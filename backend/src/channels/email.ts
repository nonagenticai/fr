// E-10: Email inbound channel.
//
// `parseWebhook` accepts Mailgun-style POST forms (multipart/form-data or
// application/x-www-form-urlencoded). Required form fields:
//   - `from`        — sender envelope address (raw or RFC-5322 formatted)
//   - `subject`     — email subject (optional in spec but Mailgun always sets)
//   - `stripped-text` — Mailgun's reply text with quotes removed (preferred);
//                     else `body-plain` with quoted text stripped (`stripQuotedReply`).
//   - `Message-Id`  — RFC-5322 Message-Id header; used as correlationId.
//
// Identity resolution: there is no in-DB email→userId table yet (see
// `agent-core/identity.ts` — null-by-default). We carry the parsed sender
// address in `userId` and `address`; the dispatcher delegates to
// `agentCore.resolveIdentity` which production wires to a real resolver.
// If `from` is missing/empty, returns null (channel disclaims the request).
import type { ChannelInbound, InboundMessage } from './index';
import type { ChannelMessage } from '../domain/engagement/notifications';
import { emailAdapter } from '../domain/engagement/adapters/email';

function extractEmailAddress(raw: string): string {
  // Mailgun gives either bare "alice@example.com" or "Alice <alice@example.com>".
  const m = raw.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim().toLowerCase();
  return raw.trim().toLowerCase();
}

async function readForm(req: Request): Promise<FormLike | null> {
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const text = await req.text();
      return new URLSearchParams(text);
    }
    if (ct.includes('multipart/form-data')) {
      return await req.formData();
    }
    if (ct.includes('application/json')) {
      // Some webhook providers ship JSON with the same field names.
      const body = await req.json() as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') params.set(k, v);
      }
      return params;
    }
  } catch {
    return null;
  }
  return null;
}

/** A line that opens a quoted original: `On <date>, <who> wrote:` (possibly wrapped onto
 * the next line), Outlook's `-----Original Message-----` / `From: … Sent:` header block,
 * or a forwarded-message banner — in English, German, Dutch and French (the clients'
 * localised forms: `Am … schrieb …:` / `Von:`+`Gesendet:`, `Op … schreef …:` /
 * `Van:`+`Verzonden:`, `Le … a écrit :` / `De :`+`Envoyé :`). A header that is missed
 * lets the quoted original — possibly a licence notification — reach the resolver. */
const QUOTE_HEADER_RES: RegExp[] = [
  /^\s*-{2,}\s*(original message|forwarded message|urspr(ü|ue)ngliche nachricht|weitergeleitete nachricht|oorspronkelijk bericht|doorgestuurd bericht|message d'origine|message transf(é|e)r(é|e))\s*-{2,}/i,
  /^\s*on\b.*\bwrote\s*:\s*$/i,
  /^\s*am\b.*\bschrieb\b.*:\s*$/i,
  /^\s*op\b.*\bschreef\b.*:\s*$/i,
  /^\s*le\b.*\sa\s+(é|e)crit\s*:\s*$/i,
];
/** The first word of a (possibly wrapped) `<intro> <date> … <wrote>:` header. */
const QUOTE_INTRO_RE = /^\s*(on|am|op|le)\b/i;
/** Outlook-style header block: a `From:` line followed within three lines by `Sent:`/`Date:`. */
const HEADER_FROM_RE = /^\s*(from|von|van|de)\s*:\s*\S/i;
const HEADER_SENT_RE = /^\s*(sent|date|gesendet|datum|verzonden|verstuurd|envoy(é|e))\s*:\s*\S/i;

/**
 * The new text of an email reply: everything before the first quote header, minus every
 * line starting with `>`. Exported for its test.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (QUOTE_HEADER_RES.some((re) => re.test(line))) { cut = i; break; }
    // `On Mon, 1 Jan 2026 at 10:00, Name <a@b>` + `wrote:` wrapped onto the next line (and
    // the localised forms, whose `schrieb` / `schreef` / `a écrit` may land on either line).
    if (QUOTE_INTRO_RE.test(line) && !/^\s*>/.test(next) && next.trim() !== '' &&
        QUOTE_HEADER_RES.some((re) => re.test(`${line} ${next.trim()}`))) {
      cut = i; break;
    }
    // Outlook: `From: …` followed within three lines by `Sent:` / `Date:` (any language above).
    if (HEADER_FROM_RE.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_SENT_RE.test(l))) {
      cut = i; break;
    }
  }
  return lines
    .slice(0, cut)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim();
}

/** The fixed subjects fr's own email adapter writes (domain/engagement/adapters/email.ts
 * `subjectForKind` + approval `send`). A reply's subject echoing one of these is fr's text
 * plus — for a licence notification — the licence-chosen correlation id. */
const FR_OWN_SUBJECT_RE = /^(fr notification|approval required|action result|action error|approval [a-z_-]+:)/i;
/** `Re:` / `Fwd:` / `AW:` … prefixes a mail client adds (repeated, any case). */
const REPLY_PREFIX_RE = /^\s*((re|fwd?|aw|wg|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i;

/**
 * The part of an inbound subject that is the SENDER's words, or '' (validator 4, item 3).
 * ⛔ A reply to a licence notification carries `Re: FR notification (cid:licence:<tenant>:
 * <caller part>)` — the caller part is LICENCE-CHOSEN text, and the subject is prepended to
 * the intent-resolver input. So a subject that carries ANY `cid:` token, or that is fr's own
 * fixed subject (after any `Re:` / `Fwd:` prefix), is dropped WHOLE: everything after `(cid:` is fr's/the licence's, and a
 * closing paren inside the caller part must not let a tail survive. Exported for its test.
 */
export function senderSubject(raw: string): string {
  const subject = raw.replace(REPLY_PREFIX_RE, '').trim();
  if (!subject) return '';
  if (/\bcid\s*:/i.test(subject)) return '';
  if (FR_OWN_SUBJECT_RE.test(subject)) return '';
  // The sender's own subject is passed through as written (reply prefix included).
  return raw.trim();
}

/** Minimal common surface of URLSearchParams + FormData that we use. */
type FormLike = { get(name: string): unknown };

function getField(
  form: FormLike,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = form.get(key);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export const emailChannel: ChannelInbound = {
  name: 'email',

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    const form = await readForm(req);
    if (!form) return null;

    const fromRaw = getField(form, 'from', 'From', 'sender');
    if (!fromRaw) return null;

    const senderEmail = extractEmailAddress(fromRaw);
    if (!senderEmail || !senderEmail.includes('@')) return null;

    // ⛔ ONLY THE SENDER'S NEW TEXT reaches the intent resolver (George 2026-10-10). A reply
    // quotes the message it answers — which may be a tenant LICENCE notification — and the
    // whole body used to be handed to the agent under the replying user's identity, so a
    // licence-authored instruction in the quote was prompt-injectable into approval-free
    // actions. Mailgun's `stripped-text` (quotes + signature removed by the provider) wins;
    // otherwise the full body is cut at the first quote header and every `>` line dropped.
    const providerStripped = getField(form, 'stripped-text');
    const fullBody = getField(form, 'body-plain', 'text', 'body');
    const text = providerStripped !== null
      ? stripQuotedReply(providerStripped)
      : fullBody !== null ? stripQuotedReply(fullBody) : '';
    if (!text) return null;

    // Only the sender's own subject words reach the resolver (see `senderSubject`).
    const rawSubject = getField(form, 'subject', 'Subject') ?? '';
    const subject = senderSubject(rawSubject);
    const messageId = getField(form, 'Message-Id', 'message-id', 'messageId');
    const correlationId = messageId
      ? messageId.replace(/[<>]/g, '')
      : crypto.randomUUID();

    return {
      channel: 'email',
      // Carry the email through both `userId` and `address` so the
      // dispatcher's KeycloakIdentityResolver can resolve it via
      // findUserByEmail. Same shape as channels/telegram.ts, whose sender id
      // doubles as the address.
      userId: senderEmail,
      address: senderEmail,
      text: subject ? `${subject}\n\n${text}` : text,
      // The reply→decision flow reads the sender's own words, and the subject as what the
      // message replies to — but only when it still carries the notification's tag (an
      // ordinary subject is not a Reply to anything).
      replyText: text,
      ...(/\[ApprovalId:[0-9a-f-]{36}\]/i.test(rawSubject) ? { quotedText: rawSubject } : {}),
      correlationId,
      raw: { from: fromRaw, subject, messageId, body: text },
    };
  },

  async postReply(_threadId: string | undefined, message: ChannelMessage): Promise<void> {
    const address = typeof message.meta?.address === 'string' ? message.meta.address : '';
    if (!address) return;
    await emailAdapter.sendMessage(address, message);
  },
};
