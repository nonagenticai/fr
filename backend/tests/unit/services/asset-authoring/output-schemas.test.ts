// Plan 7 Stage 2.1 — zod output-schema contract for asset-authoring
// patches. These shapes are what an LLM worker must emit and what the
// /api/asset-authoring/publish dispatch route validates before calling
// the upstream principles/requirements/decisions integrations.

import { describe, expect, test } from 'bun:test';
import {
  PrinciplePatch,
  RequirementPatch,
  DecisionPatch,
} from '../../../../src/services/asset-authoring/output-schemas';

describe('PrinciplePatch', () => {
  test('accepts a minimal valid patch', () => {
    const ok = PrinciplePatch.parse({
      name: 'Always validate input',
      body: 'All public-facing endpoints validate request bodies via zod.',
      rationale: 'Reduces 5xx; catches malformed payloads at the boundary.',
    });
    expect(ok.name).toBe('Always validate input');
  });
  test('rejects missing rationale', () => {
    expect(() => PrinciplePatch.parse({ name: 'X', body: 'Y' })).toThrow();
  });
});

describe('RequirementPatch', () => {
  test('requires at least one acceptance_criterion', () => {
    expect(() =>
      RequirementPatch.parse({
        name: 'Login MFA',
        body: 'Users must complete MFA on each new device.',
        acceptance_criteria: [],
      }),
    ).toThrow();
  });
  test('accepts requirement with one criterion', () => {
    const ok = RequirementPatch.parse({
      name: 'Login MFA',
      body: 'Users must complete MFA on each new device.',
      acceptance_criteria: [
        'POST /auth/login returns 412 if device is unrecognized and MFA token absent',
      ],
    });
    expect(ok.acceptance_criteria.length).toBe(1);
  });
});

describe('DecisionPatch', () => {
  test('requires >=2 considered_options and a chosen_option that is in the set', () => {
    expect(() =>
      DecisionPatch.parse({
        name: 'Postgres driver',
        body: 'Pick a Python Postgres driver.',
        considered_options: ['psycopg3'],
        chosen_option: 'psycopg3',
        consequences: 'Sync API; binary wheels.',
      }),
    ).toThrow();
    const ok = DecisionPatch.parse({
      name: 'Postgres driver',
      body: 'Pick a Python Postgres driver.',
      considered_options: ['psycopg3', 'asyncpg'],
      chosen_option: 'psycopg3',
      consequences: 'Sync API; binary wheels.',
    });
    expect(ok.chosen_option).toBe('psycopg3');
  });
  test('rejects chosen_option not in considered_options', () => {
    expect(() =>
      DecisionPatch.parse({
        name: 'Driver',
        body: 'Pick.',
        considered_options: ['a', 'b'],
        chosen_option: 'c',
        consequences: 'Y',
      }),
    ).toThrow();
  });
});
