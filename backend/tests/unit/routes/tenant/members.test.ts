// tests/unit/routes/tenant/members.test.ts
//
// The member-readable tenant directory.
//
// The property under test is NOT "does it list people" — it is that the least
// privileged of the three member listings cannot become a cross-tenant leak.
// Two ways it could:
//
//   1. by taking a tenant from the caller (privilege escalation), and
//   2. by returning `AdminUser`, whose `workspaces[]` field discloses which
//      OTHER tenants a colleague belongs to (information disclosure).
//
// Both are structural, so both are checked structurally. A test that merely
// exercised the happy path would pass under either defect.
//
// ⚠️ SCOPE. This file covers
// the contract and the invariants, which need no database. It does NOT drive
// the handler end-to-end: this suite runs with AUTH_BYPASS, so `validateAuth`
// returns a synthetic user and the handler then reaches Postgres — a
// handler-level assertion here would be testing the no-local-Postgres failure
// while LOOKING like authorization coverage. End-to-end authz belongs in the
// integration suite, which has a database.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  toTenantMembers,
  type TenantMember,
} from '../../../../src/routes/tenant/members';
import type { RoleGrant } from '../../../../src/services/user-roles';

const SOURCE = readFileSync(
  join(import.meta.dir, '../../../../src/routes/tenant/members.ts'),
  'utf8',
);

const grant = (user_id: string, role = 'workspace-member'): RoleGrant => ({
  user_id,
  tenant_id: '0195f48b-d000-7000-8000-000000000001',
  tenant_name: 'Acme',
  role,
  granted_at: '2026-09-01T00:00:00.000Z',
  granted_by: null,
});

const person = (id: string, name: string, email: string) => ({ id, name, email });

describe('toTenantMembers — the shape a picker gets', () => {
  test('resolves names and emails', () => {
    const out = toTenantMembers([grant('u1')], {
      u1: person('u1', 'Ada Lovelace', 'ada@acme.test'),
    });
    expect(out).toEqual([
      {
        id: 'u1',
        email: 'ada@acme.test',
        name: 'Ada Lovelace',
        resolved: true,
        // Migration 135. `[]` with no areas argument: the field is present and
        // empty rather than absent, so a consumer never has to distinguish
        // "no areas" from "this build does not have areas".
        knowledge_areas: [],
      },
    ] satisfies TenantMember[]);
  });

  test('an unresolvable id is LISTED, flagged, not dropped', () => {
    // A picker that silently drops a person is how an approver gets chosen
    // that nobody can explain later. A dangling grant is still real access.
    const out = toTenantMembers([grant('ghost')], {});
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 'ghost',
      email: null,
      name: null,
      resolved: false,
      knowledge_areas: [],
    });
  });

  test('one person holding TWO roles appears ONCE', () => {
    // user_roles is unique on (user_id, tenant_id, ROLE), so this is two rows
    // for one human. Listing them twice lets a user pick the same approver
    // twice and then read a roster that appears to need two sign-offs from one
    // person.
    const out = toTenantMembers(
      [grant('u1', 'workspace-admin'), grant('u1', 'workspace-member')],
      { u1: person('u1', 'Ada', 'ada@acme.test') },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('u1');
  });

  test('resolved people sort alphabetically; unresolved ids sort LAST', () => {
    // Not merely tidiness. localeCompare collates case-insensitively, so a raw
    // uuid lands BETWEEN 'Ada' and 'Zoe' — in the middle of the colleague list,
    // where it reads as someone you meant to pick. It must stay listed (a
    // dangling grant is real access) and must not look like a choice.
    const out = toTenantMembers([grant('u3'), grant('u1'), grant('u2')], {
      u1: person('u1', 'Zoe', 'z@acme.test'),
      u2: person('u2', 'Ada', 'a@acme.test'),
      // u3 deliberately unresolved
    });
    expect(out.map((m) => m.name ?? m.id)).toEqual(['Ada', 'Zoe', 'u3']);
    expect(out.at(-1)!.resolved).toBe(false);
  });

  test('an empty tenant yields an empty list, not a throw', () => {
    expect(toTenantMembers([], {})).toEqual([]);
  });
});

describe('the two structural invariants that keep this route safe', () => {
  test('it returns ONLY id/email/name/resolved/knowledge_areas — never workspaces[]', () => {
    // AdminUser carries `workspaces[]` = every workspace a person holds a role
    // in. Returning that to a plain member discloses which OTHER tenants a
    // colleague belongs to. Asserting on the KEY SET (not on a sample field)
    // is what makes this catch a future "just spread the AdminUser in".
    //
    // ⚠️ `knowledge_areas` was ADDED to this set by migration 135, deliberately
    // and with the same reasoning applied: an area says who to ask about what, it
    // is scoped to THIS tenant, and it discloses nothing about any other tenant —
    // unlike `workspaces[]`, and unlike `role`/`granted_at`/`granted_by`, which
    // are administrative facts and are still absent. Widening this list is a
    // decision; the test is here so it has to be made on purpose.
    const out = toTenantMembers([grant('u1')], {
      u1: person('u1', 'Ada', 'ada@acme.test'),
    });
    expect(Object.keys(out[0]!).sort()).toEqual([
      'email',
      'id',
      'knowledge_areas',
      'name',
      'resolved',
    ]);
  });

  test('knowledge areas are folded in per member, and default to []', () => {
    // Migration 135. The areas map comes from a SEPARATE table, so a member with
    // no row is ABSENT from it rather than present with an empty array — hence
    // the `?? []` in the fold. That default is what stops a consumer having to
    // distinguish "no areas" from "field missing".
    const out = toTenantMembers(
      [grant('u1'), grant('u2')],
      { u1: person('u1', 'Ada', 'ada@acme.test'), u2: person('u2', 'Grace', 'g@acme.test') },
      new Map([['u1', ['architecture', 'development']]]),
    );
    const byId = Object.fromEntries(out.map((m) => [m.id, m.knowledge_areas]));
    expect(byId.u1).toEqual(['architecture', 'development']);
    expect(byId.u2).toEqual([]);
  });

  test('the module never reads a tenant from a body or a path parameter', () => {
    // routes/workspace/members.ts:16-23 states the invariant: a caller-supplied
    // tenant is a cross-tenant privilege escalation, and admin/users.ts may
    // accept one ONLY because it is super-admin gated. This route is the least
    // privileged of the three, so it can least afford one.
    //
    // Checked against the source because it is a property of what the file may
    // ever do, not of one call. Verified live in
    // middleware/request-context.ts: X-Active-Tenant is honoured only for the
    // super_admin realm role, so ctxTenantId cannot be steered by a member.
    expect(SOURCE).toContain('ctxTenantId(user.tenantId)');

    // ⚠️ These target a tenant being READ AS INPUT. An earlier draft of this
    // test forbade /tenant_id\s*:/ outright and failed on the route's own
    // RESPONSE field — conflating reporting a tenant with accepting one. The
    // distinction is the whole invariant, so the patterns name the read sites.
    const forbidden = [
      /req\.json\(\)/,                     // no body at all on a GET
      /\bbody\.tenant_?[iI]d\b/,            // ...nor one smuggled through it
      /\bparams\.tenant_?[iI]d\b/,          // nor a path parameter
      /searchParams\.get\(\s*['"][^'"]*tenant/i, // nor a query string
      /headers\.get\(\s*['"]x-active-tenant/i,   // must not re-implement the switcher
    ];
    const code = SOURCE.split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    for (const re of forbidden) {
      expect(code).not.toMatch(re);
    }
  });
});
