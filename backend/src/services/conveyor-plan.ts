// src/services/conveyor-plan.ts
//
// THE CONVEYOR (v4) PROJECT PLAN — what GET /api/projects/:id/plan answers for a
// project that has an RM pm_project (RM's answer, by origin_project_id) and no fr
// template (FR-PROJECT-PAGE-CONVEYOR-2026-10-25 G1). Conveyor projects never
// carry a template: their plan lives in requirements_management (RM) and on
// the project's Planka board. fr READS it and judges nothing (fr = facilitator).
//
// Sources (all reads, in the PROJECT's tenant — never the caller's):
//   phases        RM project type, position order (`phasesOfState`)
//   entered/left  RM `GET /pm/projects/{id}/phase-events`
//   current/closed RM pm_project `current_phase_id` + `status` ('closed' = finished)
//   cards         the Planka board; card → phase by the card's OWN Metadata
//                 `phase` field (every conveyor card-creating flow stamps it),
//                 else by its `card_type` when the type's composition places
//                 that card type in exactly ONE phase, else "not placed".
//                 NOT by card type alone:
//                 project_phase_start / project_phase_closure sit in several phases.
//   capabilities  RM `GET /pm/projects/{id}/capabilities` (selected)
//   risks         RM PM rows (activities/dependencies went with RM's
//                 schedule apparatus, R352)
//
// Every source is read independently: a failed one is `{available:false,
// reason}` — never an empty success — and the rest still render. Only the
// project's own RM state failing makes the whole plan unavailable.

import {
  getPmProjectCapabilities,
  listPmProjectPhaseEvents,
  listRisksOfPmProject,
  PM_PROJECT_CLOSED_STATUS,
  type PmProjectCapabilitiesOut,
  type PmProjectPhaseEventOut,
} from '../integrations/pm';
import { IntegrationError } from '../integrations/_lib/errors';
import { AppError } from '../utils/errors';
import { plankaClient } from './planka';
import { phasesOfState, projectTypeAndPhase, type ProjectStateRow, type RmProjectState } from './catalogue/project-state';
import { composition as typeComposition } from './catalogue/tenant-catalogue';

// ── output shape ────────────────────────────────────────────────────────────

export type Section<T> = ({ available: true } & T) | { available: false; reason: string };

export type ConveyorPhaseState = 'done' | 'active' | 'upcoming' | 'not_run';

export interface ConveyorPlanCard {
  id: string;
  name: string;
  card_type: string | null;
  card_type_title: string | null;
  list: string | null;
  last_moved_at: string | null;
  /** How the card was placed in its phase: its own `phase` field, or its card type. */
  placed_by: 'card_phase' | 'card_type' | null;
}

export interface ConveyorPlanPhase {
  name: string;
  title: string;
  position: number;
  has_gate: boolean;
  entered_at: string | null;
  left_at: string | null;
  state: ConveyorPhaseState;
  cards: ConveyorPlanCard[];
}

export interface ConveyorPlanCapability {
  name: string;
  title: string | null;
  involvement: string | null;
  rigor: string | null;
  complexity: string | null;
  purpose: string | null;
  /** The PM's long rationale — rendered behind a "Why" disclosure. */
  reason: string | null;
  order_after: string[];
  selected_at: string | null;
}

export interface ConveyorPlanRisk {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
  category: string | null;
  probability: number | null;
  impact_score: number | null;
  risk_score: number | null;
  response_strategy: string | null;
  response_plan: string | null;
}

export interface ConveyorPlanAvailable {
  project_id: string;
  legacy: false;
  kind: 'conveyor';
  available: true;
  project_type: { id: string | null; name: string | null };
  status: string | null;
  closed: boolean;
  current_phase: string | null;
  phase_updated_at: string | null;
  phases: Section<{ items: ConveyorPlanPhase[] }>;
  phase_history: Section<Record<never, never>>;
  cards: Section<{ unplaced: ConveyorPlanCard[] }>;
  capabilities: Section<{ selected: ConveyorPlanCapability[] }>;
  risks: Section<{ items: ConveyorPlanRisk[] }>;
}

export interface ConveyorPlanUnavailable {
  project_id: string;
  legacy: false;
  kind: 'conveyor';
  available: false;
  reason: string;
}

export type ConveyorPlan = ConveyorPlanAvailable | ConveyorPlanUnavailable;

// ── raw input shapes (what the readers return) ──────────────────────────────

interface ConveyorBoard {
  included?: {
    lists?: Array<{ id: string; name?: string | null }>;
    cards?: Array<{
      id: string;
      name?: string | null;
      listId: string;
      listChangedAt?: string | null;
      createdAt?: string | null;
    }>;
    customFields?: Array<{ id: string; name?: string | null }>;
    customFieldValues?: Array<{ cardId: string; customFieldId: string; content?: unknown }>;
  };
}

interface PlanPhaseSpec {
  name: string;
  title: string;
  has_gate: boolean;
  phase_id?: string;
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: string };

interface ConveyorPlanInputs {
  projectId: string;
  state: RmProjectState;
  phases: Settled<PlanPhaseSpec[]>;
  phaseEvents: Settled<PmProjectPhaseEventOut[]>;
  board: Settled<ConveyorBoard>;
  composition: Settled<unknown>;
  capabilities: Settled<PmProjectCapabilitiesOut>;
  risks: Settled<unknown[]>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoOf = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString();
  return str(v);
};

/** A failure as a short, user-readable reason (never a stack). */
export function reasonOf(err: unknown): string {
  if (err instanceof IntegrationError) return err.code;
  if (err instanceof AppError) return err.code ?? `http_${err.statusCode}`;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return 'upstream_unavailable';
}

/** Card id → {field name → content} for the named custom fields. */
function cardFieldValues(board: ConveyorBoard, names: readonly string[]): Map<string, Record<string, string>> {
  const inc = board.included ?? {};
  const wanted = new Set(names);
  const nameById = new Map<string, string>();
  for (const f of inc.customFields ?? []) if (f.name && wanted.has(f.name)) nameById.set(f.id, f.name);
  const out = new Map<string, Record<string, string>>();
  for (const v of inc.customFieldValues ?? []) {
    const name = nameById.get(v.customFieldId);
    if (!name) continue;
    const content = typeof v.content === 'string' ? v.content.trim() : v.content == null ? '' : String(v.content);
    if (content === '') continue;
    const row = out.get(v.cardId) ?? {};
    row[name] = content;
    out.set(v.cardId, row);
  }
  return out;
}

/** card type name → {title, phases it is placed in} from RM's composition. */
function compositionIndex(comp: unknown): Map<string, { title: string | null; phases: Set<string> }> {
  const out = new Map<string, { title: string | null; phases: Set<string> }>();
  const phases = (comp as { phases?: unknown } | null)?.phases;
  for (const ph of Array.isArray(phases) ? phases : []) {
    const phaseName = str((ph as { name?: unknown })?.name);
    const caps = (ph as { capabilities?: unknown })?.capabilities;
    for (const cap of Array.isArray(caps) ? caps : []) {
      const cts = (cap as { card_types?: unknown })?.card_types;
      for (const ct of Array.isArray(cts) ? cts : []) {
        const name = str((ct as { name?: unknown })?.name);
        if (!name) continue;
        const e = out.get(name) ?? { title: str((ct as { title?: unknown })?.title), phases: new Set<string>() };
        if (phaseName) e.phases.add(phaseName);
        out.set(name, e);
      }
    }
  }
  return out;
}

/** capability name → title from RM's composition. */
function capabilityTitles(comp: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const phases = (comp as { phases?: unknown } | null)?.phases;
  for (const ph of Array.isArray(phases) ? phases : []) {
    const caps = (ph as { capabilities?: unknown })?.capabilities;
    for (const cap of Array.isArray(caps) ? caps : []) {
      const name = str((cap as { name?: unknown })?.name);
      const title = str((cap as { title?: unknown })?.title);
      if (name && title) out.set(name, title);
    }
  }
  return out;
}

/** Entered / left per phase from the phase events (any order in, oldest-first internally). */
function phaseWindows(
  events: readonly PmProjectPhaseEventOut[],
  phases: readonly PlanPhaseSpec[],
): Map<string, { entered_at: string | null; left_at: string | null }> {
  const nameById = new Map(phases.filter((p) => p.phase_id).map((p) => [p.phase_id!, p.name]));
  const nameOf = (id: unknown, name: unknown): string | null =>
    str(name) ?? (typeof id === 'string' ? nameById.get(id) ?? null : null);
  const sorted = [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const out = new Map<string, { entered_at: string | null; left_at: string | null }>();
  for (const ev of sorted) {
    const at = isoOf(ev.at);
    const to = nameOf(ev.to_phase_id, (ev as { to_phase?: unknown }).to_phase);
    const from = nameOf(ev.from_phase_id, (ev as { from_phase?: unknown }).from_phase);
    if (from) {
      const w = out.get(from) ?? { entered_at: null, left_at: null };
      w.left_at = at;
      out.set(from, w);
    }
    if (to) {
      const w = out.get(to) ?? { entered_at: null, left_at: null };
      // First entry is when the phase began; a re-entry reopens it (left_at cleared).
      if (w.entered_at === null) w.entered_at = at;
      w.left_at = null;
      out.set(to, w);
    }
  }
  return out;
}

// ── the builder (pure) ──────────────────────────────────────────────────────

function buildConveyorPlan(inp: ConveyorPlanInputs): ConveyorPlanAvailable {
  const { state } = inp;
  const pm = state.pm as unknown as Record<string, unknown>;
  const status = str(pm.status);
  const closed = status === PM_PROJECT_CLOSED_STATUS;
  const current = state.phase;

  const comp = inp.composition.ok ? compositionIndex(inp.composition.value) : new Map();
  const capTitles = inp.composition.ok ? capabilityTitles(inp.composition.value) : new Map<string, string>();

  // cards
  const phaseNames = new Set(inp.phases.ok ? inp.phases.value.map((p) => p.name) : []);
  const byPhase = new Map<string, ConveyorPlanCard[]>();
  const unplaced: ConveyorPlanCard[] = [];
  if (inp.board.ok) {
    const board = inp.board.value;
    const lists = new Map((board.included?.lists ?? []).map((l) => [l.id, l.name ?? null]));
    const fields = cardFieldValues(board, ['card_type', 'phase']);
    for (const c of board.included?.cards ?? []) {
      const f = fields.get(c.id) ?? {};
      const cardType = f.card_type ?? null;
      const entry = cardType ? comp.get(cardType) : undefined;
      let phase: string | null = null;
      let placedBy: ConveyorPlanCard['placed_by'] = null;
      if (f.phase && phaseNames.has(f.phase)) {
        phase = f.phase;
        placedBy = 'card_phase';
      } else if (entry && entry.phases.size === 1) {
        const only = [...entry.phases][0]!;
        if (phaseNames.has(only)) {
          phase = only;
          placedBy = 'card_type';
        }
      }
      const card: ConveyorPlanCard = {
        id: c.id,
        name: c.name ?? '',
        card_type: cardType,
        card_type_title: entry?.title ?? null,
        list: lists.get(c.listId) ?? null,
        last_moved_at: c.listChangedAt ?? c.createdAt ?? null,
        placed_by: placedBy,
      };
      if (phase) {
        const arr = byPhase.get(phase) ?? [];
        arr.push(card);
        byPhase.set(phase, arr);
      } else unplaced.push(card);
    }
    const byTime = (a: ConveyorPlanCard, b: ConveyorPlanCard) =>
      String(a.last_moved_at ?? '').localeCompare(String(b.last_moved_at ?? ''));
    for (const arr of byPhase.values()) arr.sort(byTime);
    unplaced.sort(byTime);
  }

  // phases
  let phases: ConveyorPlanAvailable['phases'];
  if (!inp.phases.ok) phases = { available: false, reason: inp.phases.reason };
  else {
    const windows = inp.phaseEvents.ok ? phaseWindows(inp.phaseEvents.value, inp.phases.value) : new Map();
    const currentIdx = inp.phases.value.findIndex((p) => p.name === current);
    phases = {
      available: true,
      items: inp.phases.value.map((p, i) => {
        const w = windows.get(p.name) ?? { entered_at: null, left_at: null };
        const isCurrent = p.name === current;
        let st: ConveyorPhaseState;
        if (isCurrent) st = closed ? 'done' : 'active';
        else if (w.entered_at !== null) st = 'done';
        else if (closed || (currentIdx >= 0 && i < currentIdx)) st = 'not_run';
        else st = 'upcoming';
        return {
          name: p.name,
          title: p.title,
          position: i,
          has_gate: p.has_gate,
          entered_at: w.entered_at,
          left_at: w.left_at,
          state: st,
          cards: byPhase.get(p.name) ?? [],
        };
      }),
    };
  }

  // capabilities
  let capabilities: ConveyorPlanAvailable['capabilities'];
  if (!inp.capabilities.ok) capabilities = { available: false, reason: inp.capabilities.reason };
  else {
    const sel = Array.isArray(inp.capabilities.value.selected) ? inp.capabilities.value.selected : [];
    capabilities = {
      available: true,
      selected: sel.map((s) => {
        const r = s as unknown as Record<string, unknown>;
        const name = String(r.name ?? '');
        return {
          name,
          title: capTitles.get(name) ?? null,
          involvement: str(r.involvement),
          rigor: str(r.rigor),
          complexity: str(r.complexity),
          purpose: str(r.purpose),
          reason: str(r.reason),
          order_after: Array.isArray(r.order_after) ? r.order_after.filter((x): x is string => typeof x === 'string') : [],
          selected_at: isoOf(r.selected_at),
        };
      }),
    };
  }

  const risks: ConveyorPlanAvailable['risks'] = inp.risks.ok
    ? {
        available: true,
        items: inp.risks.value
          .map((x) => {
            const r = x as Record<string, unknown>;
            return {
              id: String(r.id),
              title: String(r.title ?? ''),
              description: str(r.description),
              status: str(r.status),
              category: str(r.category),
              probability: num(r.probability),
              impact_score: num(r.impact_score),
              risk_score: num(r.risk_score),
              response_strategy: str(r.response_strategy),
              response_plan: str(r.response_plan),
            };
          })
          .sort((a, b) => (b.risk_score ?? -1) - (a.risk_score ?? -1)),
      }
    : { available: false, reason: inp.risks.reason };

  return {
    project_id: inp.projectId,
    legacy: false,
    kind: 'conveyor',
    available: true,
    project_type: { id: state.projectTypeId, name: state.projectType },
    status,
    closed,
    current_phase: current,
    phase_updated_at: state.phaseUpdatedAt,
    phases,
    phase_history: inp.phaseEvents.ok ? { available: true } : { available: false, reason: inp.phaseEvents.reason },
    cards: inp.board.ok ? { available: true, unplaced } : { available: false, reason: inp.board.reason },
    capabilities,
    risks,
  };
}

// ── the loader ──────────────────────────────────────────────────────────────

interface ConveyorPlanProjectRow extends ProjectStateRow {
  planka_board_id?: string | null;
}

async function settle<T>(p: () => Promise<T>, label: string, projectId: string): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p() };
  } catch (err) {
    console.error(`[conveyor-plan] ${label} unavailable for project ${projectId}:`, err);
    return { ok: false, reason: reasonOf(err) };
  }
}

/** The conveyor plan of `project` (its RM pm_project + Planka board). Never throws. */
export async function loadConveyorPlan(project: ConveyorPlanProjectRow): Promise<ConveyorPlan> {
  let state: RmProjectState;
  try {
    state = await projectTypeAndPhase(project);
  } catch (err) {
    console.error(`[conveyor-plan] project state unavailable for project ${project.id}:`, err);
    return { project_id: project.id, legacy: false, kind: 'conveyor', available: false, reason: reasonOf(err) };
  }
  const tenant = state.tenantId;
  const pmId = state.rmPmProjectId;
  const pm = state.pm as unknown as Record<string, unknown>;
  const boardId = str(project.planka_board_id) ?? str(pm.planka_board_id);

  const [phases, phaseEvents, board, composition, capabilities, risks] = await Promise.all([
    settle(() => phasesOfState(state), 'phases', project.id),
    settle(() => listPmProjectPhaseEvents(tenant, pmId, { limit: 1000, offset: 0 }), 'phase events', project.id),
    boardId
      ? settle(() => plankaClient.asAgent().boards.get(boardId) as unknown as Promise<ConveyorBoard>, 'board', project.id)
      : Promise.resolve<Settled<ConveyorBoard>>({ ok: false, reason: 'no_board' }),
    state.projectType
      ? settle<unknown>(() => typeComposition(tenant, state.projectType!), 'composition', project.id)
      : Promise.resolve<Settled<unknown>>({ ok: false, reason: 'project_type_missing' }),
    settle(() => getPmProjectCapabilities(tenant, pmId), 'capabilities', project.id),
    settle<unknown[]>(() => listRisksOfPmProject(tenant, pmId), 'risks', project.id),
  ]);
  return buildConveyorPlan({
    projectId: project.id,
    state,
    phases,
    phaseEvents,
    board,
    composition,
    capabilities,
    risks,
  });
}
