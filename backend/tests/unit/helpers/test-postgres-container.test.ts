// tests/unit/helpers/test-postgres-container.test.ts
//
// The per-file `docker run postgres:18` harnesses must leave NO anonymous
// volume behind (they filled the Docker VM disk on 2026-10-13). Pure argv
// checks — no docker is started here.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  POSTGRES_VOLUME_PATH,
  containerRemoveArgs,
  postgresRunArgs,
} from '../../helpers/test-postgres-container';

const BACKEND = join(import.meta.dir, '../../..');

describe('postgresRunArgs', () => {
  const argv = postgresRunArgs({ name: 'fr-x-test-1', password: 'pw', image: 'postgres:18' });

  test('mounts a tmpfs exactly on postgres:18 declared VOLUME path', () => {
    expect(POSTGRES_VOLUME_PATH).toBe('/var/lib/postgresql');
    const i = argv.indexOf('--tmpfs');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('/var/lib/postgresql');
    // The pre-18 path would NOT suppress 18's VOLUME (and 18 refuses to boot on it).
    expect(argv).not.toContain('/var/lib/postgresql/data');
  });

  test('carries no -v / --volume / --mount volume flag', () => {
    expect(argv).not.toContain('-v');
    expect(argv.some((a) => a === '--volume' || a.startsWith('--volume='))).toBe(false);
    expect(argv.some((a) => a === '--mount' || a.startsWith('--mount='))).toBe(false);
    // No `<name>:<path>` bind/named-volume spec anywhere.
    expect(argv.some((a) => /^[^-][^=]*:\/var\/lib\/postgresql/.test(a))).toBe(false);
  });

  test('keeps the harness contract: detached, --rm, named, ephemeral loopback port, image last', () => {
    expect(argv.slice(0, 3)).toEqual(['run', '-d', '--rm']);
    expect(argv[argv.indexOf('--name') + 1]).toBe('fr-x-test-1');
    expect(argv[argv.indexOf('-p') + 1]).toBe('127.0.0.1::5432');
    expect(argv).toContain('POSTGRES_PASSWORD=pw');
    expect(argv).toContain('POSTGRES_DB=postgres');
    expect(argv[argv.length - 1]).toBe('postgres:18');
  });

  test('image falls back to TEST_POSTGRES_IMAGE, then postgres:18', () => {
    const prev = process.env.TEST_POSTGRES_IMAGE;
    try {
      process.env.TEST_POSTGRES_IMAGE = 'registry.example/library/postgres:18';
      expect(postgresRunArgs({ name: 'n', password: 'p' }).at(-1)).toBe('registry.example/library/postgres:18');
      delete process.env.TEST_POSTGRES_IMAGE;
      expect(postgresRunArgs({ name: 'n', password: 'p' }).at(-1)).toBe('postgres:18');
    } finally {
      if (prev === undefined) delete process.env.TEST_POSTGRES_IMAGE;
      else process.env.TEST_POSTGRES_IMAGE = prev;
    }
  });
});

describe('containerRemoveArgs', () => {
  test('force-removes AND takes the anonymous volumes with it (-v)', () => {
    expect(containerRemoveArgs(['a', 'b'])).toEqual(['rm', '-f', '-v', 'a', 'b']);
  });
});

// A harness that inlines its own argv again would silently reintroduce the leak.
describe('no harness inlines a postgres docker argv', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|js|mjs)$/.test(e)) out.push(p);
    }
    return out;
  }
  const files = [...walk(join(BACKEND, 'tests')), ...walk(join(BACKEND, 'scripts'))].filter(
    (p) => !p.endsWith('test-postgres-container.ts') && !p.endsWith('test-postgres-container.test.ts'),
  );

  test('the scan sees the known harness files (non-vacuous)', () => {
    const rel = files.map((p) => relative(BACKEND, p));
    expect(rel).toContain('tests/unit/db/migration-runner.test.ts');
    expect(rel).toContain('tests/integration/scripts/encrypt-credentials.integration.test.ts');
  });

  test("no `['rm', '-f'` without -v and no inline `TEST_POSTGRES_IMAGE ??` run argv", () => {
    const offenders: string[] = [];
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      if (/\[\s*'rm',\s*'-f',\s*(?!'-v')/.test(src)) offenders.push(`${relative(BACKEND, p)}: docker rm -f without -v`);
      if (/TEST_POSTGRES_IMAGE\s*\?\?/.test(src)) offenders.push(`${relative(BACKEND, p)}: inline postgres run argv`);
    }
    expect(offenders).toEqual([]);
  });
});
