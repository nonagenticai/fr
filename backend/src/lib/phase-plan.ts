// src/lib/phase-plan.ts
//
// The PLAN INSTANCE an outline version carries (U-PS-OUTLINE; PSD §6.2 "Plan
// instance: fr project_outlines + phase_plan jsonb + hash"; design D1/D4).
//
// Shape (only the keys fr reads are validated; everything else the S3
// instantiation writes — deliverables, cardinalities, minters, size class — is
// carried verbatim and covered by the hash):
//   template_id    the pm `project_templates` id the plan was instantiated from;
//   template_hash  that template version's body hash (`template_id@hash`);
//   phases[]       an ordered, duplicate-free list of phase NAMES. fr holds no
//                  spine (design: fr consumes RM vocabulary): where a plan is
//                  ACCEPTED (the outline webhook) its phases must be an ordered
//                  subset of the request's RM project-type phases
//                  (`planPhasesOutsideType`). phases[0] is the phase promote
//                  stamps (U-PS-ROUTE).
//
// `phase_plan_hash` = sha256 hex over the RFC 8785 (JCS) canonical form of the
// stored plan — the same canonicaliser U2 uses (lib/bug-report-hash.ts), so two
// emitters hashing one plan agree byte-for-byte. It is computed HERE, server
// side, and never accepted from a caller: a caller-supplied hash is a claim, a
// computed one is a fact about the bytes the row actually holds.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { approvalKindEnum } from '../db/schema';
import { canonicalizeJcs } from './bug-report-hash';

/** A phase NAME (RM project-phase `name` shape). Which names exist is the tenant's RM catalogue. */
const PhaseNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(200);

// ── U-PS-PHASEEXIT (fr#1481): the two keys computed phase exit reads ────────
// Both OPTIONAL (an outline written before PR H carries neither and stays
// valid), both mirror the pm template body (procedure_management
// `schemas/project_template.py`) so the S3 instantiation can copy them through:
//   gates         { <phase>: [approval kind slug, ...] } — pm TemplatePhase.gate,
//                 the G-12 approval(s) required at that phase's EXIT (A1 =
//                 ['ready_signoff','bug_fix_authorization'] after deep_analysis,
//                 A3 = ['feature_design_approval'], A5 = ['landing_signoff']).
//                 Keyed by phase rather than nesting objects in `phases[]` so
//                 `phases` stays the plain ordered id list promote already reads.
//   deliverables  pm Deliverable {id, phase, card_types, cardinality, minter}:
//                 WHERE each deliverable is placed. The approved-scope row
//                 (project_deliverables) joins back by `plan_deliverable_id`.
/** pm SLUG_PATTERN — approval kinds and deliverable ids. */
const SLUG = /^[a-z][a-z0-9_]*$/;
/** pm CARDINALITY_PATTERN. */
export const PLAN_CARDINALITY_PATTERN =
  /^(fixed:[1-9][0-9]*|at_phase_exit|per_finding|per_contract_unit|per_approved_bug|split_by_invest)$/;

export const PlanDeliverableSchema = z
  .object({
    id: z.string().regex(SLUG).max(200),
    phase: PhaseNameSchema,
    card_types: z.array(z.string().min(1).max(200)).min(1),
    cardinality: z.string().regex(PLAN_CARDINALITY_PATTERN),
    minter: z.string().min(1).max(255),
  })
  .passthrough();
export type PlanDeliverable = z.infer<typeof PlanDeliverableSchema>;

export const PhasePlanSchema = z
  .object({
    template_id: z.string().min(1).max(200),
    template_hash: z.string().min(1).max(200),
    phases: z.array(PhaseNameSchema).min(1),
    gates: z.record(z.string(), z.array(z.string().regex(SLUG).max(200))).optional(),
    deliverables: z.array(PlanDeliverableSchema).optional(),
  })
  .passthrough()
  .superRefine((plan, ctx) => {
    // A gate or a deliverable placed in a phase the plan does not walk could
    // never be evaluated — refuse it rather than carry a dead placement.
    const walked = new Set<string>(plan.phases);
    for (const phase of Object.keys(plan.gates ?? {})) {
      if (!walked.has(phase)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gates', phase],
          message: `gate declared on '${phase}', which is not one of this plan's phases`,
        });
      }
    }
    const ids = new Set<string>();
    (plan.deliverables ?? []).forEach((d, i) => {
      if (!walked.has(d.phase)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deliverables', i, 'phase'],
          message: `deliverable '${d.id}' is placed in '${d.phase}', which is not one of this plan's phases`,
        });
      }
      if (ids.has(d.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deliverables', i, 'id'],
          message: `deliverable id '${d.id}' appears twice`,
        });
      }
      ids.add(d.id);
    });
  })
  .superRefine((plan, ctx) => {
    // Duplicate-free: a plan that names a phase twice is not a plan computed
    // phase-exit can ever finish. (ORDER against the project type is checked
    // where the plan is accepted — planPhasesOutsideType — since only there is
    // the tenant's RM type known.)
    const seen = new Set<string>();
    plan.phases.forEach((p, i) => {
      if (seen.has(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phases', i],
          message: `phase '${p}' is repeated; phases must be duplicate-free`,
        });
      }
      seen.add(p);
    });
  });

export type PhasePlan = z.infer<typeof PhasePlanSchema>;

/** The machine code an outline whose plan does not fit its project type is refused with. */
export const PHASE_PLAN_PHASE_NOT_IN_TYPE = 'phase_plan_phase_not_in_type';

/**
 * Where `plan.phases` is not an ORDERED SUBSET of `typePhases` (the request's
 * RM project-type phase names, in order): each offending phase with why. Empty
 * ⇒ the plan fits the type. Input validation, applied where a plan is accepted.
 */
export function planPhasesOutsideType(
  plan: Pick<PhasePlan, 'phases'>,
  typePhases: readonly string[],
): Array<{ phase: string; reason: 'not_a_phase_of_the_type' | 'out_of_order' }> {
  const out: Array<{ phase: string; reason: 'not_a_phase_of_the_type' | 'out_of_order' }> = [];
  let prev = -1;
  for (const p of plan.phases) {
    const idx = typePhases.indexOf(p);
    if (idx < 0) out.push({ phase: p, reason: 'not_a_phase_of_the_type' });
    else if (idx <= prev) out.push({ phase: p, reason: 'out_of_order' });
    else prev = idx;
  }
  return out;
}

// ── gate slugs → approval predicates (fr#1481) ──────────────────────────────
// ONE mapping, read by BOTH the plan parse (outline webhook + promote refuse an
// unmappable slug — `phase_plan_gate_unknown`) and the plan read model's
// evaluator (lib/plan-phase-exit.ts evaluateGate). A slug names either an approval
// metadata marker or an `approval_kind` enum value under one of the prefixes.
// PhasePlanSchema checks only the slug FORMAT, deliberately: a STORED plan
// written before this check must still parse (the read model then reports it as
// `gate_kind_unknown`), so the vocabulary check is applied where a plan is
// ACCEPTED, never where one is read back.

/** The one approval-metadata marker a gate slug may name (services/approvals/u3-gates.ts BUG_FIX_AUTHORIZATION_MARKER). */
export const PLAN_GATE_MARKERS: ReadonlySet<string> = new Set(['bug_fix_authorization']);
/** Prefixes under which a gate slug names an `approval_kind` enum value. */
const GATE_KIND_PREFIXES = ['execution.', 'qa.'] as const;

export interface GateRequirement {
  /** One entry per approval that must exist: its kind (or null = any kind) + the markers it must carry. */
  groups: Array<{ kind: string | null; markers: string[] }>;
  /** Slugs that name neither an approval kind nor a known marker — the gate can never be satisfied. */
  unknown: string[];
}

export function gateRequirement(slugs: readonly string[], approvalKinds: readonly string[]): GateRequirement {
  const kinds: string[] = [];
  const markers: string[] = [];
  const unknown: string[] = [];
  const kindSet = new Set(approvalKinds);
  for (const s of slugs) {
    if (PLAN_GATE_MARKERS.has(s)) {
      markers.push(s);
      continue;
    }
    const hit = GATE_KIND_PREFIXES.map((p) => `${p}${s}`).find((k) => kindSet.has(k));
    if (hit) kinds.push(hit);
    else unknown.push(s);
  }
  const groups = kinds.length > 0
    ? kinds.map((kind) => ({ kind, markers }))
    : markers.length > 0
      ? [{ kind: null, markers }]
      : [];
  return { groups, unknown };
}

/** The machine code a plan carrying an unmappable gate slug is refused with. */
export const PHASE_PLAN_GATE_UNKNOWN = 'phase_plan_gate_unknown';

/**
 * Every gate slug of `plan` that maps to no approval predicate, as
 * `{phase, slug}` (empty ⇒ every gate is satisfiable). Such a plan would strand
 * its project: the gate can never open, and PATCH /phase refuses every lane for
 * a plan project. Callers that ACCEPT a plan refuse it on a non-empty answer.
 */
export function planGateUnknownSlugs(
  plan: Pick<PhasePlan, 'gates'>,
  approvalKinds: readonly string[] = approvalKindEnum.enumValues,
): Array<{ phase: string; slug: string }> {
  const out: Array<{ phase: string; slug: string }> = [];
  for (const [phase, slugs] of Object.entries(plan.gates ?? {})) {
    for (const slug of gateRequirement(slugs, approvalKinds).unknown) out.push({ phase, slug });
  }
  return out;
}

/** sha256 hex of the JCS-canonical plan. Throws (TypeError) on a non-canonicalisable value. */
export function phasePlanHash(plan: unknown): string {
  return createHash('sha256').update(canonicalizeJcs(plan), 'utf8').digest('hex');
}

/**
 * The template a STORED plan names, or null when the outline carries no plan.
 * Re-validates (the column is jsonb — `unknown` until proven), so a tampered or
 * malformed row reads as "no template" only if it is absent; a present but
 * invalid plan THROWS, loudly, rather than silently demoting a template start
 * to the legacy path.
 */
export function storedPhasePlan(raw: unknown): PhasePlan | null {
  if (raw === null || raw === undefined) return null;
  return PhasePlanSchema.parse(raw);
}

// ── U-TX-VIEW-OUTLINE (fr#1484): the PROPOSED plan the requester approves ────
//
// PSD AT6: approve ⇒ `project_deliverables` rows == ALL template deliverables
// (3..7) and cards minted at commit == the plan's phase-1 FIXED cards (types
// and count exact) — `it.bug_hunt`: 3 rows, 1 card. Deferred deliverables
// (every non-fixed cardinality, and every deliverable outside phases[0]) mint 0
// at commit. So:
//   card_count_at_commit = Σ n over deliverables placed in phases[0] whose
//                          cardinality is `fixed:n`.
// Computed HERE, on the server, from the stored plan — the request page renders
// the number, it never re-derives it (D8).

export interface ProposedPlanDeliverable {
  plan_deliverable_id: string;
  card_types: string[];
  cardinality: string;
  minter: string;
  /** Cards this deliverable mints at approval (AT6). */
  cards_at_commit: number;
}

export interface ProposedPlanPhase {
  phase: string;
  label: string;
  gate_kinds: string[];
  deliverables: ProposedPlanDeliverable[];
}

export interface ProposedPlanView {
  template: { id: string; hash: string };
  phase_plan_hash: string;
  phases: ProposedPlanPhase[];
  /** AT6 count; null when the plan carries no `deliverables` (nothing to count — not zero). */
  card_count_at_commit: number | null;
  /** = project_deliverables rows written at approval; null when the plan carries no deliverables. */
  deliverable_count: number | null;
  /** S4 computed plan checks — none exist yet, so always null ("checks pending"). */
  checks: null;
}

/** Cards a deliverable mints at commit (AT6): n for fixed:n placed in the first phase, else 0. */
export function cardsAtCommit(plan: Pick<PhasePlan, 'phases'>, d: { phase: string; cardinality: string }): number {
  if (d.phase !== plan.phases[0]) return 0;
  const m = /^fixed:([1-9][0-9]*)$/.exec(d.cardinality);
  return m ? Number(m[1]) : 0;
}

/**
 * @param labels phase name → the tenant's RM title (services/catalogue/
 *   tenant-catalogue.ts `phaseTitles`). A plan phase the tenant has no title
 *   for is shown by its name.
 */
export function proposedPlanView(
  plan: PhasePlan,
  phasePlanHashValue: string,
  labels: ReadonlyMap<string, string>,
): ProposedPlanView {
  const deliverables = plan.deliverables;
  return {
    template: { id: plan.template_id, hash: plan.template_hash },
    phase_plan_hash: phasePlanHashValue,
    phases: plan.phases.map((phase) => ({
      phase,
      label: labels.get(phase) ?? phase,
      gate_kinds: [...(plan.gates?.[phase] ?? [])],
      deliverables: (deliverables ?? [])
        .filter((d) => d.phase === phase)
        .map((d) => ({
          plan_deliverable_id: d.id,
          card_types: d.card_types,
          cardinality: d.cardinality,
          minter: d.minter,
          cards_at_commit: cardsAtCommit(plan, d),
        })),
    })),
    card_count_at_commit: deliverables ? deliverables.reduce((n, d) => n + cardsAtCommit(plan, d), 0) : null,
    deliverable_count: deliverables ? deliverables.length : null,
    checks: null,
  };
}
