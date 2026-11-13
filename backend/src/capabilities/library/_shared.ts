// fr-agui SPEC §13 P4a3 — spec drain, the rest of the tenant library: what the
// declarations in this directory share.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers are bound
// through lazy.ts.
//
// Every capability here keeps its route handler (`legacyHandler`), so runtime
// behaviour does not change; the declaration is the route CONTRACT for the
// derived spec. Each NEW operation gets operationId = camelCase(id) (SPEC §3.3),
// is tenant-scoped (platform for the super-admin stream andon cord) and
// `out-of-agent-scope`: none is derived here. What SPEC §13 P1c does with the
// matching agent actions differs by area — the `toc.*` actions and the
// `architecture.*` reads are RE-HOMED into the project agent (bound project's TOC
// / containers only); the rest (`streams.*`, …) are
// retired from the agent and stay in the UI.
import { z } from 'zod';
import { OPERATIONS, type OperationName } from '@fr/service-client-requirements';

import { defaultConfirm, defineCapability, type Capability, type CapabilityArea, type HttpMethod, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import type { CapabilityRoute } from '../rbac-rules';
import { frErrorBody } from '../research/_shared';

export { dataEnvelope, frErrorBody, pathId, upstreamBody } from '../research/_shared';

/**
 * The request-body model requirements_management declares for one of ITS
 * operations (by generated name), read from its openapi.json through the
 * generated client — so a forwarded body's declared type follows RM, never a
 * hand-kept name. An operation without a named body is a declaration error.
 */
export function rmRequestModel(op: OperationName): string {
  const entry = OPERATIONS[op] as { body?: string };
  if (entry.body === undefined) throw new Error(`requirements_management operation ${op} declares no named request body`);
  return entry.body;
}

/** `handleError` for a 401 (UnauthorizedError carries no `code`). */
export const unauthorizedBody = z.object({ error: z.string() });

/** The three messages `validateAuth` answers a 401 with, rendered by `handleError`. */
export const VALIDATE_AUTH_401 =
  "`error`: 'Missing or invalid Authorization header', 'Invalid or expired token' or 'unauthorized'.";

/** The licence / conveyor route doors `validateAuth` applies, rendered by `handleError` (`{ error, code }`). */
export const DOOR_403 =
  "403: `code` 'licence_route_not_allowed' (a licence token off the licence route allowlist), " +
  "'conveyor_route_forbidden' (the conveyor priority identity, non-GET) or a request-context refusal.";

/**
 * The responses of a route that is `validateAuth` → `handle(() => integration…)`
 * with an upstream client that REQUIRES a frame tenant (requirements_management:
 * architecture, TOC). `default` covers fr's 400 / coded 403 /
 * 409 / 500 and every upstream status relayed — the same `frErrorBody` as the
 * research proxies.
 */
export function proxyResponses(service: string, extra = ''): ResponseSpec[] {
  return [
    { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
    {
      status: 'default',
      description:
        "400: fr refused the input (`error.code` 'BAD_REQUEST': the body is not JSON; nothing sent upstream). " +
        DOOR_403 +
        ` 409: \`error.code\` 'MISSING_TENANT' (no request tenant: nothing is sent to ${service}).` +
        extra +
        " Any other status is the upstream's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / " +
        "5xx or no answer is 502, a timeout 504), or fr's own 500.",
      schema: frErrorBody,
    },
  ];
}

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export interface LibraryRoute {
  id: `${string}.${string}`;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  output?: z.ZodTypeAny;
  effect: Capability['effect'];
  /** The export of the route module the route table used. */
  handler: string;
  successStatus?: 201 | 202 | 204;
  /** The success media type when it is NOT JSON (a PNG download). */
  responseContentType?: string;
  /** Replaces the group's responses for this route. */
  responses?: ResponseSpec[];
}

interface LibraryGroup {
  area: CapabilityArea;
  tag: string;
  tenancy: Capability['tenancy'];
  module: string;
  load: () => Promise<Record<string, unknown>>;
  /** The declared rule, built for ONE route (its doors depend on (method, path)). */
  rule: (route: CapabilityRoute) => Capability['auth']['rbac'];
  responses: ResponseSpec[];
  output: z.ZodTypeAny;
}

/** One route module's NEW declarations. */
export function libraryCapabilities(group: LibraryGroup, routes: ReadonlyArray<LibraryRoute>): ReadonlyArray<Capability<unknown, unknown>> {
  return routes.map((r) =>
    defineCapability({
      id: r.id,
      area: group.area,
      summary: r.summary,
      ...(r.description !== undefined ? { description: r.description } : {}),
      http: {
        method: r.method,
        path: r.path,
        operationId: camel(r.id),
        ...(r.successStatus !== undefined ? { successStatus: r.successStatus } : {}),
        ...(r.responseContentType !== undefined ? { responseContentType: r.responseContentType } : {}),
      },
      input: r.input,
      output: r.output ?? (r.successStatus === 204 ? z.null() : group.output),
      errors: [],
      auth: { principal: 'user', rbac: group.rule({ method: r.method, path: r.path }) },
      tenancy: group.tenancy,
      effect: r.effect,
      confirm: defaultConfirm(r.effect),
      agent: { expose: false, reason: 'out-of-agent-scope' },
      openapi: { tags: [group.tag], responses: [...(r.responses ?? group.responses)] },
      legacyHandler: lazyHandler(group.load, { module: group.module, exportName: r.handler }),
    }),
  );
}

/** A `custom` rule bound to one route. */
export function routeRule(
  check: (ctx: Parameters<Extract<Capability['auth']['rbac'], { type: 'custom' }>['check']>[0], route: CapabilityRoute) => Promise<boolean>,
) {
  return (route: CapabilityRoute) => ({ type: 'custom' as const, check: (ctx: Parameters<typeof check>[0]) => check(ctx, route) });
}
