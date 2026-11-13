// tests/unit/services/gherkin-scenarios-hash-recompute.test.ts
//
// B4 (coordinator ruling 2026-10-03): a scenario hash on a card write is
// accepted ONLY when fr RECOMPUTES it from the canonical scenario content —
// never a bare asserted hash. Two carriers on the card document:
//   * `scenarios_check.scenario_hash` — the freeze value R3b's tamper check
//     reads (ncn scripts/lib/coding-qa-verdict.mjs AA_CQ_SCENARIOS stored_hash)
//     and recomputes over the card's WHOLE gherkin_scenarios set;
//   * `gherkin_scenarios[i].scenario_hash` — the hash of the one-element set.
// Supplied ≠ recomputed ⇒ 422 `scenario_hash_mismatch`; absent ⇒ nothing is
// computed or added (freezing is READY's act; R3b reports a missing hash).
//
// Expected values come from the VENDORED REFERENCE implementation
// (tests/fixtures/canonical-scenarios-hash/canonical-scenarios-hash.mjs) and
// its golden vectors — never from the fr function under test.
//
// MUTATION CONTROL (applied, run RED, reverted): `checkScenarioHashes` →
// `return null` at its top (trust the input) ⇒ every "tampered" test RED.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  CARD_DOCUMENT_CODES,
  SCENARIO_CODES,
  appendScenarioEntries,
  assertDescriptionScenarios,
  checkDescriptionScenarios,
  scenarioRefusalBody,
  scenarioRefusalStatus,
  splitScenarioEvidence,
} from '../../../src/services/gherkin-scenarios';
import { AppError } from '../../../src/utils/errors';
import { scenariosHash as refHash } from '../../fixtures/canonical-scenarios-hash/canonical-scenarios-hash.mjs';

const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/canonical-scenarios-hash/vectors.json'), 'utf8'),
) as { vectors: Array<{ name: string; input: Array<Record<string, unknown>>; sha256: string }> };

const A = {
  scenario_id: 'scn_0a1b2c3d',
  criterion_id: 'crit_0a1b2c3d',
  title: 'nonzero shallow-probe exit with stdout true fails closed',
  gherkin: 'Scenario: x\n  Given a probe exit 128\n  Then 500\n',
};
const B = { scenario_id: 'scn_1b2c3d4e', criterion_id: 'crit_1b2c3d4e', title: 'stdout false', gherkin: null };
const SET = [A, B];
const doc = (o: Record<string, unknown>) => JSON.stringify({ title: 'card', ...o });
const frozen = (set: Array<Record<string, unknown>>, hash: unknown) =>
  doc({ gherkin_scenarios: set, scenarios_check: { criteria: [], scenario_hash: hash } });
const TAMPERED = 'f'.repeat(64);

describe('scenarios_check.scenario_hash (the freeze value R3b recomputes)', () => {
  test('a correct hash is accepted (raw JSON and ```json-fenced)', () => {
    expect(checkDescriptionScenarios(frozen(SET, refHash(SET)))).toBeNull();
    expect(checkDescriptionScenarios('prose\n\n```json\n' + frozen(SET, refHash(SET)) + '\n```')).toBeNull();
    // input order is irrelevant (canonical sort by scenario_id)
    expect(checkDescriptionScenarios(frozen([B, A], refHash(SET)))).toBeNull();
  });

  test('a tampered hash → 422 scenario_hash_mismatch, with the recomputed value named', () => {
    const r = checkDescriptionScenarios(frozen(SET, TAMPERED));
    expect(r?.code).toBe(SCENARIO_CODES.scenarioHashMismatch);
    expect(r?.code).toBe('scenario_hash_mismatch');
    expect(scenarioRefusalStatus(r!)).toBe(422);
    expect(r!.issues[0]!.path).toEqual(['scenarios_check', 'scenario_hash']);
    expect(r!.issues[0]!.message).toContain(refHash(SET));
    const body = scenarioRefusalBody(r!);
    expect(body.error).toBe('scenario_hash_mismatch');
    expect(body.qa_needs_info).toBe('repro_malformed');
  });

  test('tampered CONTENT under a stale hash → 422 (the hash is of the content, not the id list)', () => {
    const h = refHash(SET);
    expect(checkDescriptionScenarios(frozen([{ ...A, title: A.title + '!' }, B], h))?.code).toBe(
      'scenario_hash_mismatch',
    );
    expect(checkDescriptionScenarios(frozen([A], h))?.code).toBe('scenario_hash_mismatch'); // a dropped scenario
    // evidence/lifecycle fields are OUT of the hash: changing them keeps it valid
    expect(checkDescriptionScenarios(frozen([{ ...A, status: 'frozen' }, B], h))).toBeNull();
  });

  test('non-string / mis-shaped hashes are refused, never ignored', () => {
    for (const bad of [42, '', 'nothex', refHash(SET).toUpperCase(), 'sha256:' + refHash(SET), { h: 1 }]) {
      expect({ bad, code: checkDescriptionScenarios(frozen(SET, bad))?.code }).toEqual({
        bad,
        code: 'scenario_hash_mismatch',
      });
    }
  });

  test('absent (or null) → accepted, nothing computed, nothing added', () => {
    const d = doc({ gherkin_scenarios: SET, scenarios_check: { criteria: [] } });
    expect(checkDescriptionScenarios(d)).toBeNull();
    expect(checkDescriptionScenarios(frozen(SET, null))).toBeNull();
    expect(checkDescriptionScenarios(doc({ gherkin_scenarios: SET }))).toBeNull();
    // the split (the only rewriting step on create) returns it byte-identical: no hash stamped
    const split = splitScenarioEvidence(d);
    expect('description' in split && split.description).toBe(d);
  });

  test('a hash with no gherkin_scenarios is checked against the empty set', () => {
    const empty = VECTORS.vectors.find((v) => v.name === 'empty_list')!;
    expect(checkDescriptionScenarios(doc({ scenarios_check: { scenario_hash: empty.sha256 } }))).toBeNull();
    expect(checkDescriptionScenarios(doc({ scenarios_check: { scenario_hash: TAMPERED } }))?.code).toBe(
      'scenario_hash_mismatch',
    );
  });

  test('the STORED value equals the recomputed one (through the create-path evidence split)', () => {
    const content = 'def test_scn_0a1b2c3d():\n    assert True\n';
    const sha = createHash('sha256').update(content, 'utf8').digest('hex');
    const withEvidence = [{ ...A, test_path: 'tests/t.py', test_file_sha256: sha, test_file_content: content }, B];
    const d = frozen(withEvidence, refHash(SET));
    expect(checkDescriptionScenarios(d)).toBeNull();
    const split = splitScenarioEvidence(d);
    if (!('description' in split)) throw new Error('refused');
    const stored = JSON.parse(split.description!) as {
      gherkin_scenarios: Array<Record<string, unknown>>;
      scenarios_check: { scenario_hash: string };
    };
    expect(stored.gherkin_scenarios[0]!.test_file_content).toBeUndefined();
    expect(stored.scenarios_check.scenario_hash).toBe(refHash(stored.gherkin_scenarios));
    expect(stored.scenarios_check.scenario_hash).toBe(refHash(SET));
  });

  test('cross-check vector shared with the QA side (movies-db vectors.json, vendored by fr AND ncn)', () => {
    // ncn scripts/tests/fixtures/canonical-scenarios-hash.vectors.json carries the same
    // sha256 with its `sha256:` repo prefix; AA_CQ_HASH returns and compares the bare hex.
    const v = VECTORS.vectors.find((x) => x.name === 'order_independent_input')!;
    expect(v.sha256).toBe('20988de5f086700e7558578e8d4857c5bfa0b2c38705ffb6b15dd395a67f5493'); // == ncn's pinned value, measured 2026-10-03
    expect(checkDescriptionScenarios(frozen(v.input, v.sha256))).toBeNull();
    expect(checkDescriptionScenarios(frozen(v.input, refHash(v.input)))).toBeNull();
    const other = VECTORS.vectors.find((x) => x.name === 'single_basic')!;
    expect(checkDescriptionScenarios(frozen(v.input, other.sha256))?.code).toBe('scenario_hash_mismatch');
  });
});

describe('gherkin_scenarios[i].scenario_hash (per entry = hash of [entry])', () => {
  test('correct → accepted; tampered → 422 at the entry path', () => {
    const ok = [{ ...A, scenario_hash: refHash([A]) }, { ...B, scenario_hash: refHash([B]) }];
    expect(checkDescriptionScenarios(doc({ gherkin_scenarios: ok }))).toBeNull();
    const bad = [ok[0], { ...B, scenario_hash: refHash([A]) }];
    const r = checkDescriptionScenarios(doc({ gherkin_scenarios: bad }));
    expect(r?.code).toBe('scenario_hash_mismatch');
    expect(scenarioRefusalStatus(r!)).toBe(422);
    expect(r!.issues.map((i) => i.path)).toEqual([['gherkin_scenarios', 1, 'scenario_hash']]);
    // the SET hash is not a per-entry hash
    expect(checkDescriptionScenarios(doc({ gherkin_scenarios: [{ ...A, scenario_hash: refHash(SET) }, B] }))?.code).toBe(
      'scenario_hash_mismatch',
    );
  });

  test('shared per-entry vectors: a single-entry vector sha256 IS the per-entry hash of [entry] (phase-10 R3-RESULT-SHAPE.md)', () => {
    // One definition: per-entry scenario_hash = canonical-scenarios-hash v1 of [entry]. The
    // single-entry vectors in the vendored vectors.json (fr == ncn == movies-db) pin it.
    const pinned: Record<string, string> = {
      single_basic: 'f4890332435c69b90316669b355c559f7c26a9d5384b28b5038fedb495ba131c',
      unicode_kept_as_is: '02d07741cd61ad76bd22deddc649d7911d03c1405d013611c038a087db6b97f1',
    };
    for (const [name, hex] of Object.entries(pinned)) {
      const v = VECTORS.vectors.find((x) => x.name === name)!;
      expect(v.sha256).toBe(hex);
      const entry = v.input[0]!;
      expect(checkDescriptionScenarios(doc({ gherkin_scenarios: [{ ...entry, scenario_hash: hex }] }))).toBeNull();
    }
    const other = VECTORS.vectors.find((x) => x.name === 'single_basic')!.input[0]!;
    expect(
      checkDescriptionScenarios(doc({ gherkin_scenarios: [{ ...other, scenario_hash: pinned.unicode_kept_as_is }] }))?.code,
    ).toBe('scenario_hash_mismatch');
  });

  test('run twice: a re-PUT of an identical scenario yields the identical hash and is accepted both times', () => {
    // Re-entry must never wedge on 422: the same content, re-serialised the way a round trip
    // through a card description does (pretty vs compact JSON, key order, CRLF line endings),
    // recomputes to the same set hash AND the same per-entry hash.
    const first = [{ ...A, scenario_hash: refHash([A]) }, { ...B, scenario_hash: refHash([B]) }];
    const d1 = doc({ gherkin_scenarios: first, scenarios_check: { criteria: [], scenario_hash: refHash(SET) } });
    const reordered = (e: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(e).reverse()) as Record<string, unknown>;
    const second = [
      reordered({ ...B, scenario_hash: refHash([B]) }),
      reordered({ ...A, gherkin: String(A.gherkin).replace(/\n/g, '\r\n'), scenario_hash: refHash([A]) }),
    ];
    const d2 =
      'prose\n\n```json\n' +
      JSON.stringify({ title: 'card', scenarios_check: { scenario_hash: refHash(SET), criteria: [] }, gherkin_scenarios: second }, null, 2) +
      '\n```';
    expect(checkDescriptionScenarios(d1)).toBeNull();
    expect(checkDescriptionScenarios(d2)).toBeNull();
    expect(checkDescriptionScenarios(d1)).toBeNull(); // and again: deterministic, no state
    expect(refHash(second)).toBe(refHash(first));
    expect(refHash([second[1]!])).toBe(refHash([A]));
  });

  test('the Planka-passthrough writers refuse it with a 422 AppError', () => {
    let err: unknown;
    try {
      assertDescriptionScenarios(frozen(SET, TAMPERED));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(422);
    expect((err as AppError).code).toBe('scenario_hash_mismatch');
    expect(() => assertDescriptionScenarios(frozen(SET, refHash(SET)))).not.toThrow();
  });

  test('schema refusals keep 400', () => {
    const r = checkDescriptionScenarios(doc({ gherkin_scenarios: [{ ...A, extra: 1 }] }));
    expect(r?.code).toBe(SCENARIO_CODES.unknownKey);
    expect(scenarioRefusalStatus(r!)).toBe(400);
  });
});

describe('append to an existing card (POST /api/cards/:id/scenario-evidence)', () => {
  test('appending to a FROZEN set is refused: the stored hash would stop being the recomputed one', () => {
    const v = appendScenarioEntries(frozen([A], refHash([A])), [B]);
    expect('refusal' in v && v.refusal.code).toBe(CARD_DOCUMENT_CODES.scenarioHashMismatch);
  });

  test('an unfrozen set takes the append; an identical re-append of a frozen set is a no-op', () => {
    const v = appendScenarioEntries(doc({ gherkin_scenarios: [A] }), [B]);
    expect('description' in v && v.appended).toEqual([B.scenario_id]);
    const f = frozen(SET, refHash(SET));
    const again = appendScenarioEntries(f, [B]);
    expect('description' in again && again.description).toBe(f);
  });
});
