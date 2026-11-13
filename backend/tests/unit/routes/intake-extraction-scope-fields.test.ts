// tests/unit/routes/intake-extraction-scope-fields.test.ts
//
// intakeExtractionSchema(types) is a CLOSED allow-list (`additionalProperties:
// false`), which makes an omission from it invisible at every later step: the
// worker's output is validated against this schema, so a key it does not list
// is DROPPED, and a dropped key looks exactly like a field the user never
// mentioned. Nothing downstream can tell the two apart — not the draft row, not
// the review page, not the agent brief.
//
// The four project-definition scope fields were exactly that case until
// 2026-09-23: `scopeFieldsForBrief` / `BRIEF_SCOPE_FIELDS` (routes/projects.ts)
// reads them into BOTH agent briefs, and this schema did not list any of them,
// so a free-text intake that stated its own scope had that scope discarded here
// and the brief then honestly reported nothing was said.
//
// KILLING MUTATION: delete any one of the four from intakeExtractionSchema.

import { describe, expect, it } from 'bun:test';
import { intakeExtractionSchema } from '../../../src/routes/project-requests';

const INTAKE_EXTRACTION_SCHEMA = intakeExtractionSchema([{ name: 'feature_new' }]);
import { BRIEF_SCOPE_FIELDS } from '../../../src/routes/projects';

function props(): Record<string, { type?: string; items?: { type?: string } }> {
  return (INTAKE_EXTRACTION_SCHEMA.properties ?? {}) as Record<
    string,
    { type?: string; items?: { type?: string } }
  >;
}

describe('intakeExtractionSchema — the scope fields an NL intake may fill', () => {
  it('lists all four fields the brief reader consumes', () => {
    // Keyed off BRIEF_SCOPE_FIELDS rather than a hand-copied list, so a field
    // added to the reader and forgotten here fails too.
    for (const key of BRIEF_SCOPE_FIELDS) {
      expect(props()[key], `${key} must be extractable from free text`).toBeDefined();
    }
  });

  it('declares each of them as an array of strings, matching its siblings', () => {
    for (const key of BRIEF_SCOPE_FIELDS) {
      expect(props()[key], key).toEqual({ type: 'array', items: { type: 'string' } });
    }
    // Positive control: the sibling whose shape they were copied from. If this
    // ever stops being array-of-string the assertion above is measuring the
    // wrong contract, not a passing one.
    expect(props().success_criteria).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('requires none of them — an invented scope is worse than an absent one', () => {
    expect(INTAKE_EXTRACTION_SCHEMA.required).toEqual(['name']);
    // And the allow-list is still closed: if this flipped to true the test
    // above would pass for a reason that has nothing to do with the schema.
    expect(INTAKE_EXTRACTION_SCHEMA.additionalProperties).toBe(false);
  });
});
