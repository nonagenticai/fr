// src/routes/project-execution.ts
//
// fr-agui SPEC §7.4 / §13 P3 — the project's EXECUTION OBSERVABILITY reads, the
// data behind the Execution hub (`/projects/[id]/execution`) and the project
// agent's observability tools:
//
//   GET /api/projects/:id/executions            every fr-initiated n8n run of the project (any member's)
//   GET /api/projects/:id/wip                   RM's WIP limit for the project + the Planka board count
//   GET /api/projects/:id/agent-actions         capability_audit rows of the project (actor, capability, outcome, time)
//   GET /api/projects/:id/blocked-cards         BLOCKED-lane cards, their block reason, the card's open gate
//   GET /api/projects/:id/cards-by-type         the board's cards of one RM card type of the project's type
//   GET /api/projects/:id/conveyor-executions   conveyor v4 runs tagged with the project (§7.4a); off until tagged
//   GET /api/projects/:id/flow-runs             the n8n execution-hook record of the project's flow runs (cockpit R-CK5)
//
// GATE (every read): `validateAuth` → `loadProjectForRead` — any member of the
// project's tenant (P1-TEAM-a; the ruling: every tenant member sees every
// project's runs), the same 404 for every unreadable shape. fr is a FACILITATOR:
// these reads report what n8n, Planka, requirements_management and fr's own
// tables say; nothing here judges, ranks or decides.
//
// TENANT PIN (⛔ fail closed, one rule for every fr table read here): rows are
// selected on the project id AND the caller's ACTIVE tenant — the predicate the
// cockpit's approvals block uses (fr row 14d). For every member that is the
// project's tenant. A super-admin's HOME view of another tenant's project gets
// no rows (it switches into the tenant to read them), never another tenant's.
// Upstream reads (RM, the conveyor's n8n custom data) use the PROJECT's tenant
// tag (`projectCatalogueTenant`), the same rule as routes/project-pm.ts.
//
// Envelope `{ data }` (a single read model). Every `data` carries `project_id`
// (the bound project) and passes through
// `redact()` (capabilities/redact.ts: secret-shaped values and secret-named
// keys) — execution, card and block-reason text is free text and may carry a
// secret, so nothing is served unscrubbed.
import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { config } from '../config';
import { db as defaultDb, n8nExecutionMapping, capabilityAudit, approvals } from '../db/client';
import { redact } from '../capabilities/redact';
import { IntegrationError } from '../integrations/_lib/errors';
import { getExecution, listExecutionsOn, type Execution, type N8nInstance } from '../integrations/n8n';
import { getPmProjectWipLimit, type PmProjectWipLimitOut } from '../integrations/pm';
import { loadProjectForRead } from '../lib/project-access';
import { canReadProductionWorkflows } from '../lib/production-workflows-gate';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { normalizePhase } from '../services/cockpit/project-cockpit';
import { projectTypeAndPhase, rmPmProjectIdOf } from '../services/catalogue/project-state';
import { composition, projectCatalogueTenant, wip } from '../services/catalogue/tenant-catalogue';
import { plankaClient } from '../services/planka';
import { AppError, handleError } from '../utils/errors';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { jsonResponse } from '../utils/response';
import { shapeExecution } from './tools/n8n';
import { listFlowRunsForProject, LIST_MAX_LIMIT as FLOW_RUNS_MAX_LIMIT } from '../services/conveyor-flow-runs';

// R311 PR 5: the conveyor failure notices + start retry offer read is served by its own
// module; re-exported here so the hub's read table (capabilities/projects/execution.ts) binds one module.
export { handleListProjectConveyorNotices } from './project-conveyor-start';

type User = Awaited<ReturnType<typeof validateAuth>>;
type ProjectRow = Awaited<ReturnType<typeof loadProjectForRead>>;
type MappingRow = typeof n8nExecutionMapping.$inferSelect;

interface AuditListRow {
  capability_id: string | null;
  user_id: string;
  initiator: string;
  status: string;
  ts: Date | string;
}

interface OpenGateRow {
  id: string;
  card_id: string | null;
  kind: string;
  description: string;
  created_at: Date | string | null;
}

/** The raw Planka board detail, with the custom-field bags `boards.get` passes through. */
interface RawBoard {
  included?: {
    lists?: Array<{ id: string; name?: string | null }>;
    cards?: Array<{ id: string; name?: string | null; listId: string; listChangedAt?: string | null; updatedAt?: string | null; createdAt?: string | null }>;
    customFieldGroups?: Array<{ id: string; name?: string | null }>;
    customFields?: Array<{ id: string; name?: string | null; customFieldGroupId: string }>;
    customFieldValues?: Array<{ cardId: string; customFieldGroupId?: string; customFieldId: string; content?: unknown }>;
  };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

// The real-SQL reads behind the execution routes (tenant-pinned).
export async function executionMappingPage(a: { projectId: string; tenantId: string; since?: Date; offset: number; limit: number }): Promise<MappingRow[]> {
  const where = [eq(n8nExecutionMapping.project_id, a.projectId), eq(n8nExecutionMapping.tenant_id, a.tenantId)];
  if (a.since) where.push(gte(n8nExecutionMapping.triggered_at, a.since));
  return await defaultDb
    .select()
    .from(n8nExecutionMapping)
    .where(and(...where))
    .orderBy(desc(n8nExecutionMapping.triggered_at), desc(n8nExecutionMapping.execution_id))
    .limit(a.limit)
    .offset(a.offset);
}

export async function executionAuditRows(a: { projectId: string; tenantId: string; limit: number }): Promise<AuditListRow[]> {
  return await defaultDb
    .select({
      capability_id: capabilityAudit.capability_id,
      user_id: capabilityAudit.user_id,
      initiator: capabilityAudit.initiator,
      status: capabilityAudit.status,
      ts: capabilityAudit.ts,
    })
    .from(capabilityAudit)
    .where(and(eq(capabilityAudit.project_id, a.projectId), eq(capabilityAudit.tenant_id, a.tenantId)))
    .orderBy(desc(capabilityAudit.ts))
    .limit(a.limit);
}

export async function executionOpenGates(a: { projectId: string; tenantId: string; cardIds: string[] }): Promise<OpenGateRow[]> {
  if (a.cardIds.length === 0) return [];
  return await defaultDb
    .select({
      id: approvals.id,
      card_id: approvals.card_id,
      kind: approvals.kind,
      description: approvals.description,
      created_at: approvals.created_at,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.project_id, a.projectId),
        eq(approvals.tenant_id, a.tenantId),
        eq(approvals.status, 'pending'),
        inArray(approvals.card_id, a.cardIds),
      ),
    )
    .orderBy(desc(approvals.created_at));
}

async function actorNames(ids: Set<string>): Promise<Map<string, string>> {
  const { resolveActorNames } = await import('./dashboard');
  return resolveActorNames(ids);
}

function readBoard(boardId: string): Promise<RawBoard> {
  return plankaClient.asAgent().boards.get(boardId) as Promise<RawBoard>;
}

/** The NAMED conveyor n8n instance (§7.4a) — null unless BOTH url and key are set. Never fr's default n8n. */
function conveyorInstance(): N8nInstance | null {
  const { conveyorRunsN8nUrl: apiUrl, conveyorRunsN8nApiKey: apiKey } = config.services.n8n;
  return apiUrl && apiKey ? { apiUrl, apiKey } : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Scope {
  user: User;
  project: ProjectRow;
  projectId: string;
}

async function scopeOf(req: Request, projectId: string): Promise<Scope> {
  const user = await validateAuth(req);
  const project = await loadProjectForRead(defaultDb, user, projectId);
  return { user, project, projectId: project.id };
}

/** `body` scrubbed (secret-shaped values / secret-named keys → «redacted»), naming the bound project. */
function scrubbed(projectId: string, body: Record<string, unknown>): Record<string, unknown> {
  return redact({ project_id: projectId, ...body });
}

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

function invalid(message: string): AppError {
  return new AppError(422, message).withCode('invalid_input');
}

/** A bounded int query param. */
function intParam(q: URLSearchParams, name: string, dflt: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer ${min}..${max}`);
  return n;
}

const UPSTREAM_DOWN = (err: unknown): string =>
  err instanceof IntegrationError ? err.code : err instanceof AppError ? (err.code ?? `http_${err.statusCode}`) : 'upstream_unavailable';

/** Card id → { fieldName → content } for the named custom fields, from one board read. */
function cardFields(board: RawBoard, fieldNames: readonly string[]): Map<string, Record<string, string>> {
  const inc = board.included ?? {};
  const wanted = new Set(fieldNames);
  const fieldName = new Map<string, string>();
  for (const f of inc.customFields ?? []) if (f.name && wanted.has(f.name)) fieldName.set(f.id, f.name);
  const out = new Map<string, Record<string, string>>();
  for (const v of inc.customFieldValues ?? []) {
    const name = fieldName.get(v.customFieldId);
    if (!name) continue;
    const row = out.get(v.cardId) ?? {};
    row[name] = String(v.content ?? '');
    out.set(v.cardId, row);
  }
  return out;
}

function boardCards(board: RawBoard): Array<{ id: string; name: string; list_name: string | null; phase: string; since: string | null }> {
  const lists = new Map((board.included?.lists ?? []).map((l) => [l.id, l.name ?? null]));
  return (board.included?.cards ?? []).map((c) => {
    const list = lists.get(c.listId) ?? null;
    return {
      id: c.id,
      name: c.name ?? '',
      list_name: list,
      phase: normalizePhase(list),
      since: c.listChangedAt ?? c.updatedAt ?? c.createdAt ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/executions — every fr-initiated run of the project
// ---------------------------------------------------------------------------

const EXECUTIONS_DEFAULT_LIMIT = 20;
/** Each row costs one n8n get-by-id (n8n has no batch read): the same ceiling as the own-runs list. */
const EXECUTIONS_MAX_LIMIT = 25;
const FETCH_CONCURRENCY = 10;
const CURSOR_VERSION = 'fr-proj-exec-1';

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  let parsed: { v?: unknown; o?: unknown } | undefined;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; o?: unknown };
  } catch {
    parsed = undefined;
  }
  const o = parsed?.o;
  if (parsed?.v !== CURSOR_VERSION || typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) {
    throw invalid('cursor is not a cursor issued by this endpoint');
  }
  return o;
}

/**
 * The project's fr-initiated runs, newest first, from fr's own record
 * (`n8n_execution_mapping`: who started it, when, how) — EVERY member's, not
 * only the caller's (`n8n.list_executions` keeps serving the caller's own). The
 * run's status comes from n8n; when n8n cannot answer the row is still listed
 * (fr's record proves the run was started) with `status: null` and
 * `status_source` saying why — never dropped, never guessed.
 */
export async function handleListProjectExecutions(req: Request, projectId: string): Promise<Response> {
  try {
    const { user, projectId: pid } = await scopeOf(req, projectId);
    const q = query(req);
    const limit = intParam(q, 'limit', EXECUTIONS_DEFAULT_LIMIT, 1, EXECUTIONS_MAX_LIMIT);
    const offset = decodeCursor(q.get('cursor'));
    const sinceRaw = q.get('since');
    let since: Date | undefined;
    if (sinceRaw) {
      since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) throw invalid('since must be an ISO-8601 date-time');
    }
    const rows = await executionMappingPage({ projectId: pid, tenantId: ctxTenantId(user.tenantId), since, offset, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const fetched: Array<{ exec?: Execution; source: 'n8n' | 'pruned' | 'unavailable' }> = [];
    for (let i = 0; i < page.length; i += FETCH_CONCURRENCY) {
      const chunk = page.slice(i, i + FETCH_CONCURRENCY);
      fetched.push(
        ...(await Promise.all(
          chunk.map(async (m) => {
            const n = Number(m.execution_id);
            if (!Number.isFinite(n)) return { source: 'unavailable' as const };
            try {
              return { exec: await getExecution(n, { includeData: false }), source: 'n8n' as const };
            } catch (err) {
              if (err instanceof IntegrationError && err.code === 'UPSTREAM_NOT_FOUND') return { source: 'pruned' as const };
              return { source: 'unavailable' as const };
            }
          }),
        )),
      );
    }
    const names = await actorNames(new Set(page.map((m) => m.user_id)));
    const redactInternal = !canReadProductionWorkflows(user);
    const runs = page.map((m, i) => {
      const f = fetched[i]!;
      const shaped = f.exec
        ? shapeExecution(f.exec, m, { redactInternal })
        : {
            id: m.execution_id,
            workflow_id: redactInternal ? null : m.workflow_id,
            status: undefined,
            mode: undefined,
            started_at: undefined,
            stopped_at: undefined,
            duration_ms: undefined,
            project_id: m.project_id,
            initiated_via: m.initiated_via,
            correlation_id: m.correlation_id,
            trace_url: null,
          };
      return {
        ...shaped,
        status: shaped.status ?? null,
        status_source: f.source,
        triggered_at: iso(m.triggered_at),
        // A display name only — never another member's user id (SPEC §7.4).
        initiated_by: names.get(m.user_id) ?? null,
        initiated_by_me: m.user_id === user.id,
      };
    });
    return jsonResponse({ data: scrubbed(pid, {
      scope: 'all_members',
      runs,
      meta: { cursor: hasMore ? encodeCursor(offset + limit) : null, hasMore },
    }) });
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/wip — RM's limit + the board count (read-only)
// ---------------------------------------------------------------------------

const BOARD_COUNT_LABEL = "board count (Planka), not n8n's enforced count";

const WIP_SOURCE_LABEL: Record<string, string> = {
  project: "this project's own WIP limit (requirements_management)",
  catalogue: "fallback: the tenant catalogue's limit for this project's type (no project limit is set)",
  none: 'no WIP limit is set in requirements_management for this project or its type',
  catalogue_resolve:
    "fallback: the most specific catalogue limit for this project's type (requirements_management's per-project read was not available)",
};

/**
 * The project's WIP limit as requirements_management holds it, next to how
 * many of its cards sit in DOING on the Planka board. ⛔ READ-ONLY and NOT the
 * enforced figure: n8n enforces WIP (fr#1552 deleted fr's own enforcement);
 * the board count is what Planka shows, and it is labelled so.
 */
export async function handleGetProjectWip(req: Request, projectId: string): Promise<Response> {
  try {
    const { project, projectId: pid } = await scopeOf(req, projectId);

    let limit: Record<string, unknown>;
    try {
      const state = await projectTypeAndPhase(project);
      let w: PmProjectWipLimitOut | null = null;
      let source: string;
      try {
        w = await getPmProjectWipLimit(state.tenantId, state.rmPmProjectId);
        source = w.source;
      } catch (err) {
        // RM's per-project read failed: fall back to the catalogue resolver for
        // the project's type, LABELLED as the fallback (SPEC §7.4).
        if (!state.projectTypeId) throw err;
        const r = await wip(state.tenantId, { project_type_id: state.projectTypeId });
        w = { project_id: state.rmPmProjectId, source: 'catalogue', effective_wip_limit: r.wip_limit, catalogue_limit_id: r.id, wip_limit: null };
        source = 'catalogue_resolve';
      }
      limit = {
        available: true,
        effective_wip_limit: w.effective_wip_limit ?? null,
        project_wip_limit: w.wip_limit ?? null,
        source,
        label: WIP_SOURCE_LABEL[source] ?? `source: ${source}`,
        catalogue_limit_id: w.catalogue_limit_id ?? null,
        paused: w.effective_wip_limit === 0,
      };
    } catch (err) {
      limit = { available: false, reason: UPSTREAM_DOWN(err) };
    }

    let boardCount: Record<string, unknown>;
    if (!project.planka_board_id) {
      boardCount = { available: false, reason: 'no_board', label: BOARD_COUNT_LABEL };
    } else {
      try {
        const cards = boardCards(await readBoard(project.planka_board_id));
        boardCount = { available: true, doing: cards.filter((c) => c.phase === 'DOING').length, label: BOARD_COUNT_LABEL };
      } catch (err) {
        boardCount = { available: false, reason: UPSTREAM_DOWN(err), label: BOARD_COUNT_LABEL };
      }
    }

    const eff = limit.available ? (limit.effective_wip_limit as number | null) : null;
    const doing = boardCount.available ? (boardCount.doing as number) : null;
    return jsonResponse({ data: scrubbed(pid, {
      limit,
      board_count: boardCount,
      // Headroom against the BOARD count (both inputs known, a limit set) — never n8n's.
      headroom: eff !== null && doing !== null ? eff - doing : null,
      enforced_by: 'n8n',
    }) });
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/agent-actions — capability_audit (SPEC §10.5)
// ---------------------------------------------------------------------------

const AGENT_ACTIONS_MAX_LIMIT = 100;

function outcomeOf(status: string): { outcome: string; http_status: number | null } {
  const m = /^(executed|unmatched):(\d{3})$/.exec(status);
  if (m) return { outcome: m[1]!, http_status: Number(m[2]) };
  return { outcome: status, http_status: null };
}

/**
 * The agent activity of the project, any member's: who (a display name), which
 * capability, the outcome, when. ⛔ NEVER the input, its hash, the thread or the
 * proposal id (SPEC §7.4 / §10.5) — another member's chat is never exposed.
 */
export async function handleListProjectAgentActions(req: Request, projectId: string): Promise<Response> {
  try {
    const { user, projectId: pid } = await scopeOf(req, projectId);
    const limit = intParam(query(req), 'limit', 50, 1, AGENT_ACTIONS_MAX_LIMIT);
    const rows = await executionAuditRows({ projectId: pid, tenantId: ctxTenantId(user.tenantId), limit });
    const names = await actorNames(new Set(rows.map((r) => r.user_id)));
    return jsonResponse({ data: scrubbed(pid, {
      actions: rows.map((r) => ({
        capability: r.capability_id,
        actor: names.get(r.user_id) ?? null,
        by_me: r.user_id === user.id,
        initiator: r.initiator,
        ...outcomeOf(r.status),
        at: iso(r.ts),
      })),
    }) });
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/blocked-cards — the BLOCKED lane, with reasons
// ---------------------------------------------------------------------------

/**
 * The cards in the board's BLOCKED lane (the same lane predicate as the cockpit
 * and the board), each with its `block_reason` (the Runtime State field the
 * conveyor writes, `null` when the card carries none — never invented) and its
 * open gate, if any (the ONE pending approval holding the card,
 * domain/approvals/one-open-gate.ts).
 */
export async function handleListProjectBlockedCards(req: Request, projectId: string): Promise<Response> {
  try {
    const { user, project, projectId: pid } = await scopeOf(req, projectId);
    if (!project.planka_board_id) return jsonResponse({ data: scrubbed(pid, { available: false, reason: 'no_board', cards: [] }) });
    const board = await readBoard(project.planka_board_id);
    const blocked = boardCards(board).filter((c) => c.phase === 'BLOCKED');
    const fields = cardFields(board, ['block_reason']);
    const gates = await executionOpenGates({ projectId: pid, tenantId: ctxTenantId(user.tenantId), cardIds: blocked.map((c) => c.id) });
    const gateByCard = new Map<string, OpenGateRow>();
    for (const g of gates) if (g.card_id && !gateByCard.has(g.card_id)) gateByCard.set(g.card_id, g);
    return jsonResponse({ data: scrubbed(pid, {
      available: true,
      cards: blocked.map((c) => {
        const reason = (fields.get(c.id)?.block_reason ?? '').trim();
        const gate = gateByCard.get(c.id);
        return {
          id: c.id,
          name: c.name,
          list_name: c.list_name,
          blocked_since: c.since,
          block_reason: reason === '' ? null : reason,
          escalation: gate
            ? { approval_id: gate.id, kind: gate.kind, description: gate.description, created_at: iso(gate.created_at), url: `/projects/${pid}/approve/${gate.id}` }
            : null,
          url: `/projects/${pid}/cards/${c.id}`,
        };
      }),
    }) });
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/cards-by-type?card_type= — generic over RM's card types
// ---------------------------------------------------------------------------

const CARD_TYPE_RE = /^[a-z0-9][a-z0-9_]{0,99}$/;

/** Every card-type NAME the composition of the project's type places, from RM's matrix. */
function compositionCardTypes(comp: unknown): Set<string> {
  const out = new Set<string>();
  const phases = (comp as { phases?: unknown } | null)?.phases;
  for (const ph of Array.isArray(phases) ? phases : []) {
    const caps = (ph as { capabilities?: unknown } | null)?.capabilities;
    for (const cap of Array.isArray(caps) ? caps : []) {
      const cts = (cap as { card_types?: unknown } | null)?.card_types;
      for (const ct of Array.isArray(cts) ? cts : []) {
        const name = (ct as { name?: unknown } | null)?.name;
        if (typeof name === 'string' && name !== '') out.add(name);
      }
    }
  }
  return out;
}

/**
 * The board's cards whose Metadata `card_type` is `card_type` — for a card type
 * RM's composition places in the PROJECT's type only. An unknown type (e.g.
 * `coach`, until the conveyor defines it) answers `[]` with
 * `reason:'card_type_unknown'`: never an invented list.
 */
export async function handleListProjectCardsByType(req: Request, projectId: string): Promise<Response> {
  try {
    const { project, projectId: pid } = await scopeOf(req, projectId);
    const cardType = (query(req).get('card_type') ?? '').trim();
    if (!CARD_TYPE_RE.test(cardType)) throw invalid('card_type must be a card type name (lowercase letters, digits, _)');
    const state = await projectTypeAndPhase(project);
    const comp = state.projectType ? await composition(state.tenantId, state.projectType) : null;
    const known = compositionCardTypes(comp);
    if (!known.has(cardType)) {
      return jsonResponse({ data: scrubbed(pid, {
        card_type: cardType,
        project_type: state.projectType,
        known: false,
        reason: 'card_type_unknown',
        cards: [],
      }) });
    }
    if (!project.planka_board_id) return jsonResponse({ data: scrubbed(pid, { card_type: cardType, known: true, available: false, reason: 'no_board', cards: [] }) });
    const board = await readBoard(project.planka_board_id);
    const fields = cardFields(board, ['card_type']);
    const cards = boardCards(board)
      .filter((c) => (fields.get(c.id)?.card_type ?? '').trim() === cardType)
      .map((c) => ({ id: c.id, name: c.name, list_name: c.list_name, phase: c.phase, url: `/projects/${pid}/cards/${c.id}` }));
    return jsonResponse({ data: scrubbed(pid, { card_type: cardType, project_type: state.projectType, known: true, available: true, cards }) });
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/conveyor-executions — SPEC §7.4a, OFF until tagged
// ---------------------------------------------------------------------------

const CONVEYOR_RUNS_UNTAGGED = 'conveyor_runs_untagged';
/** The flag is on but the conveyor's n8n instance is not named (FR_CONVEYOR_RUNS_N8N_URL + _API_KEY). */
const CONVEYOR_INSTANCE_UNCONFIGURED = 'conveyor_instance_unconfigured';
/** n8n list pages scanned per read (250 executions each): bounded, and `truncated` says so. */
const CONVEYOR_SCAN_PAGES = 4;
const N8N_PAGE = 250;

/**
 * The conveyor v4 runs of the project, per the tagging contract (§7.4a): n8n
 * executions whose custom data carries `fr_project_id` = the bound project AND
 * `fr_tenant_id` = the project's tenant tag. Until the conveyor sets those tags
 * (the cross-repo issue) the switch `FR_CONVEYOR_RUN_TAGS` stays empty and the
 * read answers `available:false, reason:'conveyor_runs_untagged'` without
 * calling anything — an untagged run is unattributable, so nothing is guessed.
 * Only `custom_data` (the contract's primary) is built; the Data Table fallback
 * awaits the issue's measurement of which n8n API serves it.
 *
 * ⛔ The runs live on the CONVEYOR's n8n, not fr's default instance: reading
 * fr's own n8n would answer a confident `available:true, runs:[]`. So the flag
 * is honoured only with the instance NAMED (`FR_CONVEYOR_RUNS_N8N_URL` +
 * `FR_CONVEYOR_RUNS_N8N_API_KEY`); without it the read answers
 * `available:false, reason:'conveyor_instance_unconfigured'` and calls nothing.
 */
export async function handleListProjectConveyorExecutions(req: Request, projectId: string): Promise<Response> {
  try {
    const { user, project, projectId: pid } = await scopeOf(req, projectId);
    const source = config.services.n8n.conveyorRunTags;
    if (source !== 'custom_data') {
      return jsonResponse({ data: scrubbed(pid, {
        available: false,
        reason: CONVEYOR_RUNS_UNTAGGED,
        contract: 'fr-agui SPEC §7.4a: the conveyor tags every execution with fr_project_id + fr_tenant_id custom data',
      }) });
    }
    const instance = conveyorInstance();
    if (!instance) {
      return jsonResponse({ data: scrubbed(pid, {
        available: false,
        reason: CONVEYOR_INSTANCE_UNCONFIGURED,
        contract: 'fr-agui SPEC §7.4a: FR_CONVEYOR_RUNS_N8N_URL + FR_CONVEYOR_RUNS_N8N_API_KEY name the conveyor n8n instance',
      }) });
    }
    const tenantTag = projectCatalogueTenant(project);
    const redactInternal = !canReadProductionWorkflows(user);
    const runs: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let scanned = 0;
    let pages = 0;
    do {
      const page = await listExecutionsOn(instance, { limit: N8N_PAGE, ...(cursor ? { cursor } : {}) });
      pages++;
      for (const e of (page.data ?? []) as Execution[]) {
        scanned++;
        const cd = (e.customData ?? {}) as Record<string, unknown>;
        if (cd.fr_project_id !== pid || cd.fr_tenant_id !== tenantTag) continue;
        runs.push({
          id: String(e.id),
          workflow_id: redactInternal ? null : (e.workflowId ?? null),
          status: e.status ?? null,
          mode: e.mode ?? null,
          started_at: e.startedAt ?? null,
          stopped_at: e.stoppedAt ?? null,
          card_id: typeof cd.card_id === 'string' ? cd.card_id : null,
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages < CONVEYOR_SCAN_PAGES);
    return jsonResponse({ data: scrubbed(pid, { available: true, source, runs, scanned, truncated: Boolean(cursor) }) });
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/flow-runs — the execution-hook record (cockpit A5 / R-CK5)
// ---------------------------------------------------------------------------

const FLOW_RUNS_DEFAULT_LIMIT = 50;

/**
 * The project's conveyor flow runs as the n8n execution hook reported them
 * (`conveyor_flow_runs`, migration 213), newest started first. Rows are pinned to the
 * project AND the caller's active tenant (the TENANT PIN above). `available: false` with
 * reason 'no_flow_runs_recorded' when the hook has reported nothing for the project yet —
 * say so, never guess.
 */
export async function handleListProjectFlowRuns(req: Request, projectId: string): Promise<Response> {
  try {
    const { user, project, projectId: pid } = await scopeOf(req, projectId);
    const q = query(req);
    const limit = intParam(q, 'limit', FLOW_RUNS_DEFAULT_LIMIT, 1, FLOW_RUNS_MAX_LIMIT);
    const sinceRaw = q.get('since');
    let since: Date | null = null;
    if (sinceRaw) {
      since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) throw invalid('since must be an ISO-8601 date-time');
    }
    // Runs under the fr id are fr's own (no RM call). Most flows report under the RM pm_project id,
    // which only RM can name (fr keeps no copy): added when RM answers; RM down ⇒ the fr-id runs
    // plus `rm_unavailable: true`, never an error.
    let rmPmProjectId: string | null = null;
    let rmUnavailable = false;
    try {
      rmPmProjectId = await rmPmProjectIdOf(project);
    } catch (err) {
      rmUnavailable = true;
      reportSwallowedFailure(err, {
        service: 'requirements_management',
        method: 'GET',
        path: '/pm/projects',
        degradedTo: `flow runs of project ${pid}: only the runs stored under the fr id`,
      });
    }
    const rows = await listFlowRunsForProject(pid, { since, limit, tenantId: ctxTenantId(user.tenantId), rmPmProjectId });
    return jsonResponse({
      data: scrubbed(pid, {
        available: rows.length > 0,
        ...(rmUnavailable ? { rm_unavailable: true } : {}),
        ...(rows.length === 0 ? { reason: 'no_flow_runs_recorded' } : {}),
        runs: rows.map((r) => ({
          execution_id: r.execution_id,
          workflow_id: r.workflow_id,
          workflow_name: r.workflow_name,
          card_id: r.card_id,
          status: r.status,
          n8n_status: r.n8n_status,
          started_at: iso(r.started_at),
          stopped_at: iso(r.stopped_at),
          failed_node: r.failed_node,
          error_class: r.error_class,
          error_message: r.error_message,
          retry_of: r.retry_of,
          parent_execution_id: r.parent_execution_id,
          received_at: iso(r.received_at),
        })),
      }),
    });
  } catch (err) {
    return handleError(err);
  }
}
