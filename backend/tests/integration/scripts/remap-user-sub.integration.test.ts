// tests/integration/scripts/remap-user-sub.integration.test.ts
//
// scripts/remap-user-sub.ts against a REAL Postgres (schema = drizzle push + migrations, as CI builds it):
//  * every person-shaped column in the live schema is classified — a NEW sub-bearing column added to
//    schema.ts or a migration without being listed in the script FAILS this file;
//  * dry run counts per column and writes nothing; --apply re-keys every SUB_COLUMNS row (plain, tagged
//    `human:<sub>`, uuid[]), leaves the append-only ledger alone, and a re-run is "already remapped";
//  * a pre-existing --to refuses, and --resolve-preexisting removes only a same-email post-move stub.

import { afterEach, describe, expect } from 'bun:test';

import { queryClient } from '../../../src/db/client';
import {
  CANDIDATE_NAME_RE,
  LEDGER_COLUMNS,
  NOT_SUB_COLUMNS,
  RemapRefused,
  STUB_TABLES,
  SUB_COLUMNS,
  applyRemap,
  parseArgs,
  planRemap,
  report,
  unclassifiedColumns,
} from '../../../scripts/remap-user-sub';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('remap-user-sub');

// Literal subs unique to this file, so cleanup touches nothing else.
const FROM = '0195f48b-1188-7000-8000-00000ee00001';
const TO = '0195f48b-1188-7000-8000-00000ee00002';
const OTHER = '0195f48b-1188-7000-8000-00000ee00003';
const TENANT = '0195f48b-1188-7000-8000-00000ee0000a';
const PROJECT = '0195f48b-1188-7000-8000-00000ee0000b';
const STREAM = '0195f48b-1188-7000-8000-00000ee0000c';
const CARD = 'remap-user-sub-ledger-card';
// super_admin_tenant_actions is APPEND-ONLY too (migration 215): one row, keyed by this correlation id.
const AUDIT_CID = 'remap-user-sub-ledger-audit';
const SUBS = [FROM, TO, OTHER];

afterEach(async () => {
  await queryClient`DELETE FROM priority_change_events WHERE project_id = ${PROJECT}::uuid`;
  await queryClient`DELETE FROM projects WHERE id = ${PROJECT}::uuid`;
  for (const t of ['user_roles', 'notification_prefs', 'user_channel_prefs', 'notifications']) {
    await queryClient.unsafe(`DELETE FROM ${t} WHERE user_id = ANY($1::text[])`, [SUBS]);
  }
  await queryClient`DELETE FROM streams WHERE id = ${STREAM}::uuid`;
  await queryClient`DELETE FROM signup_approvals WHERE tenant_slug LIKE 'remap-user-sub-%'`;
});

async function seed(): Promise<void> {
  await queryClient`
    INSERT INTO projects (id, owner_id, name, repository_url, status, project_data)
    VALUES (${PROJECT}::uuid, ${FROM}::uuid, 'remap', '', 'active', ${JSON.stringify({ created_by: FROM })}::jsonb)`;
  await queryClient`INSERT INTO user_roles (user_id, tenant_id, role, granted_by) VALUES (${FROM}, ${TENANT}::uuid, 'workspace-member', ${OTHER})`;
  await queryClient`INSERT INTO user_roles (user_id, tenant_id, role, granted_by) VALUES (${OTHER}, ${TENANT}::uuid, 'workspace-member', ${FROM})`;
  await queryClient`
    INSERT INTO priority_change_events (tenant_id, project_id, from_priority, to_priority, actor_id, actor_kind, priority_set_by)
    VALUES (${TENANT}::uuid, ${PROJECT}::uuid, NULL, 'P1', ${FROM}, 'user', ${`human:${FROM}`})`;
  await queryClient`
    INSERT INTO streams (id, tenant_id, kind, name, slug, planka_project_id, planka_board_id)
    VALUES (${STREAM}::uuid, ${TENANT}::uuid, 'decision', 'remap', 'remap-user-sub', 'p', 'b')`;
}

async function seedLedger(): Promise<void> {
  // card_done_overrides is APPEND-ONLY (cannot be cleaned up): one row, keyed by a card id unique to this file.
  const [r] = await queryClient`SELECT count(*)::int AS n FROM card_done_overrides WHERE card_id = ${CARD}`;
  if (r!.n === 0) {
    await queryClient`
      INSERT INTO card_done_overrides (card_id, board_id, card_type, actor_id, reason)
      VALUES (${CARD}, 'remap-board', 'task', ${FROM}, 'remap-user-sub test')`;
  }
  const [a] = await queryClient`SELECT count(*)::int AS n FROM super_admin_tenant_actions WHERE correlation_id = ${AUDIT_CID}`;
  if (a!.n === 0) {
    await queryClient`
      INSERT INTO super_admin_tenant_actions (actor_user_id, tenant_id, home_tenant_id, method, route, status, correlation_id)
      VALUES (${FROM}, ${TENANT}::uuid, ${OTHER}, 'POST', '/api/x', 201, ${AUDIT_CID})`;
  }
}

const count = (rows: { table: string; column: string; rows: number }[], k: string): number =>
  rows.find((c) => `${c.table}.${c.column}` === k)?.rows ?? -1;

describe('remap-user-sub: column classification', () => {
  itDb('every person-shaped column in the live schema is listed (a new sub column fails here)', async () => {
    const missing = await queryClient.begin('read only', (tx) => unclassifiedColumns(tx));
    expect(missing).toEqual([]);
  });

  itDb('every listed column exists, the lists are disjoint, and NOT_SUB entries still match the name filter', async () => {
    const cols = await queryClient<{ k: string }[]>`
      SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public'`;
    const live = new Set(cols.map((c) => c.k));
    const sub = SUB_COLUMNS.map((c) => `${c.table}.${c.column}`);
    const ledger = LEDGER_COLUMNS.map((c) => `${c.table}.${c.column}`);
    const not = Object.keys(NOT_SUB_COLUMNS);
    for (const k of [...sub, ...ledger, ...not]) expect(live.has(k) ? k : `MISSING ${k}`).toBe(k);
    const all = [...sub, ...ledger, ...not];
    expect(new Set(all).size).toBe(all.length);
    const re = new RegExp(CANDIDATE_NAME_RE);
    for (const k of not) expect(re.test(k.split('.')[1]!) ? k : `NOT A CANDIDATE ${k}`).toBe(k);
    for (const s of STUB_TABLES) expect(sub).toContain(`${s.table}.${s.column}`);
    // 60 until 2026-11-03, when kaizen_candidates.user_id left with its table (migration 230).
    expect(sub.length).toBeGreaterThanOrEqual(59);
  });
});

describe('remap-user-sub: parseArgs', () => {
  itDb('validates subs, email and --moved-after', async () => {
    expect(() => parseArgs(['--from', 'x', '--to', TO])).toThrow(RemapRefused);
    expect(() => parseArgs(['--from', FROM, '--to', FROM])).toThrow(/same/);
    expect(() => parseArgs(['--from', FROM, '--to', TO, '--moved-after', 'nope'])).toThrow(/moved-after/);
    expect(() => parseArgs(['--from', FROM, '--to', TO, '--email', 'nope'])).toThrow(/email/);
    const a = parseArgs(['--from', FROM.toUpperCase(), '--to', TO, '--apply', '--resolve-preexisting', '--email', 'A@B.io']);
    expect(a).toMatchObject({ from: FROM, to: TO, apply: true, resolvePreexisting: true, email: 'a@b.io', movedAfter: null });
  });
});

describe('remap-user-sub: dry run + apply', () => {
  itDb('dry run counts per column and writes NOTHING', async () => {
    await seed();
    await seedLedger();
    const plan = await planRemap(queryClient, FROM, TO);
    expect(plan.state).toBe('ready');
    expect(count(plan.columns, 'projects.owner_id')).toBe(1);
    expect(count(plan.columns, 'user_roles.user_id')).toBe(1);
    expect(count(plan.columns, 'user_roles.granted_by')).toBe(1);
    expect(count(plan.columns, 'priority_change_events.actor_id')).toBe(1);
    expect(count(plan.columns, 'priority_change_events.priority_set_by')).toBe(1);
    expect(count(plan.columns, 'card_done_overrides.actor_id')).toBe(1);
    expect(count(plan.columns, 'super_admin_tenant_actions.actor_user_id')).toBe(1);
    expect(plan.total).toBe(5);
    expect(plan.ledgerRows).toBe(2);
    expect(plan.json.find((j) => j.table === 'projects' && j.column === 'project_data')?.rows).toBe(1);
    expect(report(FROM, TO, plan, false).at(-1)).toContain('DRY RUN');
    const [o] = await queryClient`SELECT owner_id::text AS o FROM projects WHERE id = ${PROJECT}::uuid`;
    expect(o!.o).toBe(FROM);
  });

  itDb('--apply re-keys plain and tagged columns; ledger kept; re-run is already_remapped', async () => {
    await seed();
    await seedLedger();
    const plan = await applyRemap(queryClient, FROM, TO);
    expect(plan.state).toBe('ready');
    const [p] = await queryClient`SELECT owner_id::text AS o FROM projects WHERE id = ${PROJECT}::uuid`;
    expect(p!.o).toBe(TO);
    const roles = await queryClient`SELECT user_id, granted_by FROM user_roles WHERE tenant_id = ${TENANT}::uuid ORDER BY user_id`;
    expect(roles.map((r) => `${r.user_id}<-${r.granted_by}`).sort()).toEqual([`${OTHER}<-${TO}`, `${TO}<-${OTHER}`].sort());
    const [ev] = await queryClient`SELECT actor_id, priority_set_by FROM priority_change_events WHERE project_id = ${PROJECT}::uuid`;
    expect(ev).toMatchObject({ actor_id: TO, priority_set_by: `human:${TO}` });
    const [l] = await queryClient`SELECT actor_id FROM card_done_overrides WHERE card_id = ${CARD}`;
    expect(l!.actor_id).toBe(FROM);
    // A super_admin with tenant-audit rows remaps cleanly: the append-only audit (UPDATE refused by
    // trigger) is reported, never rewritten — it records who acted at the time.
    const [au] = await queryClient`SELECT actor_user_id FROM super_admin_tenant_actions WHERE correlation_id = ${AUDIT_CID}`;
    expect(au!.actor_user_id).toBe(FROM);
    const again = await applyRemap(queryClient, FROM, TO);
    expect(again.state).toBe('already_remapped');
    expect(report(FROM, TO, again, true)[0]).toContain('already remapped');
  });

  itDb('a --from nobody references is refused', async () => {
    await expect(planRemap(queryClient, OTHER, TO)).rejects.toThrow(/nothing in fr references/);
  });
});

describe('remap-user-sub: pre-existing --to', () => {
  const seedStub = async (opts: { email?: string; oldRow?: boolean } = {}) => {
    await seed();
    await queryClient`
      INSERT INTO signup_approvals (email, name, source, tenant_name, tenant_slug, status, kc_user_id)
      VALUES ('Ola@Example.org', 'Ola', 'web', 'remap', 'remap-user-sub-from', 'approved', ${FROM}::uuid)`;
    await queryClient`
      INSERT INTO user_channel_prefs (user_id, channel, address) VALUES (${TO}, 'email', ${opts.email ?? 'ola@example.org'})`;
    await queryClient`
      INSERT INTO notification_prefs (user_id, channel, event_type, enabled, created_at)
      VALUES (${TO}, 'email', 'approval', true, ${(opts.oldRow ? new Date(Date.now() - 3 * 86_400_000) : new Date()).toISOString()}::timestamptz)`;
  };

  itDb('refused without --resolve-preexisting; nothing written', async () => {
    await seedStub();
    await expect(applyRemap(queryClient, FROM, TO)).rejects.toThrow(/already referenced/);
    const [p] = await queryClient`SELECT owner_id::text AS o FROM projects WHERE id = ${PROJECT}::uuid`;
    expect(p!.o).toBe(FROM);
  });

  itDb('--resolve-preexisting + same email: stub deleted, then re-keyed, in one transaction', async () => {
    await seedStub();
    const dry = await planRemap(queryClient, FROM, TO, { resolvePreexisting: true, email: 'OLA@example.org' });
    expect(dry.preexisting?.blockers).toEqual([]);
    expect(dry.preexisting?.stubRows.map((s) => s.table).sort()).toEqual(['notification_prefs', 'user_channel_prefs']);
    const plan = await applyRemap(queryClient, FROM, TO, { resolvePreexisting: true, email: 'ola@example.org' });
    expect(plan.state).toBe('ready');
    const [n] = await queryClient`SELECT count(*)::int AS n FROM notification_prefs WHERE user_id = ${TO}`;
    expect(n!.n).toBe(0);
    const [s] = await queryClient`SELECT kc_user_id::text AS k FROM signup_approvals WHERE tenant_slug = 'remap-user-sub-from'`;
    expect(s!.k).toBe(TO);
  });

  itDb('--resolve-preexisting refuses a different email, a pre-move row, a missing --email, a non-stub ref', async () => {
    await seedStub({ email: 'someone-else@example.org' });
    await expect(applyRemap(queryClient, FROM, TO, { resolvePreexisting: true, email: 'ola@example.org' })).rejects.toThrow(
      /DIFFERENT person/,
    );
    await expect(applyRemap(queryClient, FROM, TO, { resolvePreexisting: true })).rejects.toThrow(/--email/);
    await queryClient`UPDATE user_channel_prefs SET address = 'ola@example.org' WHERE user_id = ${TO}`;
    await queryClient`INSERT INTO user_roles (user_id, tenant_id, role) VALUES (${TO}, ${TENANT}::uuid, 'workspace-admin')`;
    await expect(applyRemap(queryClient, FROM, TO, { resolvePreexisting: true, email: 'ola@example.org' })).rejects.toThrow(
      /outside the stub tables: user_roles.user_id=1/,
    );
    await queryClient`DELETE FROM user_roles WHERE user_id = ${TO}`;
    await queryClient`UPDATE notification_prefs SET created_at = now() - interval '3 days' WHERE user_id = ${TO}`;
    await expect(applyRemap(queryClient, FROM, TO, { resolvePreexisting: true, email: 'ola@example.org' })).rejects.toThrow(
      /before --moved-after/,
    );
    const [p] = await queryClient`SELECT owner_id::text AS o FROM projects WHERE id = ${PROJECT}::uuid`;
    expect(p!.o).toBe(FROM);
  });
});
