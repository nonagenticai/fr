/**
 * n8n adapter — read-only execution observability + a write-side
 * `triggerWorkflow` that ALWAYS persists the project/user mapping row.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
 *   §"Backend"  — listExecutions, getExecution, triggerWorkflow methods
 *   §"Architecture decisions / Project association: fr-owned mapping table"
 *   §"Idempotency & correlation"
 *
 * Authentication: n8n's Public API uses the `X-N8N-API-KEY` header (defined
 * in the OpenAPI spec as `securitySchemes.ApiKeyAuth`). The shared
 * `createHttpClient` does not have a first-class api-key knob; we wire it in
 * via `defaultHeaders` on the client construction.
 *
 * NOTE: There is a sibling `services/n8n.ts` that handles the approval
 * webhook callback flow (sendApprovalDecision / callWebhook). That module is
 * intentionally untouched by this slice; `triggerWorkflow` here is a NEW
 * helper centralising the mapping-row write so future trigger callers don't
 * need to re-implement it.
 */

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { IntegrationError } from './_lib/errors';
import { db as defaultDb, n8nExecutionMapping } from '../db/client';
import { assertGlobalAndonReleased } from '../lib/global-andon-gate';
import { getCorrelationId, getInitiator } from './_lib/context';
import {
  n8nAttributionHeaders,
  resolveN8nAttribution,
  withN8nAttributionBody,
} from './_lib/n8n-attribution';
import {
  getGetExecutionsUrl,
  getGetExecutionsIdUrl,
  getGetWorkflowsUrl,
  getGetWorkflowsIdUrl,
  type GetExecutionsParams,
  type GetWorkflowsParams,
  type Execution,
  type ExecutionList,
  type Workflow,
  type WorkflowList,
} from '@fr/service-client-n8n';

export type {
  Execution,
  ExecutionList,
  GetExecutionsParams,
  Workflow,
  WorkflowList,
  GetWorkflowsParams,
};

/**
 * Per-ATTEMPT HTTP timeout for every n8n call.
 *
 * ⚠️ This deliberately OVERRIDES `_lib/http-client.ts`'s own `DEFAULT_TIMEOUT_MS`
 * (30_000). The two constants used to share a name, which read as "n8n gets the
 * 30 s default" and hid the real budget from anyone sizing a request against it.
 * It is passed as `defaultTimeoutMs` at the `createHttpClient` call below, so
 * for n8n the effective numbers are:
 *
 *   per attempt              15,000 ms   (this constant)
 *   attempts                 2           (`http-client.ts` retry default,
 *                                         idempotent methods only)
 *   backoff between attempts 200 ms      (same default)
 *   ⇒ user-visible budget    ≈ 30.2 s    before UPSTREAM_TIMEOUT → 504
 *
 * That 30.2 s is exactly the latency seen on the live 504s of GET
 * /api/workflows. Anything sized to "fit in the timeout" must fit in 15,000 ms,
 * NOT 30,000 — see {@link WORKFLOW_PAGE_SIZE}.
 */
export const N8N_TIMEOUT_MS = 15_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    // Read env at construction time (the `config` snapshot is captured at
    // module load, which under bun-test preload order is BEFORE the test
    // setup.ts has a chance to set N8N_API_KEY — same `config` capture
    // timing issue download-tokens.ts works around at line 95). Falling
    // back to process.env keeps the boot-time guard authoritative while
    // letting tests override.
    const apiKey = config.services.n8n.apiKey || process.env.N8N_API_KEY || '';
    if (!apiKey && process.env.AUTH_BYPASS !== 'true') {
      throw new IntegrationError({
        code: 'UPSTREAM_UNAUTHORIZED',
        message: 'N8N_API_KEY is not configured',
        service: 'n8n',
      });
    }
    cachedClient = createHttpClient({
      serviceName: 'n8n',
      baseUrl: config.services.n8n.apiUrl,
      defaultTimeoutMs: N8N_TIMEOUT_MS,
      // n8n's Public API authenticates on `X-N8N-API-KEY` (set below) and reads no
      // bearer. A third-party product with its own identity system — the same shape
      // as the Planka defect (#848).
      sendAuthorization: false,
      // n8n Public API auth is `X-N8N-API-KEY: <key>`. NOT bearer.
      defaultHeaders: apiKey ? { 'X-N8N-API-KEY': apiKey } : {},
    });
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listExecutions(
  params?: GetExecutionsParams,
): Promise<ExecutionList> {
  return await http().json<ExecutionList>(getGetExecutionsUrl(params), {
    method: 'GET',
  });
}

/** A NAMED n8n instance (not fr's default client): its public API base + key. */
export interface N8nInstance {
  apiUrl: string;
  apiKey: string;
}

const namedClients = new Map<string, HttpClient>();

/**
 * `listExecutions` against an explicitly named instance (fr-agui SPEC §7.4a:
 * the conveyor v4 runs live on another n8n than fr's default). One cached
 * client per (url, key); never falls back to fr's default instance.
 */
export async function listExecutionsOn(
  instance: N8nInstance,
  params?: GetExecutionsParams,
): Promise<ExecutionList> {
  const key = `${instance.apiUrl}\u0000${instance.apiKey}`;
  let client = namedClients.get(key);
  if (!client) {
    client = createHttpClient({
      serviceName: 'n8n',
      baseUrl: instance.apiUrl,
      defaultTimeoutMs: N8N_TIMEOUT_MS,
      sendAuthorization: false,
      defaultHeaders: { 'X-N8N-API-KEY': instance.apiKey },
    });
    namedClients.set(key, client);
  }
  return await client.json<ExecutionList>(getGetExecutionsUrl(params), { method: 'GET' });
}

export async function getExecution(
  executionId: number | string,
  params?: { includeData?: boolean },
): Promise<Execution> {
  // The generated helper TYPES `id` as a number but interpolates it into a template string, so a
  // string id passes through unchanged. n8n's ids are numeric today (measured 1217136, 2026-11-01);
  // the `as` is only the stale generated type — `Number()` at a call site would instead turn any
  // future non-numeric id into NaN and 404 a live execution.
  return await http().json<Execution>(
    getGetExecutionsIdUrl(executionId as number, params),
    { method: 'GET' },
  );
}

export interface ListWorkflowsParams {
  active?: boolean;
  /**
   * Total cap on the number of workflows returned. When set, the cursor
   * loop stops as soon as it has collected this many. When omitted,
   * {@link listWorkflows} follows `nextCursor` to completion and returns
   * the ENTIRE catalogue — that is the mode the Workflows Viewer uses.
   */
  limit?: number;
}

/** n8n's Public API hard-caps the per-request `limit` at 250 items. */
export const N8N_MAX_PAGE_SIZE = 250;

/**
 * How many workflows to ask n8n for per page. NOT the API's cap (250) — a
 * COST budget.
 *
 * Measured 2026-08-10 from inside the fr pod against the live Public API: the
 * `/workflows` crawl costs ~110 ms per workflow and is LINEAR in the page size
 * (n8n eager-joins `activeVersion` unconditionally and fans a tags query out
 * per row; the 255-workflow catalogue serialises to ~50 MB). That is an
 * upstream defect fr cannot fix, so fr sizes the page to survive it:
 *
 *   fixed cost per request      ≈   700 ms   (measured at `limit=1`)
 *   worst marginal cost/item    ≈   615 ms   (the 61.6 s page observed inside
 *                                             the worst 82,635 ms full crawl)
 *   ⇒ worst page at limit=20      700 + 615×20 = 13,000 ms
 *                                = 87% of the 15,000 ms {@link N8N_TIMEOUT_MS}
 *                                  per-ATTEMPT budget, with http-client's
 *                                  second attempt still in reserve.
 *
 * Why not larger: 25 → 700 + 615×25 = 16,075 ms, over budget on the first
 * attempt. Why not smaller: 10 would need 26 pages for today's 255 workflows,
 * adding 26 × 700 ms of pure fixed overhead to every crawl for no headroom
 * gain. 20 is the largest size that fits with the retry intact.
 *
 * ⚠️ This is a per-PAGE size, and shrinking the page makes the WHOLE CRAWL
 * SLOWER, not faster — it trades total latency for per-request survivability.
 * For today's 255 workflows (13 pages):
 *
 *   typical   13 × 700 + 104×255  ≈  35.7 s   (was ~28 s at 2 pages of 250)
 *   pessimistic 13 × 700 + 615×255 ≈ 166 s    ⚠️ EXTRAPOLATION, not a
 *                                              measurement: it applies the
 *                                              worst observed PER-PAGE
 *                                              marginal to every item. The
 *                                              worst crawl actually MEASURED
 *                                              was 82,635 ms at page size 250.
 *
 * (104 ms/item is the typical marginal backed out of the measured 28 s:
 * (28,000 − 2×700)/255.) This is why no user request may ever await the crawl
 * — see `routes/workflows.ts` and `workers/workflows-cache.ts`.
 */
export const WORKFLOW_PAGE_SIZE = 20;

/**
 * Hard ceiling on the cursor-follow loop, expressed in ITEMS.
 *
 * It used to be a page count (`MAX_WORKFLOW_PAGES = 50`) justified by
 * "50 × 250 = 12 500 workflows". That justification silently died the moment
 * the page size stopped being 250: at 20 items/page the same 50 would cap the
 * catalogue at 1,000 workflows — only 3.9× today's 255 — and a real customer
 * growth curve would start truncating the Workflows Viewer with an
 * UPSTREAM_BAD_BODY that blamed n8n. Stating the ceiling in items and deriving
 * the page count keeps the guard's meaning invariant under page-size changes.
 */
const MAX_WORKFLOW_ITEMS = 12_500;
const MAX_WORKFLOW_PAGES = Math.ceil(MAX_WORKFLOW_ITEMS / WORKFLOW_PAGE_SIZE);

/**
 * List n8n workflows visible to the configured API key.
 *
 * n8n's Public API is cursor-paginated (per-request `limit` ≤ 250,
 * `nextCursor`). This helper follows the cursor across pages and merges
 * them into the slice's `{ workflows }` envelope — earlier versions fetched
 * a single page and silently dropped the tail once the catalogue grew past
 * 250. Pass `params.limit` to cap the total; omit it to get everything.
 *
 * Pages are {@link WORKFLOW_PAGE_SIZE}, deliberately far below the API cap, so
 * that ONE request fits inside {@link N8N_TIMEOUT_MS}. The whole crawl does
 * not: budget ~36 s typical and up to ~166 s for the full catalogue, and never
 * run it on a user request.
 */
export async function listWorkflows(
  params?: ListWorkflowsParams,
): Promise<{ workflows: Workflow[] }> {
  const totalCap =
    params?.limit !== undefined && params.limit > 0
      ? params.limit
      : Infinity;
  const client = http();
  const workflows: Workflow[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const remaining = totalCap - workflows.length;
    const pageSize = Math.min(WORKFLOW_PAGE_SIZE, remaining);
    const upstreamParams: GetWorkflowsParams = { limit: pageSize };
    if (params?.active !== undefined) upstreamParams.active = params.active;
    if (cursor) upstreamParams.cursor = cursor;

    const body = await client.json<WorkflowList>(
      getGetWorkflowsUrl(upstreamParams),
      { method: 'GET' },
    );
    workflows.push(...(body.data ?? []));
    cursor = body.nextCursor ?? undefined;
    pages += 1;

    if (workflows.length >= totalCap) {
      return { workflows: workflows.slice(0, totalCap) };
    }
    if (cursor && pages >= MAX_WORKFLOW_PAGES) {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message:
          `n8n workflow pagination exceeded ${MAX_WORKFLOW_ITEMS} workflows ` +
          `(${MAX_WORKFLOW_PAGES} pages of ${WORKFLOW_PAGE_SIZE}) — ` +
          `upstream is not clearing nextCursor`,
        service: 'n8n',
        path: '/workflows',
        method: 'GET',
      });
    }
  } while (cursor);

  return { workflows };
}

/**
 * Fetch a single workflow by id, including nodes + connections + settings.
 * Used by the read-only /api/workflows/:id viewer surface (Workflows Viewer
 * spec, 2026-05-09). The full Workflow shape is returned as-is — the route
 * handler is the only place that decides what to project for the client.
 */
export async function getWorkflow(id: string): Promise<Workflow> {
  if (!id) {
    throw new IntegrationError({
      // Reached from GET /api/workflows/:id, where a :id segment cannot match
      // empty. A violated guard here is an fr bug, not a bad request. No call
      // was made, so naming a service was false too.
      code: 'INTERNAL_PRECONDITION',
      message: 'workflow id is required',
    });
  }
  return await http().json<Workflow>(getGetWorkflowsIdUrl(id), {
    method: 'GET',
  });
}

/**
 * Count n8n executions still in the `running` state — the in-flight drain after
 * a global-andon engage. Deactivation stops NEW runs immediately, but an
 * already-running execution finishes on its own — the operator cord does not
 * stop running executions (n8n 2.46.1 DOES have `POST /executions/{id}/stop`;
 * keeping the cord's drain is deliberate, not an upstream gap), so this lets a
 * super-admin watch the drain.
 *
 * Reads a single page (n8n caps `limit` at 250). Running executions are
 * normally a small handful; if a full page comes back with more to follow we
 * report `capped: true` so the caller can show "250+". One page is enough for
 * an at-a-glance "is anything still running" signal.
 */
export async function countRunningExecutions(): Promise<{
  count: number;
  capped: boolean;
}> {
  const res = await listExecutions({ status: 'running', limit: N8N_MAX_PAGE_SIZE });
  const count = (res.data ?? []).length;
  return { count, capped: count >= N8N_MAX_PAGE_SIZE && !!res.nextCursor };
}

// ---------------------------------------------------------------------------
// Write — runWorkflow (Public-API workflow run endpoint)
// ---------------------------------------------------------------------------

interface RunWorkflowResult {
  executionId: string;
  raw: unknown;
}

/**
 * POST a manual run of an n8n workflow via the Public API.
 *
 * Used by the `n8n.trigger_workflow` agent-callable action (Wave 2 follow-up
 * to spec §"Architecture decisions / Project association"). This sits next to
 * the webhook-style {@link triggerWorkflow} above; the API-style run is the
 * surface the AG-UI write action exposes because it returns an execution id
 * synchronously without depending on the workflow having a webhook trigger.
 *
 * Auth: same `X-N8N-API-KEY` header as the read endpoints (see {@link http}).
 * Path: `POST {apiUrl}/workflows/{id}/run`.
 *
 * The execution id is plucked out of the response body (`executionId` |
 * `execution_id` | `id`), matching the lenient extraction logic in
 * {@link triggerWorkflow} so both helpers stay tolerant of n8n's response
 * shape drifting between minor versions.
 */
export async function runWorkflow(
  workflowId: string,
  payload?: unknown,
): Promise<RunWorkflowResult> {
  if (!workflowId) {
    throw new IntegrationError({
      // Supplied from config.services.n8n.aaBuild*WorkflowId. A server knob,
      // not caller input -- no retry and no corrected request can fix it.
      code: 'INTERNAL_PRECONDITION',
      message: 'workflowId is required for runWorkflow',
    });
  }

  // Global andon: refuse to dispatch ANY new n8n work while the cord is engaged.
  // The API-style `/workflows/{id}/run` is a SECOND fr→n8n dispatch seam (next to
  // {@link triggerWorkflow}'s webhook path) reached by the AG-UI
  // `n8n.trigger_workflow` action and the TOC hooks. Without this guard those
  // callers could keep launching executions after a super-admin pulled the cord.
  // The cord's actuator is the n8n-worker replica count, so nothing RUNS while it
  // is engaged — but a `/run` would still bank an execution in the queue, and a
  // queue that fires on release is not a stopped line. The cord is a GLOBAL
  // singleton (no tenant exemption); always read the default db. The release path
  // scales the worker back up and never comes through here.
  await assertGlobalAndonReleased();

  const path = `/workflows/${encodeURIComponent(workflowId)}/run`;
  const raw = await http().json<unknown>(path, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
    headers: { 'content-type': 'application/json' },
  });
  let executionId: string | undefined;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const candidate = r.executionId ?? r.execution_id ?? r.id;
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      executionId = String(candidate);
    }
  }
  if (!executionId) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message:
        'Could not resolve executionId from n8n /workflows/{id}/run response',
      service: 'n8n',
      path,
      method: 'POST',
      upstreamBody: raw,
    });
  }
  return { executionId, raw };
}

// ---------------------------------------------------------------------------
// Write — triggerWorkflow (mapping row first when possible)
// ---------------------------------------------------------------------------

interface TriggerWorkflowOptions {
  correlationId?: string;
  projectId: string;
  userId: string;
  initiatedVia?: string;
  /**
   * If the caller already knows the execution id (e.g. it pre-generated an
   * idempotency key passed to n8n as `X-Execution-Id`), pass it here. When
   * absent, we extract the value out of the n8n webhook response.
   */
  executionId?: string;
  workflowId: string;
  /**
   * fr#1322 — tenant the run is triggered under, stamped on the mapping row so
   * the customer executions list can scope by tenant. Required key: pass
   * `null` explicitly when no tenant is resolvable (such rows are hidden from
   * customers, fail-closed).
   */
  tenantId: string | null;
}

interface TriggerWorkflowResult {
  executionId: string;
  webhookResponse: unknown;
}

/**
 * Centralised workflow-trigger helper.
 *
 * Per spec §"Architecture decisions / Project association": every fr code
 * path that fires an n8n webhook MUST go through this helper. When the
 * caller can supply a pre-generated execution id (idempotency-key style),
 * the mapping row is written BEFORE the webhook call; otherwise it is
 * written immediately after extracting the id from the n8n reply. Either
 * INSERT uses `ON CONFLICT (execution_id) DO UPDATE` so safe retries
 * refresh trailing fields rather than erroring.
 */
export async function triggerWorkflow(
  webhookPath: string,
  payload: unknown,
  opts: TriggerWorkflowOptions,
): Promise<TriggerWorkflowResult> {
  if (!opts.projectId) {
    throw new IntegrationError({
      // opts are built by callers, not read from a request body.
      code: 'INTERNAL_PRECONDITION',
      message: 'projectId is required for triggerWorkflow',
    });
  }
  if (!opts.userId) {
    throw new IntegrationError({
      // ActionContext userId, not caller input.
      code: 'INTERNAL_PRECONDITION',
      message: 'userId is required for triggerWorkflow',
    });
  }
  if (!opts.workflowId) {
    throw new IntegrationError({
      // Env webhook/workflow config via resolveConfigured.
      code: 'INTERNAL_PRECONDITION',
      message: 'workflowId is required for triggerWorkflow',
    });
  }

  // Global andon: refuse to dispatch ANY new n8n work while the cord is
  // engaged. This is the single fr→n8n dispatch seam, so the guard here (plus
  // workflow deactivation on engage) is what makes a tenant-admin action
  // unable to restart automation until a super-admin disengages. The cord is a
  // GLOBAL singleton — always read the default db, never the caller's injected
  // per-call/transaction client (which may be a partial mock or a tx scope).
  await assertGlobalAndonReleased();

  const correlationId =
    opts.correlationId ?? getCorrelationId() ?? 'no-correlation-id';
  const initiator = opts.initiatedVia ?? getInitiator() ?? 'web';

  // Phase 1 (preferred): pre-generated execution id → write the mapping row
  // BEFORE the webhook call so the activity surface picks the run up
  // immediately, even if the webhook reply is slow.
  if (opts.executionId) {
    await defaultDb
      .insert(n8nExecutionMapping)
      .values({
        execution_id: opts.executionId,
        workflow_id: opts.workflowId,
        project_id: opts.projectId,
        user_id: opts.userId,
        correlation_id: correlationId,
        initiated_via: initiator,
        tenant_id: opts.tenantId,
      })
      .onConflictDoUpdate({
        target: n8nExecutionMapping.execution_id,
        set: {
          workflow_id: opts.workflowId,
          project_id: opts.projectId,
          user_id: opts.userId,
          correlation_id: correlationId,
          initiated_via: initiator,
          tenant_id: opts.tenantId,
        },
      });
  }

  const url = `${config.services.n8n.webhookUrl}/${webhookPath.replace(/^\/+/, '')}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), N8N_TIMEOUT_MS);

  let webhookResponse: unknown;
  let resp: Response;
  try {
    const triggerHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
    };
    if (opts.executionId) {
      triggerHeaders['x-execution-id'] = opts.executionId;
    }
    // Authenticates fr to the n8n receiver (FR_BACKEND_N8N_WEBHOOK_SECRET on
    // the n8n side, same value). Read at call time, never logged.
    if (config.services.n8n.webhookSecret) {
      triggerHeaders['x-webhook-secret'] = config.services.n8n.webhookSecret;
    }
    // Per-project / per-member billing attribution (X-Project-Id /
    // X-Actor-Id + body project_id / actor_id). `opts.projectId` is the id this
    // helper records on n8n_execution_mapping; `opts.userId` is the Keycloak
    // `sub` (see _lib/n8n-attribution.ts). Omitted when not a real uuid.
    const attribution = resolveN8nAttribution({
      projectId: opts.projectId,
      actorId: opts.userId,
    });
    Object.assign(triggerHeaders, n8nAttributionHeaders(attribution));
    resp = await fetch(url, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify(withN8nAttributionBody(payload, attribution)),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(t);
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message === 'timeout');
    throw new IntegrationError({
      code: isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `n8n webhook ${webhookPath} ${isAbort ? 'timed out' : 'unreachable'}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      service: 'n8n',
      path: webhookPath,
      method: 'POST',
      cause: err,
    });
  } finally {
    clearTimeout(t);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new IntegrationError({
      code:
        resp.status === 401
          ? 'UPSTREAM_UNAUTHORIZED'
          : resp.status === 403
            ? 'UPSTREAM_FORBIDDEN'
            : resp.status === 404
              ? 'UPSTREAM_NOT_FOUND'
              : resp.status === 409
                ? 'UPSTREAM_CONFLICT'
                : 'UPSTREAM_BAD_STATUS',
      message: `n8n webhook ${webhookPath} returned ${resp.status}`,
      service: 'n8n',
      path: webhookPath,
      method: 'POST',
      upstreamStatus: resp.status,
      upstreamBody: text.slice(0, 500),
    });
  }

  if (text.length > 0) {
    try {
      webhookResponse = JSON.parse(text);
    } catch {
      webhookResponse = text;
    }
  }

  let execId = opts.executionId;
  if (!execId && webhookResponse && typeof webhookResponse === 'object') {
    const r = webhookResponse as Record<string, unknown>;
    const candidate = r.executionId ?? r.execution_id ?? r.id;
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      execId = String(candidate);
    }
  }
  if (!execId) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message:
        'Could not resolve executionId from caller opts or n8n webhook response; refusing to write a mapping row keyed by empty string',
      service: 'n8n',
      path: webhookPath,
      method: 'POST',
      upstreamBody: webhookResponse,
    });
  }

  // Phase 2: not pre-generated → INSERT now keyed by the n8n-issued id.
  if (!opts.executionId) {
    await defaultDb
      .insert(n8nExecutionMapping)
      .values({
        execution_id: execId,
        workflow_id: opts.workflowId,
        project_id: opts.projectId,
        user_id: opts.userId,
        correlation_id: correlationId,
        initiated_via: initiator,
        tenant_id: opts.tenantId,
      })
      .onConflictDoUpdate({
        target: n8nExecutionMapping.execution_id,
        set: {
          workflow_id: opts.workflowId,
          project_id: opts.projectId,
          user_id: opts.userId,
          correlation_id: correlationId,
          initiated_via: initiator,
          tenant_id: opts.tenantId,
        },
      });
  }

  return { executionId: execId, webhookResponse };
}
