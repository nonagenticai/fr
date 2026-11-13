// src/lib/workers/wm-errors.ts
//
// worker_management's BYO-key error contract (worker_management#316, owner
// ruling 2026-10-01: a tenant's own key that cannot be used is an ERROR, never a
// silent fallback). WM answers with the envelope `{error:{code,message,status,details}}`
// and, on the chat SSE stream, a frame whose `error` stays a string with
// `error_code`, `status` and `details` beside it.
//
// WM's `message` is written for operators (tenant id, WM API paths). This maps
// the CODE to a sentence the user can act on, from secret-free detail fields
// only. The backend carries the same table in
// `backend/src/lib/wm-byo-errors.ts`; keep the two in step.

export const WM_BYO_ERROR_CODES = [
  'BYO_KEY_WITHHELD',
  'BYO_KEY_UNUSABLE',
  'BYO_PROVIDER_NOT_CONFIGURED',
  'BYO_PROVIDER_CALL_FAILED',
  'MODEL_NOT_AVAILABLE_TO_TENANT',
  // WM's 402 for a commercial tenant with no provider row (`BYORequiredError`).
  // Lower-case, and nested: the wire body is
  // `{error:{code:"ERROR", message:{code, message}, status:402}}`. See the
  // backend table for the full note; `byoCodeOf` reads the nesting.
  'byo_llm_not_configured',
] as const;

export type WmByoErrorCode = (typeof WM_BYO_ERROR_CODES)[number];

export function isWmByoErrorCode(v: unknown): v is WmByoErrorCode {
  return typeof v === 'string' && (WM_BYO_ERROR_CODES as readonly string[]).includes(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** User-facing sentence for a WM BYO error code. */
export function wmByoUserMessage(
  code: WmByoErrorCode,
  details: Record<string, unknown> = {},
): string {
  const provider = str(details.provider) ?? 'your provider';
  const tier = str(details.tier);
  const model = str(details.model);
  const tierText = tier && tier !== 'default' ? ` for the ${tier} tier` : '';
  switch (code) {
    case 'BYO_KEY_WITHHELD':
      return (
        `Your workspace's own ${provider} key could not be used because your sign-in could not be ` +
        'verified for this workspace. Sign out and sign in again, then retry.'
      );
    case 'BYO_KEY_UNUSABLE':
      return (
        `The ${provider} key saved${tierText} cannot be used. Re-enter it in Settings → LLM provider ` +
        'and press Test.'
      );
    case 'BYO_PROVIDER_NOT_CONFIGURED':
      return `No ${provider} key is configured for this workspace. Add one in Settings → LLM provider.`;
    case 'BYO_PROVIDER_CALL_FAILED':
      return (
        `${provider} rejected the request made with your workspace's key. Check the key and the ` +
        'provider account in Settings → LLM provider.'
      );
    case 'MODEL_NOT_AVAILABLE_TO_TENANT':
      return model
        ? `Model '${model}' is not available to this workspace. Pick another model.`
        : 'That model is not available to this workspace. Pick another model.';
    case 'byo_llm_not_configured':
      return (
        'No LLM provider is configured for this workspace, so agents cannot run. ' +
        'Add a provider key in Settings → LLM provider.'
      );
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The user sentence for a WM error body — the JSON envelope or an SSE error
 * frame — or null when it is not a WM BYO error.
 */
export function wmByoErrorMessage(body: unknown): string | null {
  const b = asRecord(body);
  if (isWmByoErrorCode(b.error_code)) {
    return wmByoUserMessage(b.error_code, { provider: b.provider, ...asRecord(b.details) });
  }
  const env = asRecord(b.error);
  const code = byoCodeOf(env);
  if (code) return wmByoUserMessage(code, asRecord(env.details));
  // FastAPI's default rendering of a dict `detail` (no WM handler in front).
  const detail = asRecord(b.detail);
  if (isWmByoErrorCode(detail.code)) return wmByoUserMessage(detail.code, asRecord(detail.details));
  return null;
}

/**
 * The BYO code inside a WM envelope `error` object: its own `code`, or the code
 * nested in `message` (an `HTTPException` raised with a dict `detail`, i.e. 402).
 */
function byoCodeOf(env: Record<string, unknown>): WmByoErrorCode | null {
  if (isWmByoErrorCode(env.code)) return env.code;
  const nested = asRecord(env.message).code;
  return isWmByoErrorCode(nested) ? nested : null;
}

// ── Neutral page copy (fr#1409) ────────────────────────────────────────────
// A failed request on /chat, /workers/new and /workers/[name] used to render
// `${status} — ${await res.text()}` (or the thrown `${status} ${statusText}:
// detail`) to tenant admins: upstream status codes and response bodies. The
// page now shows one of these sentences; the raw detail goes to the console
// via `logRawError` only.

export const WORKER_LOAD_ERROR_TEXT = "Couldn't load this worker. Try again.";
export const WORKER_NOT_FOUND_TEXT = 'Worker not found.';
export const WORKER_SAVE_ERROR_TEXT = "Couldn't save your changes. Try again.";
export const WORKER_CREATE_ERROR_TEXT = "Couldn't create the worker. Try again.";
export const WORKER_DELETE_ERROR_TEXT = "Couldn't delete this worker. Try again.";
export const SEND_ERROR_TEXT = "Couldn't send the message. Try again.";

/** WM's PROVIDER_BUSY stream frame (IR queue refusal): a fixed line, no exception text. */
export function providerBusyText(providerLabel?: string): string {
  const label = providerLabel?.trim() || 'The provider';
  return `${label} is busy right now. Try again shortly.`;
}

/** Keep the raw failure (status, statusText, body, Error) out of the DOM: console only. */
export function logRawError(context: string, ...detail: unknown[]): void {
  console.error(`[${context}]`, ...detail);
}

/**
 * Page copy for a failed (non-2xx) worker_management call: the BYO sentence
 * when WM sent one (it is written for the user and secret-free), else the
 * caller's neutral `fallback`. Never the status, statusText or raw body.
 */
export function neutralHttpErrorText(fallback: string, rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = undefined;
  }
  return wmByoErrorMessage(parsed) ?? fallback;
}

/**
 * Text for a failed (non-2xx) chat/completions response: the BYO sentence when
 * WM sent one, else SEND_ERROR_TEXT. `status` is accepted for call-site
 * symmetry; it never reaches the copy (fr#1409).
 */
export function chatHttpErrorText(_status: number, rawText: string): string {
  return neutralHttpErrorText(SEND_ERROR_TEXT, rawText);
}

/**
 * Text for a failed (non-2xx) worker_management call outside the chat stream —
 * the Workers test console's `/message`, for one. Same rules as
 * `chatHttpErrorText`; named for what it is used for.
 */
export function wmHttpErrorText(status: number, rawText: string): string {
  return chatHttpErrorText(status, rawText);
}
