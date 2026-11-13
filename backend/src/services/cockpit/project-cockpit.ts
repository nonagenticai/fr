// src/services/cockpit/project-cockpit.ts
//
// Project cockpit read model v2 (GET /api/projects/:id/cockpit) — R-CK8 of
// FR-COCKPIT-IMPL-PLAN-2026-10-25.
//
// ONE call for the whole project page. Every source is read IN PARALLEL with its own timeout and a
// last-known cache (`./panel.ts`), and every panel is the envelope
//   { data, as_of, health: ok | degraded | down, down_since?, detail_code? }
// so one slow or dead upstream degrades its own panel and nothing else, and no raw upstream error
// reaches the page (detail_code is a short code shown only behind "Details").
//
// Folded in (the browser used to make each as its own call): the repository set, the PM's
// capability selection, the conveyor history (conversation, cards, delivered PRs), the conveyor
// reports and the approval fields the "needs you" widget used to hydrate with a second
// approvals.list call. `?scope=header` returns only the project + status panels, for the shell
// header on every project page.
//
// ⛔ improvement-loop is NOT a source (F4, George 2026-10-25: it is future functionality, replicas
// 0). The cell-run block and the tenant quality-verdict block are gone, not degraded. Flow runs
// come from `conveyor_flow_runs` (A5, the n8n execution hook).
//
// Everything here is PROJECT-SCOPED, and every cached value is keyed on tenant + project.

import { block, availableBlock, unavailableBlock, type Block } from '../read-models/_lib';
import { db, n8nExecutionMapping } from '../../db/client';
import {
  approvals,
  requiredApprovers,
  approvalDecisions,
  cardSeekerLinks,
  assetBindings,
  projectDeliverables,
  projectMilestones,
  projectReports,
  type ConveyorFlowRunRow,
} from '../../db/schema';
import { and, eq, ne, asc, desc, inArray } from 'drizzle-orm';
import { isPhaseOf, nextGate, railNodes, type PhaseSpec, type RailNode } from '../../lib/project-phase';
import {
  capabilitiesOfState,
  phasesOfState,
  projectTypeAndPhase,
  rmPmProjectIdOf,
  RM_PROJECT_MISSING,
  type RmProjectState,
} from '../catalogue/project-state';
import { cardTypeCapabilityMap } from '../catalogue/tenant-catalogue';
import { plankaClient } from '../../services/planka';
import type { BoardDetail, Card } from '../../services/planka/types';
import { getExecution } from '../../integrations/n8n';
import { listGraphExecutionSessions } from '../../integrations/workers';
import type { GraphExecutionSession } from '../../integrations/workers';
import {
  getProjectCost,
  getProjectCosts,
  getTenantUsageCrossBreakdown,
  type UpstreamProjectCosts,
} from '../../integrations/metering/usage';
import { listPmProjectPhaseEvents } from '../../integrations/pm';
import { fundingTotals, MAX_WINDOW_DAYS, type CostLens, type FundingTotal } from '../../lib/usage-funding';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { fetchTenantMarkupPct } from '../../routes/me/usage';
import { applyMarkup } from '../../lib/money';
import { tryGetRequestContext } from '../../integrations/_lib/context';
import { classifyProjectOwnership, projectKcTenantTag } from '../../lib/project-owner-guard';
import { listArtifacts } from '../../integrations/artifacts';
import type { ArtifactOut } from '../../integrations/artifacts';
import { loadProjectRepositories } from '../project-repositories';
import { findHumanOverrideCardIds } from '../computed-checks';
import { isDoneEquivalentListName } from '../../lib/done-equivalent';
import { loadPlanForRail, planNextGate, planRailNodes } from '../../lib/plan-phase-exit';
import type { PhasePlan } from '../../lib/phase-plan';
import { phaseFromListName, isBlocked as isBlockedListName } from '../../lib/phase';
import { statedOpenQuestions } from '../../domain/engagement/deblock-actions';
import { readProjectAndon, type ProjectAndonView } from '../project-andon';
import { listFlowRunsForProject } from '../conveyor-flow-runs';
import {
  buildConveyorHistory,
  askQuestion,
  stripAskPrefix,
  type CardsPayload,
  type ConversationEntry,
  type DeliveredPayload,
} from '../conveyor-history/history';
import type { PmProjectCapabilityEventOut } from '../../integrations/pm';
import type {
  ProjectRepositorySet,
} from '../project-repositories';
import type { projects } from '../../db/schema';
import {
  detailCodeOf,
  fetchPanel,
  okPanel,
  naPanel,
  downPanel,
  degradedPanel,
  worstHealth,
  type Panel,
  type PanelHealth,
} from './panel';
import {
  CLOSURE_PHASE,
  composeDecisionLog,
  composeSpine,
  exactCardPhase,
  withClosure,
  type BoardCardIn,
  type CockpitDecision,
  type CockpitSpine,
  type PhaseEventIn,
} from './spine';
import { deliveryFromRm } from '../project-delivered';
import { artifactCardId, composeOverview, type ProjectOverview } from './overview';
import { documentLabels, fallbackTitle, type DocumentLabel, type TrailArtifact } from './document-trail';
import { composeBoard, type BoardCard, type BoardIn, type ProjectBoard } from './board';
import {
  deriveCockpitState,
  unresolvedFlowFailures,
  type CockpitState,
  type CockpitStateReason,
} from './cockpit-status';

type Project = typeof projects.$inferSelect;

/** The project's conveyor flow runs stored under its fr id, tenant-pinned, newest first (fr only). */
function listFlowRuns(projectId: string, tenantId: string, rmPmProjectId?: string): Promise<ConveyorFlowRunRow[]> {
  return listFlowRunsForProject(projectId, { tenantId, limit: FLOW_RUNS_LIMIT, rmPmProjectId });
}

/**
 * The flows panel: the fr-id runs (fr's own data, no RM call), plus the runs the hook reported under
 * the project's RM pm_project id once the rm panel has that id (a live or last-known RM answer; an RM
 * id never changes). RM unreadable ⇒ the fr-id runs, `degraded` with `rm_unavailable` — the gap is
 * RM's, never fr_db's. RM holding no pm_project ⇒ the fr-id runs as they are.
 */
export async function withRmRefRuns(
  frRuns: Panel<ConveyorFlowRunRow[]>,
  rm: Panel<RmProjectState>,
  projectId: string,
  tenantId: string,
): Promise<Panel<ConveyorFlowRunRow[]>> {
  if (frRuns.data === null) return frRuns;
  if (rm.data) {
    try {
      const all = await listFlowRuns(projectId, tenantId, rm.data.rmPmProjectId);
      return rm.health === 'ok' ? { ...frRuns, data: all } : degradedPanel(all, 'rm_unavailable', frRuns.as_of ?? new Date());
    } catch (err) {
      reportSwallowedFailure(err, { service: 'fr_db', degradedTo: `cockpit flows of ${projectId}: RM-ref runs not added` });
      return degradedPanel(frRuns.data, 'fr_db_rm_ref_runs', frRuns.as_of ?? new Date());
    }
  }
  if (!conveyorLinkedOf(rm)) return frRuns;
  return degradedPanel(frRuns.data, 'rm_unavailable', frRuns.as_of ?? new Date());
}

/** The rm panel's detail_code when RM holds no pm_project for the project. */
const RM_STATE_MISSING_CODE = detailCodeOf('rm', { code: RM_PROJECT_MISSING });

/**
 * Is the project run by the conveyor? RM's answer: false only when RM says it holds no pm_project
 * for it. An unreadable RM leaves it linked (its panels then read degraded / down, never "not a
 * conveyor project").
 */
function conveyorLinkedOf(rm: Panel<RmProjectState>): boolean {
  return rm.data !== null || rm.detail_code !== RM_STATE_MISSING_CODE;
}

/** The pm_project's RM phase events. */
function listPhaseEvents(state: RmProjectState): Promise<PhaseEventIn[]> {
  return listPmProjectPhaseEvents(state.tenantId, state.rmPmProjectId, { limit: PHASE_EVENTS_LIMIT, offset: 0 }) as Promise<
    PhaseEventIn[]
  >;
}

/** RM phase events read per project (a project moves phase a handful of times; 100 is ample). */
const PHASE_EVENTS_LIMIT = 100;

/** How many of fr's stored reports the cockpit lists (the Reports panel; the rest are on /reports). */
const STORED_REPORTS_LIMIT = 10;

/** fr's own stored reports (`project_reports`) for the project, tenant-pinned (migration 080), newest first. */
async function loadStoredReports(projectId: string, tenantId: string): Promise<StoredReport[]> {
  const rows = await db
    .select()
    .from(projectReports)
    .where(and(eq(projectReports.project_id, projectId), eq(projectReports.tenant_id, tenantId)))
    .orderBy(desc(projectReports.created_at))
    .limit(STORED_REPORTS_LIMIT);
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  })) as unknown as StoredReport[];
}

/** Per-source timeouts (ms). A source past its timeout serves its last known value. */
const DEFAULT_TIMEOUTS = {
  frDb: 4000,
  planka: 5000,
  rm: 5000,
  // R6: the card-type → capability names are a NICE-TO-HAVE annotation on the cost panel; a slow
  // catalogue must not hold the whole cockpit read, so it gets a shorter ceiling than RM itself.
  catalogue: 2500,
  artifacts: 4000,
  billing: 5000,
  n8n: 3000,
  workers: 3000,
  history: 8000,
} as const;
type CockpitTimeouts = { [K in keyof typeof DEFAULT_TIMEOUTS]: number };
const COCKPIT_TIMEOUTS: CockpitTimeouts = { ...DEFAULT_TIMEOUTS };

/** How long a slow-changing, expensive source is served from cache without asking. */
const COCKPIT_FRESH_FOR = { capabilities: 30_000, history: 60_000 } as const;

export const FLOW_RUNS_LIMIT = 200;

// ---------------------------------------------------------------------------
// Payload types (mirrored block-by-block on the frontend in Session 3)
// ---------------------------------------------------------------------------

export type Phase = 'READYING' | 'DOING' | 'INSPECTING' | 'PUBLISHING' | 'BLOCKED' | 'OTHER';

export interface PhaseColumn {
  phase: Phase;
  list_name: string | null;
  count: number;
  /** true when this is the phase with the most in-flight (DOING/INSPECTING) cards. */
  active: boolean;
  /** ms since the oldest card entered this list (null when empty). */
  oldest_card_age_ms: number | null;
}

export interface CockpitCard {
  id: string;
  name: string;
  phase: Phase;
  list_name: string | null;
  labels: string[];
  age_in_phase_ms: number | null;
  updated_at: string | null;
  blocked: boolean;
  blocked_reason: string | null;
}

export interface CockpitApproval {
  id: string;
  kind: string;
  status: string;
  description: string;
  card_id: string | null;
  created_at: string | null;
  expires_at: string | null;
  /**
   * The approval's `metadata` jsonb, VERBATIM and NULLABLE.
   *
   * ⭐ WHY IT IS ON THE READ-MODEL AND NOT FETCHED BY THE WIDGET. `metadata` is
   * where a row's gate lives (`gate_terms`, `deblock_action`, `callback_path`),
   * so without it the "Needs you" widget structurally could not tell a question
   * from a broken gate and had to hydrate each row with a second API call. That
   * call is a round-trip and a failure mode per row, for a column this query
   * already reads — `loadApprovals` selects the whole `approvals` row and then
   * dropped this field on the floor.
   *
   * ⚠️ NULL IS A REAL VALUE HERE, not "not loaded". The column is nullable and
   * plenty of rows carry no metadata at all, so a reader must treat `null` as
   * "this row has no gate recorded" and never as "fetch it from somewhere else".
   */
  metadata: Record<string, unknown> | null;
  required_approvers: { user_id: string; role: string | null }[];
  decisions: {
    approver_id: string;
    decision: string;
    comment: string | null;
    decided_at: string | null;
    /** A5 / R-CK1: a person, the approval-triage agent, or fr policy code. */
    decided_by_kind: 'human' | 'triage_agent' | 'rule' | 'agent';
  }[];
  // ── The fields the "needs you" widget used to hydrate with a second approvals.list call ──
  /** The approval's tenant (the decide rule's tenant-member arm compares it to the caller's). */
  tenant_id: string;
  /** 'web' | 'n8n' — a conveyor-raised row's requester is the system. */
  source: string | null;
  requester_id: string | null;
  action_id: string | null;
  change_summary: string | null;
  impact_analysis: string | null;
}

export interface CurrentExecution {
  execution_id: string;
  workflow_id: string;
  correlation_id: string;
  status: string;
  started_at: string | null;
  triggered_at: string | null;
}

export type TimelineEventType =
  | 'phase_transition'
  | 'asset_fetch'
  | 'worker_inference'
  | 'typed_action'
  | 'qa_verdict'
  | 'decision_write'
  | 'kag_write';

export interface TimelinePill {
  label: string;
  tone: 'success' | 'warn' | 'danger' | 'neutral';
}

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  at: string;
  title: string;
  card_id: string | null;
  execution_id: string | null;
  correlation_id: string | null;
  status: string | null;
  pills: TimelinePill[];
}

export interface AssetUsage {
  /** distinct KAG entities linked to this project's cards (cardSeekerLinks). */
  kag_memory_links: number;
  cards_with_links: number;
  per_card: { card_id: string; link_count: number }[];
  /**
   * Count of governance assets bound to this project, per kind (asset_bindings).
   * A 0 is a real "none bound" answer, not a data gap. KAG keeps its richer
   * per-card link metric above; there is no per-card link table for these kinds.
   */
  bound_by_kind: {
    principle: number;
    requirement: number;
    decision: number;
  };
}

export interface CockpitGoal {
  /** null ⇒ the phase rail could not be read. NEVER 0-as-unknown. */
  cards_total: number | null;
  /** null ⇒ the phase rail could not be read. NEVER 0-as-unknown. */
  cards_published: number | null;
  /** null ⇒ the phase rail could not be read. NEVER 0-as-unknown. */
  coverage_pct: number | null;
  open_gates: number;
}

/**
 * A customer-review-relevant artifact for this project. Mirrors the fields the
 * "Needs you" queue needs — id/filename/kind/status + when it landed — so the
 * queue reads its review list off the cockpit read model instead of stitching a
 * separate `/api/assets/artifacts` call client-side (design-contract: the
 * frontend should not assemble a cockpit from many small calls).
 */
export interface CockpitArtifact {
  id: string;
  filename: string;
  kind: string;
  project_id: string;
  created_at: string;
  status: 'pending' | 'needs_revision';
}

/**
 * A report the CONVEYOR stored for this project (G5). The conveyor writes each
 * card's final report to the artifacts service as `report.json`, keyed on the fr
 * project id — never to fr's `project_reports` (the phase-gate reports fr itself
 * writes). Read-only: fr shows them with the artifact's own review status.
 */
export interface CockpitReport {
  id: string;
  filename: string;
  /** The Planka card the report belongs to, when the artifact names one on this board. */
  card_id: string | null;
  card_name: string | null;
  step: string | null;
  /**
   * The artifact's REVIEW status (e.g. `pending` = nobody has reviewed it). NOT
   * readiness: every conveyor report is `pending` — `publish_status` says ready.
   */
  status: string | null;
  /** artifact_service publish state: `published` (the conveyor released it) or `draft`; null = not served. */
  publish_status: 'draft' | 'published' | null;
  /** The newest PUBLISHED report — the project's final report. At most one row is true. */
  is_final: boolean;
  created_at: string;
}

/** The filename the conveyor's flows upload a card's final report under. */
export const CONVEYOR_REPORT_FILENAME = 'report.json';

// ── The MACRO project lifecycle rail (migration 081 + lib/project-phase.ts) ───
//
// Distinct from `phase_rail` above, which is the MICRO board-mantra axis
// (READYING · DOING · INSPECTING · PUBLISHING) derived from Planka list names.
// This one is the project's own lifecycle: the ordered phases of its RM project
// type (or its plan's phases), projected by the SAME `railNodes`/`nextGate`
// that `GET /api/projects/:id/phase` uses — one projection, two surfaces.

export interface LifecycleRail {
  /** RM's current phase; null = NOT STARTED (n8n has not set the first phase): every node pending. */
  phase: string | null;
  /**
   * When the phase was last stamped. NULLABLE even on an AVAILABLE block: a
   * phase past `request` with no stamp means something advanced the column
   * without recording when, which is a real (if odd) state and is reported as
   * itself rather than back-filled with a fabricated time.
   */
  phase_updated_at: string | null;
  next_gate: string | null;
  nodes: RailNode[];
  /**
   * fr#1482: the plan this rail was projected from — `{template_id,
   * template_hash}` for a PLAN project (nodes = the plan's phases only), null
   * for a legacy project (nodes = its RM project type's phases). Additive.
   */
  plan: { template_id: string; template_hash: string } | null;
}

// ── The APPROVED SCOPE (migration 127) ───────────────────────────────────────
//
// ⚠️ `acceptance_criteria` IS APPROVED INTENT, NOT EVIDENCE OF COMPLETION, and a
// reader of this block must not present it as one. Nothing in this estate
// validates a criterion against an artefact: as of 2026-09-23 `artifacts.card_id`
// was NULL on all 58,573 rows. The migration header and the schema comment both
// say this; it is repeated here because THIS is the type a UI component imports,
// and the component is where the checkmark would otherwise get added.

export interface ProjectDeliverable {
  id: string;
  position: number;
  /** CLOSED vocabulary — the DB CHECK admits only these two. */
  kind: 'deliverable' | 'intermediate';
  title: string;
  description: string | null;
  /** Ordered free text. `[]` is a real "none recorded", never a missing read. */
  acceptance_criteria: string[];
}

export interface ProjectMilestone {
  position: number;
  name: string;
  /** NULLABLE by design: an agreed ordering need not commit to dates. */
  target_date: string | null;
}

/**
 * The effort figure a human APPROVED on the outline. ⚠️ NOT tracked effort —
 * nothing in fr measures effort spent, and the UI label must say so.
 */
export interface ApprovedEffortEstimate {
  value: number;
  unit: string;
  note?: string;
}

/** The rows the approved-scope read returns (the project column is added later). */
interface ApprovedScopeRows {
  deliverables: ProjectDeliverable[];
  milestones: ProjectMilestone[];
}

export interface ApprovedScope extends ApprovedScopeRows {
  approved_effort_estimate: ApprovedEffortEstimate | null;
}

// ── Per-project LLM cost to date ─────────────────────────────────────────────
//
// DISPLAY ONLY — no budget field, no budget logic (operator decision
// 2026-09-22). Sourced from billing via `integrations/metering/usage.ts
// getProjectCost`.
//
// ⚠️ CORRECTED 2026-09-23: this said "the same read `GET /api/projects/:id/cost`
// uses", in the PRESENT tense. That route no longer exists — it was DELETED,
// because it was a second, independent backend computation of the number this
// block already produces, with zero frontend callers. Two paths to one figure is
// how the renamed-amount defect below was born in the first place.
// `buildProjectCostBlock` is now the ONLY path. Grep `project-cost` under
// `backend/src` to disprove this line; it returns nothing but prose.
//
// ⛔ DO NOT NAME THE RETIRED FIELD IN THIS FILE, not even in prose.
// `tests/unit/project-cost-rename-guard.test.ts` greps the whole tree for that
// identifier and fails on ANY occurrence, source or comment — and it builds the
// token via `['total','usd'].join('_')` precisely so the guard file itself does
// not trip its own check. The first draft of THIS comment named the field to
// explain why it was retired, and reded the guard in CI. A comment must not
// impersonate the thing it describes.
//
// ⛔ THE AMOUNT FIELD THIS REPLACES WAS NAMED AS A TOTAL AND WAS NOT ONE.
// Billing only ever knew the spend that arrived WITH this project's id on the
// cost event, and `lib/project-owner-guard.ts` emits that id ONLY when
// `projects.project_data->>'keycloak_tenant_id'` is present AND matches the
// caller's active tenant. For every other project the id was structurally never
// emitted — so billing holds no row that could name it, and its zero means
// UNKNOWN. `$0.00` therefore rendered identically for "spent nothing" and "every
// call for this project was emitted unattributed". The old `coverage_note` warned
// about this in prose but carried no measurement, so it could not move a render.
//
// The fix is structural, not cosmetic: an unattributable project produces NO
// DATA AT ALL (`unavailableBlock(…, 'data_gap')`), so no consumer — not just the
// panel — can format a dollar figure out of it.

export type ProjectCostCoverage = 'attributed' | 'unattributable';

export interface ProjectCost {
  /**
   * Dollars billing ATTRIBUTED to this project over [from, to]. Never a "total":
   * it is a floor on real spend, and the only spend it can ever see is the spend
   * that carried this project's id.
   */
  attributed_usd: number | null;
  /**
   * What `attributed_usd` is. `'incurred'` (fr's pre-markup provider cost) is
   * for a super-admin ONLY; everyone else gets `'billed'` (incurred × the
   * tenant's markup, the figure /settings/usage and /admin/billing show), or
   * `'unavailable'` with `attributed_usd: null` when the markup cannot be
   * established — never the incurred figure under a billed label.
   */
  cost_basis: 'incurred' | 'billed' | 'unavailable';
  /** LLM calls billing attributed to this project over the same window. */
  attributed_request_count: number;
  /** Input (prompt) tokens billing attributed to this project over the same window. */
  input_tokens: number;
  /** Output (completion) tokens billing attributed to this project over the same window. */
  output_tokens: number;
  /**
   * ⚠️ The LAST DAY the figures above actually cover (YYYY-MM-DD, UTC), or null
   * when no completed day falls in the window yet. Billing's per-project read
   * (`GET /api/costs/tenant/{id}` → `billing_cost_daily`) is rolled up per
   * COMPLETED UTC day only, so today's spend is invisible until the day closes —
   * a project created today reads zero all day while it is spending. The panel
   * must say "through <this day>", and must never render a zero for a null here.
   * Billing exposes no per-project intraday read (checked 2026-10-25:
   * `/costs/by-correlation` reads raw events but by correlation id, which the
   * conveyor's inference events do not carry; `/export/billing.csv` is
   * tenant-wide), so fr cannot fill the gap without a billing change.
   */
  rolled_up_through: string | null;
  /**
   * Who paid, summarised from `funding` for the cost-basis line: a single
   * funding value when every event in the split has it (e.g. `local_gpu` = fr's
   * own GPU, an internal transfer — no provider bill), `mixed`, or null when the
   * split is unavailable or empty.
   */
  funding_kind: string | null;
  /** Inclusive first day (YYYY-MM-DD, UTC) — the project's creation day. */
  from: string;
  /** Inclusive last day (YYYY-MM-DD, UTC). */
  to: string;
  /** When billing was asked. */
  as_of: string;
  /**
   * ⚠️ EVERY AVAILABLE BLOCK THIS AGGREGATOR EMITS CARRIES 'attributed', by
   * construction: an unattributable project resolves UNAVAILABLE below, so there
   * is no `data` to put a second value in. The field ships anyway and the panel
   * branches on it FIRST — it is a REFUSAL, not a metric. If a future edit makes
   * the unattributable path available-with-zeros (the exact regression this block
   * exists to prevent), `coverage` is what still stops the `$0.00` from
   * rendering. ⛔ Do not delete it as "single-valued in production"; that is the
   * property that makes it a guard rather than a measurement.
   */
  coverage: ProjectCostCoverage;
  /**
   * Who paid for this project's usage — local GPU / platform-paid external /
   * tenant BYO (/ unknown) — from billing's cross rollup, through the same cost
   * lens as `attributed_usd` (BYO never marked up). Its window is at most the
   * last 92 days (billing's cap) and complete UTC days only, so it need not sum
   * to `attributed_usd`; `from`/`to` say what it covers. `null` when billing's
   * breakdown could not be read — the amount above still stands.
   */
  funding: ProjectFundingSplit | null;
}

export interface ProjectFundingSplit {
  from: string;
  to: string;
  by_funding: FundingTotal[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  /** Set only when status = 'delivered' (migration 173): RM's updated_at on the closed pm_project, derived per read and stored by the reconcile worker; stored rows keep theirs (older rows: the hunt PR's proof). */
  delivered_at: string | null;
  /** What delivered the project: {source:'rm_project_closed', rm_pm_project_id, phase} (services/project-delivered.ts); older bug-hunt rows {computed_check_id, evidence_sha, outcome, hunt_card_id, pr:{number, head_sha, url}}. */
  delivery_evidence: Record<string, unknown> | null;
  /** RM's current phase (RM owns it; n8n writes it). null = not started, or unreadable — see the reason. */
  project_phase: string | null;
  /** RM's project type (name in the tenant catalogue), or null. */
  project_type: string | null;
  /**
   * RM's lifecycle status of the project (`closed` once the PM closes it). The phase
   * stays the last phase on closure; fr's `status` reads 'delivered' while RM says closed
   * (derived per read and stored by the reconcile worker, services/project-delivered.ts), except a `failed` row, which only
   * this field shows as closed. null when RM is unreadable.
   */
  rm_status: string | null;
  // When RM's state could not be read the phase/type/status above are UNKNOWN (null), and the
  // `project` panel is `degraded` with the reason in its detail_code — never a raw message here.
  shape: string;
  planka_board_id: string | null;
  n8n_project_id: string | null;
  /**
   * The DENORMALISED primary repo url (`projects.repository_url`). NULL = the
   * project has no repository (migration 190: optional) — render nothing.
   *
   * ⛔ KEPT DELIBERATELY, and additive is the whole point of this change. Every
   * existing consumer destructures this scalar, and it stays meaningful: it is
   * the primary repository, which for a 1-repo project is the only one and for
   * an N-repo project is still the one `POST /api/projects` and the
   * promote-to-primary lane re-stamp. What was WRONG before was not that this
   * field existed, it was that it was the ONLY thing here — repos 2..N had no
   * representation at all, so a 3-repo project and a 1-repo project rendered
   * identically. `repositories` below is the fix; removing this scalar would be
   * a second, unrelated break.
   */
  repository_url: string | null;
  /**
   * `projects.coordination_mode` (migration 143) — 'coordinated' (one unit of
   * work across every repo) or 'independent' (each repo moves on its own).
   *
   * Read off the project row this function was handed, so it is as available as
   * the row itself and can never be the reason this block degrades. It ships
   * BESIDE `repositories` because the list alone does not say how the repos are
   * worked, and a consumer rendering N repos without the mode has to guess.
   */
  coordination_mode: string;
  // The FULL repository set is its own panel (`repositories`): a failed join-table read is then
  // that panel's `down`, never an empty list on an available summary.
  /**
   * True unless RM answers that it holds no pm_project for the project (origin_project_id), i.e. it
   * is run by the conveyor. The project page mounts the conveyor-history panel only then.
   */
  conveyor_linked: boolean;
  /**
   * R6 / R-CK3 (FR-COCKPIT-IMPL-PLAN §2): RM's `Project.budget` — the line the Cost page draws,
   * REPORTING ONLY (nothing in fr enforces it; enforcement belongs to billing's tenant budgets).
   * null = the project has no budget set, and a null budget is NEVER rendered as $0.
   *
   * Read off `rmState.pm`, which the cockpit already holds for the phase/type/status above — no
   * extra RM call. Unknown when RM is unreadable, exactly like the fields above.
   */
  budget: number | null;
  /**
   * R6: whether the RM state BEHIND `budget` was read. `true` ⇒ `budget === null` is the fact
   * "this project has no budget set"; `false` ⇒ RM could not be read (no state, not even the last
   * known one), so a null budget is UNKNOWN — the UI must not print "no budget set" for a failed read.
   */
  budget_known: boolean;
  /** ISO 4217 code alongside `budget` (RM's `Project.currency`); null when RM holds none. */
  currency: string | null;
}

// ── C1 status header ─────────────────────────────────────────────────────────

export interface CockpitStatus {
  /** The ONE lifecycle state chip (R-CK4, derived here — see ./cockpit-status.ts). */
  state: CockpitState;
  /** Why (codes; the UI words them). Empty for `running`. */
  reasons: CockpitStateReason[];
  project_type: string | null;
  /** RM's current phase name (null = not started). The UI labels it with the tenant's phase title. */
  phase: string | null;
  /** The next gated phase ahead (null = none ahead, or closed). */
  next_gate: string | null;
  /** When the project started (fr creation); null only for an unreadable stamp. */
  started_at: string | null;
  /** When it ended — set only for a closed project whose closure time RM recorded. */
  ended_at: string | null;
  /** Open approvals (asks + sign-offs) on the project. */
  open_approvals: number;
  /**
   * "Phase N of M: X" (R2): the phase chain is the type's phases + Closure. `current_phase` is the
   * RM phase, or Closure once a `project_closure` card has left To do (or the project closed).
   * null = not started / unreadable.
   */
  current_phase: string | null;
  current_phase_label: string | null;
  phase_position: number | null;
  phase_count: number | null;
  /** Spend to date (billing, settled + today's provisional); null = billing not read / not attributable. */
  cost: { total: number | null; calls: number; currency: string; basis: CockpitProjectCosts['cost_basis'] } | null;
  /** The three header health dots. */
  health: { flows: PanelHealth; upstream: PanelHealth; cost: PanelHealth };
}

// ── C2 action strip ──────────────────────────────────────────────────────────

export type CockpitActionType = 'ask' | 'signoff' | 'review';

export interface CockpitActionItem {
  /** `approval:<id>` | `artifact:<id>`. */
  key: string;
  type: CockpitActionType;
  /** One plain line: the question, the sign-off's subject, or the artifact's name. */
  title: string;
  created_at: string | null;
  card_id: string | null;
  card_name: string | null;
  approval_id: string | null;
  artifact_id: string | null;
  /** The phase of the item's card (exact); null = no card / the card has no phase. */
  phase: string | null;
}

// ── Flow runs (A5) ───────────────────────────────────────────────────────────

export interface CockpitFlowRun {
  execution_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  card_id: string | null;
  /** The conveyor's verdict: a flow that took its `Flow error` / `Agent failed` path is 'error'. */
  status: string;
  /** n8n's own final status (migration 214); 'success' on a flow_error / agent_failed run. */
  n8n_status: string | null;
  started_at: string | null;
  stopped_at: string | null;
  failed_node: string | null;
  /** e.g. `flow_error`, `agent_failed` (the flow's own failure path) or n8n's error class. */
  error_class: string | null;
}

/** A failed run as the flow block surfaces it: the run plus its raw message (shown behind "Details"). */
export interface CockpitFlowFailure extends CockpitFlowRun {
  error_message: string | null;
  /** true ⇒ n8n finished the execution normally but the flow took its own failure path. */
  failed_inside_flow: boolean;
}

export interface CockpitFlows {
  /** false ⇒ no flow run has ever been recorded for this project ("Flow data not connected yet"). */
  connected: boolean;
  runs: CockpitFlowRun[];
  /** Failed runs with no later success of the same flow on the same card (newest first). */
  unresolved_failures: CockpitFlowFailure[];
  /** Every failed run in the window read (error / crashed), newest first, capped at FLOW_FAILURES_LIMIT. */
  failures: CockpitFlowFailure[];
  /** How many failed runs the window read holds (may exceed `failures.length`). */
  failure_count: number;
  last_received_at: string | null;
}

// ── billing #290 per-project costs (Slice 2 renders them) ───────────────────

/** R6 (C7 / R-CK6): one card's spend plus the phase and capability DERIVED from the card. */
export interface CostCardRow {
  card_id: string | null;
  cost: number | null;
  calls: number;
  /** The card's EXACT phase (the card's own `phase` field, or Closure for a closure card); null = no card / not tied. */
  phase?: string | null;
  /** The card's `card_type` custom field, as the board records it. */
  card_type?: string | null;
  /** The RM capability NAME of `card_type` (tenant catalogue); null when the type or the catalogue could not say. */
  capability?: string | null;
}

/** Whether the tenant catalogue could name capabilities for this project's cost rows. */
type CapabilitySource = 'catalogue' | 'unavailable';

/**
 * R6 (C7): the BOARD's state when the cost rows were annotated — the tri-state `board_available`
 * reduces to one boolean. 'no_board' is a FACT about the project (it has no board: archived, or
 * never created) and must never be worded as a read failure; 'unavailable' is a read failure.
 */
export type CostBoardState = 'ok' | 'unavailable' | 'no_board';

export interface CockpitProjectCosts {
  /** 'incurred' (super-admin) | 'billed' (× the tenant markup) | 'unavailable' (markup unknown ⇒ no amounts). */
  cost_basis: 'incurred' | 'billed' | 'unavailable';
  settled: { day: string; cost: number | null; calls: number; tokens_in: number; tokens_out: number }[];
  provisional: { since: string | null; cost: number | null; calls: number; tokens_in: number; tokens_out: number };
  /**
   * billing's per-card spend (`metadata.card_id`). R6 (C7) annotates each row with the card's OWN
   * phase and its RM capability (R-CK6: derived from the card, not sent on the wire); the three
   * annotation keys are OPTIONAL so `priceProjectCosts` stays the pure pricing function and an
   * older/partial answer still types.
   */
  by_card: CostCardRow[];
  by_card_since: string | null;
  /**
   * R6: whether the BOARD was read when these rows were annotated. `false` ⇒ no row could be tied
   * to a card, so `phase` / `card_type` / `capability` are null on EVERY row because the board was
   * unavailable — NOT because the cards record nothing. Absent on an older answer (before the
   * annotation) and on a not-attributable panel (no data at all).
   */
  board_available?: boolean;
  /**
   * R6: the board's state behind the annotation, tri-state. `no_board` = the project has no board
   * at all (a fact — the archive purges `planka_board_id`), NOT a failed read; `unavailable` = the
   * board could not be read. OPTIONAL like `board_available`: an older answer has neither, so a
   * reader must keep the pre-R6 behaviour. `board_available === (board_state === 'ok')`.
   */
  board_state?: CostBoardState;
  /**
   * R6: whether the card→capability names could be read from the tenant's RM catalogue.
   * 'unavailable' = the catalogue was needed and the read failed, so `capability` is null on every
   * row — the page says so rather than showing the spend as capability-less.
   */
  capability_source?: CapabilitySource;
  totals: {
    cost: number | null;
    settled_cost: number | null;
    provisional_cost: number | null;
    calls: number;
    tokens_in: number;
    tokens_out: number;
  };
  /** ISO 4217 currency of every amount (billing's; USD when billing did not say). */
  currency: string;
  /** billing's own statement of what `cost` is. */
  basis: string;
  as_of: string;
}

/** The PM's capability selection (RM), as `GET /api/projects/:id/capabilities` serves it. */
interface CockpitCapabilities {
  project_type: string | null;
  selected: unknown[];
  implicit: unknown[];
  events: PmProjectCapabilityEventOut[];
  total_events: number;
}

export interface CockpitConveyorHistory {
  conversation: Panel<{ entries: ConversationEntry[] }>;
  cards: Panel<CardsPayload>;
  delivered: Panel<DeliveredPayload>;
}

/** A `project_reports` row as `GET /api/reports` serves it. */
export type StoredReport = Omit<typeof projectReports.$inferSelect, 'created_at'> & { created_at: string };

interface CockpitBoard {
  phase_rail: PhaseColumn[];
  active_cards: CockpitCard[];
  blocked_cards: CockpitCard[];
}

/** `?scope=header`: what the shell header on every project page needs. */
export interface ProjectCockpitHeader {
  scope: 'header';
  project: Panel<ProjectSummary>;
  status: Panel<CockpitStatus>;
  /**
   * R4: how many items the project's Needs you page lists — the length of the SAME `deriveActions`
   * list the full read serves as `actions` (open asks + sign-offs + artifact reviews; 0 when closed).
   * The project rail badges "Needs you" with it.
   */
  needs_you: Panel<number>;
}

export interface ProjectCockpit {
  scope: 'full';
  project: Panel<ProjectSummary>;
  status: Panel<CockpitStatus>;
  /** C2: open asks, sign-offs and artifact reviews, oldest first. Empty on a closed project. */
  actions: Panel<CockpitActionItem[]>;
  /** MACRO project lifecycle rail. */
  lifecycle_rail: Panel<LifecycleRail>;
  /** MICRO board-mantra rail (Planka list names). */
  phase_rail: Panel<PhaseColumn[]>;
  active_cards: Panel<CockpitCard[]>;
  blocked_cards: Panel<CockpitCard[]>;
  approvals: Panel<CockpitApproval[]>;
  current_execution: Panel<CurrentExecution | null>;
  timeline_events: Panel<TimelineEvent[]>;
  /** A5 flow runs (n8n execution hook). */
  flows: Panel<CockpitFlows>;
  asset_usage: Panel<AssetUsage>;
  goal: Panel<CockpitGoal>;
  artifacts: Panel<CockpitArtifact[]>;
  /** Conveyor reports (artifacts service `report.json`). */
  reports: Panel<CockpitReport[]>;
  /** fr's own stored reports (`project_reports`, e.g. a bug_report), newest first. */
  stored_reports: Panel<StoredReport[]>;
  /** Per-project LLM spend from billing's daily rollup (the current cost panel). */
  cost: Panel<ProjectCost>;
  /** billing #290: settled + provisional + by_card. */
  project_costs: Panel<CockpitProjectCosts>;
  deliverables: Panel<ApprovedScope>;
  repositories: Panel<ProjectRepositorySet>;
  capabilities: Panel<CockpitCapabilities>;
  /** Conveyor projects only (an RM link); not applicable otherwise. */
  conveyor_history: Panel<CockpitConveyorHistory>;
  /** C3: phase segments sized by time spent, gates with signer, card dots, machine vs people time. */
  spine: Panel<CockpitSpine>;
  /** C8: every question and sign-off as one row that names its subject, oldest first. */
  decisions: Panel<CockpitDecision[]>;
  /** R2: the project as a chain of phases (overview.ts). */
  overview: Panel<ProjectOverview>;
  /** R5 (C4): the board — columns, time in column, blocked reasons, each card's exact phase (board.ts). */
  board: Panel<ProjectBoard>;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly — the real logic lives here)
// ---------------------------------------------------------------------------

const RECENT_MAPPING_LIMIT = 25;
const WM_CORRELATION_FANOUT = 8;
const TIMELINE_CAP = 60;
const N8N_ACTIVE_STATUSES = new Set(['running', 'waiting', 'new']);

/**
 * Map a Planka list name onto the canonical mantra phase.
 *
 * ⛔ One mapping with the Board: TODO and READY are both READYING (the canonical
 * `phaseFromListName` in lib/phase.ts), and the BLOCKED jidoka lane is its OWN
 * column. Before the UI review of 2026-10-07 TODO and BLOCKED both fell through
 * to OTHER, so the overview showed "Other 21" next to a Board showing
 * "BLOCKED 21" and a Needs-you panel claiming nothing was blocked.
 */
export function normalizePhase(listName: string | null | undefined): Phase {
  const n = (listName ?? '').toUpperCase();
  // ⛔ DONE via the ONE shared predicate (lib/done-equivalent.ts) — the same function the
  // DONE-move guard, /api/measure and isFinishedList use. It is decided FIRST so the rail's
  // PUBLISHING is EXACTLY the predicate (no substring arm below can pre-empt or widen it). The
  // predicate is an exact normalized allowlist, so "READY TO SHIP" / "QA DONE" are not DONE and
  // fall through to the READY / QA arms below.
  if (isDoneEquivalentListName(n)) return 'PUBLISHING';
  if (isBlockedListName(n)) return 'BLOCKED';
  const canonical = phaseFromListName(n);
  if (canonical) return canonical;
  if (n.includes('READY') || n.includes('TODO') || n.includes('TO DO')) return 'READYING';
  if (n.includes('DOING') || n.includes('IN PROGRESS') || n.includes('WIP')) return 'DOING';
  if (n.includes('INSPECT') || n.includes('REVIEW') || n.includes('QA')) return 'INSPECTING';
  return 'OTHER';
}

function cardLabels(board: BoardDetail, cardId: string): string[] {
  const labelIds = (board.included.cardLabels ?? [])
    .filter((cl) => cl.cardId === cardId)
    .map((cl) => cl.labelId);
  const byId = new Map((board.included.labels ?? []).map((l) => [l.id, l.name ?? '']));
  return labelIds.map((id) => byId.get(id) ?? '').filter((s) => s.length > 0);
}

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, now - t);
}

/** Age of a card in its current list — prefer listChangedAt, fall back to updatedAt/createdAt. */
function cardPhaseAge(card: Card, now: number): number | null {
  return ageMs(card.listChangedAt ?? card.updatedAt ?? card.createdAt, now);
}

/**
 * Derive the phase rail + active/blocked card lists from a single board detail.
 * `pendingApprovalCardIds` marks cards gated by an open approval as blocked.
 */
export function deriveBoardViews(
  board: BoardDetail,
  pendingApprovalCardIds: Set<string>,
  now: number,
  /** Break-glass DONE cards (`done_kind: 'human_override'`): never counted as PUBLISHING. */
  humanOverrideCardIds: ReadonlySet<string> = new Set(),
): { phase_rail: PhaseColumn[]; active_cards: CockpitCard[]; blocked_cards: CockpitCard[] } {
  const lists = board.included.lists ?? [];
  const cards = board.included.cards ?? [];
  const listNameById = new Map(lists.map((l) => [l.id, l.name ?? null]));

  const cardViews: CockpitCard[] = cards.map((c) => {
    const listName = listNameById.get(c.listId) ?? null;
    const rawPhase = normalizePhase(listName);
    // ⛔ A break-glass DONE is NOT done work (liveness-DONE design row #7).
    const phase: Phase = rawPhase === 'PUBLISHING' && humanOverrideCardIds.has(c.id) ? 'OTHER' : rawPhase;
    const labels = cardLabels(board, c.id);
    const labelBlocked = labels.some((l) => /block|gate|hold/i.test(l));
    const gateBlocked = pendingApprovalCardIds.has(c.id);
    // A card sitting in the BLOCKED lane IS blocked — the Board and the
    // Needs-you page already count it; the cockpit used to see only labels.
    const laneBlocked = phase === 'BLOCKED';
    return {
      id: c.id,
      name: c.name,
      phase,
      list_name: listName,
      labels,
      age_in_phase_ms: cardPhaseAge(c, now),
      updated_at: c.updatedAt ?? null,
      blocked: laneBlocked || labelBlocked || gateBlocked,
      blocked_reason: gateBlocked
        ? 'awaiting approval'
        : laneBlocked
          ? 'in the BLOCKED lane'
          : labelBlocked
            ? 'labelled blocked'
            : null,
    };
  });

  // Phase rail: one column per canonical phase present on the board, in mantra order.
  const order: Phase[] = ['READYING', 'DOING', 'INSPECTING', 'PUBLISHING', 'BLOCKED', 'OTHER'];
  const inFlight = new Map<Phase, CockpitCard[]>();
  for (const cv of cardViews) {
    const arr = inFlight.get(cv.phase) ?? [];
    arr.push(cv);
    inFlight.set(cv.phase, arr);
  }
  // "active" phase = the DOING/INSPECTING column carrying the most cards.
  let activePhase: Phase | null = null;
  let activeCount = -1;
  for (const p of ['DOING', 'INSPECTING'] as Phase[]) {
    const n = (inFlight.get(p) ?? []).length;
    if (n > activeCount && n > 0) {
      activeCount = n;
      activePhase = p;
    }
  }
  const phase_rail: PhaseColumn[] = order
    .filter((p) => (p !== 'OTHER' && p !== 'BLOCKED') || (inFlight.get(p) ?? []).length > 0)
    .map((p) => {
      const group = inFlight.get(p) ?? [];
      const oldest = group.reduce<number | null>((acc, c) => {
        if (c.age_in_phase_ms == null) return acc;
        return acc == null ? c.age_in_phase_ms : Math.max(acc, c.age_in_phase_ms);
      }, null);
      // Representative list name for the phase (first matching list).
      const listName = lists.find((l) => normalizePhase(l.name) === p)?.name ?? null;
      return {
        phase: p,
        list_name: listName,
        count: group.length,
        active: p === activePhase,
        oldest_card_age_ms: oldest,
      };
    });

  const active_cards = cardViews.filter(
    (c) => !c.blocked && (c.phase === 'DOING' || c.phase === 'INSPECTING'),
  );
  const blocked_cards = cardViews.filter((c) => c.blocked);

  return { phase_rail, active_cards, blocked_cards };
}

interface MappingRow {
  execution_id: string;
  workflow_id: string;
  correlation_id: string;
  triggered_at: Date | string | null;
}

/** ISO of a date-ish value, or null when it is absent or not a date (never a throw). */
function safeIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// ---------------------------------------------------------------------------
// The MACRO lifecycle rail — the honesty rule this block exists to enforce
// ---------------------------------------------------------------------------

/**
 * Project the project's RM phase + its stamp into the macro lifecycle rail
 * block. PURE (no DB, no clock beyond the block stamp).
 *
 * ⭐ RM OWNS THE PHASE (George 2026-10-13; n8n is the only writer). fr creates
 * the pm_project with NO phase, so a project n8n has not started yet reads
 * `phase: null` — and that is rendered as exactly that: an AVAILABLE rail whose
 * every node is pending (`gate` / `upcoming`, none `done` or `active`) and whose
 * next gate is the first gated phase of the list. Nothing is fabricated: no
 * node is highlighted, so no reader can parse progress out of it.
 *
 * (The old honesty rule — fr's `project_phase` column was born `'request'`, so
 * its first phase with a NULL stamp was indistinguishable from a decision and
 * was withheld as `no_data` — is gone with the column read: a non-null RM phase
 * was SET by n8n and is an observation; "nothing set" is the null.)
 *
 * A value outside the phase vocabulary → UNAVAILABLE `data_gap`, never clamped
 * to a position.
 */
type LifecycleRailSource =
  /** fr#1482 — a PLAN project: the plan's phases, labelled with the tenant's RM titles. */
  | { kind: 'plan'; plan: PhasePlan; labels: ReadonlyMap<string, string> }
  /** A legacy project: its RM project type's ordered phases. */
  | { kind: 'type'; phases: readonly PhaseSpec[] }
  /** The phase list could not be read (plan unreadable, catalogue not initialised, no type…). */
  | { kind: 'unresolvable'; reason: string };

export function deriveLifecycleRail(
  phase: string | null,
  phaseUpdatedAt: Date | string | null | undefined,
  source: LifecycleRailSource,
): Block<LifecycleRail> {
  const stampedAt = toIso(phaseUpdatedAt);

  if (source.kind === 'unresolvable') {
    return unavailableBlock<LifecycleRail>(
      'fr-db',
      `this project's phase list could not be read (${source.reason})`,
      'data_gap',
    );
  }
  if (source.kind === 'plan') {
    const { plan, labels } = source;
    const nodes = planRailNodes(plan, phase, labels);
    if (!nodes) {
      return unavailableBlock<LifecycleRail>(
        'fr-db',
        `the recorded phase '${phase}' is not one of this project's plan phases`,
        'data_gap',
      );
    }
    return availableBlock<LifecycleRail>('fr-db', {
      phase,
      phase_updated_at: stampedAt,
      next_gate: planNextGate(plan, phase),
      nodes,
      plan: { template_id: plan.template_id, template_hash: plan.template_hash },
    });
  }

  const { phases } = source;
  const nodes = railNodes(phases, phase);
  if ((phase !== null && !isPhaseOf(phases, phase)) || !nodes) {
    return unavailableBlock<LifecycleRail>(
      'fr-db',
      `the recorded phase '${phase}' is not one of this project type's phases`,
      'data_gap',
    );
  }

  return availableBlock<LifecycleRail>('fr-db', {
    phase,
    phase_updated_at: stampedAt,
    next_gate: nextGate(phases, phase),
    nodes,
    plan: null,
  });
}

// ---------------------------------------------------------------------------
// The APPROVED SCOPE (migration 127)
// ---------------------------------------------------------------------------

/** Coerce the `acceptance_criteria` jsonb to the ordered string list it models. */
function toAcceptanceCriteria(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * The approved effort figure off `projects.approved_effort_estimate` (jsonb,
 * nullable). Anything that is not the shape the outline schema approved is
 * dropped rather than half-rendered — a partial estimate on screen is a number
 * the customer will read as agreed.
 */
function toApprovedEffort(v: unknown): ApprovedEffortEstimate | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return null;
  if (typeof o.unit !== 'string' || o.unit.length === 0) return null;
  return {
    value: o.value,
    unit: o.unit,
    ...(typeof o.note === 'string' && o.note.length > 0 ? { note: o.note } : {}),
  };
}

/**
 * Read the approved scope. ⚠️ BOTH reads are ORDERED BY `position` — the column
 * exists because the approved list is an ORDERED one, and Postgres returns rows
 * in no guaranteed order without it. Dropping either ORDER BY renders the
 * customer's agreed scope in an arbitrary sequence that still looks plausible,
 * which is why the integration test asserts the order explicitly against rows
 * inserted out of order.
 */
async function loadApprovedScope(projectId: string): Promise<ApprovedScopeRows> {
  const [deliverableRows, milestoneRows] = await Promise.all([
    db
      .select({
        id: projectDeliverables.id,
        position: projectDeliverables.position,
        kind: projectDeliverables.kind,
        title: projectDeliverables.title,
        description: projectDeliverables.description,
        acceptance_criteria: projectDeliverables.acceptance_criteria,
      })
      .from(projectDeliverables)
      .where(eq(projectDeliverables.project_id, projectId))
      .orderBy(asc(projectDeliverables.position)),
    db
      .select({
        position: projectMilestones.position,
        name: projectMilestones.name,
        target_date: projectMilestones.target_date,
      })
      .from(projectMilestones)
      .where(eq(projectMilestones.project_id, projectId))
      .orderBy(asc(projectMilestones.position)),
  ]);

  return {
    deliverables: deliverableRows.map((r) => ({
      id: r.id,
      position: r.position,
      // The DB CHECK already closes this vocabulary; the cast records that the
      // narrowing is enforced by the constraint, not assumed here.
      kind: r.kind as ProjectDeliverable['kind'],
      title: r.title,
      description: r.description ?? null,
      acceptance_criteria: toAcceptanceCriteria(r.acceptance_criteria),
    })),
    milestones: milestoneRows.map((r) => ({
      position: r.position,
      name: r.name,
      target_date: r.target_date ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Per-project cost block
// ---------------------------------------------------------------------------

/** UTC calendar day (YYYY-MM-DD) — the unit billing's window bounds are in. */
function utcDay(v: Date | string | number): string {
  return new Date(v).toISOString().slice(0, 10);
}

/**
 * The cost block. ⭐ THE ONLY BRANCH THAT MATTERS: an unattributable project is
 * resolved WITHOUT CONTACTING BILLING, and resolves to NO DATA.
 *
 * `classifyProjectOwnership` is the same pure predicate `guardProjectId` uses to
 * decide whether this project's id may ride an outbound billing-relevant call at
 * all. If it says anything but `owned`, the id was never emitted, so billing
 * cannot hold a row naming this project and its answer would be a 0 that means
 * UNKNOWN. Asking anyway would buy a round-trip AND a lie.
 *
 * ⛔ It must stay `data_gap`, not `no_data`. `no_data` is "nothing recorded for
 * this selection, empty by design" — which a UI is entitled to render as zero.
 * This is the opposite: something may very well be recorded, under no name we can
 * query by.
 *
 * Billing failing is a different state and takes the `block()` path, which stamps
 * kind `'error'`; the two are rendered with different copy. A window wider than
 * `PROJECT_COST_MAX_CHUNKS` (≈10 years) also lands there via `getProjectCost`'s
 * own refusal — unreachable for any project fr can have created, and an
 * `available:false` either way, so it gets no branch of its own here.
 *
 * EXPORTED for the unit test, deliberately: the rest of `buildProjectCockpit`
 * reads the DB directly, so reaching this branch through the aggregator would
 * require Postgres and land the proof in `tests/integration/**` — which is NOT
 * prefix-covered by CI's `bun test` scope (only `tests/unit/`, `tests/auth/` and
 * `src/` are). A proof that cannot run is not a proof.
 */
function buildProjectCostBlock(
  project: Pick<Project, 'id' | 'project_data' | 'created_at'>,
  tenantId: string,
  now: number,
): Promise<Block<ProjectCost>> {
  const outcome = classifyProjectOwnership(project, tenantId);
  if (outcome !== 'owned') {
    return Promise.resolve(
      unavailableBlock<ProjectCost>(
        'metering',
        outcome === 'untagged'
          ? 'this project carries no tenant tag, so no LLM call ever carried its id and billing holds nothing that could name it'
          : 'this project is tagged to another workspace, so its spend was never attributed under this one',
        'data_gap',
      ),
    );
  }

  const from = utcDay(project.created_at);
  const to = utcDay(now);
  return block('metering', async () => {
    // Verified request-frame flag only: no frame / no flag is a customer.
    const superAdmin = tryGetRequestContext()?.callerIsSuperAdmin === true;
    const cost = await getProjectCost({ tenantId, projectId: project.id, from, to });
    // Asked only once billing answered: a billing outage is already `error`.
    const markupPct = superAdmin ? null : await fetchTenantMarkupPct(tenantId);
    const priced: Pick<ProjectCost, 'attributed_usd' | 'cost_basis'> = superAdmin
      ? { attributed_usd: cost.total_cost_usd, cost_basis: 'incurred' }
      : markupPct === null
        ? { attributed_usd: null, cost_basis: 'unavailable' }
        : {
            attributed_usd: Number(applyMarkup(cost.total_cost_usd.toFixed(6), markupPct)),
            cost_basis: 'billed',
          };
    const lens: CostLens = superAdmin
      ? { basis: 'incurred' }
      : markupPct === null
        ? { basis: 'unavailable' }
        : { basis: 'billed', markupPct };
    const funding = await projectFundingSplit(project.id, tenantId, from, to, lens);
    const payload: ProjectCost = {
      ...priced,
      attributed_request_count: cost.request_count,
      input_tokens: cost.input_tokens,
      output_tokens: cost.output_tokens,
      from,
      to,
      rolled_up_through: rolledUpThrough(from, to, now),
      as_of: new Date(now).toISOString(),
      coverage: 'attributed',
      funding,
      funding_kind: fundingKind(funding),
    };
    return payload;
  });
}

/**
 * The last day billing's daily rollup can cover in [from, to]: yesterday (UTC),
 * clamped to `to`; null when that is before `from` (the project started today).
 */
function rolledUpThrough(from: string, to: string, now: number): string | null {
  const yesterday = utcDay(now - 86_400_000);
  const through = yesterday < to ? yesterday : to;
  return through < from ? null : through;
}

/** One funding value when every event in the split has it, `mixed` when not, null when empty/unavailable. */
function fundingKind(split: ProjectFundingSplit | null): string | null {
  if (!split) return null;
  const kinds = new Set(split.by_funding.filter((f) => f.events > 0).map((f) => f.funding));
  if (kinds.size === 0) return null;
  return kinds.size === 1 ? [...kinds][0]! : 'mixed';
}

/** The project's funding split, or null when billing's breakdown is unreadable. */
async function projectFundingSplit(
  projectId: string,
  tenantId: string,
  created: string,
  to: string,
  lens: CostLens,
): Promise<ProjectFundingSplit | null> {
  const earliest = new Date(Date.parse(`${to}T00:00:00Z`) - MAX_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const from = created > earliest ? created : earliest;
  try {
    const r = await getTenantUsageCrossBreakdown({
      tenantId,
      query: { from, to, group_by: 'funding', project_id: projectId },
    });
    return { from: r.from ?? from, to: r.to ?? to, by_funding: fundingTotals(r.rows ?? [], lens).by_funding };
  } catch (e) {
    reportSwallowedFailure(e, {
      service: 'billing',
      path: '/api/usage/breakdown',
      degradedTo: 'ProjectCost.funding=null (amount still shown)',
    });
    return null;
  }
}

/**
 * Compose the project timeline from real, project-scoped sources:
 *  - n8n execution mapping rows  → typed_action events (evidence a typed n8n action fired)
 *  - worker_management sessions  → worker_inference (+ qa_verdict when validation_passed known)
 *  - approval decisions          → decision_write events
 *  - card list-change timestamps → phase_transition events
 * Merged desc by `at`, capped. Pure — no I/O. (Conveyor flow runs are the `flows` panel.)
 */
export function composeTimeline(input: {
  mappings: MappingRow[];
  sessions: GraphExecutionSession[];
  approvals: CockpitApproval[];
  cards: CockpitCard[];
  now: number;
  /** Every board card's name (done cards included), for the decision rows' subjects. */
  cardNames?: ReadonlyMap<string, string>;
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const m of input.mappings) {
    const at = toIso(m.triggered_at);
    if (!at) continue;
    events.push({
      id: `n8n:${m.execution_id}`,
      type: 'typed_action',
      at,
      title: 'A typed n8n action executed',
      card_id: null,
      execution_id: m.execution_id,
      correlation_id: m.correlation_id,
      status: null,
      pills: [{ label: `workflow ${m.workflow_id}`, tone: 'neutral' }],
    });
  }

  for (const s of input.sessions) {
    const at = s.completed_at ?? s.created_at;
    if (!at) continue;
    events.push({
      id: `wm:${s.session_id}`,
      type: 'worker_inference',
      at,
      title: 'A narrow worker inference ran',
      card_id: null,
      execution_id: null,
      correlation_id: s.correlation_id,
      status: s.status,
      pills: [{ label: `graph ${s.graph_id}`, tone: 'neutral' }],
    });
    if (s.validation_passed !== null && s.validation_passed !== undefined) {
      events.push({
        id: `qa:${s.session_id}`,
        type: 'qa_verdict',
        at: s.completed_at ?? s.created_at,
        title: s.validation_passed ? 'QA verdict: passed' : 'QA verdict: failed',
        card_id: null,
        execution_id: null,
        correlation_id: s.correlation_id,
        status: s.validation_passed ? 'passed' : 'failed',
        pills: [
          {
            label: s.validation_passed ? 'validation ok' : 'validation failed',
            tone: s.validation_passed ? 'success' : 'danger',
          },
        ],
      });
    }
  }

  for (const a of input.approvals) {
    for (const d of a.decisions) {
      if (!d.decided_at) continue;
      events.push({
        id: `decision:${a.id}:${d.approver_id}`,
        type: 'decision_write',
        at: d.decided_at,
        // C8: the row names its subject — never the bare "A decision was approved".
        title: decisionTimelineTitle(a, d.decision, input.cardNames ?? new Map(input.cards.map((c) => [c.id, c.name] as const))),
        card_id: a.card_id,
        execution_id: null,
        correlation_id: null,
        status: d.decision,
        pills: [
          { label: `decision: ${d.decision}`, tone: d.decision === 'approved' ? 'success' : 'danger' },
          ...(d.decided_by_kind === 'triage_agent'
            ? [{ label: 'decided by the approval agent', tone: 'neutral' as const }]
            : d.decided_by_kind === 'rule'
              ? [{ label: 'decided by a rule', tone: 'neutral' as const }]
              : []),
        ],
      });
    }
  }

  for (const c of input.cards) {
    if (c.age_in_phase_ms == null) continue;
    const at = new Date(input.now - c.age_in_phase_ms).toISOString();
    events.push({
      id: `phase:${c.id}`,
      type: 'phase_transition',
      at,
      title: `Card entered ${c.phase.toLowerCase()}`,
      card_id: c.id,
      execution_id: null,
      correlation_id: null,
      status: c.phase,
      pills: [{ label: c.phase.toLowerCase(), tone: 'neutral' }],
    });
  }

  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, TIMELINE_CAP);
}

/** "Approved: Sign-off for “Fix login” (development bug fix)" — the subject, never a bare verdict. */
function decisionTimelineTitle(a: CockpitApproval, decision: string, names: ReadonlyMap<string, string>): string {
  const [row] = composeDecisionLog({ approvals: [{ ...a, decisions: a.decisions.filter((x) => x.decision === decision) }], cardNames: names });
  const verdict = decision === 'approved' ? 'Approved' : decision === 'rejected' ? 'Rejected' : decision.replace(/_/g, ' ');
  return `${verdict}: ${row?.subject ?? 'an item on this project'}`;
}

/**
 * Derive the customer goal-coverage summary. Pure.
 *
 * ⛔ `phaseRail === null` MEANS "THE RAIL COULD NOT BE READ", AND THE THREE
 * RAIL-DERIVED FIELDS MUST THEN BE null, NOT 0. This used to be called as
 * `deriveGoal(phaseRail.data ?? [], openGates)`, and that `?? []` was a defect: an
 * unavailable rail reduced to `cards_total: 0, cards_published: 0, coverage_pct: 0`
 * and was published as available, so an upstream outage rendered as "0% of 0 cards"
 * — a confident empty success. Nothing downstream could tell that from a project
 * that genuinely has no cards.
 *
 * ⭐ AND THE BLOCK STAYS AVAILABLE, deliberately. `open_gates` does NOT come from the
 * rail — it is counted from the APPROVALS read, which is a different source and is
 * still real. Blanking the whole block to fix the rail fields would have thrown that
 * away and reintroduced the exact defect: `open_gates` reading as nothing
 * over a real pending gate, i.e. "nothing waiting on you" by a second route. A
 * remedy that removes one lie by telling another is not a fix. Unavailability is
 * per-FIELD here because the sources are per-field.
 */
export function deriveGoal(phaseRail: PhaseColumn[] | null, openGates: number): CockpitGoal {
  if (phaseRail === null) {
    return {
      cards_total: null,
      cards_published: null,
      coverage_pct: null,
      open_gates: openGates,
    };
  }
  const total = phaseRail.reduce((n, p) => n + p.count, 0);
  const published = phaseRail.find((p) => p.phase === 'PUBLISHING')?.count ?? 0;
  const coverage = total > 0 ? Math.round((published / total) * 100) : 0;
  return { cards_total: total, cards_published: published, coverage_pct: coverage, open_gates: openGates };
}

/**
 * Reduce a raw artifact list to the review-actionable set the "Needs you" queue
 * shows — `pending` or `needs_revision` only — projected to the customer-safe
 * `CockpitArtifact` shape. Pure (the same filter NeedsYouQueue applied client-side).
 *
 * A conveyor report (`report.json`) in `needs_revision` is NOT the human's next action: the
 * human already asked for a revision (directly, or by rejecting the card's sign-off — George
 * 2026-10-29), so the next move is the conveyor's. It leaves the queue; every other artifact in
 * `needs_revision` stays as before.
 */
export function filterActionableArtifacts(rows: ArtifactOut[]): CockpitArtifact[] {
  const result: CockpitArtifact[] = [];
  for (const a of rows) {
    if (a.status !== 'pending' && a.status !== 'needs_revision') continue;
    if (a.status === 'needs_revision' && a.filename === CONVEYOR_REPORT_FILENAME) continue;
    result.push({
      id: a.id,
      filename: a.filename,
      kind: a.kind,
      project_id: a.project_id,
      created_at: a.created_at,
      status: a.status,
    });
  }
  return result;
}

/**
 * The conveyor's stored reports among a project's artifacts (G5): every
 * `report.json`, whatever its review status, newest first. Pure.
 */
export function selectConveyorReports(
  rows: ArtifactOut[],
  cardNames: ReadonlyMap<string, string>,
): CockpitReport[] {
  const newestFirst = (x: CockpitReport, y: CockpitReport) =>
    x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0;
  const reports = rows
    .filter((a) => a.filename === CONVEYOR_REPORT_FILENAME)
    .map(
      (a): CockpitReport => ({
        id: a.id,
        filename: a.filename,
        // The conveyor links a report to its card by the PLANKA id (`planka_card_id`); artifact
        // `card_id` is a UUID column the conveyor leaves NULL — the Outputs page's one rule.
        card_id: artifactCardId(a),
        card_name: cardNames.get(artifactCardId(a) ?? '') ?? null,
        step: a.step ?? null,
        status: a.status ?? null,
        publish_status: a.publish_status === 'published' || a.publish_status === 'draft' ? a.publish_status : null,
        is_final: false,
        created_at: a.created_at,
      }),
    );
  // Published before drafts (unknown last), newest first within each; the newest
  // published one is the final report.
  const rank = (r: CockpitReport) => (r.publish_status === 'published' ? 0 : r.publish_status === 'draft' ? 1 : 2);
  reports.sort((x, y) => rank(x) - rank(y) || newestFirst(x, y));
  if (reports[0]?.publish_status === 'published') reports[0].is_final = true;
  return reports;
}

// ---------------------------------------------------------------------------
// DB block helpers
// ---------------------------------------------------------------------------

/**
 * How many DECIDED (non-pending) approvals the cockpit reads, newest first.
 * Every PENDING row is still read: they drive `open_gates` and the blocked-card
 * set, and dropping one would under-report an open gate. Decided rows only feed
 * the timeline's decision events, which are capped anyway — an unbounded read
 * of a long-lived project's whole approval history (plus its roster and
 * decisions, by id) was the cost with nothing displayed for it.
 */
export const COCKPIT_DECIDED_APPROVALS_LIMIT = 200;

export async function loadApprovals(
  projectId: string,
  tenantId: string,
): Promise<CockpitApproval[]> {
  // fr row 14d: `approvals.tenant_id = <active tenant>` for EVERY caller, a
  // super-admin in home view included — the same single predicate as every
  // approvals lane in routes/approvals.ts. This used to drop the tenant pin
  // under `superAdminHome` (the "third copy" of the home-view relaxation),
  // which let a super-admin's home-tagged project render another tenant's
  // approvals in its "needs you" block while `GET /api/projects/:id/approvals`
  // showed only the home rows (V-fr-14d probe). Reading another tenant's
  // approvals is done by SWITCHING into that tenant, never from home.
  const scope = and(eq(approvals.project_id, projectId), eq(approvals.tenant_id, tenantId));
  const [pendingRows, decidedRows] = await Promise.all([
    db
      .select()
      .from(approvals)
      .where(and(scope, eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.created_at)),
    db
      .select()
      .from(approvals)
      .where(and(scope, ne(approvals.status, 'pending')))
      .orderBy(desc(approvals.created_at))
      .limit(COCKPIT_DECIDED_APPROVALS_LIMIT),
  ]);
  // Same order the single unbounded read produced: newest first.
  const rows = [...pendingRows, ...decidedRows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const required = await db
    .select()
    .from(requiredApprovers)
    .where(inArray(requiredApprovers.approval_id, ids));
  const decisions = await db
    .select()
    .from(approvalDecisions)
    .where(inArray(approvalDecisions.approval_id, ids));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    description: r.description,
    card_id: r.card_id,
    created_at: toIso(r.created_at),
    expires_at: toIso(r.expires_at),
    // Already read by the `select()` above; passed through rather than re-fetched.
    metadata: r.metadata ?? null,
    required_approvers: required
      .filter((ra) => ra.approval_id === r.id)
      .map((ra) => ({ user_id: ra.user_id, role: ra.role })),
    decisions: decisions
      .filter((d) => d.approval_id === r.id)
      .map((d) => ({
        approver_id: d.approver_id,
        decision: d.decision,
        comment: d.comment,
        decided_at: toIso(d.decided_at),
        decided_by_kind: d.decided_by_kind,
      })),
    tenant_id: r.tenant_id,
    source: r.source ?? null,
    requester_id: r.requester_id ?? null,
    action_id: (r as { action_id?: string | null }).action_id ?? null,
    change_summary: r.change_summary ?? null,
    impact_analysis: r.impact_analysis ?? null,
  }));
}

async function loadRecentMappings(projectId: string): Promise<MappingRow[]> {
  return db
    .select({
      execution_id: n8nExecutionMapping.execution_id,
      workflow_id: n8nExecutionMapping.workflow_id,
      correlation_id: n8nExecutionMapping.correlation_id,
      triggered_at: n8nExecutionMapping.triggered_at,
    })
    .from(n8nExecutionMapping)
    .where(eq(n8nExecutionMapping.project_id, projectId))
    .orderBy(desc(n8nExecutionMapping.triggered_at))
    .limit(RECENT_MAPPING_LIMIT);
}

/** Governance asset kinds surfaced per-project in the asset-use strip. */
const BOUND_ASSET_KINDS = ['principle', 'requirement', 'decision'] as const;

/**
 * Pure tally of asset_bindings rows into per-kind counts. A kind absent from the
 * rows stays 0 — a real "none bound" answer. Non-governance kinds (workflow,
 * prompt, kag_source, …) are ignored; this strip only surfaces the three above.
 */
export function tallyBoundByKind(rows: { asset_kind: string }[]): AssetUsage['bound_by_kind'] {
  const counts: AssetUsage['bound_by_kind'] = {
    principle: 0,
    requirement: 0,
    decision: 0,
  };
  for (const r of rows) {
    if ((BOUND_ASSET_KINDS as readonly string[]).includes(r.asset_kind)) {
      counts[r.asset_kind as (typeof BOUND_ASSET_KINDS)[number]] += 1;
    }
  }
  return counts;
}

/** Tally distinct assets bound to this project, per governance kind (asset_bindings). */
async function loadBoundByKind(projectId: string): Promise<AssetUsage['bound_by_kind']> {
  const rows = await db
    .select({ asset_kind: assetBindings.asset_kind })
    .from(assetBindings)
    .where(eq(assetBindings.project_id, projectId));
  return tallyBoundByKind(rows);
}

async function loadAssetUsage(projectId: string, cardIds: string[]): Promise<AssetUsage> {
  // Governance-asset bindings are keyed by project, independent of the board
  // cards — so this runs even when the project has no cards yet.
  const boundByKind = await loadBoundByKind(projectId);

  if (cardIds.length === 0) {
    return { kag_memory_links: 0, cards_with_links: 0, per_card: [], bound_by_kind: boundByKind };
  }
  const links = await db
    .select({ card_id: cardSeekerLinks.card_id, kag_entity_id: cardSeekerLinks.kag_entity_id })
    .from(cardSeekerLinks)
    .where(inArray(cardSeekerLinks.card_id, cardIds));

  const perCard = new Map<string, Set<string>>();
  for (const l of links) {
    const set = perCard.get(l.card_id) ?? new Set<string>();
    set.add(l.kag_entity_id);
    perCard.set(l.card_id, set);
  }
  const entities = new Set(links.map((l) => l.kag_entity_id));
  return {
    kag_memory_links: entities.size,
    cards_with_links: perCard.size,
    per_card: [...perCard.entries()].map(([card_id, set]) => ({ card_id, link_count: set.size })),
    bound_by_kind: boundByKind,
  };
}

// ---------------------------------------------------------------------------
// v2 pure composers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * An available Block → an `ok` panel (`degraded` when it carries a completeness note); an
 * unavailable one → `down` (an outage) or not-applicable (a known gap / nothing to read).
 * Used only for the sub-blocks of services that still speak Block (the conveyor history).
 */
function panelFromBlock<T>(b: Block<T>, source: string): Panel<T> {
  if (b.meta.available && b.data !== null) {
    return b.meta.note ? degradedPanel(b.data, `${source}_partial`, b.meta.fetched_at) : okPanel(b.data, b.meta.fetched_at);
  }
  const kind = b.meta.unavailable_kind ?? 'error';
  if (kind === 'error') {
    const m = /^([A-Z][A-Z_]+):/.exec(b.meta.error ?? '');
    return downPanel<T>(`${source}_${(m?.[1] ?? 'error').toLowerCase()}`);
  }
  return naPanel<T>(`${source}_${kind}`);
}

/** An ask (a QUESTION, or a row that states a question) vs a sign-off. */
function isAskApproval(a: Pick<CockpitApproval, 'metadata'>): boolean {
  const da = a.metadata?.deblock_action;
  if (typeof da === 'string' && da.trim().toUpperCase() === 'QUESTION') return true;
  return statedOpenQuestions(a.metadata).length > 0;
}

const ACTION_TITLE_MAX = 240;

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > ACTION_TITLE_MAX ? `${t.slice(0, ACTION_TITLE_MAX - 1)}…` : t;
}

/**
 * C2: everything on this project waiting on a person, OLDEST FIRST. ⛔ A closed project offers
 * nothing: its draft reports were never going to be published, and a sign-off on a closed project
 * moves nothing.
 */
function deriveActions(input: {
  approvals: readonly CockpitApproval[];
  artifacts: readonly CockpitArtifact[];
  reports: readonly CockpitReport[];
  cardNames: ReadonlyMap<string, string>;
  /** The Outputs trail's label of each artifact (`documentLabels`) — the review's title and card. */
  documentLabels?: ReadonlyMap<string, DocumentLabel>;
  closed: boolean;
}): CockpitActionItem[] {
  if (input.closed) return [];
  const items: CockpitActionItem[] = [];
  for (const a of input.approvals) {
    if (a.status !== 'pending') continue;
    const ask = isAskApproval(a);
    const text = ask
      ? askQuestion({ description: a.description, change_summary: a.change_summary, metadata: a.metadata })
      : stripAskPrefix(a.change_summary || a.description || '');
    items.push({
      key: `approval:${a.id}`,
      type: ask ? 'ask' : 'signoff',
      title: oneLine(text) || (ask ? 'A question for you' : 'A sign-off for you'),
      created_at: a.created_at,
      card_id: a.card_id,
      card_name: a.card_id ? (input.cardNames.get(a.card_id) ?? null) : null,
      approval_id: a.id,
      artifact_id: null,
      phase: null,
    });
  }
  const reportById = new Map(input.reports.map((r) => [r.id, r]));
  for (const art of input.artifacts) {
    const rep = reportById.get(art.id);
    // ⭐ ONE labelling rule with the Outputs page (document-trail.ts): the same title there and here,
    // never a file name and never a generic "a report to review".
    const label = input.documentLabels?.get(art.id);
    const cardId = label?.card_id ?? rep?.card_id ?? null;
    const cardName = label?.card_name ?? rep?.card_name ?? (cardId ? (input.cardNames.get(cardId) ?? null) : null);
    items.push({
      key: `artifact:${art.id}`,
      type: 'review',
      title: label?.title ?? fallbackTitle(art, cardName),
      created_at: art.created_at,
      card_id: cardId,
      card_name: cardName,
      approval_id: null,
      artifact_id: art.id,
      phase: null,
    });
  }
  const t = (x: CockpitActionItem) => (x.created_at ? Date.parse(x.created_at) : Number.POSITIVE_INFINITY);
  return items.sort((x, y) => t(x) - t(y));
}

function flowRunView(r: ConveyorFlowRunRow): CockpitFlowRun {
  return {
    execution_id: r.execution_id,
    workflow_id: r.workflow_id,
    workflow_name: r.workflow_name,
    card_id: r.card_id,
    status: r.status,
    n8n_status: r.n8n_status ?? null,
    started_at: toIso(r.started_at),
    stopped_at: toIso(r.stopped_at),
    failed_node: r.failed_node,
    error_class: r.error_class,
  };
}

const FAILED_FLOW_STATUSES = new Set(['error', 'crashed']);
const FLOW_FAILURES_LIMIT = 20;

function flowFailureView(r: ConveyorFlowRunRow): CockpitFlowFailure {
  return {
    ...flowRunView(r),
    error_message: r.error_message,
    failed_inside_flow: r.status === 'error' && r.n8n_status === 'success',
  };
}

/** The flows panel's data. `connected:false` ⇔ the hook has never reported a run for this project. */
function composeFlows(rows: readonly ConveyorFlowRunRow[]): CockpitFlows {
  let last: number | null = null;
  for (const r of rows) {
    const t = r.received_at ? new Date(r.received_at).getTime() : NaN;
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  const failed = rows.filter((r) => FAILED_FLOW_STATUSES.has(r.status));
  return {
    connected: rows.length > 0,
    runs: rows.map(flowRunView),
    unresolved_failures: unresolvedFlowFailures(rows).map(flowFailureView),
    failures: failed.slice(0, FLOW_FAILURES_LIMIT).map(flowFailureView),
    failure_count: failed.length,
    last_received_at: last === null ? null : new Date(last).toISOString(),
  };
}

/**
 * Price billing's per-project costs through the SAME lens as the cost panel: a super-admin sees
 * the incurred (internal) cost, everyone else the billed figure (× the tenant's markup), and when
 * the markup is unknown NO amount at all — never the incurred figure under a billed label.
 */
function priceProjectCosts(raw: UpstreamProjectCosts, lens: CostLens): CockpitProjectCosts {
  const price = (v: string | number | null | undefined): number | null => {
    if (lens.basis === 'unavailable') return null;
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0'));
    if (!Number.isFinite(n)) return null;
    if (lens.basis === 'incurred') return n;
    return Number(applyMarkup(n.toFixed(6), lens.markupPct));
  };
  return {
    cost_basis: lens.basis,
    settled: (raw.settled ?? []).map((d) => ({
      day: d.day,
      cost: price(d.cost),
      calls: d.calls ?? 0,
      tokens_in: d.tokens_in ?? 0,
      tokens_out: d.tokens_out ?? 0,
    })),
    provisional: {
      since: raw.provisional?.since ?? null,
      cost: price(raw.provisional?.cost),
      calls: raw.provisional?.calls ?? 0,
      tokens_in: raw.provisional?.tokens_in ?? 0,
      tokens_out: raw.provisional?.tokens_out ?? 0,
    },
    by_card: (raw.by_card ?? []).map((c) => ({ card_id: c.card_id ?? null, cost: price(c.cost), calls: c.calls ?? 0 })),
    by_card_since: raw.by_card_since ?? null,
    totals: {
      cost: price(raw.totals?.cost),
      settled_cost: price(raw.totals?.settled_cost),
      provisional_cost: price(raw.totals?.provisional_cost),
      calls: raw.totals?.calls ?? 0,
      tokens_in: raw.totals?.tokens_in ?? 0,
      tokens_out: raw.totals?.tokens_out ?? 0,
    },
    currency: raw.currency ?? 'USD',
    basis: raw.basis ?? '',
    as_of: raw.as_of ?? new Date().toISOString(),
  };
}

/**
 * R6 / C7 (R-CK6): annotate billing's per-card rows with the card's OWN phase (exact, from the
 * board/spine — never inferred) and the RM capability of the card's type. Pure, so the mapping is
 * unit-tested without a database or a catalogue.
 *
 * `capabilityOf` = the tenant catalogue's card-type-name → capability-name map, or NULL when the
 * read failed. The distinction is load-bearing: a null with a map means "this type is not in the
 * catalogue" (data), a null because there was no map means "the names could not be read"
 * (`capability_source: 'unavailable'`) and the page must say so.
 */
function annotateByCard(
  rows: readonly { card_id: string | null; cost: number | null; calls: number }[],
  cards: readonly Pick<BoardCard, 'id' | 'phase' | 'card_type'>[],
  capabilityOf: ReadonlyMap<string, string> | null,
): { rows: CostCardRow[]; capability_source: CapabilitySource } {
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  let needed = false;
  const annotated = rows.map((r): CostCardRow => {
    const card = r.card_id ? byId.get(r.card_id) : undefined;
    const cardType = card?.card_type && card.card_type.trim() !== '' ? card.card_type.trim() : null;
    if (cardType) needed = true;
    return {
      card_id: r.card_id,
      cost: r.cost,
      calls: r.calls,
      phase: card?.phase ?? null,
      card_type: cardType,
      capability: cardType && capabilityOf ? (capabilityOf.get(cardType) ?? null) : null,
    };
  });
  // No row resolves a card TYPE: there was nothing to name, so the absent capability is data.
  return { rows: annotated, capability_source: needed && capabilityOf === null ? 'unavailable' : 'catalogue' };
}

/** Is a card past To do (anything but the READYING lanes)? */
// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

interface CoreSources {
  key: (name: string) => string;
  approvals: Panel<CockpitApproval[]>;
  boardRaw: Panel<BoardDetail>;
  rm: Panel<RmProjectState>;
  andon: Panel<ProjectAndonView | null>;
  flowRows: Panel<ConveyorFlowRunRow[]>;
  projectCosts: Panel<CockpitProjectCosts>;
}

interface Core extends CoreSources {
  project: Panel<ProjectSummary>;
  status: Panel<CockpitStatus>;
  lifecycleRail: Panel<LifecycleRail>;
  board: Panel<CockpitBoard>;
  flows: Panel<CockpitFlows>;
  cardNames: Map<string, string>;
  boardCardIds: string[];
  closed: boolean;
  /** Break-glass DONE cards (null = the lookup failed). R5 board. */
  overrideIds: ReadonlySet<string> | null;
}

function costLensFor(superAdmin: boolean, markupPct: number | null): CostLens {
  return superAdmin ? { basis: 'incurred' } : markupPct === null ? { basis: 'unavailable' } : { basis: 'billed', markupPct };
}

async function readCoreSources(project: Project, tenantId: string): Promise<CoreSources> {
  const key = (name: string) => `${tenantId}:${project.id}:${name}`;
  const superAdmin = tryGetRequestContext()?.callerIsSuperAdmin === true;
  const T = COCKPIT_TIMEOUTS;
  const boardId = project.planka_board_id;
  const owned = classifyProjectOwnership(project, tenantId) === 'owned';
  const [approvalsP, boardRaw, rm, andon, frFlowRows, projectCosts] = await Promise.all([
    fetchPanel(key('approvals'), 'fr_db', () => loadApprovals(project.id, tenantId), { timeoutMs: T.frDb }),
    boardId
      ? fetchPanel(key('board'), 'planka', () => plankaClient.asAgent().boards.get(boardId), { timeoutMs: T.planka })
      : Promise.resolve(naPanel<BoardDetail>('planka_no_board')),
    fetchPanel(key('rm_state'), 'rm', () => projectTypeAndPhase(project), { timeoutMs: T.rm }),
    fetchPanel(key('andon'), 'fr_db', () => readProjectAndon(project.id), { timeoutMs: T.frDb }),
    fetchPanel(key('flows'), 'fr_db', () => listFlowRuns(project.id, tenantId), { timeoutMs: T.frDb }),
    // ⛔ Same refusal as the cost panel: an untagged / foreign-tagged project never carried its id
    // on a billing event, so billing cannot know its spend and is not asked.
    owned
      ? fetchPanel(
          key(`project_costs:${superAdmin ? 'sa' : 'member'}`),
          'billing',
          async () => {
            const raw = await getProjectCosts({ tenantId, projectId: project.id });
            const markup = superAdmin ? null : await fetchTenantMarkupPct(tenantId);
            return priceProjectCosts(raw, costLensFor(superAdmin, markup));
          },
          { timeoutMs: T.billing },
        )
      : Promise.resolve(naPanel<CockpitProjectCosts>('billing_project_not_attributable')),
  ]);
  const flowRows = await withRmRefRuns(frFlowRows, rm, project.id, tenantId);
  return { key, approvals: approvalsP, boardRaw, rm, andon, flowRows, projectCosts };
}

async function finishCore(project: Project, src: CoreSources, now: number): Promise<Core> {
  const T = COCKPIT_TIMEOUTS;
  const { key } = src;
  const approvalsData = src.approvals.data ?? [];
  const pendingApprovalCardIds = new Set(
    approvalsData.filter((a) => a.status === 'pending' && a.card_id).map((a) => a.card_id as string),
  );
  const board = src.boardRaw.data;
  const cardNames = new Map<string, string>();
  const boardCardIds: string[] = [];
  for (const c of board?.included.cards ?? []) {
    boardCardIds.push(c.id);
    if (c.name) cardNames.set(c.id, c.name);
  }

  // Break-glass DONE cards never count as PUBLISHING; a failed lookup makes the rail unknown, never an overcount.
  const listName = new Map((board?.included.lists ?? []).map((l) => [l.id, l.name ?? null]));
  const doneCardIds = (board?.included.cards ?? [])
    .filter((c) => normalizePhase(listName.get(c.listId) ?? null) === 'PUBLISHING')
    .map((c) => c.id);

  const rmState = src.rm.data;
  const closedByRm = rmState?.pm.status === 'closed';

  const [overrides, railSource, phaseEvents] = await Promise.all([
    doneCardIds.length > 0
      ? fetchPanel(key('overrides'), 'fr_db', () => findHumanOverrideCardIds(doneCardIds), { timeoutMs: T.frDb })
      : Promise.resolve(okPanel(new Set<string>())),
    resolveRailSource(project, rmState, key),
    closedByRm && rmState
      ? fetchPanel(key('phase_events'), 'rm', () => listPhaseEvents(rmState), { timeoutMs: T.rm })
      : Promise.resolve(null),
  ]);

  // ── board views ──
  let boardPanel: Panel<CockpitBoard>;
  if (!board) {
    boardPanel =
      src.boardRaw.health === 'ok'
        ? naPanel<CockpitBoard>(src.boardRaw.detail_code ?? 'planka_no_board')
        : downPanel<CockpitBoard>(src.boardRaw.detail_code ?? 'planka_error', src.boardRaw.down_since);
  } else if (overrides.data === null) {
    boardPanel = downPanel<CockpitBoard>(overrides.detail_code ?? 'fr_db_override_lookup', overrides.down_since);
  } else {
    const views = deriveBoardViews(board, pendingApprovalCardIds, now, overrides.data);
    const h = worstHealth(src.boardRaw.health, overrides.health, src.approvals.data ? 'ok' : 'degraded');
    boardPanel = {
      data: views,
      as_of: src.boardRaw.as_of,
      health: h,
      ...(src.boardRaw.down_since ? { down_since: src.boardRaw.down_since } : {}),
      ...(h !== 'ok'
        ? { detail_code: src.boardRaw.detail_code ?? overrides.detail_code ?? src.approvals.detail_code ?? 'partial' }
        : {}),
    };
  }

  // ── lifecycle rail ──
  let lifecycleRail: Panel<LifecycleRail>;
  if (!rmState) {
    lifecycleRail = downPanel<LifecycleRail>(src.rm.detail_code ?? 'rm_error', src.rm.down_since);
  } else if (railSource.panel.data === null) {
    lifecycleRail = downPanel<LifecycleRail>(railSource.panel.detail_code ?? 'rm_phase_list', railSource.panel.down_since);
  } else {
    const b = deriveLifecycleRail(rmState.phase, rmState.phaseUpdatedAt, railSource.panel.data);
    lifecycleRail = b.data
      ? {
          data: b.data,
          as_of: src.rm.as_of,
          health: worstHealth(src.rm.health, railSource.panel.health),
          ...(src.rm.down_since ? { down_since: src.rm.down_since } : {}),
          ...(src.rm.detail_code || railSource.panel.detail_code
            ? { detail_code: src.rm.detail_code ?? railSource.panel.detail_code }
            : {}),
        }
      : downPanel<LifecycleRail>('rm_phase_not_in_phase_list');
  }

  // ── project summary ──
  // RM closed ⇒ reads delivered, derived per read (services/project-delivered.ts;
  // the reconcile worker is the only writer, and this read writes nothing).
  const delivery = deliveryFromRm(project, rmState);
  const projectSummary: ProjectSummary = {
    id: project.id,
    name: project.name,
    status: delivery.status,
    delivered_at: delivery.delivered_at ? delivery.delivered_at.toISOString() : null,
    delivery_evidence: (delivery.delivery_evidence as Record<string, unknown> | null) ?? null,
    project_phase: rmState?.phase ?? null,
    project_type: rmState?.projectType ?? null,
    rm_status: rmState?.pm.status ?? null,
    shape: project.shape,
    planka_board_id: project.planka_board_id,
    n8n_project_id: project.n8n_project_id,
    repository_url: project.repository_url,
    coordination_mode: project.coordination_mode,
    conveyor_linked: conveyorLinkedOf(src.rm),
    // R-CK3: RM's budget is REPORTING ONLY. A non-finite / absent value is "no budget", never 0.
    budget: typeof rmState?.pm.budget === 'number' && Number.isFinite(rmState.pm.budget) ? rmState.pm.budget : null,
    // R6: a null budget is a FACT only when the RM state behind it was readable (a healthy read, or
    // a last-known state the panel marks degraded). When RM could not be read at all, "no budget
    // set" would be a claim we cannot make — the budget is UNKNOWN, and this says so.
    budget_known: src.rm.health === 'ok' || rmState !== null,
    currency: typeof rmState?.pm.currency === 'string' && rmState.pm.currency.trim() !== '' ? rmState.pm.currency.trim() : null,
  };
  // The row itself cannot fail; the RM half (phase/type/status) can, and then the panel says so.
  const projectPanel: Panel<ProjectSummary> =
    src.rm.health === 'ok'
      ? okPanel(projectSummary, new Date(now))
      : {
          data: projectSummary,
          as_of: new Date(now).toISOString(),
          health: 'degraded',
          detail_code: src.rm.detail_code ?? 'rm_error',
          ...(src.rm.down_since ? { down_since: src.rm.down_since } : {}),
        };

  // ── flows ──
  const flowsData = src.flowRows.data ? composeFlows(src.flowRows.data) : null;
  let flows: Panel<CockpitFlows>;
  if (!flowsData) {
    flows = { ...(src.flowRows as unknown as Panel<CockpitFlows>), data: null };
  } else if (!flowsData.connected && projectSummary.conveyor_linked) {
    flows = degradedPanel(flowsData, 'flow_data_not_connected', src.flowRows.as_of ?? new Date(now));
  } else {
    flows = { ...src.flowRows, data: flowsData } as Panel<CockpitFlows>;
  }

  // ── status (C1) ──
  const closed = closedByRm || project.status === 'archived' || project.status === 'delivered';
  const views = boardPanel.data;
  const derived = deriveCockpitState({
    frStatus: project.status,
    rmStatus: rmState?.pm.status ?? null,
    andonEngaged: src.andon.data?.engaged ?? project.andon_engaged === true,
    openApprovals: approvalsData.filter((a) => a.status === 'pending').length,
    blockedCards: (views?.blocked_cards ?? []).filter((c) => c.blocked_reason !== 'awaiting approval').length,
    unresolvedFlowFailures: flowsData?.unresolved_failures.length ?? 0,
  });
  const endedAt = closed ? (phaseEvents?.data?.[0]?.at ?? null) : null;
  const upstream = worstHealth(
    src.approvals.health,
    board || src.boardRaw.health !== 'ok' ? boardPanel.health : 'ok',
    src.rm.health,
    src.andon.health,
    lifecycleRail.health,
  );
  // "Phase N of M": the type's phases + Closure; Closure is current once a closure card moved.
  const chain = withClosure(lifecycleRail.data?.nodes ?? []);
  let currentPhase: string | null = rmState?.phase ?? null;
  if (chain.some((n) => n.phase === CLOSURE_PHASE) && !(lifecycleRail.data?.nodes ?? []).some((n) => n.phase === CLOSURE_PHASE)) {
    const names = new Set(chain.map((n) => n.phase));
    const closureMoved = spineCardsOf(board ?? null).some(
      (c) => exactCardPhase(c, names).phase === CLOSURE_PHASE && c.list_phase !== 'READYING',
    );
    if (closed || closureMoved) currentPhase = CLOSURE_PHASE;
  }
  const currentIdx = currentPhase ? chain.findIndex((n) => n.phase === currentPhase) : -1;
  const costs = src.projectCosts.data;
  const status: CockpitStatus = {
    state: derived.state,
    reasons: derived.reasons,
    project_type: rmState?.projectType ?? null,
    phase: rmState?.phase ?? null,
    next_gate: closed ? null : (lifecycleRail.data?.next_gate ?? null),
    started_at: safeIso(project.created_at),
    ended_at: endedAt,
    open_approvals: approvalsData.filter((a) => a.status === 'pending').length,
    current_phase: currentIdx >= 0 ? currentPhase : null,
    current_phase_label: currentIdx >= 0 ? (chain[currentIdx]?.label ?? null) : null,
    phase_position: currentIdx >= 0 ? currentIdx + 1 : null,
    phase_count: chain.length > 0 ? chain.length : null,
    cost: costs ? { total: costs.totals.cost, calls: costs.totals.calls, currency: costs.currency, basis: costs.cost_basis } : null,
    health: { flows: flows.health, upstream, cost: src.projectCosts.health },
  };
  // The chip is only as sure as what it was derived from.
  const statusInputs = [src.rm, src.approvals, src.andon, src.flowRows, boardPanel];
  const statusHealth = worstHealth(...statusInputs.map((p) => (p.health === 'down' ? 'degraded' : p.health)));
  const firstBad = statusInputs.find((p) => p.health !== 'ok');
  const statusPanel: Panel<CockpitStatus> =
    statusHealth === 'ok'
      ? okPanel(status, new Date(now))
      : degradedPanel(status, firstBad?.detail_code ?? 'partial', new Date(now));

  return {
    ...src,
    project: projectPanel,
    status: statusPanel,
    lifecycleRail,
    board: boardPanel,
    flows,
    cardNames,
    boardCardIds,
    closed,
    overrideIds: board && doneCardIds.length > 0 ? overrides.data : new Set<string>(),
  };
}

async function resolveRailSource(
  project: Project,
  rmState: RmProjectState | null,
  key: (n: string) => string,
): Promise<{ panel: Panel<LifecycleRailSource> }> {
  if (!rmState) return { panel: downPanel('rm_state') };
  const T = COCKPIT_TIMEOUTS;
  if (project.template_id) {
    const p = await fetchPanel(
      key('rail_plan'),
      'fr_db',
      async (): Promise<LifecycleRailSource> => {
        const loaded = await loadPlanForRail(project.id);
        return 'unresolvable' in loaded
          ? { kind: 'unresolvable', reason: loaded.unresolvable }
          : { kind: 'plan', plan: loaded.plan, labels: loaded.labels };
      },
      { timeoutMs: T.rm },
    );
    return { panel: p };
  }
  const p = await fetchPanel(
    key('type_phases'),
    'rm',
    async (): Promise<LifecycleRailSource> => ({ kind: 'type', phases: await phasesOfState(rmState) }),
    { timeoutMs: T.rm },
  );
  return { panel: p };
}

/** `?scope=header`: the project + status panels only (the shell header on every project page). */
export async function buildProjectCockpitHeader(
  project: Project,
  tenantId: string,
): Promise<ProjectCockpitHeader> {
  const now = Date.now();
  // The artifacts read starts WITH the core reads, not after them: the header is on every project
  // page, and a serial artifacts call would add its whole latency to each. `fetchPanel` never
  // throws (a slow / failed read degrades the `needs_you` panel), so it cannot fail the header.
  const artifactsRead = fetchPanel(`${tenantId}:${project.id}:artifacts`, 'artifacts', () => listArtifacts(project.id), {
    timeoutMs: COCKPIT_TIMEOUTS.artifacts,
  });
  const src = await readCoreSources(project, tenantId);
  const [core, rawArtifacts] = await Promise.all([finishCore(project, src, now), artifactsRead]);
  const artifactRows = rawArtifacts.data;
  const items = deriveActions({
    approvals: src.approvals.data ?? [],
    artifacts: artifactRows ? filterActionableArtifacts(artifactRows) : [],
    reports: [],
    cardNames: core.cardNames,
    documentLabels: artifactRows ? documentLabels(artifactRows as TrailArtifact[], core.cardNames) : undefined,
    closed: core.closed,
  });
  return {
    scope: 'header',
    project: core.project,
    status: core.status,
    needs_you: actionsPanel(items.length, src.approvals, rawArtifacts, core.closed, now),
  };
}

/**
 * The health of the C2 list (`actions`) and of its count (`needs_you`): ONE rule for both, so the
 * rail badge and the Needs you page can never disagree about whether the number is complete.
 */
function actionsPanel<T>(
  data: T,
  approvalsPanel: Panel<unknown>,
  artifactsPanel: Panel<unknown>,
  closed: boolean,
  now: number,
): Panel<T> {
  if (closed) return okPanel(data, new Date(now));
  if (approvalsPanel.data === null && artifactsPanel.data === null) {
    return downPanel<T>(approvalsPanel.detail_code ?? 'fr_db_error', approvalsPanel.down_since);
  }
  const bad = [approvalsPanel, artifactsPanel].find((p) => p.health !== 'ok');
  return bad ? degradedPanel(data, bad.detail_code ?? 'partial', new Date(now)) : okPanel(data, new Date(now));
}

function slice<T, K extends keyof T>(p: Panel<T>, k: K): Panel<T[K]> {
  return { ...(p as unknown as Panel<T[K]>), data: p.data ? p.data[k] : null };
}

/**
 * R6 / C7: the `project_costs` panel with its per-card rows annotated (phase + capability).
 *
 * The catalogue read happens ONLY when at least one cost row resolves to a board card that carries
 * a `card_type` — an unattributed project, or a project whose cards name no type, reads nothing.
 * A failed catalogue read does NOT degrade the panel: the amounts are billing's and are still
 * correct; only the capability names are unavailable, and `capability_source` says so.
 *
 * `boardState` is the board's state, carried onto the rows as BOTH `board_available` (the boolean
 * older readers use) and `board_state` (the tri-state, so `planka_no_board` is worded as the fact it
 * is and never as a read failure). When it is not 'ok' EVERY row is unannotated, and the fields say
 * so — without them the page would read "not recorded as tied to a phase" as a property of the
 * cards, which is a claim about a board nobody could read (or that does not exist).
 */
async function annotateProjectCosts(
  panel: Panel<CockpitProjectCosts>,
  cards: readonly BoardCard[],
  boardState: CostBoardState,
  tenantId: string,
): Promise<Panel<CockpitProjectCosts>> {
  const data = panel.data;
  if (!data) return panel;
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const needsCatalogue = data.by_card.some((r) => {
    const card = r.card_id ? byId.get(r.card_id) : undefined;
    return !!(card?.card_type && card.card_type.trim() !== '');
  });
  let map: Map<string, string> | null = null;
  if (needsCatalogue) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      map = await Promise.race([
        cardTypeCapabilityMap(tenantId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('the tenant catalogue did not answer in time')),
            COCKPIT_TIMEOUTS.catalogue,
          );
        }),
      ]);
    } catch (err) {
      reportSwallowedFailure(err, {
        service: 'requirements_management',
        path: 'tenant catalogue: card type → capability',
        degradedTo: 'cost rows without capability names',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const { rows, capability_source } = annotateByCard(data.by_card, cards, map);
  return {
    ...panel,
    data: {
      ...data,
      by_card: rows,
      capability_source,
      board_available: boardState === 'ok',
      board_state: boardState,
    },
  };
}

export async function buildProjectCockpit(
  project: Project,
  tenantId: string,
): Promise<ProjectCockpit> {
  const now = Date.now();
  const T = COCKPIT_TIMEOUTS;
  const src = await readCoreSources(project, tenantId);
  const key = src.key;
  const superAdmin = tryGetRequestContext()?.callerIsSuperAdmin === true;
  const owned = classifyProjectOwnership(project, tenantId) === 'owned';
  const conveyorLinked = conveyorLinkedOf(src.rm);
  const rmState = src.rm.data;
  const board = src.boardRaw.data;
  const boardCardIds = (board?.included.cards ?? []).map((c) => c.id);

  const [core, mappings, scopeRows, repositories, rawArtifacts, cost, capabilities, history, assetUsage, storedReports, phaseEvents] =
    await Promise.all([
      finishCore(project, src, now),
      fetchPanel(key('mappings'), 'fr_db', () => loadRecentMappings(project.id), { timeoutMs: T.frDb }),
      fetchPanel(key('scope'), 'fr_db', () => loadApprovedScope(project.id), { timeoutMs: T.frDb }),
      fetchPanel(key('repositories'), 'fr_db', () => loadProjectRepositories(project.id), { timeoutMs: T.frDb }),
      fetchPanel(key('artifacts'), 'artifacts', () => listArtifacts(project.id), { timeoutMs: T.artifacts }),
      owned
        ? fetchPanel(
            key(`cost:${superAdmin ? 'sa' : 'member'}`),
            'billing',
            async () => {
              const b = await buildProjectCostBlock(project, tenantId, now);
              if (!b.meta.available || b.data === null) throw new Error('billing cost read failed');
              return b.data;
            },
            { timeoutMs: T.billing },
          )
        : Promise.resolve(naPanel<ProjectCost>('billing_project_not_attributable')),
      rmState
        ? fetchPanel(
            key('capabilities'),
            'rm',
            async (): Promise<CockpitCapabilities> => {
              const { capabilities: c, events } = await capabilitiesOfState(rmState);
              return {
                project_type: c.project_type ?? null,
                selected: Array.isArray(c.selected) ? c.selected : [],
                implicit: Array.isArray(c.implicit) ? c.implicit : [],
                events,
                total_events: events.length,
              };
            },
            { timeoutMs: T.rm, freshForMs: COCKPIT_FRESH_FOR.capabilities },
          )
        : Promise.resolve(downPanel<CockpitCapabilities>(src.rm.detail_code ?? 'rm_state', src.rm.down_since)),
      conveyorLinked
        ? fetchPanel(
            key('conveyor_history'),
            'conveyor_history',
            async (): Promise<CockpitConveyorHistory> => {
              const h = await buildConveyorHistory(
                { id: project.id, planka_board_id: project.planka_board_id ?? null, tenant_tag: projectKcTenantTag(project) ?? null },
                tenantId,
                { board: board ?? undefined },
              );
              return {
                conversation: panelFromBlock(h.conversation, 'fr_db'),
                cards: panelFromBlock(h.cards, 'planka'),
                delivered: panelFromBlock(h.delivered, 'planka'),
              };
            },
            { timeoutMs: T.history, freshForMs: COCKPIT_FRESH_FOR.history },
          )
        : Promise.resolve(naPanel<CockpitConveyorHistory>('conveyor_not_linked')),
      fetchPanel(key('asset_usage'), 'fr_db', () => loadAssetUsage(project.id, boardCardIds), { timeoutMs: T.frDb }),
      fetchPanel(key('stored_reports'), 'fr_db', () => loadStoredReports(project.id, tenantId), { timeoutMs: T.frDb }),
      rmState
        ? fetchPanel(key('spine_phase_events'), 'rm', () => listPhaseEvents(rmState), { timeoutMs: T.rm })
        : Promise.resolve(downPanel<PhaseEventIn[]>(src.rm.detail_code ?? 'rm_state', src.rm.down_since)),
    ]);

  // ── execution + timeline (need the mappings) ──
  const mappingRows = mappings.data ?? [];
  const mostRecent = mappingRows[0];
  const correlations = [...new Set(mappingRows.map((m) => m.correlation_id))].slice(0, WM_CORRELATION_FANOUT);
  const [currentExecution, sessions] = await Promise.all([
    mappings.data === null
      ? Promise.resolve(downPanel<CurrentExecution | null>(mappings.detail_code ?? 'fr_db_mappings', mappings.down_since))
      : fetchPanel(
          key('current_execution'),
          'n8n',
          async (): Promise<CurrentExecution | null> => {
            if (!mostRecent) return null;
            const execId = Number(mostRecent.execution_id);
            if (Number.isNaN(execId)) return null;
            const exec = await getExecution(execId);
            const st = exec.status ?? 'unknown';
            if (!N8N_ACTIVE_STATUSES.has(st)) return null;
            return {
              execution_id: mostRecent.execution_id,
              workflow_id: mostRecent.workflow_id,
              correlation_id: mostRecent.correlation_id,
              status: st,
              started_at: exec.startedAt ?? null,
              triggered_at: toIso(mostRecent.triggered_at),
            };
          },
          { timeoutMs: T.n8n },
        ),
    correlations.length === 0
      ? Promise.resolve(okPanel<GraphExecutionSession[]>([]))
      : fetchPanel(
          key('wm_sessions'),
          'workers',
          async () => {
            const all: GraphExecutionSession[] = [];
            for (const cid of correlations) {
              const res = await listGraphExecutionSessions({ correlation_id: cid, limit: 10 });
              all.push(...res.sessions);
            }
            return all;
          },
          { timeoutMs: T.workers },
        ),
  ]);

  const views = core.board.data;
  const derivedCards = views ? [...views.active_cards, ...views.blocked_cards] : [];
  // ⛔ A timeline composed without the mapping history is a WRONG timeline presented as complete:
  // a failed mappings read makes it `down`, never a shorter list.
  const timeline: Panel<TimelineEvent[]> =
    mappings.data === null
      ? downPanel<TimelineEvent[]>(mappings.detail_code ?? 'fr_db_mappings', mappings.down_since)
      : (() => {
          const events = composeTimeline({
            mappings: mappingRows,
            sessions: sessions.data ?? [],
            approvals: src.approvals.data ?? [],
            cards: derivedCards,
            now,
            cardNames: core.cardNames,
          });
          const h = worstHealth(
            mappings.health,
            sessions.health === 'down' ? 'degraded' : sessions.health,
            src.approvals.health === 'down' ? 'degraded' : src.approvals.health,
          );
          const bad = [mappings, sessions, src.approvals].find((p) => p.health !== 'ok');
          return h === 'ok' ? okPanel(events, new Date(now)) : degradedPanel(events, bad?.detail_code ?? 'partial', new Date(now));
        })();

  // ── artifacts + reports (one read) ──
  const artifactRows = rawArtifacts.data;
  const artifactsPanel: Panel<CockpitArtifact[]> = {
    ...(rawArtifacts as unknown as Panel<CockpitArtifact[]>),
    data: artifactRows ? filterActionableArtifacts(artifactRows) : null,
  };
  const reportsPanel: Panel<CockpitReport[]> = {
    ...(rawArtifacts as unknown as Panel<CockpitReport[]>),
    data: artifactRows ? selectConveyorReports(artifactRows, core.cardNames) : null,
  };

  // ── C2 actions ──
  const actionsData = deriveActions({
    approvals: src.approvals.data ?? [],
    artifacts: artifactsPanel.data ?? [],
    reports: reportsPanel.data ?? [],
    cardNames: core.cardNames,
    documentLabels: artifactRows ? documentLabels(artifactRows as TrailArtifact[], core.cardNames) : undefined,
    closed: core.closed,
  });
  const actions: Panel<CockpitActionItem[]> = actionsPanel(actionsData, src.approvals, artifactsPanel, core.closed, now);

  // ── goal ──
  const openGates = (src.approvals.data ?? []).filter((a) => a.status === 'pending').length;
  const goalData = deriveGoal(views ? views.phase_rail : null, openGates);
  const goalHealth = worstHealth(
    core.board.data ? core.board.health : core.board.health === 'ok' ? 'ok' : 'degraded',
    src.approvals.health === 'down' ? 'degraded' : src.approvals.health,
  );
  const goal = goalHealth === 'ok' ? okPanel(goalData, new Date(now)) : degradedPanel(goalData, core.board.detail_code ?? src.approvals.detail_code ?? 'partial', new Date(now));

  // ── approved scope ──
  const deliverables: Panel<ApprovedScope> = {
    ...(scopeRows as unknown as Panel<ApprovedScope>),
    data: scopeRows.data
      ? {
          deliverables: scopeRows.data.deliverables,
          milestones: scopeRows.data.milestones,
          approved_effort_estimate: toApprovedEffort(project.approved_effort_estimate),
        }
      : null,
  };

  // ── C3 spine + C8 decision log (phases are EXACT: the card's own field / closure type) ──
  const boardCards = spineCardsOf(board ?? null);
  const nodes = core.lifecycleRail.data?.nodes ?? [];
  const spineData =
    core.lifecycleRail.data === null
      ? null
      : composeSpine({
          nodes,
          events: phaseEvents.data ?? [],
          approvals: src.approvals.data ?? [],
          cards: boardCards,
          closed: core.closed,
          now,
        });
  const cardPhases = new Map<string, string>();
  for (const c of spineData?.cards ?? []) if (c.phase) cardPhases.set(c.id, c.phase);
  const decisionsData = composeDecisionLog({
    approvals: src.approvals.data ?? [],
    cardNames: core.cardNames,
    cardPhases,
  });
  const decisions: Panel<CockpitDecision[]> =
    src.approvals.data === null
      ? downPanel<CockpitDecision[]>(src.approvals.detail_code ?? 'fr_db_error', src.approvals.down_since)
      : src.approvals.health === 'ok'
        ? okPanel(decisionsData, new Date(now))
        : degradedPanel(decisionsData, src.approvals.detail_code ?? 'partial', new Date(now));
  let spine: Panel<CockpitSpine>;
  if (spineData === null) {
    spine = downPanel<CockpitSpine>(core.lifecycleRail.detail_code ?? 'rm_phase_list', core.lifecycleRail.down_since);
  } else {
    const parts = [core.lifecycleRail, phaseEvents, src.approvals, src.boardRaw];
    const bad = parts.find((p) => p.health !== 'ok');
    spine = bad ? degradedPanel(spineData, bad.detail_code ?? 'partial', new Date(now)) : okPanel(spineData, new Date(now));
  }
  for (const item of actionsData) item.phase = item.card_id ? (cardPhases.get(item.card_id) ?? null) : null;

  // ── R5 board (C4): columns, time in column, blocked reasons, exact phase per card ──
  const boardPanel: Panel<ProjectBoard> = !board
    ? { ...(src.boardRaw as unknown as Panel<ProjectBoard>), data: null }
    : (() => {
        const placed = new Map((spineData?.cards ?? []).map((c) => [c.id, { phase: c.phase, placed_by: c.placed_by }] as const));
        const data = composeBoard({
          boardId: project.planka_board_id ?? null,
          board: board as unknown as BoardIn,
          normalize: normalizePhase,
          phases: placed,
          approvals: (src.approvals.data ?? []).map((a) => ({
            id: a.id,
            status: a.status,
            card_id: a.card_id,
            description: a.description,
            created_at: a.created_at,
          })),
          flowFailures: core.flows.data?.unresolved_failures ?? [],
          humanOverrideCardIds: core.overrideIds ?? undefined,
        });
        // Without the spine every card reads "not tied to a phase"; without approvals or flows a
        // wait or a failure may be missing — the panel says it is partial, never complete.
        const parts = [src.boardRaw, spine, src.approvals, core.flows];
        const bad = parts.find((p) => p.health !== 'ok' && p.detail_code !== 'flow_data_not_connected');
        return bad || core.overrideIds === null
          ? degradedPanel(data, bad?.detail_code ?? 'fr_db_override_lookup', new Date(now))
          : okPanel(data, new Date(now));
      })();

  // ── R2 overview: the project as a chain of phases ──
  const historyData = history.data;
  const deliveredPrs = historyData && historyData.delivered.data ? historyData.delivered.data.pull_requests : null;
  const costsData = src.projectCosts.data;
  const overviewData = composeOverview({
    projectId: project.id,
    state: core.status.data?.state ?? 'running',
    spine: spineData,
    decisions: decisionsData,
    artifacts: artifactRows as ArtifactOut[] | null,
    pullRequests: deliveredPrs,
    byCard: costsData ? { rows: costsData.by_card, since: costsData.by_card_since, currency: costsData.currency } : null,
    flowFailures: core.flows.data?.unresolved_failures ?? [],
    blockedCards: (views?.blocked_cards ?? [])
      .filter((c) => c.blocked_reason !== 'awaiting approval')
      .map((c) => ({ id: c.id, name: c.name, age_in_phase_ms: c.age_in_phase_ms, blocked_reason: c.blocked_reason })),
    cardNames: core.cardNames,
    now,
  });
  // A flow feed that is merely "not connected yet" does not make the overview partial; one that
  // could not be read does (its problem lines would be missing).
  const overviewParts = [spine, decisions, rawArtifacts, src.projectCosts, ...(core.flows.data === null ? [core.flows] : [])];
  const overviewBad = overviewParts.find((p) => p.health !== 'ok');
  const overview: Panel<ProjectOverview> =
    spineData === null
      ? downPanel<ProjectOverview>(spine.detail_code ?? 'rm_phase_list', spine.down_since)
      : overviewBad
        ? degradedPanel(overviewData, overviewBad.detail_code ?? 'partial', new Date(now))
        : okPanel(overviewData, new Date(now));

  // ── R6 / C7: per-card spend annotated with its card's OWN phase and RM capability ──
  // The board's TRI-STATE is carried onto the rows: `boardPanel.data === null` alone cannot say
  // whether the board could not be read (`health !== 'ok'`, a failure) or the project HAS no board
  // (`health: 'ok'` + `planka_no_board`, a fact) — the Cost and Plan pages word those differently.
  const boardState: CostBoardState =
    boardPanel.data !== null ? 'ok' : boardPanel.health === 'ok' ? 'no_board' : 'unavailable';
  const projectCosts = await annotateProjectCosts(
    src.projectCosts,
    boardPanel.data?.cards ?? [],
    boardState,
    tenantId,
  );

  return {
    scope: 'full',
    project: core.project,
    status: core.status,
    actions,
    lifecycle_rail: core.lifecycleRail,
    phase_rail: slice(core.board, 'phase_rail'),
    active_cards: slice(core.board, 'active_cards'),
    blocked_cards: slice(core.board, 'blocked_cards'),
    approvals: src.approvals,
    current_execution: currentExecution,
    timeline_events: timeline,
    flows: core.flows,
    asset_usage: assetUsage,
    goal,
    artifacts: artifactsPanel,
    reports: reportsPanel,
    stored_reports: storedReports,
    cost,
    project_costs: projectCosts,
    deliverables,
    repositories,
    capabilities,
    conveyor_history: history,
    spine,
    decisions,
    overview,
    board: boardPanel,
  };
}

/** The board's cards as the spine needs them: list phase, creation time, the card's own `phase` field. */
function spineCardsOf(board: BoardDetail | null): BoardCardIn[] {
  if (!board) return [];
  const inc = board.included as BoardDetail['included'] & {
    customFields?: Array<{ id: string; name?: string | null }>;
    customFieldValues?: Array<{ cardId: string; customFieldId: string; content?: unknown }>;
  };
  const listName = new Map((inc.lists ?? []).map((l) => [l.id, l.name ?? null]));
  const phaseFieldIds = new Set((inc.customFields ?? []).filter((f) => f.name === 'phase').map((f) => f.id));
  const typeFieldIds = new Set((inc.customFields ?? []).filter((f) => f.name === 'card_type').map((f) => f.id));
  const phaseOf = new Map<string, string>();
  const typeOf = new Map<string, string>();
  for (const v of inc.customFieldValues ?? []) {
    const c = typeof v.content === 'string' ? v.content.trim() : '';
    if (!c) continue;
    if (phaseFieldIds.has(v.customFieldId)) phaseOf.set(v.cardId, c);
    else if (typeFieldIds.has(v.customFieldId)) typeOf.set(v.cardId, c);
  }
  return (inc.cards ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? null,
    list_phase: normalizePhase(listName.get(c.listId) ?? null),
    created_at: (c as { createdAt?: string | null }).createdAt ?? null,
    phase_field: phaseOf.get(c.id) ?? null,
    card_type: typeOf.get(c.id) ?? null,
  }));
}
