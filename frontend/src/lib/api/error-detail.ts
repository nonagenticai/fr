// src/lib/api/error-detail.ts
//
// One shape-aware reader for fr's error bodies.
//
// Why this exists: `super-admin.ts` did
// `[body.error, body.detail].filter(Boolean).join(': ')`. That is correct only
// while `error` is a STRING. Integration-backed routes return an OBJECT —
// `integrationErrorResponse` (backend/src/integrations/_lib/errors.ts) emits
// `{error:{code,message,service,upstream:{status,body}}}` — and `Array.join`
// on an object yields `[object Object]`.
//
// Measured 2026-08-26 in production: a super-admin waited 10.8s on
// `POST /api/admin/super-admin/provision-user` and was told
// `provisionUser: 404 — [object Object]`, while the actual reason —
// "no active plan for licenses app 'meta_prompt_core_actions'" — sat two
// levels down in the very same payload. The operator had no way to know which
// of the checkboxes they ticked was the bad one.
//
// The shapes this must survive, MOST SPECIFIC FIRST (the upstream's own
// sentence beats fr's generic wrapper — `provisioning /api/provision 404: {…}`
// names the transport, not the problem):
//
//   {error: {upstream: {body: {detail: "…"}}}}              upstream sentence
//   {error: {upstream: {body: {detail: {error, remedy}}}}}  coded refusal + fix
//   {error: {upstream: {body: {detail: [{msg}, …]}}}}       FastAPI 422 list
//   {error: {message, code}}                                fr integration envelope
//   {error: "…"}                                            plain fr handler error
//   {detail: "…"}                                           bare FastAPI passthrough
//
// Anything unrecognised returns '' so callers keep their own fallback wording
// rather than rendering a stringified blob at the user.

/** `all_tokens_expired` -> `All tokens expired`. */
export function humaniseCode(code: string): string {
  const words = code.replace(/_/g, ' ').trim();
  if (words.length === 0) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * How much of each 422 entry to render.
 *
 * Both flags default OFF, which is exactly what `detailToString` did before
 * this became shared: `super-admin.ts`, `licenses-admin.ts` and `usage.ts` are
 * in production and their wording is not allowed to move. `reviews.ts` opts
 * into both.
 */
export interface FlattenDetailArrayOptions {
  /**
   * Prefix each message with Pydantic's `loc` path — `body.reviewers_required:
   * Input should be a valid integer` rather than the field-less
   * `Input should be a valid integer`.
   *
   * The path is kept WHOLE rather than trimmed to its last segment: `body.x`
   * and `query.x` are different bugs.
   */
  withLoc?: boolean;
  /**
   * Also render entries that are themselves plain strings (`detail:
   * ["first", "second"]`). FastAPI emits this for `HTTPException(detail=[…])`,
   * which is not the Pydantic 422 shape and carries no `msg` key.
   */
  withPlainStringEntries?: boolean;
}

/** One 422 entry -> one line. '' means "nothing legible here", and is dropped. */
function renderDetailEntry(entry: unknown, opts: FlattenDetailArrayOptions): string {
  const plain = nonEmpty(entry);
  if (plain) return opts.withPlainStringEntries ? plain : '';
  if (!entry || typeof entry !== 'object') return '';

  const item = entry as { msg?: unknown; loc?: unknown };
  const msg = nonEmpty(item.msg);
  if (!msg) return '';
  if (!opts.withLoc) return msg;

  const loc = Array.isArray(item.loc)
    ? item.loc.filter((part) => typeof part === 'string' || typeof part === 'number').join('.')
    : '';
  return loc ? `${loc}: ${msg}` : msg;
}

/**
 * Flatten a FastAPI/Pydantic 422 `detail` ARRAY — `[{loc, msg, type}, …]` — into
 * one line, or null when no entry renders to anything.
 *
 * ⚠️ THE ONLY implementation of this rule in the frontend. `reviews.ts` used to
 * carry a second copy (added by #1012, which did not notice this one); two
 * copies of one rule is how two copies quietly disagree. The differences that
 * copy legitimately needed are the options above, not a fork — and they have to
 * live INSIDE the flattener, because `loc` is per-entry and is unrecoverable
 * once the entries have been joined into a string.
 */
export function flattenDetailArray(
  detail: readonly unknown[],
  opts: FlattenDetailArrayOptions = {},
): string | null {
  const lines = detail
    .map((entry) => renderDetailEntry(entry, opts))
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('; ') : null;
}

/**
 * Flatten a `detail` payload. FastAPI uses three shapes for this one key: a
 * plain sentence, a coded object, and the 422 validation array. Treating only
 * the first would silently blank the other two.
 */
function detailToString(detail: unknown): string | null {
  const plain = nonEmpty(detail);
  if (plain) return plain;

  // FastAPI 422: [{loc, msg, type}, …]. `msg` is the only human part these
  // callers show — see FlattenDetailArrayOptions for why they stay bare.
  if (Array.isArray(detail)) return flattenDetailArray(detail);

  if (detail && typeof detail === 'object') {
    const d = detail as { error?: unknown; remedy?: unknown; message?: unknown };
    const remedy = nonEmpty(d.remedy);
    const reason = nonEmpty(d.error);
    // `remedy` is the only part that tells the user what to DO, so it always
    // survives; the code in front of it is context, not the message.
    if (remedy) return reason ? `${humaniseCode(reason)} — ${remedy}` : remedy;
    if (reason) return humaniseCode(reason);
    const message = nonEmpty(d.message);
    if (message) return message;
  }
  return null;
}

/** The reason carried by the top-level `error` key, whatever its shape. */
function reasonFromErrorField(err: unknown): string | null {
  const plain = nonEmpty(err);
  if (plain) return plain;
  if (!err || typeof err !== 'object') return null;

  const e = err as {
    message?: unknown;
    code?: unknown;
    upstream?: { body?: unknown } | null;
  };

  // Deepest first: what the upstream service actually said.
  const upstream = detailToString(
    (e.upstream?.body as { detail?: unknown } | undefined)?.detail,
  );
  if (upstream) return upstream;

  const message = nonEmpty(e.message);
  if (message) return message;

  const code = nonEmpty(e.code);
  return code ? humaniseCode(code) : null;
}

/**
 * Pull the most specific human-readable reason out of an already-parsed error
 * body. Returns '' when nothing legible is present — never `[object Object]`,
 * never a JSON blob.
 */
export function errorDetailFrom(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as { error?: unknown; detail?: unknown };

  const parts: string[] = [];
  const reason = reasonFromErrorField(b.error);
  if (reason) parts.push(reason);

  const bare = detailToString(b.detail);
  // A top-level `detail` that merely repeats what `error` already said is
  // noise, not extra information.
  if (bare && !parts.includes(bare)) parts.push(bare);

  return parts.join(': ');
}

/**
 * `errorDetailFrom` over a non-2xx `Response`. Never throws and never rejects:
 * a body that is not JSON (an ingress 502 serving `text/plain`) yields ''.
 */
export async function errorDetailOf(r: Response): Promise<string> {
  try {
    return errorDetailFrom(await r.json());
  } catch {
    return '';
  }
}
