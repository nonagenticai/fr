// fr-agui SPEC §13 P4d-2 — spec drain of the routes that ALREADY had an operation in
// the served spec (the `src/openapi.ts` literal): what their declarations share.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// Every route keeps its handler (`legacyHandler`), so nothing changes at runtime. Its
// literal operation moves into the declaration VERBATIM (`openapi.frozen`, SPEC §3.3:
// operationId and operation body byte-identical; the literal keeps only the position
// marker), so n8n-nodes-fr and the frontend client keep their operations unchanged.
// The only edits a frozen object takes are DECLARATION fixes the real-pipeline sweep
// requires, each named where it is made (e.g. the server's licence-door 403 on a route
// that is not on the licence allowlist).
//
// The agent-facing input is the frozen operation's own parameters and body
// (`frozenInput`): path and query parameters typed from their schemas, a JSON body as
// its listed properties (unknown keys kept — the route's own validator is the
// contract). None of these is agent-exposed here (`out-of-agent-scope`): the project
// agent reads several of them through hand-written actions that run the route as the
// human (agui/actions/project-core.ts), unchanged.
import { z, type ZodTypeAny } from 'zod';

import { defaultConfirm, defineCapability, type Capability, type CapabilityArea, type HttpMethod } from './define';
import { isLicenceRouteAllowed } from '../lib/licence-route-allowlist';
import { lazyHandler } from './lazy';
import type { CapabilityRoute } from './rbac-rules';

type Json = Record<string, unknown>;

/** One OpenAPI parameter/property schema → zod (the shapes the literal uses). */
function zodOfSchema(s: Json | undefined): ZodTypeAny {
  if (s === undefined || typeof s !== 'object') return z.unknown();
  let out: ZodTypeAny;
  const t = s.type;
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === 'string')) {
    out = z.enum(s.enum as [string, ...string[]]);
  } else if (t === 'string') {
    out = s.format === 'uuid' ? z.string().uuid() : z.string();
  } else if (t === 'integer') {
    out = z.number().int();
  } else if (t === 'number') {
    out = z.number();
  } else if (t === 'boolean') {
    out = z.boolean();
  } else if (t === 'array') {
    out = z.array(zodOfSchema(s.items as Json | undefined));
  } else if (t === 'object') {
    out = z.record(z.unknown());
  } else {
    out = z.unknown();
  }
  if (s.nullable === true) out = out.nullable();
  if (typeof s.description === 'string') out = out.describe(s.description);
  return out;
}

/** A query parameter arrives as a string: a typed one is coerced, as the route parses it. */
function zodOfQuery(s: Json | undefined): ZodTypeAny {
  const t = s?.type;
  if (t === 'integer') return z.coerce.number().int();
  if (t === 'number') return z.coerce.number();
  if (t === 'boolean') return z.enum(['true', 'false']);
  return zodOfSchema(s);
}

/** The frozen operation's path / query parameters and JSON body, as the declaration's input. */
function frozenInput(frozen: Json): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const p of (frozen.parameters ?? []) as Json[]) {
    const name = String(p.name);
    if (p.in === 'path') shape[name] = zodOfSchema(p.schema as Json | undefined);
    else if (p.in === 'query') {
      const q = zodOfQuery(p.schema as Json | undefined);
      shape[name] = p.required === true ? q : q.optional();
    }
  }
  const body = (frozen.requestBody as Json | undefined)?.content as Record<string, Json> | undefined;
  const schema = (body?.['application/json'] ?? body?.['multipart/form-data'])?.schema as Json | undefined;
  if (schema !== undefined && schema.type === 'object' && schema.properties !== undefined) {
    const required = new Set((schema.required ?? []) as string[]);
    for (const [k, v] of Object.entries(schema.properties as Record<string, Json>)) {
      if (k in shape) continue;
      const f = zodOfSchema(v);
      shape[k] = required.has(k) ? f : f.optional();
    }
  }
  return z.object(shape).passthrough();
}

export interface FrozenRoute {
  id: `${string}.${string}`;
  /** Overrides the group's area. */
  area?: CapabilityArea;
  method: HttpMethod;
  path: string;
  /** The export of the route module the route table used. */
  handler: string;
  effect: Capability['effect'];
  /** The rule the route's gate amounts to, for THIS route (its doors depend on (method, path)). */
  rule: (route: CapabilityRoute) => Capability['auth']['rbac'];
  /** The literal operation, VERBATIM (see header). */
  frozen: Json;
  /** Its row in lib/licence-route-allowlist.ts. */
  licenceOps?: string[];
  secrets?: { input?: string[]; output?: string[] };
  /**
   * The handler reads the body with an unguarded `req.json()`, so a non-JSON body is the
   * pipeline's 400 `{ error: 'invalid JSON body' }` (utils/routed-dispatch.ts
   * `tagInboundJsonParseErrors`). A literal that declared no 400 / default gains it.
   * `'integration'`: the handler's own `readJsonBody` / `readJsonValidated` refusal instead — 400
   * `{ error: { code: 'BAD_REQUEST', message } }` (P4d-2c). `{ error }`: the handler's own catch, answering
   * 400 `{ error }` with that message (P4d-2d).
   */
  nonJson400?: NonJson400Kind;
  tenancy?: Capability['tenancy'];
  /** Overrides the group's module (a route group whose handlers live in two files). */
  source?: { module: string; load: () => Promise<Record<string, unknown>> };
  output?: ZodTypeAny;
  summary?: string;
  /**
   * P4d-2d — a route whose caller is not a user (an n8n webhook: X-Webhook-Secret; a service:
   * X-Internal-Token; the public probe). The declaration names it; the route's own handler
   * enforces it, unchanged. Default 'user'.
   */
  principal?: Capability['auth']['principal'];
  /**
   * P4d-2d — the literal declared no 401 / default, yet the route answers a caller with no credential 401: the
   * frozen object gains a 401 with this description.
   */
  unauthorized401?: string;
  /** P4d-2d — the agent exclusion reason (default 'out-of-agent-scope'). */
  agentReason?: 'out-of-agent-scope' | 'service-to-service' | 'transport';
}

interface FrozenGroup {
  area: CapabilityArea;
  tenancy: Capability['tenancy'];
  module: string;
  load: () => Promise<Record<string, unknown>>;
}

/**
 * The server's licence route door (utils/routed-dispatch.ts `assertLicenceBearerRouteAllowed`):
 * a licence-shaped bearer on a route that is NOT on the licence allowlist is refused 403
 * `{ error, code: 'licence_route_not_allowed' }` right after routing, before the handler. A
 * literal operation that declares neither a 403 nor a `default` did not say so; its frozen
 * object gains exactly this response (the one edit).
 */
export const LICENCE_DOOR_403 = {
  description:
    "`code` 'licence_route_not_allowed': a licence-shaped bearer. This route is not on the licence route allowlist, so the " +
    'server refuses it right after routing, before the handler runs.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } },
} as const;

/** `frozen` with the licence-door 403 added when the route is off the allowlist and declares no 403 / default. */
export function withLicenceDoor(method: HttpMethod, path: string, frozen: Json): Json {
  const responses = (frozen.responses ?? {}) as Json;
  if (isLicenceRouteAllowed(method, path) || '403' in responses || 'default' in responses) return frozen;
  return { ...frozen, responses: { ...responses, '403': LICENCE_DOOR_403 } };
}

const NON_JSON_400 = {
  description: "`error` 'invalid JSON body': the body is not JSON (refused before anything is written).",
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
} as const;

/**
 * fr-agui P4d-2c — the routes that read their body with `readJsonBody` / `readJsonValidated`
 * (routes/_lib/request.ts) throw an IntegrationError BAD_REQUEST before anything else runs; the
 * central catch renders it as the integration envelope.
 */
const NON_JSON_400_INTEGRATION = {
  description:
    "`error.code` 'BAD_REQUEST' ('Invalid JSON request body'): the body is not JSON (refused before anything is read or written).",
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
  },
} as const;

/** How a route refuses a non-JSON body (see `FrozenRoute.nonJson400`). */
type NonJson400Kind = true | 'integration' | { error: string; what?: string };

/**
 * P4d-2d — a handler's own non-JSON catch: 400 `{ error: <message> }`. `what` names the refused
 * body when it is not "not JSON" (e.g. a multipart route: 'the body is not multipart/form-data').
 */
function nonJson400Own(message: string, what = 'the body is not JSON') {
  return {
    description: `\`error\` '${message}': ${what} (refused before anything is written).`,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  } as const;
}

/** `frozen` with the pipeline's non-JSON 400 added when it declares no 400 / default. */
function withNonJson400(frozen: Json, kind: NonJson400Kind = true): Json {
  const responses = (frozen.responses ?? {}) as Json;
  if ('400' in responses || 'default' in responses) return frozen;
  const r400 = kind === true ? NON_JSON_400 : kind === 'integration' ? NON_JSON_400_INTEGRATION : nonJson400Own(kind.error, kind.what);
  return { ...frozen, responses: { ...responses, '400': r400 } };
}

/** P4d-2d — `frozen` with a measured 401 added when it declares no 401 / default. */
function withUnauthorized401(frozen: Json, description: string): Json {
  const responses = (frozen.responses ?? {}) as Json;
  if ('401' in responses || 'default' in responses) return frozen;
  return { ...frozen, responses: { ...responses, '401': { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } };
}

/** The success body is the frozen operation's (the served contract); the agent never reads it. */
const FROZEN_OUTPUT = z.unknown().describe("The frozen operation's success body (openapi.frozen).");

/** The frozen object with its measured, named additions (licence door 403, non-JSON 400, 401), in that fixed order. */
function frozenWithMeasuredResponses(r: FrozenRoute): Json {
  let op = r.frozen;
  if (r.unauthorized401 !== undefined) op = withUnauthorized401(op, r.unauthorized401);
  if (r.nonJson400 !== undefined) op = withNonJson400(op, r.nonJson400);
  return withLicenceDoor(r.method, r.path, op);
}

export function frozenRouteCapabilities(group: FrozenGroup, routes: ReadonlyArray<FrozenRoute>): ReadonlyArray<Capability<unknown, unknown>> {
  return routes.map((r) => {
    const src = r.source ?? group;
    const route = { method: r.method, path: r.path };
    return defineCapability({
      id: r.id,
      area: r.area ?? group.area,
      summary: r.summary ?? String(r.frozen.summary),
      http: { method: r.method, path: r.path, operationId: String(r.frozen.operationId) },
      input: frozenInput(r.frozen),
      output: r.output ?? FROZEN_OUTPUT,
      errors: [],
      auth: { principal: r.principal ?? 'user', rbac: r.rule(route) },
      tenancy: r.tenancy ?? group.tenancy,
      effect: r.effect,
      confirm: defaultConfirm(r.effect),
      ...(r.secrets !== undefined ? { secrets: r.secrets } : {}),
      ...(r.licenceOps !== undefined ? { licence: { ops: r.licenceOps } } : {}),
      agent: { expose: false, reason: r.agentReason ?? 'out-of-agent-scope' },
      openapi: { frozen: frozenWithMeasuredResponses(r) },
      legacyHandler: lazyHandler(src.load, { module: src.module, exportName: r.handler }),
    });
  });
}
