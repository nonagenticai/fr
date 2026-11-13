// tests/unit/db/no-session-advisory-lock.test.ts
//
// ⛔ PIN: no SESSION-level Postgres advisory lock anywhere in backend/src.
//
// fr reaches Postgres through pgbouncer in TRANSACTION pooling. A session-level
// `pg_advisory_lock` / `pg_advisory_unlock` (or `try_` / `_shared` /
// `unlock_all`) binds to the SERVER backend, not to fr's logical connection:
// the lock outlives fr's transaction and is handed to whichever client gets
// that backend next, and the unlock can land on a different backend and leak
// the lock forever. Same class as the 2026-09-22 session-`SET` incident. Every
// advisory lock in fr must be `pg_advisory_xact_lock` /
// `pg_try_advisory_xact_lock`, taken inside the transaction it protects.
//
// Sibling pin (row 13a): no SESSION-level `SET lock_timeout` /
// `SET statement_timeout` (or `SET SESSION …`, or `set_config(…, false)`)
// either — same mechanism: the GUC survives fr's transaction on the server
// backend and the next client inherits it. Only `SET LOCAL` (or
// `set_config(…, true)`) inside the transaction it bounds.
//
// Code lines only: comment lines (`//`, `*`, `/*`) are skipped, because several
// files DOCUMENT the forbidden form (db/advisory-lock-keys.ts,
// services/improvement-cards/relations.ts) and must stay free to.

import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../../../src');

/** Session-level advisory-lock calls. The xact forms never match (`advisory_xact_`). */
const SESSION_LOCK = /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\s*\(/;

/** Session-level timeout GUCs: `SET [SESSION] <guc>` (not `SET LOCAL`) or `set_config('<guc>', …, false)`. */
const SESSION_TIMEOUT_SET =
  /\bSET\s+(?:SESSION\s+)?(?:lock_timeout|statement_timeout|idle_in_transaction_session_timeout)\b|\bset_config\(\s*'(?:lock_timeout|statement_timeout|idle_in_transaction_session_timeout)'\s*,[^)]*,\s*false\s*\)/i;

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function findSessionLocks(source: string): number[] {
  const hits: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (!isCommentLine(line) && SESSION_LOCK.test(line)) hits.push(i + 1);
  });
  return hits;
}

function findSessionTimeoutSets(source: string): number[] {
  const hits: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (!isCommentLine(line) && SESSION_TIMEOUT_SET.test(line)) hits.push(i + 1);
  });
  return hits;
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('detector: flags every session-level form, spares the xact forms and comment lines', () => {
  for (const bad of [
    'await tx`SELECT pg_advisory_lock(${k})`;',
    'sql`SELECT pg_advisory_unlock(hashtext(${k}))`',
    'SELECT pg_try_advisory_lock(1)',
    'SELECT pg_advisory_lock_shared (1)',
    'SELECT pg_advisory_unlock_all()',
    // The conveyor slot's SESSION form must be caught…
    'sql`SELECT pg_try_advisory_lock(hashtext(${PRIORITY_CONVEYOR_LOCK_KEY})) AS ok`',
  ]) {
    expect(findSessionLocks(bad)).toEqual([1]);
  }
  for (const ok of [
    'sql`SELECT pg_advisory_xact_lock(hashtext(${k}))`',
    'SELECT pg_try_advisory_xact_lock(1)',
    // …and its transaction-scoped form must not be.
    'sql`SELECT pg_try_advisory_xact_lock(hashtext(${PRIORITY_CONVEYOR_LOCK_KEY})) AS ok`',
    '// never pg_advisory_lock(...) here',
    ' * a `pg_advisory_lock(...)` call',
  ]) {
    expect(findSessionLocks(ok)).toEqual([]);
  }
});

test('backend/src contains NO session-level advisory lock call', () => {
  const files = tsFiles(SRC);
  // Fail closed on an empty scope: a scan of nothing must not read as clean.
  // Non-vacuity only — no count of the tree is pinned.
  expect(files.length).toBeGreaterThan(0);
  // Positive control: the scan reads code lines — the per-card priority lock's
  // xact call is in scope and is seen.
  const priority = files.find((f) => f.endsWith(join('lib', 'priority-change.ts')));
  expect(priority).toBeDefined();
  expect(readFileSync(priority!, 'utf8')).toContain('pg_advisory_xact_lock(');
  expect(readFileSync(priority!, 'utf8')).toContain('pg_try_advisory_xact_lock(');

  const offenders: string[] = [];
  for (const f of files) {
    for (const line of findSessionLocks(readFileSync(f, 'utf8'))) {
      offenders.push(`${relative(SRC, f)}:${line}`);
    }
  }
  expect(offenders).toEqual([]);
});

test('detector: flags a session-level timeout SET, spares SET LOCAL, set_config(…, true) and comment lines', () => {
  for (const bad of [
    "await tx.execute(sql.raw(`SET lock_timeout = '2s'`));",
    "await tx.execute(sql.raw(`SET statement_timeout = '10s'`));",
    "sql`SET SESSION lock_timeout TO '2s'`",
    "sql`set statement_timeout = 0`",
    "SET idle_in_transaction_session_timeout = '5s'",
    "sql`SELECT set_config('lock_timeout', '2s', false)`",
  ]) {
    expect(findSessionTimeoutSets(bad)).toEqual([1]);
  }
  for (const ok of [
    "await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${PRIORITY_LOCK_TIMEOUT}'`));",
    "await tx.execute(sql.raw(`SET LOCAL statement_timeout = '10s'`));",
    "sql`SELECT set_config('statement_timeout', '10s', true)`",
    "// a session `SET lock_timeout` would leak",
    " * `SET statement_timeout` is forbidden",
    "const PRIORITY_LOCK_TIMEOUT = '2s';",
  ]) {
    expect(findSessionTimeoutSets(ok)).toEqual([]);
  }
});

test('backend/src contains NO session-level lock_timeout / statement_timeout SET', () => {
  const files = tsFiles(SRC);
  expect(files.length).toBeGreaterThan(0);
  // Positive control: the priority transaction's SET LOCALs are in scope and seen.
  const priority = files.find((f) => f.endsWith(join('lib', 'priority-change.ts')));
  expect(priority).toBeDefined();
  const src = readFileSync(priority!, 'utf8');
  expect(src).toContain('SET LOCAL lock_timeout');
  expect(src).toContain('SET LOCAL statement_timeout');

  const offenders: string[] = [];
  for (const f of files) {
    for (const line of findSessionTimeoutSets(readFileSync(f, 'utf8'))) {
      offenders.push(`${relative(SRC, f)}:${line}`);
    }
  }
  expect(offenders).toEqual([]);
});
