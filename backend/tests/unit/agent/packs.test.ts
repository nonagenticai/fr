// tests/unit/agent/packs.test.ts
//
// fr-agui SPEC §11.2 / §11.3 (P1): fr's in-repo `capability-pack/v1` packs,
// `project-core` and `request-intake`, ARE the two agent catalogs (one source):
// the doorway set is the request-intake pack, the project agent's set the
// project-core pack. The schema is fr's (OQ-11 = a) and strict: a pack that
// lists an id twice, names an example capability it does not contain, or
// carries an unknown field fails at load — i.e. at boot and in every test that
// imports the catalog.
//
// MUTATION (run, red, reverted — see the P1c report): drop the duplicate-id
// check in agent/packs.ts → "a pack listing an id twice is refused" red.

import { describe, expect, test } from 'bun:test';

import { CapabilityPackSchema, FR_PACKS, packCore, packInstructions, packMembers, packSearchable, renderPackBlock } from '../../../src/agent/packs';
import { DOORWAY_INTAKE_ACTIONS } from '../../../src/agent/intake-catalog';
import { PROJECT_AGENT_ACTIONS } from '../../../src/agui/agent-surface';

const base = {
  schema: 'capability-pack/v1',
  consumer: 'fr',
  id: 'probe',
  version: 1,
  summary: 's',
  capabilities: ['a.b'],
  searchable: [],
  requires: { fr_registry: '>=1' },
  examples: [],
};

describe('fr capability packs', () => {
  test('both in-repo packs parse and ARE the catalogs', () => {
    expect(FR_PACKS['project-core'].schema).toBe('capability-pack/v1');
    expect([...packMembers('request-intake')].sort()).toEqual([...DOORWAY_INTAKE_ACTIONS].sort());
    expect([...packMembers('project-core')].sort()).toEqual([...PROJECT_AGENT_ACTIONS].sort());
    // core and searchable are disjoint; the project agent sends ~the §8.1 core every turn.
    const core = packCore('project-core');
    expect([...packSearchable('project-core')].filter((n) => core.has(n))).toEqual([]);
    // No size floor: the pack-members equality above already pins the contents.
    expect(core.has('capabilities.search')).toBe(true);
  });

  test('the two packs share only the project read and generic navigation (each scoped by the thread)', () => {
    const shared = [...packMembers('project-core')].filter((n) => packMembers('request-intake').has(n)).sort();
    // projects.get: the doorway reads the project it opens; the project agent its bound one.
    // ui.navigate: doorway pages vs the bound project's shell (agui/actions/ui-navigate.ts).
    expect(shared).toEqual(['projects.get', 'ui.navigate']);
  });

  test('the schema is strict: duplicates, foreign examples and unknown fields are refused', () => {
    expect(CapabilityPackSchema.safeParse(base).success).toBe(true);
    expect(CapabilityPackSchema.safeParse({ ...base, capabilities: ['a.b', 'a.b'] }).success).toBe(false);
    expect(CapabilityPackSchema.safeParse({ ...base, searchable: ['a.b'] }).success).toBe(false);
    expect(CapabilityPackSchema.safeParse({ ...base, examples: [{ user: 'x', capabilities: ['c.d'] }] }).success).toBe(false);
    expect(CapabilityPackSchema.safeParse({ ...base, grants: ['x.y'] }).success).toBe(false);
    expect(CapabilityPackSchema.safeParse({ ...base, schema: 'capability-pack/v2' }).success).toBe(false);
  });

  test('instructions load and render as the fr-authored skill block', () => {
    expect(packInstructions('project-core')).toContain('bound to that project');
    expect(packInstructions('request-intake')).toContain('doorway');
    const block = renderPackBlock('project-core');
    expect(block.startsWith('<skill id="fr/project-core" version="9" trust="fr-authored">\n')).toBe(true);
    expect(block.endsWith('\n</skill>')).toBe(true);
  });
});
