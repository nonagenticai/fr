// tests/unit/services/gherkin-scenarios-resend.test.ts
//
// RE-SEND contract for every re-entry path that writes scenarios back to a card
// (READY re-ready, U1 re-drive, a retry after a transport failure):
//
//   - append (`appendScenarioEntries`, POST /api/cards/:id/scenario-evidence)
//     compares the WHOLE entry (`canon`, key order ignored) — not just the four
//     hashed keys. A re-send whose hashed fields are equal but ANY other field
//     differs (status, a per-entry scenario_hash, an evidence pointer) is a
//     CONFLICT. Only a VERBATIM re-send (as read back) is a no-op.
//     ⇒ re-entry paths must re-send entries exactly as read back, never rebuilt
//       from scenario_id/criterion_id/title/gherkin.
//   - freeze (`freezeScenarioSet`, POST /api/cards/:id/scenarios/freeze) is a
//     HASH-level compare-and-set: once frozen, a replay with the same hash is
//     `unchanged` and writes nothing, whatever its non-hashed fields say; the
//     stored entries are never touched by a replay.
//
// MUTATION CONTROL: each test names the mutation that turns it RED.

import { describe, expect, test } from 'bun:test';

import { appendScenarioEntries, freezeScenarioSet } from '../../../src/services/gherkin-scenarios';
import { scenariosHash as refHash } from '../../fixtures/canonical-scenarios-hash/canonical-scenarios-hash.mjs';

const STORED = {
  scenario_id: 'scn_0a1b2c3d',
  criterion_id: 'crit_0a1b2c3d',
  title: 'probe exit 128 fails closed',
  gherkin: null,
  status: 'approved',
  failing_test: 'tests/t.py::test_scn_0a1b2c3d',
  test_file_sha256: 'a'.repeat(64),
};
const onCard = (e: Record<string, unknown>) => JSON.stringify({ gherkin_scenarios: [e] });

describe('append re-send: whole-entry equality', () => {
  test('a VERBATIM re-send (keys reordered) is a no-op: alreadyOnCard, description unchanged', () => {
    // mutation: compare with a key-order-sensitive JSON.stringify instead of canon ⇒ conflict ⇒ RED
    const d = onCard(STORED);
    const reordered = Object.fromEntries(Object.entries(STORED).reverse());
    expect(appendScenarioEntries(d, [reordered])).toEqual({ description: d, appended: [], alreadyOnCard: ['scn_0a1b2c3d'] });
  });

  test('status-only difference ⇒ conflict, never a rewrite', () => {
    // mutation: compare only the hashed keys ⇒ alreadyOnCard ⇒ RED
    expect(appendScenarioEntries(onCard(STORED), [{ ...STORED, status: 'pending' }])).toEqual({ conflict: ['scn_0a1b2c3d'] });
  });

  test('per-entry scenario_hash added on re-send ⇒ conflict', () => {
    // mutation: drop non-hashed keys from the comparison ⇒ alreadyOnCard ⇒ RED
    const withHash = { ...STORED, scenario_hash: refHash([STORED]) };
    expect(appendScenarioEntries(onCard(STORED), [withHash])).toEqual({ conflict: ['scn_0a1b2c3d'] });
  });

  test('evidence-pointer-only difference ⇒ conflict', () => {
    // mutation: exclude evidence fields from canon ⇒ alreadyOnCard ⇒ RED
    expect(appendScenarioEntries(onCard(STORED), [{ ...STORED, test_file_sha256: 'b'.repeat(64) }])).toEqual({
      conflict: ['scn_0a1b2c3d'],
    });
  });
});

describe('freeze replay: hash-level CAS', () => {
  const pending = { ...STORED, status: 'pending' };
  const sent = [{ ...pending, gherkin: 'Given a probe\nWhen it exits 128\nThen it fails closed', status: 'frozen' }];
  const hash = refHash(sent);

  test('first freeze, then a status-altered replay of the same hashed set ⇒ unchanged, stored bytes untouched', () => {
    // mutation: compare whole entries on replay (or drop the CAS early return) ⇒ refusal / frozen ⇒ RED
    const first = freezeScenarioSet(onCard(pending), sent, hash);
    if (first.kind !== 'frozen') throw new Error(`expected frozen, got ${first.kind}`);
    const replay = freezeScenarioSet(first.description, [{ ...sent[0], status: 'approved' }], hash);
    expect(replay).toEqual({ kind: 'unchanged', scenarioCount: 1 });
  });

  test('a replay with a DIFFERENT hash after freeze ⇒ conflict carrying the stored hash', () => {
    // mutation: treat any stored hash as unchanged ⇒ RED
    const first = freezeScenarioSet(onCard(pending), sent, hash);
    if (first.kind !== 'frozen') throw new Error(`expected frozen, got ${first.kind}`);
    const other = [{ ...sent[0], gherkin: 'Given something else' }];
    expect(freezeScenarioSet(first.description, other, refHash(other))).toEqual({ kind: 'conflict', storedHash: hash });
  });
});
