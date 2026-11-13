// tests/unit/services/departments.test.ts
//
// Foundation Plan 2 — workspaces + departments + department_members service
// coverage. Hits the live test postgres (port 5488 via DATABASE_URL); we
// scrub state in beforeEach so tests are order-independent. The plan
// authored these as TDD; implementation lives in
// src/services/{workspaces,departments,department-members}.ts.

import { test, expect, beforeAll, beforeEach } from 'bun:test';
// Use `queryClient` (raw postgres.js tag) for cleanup. `tests/setup.ts`
// pre-warms `queryClient`; the drizzle `db` instance races with bun:test's
// parallel loader on full-suite runs (its prototype chain is observed
// half-linked, e.g. `.limit(...)` undefined). beforeAll below forces a
// real `db` query to run once before any test, which fully links the
// drizzle module before parallel test files start hitting it.
import { db, queryClient, workspaces } from '../../../src/db/client';
import { ensureWorkspace } from '../../../src/services/workspaces';
import {
  createDepartment,
  listDepartments,
  getDefaultDepartment,
  setDefaultDepartment,
  archiveDepartment,
} from '../../../src/services/departments';
import {
  addMember,
  listMembers,
  getMemberRole,
  removeMember,
  listDepartmentsForUser,
} from '../../../src/services/department-members';

const W = '11111111-1111-1111-1111-111111111111';

// Force the drizzle `db` instance to fully link before tests run. Under
// the bun:test parallel loader the chained API (`db.select().from(t).limit`)
// has been observed half-linked when many test files race for the same
// module — a single real query through `db` settles it.
beforeAll(async () => {
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  // Scoped delete: only nuke this test file's own workspace. The cascade
  // chain (workspaces → departments → department_members /
  // asset_assignments) does the rest, and we don't stomp on rows owned by
  // other test files running in parallel under bun:test.
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'test workspace');
});

// ---------------------------------------------------------------------------
// workspaces

test('ensureWorkspace is idempotent — second call returns the same row', async () => {
  const first = await ensureWorkspace(W, 'test workspace');
  const second = await ensureWorkspace(W, 'different name');
  expect(second.id).toBe(first.id);
  // The name on the existing row is preserved (we don't overwrite on
  // ensure — the function is "create or get", not "create or update").
  expect(second.name).toBe('test workspace');
});

// ---------------------------------------------------------------------------
// departments

test('createDepartment creates a non-default dept', async () => {
  const d = await createDepartment(W, { name: 'eng' });
  expect(d.name).toBe('eng');
  expect(d.is_default).toBe(false);
});

test('setDefaultDepartment is unique per workspace', async () => {
  const a = await createDepartment(W, { name: 'a' });
  const b = await createDepartment(W, { name: 'b' });
  await setDefaultDepartment(a.id);
  await setDefaultDepartment(b.id);
  const def = await getDefaultDepartment(W);
  expect(def?.id).toBe(b.id);
});

test('listDepartments excludes archived by default', async () => {
  const a = await createDepartment(W, { name: 'a' });
  await archiveDepartment(a.id);
  expect((await listDepartments(W)).length).toBe(0);
  expect((await listDepartments(W, { includeArchived: true })).length).toBe(1);
});

// ---------------------------------------------------------------------------
// department_members

const U1 = 'user-1';
const U2 = 'user-2';

test('addMember stores a (user, role) tuple', async () => {
  const dept = await createDepartment(W, { name: 'eng' });
  await addMember(dept.id, U1, 'dept-admin');
  expect(await getMemberRole(dept.id, U1)).toBe('dept-admin');
});

test('addMember is upsert — last role wins', async () => {
  const dept = await createDepartment(W, { name: 'eng' });
  await addMember(dept.id, U1, 'dept-member');
  await addMember(dept.id, U1, 'dept-admin');
  expect(await getMemberRole(dept.id, U1)).toBe('dept-admin');
});

test('removeMember deletes the row', async () => {
  const dept = await createDepartment(W, { name: 'eng' });
  await addMember(dept.id, U1, 'dept-member');
  await removeMember(dept.id, U1);
  expect(await getMemberRole(dept.id, U1)).toBeNull();
});

test('listMembers returns all members of a dept', async () => {
  const dept = await createDepartment(W, { name: 'eng' });
  await addMember(dept.id, U1, 'dept-admin');
  await addMember(dept.id, U2, 'dept-member');
  expect((await listMembers(dept.id)).length).toBe(2);
});

test('listDepartmentsForUser spans multiple departments', async () => {
  const a = await createDepartment(W, { name: 'a' });
  const b = await createDepartment(W, { name: 'b' });
  await addMember(a.id, U1, 'dept-admin');
  await addMember(b.id, U1, 'dept-viewer');
  const rows = await listDepartmentsForUser(U1);
  const byDept = Object.fromEntries(rows.map((r) => [r.dept_id, r.role]));
  expect(byDept[a.id]).toBe('dept-admin');
  expect(byDept[b.id]).toBe('dept-viewer');
});
