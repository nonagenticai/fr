/**
 * fr-agui SPEC §10.1 — secret redaction for everything the AGENT sees, stores
 * or streams.
 *
 * Applied, in order:
 *   1. the action's DECLARED secret fields (`confirm.secretFields`; a
 *      capability's `secrets.input` / `secrets.output` JSON pointers) → «redacted»;
 *   2. PII masks — `maskAddress` / `maskRecipient`, ported from the frontend
 *      (`frontend/src/lib/api/channel-prefs.ts`, `deliveries.ts`); one shared
 *      vector file pins that both sides give identical output
 *      (backend/tests/fixtures/redact/mask-vectors.json);
 *   3. defence in depth over EVERY string: secret-shaped VALUES (token
 *      prefixes, JWTs, private-key blocks, credentials in URLs, `password=…`
 *      pairs) and secret-named KEYS (`*_token`, `secret`, `password`,
 *      `api_key`, `credential`, `cookie`, `private_key`) → «redacted».
 *
 * It runs at the four points of §10.1, all in agent/loop.ts: (a) before a tool
 * result enters the LLM context, (b) before a `session-store` append, (c)
 * before an NDJSON emit, (d) before span attributes. The stored thread, the LLM
 * transcript and the stream therefore carry the SAME redacted view; raw values
 * live only in the browser cards (§5.5), which call routes directly.
 *
 * Pure, env-free, and it never throws on odd input (a cycle or an exotic value
 * is replaced, never walked forever).
 *
 * ⚠️ The patterns are assembled from fragments so this file is not itself a
 * gitleaks / private-key-scan hit (the archetype's secret scan).
 */

export const REDACTED = '«redacted»';

/** Mask glyph used by the frontend helpers (U+2022 ×4). */
const DOTS = '\u2022\u2022\u2022\u2022';
const SHORT_LEN = 8;

/** Port of frontend `maskAddress(channel, address)` (channel-prefs.ts). Byte-identical output. */
export function maskAddress(channel: string, address: string): string {
  if (!address) return '';
  if (channel === 'email' || channel === 'teams') {
    const at = address.indexOf('@');
    if (at <= 0) return address.slice(0, 1) + DOTS;
    return `${address.slice(0, at).slice(0, 1)}${DOTS}${address.slice(at)}`;
  }
  if (address.length <= 6) return address;
  return `${address.slice(0, 6)}\u2026`;
}

/** Port of frontend `maskRecipient(channel, address)` (deliveries.ts). Byte-identical output. */
export function maskRecipient(channel: string, address: string): string {
  if (!address) return '';
  if (channel === 'voice') {
    const digits = address.replace(/\D/g, '');
    return digits.length >= 4 ? `${DOTS}${digits.slice(-4)}` : DOTS;
  }
  if (channel === 'email' || channel === 'teams') {
    const at = address.indexOf('@');
    if (at > 0) return `${address.slice(0, at).charAt(0)}${DOTS}${address.slice(at)}`;
    return DOTS;
  }
  if (address.length <= 12) return address;
  return address.length > SHORT_LEN ? `\u2026${address.slice(-SHORT_LEN)}` : address;
}

// ---------------------------------------------------------------------------
// 3. Pattern scanner
// ---------------------------------------------------------------------------

const BEGIN = '-----' + 'BEGIN';
const END = '-----' + 'END';

interface SecretPattern {
  re: RegExp;
  /** The replacement for one match (default: the whole match → «redacted»). */
  keep?: (match: string, ...groups: string[]) => string;
}

/**
 * Secret-shaped substrings (the token prefixes of SPEC §5.5 and the plugin set
 * detect-secrets / gitleaks use: GitHub, Slack, OpenAI/Anthropic-style `sk-`,
 * AWS access keys, Google API keys, Stripe, npm, JWT, private-key blocks,
 * basic-auth URLs, `password=` / `token:` pairs, Bearer/Basic headers).
 * The keyed pair only takes a value that LOOKS like a credential (quoted, or
 * ≥6 chars with a digit or symbol), so prose such as "password: minimum
 * length" is left readable.
 */
//
// ⚠️ LINEAR TIME: a pattern that opens with a repeated class (`[a-z][a-z0-9+.-]*`,
// `[a-z0-9-]+`) carries a lookbehind so it starts only at the START of a run.
// Without it every position of a long run is a fresh start and the scan is
// quadratic — measured: 20k chars ≈ 220 ms per pattern, so a 200k span
// attribute (tests/unit/telemetry/spans.test.ts) took minutes.
export const SECRET_VALUE_PATTERNS: ReadonlyArray<SecretPattern> = [
  { re: new RegExp(`${BEGIN}[A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:${END}[A-Z0-9 ]*PRIVATE KEY-----|$)`, 'g') },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { re: /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { re: /\bnpm_[A-Za-z0-9]{36}/g },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, keep: (_m, scheme) => `${scheme} ${REDACTED}` },
  { re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, keep: (_m, head) => `${head}${REDACTED}@` },
  {
    re: /\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*)("[^"]+"|'[^']+'|(?=[^\s,;&"']*[0-9_!@#$%^*+/-])[^\s,;&"']{6,})/gi,
    keep: (_m, head) => `${head}${REDACTED}`,
  },
  // P1c-a audit item 3 — the shapes the scanner above missed.
  // GitLab personal/project access tokens, Hugging Face tokens.
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { re: /\bhf_[A-Za-z0-9]{30,}/g },
  // Incoming-webhook URLs: the path after the fixed prefix IS the credential
  // (Slack, Teams / Office 365 connectors, Discord). The host stays readable.
  { re: /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
  { re: /(?<![a-z0-9-])([a-z0-9-]+\.webhook\.office\.com\/webhookb2\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
  { re: /(outlook\.office(?:365)?\.com\/webhook\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
  { re: /((?:discord|discordapp)\.com\/api\/webhooks\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
  // Telegram bot token (`<bot id>:<35-char secret>`), bare or in `api.telegram.org/bot<token>/…`.
  { re: /(?<![0-9])[0-9]{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  // A credential in a query string: `?token=…`, `&sig=…` (Power Automate /
  // Azure SAS), `key`, `secret`, `signature`, `access_token`, `api_key`, …
  {
    re: /([?&](?:token|sig|signature|key|api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password)=)[^&\s#"'<>]+/gi,
    keep: (_m, head) => `${head}${REDACTED}`,
  },
  // A 40-hex token used as the USERNAME of a repo URL (`https://<token>@github.com/o/r`).
  { re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[0-9a-f]{40}@/gi, keep: (_m, head) => `${head}${REDACTED}@` },
  // The opaque fr licence token: `secrets.token_urlsafe(32)` in the licenses
  // service (licenses/models.py `generate_token`) — EXACTLY 43 url-safe base64
  // chars. Requires mixed case AND a digit, so a 43-char lowercase identifier, a
  // hex SHA (40 / 64, lowercase) or a UUID (36) is never taken. Last, so a JWT
  // segment or a prefixed token above is already gone.
  { re: /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{0,42}[A-Z])(?=[A-Za-z0-9_-]{0,42}[a-z])(?=[A-Za-z0-9_-]{0,42}[0-9])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
];

/** Replace every secret-shaped substring of `s`. */
export function scrubString(s: string): string {
  let out = s;
  for (const { re, keep } of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m: string, ...rest: unknown[]) =>
      keep ? keep(m, ...(rest.filter((x) => typeof x === 'string') as string[])) : REDACTED,
    );
  }
  return out;
}

/** A KEY whose string value is a secret, whatever it looks like (SPEC §10.1 guard list). */
const SECRET_KEY_RE =
  /^(?:.*[_-])?(?:token|secret|password|passwd|api_?key|apikey|credentials?|cookie|private_?key|client_?secret|refresh_?token|access_?token|session_?token|licen[cs]e_?token|bearer)$/i;

/** Keys that look secret-named but are not (counts, kinds, ids of non-secrets). */
const NOT_SECRET_KEYS: ReadonlySet<string> = new Set(['secretfields', 'secret_fields', 'token_count', 'tokens', 'max_tokens']);

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (NOT_SECRET_KEYS.has(k)) return false;
  return SECRET_KEY_RE.test(key);
}

/** PII masks applied by KEY (SPEC §10.1 step 2). */
export type PiiMask = 'email' | 'address' | 'recipient';

/**
 * SPEC §10.1 step 2 — the PII keys the AGENT's view masks, passed at every
 * redaction point (agent/loop.ts tool input + tool result → stream, thread and
 * LLM; telemetry/spans.ts attributes). An email keeps its first character and
 * domain; `recipient_address` (engagement_deliveries) and a channel-pref
 * `address` are masked per their sibling `channel`, exactly as the frontend
 * cards do (one vector file pins both sides: tests/fixtures/redact/mask-vectors.json).
 */
export const AGENT_PII_MASKS: Readonly<Record<string, PiiMask>> = {
  email: 'email',
  approver_email: 'email',
  requester_email: 'email',
  decided_by_email: 'email',
  actor_email: 'email',
  owner_email: 'email',
  user_email: 'email',
  recipient_email: 'email',
  recipient_address: 'recipient',
  address: 'address',
};

export interface RedactSpec {
  /** Top-level / dotted keys or JSON pointers declared secret (`/github_access_token`, `github_access_token`). */
  secretPaths?: readonly string[];
  /** Keys whose string value is PII, and the mask (`recipient` uses the sibling `channel` field). */
  pii?: Readonly<Record<string, PiiMask>>;
}

const MAX_DEPTH = 40;

function pointerKey(p: string): string {
  return p.startsWith('/') ? p.slice(1).split('/').join('.') : p;
}

function maskEmail(v: string): string {
  return maskAddress('email', v);
}

function applyPii(mask: PiiMask, value: string, siblingChannel: unknown): string {
  if (mask === 'email') return maskEmail(value);
  const channel = typeof siblingChannel === 'string' ? siblingChannel : '';
  return mask === 'address' ? maskAddress(channel, value) : maskRecipient(channel, value);
}

/** `address` is PII only on a channel-shaped row (a sibling `channel`); a bare `address` key is just scanned. */
function piiApplies(mask: PiiMask, obj: Record<string, unknown>): boolean {
  return mask !== 'address' || typeof obj.channel === 'string';
}

/**
 * The redacted view of `value`. Never mutates the input. `spec` adds the
 * declared paths and PII masks on top of the always-on scanner.
 */
export function redact<T>(value: T, spec: RedactSpec = {}): T {
  const secret = new Set((spec.secretPaths ?? []).map(pointerKey));
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === 'string') return scrubString(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth > MAX_DEPTH || seen.has(v as object)) return REDACTED;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(obj)) {
      const here = path ? `${path}.${k}` : k;
      if (secret.has(here) || secret.has(k)) {
        out[k] = x === undefined || x === null || x === '' ? x : REDACTED;
        continue;
      }
      if (typeof x === 'string' && isSecretKey(k)) {
        out[k] = x === '' ? x : REDACTED;
        continue;
      }
      const pii = spec.pii?.[k];
      if (pii && typeof x === 'string' && piiApplies(pii, obj)) {
        out[k] = applyPii(pii, x, obj.channel);
        continue;
      }
      out[k] = walk(x, here, depth + 1);
    }
    return out;
  };
  try {
    return walk(value, '', 0) as T;
  } catch {
    return REDACTED as unknown as T;
  }
}

/**
 * One span / log attribute (§10.1 d), as telemetry/spans.ts applies it: a PII key
 * (its last dotted segment in AGENT_PII_MASKS, e.g. `approval.approver_email`)
 * → its mask; every other string scrubbed of secret SHAPES. (A secret-NAMED
 * span key stays a call-site convention — spans.ts rule 3, pinned by
 * tests/unit/telemetry/spans.test.ts "HONEST LIMIT".)
 */
export function redactAttribute(key: string, value: string): string {
  if (value === '') return value;
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  const mask = AGENT_PII_MASKS[leaf];
  if (mask === 'email') return maskEmail(value);
  if (mask === 'recipient') return maskRecipient('', value);
  return scrubString(value);
}

/**
 * P1c-b — a SHORT redacted view of free text (thread `lastMessagePreview`).
 *
 * ⛔ Order matters: scrub the FULL text, THEN cut. Cutting first truncates a
 * token that straddles the cut, the patterns (most are length-anchored: the
 * 43-char licence token, `glpat-…{20,}`) no longer match the stub, and a real
 * secret's prefix is served as-is.
 *
 * The cut never lands inside a `«redacted»` marker: it moves to the marker's
 * start, so the preview never ends in a half marker.
 */
export function redactThenTruncate(text: string, max: number): string {
  const scrubbed = scrubString(text);
  if (scrubbed.length <= max) return scrubbed;
  let cut = max;
  for (let i = scrubbed.indexOf(REDACTED); i !== -1 && i < cut; i = scrubbed.indexOf(REDACTED, i + 1)) {
    if (i + REDACTED.length > cut) {
      cut = i;
      break;
    }
  }
  return scrubbed.slice(0, cut);
}
