// src/services/conveyor-flow-runs.ts
//
// Cockpit A5 / R-CK5 (migration 213): the n8n execution-hook record of every conveyor flow run.
//
//   ingestFlowRuns(body)          POST /api/internal/conveyor/flow-runs (routes/internal-conveyor-flow-runs.ts)
//   listFlowRunsForProject(id, …) the cockpit's flow block + GET /api/projects/:id/flow-runs
//
// INGEST RULES
//   * One record or an array of at most MAX_BATCH. Each record is validated on its own: a bad
//     record is REJECTED and counted, never a 500, and never stops the valid ones landing.
//   * Upsert on `execution_id` — the hook fires again when a waiting execution resumes.
//   * A `running` / `waiting` record NEVER overwrites a terminal status (success / error /
//     canceled / crashed) that arrived first (hooks race). Such a record only fills fields the
//     stored row still lacks; it is counted `kept_terminal`.
//   * A later record never blanks a stored field: an absent / null field keeps the stored value.
//   * `project_ref` is stored as received. fr resolves an fr project id to its project and takes
//     `tenant_id` from that project's tenant tag (`project_data->>'keycloak_tenant_id'`). Any
//     other ref (the RM pm_project id most flows send) is left unresolved (project_id/tenant_id
//     NULL): fr keeps no RM id (R345 — RM is the authority) and the hook names no tenant to ask
//     RM in. The READ resolves it instead: listFlowRunsForProject matches an unresolved row whose
//     ref is the project's RM pm_project id, which the caller resolved from RM.
//   * `error_message` is clipped to ERROR_MESSAGE_MAX characters, never refused for length.
//   * `n8n_status` (migration 214, n8n-custom #17) is n8n's OWN final status, kept next to the
//     conveyor's `status`: a flow that took its `Flow error` / `Agent failed` path arrives as
//     status 'error', error_class 'flow_error' / 'agent_failed', n8n_status 'success'.
//
// fr is a facilitator: it records what the hook reports and decides nothing from it.
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { conveyorFlowRuns, db as defaultDb, projects } from '../db/client';
import { CONVEYOR_FLOW_RUN_STATUSES, CONVEYOR_FLOW_RUN_TERMINAL_STATUSES, type ConveyorFlowRunRow } from '../db/schema';
import { isUuidShape } from '../lib/uuid-shape';

export const MAX_BATCH = 200;
export const ERROR_MESSAGE_MAX = 2000;
const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

const opaque = (max: number) =>
  z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(max));
const optOpaque = (max: number) =>
  z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined ? null : String(v).trim() || null))
    .pipe(z.string().max(max).nullable());
const optTime = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v.trim() === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not an ISO-8601 date-time' });
      return z.NEVER;
    }
    return d;
  });

/**
 * One hook record. `workflow` and `project_id` are accepted as aliases of `workflow_name` and
 * `project_ref` (the A3 hook contract names them that way); the canonical name wins when both
 * are sent. Unknown keys are ignored (the hook ships from another repo on another schedule).
 */
const FlowRunRecordSchema = z
  .object({
    execution_id: opaque(200),
    workflow_id: optOpaque(200),
    workflow_name: optOpaque(500),
    workflow: optOpaque(500),
    card_id: optOpaque(200),
    project_ref: optOpaque(200),
    project_id: optOpaque(200),
    status: z.enum(CONVEYOR_FLOW_RUN_STATUSES),
    // n8n-custom #17: n8n's own final status. Free text (n8n's vocabulary); never refuses a record.
    n8n_status: optOpaque(40),
    started_at: optTime,
    stopped_at: optTime,
    failed_node: optOpaque(500),
    error_class: optOpaque(200),
    error_message: z
      .union([z.string(), z.null()])
      .optional()
      .transform((v) => (v === null || v === undefined || v === '' ? null : v.slice(0, ERROR_MESSAGE_MAX))),
    retry_of: optOpaque(200),
    parent_execution_id: optOpaque(200),
  })
  .passthrough();

type FlowRunRecord = {
  execution_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  card_id: string | null;
  project_ref: string | null;
  status: (typeof CONVEYOR_FLOW_RUN_STATUSES)[number];
  n8n_status: string | null;
  started_at: Date | null;
  stopped_at: Date | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  retry_of: string | null;
  parent_execution_id: string | null;
};

interface FlowRunRejection {
  index: number;
  execution_id: string | null;
  reason: string;
}

interface FlowRunIngestResult {
  received: number;
  inserted: number;
  updated: number;
  /** A running/waiting record that arrived after a terminal one: the terminal status was kept. */
  kept_terminal: number;
  rejected: FlowRunRejection[];
  /** Valid records the database refused to write (counted, never thrown). */
  failed: FlowRunRejection[];
}

/** Validate one raw record. Returns the normalised record or the reason it was refused. */
export function parseFlowRunRecord(raw: unknown): { ok: true; record: FlowRunRecord } | { ok: false; reason: string } {
  const parsed = FlowRunRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `${issue?.path.join('.') || 'record'}: ${issue?.message ?? 'invalid'}` };
  }
  const r = parsed.data;
  return {
    ok: true,
    record: {
      execution_id: r.execution_id,
      workflow_id: r.workflow_id,
      workflow_name: r.workflow_name ?? r.workflow,
      card_id: r.card_id,
      project_ref: r.project_ref ?? r.project_id,
      status: r.status,
      n8n_status: r.n8n_status,
      started_at: r.started_at,
      stopped_at: r.stopped_at,
      failed_node: r.failed_node,
      error_class: r.error_class,
      error_message: r.error_message,
      retry_of: r.retry_of,
      parent_execution_id: r.parent_execution_id,
    },
  };
}

/** Thrown for a body the route answers 4xx as a whole (not JSON-shaped, empty, too large). */
export class FlowRunBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: 'invalid_body' | 'empty_batch' | 'batch_too_large',
    message: string,
  ) {
    super(message);
  }
}

/** Normalise a request body into the list of raw records (one object, or an array ≤ MAX_BATCH). */
export function recordsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    if (body.length === 0) throw new FlowRunBodyError(400, 'empty_batch', 'The array holds no records');
    if (body.length > MAX_BATCH) {
      throw new FlowRunBodyError(413, 'batch_too_large', `At most ${MAX_BATCH} records per request (got ${body.length})`);
    }
    return body;
  }
  if (body !== null && typeof body === 'object') {
    const records = (body as { records?: unknown }).records;
    if (Array.isArray(records)) return recordsOf(records);
    return [body];
  }
  throw new FlowRunBodyError(400, 'invalid_body', 'The body must be a flow-run record or an array of them');
}

interface Resolution {
  projectId: string | null;
  tenantId: string | null;
}

/** fr's resolution of a project_ref: the project whose fr id it is, else none (see INGEST RULES). */
async function resolveProjectRef(ref: string | null): Promise<Resolution> {
  if (!ref || !isUuidShape(ref)) return { projectId: null, tenantId: null };
  const [row] = await defaultDb
    .select({ id: projects.id, tenant: sql<string | null>`${projects.project_data}->>'keycloak_tenant_id'` })
    .from(projects)
    .where(eq(projects.id, ref))
    .limit(1);
  if (!row) return { projectId: null, tenantId: null };
  return { projectId: row.id, tenantId: isUuidShape(row.tenant) ? row.tenant : null };
}

// The statuses are this module's own constants (never request data), so inlining them is safe.
const TERMINAL_LIST = `(${CONVEYOR_FLOW_RUN_TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ')})`;
/** The incoming record is non-terminal and the stored row already is terminal. */
const STALE = `(conveyor_flow_runs.status IN ${TERMINAL_LIST} AND excluded.status IN ('running', 'waiting'))`;
/** Fresh record: its non-null fields win. Stale record: it only fills what the stored row lacks. */
const merge = (col: string) =>
  sql.raw(
    `CASE WHEN ${STALE} THEN COALESCE(conveyor_flow_runs.${col}, excluded.${col}) ` +
      `ELSE COALESCE(excluded.${col}, conveyor_flow_runs.${col}) END`,
  );

const MERGED_COLUMNS = [
  'n8n_status',
  'workflow_id',
  'workflow_name',
  'card_id',
  'project_ref',
  'project_id',
  'tenant_id',
  'stopped_at',
  'failed_node',
  'error_class',
  'error_message',
  'retry_of',
  'parent_execution_id',
] as const;

/** Upsert one validated record. Returns what happened to it. */
async function upsertFlowRun(record: FlowRunRecord, resolution: Resolution): Promise<'inserted' | 'updated' | 'kept_terminal'> {
  const set: Record<string, unknown> = {
    status: sql.raw(`CASE WHEN ${STALE} THEN conveyor_flow_runs.status ELSE excluded.status END`),
    received_at: sql`now()`,
    // ⛔ The EARLIEST start wins, whatever the record order: n8n resets `startedAt` when a waiting
    // execution resumes, so the resumed run's postExecute reports a LATER start for the same
    // execution. LEAST ignores NULLs, so an absent start never blanks a stored one.
    started_at: sql.raw('LEAST(conveyor_flow_runs.started_at, excluded.started_at)'),
  };
  for (const col of MERGED_COLUMNS) set[col] = merge(col);
  const rows = await defaultDb
    .insert(conveyorFlowRuns)
    .values({
      ...record,
      project_id: resolution.projectId,
      tenant_id: resolution.tenantId,
    })
    .onConflictDoUpdate({ target: conveyorFlowRuns.execution_id, set })
    .returning({ inserted: sql<boolean>`(xmax = 0)`, status: conveyorFlowRuns.status });
  const row = rows[0];
  if (row?.inserted) return 'inserted';
  return row && row.status !== record.status ? 'kept_terminal' : 'updated';
}

/** The whole ingest: validate each record, resolve its project once per ref, upsert, count. */
export async function ingestFlowRuns(body: unknown): Promise<FlowRunIngestResult> {
  const raws = recordsOf(body);
  const out: FlowRunIngestResult = { received: raws.length, inserted: 0, updated: 0, kept_terminal: 0, rejected: [], failed: [] };
  const resolved = new Map<string, Resolution>();
  for (const [index, raw] of raws.entries()) {
    const parsed = parseFlowRunRecord(raw);
    const rawId = (raw as { execution_id?: unknown } | null)?.execution_id;
    if (!parsed.ok) {
      out.rejected.push({ index, execution_id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null, reason: parsed.reason });
      continue;
    }
    const { record } = parsed;
    try {
      const key = record.project_ref ?? '';
      let resolution = resolved.get(key);
      if (!resolution) {
        resolution = await resolveProjectRef(record.project_ref);
        resolved.set(key, resolution);
      }
      const outcome = await upsertFlowRun(record, resolution);
      out[outcome] += 1;
    } catch (err) {
      out.failed.push({ index, execution_id: record.execution_id, reason: err instanceof Error ? err.message.slice(0, 300) : 'write failed' });
    }
  }
  return out;
}

interface ListFlowRunsOptions {
  /** Only runs started at or after this instant. */
  since?: Date | null;
  /** Rows, newest first; 1..LIST_MAX_LIMIT (default LIST_DEFAULT_LIMIT). */
  limit?: number;
  /** Tenant pin: when set, only rows whose resolved tenant is this one (fail closed). */
  tenantId?: string | null;
  /**
   * The project's RM pm_project id, resolved from RM by the caller (in the project's own tenant).
   * Set ⇒ the unresolved rows the hook reported under that ref are the project's too.
   */
  rmPmProjectId?: string | null;
}

/** A project's flow runs, newest started first (rows with no start time last). */
export async function listFlowRunsForProject(projectId: string, opts: ListFlowRunsOptions = {}): Promise<ConveyorFlowRunRow[]> {
  if (!isUuidShape(projectId)) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? LIST_DEFAULT_LIMIT), 1), LIST_MAX_LIMIT);
  const own = [eq(conveyorFlowRuns.project_id, projectId)];
  if (opts.tenantId !== undefined) {
    if (!isUuidShape(opts.tenantId)) return [];
    own.push(eq(conveyorFlowRuns.tenant_id, opts.tenantId));
  }
  // An unresolved row (no project, no tenant) whose ref is the project's RM id: that id came from
  // RM in the project's own tenant, so the match is the tenant pin.
  const byRmRef = opts.rmPmProjectId
    ? and(isNull(conveyorFlowRuns.project_id), eq(conveyorFlowRuns.project_ref, opts.rmPmProjectId))
    : undefined;
  const conds = [byRmRef ? or(and(...own), byRmRef)! : and(...own)!];
  if (opts.since) conds.push(gte(conveyorFlowRuns.started_at, opts.since));
  return defaultDb
    .select()
    .from(conveyorFlowRuns)
    .where(and(...conds))
    .orderBy(sql`${conveyorFlowRuns.started_at} DESC NULLS LAST`, desc(conveyorFlowRuns.received_at))
    .limit(limit);
}
