// src/lib/api/api-error.ts
//
// ONE formatter for the error envelope fr-backend returns, so a validation
// failure reaches the operator as a sentence instead of a JSON dump.
//
// fr-backend wraps every upstream failure as
//   { error: { code, message, service, upstream: { status, body } } }
// (backend/src/integrations/_lib/errors.ts integrationErrorResponse). What is
// inside `upstream.body` depends on which service failed, and the two shapes
// that matter are NOT the same:
//
//   1. billing_service replaces FastAPI's validation body wholesale in its own
//      RequestValidationError handler (billing_service/src/main.py:481-495 →
//      _error_envelope :430-448), so fr receives
//        { error: { code: 'VALIDATION_ERROR', message: 'Request validation
//          failed', status, request_id, timestamp, details?: [...] } }
//      — there is NO `detail` key. `details` is only present when the handler
//      passes leak_details (a sanitised [{field, message, type}] array); when
//      it is absent the generic `message` is all there is.
//
//   2. worker_management (and anything on stock FastAPI) returns
//        { detail: 'a string' }            — a raised HTTPException, or
//        { detail: [{loc, msg, type}, …] } — a 422 from Pydantic.
//      The array is the shape `JSON.stringify` used to dump verbatim into a
//      toast; `loc` is `['body', 'field_name']` for a field error and exactly
//      `['body']` for a whole-model (`model_validator`) error.
//
// Resolution order: error.details[] → error.message → detail (array|string) →
// err.message → body.message → the caller's fallback. The string-`detail` path
// is byte-identical to the implementation this replaced in llm-provider.ts.

/** Pydantic prefixes every `ValueError` raised in a validator with this. */
const VALUE_ERROR_PREFIX = 'Value error, ';

function cleanMessage(msg: string): string {
  return msg.startsWith(VALUE_ERROR_PREFIX) ? msg.slice(VALUE_ERROR_PREFIX.length) : msg;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function joinEntries(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('; ');
}

/**
 * billing's sanitised `error.details`: [{field, message, type}]. `field` is
 * empty/absent for a whole-body rule, in which case the message stands alone.
 */
function formatDetailsArray(entries: unknown[]): string {
  return joinEntries(
    entries.map((e) => {
      if (!isRecord(e)) return typeof e === 'string' ? cleanMessage(e) : '';
      const message = typeof e.message === 'string' ? cleanMessage(e.message) : '';
      if (!message) return '';
      const field = typeof e.field === 'string' ? e.field.trim() : '';
      return field ? `${field}: ${message}` : message;
    }),
  );
}

/**
 * Stock FastAPI `detail`: [{loc, msg, type}]. `loc[0]` is the request part
 * ('body'), so the field path is everything after it — empty for a
 * `model_validator` error, which then renders as the bare message.
 */
function formatDetailArray(entries: unknown[]): string {
  return joinEntries(
    entries.map((e) => {
      if (!isRecord(e)) return typeof e === 'string' ? cleanMessage(e) : '';
      const msg = typeof e.msg === 'string' ? cleanMessage(e.msg) : '';
      if (!msg) return '';
      const loc = Array.isArray(e.loc) ? e.loc : [];
      const path = (loc[0] === 'body' ? loc.slice(1) : loc)
        .map((p) => String(p))
        .filter((p) => p.length > 0)
        .join('.');
      return path ? `${path}: ${msg}` : msg;
    }),
  );
}

/** Format an already-parsed fr-backend error body. */
export function formatApiError(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  const err = body.error as Record<string, unknown> | string | undefined;
  if (typeof err === 'string') return err;

  if (isRecord(err)) {
    const upstream = err.upstream as { body?: unknown } | undefined;
    const ub = isRecord(upstream) ? (upstream.body as unknown) : undefined;

    // 1. billing's own envelope, nested inside the upstream body.
    const upstreamErr = isRecord(ub) ? (ub.error as unknown) : undefined;
    if (isRecord(upstreamErr)) {
      if (Array.isArray(upstreamErr.details)) {
        const formatted = formatDetailsArray(upstreamErr.details);
        if (formatted) return formatted;
      }
      if (typeof upstreamErr.message === 'string' && upstreamErr.message.length > 0) {
        return upstreamErr.message;
      }
    }

    // 2. stock FastAPI `detail`, array or string.
    const detail = isRecord(ub) ? ub.detail : undefined;
    if (Array.isArray(detail)) {
      const formatted = formatDetailArray(detail);
      // An array we cannot read stays visible rather than silently vanishing —
      // that is the pre-existing behaviour and still beats the fallback.
      return formatted || JSON.stringify(detail);
    }
    if (typeof detail === 'string' && detail.length > 0) return detail;
    if (detail && typeof detail === 'object') return JSON.stringify(detail);

    // 3. fr-backend's own message for the failure.
    if (typeof err.message === 'string') return err.message;
  }

  if (typeof body.message === 'string') return body.message;
  return fallback;
}

/** Read a non-ok Response and turn its body into a human-readable message. */
export async function apiErrorMessage(r: Response, fallback: string): Promise<string> {
  try {
    return formatApiError(await r.json(), fallback);
  } catch {
    // non-JSON body
    return fallback;
  }
}
