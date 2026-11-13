// Unit test for the finding-suppression elevation gate. Pure logic — no DB.
//
// P1-TEAM-a (George 2026-10-15, "all actions are able to be done by all members
// of the tenant"): elevated = any HUMAN member of the project's tenant (the
// project's own tag equals the active tenant) or a super_admin. The machine
// seats — licence caller, aa-orchestrator, the conveyor priority identity —
// are still NOT elevated: this gate exists so the conveyor cannot silence a
// vulnerability, and "the licence and conveyor lanes are unchanged".

import { describe, expect, test } from 'bun:test';
import type { User } from '../../../../src/types/api';
import { hasElevatedSuppressionRights } from '../../../../src/routes/findings/suppressions';

const T = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const project = { owner_id: 'owner-1', project_data: { keycloak_tenant_id: T } } as never;
const untagged = { owner_id: 'owner-1', project_data: {} } as never;
const user = (id: string, roles: string[], extra: Partial<User> = {}): User =>
  ({ id, roles, tenantId: T, ...extra } as unknown as User);

describe('hasElevatedSuppressionRights', () => {
  test('project owner (a member of the tenant) is elevated', () => {
    expect(hasElevatedSuppressionRights(user('owner-1', []), project, T)).toBe(true);
  });

  test('ADMITTED: a non-owner member of the SAME tenant is elevated', () => {
    expect(hasElevatedSuppressionRights(user('someone-else', []), project, T)).toBe(true);
  });

  test('REFUSED: a member of ANOTHER tenant is not elevated (tag ≠ active tenant)', () => {
    expect(hasElevatedSuppressionRights(user('someone-else', [], { tenantId: OTHER }), project, OTHER)).toBe(false);
  });

  test('REFUSED: an untagged project elevates no member', () => {
    expect(hasElevatedSuppressionRights(user('owner-1', []), untagged, T)).toBe(false);
  });

  test('REFUSED: a blank active tenant elevates nobody', () => {
    expect(hasElevatedSuppressionRights(user('owner-1', []), project, '')).toBe(false);
  });

  test('super_admin is elevated on a project it does not own', () => {
    expect(hasElevatedSuppressionRights(user('someone-else', ['super_admin']), project, T)).toBe(true);
  });

  test('aa-orchestrator role is NOT elevated, even in the project tenant', () => {
    expect(hasElevatedSuppressionRights(user('svc', ['aa-orchestrator']), project, T)).toBe(false);
  });

  test('a licence caller (a customer n8n = its conveyor) is NOT elevated', () => {
    expect(hasElevatedSuppressionRights(user('lic', [], { authKind: 'licence' } as Partial<User>), project, T)).toBe(false);
  });
});
