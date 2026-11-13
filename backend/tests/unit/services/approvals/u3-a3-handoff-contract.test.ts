// P2.3 (C1-59) — metadata.handoff_contract on an A3 mint (src/services/approvals/u3-gates.ts +
// src/services/approvals/handoff-contract.ts). DB-free: the design mint never reads the database.
//
// What this pins:
//   * SHARED TEST VECTOR: tests/fixtures/handoff-v2/*.json are byte-identical copies of ncn
//     scripts/tests/fixtures/handoff-v2-*.json (ncn#2034). fr's ONE canonicalizeJcs must give
//     their expected_contract_hash (contract minus design_approval_id).
//   * handoff_contract is OPTIONAL: absent ⇒ minted, and the stored metadata has no such key.
//   * present ⇒ strict handoff.v2 (422 handoff_contract_invalid, incl. an unknown key at any
//     level), and contract_hash must equal its hash (422 contract_hash_mismatch).
//   * present + valid ⇒ stored VERBATIM (canonical bytes equal the input's).
//   * an unknown TOP-LEVEL A3 metadata key ⇒ 422 design_metadata_invalid (was a silent drop).
//   * handoff_contract.design_card_id must be the card the A3 is minted on (422
//     contract_design_card_mismatch) — the dev cards are parented under it.
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';

import { canonicalizeJcs } from '../../../../src/lib/bug-report-hash';
import { handoffContractHash } from '../../../../src/services/approvals/handoff-contract';
import {
  assertU3DedupeCompatible,
  FEATURE_DESIGN_APPROVAL_KIND,
  resolveU3Mint,
} from '../../../../src/services/approvals/u3-gates';
import { AppError } from '../../../../src/utils/errors';
import { designMetadata } from './u3-fixtures';

import canonicalVector from '../../../fixtures/handoff-v2/handoff-v2-canonical.json';
import singleUnitVector from '../../../fixtures/handoff-v2/handoff-v2-single-unit.json';

const TENANT = randomUUID();
const VECTORS = { canonical: canonicalVector, 'single-unit': singleUnitVector } as const;

async function refusal(fn: () => unknown): Promise<{ status: number; code?: string }> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return { status: (err as AppError).statusCode, code: (err as AppError).code };
  }
  throw new Error('expected a refusal, got none');
}

/** The card the shared vectors' contracts are bound to (contract.design_card_id); the A3 is minted on it. */
const DESIGN_CARD = canonicalVector.contract.design_card_id;
const mint = (metadata: Record<string, unknown>, cardId: string = DESIGN_CARD) =>
  resolveU3Mint({ rawBody: { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata }, cardId, tenantId: TENANT });

const clone = <T>(v: T): T => structuredClone(v);
const contractOf = (v: { contract: unknown }) => clone(v.contract) as Record<string, any>;

/** The contract's paths (target_files ∪ acceptance_tests[].path), byte-sorted — the write_set it implies. */
const contractPaths = (c: Record<string, any>): string[] =>
  [
    ...new Set<string>(
      c.units.flatMap((u: any) => [...u.scope.target_files, ...u.acceptance_tests.map((t: any) => t.path)]),
    ),
  ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

/** design_hash + write_set CONSISTENT with `c` (P2.3 cross-checks), built from the fixture contract. */
const scopeOf = (c: Record<string, any>) => ({ design_hash: c.design_hash, write_set: contractPaths(c) });

/** A3 metadata carrying `contract` with a consistent design_hash + write_set (`extra` overrides). */
const a3Meta = (contract: unknown, extra: Record<string, unknown> = {}) =>
  designMetadata({ ...scopeOf(contract as Record<string, any>), handoff_contract: contract, ...extra });

/** A3 metadata carrying `contract`, sealed with ITS hash. */
const withContract = (contract: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  a3Meta(contract, { contract_hash: handoffContractHash(contract), ...extra });

describe('shared handoff.v2 test vector (ncn#2034 fixtures, byte-identical)', () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    test(`${name}: fr computes expected_contract_hash with its ONE canonicalizeJcs`, () => {
      expect(v.expected_contract_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(handoffContractHash(contractOf(v))).toBe(v.expected_contract_hash);
      // The hash is canonicalizeJcs(contract minus design_approval_id), spelled out:
      const { design_approval_id: _omit, ...body } = contractOf(v);
      expect(createHash('sha256').update(canonicalizeJcs(body), 'utf8').digest('hex')).toBe(v.expected_contract_hash);
    });
  }

  test('CONTROL: the vector is sensitive — one changed character moves the hash', () => {
    const c = contractOf(canonicalVector);
    c.units[0].acceptance_tests[0].code += ' ';
    expect(handoffContractHash(c)).not.toBe(canonicalVector.expected_contract_hash);
  });
});

describe('A3 mint: handoff_contract optional, strict, sealed, verbatim', () => {
  test('absent ⇒ minted exactly as before (no handoff_contract key stored)', async () => {
    const out = await mint(designMetadata());
    expect(out!.kind).toBe(FEATURE_DESIGN_APPROVAL_KIND);
    expect(out!.metadata).not.toHaveProperty('handoff_contract');
    expect(out!.metadata.contract_hash).toBe('c'.repeat(64));
  });

  for (const [name, v] of Object.entries(VECTORS)) {
    test(`${name}: valid + correct hash ⇒ stored verbatim (canonical bytes identical)`, async () => {
      const input = contractOf(v);
      const out = await mint(a3Meta(input, { contract_hash: v.expected_contract_hash }));
      const stored = out!.metadata.handoff_contract as Record<string, unknown>;
      expect(canonicalizeJcs(stored)).toBe(canonicalizeJcs(contractOf(v)));
      expect(stored).not.toBe(input); // a copy, not the caller's object
      expect(out!.metadata.contract_hash).toBe(v.expected_contract_hash);
    });
  }

  test('a contract WITHOUT design_approval_id is accepted (fr assigns the id; excluded from the hash)', async () => {
    const c = contractOf(canonicalVector);
    delete c.design_approval_id;
    expect(handoffContractHash(c)).toBe(canonicalVector.expected_contract_hash);
    const out = await mint(withContract(c));
    expect(out!.metadata.handoff_contract).not.toHaveProperty('design_approval_id');
  });

  test('valid contract, WRONG contract_hash ⇒ 422 contract_hash_mismatch', async () => {
    const c = contractOf(canonicalVector);
    expect(await refusal(() => mint(a3Meta(c, { contract_hash: 'c'.repeat(64) })))).toEqual({
      status: 422,
      code: 'contract_hash_mismatch',
    });
    // A hash over the WHOLE contract (design_approval_id included) is also wrong.
    const whole = createHash('sha256').update(canonicalizeJcs(c), 'utf8').digest('hex');
    expect(await refusal(() => mint(a3Meta(c, { contract_hash: whole })))).toEqual({
      status: 422,
      code: 'contract_hash_mismatch',
    });
  });

  test('tampered contract under the ORIGINAL hash ⇒ 422 contract_hash_mismatch', async () => {
    const c = contractOf(canonicalVector);
    c.units[0].acceptance_tests[0].code = 'def test_x():\n    assert True\n';
    expect(
      await refusal(() => mint(a3Meta(c, { contract_hash: canonicalVector.expected_contract_hash }))),
    ).toEqual({ status: 422, code: 'contract_hash_mismatch' });
  });

  const malformed: Array<[string, (c: Record<string, any>) => unknown]> = [
    ['null', () => null],
    ['an array', () => []],
    ['wrong contract_version', (c) => ({ ...c, contract_version: 'handoff.v1' })],
    ['missing repo_name', (c) => { delete c.repo_name; return c; }],
    ['empty branch', (c) => ({ ...c, branch: '' })],
    ['0 units', (c) => ({ ...c, units: [] })],
    ['8 units', (c) => ({ ...c, units: [...c.units, c.units[0]] })],
    ['unit.kind not new|update', (c) => { c.units[0].unit.kind = 'create'; return c; }],
    ['unit.function with a space', (c) => { c.units[0].unit.function = 'a b'; return c; }],
    ['unit.insert_after not an identifier', (c) => { c.units[0].unit.insert_after = '1x'; return c; }],
    ['target_files a glob', (c) => { c.units[0].scope.target_files = ['src/**/*.py']; return c; }],
    ['target_files with ..', (c) => { c.units[0].scope.target_files = ['src/../x.py']; return c; }],
    ['target_files empty', (c) => { c.units[0].scope.target_files = []; return c; }],
    ['acceptance_test id not crit_<8hex>', (c) => { c.units[0].acceptance_tests[0].id = 'crit_1'; return c; }],
    ['acceptance_test path not .py', (c) => { c.units[0].acceptance_tests[0].path = 'tests/x.ts'; return c; }],
    ['acceptance_test code blank', (c) => { c.units[0].acceptance_tests[0].code = '  \n'; return c; }],
    ['acceptance_tests empty', (c) => { c.units[0].acceptance_tests = []; return c; }],
    ['acceptance_criteria empty', (c) => { c.units[0].acceptance_criteria = []; return c; }],
    ['child_card_type unknown', (c) => { c.units[0].child_card_type = 'development_bugfix'; return c; }],
    ['interfaces direction invalid', (c) => { c.units[0].interfaces[0].direction = 'uses'; return c; }],
    ['requires not an array', (c) => { c.units[0].requires = 'beta-2'; return c; }],
    ['U+0000 in test code (unstorable in jsonb)', (c) => { c.units[0].acceptance_tests[0].code = 'x\u0000'; return c; }],
  ];
  for (const [label, mutate] of malformed) {
    test(`malformed (${label}) ⇒ 422 handoff_contract_invalid`, async () => {
      const bad = mutate(contractOf(canonicalVector));
      // Sealed with ITS OWN hash where hashable, so only the SHAPE can refuse it.
      let hash = 'c'.repeat(64);
      try {
        hash = handoffContractHash(bad as Record<string, unknown>);
      } catch {
        /* null / array: not hashable */
      }
      expect(await refusal(() => mint(designMetadata({ ...scopeOf(contractOf(canonicalVector)), contract_hash: hash, handoff_contract: bad })))).toEqual({
        status: 422,
        code: 'handoff_contract_invalid',
      });
    });
  }

  const extraKeyAt: Array<[string, (c: Record<string, any>) => void]> = [
    ['contract top level', (c) => { c.test_code = 'x'; }],
    ['a unit', (c) => { c.units[0].design_hash = 'a'.repeat(64); }],
    ['unit.unit', (c) => { c.units[0].unit.line = 3; }],
    ['unit.scope', (c) => { c.units[0].scope.globs = []; }],
    ['an acceptance_test', (c) => { c.units[0].acceptance_tests[0].name = 'n'; }],
    ['an acceptance_criterion', (c) => { c.units[0].acceptance_criteria[0].weight = 1; }],
    ['an interface', (c) => { c.units[0].interfaces[0].doc = 'd'; }],
  ];
  for (const [where, add] of extraKeyAt) {
    test(`an unknown key inside handoff_contract (${where}) ⇒ 422 handoff_contract_invalid, even correctly hashed`, async () => {
      const c = contractOf(canonicalVector);
      add(c);
      expect(await refusal(() => mint(withContract(c)))).toEqual({ status: 422, code: 'handoff_contract_invalid' });
    });
  }
});

describe('A3 mint: top-level metadata is STRICT', () => {
  for (const key of ['units', 'acceptance_criteria', 'test_code', 'handoff']) {
    test(`unknown top-level key ${key} ⇒ 422 design_metadata_invalid (was silently dropped)`, async () => {
      expect(await refusal(() => mint(designMetadata({ [key]: [] })))).toEqual({
        status: 422,
        code: 'design_metadata_invalid',
      });
    });
  }

  test('every declared key still mints (no false refusal of the allowed set)', async () => {
    const c = contractOf(singleUnitVector);
    const out = await mint(withContract(c));
    expect(Object.keys(out!.metadata).sort()).toEqual(
      [
        'a3_inputs_hash',
        'contract_hash',
        'design_artifact_id',
        'design_hash',
        'handoff_contract',
        'scenarios',
        'scenarios_hash',
        'write_set',
        'write_set_seal',
      ].sort(),
    );
  });
});

describe('A3 mint: handoff_contract cross-checked against the approved design + write_set (P2.3 rulings 2-3)', () => {
  test('handoff_contract.design_hash ≠ metadata.design_hash ⇒ 422 contract_design_hash_mismatch', async () => {
    const c = contractOf(canonicalVector);
    expect(await refusal(() => mint(withContract(c, { design_hash: 'd'.repeat(64) })))).toEqual({
      status: 422,
      code: 'contract_design_hash_mismatch',
    });
  });

  test('write_set MISSING a contract path ⇒ 422 contract_write_set_mismatch', async () => {
    const c = contractOf(canonicalVector);
    const ws = contractPaths(c);
    const dropped = ws.filter((p) => p !== 'tests/billing/test_apply_vat_0.py');
    expect(dropped.length).toBe(ws.length - 1);
    expect(await refusal(() => mint(withContract(c, { write_set: dropped })))).toEqual({
      status: 422,
      code: 'contract_write_set_mismatch',
    });
  });

  test('write_set with an EXTRA path not in the contract ⇒ 422 contract_write_set_mismatch', async () => {
    const c = contractOf(singleUnitVector);
    const wider = [...contractPaths(c), 'zz/extra.py'];
    expect(await refusal(() => mint(withContract(c, { write_set: wider })))).toEqual({
      status: 422,
      code: 'contract_write_set_mismatch',
    });
  });

  test('a contract path repeated across units / target_files+tests is compared as a SET (positive)', async () => {
    const c = contractOf(canonicalVector);
    const all = c.units.flatMap((u: any) => [...u.scope.target_files, ...u.acceptance_tests.map((t: any) => t.path)]);
    expect(all.length).toBeGreaterThan(new Set(all).size); // the vector does repeat a path
    const out = await mint(withContract(c));
    expect(out!.metadata.write_set).toEqual(contractPaths(c));
  });

  test('the seal is still writeSetSeal over write_set exactly as sent', async () => {
    const c = contractOf(singleUnitVector);
    const out = await mint(withContract(c));
    const { writeSetSeal } = await import('../../../../src/lib/write-set');
    expect(out!.metadata.write_set_seal).toBe(writeSetSeal(contractPaths(c)));
  });

  test('handoff_contract.design_card_id ≠ the card the A3 is minted on ⇒ 422 contract_design_card_mismatch', async () => {
    const c = contractOf(canonicalVector);
    expect(DESIGN_CARD).toBe(singleUnitVector.contract.design_card_id);
    expect(await refusal(() => mint(withContract(c), 'some-other-card'))).toEqual({
      status: 422,
      code: 'contract_design_card_mismatch',
    });
    // CONTROL: the same contract on its own design card mints.
    expect((await mint(withContract(contractOf(canonicalVector))))!.kind).toBe(FEATURE_DESIGN_APPROVAL_KIND);
  });

  test('CONTROL: no handoff_contract ⇒ no cross-check (design_hash d…, write_set unrelated still mints)', async () => {
    const out = await mint(designMetadata());
    expect(out!.metadata.design_hash).toBe('d'.repeat(64));
  });
});

describe('A3 re-mint onto the open gate: a different contract_hash is refused (P2.3 ruling 4)', () => {
  const minted = async (c: Record<string, any>) => (await mint(withContract(c)))!;

  test('same identity + same contract_hash ⇒ folds (no throw)', async () => {
    const c = contractOf(canonicalVector);
    const a = await minted(c);
    const b = await minted(contractOf(canonicalVector));
    expect(() => assertU3DedupeCompatible(b, { id: 'open-1', kind: a.kind, metadata: a.metadata })).not.toThrow();
  });

  test('same identity + DIFFERENT contract_hash ⇒ 409 contract_conflicts_open_approval naming the open id', async () => {
    const c1 = contractOf(canonicalVector);
    const c2 = contractOf(canonicalVector);
    c2.units[0].acceptance_tests[0].code += '\n# v2\n';
    const a = await minted(c1);
    const b = await minted(c2);
    expect(b.metadata.contract_hash).not.toBe(a.metadata.contract_hash);
    // identity (design_artifact_id, design_hash, scenarios_hash, write_set_seal) is the SAME
    expect(b.metadata.write_set_seal).toBe(a.metadata.write_set_seal);
    let err: unknown;
    try {
      assertU3DedupeCompatible(b, { id: 'open-1', kind: a.kind, metadata: a.metadata });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('contract_conflicts_open_approval');
    expect((err as AppError).message).toContain('open-1');
    expect((err as AppError & { details?: any }).details?.existing_approval_id).toBe('open-1');
  });

  test('a different IDENTITY still wins as open_gate_conflict (dedupe otherwise unchanged)', async () => {
    const a = await minted(contractOf(canonicalVector));
    const b = await mint(designMetadata({ design_artifact_id: 'design-2' }));
    expect(() => assertU3DedupeCompatible(b, { id: 'open-1', kind: a.kind, metadata: a.metadata })).toThrow();
    try {
      assertU3DedupeCompatible(b, { id: 'open-1', kind: a.kind, metadata: a.metadata });
    } catch (e) {
      expect((e as AppError).code).toBe('open_gate_conflict');
    }
  });
});
