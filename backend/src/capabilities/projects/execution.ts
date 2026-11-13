// fr-agui SPEC §13 P3 / §7.4 — execution observability, declared as capabilities.
//
// Six PROJECT reads over routes/project-execution.ts, agent-exposed to the
// project agent: the project comes from the thread (`/api/projects/:id`, SPEC
// §5.7 rule 3 — stripped from the model's schema and injected). The agent
// action runs the route itself as the human (agui/actions/project-execution.ts),
// so it answers exactly what the Execution hub shows. Any member of the
// project's tenant may read every one of them (the ruling: tenant-wide
// collaboration; P1-TEAM-a), narrowed later by the selection function.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, type Capability, type ResponseSpec } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { frErrorBody } from '../library/_shared';

const projectId = z.string().uuid().describe('The project id');

const RESPONSES = (extra: ResponseSpec[] = []): ResponseSpec[] => [
  { status: 401, description: "validateAuth's 401 (`error`: 'Missing or invalid Authorization header' / 'Invalid or expired token').", schema: z.object({ error: z.string() }) },
  { status: 404, description: "`error` 'Project not found': absent, not readable by the caller (another tenant's), or not a uuid — one answer.", schema: frErrorBody },
  ...extra,
  {
    status: 'default',
    description:
      "403: validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden'). 422: `code` 'invalid_input' " +
      "(a bad query parameter). 409: `code` 'project_tenant_unknown' / 'rm_project_missing' where the read needs the project's RM " +
      'or tenant tag. Any other status is an upstream\'s, relayed, or fr\'s own 500.',
    schema: frErrorBody,
  },
];

interface ExecRead {
  id: `${string}.${string}`;
  path: string;
  handler: string;
  readExport: string;
  summary: string;
  description: string;
  query: z.ZodRawShape;
  output: z.ZodTypeAny;
  tier: 'core' | 'searchable';
}

const bound = z.object({ project_id: z.string().uuid().describe('The bound project — every answer carries it') });

const EXEC_READS: ExecRead[] = [
  {
    id: 'projects.list_executions',
    path: '/api/projects/:id/executions',
    handler: 'handleListProjectExecutions',
    readExport: 'listExecutionsRead',
    summary: "Every fr-initiated workflow run of this project — all members' runs (newest first)",
    description:
      "All n8n runs fr started for this project, by ANY member of the project's tenant (n8n.list_executions serves only your own). " +
      'Each run: id, status (from n8n; null with `status_source` when n8n cannot answer), started/stopped, how it was started, ' +
      "and who started it (a display name; `initiated_by_me`). `since` (ISO date-time) answers e.g. \"what ran today\".",
    query: {
      since: z.string().optional().describe('Only runs fr started at or after this ISO-8601 date-time (e.g. the start of today).'),
      limit: z.number().int().min(1).max(25).optional().describe('Page size, 1..25 (default 20): each row is one n8n read.'),
      cursor: z.string().optional().describe("The previous page's meta.cursor."),
    },
    output: bound.extend({
      scope: z.literal('all_members'),
      runs: z.array(z.record(z.unknown())),
      meta: z.object({ cursor: z.string().nullable(), hasMore: z.boolean() }),
    }),
    tier: 'core',
  },
  {
    id: 'projects.get_wip',
    path: '/api/projects/:id/wip',
    handler: 'handleGetProjectWip',
    readExport: 'getWipRead',
    summary: "This project's WIP limit (requirements_management) and its board count — read-only, n8n enforces",
    description:
      "How close the project is to its WIP limit. `limit` is requirements_management's (the project's own, else the tenant catalogue's " +
      "for its type — `source` / `label` say which). `board_count` is the number of cards in DOING on the Planka board — a board count, " +
      "NOT n8n's enforced count. `headroom` = limit − board count. Read-only: n8n enforces WIP.",
    query: {},
    output: bound.extend({ limit: z.record(z.unknown()), board_count: z.record(z.unknown()), headroom: z.number().nullable(), enforced_by: z.literal('n8n') }),
    tier: 'core',
  },
  {
    id: 'projects.list_blocked_cards',
    path: '/api/projects/:id/blocked-cards',
    handler: 'handleListProjectBlockedCards',
    readExport: 'listBlockedCardsRead',
    summary: "This project's BLOCKED cards, each with its block reason and open escalation gate",
    description:
      "The cards in the board's BLOCKED lane. Each: id, name, since when, `block_reason` (what the conveyor wrote; null when the card " +
      'carries none — never invented) and `escalation` (the pending approval holding the card, if any, with its link). Use it to answer "why is card X blocked".',
    query: {},
    output: bound.extend({ available: z.boolean(), cards: z.array(z.record(z.unknown())) }).passthrough(),
    tier: 'core',
  },
  {
    id: 'projects.list_agent_actions',
    path: '/api/projects/:id/agent-actions',
    handler: 'handleListProjectAgentActions',
    readExport: 'listAgentActionsRead',
    summary: "The project's agent activity: who, which capability, the outcome, when (never the inputs)",
    description:
      "capability_audit rows of this project, any member's: actor (a display name), capability, outcome ('proposed' / 'executed' / " +
      "'unmatched' with the HTTP status), time. Never the inputs, a thread or a proposal id.",
    query: { limit: z.number().int().min(1).max(100).optional().describe('Rows, newest first (default 50, max 100).') },
    output: bound.extend({ actions: z.array(z.record(z.unknown())) }),
    tier: 'searchable',
  },
  {
    id: 'projects.list_cards_by_type',
    path: '/api/projects/:id/cards-by-type',
    handler: 'handleListProjectCardsByType',
    readExport: 'listCardsByTypeRead',
    summary: "The board's cards of one card type (e.g. coach cards) — card types of this project's type only",
    description:
      "The board's cards whose card_type is `card_type`. The type must be one requirements_management places in this project's type; " +
      "an unknown one (e.g. `coach`, until the conveyor defines it) answers `[]` with reason 'card_type_unknown' — never an invented list.",
    query: { card_type: z.string().regex(/^[a-z0-9][a-z0-9_]{0,99}$/).describe('A card type name, e.g. coach.') },
    output: bound.extend({ card_type: z.string(), known: z.boolean(), cards: z.array(z.record(z.unknown())) }).passthrough(),
    tier: 'searchable',
  },
  {
    id: 'projects.list_conveyor_executions',
    path: '/api/projects/:id/conveyor-executions',
    handler: 'handleListProjectConveyorExecutions',
    readExport: 'listConveyorExecutionsRead',
    summary: "The conveyor v4 runs of this project (§7.4a tagging) — unavailable until the conveyor tags its runs",
    description:
      "Conveyor (n8n) executions tagged with this project's fr_project_id and tenant. Until the conveyor sets those tags it answers " +
      "available:false, reason 'conveyor_runs_untagged' (or 'conveyor_instance_unconfigured' while the conveyor's n8n instance is not named): " +
      "say so, never guess which runs are this project's.",
    query: {},
    output: bound.extend({ available: z.boolean() }).passthrough(),
    tier: 'searchable',
  },
  {
    // R311 PR 5 (kanban-coach-errors.md §2.5 / §4.1): the conveyor's failure notices and the start retry offer.
    // Served by routes/project-conveyor-start.ts (re-exported from routes/project-execution.ts).
    id: 'projects.list_conveyor_notices',
    path: '/api/projects/:id/conveyor-notices',
    handler: 'handleListProjectConveyorNotices',
    readExport: 'listConveyorNoticesRead',
    summary: "What the conveyor reported went wrong for this project (start failed, coach could not act) and whether a start retry is offered",
    description:
      "The `project.start_failed` notices (the conveyor accepted the start but failed after it) and the `project.coach_failed` notices " +
      "(the kanban coach could neither act nor comment on a card, so a person must move or re-run it), newest first, with fr's recorded " +
      "conveyor start attempts. `retry.available` says whether a member may retry the start now and why (`reason`); retrying is the " +
      "user's choice — offer it with projects.retry_conveyor_start, never decide it. `reason` 'refused_by_conveyor' = the conveyor " +
      "declined the start (`retry.code`) and will decline a retry too: show the user `retry.message` as written, and offer no retry. " +
      "`reason` 'no_progress' (R319) = the start was accepted 10+ minutes ago but the project's start card is still waiting on its " +
      "board: offer \"Start again\" (the same retry). 'stalled' (R320) = the start card has sat in READY or DOING with no change for " +
      "30+ minutes: offer \"Start again\" too. 'restart_not_done' = a \"Start again\" of a stalled project was not carried out: tell " +
      "the user `retry.message` as written. 'on_hold' = the same, but the project is on hold, so nothing is offered until " +
      "it is released. fr only reports what the conveyor sent and what the project's board shows. " +
      "`restart` (George 2026-10-31) = whether the project may be RESTARTED — the whole project, or one phase: `restart.phase` is " +
      "the current requirements_management phase (null = unknown, so only a project restart) and `restart.phases` the phases that " +
      "may be restarted (the current one and earlier, in order; each `{name, title, default_comment}` — `default_comment` is the " +
      "comment given when that phase's start was signed off, to offer as the restart's steering comment): every card in " +
      "that scope runs again, finished ones included, and the conveyor\'s open questions on this project, plus open requests about its cards, are withdrawn. Offered for every active, " +
      "undelivered project; propose it with projects.retry_conveyor_start and `scope` when the user wants to start over, never on your own.",
    query: {},
    output: bound.extend({
      retry: z.object({ available: z.boolean(), reason: z.string() }).passthrough(),
      restart: z
        .object({
          available: z.boolean(),
          phase: z.string().nullable(),
          phases: z.array(z.object({ name: z.string(), title: z.string(), default_comment: z.string().nullable() })),
        })
        .passthrough(),
      notices: z.array(z.record(z.unknown())),
      attempts: z.array(z.record(z.unknown())),
    }),
    tier: 'core',
  },
  {
    // Cockpit A5 / R-CK5 (migration 213): the n8n execution-hook record. Served by routes/project-execution.ts.
    id: 'projects.list_flow_runs',
    path: '/api/projects/:id/flow-runs',
    handler: 'handleListProjectFlowRuns',
    readExport: 'listFlowRunsRead',
    summary: "The conveyor flow runs of this project as n8n's execution hook reported them (status, failed node, error)",
    description:
      "One row per n8n execution of this project's conveyor flows, newest started first: workflow, card, status " +
      "(running / waiting / success / error / canceled / crashed), start and stop, the failed node and error class/message. " +
      "available:false, reason 'no_flow_runs_recorded' when the hook has reported nothing for the project yet: say so, never guess. " +
      "Runs stored under the fr project id are always listed (fr's own data); runs the hook reported under the RM pm_project id are " +
      "added when requirements_management answers. `rm_unavailable: true` when RM could not be read: the list then holds only the " +
      'fr-id runs and may be incomplete.',
    query: {
      since: z.string().optional().describe('Only runs started at or after this ISO-8601 date-time.'),
      limit: z.number().int().min(1).max(200).optional().describe('Rows, newest first (default 50, max 200).'),
    },
    output: bound
      .extend({ available: z.boolean(), rm_unavailable: z.boolean().optional(), runs: z.array(z.record(z.unknown())) })
      .passthrough(),
    tier: 'searchable',
  },
];

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** The exact path → reader table (exported for the agent actions and the tests). */
export const EXECUTION_READ_TABLE: ReadonlyArray<Pick<ExecRead, 'id' | 'path' | 'handler' | 'readExport' | 'tier'> & { query: string[] }> =
  EXEC_READS.map((r) => ({ id: r.id, path: r.path, handler: r.handler, readExport: r.readExport, tier: r.tier, query: Object.keys(r.query) }));

export const PROJECT_EXECUTION_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = EXEC_READS.map((r) =>
  defineCapability({
    id: r.id,
    area: 'projects',
    summary: r.summary,
    description: `${r.description} Any member of the project's tenant may read it (P1-TEAM-a).`,
    http: { method: 'GET', path: r.path, operationId: camel(r.id) },
    input: z.object({ id: projectId, ...r.query }),
    // The route's envelope is `{ data }` (a read model); the agent action returns `data`.
    output: z.object({ data: r.output }),
    errors: [],
    // The route's gate is validateAuth + loadProjectForRead; the agent's is the
    // bound project's membership AND the route itself, run as the human.
    auth: { principal: 'user', rbac: { type: 'project-member' } },
    tenancy: 'project',
    effect: 'read',
    confirm: 'none',
    agent: {
      expose: true,
      tier: r.tier,
      cronSafe: false,
      idempotencyKey: (i: unknown) => `${r.id}:${JSON.stringify(i ?? {})}`,
    },
    openapi: { tags: ['Projects'], responses: RESPONSES() },
    handler: lazyActionHandler(() => import('../../agui/actions/project-execution'), {
      module: 'src/agui/actions/project-execution.ts',
      exportName: r.readExport,
    }),
    legacyHandler: lazyHandler(() => import('../../routes/project-execution'), {
      module: 'src/routes/project-execution.ts',
      exportName: r.handler,
    }),
  }),
);
