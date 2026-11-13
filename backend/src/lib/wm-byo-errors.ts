// src/lib/wm-byo-errors.ts
//
// worker_management's BYO-key error contract (worker_management#316, owner
// ruling 2026-10-01: a tenant's own key that cannot be used is an ERROR, never a
// silent fallback to a platform model). WM answers with the envelope
//
//     { error: { code, message, status, details } }
//
// and, on the chat SSE stream, a frame whose `error` stays a string with
// `error_code`, `status` and `details` beside it.
//
// WM's `message` is written for operators (it names the tenant id and WM API
// paths). This module turns the CODE into a sentence the signed-in user can act
// on, using only secret-free detail fields (provider, tier, model). The frontend
// carries the same table in `frontend/src/lib/workers/wm-errors.ts`; keep the two
// in step.

import { isIntegrationError } from '../integrations/_lib/errors';

export const WM_BYO_ERROR_CODES = [
  'BYO_KEY_WITHHELD',
  'BYO_KEY_UNUSABLE',
  'BYO_PROVIDER_NOT_CONFIGURED',
  'BYO_PROVIDER_CALL_FAILED',
  'MODEL_NOT_AVAILABLE_TO_TENANT',
  // WM's 402 for a commercial (byo_required) tenant with no provider row
  // (`BYORequiredError`). Lower-case on WM's side, and NOT in the typed
  // envelope: WM raises it as `HTTPException(402, detail={code, message})`, so
  // the wire body is `{error:{code:"ERROR", message:{code, message}, status:402}}`
  // (402 is absent from WM's status→code map). `byoCodeOf` reads that nesting.
  'byo_llm_not_configured',
] as const;

export type WmByoErrorCode = (typeof WM_BYO_ERROR_CODES)[number];

export interface WmByoError {
  code: WmByoErrorCode;
  /** HTTP status WM answered with, when known. */
  status?: number;
  /** A sentence for the signed-in user. Never the tenant id, a key or a WM path. */
  message: string;
  /**
   * The secret-free detail fields the sentence was built from (provider, tier,
   * model) — nothing else from WM's `details`, which also carries the tenant
   * id. Lets a browser rebuild the same sentence from the frontend table.
   */
  details: SafeByoDetails;
}

export interface SafeByoDetails {
  provider?: string;
  tier?: string;
  model?: string;
}

function safeDetails(d: Record<string, unknown>): SafeByoDetails {
  const out: SafeByoDetails = {};
  const provider = str(d.provider);
  const tier = str(d.tier);
  const model = str(d.model);
  if (provider) out.provider = provider;
  if (tier) out.tier = tier;
  if (model) out.model = model;
  return out;
}

function isByoCode(v: unknown): v is WmByoErrorCode {
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

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The BYO code inside a WM error envelope `error` object: its own `code`, or —
 * for an `HTTPException` raised with a dict `detail` (the 402) — the code
 * nested in `message`.
 */
function byoCodeOf(env: Record<string, unknown>): WmByoErrorCode | null {
  if (isByoCode(env.code)) return env.code;
  const nested = rec(env.message).code;
  return isByoCode(nested) ? nested : null;
}

/**
 * Read a WM BYO error out of a response body: the JSON envelope
 * (`{error:{code,status,details}}`) or an SSE error frame
 * (`{error:"…", error_code, status, details}`). Null for anything else.
 */
export function wmByoErrorFromBody(body: unknown): WmByoError | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  // SSE frame shape: `error` is a string, the code sits beside it.
  if (isByoCode(b.error_code)) {
    const details = (b.details && typeof b.details === 'object' ? b.details : {}) as Record<
      string,
      unknown
    >;
    const merged = { provider: b.provider, ...details };
    return {
      code: b.error_code,
      status: typeof b.status === 'number' ? b.status : undefined,
      message: wmByoUserMessage(b.error_code, merged),
      details: safeDetails(merged),
    };
  }
  // Envelope shape.
  const env = rec(b.error);
  const code = byoCodeOf(env);
  if (code) {
    return {
      code,
      status: typeof env.status === 'number' ? env.status : undefined,
      message: wmByoUserMessage(code, rec(env.details)),
      details: safeDetails(rec(env.details)),
    };
  }
  // FastAPI's default rendering of a dict `detail` (no WM handler in front).
  const detail = rec(b.detail);
  if (isByoCode(detail.code)) {
    return {
      code: detail.code,
      message: wmByoUserMessage(detail.code, rec(detail.details)),
      details: safeDetails(rec(detail.details)),
    };
  }
  return null;
}

/** The WM BYO error carried by an IntegrationError from the WM client, or null. */
export function wmByoErrorFromIntegrationError(err: unknown): WmByoError | null {
  if (!isIntegrationError(err)) return null;
  const found = wmByoErrorFromBody(err.upstreamBody);
  if (found && found.status === undefined && typeof err.upstreamStatus === 'number') {
    return { ...found, status: err.upstreamStatus };
  }
  return found;
}
