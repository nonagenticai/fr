// tests/unit/services/gherkin-scenarios.test.ts
//
// fr#1338 follow-up — the STRICT `gherkin_scenarios` entry schema (R3 repro
// contract v2, ~/.claude/plans/w53-scratch/R3-RESULT-SHAPE.md) and the
// canonical-scenarios-hash v1 allowlist, the PURE halves. The route halves
// (refused ⇒ nothing written; round-trip through the card store) were the
// decomposition-commit integration suite, deleted 2026-10-29 — no longer in the suite.
//
// `scenariosHash` (src/services/gherkin-scenarios.ts) is fr's implementation of
// canonical-scenarios-hash v1 with an EXPLICIT key allowlist (lib/scenarios-hash.ts).
// It is pinned against the spec's golden vectors AND against the reference .mjs,
// both VENDORED under tests/fixtures/canonical-scenarios-hash/ (source:
// ~/.claude/plans/program/30-specs-contracts/canonical-scenarios-hash/), pinned
// by sha256 below so a silent edit of the vendored copy fails here; refresh it
// only from that directory, never by hand.
//
// MUTATION CONTROLS (each applied, run RED, reverted):
//   * GherkinScenarioEntry: `.strict()` → `.strip()` → "undeclared key is REFUSED" RED.
//   * test_file_content: drop the byte refine → "multibyte over 32 KiB" RED.
//   * the canonicalScenariosString projection gains `status` → vectors + "evidence OUT" RED.
//   * assertDescriptionScenarios: drop the not-accepted-here arm → its test RED.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  GherkinScenarioEntry,
  SCENARIO_CODES,
  TEST_FILE_CONTENT_MAX,
  appendScenarioEntries,
  assertDescriptionScenarios,
  canonicalScenariosString as frCanonical,
  cardDocumentOf,
  checkDescriptionScenarios,
  hasScenarioEvidenceKey,
  normaliseJsonEscapes,
  scenarioEvidenceVerdict,
  scenarioRefusalBody,
  scenariosHash as frHash,
  splitScenarioEvidence,
} from '../../../src/services/gherkin-scenarios';
import { AppError } from '../../../src/utils/errors';
import {
  criteriaFromAcceptance,
  mintedCardDescription,
  scenarioSkeleton,
} from '../../../src/routes/decomposition-commit';
import { canonicalScenariosString, scenariosHash } from '../../fixtures/canonical-scenarios-hash/canonical-scenarios-hash.mjs';

const VENDOR_DIR = join(import.meta.dir, '../../fixtures/canonical-scenarios-hash');
/** sha256 of the vendored files, as published in the spec directory 2026-10-02. */
const VENDORED_SHA256 = {
  'canonical-scenarios-hash.mjs': '25994afed1d62246ed1f96b53690804bd6e43b5213596818e19df637c728f728',
  'vectors.json': 'f455b35b18249e5c5077c040c99efe955fb7dbac9c7ce3af7784ee88d789b9c7',
} as const;

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const TEST_FILE = [
  'import pytest',
  '',
  'def test_scn_0a1b2c3d_export_rejects_empty_rows():',
  '    # ünïcödé on purpose: the byte count is not the char count',
  '    assert export([]) == "id\\n"',
  '',
].join('\n');

/**
 * A contract-v2 bug-path entry, every declared field present. Its per-entry
 * `scenario_hash` is the REFERENCE implementation's hash of `[entry]` (B4: fr
 * recomputes it and refuses any other value) unless `over` names one.
 */
function bugEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const e: Record<string, unknown> = {
    scenario_id: 'scn_0a1b2c3d',
    criterion_id: 'crit_0a1b2c3d',
    title: 'the export rejects empty rows',
    gherkin: null,
    status: 'approved',
    failing_test: 'tests/test_scn_0a1b2c3d.py::test_scn_0a1b2c3d_export_rejects_empty_rows',
    test_path: 'tests/test_scn_0a1b2c3d.py',
    test_file_sha256: sha256(TEST_FILE),
    test_file_content: TEST_FILE,
    base_sha: 'b'.repeat(40),
    expect_red: true,
    runner: 'pytest-uv',
    ...over,
  };
  if (!('scenario_hash' in over)) e.scenario_hash = scenariosHash([e]);
  return e;
}
const descOf = (entries: unknown[]) => JSON.stringify({ title: 'x', gherkin_scenarios: entries });

describe('strict entry schema (repro contract v2)', () => {
  test('a full bug-path entry and the D14 skeleton both pass', () => {
    expect(GherkinScenarioEntry.safeParse(bugEntry()).success).toBe(true);
    const skel = scenarioSkeleton(criteriaFromAcceptance(['a', 'b']));
    for (const s of skel) expect(GherkinScenarioEntry.safeParse(s).success).toBe(true);
    expect(checkDescriptionScenarios(descOf([bugEntry()]))).toBeNull();
  });

  test('the server-minted description is accepted by its own schema (fr never refuses its own mint)', () => {
    const d = mintedCardDescription({
      decompositionId: 'dec-1',
      deliverable: {
        id: 'd1',
        kind: 'deliverable',
        title: 'D1',
        description: 'x',
        // duplicate AC text: deduped to ONE scenario, so no duplicate scn_ id
        acceptance_criteria: ['same', 'other', 'same', 'z'.repeat(50_000)],
      },
    });
    expect(checkDescriptionScenarios(d)).toBeNull();
  });

  test('an undeclared extra key is REFUSED with a code — never stripped', () => {
    const r = checkDescriptionScenarios(descOf([bugEntry({ repro_sha: 'c'.repeat(40) })]));
    expect(r?.code).toBe(SCENARIO_CODES.unknownKey);
    expect(r?.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    // and the schema itself does not hand back a stripped copy
    expect(GherkinScenarioEntry.safeParse(bugEntry({ extra: 1 })).success).toBe(false);
  });

  test('test_file_content over 32 KiB is REFUSED (chars, and UTF-8 bytes)', () => {
    const chars = checkDescriptionScenarios(
      descOf([bugEntry({ test_file_content: 'x'.repeat(TEST_FILE_CONTENT_MAX + 1) })]),
    );
    expect(chars?.code).toBe(SCENARIO_CODES.tooLarge);
    // exactly at the cap is fine
    expect(
      checkDescriptionScenarios(descOf([bugEntry({ test_file_content: 'x'.repeat(TEST_FILE_CONTENT_MAX) })])),
    ).toBeNull();
    // 20,000 × 'é' = 20,000 chars (under the char cap) but 40,000 bytes
    const bytes = checkDescriptionScenarios(descOf([bugEntry({ test_file_content: 'é'.repeat(20_000) })]));
    expect(bytes?.code).toBe(SCENARIO_CODES.tooLarge);
  });

  test('each evidence field is shape-checked (refused, never .catch-dropped)', () => {
    const bad: Array<Record<string, unknown>> = [
      { test_file_sha256: 'A'.repeat(64) },
      { test_file_sha256: 'a'.repeat(63) },
      { base_sha: 'a'.repeat(39) },
      { test_path: '/etc/passwd' },
      { test_path: 'src/test_x.py' },
      { test_path: 'tests/../src/x.py' },
      { failing_test: '' },
      { expect_red: 'true' },
      { runner: 'Pytest UV' },
      { scenario_id: 'scn_XYZ' },
      { criterion_id: 'c_1' },
      { scenario_hash: 'nothex' },
      { test_file_content: 7 },
    ];
    for (const over of bad) {
      const r = checkDescriptionScenarios(descOf([bugEntry(over)]));
      expect({ over, code: r?.code }).toEqual({ over, code: SCENARIO_CODES.invalid });
    }
  });

  test('duplicate scenario_id is refused', () => {
    const r = checkDescriptionScenarios(descOf([bugEntry(), bugEntry({ criterion_id: 'crit_ffffffff' })]));
    expect(r?.code).toBe(SCENARIO_CODES.invalid);
  });

  test('the checked document is exactly the one hydration reads (```json fence, else raw {…})', () => {
    const fenced = 'prose\n\n```json\n' + descOf([bugEntry({ nope: 1 })]) + '\n```';
    expect(checkDescriptionScenarios(fenced)?.code).toBe(SCENARIO_CODES.unknownKey);
    expect(cardDocumentOf('just prose')).toBeUndefined();
    expect(cardDocumentOf('{not json')).toBeUndefined();
    expect(checkDescriptionScenarios('just prose')).toBeNull();
    expect(checkDescriptionScenarios(JSON.stringify({ title: 'no scenarios' }))).toBeNull();
    expect(checkDescriptionScenarios(undefined)).toBeNull();
    // the key present but not an array is malformed, not ignored
    expect(checkDescriptionScenarios(JSON.stringify({ gherkin_scenarios: 'x' }))?.code).toBe(SCENARIO_CODES.invalid);
  });
});

describe('canonical-scenarios-hash v1 (vendored reference)', () => {
  test('the vendored files are byte-identical to the published spec', () => {
    for (const [file, want] of Object.entries(VENDORED_SHA256)) {
      expect({ file, sha: sha256(readFileSync(join(VENDOR_DIR, file))) }).toEqual({ file, sha: want });
    }
  });

  const vectors = JSON.parse(readFileSync(join(VENDOR_DIR, 'vectors.json'), 'utf8')) as {
    vectors: Array<{ name: string; input: unknown[]; canonical: string; sha256: string }>;
    must_throw: Array<{ name: string; input: unknown[] }>;
  };

  test('every golden vector: canonical bytes AND sha256 match', () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);
    for (const v of vectors.vectors) {
      expect({ name: v.name, canonical: canonicalScenariosString(v.input) }).toEqual({
        name: v.name,
        canonical: v.canonical,
      });
      expect({ name: v.name, sha: scenariosHash(v.input) }).toEqual({ name: v.name, sha: v.sha256 });
    }
  });

  test('every must_throw input throws', () => {
    expect(vectors.must_throw.length).toBeGreaterThan(0);
    for (const v of vectors.must_throw) expect(() => scenariosHash(v.input)).toThrow();
  });

  test('a STORED entry: evidence fields are OUT of the hash, gherkin/title/ids are IN', () => {
    const stored = (JSON.parse(descOf([bugEntry({ gherkin: 'Scenario: x\n  Given y\n' })])) as {
      gherkin_scenarios: Array<Record<string, unknown>>;
    }).gherkin_scenarios;
    expect(checkDescriptionScenarios(descOf(stored))).toBeNull();
    const base = scenariosHash(stored);
    const with_ = (over: Record<string, unknown>) => scenariosHash([{ ...stored[0], ...over }]);

    // OUT: every contract-v2 evidence field + lifecycle fields.
    const evidence: Record<string, unknown> = {
      test_file_content: TEST_FILE + '\n# edited\n',
      test_file_sha256: 'c'.repeat(64),
      test_path: 'tests/test_other.py',
      failing_test: 'tests/test_other.py::t',
      base_sha: 'd'.repeat(40),
      expect_red: false,
      runner: 'other',
      status: 'pending',
      scenario_hash: 'e'.repeat(64),
    };
    for (const [k, v] of Object.entries(evidence)) {
      expect({ k, h: with_({ [k]: v }) }).toEqual({ k, h: base });
    }
    // IN: exactly the v1 allowlist.
    for (const [k, v] of Object.entries({
      gherkin: 'Scenario: x\n  Given z\n',
      title: 'another title',
      criterion_id: 'crit_99999999',
      scenario_id: 'scn_99999999',
    })) {
      expect({ k, changed: with_({ [k]: v }) !== base }).toEqual({ k, changed: true });
    }
  });
});

describe('fr scenariosHash == canonical v1 (explicit allowlist)', () => {
  const vectors = JSON.parse(readFileSync(join(VENDOR_DIR, 'vectors.json'), 'utf8')) as {
    vectors: Array<{ name: string; input: Array<Record<string, unknown>>; canonical: string; sha256: string }>;
    must_throw: Array<{ name: string; input: Array<Record<string, unknown>> }>;
  };

  test('every golden vector: fr canonical bytes AND sha256 match; must_throw throws', () => {
    for (const v of vectors.vectors) {
      expect({ name: v.name, c: frCanonical(v.input), h: frHash(v.input) }).toEqual({
        name: v.name,
        c: v.canonical,
        h: v.sha256,
      });
    }
    for (const v of vectors.must_throw) expect(() => frHash(v.input)).toThrow();
  });

  test('fr == the reference implementation on a stored bug-path entry, and evidence is OUT', () => {
    const e = bugEntry({ gherkin: 'Scenario: x\r\n  Given y  \n\n' });
    expect(frHash([e])).toBe(scenariosHash([e]));
    const base = frHash([e]);
    for (const k of ['test_file_content', 'test_file_sha256', 'test_path', 'failing_test', 'base_sha', 'expect_red', 'runner', 'status', 'scenario_hash']) {
      const { [k]: _gone, ...without } = e;
      expect({ k, h: frHash([without]) }).toEqual({ k, h: base });
    }
    expect(frHash([{ ...e, gherkin: 'Scenario: x\n  Given z\n' }])).not.toBe(base);
  });
});

describe('qa_needs_info and the paths that write straight to Planka', () => {
  test('every refusal body carries qa_needs_info repro_malformed — never test_file_changed', () => {
    for (const desc of [
      descOf([bugEntry({ extra: 1 })]),
      descOf([bugEntry({ test_file_content: 'x'.repeat(TEST_FILE_CONTENT_MAX + 1) })]),
      descOf([bugEntry({ base_sha: 'nope' })]),
    ]) {
      const body = scenarioRefusalBody(checkDescriptionScenarios(desc)!);
      expect(body.qa_needs_info).toBe('repro_malformed');
      expect(JSON.stringify(body).includes('test_file_changed')).toBe(false);
    }
  });

  test('assertDescriptionScenarios (kanban / agent / bridge writers) REFUSES test_file_content: it must never reach Planka', () => {
    let err: unknown;
    try {
      assertDescriptionScenarios(descOf([bugEntry()]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe(SCENARIO_CODES.contentNotAcceptedHere);
    expect((err as AppError).details.qa_needs_info).toBe('repro_malformed');
    // the same entry without the file is fine on those paths
    const { test_file_content: _c, ...pointerOnly } = bugEntry();
    expect(() => assertDescriptionScenarios(descOf([pointerOnly]))).not.toThrow();
    expect(() => assertDescriptionScenarios('plain prose')).not.toThrow();
  });

  test('splitScenarioEvidence: content out, pointer kept; sha mismatch refused', () => {
    const split = splitScenarioEvidence(descOf([bugEntry()]));
    if ('refusal' in split) throw new Error('unexpected refusal');
    expect(split.evidence.map((e) => e.test_file_sha256)).toEqual([sha256(TEST_FILE)]);
    expect(split.description!.includes('test_file_content')).toBe(false);
    const bad = splitScenarioEvidence(descOf([bugEntry({ test_file_sha256: 'f'.repeat(64) })]));
    expect('refusal' in bad && bad.refusal.code).toBe(SCENARIO_CODES.shaMismatch);
    const noSha = bugEntry();
    delete noSha.test_file_sha256;
    const missing = splitScenarioEvidence(descOf([noSha]));
    expect('refusal' in missing && missing.refusal.code).toBe(SCENARIO_CODES.shaMismatch);
  });
});

// ── audit fixes: fail CLOSED on evidence the parsed document does not account
// for; refuse text Postgres cannot store ─────────────────────────────────────
// MUTATION CONTROLS (each applied, run RED, reverted — see the commit report):
//   * locateCardDocument: stop after the FIRST ``` candidate → "``` inside" RED.
//   * checkDescriptionScenarios / splitScenarioEvidence: drop the
//     evidenceOutsideDocument backstop → "second fence" / "unparseable" RED.
//   * pgText refine → always true → NUL / lone surrogate RED.
const TICKS_FILE = 'def test_x():\n    doc = """```python\nprint(1)\n```"""\n    assert False\n';
const fenced = (doc: unknown, pre = 'Intro\n', post = '\n') =>
  `${pre}\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`${post}`;
const tickEntry = () => bugEntry({ test_file_content: TICKS_FILE, test_file_sha256: sha256(TICKS_FILE) });

describe('evidence the card document does not account for is REFUSED (fail closed)', () => {
  test('``` inside test_file_content: the fence is found by structure, the file split OUT, the rewrite has no ```', () => {
    const desc = fenced({ title: 'x', gherkin_scenarios: [tickEntry()] }, 'Intro\n', '\ntrailer');
    expect(checkDescriptionScenarios(desc)).toBeNull();
    const split = splitScenarioEvidence(desc);
    if ('refusal' in split) throw new Error('unexpected refusal ' + split.refusal.code);
    expect(split.evidence.length).toBe(1);
    expect(split.evidence[0]!.entry.test_file_content).toBe(TICKS_FILE);
    const out = split.description!;
    expect(out.includes('test_file_content')).toBe(false);
    expect(out.startsWith('Intro\n```json\n')).toBe(true);
    expect(out.endsWith('```\ntrailer')).toBe(true);
    // hydration's LAZY first-``` match now reads exactly the stripped document
    const lazy = JSON.parse(out.match(/```json\s*([\s\S]*?)```/i)![1]!) as Record<string, unknown>;
    expect(lazy).toEqual(cardDocumentOf(out) as Record<string, unknown>);
    expect((lazy.gherkin_scenarios as Array<Record<string, unknown>>)[0]!.test_file_sha256).toBe(sha256(TICKS_FILE));
    // kanban / agent / bridge: still refused as "not accepted here", never passed
    expect(() => assertDescriptionScenarios(desc)).toThrow();
    try {
      assertDescriptionScenarios(desc);
    } catch (e) {
      expect((e as AppError).code).toBe(SCENARIO_CODES.contentNotAcceptedHere);
    }
  });

  test('a SECOND fenced block carrying test_file_content is refused on every path', () => {
    const second = fenced({ gherkin_scenarios: [bugEntry()] }, '', '');
    for (const desc of [
      fenced({ title: 'x' }) + '\n' + second, // first fence has no scenarios
      fenced({ gherkin_scenarios: [] }) + '\n' + second,
      'prose\n' + second.replace('```json', '```yaml'), // not a json fence at all
    ]) {
      expect(checkDescriptionScenarios(desc)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
      const split = splitScenarioEvidence(desc);
      expect('refusal' in split && split.refusal.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
      expect(() => assertDescriptionScenarios(desc)).toThrow();
    }
  });

  test('a fence that never parses but carries test_file_content is refused (no document ⇒ no pass-through)', () => {
    const broken = 'Intro\n```json\n{"gherkin_scenarios":[{"test_file_content": "x", ```\n';
    expect(cardDocumentOf(broken)).toBeUndefined();
    const r = checkDescriptionScenarios(broken);
    expect(r?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    expect(scenarioRefusalBody(r!).qa_needs_info).toBe('repro_malformed');
    const split = splitScenarioEvidence(broken);
    expect('refusal' in split).toBe(true);
    // a nested / top-level key the split would not strip is refused too
    expect(checkDescriptionScenarios(JSON.stringify({ test_file_content: 'x' }))?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
    expect(checkDescriptionScenarios(JSON.stringify({ meta: { test_file_content: 'x' } }))?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
    // prose OUTSIDE any parsed document that names the key is refused too: the
    // normalised-text backstop cannot tell a mention from a key form there
    // (YAML, `\"k\":`, an escaped copy), so it fails closed. Measured before
    // tightening: 0 of 5901 prod Planka cards carry the name at all.
    expect(checkDescriptionScenarios('we split test_file_content out of Planka')?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
    // ...and so is a string VALUE inside a parsed document that names it (fourth
    // audit NO): a string value can itself be JSON one parse away from the real
    // key, so only the key's own position on a scenario entry is accounted for.
    expect(checkDescriptionScenarios(JSON.stringify({ title: 'we split test_file_content out' }))?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
  });
});

describe('text Postgres cannot store is refused at validation (400, never a 5xx)', () => {
  test.each([
    ['NUL', 'abc\u0000def'],
    ['lone high surrogate', 'abc\ud800def'],
    ['lone low surrogate', 'abc\udc00'],
  ])('%s in test_file_content → gherkin_scenario_text_not_storable, repro_malformed', (_n, content) => {
    const desc = descOf([bugEntry({ test_file_content: content, test_file_sha256: sha256(content) })]);
    const r = checkDescriptionScenarios(desc);
    expect(r?.code).toBe(SCENARIO_CODES.notStorable);
    expect(scenarioRefusalBody(r!).qa_needs_info).toBe('repro_malformed');
  });

  test('NUL in title / gherkin is refused too; a valid surrogate PAIR is fine', () => {
    expect(checkDescriptionScenarios(descOf([bugEntry({ title: 't\u0000' })]))?.code).toBe(SCENARIO_CODES.notStorable);
    expect(checkDescriptionScenarios(descOf([bugEntry({ gherkin: 'Given \ud800' })]))?.code).toBe(
      SCENARIO_CODES.notStorable,
    );
    const ok = 'emoji 😀 ok';
    expect(checkDescriptionScenarios(descOf([bugEntry({ test_file_content: ok, test_file_sha256: sha256(ok) })]))).toBeNull();
  });
});

// ── third audit NO: detection is STRUCTURAL — escaped keys, every document ───
// The detector used to return "no key" whenever the RAW text lacked the literal
// `test_file_content`; a key written `"test_file_\u0063ontent"` parses to the
// real key and went to Planka. MUTATION CONTROLS (each applied, run RED,
// reverted — see the commit report):
//   * put back `if (!description.includes('test_file_content')) return false`
//     → "escaped key nested outside entries" + "whole-description raw JSON" RED.
//   * drop the normalised-text backstop (layer 2 of hasScenarioEvidenceKey)
//     → "escaped key in prose" + "duplicate key hides one" RED.
//   * make the walk shallow (the structural walk stops descending)
//     → "escaped key nested outside entries" RED (the backstop counts the
//       nested key as accounted for — placement is the walk's job alone).
/** `"test_file_content"` → `"test_file_\u0063ontent"` in serialised JSON (same key once parsed). */
const escKey = (json: string) => json.split('"test_file_content"').join('"test_file_\\u0063ontent"');
const BIG = 'x'.repeat(5000);

describe('escaped evidence keys are detected by structure, not by raw text', () => {
  test('normaliseJsonEscapes decodes left to right, to a fixpoint, surrogate pairs included', () => {
    expect(normaliseJsonEscapes('test_file_\\u0063ontent')).toBe('test_file_content');
    expect(normaliseJsonEscapes('test_file_\\\\u0063ontent')).toBe('test_file_content'); // escaped twice
    expect(normaliseJsonEscapes('\\ud83d\\ude00')).toBe('😀');
    expect(normaliseJsonEscapes('a\\/b\\"c')).toBe('a/b"c');
  });

  test('escaped key nested OUTSIDE scenario entries (fenced) is refused on every path', () => {
    const desc = escKey(fenced({ title: 't', extra: { test_file_content: BIG } }));
    expect(desc.includes('test_file_content')).toBe(false); // the raw literal really is absent
    expect(hasScenarioEvidenceKey(desc, { allowOnEntries: true })).toBe(true);
    expect(hasScenarioEvidenceKey(desc, { allowOnEntries: false })).toBe(true);
    expect(checkDescriptionScenarios(desc)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    const split = splitScenarioEvidence(desc);
    expect('refusal' in split && split.refusal.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    expect(() => assertDescriptionScenarios(desc)).toThrow();
    // nested in an array of objects, too
    const inArray = escKey(fenced({ title: 't', notes: [{ a: 1 }, { deep: [{ test_file_content: 'x' }] }] }));
    expect(checkDescriptionScenarios(inArray)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
  });

  test('escaped key on a scenario ENTRY is split out and stored — never passed through', () => {
    const desc = escKey(fenced({ title: 'x', gherkin_scenarios: [bugEntry()] }));
    expect(desc.includes('test_file_content')).toBe(false);
    expect(checkDescriptionScenarios(desc)).toBeNull();
    const split = splitScenarioEvidence(desc);
    if ('refusal' in split) throw new Error('unexpected refusal ' + split.refusal.code);
    expect(split.evidence.length).toBe(1);
    expect(split.evidence[0]!.entry.test_file_content).toBe(TEST_FILE);
    const out = split.description!;
    expect(normaliseJsonEscapes(out).includes('test_file_content')).toBe(false);
    expect(hasScenarioEvidenceKey(out, { allowOnEntries: false })).toBe(false); // the chokepoint lets the split output go
    expect((cardDocumentOf(out) as { gherkin_scenarios: Array<Record<string, unknown>> }).gherkin_scenarios[0]!.test_file_sha256).toBe(
      sha256(TEST_FILE),
    );
    // the straight-to-Planka writers refuse it as "not accepted here"
    expect(() => assertDescriptionScenarios(desc)).toThrow();
    try {
      assertDescriptionScenarios(desc);
    } catch (e) {
      expect((e as AppError).code).toBe(SCENARIO_CODES.contentNotAcceptedHere);
    }
    // and the post-split chokepoint refuses the un-split form
    expect(hasScenarioEvidenceKey(desc, { allowOnEntries: false })).toBe(true);
  });

  test('surrogate-pair escapes: the key is still found, and an escaped emoji file is stored decoded', () => {
    const emoji = 'def test_x():\n    assert "😀" == "😀"\n';
    const entry = bugEntry({ test_file_content: emoji, test_file_sha256: sha256(emoji) });
    // serialise with every non-ASCII char as \uXXXX (a surrogate PAIR for the emoji)
    const asciiOnly = (j: string) => j.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const desc = escKey(asciiOnly(fenced({ title: 'x', gherkin_scenarios: [entry] })));
    expect(desc).toContain('\\ud83d\\ude00');
    const split = splitScenarioEvidence(desc);
    if ('refusal' in split) throw new Error('unexpected refusal ' + split.refusal.code);
    expect(split.evidence[0]!.entry.test_file_content).toBe(emoji);
    // a key whose escape sits next to a surrogate pair, nested outside entries: refused
    const nested = '```json\n{"\\ud83d\\ude00":{"\\u0074est_file_content":"x"}}\n```';
    expect(checkDescriptionScenarios(nested)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    expect(hasScenarioEvidenceKey(nested, { allowOnEntries: false })).toBe(true);
  });

  test('whole-description raw JSON (no fence) with an escaped key is refused', () => {
    for (const desc of [
      escKey(JSON.stringify({ extra: { test_file_content: BIG } })),
      '  ' + escKey(JSON.stringify({ extra: { test_file_content: 'x' } })), // leading whitespace
      escKey(JSON.stringify([{ test_file_content: 'x' }])), // an array document
    ]) {
      expect(desc.includes('test_file_content')).toBe(false);
      expect(checkDescriptionScenarios(desc)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
      expect(hasScenarioEvidenceKey(desc, { allowOnEntries: false })).toBe(true);
    }
  });

  test('normalised-text backstop: escaped key in prose, and a duplicate key the parse drops', () => {
    expect(checkDescriptionScenarios('pasted: {\\"test_file_\\u0063ontent\\": \\"x\\"}')?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
    expect(hasScenarioEvidenceKey('notes\ntest_file_\\u0063ontent: |\n  def t(): pass', { allowOnEntries: false })).toBe(true);
    // JSON.parse keeps the LAST "extra" — the first one's bytes would still go to Planka
    const dup = '```json\n{"title":"t","extra":{"test_file_content":"' + BIG + '"},"extra":{}}\n```';
    expect(JSON.stringify(cardDocumentOf(dup))).not.toContain('test_file_content');
    expect(checkDescriptionScenarios(dup)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    expect(hasScenarioEvidenceKey(dup, { allowOnEntries: false })).toBe(true);
    // a later fence carrying an escaped key is a document too
    const second = fenced({ title: 't' }) + '\n' + escKey(fenced({ test_file_content: 'x' }, '', ''));
    expect(checkDescriptionScenarios(second)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
  });

  test('positive controls: ordinary descriptions are NOT refused', () => {
    const clean = [
      fenced({ title: 'x', gherkin_scenarios: [bugEntry({ test_file_content: undefined })].map(({ test_file_content: _d, ...e }) => e) }),
      'Plain prose card.\n\n' + fenced({ title: 'x', emoji: '😀' }) + '\ntrailer',
      JSON.stringify({ title: 'raw doc', acceptance: ['a', 'b'] }),
      'just prose',
      '',
    ];
    for (const d of clean) {
      expect({ d: d.slice(0, 60), r: checkDescriptionScenarios(d) }).toEqual({ d: d.slice(0, 60), r: null });
      expect(hasScenarioEvidenceKey(d, { allowOnEntries: false })).toBe(false);
    }
    // fourth audit NO: only the key ON a top-level scenario entry is accounted
    // for, so a value naming it, or a different key containing the name, is refused
    for (const d of [
      fenced({ title: 'value mentions test_file_content: but it is a value', note: 'test_file_\\u0063ontent as text' }),
      fenced({ my_test_file_content_note: 'a different key that contains the name' }),
    ]) {
      expect(checkDescriptionScenarios(d)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    }
  });
});

// ── fourth audit NO: JSON inside STRING values, and pathological nesting ─────
// p4 probe: a ```json fence whose `repro` STRING held JSON.stringify(entry), and
// a description that is itself a JSON *string* of the card document, both
// passed every check and put 30 KB of test file on the Planka wire — the
// string values were "accounted for", and one more parse yields the real key.
// MUTATION CONTROLS (each applied, run RED, reverted — see the commit report):
//   * no string recursion in scanDocument (`nestedJson` → undefined)
//       → "9 string layers are refused" + "100k-level nesting" (the string-held
//         case) RED, here and at the transport (the backstop has no layer bound)
//   * nested occurrences accounted (a key under a string layer counted, not refused)
//       → both p4 cases + both triple-nested cases RED, here and at the transport
//   * no catch in hasScenarioEvidenceKey → "any detector exception is a refusal" RED
//     (the iterative, depth-capped walk no longer throws on real input, so the
//     catch is pinned with an injected failure)
const p4Entry = () => ({ scenario_id: 'scn_p4', test_file_content: 'X'.repeat(30_000) });
const P4: Record<string, () => string> = {
  'A: fence whose string value is JSON.stringify(entry)': () =>
    '```json\n' + JSON.stringify({ title: 't', repro: JSON.stringify(p4Entry()) }) + '\n```',
  'B: the description is a JSON string of the card document': () =>
    JSON.stringify(JSON.stringify({ gherkin_scenarios: [p4Entry()] })),
  'triple-nested stringified document in a value': () =>
    fenced({ title: 't', repro: JSON.stringify(JSON.stringify(JSON.stringify({ gherkin_scenarios: [p4Entry()] }))) }),
  'triple-nested, ESCAPED key (no raw literal anywhere)': () =>
    fenced({
      title: 't',
      repro: JSON.stringify(JSON.stringify(escKey(JSON.stringify({ gherkin_scenarios: [p4Entry()] })))),
    }),
};
/** `layers` string layers around `v`: each layer is one more JSON.parse away from it. */
const stringLayers = (v: unknown, layers: number): string => {
  let s: unknown = v;
  for (let i = 0; i < layers; i++) s = JSON.stringify(s);
  return s as string;
};
const deepObject = (n: number, leaf = '1') => '{"a":'.repeat(n) + leaf + '}'.repeat(n);

describe('evidence inside JSON-string values is found (bounded), pathological nesting fails closed', () => {
  for (const [name, make] of Object.entries(P4)) {
    test(`${name}: refused on every path, never split through`, () => {
      const desc = make();
      expect(hasScenarioEvidenceKey(desc, { allowOnEntries: true })).toBe(true);
      expect(hasScenarioEvidenceKey(desc, { allowOnEntries: false })).toBe(true);
      expect(checkDescriptionScenarios(desc)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
      const split = splitScenarioEvidence(desc);
      expect('refusal' in split && split.refusal.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
      expect(() => assertDescriptionScenarios(desc)).toThrow(AppError);
    });
  }

  test('the escaped triple-nested case really has no raw literal', () => {
    expect(P4['triple-nested, ESCAPED key (no raw literal anywhere)']!().includes('test_file_content')).toBe(false);
  });

  test('9 string layers are refused (fail closed) even with no key; 8 harmless layers pass', () => {
    const harmless = { note: 'no evidence here', n: [1, 2, 3] };
    const nine = fenced({ title: 't', blob: stringLayers(harmless, 9) });
    expect(hasScenarioEvidenceKey(nine, { allowOnEntries: true })).toBe(true);
    expect(checkDescriptionScenarios(nine)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    // fr#1359: the refusal names its REAL reason — there is no key here
    expect(scenarioEvidenceVerdict(nine, { allowOnEntries: true })).toBe('nesting_limit');
    expect(scenarioEvidenceVerdict(nine, { allowOnEntries: false })).toBe('nesting_limit');
    expect(checkDescriptionScenarios(nine)?.message).toContain('nested past the evidence detector');
    expect(checkDescriptionScenarios(nine)?.message).not.toContain('appears outside');
    const eight = fenced({ title: 't', blob: stringLayers(harmless, 8) });
    expect(checkDescriptionScenarios(eight)).toBeNull();
    expect(hasScenarioEvidenceKey(eight, { allowOnEntries: false })).toBe(false);
    expect(scenarioEvidenceVerdict(eight, { allowOnEntries: true })).toBeNull();
    // and with the key at layer 9 / layer 8: refused either way
    expect(checkDescriptionScenarios(fenced({ blob: stringLayers({ test_file_content: 'x' }, 9) }))?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
    expect(checkDescriptionScenarios(fenced({ blob: stringLayers({ test_file_content: 'x' }, 8) }))?.code).toBe(
      SCENARIO_CODES.evidenceOutsideDocument,
    );
  });

  test('100k-level nesting (object, array, inside a string value) is a 400 refusal, not a throw', () => {
    for (const desc of [
      deepObject(100_000),
      deepObject(100_000, '{"test_file_content":"x"}'),
      '['.repeat(100_000) + ']'.repeat(100_000),
      fenced({ title: 't', blob: deepObject(100_000) }),
    ]) {
      expect(() => hasScenarioEvidenceKey(desc, { allowOnEntries: true })).not.toThrow();
      expect(checkDescriptionScenarios(desc)?.code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
      // fr#1359: the depth cap is hit before any key, so the reason is the limit
      expect(scenarioEvidenceVerdict(desc, { allowOnEntries: true })).toBe('nesting_limit');
      let caught: unknown;
      try {
        assertDescriptionScenarios(desc);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).statusCode).toBe(400);
      expect((caught as AppError).code).toBe(SCENARIO_CODES.evidenceOutsideDocument);
    }
    // ordinary nesting is nowhere near the cap
    expect(checkDescriptionScenarios(deepObject(200))).toBeNull();
  });

  test('a real evidence key is reported as evidence_key', () => {
    expect(scenarioEvidenceVerdict(fenced({ x: { test_file_content: 'y' } }), { allowOnEntries: true })).toBe('evidence_key');
  });

  test('positive control: string values holding harmless JSON (no key) still pass', () => {
    const d = fenced({
      title: 'x',
      example_payload: JSON.stringify({ rows: [], ok: true }),
      nested: JSON.stringify(JSON.stringify({ a: [1, { b: 'c' }] })),
      quoted: '"just a quoted phrase"',
      list: '[1, 2, 3]',
    });
    expect(checkDescriptionScenarios(d)).toBeNull();
    expect(hasScenarioEvidenceKey(d, { allowOnEntries: false })).toBe(false);
    expect(hasScenarioEvidenceKey(JSON.stringify(JSON.stringify({ title: 'x' })), { allowOnEntries: false })).toBe(false);
  });

  test('a legit card with evidence on a top-level scenario entry is still split (string JSON elsewhere included)', () => {
    const desc = fenced({
      title: 'x',
      example_payload: JSON.stringify({ rows: [] }),
      gherkin_scenarios: [bugEntry()],
    });
    expect(checkDescriptionScenarios(desc)).toBeNull();
    const split = splitScenarioEvidence(desc);
    if ('refusal' in split) throw new Error('unexpected refusal ' + split.refusal.code);
    expect(split.evidence.length).toBe(1);
    expect(split.evidence[0]!.entry.test_file_content).toBe(TEST_FILE);
    expect(hasScenarioEvidenceKey(split.description, { allowOnEntries: false })).toBe(false);
    // the evidence VALUE is dropped whole with its key, so a test file that names
    // the key (or is itself JSON carrying it) is still the entry's own evidence
    const selfRef = 'def test_x():\n    assert "test_file_content" in {"test_file_content": 1}\n';
    const d2 = fenced({ gherkin_scenarios: [bugEntry({ test_file_content: selfRef, test_file_sha256: sha256(selfRef) })] });
    expect(checkDescriptionScenarios(d2)).toBeNull();
    const s2 = splitScenarioEvidence(d2);
    if ('refusal' in s2) throw new Error('unexpected refusal ' + s2.refusal.code);
    expect(normaliseJsonEscapes(s2.description!).includes('test_file_content')).toBe(false);
  });
});

// ── appendScenarioEntries (POST /api/cards/:id/scenario-evidence, G-26 gap A) ──
describe('appendScenarioEntries — the pointer append to an EXISTING card document', () => {
  const ptr = (scn: string, over: Record<string, unknown> = {}) => ({
    scenario_id: scn,
    criterion_id: 'crit_' + scn.slice(4),
    test_file_sha256: 'a'.repeat(64),
    ...over,
  });
  const scenarios = (d: string) => (cardDocumentOf(d) as { gherkin_scenarios: unknown[] }).gherkin_scenarios;

  test('empty / null description BECOMES the card document', () => {
    for (const d of [null, undefined, '', '  ']) {
      const r = appendScenarioEntries(d, [ptr('scn_00000001')]);
      if (!('description' in r)) throw new Error('expected a description');
      expect(JSON.parse(r.description)).toEqual({ gherkin_scenarios: [ptr('scn_00000001')] });
      expect(r.appended).toEqual(['scn_00000001']);
    }
  });

  test('a fenced document is rewritten in its span only; prose before AND after kept byte-for-byte', () => {
    const d = 'head ``` prose\n\n```json\n{"title":"t","gherkin_scenarios":[' + JSON.stringify(ptr('scn_00000001')) + ']}\n```\ntail';
    const r = appendScenarioEntries(d, [ptr('scn_00000002')]);
    if (!('description' in r)) throw new Error('expected a description');
    expect(r.description.startsWith('head ``` prose\n\n```json\n')).toBe(true);
    expect(r.description.endsWith('\n```\ntail')).toBe(true);
    expect(scenarios(r.description)).toEqual([ptr('scn_00000001'), ptr('scn_00000002')]);
    expect((cardDocumentOf(r.description) as { title: string }).title).toBe('t');
  });

  test('prose with no document gets a ```json fence appended; the prose is kept verbatim', () => {
    const r = appendScenarioEntries('## Bug\nsteps', [ptr('scn_00000003')]);
    if (!('description' in r)) throw new Error('expected a description');
    expect(r.description.startsWith('## Bug\nsteps\n\n```json\n')).toBe(true);
    expect(scenarios(r.description)).toEqual([ptr('scn_00000003')]);
  });

  test('an IDENTICAL entry already on the card is not duplicated and the input is returned unchanged', () => {
    const d = JSON.stringify({ gherkin_scenarios: [{ test_file_sha256: 'a'.repeat(64), scenario_id: 'scn_00000004', criterion_id: 'crit_00000004' }] });
    const r = appendScenarioEntries(d, [ptr('scn_00000004')]);
    expect(r).toEqual({ description: d, appended: [], alreadyOnCard: ['scn_00000004'] });
  });

  test('a DIFFERENT entry for the scenario_id ⇒ conflict, never a rewrite', () => {
    const d = JSON.stringify({ gherkin_scenarios: [ptr('scn_00000005', { test_file_sha256: 'b'.repeat(64) })] });
    expect(appendScenarioEntries(d, [ptr('scn_00000005'), ptr('scn_00000006')])).toEqual({ conflict: ['scn_00000005'] });
  });

  test('an unparseable document, a non-object document, a non-array gherkin_scenarios ⇒ refusal', () => {
    const codes = ['{"broken":', '```json\n{"x":\n```', '```json\n[1,2]\n```', '{"gherkin_scenarios":{}}'].map((d) => {
      const r = appendScenarioEntries(d, [ptr('scn_00000007')]);
      return 'refusal' in r ? r.refusal.code : 'no refusal';
    });
    expect(codes).toEqual([
      'card_document_unparseable',
      'card_document_unparseable',
      'card_document_not_appendable',
      'card_document_not_appendable',
    ]);
  });
});
