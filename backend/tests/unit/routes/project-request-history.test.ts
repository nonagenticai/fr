// tests/unit/routes/project-request-history.test.ts
//
// The property under test is that the append happens IN THE DATABASE.
//
// This is not style. MEASURED against postgres 18 with two writers on one row:
// the previous read-modify-write helper kept 1 entry, a SQL-side append kept 2.
// The entry the old path destroyed was the agent's — the one no human can
// reconstruct from memory afterwards.
//
// So the assertions are about the SQL that gets generated, because "it returns
// the right array" is exactly the thing the broken version also did.

import { describe, test, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  appendHistorySql,
  type HistoryEntry,
} from '../../../src/routes/project-request-history';

const entry = (action: string): HistoryEntry => ({
  at: '2026-09-21T12:00:00.000Z',
  action,
  by: '0195f48b-d000-7000-8000-000000000001',
});

/**
 * Compile the fragment to the SQL Postgres will actually receive.
 *
 * Uses drizzle's own dialect, so these assertions are about the emitted
 * statement rather than about the shape of an intermediate object — the point
 * being that the DATABASE does the append.
 */
const dialect = new PgDialect();
function render(frag: ReturnType<typeof appendHistorySql>): {
  sql: string;
  entries: HistoryEntry[];
} {
  const q = dialect.sqlToQuery(frag);
  // Exactly one bound parameter: the JSON array of new entries.
  return { sql: q.sql, entries: JSON.parse(String(q.params[0] ?? '[]')) };
}

describe('appendHistorySql — the append is a SQL concatenation', () => {
  test('it concatenates onto the column rather than replacing it', () => {
    const { sql } = render(appendHistorySql(entry('submitted')));
    // The `||` and the column reference together are what make the database,
    // not the application, decide what the final array is. Asserting the
    // COLUMN appears on the right-hand side is the part that matters: a
    // fragment that merely said `$1::jsonb` would replace, not append.
    expect(sql).toContain('||');
    expect(sql).toContain('"project_requests"."history"');
  });

  test('it casts the new entries to jsonb', () => {
    // Without the cast the parameter binds as text and `jsonb || text` errors
    // at runtime — green tsc, red production.
    expect(render(appendHistorySql(entry('submitted'))).sql).toContain('::jsonb');
  });

  test('it coalesces a NULL history instead of erasing it', () => {
    // NULL || anything is NULL in SQL. The column is NOT NULL DEFAULT '[]', so
    // this is for legacy rows only — but a silent erase is precisely the
    // failure this module exists to remove, and reintroducing it in the fix
    // would be careless.
    expect(render(appendHistorySql(entry('submitted'))).sql).toContain('coalesce');
  });

  test('the entries are carried as one JSON array parameter', () => {
    const { sql, entries } = render(appendHistorySql(entry('approved')));
    // One bound parameter holding an ARRAY — so the concatenation is
    // array-to-array and cannot flatten an object into the list.
    expect(sql).toContain('$1::jsonb');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('approved');
  });

  test('two facts about one transition go in ONE statement', () => {
    // A promotion and the CommonPractice feedback that followed it are two
    // entries. Two statements are two chances to interleave, so the helper is
    // variadic and both land in a single concatenation.
    const { sql, entries } = render(
      appendHistorySql(entry('approved'), entry('cp_feedback_sent')),
    );
    expect(entries.map((e) => e.action)).toEqual(['approved', 'cp_feedback_sent']);
    // ONE concatenation, not two — two statements are two chances to interleave.
    expect(sql.match(/\|\|/g) ?? []).toHaveLength(1);
  });

  test('an empty append is still well-formed', () => {
    const { sql, entries } = render(appendHistorySql());
    expect(entries).toEqual([]);
    expect(sql).toContain('||');
  });
});

describe('the route file no longer rebuilds the array in TypeScript', () => {
  test('no read-modify-write survives in project-requests.ts', async () => {
    const src = await Bun.file(
      new URL('../../../src/routes/project-requests.ts', import.meta.url),
    ).text();
    // The exact shape of the old helper. If this reappears, an audit entry can
    // be lost again with nothing failing.
    expect(src).not.toContain('[...prior, entry]');
    expect(src).not.toMatch(/history:\s*\[\s*\.\.\./);
    // And every append goes through the SQL helper.
    expect(src).toContain('appendHistorySql');
  });
});
