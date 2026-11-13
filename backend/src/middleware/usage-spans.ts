// src/middleware/usage-spans.ts
//
// Per-request metering emit. Wraps a route handler so every dispatched
// request fires one span onto the `metering:events` Redis stream (via
// services/metering-emit), tagged with the active request-context
// tenantId + userId.
//
// Wiring is in server.ts — this module is intentionally tiny so the
// server file's hot path stays readable.
//
// SKIP RULES (no emit for):
//   * Health probes: /health, /healthz, /ready, /api/metrics/prom
//   * The metering read endpoints themselves (/api/me/usage/*,
//     /api/me/licenses/*) — emitting on these would create a positive-
//     feedback loop where rendering the page bumps the page's own
//     counters.
//   * Anything that doesn't reach this middleware (WebSocket upgrades,
//     /openapi.json, /, /health) — those return early in server.ts
//     before we wrap, so the skip list only needs to cover routes that
//     ARE router-dispatched.

import { statusForError } from '../utils/errors';
import { tryGetRequestContext } from '../integrations/_lib/context';
import { recordSpan } from '../services/metering-emit';
import { switchedSuperAdminFrame } from '../lib/super-admin-tenant-audit';
import { INTERNAL_SYSTEM_TENANT_ID } from './internal-tenant-only';
import { recordMeteringSpanAttribution } from '../lib/metering-span-metrics';

type RouteHandler = (req: Request, ...params: string[]) => Promise<Response>;

/**
 * Pathname prefixes / exact matches we never emit for.
 *
 * Health + prom are listed defensively even though server.ts short-circuits
 * them before reaching the router — so any future move that pushes them
 * through the router won't silently start polluting metering.
 */
const SKIP_EXACT: ReadonlySet<string> = new Set([
  '/health',
  '/healthz',
  '/ready',
  '/api/metrics/prom',
  '/openapi.json',
  '/',
  // Unauthenticated work-initiation interlock that every n8n workflow polls
  // (~480 calls / 30 min). No credential, so no tenant can EVER be attributed:
  // each span reached billing-service as `tenant_id: ''` and was ~all of its
  // `tenant_id_unattributed` warnings. It is platform plumbing, not tenant
  // usage, so it is not metered at all. Exact match only — the sibling
  // `POST /api/internal/andon/read-failure` and the user-facing
  // `GET /api/andon` header poll are still metered.
  '/api/internal/andon',
  // billing-service's own project -> tenant map pull (X-Internal-Token,
  // FR_BILLING_INTERNAL_TOKEN). The caller carries no tenant and the answer
  // spans every tenant; metering billing's lookup back into billing is
  // self-feeding, same rationale as /api/me/usage/*.
  '/api/internal/projects/tenant-map',
]);

const SKIP_PREFIX: readonly string[] = [
  '/api/me/usage/',
  '/api/me/licenses/',
  // Per-operation cost read (cost-correlation standard) — a metering read,
  // same self-feeding rationale as /api/me/usage/*.
  '/api/me/costs/',
];

function shouldSkip(pathname: string): boolean {
  if (SKIP_EXACT.has(pathname)) return true;
  for (const p of SKIP_PREFIX) {
    if (pathname.startsWith(p)) return true;
  }
  return false;
}

/**
 * Log the first unattributed span seen for each distinct pathname, so the
 * counter's `attributed="no"` arm can be turned into a list of routes to fix
 * without paying request-path cardinality on a Prometheus label.
 *
 * Bounded: once the set reaches {@link UNATTRIBUTED_LOG_CAP} distinct paths it
 * stops growing (and stops logging new ones). fr's pathnames embed uuids, so an
 * unbounded set is a slow leak; the counter, not this log, is the durable
 * signal.
 */
const UNATTRIBUTED_LOG_CAP = 200;
const warnedUnattributedPaths = new Set<string>();

/**
 * Routes that are tenantless BY DESIGN: no verified identity ever reaches them,
 * so there is no tenant `attributeRequestTo()` could honestly publish. The
 * warning below exists to name routes that COULD be attributed and are not;
 * for these it is a false lead (measured in prod logs, 7d to 2026-10-05).
 *
 * ⚠️ This list ONLY silences the per-path warning. It never sets a tenant, and
 * the span is still emitted and still counted as `attributed="no"` — an honest
 * nil, never a default (see the ⛔ note in `withUsageSpans`). A route here that
 * later gains a verified bearer is attributed as usual; the entry just becomes
 * inert.
 *
 * Add a route only when its credential carries NO tenant (a dedicated
 * service-to-service token, or no credential at all). Never add a user route
 * to make its warning go away — publish the tenant instead.
 */
const DELIBERATELY_TENANTLESS: readonly { method: string; path: RegExp }[] = [
  // Unauthenticated by design (routes/client-errors.ts header): the browser
  // reporter deliberately sends NO Authorization header, so even a logged-in
  // user's report has no verified identity here.
  { method: 'POST', path: /^\/api\/client-errors$/ },
  // worker_management -> fr, `X-Internal-Token` only. The CARD's tenant is the
  // answer being looked up, not the caller's tenant — billing it there would
  // attribute WM's call to whichever platform tenant owns the card.
  // routes/internal-card-platform-owner.ts.
  { method: 'GET', path: /^\/api\/internal\/cards\/[^/]+\/platform-owner$/ },
];

/**
 * Whether an unattributed span is EXPECTED, so the "fix this route" warning
 * would be noise:
 *   - a 401: the request was refused authentication, so by definition no
 *     verified identity exists to attribute (measured: every unattributed
 *     `GET /api/tools/n8n/executions` and `.../providers/:p/models` span in
 *     prod was a 401 from a logged-out/expired poller);
 *   - a route on {@link DELIBERATELY_TENANTLESS}.
 */
function isExpectedUnattributed(
  method: string,
  pathname: string,
  statusCode: number,
): boolean {
  if (statusCode === 401) return true;
  return DELIBERATELY_TENANTLESS.some((r) => r.method === method && r.path.test(pathname));
}

function warnUnattributedOnce(method: string, pathname: string): void {
  const key = `${method} ${pathname}`;
  if (warnedUnattributedPaths.has(key)) return;
  if (warnedUnattributedPaths.size >= UNATTRIBUTED_LOG_CAP) return;
  warnedUnattributedPaths.add(key);
  console.warn(
    `[usage-spans] metering span emitted with NO tenant for ${key} — ` +
      'billing will attribute it to the nil tenant. If this route has a ' +
      'resolvable tenant, publish it with attributeRequestTo().',
  );
}

/**
 * Wrap a router-dispatched handler. Returns a function with the same
 * `(req, ...params) => Promise<Response>` shape; on each call, the
 * original handler runs, the response is captured, and one metering
 * span is emitted (fire-and-forget) before we return the response.
 *
 * If the handler throws, we synthesise a status (500 by default, or
 * `error.status` when present) so the emit still records the failure,
 * and then re-throw.
 */
export function withUsageSpans(handler: RouteHandler): RouteHandler {
  return async function wrapped(req: Request, ...params: string[]): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
    const skip = shouldSkip(pathname);
    const start = Date.now();

    let response: Response;
    let thrown: unknown;
    let statusCode = 500;
    try {
      response = await handler(req, ...params);
      statusCode = response.status;
    } catch (err) {
      thrown = err;
      // The status the CALLER will actually be given, from the same mapping
      // `handleError` uses to give it.
      //
      // ⚠️ This used to duck-type `err.status`. NO error class in this repo
      // carries `.status` — `AppError` carries `statusCode`, `IntegrationError`
      // carries neither — so the probe never matched and every THROWN error was
      // metered as the `statusCode = 500` default above, while errors RETURNED
      // as a Response were recorded correctly. Measured over 9 days,
      // `/api/webhooks/n8n/execution-event` shows 424 metered events, ALL 500,
      // against 65x404 / 120x422 / ZERO 500s in fr's own access log for the same
      // route. A route that never 500s was the estate's top 500-emitter.
      //
      // Shared function, not a better guess: a second copy of the mapping is how
      // the first one drifted out of agreement with the boundary.
      statusCode = statusForError(err);
      // Re-emit, then re-throw below so server.ts's central catch can
      // shape the user-visible response.
    }

    if (!skip) {
      const ctx = tryGetRequestContext();
      // ── ATTRIBUTION IS COUNTED, NOT ASSUMED ──────────────────────────────
      //
      // `ctx.tenantId` is populated by `buildRequestContext` from a VERIFIED
      // bearer token, and by `attributeRequestTo` for handlers whose credential
      // is not on `Authorization` (the n8n webhook receivers, the agui
      // body-credential refresh). When neither applies the span still goes out
      // with an empty tenant, because billing wants the request counted — but
      // billing does NOT reject it: it logs `tenant_id_unattributed` and writes
      // the row to the nil tenant anyway. That made the leak invisible from
      // both ends. Measured on worker4 over 3h on 2026-09-04: fr's three n8n
      // webhook routes alone produced 384 such rows, ≈2,733/day.
      //
      // So: emit the same span as before, and COUNT the omission. An
      // unattributed span is now a number on fr's own exporter
      // (`fr_metering_spans_total{attributed="no"}`) and a named route in the
      // log, once per distinct pathname per process.
      //
      // ⛔ It deliberately does NOT substitute a default tenant. A default here
      // would bill one real customer for everyone else's traffic, which is a
      // strictly worse failure than an honest nil.
      const attributed = Boolean(ctx?.tenantId);
      recordMeteringSpanAttribution(attributed);
      // The warning is the to-do list of routes to attribute; a span that is
      // tenantless by design (401, or `DELIBERATELY_TENANTLESS`) is not on it.
      // Still counted above — the counter is the durable, honest signal.
      if (!attributed && !isExpectedUnattributed(method, pathname, statusCode)) {
        warnUnattributedOnce(method, pathname);
      }
      // George 2026-10-27 decision: a super_admin switched into another tenant
      // (or their switched Copilot session) is OPERATOR activity, not customer
      // usage. Bill it to the system tenant and record the tenant acted in as
      // `operator_target_tenant_id`; the customer's project id is not carried
      // onto the system tenant's row. Same predicate as the audit
      // (lib/super-admin-tenant-audit.ts `switchedSuperAdminFrame`).
      const operator = ctx ? switchedSuperAdminFrame(ctx) : null;
      // Fire-and-forget. `recordSpan` already swallows its own errors.
      void recordSpan({
        tenantId: operator ? INTERNAL_SYSTEM_TENANT_ID : ctx?.tenantId,
        ...(operator ? { operatorTargetTenantId: operator.tenantId } : {}),
        userId: ctx?.userId,
        // Guard-validated only — see lib/project-owner-guard.ts. `ctx.projectId`
        // is never set from anything but `setProjectId()`, which only the
        // guard's callers invoke.
        projectId: operator ? undefined : ctx?.projectId,
        route: pathname,
        method,
        statusCode,
        latencyMs: Date.now() - start,
      });
    }

    if (thrown !== undefined) {
      throw thrown;
    }
    return response!;
  };
}
