// src/routes/kanban/_errors.ts
// Translate a PlankaError (from the planka service layer) into the
// `{ status, data }` shape that server.ts's catch block serializes as a
// JSON response with the right HTTP status code.
//
// Handlers call: `throw toHttpError(err)` when they catch a PlankaError.
// Anything else should rethrow unchanged so the generic `handleError`
// branch catches it.
import { PlankaError, PlankaValidationError } from '../../services/planka/errors';
import { clientSafePlankaMessage, statusForPlankaError } from '../../utils/errors';

export interface HttpErrorShape {
  status: number;
  data: { error: string; message?: string; details?: unknown; code?: string };
}

/**
 * Map a PlankaError to an HTTP-shaped error object for server.ts's
 * typed-error branch. Non-PlankaError values are rethrown unchanged.
 */
export function toHttpError(err: unknown): HttpErrorShape {
  if (!(err instanceof PlankaError)) {
    // Let the caller rethrow; server.ts will fall through to handleError().
    throw err;
  }

  // ⛔ NEVER `err.message`. `mapPlankaError` builds it as
  //     `Planka <status> on <internal path>: <200 chars of raw upstream body>`
  // whenever the upstream body is not parsed JSON — deliberately, so an
  // OPERATOR can tell a real Planka 403 from an Istio ambient `RBAC: access
  // denied`. That snippet is for the log, not for the caller: it names an
  // internal Planka path and echoes an arbitrary upstream body, and these 33
  // routes are reachable by any authenticated user.
  //
  // `utils/errors.ts::handleError` was hardened against exactly this string.
  // This shim was the second door — it produced the very message the central
  // boundary refuses, on the routes that call it. Same status mapping, same
  // safe text, one shared table.
  const status = statusForPlankaError(err);
  const data: HttpErrorShape['data'] = {
    error: clientSafePlankaMessage(status),
    message: clientSafePlankaMessage(status),
  };

  // `details` IS forwarded for a validation error, matching handleError:
  // `fields` is Planka's `problems` array, which describes the CALLER's own
  // input and which they are entitled to see. It is not an upstream snippet.
  if (err instanceof PlankaValidationError) {
    data.details = err.fields;
  }

  return { status, data };
}
