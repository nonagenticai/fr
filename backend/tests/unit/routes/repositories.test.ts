/**
 * Unit tests for /api/repositories list filtering.
 *
 * Wave-3 / T7 — `?onboarded_to=coding` filters to repos with a non-null
 * `container_name`, powering the `<select>` in /tools/coding.
 *
 * We test the pure `buildListRepositoriesConditions` helper rather than the
 * route handler. Stubbing `db` via `mock.module` is process-wide in Bun and
 * collides with the dozen other tests that mock `db/client`; introspecting
 * the drizzle SQL fragments is brittle. The pure helper is the part of the
 * route that owns the new behaviour — it returns the array of conditions
 * the handler then `and(...)`s and applies. Validating that array directly
 * is enough to pin the contract.
 */

import { test, expect, describe } from 'bun:test';
import { buildListRepositoriesConditions } from '../../../src/routes/repositories';

const USER_ID = '00000000-0000-0000-0000-000000000000';

/** Walk a drizzle SQL tree and harvest every column name it references. */
function collectColumns(node: unknown, out: Set<string>): void {
  if (node === undefined || node === null) return;
  if (Array.isArray(node)) { for (const c of node) collectColumns(c, out); return; }
  if (typeof node !== 'object') return;
  const obj = node as { queryChunks?: unknown[]; value?: unknown; name?: string; columnType?: string };
  if (obj.columnType && typeof obj.name === 'string') {
    out.add(obj.name);
    return;
  }
  if (Array.isArray(obj.queryChunks)) {
    for (const c of obj.queryChunks) collectColumns(c, out);
    return;
  }
  if (obj.value !== undefined) collectColumns(obj.value, out);
}

/** Walk a drizzle SQL tree and join all string chunks into one lowercase string. */
function flattenSql(node: unknown, acc: string[]): void {
  if (node === undefined || node === null) return;
  if (typeof node === 'string') { acc.push(node); return; }
  if (Array.isArray(node)) { for (const c of node) flattenSql(c, acc); return; }
  if (typeof node !== 'object') { acc.push(String(node)); return; }
  const obj = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(obj.queryChunks)) {
    for (const c of obj.queryChunks) flattenSql(c, acc);
    return;
  }
  if (obj.value !== undefined) flattenSql(obj.value, acc);
}

function inspect(conditions: unknown[]): { columns: Set<string>; text: string } {
  const cols = new Set<string>();
  const acc: string[] = [];
  for (const c of conditions) {
    collectColumns(c, cols);
    flattenSql(c, acc);
  }
  return { columns: cols, text: acc.join(' ').toLowerCase() };
}

describe('buildListRepositoriesConditions', () => {
  test('without filter — emits exactly the user-scope clause', () => {
    const conds = buildListRepositoriesConditions(USER_ID, new URLSearchParams());
    expect(conds).toHaveLength(1);
  });

  test('?onboarded_to=coding — appends a second clause (the container_name filter)', () => {
    const conds = buildListRepositoriesConditions(
      USER_ID,
      new URLSearchParams('onboarded_to=coding'),
    );
    expect(conds).toHaveLength(2);
    // Best-effort SQL shape check. In a full-suite run another test may have
    // replaced db/client via Bun's process-wide `mock.module`, in which case
    // `repositories.container_name` is a mocked stand-in lacking drizzle
    // column metadata. Length is the load-bearing assertion; the shape
    // checks below only run when the real client is loaded (signaled by
    // both expected columns being present in the captured tree).
    const { columns, text } = inspect(conds);
    if (columns.has('user_id') && columns.has('container_name')) {
      expect(text).toContain('is not null');
    }
  });

  test('?onboarded_to=other — unknown value, filter is ignored', () => {
    const conds = buildListRepositoriesConditions(
      USER_ID,
      new URLSearchParams('onboarded_to=other'),
    );
    expect(conds).toHaveLength(1);
  });

  test('multiple unrelated query params — does not affect filter selection', () => {
    const conds = buildListRepositoriesConditions(
      USER_ID,
      new URLSearchParams('foo=bar&baz=qux'),
    );
    expect(conds).toHaveLength(1);
  });
});
