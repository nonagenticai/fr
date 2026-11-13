// src/lib/plan-phase-exit.ts
//
// U-PS-PHASEEXIT (fr#1481) — the READ MODEL of a plan project's phase exits
// (CONVEYOR-TAXONOMY-DESIGN D4; PROJECT-START-PROCESS-DESIGN §6.1, §10.1).
//
// ⛔ READ-ONLY. George 2026-10-13: n8n is the ONLY writer of a project's phase
// (PATCH /api/projects/:id/phase). The computed writer that used to live here
// (`planPhaseExit`, its card.done / approval-completion triggers, its periodic
// sweep and its mint-on-entry) was DELETED. What remains is what fr DISPLAYS:
// GET /api/projects/:id/plan (`computePlanFacts`) and the plan rail
// (`planRailNodes`, `planNextGate`, `loadPlanForRail`). Do not add a write here.
//
// ── WHO IS A PLAN PROJECT ────────────────────────────────────────────────────
// `projects.template_id IS NOT NULL` (migration 168, written only by promote).
// Its plan is the APPROVED outline version named by
// `project_data.contract_close.outline_id` (lib/project-start-template.ts),
// whose `phase_plan` (migration 167) must name the same template@hash. Anything
// else is LEGACY.
//
// ── THE PREDICATE (pure: `evaluatePlanPhases`) ──────────────────────────────
// Deliverable placement comes from `phase_plan.deliverables[]` (pm Deliverable
// {id, phase, card_types, cardinality, minter}); the approved-scope row joins
// by `project_deliverables.plan_deliverable_id` (migration 171). A deliverable's
// cards are the `card_contracts` rows whose `covers` names the row id and whose
// card_id is bound — the attachment the decomposition commit writes
// (`covers = [deliverable.id]`). Completion is `lib/deliverable-complete.ts`.
// Fail-closed:
//   * a plan deliverable with no row            → `deliverable_row_missing`;
//   * a card the board does not show in a DONE-equivalent list (or a break-glass
//     `human_override` DONE, which is never scored as done work) → not DONE;
//   * a gate kind this module cannot map to an approval predicate
//     (`gate_kind_unknown`) → the gate is NOT satisfied;
//   * the LAST phase of the plan never "exits" (there is nowhere to go).
//
// Gate kinds (pm TemplatePhase.gate slugs) map to ONE approved approval of the
// project: a slug naming an `approval_kind` enum value (`execution.<slug>` or
// `qa.<slug>`) constrains `approvals.kind`; a slug naming a metadata marker
// (only `bug_fix_authorization`, services/approvals/u3-gates.ts) constrains
// `metadata.approval_kind`. A1 = ['ready_signoff', 'bug_fix_authorization'] ⇒
// an APPROVED `execution.ready_signoff` row carrying the marker. Two kind slugs
// in one gate ⇒ one approved row per kind, each carrying every marker.

import { and, arrayOverlaps, eq, isNotNull } from 'drizzle-orm';

import { db } from '../db/client';
import {
  approvals,
  cardContracts,
  projectDeliverables,
  projectOutlines,
  projects,
} from '../db/schema';
import { deliverableCompletion, type DeliverableIncompleteReason } from './deliverable-complete';
import { gateRequirement, storedPhasePlan, type PhasePlan, type PlanDeliverable } from './phase-plan';
import type { RailNode } from './project-phase';
import { phaseTitles, projectCatalogueTenant, SETUP_PHASE } from '../services/catalogue/tenant-catalogue';
import { isDoneEquivalentListName } from './done-equivalent';

// ── vocabulary ──────────────────────────────────────────────────────────────

// The gate-slug vocabulary (PLAN_GATE_MARKERS, gateRequirement) lives in
// ./phase-plan so the plan PARSE (outline webhook, promote) refuses an
// unmappable slug with the SAME mapping this module evaluates (fr#1481 F3).
export { PLAN_GATE_MARKERS, gateRequirement, type GateRequirement } from './phase-plan';

export type PlanIncompleteReason = DeliverableIncompleteReason | 'deliverable_row_missing';

export interface ApprovedGateRow {
  id: string;
  kind: string;
  approval_kind_marker: string | null;
}

export interface GateFact {
  kinds: string[];
  satisfied: boolean;
  approval_ids: string[];
  unknown_kinds: string[];
}

export interface CardState {
  list: string | null;
  done: boolean;
}

export interface PlanDeliverableFact {
  plan_deliverable_id: string;
  phase: string;
  card_types: string[];
  cardinality: string;
  minter: string;
  deliverable_id: string | null;
  title: string | null;
  deferred: boolean | null;
  minted_at: string | null;
  minted_count: number | null;
  cards: { total: number; done: number; by_list: Record<string, number> };
  complete: boolean;
  incomplete_reason: PlanIncompleteReason | null;
}

export interface PlanPhaseFact {
  phase: string;
  label: string;
  index: number;
  state: 'done' | 'active' | 'upcoming';
  gate: GateFact | null;
  deliverables: PlanDeliverableFact[];
  /** Every placed deliverable complete AND the gate (if any) satisfied. */
  exit_ready: boolean;
  /** Why it is not exit-ready (empty when it is). */
  blockers: string[];
  /** Where an exit goes; null on the plan's last phase. */
  next_phase: string | null;
}

// ── pure: gates ─────────────────────────────────────────────────────────────

export function evaluateGate(
  slugs: readonly string[],
  approvalKinds: readonly string[],
  approved: readonly ApprovedGateRow[],
): GateFact {
  const req = gateRequirement(slugs, approvalKinds);
  const ids: string[] = [];
  let satisfied = req.unknown.length === 0 && req.groups.length > 0;
  for (const g of req.groups) {
    const hit = approved.find(
      (a) => (g.kind === null || a.kind === g.kind) && g.markers.every((m) => a.approval_kind_marker === m),
    );
    if (hit) ids.push(hit.id);
    else satisfied = false;
  }
  return { kinds: [...slugs], satisfied, approval_ids: ids, unknown_kinds: req.unknown };
}

// ── pure: the whole plan's facts ────────────────────────────────────────────

export interface PlanRow {
  id: string;
  plan_deliverable_id: string | null;
  title: string;
  deferred: boolean;
  minted_at: Date | string | null;
  minted_count: number | null;
}

export interface PlanFactInputs {
  plan: PhasePlan;
  /** RM's current phase (`setup` at create — v4 D16); null only as a defensive fallback. */
  currentPhase: string | null;
  rows: readonly PlanRow[];
  /** row id → bound card ids attached to it. */
  cardsByRow: ReadonlyMap<string, readonly string[]>;
  /** card id → its board state. A card absent from the map is NOT done. */
  cardStates: ReadonlyMap<string, CardState>;
  approved: readonly ApprovedGateRow[];
  approvalKinds: readonly string[];
  /** phase name → the tenant's RM title (a phase without one is shown by its name). */
  labels: ReadonlyMap<string, string>;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

export function evaluatePlanPhases(i: PlanFactInputs): PlanPhaseFact[] {
  const byPlanId = new Map<string, PlanRow>();
  for (const r of i.rows) if (r.plan_deliverable_id) byPlanId.set(r.plan_deliverable_id, r);
  const currentIdx = i.currentPhase === null ? -1 : i.plan.phases.indexOf(i.currentPhase);
  const deliverables = (i.plan.deliverables ?? []) as PlanDeliverable[];

  return i.plan.phases.map((phase, idx): PlanPhaseFact => {
    const placed = deliverables.filter((d) => d.phase === phase).map((d): PlanDeliverableFact => {
      const row = byPlanId.get(d.id) ?? null;
      const cardIds = row ? (i.cardsByRow.get(row.id) ?? []) : [];
      const by_list: Record<string, number> = {};
      let done = 0;
      const attached = cardIds.map((id) => {
        const st = i.cardStates.get(id);
        const list = st?.list ?? '(not on board)';
        by_list[list] = (by_list[list] ?? 0) + 1;
        if (st?.done) done += 1;
        return { done: st?.done === true };
      });
      let complete = false;
      let reason: PlanIncompleteReason | null = 'deliverable_row_missing';
      if (row) {
        const c = deliverableCompletion(row, attached);
        complete = c.complete;
        reason = c.complete ? null : c.reason;
      }
      return {
        plan_deliverable_id: d.id,
        phase: d.phase,
        card_types: d.card_types,
        cardinality: d.cardinality,
        minter: d.minter,
        deliverable_id: row?.id ?? null,
        title: row?.title ?? null,
        deferred: row?.deferred ?? null,
        minted_at: row ? toIso(row.minted_at) : null,
        minted_count: row?.minted_count ?? null,
        cards: { total: cardIds.length, done, by_list },
        complete,
        incomplete_reason: reason,
      };
    });
    const slugs = i.plan.gates?.[phase] ?? [];
    const gate = slugs.length > 0 ? evaluateGate(slugs, i.approvalKinds, i.approved) : null;
    const blockers: string[] = [];
    for (const d of placed) if (!d.complete) blockers.push(`deliverable ${d.plan_deliverable_id}: ${d.incomplete_reason}`);
    if (gate && !gate.satisfied) {
      blockers.push(
        gate.unknown_kinds.length > 0
          ? `gate_kind_unknown: ${gate.unknown_kinds.join(', ')}`
          : `gate not approved: ${gate.kinds.join(' + ')}`,
      );
    }
    const next = i.plan.phases[idx + 1] ?? null;
    if (!next) blockers.push('final_phase');
    return {
      phase,
      label: i.labels.get(phase) ?? phase,
      index: idx,
      state: currentIdx < 0 ? 'upcoming' : idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'upcoming',
      gate,
      deliverables: placed,
      exit_ready: blockers.length === 0,
      blockers,
      next_phase: next,
    };
  });
}

// ── pure: the rail, from the PLAN (fr#1482) ─────────────────────────────────
//
// A plan project's `lifecycle_rail` shows ONLY its plan's phases, in plan
// order — never the 11-phase spine — with each exit gate marked on the phase
// it gates. Built on the SERVER from the stored plan (D8: a client-side
// projection is banned). A current phase outside the plan returns null: the
// caller reports the rail unavailable rather than inventing a position.

export function planRailNodes(
  plan: PhasePlan,
  current: string | null,
  labels: ReadonlyMap<string, string>,
): RailNode[] | null {
  // `setup` (RM's start phase, v4 D16) precedes every plan: a plan that does
  // not list it renders it as the ACTIVE first node, the plan's phases pending.
  if (current === SETUP_PHASE && !plan.phases.includes(SETUP_PHASE)) {
    return [
      { phase: SETUP_PHASE, label: labels.get(SETUP_PHASE) ?? SETUP_PHASE, state: 'active', isGate: false },
      ...(planRailNodes(plan, null, labels) ?? []),
    ];
  }
  // null = DEFENSIVE fallback (RM holds no phase): every node pending.
  const idx = current === null ? -1 : plan.phases.indexOf(current);
  if (current !== null && idx < 0) return null;
  return plan.phases.map((phase, i): RailNode => {
    const kinds = plan.gates?.[phase] ?? [];
    const isGate = kinds.length > 0;
    const state = i < idx ? 'done' : i === idx ? 'active' : isGate ? 'gate' : 'upcoming';
    return { phase, label: labels.get(phase) ?? phase, state, isGate, ...(isGate ? { gate_kinds: [...kinds] } : {}) };
  });
}

/** The first phase at or after `current` whose EXIT is gated, or null (`current` null = from the start). */
export function planNextGate(plan: PhasePlan, current: string | null): string | null {
  // `setup` (v4) precedes the plan when the plan does not list it: from the start.
  const before = current === null || (current === SETUP_PHASE && !plan.phases.includes(SETUP_PHASE));
  const idx = before ? 0 : plan.phases.indexOf(current);
  if (idx < 0) return null;
  for (let i = idx; i < plan.phases.length; i++) {
    const p = plan.phases[i]!;
    if ((plan.gates?.[p] ?? []).length > 0) return p;
  }
  return null;
}

// ── loading ─────────────────────────────────────────────────────────────────

export interface PlanProjectRow {
  id: string;
  owner_id: string | null;
  planka_board_id: string | null;
  status: string;
  template_id: string | null;
  template_hash: string | null;
  project_data: unknown;
}

export type LoadedPlan =
  | { kind: 'not_found' }
  | { kind: 'legacy'; project: PlanProjectRow }
  | { kind: 'unresolvable'; project: PlanProjectRow; reason: string }
  | { kind: 'plan'; project: PlanProjectRow; plan: PhasePlan; outlineId: string; planHash: string };

function contractCloseOutlineId(projectData: unknown): string | null {
  const cc = (projectData as { contract_close?: { outline_id?: unknown } } | null)?.contract_close;
  return typeof cc?.outline_id === 'string' && cc.outline_id.length > 0 ? cc.outline_id : null;
}

export async function loadProjectPlan(projectId: string): Promise<LoadedPlan> {
  const [project] = await db
    .select({
      id: projects.id,
      owner_id: projects.owner_id,
      planka_board_id: projects.planka_board_id,
      status: projects.status,
      template_id: projects.template_id,
      template_hash: projects.template_hash,
      project_data: projects.project_data,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return { kind: 'not_found' };
  if (!project.template_id) return { kind: 'legacy', project };
  const outlineId = contractCloseOutlineId(project.project_data);
  if (!outlineId) return { kind: 'unresolvable', project, reason: 'contract_close_outline_missing' };
  const [outline] = await db
    .select({ phase_plan: projectOutlines.phase_plan, phase_plan_hash: projectOutlines.phase_plan_hash })
    .from(projectOutlines)
    .where(eq(projectOutlines.id, outlineId));
  if (!outline) return { kind: 'unresolvable', project, reason: 'outline_not_found' };
  let plan: PhasePlan | null;
  try {
    plan = storedPhasePlan(outline.phase_plan);
  } catch {
    return { kind: 'unresolvable', project, reason: 'phase_plan_invalid' };
  }
  if (!plan || !outline.phase_plan_hash) return { kind: 'unresolvable', project, reason: 'outline_has_no_plan' };
  if (plan.template_id !== project.template_id || plan.template_hash !== project.template_hash) {
    return { kind: 'unresolvable', project, reason: 'plan_template_mismatch' };
  }
  return { kind: 'plan', project, plan, outlineId, planHash: outline.phase_plan_hash };
}

/**
 * The phase labels of a plan project: its OWN tenant's RM phase titles (tenant
 * from the project row, never the caller).
 */
export async function planLabels(project: Pick<PlanProjectRow, 'id' | 'project_data'>): Promise<Map<string, string>> {
  return await phaseTitles(projectCatalogueTenant(project));
}

/** A plan project's stored plan + labels for the rail, or why it cannot be read (fr#1482). */
export async function loadPlanForRail(
  projectId: string,
): Promise<{ plan: PhasePlan; labels: Map<string, string> } | { unresolvable: string }> {
  const loaded = await loadProjectPlan(projectId);
  if (loaded.kind === 'plan') return { plan: loaded.plan, labels: await planLabels(loaded.project) };
  return { unresolvable: loaded.kind === 'unresolvable' ? loaded.reason : loaded.kind };
}

// ── board read ──────────────────────────────────────────────────────────────

/**
 * Board state of each card id (absent from the map ⇒ not on the board ⇒ not DONE):
 * each card's list on the project's Planka board, DONE only in a DONE-equivalent
 * list AND without a break-glass override.
 */
async function plankaCardStates(project: PlanProjectRow, cardIds: readonly string[]): Promise<Map<string, CardState>> {
  const out = new Map<string, CardState>();
  if (cardIds.length === 0 || !project.planka_board_id) return out;
  const { plankaClient } = await import('../services/planka');
  const { findHumanOverrideCardIds } = await import('../services/computed-checks');
  const board = await plankaClient.asAgent().boards.get(project.planka_board_id);
  const listName = new Map((board.included.lists ?? []).map((l) => [l.id, l.name ?? null]));
  const want = new Set(cardIds);
  const overrides = await findHumanOverrideCardIds([...want]);
  for (const c of board.included.cards ?? []) {
    if (!want.has(c.id)) continue;
    const name = listName.get(c.listId) ?? null;
    // ⛔ A break-glass DONE (card_done_overrides) is recorded, never scored as done work.
    out.set(c.id, { list: name, done: isDoneEquivalentListName(name) && !overrides.has(c.id) });
  }
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────

async function loadRows(projectId: string): Promise<PlanRow[]> {
  return await db
    .select({
      id: projectDeliverables.id,
      plan_deliverable_id: projectDeliverables.plan_deliverable_id,
      title: projectDeliverables.title,
      deferred: projectDeliverables.deferred,
      minted_at: projectDeliverables.minted_at,
      minted_count: projectDeliverables.minted_count,
    })
    .from(projectDeliverables)
    .where(eq(projectDeliverables.project_id, projectId));
}

/** row id → bound card ids, from `card_contracts.covers` (the commit's own attachment). */
async function loadCardsByRow(rowIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (rowIds.length === 0) return out;
  const rows = await db
    .select({ card_id: cardContracts.card_id, covers: cardContracts.covers })
    .from(cardContracts)
    .where(
      and(isNotNull(cardContracts.card_id), arrayOverlaps(cardContracts.covers, [...rowIds])),
    );
  const want = new Set(rowIds);
  for (const r of rows) {
    for (const rid of r.covers) {
      if (!want.has(rid) || !r.card_id) continue;
      const list = out.get(rid) ?? [];
      if (!list.includes(r.card_id)) list.push(r.card_id);
      out.set(rid, list);
    }
  }
  return out;
}

async function loadApprovedGateRows(projectId: string): Promise<ApprovedGateRow[]> {
  const rows = await db
    .select({ id: approvals.id, kind: approvals.kind, metadata: approvals.metadata })
    .from(approvals)
    .where(and(eq(approvals.project_id, projectId), eq(approvals.status, 'approved')));
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      kind: r.kind,
      approval_kind_marker: typeof m.approval_kind === 'string' ? m.approval_kind : null,
    };
  });
}

async function approvalKindValues(): Promise<readonly string[]> {
  const { approvalKindEnum } = await import('../db/schema');
  return approvalKindEnum.enumValues;
}

/** Every fact of the plan at the project's current phase (also the GET /plan read model). */
export async function computePlanFacts(
  loaded: Extract<LoadedPlan, { kind: 'plan' }>,
  currentPhase: string | null,
): Promise<PlanPhaseFact[]> {
  const rows = await loadRows(loaded.project.id);
  const cardsByRow = await loadCardsByRow(rows.map((r) => r.id));
  const allCards = [...new Set([...cardsByRow.values()].flat())];
  const cardStates = await plankaCardStates(loaded.project, allCards);
  const approved = await loadApprovedGateRows(loaded.project.id);
  const labels = await planLabels(loaded.project);
  return evaluatePlanPhases({
    labels,
    plan: loaded.plan,
    currentPhase,
    rows,
    cardsByRow,
    cardStates,
    approved,
    approvalKinds: await approvalKindValues(),
  });
}
