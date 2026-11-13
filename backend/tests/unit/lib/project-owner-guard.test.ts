// tests/unit/lib/project-owner-guard.test.ts
//
// Coverage:
//   - classifyProjectOwnership: all three outcomes (untagged, foreign, owned).
//     There is no `absent` — see project-owner-guard.ts's docblock: the one
//     caller can never supply a missing project or caller tenant, so both
//     parameters are typed required and that branch was removed rather than
//     kept as unreachable dead code.
//   - guardProjectId counts every outcome via project-id-emit-metrics.
//   - Emission is UNCONDITIONAL: only `owned` ever rides the wire. `foreign`
//     and `untagged` NEVER emit — no mode flag changes this (there is no mode
//     flag; an earlier revision's `PROJECT_ID_EMIT_MODE` was removed because
//     its two values computed the identical result once "refuse, don't
//     coerce" applied to both).
//   - fr#1214: the `lane` label. `crossTenantReadOnly` LABELS the count and
//     gates the log line; it changes neither the classification nor the
//     emission. Suppressing `foreign` on the cross-tenant lane is exactly what
//     must NOT ship, so the arms below assert that `foreign` still counts and
//     still refuses on BOTH lanes.

import { describe, expect, test } from 'bun:test';
import {
  classifyProjectOwnership,
  guardProjectId,
  isProjectAccessAllowed,
  projectIdEmitLane,
  projectKcTenantTag,
} from '../../../src/lib/project-owner-guard';
import {
  PROJECT_ID_EMIT_LANES,
} from '../../../src/lib/project-id-emit-metrics';

const HOME = '0195f48b-d000-7000-8000-000000000003';
const OTHER = '0195f48b-d000-7000-8000-000000000099';

function project(tag: string | null | undefined, id = 'proj-1') {
  return { id, project_data: tag === undefined ? null : { keycloak_tenant_id: tag } };
}


describe('projectKcTenantTag', () => {
  test('reads project_data.keycloak_tenant_id, trimmed', () => {
    expect(projectKcTenantTag({ project_data: { keycloak_tenant_id: `  ${HOME}  ` } })).toBe(HOME);
  });

  test('undefined for null project_data', () => {
    expect(projectKcTenantTag({ project_data: null })).toBeUndefined();
  });

  test('undefined for a blank/whitespace-only tag (same as no tag)', () => {
    expect(projectKcTenantTag({ project_data: { keycloak_tenant_id: '   ' } })).toBeUndefined();
  });

  test('undefined for missing project', () => {
    expect(projectKcTenantTag(undefined)).toBeUndefined();
    expect(projectKcTenantTag(null)).toBeUndefined();
  });
});

describe('classifyProjectOwnership', () => {
  test('untagged: project has no keycloak_tenant_id', () => {
    expect(classifyProjectOwnership(project(undefined), HOME)).toBe('untagged');
  });

  test('untagged: project has a blank tag', () => {
    expect(classifyProjectOwnership(project('   '), HOME)).toBe('untagged');
  });

  test('foreign: tag names a different tenant', () => {
    expect(classifyProjectOwnership(project(OTHER), HOME)).toBe('foreign');
  });

  test('owned: tag matches the caller tenant', () => {
    expect(classifyProjectOwnership(project(HOME), HOME)).toBe('owned');
  });
});

// ── fr#1214: the lane label ─────────────────────────────────────────────────
describe('projectIdEmitLane — the crossTenantReadOnly → lane mapping', () => {
  // ⛔ MUTATION CONTROL. Hard-code either branch (e.g. `return 'own_tenant'`)
  // and one of these two goes RED. Without the second assertion, "always
  // cross_tenant_read" would satisfy the first.
  test('true is the deliberate cross-tenant read lane', () => {
    expect(projectIdEmitLane(true)).toBe('cross_tenant_read');
  });

  test('false — every mutating caller and every ordinary identity — is own_tenant', () => {
    expect(projectIdEmitLane(false)).toBe('own_tenant');
  });

  test('there are exactly two lanes, and the boolean covers both', () => {
    expect([...PROJECT_ID_EMIT_LANES].sort()).toEqual(['cross_tenant_read', 'own_tenant']);
    expect(new Set([projectIdEmitLane(true), projectIdEmitLane(false)]).size).toBe(2);
  });
});

describe('guardProjectId — lane labelling (fr#1214)', () => {

  // ⛔ MUTATION CONTROL — the thing fr#1214 must NOT do. If
  // `crossTenantReadOnly` is ever wired into `classifyProjectOwnership` or
  // `resolveEmission` (i.e. "the cross-tenant lane is allowed to emit / is
  // reclassified as owned"), this goes RED. Make `foreign` emit a project id
  // and the `toBeUndefined()` fails; reclassify it and the outcome fails.
  test('the cross-tenant lane still REFUSES — labelling is not permission', () => {
    const { projectId, outcome } = guardProjectId(project(OTHER, 'p-xtenant'), HOME, true);
    expect(outcome).toBe('foreign');
    expect(projectId).toBeUndefined();
  });

  test('untagged is labelled by lane too, and refuses on both', () => {
    expect(guardProjectId(project(undefined, 'p-u1'), HOME, true)).toEqual({
      projectId: undefined,
      outcome: 'untagged',
      lane: 'cross_tenant_read',
      allowed: false,
    });
    expect(guardProjectId(project(undefined, 'p-u2'), HOME, false)).toEqual({
      projectId: undefined,
      outcome: 'untagged',
      lane: 'own_tenant',
      allowed: false,
    });
  });

});

describe('guardProjectId — emission: refuse, do not coerce (unconditional, no mode)', () => {
  test('owned emits the project id', () => {
    const { projectId, outcome } = guardProjectId(project(HOME, 'p-owned'), HOME, false);
    expect(outcome).toBe('owned');
    expect(projectId).toBe('p-owned');
  });

  // ⛔ MUTATION CONTROL — pins the "refuse, don't coerce" contract. If
  // `resolveEmission` is ever mutated back to emit the raw id unconditionally
  // (the prior `observe`-mode bug: `outcome === 'absent' ? undefined :
  // projectId`), this assertion goes red.
  test('foreign NEVER emits — a mismatched tenant tag must never ride the wire', () => {
    const { projectId, outcome } = guardProjectId(project(OTHER, 'p-foreign'), HOME, false);
    expect(outcome).toBe('foreign');
    expect(projectId).toBeUndefined();
  });

  // ⛔ MUTATION CONTROL — untagged is foreign-but-unknown, not "no
  // restriction". If `resolveEmission` is ever mutated to treat untagged as
  // safe to emit, this assertion goes red.
  test('untagged NEVER emits — unknown ownership is not "no restriction"', () => {
    const { projectId, outcome } = guardProjectId(project(undefined, 'p-untagged'), HOME, false);
    expect(outcome).toBe('untagged');
    expect(projectId).toBeUndefined();
  });
});

// fr row 14b — the guard DENIES, it does not only label. Ownership alone never
// grants cross-tenant access: `foreign` and `untagged` are refused on BOTH
// lanes; only `owned` is allowed.
describe('guardProjectId access verdict (fr row 14b)', () => {
  test('owned ⇒ allowed (positive control)', () => {
    expect(guardProjectId(project(HOME, 'p-14b-own'), HOME, false).allowed).toBe(true);
    expect(isProjectAccessAllowed('owned')).toBe(true);
  });
  test('foreign ⇒ DENIED on the own-tenant lane and the read lane', () => {
    expect(guardProjectId(project(OTHER, 'p-14b-f1'), HOME, false).allowed).toBe(false);
    expect(guardProjectId(project(OTHER, 'p-14b-f2'), HOME, true).allowed).toBe(false);
    expect(isProjectAccessAllowed('foreign')).toBe(false);
  });
  test('untagged ⇒ DENIED (fail closed), blank tag too', () => {
    expect(guardProjectId(project(undefined, 'p-14b-u1'), HOME, false).allowed).toBe(false);
    expect(guardProjectId(project('   ', 'p-14b-u2'), HOME, false).allowed).toBe(false);
    expect(isProjectAccessAllowed('untagged')).toBe(false);
  });
});
