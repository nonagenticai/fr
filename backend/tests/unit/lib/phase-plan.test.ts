// tests/unit/lib/phase-plan.test.ts — U-PS-OUTLINE plan validation + hash.
//
// Phases are NAMES (fr holds no spine — design: fr consumes RM vocabulary); the
// ORDER against the request's RM project type is `planPhasesOutsideType`,
// applied where a plan is accepted (the outline webhook).

import { describe, expect, test } from 'bun:test';

import {
  PHASE_PLAN_GATE_UNKNOWN,
  PhasePlanSchema,
  planPhasesOutsideType,
  cardsAtCommit,
  phasePlanHash,
  planGateUnknownSlugs,
  proposedPlanView,
  storedPhasePlan,
} from '../../../src/lib/phase-plan';
import { evaluateGate } from '../../../src/lib/plan-phase-exit';
import { approvalKindEnum } from '../../../src/db/schema';

const BUG_HUNT = {
  template_id: 'it.bug_hunt',
  template_hash: 'a'.repeat(64),
  phases: ['deep_analysis', 'feature_development', 'closure'],
};

describe('PhasePlanSchema', () => {
  test('accepts the it.bug_hunt plan and keeps extra keys', () => {
    // fr#1481: `deliverables` is no longer an opaque passthrough key — computed
    // phase exit reads it, so it is validated as the pm Deliverable shape. An
    // unknown key (size_class) is still carried verbatim.
    const r = PhasePlanSchema.safeParse({
      ...BUG_HUNT,
      size_class: 'S',
      deliverables: [
        { id: 'd3_closure', phase: 'closure', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'planPhaseExit' },
      ],
    });
    expect(r.success).toBe(true);
    expect((r as { data: Record<string, unknown> }).data.size_class).toBe('S');
  });

  test('fr#1481: a half-specified deliverable (no id/card_types/cardinality/minter) is refused', () => {
    expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, deliverables: [{ phase: 'closure' }] }).success).toBe(false);
  });

  test('ORDER is not the schema’s business any more (no fr spine): any order of names parses', () => {
    expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, phases: ['closure', 'deep_analysis'] }).success).toBe(true);
  });

  test('a repeated phase is refused', () => {
    expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, phases: ['deep_analysis', 'deep_analysis'] }).success).toBe(
      false,
    );
  });

  test('a phase must be a name-shaped token (RM phase names); RM decides which exist', () => {
    for (const p of ['Bad Name', '', '1st', 'a-b']) {
      expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, phases: [p] }).success).toBe(false);
    }
    expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, phases: ['intake', 'fix_v3'] }).success).toBe(true);
  });
});

describe('planPhasesOutsideType (the order check, against the RM project type)', () => {
  const TYPE = ['request', 'deep_analysis', 'feature_development', 'closure'];
  test('an ordered subset of the type fits', () => {
    expect(planPhasesOutsideType(BUG_HUNT, TYPE)).toEqual([]);
  });
  test('a phase the type does not have is named', () => {
    expect(planPhasesOutsideType({ phases: ['deep_analysis', 'contract'] }, TYPE)).toEqual([
      { phase: 'contract', reason: 'not_a_phase_of_the_type' },
    ]);
  });
  test('out of the type order is named', () => {
    expect(planPhasesOutsideType({ phases: ['closure', 'deep_analysis'] }, TYPE)).toEqual([
      { phase: 'deep_analysis', reason: 'out_of_order' },
    ]);
  });
  test('an empty type fits nothing', () => {
    expect(planPhasesOutsideType({ phases: ['closure'] }, [])).toHaveLength(1);
  });

  test('an empty plan, or one without its template coordinates, is refused', () => {
    expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, phases: [] }).success).toBe(false);
    expect(PhasePlanSchema.safeParse({ phases: BUG_HUNT.phases }).success).toBe(false);
  });
});

describe('phasePlanHash', () => {
  test('is 64 lowercase hex and deterministic', () => {
    const h = phasePlanHash(BUG_HUNT);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(phasePlanHash(structuredClone(BUG_HUNT))).toBe(h);
  });

  test('key order does not change the hash (JCS canonical form)', () => {
    const reordered = { phases: BUG_HUNT.phases, template_hash: BUG_HUNT.template_hash, template_id: BUG_HUNT.template_id };
    expect(phasePlanHash(reordered)).toBe(phasePlanHash(BUG_HUNT));
  });

  test('any content change changes the hash', () => {
    expect(phasePlanHash({ ...BUG_HUNT, phases: ['deep_analysis', 'closure'] })).not.toBe(phasePlanHash(BUG_HUNT));
  });

  test('a non-canonicalisable value throws instead of hashing approximately', () => {
    expect(() => phasePlanHash({ ...BUG_HUNT, cap: 1.5 })).toThrow(TypeError);
  });
});

describe('storedPhasePlan', () => {
  test('null/undefined → null (legacy outline)', () => {
    expect(storedPhasePlan(null)).toBeNull();
    expect(storedPhasePlan(undefined)).toBeNull();
  });
  test('a present but malformed plan THROWS — never silently demoted to "no template"', () => {
    expect(() => storedPhasePlan({ template_id: 'x' })).toThrow();
  });
  test('a valid stored plan round-trips', () => {
    expect(storedPhasePlan(BUG_HUNT)?.phases[0]).toBe('deep_analysis');
  });
});

// fr#1484 — the PROPOSED plan view and the PSD AT6 card count.
// MUTATIONS WATCHED: count fixed:n in EVERY phase (not only phases[0]) →
// "only the first phase's fixed cards" RED; count at_phase_exit as 1 →
// "an at_phase_exit deliverable mints 0 at commit" RED.
describe('proposedPlanView — PSD AT6', () => {
  const bugHunt = PhasePlanSchema.parse({
    ...BUG_HUNT,
    gates: { deep_analysis: ['ready_signoff', 'bug_fix_authorization'] },
    deliverables: [
      { id: 'd1', phase: 'deep_analysis', card_types: ['code_quality_analysis'], cardinality: 'fixed:1', minter: 'commit' },
      { id: 'd2', phase: 'feature_development', card_types: ['development_bug_fix'], cardinality: 'per_approved_bug', minter: 'f' },
      { id: 'd3', phase: 'closure', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'planPhaseExit' },
    ],
  });

  test('it.bug_hunt: 3 rows, 1 card; 3 phases with the A1 gate on deep_analysis; checks pending', () => {
    const v = proposedPlanView(bugHunt, 'f'.repeat(64), new Map([['deep_analysis', 'Deep analysis (RM)']]));
    expect(v.deliverable_count).toBe(3);
    expect(v.card_count_at_commit).toBe(1);
    expect(v.phases.map((p) => [p.phase, p.gate_kinds])).toEqual([
      ['deep_analysis', ['ready_signoff', 'bug_fix_authorization']],
      ['feature_development', []],
      ['closure', []],
    ]);
    expect(v.phases[0]!.deliverables[0]!.cards_at_commit).toBe(1);
    // labels are the tenant RM titles; a phase without one shows its name
    expect(v.phases.map((p) => p.label)).toEqual(['Deep analysis (RM)', 'feature_development', 'closure']);
    expect(v.checks).toBeNull();
  });

  test('only the FIRST phase\'s fixed:n cards count (a later fixed deliverable is deferred: 0 at commit)', () => {
    const p = PhasePlanSchema.parse({
      template_id: 't', template_hash: 'h', phases: ['feature_design', 'feature_development', 'closure'],
      deliverables: [
        { id: 'a', phase: 'feature_design', card_types: ['architecture_task'], cardinality: 'fixed:2', minter: 'commit' },
        { id: 'b', phase: 'feature_development', card_types: ['development_feature_new'], cardinality: 'fixed:3', minter: 'x' },
        { id: 'c', phase: 'feature_development', card_types: ['development_feature_new'], cardinality: 'per_contract_unit', minter: 'mint-design-units' },
        { id: 'd', phase: 'closure', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'planPhaseExit' },
      ],
    });
    expect(proposedPlanView(p, 'h', new Map()).card_count_at_commit).toBe(2);
    expect(cardsAtCommit(p, { phase: 'feature_development', cardinality: 'fixed:3' })).toBe(0);
  });

  test('an at_phase_exit deliverable mints 0 at commit even when placed in the first phase (it is deferred)', () => {
    expect(cardsAtCommit(bugHunt, { phase: 'deep_analysis', cardinality: 'at_phase_exit' })).toBe(0);
    expect(cardsAtCommit(bugHunt, { phase: 'deep_analysis', cardinality: 'per_finding' })).toBe(0);
  });

  test('a plan with no deliverables has NO count (null), not zero', () => {
    const v = proposedPlanView(PhasePlanSchema.parse(BUG_HUNT), 'h', new Map());
    expect(v.card_count_at_commit).toBeNull();
    expect(v.deliverable_count).toBeNull();
  });
});

// fr#1481 F3 — an unmappable gate slug passes the FORMAT check but would strand
// the project (the gate never opens; PATCH /phase refuses plan projects). The
// accept paths refuse it with planGateUnknownSlugs, which uses the SAME
// slug → approval mapping the plan read model's evaluateGate uses.
// MUTATION WATCHED: make planGateUnknownSlugs return [] ⇒ the 'nonsense_gate'
// case (here, the outline webhook 422 and the promote throw) goes RED.
describe('planGateUnknownSlugs — the plan-accept vocabulary check', () => {
  test('the shipped gates (A1, A3, A5) all map; an unknown slug is named with its phase', () => {
    const plan = {
      gates: {
        deep_analysis: ['ready_signoff', 'bug_fix_authorization'],
        architecture: ['feature_design_approval'],
        closure: ['landing_signoff', 'coverage_signoff'],
      },
    };
    expect(planGateUnknownSlugs(plan)).toEqual([]);
    expect(planGateUnknownSlugs({ gates: { deep_analysis: ['ready_signoff', 'nonsense_gate'] } })).toEqual([
      { phase: 'deep_analysis', slug: 'nonsense_gate' },
    ]);
    expect(planGateUnknownSlugs({})).toEqual([]);
    expect(PHASE_PLAN_GATE_UNKNOWN).toBe('phase_plan_gate_unknown');
  });

  test('single source: a slug is refused at accept EXACTLY when evaluateGate reports it unknown', () => {
    const kinds = approvalKindEnum.enumValues;
    for (const slug of ['ready_signoff', 'bug_fix_authorization', 'landing_signoff', 'question', 'nonsense_gate', 'generic']) {
      const atAccept = planGateUnknownSlugs({ gates: { closure: [slug] } }).map((g) => g.slug);
      expect(atAccept).toEqual(evaluateGate([slug], kinds, []).unknown_kinds);
    }
  });

  test('the format-only schema still PARSES a stored plan with an unknown slug (read-back never throws on it)', () => {
    expect(PhasePlanSchema.safeParse({ ...BUG_HUNT, gates: { deep_analysis: ['nonsense_gate'] } }).success).toBe(true);
  });
});
