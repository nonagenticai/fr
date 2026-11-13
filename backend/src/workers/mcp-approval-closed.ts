// src/workers/mcp-approval-closed.ts
//
// Pushes `approval.closed` to every `mcp` address an approval was delivered to,
// once the approval leaves `pending` (fr #1684).
//
// The mcp adapter (domain/engagement/adapters/mcp.ts) emits `approval.closed`
// only when it is handed a non-pending approval, and nothing re-sends an approval
// after a decision: approvals reach a terminal status from ~40 writers (web,
// Telegram, mcp, Teams, n8n callbacks, expiry, void, board moves). So
// instead of a send at each writer, this tick finds the pairs that are owed one:
// a `sent` mcp delivery of the request, a non-pending approval, and no `sent`
// `approval-closed` delivery to that address yet. Each pair is sent once.
//
// The MCP server closes inputs by approval_id idempotently, so a duplicate (two
// overlapping ticks, a redeploy mid-tick) is harmless. A pair that keeps failing
// stops after MAX_FAILURES attempts; the MCP run's own deadline ends it anyway.

import { sql } from 'drizzle-orm';

import { db, engagementDeliveries } from '../db/client';
import { mcpAdapter } from '../domain/engagement/adapters/mcp';
import type { ApprovalWithDetails } from '../domain/engagement/notifications';
import { reportSwallowedFailure } from '../integrations/_lib/errors';

export const CLOSED_ENGAGEMENT_TYPE = 'approval-closed';
const DEFAULT_INTERVAL_MS = 30_000;
/** Requests older than this are past every MCP run's deadline (external_run_max_seconds, 7d). */
const LOOKBACK_DAYS = 8;
const BATCH = 50;
const MAX_FAILURES = 5;
/** Action-approval states that exist only after an approve (domain/engagement/action-approvals.ts). */
const AFTER_APPROVAL = new Set(['executing', 'done', 'failed']);

type OwedRow = ApprovalWithDetails & { recipient_address: string; recipient_user_id: string | null } & Record<string, unknown>;

export interface McpApprovalClosedTickResult {
  outcome: 'ok' | 'failed';
  sent: number;
  failed: number;
  error?: string;
}

export async function runMcpApprovalClosedTick(): Promise<McpApprovalClosedTickResult> {
  const result: McpApprovalClosedTickResult = { outcome: 'ok', sent: 0, failed: 0 };
  try {
    const rows = await db.execute<OwedRow>(sql`
      SELECT DISTINCT ON (a.id, d.recipient_address)
             a.id, a.project_id, a.tenant_id, a.status, a.metadata, a.description, a.card_id,
             a.callback_path, a.source, a.expires_at, a.requester_id, a.kind,
             d.recipient_address, d.recipient_user_id
        FROM engagement_deliveries d
        JOIN approvals a ON a.id::text = d.engagement_id
       WHERE d.channel = 'mcp'
         AND d.engagement_type = 'approval'
         AND d.status = 'sent'
         AND d.created_at > now() - make_interval(days => ${LOOKBACK_DAYS})
         AND a.status <> 'pending'
         AND NOT EXISTS (
               SELECT 1 FROM engagement_deliveries c
                WHERE c.engagement_id = d.engagement_id
                  AND c.channel = 'mcp'
                  AND c.engagement_type = ${CLOSED_ENGAGEMENT_TYPE}
                  AND c.recipient_address = d.recipient_address
               GROUP BY c.recipient_address
               HAVING bool_or(c.status = 'sent') OR count(*) >= ${MAX_FAILURES})
       ORDER BY a.id, d.recipient_address
       LIMIT ${BATCH}
    `);

    for (const row of rows) {
      const { recipient_address: address, recipient_user_id: userId, ...decided } = row;
      // An ACTION approval moves on past its decision (executing → done | failed); the MCP
      // side is told the decision, never a run state.
      const approval = { ...decided, status: AFTER_APPROVAL.has(decided.status) ? 'approved' : decided.status };
      const sent = await mcpAdapter.send(approval, address);
      await db.insert(engagementDeliveries).values({
        engagement_id: approval.id,
        engagement_type: CLOSED_ENGAGEMENT_TYPE,
        channel: 'mcp',
        recipient_user_id: userId,
        recipient_address: address,
        status: sent.success ? 'sent' : 'failed',
        error: sent.error ?? null,
        metadata_json: { ...(sent.metadata ?? {}), final_status: approval.status },
      });
      if (sent.success) result.sent += 1;
      else result.failed += 1;
    }
    return result;
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'mcp-approval-closed',
      degradedTo: 'no approval.closed sent this tick (retried next tick)',
    });
    return { ...result, outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** Idempotent. Interval override: MCP_APPROVAL_CLOSED_INTERVAL_MS. */
export function startMcpApprovalClosedWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(process.env.MCP_APPROVAL_CLOSED_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[mcp-approval-closed] interval invalid, refusing to start');
    return;
  }
  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runMcpApprovalClosedTick();
      if (r.sent > 0 || r.failed > 0 || r.outcome === 'failed') {
        console.log(
          `[mcp-approval-closed] outcome=${r.outcome} sent=${r.sent} failed=${r.failed}` +
            (r.error ? ` error=${r.error}` : ''),
        );
      }
    } finally {
      tickInFlight = false;
    }
  };
  void runOnce();
  timer = setInterval(() => void runOnce(), intervalMs);
  console.log(`[mcp-approval-closed] scheduler started, interval=${intervalMs}ms`);
}

export function stopMcpApprovalClosedWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
