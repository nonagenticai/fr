// tests/integration/routes/approval-decisions-unique.integration.test.ts
//
// MIGRATION 157 — UNIQUE (approval_id, approver_id) on `approval_decisions`: the losing
// side of a check-then-insert race (e.g. a Telegram webhook retry overlapping the original
// delivery) becomes a unique violation instead of a second decision row.
//
// This index (+ recordDecision's FOR UPDATE re-check) is the exactly-once guarantee for a
// DECISION. There is deliberately no Telegram update_id ledger: a claim-before-process
// ledger lost messages (retryable 503 retries; pods killed mid-request on deploy), so a
// retried update is processed again — it may repeat a chat reply, never decide twice.
//
// ⚠️ DB-BACKED ON PURPOSE: this is a property of the schema (a unique index). A stub could
// not fail for a migration that forgot it.

import { expect, describe, beforeEach, afterAll } from 'bun:test';
import { eq, sql as drizzleSql } from 'drizzle-orm';

import { db, approvals, approvalDecisions } from '../../../src/db/client';

import { createDbSuite } from '../helpers/db-suite';

const { itDb, dbReachable } = createDbSuite('approval-decisions-unique');

const TENANT_ID = '00000000-0000-4000-8000-0000e7d00001';
const REQUESTER_ID = 'e7d0f000-0000-4000-8000-000000000001';
const APPROVER_ID = 'e7d0f000-0000-4000-8000-0000000000a1';
const APPROVAL_ID = 'e7d00001-0000-4000-8000-000000000001';

async function cleanup(): Promise<void> {
  if (!dbReachable) return;
  // approval_decisions cascades on approvals.id.
  await db.delete(approvals).where(eq(approvals.id, APPROVAL_ID));
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

function isUniqueViolation(err: unknown): boolean {
  const probe = (val: unknown): { code?: string; message?: string } | null =>
    val && typeof val === 'object' ? (val as Record<string, unknown>) : null;
  const top = probe(err) ?? {};
  const cause = probe((err as { cause?: unknown } | undefined)?.cause) ?? {};
  return (
    top.code === '23505' ||
    cause.code === '23505' ||
    /duplicate key|unique constraint/i.test(`${top.message ?? ''} ${cause.message ?? ''}`)
  );
}

describe('approval_decisions UNIQUE (approval_id, approver_id)', () => {
  itDb('a second decision by the same approver on the same approval is a unique violation', async () => {
    await db.insert(approvals).values({
      id: APPROVAL_ID,
      tenant_id: TENANT_ID,
      requester_id: REQUESTER_ID,
      description: 'migration 157 unique-decision probe',
      status: 'pending',
      callback_path: 'kanban/approval-callback',
      card_id: null,
      metadata: {},
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await db.insert(approvalDecisions).values({
      approval_id: APPROVAL_ID,
      approver_id: APPROVER_ID,
      decision: 'approved',
    });

    let caught: unknown;
    try {
      await db.insert(approvalDecisions).values({
        approval_id: APPROVAL_ID,
        approver_id: APPROVER_ID,
        decision: 'approved',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);

    const [countRow] = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(approvalDecisions)
      .where(eq(approvalDecisions.approval_id, APPROVAL_ID));
    expect(countRow?.n).toBe(1);
  });
});
