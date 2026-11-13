// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: what the NEW operations in this
// directory share (the routes that had no operation in the served spec, LEGACY_UNDECLARED).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// Every capability here keeps its route handler (`legacyHandler`), so runtime behaviour does not
// change; the declaration is the route CONTRACT for the derived spec. Each one gets operationId =
// camelCase(id) (SPEC §3.3) and is NOT agent-exposed. Unlike `settingsCapabilities` (P4b), a route
// here may name a non-user caller (`principal`: the public AG-UI catalogue, the frontend error
// sink, an inbound intake webhook) and its own `security` / agent exclusion reason, and may stream
// NDJSON (`http.stream`). None is on the licence route allowlist.
import { z } from 'zod';

import { defaultConfirm, defineCapability, type Capability, type CapabilityArea, type HttpMethod, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import type { CapabilityRoute } from '../rbac-rules';

export { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, unauthorizedBody } from '../library/_shared';

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Never through the registry or the agent: deny-all at that layer (the handler owns its auth). */
export const neverThroughRegistry = () => ({ type: 'custom' as const, check: async () => false });

export interface PlatformRoute {
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
  /** The success body is NDJSON (one AG-UI event per line). */
  stream?: 'ndjson';
  /** OpenAPI security (default: the document-level bearerAuth); `[]` = no bearer. */
  security?: Array<Record<string, string[]>>;
  secrets?: { input?: string[]; output?: string[] };
}

export interface PlatformGroup {
  area: CapabilityArea;
  tag: string;
  tenancy: Capability['tenancy'];
  module: string;
  load: () => Promise<Record<string, unknown>>;
  /** The declared rule, built for ONE route (its doors depend on (method, path)). */
  rule: (route: CapabilityRoute) => Capability['auth']['rbac'];
  principal?: Capability['auth']['principal'];
  agentReason?: 'out-of-agent-scope' | 'service-to-service' | 'transport';
  /** `x-internal`: a service-to-service operation, not a typed-client op. */
  internal?: true;
}

/** One route module's NEW declarations. */
export function platformCapabilities(group: PlatformGroup, routes: ReadonlyArray<PlatformRoute>): ReadonlyArray<Capability<unknown, unknown>> {
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
        ...(r.stream !== undefined ? { stream: r.stream } : {}),
      },
      input: r.input,
      output: r.output,
      errors: [],
      auth: { principal: group.principal ?? 'user', rbac: group.rule({ method: r.method, path: r.path }) },
      tenancy: group.tenancy,
      effect: r.effect,
      confirm: defaultConfirm(r.effect),
      ...(r.secrets !== undefined ? { secrets: r.secrets } : {}),
      agent: { expose: false, reason: group.agentReason ?? 'out-of-agent-scope' },
      openapi: {
        tags: [group.tag],
        responses: [...r.responses],
        ...(r.security !== undefined ? { security: r.security } : {}),
        ...(group.internal ? { internal: true } : {}),
      },
      legacyHandler: lazyHandler(group.load, { module: group.module, exportName: r.handler }),
    }),
  );
}

/** `withIntegrationCatch` + an IntegrationError: `{ error: { code, message } }`. */
export const integrationBody = z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() });

/** The licence route door (utils/routed-dispatch.ts), before the handler: `{ error, code }`. */
export const doorBody = z.object({ error: z.string(), code: z.string() });

export const LICENCE_DOOR_403_TEXT =
  "403: `code` 'licence_route_not_allowed' — a licence-shaped bearer; this route is not on the licence route allowlist, " +
  'so the server refuses it right after routing, BEFORE the handler runs.';
