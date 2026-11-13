import { z } from 'zod';
import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { CODING_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import { getBundleTokenMinter } from '../lib/bundle-token-minter';
import {
  getListProviderModelsUrl,
  getListProvidersUrl,
  getCreateWorkerUrl,
  getListWorkersUrl,
  getGetWorkerUrl,
  getGetWorkerStatesUrl,
  getUpdateWorkerUrl,
  getDeleteWorkerUrl,
  getSendWorkerMessageUrl,
  getChatCompletionsUrl,
  type ListWorkersParams,
  type WorkerCreateRequest,
  type WorkerResponse,
  type MessageRequest,
  type MessageResponse,
  type ProviderListResponse,
  type ProviderModelListResponse,
  type GetWorkerStates200Item,
} from '@fr/service-client-workers';
export type { ListWorkersParams };

const listWorkersParamsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strip();

export function parseListWorkersParams(
  sp: URLSearchParams,
): ListWorkersParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return listWorkersParamsSchema.parse(raw) as ListWorkersParams;
}

// Streaming chat completions can legitimately take a long time; regular CRUD
// should fail fast so the frontend doesn't hang on a dead upstream.
//
// 2026-08-19: 120_000 -> 1_200_000, matched to worker_management's
// IR_HTTP_READ_TIMEOUT_S / AGENT_RUN_TIMEOUT_S and inference-router's
// INFERENCE_ROUTER_CHAIN_DEADLINE_SECONDS, all 1200s. pgx now serves a DENSE
// Qwen3.8-27B at 11-19 tok/s where it served an MoE gemma-4-26B-A4B at ~56
// tok/s, so a long answer that took ~45s now takes minutes.
//
// ⚠️ Read what this timeout actually covers before sizing anything against it.
// `HttpClient.proxy` clears the abort timer in a `finally` on the `fetch`
// itself, so it bounds TIME-TO-RESPONSE-HEADERS, not the lifetime of the
// stream. Upstream sends SSE headers in ~2s and the body is then piped out
// with NO timer attached. So this value was NOT what truncated long chats, and
// raising it does not by itself keep a slow stream alive — the real budget
// lives in worker_management and inference-router. It is raised here so the
// ladder reads consistently and so a genuinely slow FIRST byte (cold model
// load on pgx is ~8 minutes after a swap, because a model change invalidates
// the torch.compile cache) is not cut off at the door.
const CRUD_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 1_200_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'worker_management',
      baseUrl: config.services.workers.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // NEVER the end user's Keycloak JWT: since WM#362 `Authorization` is read
      // as a LICENCE (a non-licence there is a hard 401). The only thing fr puts
      // in `Authorization` is the tenant's own `workers` licence
      // (`tenantCredentialProvider` below). Role checks use
      // `X-Caller-Authorization`, a different header.
      sendAuthorization: false,
      // fr's OWN licence, in the ONLY header worker_management introspects.
      //
      // Until now these calls landed on `auth_middleware.py:651-684`, the
      // TOKENLESS trusted-network branch: nothing proved fr was entitled to the
      // tenant it asserted, so `_audit_identity_omission` counts every one of
      // them and `request.state.license_id` / `subject_id` are set to None. That
      // is the recorded mechanism behind billing's structurally licence-less
      // cost events, and it is refused outright the moment
      // WORKER_MANAGEMENT_REQUIRE_AUTHENTICATED_TENANT is turned on.
      //
      // `CODING_SERVICE_TOKEN` is REUSED rather than a new credential minted:
      // its introspected subject is `019ffe9f-31fd-70da-b3c5-f921f7290b01`
      // (`svc-fr-backend`), which is listed in worker_management's live
      // `AUTH_DELEGATING_SUBJECTS` (gitops #3813, verified on the running
      // deployment 2026-09-11). That listing is what lets the delegation gate at
      // `auth_middleware.py:548-549` adopt the `X-Effective-Tenant-Id` this
      // option sends alongside, so BYO resolution and the cost event follow the
      // CUSTOMER tenant instead of fr's service account.
      //
      // ⚠️ Safe when the secret is absent: no token ⇒ no Bearer, and the plain
      // `X-Tenant-Id` trusted-network request goes out byte-identical to today.
      // That matters because `auth_middleware.py:501-510` validates ANY token it
      // is given even from a trusted network and 401s an inactive one — it does
      // NOT fall back to the tokenless branch. A half-attached credential would
      // therefore take a working path down; both headers or neither is enforced
      // in the client.
      //
      // ⚠️ TRANSITIONAL (George 2026-10-15: licences are tenant×app only, no
      // app-to-app licences). This delegation pair is now only the FALLBACK
      // for a tenant `tenantCredentialProvider` below cannot mint for.
      tenantBearerEnvVar: CODING_SERVICE_TOKEN_ENV,
      // THE TENANT'S OWN `workers` LICENCE, minted per tenant by licenses'
      // bundle-token route with the dedicated `fr-bundle-minter` SA
      // (BUNDLE_MINTER_CLIENT_ID/SECRET, realm secure-apps), cached until
      // expiry - 5 min, single-flight per tenant (lib/bundle-token-minter.ts).
      //
      // Sent as `Authorization: Bearer <tenant workers token>`: WM reads the
      // licence from `X-Tenant-Id: Bearer` OR `Authorization: Bearer`
      // (`_extract_license_token`, WM#362) and checks `app.key == "workers"`
      // (WM#363, observe mode). With it the request carries NO
      // `X-Tenant-Id: Bearer <fr coding licence>` and NO `X-Effective-Tenant-Id`,
      // but it KEEPS `X-End-User-Token` (the signed-in user's portal token,
      // when it proves this tenant): the licence names the tenant, the
      // end-user token names the user inside it, which WM needs for worker
      // ownership, `visibility='user'` scoping and per-user cost attribution
      // (WM honouring it on the licence branch lands separately).
      //
      // Only an auth-layer 401 (`WWW-Authenticate: Bearer`) invalidates and
      // re-mints the tenant token; WM handler 401s are returned as is.
      //
      // FALLBACK (transitional): a tenant whose bundle lacks `workers` (404
      // `no_bundle`), or any mint failure, yields no token and the request
      // goes out on the delegated path above, byte-identical to before. The
      // minter logs that once per tenant (`[bundle-token] … outcome=no_bundle`),
      // and WM's observe-mode `wm_licence_app_total{outcome="delegated"}`
      // names who is still delegated. Unconfigured minter ⇒ always fallback.
      tenantCredentialProvider: getBundleTokenMinter('workers'),
      // The signed-in user's portal token rides DELEGATED calls as
      // `X-End-User-Token` (worker_management#316): WM decrypts the tenant's
      // BYO key only with that proof. See `HttpClientOptions.forwardEndUserToken`.
      forwardEndUserToken: true,
      // WM#324 / fr row 15: never call WM without a tenant. A tenantless call
      // is not refused upstream — WM serves its DEFAULT tenant to a tokenless
      // trusted-network caller, i.e. someone else's data. And fr must not
      // patch the gap with its own licence or the system tenant (strict tenant
      // separation). No frame tenant ⇒ MISSING_TENANT before anything is sent;
      // callers render that as an explicit unavailable/empty state.
      requireTenant: true,
    });
  }
  return cachedClient;
}

export async function listWorkers(params?: ListWorkersParams): Promise<string[]> {
  return await http().json<string[]>(getListWorkersUrl(params), { method: 'GET' });
}

export async function getWorker(workerName: string): Promise<WorkerResponse> {
  return await http().json<WorkerResponse>(getGetWorkerUrl(workerName), { method: 'GET' });
}

export async function createWorker(body: WorkerCreateRequest): Promise<WorkerResponse> {
  return await http().json<WorkerResponse>(getCreateWorkerUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateWorker(
  workerName: string,
  body: WorkerCreateRequest,
): Promise<WorkerResponse> {
  return await http().json<WorkerResponse>(getUpdateWorkerUrl(workerName), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteWorker(workerName: string): Promise<void> {
  await http().json<void>(getDeleteWorkerUrl(workerName), { method: 'DELETE' });
}

export async function sendWorkerMessage(
  workerName: string,
  body: MessageRequest,
): Promise<MessageResponse> {
  return await http().json<MessageResponse>(getSendWorkerMessageUrl(workerName), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: STREAM_TIMEOUT_MS,
  });
}

export async function listWorkerProviders(): Promise<ProviderListResponse> {
  return await http().json<ProviderListResponse>(getListProvidersUrl(), { method: 'GET' });
}

export async function listWorkerProviderModels(
  providerName: string,
): Promise<ProviderModelListResponse> {
  return await http().json<ProviderModelListResponse>(
    getListProviderModelsUrl(providerName),
    { method: 'GET' },
  );
}

export interface WorkerActivityEvent {
  at: string;
  status: string;
  detail?: string | null;
}

/**
 * Project the worker state stream as an activity stream. The workers service
 * does not (yet) expose a dedicated `/activity` endpoint, but each state
 * transition written to `/workers/{name}/states` is effectively an activity
 * event. `since` is applied client-side because the upstream `GetWorkerStatesParams`
 * only supports `limit` (1-100) — no time filter.
 */
export async function listWorkerActivity(
  workerId: string,
  since?: string,
): Promise<WorkerActivityEvent[]> {
  const states = await http().json<GetWorkerStates200Item[]>(
    getGetWorkerStatesUrl(workerId, { limit: 100 }),
    { method: 'GET' },
  );
  const sinceMs = since ? Date.parse(since) : NaN;
  const pickTs = (s: Record<string, unknown>): string | undefined => {
    const v = s.recorded_at ?? s.created_at ?? s.createdAt ?? s.timestamp;
    return typeof v === 'string' ? v : undefined;
  };
  const events: WorkerActivityEvent[] = [];
  for (const raw of states ?? []) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const at = pickTs(s);
    if (!at) continue;
    if (Number.isFinite(sinceMs)) {
      const ts = Date.parse(at);
      if (Number.isFinite(ts) && ts < sinceMs) continue;
    }
    const status = typeof s.status === 'string' ? s.status : 'unknown';
    const detailRaw = s.detail;
    const detail =
      typeof detailRaw === 'string'
        ? detailRaw
        : detailRaw == null
          ? null
          : JSON.stringify(detailRaw);
    events.push({ at, status, detail });
  }
  return events;
}

/**
 * Stream-style passthrough for endpoints where we must not buffer the body —
 * notably `chat/completions`, which returns SSE.
 */
export async function proxyWorkersRequest(
  req: Request,
  upstreamPath: string,
): Promise<Response> {
  const timeoutMs =
    upstreamPath === getChatCompletionsUrl() ? STREAM_TIMEOUT_MS : CRUD_TIMEOUT_MS;
  return await http().proxy(req, upstreamPath, { timeoutMs });
}

// ---------------------------------------------------------------------------
// graph_execution_sessions read endpoint
// ---------------------------------------------------------------------------
//
// Spec ref: docs/archive/2026-04-27-continuous-improvement-design.md §9.3
//
// Reads real production execution traces from worker_management for the
// project cockpit's replays, the control tower's executions block and the
// agent's workers read. The endpoint isn't exposed via the openapi-generated
// `@fr/service-client-workers` package, so we hand-roll the call (typed via
// zod). When the next openapi regeneration lands this should switch to the
// generated URL builder.
//
// WM source: worker_management/src/api/graph_execution_api.py:310-409.

const GraphExecutionSessionSchema = z.object({
  session_id: z.string().uuid(),
  graph_id: z.string(),
  status: z.string(),
  // WM leaves this null for sessions that never reached oracle validation
  // (in-flight / errored). Nullable so the list parse doesn't 500 — the route's
  // verdictOf() already maps null → 'unknown'.
  validation_passed: z.boolean().nullable(),
  correlation_id: z.string().nullable(),
  // Any JSON value — a worker's request/response can be an object, a JSON
  // array (e.g. relationship-extraction returns a list), or a scalar. The
  // route only JSON.stringifies these for display, so z.record() (object-only)
  // was too strict and 422'd the whole tenant lens on the first array payload.
  request_payload: z.unknown(),
  final_response: z.unknown(),
  // WM's list endpoint is `SELECT *`, so the quality_score column IS present
  // (pg numeric → string). Optional/nullable: in-flight rows have none.
  quality_score: z.union([z.string(), z.number()]).nullable().optional(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

// WM's GET /execution/sessions/list returns a BARE ARRAY of session rows
// (response_model=list[dict]), not a {sessions,total} envelope — no total is
// available.
//
// ⚠️ AND THAT IS WHY THIS RETURNS NO TOTAL EITHER. It used to synthesize
// `total: sessions.length`, which is the row count of ONE PAGE. With no
// `limit` sent, WM applied its own default of 100, so a tenant with 40,000
// sessions was reported as having a total of 100 — the capped page presented
// as the whole set. Same defect, same cure as
// `routes/assets/_lib/page-cap.ts`: send an explicit limit we chose, and
// signal a BOOLEAN ("there is more") rather than fabricating a count.
const ListSessionsResponseSchema = z.array(GraphExecutionSessionSchema);

export type GraphExecutionSession = z.infer<typeof GraphExecutionSessionSchema>;

export interface ListGraphExecutionSessionsFilters {
  graph_id?: string;
  status?: string;
  validation_passed?: boolean;
  correlation_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/** WM's own default for `GET /execution/sessions/list` (openapi: `default: 100`). */
const WM_SESSION_LIST_DEFAULT_LIMIT = 100;

/**
 * WM's own MAXIMUM (openapi: `maximum: 500`, "Maximum number of sessions to
 * return (1-500, default 100)").
 *
 * ⚠️ This is 500, NOT the 1000 used by the asset routes. The truncation probe
 * compares the returned row count against the cap it BELIEVES was applied, so
 * the cap must be one the upstream will actually honour. Ask for 1000 and
 * FastAPI's validator rejects (or clamps) it; either way we would compare a
 * 500-row page against 1000 and answer "not truncated" for every full page —
 * a false claim of completeness, strictly worse than the silence it replaces.
 */
const WM_SESSION_LIST_MAX_LIMIT = 500;

/**
 * Per-request row cap for the sessions list. Absent / junk / out-of-range
 * falls back to WM's own default rather than throwing — a read-only list that
 * starts erroring because a caller passed a stale limit is a worse outcome
 * than serving the default page, and the value is clamped to WM's maximum so
 * the probe below can never compare against a cap WM did not apply.
 */
function resolveSessionListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return WM_SESSION_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), WM_SESSION_LIST_MAX_LIMIT);
}

export async function listGraphExecutionSessions(
  filters: ListGraphExecutionSessionsFilters,
): Promise<{
  sessions: GraphExecutionSession[];
  appliedLimit: number;
  truncated: boolean;
}> {
  const appliedLimit = resolveSessionListLimit(filters.limit);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  // ALWAYS send it, even when the caller passed nothing: an absent `limit` is
  // exactly how WM's default of 100 became fr's page size, invisibly.
  qs.set('limit', String(appliedLimit));
  const path = `/execution/sessions/list?${qs}`;
  const raw = await http().json<unknown>(path, { method: 'GET' });
  const sessions = ListSessionsResponseSchema.parse(raw);
  // A full page means "there is probably more", and it is exact in the only
  // direction that matters. Exactly `appliedLimit` rows in existence reads as
  // truncated — accepted, the same false positive page-cap.ts documents.
  return { sessions, appliedLimit, truncated: sessions.length >= appliedLimit };
}

// ---------------------------------------------------------------------------
// tenant-config: per-tenant BYO LLM provider
// ---------------------------------------------------------------------------
//
// WM source: worker_management/src/api/tenant_config/_router.py
//   GET    /tenant-config/llm[?tier=]  → LLMConfigView (key never returned, only hasKey)
//   PUT    /tenant-config/llm[?tier=]  → LLMConfigView (apiKey tri-state: see below)
//   DELETE /tenant-config/llm[?tier=]  → 204 (revert that tier to platform routing)
//   GET    /tenant-config/llm/all      → { configs: [...] } (every configured row)
//   GET    /tenant-config/llm/catalog  → { providers: [...] }
//   GET    /tenant-config/llm/audit    → { entries: [...] } (change history, newest first)
//
// Work tiers: a tenant can store a distinct provider/model/key per work-size
// tier (small/medium/high), mapped server-side to the role `tier:<tier>`. The
// optional `tier` query param selects that row; absent ⇒ the `__default__` row
// (the Phase-1 single-provider behavior, unchanged). A worker run resolves its
// tier row, then falls back to the default row, then the platform default.
//
// These endpoints aren't yet in the generated `@fr/service-client-workers`
// package, so we hand-roll the calls + types (typed cast, same approach the
// bulk of this file uses). The WM auth middleware accepts our trusted-network
// X-Tenant-Id (injected by createHttpClient) and scopes by tenant; the
// workspace-admin gate is enforced at the fr route layer, not here.
//
// Wire shape note: LLMConfigView is camelCase (WM serialization_alias —
// baseUrl/maxTokens/hasKey/updatedAt); the catalog payload is snake_case
// (plain dict straight from provider_catalog.py).

/** GET /tenant-config/llm response. The API key is NEVER returned — only `hasKey`. */
export interface LlmConfigView {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  temperature: number | null;
  maxTokens: number | null;
  params: Record<string, unknown>;
  hasKey: boolean;
  updatedAt: string | null;
}

/**
 * PUT /tenant-config/llm body. `provider` + `model` required.
 *
 * apiKey tri-state (WM detects via Pydantic `model_fields_set`):
 *   - field ABSENT  → preserve the existing key (do not include the property)
 *   - apiKey === '' → clear the stored key
 *   - apiKey === 'x'→ set/overwrite
 * The route handler builds this object so the property is present iff the
 * client actually sent it; JSON.stringify then omits an absent key.
 */
export interface LlmConfigUpdate {
  provider: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  params?: Record<string, unknown>;
  apiKey?: string;
}

/** Work-size tiers. Absent ⇒ the `__default__` row. */
export type WorkTier = 'small' | 'medium' | 'high';

/**
 * Recommended model per class, surfaced as a UI hint for the tier editor
 * (small→flash, medium→reasoning, high→frontier). Empty `{}` for free-text
 * providers (openai_compatible / custom). Resolution does NOT depend on these.
 */
export interface LlmModelClasses {
  flash?: string;
  reasoning?: string;
  frontier?: string;
}

export interface LlmCatalogProvider {
  key: string;
  label: string;
  provider: string;
  default_base_url: string | null;
  requires_api_key: boolean;
  requires_base_url: boolean;
  is_external: boolean;
  models: string[];
  model_classes: LlmModelClasses;
  required_params: string[];
}

export interface LlmCatalog {
  providers: LlmCatalogProvider[];
}

/** One row from GET /tenant-config/llm/all — a masked view plus its role/tier. */
export interface LlmConfigRow extends LlmConfigView {
  role: string;
  tier: WorkTier | null;
}

/** `?tier=high` when a tier is given; empty (⇒ `__default__`) otherwise. */
function tierQuery(tier?: WorkTier | null): string {
  return tier ? `?tier=${encodeURIComponent(tier)}` : '';
}

/**
 * Copy ONLY the declared fields of an LLM config view out of an upstream payload.
 *
 * `http().json<LlmConfigView>(...)` is a CAST, not a parse — the generic is erased
 * at runtime, so every field worker_management sends reaches fr, and fr's routes
 * hand the object straight to the browser (`routes/settings/llm-provider.ts:128`
 * returns the dep's result verbatim; nothing between here and the client narrows
 * it). Nothing in fr stripped anything.
 *
 * The type says there is no `apiKey`, and the unit test asserted
 * `'apiKey' in body.data === false` — but the test stubbed the dep with a fixture
 * that never had one, so it held no matter what the code did, and the property it
 * named was implemented nowhere. fr was relying entirely on the upstream never
 * putting a secret in the response.
 *
 * That is a bet, not a boundary. This makes it a boundary: an added upstream
 * field cannot traverse fr to a browser just because fr forgot to look for it.
 * Cheap, and it fails in the safe direction — an unknown field is dropped rather
 * than forwarded.
 *
 * ⚠️ SCOPE, stated honestly: this narrows the TOP LEVEL only. `params` is a
 * declared `Record<string, unknown>` passthrough bag and is forwarded as-is, so a
 * secret placed INSIDE `params` still reaches the client. Filtering it would mean
 * guessing which keys are secret, and a redaction heuristic fails in both
 * directions — dropping a real setting, or missing a differently-named key.
 * Narrowing `params` needs worker_management to declare its shape; until then the
 * hole is named here rather than papered over.
 */
export function pickLlmConfigView(raw: LlmConfigView): LlmConfigView {
  return {
    configured: raw.configured,
    provider: raw.provider,
    model: raw.model,
    baseUrl: raw.baseUrl,
    temperature: raw.temperature,
    maxTokens: raw.maxTokens,
    params: raw.params,
    hasKey: raw.hasKey,
    updatedAt: raw.updatedAt,
  };
}

export async function getTenantLlmConfig(tier?: WorkTier | null): Promise<LlmConfigView> {
  return pickLlmConfigView(
    await http().json<LlmConfigView>(`/tenant-config/llm${tierQuery(tier)}`, { method: 'GET' }),
  );
}

export async function putTenantLlmConfig(
  body: LlmConfigUpdate,
  tier?: WorkTier | null,
): Promise<LlmConfigView> {
  return pickLlmConfigView(
    await http().json<LlmConfigView>(`/tenant-config/llm${tierQuery(tier)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteTenantLlmConfig(tier?: WorkTier | null): Promise<void> {
  await http().json<void>(`/tenant-config/llm${tierQuery(tier)}`, { method: 'DELETE' });
}

/** GET /tenant-config/llm/all — every configured row (default + tiers), masked. */
export async function listTenantLlmConfigs(): Promise<{ configs: LlmConfigRow[] }> {
  const raw = await http().json<{ configs: LlmConfigRow[] }>('/tenant-config/llm/all', {
    method: 'GET',
  });
  // Same narrowing as the single-row reads, plus this shape's own two fields.
  // A list endpoint leaking what the singular one strips would be the obvious
  // way for this fix to be half a fix.
  return {
    configs: (raw.configs ?? []).map((row) => ({
      ...pickLlmConfigView(row),
      role: row.role,
      tier: row.tier,
    })),
  };
}

export async function getTenantLlmCatalog(): Promise<LlmCatalog> {
  return await http().json<LlmCatalog>('/tenant-config/llm/catalog', { method: 'GET' });
}

/** The actions worker_management records on `tenant_llm_config_audit` (WM #320). */
type LlmAuditAction = 'set_key' | 'clear_key' | 'update' | 'remove' | 'test';
/** Who did it: the owner acting on a customer tenant, the tenant's own admin, or a service. */
type LlmAuditActor = 'platform_operator' | 'workspace_admin' | 'service';

/**
 * One row of GET /tenant-config/llm/audit — newest first, scoped by WM to the
 * effective tenant. `tier` is null for the default row; `keyId` is a 12-hex
 * fingerprint or 'none'. No key, no hash of a key and no sub ever appear.
 */
export interface LlmAuditEntry {
  at: string;
  tier: WorkTier | null;
  action: LlmAuditAction;
  actor: LlmAuditActor;
  provider: string | null;
  keyId: string;
}

/** Copy only the declared fields (same boundary rule as `pickLlmConfigView`). */
function pickLlmAuditEntry(raw: LlmAuditEntry): LlmAuditEntry {
  return {
    at: raw.at,
    tier: raw.tier ?? null,
    action: raw.action,
    actor: raw.actor,
    provider: raw.provider ?? null,
    keyId: raw.keyId,
  };
}

/**
 * GET /tenant-config/llm/audit[?limit=] — the tenant's BYO change history
 * (owner ruling 2026-10-02: a customer must see what the platform operator did
 * to its key). WM defaults limit to 50 and clamps to 200.
 */
export async function getTenantLlmAudit(limit?: number): Promise<{ entries: LlmAuditEntry[] }> {
  const q = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  const raw = await http().json<{ entries: LlmAuditEntry[] }>(`/tenant-config/llm/audit${q}`, {
    method: 'GET',
  });
  return { entries: (raw?.entries ?? []).map(pickLlmAuditEntry) };
}

/**
 * POST /tenant-config/llm/test body: `{tier}` (absent/null ⇒ the tenant's
 * default row) OR `{provider, model?}` — never both (WM answers 422).
 */
export type LlmKeyTestRequest =
  | { tier?: WorkTier | null }
  | { provider: string; model?: string };

/**
 * POST /tenant-config/llm/test result: ONE minimal live call with the tenant
 * row's credential (worker_management, owner ruling 2026-10-01). `ok:false` is
 * still HTTP 200 — a missing row, a withheld key, or a vendor that rejected it,
 * with `error` saying which. The key is never returned.
 */
export interface LlmKeyTestResult {
  ok: boolean;
  provider?: string | null;
  model?: string | null;
  latency_ms?: number | null;
  error?: string | null;
  warning?: string | null;
}

/** Copy only the declared fields (same boundary rule as `pickLlmConfigView`). */
function pickLlmKeyTestResult(raw: LlmKeyTestResult): LlmKeyTestResult {
  const out: LlmKeyTestResult = { ok: raw?.ok === true };
  if (typeof raw?.provider === 'string') out.provider = raw.provider;
  if (typeof raw?.model === 'string') out.model = raw.model;
  if (typeof raw?.latency_ms === 'number') out.latency_ms = raw.latency_ms;
  if (typeof raw?.error === 'string') out.error = raw.error;
  if (typeof raw?.warning === 'string') out.warning = raw.warning;
  return out;
}

/**
 * Test the tenant's key for a tier (or provider). A DELEGATED call: the
 * signed-in user's portal token rides along as `X-End-User-Token`
 * (`forwardEndUserToken`), which WM needs before it will decrypt the key.
 */
export async function testTenantLlmConfig(body: LlmKeyTestRequest): Promise<LlmKeyTestResult> {
  return pickLlmKeyTestResult(
    await http().json<LlmKeyTestResult>('/tenant-config/llm/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

