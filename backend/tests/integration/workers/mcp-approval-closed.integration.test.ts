// tests/integration/workers/mcp-approval-closed.integration.test.ts
//
// fr #1684: a decided approval that was delivered to an mcp address must be
// followed by exactly one approval.closed attempt per address, recorded as an
// `approval-closed` delivery. MCP_EVENTS_URL is unset in tests, so every send
// fails with 'mcp channel not configured' — which is what lets the selection,
// the failure cap and the once-only rule be asserted without a fake server.

import { afterEach, expect } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';

import { approvals, db, engagementDeliveries } from '../../../src/db/client';
import {
  CLOSED_ENGAGEMENT_TYPE,
  runMcpApprovalClosedTick,
} from '../../../src/workers/mcp-approval-closed';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '33333333-3333-3333-3333-333333333384';
const ADDRESS = 'care-bus:test:1684';
const { itDb } = createDbSuite('mcp-approval-closed');
const seeded: string[] = [];

async function seedApproval(status: string, delivered: { channel: string; status: string }[]) {
  const [row] = await db
    .insert(approvals)
    .values({ tenant_id: TENANT, status, description: `t-${status}`, metadata: { mcp_run_id: 'run-1684' } })
    .returning({ id: approvals.id });
  seeded.push(row!.id);
  for (const d of delivered) {
    await db.insert(engagementDeliveries).values({
      engagement_id: row!.id,
      engagement_type: 'approval',
      channel: d.channel,
      recipient_address: ADDRESS,
      status: d.status,
    });
  }
  return row!.id;
}

function closedRows(id: string) {
  return db
    .select()
    .from(engagementDeliveries)
    .where(and(eq(engagementDeliveries.engagement_id, id), eq(engagementDeliveries.engagement_type, CLOSED_ENGAGEMENT_TYPE)));
}

afterEach(async () => {
  if (seeded.length) {
    await db.delete(engagementDeliveries).where(inArray(engagementDeliveries.engagement_id, seeded));
    await db.delete(approvals).where(inArray(approvals.id, seeded));
    seeded.length = 0;
  }
});

itDb('attempts approval.closed only for a decided approval delivered to mcp', async () => {
  const decided = await seedApproval('approved', [{ channel: 'mcp', status: 'sent' }]);
  const pending = await seedApproval('pending', [{ channel: 'mcp', status: 'sent' }]);
  const telegramOnly = await seedApproval('rejected', [{ channel: 'telegram', status: 'sent' }]);
  const neverDelivered = await seedApproval('expired', [{ channel: 'mcp', status: 'failed' }]);

  const r = await runMcpApprovalClosedTick();
  expect(r.outcome).toBe('ok');

  const rows = await closedRows(decided);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.channel).toBe('mcp');
  expect(rows[0]!.recipient_address).toBe(ADDRESS);
  expect(rows[0]!.status).toBe('failed');
  expect(rows[0]!.error).toBe('mcp channel not configured');
  expect(rows[0]!.metadata_json).toMatchObject({ final_status: 'approved' });

  for (const id of [pending, telegramOnly, neverDelivered]) expect(await closedRows(id)).toHaveLength(0);
});

itDb('stops retrying an address after five failed attempts', async () => {
  const id = await seedApproval('voided', [{ channel: 'mcp', status: 'sent' }]);
  for (let i = 0; i < 7; i++) await runMcpApprovalClosedTick();
  expect(await closedRows(id)).toHaveLength(5);
});

itDb('never re-sends once approval.closed was sent to that address', async () => {
  const id = await seedApproval('approved', [{ channel: 'mcp', status: 'sent' }]);
  await db.insert(engagementDeliveries).values({
    engagement_id: id,
    engagement_type: CLOSED_ENGAGEMENT_TYPE,
    channel: 'mcp',
    recipient_address: ADDRESS,
    status: 'sent',
  });
  await runMcpApprovalClosedTick();
  expect(await closedRows(id)).toHaveLength(1);
});

itDb('reports an action approval that ran (executing/done/failed) as approved', async () => {
  const id = await seedApproval('done', [{ channel: 'mcp', status: 'sent' }]);
  await runMcpApprovalClosedTick();
  const [row] = await closedRows(id);
  expect(row!.metadata_json).toMatchObject({ final_status: 'approved' });
});
