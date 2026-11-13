/**
 * fr-agui SPEC §3.3 — the capability contract.
 *
 * ONE declaration per capability. Every artefact that used to be written by
 * hand in up to four places is DERIVED from it (SPEC §3.4):
 *
 *   (a) the router entry          derive-router.ts
 *   (b) the OpenAPI operation     derive-openapi.ts
 *   (c) the AG-UI agent action    derive-agent.ts
 *   (d) the MCP tool descriptor   derive-mcp.ts   (descriptors only, not served)
 *
 * ⛔ THIS MODULE AND EVERY CAPABILITY DECLARATION ARE SIDE-EFFECT FREE. They
 * import zod, pure helpers and types only — never the db, Keycloak, a route
 * module or the AG-UI registry. The served spec (`capabilities/served-spec.ts`) and the CI guards (which run
 * with NO environment) import the registry, so a declaration that pulled in a
 * route module would make the served spec and the guards depend on boot env.
 * Handlers are therefore bound through `lazyHandler` / `lazyActionHandler`
 * (lazy.ts): a cached dynamic import at the first call.
 *
 * P0b (SPEC §13): the skeleton only, NO behaviour change.
 *   - Existing operations carry their spec entry VERBATIM in `openapi.frozen`
 *     (moved out of the openapi.ts literal), so the served document is
 *     byte-identical and no n8n-nodes-fr regen is needed (SPEC §3.6).
 *   - Web routes keep their existing `Request` handler (`legacyHandler`).
 *   - The P0a agent actions are now derived from these declarations; their
 *     fingerprint is pinned against the hand-written originals
 *     (tests/unit/capabilities/derive-agent.test.ts).
 */
import type { ZodTypeAny } from 'zod';

import type { ActionContext, ApprovalPolicy, ProposalSpec, RbacRuleLike } from '../agui/types';
import { extractJsonSchema } from './json-schema';

/** Same NAME_RE as agui/registry.ts — the id doubles as the AG-UI action name and the MCP tool name. */
const CAPABILITY_ID_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** Appendix A rows. Widened per unit as areas are migrated. */
export type CapabilityArea =
  | 'projects'
  | 'approvals'
  | 'conveyor'
  | 'project_requests'
  | 'ui'
  | 'kag'
  | 'internal'
  | 'webhooks'
  | 'research'
  | 'media'
  // P4a3 — the rest of the tenant library.
  | 'architecture'
  | 'toc'
  // P4b — tenant settings and services.
  | 'settings'
  | 'url_credentials'
  | 'channels'
  | 'secrets'
  | 'tenant'
  | 'inapp'
  | 'notifications'
  | 'connectors'
  | 'scheduled_triggers'
  | 'suggested_schedules'
  | 'reports'
  | 'workers'
  | 'workflows'
  | 'tools'
  // P4b part 3 — the caller's account, tenant billing, workspace members, repositories, the GitHub App callback.
  | 'me'
  | 'billing'
  | 'workspace'
  | 'repositories'
  | 'github_app'
  // P4b part 3 — the analysis-to-kanban bridge and the analytics rollups (routes/tools/{bridge,analytics}.ts).
  | 'bridge'
  | 'analytics'
  // P4c part 1 — tenant and platform oversight (capabilities/observe/*, capabilities/admin/*).
  | 'card_types'
  | 'asset_assignments'
  | 'traceability'
  | 'measure'
  | 'engagements'
  | 'andon'
  | 'departments'
  | 'verification'
  | 'control_tower'
  // P1c — the confirm-card route for agent-native writes (POST /api/capabilities/:id/invoke).
  | 'capabilities'
  // P4c part 2 — the asset console, the platform access console.
  | 'asset_console'
  | 'admin_users'
  // P4c part 3 — the licensing console, pricing, user provisioning.
  | 'licensing'
  | 'pricing'
  | 'provisioning'
  // P4d-2b — the kanban group: fr's Planka proxy + liveness, and the super_admin asset passthrough.
  | 'kanban'
  | 'kanban_assets'
  // P4d-2a — the projects / cards / approvals group (spec drain).
  | 'documents'
  | 'comments'
  | 'metrics'
  | 'knowledge_areas'
  | 'cards'
  | 'activity'
  // P4d-2a part 2 — the split-family contracts, the PM execution-card minter and the Readying split.
  | 'decompositions'
  // P4d-2c — the library group: the governed asset kinds and the library list surfaces, asset bindings,
  // the project-scope override / block edges, the asset-authoring publish dispatcher.
  | 'library'
  | 'asset_bindings'
  | 'asset_scope'
  | 'asset_authoring'
  // P4d-2d — the platform group: the super-admin tenant LLM-provider mirror and tenant inference, the
  // health probe, the AG-UI wire protocol + agent chat, the coding spine, the frontend error sink.
  | 'llm_provider'
  | 'inference'
  | 'system'
  | 'agui'
  | 'agent'
  | 'coding'
  | 'client_errors'
  // Early-access signup v2 — the signup queue, its two service doors and the super_admin onboarding screen.
  | 'signup_approvals';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ErrorSpec {
  status: number;
  code: string;
}

/**
 * fr-agui P4d-1 — the server's licence route door (utils/routed-dispatch.ts
 * `assertLicenceBearerRouteAllowed`): a licence-shaped bearer on a route that is not on
 * the licence route allowlist is refused 403 `{ error, code: 'licence_route_not_allowed' }`
 * right after routing, before the handler runs. Every route that is not allowlisted can
 * answer it.
 */
export const LICENCE_ROUTE_DOOR_ERROR: ErrorSpec = { status: 403, code: 'licence_route_not_allowed' };

/**
 * SPEC §3.7 rule 3 — the CLOSED vocabulary for `agent.expose:false`.
 * `decision-pending:<ref>` names the open question or unit that decides it.
 */
type AgentExclusionReason =
  | 'out-of-agent-scope'
  | 'session-precondition'
  | 'service-to-service'
  | 'transport'
  | 'conveyor-lane'
  | 'browser-redirect'
  | `decision-pending:${string}`;

const AGENT_EXCLUSION_REASONS: ReadonlyArray<string> = [
  'out-of-agent-scope',
  'session-precondition',
  'service-to-service',
  'transport',
  'conveyor-lane',
  'browser-redirect',
];

export function isAgentExclusionReason(r: string): r is AgentExclusionReason {
  return AGENT_EXCLUSION_REASONS.includes(r) || /^decision-pending:[A-Za-z0-9._-]+$/.test(r);
}

/**
 * Agent-only metadata the AG-UI action needs and the route never did. Present
 * only when `expose: true`; everything here maps 1:1 onto an
 * `AgentCallableAction` field (derive-agent.ts).
 */
interface AgentExposure<I> {
  expose: true;
  tier: 'core' | 'searchable';
  /** `AgentCallableAction.idempotencyKey`. */
  idempotencyKey: (input: I) => string | Promise<string>;
  /** `AgentCallableAction.cronSafe`. */
  cronSafe: boolean;
  /** The confirm card a web proposal renders (writes with `confirm !== 'none'`). */
  card?: ProposalSpec['card'];
  /** `AgentCallableAction.channelPendingText`. */
  channelPendingText?: (input: I, ctx: ActionContext, approvalId: string) => string;
  idempotencyTtlSeconds?: number;
  approvalTtlSeconds?: number;
}

type AgentDecl<I> = AgentExposure<I> | { expose: false; reason: AgentExclusionReason };

export interface CapabilityHttp {
  method: HttpMethod;
  /** Express style (`/api/projects/:id`). `null` ⇒ agent-native write (POST /api/capabilities/:id/invoke, P1c). */
  path: string | null;
  /**
   * REQUIRED and FROZEN for every operation already in the spec (SPEC §3.3 /
   * F3). Never derived from `id` for an existing operation.
   */
  operationId: string;
  idempotencyHeader?: 'Idempotency-Key';
  /** fr-agui P4b part 3: 302 — a browser redirect (no body; the target in `Location`). */
  successStatus?: 200 | 201 | 202 | 204 | 302;
  stream?: 'ndjson';
  /**
   * The request body media type when it is NOT JSON. `multipart/form-data`
   * names the binary part(s) in `fileFields`; derive-openapi emits them as
   * `{type: string, format: binary}` (the zod input cannot express a file).
   */
  requestBody?: { contentType: 'multipart/form-data'; fileFields: string[] };
  /**
   * fr-agui P4b — input properties that travel in the QUERY STRING on a method
   * that also carries a JSON body (`PUT /api/settings/llm-provider?tier=…`).
   * derive-openapi emits them as `in: query` parameters instead of body
   * properties. GET/DELETE need none (every non-path property is a query one).
   */
  queryFields?: string[];
  /**
   * The success response media type when it is NOT JSON (a streamed image,
   * a download). derive-openapi emits `{type: string, format: binary}` under it.
   */
  responseContentType?: string;
  /**
   * fr-agui P4b part 3 — a FEATURE-FLAGGED route: deriveRouter registers the row
   * only when this returns true at boot (the bridge routes, FR_FEATURE_BRIDGE).
   * The derived spec documents the operation either way, and every static
   * instrument (route order, coverage) reads the table as the flag-ON superset.
   */
  mountedWhen?: () => boolean;
  /**
   * fr-agui P4d-1 — input properties that travel in the JSON BODY where the
   * default placement would put them elsewhere:
   *   - on a DELETE, the named properties form an (optional unless required)
   *     JSON body instead of query parameters (`{ keep_board }`);
   *   - on a body method, a name that is ALSO a path parameter is emitted both
   *     as the path parameter and as a body property (the route reads the path,
   *     and its body schema requires the same key).
   * Legacy routes only: the adapter (derive-router.ts) reads neither form.
   */
  bodyFields?: string[];
  /**
   * fr-agui P4d-1 — request headers the ROUTE reads (not part of `input`), emitted
   * as `in: header` parameters. A closed list: each name here is one a route
   * really reads. Legacy routes only.
   */
  headers?: ReadonlyArray<RequestHeaderSpec>;
  /**
   * fr-agui P4d-2d — an operation the server answers OUTSIDE the router (`GET /health`: a direct
   * pathname match in the Bun.serve fetch handler, before routing, touching no dependency it does
   * not report). The value names where it is served. The derived spec documents it; deriveRouter
   * registers no row and the static route table has none (capabilityRouteRows skips it), so it
   * carries no handler at all.
   */
  unrouted?: string;
  /**
   * fr-agui P4d-2e — the inverse of `unrouted`: a ROUTED row with NO spec operation, and why. Only
   * for a byte-level passthrough whose contract is the upstream's (the Evidence Review
   * `/api/assets/kag/reviews(.*)` proxy: any method, any sub-path, status / ETag / problem+json
   * forwarded raw), which no operation can describe honestly. derive-openapi emits nothing for it;
   * the route-coverage guard exempts it by this reason (scripts/check-route-spec-coverage.ts
   * EXEMPT_ROUTES); deriveRouter registers it like any row. Legacy routes only, never agent-exposed.
   */
  specExempt?: string;
}

/** A request header a legacy route reads (see `CapabilityHttp.headers`). */
export interface RequestHeaderSpec {
  name: 'X-Target-Tenant-Id';
  required: boolean;
  description: string;
}

/**
 * A NON-success, NON-`CodedError` response a route really answers with, and its
 * exact body (fr-agui P4a1): an approval park (`202 { data: PendingAction }`), a
 * legacy refusal whose body carries no `code` (so `errors` / `CodedError` would
 * misdescribe it). derive-openapi emits it as JSON under `schema`.
 */
export interface ResponseSpec {
  /**
   * An HTTP status, or OpenAPI's `default` (fr-agui P4a2): every status the
   * operation can answer that is NOT listed — for a proxy route, the upstream
   * statuses fr relays (an upstream 404 / 409 / 422 / 429 / 5xx) in one body.
   */
  status: number | 'default';
  description: string;
  schema: ZodTypeAny;
}

interface CapabilityOpenApi {
  /**
   * The operation object EXACTLY as it stood in the openapi.ts literal, moved
   * here verbatim. derive-openapi.ts emits it unchanged, so a migration keeps
   * the served document byte-identical (SPEC §3.6, P0b acceptance). Its
   * `operationId` must equal `http.operationId` (checked by defineCapability).
   */
  frozen?: Record<string, unknown>;
  /**
   * Tags of a NEW (non-frozen) operation. Required for one: the served spec
   * gives every operation a tag, and each must be declared in the openapi.ts
   * literal's top-level `tags[]` (tests/unit/openapi-spec-integrity.test.ts).
   */
  tags?: string[];
  /** Further responses of a NEW (non-frozen) operation; see `ResponseSpec`. */
  responses?: ResponseSpec[];
  /**
   * NEW operations only (ignored when `frozen` is set): `security` (default:
   * the document-level bearerAuth) and `x-internal` (a service-to-service
   * operation, not a typed-client op).
   */
  security?: Array<Record<string, string[]>>;
  internal?: boolean;
}

export type LegacyRouteHandler = (req: Request, ...params: string[]) => Promise<Response>;

export interface Capability<I = unknown, O = unknown> {
  id: `${string}.${string}`;
  area: CapabilityArea;
  /** OpenAPI summary for a NEW operation; the agent tool description (first line). */
  summary: string;
  /** Longer agent text; never tenant data. */
  description?: string;
  http: CapabilityHttp;
  /** The agent-facing input (body ∪ query ∪ path). */
  input: ZodTypeAny;
  output: ZodTypeAny;
  errors: ErrorSpec[];
  auth: {
    principal: 'user' | 'service' | 'public' | 'webhook';
    rbac: RbacRuleLike;
  };
  tenancy: 'self' | 'tenant' | 'project' | 'platform';
  effect: 'read' | 'write' | 'destructive';
  confirm: 'none' | 'card' | 'card-typed';
  /** JSON-pointer paths (`/github_access_token`); SPEC §10.1. */
  secrets?: { input?: string[]; output?: string[] };
  conveyorGated?: boolean;
  /** Output fields owned by requirements_management (render read-only). */
  rmOwned?: string[];
  agent: AgentDecl<I>;
  /** Must equal the licence-route-allowlist.ts row (guarded, never derived; SPEC §3.5). */
  licence?: { ops: string[] };
  approval?: ApprovalPolicy;
  parking?: 'policy' | 'never';
  autoApproveForInitiator?: boolean;
  openapi?: CapabilityOpenApi;
  /** Server-side execution (reads; channel writes). */
  handler?: (input: I, ctx: ActionContext) => Promise<O>;
  /** The existing web route handler, kept unchanged during migration (SPEC §3.6). */
  legacyHandler?: LegacyRouteHandler;
}

export class InvalidCapabilityError extends Error {
  constructor(id: string, reason: string) {
    super(`capability ${id}: ${reason}`);
    this.name = 'InvalidCapabilityError';
  }
}

const HTTP_METHODS: ReadonlyArray<HttpMethod> = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** The derived default for `confirm` (SPEC §3.3). */
export function defaultConfirm(effect: Capability['effect']): Capability['confirm'] {
  return effect === 'read' ? 'none' : effect === 'write' ? 'card' : 'card-typed';
}

/**
 * Validate and return one declaration. Every rule here is a structural fact a
 * derivation relies on; a declaration that breaks one fails at module load,
 * not in a request.
 */
export function defineCapability<I, O>(cap: Capability<I, O>): Capability<I, O> {
  const fail = (reason: string): never => {
    throw new InvalidCapabilityError(cap.id, reason);
  };
  if (!CAPABILITY_ID_RE.test(cap.id)) fail('id must be <area>.<verb_noun> (lowercase, one dot)');
  if (!cap.summary.trim()) fail('summary is required');
  if (!HTTP_METHODS.includes(cap.http.method)) fail(`http.method ${cap.http.method} is not a route method`);
  if (!/^[a-z][A-Za-z0-9]*$/.test(cap.http.operationId)) fail('http.operationId must be a camelCase identifier');
  if (cap.http.path !== null && !cap.http.path.startsWith('/')) fail('http.path must start with /');
  if (cap.http.path === null && cap.http.method !== 'POST') fail('an agent-native write (path null) is POST');
  if (cap.http.requestBody !== undefined) {
    if (cap.http.method === 'GET' || cap.http.method === 'DELETE') fail('a GET/DELETE carries no request body');
    if (cap.http.requestBody.fileFields.length === 0) fail('a multipart body names at least one file field');
  }
  if (cap.http.queryFields !== undefined) {
    if (cap.http.method === 'GET' || cap.http.method === 'DELETE') fail('queryFields is for a method with a body; a GET/DELETE input is all query');
    if (cap.http.queryFields.length === 0) fail('queryFields names at least one field');
  }
  if (cap.http.responseContentType !== undefined && /json/i.test(cap.http.responseContentType)) {
    fail('responseContentType is for a NON-JSON response; omit it for JSON');
  }
  if (cap.http.successStatus === 302 && cap.legacyHandler === undefined) {
    fail('a 302 (browser redirect) is a legacy route: the adapter cannot set its Location');
  }
  if (cap.http.mountedWhen !== undefined && cap.http.path === null) fail('mountedWhen is for a routed capability');
  if (cap.http.bodyFields !== undefined) {
    if (cap.http.method === 'GET') fail('a GET carries no request body (bodyFields)');
    if (cap.http.bodyFields.length === 0) fail('bodyFields names at least one field');
    if (cap.legacyHandler === undefined) fail('bodyFields is for a legacy route: the adapter reads no such body');
    if (cap.http.method !== 'DELETE') {
      const params = cap.http.path === null ? [] : [...cap.http.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
      for (const f of cap.http.bodyFields) {
        if (!params.includes(f)) fail(`bodyFields ${f}: on a ${cap.http.method} only a name shared with a path parameter needs listing`);
      }
    }
  }
  if (cap.http.headers !== undefined) {
    if (cap.http.headers.length === 0) fail('headers names at least one header');
    if (cap.legacyHandler === undefined) fail('headers is for a legacy route: the adapter reads no header');
    for (const h of cap.http.headers) if (!h.description.trim()) fail(`header ${h.name} needs a description`);
  }
  if (cap.http.unrouted !== undefined) {
    if (cap.http.path === null) fail('unrouted is for an operation with a path');
    if (!cap.http.unrouted.trim()) fail('unrouted names where the operation is served');
    if (cap.handler !== undefined || cap.legacyHandler !== undefined) fail('an unrouted operation has no router handler');
    if (cap.agent.expose) fail('an unrouted operation is not agent-exposed');
  } else if (cap.http.path !== null && cap.handler === undefined && cap.legacyHandler === undefined) {
    fail('a routed capability needs handler or legacyHandler');
  }
  if (cap.http.specExempt !== undefined) {
    if (!cap.http.specExempt.trim()) fail('specExempt names why no operation can describe the route');
    if (cap.http.path === null || cap.http.unrouted !== undefined) fail('specExempt is for a routed row');
    if (cap.legacyHandler === undefined) fail('specExempt is for a legacy passthrough route');
    if (cap.agent.expose) fail('a specExempt route is not agent-exposed');
    if (cap.openapi?.frozen !== undefined || (cap.openapi?.responses ?? []).length > 0) fail('a specExempt route declares no operation');
  }
  const frozen = cap.openapi?.frozen;
  if (frozen !== undefined && frozen.operationId !== cap.http.operationId) {
    fail(`openapi.frozen.operationId (${String(frozen.operationId)}) must equal http.operationId`);
  }
  if (frozen === undefined && cap.http.path !== null && cap.http.specExempt === undefined && (cap.openapi?.tags ?? []).length === 0) {
    fail('a new (non-frozen) routed operation names openapi.tags');
  }
  const extra = cap.openapi?.responses ?? [];
  if (extra.length > 0) {
    if (frozen !== undefined) fail('openapi.responses is for a new (non-frozen) operation');
    const taken = new Set<number | 'default'>([cap.http.successStatus ?? 200, ...cap.errors.map((e) => e.status)]);
    for (const r of extra) {
      if (r.status !== 'default' && (!Number.isInteger(r.status) || r.status < 100 || r.status > 599)) {
        fail(`openapi.responses status ${r.status} is not an HTTP status`);
      }
      if (taken.has(r.status)) fail(`openapi.responses status ${r.status} is already declared`);
      if (!r.description.trim()) fail(`openapi.responses ${r.status} needs a description`);
      // derive-openapi emits `extractJsonSchema(r.schema)`; a schema it cannot
      // convert (a non-zod value) or that converts to `{}` (z.unknown / z.any)
      // would publish a response body that describes nothing.
      const json = extractJsonSchema(r.schema);
      if (json === null || Object.keys(json).length === 0) {
        fail(`openapi.responses ${r.status} schema is not an extractable zod schema`);
      }
      taken.add(r.status);
    }
  }
  if (cap.effect === 'read' && cap.confirm !== 'none') fail('a read never confirms');
  if (cap.effect !== 'read' && cap.confirm === 'none') fail('a write or destructive capability confirms');
  if (cap.effect === 'destructive' && cap.confirm !== 'card-typed') fail('destructive ⇒ card-typed');
  if (cap.parking === 'never' && cap.effect === 'read') fail("parking:'never' is for a write");
  for (const p of [...(cap.secrets?.input ?? []), ...(cap.secrets?.output ?? [])]) {
    if (!/^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(p)) fail(`secret path ${p} is not a JSON pointer`);
  }
  if (cap.agent.expose) {
    if (cap.effect !== 'read' && cap.agent.card === undefined) fail('an agent-exposed write names its confirm card');
    // Every write with a server-side handler is offered on every channel (George
    // 2026-10-30); one without a handler is web-only (derive-agent.ts `isWebOnlyWrite`).
    if (cap.effect === 'read' && cap.handler === undefined) fail('an agent-exposed read needs a server-side handler');
  } else if (!isAgentExclusionReason(cap.agent.reason)) {
    fail(`agent.reason ${cap.agent.reason} is not in the closed vocabulary (SPEC §3.7 rule 3)`);
  }
  return cap;
}
