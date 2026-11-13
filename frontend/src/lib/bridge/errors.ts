/**
 * Bridge error envelope — frontend mirror of the backend's
 * `integrationErrorResponse({ error: { code, message, service, upstream? } })`
 * shape (see backend/src/integrations/_lib/errors.ts §IntegrationError).
 *
 * The unified API client throws `ApiError` whose `data` field carries the
 * parsed JSON body. For bridge routes, that body is always
 * `{ error: { code, message, ... } }` on failure. Components should never
 * render `err.message` directly (which collapses the structured envelope to
 * `[object Object]` because `ApiError`'s constructor passes the object
 * through `super(message)`); instead they should call `parseBridgeError`
 * and render based on the resulting `code`.
 */

import { ApiError } from '../api/unified-client';

/**
 * Discriminated union of error codes the bridge backend may return on a
 * mutation route. Mirrors `IntegrationErrorCode` in
 * backend/src/integrations/_lib/errors.ts.
 *
 * Keep this union in sync with the backend; the catchall `unknown` arm
 * absorbs codes that have not yet been wired into the FE switch.
 */
export type BridgeErrorCode =
  // Upstream HTTP failure modes
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_BAD_STATUS'
  | 'UPSTREAM_BAD_BODY'
  | 'UPSTREAM_UNAUTHORIZED'
  | 'UPSTREAM_FORBIDDEN'
  | 'UPSTREAM_NOT_FOUND'
  | 'UPSTREAM_CONFLICT'
  // Bridge domain errors
  | 'draft_not_found'
  | 'draft_not_editable'
  | 'draft_not_rejectable'
  | 'draft_not_submittable'
  | 'draft_missing_target_list'
  | 'draft_insert_failed'
  | 'draft_update_failed'
  | 'approval_insert_failed'
  | 'kanban_unexpected_response'
  | 'output_not_found'
  | 'coding_output_not_cached'
  | 'coding_stable_id_unrecoverable'
  | 'coding_slice_not_landed'
  | 'unknown_producer'
  // Local / network failure (no envelope)
  | 'network_error'
  // Unknown code from backend (forward-compat)
  | 'unknown';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  /** HTTP status from the original response (0 for network errors). */
  status: number;
  /** Friendly, render-ready string keyed off the code. */
  friendly: string;
  /** Original raw body for debugging (developer console only). */
  raw?: unknown;
}

/**
 * Stable, human-readable copy keyed by code. Intended for end users; do NOT
 * include backend internals or stack traces. The actual backend `message` is
 * preserved on `BridgeError.message` and may be shown as a secondary detail.
 */
const FRIENDLY: Record<BridgeErrorCode, string> = {
  UPSTREAM_UNREACHABLE: 'Bridge service is unreachable. Try again shortly.',
  UPSTREAM_TIMEOUT: 'Bridge service timed out. Try again shortly.',
  UPSTREAM_BAD_STATUS: 'Bridge service returned an unexpected status.',
  UPSTREAM_BAD_BODY: 'Bridge request was malformed. Reload the page and retry.',
  UPSTREAM_UNAUTHORIZED:
    'Your session is no longer authorized for this action.',
  UPSTREAM_FORBIDDEN: 'You do not have permission to perform this action.',
  UPSTREAM_NOT_FOUND: 'The requested resource no longer exists.',
  UPSTREAM_CONFLICT: 'This action conflicts with the current draft state.',
  draft_not_found:
    'This draft was not found — it may have been deleted or rejected.',
  draft_not_editable:
    'This draft is no longer editable (it has already been submitted, ' +
    'committed, or rejected).',
  draft_not_rejectable:
    'This draft cannot be rejected from its current state.',
  draft_not_submittable:
    'This draft cannot be submitted from its current state.',
  draft_missing_target_list:
    'Cannot commit: the draft is missing a target list (column). Set a ' +
    'target list on the edit form before submitting.',
  draft_insert_failed:
    'Could not save the new draft. Try again or contact support.',
  draft_update_failed:
    'Could not save your changes. Try again or contact support.',
  approval_insert_failed:
    'Could not record the approval. Try again or contact support.',
  kanban_unexpected_response:
    'The kanban service returned an unexpected response. The card may or ' +
    'may not have been created — refresh the kanban board to check.',
  output_not_found:
    'The source tool output could not be located. It may have been ' +
    'expired or rotated.',
  coding_output_not_cached:
    'The coding finding has aged out of the cache; re-run the analysis ' +
    'before promoting.',
  coding_stable_id_unrecoverable:
    'The coding finding could not be uniquely identified for dedup.',
  coding_slice_not_landed:
    'The coding bridge slice is not deployed yet — try again after the ' +
    'next deploy.',
  unknown_producer:
    'The selected producer is not registered in the bridge.',
  network_error:
    'Network error reaching the bridge service. Check your connection.',
  unknown: 'Unexpected error. Try again or contact support.',
};

const KNOWN_CODES = new Set<BridgeErrorCode>(
  Object.keys(FRIENDLY) as BridgeErrorCode[],
);

function isKnownCode(value: unknown): value is BridgeErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value as BridgeErrorCode);
}

/**
 * Parse any thrown value from a bridge api call into a structured
 * `BridgeError`. Always succeeds — falls back to `code: 'unknown'` so callers
 * can render unconditionally without a try/catch.
 */
export function parseBridgeError(err: unknown): BridgeError {
  if (err instanceof ApiError) {
    const body = err.data as { error?: { code?: unknown; message?: unknown } } | undefined;
    const rawCode = body?.error?.code;
    const code: BridgeErrorCode = isKnownCode(rawCode) ? rawCode : 'unknown';
    const message =
      typeof body?.error?.message === 'string' && body.error.message.length > 0
        ? body.error.message
        : err.statusText || 'Request failed';
    return {
      code,
      message,
      status: err.status,
      friendly: FRIENDLY[code],
      raw: body,
    };
  }
  // Network-layer failure: ApiError sets status=0 for network errors, but
  // sometimes fetch throws a TypeError before reaching ApiError.
  if (err instanceof TypeError) {
    return {
      code: 'network_error',
      message: err.message,
      status: 0,
      friendly: FRIENDLY.network_error,
    };
  }
  if (err instanceof Error) {
    return {
      code: 'unknown',
      message: err.message,
      status: 0,
      friendly: FRIENDLY.unknown,
    };
  }
  return {
    code: 'unknown',
    message: String(err),
    status: 0,
    friendly: FRIENDLY.unknown,
  };
}
