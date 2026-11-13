// Unit test for the Patch → In translation seam behind
// POST /api/asset-authoring/publish. This is the assertion the codebase
// lacked: it proves every REQUIRED upstream *In field is populated from the
// right worker Patch field, which is exactly what would have caught the live
// 422 (the old identity `as unknown as *In` cast sent name/body/… verbatim, so
// title/statement/description/context/decision/effort were all absent).

import { describe, expect, test } from 'bun:test';
import {
  principlePatchToIn,
  requirementPatchToIn,
  decisionPatchToIn,
  DEFAULT_REQUIREMENT_EFFORT,
} from '../../../../src/services/asset-authoring/patch-to-in';

describe('principlePatchToIn', () => {
  test('maps name→title, body→statement; carries rationale/tags', () => {
    const out = principlePatchToIn({
      name: 'Least privilege',
      body: 'Grant the minimum access required.',
      rationale: 'Limits blast radius.',
      tags: ['security'],
    });
    expect(out.title).toBe('Least privilege');
    expect(out.statement).toBe('Grant the minimum access required.');
    expect(out.rationale).toBe('Limits blast radius.');
    expect(out.tags).toEqual(['security']);
    // required PrincipleIn fields present
    expect(out.title).toBeTruthy();
    expect(out.statement).toBeTruthy();
  });
});

describe('requirementPatchToIn', () => {
  test('maps name→title, body→description, acceptance_criteria→acceptance; defaults effort', () => {
    const out = requirementPatchToIn({
      name: 'Rate limit the API',
      body: 'The API must reject bursts above the tenant quota.',
      acceptance_criteria: ['429 on quota exceed', 'per-tenant window'],
    });
    expect(out.title).toBe('Rate limit the API');
    expect(out.description).toBe(
      'The API must reject bursts above the tenant quota.',
    );
    expect(out.acceptance).toEqual(['429 on quota exceed', 'per-tenant window']);
    // required RequirementIn.effort present + valid (>0.001)
    expect(out.effort).toBe(DEFAULT_REQUIREMENT_EFFORT);
    expect(out.effort).toBeGreaterThan(0.001);
    expect(out.title).toBeTruthy();
    expect(out.description).toBeTruthy();
  });

  test('uses the worker-supplied effort when present', () => {
    const out = requirementPatchToIn({
      name: 'R',
      body: 'B',
      acceptance_criteria: ['a'],
      effort: 5,
    });
    expect(out.effort).toBe(5);
  });
});

describe('decisionPatchToIn', () => {
  test('maps name→title, body→context, chosen_option→decision, considered_options→alternatives; defaults status', () => {
    const out = decisionPatchToIn({
      name: 'Adopt Postgres 18',
      body: 'We need a supported database across all services.',
      considered_options: ['Postgres 18', 'SQLite', 'MySQL'],
      chosen_option: 'Postgres 18',
      consequences: 'One standard driver + tuning path.',
    });
    expect(out.title).toBe('Adopt Postgres 18');
    expect(out.context).toBe(
      'We need a supported database across all services.',
    );
    expect(out.decision).toBe('Postgres 18');
    expect(out.alternatives).toEqual(['Postgres 18', 'SQLite', 'MySQL']);
    expect(out.consequences).toBe('One standard driver + tuning path.');
    expect(out.status).toBe('proposed');
    // required DecisionIn fields present
    expect(out.title).toBeTruthy();
    expect(out.context).toBeTruthy();
    expect(out.decision).toBeTruthy();
  });

  test('uses the worker-supplied status when present', () => {
    const out = decisionPatchToIn({
      name: 'D',
      body: 'B',
      considered_options: ['a', 'b'],
      chosen_option: 'a',
      consequences: 'C',
      status: 'accepted',
    });
    expect(out.status).toBe('accepted');
  });
});
