import {
  integrationErrorResponse,
  isIntegrationError,
} from '../../../integrations/_lib/errors';

/**
 * Log the cause of an upstream refusal before it becomes a Response.
 *
 * Why here, and why at all: `handle` converts an `IntegrationError` into an
 * HTTP Response, which means a handler wrapped in `emitSpan` RETURNS rather
 * than THROWS. `emitSpan` only writes `error_name`/`error_message` on its
 * throw path, and it snapshots its attributes before running the callback — so
 * the conversion silently erases the cause. Measured 2026-08-26: three live
 * 502s on `/api/tools/n8n/executions` logged nothing but
 * `{"name":"fr.n8n.list","status":"error","outcome":"error"}`. Nothing said
 * unreachable-vs-bad-key-vs-bad-status, and the real cause (n8n mid-rollout)
 * had to be recovered by correlating Kubernetes ReplicaSet timestamps.
 *
 * 16 call sites nest `handle` inside `emitSpan`, and all 41 `handle` callers
 * have the same gap, so this belongs in `handle` rather than at any one of
 * them. `emitSpan`'s signature is documented as FROZEN, and reordering every
 * site would be a far larger change for the same information.
 *
 * `correlation_id` is what ties this line back to the span and the access-log
 * line beside it. The upstream body is deliberately NOT logged — it can carry
 * tokens and PII.
 */
export function handle<T>(
  run: () => Promise<T>,
  toResponse: (value: T) => Response,
): Promise<Response> {
  return run().then(toResponse, (err: unknown) => {
    if (isIntegrationError(err)) {
      // Logging moved INTO `integrationErrorResponse` (integrations/_lib/errors.ts).
      // It lived here and reached this wrapper's 41 call sites only; the other 32
      // modules that convert an IntegrationError directly had no telemetry at all,
      // which is why the budget-502 burst left no cause behind. Logging in the
      // converter covers every caller by construction. Do NOT re-add it here — that
      // would double-log every failure this wrapper handles.
      return integrationErrorResponse(err);
    }
    throw err;
  });
}
