// tests/unit/routes/execution-event-tenant-resolution.test.ts
//
// n8n's execution-events were refused for a tenant fr could have resolved.
//
// `handleN8nExecutionEvent` derived the tenant as
// `v.tenant_id ?? project.tenant_id`, where the second term is ONLY
// `departments.workspace_id`. Its comment claimed to "mirror the approval
// path" — it did not. The approval path (`resolveCardApprovalTenant`) had
// already been fixed to fall back to the tenant stamped on the project row,
// precisely because the department chain is structurally dead here.
//
// MEASURED on prod 2026-09-04:
//     departments                       = 0
//     projects                          = 246
//     projects with dept_id NOT NULL    = 0      <- the department arm resolves NOTHING
//     projects with keycloak_tenant_id  = 228    <- all 228 join to a real workspaces.id
//
// And n8n cannot close the gap from its side: both active workflows that POST
// to this endpoint (`AA Pattern - Blocked Escalate`, `AA Pattern - Done
// Finalize`) build their bodies from nodes that carry no tenant or workspace
// value at all. So resolution happens in fr or it does not happen.
//
// These drive `tenantFromProjectRow`, the single owner both paths now share.
// The handler wiring itself needs Postgres; it was asserted by the webhooks
// route suite, deleted 2026-10-29 — no longer in the suite.

import { test, expect, describe } from 'bun:test';

import { tenantFromProjectRow } from '../../../src/routes/webhooks';

const DEPT_TENANT = '11111111-1111-4111-8111-111111111111';
const STAMPED_TENANT = '22222222-2222-4222-8222-222222222222';

describe('a project with no department still has a tenant', () => {
  test('falls back to the tenant stamped at create time', () => {
    // The whole defect: this returned null, and the caller refused a valid event.
    expect(
      tenantFromProjectRow(null, { keycloak_tenant_id: STAMPED_TENANT }),
    ).toBe(STAMPED_TENANT);
  });

  test('the department still wins when there IS one', () => {
    // Not a rewrite of precedence — the department arm keeps priority; it is
    // simply empty estate-wide today.
    expect(
      tenantFromProjectRow(DEPT_TENANT, { keycloak_tenant_id: STAMPED_TENANT }),
    ).toBe(DEPT_TENANT);
  });
});

describe('it still fails closed', () => {
  // The negative control. Resolving MORE must not mean resolving ANYTHING: a
  // project with neither source must still return null so the caller refuses,
  // rather than attributing the event to a default or nil tenant.
  test('neither department nor stamped tenant -> null', () => {
    expect(tenantFromProjectRow(null, null)).toBeNull();
    expect(tenantFromProjectRow(undefined, undefined)).toBeNull();
    expect(tenantFromProjectRow(null, {})).toBeNull();
  });

  test('a non-object project_data does not throw or invent a tenant', () => {
    expect(tenantFromProjectRow(null, 'not-an-object')).toBeNull();
    expect(tenantFromProjectRow(null, 42)).toBeNull();
  });

  test('an empty-string stamped tenant is not a tenant', () => {
    // `?? ` would let '' through; the falsy check must not.
    expect(tenantFromProjectRow(null, { keycloak_tenant_id: '' })).toBeNull();
    expect(tenantFromProjectRow('', { keycloak_tenant_id: STAMPED_TENANT })).toBe(
      STAMPED_TENANT,
    );
  });
});
