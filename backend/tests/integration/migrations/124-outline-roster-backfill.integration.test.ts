// tests/integration/migrations/124-outline-roster-backfill.integration.test.ts
//
// Migration 124 repairs `project_outline.approval` rows #1153 minted with no
// `required_approvers` roster. It must:
//   * backfill a PENDING roster-less outline approval (payload.approvers, else
//     the request's created_by — the route's rule);
//   * leave an outline approval that ALREADY has a roster exactly as it is;
//   * skip non-pending outline approvals (decided rows are history);
//   * skip other approval kinds;
//   * be idempotent.
//
// Runs the SQL file directly (CI builds with drizzle-kit push, so the runner
// stamps 124 applied without running it — see the file's NOT PROBED note).
//
// ⚠️ ONE sql.begin() THAT ALWAYS ROLLS BACK: the migration is not scoped to this
// test's fixtures, and the database is shared. Rollback is forced by throwing a
// sentinel — postgres.js COMMITS a callback that returns normally. Bind
// parameters are explicitly cast (42P18 in CI otherwise; see the 117 test).

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';

const MIGRATION = readFileSync(
  join(import.meta.dir, '../../../migrations/124_outline_approval_roster_backfill.sql'),
  'utf8',
);

const TAG = `mig124-${process.pid}-${Date.now()}`;
const TENANT = '00000000-0000-4000-8000-0000124b0001';
const CREATOR = '00000000-0000-4000-8000-0000124b0010';
const NAMED = '00000000-0000-4000-8000-0000124b0011';
const EXISTING = '00000000-0000-4000-8000-0000124b0012';

class Rollback extends Error {}

type Tx = postgres.TransactionSql<Record<string, never>>;

async function seedRequest(tx: Tx, ref: string, payload: object): Promise<string> {
  const rows = (await tx.unsafe(
    `INSERT INTO project_requests (tenant_id, source, external_ref, payload, status, history, created_by)
     VALUES ($1::uuid, 'fr', $2::text, $3::jsonb, 'outline_proposed', '[]'::jsonb, $4::uuid)
     RETURNING id`,
    [TENANT, `${TAG}-${ref}`, JSON.stringify(payload), CREATOR],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

async function seedApproval(
  tx: Tx,
  control: string,
  requestId: string,
  status: string,
  kind = 'project_outline.approval',
): Promise<string> {
  const rows = (await tx.unsafe(
    `INSERT INTO approvals
       (tenant_id, project_id, project_request_id, requester_id, status, kind,
        description, source, created_at, updated_at, metadata)
     VALUES ($1::uuid, NULL, $2::uuid, $3::uuid, $4::text, $5::text::approval_kind,
             $6::text, 'n8n', now(), now(),
             jsonb_build_object('test_tag', $7::text, 'control', $6::text))
     RETURNING id`,
    [TENANT, requestId, CREATOR, status, kind, control, TAG],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

async function roster(tx: Tx, approvalId: string) {
  return (await tx.unsafe(
    `SELECT user_id::text AS user_id, role, tenant_id::text AS tenant_id
       FROM required_approvers WHERE approval_id = $1::uuid ORDER BY user_id`,
    [approvalId],
  )) as unknown as { user_id: string; role: string | null; tenant_id: string }[];
}

test('migration 124 backfills only pending roster-less outline approvals, idempotently', async () => {
  let failure: unknown;
  try {
    await sql.begin(async (tx) => {
      const fallbackReq = await seedRequest(tx, 'fallback', { name: 'x' });
      const namedReq = await seedRequest(tx, 'named', { name: 'y', approvers: [NAMED, 'free text'] });

      const fallback = await seedApproval(tx, 'fallback', fallbackReq, 'pending');
      const named = await seedApproval(tx, 'named', namedReq, 'pending');
      const hasRoster = await seedApproval(tx, 'has_roster', fallbackReq, 'pending');
      const decided = await seedApproval(tx, 'decided', fallbackReq, 'approved');
      const voided = await seedApproval(tx, 'voided', fallbackReq, 'voided');
      const otherKind = await seedApproval(tx, 'other_kind', fallbackReq, 'pending', 'generic');

      await tx.unsafe(
        `INSERT INTO required_approvers (tenant_id, approval_id, user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'tech_lead')`,
        [TENANT, hasRoster, EXISTING],
      );

      // Positive control: every target starts with NO roster, so a pass below
      // is the migration's doing.
      for (const id of [fallback, named, decided, voided, otherKind]) {
        expect(await roster(tx, id)).toEqual([]);
      }

      await tx.unsafe(MIGRATION);

      expect(await roster(tx, fallback)).toEqual([
        { user_id: CREATOR, role: 'outline_approver', tenant_id: TENANT },
      ]);
      expect(await roster(tx, named)).toEqual([
        { user_id: NAMED, role: 'outline_approver', tenant_id: TENANT },
      ]);
      expect(await roster(tx, hasRoster)).toEqual([
        { user_id: EXISTING, role: 'tech_lead', tenant_id: TENANT },
      ]);
      expect(await roster(tx, decided)).toEqual([]);
      expect(await roster(tx, voided)).toEqual([]);
      expect(await roster(tx, otherKind)).toEqual([]);

      // Idempotent: a second run adds nothing.
      await tx.unsafe(MIGRATION);
      expect((await roster(tx, fallback)).length).toBe(1);
      expect((await roster(tx, named)).length).toBe(1);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) failure = err;
  }
  if (failure) throw failure;
});
