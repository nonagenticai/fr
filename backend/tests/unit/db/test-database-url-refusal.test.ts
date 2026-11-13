// tests/unit/db/test-database-url-refusal.test.ts
//
// fr-agui P4d-2e — backend tests with no DATABASE_URL outside CI REFUSE every connection (config.ts
// itself has had no localhost fallback since 2026-10-21 — tests/unit/db/database-url-no-fallback.test.ts)
// (tests/setup-env.ts + src/db/client.ts). On a developer Mac the old fallback was a REAL database:
// on 2026-10-17 a unit run without DATABASE_URL reached devbox's and ran a scoped DELETE.
// Both directions, each in a subprocess `bun test` so the bunfig preloads run as for any test file:
//   * DATABASE_URL unset, CI unset  → every query throws TEST_DATABASE_URL_REFUSED_MESSAGE (nothing dialled);
//   * DATABASE_URL set              → untouched, the query runs (against the suite's own database);
//   * CI=true, DATABASE_URL unset   → untouched (CI owns its env; every CI test step sets DATABASE_URL).
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { TEST_DATABASE_URL_REFUSED_MESSAGE } from '../../../src/db/client';

const BACKEND = join(import.meta.dir, '../../..');

function probe(env: Record<string, string>): { refused: string | null; url: string | null; out: string } {
  const p = Bun.spawnSync(['bun', '--no-env-file', 'test', '--timeout', '60000', './tests/fixtures/db-refusal/probe.ts'], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  });
  const text = p.stdout.toString() + p.stderr.toString();
  const line = text.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (line === undefined) throw new Error(`probe printed no result (exit ${p.exitCode}):\n${text}`);
  return JSON.parse(line.slice('PROBE_RESULT '.length));
}

// The suite's own database (every CI test step sets DATABASE_URL; locally, a throwaway one). When this
// run itself is the refused one there is no database to prove the "set → runs" half against.
const suiteUrl = process.env.FR_TEST_DATABASE_URL_REFUSED === '1' ? undefined : process.env.DATABASE_URL;

describe('the localhost:5432/fr fallback is refused outside CI', () => {
  test('DATABASE_URL unset, CI unset: the query THROWS the refusal message; the sentinel is unconnectable', () => {
    const r = probe({ PROBE_QUERY: '1' });
    expect(r.refused).toBe('1');
    expect(r.url).not.toContain('localhost:5432');
    expect(r.url).toContain('127.0.0.1:9/');
    expect(r.out).toBe(`ERROR ${TEST_DATABASE_URL_REFUSED_MESSAGE}`);
    // A blank DATABASE_URL is "unset" too (config treats it as unset).
    expect(probe({ PROBE_QUERY: '1', DATABASE_URL: '  ' }).out).toBe(`ERROR ${TEST_DATABASE_URL_REFUSED_MESSAGE}`);
  });

  test('CI=true, DATABASE_URL unset: left alone (no refusal flag, no sentinel; CI steps always set DATABASE_URL)', () => {
    const r = probe({ CI: 'true' });
    expect(r.refused).toBeNull();
    expect(r.url).toBeNull();
  });

  test.skipIf(suiteUrl === undefined)('DATABASE_URL set: untouched, and the query RUNS', () => {
    const r = probe({ PROBE_QUERY: '1', DATABASE_URL: suiteUrl! });
    expect(r.refused).toBeNull();
    expect(r.url).toBe(suiteUrl!);
    expect(r.out).toBe('CONNECTED');
  });
});
