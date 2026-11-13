// tests/integration/scripts/encrypt-credentials.integration.test.ts
//
// Phase 4 — backfill script integration test.
//
// Pre-populates a real Postgres with a mix of legacy-plaintext rows and
// already-encrypted envelope rows, then drives the same code path the
// `bun run scripts/encrypt-channel-credentials.ts` CLI invokes:
//   * legacy rows become envelope-shaped
//   * already-encrypted rows are unchanged (idempotent)
//   * a second run is a no-op
//
// Docker-gated against postgres:18 like
// `tests/unit/services/channels-registry.test.ts`.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://placeholder/placeholder';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { containerRemoveArgs, postgresRunArgs } from '../../helpers/test-postgres-container';
import path from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../../../src/db/migration-runner';
import { encryption } from '../../../src/services/encryption';
import { truncateForTests } from '../../helpers/destructive-hatch';

const CONTAINER_NAME = `fr-encrypt-creds-test-${process.pid}`;
const CONTAINER_NAME_PREFIX = 'fr-encrypt-creds-test-';
const TEST_PASSWORD = 'test';
const ENVELOPE_PREFIX = 'eyJ2Ijox';
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
      try { await sql.end({ timeout: 1 }); } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Timed out waiting for postgres on port ${TEST_PORT}`);
}

const DOCKER = dockerAvailable();
const DB_NAME = `encrypt_creds_test_${process.pid}`;
let testDbUrl = '';
let directSql: postgres.Sql;

const WS_ID = '11111111-1111-4111-8111-111111111111';

if (DOCKER) {
  const bail = () => { try { stopContainer(); } catch {} };
  process.once('SIGINT', bail);
  process.once('SIGTERM', bail);
  process.once('exit', bail);
}

beforeAll(async () => {
  if (!DOCKER) {
    console.warn('[encrypt-credentials.test] docker unavailable — skipping');
    return;
  }
  const started = startContainer();
  if (!started.ok) {
    console.warn(`[encrypt-credentials.test] docker run failed: ${started.reason}`);
    return;
  }
  await waitForPg();

  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`); }
  finally { await admin.end({ timeout: 5 }); }
  testDbUrl = adminUrl(DB_NAME);

  const push = spawnSync(
    'bunx', ['drizzle-kit', 'push'],
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
  await directSql`
    INSERT INTO workspaces (id, name) VALUES (${WS_ID}, 'Test Workspace')
  `;
  await encryption.initialize();
}, 180_000);

afterAll(async () => {
  try { if (directSql) await directSql.end({ timeout: 5 }); } catch {}
  stopContainer();
});

const d = DOCKER ? describe : describe.skip;

// Run the same logic as scripts/encrypt-channel-credentials.ts directly
// against the test db. We replicate the loop here (rather than spawning
// `bun run scripts/...` as a subprocess) so we can reuse the same
// `directSql` connection + assert intermediate state. The script file
// itself is exercised end-to-end manually before deployment per
// memory `feedback-credentials-connectivity.md`.
async function runBackfill(sql: postgres.Sql): Promise<{ encrypted: number; skipped: number }> {
  const BATCH = 100;
  let encrypted = 0;
  let skipped = 0;
  while (true) {
    const rows = await sql<{ id: string; credentials_enc: string }[]>`
      SELECT id, credentials_enc
      FROM channels
      WHERE credentials_enc IS NOT NULL
        AND credentials_enc NOT LIKE ${ENVELOPE_PREFIX + '%'}
      ORDER BY id
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.credentials_enc.startsWith(ENVELOPE_PREFIX)) { skipped += 1; continue; }
      const env = await encryption.encryptToEnvelope(row.credentials_enc);
      await sql`
        UPDATE channels
        SET credentials_enc = ${env}
        WHERE id = ${row.id}
          AND credentials_enc = ${row.credentials_enc}
      `;
      encrypted += 1;
    }
  }
  return { encrypted, skipped };
}

d('encrypt-channel-credentials backfill', () => {
  test('encrypts legacy rows; leaves already-encrypted rows untouched; idempotent', async () => {
    // Wipe channels (other suites may have left rows).
    // migration 142 refuses TRUNCATE on `channels` at any row count.
    await truncateForTests(directSql, 'channels');

    // Seed 5 legacy plaintext rows + 2 already-encrypted rows.
    const legacyValues = [
      'creds-A',
      'creds-B',
      'creds-C',
      'creds-D',
      'creds-E',
    ];
    for (let i = 0; i < legacyValues.length; i++) {
      await directSql`
        INSERT INTO channels (workspace_id, kind, name, config, credentials_enc)
        VALUES (
          ${WS_ID}, 'teams', ${`legacy-${i}`}, '{}'::jsonb, ${legacyValues[i]!}
        )
      `;
    }
    const preEncryptedA = await encryption.encryptToEnvelope('already-A');
    const preEncryptedB = await encryption.encryptToEnvelope('already-B');
    await directSql`
      INSERT INTO channels (workspace_id, kind, name, config, credentials_enc)
      VALUES (${WS_ID}, 'email', 'pre-A', '{}'::jsonb, ${preEncryptedA})
    `;
    await directSql`
      INSERT INTO channels (workspace_id, kind, name, config, credentials_enc)
      VALUES (${WS_ID}, 'email', 'pre-B', '{}'::jsonb, ${preEncryptedB})
    `;

    // Snapshot the pre-encrypted blobs so we can prove idempotency.
    const preBlobs = await directSql<{ name: string; credentials_enc: string }[]>`
      SELECT name, credentials_enc FROM channels
      WHERE name IN ('pre-A','pre-B')
      ORDER BY name
    `;
    expect(preBlobs).toHaveLength(2);

    // First run.
    const r1 = await runBackfill(directSql);
    expect(r1.encrypted).toBe(5);
    expect(r1.skipped).toBe(0);

    // All 7 rows now have envelope shape.
    const allRows = await directSql<{ name: string; credentials_enc: string }[]>`
      SELECT name, credentials_enc FROM channels ORDER BY name
    `;
    expect(allRows).toHaveLength(7);
    for (const r of allRows) {
      expect(r.credentials_enc.startsWith(ENVELOPE_PREFIX)).toBe(true);
      const env = JSON.parse(
        Buffer.from(r.credentials_enc, 'base64').toString('utf8'),
      ) as { v: number; iv: string; ct: string };
      expect(env.v).toBe(1);
    }

    // The two pre-encrypted blobs are byte-identical to before — backfill
    // didn't re-encrypt them.
    const postBlobs = await directSql<{ name: string; credentials_enc: string }[]>`
      SELECT name, credentials_enc FROM channels
      WHERE name IN ('pre-A','pre-B')
      ORDER BY name
    `;
    for (let i = 0; i < preBlobs.length; i++) {
      expect(postBlobs[i]!.credentials_enc).toBe(preBlobs[i]!.credentials_enc);
    }

    // Decrypt round-trip: legacy values decrypt to their original
    // plaintext via the envelope helper.
    const legacyRow = allRows.find((r) => r.name === 'legacy-0')!;
    const decrypted = await encryption.decryptFromEnvelope(legacyRow.credentials_enc);
    expect(decrypted).toBe('creds-A');

    // Second run is a no-op.
    const r2 = await runBackfill(directSql);
    expect(r2.encrypted).toBe(0);
    expect(r2.skipped).toBe(0);
  }, 60_000);
});
