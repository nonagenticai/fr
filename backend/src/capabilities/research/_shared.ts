// fr-agui SPEC §13 P4a2 — spec drain, research: what the 58 research / media
// declarations share (capabilities/research/{discover,scientific,media}.ts).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers are bound
// through lazy.ts.
//
// The routes (routes/research/{discover,scientific,media}.ts) are one shape:
//
//   validateAuth(req)                 → 401 { error } | 403 { error, code } | 502/504 envelope
//   readJsonBody / require*Field      → 400 { error: { code: 'BAD_REQUEST', … } }
//   ctxTenantId(user.tenantId)        → the request-context tenant, else the JWT
//                                       tenant; THROWS when neither (→ 500)
//   handle(() => integration(…, tenantId), data => jsonResponse({ data }))
//                                     → 200 { data } | the upstream failure relayed
//                                       in fr's integration-error envelope
//
// so every declaration gets the SAME non-success responses (401 + `default`)
// and the same RBAC rule.
import { z } from 'zod';

import { defaultConfirm, defineCapability, type Capability, type CapabilityArea, type HttpMethod, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { isAuthenticatedUserInResolvedTenant, type CapabilityRoute } from '../rbac-rules';

/** fr's response envelope over the upstream payload (`jsonResponse({ data })`). */
export const dataEnvelope = z.object({ data: z.unknown() });

/** A body forwarded verbatim to the upstream; `type` is the upstream request model. */
export function upstreamBody(service: string, type: string) {
  return z.object({}).passthrough().describe(`Forwarded verbatim to the ${service} (${type}).`);
}

/** A `requireStringField` field: present, a string, not blank (a whitespace-only value is a 400). */
export const requiredString = (what: string) => z.string().min(1).describe(`${what}. Required and not blank (else 400 BAD_REQUEST).`);
/** A `requireArrayField` field: a non-empty array; its items are forwarded unchecked. */
export const requiredArray = (what: string) => z.array(z.unknown()).min(1).describe(`${what}. Required, non-empty (else 400 BAD_REQUEST).`);
/** A path segment, passed through `encodeURIComponent` to the upstream. */
export const pathId = (what: string) => z.string().min(1).describe(what);

/**
 * Every non-success body these routes answer, as ONE schema (inlined into each
 * of 58 operations, so it is kept small; the prose lives once, in the
 * 'Research' / 'Media' tag description in openapi.ts):
 *   * `handleError` for an AppError: `{ error: string, code?: string }` (a 401,
 *     a coded 403, fr's unexpected 500);
 *   * `integrationErrorResponse` (integrations/_lib/errors.ts) for every
 *     IntegrationError — fr's own caller-side refusals (`BAD_REQUEST`,
 *     `BAD_PATH`) and every upstream failure: `{ error: { code, message,
 *     upstream?: { status, body? }, … } }` (a super-admin also sees `service`
 *     and the raw upstream body).
 */
export const frErrorBody = z.object({
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), upstream: z.object({ status: z.number().int() }).passthrough().optional() }).passthrough(),
  ]),
  code: z.string().optional(),
});
/** `handleError` for a 401 (UnauthorizedError carries no `code`). */
const unauthorizedBody = z.object({ error: z.string() });

/**
 * The non-success responses every research / media route answers: the 401
 * (its own body), and OpenAPI's `default` ("any other status") for the rest —
 * fr's input refusals (400), its coded 403s and unexpected 500, and every
 * upstream status relayed. Two entries, not one per status: the schema is
 * inlined into each of 58 operations (no new `components`), and listing 400 /
 * 403 / 404 / … separately would repeat the same body six times per operation.
 * The statuses are named in the descriptions.
 */
const RESEARCH_RESPONSES: ReadonlyArray<ResponseSpec> = [
  {
    status: 401,
    description: "`error`: 'Missing or invalid Authorization header', 'Invalid or expired token' or 'unauthorized'.",
    schema: unauthorizedBody,
  },
  {
    status: 'default',
    description:
      "400: fr refused the input (`error.code` 'BAD_REQUEST' / 'BAD_PATH', nothing sent upstream). 403: `code` " +
      "'licence_route_not_allowed' (a licence token), 'conveyor_route_forbidden' (the conveyor identity, non-GET) or a " +
      "request-context refusal. Any other status is the upstream's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass " +
      "through, its 401 / 5xx or no answer is 502, a timeout 504; the Scientific Processor's 503 / 429 is relayed as " +
      "'UPSTREAM_BUSY' with its `Retry-After` header and `error.retry_after` / `error.upstream_error` / `error.lane`), " +
      "or fr's own 500.",
    schema: frErrorBody,
  },
];

/**
 * The route gate, declared for ONE route: authenticated, past validateAuth's
 * licence / conveyor doors for that (method, path), AND a tenant resolvable as
 * `ctxTenantId(user.tenantId)` resolves it.
 */
function authenticatedInTenant(route: CapabilityRoute) {
  return {
    type: 'custom' as const,
    check: (ctx: Parameters<typeof isAuthenticatedUserInResolvedTenant>[0]) =>
      isAuthenticatedUserInResolvedTenant(ctx, route),
  };
}

export interface ResearchRoute {
  id: `${'research' | 'media'}.${string}`;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  effect: Capability['effect'];
  /** The export of the route module the route table used. */
  handler: string;
  successStatus?: 201;
}

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** One route module's declarations: tenant-scoped, out-of-agent-scope, NEW operationId = camelCase(id). */
export function researchCapabilities(
  area: Extract<CapabilityArea, 'research' | 'media'>,
  tag: string,
  module: string,
  load: () => Promise<Record<string, unknown>>,
  routes: ReadonlyArray<ResearchRoute>,
): ReadonlyArray<Capability<unknown, unknown>> {
  return routes.map((r) =>
    defineCapability({
      id: r.id,
      area,
      summary: r.summary,
      ...(r.description !== undefined ? { description: r.description } : {}),
      http: {
        method: r.method,
        path: r.path,
        operationId: camel(r.id),
        ...(r.successStatus !== undefined ? { successStatus: r.successStatus } : {}),
      },
      input: r.input,
      output: dataEnvelope,
      errors: [],
      auth: { principal: 'user', rbac: authenticatedInTenant({ method: r.method, path: r.path }) },
      tenancy: 'tenant',
      effect: r.effect,
      confirm: defaultConfirm(r.effect),
      agent: { expose: false, reason: 'out-of-agent-scope' },
      openapi: { tags: [tag], responses: [...RESEARCH_RESPONSES] },
      legacyHandler: lazyHandler(load, { module, exportName: r.handler }),
    }),
  );
}
