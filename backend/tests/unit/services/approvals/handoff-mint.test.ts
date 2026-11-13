// P2.3 step 3 (C1-59) — services/approvals/handoff-mint.ts, the PURE half of
// POST /api/approvals/:id/mint-design-units. DB-free.
//
// What this pins:
//   * the shared ncn vectors (tests/fixtures/handoff-v2/*.json): canonical → 7 bodies in
//     requires-first order, single-unit → 1 body; dedupe key a3:<approval id>:<unit_key>;
//     card_inputs carries EXACTLY ncn CARD_INPUT_KEYS (no red_test), design_hash and
//     design_approval_id non-empty, scope.target_files[0] === unit.file; the description IS
//     canonicalizeJcs(card_inputs).
//   * every structural guard refuses, ALL-OR-NOTHING (zero bodies), with the ncn code.
//   * the parent binding (designCardBindingRefusal): design_card_id === the approval's card_id.
//   * KNOWN GAP, named: element_ids are structural only — an unresolvable element id is ACCEPTED.
import { describe, expect, test } from 'bun:test';

import { canonicalizeJcs } from '../../../../src/lib/bug-report-hash';
import {
  designCardBindingRefusal,
  HANDOFF_CARD_INPUT_KEYS,
  validateHandoffForMint,
  type HandoffMintCtx,
} from '../../../../src/services/approvals/handoff-mint';

import canonicalVector from '../../../fixtures/handoff-v2/handoff-v2-canonical.json';
import singleUnitVector from '../../../fixtures/handoff-v2/handoff-v2-single-unit.json';

const APPROVAL_ID = '9b2f6c1e-4d3a-4e8b-a7c5-0f1e2d3c4b5a'; // the fixtures' design_approval_id
const contractOf = (v: { contract: unknown }) => structuredClone(v.contract) as Record<string, any>;
const allCrit = (c: Record<string, any>): string[] =>
  c.units.flatMap((u: any) => u.acceptance_criteria.map((a: any) => a.id as string));

function ctxFor(c: Record<string, any>, over: Partial<HandoffMintCtx['approval']> = {}, ids?: string[]): HandoffMintCtx {
  return {
    approval: {
      id: APPROVAL_ID,
      kind: 'execution.feature_design_approval',
      design_hash: c.design_hash,
      decided: true,
      ...over,
    },
    designDoc: { hash: c.design_hash, criterion_ids: ids ?? allCrit(c) },
  };
}

/** The codes a mutated contract is refused with; asserts zero bodies (all-or-nothing). */
function refusedCodes(c: Record<string, any>, ctx: HandoffMintCtx = ctxFor(c)): string[] {
  const r = validateHandoffForMint(c, ctx);
  expect(r.ok).toBe(false);
  expect((r as { bodies?: unknown }).bodies).toBeUndefined();
  return r.ok ? [] : r.violations.map((x) => x.code);
}

describe('shared vectors → card bodies', () => {
  test('canonical: 7 bodies, requires-first, a3: dedupe keys, the agreed card_inputs shape', () => {
    const c = contractOf(canonicalVector);
    const r = validateHandoffForMint(c, ctxFor(c));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bodies).toHaveLength(7);
    const pos = new Map(r.bodies.map((b, i) => [b.unit_key, i]));
    for (const b of r.bodies) {
      for (const req of b.requires) expect(pos.get(req)!).toBeLessThan(pos.get(b.unit_key)!);
      expect(b.asset_id).toBe(`a3:${APPROVAL_ID}:${b.unit_key}`);
      const ci = b.card_inputs as unknown as Record<string, any>;
      expect(Object.keys(ci).sort()).toEqual([...HANDOFF_CARD_INPUT_KEYS].sort());
      expect(ci).not.toHaveProperty('red_test');
      expect(ci.design_hash).toBe(c.design_hash);
      expect(ci.design_approval_id).toBe(APPROVAL_ID);
      expect(ci.kind).toBe(`${b.card_type}_inputs`);
      expect(['new', 'update']).toContain(ci.unit.kind);
      expect(ci.scope.target_files[0]).toBe(ci.unit.file);
      expect(ci.contract_ref).toEqual({ decomposition_id: c.decomposition_id, unit_key: b.unit_key });
      for (const k of ['repository_url', 'repo_name', 'container_name', 'branch']) expect(ci[k]).toBe(c[k]);
      expect(ci.acceptance_tests.every((t: any) => Object.keys(t).sort().join() === 'code,id,path')).toBe(true);
      expect(ci.acceptance_criterion_ids.length).toBeGreaterThan(0);
      expect(b.description).toBe(canonicalizeJcs(b.card_inputs));
      expect(JSON.parse(b.description)).toEqual(ci);
      expect(b.parent_card_id).toBe(c.design_card_id);
      expect(['development_feature_new', 'development_feature_update']).toContain(b.card_type);
    }
    expect(new Set(r.bodies.map((b) => b.asset_id)).size).toBe(7);
  });

  test('insert_after null is omitted (append); a string is carried', () => {
    const c = contractOf(canonicalVector);
    c.units[0].unit.insert_after = 'helper_fn';
    const r = validateHandoffForMint(c, ctxFor(c));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byKey = new Map(r.bodies.map((b) => [b.unit_key, b]));
    expect(byKey.get(c.units[0].unit_key)!.card_inputs.unit.insert_after).toBe('helper_fn');
    expect(byKey.get(c.units[1].unit_key)!.card_inputs.unit).not.toHaveProperty('insert_after');
  });

  test('single-unit: 1 body', () => {
    const c = contractOf(singleUnitVector);
    const r = validateHandoffForMint(c, ctxFor(c));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bodies).toHaveLength(1);
  });
});

describe('guards (each refuses with the ncn code, zero bodies)', () => {
  const base = () => contractOf(canonicalVector);

  test('units 1..7', () => {
    const c = base();
    c.units.push(structuredClone(c.units[0]));
    c.units[7].unit_key = 'theta-8';
    expect(refusedCodes(c)).toContain('unit_count_out_of_range');
    const e = base();
    e.units = [];
    expect(refusedCodes(e)).toContain('unit_count_out_of_range');
  });

  test('per unit 1..7 ACs (unit_not_invest_small)', () => {
    const c = contractOf(singleUnitVector);
    const u = c.units[0];
    const extra = Array.from({ length: 8 }, (_, i) => ({ id: `crit_${(0xabc00000 + i).toString(16)}`, text: `x${i}` }));
    u.acceptance_criteria = extra;
    u.covers = extra.map((a) => a.id);
    u.acceptance_tests = extra.map((a, i) => ({ id: a.id, path: `tests/t_${i}.py`, code: 'assert 0' }));
    expect(refusedCodes(c, ctxFor(c))).toContain('unit_not_invest_small');
  });

  test('AC id must match ^crit_[0-9a-f]{8}$', () => {
    const c = base();
    c.units[0].acceptance_criteria[0].id = 'crit_XYZ';
    expect(refusedCodes(c)[0]).toMatch(/^schema_invalid:/);
  });

  test('every design AC owned by exactly ONE unit (criterion_in_multiple_units)', () => {
    const c = base();
    c.units[1].acceptance_criteria.push(structuredClone(c.units[0].acceptance_criteria[0]));
    expect(refusedCodes(c)).toContain('criterion_in_multiple_units');
  });

  test('a design AC owned by NO unit (hd_criterion_uncovered)', () => {
    const c = base();
    expect(refusedCodes(c, ctxFor(c, {}, [...allCrit(c), 'crit_00000000']))).toContain('hd_criterion_uncovered');
  });

  test('every AC has ≥1 test (criterion_without_test)', () => {
    const c = base();
    const u = c.units.find((x: any) => x.acceptance_tests.length > 1)!;
    u.acceptance_tests = u.acceptance_tests.slice(1);
    expect(refusedCodes(c)).toContain('criterion_without_test');
  });

  test('(file, function) unique design-wide, file case-insensitive (unit_function_duplicate)', () => {
    const c = base();
    c.units[1].unit = { ...c.units[0].unit, file: c.units[0].unit.file.toUpperCase() };
    c.units[1].scope.target_files = [c.units[1].unit.file];
    expect(refusedCodes(c)).toContain('unit_function_duplicate');
  });

  test('target_files canonical; [0] === unit.file', () => {
    for (const bad of ['/abs.py', 'a/../b.py', 'a//b.py', './a.py', 'a b.py']) {
      const c = base();
      c.units[0].scope.target_files.push(bad);
      expect(refusedCodes(c)).toContain('target_files_not_canonical');
    }
    const h = base();
    h.units[0].scope.target_files.reverse();
    expect(refusedCodes(h)).toContain('target_files_head_not_unit_file');
  });

  test('test paths unique design-wide, case-insensitive (acceptance_test_path_duplicate)', () => {
    const c = base();
    c.units[1].acceptance_tests[0].path = c.units[0].acceptance_tests[0].path.toUpperCase().replace(/\.PY$/, '.py');
    expect(refusedCodes(c)).toContain('acceptance_test_path_duplicate');
  });

  test('a test path never equals a target file (acceptance_test_path_collision)', () => {
    const c = base();
    c.units[1].scope.target_files.push(c.units[0].acceptance_tests[0].path);
    expect(refusedCodes(c)).toContain('acceptance_test_path_collision');
  });

  test('|target_files ∪ test paths| ≤ 40 (write_set_over_budget)', () => {
    const c = base();
    for (let i = 0; i < 40; i += 1) c.units[0].scope.target_files.push(`src/extra/f_${i}.py`);
    expect(refusedCodes(c)).toContain('write_set_over_budget');
  });

  test('top-level repository_url / branch / container_name / repo_name required', () => {
    for (const f of ['repository_url', 'branch', 'container_name', 'repo_name']) {
      const c = base();
      c[f] = '';
      expect(refusedCodes(c)).toContain('incomplete_contract');
    }
  });

  test('design hash must be the approved H_d (design_hash_mismatch)', () => {
    const c = base();
    expect(refusedCodes(c, ctxFor(c, { design_hash: 'f'.repeat(64) }))).toContain('design_hash_mismatch');
  });

  test('no stored approve decision (approval_not_decided), a wrong kind (approval_kind_invalid)', () => {
    const c = base();
    expect(refusedCodes(c, ctxFor(c, { decided: false }))).toContain('approval_not_decided');
    expect(refusedCodes(c, ctxFor(c, { kind: 'generic' }))).toContain('approval_kind_invalid');
  });

  test('design_approval_id must be the triggering approval (mismatch / missing)', () => {
    const c = base();
    expect(refusedCodes(c, ctxFor(c, { id: '00000000-0000-4000-8000-000000000000' }))).toContain(
      'design_approval_id_mismatch',
    );
    delete c.design_approval_id;
    expect(refusedCodes(c)).toContain('design_approval_id_missing');
  });

  test('requires: dangling and cyclic dependencies', () => {
    const c = base();
    c.units[0].requires = ['nope-9'];
    expect(refusedCodes(c)).toContain('dangling_dependency');
    const y = base();
    const [a, b] = [y.units[0], y.units[1]];
    a.requires = [b.unit_key];
    b.requires = [a.unit_key];
    expect(refusedCodes(y)).toContain('cyclic_dependency');
  });

  test('a unit may not carry a contract-level field (unit_overrides_contract_field)', () => {
    const c = base();
    c.units[0].design_hash = 'x';
    expect(refusedCodes(c)).toContain('unit_overrides_contract_field');
  });

  test('all-or-nothing: ONE bad unit of seven ⇒ no body for the six good ones', () => {
    const c = base();
    c.units[6].scope.target_files.reverse();
    const r = validateHandoffForMint(c, ctxFor(c));
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('bodies');
  });
});

describe('parent binding: design_card_id must be the approval\'s card (route 409 design_card_mismatch)', () => {
  test('equal ⇒ null; another card, a null/empty approval card, or a missing design_card_id ⇒ a reason', () => {
    const c = contractOf(canonicalVector);
    expect(designCardBindingRefusal(c, c.design_card_id)).toBeNull();
    expect(designCardBindingRefusal(c, 'another-card')).toContain('is not the approval');
    expect(designCardBindingRefusal(c, null)).toContain('has no card_id');
    expect(designCardBindingRefusal(c, '')).toContain('has no card_id');
    const { design_card_id: _omit, ...noCard } = c;
    expect(designCardBindingRefusal(noCard, c.design_card_id)).not.toBeNull();
    expect(designCardBindingRefusal(null, c.design_card_id)).not.toBeNull();
  });
});

describe('KNOWN GAP: element_ids are checked STRUCTURALLY ONLY', () => {
  test('an element id no requirements API could resolve is ACCEPTED (there is no element API)', () => {
    const c = base0();
    c.units[0].scope.element_ids = ['el-does-not-exist-anywhere'];
    expect(validateHandoffForMint(c, ctxFor(c)).ok).toBe(true);
  });
  test('…but a malformed (non-string / empty) element id is refused', () => {
    const c = base0();
    c.units[0].scope.element_ids = [''];
    expect(refusedCodes(c)[0]).toMatch(/^schema_invalid:.*element_ids/);
  });
  function base0() {
    return contractOf(canonicalVector);
  }
});
