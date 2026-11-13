// fr-agui SPEC §13 P4d-2e — the Evidence Review 8810 passthrough (`/api/assets/kag/reviews(.*)`,
// routes/assets/kag-reviews.ts), the last `router.add` rows of src/server.ts, as registry rows.
//
// ONE handler for FIVE methods over a regex sub-path: a BYTE-LEVEL forwarder (status, an allowlist
// of headers — ETag among them — and the raw body, application/problem+json kept), because Evidence
// Review's contract depends on what a re-serializing proxy destroys (the route module's header). No
// OpenAPI operation can describe "any method, any sub-path, the upstream's answer verbatim", so
// these rows are `http.specExempt` — routed, never in the served spec — and exempted, with this
// reason, by scripts/check-route-spec-coverage.ts EXEMPT_ROUTES. The contract is Evidence Review's
// own OpenAPI (kag `/reviews` gateway prefix).
//
// Gate (the handler's, unchanged): validateAuth, then the caller's bearer is forwarded (Evidence
// Review derives the acting human from it); `409 tenant_context_conflict` for a switched super-admin.
// Declared `out-of-agent-scope`; the order against the specific `/api/assets/kag/*` rows is the
// pinned overlap pairs' (route-overlap-pairs.json), exactly as before.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defaultConfirm, defineCapability, type Capability, type HttpMethod } from '../define';
import { lazyHandler } from '../lazy';
import { routeRule } from '../library/_shared';
import { isAuthenticatedUser } from '../rbac-rules';

const PATH = '/api/assets/kag/reviews(.*)';

export const KAG_REVIEWS_SPEC_EXEMPT =
  'Evidence Review 8810 byte-level passthrough: any method and sub-path, the upstream status / ETag / problem+json ' +
  'forwarded raw (routes/assets/kag-reviews.ts). The contract is Evidence Review’s; no fr operation can describe it.';

const METHODS: ReadonlyArray<{ id: `${string}.${string}`; operationId: string; method: HttpMethod; effect: Capability['effect'] }> = [
  { id: 'kag.reviews_passthrough_get', operationId: 'kagReviewsPassthroughGet', method: 'GET', effect: 'read' },
  { id: 'kag.reviews_passthrough_post', operationId: 'kagReviewsPassthroughPost', method: 'POST', effect: 'write' },
  { id: 'kag.reviews_passthrough_patch', operationId: 'kagReviewsPassthroughPatch', method: 'PATCH', effect: 'write' },
  { id: 'kag.reviews_passthrough_put', operationId: 'kagReviewsPassthroughPut', method: 'PUT', effect: 'write' },
  { id: 'kag.reviews_passthrough_delete', operationId: 'kagReviewsPassthroughDelete', method: 'DELETE', effect: 'destructive' },
];

const rule = routeRule(isAuthenticatedUser);

export const KAG_REVIEWS_PASSTHROUGH_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = METHODS.map(({ id, operationId, method, effect }) =>
  defineCapability({
    id,
    area: 'kag',
    summary: `Evidence Review passthrough (${method} /api/assets/kag/reviews/…)`,
    http: {
      method,
      path: PATH,
      operationId,
      specExempt: KAG_REVIEWS_SPEC_EXEMPT,
    },
    input: z.object({}).passthrough().describe('Forwarded verbatim to Evidence Review.'),
    output: z.unknown().describe("Evidence Review's answer, verbatim."),
    errors: [],
    auth: { principal: 'user', rbac: rule({ method, path: PATH }) },
    tenancy: 'tenant',
    effect,
    confirm: defaultConfirm(effect),
    agent: { expose: false, reason: 'out-of-agent-scope' },
    legacyHandler: lazyHandler(() => import('../../routes/assets/kag-reviews'), {
      module: 'src/routes/assets/kag-reviews.ts',
      exportName: 'handleKagReviewsProxy',
    }),
  }),
);
