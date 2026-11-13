// tests/unit/services/gherkin-scenarios-freeze.test.ts
//
// `freezeScenarioSet` — READY's freeze of an existing card's scenario set:
// merge the sent entries onto the STORED skeleton (gherkin authored, status
// pending → frozen, evidence pointers kept) and write
// `scenarios_check.scenario_hash`. The caller has already verified the hash is
// the canonical hash of the sent set; the freeze refuses anything that would
// RESHAPE the set (pairs, titles, other fields) and keeps ncn's readied_brief
// sentinel region after the raw head byte-for-byte.
//
// Expected hashes come from the VENDORED REFERENCE implementation
// (tests/fixtures/canonical-scenarios-hash/canonical-scenarios-hash.mjs) —
// never from the fr function under test.
//
// MUTATION CONTROL: each test names, in a one-line comment, the mutation of
// `freezeScenarioSet` that turns it RED.

import { describe, expect, test } from 'bun:test';

import {
  SCENARIO_FREEZE_CODES,
  appendScenarioEntries,
  cardDocumentOf,
  checkDescriptionScenarios,
  freezeScenarioSet,
} from '../../../src/services/gherkin-scenarios';
import { scenariosHash as refHash } from '../../fixtures/canonical-scenarios-hash/canonical-scenarios-hash.mjs';
import { AA_CQ_HASH, AA_CQ_HASH_STATE, AA_CQ_SCENARIOS } from './_ncn-cq-reader';

const SHA = 'a'.repeat(64);
const S1 = {
  scenario_id: 'scn_0a1b2c3d',
  criterion_id: 'crit_0a1b2c3d',
  title: 'probe exit 128 fails closed',
  gherkin: null,
  status: 'pending',
  test_file_sha256: SHA,
  failing_test: 'tests/t.py::test_scn_0a1b2c3d',
};
const S2 = { scenario_id: 'scn_1b2c3d4e', criterion_id: 'crit_1b2c3d4e', title: 'stdout false', gherkin: null, status: 'pending' };
const SKELETON: Array<Record<string, unknown>> = [S1, S2];

const GHERKIN = 'Scenario: probe\n  Given a probe exit 128\n  Then 500\n';
const SENT: Array<Record<string, unknown>> = [
  { scenario_id: S1.scenario_id, criterion_id: S1.criterion_id, title: S1.title, gherkin: GHERKIN, status: 'frozen' },
  // a null gherkin may be frozen as null
  { scenario_id: S2.scenario_id, criterion_id: S2.criterion_id, title: S2.title, gherkin: null, status: 'frozen' },
];
const H = refHash(SENT);

const TAIL =
  '\n\n<!-- aa:readied_brief:start -->\n```readied_brief\n{"goal":"ship it"}\n```\n<!-- aa:readied_brief:end -->';
const card = (set: Array<Record<string, unknown>> | undefined, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ title: 'card', gherkin_scenarios: set, scenarios_check: { criteria: ['c1'] }, ...extra }) + TAIL;

type Doc = { gherkin_scenarios: Array<Record<string, unknown>>; scenarios_check: Record<string, unknown> };
const headOf = (d: string) => JSON.parse(d.slice(0, d.length - TAIL.length)) as Doc;

const refusalCode = (r: ReturnType<typeof freezeScenarioSet>) => (r.kind === 'refusal' ? r.code : r.kind);

describe('freezeScenarioSet', () => {
  test('frozen: hash written, brief tail preserved, evidence pointers kept, null gherkin allowed', () => {
    // mutation: write `{ ...doc }` without scenarios_check.scenario_hash ⇒ RED
    const r = freezeScenarioSet(card(SKELETON), SENT, H);
    if (r.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(r));
    expect(r.scenarioCount).toBe(2);
    expect(r.description.endsWith(TAIL)).toBe(true);
    const doc = headOf(r.description);
    expect(doc.scenarios_check).toEqual({ criteria: ['c1'], scenario_hash: H });
    expect(doc.gherkin_scenarios.map((e) => e.scenario_id)).toEqual([S1.scenario_id, S2.scenario_id]);
    expect(doc.gherkin_scenarios[0]).toMatchObject({
      gherkin: GHERKIN,
      status: 'frozen',
      test_file_sha256: SHA,
      failing_test: S1.failing_test,
    });
    expect(doc.gherkin_scenarios[1]).toMatchObject({ gherkin: null, status: 'frozen' });
    expect(checkDescriptionScenarios(r.description)).toBeNull();
  });

  test('re-freeze with the stored hash ⇒ unchanged', () => {
    // mutation: drop the `=== scenarioHash` early return ⇒ RED (would be 'conflict' or a rewrite)
    const once = freezeScenarioSet(card(SKELETON), SENT, H);
    if (once.kind !== 'frozen') throw new Error('not frozen');
    expect(freezeScenarioSet(once.description, SENT, H)).toEqual({ kind: 'unchanged', scenarioCount: 2 });
  });

  test('a different stored hash ⇒ conflict, naming the stored hash', () => {
    // mutation: treat any stored hash as `unchanged` ⇒ RED
    const once = freezeScenarioSet(card(SKELETON), SENT, H);
    if (once.kind !== 'frozen') throw new Error('not frozen');
    expect(freezeScenarioSet(once.description, SENT, 'f'.repeat(64))).toEqual({ kind: 'conflict', storedHash: H });
  });

  test('no skeleton (missing or empty) ⇒ 409 scenarios_skeleton_missing', () => {
    // mutation: delete the `stored.length === 0` guard ⇒ RED (pairs-differ 422 instead)
    for (const d of [card(undefined), card([]), '']) {
      const r = freezeScenarioSet(d, SENT, H);
      expect(r.kind === 'refusal' && [r.code, r.status]).toEqual([SCENARIO_FREEZE_CODES.skeletonMissing, 409]);
    }
  });

  test('a changed title ⇒ 422 scenario_freeze_title_changed', () => {
    // mutation: delete the title comparison ⇒ RED (would freeze)
    const sent = [{ ...SENT[0], title: S1.title + '!' }, SENT[1]!];
    const r = freezeScenarioSet(card(SKELETON), sent, refHash(sent));
    expect(r.kind === 'refusal' && [r.code, r.status]).toEqual([SCENARIO_FREEZE_CODES.titleChanged, 422]);
  });

  test('different {scenario_id, criterion_id} pairs ⇒ 422 scenario_freeze_pairs_differ', () => {
    // mutation: compare only set sizes (or only scenario_ids) ⇒ RED
    const dropped = [SENT[0]!];
    expect(refusalCode(freezeScenarioSet(card(SKELETON), dropped, refHash(dropped)))).toBe(
      SCENARIO_FREEZE_CODES.pairsDiffer,
    );
    const recrit = [SENT[0]!, { ...SENT[1], criterion_id: 'crit_99999999' }];
    expect(refusalCode(freezeScenarioSet(card(SKELETON), recrit, refHash(recrit)))).toBe(
      SCENARIO_FREEZE_CODES.pairsDiffer,
    );
  });

  test('status approved → frozen ⇒ 422 scenario_freeze_field_changed', () => {
    // mutation: accept any sent status ⇒ RED
    const r = freezeScenarioSet(card([{ ...S1, status: 'approved' }, S2]), SENT, H);
    expect(r.kind === 'refusal' && [r.code, r.status]).toEqual([SCENARIO_FREEZE_CODES.fieldChanged, 422]);
    expect(r.kind === 'refusal' && r.message).toContain(`${S1.scenario_id}.status`);
  });

  test('any other sent field that differs from the stored one ⇒ 422 field_changed (keys listed)', () => {
    // mutation: skip the "every other sent key" loop ⇒ RED (would freeze, silently dropping the change)
    const sent = [{ ...SENT[0], test_path: 'tests/other.py', failing_test: 'tests/x.py::y' }, SENT[1]!];
    const r = freezeScenarioSet(card(SKELETON), sent, refHash(sent));
    expect(refusalCode(r)).toBe(SCENARIO_FREEZE_CODES.fieldChanged);
    expect(r.kind === 'refusal' && r.message).toContain(`${S1.scenario_id}.test_path`);
    expect(r.kind === 'refusal' && r.message).toContain(`${S1.scenario_id}.failing_test`);
    // an identical evidence pointer is not a change
    const same = [{ ...SENT[0], test_file_sha256: SHA }, SENT[1]!];
    expect(freezeScenarioSet(card(SKELETON), same, refHash(same)).kind).toBe('frozen');
  });

  test('a stored non-null gherkin sent different ⇒ 422 field_changed; sent identical ⇒ frozen', () => {
    // mutation: always take the sent gherkin ⇒ RED
    const authored = [{ ...S1, gherkin: 'Scenario: old\n' }, S2];
    expect(refusalCode(freezeScenarioSet(card(authored), SENT, H))).toBe(SCENARIO_FREEZE_CODES.fieldChanged);
    const sent = [{ ...SENT[0], gherkin: 'Scenario: old\n' }, SENT[1]!];
    expect(freezeScenarioSet(card(authored), sent, refHash(sent)).kind).toBe('frozen');
  });

  test('a criterion_id of width 7 (on both sides) ⇒ 422 scenario_freeze_criterion_id_not_canonical', () => {
    // mutation: widen FREEZE_CRITERION_ID to the schema's crit_<1..64 hex> ⇒ RED (would freeze)
    const crit7 = 'crit_0a1b2c3';
    const sent = [{ ...SENT[0], criterion_id: crit7 }, SENT[1]!];
    const r = freezeScenarioSet(card([{ ...S1, criterion_id: crit7 }, S2]), sent, refHash(sent));
    expect(r.kind === 'refusal' && [r.code, r.status]).toEqual([SCENARIO_FREEZE_CODES.criterionIdNotCanonical, 422]);
  });
});

// ── the readied_brief must not SHADOW the frozen head (ncn reads the brief first) ──

const GOAL_BRIEF = '{"goal":"ship it"}';
/** The skeleton card with `briefText` (verbatim, may be non-JSON) inside ncn's readied_brief fence. */
const withBrief = (briefText: string, head: string = JSON.stringify({ title: 'card', gherkin_scenarios: SKELETON, scenarios_check: { criteria: ['c1'] } })) =>
  head + '\n\n<!-- aa:readied_brief:start -->\n```readied_brief\n' + briefText + '\n```\n<!-- aa:readied_brief:end -->';
const conflictOf = (r: ReturnType<typeof freezeScenarioSet>) =>
  r.kind === 'refusal' ? [r.code, r.status] : r.kind;

describe('freezeScenarioSet — readied_brief shadowing', () => {
  test('brief with a non-empty gherkin_scenarios ⇒ 409 scenarios_brief_conflict; an EMPTY array ⇒ frozen', () => {
    // mutation: drop the brief.gherkin_scenarios leg of briefShadowRefusal ⇒ RED (would freeze)
    const r = freezeScenarioSet(withBrief(JSON.stringify({ gherkin_scenarios: [SENT[0]] })), SENT, H);
    expect(conflictOf(r)).toEqual([SCENARIO_FREEZE_CODES.briefConflict, 409]);
    expect(r.kind === 'refusal' && r.message).toContain('gherkin_scenarios');
    expect(freezeScenarioSet(withBrief(JSON.stringify({ gherkin_scenarios: [] })), SENT, H).kind).toBe('frozen');
  });

  test('brief scenarios_check.scenario_hash ≠ the frozen hash ⇒ 409 scenarios_brief_conflict', () => {
    // mutation: drop the `!== scenarioHash` comparison (or the whole hash leg) ⇒ RED (would freeze)
    const r = freezeScenarioSet(withBrief(JSON.stringify({ scenarios_check: { scenario_hash: 'f'.repeat(64) } })), SENT, H);
    expect(conflictOf(r)).toEqual([SCENARIO_FREEZE_CODES.briefConflict, 409]);
    expect(r.kind === 'refusal' && r.message).toContain('f'.repeat(64));
  });

  test('brief scenarios_check.scenario_hash EQUAL to the frozen hash ⇒ frozen', () => {
    // mutation: refuse any brief scenarios_check.scenario_hash (equality ignored) ⇒ RED
    const r = freezeScenarioSet(withBrief(JSON.stringify({ scenarios_check: { scenario_hash: H } })), SENT, H);
    expect(r.kind).toBe('frozen');
  });

  test('brief scenarios_check WITHOUT scenario_hash ⇒ frozen (ncn READY writer owes the hash into it)', () => {
    // mutation: refuse any brief scenarios_check object ⇒ RED
    const r = freezeScenarioSet(withBrief(JSON.stringify({ scenarios_check: { criteria: ['c1'] } })), SENT, H);
    expect(r.kind).toBe('frozen');
  });

  test('unparseable brief ⇒ frozen (ncn falls back to the head; scenarios_unknown when it has no set)', () => {
    // mutation: let the JSON.parse failure throw / refuse ⇒ RED
    const r = freezeScenarioSet(withBrief('{not json'), SENT, H);
    expect(r.kind).toBe('frozen');
  });

  test('replay (stored hash === sent) under a shadowing brief ⇒ conflict, NOT unchanged', () => {
    // mutation: return `unchanged` before calling briefShadowRefusal ⇒ RED
    const once = freezeScenarioSet(withBrief(GOAL_BRIEF), SENT, H);
    if (once.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(once));
    // CONTROL: the same replay with the clean brief is `unchanged`
    expect(freezeScenarioSet(once.description, SENT, H)).toEqual({ kind: 'unchanged', scenarioCount: 2 });
    const shadowed = once.description.replace(GOAL_BRIEF, JSON.stringify({ gherkin_scenarios: [SENT[0]] }));
    expect(shadowed).not.toBe(once.description);
    expect(conflictOf(freezeScenarioSet(shadowed, SENT, H))).toEqual([SCENARIO_FREEZE_CODES.briefConflict, 409]);
  });
});

// ── consumer parity: what ncn's QA reader sees on every description fr freezes ──

describe('freezeScenarioSet — ncn AA_CQ_SCENARIOS / AA_CQ_HASH_STATE parity', () => {
  const RAW_HEAD = JSON.stringify({ title: 'card', gherkin_scenarios: SKELETON, scenarios_check: { criteria: ['c1'] } });
  const cases: Array<[string, string]> = [
    ['raw head, no brief', RAW_HEAD],
    ['raw head + brief without scenario fields', withBrief(GOAL_BRIEF)],
    ['raw head + brief scenarios_check with the EQUAL hash', withBrief(JSON.stringify({ scenarios_check: { scenario_hash: H } }))],
    ['raw head + unparseable brief', withBrief('{not json')],
  ];
  for (const [name, description] of cases) {
    test(`${name}: fr 'frozen' ⇒ ncn hash state 'ok'`, () => {
      // mutation: write the hash anywhere ncn does not read it (or into a fenced copy) ⇒ RED ('missing')
      const r = freezeScenarioSet(description, SENT, H);
      if (r.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(r));
      const seen = AA_CQ_SCENARIOS(r.description, {});
      expect(seen.known).toBe(true);
      expect(seen.set.map((e) => e.scenario_id)).toEqual([S1.scenario_id, S2.scenario_id]);
      expect(seen.stored_hash).toBe(H);
      expect(AA_CQ_HASH_STATE(seen)).toBe('ok');
    });
  }

  test('CONTROL: the reader IS shadowed by a brief hash ≠ frozen — which is why fr refuses it', () => {
    // mutation: the reader copy ignores the brief (head-only) ⇒ RED (would read 'ok')
    const head = freezeScenarioSet(RAW_HEAD, SENT, H);
    if (head.kind !== 'frozen') throw new Error('not frozen');
    const shadowed = withBrief(JSON.stringify({ scenarios_check: { scenario_hash: 'f'.repeat(64) } }), head.description);
    expect(AA_CQ_HASH_STATE(AA_CQ_SCENARIOS(shadowed, {}))).toBe('mismatch');
    expect(conflictOf(freezeScenarioSet(shadowed, SENT, H))).toEqual([SCENARIO_FREEZE_CODES.briefConflict, 409]);
  });

  test('the reader copy hashes exactly as the vendored reference (canonical-scenarios-hash v1)', () => {
    // mutation: any drift in the copied AA_CQ_HASH / AA_CQ_SHA256 ⇒ RED
    expect(AA_CQ_HASH(SENT)).toBe(H);
  });
});

// ── a replay re-hashes the STORED set before it reports `unchanged` ──

describe('freezeScenarioSet — replay integrity of the stored set', () => {
  const frozenOnce = () => {
    const r = freezeScenarioSet(card(SKELETON), SENT, H);
    if (r.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(r));
    return r.description;
  };
  /** The frozen description with its stored set replaced by `f(set)` (hash + brief tail kept). */
  const tamper = (f: (set: Array<Record<string, unknown>>) => unknown) => {
    const doc = headOf(frozenOnce());
    return JSON.stringify({ ...doc, gherkin_scenarios: f(doc.gherkin_scenarios) }) + TAIL;
  };
  const EXTRA = { scenario_id: 'scn_2c3d4e5f', criterion_id: 'crit_2c3d4e5f', title: 'extra', gherkin: null, status: 'frozen' };
  const tampered: Array<[string, string]> = [
    ['stored gherkin edited', tamper((s) => s.map((e, i) => (i === 0 ? { ...e, gherkin: 'Scenario: edited\n' } : e)))],
    ['an extra stored entry', tamper((s) => [...s, EXTRA])],
    ['stored set emptied', tamper(() => [])],
    ['stored set removed', tamper(() => undefined)],
  ];
  for (const [name, d] of tampered) {
    test(`${name} ⇒ 409 scenarios_stored_hash_mismatch; ncn reads 'mismatch' or null`, () => {
      // mutation: return `unchanged` without re-hashing the stored set ⇒ RED (would be unchanged)
      expect(conflictOf(freezeScenarioSet(d, SENT, H))).toEqual([SCENARIO_FREEZE_CODES.storedHashMismatch, 409]);
      // parity: why fr refuses — QA would not read 'ok' over this card
      expect(['mismatch', null]).toContain(AA_CQ_HASH_STATE(AA_CQ_SCENARIOS(d, {})));
    });
  }

  test('CONTROL: an intact (re-serialised) stored set replays ⇒ unchanged', () => {
    // mutation: compare the recompute against anything but the stored hash (or refuse any replay) ⇒ RED
    const d = tamper((s) => s);
    expect(freezeScenarioSet(d, SENT, H)).toEqual({ kind: 'unchanged', scenarioCount: 2 });
    expect(AA_CQ_HASH_STATE(AA_CQ_SCENARIOS(d, {}))).toBe('ok');
  });

  test('a stored set written by ANOTHER writer with a non-8-hex id + a correct whole-set hash ⇒ 409, not unchanged', () => {
    // mutation: drop the stored-id width check on the replay path ⇒ RED (would be unchanged while ncn reads mismatch)
    const narrow = { scenario_id: 'scn_0a1b2c3d', criterion_id: 'crit_abc', title: 'narrow', gherkin: 'Given x', status: 'frozen' };
    const set = [narrow, { ...EXTRA, gherkin: 'Given y' }];
    const h = refHash(set);
    const d = JSON.stringify({ gherkin_scenarios: set, scenarios_check: { scenario_hash: h } }) + TAIL;
    expect(conflictOf(freezeScenarioSet(d, set, h))).toEqual([SCENARIO_FREEZE_CODES.storedHashMismatch, 409]);
    expect(['mismatch', null]).toContain(AA_CQ_HASH_STATE(AA_CQ_SCENARIOS(d, {})));
  });

  test('a DIFFERENT sent hash over a tampered set ⇒ conflict (scenarios_frozen keeps precedence)', () => {
    // mutation: run the stored-set re-hash before the stored-hash comparison ⇒ RED (would be stored_hash_mismatch)
    expect(freezeScenarioSet(tampered[0]![1], SENT, 'f'.repeat(64))).toEqual({ kind: 'conflict', storedHash: H });
  });
});

// ── a malformed brief scenarios_check hides the head's hash from ncn ──

describe('freezeScenarioSet — malformed brief scenarios_check', () => {
  const malformed: Array<[string, unknown]> = [
    ['an array', [{ scenario_hash: 'f'.repeat(64) }]],
    ['a numeric scenario_hash', { scenario_hash: 42 }],
    ['a null scenario_hash', { scenario_hash: null }],
  ];
  for (const [name, sc] of malformed) {
    test(`brief scenarios_check ${name} ⇒ 409 scenarios_brief_conflict`, () => {
      // mutation: drop the `malformed` leg of briefShadowRefusal ⇒ RED (would freeze)
      expect(conflictOf(freezeScenarioSet(withBrief(JSON.stringify({ scenarios_check: sc })), SENT, H))).toEqual([
        SCENARIO_FREEZE_CODES.briefConflict,
        409,
      ]);
    });
  }

  test('CONTROL: a plain brief scenarios_check with NO scenario_hash key ⇒ frozen', () => {
    // mutation: treat a missing scenario_hash key as non-string (hasOwnProperty dropped) ⇒ RED
    expect(freezeScenarioSet(withBrief(JSON.stringify({ scenarios_check: { criteria: ['c1'] } })), SENT, H).kind).toBe(
      'frozen',
    );
  });
});

// ── content carrying the sentinel literal never splits its own document ──

describe('serialised card documents never contain `<!--`', () => {
  const OPENER = '<!-- aa:readied_brief:start -->';

  test('append: an entry whose title + gherkin carry a sentinel opener ⇒ document whole, brief tail byte-identical', () => {
    // mutation: drop noCommentOpeners from writeCardDocument's raw branch ⇒ RED (head cut inside the title)
    const head = JSON.stringify({ title: 'card', gherkin_scenarios: [S2] });
    const d = withBrief(GOAL_BRIEF, head);
    const tail = d.slice(head.length);
    const entry = {
      scenario_id: 'scn_2c3d4e5f',
      criterion_id: 'crit_2c3d4e5f',
      title: `title with ${OPENER} inside`,
      gherkin: `Scenario: x\n  Given "${OPENER}"\n`,
      status: 'pending',
    };
    const r = appendScenarioEntries(d, [entry]);
    if (!('description' in r)) throw new Error('not appended: ' + JSON.stringify(r));
    expect(r.appended).toEqual([entry.scenario_id]);
    expect(r.description.endsWith(tail)).toBe(true);
    expect(r.description.slice(0, r.description.length - tail.length)).not.toContain('<!--');
    const doc = cardDocumentOf(r.description) as Doc;
    expect(doc.gherkin_scenarios[1]).toEqual(entry);
    expect(doc.gherkin_scenarios[1]!.title).toBe(entry.title);
    const seen = AA_CQ_SCENARIOS(r.description, {});
    expect(seen.known).toBe(true);
    expect(seen.set.map((e) => e.scenario_id)).toEqual([S2.scenario_id, entry.scenario_id]);
    expect(seen.set[1].title).toBe(entry.title);
  });

  test('freeze of a FENCED card with a gherkin carrying a sentinel opener ⇒ no `<!--` in the fence; parses back exactly', () => {
    // mutation: drop noCommentOpeners from writeCardDocument's FENCED branch ⇒ RED (raw `<!--` inside the fence)
    const d =
      '```json\n' +
      JSON.stringify({ title: 'card', gherkin_scenarios: SKELETON, scenarios_check: { criteria: ['c1'] } }, null, 2) +
      '\n```';
    const g = `Scenario: html comment\n  Given the page has "${OPENER}"\n`;
    const sent = [{ ...SENT[0], gherkin: g }, SENT[1]!];
    const r = freezeScenarioSet(d, sent, refHash(sent));
    if (r.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(r));
    expect(r.description.startsWith('```json\n')).toBe(true);
    expect(r.description.endsWith('\n```')).toBe(true);
    expect(r.description).not.toContain('<!--');
    expect((cardDocumentOf(r.description) as Doc).gherkin_scenarios[0]!.gherkin).toBe(g);
  });

  test('append to an EMPTY description: an entry whose title carries `<!--` ⇒ no raw `<!--`; parses back exactly', () => {
    // mutation: drop noCommentOpeners from the empty-description serialisation in appendScenarioEntries ⇒ RED
    const entry = { ...S2, title: `t ${OPENER} t` };
    const r = appendScenarioEntries('', [entry]);
    if (!('description' in r)) throw new Error('not appended: ' + JSON.stringify(r));
    expect(r.description).not.toContain('<!--');
    expect((cardDocumentOf(r.description) as Doc).gherkin_scenarios[0]).toEqual(entry);
  });

  test('append to PROSE: the appended ```json fence carries no raw `<!--`; parses back exactly', () => {
    // mutation: drop noCommentOpeners from the prose + appended-fence serialisation in appendScenarioEntries ⇒ RED
    const prose = 'Notes for the card.';
    const entry = { ...S2, title: `t ${OPENER} t` };
    const r = appendScenarioEntries(prose, [entry]);
    if (!('description' in r)) throw new Error('not appended: ' + JSON.stringify(r));
    expect(r.description.startsWith(prose + '\n\n```json\n')).toBe(true);
    expect(r.description).not.toContain('<!--');
    expect((cardDocumentOf(r.description) as Doc).gherkin_scenarios[0]).toEqual(entry);
  });

  test('freeze with a gherkin carrying a sentinel opener ⇒ frozen; replay ⇒ unchanged (not 422); ncn reads ok', () => {
    // mutation: drop noCommentOpeners ⇒ RED (replay finds an unparseable head ⇒ 422 card_document_unparseable)
    const g = `Scenario: html comment\n  Given the page has "${OPENER}"\n`;
    const sent = [{ ...SENT[0], gherkin: g }, SENT[1]!];
    const h = refHash(sent);
    const r = freezeScenarioSet(card(SKELETON), sent, h);
    if (r.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(r));
    expect(r.description.endsWith(TAIL)).toBe(true);
    expect(headOf(r.description).gherkin_scenarios[0]!.gherkin).toBe(g);
    expect(freezeScenarioSet(r.description, sent, h)).toEqual({ kind: 'unchanged', scenarioCount: 2 });
    const seen = AA_CQ_SCENARIOS(r.description, {});
    expect(seen.set[0].gherkin).toBe(g);
    expect(AA_CQ_HASH_STATE(seen)).toBe('ok');
  });
});

// ── the brief-shadow check runs on the WRITTEN bytes (what ncn reads), not only the input ──

describe('freezeScenarioSet — output-side brief shadowing', () => {
  // A stored title carrying a FAKE readied_brief fence: on the INPUT ncn's lazy
  // regex matches it (captures "notes" ⇒ unparseable ⇒ no brief); the write
  // escapes every backtick in the head, so on the OUTPUT the regex reaches the
  // REAL brief after the head.
  const FAKE_TITLE = 'probe ```readied_brief notes``` exit';
  const skel = [{ ...S1, title: FAKE_TITLE }, S2];
  const sent = [{ ...SENT[0], title: FAKE_TITLE }, SENT[1]!];
  const h = refHash(sent);
  const head = JSON.stringify({ title: 'card', gherkin_scenarios: skel, scenarios_check: { criteria: ['c1'] } });
  const SHADOW_BRIEF = JSON.stringify({ gherkin_scenarios: [SENT[0]] });

  test('fake fence in the head + a real brief with its own set ⇒ 409 scenarios_brief_conflict', () => {
    // mutation: drop the post-write briefShadowRefusal(written, …) ⇒ RED (200 frozen; ncn reads 'mismatch')
    const d = withBrief(SHADOW_BRIEF, head);
    // the INPUT-side check alone cannot see the real brief: ncn's regex stops at the fake one
    expect(/```readied_brief\s*([\s\S]*?)```/.exec(d)![1]).toBe('notes');
    expect(conflictOf(freezeScenarioSet(d, sent, h))).toEqual([SCENARIO_FREEZE_CODES.briefConflict, 409]);
    // parity: the bytes fr WOULD have written (a clean-brief freeze, brief kept byte-for-byte,
    // then the shadowing brief in its place) read 'mismatch' in ncn's reader
    const clean = freezeScenarioSet(withBrief(GOAL_BRIEF, head), sent, h);
    if (clean.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(clean));
    const wouldWrite = clean.description.replace(GOAL_BRIEF, SHADOW_BRIEF);
    expect(wouldWrite).not.toBe(clean.description);
    expect(AA_CQ_HASH_STATE(AA_CQ_SCENARIOS(wouldWrite, {}))).toBe('mismatch');
  });

  test('CONTROL: the same fake-fence head with a clean brief ⇒ frozen, and ncn reads ok on the output', () => {
    // mutation: run the post-write check on a refusal-for-any-brief basis ⇒ RED (would refuse)
    const r = freezeScenarioSet(withBrief(GOAL_BRIEF, head), sent, h);
    if (r.kind !== 'frozen') throw new Error('not frozen: ' + JSON.stringify(r));
    expect(AA_CQ_HASH_STATE(AA_CQ_SCENARIOS(r.description, {}))).toBe('ok');
  });
});

// ── a raw head AND a later ```json fence: the two readers disagree ──

describe('freezeScenarioSet — ambiguous card document', () => {
  const RAW_HEAD = JSON.stringify({ title: 'card', gherkin_scenarios: SKELETON, scenarios_check: { criteria: ['c1'] } });

  test('raw head + a ```json fence inside a sentinel region ⇒ 422 card_document_ambiguous', () => {
    // mutation: drop the `loc.fenced && trim().startsWith('{')` refusal ⇒ RED (freezes the fence; ncn reads the head)
    const d =
      RAW_HEAD +
      '\n\n<!-- aa:x:start -->\n```json\n' +
      JSON.stringify({ gherkin_scenarios: SKELETON }) +
      '\n```\n<!-- aa:x:end -->';
    const r = freezeScenarioSet(d, SENT, H);
    expect(r.kind === 'refusal' && [r.code, r.status]).toEqual([SCENARIO_FREEZE_CODES.documentAmbiguous, 422]);
    expect(SCENARIO_FREEZE_CODES.documentAmbiguous).toBe('card_document_ambiguous');
  });

  test('CONTROL: a genuinely fenced card (description starts with ```json) ⇒ frozen', () => {
    // mutation: refuse every fenced document (drop the raw-head condition) ⇒ RED
    const d =
      '```json\n' +
      JSON.stringify({ title: 'card', gherkin_scenarios: SKELETON, scenarios_check: { criteria: ['c1'] } }, null, 2) +
      '\n```';
    expect(freezeScenarioSet(d, SENT, H).kind).toBe('frozen');
  });
});
