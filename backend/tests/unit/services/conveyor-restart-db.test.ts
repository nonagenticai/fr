// tests/unit/services/conveyor-restart-db.test.ts
//
// George 2026-10-31 — "Start again" as a PROJECT / PHASE restart, against the real CI postgres:
//   * voidOpenConveyorAsks voids every OPEN conveyor ask (source 'n8n', pending) and every open
//     web request on a CARD of THIS project in THIS tenant, records why, and leaves every other
//     row (a web approval on no card, a decided one, another project's, another tenant's) alone;
//   * beginRestartAttempt refuses what is not offered (phase unknown / not at or before the current one, not active,
//     delivered, on hold, not configured) and otherwise records `<fr id>:restart-<n>` in the start
//     numbering; the project row lock serialises two restarts (the second is start_in_flight).
//
// DB-backed + skip-if-unreachable (fail-loud when DATABASE_URL / CI is set).
import { afterAll, beforeAll, describe, expect } from 'bun:test';

import { approvalDecisions, approvals, db, projectConveyorStartAttempts, projects, queryClient } from '../../../src/db/client';
import {
  beginRestartAttempt,
  phaseStartSignoffComments,
  voidOpenConveyorAsks,
  withdrawAsksForRestart,
} from '../../../src/services/conveyor-failures';
import { AppError } from '../../../src/utils/errors';
import { createDbSuite, dbReachable } from '../../integration/helpers/db-suite';

const sql = queryClient;
const TENANT = 'f3100000-0000-4000-8000-00000000000a';
const OTHER_TENANT = 'f3100000-0000-4000-8000-00000000000b';
const OWNER = 'f3200000-0000-4000-8000-000000000001';
const ACTIVE = 'f3300000-0000-4000-8000-0000000000a1';
const ARCHIVED = 'f3300000-0000-4000-8000-0000000000a2';
const OTHER_PROJECT = 'f3300000-0000-4000-8000-0000000000a3';
const HELD = 'f3300000-0000-4000-8000-0000000000a4'; // active, its cord engaged
const RACE = 'f3300000-0000-4000-8000-0000000000a5'; // active, no attempt yet
const VOIDFAIL = 'f3300000-0000-4000-8000-0000000000a6'; // active, for the void step
const A = {
  askCard: 'f3400000-0000-4000-8000-000000000001', // pending, n8n, card gate ⇒ voided
  askProject: 'f3400000-0000-4000-8000-000000000002', // pending, n8n, no card ⇒ voided
  web: 'f3400000-0000-4000-8000-000000000003', // pending, web, no card (a person's request) ⇒ kept
  webCard: 'f3400000-0000-4000-8000-000000000007', // pending, web, on a card (a board-move request) ⇒ voided
  decided: 'f3400000-0000-4000-8000-000000000004', // approved, n8n ⇒ kept
  otherProject: 'f3400000-0000-4000-8000-000000000005', // pending, n8n, another project ⇒ kept
  otherTenant: 'f3400000-0000-4000-8000-000000000006', // pending, n8n, this project id but another tenant ⇒ kept
  // R349 — phase-start sign-offs on RACE (phaseStartSignoffComments)
  preOld: 'f3400000-0000-4000-8000-000000000011', // approved signoff, preliminary, older ⇒ superseded
  preNew: 'f3400000-0000-4000-8000-000000000012', // rejected signoff, preliminary, newer ⇒ its comment
  exeVoided: 'f3400000-0000-4000-8000-000000000013', // voided signoff, execution ⇒ not decided
  exeOtherType: 'f3400000-0000-4000-8000-000000000014', // approved signoff, another card type ⇒ ignored
  exeQuestion: 'f3400000-0000-4000-8000-000000000015', // approved QUESTION on the phase-start card ⇒ ignored
};
const ALL_PROJECTS = [ACTIVE, ARCHIVED, OTHER_PROJECT, HELD, RACE, VOIDFAIL];

async function cleanup(): Promise<void> {
  await sql`DELETE FROM approvals WHERE id IN ${sql(Object.values(A))}`;
  await sql`DELETE FROM project_conveyor_start_attempts WHERE project_id IN ${sql(ALL_PROJECTS)}`;
  await sql`DELETE FROM projects WHERE id IN ${sql(ALL_PROJECTS)}`;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  const project = (id: string, status: string) => ({
    id,
    owner_id: OWNER,
    name: `restart-${id.slice(-2)}`,
    dept_id: null,
    status,
    project_data: { keycloak_tenant_id: TENANT },
  });
  await db.insert(projects).values([
    project(ACTIVE, 'active'),
    project(ARCHIVED, 'archived'),
    project(OTHER_PROJECT, 'active'),
    { ...project(HELD, 'active'), andon_engaged: true, andon_engaged_at: new Date(), andon_engaged_by: OWNER },
    project(RACE, 'active'),
    project(VOIDFAIL, 'active'),
  ]);
  const ask = (id: string, over: Record<string, unknown>) => ({
    id,
    tenant_id: TENANT,
    project_id: ACTIVE,
    description: 'restart test ask',
    source: 'n8n',
    status: 'pending',
    ...over,
  });
  await db.insert(approvals).values([
    ask(A.askCard, { card_id: 'card-restart-1' }),
    ask(A.askProject, {}),
    ask(A.web, { source: 'web' }),
    ask(A.webCard, { source: 'web', card_id: 'card-restart-2' }),
    ask(A.decided, { status: 'approved' }),
    ask(A.otherProject, { project_id: OTHER_PROJECT }),
    ask(A.otherTenant, { tenant_id: OTHER_TENANT }),
  ] as Array<typeof approvals.$inferInsert>);
  const signoff = (id: string, card: string, status: string, cardType = 'project_phase_start', askKind = 'signoff') =>
    ask(id, { project_id: RACE, card_id: card, status, metadata: { card_type: cardType, ask_kind: askKind } });
  await db.insert(approvals).values([
    signoff(A.preOld, 'card-pre-1', 'approved'),
    signoff(A.preNew, 'card-pre-2', 'rejected'),
    signoff(A.exeVoided, 'card-exe-1', 'voided'),
    signoff(A.exeOtherType, 'card-exe-1', 'approved', 'rewrite_slice'),
    signoff(A.exeQuestion, 'card-exe-1', 'approved', 'project_phase_start', 'question'),
  ] as Array<typeof approvals.$inferInsert>);
  const decided = (approvalId: string, at: string, comment: string) => ({
    approval_id: approvalId,
    approver_id: OWNER,
    decision: 'approved',
    comment,
    decided_at: new Date(at),
  });
  await db.insert(approvalDecisions).values([
    decided(A.preOld, '2026-11-01T10:00:00Z', 'old preliminary steer'),
    decided(A.preNew, '2026-11-02T10:00:00Z', '  newer preliminary steer  '),
    decided(A.exeVoided, '2026-11-03T10:00:00Z', 'voided'),
    decided(A.exeOtherType, '2026-11-03T10:00:00Z', 'not a phase start'),
    decided(A.exeQuestion, '2026-11-03T10:00:00Z', 'a question answer'),
  ]);
  // One earlier delivered start (attempt 0, the bare key).
  await db.insert(projectConveyorStartAttempts).values({
    project_id: ACTIVE,
    tenant_id: TENANT,
    attempt_n: 0,
    idempotency_key: ACTIVE,
    outcome: 'delivered',
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

const { itDb } = createDbSuite('conveyor-restart-db');

/**
 * Run `body` (an async function body; `beginRestartAttempt`, `withdrawAsksForRestart`, `base` and
 * `settle` in scope) in a FRESH child `bun` with `env` over this process's env, and return what it
 * returns. A fresh process is how a test controls `config` (read once at import).
 */
async function inChild(env: Record<string, string>, body: string): Promise<unknown> {
  const mod = `${import.meta.dir}/../../../src/services/conveyor-failures.ts`;
  const code = `
    const { beginRestartAttempt, withdrawAsksForRestart } = await import(${JSON.stringify(mod)});
    const base = { tenantId: ${JSON.stringify(TENANT)}, requestedBy: ${JSON.stringify(OWNER)}, delivered: false };
    const settle = async (p) => { try { return { ok: await p }; } catch (e) { return { code: e.code, reason: e.details?.reason }; } };
    const out = await (async () => { ${body} })();
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);
  `;
  const child = Bun.spawn({
    cmd: ['bun', '-e', code],
    cwd: `${import.meta.dir}/../../..`,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  if (exit !== 0 || !line) throw new Error(`child failed (exit ${exit}): ${err.slice(-2000)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code?: string; details?: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return { status: err.statusCode, code: err.code, details: err.details };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('voidOpenConveyorAsks', () => {
  itDb("voids the project's open conveyor asks and card requests only, with the recorded reason and actor", async () => {
    const out = await voidOpenConveyorAsks({
      projectId: ACTIVE,
      tenantId: TENANT,
      actor: OWNER,
      reason: 'project restarted (project, attempt 1): test',
    });
    expect(out).toEqual({ pending: 3, voided: 3 });
    const rows = await sql<Array<{ id: string; status: string; voided_reason: string | null; voided_by: string | null }>>`
      SELECT id, status, voided_reason, voided_by FROM approvals WHERE id IN ${sql(Object.values(A))}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [A.askCard, A.askProject, A.webCard]) {
      expect(byId.get(id)).toMatchObject({ status: 'voided', voided_reason: 'project restarted (project, attempt 1): test', voided_by: OWNER });
    }
    expect(byId.get(A.web)?.status).toBe('pending');
    expect(byId.get(A.decided)?.status).toBe('approved');
    expect(byId.get(A.otherProject)?.status).toBe('pending');
    expect(byId.get(A.otherTenant)?.status).toBe('pending');
    // Nothing left to void: a second restart voids nothing.
    expect(await voidOpenConveyorAsks({ projectId: ACTIVE, tenantId: TENANT, actor: OWNER, reason: 'project restarted again' })).toEqual({
      pending: 0,
      voided: 0,
    });
  });
});

describe('beginRestartAttempt', () => {
  const base = { projectId: ACTIVE, tenantId: TENANT, requestedBy: OWNER, delivered: false };

  itDb('a phase restart needs the RM phase, and names a phase at or before it (R349)', async () => {
    expect(await refusal(beginRestartAttempt({ ...base, scope: 'phase', rmPhase: null }))).toMatchObject({
      status: 409,
      code: 'restart_phase_unknown',
    });
    expect(
      await refusal(
        beginRestartAttempt({ ...base, scope: 'phase', rmPhase: 'preliminary', phase: 'execution', selectable: ['setup', 'preliminary'] }),
      ),
    ).toMatchObject({ status: 409, code: 'restart_phase_invalid', details: { phase: 'preliminary', allowed: ['setup', 'preliminary'] } });
    // A phase restart without a phase is refused the same way.
    expect(
      await refusal(beginRestartAttempt({ ...base, scope: 'phase', rmPhase: 'preliminary', selectable: ['setup', 'preliminary'] })),
    ).toMatchObject({ status: 409, code: 'restart_phase_invalid' });
  });

  itDb('refused for an archived project (not_active) and a delivered one', async () => {
    expect(await refusal(beginRestartAttempt({ ...base, projectId: ARCHIVED, scope: 'project', rmPhase: 'setup' }))).toMatchObject({
      status: 409,
      code: 'conveyor_restart_not_offered',
      details: { reason: 'not_active' },
    });
    expect(await refusal(beginRestartAttempt({ ...base, delivered: true, scope: 'project', rmPhase: 'setup' }))).toMatchObject({
      status: 409,
      code: 'conveyor_restart_not_offered',
      details: { reason: 'delivered' },
    });
  });

  itDb('refused while the project is on hold (its cord), as the start retry is — the hold comes first', async () => {
    expect(await refusal(beginRestartAttempt({ ...base, projectId: HELD, scope: 'project', rmPhase: 'setup' }))).toMatchObject({
      status: 409,
      code: 'conveyor_restart_not_offered',
      details: { reason: 'on_hold' },
    });
  });

  // `config` is read once per process, so each webhook setting runs in its own fresh child `bun`
  // (beginRestartAttempt sends nothing either way: it only records under the lock).
  itDb('no conveyor webhook configured: an active project is refused conveyor_not_configured', async () => {
    const r = await inChild(
      { CONVEYOR_START_WEBHOOK_URL: '' },
      `return await settle(beginRestartAttempt({ ...base, projectId: ${JSON.stringify(RACE)}, scope: 'project', rmPhase: 'setup' }));`,
    );
    expect(r).toEqual({ code: 'conveyor_restart_not_offered', reason: 'conveyor_not_configured' });
  }, 60_000);

  itDb('configured: records <fr id>:restart-<n> after the existing attempts; a second restart and a concurrent pair meet the row lock', async () => {
    const r = (await inChild(
      { CONVEYOR_START_WEBHOOK_URL: 'http://conveyor.test/webhook' },
      `const first = await settle(beginRestartAttempt({ ...base, projectId: ${JSON.stringify(ACTIVE)}, scope: 'phase', rmPhase: 'execution', phase: 'preliminary', selectable: ['preliminary', 'execution'] }));
       const second = await settle(beginRestartAttempt({ ...base, projectId: ${JSON.stringify(ACTIVE)}, scope: 'project', rmPhase: 'execution' }));
       const pair = await Promise.all([1, 2].map(() => settle(beginRestartAttempt({ ...base, projectId: ${JSON.stringify(RACE)}, scope: 'project', rmPhase: 'setup' }))));
       return { first, second, pair };`,
    )) as { first: { ok: unknown }; second: unknown; pair: Array<{ ok?: Record<string, unknown>; code?: string; reason?: string }> };
    expect(r.first.ok).toMatchObject({ attempt_n: 1, idempotency_key: `${ACTIVE}:restart-1`, scope: 'phase', phase: 'preliminary' });
    // The recorded attempt is pending: a second restart right now is refused (start_in_flight).
    expect(r.second).toEqual({ code: 'conveyor_restart_not_offered', reason: 'start_in_flight' });
    // Two at once on a fresh project: the row lock lets exactly one through; the other sees its pending attempt.
    const won = r.pair.filter((x: { ok?: unknown }) => x.ok);
    expect(won).toHaveLength(1);
    expect(won[0]?.ok).toMatchObject({ attempt_n: 1, idempotency_key: `${RACE}:restart-1` });
    expect(r.pair.find((x: { ok?: unknown }) => !x.ok)).toEqual({ code: 'conveyor_restart_not_offered', reason: 'start_in_flight' });
    const rows = await sql<Array<{ idempotency_key: string; outcome: string }>>`
      SELECT idempotency_key, outcome FROM project_conveyor_start_attempts WHERE project_id = ${RACE}`;
    expect([...rows].map((x) => ({ idempotency_key: x.idempotency_key, outcome: x.outcome }))).toEqual([
      { idempotency_key: `${RACE}:restart-1`, outcome: 'pending' },
    ]);
  }, 60_000);
});

describe('phaseStartSignoffComments (R349: the restart comment prefill)', () => {
  itDb("per phase, the latest DECIDED phase-start sign-off's comment, phased by its card", async () => {
    const cardPhases = new Map([
      ['card-pre-1', 'preliminary'],
      ['card-pre-2', 'preliminary'],
      ['card-exe-1', 'execution'],
    ]);
    const got = await phaseStartSignoffComments({ projectId: RACE, tenantId: TENANT, cardPhases });
    // execution: a voided sign-off, another card type and a question are none of them a decided phase-start sign-off.
    expect(Object.fromEntries(got)).toEqual({ preliminary: 'newer preliminary steer' });
    // Another tenant reads nothing; a card with no phase field places nothing.
    expect((await phaseStartSignoffComments({ projectId: RACE, tenantId: OTHER_TENANT, cardPhases })).size).toBe(0);
    expect((await phaseStartSignoffComments({ projectId: RACE, tenantId: TENANT, cardPhases: new Map() })).size).toBe(0);
  });
});

describe('withdrawAsksForRestart (the route\'s restart void step)', () => {
  itDb('a failed void marks the attempt failed with why and throws, so the restart is not sent', async () => {
    const [row] = await db
      .insert(projectConveyorStartAttempts)
      .values({ project_id: VOIDFAIL, tenant_id: TENANT, attempt_n: 1, idempotency_key: `${VOIDFAIL}:restart-1` })
      .returning();
    const attempt = { id: row!.id, attempt_n: 1, idempotency_key: row!.idempotency_key, scope: 'project' as const, phase: null };
    // A real Postgres failure inside the void: the approvals select is bound to a tenant that is not a uuid.
    await expect(withdrawAsksForRestart({ attempt, projectId: VOIDFAIL, tenantId: 'not-a-uuid', actor: OWNER })).rejects.toThrow();
    const [after] = await sql<Array<{ outcome: string; outcome_detail: string | null; completed_at: Date | null }>>`
      SELECT outcome, outcome_detail, completed_at FROM project_conveyor_start_attempts WHERE id = ${row!.id}`;
    expect(after?.outcome).toBe('failed');
    expect(after?.outcome_detail).toStartWith('open asks could not be voided, restart not sent: ');
    expect(after?.completed_at).not.toBeNull();
  });

  itDb('a successful void leaves the attempt pending (the route then sends it)', async () => {
    const [row] = await db
      .insert(projectConveyorStartAttempts)
      .values({ project_id: VOIDFAIL, tenant_id: TENANT, attempt_n: 2, idempotency_key: `${VOIDFAIL}:restart-2` })
      .returning();
    const attempt = { id: row!.id, attempt_n: 2, idempotency_key: row!.idempotency_key, scope: 'project' as const, phase: null };
    expect(await withdrawAsksForRestart({ attempt, projectId: VOIDFAIL, tenantId: TENANT, actor: OWNER })).toEqual({ pending: 0, voided: 0 });
    const [after] = await sql<Array<{ outcome: string }>>`SELECT outcome FROM project_conveyor_start_attempts WHERE id = ${row!.id}`;
    expect(after?.outcome).toBe('pending');
  });
});
