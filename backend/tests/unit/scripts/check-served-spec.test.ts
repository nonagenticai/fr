// tests/unit/scripts/check-served-spec.test.ts
//
// The served-spec lock guard (scripts/check-served-spec.ts, fr-agui P4d-2e): the CONTROL is the
// real served spec against the committed lock; every mutation below is a change a consumer
// (n8n-nodes-fr, the frontend client) would see, and each must red — naming the operation.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXIT_BROKEN_GUARD,
  EXIT_OFFENCES,
  LOCK_FILE,
  compareToLock,
  lockBrokenError,
  lockOf,
  renderLock,
  type ServedSpecLock,
} from '../../../scripts/check-served-spec';
import { openapiSpec, SERVED_SPEC_ORDER } from '../../../src/capabilities/served-spec';

const BACKEND = join(import.meta.dir, '../../..');
type Spec = Parameters<typeof lockOf>[0];
const served = (): Spec => structuredClone(openapiSpec) as unknown as Spec;
const committed = (): ServedSpecLock => JSON.parse(readFileSync(join(BACKEND, LOCK_FILE), 'utf8')) as ServedSpecLock;
const ops = (spec: Spec) => spec.paths as Record<string, Record<string, Record<string, any>>>;

describe('the real tree', () => {
  test('CONTROL: the served spec equals the committed lock, served in the lock order', () => {
    const lock = committed();
    expect(lockBrokenError(lock)).toBeNull();
    expect(compareToLock(lockOf(served()), lock)).toEqual([]);
    // ⛔ NO operation count here, deliberately (owner ruling 2026-10-31). It was
    // an absolute number that had to be hand-bumped on every added route — 871
    // on main when this was written — while proving nothing: it is satisfied by
    // any lock of the right SIZE, including one whose rows are all wrong. The
    // equality above is the assertion, and the byte-exactness below is the other.
    expect(lock.operations.map((r) => r.op)).toEqual([...SERVED_SPEC_ORDER]);
    // The committed file is exactly what --write produces (no hand edit can hide in it).
    expect(readFileSync(join(BACKEND, LOCK_FILE), 'utf8')).toBe(renderLock(lockOf(served())));
  });
});

describe('mutations a consumer would see red, naming the operation', () => {
  const lock = lockOf(served());

  test('MUTATION (P4d-2a part 2 audit): a frozen parameter flipped `required: true → false`', () => {
    const spec = served();
    const del = ops(spec)['/api/projects/{id}']!.delete!;
    expect(del.parameters[0].required).toBe(true);
    del.parameters[0].required = false;
    expect(compareToLock(lockOf(spec), lock)).toEqual([
      { kind: 'operation-changed', key: 'DELETE /api/projects/{id}', detail: 'deleteProject: its served bytes differ from the lock' },
    ]);
  });

  test('a description edit on a NEW operation, and a removed response', () => {
    const spec = served();
    ops(spec)['/api/assets/artifacts']!.get!.summary += '!';
    delete ops(spec)['/api/projects']!.get!.responses['200'];
    expect(compareToLock(lockOf(spec), lock).map((o) => `${o.kind} ${o.key}`).sort()).toEqual([
      'operation-changed GET /api/assets/artifacts',
      'operation-changed GET /api/projects',
    ]);
  });

  test('an operationId rename is its own offence', () => {
    const spec = served();
    ops(spec)['/api/projects']!.get!.operationId = 'listProjectsRenamed';
    expect(compareToLock(lockOf(spec), lock)).toEqual([{ kind: 'operationId-changed', key: 'GET /api/projects', detail: 'listProjects → listProjectsRenamed' }]);
  });

  test('an added and a removed operation', () => {
    const spec = served();
    ops(spec)['/api/new-thing'] = { get: { operationId: 'newThing' } };
    delete ops(spec)['/api/projects']!.post;
    expect(compareToLock(lockOf(spec), lock).map((o) => `${o.kind} ${o.key}`).sort()).toEqual([
      'operation-added GET /api/new-thing',
      'operation-removed POST /api/projects',
    ]);
  });

  test('two operations swapped in order (the served path order is the lock)', () => {
    const spec = served();
    const paths = Object.entries(ops(spec));
    [paths[1], paths[2]] = [paths[2]!, paths[1]!];
    spec.paths = Object.fromEntries(paths);
    expect(compareToLock(lockOf(spec), lock).map((o) => o.kind)).toEqual(['order']);
  });

  test('a component schema edit, and a document edit (a tag)', () => {
    const spec = served();
    (spec.components!.schemas!.Error as Record<string, unknown>).description = 'edited';
    (spec as unknown as { tags: Array<{ name: string }> }).tags.push({ name: 'Extra' });
    expect(compareToLock(lockOf(spec), lock).map((o) => `${o.kind} ${o.key} ${o.detail.split(' ')[0]}`).sort()).toEqual([
      'component #/components/schemas/Error changed',
      'document (document) info',
    ]);
  });

  test('a broken lock is BROKEN, not a pass', () => {
    expect(lockBrokenError({})).toContain('not a served-spec lock');
    expect(lockBrokenError({ document: '', components: {}, operations: [] })).toContain('ZERO operations');
    const r = { op: 'GET /x', operationId: 'x', sha256: 'y' };
    expect(lockBrokenError({ document: '', components: {}, operations: [r, r] })).toContain('twice');
  });
});

describe('through the process boundary', () => {
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(['bun', '--no-env-file', 'run', 'scripts/check-served-spec.ts', ...args], {
      cwd: BACKEND,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, DATABASE_URL: 'postgresql://x:y@127.0.0.1:9/none' },
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  const dir = mkdtempSync(join(tmpdir(), 'served-spec-lock-'));

  test('CONTROL: the committed lock passes (exit 0)', () => {
    const r = run();
    // The CLI's success LINE, not a pinned count — the number changes with
    // every added route and asserts nothing about the route being correct.
    expect(r.out).toMatch(/OK: \d+ served operation\(s\)/);
    expect(r.code).toBe(0);
  });

  test('a lock whose row for one operation is stale exits 1 and names it', () => {
    const lock = committed();
    lock.operations.find((o) => o.op === 'DELETE /api/projects/{id}')!.sha256 = '0'.repeat(64);
    const file = join(dir, 'stale.json');
    writeFileSync(file, JSON.stringify(lock));
    const r = run(`--lock=${file}`);
    expect(r.out).toContain('[operation-changed] DELETE /api/projects/{id}');
    expect(r.code).toBe(EXIT_OFFENCES);
  });

  test('an unreadable or empty lock exits 2 (broken guard), and --write refuses --lock', () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ document: '', components: {}, operations: [] }));
    expect(run(`--lock=${empty}`).code).toBe(EXIT_BROKEN_GUARD);
    expect(run(`--lock=${join(dir, 'missing.json')}`).code).toBe(EXIT_BROKEN_GUARD);
    expect(run('--write', `--lock=${empty}`).code).toBe(EXIT_BROKEN_GUARD);
  });
});
