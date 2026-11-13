// tests/unit/services/user-roles-tenant-name-source.test.ts
//
// The access list rendered a raw UUID where a workspace name belongs.
//
// `user_roles.tenant_name` is a denormalized display column, and nothing in
// `src/` wrote it until the admin grant route landed — so every older row
// carries NULL. Measured on production 2026-09-06: 10 of 13 grants had
// `tenant_name IS NULL`, and for two of them (`claude`, `nonagenticai-prod`)
// the name was sitting in `workspaces` the whole time. Resolving through the
// join takes that from 3 of 13 named to 5 of 13, and leaves the remaining 8 —
// which have no `workspaces` row at all — honestly showing an id.
//
// ⚠️ WHAT THIS FILE IS REALLY FOR: the ARGUMENT ORDER inside the coalesce.
// The natural reading — "use the stored label, fall back to the join",
// `coalesce(tenant_name, workspaces.name)` — is WRONG, and I wrote it that way
// first. `tenant_name` is a snapshot taken at grant time, so the moment a
// workspace is renamed that arm wins forever and the access list displays a
// name that no longer exists. Both orders resolve the same 5 rows today, so no
// count and no fixture would have caught it; only asserting the order does.
//
// The coalesce evaluates in SQL, so a fake-db test cannot observe its RESULT.
// It can observe its SHAPE, and the shape is precisely the part that was wrong.

import { describe, expect, test } from 'bun:test';

import { TENANT_NAME_FROM_SOURCE } from '../../../src/services/user-roles';

/** Column references inside the expression, in the order they appear. */
function columnOrder(expr: unknown): string[] {
  const chunks = (expr as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: string[] = [];
  for (const c of chunks) {
    const col = c as { name?: string; table?: Record<symbol, unknown> };
    if (!col?.name) continue;
    const table = col.table?.[Symbol.for('drizzle:Name')];
    out.push(table ? `${String(table)}.${col.name}` : col.name);
  }
  return out;
}

describe('the displayed workspace name comes from the live row, not the snapshot', () => {
  test('workspaces.name is consulted BEFORE user_roles.tenant_name', () => {
    // The whole point. Reversing these two is invisible in every row count and
    // only shows up after a workspace is renamed.
    expect(columnOrder(TENANT_NAME_FROM_SOURCE)).toEqual([
      'workspaces.name',
      'user_roles.tenant_name',
    ]);
  });

  test('both sources are present — the snapshot is kept as a fallback', () => {
    // `tenant_name` is not dead weight: when the `workspaces` row is gone it is
    // the only surviving record of what the grant referred to. Dropping it from
    // the expression would lose that, which is why this asserts BOTH arms
    // rather than just the first.
    const cols = columnOrder(TENANT_NAME_FROM_SOURCE);
    expect(cols).toContain('user_roles.tenant_name');
    expect(cols).toHaveLength(2);
  });

  test('it is a coalesce, so neither arm being NULL is an error', () => {
    const chunks = (TENANT_NAME_FROM_SOURCE as unknown as { queryChunks: unknown[] }).queryChunks;
    const literals = chunks
      .map((c) => (c as { value?: unknown[] }).value)
      .filter(Boolean)
      .flat()
      .join('');
    expect(literals).toContain('coalesce(');
    // 8 of 13 production rows resolve to NULL through both arms. That must
    // stay a legal outcome — the UI renders the id for those deliberately.
    expect(literals).not.toMatch(/coalesce\(\s*'/);
  });
});
