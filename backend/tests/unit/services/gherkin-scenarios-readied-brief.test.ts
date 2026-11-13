// tests/unit/services/gherkin-scenarios-readied-brief.test.ts
//
// A READIED card's description is the raw JSON card document (the "head")
// followed by a sentinel region ncn appends — writer: ncn
// `subroutine-card-write-description` :: Merge Block —
//   <head JSON>\n\n<!-- aa:readied_brief:start -->\n```readied_brief\n{…}\n```\n<!-- aa:readied_brief:end -->
// The whole description no longer parses as JSON, so before the fix
// `locateCardDocument` returned doc=undefined: an append was refused as
// `card_document_unparseable` and `checkDescriptionScenarios` passed a
// malformed entry vacuously. The head is now the document; everything from the
// whitespace before the sentinel onward is kept byte-for-byte on a rewrite.
//
// MUTATION CONTROL: removing the sentinel cut in `locateCardDocument` (fall
// straight to `{ doc: undefined, … }` after the whole-description parse fails)
// ⇒ the first two tests RED.

import { describe, expect, test } from 'bun:test';

import {
  CARD_DOCUMENT_CODES,
  SCENARIO_CODES,
  appendScenarioEntries,
  checkDescriptionScenarios,
} from '../../../src/services/gherkin-scenarios';

const A = { scenario_id: 'scn_0a1b2c3d', criterion_id: 'crit_0a1b2c3d', title: 'first', gherkin: null };
const B = { scenario_id: 'scn_1b2c3d4e', criterion_id: 'crit_1b2c3d4e', title: 'second', gherkin: null };
const head = (set: Array<Record<string, unknown>>) => JSON.stringify({ title: 'card', gherkin_scenarios: set });
const TAIL =
  '\n\n<!-- aa:readied_brief:start -->\n```readied_brief\n{"goal":"ship it","notes":"a `tick` and ```"}\n```\n' +
  '<!-- aa:readied_brief:end -->';

const ids = (doc: string) =>
  (JSON.parse(doc) as { gherkin_scenarios: Array<{ scenario_id: string }> }).gherkin_scenarios.map((e) => e.scenario_id);

describe('raw head + ncn readied_brief sentinel region', () => {
  test('appendScenarioEntries appends to the head; the tail after the head is byte-identical', () => {
    const v = appendScenarioEntries(head([A]) + TAIL, [B]);
    if (!('description' in v)) throw new Error('refused: ' + JSON.stringify(v));
    expect(v.appended).toEqual([B.scenario_id]);
    expect(v.description.endsWith(TAIL)).toBe(true);
    const newHead = v.description.slice(0, v.description.length - TAIL.length);
    expect(ids(newHead)).toEqual([A.scenario_id, B.scenario_id]);
  });

  test('checkDescriptionScenarios REFUSES an invalid entry in the head (was vacuous)', () => {
    const r = checkDescriptionScenarios(head([{ ...A, scenario_id: 'not-a-scn' }]) + TAIL);
    expect(r?.code).toBe(SCENARIO_CODES.invalid);
    expect(checkDescriptionScenarios(head([A]) + TAIL)).toBeNull();
  });

  test('control: a head-only description behaves as before', () => {
    const v = appendScenarioEntries(head([A]), [B]);
    if (!('description' in v)) throw new Error('refused');
    expect(ids(v.description)).toEqual([A.scenario_id, B.scenario_id]);
    expect(checkDescriptionScenarios(head([{ ...A, scenario_id: 'not-a-scn' }]))?.code).toBe(SCENARIO_CODES.invalid);
  });

  test('control: a sentinel INSIDE a JSON string of a whole-JSON description is not a cut', () => {
    const d = JSON.stringify({ title: 'see <!-- aa:readied_brief:start --> here', gherkin_scenarios: [A] });
    const v = appendScenarioEntries(d, [B]);
    if (!('description' in v)) throw new Error('refused');
    expect(ids(v.description)).toEqual([A.scenario_id, B.scenario_id]);
  });

  test('a head that does not parse + a brief ⇒ card_document_unparseable', () => {
    const v = appendScenarioEntries('{"title": "card",' + TAIL, [B]);
    expect('refusal' in v && v.refusal.code).toBe(CARD_DOCUMENT_CODES.unparseable);
  });

  test('a ```json-fenced document + a brief still uses the fence; the brief is kept', () => {
    const d = 'prose\n\n```json\n' + head([A]) + '\n```' + TAIL;
    const v = appendScenarioEntries(d, [B]);
    if (!('description' in v)) throw new Error('refused');
    expect(v.description.startsWith('prose\n\n```json\n')).toBe(true);
    expect(v.description.endsWith('\n```' + TAIL)).toBe(true);
    const fence = v.description.slice('prose\n\n```json\n'.length, v.description.length - ('\n```' + TAIL).length);
    expect(ids(fence)).toEqual([A.scenario_id, B.scenario_id]);
  });
});
