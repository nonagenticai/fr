// tests/unit/db/database-url-no-fallback.test.ts
//
// George ruling 2026-10-21: no service defaults to a host localhost:5432 Postgres.
// src/config.ts used to fall back to `postgres:postgres@localhost:5432/fr`. Now:
//   * importing config + db/client with DATABASE_URL unset does NOT throw (CI guard steps
//     import them with no database);
//   * the FIRST database use throws DATABASE_URL_UNSET_MESSAGE;
//   * nothing is ever dialled — in particular not postgres-js's PGHOST/PGPORT defaults, which
//     is what an empty URL would silently fall back to.
// Each probe runs as a subprocess `bun --no-env-file run` (no test preloads, no .env), with
// PGHOST/PGPORT pointed at a TCP listener here that counts connections. The control case
// (DATABASE_URL = that listener) proves the counter sees a real dial. DB-free.
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { DATABASE_URL_UNSET_MESSAGE } from '../../../src/config';

const BACKEND = join(import.meta.dir, '../../..');

let connections = 0;
const listener = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open() {
      connections++;
    },
    data() {},
  },
});
afterAll(() => listener.stop(true));

function probe(env: Record<string, string>): Record<string, unknown> {
  const p = Bun.spawnSync(['bun', '--no-env-file', 'run', './tests/fixtures/db-no-fallback/probe.ts'], {
    cwd: BACKEND,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      PGHOST: '127.0.0.1',
      PGPORT: String(listener.port),
      ...env,
    },
  });
  const text = p.stdout.toString() + p.stderr.toString();
  const line = text.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (line === undefined) throw new Error(`probe printed no result (exit ${p.exitCode}):\n${text}`);
  return JSON.parse(line.slice('PROBE_RESULT '.length));
}

describe('config.database.url has no localhost fallback; the db client fails closed on first use', () => {
  test('the message names the variable', () => {
    expect(DATABASE_URL_UNSET_MESSAGE).toBe('[fr] DATABASE_URL is unset: refusing to start');
  });

  for (const [label, env] of [
    ['unset', {}],
    ['blank', { DATABASE_URL: '   ' }],
  ] as const) {
    test(`DATABASE_URL ${label}: import is fine, first use throws, nothing is dialled`, () => {
      const before = connections;
      const r = probe(env);
      expect(r.importError).toBeUndefined();
      expect(r.imported).toBe(true);
      expect(r.configError).toBe(DATABASE_URL_UNSET_MESSAGE);
      expect(r.queryError).toBe(DATABASE_URL_UNSET_MESSAGE);
      expect(r.dbError).toBe(DATABASE_URL_UNSET_MESSAGE);
      expect(connections).toBe(before);
    });
  }

  test('control: a DATABASE_URL pointing at the listener IS dialled (the counter works)', async () => {
    const before = connections;
    const r = probe({ DATABASE_URL: `postgres://u:p@127.0.0.1:${listener.port}/db`, PROBE_WAIT_MS: '800' });
    expect(r.imported).toBe(true);
    expect(r.configError).toBeNull();
    expect(r.queryError).toBe('TIMEOUT'); // the listener never answers the startup packet
    await Bun.sleep(50);
    expect(connections).toBeGreaterThan(before);
  });

  test('the source carries no DSN default', async () => {
    const src = await Bun.file(join(BACKEND, 'src/config.ts')).text();
    expect(src).not.toMatch(/DATABASE_URL\s*(\|\||\?\?)\s*['"`]/);
    expect(src).not.toContain('localhost:5432');
  });
});
