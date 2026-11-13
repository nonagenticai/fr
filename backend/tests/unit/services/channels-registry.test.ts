// tests/unit/services/channels-registry.test.ts
//
// Foundation Plan 2 follow-up — channels registry CRUD service.
//
// Docker-gated against postgres:18 (matches the existing
// `migration-runner.test.ts` harness pattern).
// Brings up an ephemeral container, applies ALL fr migrations through 030
// via `applyMigrations`, seeds a workspace + department, then exercises
// the service against the real schema. Drizzle's FK constraints + the
// `(workspace_id, name)` unique index are part of the contract under
// test, so a real Postgres is the only honest substrate.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://placeholder/placeholder';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import { containerRemoveArgs, postgresRunArgs } from '../../helpers/test-postgres-container';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { applyMigrations } from '../../../src/db/migration-runner';
import * as schema from '../../../src/db/schema';
import { truncateForTests } from '../../helpers/destructive-hatch';

// ---- docker harness -------------------------------------------------------

const CONTAINER_NAME = `fr-channels-registry-test-${process.pid}`;
const CONTAINER_NAME_PREFIX = 'fr-channels-registry-test-';
const TEST_PASSWORD = 'test';
let TEST_PORT = 0;

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

function reapAllTestContainers(): void {
  const ls = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `name=${CONTAINER_NAME_PREFIX}`],
    { encoding: 'utf8' },
  );
  if (ls.status !== 0) return;
  const ids = (ls.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return;
  spawnSync('docker', containerRemoveArgs(ids), { encoding: 'utf8' });
}

function startContainer(): { ok: boolean; reason?: string } {
  reapAllTestContainers();
  const r = spawnSync(
    'docker',
    postgresRunArgs({ name: CONTAINER_NAME, password: TEST_PASSWORD }),
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return { ok: false, reason: r.stderr || r.stdout };
  for (let i = 0; i < 20; i++) {
    const p = spawnSync('docker', ['port', CONTAINER_NAME, '5432/tcp'], {
      encoding: 'utf8',
    });
    if (p.status === 0 && p.stdout) {
      const line = p.stdout.split('\n').find((l) => l.trim().length > 0);
      const m = line?.match(/:(\d+)\s*$/);
      if (m) {
        TEST_PORT = Number.parseInt(m[1]!, 10);
        return { ok: true };
      }
    }
    spawnSync('sleep', ['0.1']);
  }
  return { ok: false, reason: 'could not resolve host port' };
}

function stopContainer(): void {
  spawnSync('docker', containerRemoveArgs([CONTAINER_NAME]), { encoding: 'utf8' });
  reapAllTestContainers();
}

function adminUrl(db = 'postgres'): string {
  return `postgresql://postgres:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${db}`;
}

async function waitForPg(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sql = postgres(adminUrl(), {
      max: 1,
      connect_timeout: 2,
      onnotice: () => {},
    });
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch {
      try {
        await sql.end({ timeout: 1 });
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Timed out waiting for postgres on port ${TEST_PORT}`);
}

// ---- per-suite setup ------------------------------------------------------

const DOCKER = dockerAvailable();
const DB_NAME = `channels_registry_test_${process.pid}`;
let testDbUrl = '';
let directSql: postgres.Sql;

const WS_ID = '11111111-1111-4111-8111-111111111111';
const DEPT_ID = '22222222-2222-4222-8222-222222222222';

type ServiceModule = typeof import('../../../src/services/channels-registry');
let svcRaw: ServiceModule;

// Test-DB-bound proxy over the service. Every call passes the
// test-scoped drizzle client as the explicit `db` arg so the service's
// shared module-level client (bound to a placeholder URL by the test
// preload) is bypassed.
let svc: {
  createChannel: (input: Parameters<ServiceModule['createChannel']>[0]) =>
    ReturnType<ServiceModule['createChannel']>;
  getChannel: (id: string) => ReturnType<ServiceModule['getChannel']>;
  listChannels: (
    workspaceId: string,
    opts?: Parameters<ServiceModule['listChannels']>[1],
  ) => ReturnType<ServiceModule['listChannels']>;
  updateChannel: (
    id: string,
    patch: Parameters<ServiceModule['updateChannel']>[1],
  ) => ReturnType<ServiceModule['updateChannel']>;
  deleteChannel: (id: string) => ReturnType<ServiceModule['deleteChannel']>;
  loadChannelCredentials: (id: string) =>
    ReturnType<ServiceModule['loadChannelCredentials']>;
};

if (DOCKER) {
  const bail = () => {
    try {
      stopContainer();
    } catch {}
  };
  process.once('SIGINT', bail);
  process.once('SIGTERM', bail);
  process.once('exit', bail);
}

beforeAll(async () => {
  if (!DOCKER) {
    console.warn('[channels-registry.test] docker unavailable — skipping');
    return;
  }
  const started = startContainer();
  if (!started.ok) {
    console.warn(`[channels-registry.test] docker run failed: ${started.reason}`);
    return;
  }
  await waitForPg();

  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  testDbUrl = adminUrl(DB_NAME);

  // Materialize the full schema via drizzle-kit push first (creates the
  // projects table that NNN-style migrations ALTER), then applyMigrations
  // backfills _migrations because `projects` already exists. End-state =
  // current schema.ts including the channels table from migration 030.
  const push = spawnSync(
    'bunx',
    ['drizzle-kit', 'push'],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: testDbUrl },
      input: 'y\n',
      cwd: path.resolve(import.meta.dir, '..', '..', '..'),
    },
  );
  if (push.status !== 0) {
    throw new Error(`drizzle-kit push failed: ${push.stderr || push.stdout}`);
  }
  await applyMigrations(testDbUrl);

  directSql = postgres(testDbUrl, { max: 4, onnotice: () => {} });

  // Seed a workspace + a default department.
  await directSql`
    INSERT INTO workspaces (id, name) VALUES (${WS_ID}, 'Test Workspace')
  `;
  await directSql`
    INSERT INTO departments (id, workspace_id, name, is_default)
    VALUES (${DEPT_ID}, ${WS_ID}, 'engineering', true)
  `;

  // Build a test-scoped drizzle client and bind a service proxy to it.
  // The shared `db` module-level instance was already constructed against
  // a placeholder DATABASE_URL by the test preload; this proxy ensures
  // every service call routes through the docker DB instead.
  const testDb = drizzle(directSql, { schema });
  svcRaw = await import('../../../src/services/channels-registry');
  svc = {
    createChannel: (input) => svcRaw.createChannel(input, testDb),
    getChannel: (id) => svcRaw.getChannel(id, testDb),
    listChannels: (workspaceId, opts) =>
      svcRaw.listChannels(workspaceId, opts, testDb),
    updateChannel: (id, patch) => svcRaw.updateChannel(id, patch, testDb),
    deleteChannel: (id) => svcRaw.deleteChannel(id, testDb),
    loadChannelCredentials: (id) => svcRaw.loadChannelCredentials(id, testDb),
  };

  // Phase 4 — make sure the encryption singleton has its key imported
  // before the first encrypt call lands in createChannel.
  const { encryption } = await import('../../../src/services/encryption');
  await encryption.initialize();
}, 180_000);

afterAll(async () => {
  try {
    if (directSql) await directSql.end({ timeout: 5 });
  } catch {}
  stopContainer();
}, 30_000);

beforeEach(async () => {
  if (!DOCKER || !directSql) return;
  // `channels` is protected by migration 142, whose BEFORE TRUNCATE trigger
  // refuses at ANY row count. The fixture declares its intent through the
  // shared hatch helper (one transaction, SET LOCAL) rather than the guard
  // being weakened for it — see tests/helpers/destructive-hatch.ts.
  await truncateForTests(directSql, 'channels');
});

const d = DOCKER ? describe : describe.skip;

// ---- tests ----------------------------------------------------------------

d('channels-registry service', () => {
  test('createChannel — workspace-scoped row, credentials never returned', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'teams',
      name: 'ops-pager',
      config: { phone: '+15551234567' },
      credentials: 'super-secret-token',
    });
    expect(ch.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ch.workspace_id).toBe(WS_ID);
    expect(ch.dept_id).toBeNull();
    expect(ch.kind).toBe('teams');
    expect(ch.name).toBe('ops-pager');
    expect(ch.config).toEqual({ phone: '+15551234567' });
    // Credentials must NOT be on the read-shape under any name.
    expect((ch as unknown as Record<string, unknown>).credentials).toBeUndefined();
    expect((ch as unknown as Record<string, unknown>).credentials_enc).toBeUndefined();

    // Phase 4 raw-column proof of encryption-at-rest:
    //   1. The DB column is NEVER the plaintext.
    //   2. The stored value parses as a base64-of-JSON envelope `{v:1,…}`.
    //   3. `loadChannelCredentials` decrypts it back to the original.
    const rows = await directSql<{ credentials_enc: string | null }[]>`
      SELECT credentials_enc FROM channels WHERE id = ${ch.id}
    `;
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.credentials_enc;
    expect(stored).not.toBe('super-secret-token');
    expect(stored).not.toBeNull();
    const decoded = Buffer.from(stored!, 'base64').toString('utf8');
    const env = JSON.parse(decoded) as { v: number; iv: string; ct: string };
    expect(env.v).toBe(1);
    expect(typeof env.iv).toBe('string');
    expect(env.iv.length).toBeGreaterThan(0);
    expect(typeof env.ct).toBe('string');
    expect(env.ct.length).toBeGreaterThan(0);
    // Plaintext must not appear anywhere in the stored value.
    expect(stored).not.toMatch(/super-secret-token/);

    // Decrypt round-trip via the explicit opt-in helper.
    const plain = await svc.loadChannelCredentials(ch.id);
    expect(plain).toBe('super-secret-token');
  });

  test('createChannel — department-scoped row carries dept_id', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      dept_id: DEPT_ID,
      kind: 'teams',
      name: 'eng-standup',
    });
    expect(ch.dept_id).toBe(DEPT_ID);
  });

  test('createChannel — duplicate (workspace_id, name) rejects', async () => {
    await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'email',
      name: 'shared-inbox',
    });
    // Drizzle wraps the underlying postgres error; match on the message
    // text from either layer (the inner `cause` carries the canonical
    // 23505 unique-violation phrasing, but assertion against the outer
    // message + a manual cause check keeps this resilient to driver
    // formatting changes).
    let caught: unknown;
    try {
      await svc.createChannel({
        workspace_id: WS_ID,
        kind: 'email',
        name: 'shared-inbox',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const msg = String((caught as { message?: string } | undefined)?.message ?? '');
    const causeMsg = String(
      (caught as { cause?: { message?: string } } | undefined)?.cause?.message ?? '',
    );
    expect(`${msg} ${causeMsg}`).toMatch(/(unique|duplicate|23505)/i);
  });

  test('listChannels — sorted by name, archived hidden, credentials redacted', async () => {
    await svc.createChannel({ workspace_id: WS_ID, kind: 'web', name: 'zebra' });
    await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'inapp',
      name: 'alpha',
      credentials: 'should-not-appear',
    });
    // Soft-archive a row directly — listChannels skips it.
    const archived = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'voice',
      name: 'old-line',
    });
    await directSql`
      UPDATE channels SET archived_at = now() WHERE id = ${archived.id}
    `;

    const list = await svc.listChannels(WS_ID);
    expect(list.map((c) => c.name)).toEqual(['alpha', 'zebra']);
    for (const c of list) {
      expect((c as unknown as Record<string, unknown>).credentials).toBeUndefined();
      expect((c as unknown as Record<string, unknown>).credentials_enc).toBeUndefined();
    }
  });

  test('listChannels — empty workspaceId returns []', async () => {
    expect(await svc.listChannels('')).toEqual([]);
  });

  test('createChannel — defaults origin_kind=tenant; read-shape exposes origin', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'email',
      name: 'default-origin',
    });
    expect(ch.origin_kind).toBe('tenant');
    expect(ch.origin_project_id).toBeNull();
    expect(ch.origin_workflow_run_id).toBeNull();
    expect(ch.created_by_user_id).toBeNull();
  });

  test('createChannel — persists workflow origin provenance', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'web',
      name: 'wf-origin',
      origin: {
        origin_kind: 'workflow',
        origin_project_id: null,
        origin_workflow_run_id: 'run-77',
        created_by_user_id: 'workflow:run-77',
      },
    });
    expect(ch.origin_kind).toBe('workflow');
    expect(ch.origin_workflow_run_id).toBe('run-77');
    expect(ch.created_by_user_id).toBe('workflow:run-77');

    const rows = await directSql<{ origin_kind: string; origin_workflow_run_id: string | null }[]>`
      SELECT origin_kind, origin_workflow_run_id FROM channels WHERE id = ${ch.id}
    `;
    expect(rows[0]!.origin_kind).toBe('workflow');
    expect(rows[0]!.origin_workflow_run_id).toBe('run-77');
  });

  test('listChannels — {origin} narrows by origin_kind', async () => {
    await svc.createChannel({ workspace_id: WS_ID, kind: 'email', name: 'human-ch' });
    await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'web',
      name: 'wf-ch',
      origin: { origin_kind: 'workflow', origin_workflow_run_id: 'r1' },
    });

    const wf = await svc.listChannels(WS_ID, { origin: 'workflow' });
    expect(wf.map((c) => c.name)).toEqual(['wf-ch']);

    const tenant = await svc.listChannels(WS_ID, { origin: 'tenant' });
    expect(tenant.map((c) => c.name)).toEqual(['human-ch']);

    // No filter → both.
    const all = await svc.listChannels(WS_ID);
    expect(all.map((c) => c.name)).toEqual(['human-ch', 'wf-ch']);
  });

  test('updateChannel — patches name + credentials, returns redacted row', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'teams',
      name: 'pager-v1',
      credentials: 'old',
    });
    const updated = await svc.updateChannel(ch.id, {
      name: 'pager-v2',
      credentials: 'new',
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('pager-v2');
    expect((updated as unknown as Record<string, unknown>).credentials).toBeUndefined();

    const rows = await directSql<{ credentials_enc: string | null }[]>`
      SELECT credentials_enc FROM channels WHERE id = ${ch.id}
    `;
    const stored = rows[0]!.credentials_enc;
    expect(stored).not.toBe('new');
    expect(stored).not.toBeNull();
    // Envelope shape preserved across update.
    const env = JSON.parse(Buffer.from(stored!, 'base64').toString('utf8')) as {
      v: number;
      iv: string;
      ct: string;
    };
    expect(env.v).toBe(1);
    // Decrypt round-trip.
    const plain = await svc.loadChannelCredentials(ch.id);
    expect(plain).toBe('new');
  });

  test('updateChannel — empty patch is a no-op that returns the row', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'web',
      name: 'webhook-1',
    });
    const got = await svc.updateChannel(ch.id, {});
    expect(got?.id).toBe(ch.id);
    expect(got?.name).toBe('webhook-1');
  });

  test('updateChannel — unknown id returns null', async () => {
    const got = await svc.updateChannel(
      '00000000-0000-4000-8000-000000000000',
      { name: 'x' },
    );
    expect(got).toBeNull();
  });

  test('updateChannel — dept_id can be cleared with explicit null', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      dept_id: DEPT_ID,
      kind: 'teams',
      name: 'detach-test',
    });
    const updated = await svc.updateChannel(ch.id, { dept_id: null });
    expect(updated?.dept_id).toBeNull();
  });

  test('deleteChannel — removes row and returns true; missing id returns false', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'email',
      name: 'kill-me',
    });
    expect(await svc.deleteChannel(ch.id)).toBe(true);
    expect(await svc.getChannel(ch.id)).toBeNull();
    expect(await svc.deleteChannel(ch.id)).toBe(false);
  });

  // ---- Defense-in-depth: optional workspace scope on the mutators -------
  // updateChannel/deleteChannel take an optional 4th/3rd `scopeWorkspaceId`
  // arg. When the route supplies the caller's workspace, the mutation WHERE is
  // scoped to it so a cross-tenant id can never be written/removed even if the
  // route's assertSameWorkspace gate is later dropped (mirrors #402). Calling
  // svcRaw directly to reach the param the test proxy doesn't forward.
  const WRONG_WS = '99999999-9999-4999-8999-999999999999';

  test('updateChannel — scoped to matching workspace still patches', async () => {
    const ch = await svc.createChannel({ workspace_id: WS_ID, kind: 'web', name: 'scope-upd-ok' });
    const scopedDb = drizzle(directSql, { schema });
    const updated = await svcRaw.updateChannel(ch.id, { name: 'scope-upd-ok-2' }, scopedDb, WS_ID);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('scope-upd-ok-2');
  });

  test('updateChannel — scoped to a foreign workspace is a no-op (null, row unchanged)', async () => {
    const ch = await svc.createChannel({ workspace_id: WS_ID, kind: 'web', name: 'scope-upd-block' });
    const scopedDb = drizzle(directSql, { schema });
    const updated = await svcRaw.updateChannel(ch.id, { name: 'hacked' }, scopedDb, WRONG_WS);
    expect(updated).toBeNull();
    const rows = await directSql<{ name: string }[]>`SELECT name FROM channels WHERE id = ${ch.id}`;
    expect(rows[0]?.name).toBe('scope-upd-block');
  });

  test('deleteChannel — scoped to matching workspace removes the row', async () => {
    const ch = await svc.createChannel({ workspace_id: WS_ID, kind: 'email', name: 'scope-del-ok' });
    const scopedDb = drizzle(directSql, { schema });
    expect(await svcRaw.deleteChannel(ch.id, scopedDb, WS_ID)).toBe(true);
    expect((await directSql`SELECT id FROM channels WHERE id = ${ch.id}`).length).toBe(0);
  });

  test('deleteChannel — scoped to a foreign workspace leaves the row (false)', async () => {
    const ch = await svc.createChannel({ workspace_id: WS_ID, kind: 'email', name: 'scope-del-block' });
    const scopedDb = drizzle(directSql, { schema });
    expect(await svcRaw.deleteChannel(ch.id, scopedDb, WRONG_WS)).toBe(false);
    expect((await directSql`SELECT id FROM channels WHERE id = ${ch.id}`).length).toBe(1);
  });

  // ---- Phase 4 — credential encryption at rest --------------------------

  test('loadChannelCredentials — null when row missing or credentials unset', async () => {
    expect(
      await svc.loadChannelCredentials('00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'web',
      name: 'no-creds',
    });
    expect(await svc.loadChannelCredentials(ch.id)).toBeNull();
  });

  test('loadChannelCredentials — decrypts legacy plaintext rows (passthrough)', async () => {
    // Simulate a pre-cutover row by inserting plaintext directly. The
    // service's write paths now always envelope-encrypt; this test
    // proves the read path still tolerates legacy data until the backfill
    // script runs.
    const id = '33333333-3333-4333-8333-333333333333';
    await directSql`
      INSERT INTO channels (id, workspace_id, kind, name, config, credentials_enc)
      VALUES (
        ${id}, ${WS_ID}, 'teams', 'legacy-row',
        '{}'::jsonb, ${'plaintext-from-before-cutover'}
      )
    `;
    const plain = await svc.loadChannelCredentials(id);
    expect(plain).toBe('plaintext-from-before-cutover');
  });

  test('updateChannel — clearing credentials with explicit null sets column to NULL', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'teams',
      name: 'clear-me',
      credentials: 'will-be-cleared',
    });
    await svc.updateChannel(ch.id, { credentials: null });
    const rows = await directSql<{ credentials_enc: string | null }[]>`
      SELECT credentials_enc FROM channels WHERE id = ${ch.id}
    `;
    expect(rows[0]!.credentials_enc).toBeNull();
    expect(await svc.loadChannelCredentials(ch.id)).toBeNull();
  });

  test('default reads still redact credentials_enc from public Channel shape', async () => {
    const ch = await svc.createChannel({
      workspace_id: WS_ID,
      kind: 'email',
      name: 'redaction-check',
      credentials: 'still-secret',
    });
    const got = await svc.getChannel(ch.id);
    expect((got as unknown as Record<string, unknown>).credentials).toBeUndefined();
    expect((got as unknown as Record<string, unknown>).credentials_enc).toBeUndefined();
  });
});
