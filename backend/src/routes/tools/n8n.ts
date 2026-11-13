/**
 * n8n routes — read-only n8n workflow + execution observability scoped to
 * (user, project) via the fr-owned `n8n_execution_mapping` table.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
 *   §"Backend"  — list / get / workflows routes
 *   §"Telemetry emitted" — emitSpan + Prom counters
 *   §"Agent-callable actions" — read actions (auto approval)
 *
 * HTTP routes:
 *   - GET /api/tools/n8n/workflows
 *   - GET /api/tools/n8n/executions
 *   - GET /api/tools/n8n/executions/:id
 *
 * Each call goes through `validateAuth` for the (user) leg of scoping; the
 * (project) leg is enforced by joining n8n's execution list against
 * `n8n_execution_mapping`. Only mapped executions show up here — orphan
 * executions triggered outside fr are invisible by design (spec
 * §"Architecture decisions / Project association").
 *
 * Action names (Wave 2 namespace alignment):
 *   - `n8n.list_executions`  (renamed from `activity.list_executions`)
 *   - `n8n.get_execution`    (renamed from `activity.get_execution`)
 *   - `n8n.list_workflows`   (new — Wave 2)
 */

import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { emitSpan } from '../../telemetry/spans';
import {
  IntegrationError,
} from '../../integrations/_lib/errors';
import { db as defaultDb, n8nExecutionMapping } from '../../db/client';
import {
  getExecution as fetchExecution,
  listExecutions as listN8nExecutions,
  listWorkflows as listN8nWorkflows,
  type Execution,
  type ExecutionList,
  type GetExecutionsParams,
  type Workflow,
} from '../../integrations/n8n';
import {
  observeListDuration,
  recordTerminalExecution,
} from './_metrics';
import { withIntegrationCatch } from '../_lib';
import {
  activeTenantOf,
  canReadProductionWorkflows,
} from '../../lib/production-workflows-gate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const STATUS_VALUES = ['canceled', 'error', 'running', 'success', 'waiting'] as const;
type ExecutionStatus = (typeof STATUS_VALUES)[number];
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'success',
  'error',
  'canceled',
  'crashed',
]);

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(250).optional(),
    cursor: z.string().min(1).optional(),
    status: z.enum(STATUS_VALUES).optional(),
    projectId: z.string().min(1).optional(),
    workflowId: z.string().min(1).optional(),
  })
  .strip();

const workflowsQuerySchema = z
  .object({
    active: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
      .optional(),
    limit: z.coerce.number().int().min(1).max(250).optional(),
  })
  .strip();

function parseListQuery(req: Request): z.infer<typeof listQuerySchema> {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const k of url.searchParams.keys()) {
    const v = url.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `Invalid query: ${JSON.stringify(parsed.error.issues)}`,
    });
  }
  return parsed.data;
}

function parseWorkflowsQuery(req: Request): z.infer<typeof workflowsQuerySchema> {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const k of url.searchParams.keys()) {
    const v = url.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  const parsed = workflowsQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `Invalid query: ${JSON.stringify(parsed.error.issues)}`,
    });
  }
  return parsed.data;
}


export interface ScopedExecution {
  id: string;
  /** `null` when redacted: a customer never receives the PRODUCTION workflow id. */
  workflow_id: string | null | undefined;
  status: string | undefined;
  mode: string | undefined;
  started_at: string | undefined;
  stopped_at: string | undefined;
  duration_ms: number | undefined;
  project_id: string;
  initiated_via: string;
  correlation_id: string;
  /** `null` when redacted: the Grafana/Tempo deep-link is platform-internal. */
  trace_url: string | null;
}

function buildTraceUrl(executionId: string, workflowId: string | undefined): string {
  // No hardcoded fallback per config-externalization-policy.md;
  // `validateProductionConfig` enforces GRAFANA_URL is set in production.
  // In dev/test we tolerate '' — the row UI handles missing/empty
  // `trace_url` by hiding the deep-link.
  const grafanaBase = process.env.GRAFANA_URL || '';
  const queryObj = {
    expr: `{execution_id="${executionId}"${workflowId ? `, workflow_id="${workflowId}"` : ''}}`,
  };
  const left = encodeURIComponent(
    JSON.stringify(['now-1h', 'now', 'tempo', queryObj]),
  );
  return `${grafanaBase}/explore?left=${left}`;
}

function asOptString(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * `redactInternal` (REQUIRED, no default): true for every caller that is not
 * `productionVisible`. A customer's own execution still ran on the PRODUCTION
 * n8n instance, so its `workflow_id` names a production workflow and its
 * `trace_url` deep-links platform Grafana/Tempo — both are nulled.
 */
export function shapeExecution(
  exec: Execution,
  mapping: { project_id: string; initiated_via: string; correlation_id: string },
  opts: { redactInternal: boolean },
): ScopedExecution {
  const startedAt = asOptString((exec as { startedAt?: unknown }).startedAt);
  const stoppedAt = asOptString((exec as { stoppedAt?: unknown }).stoppedAt);
  let durationMs: number | undefined;
  if (startedAt && stoppedAt) {
    const s = Date.parse(startedAt);
    const e = Date.parse(stoppedAt);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) durationMs = e - s;
  }
  const id = String((exec as { id: unknown }).id);
  const workflowId = asOptString((exec as { workflowId?: unknown }).workflowId);
  return {
    id,
    workflow_id: opts.redactInternal ? null : workflowId,
    status: asOptString((exec as { status?: unknown }).status),
    mode: asOptString((exec as { mode?: unknown }).mode),
    started_at: startedAt,
    stopped_at: stoppedAt,
    duration_ms: durationMs,
    project_id: mapping.project_id,
    initiated_via: mapping.initiated_via,
    correlation_id: mapping.correlation_id,
    trace_url: opts.redactInternal ? null : buildTraceUrl(id, workflowId),
  };
}

// ---------------------------------------------------------------------------
// Core impls (shared between HTTP routes and AG-UI handlers)
// ---------------------------------------------------------------------------

export async function listExecutionsImpl(
  userId: string,
  query: z.infer<typeof listQuerySchema>,
  /**
   * `productionVisible` = `canReadProductionWorkflows` for the caller. REQUIRED
   * (no default) so a new call site cannot forget the gate.
   *
   * `tenantId` = the caller's ACTIVE tenant (`activeTenantOf(user)`). The
   * customer path pages only mapping rows of that tenant; absent → empty
   * envelope, no query (fail closed).
   */
  access: { productionVisible: boolean; tenantId: string | undefined },
  db = defaultDb,
): Promise<{ data: ScopedExecution[]; meta: { cursor: string | null; hasMore: boolean } }> {
  // ⛔ STRICT TENANT SEPARATION (2026-09-30): a `workflowId` filter names a
  // PRODUCTION n8n workflow, whose ids a customer cannot see in the catalogue.
  // Forwarding it would still leak n8n's `nextCursor`/`hasMore` for that
  // workflow (i.e. whether it has executions) even though the user-scope JOIN
  // drops every row. A customer gets the same envelope, empty, and n8n is not
  // called. Unfiltered lists serve the caller's OWN fr-tracked executions,
  // paged over `n8n_execution_mapping` (listOwnExecutions below).
  if (query.workflowId && !access.productionVisible) {
    return { data: [], meta: { cursor: null, hasMore: false } };
  }
  // ⛔ STRICT TENANT SEPARATION: a customer never reaches n8n's GLOBAL
  // executions list. Forwarding `status`/`cursor`/`limit` there and returning
  // its `nextCursor`/`hasMore` let a customer walk the PRODUCTION execution
  // history (probe `hasMore`, replay the cursor) even though the JOIN dropped
  // every row. The customer pages its OWN mapping rows instead.
  if (!access.productionVisible) {
    if (!access.tenantId) {
      return { data: [], meta: { cursor: null, hasMore: false } };
    }
    return await listOwnExecutions(userId, access.tenantId, query, db);
  }
  const upstreamParams: GetExecutionsParams = {};
  if (query.status) upstreamParams.status = query.status as unknown as ExecutionStatus;
  if (query.workflowId) upstreamParams.workflowId = query.workflowId;
  if (query.limit !== undefined) upstreamParams.limit = query.limit;
  if (query.cursor) upstreamParams.cursor = query.cursor;
  // n8n's `projectId` is its own internal project, NOT fr's. Filter on fr's
  // projectId after joining the mapping table.

  const t0 = performance.now();
  let upstream: ExecutionList;
  try {
    upstream = await listN8nExecutions(upstreamParams);
  } finally {
    observeListDuration((performance.now() - t0) / 1000);
  }

  const items = (upstream.data ?? []) as Execution[];
  if (items.length === 0) {
    return {
      data: [],
      meta: { cursor: upstream.nextCursor ?? null, hasMore: !!upstream.nextCursor },
    };
  }

  const ids = items.map((e) => String((e as { id: unknown }).id));

  const conditions = [
    inArray(n8nExecutionMapping.execution_id, ids),
    eq(n8nExecutionMapping.user_id, userId),
  ];
  if (query.projectId) {
    conditions.push(eq(n8nExecutionMapping.project_id, query.projectId));
  }
  const mappings = await db
    .select()
    .from(n8nExecutionMapping)
    .where(and(...conditions));

  const byId = new Map<string, typeof mappings[number]>();
  for (const m of mappings) byId.set(m.execution_id, m);

  const visible: ScopedExecution[] = [];
  const terminalToCount: { id: string; status: string }[] = [];
  for (const exec of items) {
    const id = String((exec as { id: unknown }).id);
    const m = byId.get(id);
    if (!m) continue; // Not fr-tracked → invisible by design.
    visible.push(shapeExecution(exec, m, { redactInternal: false }));
    const status = String((exec as { status?: unknown }).status ?? '');
    if (TERMINAL_STATUSES.has(status) && !m.counted_terminal) {
      terminalToCount.push({ id, status });
    }
  }

  await markTerminalCounted(terminalToCount, (ids) =>
    db
      .update(n8nExecutionMapping)
      .set({ counted_terminal: true })
      .where(inArray(n8nExecutionMapping.execution_id, ids))
      .then(() => undefined),
  );

  return {
    data: visible,
    meta: { cursor: upstream.nextCursor ?? null, hasMore: !!upstream.nextCursor },
  };
}

async function markTerminalCounted(
  terminalToCount: { id: string; status: string }[],
  mark: (ids: string[]) => Promise<void>,
): Promise<void> {
  if (terminalToCount.length === 0) return;
  await mark(terminalToCount.map((x) => x.id));
  for (const t of terminalToCount) recordTerminalExecution(t.status);
}

// ---------------------------------------------------------------------------
// Customer path — the caller's OWN mapping rows, fr-owned cursor
// ---------------------------------------------------------------------------

type MappingRow = typeof n8nExecutionMapping.$inferSelect;

/** Mapping-table access for the customer path. Injectable for unit tests. */
interface OwnExecutionStore {
  /** The caller's rows, newest first, deterministic tie-break on id. */
  readPage(args: {
    userId: string;
    /** The caller's ACTIVE tenant — rows of any other tenant are never served. */
    tenantId: string;
    projectId?: string;
    offset: number;
    limit: number;
  }): Promise<MappingRow[]>;
  markCounted(ids: string[]): Promise<void>;
}

export function dbOwnExecutionStore(db: typeof defaultDb): OwnExecutionStore {
  return {
    async readPage({ userId, tenantId, projectId, offset, limit }) {
      const conditions = [
        eq(n8nExecutionMapping.user_id, userId),
        eq(n8nExecutionMapping.tenant_id, tenantId),
      ];
      if (projectId) conditions.push(eq(n8nExecutionMapping.project_id, projectId));
      return await db
        .select()
        .from(n8nExecutionMapping)
        .where(and(...conditions))
        .orderBy(desc(n8nExecutionMapping.triggered_at), desc(n8nExecutionMapping.execution_id))
        .limit(limit)
        .offset(offset);
    },
    async markCounted(ids) {
      await db
        .update(n8nExecutionMapping)
        .set({ counted_terminal: true })
        .where(inArray(n8nExecutionMapping.execution_id, ids));
    },
  };
}

/** Customer page size when none is given (each row is one n8n get-by-id). */
const OWN_DEFAULT_LIMIT = 20;
/**
 * Hard ceiling on the customer page size. Each row is one n8n get-by-id call
 * and n8n has no batch-by-id endpoint, so the route's generic `max(250)` would
 * let one customer request fan out to 250 upstream calls.
 */
const OWN_MAX_LIMIT = 25;
/** Parallel n8n get-by-id calls per page. */
const OWN_FETCH_CONCURRENCY = 10;
const OWN_CURSOR_VERSION = 'fr-own-1';

function encodeOwnCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: OWN_CURSOR_VERSION, o: offset }), 'utf8').toString(
    'base64url',
  );
}

/** Decode an fr-owned cursor. Anything else (e.g. an n8n cursor) is refused. */
function decodeOwnCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const o = (parsed as { v?: unknown; o?: unknown } | undefined)?.o;
  if (
    (parsed as { v?: unknown } | undefined)?.v !== OWN_CURSOR_VERSION ||
    typeof o !== 'number' ||
    !Number.isSafeInteger(o) ||
    o < 0
  ) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid query: cursor is not a cursor issued by this endpoint',
    });
  }
  return o;
}

async function listOwnExecutions(
  userId: string,
  tenantId: string,
  query: z.infer<typeof listQuerySchema>,
  db: typeof defaultDb,
): Promise<{ data: ScopedExecution[]; meta: { cursor: string | null; hasMore: boolean } }> {
  const store = dbOwnExecutionStore(db);
  const offset = decodeOwnCursor(query.cursor);
  // Clamp: each row is one n8n get-by-id; n8n has no batch-by-id endpoint.
  const limit = Math.min(query.limit ?? OWN_DEFAULT_LIMIT, OWN_MAX_LIMIT);

  // limit + 1 → hasMore from the caller's OWN rows, never from n8n.
  const rows = await store.readPage({
    userId,
    tenantId,
    projectId: query.projectId,
    offset,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  const t0 = performance.now();
  const fetched: (Execution | undefined)[] = [];
  try {
    for (let i = 0; i < pageRows.length; i += OWN_FETCH_CONCURRENCY) {
      const chunk = pageRows.slice(i, i + OWN_FETCH_CONCURRENCY);
      fetched.push(
        ...(await Promise.all(
          chunk.map(async (m) => {
            const numericId = Number(m.execution_id);
            if (!Number.isFinite(numericId)) return undefined;
            try {
              return await fetchExecution(numericId, { includeData: false });
            } catch (err) {
              // Pruned upstream → the row simply has nothing to show.
              if (err instanceof IntegrationError && err.code === 'UPSTREAM_NOT_FOUND') {
                return undefined;
              }
              throw err;
            }
          }),
        )),
      );
    }
  } finally {
    observeListDuration((performance.now() - t0) / 1000);
  }

  const visible: ScopedExecution[] = [];
  const terminalToCount: { id: string; status: string }[] = [];
  pageRows.forEach((m, i) => {
    const exec = fetched[i];
    if (!exec) return;
    const status = String((exec as { status?: unknown }).status ?? '');
    if (TERMINAL_STATUSES.has(status) && !m.counted_terminal) {
      terminalToCount.push({ id: m.execution_id, status });
    }
    // `status` filters the caller's OWN rows only (it lives in n8n).
    if (query.status && status !== query.status) return;
    // Customer path: never productionVisible → always redacted.
    visible.push(shapeExecution(exec, m, { redactInternal: true }));
  });

  await markTerminalCounted(terminalToCount, (ids) => store.markCounted(ids));

  return {
    data: visible,
    meta: { cursor: hasMore ? encodeOwnCursor(offset + limit) : null, hasMore },
  };
}

export async function getExecutionImpl(
  userId: string,
  executionId: string,
  /**
   * `productionVisible` = `canReadProductionWorkflows` for the caller. REQUIRED
   * (no default): a customer's single execution gets the same redaction as
   * its list rows (`workflow_id` / `trace_url` → null).
   *
   * `tenantId` = the caller's ACTIVE tenant (`activeTenantOf(user)`). Same
   * scope as the customer list: a customer sees only mapping rows of that
   * tenant; no tenant, a foreign-tenant row or a legacy NULL-tenant row → the
   * same not-found as a missing row. Ignored on the productionVisible path.
   */
  access: { productionVisible: boolean; tenantId: string | undefined },
  db = defaultDb,
): Promise<{ execution: ScopedExecution; trace_url: string | null } | null> {
  const conditions = [
    eq(n8nExecutionMapping.execution_id, executionId),
    eq(n8nExecutionMapping.user_id, userId),
  ];
  if (!access.productionVisible) {
    // Fail closed: no active tenant → not found, no query.
    if (!access.tenantId) return null;
    conditions.push(eq(n8nExecutionMapping.tenant_id, access.tenantId));
  }
  const [mapping] = await db
    .select()
    .from(n8nExecutionMapping)
    .where(and(...conditions));
  if (!mapping) return null;

  const numericId = Number(executionId);
  if (!Number.isFinite(numericId)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `executionId must be numeric for n8n upstream; got ${executionId}`,
    });
  }
  const exec = await fetchExecution(numericId, { includeData: false });
  const shaped = shapeExecution(exec, mapping, {
    redactInternal: !access.productionVisible,
  });
  return { execution: shaped, trace_url: shaped.trace_url };
}

export async function listWorkflowsImpl(
  query: z.infer<typeof workflowsQuerySchema>,
): Promise<{ workflows: Workflow[] }> {
  const params: { active?: boolean; limit?: number } = {};
  if (query.active !== undefined) params.active = query.active;
  if (query.limit !== undefined) params.limit = query.limit;
  return await listN8nWorkflows(params);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleListExecutions(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const query = parseListQuery(req);
    return await emitSpan(
      'fr.n8n.list',
      {
        'user.id': user.id,
        'project.id': query.projectId ?? null,
        'filter.status': query.status ?? null,
        'filter.workflow_id': query.workflowId ?? null,
        'page.limit': query.limit ?? null,
      },
      () =>
        handle(
          () =>
            listExecutionsImpl(user.id, query, {
              productionVisible: canReadProductionWorkflows(user),
              tenantId: activeTenantOf(user),
            }),
          (data) => jsonResponse({ data: data.data, meta: data.meta }),
        ),
    );
  });
}

export async function handleGetExecution(
  req: Request,
  executionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    return await emitSpan(
      'fr.n8n.get',
      {
        'user.id': user.id,
        'execution.id': executionId,
      },
      () =>
        handle(
          () =>
            getExecutionImpl(user.id, executionId, {
              productionVisible: canReadProductionWorkflows(user),
              tenantId: activeTenantOf(user),
            }),
          (data) => {
            if (!data) {
              return jsonResponse(
                {
                  error: {
                    code: 'UPSTREAM_NOT_FOUND',
                    message: `Execution ${executionId} not found in user scope`,
                  },
                },
                404,
              );
            }
            return jsonResponse({ data });
          },
        ),
    );
  });
}

export async function handleListWorkflows(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const query = parseWorkflowsQuery(req);
    return await emitSpan(
      'fr.n8n.list_workflows',
      {
        'user.id': user.id,
        'filter.active': query.active ?? null,
        'page.limit': query.limit ?? null,
      },
      () =>
        handle(
          // ⛔ STRICT TENANT SEPARATION (2026-09-30): the catalogue is the
          // PRODUCTION n8n instance. A customer gets the same envelope, empty.
          async () =>
            canReadProductionWorkflows(user)
              ? await listWorkflowsImpl(query)
              : { workflows: [] as Workflow[] },
          (data) => jsonResponse({ data: data.workflows }),
        ),
    );
  });
}

// ---------------------------------------------------------------------------
// AG-UI action registration lives in `agui/actions/n8n.ts` (T6, 2026-05-01).
// Mirrors the bridge.ts / streams.ts pattern: action definitions +
// `registerN8nActions()` are exported from `agui/actions/n8n.ts`, and server
// boot calls it after the tools modules load (routes/tools/index.ts).
//
// Tests import `registerN8nActions` directly from `agui/actions/n8n.ts`
// (the `__registerN8nActionsForTests` lazy-require shim was removed
// 2026-05-01 once registration was stable; see Wave 2a follow-up to PR #94).
// ---------------------------------------------------------------------------
