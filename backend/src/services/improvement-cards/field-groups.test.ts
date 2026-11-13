import { describe, it, expect } from 'bun:test';
import { PM_CATALOGUE_DEFAULTS } from '@fr/service-client-requirements/pm-catalogue-defaults';
import { GROUP_POSITIONS, GROUP_FIELDS } from './field-groups';
import { IMPROVEMENT_CARD_FIELD_NAMES } from '../planka/custom-fields';

// field-groups.ts is a NAME MAP of the RM default board template (v4 ruling 12:
// the RM board template is the master). It provisions nothing; these
// assertions pin it to RM's synced default template so the names fr reads/writes
// cannot drift from the fields RM boards actually carry.

// RM's default board template, synced verbatim from RM (tooling/openapi/specs/requirements.pm-catalogue-defaults.json).
const TEMPLATE = PM_CATALOGUE_DEFAULTS.board_templates.find((t) => t.name === 'default')!;

describe('field-groups.ts = the RM default board template (names only)', () => {
  it('has exactly the template groups, in template order', () => {
    expect(Object.keys(GROUP_POSITIONS)).toEqual(TEMPLATE.custom_field_groups.map((g) => g.name));
    expect(Object.keys(GROUP_FIELDS)).toEqual(TEMPLATE.custom_field_groups.map((g) => g.name));
  });

  // Ordered toEqual: reds an addition, removal, rename or reorder of any field.
  it('every group carries exactly the template fields, in template order', () => {
    const fromTemplate = Object.fromEntries(TEMPLATE.custom_field_groups.map((g) => [g.name, g.fields]));
    expect(GROUP_FIELDS as Record<string, readonly string[]>).toEqual(fromTemplate);
  });

  it('positions are the template order, 65536 apart', () => {
    expect(Object.values(GROUP_POSITIONS) as number[]).toEqual(TEMPLATE.custom_field_groups.map((_, i) => (i + 1) * 65536));
  });

  it('the retired stopwatch_timeout slot is gone (not in the RM template)', () => {
    expect(GROUP_FIELDS.Metadata).not.toContain('stopwatch_timeout');
    // Positive control on the same instrument.
    expect(GROUP_FIELDS.Metadata).toContain('priority');
  });

  // RM #221 (v4 R188 / R190; R66): named explicitly so a stale vendored fixture
  // cannot hide the drift — the ordered toEqual above only checks fr against
  // fr's own copy of the template.
  it('carries the v4 source ids (R188) and closure wait flag (R190); rework_count (R66) is gone', () => {
    expect(GROUP_FIELDS.Metadata).toContain('source_artifact_id');
    expect(GROUP_FIELDS.Metadata).toContain('source_item_id');
    expect(GROUP_FIELDS['Runtime State']).toContain('wait_for_phase');
    expect(Object.values(GROUP_FIELDS).flat()).not.toContain('rework_count');
    // Positive control on the same instrument.
    expect(GROUP_FIELDS['Runtime State']).toContain('released');
  });

  it('every router-required Metadata name is a template field', () => {
    for (const n of IMPROVEMENT_CARD_FIELD_NAMES) expect(GROUP_FIELDS.Metadata).toContain(n);
  });
});
