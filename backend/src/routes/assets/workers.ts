import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { ForbiddenError } from '../../utils/errors';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import type { User } from '../../types/api';
import { userRolesService } from '../../services/user-roles';
import {
  IntegrationError,
  integrationErrorResponse,
  isIntegrationError,
  logIntegrationFailure,
} from '../../integrations/_lib/errors';
import {
  createWorker,
  deleteWorker,
  getWorker,
  listWorkerProviderModels,
  listWorkerProviders,
  listWorkers,
  parseListWorkersParams,
  proxyWorkersRequest,
  sendWorkerMessage,
  updateWorker,
} from '../../integrations/workers';
import {
  getChatCompletionsUrl,
  type MessageRequest,
  type WorkerCreateRequest,
} from '@fr/service-client-workers';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { wmByoErrorFromIntegrationError } from '../../lib/wm-byo-errors';
import { handle } from './_lib/handler';

/**
 * The status a relayed WM BYO refusal leaves fr with: WM's own 4xx as-is,
 * ANYTHING else -> 424.
 *
 * ⚠️ WM answers `BYO_PROVIDER_CALL_FAILED` with a 502 (`_router.py
 * byo_call_failed`, e.g. `/providers/{name}/models` when the tenant key's live
 * fetch fails). Relayed as a 5xx, Cloudflare REPLACES the body with its own
 * error page, so the user sentence this relay exists for is destroyed in
 * transit and /chat shows "502 Bad Gateway" — the exact loss
 * `integrations/_lib/errors.ts::providerNotConfigured` already maps to 424 for.
 * A BYO refusal is a provider/key state, not a gateway fault, so it must not be
 * a 5xx. The status also comes out of WM's BODY, so it is clamped: a missing,
 * non-integer or out-of-range value is 424 too, never a passthrough.
 * Code and sentence are unchanged; only the status moves.
 */
function byoRelayStatus(raw: number | undefined): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 499) {
    return raw;
  }
  return 424;
}

/**
 * `handle`, but a worker_management BYO-key refusal reaches the browser as
 * itself: `{error:{code, message, details}}` at WM's 4xx status (a 5xx
 * becomes 424 — see `byoRelayStatus`), where `code` is
 * the WM BYO code, `message` the user sentence and `details` only the
 * secret-free provider/tier/model. Without this the generic converter turns a
 * 403 `BYO_KEY_WITHHELD` into "You do not have access to this" and withholds
 * the body, so the Workers test console could not say WHICH key failed
 * (fr BYO validator D3). Every other failure takes `handle`'s path unchanged.
 */
function handleWm<T>(
  run: () => Promise<T>,
  toResponse: (value: T) => Response,
): Promise<Response> {
  return run().then(toResponse, (err: unknown) => {
    const byo = wmByoErrorFromIntegrationError(err);
    if (byo && isIntegrationError(err)) {
      const status = byoRelayStatus(byo.status ?? err.upstreamStatus);
      logIntegrationFailure(err, status);
      return jsonResponse(
        { error: { code: byo.code, message: byo.message, details: byo.details } },
        status,
      );
    }
    return handle(() => Promise.reject(err), toResponse);
  });
}

// ---------- RBAC bridge ----------------------------------------------------
//
// A worker is a TENANT-WIDE registry row resolved BY NAME: every member's chat
// and every workflow dispatch looks a worker up by its name, so a create /
// rename / delete by any member silently re-points or breaks every other
// member's and every run's dispatch. The three mutating verbs therefore
// require a workspace-admin of the ACTIVE tenant. Shape copied from
// `routes/channels.ts` (the canonical site); corroborated by
// `routes/admin/departments.ts::requireWorkspaceAdmin` and
// `routes/decompositions.ts::requireFamilyWriter`.
//
// ⛔ Never a claim-only check. `middleware/auth.ts::requireRole` was DELETED
// for testing only `user.roles.includes('admin')`, which matches no real grant
// (authority lives in `user_roles`). `scripts/check-admin-claim-only.ts` fails
// CI if that shape returns.
//
// 403, not channels.ts's 401: the caller IS authenticated and merely lacks the
// role, which is what `departments.ts` and `decompositions.ts` — the two
// newest sites of this gate — both answer.
//
// ⛔ THE REGISTRY READS STAY MEMBER-LEVEL, deliberately: `handleListWorkers`
// is called with a plain member token (chat lists workers), and
// `handleGetWorker` reads one row. Gating those breaks those reads for every member.
//
// ⚠️ GATED, owner decision 2026-10-02 (fr BYO validator D1): the routes that
// SPEND the tenant's LLM key from a browser require a workspace-admin or a
// platform super-admin, the same pair as /chat:
//   - `handleSendWorkerMessage` (`POST /api/assets/workers/:name/message`):
//     its only UI is the admin Workers test console
//     (`frontend/src/routes/workers/[name]/+page.svelte`). It passes the raw
//     body through, so a member could run a free-form `system_prompt` on the
//     tenant's BYO key at any `work_tier`. The SERVER-SIDE dispatch paths
//     (project intake, the agent loop) call `sendWorkerMessage` directly and
//     never reach this route, so they are unaffected.
//   - `handleListWorkerProviders` / `...ProviderModels`: their only consumers
//     (`frontend/src/lib/workers/providers.ts`) are /chat and the admin
//     Workers create/edit pages, and WM answers them with a live vendor
//     model-list run on the tenant key.
//
// ⚠️ EXCEPTION, owner ruling 2026-10-01: `handleWorkerChatCompletions` (the
// `/chat` page, its ONLY caller) is a TENANT-ADMIN tool for testing the
// workspace's own provider keys, so it requires a workspace-admin OR a platform
// super-admin — the same pair `routes/settings/llm-provider.ts` admits. A
// member never reaches a tenant BYO key through it.
async function assertWorkspaceAdmin(user: User): Promise<void> {
  const ok = await userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
  if (!ok) {
    throw new ForbiddenError('workspace-admin role required');
  }
}

/** workspace-admin of the active tenant, or a platform super-admin. */
async function assertTenantAdminOrSuperAdmin(user: User): Promise<void> {
  if (isSuperAdmin(user)) return;
  await assertWorkspaceAdmin(user);
}

export async function handleListWorkers(req: Request): Promise<Response> {
  await validateAuth(req);
  const url = new URL(req.url);
  const params = parseListWorkersParams(url.searchParams);
  return handle(
    () => listWorkers(params),
    (data) => jsonResponse({ data }),
  );
}

export async function handleCreateWorker(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  await assertWorkspaceAdmin(user);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as WorkerCreateRequest;
  return handle(
    () => createWorker(body),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetWorker(
  req: Request,
  workerName: string,
): Promise<Response> {
  await validateAuth(req);
  return handle(
    () => getWorker(workerName),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateWorker(
  req: Request,
  workerName: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await assertWorkspaceAdmin(user);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as WorkerCreateRequest;
  return handle(
    () => updateWorker(workerName, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleDeleteWorker(
  req: Request,
  workerName: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await assertWorkspaceAdmin(user);
  return handle(
    () => deleteWorker(workerName),
    () => noContentResponse(),
  );
}

export async function handleSendWorkerMessage(
  req: Request,
  workerName: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // Spends the tenant key — admin-only (D1, see the RBAC note above).
  await assertTenantAdminOrSuperAdmin(user);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as MessageRequest;
  return handleWm(
    () => sendWorkerMessage(workerName, body),
    (data) => jsonResponse({ data }),
  );
}

export async function handleListWorkerProviders(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  // Spends the tenant key — admin-only (D1, see the RBAC note above).
  await assertTenantAdminOrSuperAdmin(user);
  // listWorkerProviders returns ProviderListResponse which is already
  // `{object, data: ProviderDescriptor[]}` (generated openapi model).
  // Pass through — wrapping in `{data: response}` would double-nest and the
  // frontend's `body.data ?? []` would hand `.find` an object, not an array
  // (Da7O17PK.js: `r.find is not a function` on /chat 2026-04-27).
  return handleWm(
    () => listWorkerProviders(),
    (response) => jsonResponse(response),
  );
}

/**
 * The model picker's two non-error provider STATES (fr#1385), as typed codes
 * the frontend renders as a state, never as an error string.
 *
 *   - `PROVIDER_NOT_ENABLED` (403): worker_management refused the provider for
 *     this workspace ON PURPOSE. Matched on WM's TYPED code
 *     `PROVIDER_NOT_ENABLED_FOR_TENANT` (owner ruling 2026-10-03: the owner's
 *     commercial keys serve proven platform workspaces only), never on a bare
 *     403. fr holds no policy and no tenant list; it only says so in a
 *     sentence instead of `worker_management GET /providers/xai/models returned 403`.
 *     ⚠️ DEPLOY WINDOW: a worker_management build older than that code answers
 *     the same refusal as an untyped 403 whose message says "this deployment
 *     is local-only" (its deployment-wide flag). That one legacy sentence is
 *     matched too, so fr works against old and new WM; remove it once every WM
 *     build emits the code.
 *   - `PROVIDER_UNAVAILABLE` (424): the provider's backend did not answer —
 *     WM 5xx (`Upstream unreachable for provider 'vlm_local': …`, the dormant
 *     devbox VLM), or WM itself unreachable / timed out. Never a 5xx out of fr:
 *     Cloudflare replaces a 5xx body, the loss fr#775 mapped off 5xx for.
 *
 * A WM BYO code (`BYO_PROVIDER_NOT_CONFIGURED`, …) is NOT handled here —
 * `handleWm` relays those first, with their own sentence. Any OTHER 403, a
 * 400, a 404 for an unknown provider, … keeps `handle`'s path. The raw
 * upstream text stays on the `integration_error` log line only.
 */
type ProviderModelsState = 'PROVIDER_NOT_ENABLED' | 'PROVIDER_UNAVAILABLE';

/** worker_management's typed refusal for a provider this tenant may not use. */
const WM_PROVIDER_NOT_ENABLED_CODE = 'PROVIDER_NOT_ENABLED_FOR_TENANT';
/** inference-router's tenant gate: the request asserted a tenant it did not prove. */
const WM_END_TENANT_NOT_PROVEN_CODE = 'END_TENANT_NOT_PROVEN';
/** The pre-`PROVIDER_NOT_ENABLED_FOR_TENANT` WM refusal (deploy window only). */
const LEGACY_WM_LOCAL_ONLY = /this deployment is local-only/i;

function wmErrorEnvelope(body: unknown): { code?: unknown; message?: unknown } {
  if (!body || typeof body !== 'object') return {};
  const env = (body as { error?: unknown }).error;
  return env && typeof env === 'object' ? (env as { code?: unknown; message?: unknown }) : {};
}

function isWmProviderNotEnabled(body: unknown): boolean {
  const env = wmErrorEnvelope(body);
  if (env.code === WM_PROVIDER_NOT_ENABLED_CODE) return true;
  return env.code === 'FORBIDDEN' && typeof env.message === 'string' && LEGACY_WM_LOCAL_ONLY.test(env.message);
}

export function providerModelsState(err: unknown): ProviderModelsState | null {
  if (!isIntegrationError(err)) return null;
  const status = err.upstreamStatus;
  if (status === 403) return isWmProviderNotEnabled(err.upstreamBody) ? 'PROVIDER_NOT_ENABLED' : null;
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'PROVIDER_UNAVAILABLE';
  if (status === undefined && (err.code === 'UPSTREAM_UNREACHABLE' || err.code === 'UPSTREAM_TIMEOUT')) {
    return 'PROVIDER_UNAVAILABLE';
  }
  return null;
}

function providerModelsStateResponse(
  err: IntegrationError,
  state: ProviderModelsState,
  provider: string,
): Response {
  const status = state === 'PROVIDER_NOT_ENABLED' ? 403 : 424;
  const message =
    state === 'PROVIDER_NOT_ENABLED'
      ? `Provider '${provider}' is not enabled for this workspace.`
      : `Provider '${provider}' is unavailable right now.`;
  logIntegrationFailure(err, status);
  return jsonResponse({ error: { code: state, message, details: { provider } } }, status);
}

export async function handleListWorkerProviderModels(
  req: Request,
  providerName: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // Spends the tenant key — admin-only (D1, see the RBAC note above).
  await assertTenantAdminOrSuperAdmin(user);
  // Same story — ProviderModelListResponse is already `{object, data: ProviderModel[]}`.
  return listWorkerProviderModels(providerName).then(
    (response) => jsonResponse(response),
    (err: unknown) => {
      // A BYO-coded refusal stays handleWm's (it carries its own sentence).
      if (!wmByoErrorFromIntegrationError(err) && isIntegrationError(err)) {
        const state = providerModelsState(err);
        if (state) return providerModelsStateResponse(err, state, providerName);
        // The inference-router's per-tenant gate refusing an UNPROVEN tenant.
        // Relayed with its code (UI review 2026-10-07: it used to collapse into
        // a generic UPSTREAM_FORBIDDEN, so the chat could only say "Try
        // again"). Fixed message; the upstream text names tenant ids.
        if (
          err.upstreamStatus === 403 &&
          wmErrorEnvelope(err.upstreamBody).code === WM_END_TENANT_NOT_PROVEN_CODE
        ) {
          logIntegrationFailure(err, 403);
          return jsonResponse(
            {
              error: {
                code: WM_END_TENANT_NOT_PROVEN_CODE,
                message: `Provider '${providerName}' could not verify your workspace for this request.`,
                details: { provider: providerName },
              },
            },
            403,
          );
        }
      }
      return handleWm(() => Promise.reject(err), (response) => jsonResponse(response));
    },
  );
}

/**
 * Streaming endpoint — SSE response body must not be buffered, so this stays a
 * passthrough via the adapter's proxy helper (still goes through auth propagation
 * and the shared fetcher).
 */
export async function handleWorkerChatCompletions(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  // Tenant-admin tool (owner ruling 2026-10-01) — see the RBAC note above.
  await assertTenantAdminOrSuperAdmin(user);
  try {
    return await proxyWorkersRequest(req, getChatCompletionsUrl());
  } catch (err) {
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    throw err;
  }
}

