// tests/unit/routes/assets/artifact-review-decider.test.ts
//
// The artifact review DECISION's decider verdict (R208: sign-off approver rights are
// enforced by fr). Pure — every arm of the approvals rule's roster-less mapping, pinned
// without a database. The I/O half (project READ gate, artifact-of-project, the real
// membership read) was the project-outputs-confirm integration suite, deleted
// 2026-10-29 — no longer in the suite.

import { describe, expect, test } from 'bun:test';

import {
  artifactReviewDeciderVerdict,
  type ArtifactReviewDeciderFacts,
} from '../../../../src/routes/assets/artifacts';

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const CALLER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

const base: ArtifactReviewDeciderFacts = {
  superAdminDecider: false,
  isTenantMember: true,
  projectTenantId: T,
  activeTenantId: T,
  callerId: CALLER,
  originKind: 'workflow',
  producerUserId: OTHER,
  callerIsSoloTenantGod: false,
};
const v = (o: Partial<ArtifactReviewDeciderFacts>) => artifactReviewDeciderVerdict({ ...base, ...o });

describe('artifactReviewDeciderVerdict — the approvals decide rule, roster-less', () => {
  test('a tenant member acting in the project tenant decides', () => {
    expect(v({})).toEqual({ ok: true });
  });

  test('not a member and not a super-admin decider → not_eligible', () => {
    expect(v({ isTenantMember: false })).toEqual({ ok: false, refusal: 'not_eligible' });
  });

  test('a super-admin decider (platform tenant / switched) needs no membership', () => {
    expect(v({ isTenantMember: false, superAdminDecider: true })).toEqual({ ok: true });
  });

  test('a project tagged for ANOTHER tenant than the request acts in → not_found (a home-view read never becomes a write)', () => {
    expect(v({ projectTenantId: U })).toEqual({ ok: false, refusal: 'not_found' });
    expect(v({ projectTenantId: U, superAdminDecider: true })).toEqual({ ok: false, refusal: 'not_found' });
  });

  test('an untagged project falls through to the eligibility arms', () => {
    expect(v({ projectTenantId: null })).toEqual({ ok: true });
    expect(v({ projectTenantId: null, isTenantMember: false })).toEqual({ ok: false, refusal: 'not_eligible' });
  });

  test('the producer of a HUMAN-produced artifact may not review it', () => {
    for (const originKind of ['project', 'tenant', null]) {
      expect(v({ originKind, producerUserId: CALLER })).toEqual({ ok: false, refusal: 'self_review' });
    }
    // even as a super-admin decider — the approvals rule refuses the requester on every arm
    expect(v({ originKind: 'project', producerUserId: CALLER, superAdminDecider: true })).toEqual({
      ok: false,
      refusal: 'self_review',
    });
  });

  test('a WORKFLOW-produced artifact is never the caller own (the system-raised exemption)', () => {
    expect(v({ originKind: 'workflow', producerUserId: CALLER })).toEqual({ ok: true });
  });

  test('a one-member tenant (the tenant god) may review its own artifact', () => {
    expect(v({ originKind: 'project', producerUserId: CALLER, callerIsSoloTenantGod: true })).toEqual({ ok: true });
  });

  test('another producer, or none recorded, is not a self-review', () => {
    expect(v({ originKind: 'project', producerUserId: OTHER })).toEqual({ ok: true });
    expect(v({ originKind: 'project', producerUserId: null })).toEqual({ ok: true });
  });
});
