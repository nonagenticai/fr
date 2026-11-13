// fr-agui SPEC §13 P4b — spec drain, tenant settings and services: what the
// declarations in this directory share.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers are bound
// through lazy.ts.
//
// Every capability here keeps its route handler (`legacyHandler`), so runtime
// behaviour does not change; the declaration is the route CONTRACT for the
// derived spec. Each NEW operation gets operationId = camelCase(id) (SPEC §3.3),
// is tenant-scoped (`self` where the handler reads the caller's own rows) and
// `out-of-agent-scope` (SPEC §13 Deferred: tenant settings, money and privilege
// stay in the classic UI). None is on the licence route allowlist.
//
// 🔐 SECRETS (SPEC §5.5 / §10.1). `secrets.input` names every request field that
// carries a secret value (rendered as a SecretField, never echoed into a thread);
// `secrets.output` names every response field that DOES carry one. A pointer
// names object keys only and steps through arrays (`/items/credentials` is the
// `credentials` of every `items[]` element). A route that REDACTS (a channel's
// `credentials`, a BYO key reduced to `hasKey`) declares no such field in its
// output schema at all, so the contract never implies a value is returned.
import { z } from 'zod';

import { defaultConfirm, defineCapability, type Capability, type CapabilityArea, type HttpMethod, type RequestHeaderSpec, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import type { CapabilityRoute } from '../rbac-rules';

export { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, unauthorizedBody } from '../library/_shared';

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export interface SettingsRoute {
  id: `${string}.${string}`;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  effect: Capability['effect'];
  /** The export of the route module the route table used. */
  handler: string;
  successStatus?: 201 | 202 | 204;
  responses: ResponseSpec[];
  secrets?: { input?: string[]; output?: string[] };
  queryFields?: string[];
  /** P4d-1: `CapabilityHttp.bodyFields` (a DELETE body; a body key that shares a path parameter's name). */
  bodyFields?: string[];
  /** P4d-1: `CapabilityHttp.headers` (request headers the route reads). */
  headers?: ReadonlyArray<RequestHeaderSpec>;
  /** P4d-2a: `CapabilityHttp.responseContentType` (a non-JSON success body). */
  responseContentType?: string;
  /** Replaces the group's rule for this route. */
  rule?: (route: CapabilityRoute) => Capability['auth']['rbac'];
  tenancy?: Capability['tenancy'];
}

export interface SettingsGroup {
  area: CapabilityArea;
  tag: string;
  tenancy: Capability['tenancy'];
  module: string;
  load: () => Promise<Record<string, unknown>>;
  /** The declared rule, built for ONE route (its doors depend on (method, path)). */
  rule: (route: CapabilityRoute) => Capability['auth']['rbac'];
}

/** One route module's NEW declarations. */
export function settingsCapabilities(
  group: SettingsGroup,
  routes: ReadonlyArray<SettingsRoute>,
): ReadonlyArray<Capability<unknown, unknown>> {
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
        ...(r.queryFields !== undefined ? { queryFields: r.queryFields } : {}),
        ...(r.bodyFields !== undefined ? { bodyFields: r.bodyFields } : {}),
        ...(r.headers !== undefined ? { headers: r.headers } : {}),
        ...(r.responseContentType !== undefined ? { responseContentType: r.responseContentType } : {}),
      },
      input: r.input,
      output: r.output,
      errors: [],
      auth: { principal: 'user', rbac: (r.rule ?? group.rule)({ method: r.method, path: r.path }) },
      tenancy: r.tenancy ?? group.tenancy,
      effect: r.effect,
      confirm: defaultConfirm(r.effect),
      ...(r.secrets !== undefined ? { secrets: r.secrets } : {}),
      agent: { expose: false, reason: 'out-of-agent-scope' },
      openapi: { tags: [group.tag], responses: [...r.responses] },
      legacyHandler: lazyHandler(group.load, { module: group.module, exportName: r.handler }),
    }),
  );
}

/** The workspace-admin rule (agui/rbac.ts), route-aware, with the P4b options. */
export function workspaceAdminRule(
  opts: { superAdmin?: true; frameTenant?: true | 'untrimmed'; deptAdminOf?: string; systemTenantSuperOnly?: true; deptManagerOfPromoteTarget?: true } = {},
) {
  return (route: CapabilityRoute) => ({ type: 'workspace-admin' as const, route, ...opts });
}

/** `handleError` over an AppError / ZodError: `{ error, details?, code? }`. */
export const appErrorBody = z.object({ error: z.string(), code: z.string().optional(), details: z.unknown().optional() });

/**
 * The server-level licence route door (src/server.ts → utils/routed-dispatch.ts
 * `assertLicenceBearerRouteAllowed`): a licence-shaped bearer on a route that is not
 * on the licence route allowlist is refused right after routing, BEFORE the handler
 * runs — so a handler that renders every validateAuth throw as its own 401 never
 * sees it. `handleError` over the ForbiddenError: `{ error, code }`.
 */
export const LICENCE_ROUTE_DOOR_403 =
  "`code` 'licence_route_not_allowed': a licence-shaped bearer. This route is not on the licence route allowlist, " +
  'so the server refuses it right after routing, BEFORE the handler runs (the handler — and its own 401 — never sees it).';

/** A refusal answered before the handler runs: `{ error, code }` (the licence route door, a request-context refusal). */
export const preHandlerRefusalBody = z.object({ error: z.string(), code: z.string() });
