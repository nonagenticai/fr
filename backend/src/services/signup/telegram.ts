// src/services/signup/telegram.ts — tell George about fr early-access signups in Telegram.
//
// Port of commonpractice `backend/src/services/signup-telegram.ts` (early-access v2, contract C1).
// Bot @nonagenticaibot (FR_SIGNUP_TELEGRAM_BOT_TOKEN — NOT fr's own TELEGRAM_BOT_TOKEN, which is a
// different bot), chat FR_SIGNUP_TELEGRAM_CHAT_ID, forum topic FR_SIGNUP_TELEGRAM_THREAD_ID (the
// "fr signups" topic; never 167, which is reserved for external-probe alarms). Two messages:
//
//   • a NEW pending signup (insert only — a de-duplicated re-submit sends nothing). Name, email,
//     company, source, language, a message excerpt, and two rows of buttons:
//       1. CALLBACK buttons Approve / Reject, `callback_data` = `ea1:fr:a|r:<signupId>` (C1).
//          Telegram delivers the tap to chat-bridge — the bot's ONLY update consumer — which checks
//          the tapper and calls POST /api/signup-approvals/:id/telegram-decision with its own SA token.
//       2. a URL button "Open in fr" → /admin/onboarding?signup=<id> (super_admin screen).
//   • a follow-up when the signup is approved / rejected: outcome, requester, workspace, who decided,
//     and every provisioning step that did not finish `ok`.
//
// ⛔ SEND ONLY. This module never calls setWebhook / deleteWebhook / getUpdates: the bot's webhook
// belongs to chat-bridge.
//
// ⛔ FIRE-AND-FORGET. `notify*` return at once; the send runs detached with a bounded retry and
// every failure is logged, never thrown. A Telegram outage never blocks a signup or a decision.
// The bot token is part of the API URL, so every logged error is redacted.
import { SIGNUP_APP_KEY, signupPublicUrl, signupTelegramConfig, type SignupTelegramConfig } from './config';
import { singleLine } from './untrusted-text';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000];
const MAX_RETRY_AFTER_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;

/** One line at boot: on, or off and which setting is missing. */
export function logSignupTelegramStatus(): void {
  const cfg = signupTelegramConfig();
  if (cfg.enabled) {
    console.log(`[signup-telegram] enabled chat=${cfg.chatId} thread=${cfg.threadId}`);
    return;
  }
  const missing = [
    !cfg.botToken && 'FR_SIGNUP_TELEGRAM_BOT_TOKEN',
    !cfg.chatId && 'FR_SIGNUP_TELEGRAM_CHAT_ID',
    !/^\d+$/.test(cfg.threadId) && 'FR_SIGNUP_TELEGRAM_THREAD_ID',
  ].filter(Boolean);
  console.log(`[signup-telegram] disabled missing=${missing.join(',')}`);
}

/** The C1 callback_data prefix: `ea1:fr:<a|r>:<signupId>` (45 bytes for a uuid, ≤ 64). */
const SIGNUP_CALLBACK_PREFIX = `ea1:${SIGNUP_APP_KEY}`;

function signupCallbackData(id: string, action: 'approve' | 'reject'): string {
  return `${SIGNUP_CALLBACK_PREFIX}:${action === 'approve' ? 'a' : 'r'}:${id}`;
}

/** The super_admin screen for one signup. */
function signupDeepLink(id: string): string {
  return `${signupPublicUrl()}/admin/onboarding?signup=${encodeURIComponent(id)}`;
}

const MESSAGE_EXCERPT_MAX = 300;
const FIELD_MAX = 200;

interface NewSignupNotice {
  id: string;
  source: string;
  pendingTotal: number | null;
  /** Requester-typed — rendered inside `code` entities only. */
  email: string;
  name: string | null;
  company: string | null;
  message?: string | null;
  locale?: string | null;
}

interface SignupDecisionNotice {
  id: string;
  outcome: 'approved' | 'rejected';
  email?: string | null;
  name?: string | null;
  tenantId?: string | null;
  tenantName?: string | null;
  tenantSlug?: string | null;
  decidedVia?: string | null;
  /** `sent` | `waiting` (the email follows once every step is ok) | null. */
  emailState?: string | null;
  notOk?: Array<{ step: string; status: string; code: string | null }>;
  /** Reject only: what became of the cleanup of an aborted approve. */
  cleanup?: string | null;
}

/** First `max` code points of `value`, on one line, with `…` when cut. */
export function excerpt(value: string | null | undefined, max: number): string {
  const flat = Array.from(singleLine(value ?? ''));
  return flat.length > max ? `${flat.slice(0, max).join('')}…` : flat.join('');
}

/**
 * Plain text plus `code` entities around every REQUESTER-TYPED value; no parse_mode. A `code`
 * entity cannot contain other entities, so a URL typed into a name renders as inert monospace
 * instead of a link Telegram would auto-detect. Offsets are UTF-16 units = JS `.length`.
 */
class Message {
  text = '';
  readonly entities: Array<{ type: 'code'; offset: number; length: number }> = [];

  plain(s: string): this {
    this.text += s;
    return this;
  }

  field(label: string, value: string | null | undefined, max = FIELD_MAX): this {
    const v = excerpt(value, max);
    this.text += `${label}: `;
    if (!v) return this.plain('—\n');
    this.entities.push({ type: 'code', offset: this.text.length, length: v.length });
    this.text += v;
    return this.plain('\n');
  }
}

function basePayload(cfg: SignupTelegramConfig, m: Message): Record<string, unknown> {
  return {
    chat_id: cfg.chatId,
    message_thread_id: Number(cfg.threadId),
    text: m.text.replace(/\n+$/, ''),
    entities: m.entities,
    link_preview_options: { is_disabled: true },
  };
}

const NEW_SIGNUP_HEADLINE = 'New fr (conveyor) early-access signup';

function newSignupPayload(n: NewSignupNotice, cfg = signupTelegramConfig()): Record<string, unknown> {
  const m = new Message()
    .plain(`${NEW_SIGNUP_HEADLINE}\n\n`)
    .field('Name', n.name)
    .field('Email', n.email)
    .field('Company', n.company)
    .plain(`Source: ${n.source}\n`)
    .plain(`Language: ${n.locale ?? '— (en)'}\n`)
    .plain('Trusted via: website/chat intake (service account)\n');
  if (n.message && singleLine(n.message)) m.field('Message', n.message, MESSAGE_EXCERPT_MAX);
  m.plain(`Pending signups: ${n.pendingTotal ?? '—'}\n`)
    .plain(`Signup id: ${n.id}\n\n`)
    .plain(
      'Approve creates the workspace now (default name, conveyor bundle) and emails the set-password link. ' +
        'Open in fr to choose the workspace name first.',
    );
  return {
    ...basePayload(cfg, m),
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: signupCallbackData(n.id, 'approve') },
          { text: 'Reject', callback_data: signupCallbackData(n.id, 'reject') },
        ],
        // A relative URL makes Telegram refuse the WHOLE message (400), so no FR_PUBLIC_URL = no button.
        ...(signupPublicUrl() ? [[{ text: 'Open in fr', url: signupDeepLink(n.id) }]] : []),
      ],
    },
  };
}

function decisionPayload(d: SignupDecisionNotice, cfg = signupTelegramConfig()): Record<string, unknown> {
  const m = new Message().plain(`fr signup ${d.outcome}\n\n`);
  if (d.name !== undefined || d.email !== undefined) m.field('Name', d.name).field('Email', d.email);
  if (d.decidedVia) m.plain(`Decided via: ${d.decidedVia}\n`);
  if (d.outcome === 'approved') {
    m.field('Workspace', d.tenantName).field('Slug', d.tenantSlug);
    m.plain(`Tenant id: ${d.tenantId ?? '—'}\n`);
    m.plain(
      d.emailState === 'sent'
        ? 'Set-password email sent.\n'
        : 'The set-password email follows once every provisioning step is ok (retried automatically).\n',
    );
    const notOk = d.notOk ?? [];
    if (notOk.length === 0) m.plain('Provisioning: all steps ok.\n');
    else {
      m.plain('Provisioning steps NOT ok:\n');
      for (const s of notOk) m.plain(`  - ${s.step}: ${s.status}${s.code ? ` (${s.code})` : ''}\n`);
    }
  } else if (d.cleanup) {
    m.plain(`Cleanup of the aborted approve: ${d.cleanup}\n`);
  }
  m.plain(`Signup id: ${d.id}`);
  return basePayload(cfg, m);
}

export function notifyNewSignup(n: NewSignupNotice): void {
  const cfg = signupTelegramConfig();
  if (!cfg.enabled) return;
  detach('new_signup', cfg, () => newSignupPayload(n, cfg));
}

export function notifySignupDecision(d: SignupDecisionNotice): void {
  const cfg = signupTelegramConfig();
  if (!cfg.enabled) return;
  detach('decision', cfg, () => decisionPayload(d, cfg));
}

function detach(kind: string, cfg: SignupTelegramConfig, build: () => Record<string, unknown>): void {
  void (async () => {
    try {
      await sendWithRetry(kind, cfg, build());
    } catch (err) {
      console.error(`[signup-telegram] send crashed kind=${kind}: ${redact(err, cfg.botToken)}`);
    }
  })();
}

function redact(err: unknown, token: string): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return token ? text.split(token).join('<redacted>') : text;
}

async function sendWithRetry(kind: string, cfg: SignupTelegramConfig, payload: Record<string, unknown>): Promise<void> {
  const url = `${cfg.apiBase}/bot${cfg.botToken}/sendMessage`;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let waitMs = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
      lastError = `HTTP ${res.status}${body.description ? `: ${body.description}` : ''}`;
      // 4xx other than 429 is configuration (bad chat/thread, bot not in chat): retrying cannot fix it.
      if (res.status !== 429 && res.status < 500) break;
      if (res.status === 429 && typeof body.parameters?.retry_after === 'number') {
        waitMs = Math.min(body.parameters.retry_after * 1000, MAX_RETRY_AFTER_MS);
      }
    } catch (err) {
      lastError = redact(err, cfg.botToken);
    }
    if (attempt < MAX_ATTEMPTS) await Bun.sleep(waitMs);
  }
  console.warn(
    `[signup-telegram] send failed kind=${kind} error=${lastError.split(cfg.botToken).join('<redacted>')} ` +
      '(the signup itself is recorded; check FR_SIGNUP_TELEGRAM_* and the bot membership of the chat)',
  );
}
