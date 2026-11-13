// src/services/execution-signoff-blocks.ts
//
// Read/write side of `execution_signoff_blocks` (migration 098) — the ledger of
// cards the AA ready-prefetch gate parked in BLOCKED and could not create an
// approval for.
//
// The premise: by the time POST /api/execution/approvals refuses, n8n has
// ALREADY moved the card to BLOCKED, and the node that receives the refusal
// runs with onError:continueRegularOutput. The response — whatever status it
// carries — is discarded. A refusal is therefore only durable if fr writes it
// down itself, which is what recordSignoffBlock does before the route throws.
//
// Recording MUST NOT be able to change the route's answer. A failure here is
// logged and swallowed: losing the diagnostic is bad, but turning a precise
// 404/422 into a 500 because the diagnostic write failed would be worse.

import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';

import { db, executionSignoffBlocks } from '../db/client';
import {
  SIGNOFF_BLOCK_REASONS,
  SIGNOFF_BLOCK_REMEDIES,
  type SignoffBlockReason,
} from '../lib/execution-signoff';

/** Most open blocks the operator view returns. */
const OPEN_BLOCKS_LIMIT = 500;

export interface SignoffBlockInput {
  card_id: string;
  board_id?: string | null;
  /** Verbatim project key the caller supplied — may be absent or not a UUID. */
  requested_project_id?: string | null;
  /** Only set when the project row actually resolved. */
  resolved_project_id?: string | null;
  tenant_id?: string | null;
  reason_code: SignoffBlockReason;
  detail: string;
}

/**
 * Upsert the block for (card_id, reason_code).
 *
 * The gate re-fires every time the card is touched, so a repeat is a COUNTER
 * bump, not a new row — an operator wants a list of distinct broken things, not
 * a firehose. A repeat also RE-OPENS a previously resolved row (`resolved_at`
 * back to NULL): if the same card blocks again for the same reason, the
 * configuration regressed and the row must be visible again.
 *
 * Never throws.
 */
export async function recordSignoffBlock(
  input: SignoffBlockInput,
): Promise<void> {
  try {
    await db
      .insert(executionSignoffBlocks)
      .values({
        card_id: input.card_id,
        board_id: input.board_id ?? null,
        requested_project_id: input.requested_project_id ?? null,
        resolved_project_id: input.resolved_project_id ?? null,
        tenant_id: input.tenant_id ?? null,
        reason_code: input.reason_code,
        detail: input.detail,
      })
      .onConflictDoUpdate({
        target: [executionSignoffBlocks.card_id, executionSignoffBlocks.reason_code],
        set: {
          attempts: sql`${executionSignoffBlocks.attempts} + 1`,
          last_seen_at: sql`now()`,
          // Late-arriving context wins: an earlier attempt may have carried
          // less (e.g. no board_id), and COALESCE(new, old) never loses what we
          // already knew.
          board_id: sql`coalesce(excluded.board_id, ${executionSignoffBlocks.board_id})`,
          requested_project_id: sql`coalesce(excluded.requested_project_id, ${executionSignoffBlocks.requested_project_id})`,
          resolved_project_id: sql`coalesce(excluded.resolved_project_id, ${executionSignoffBlocks.resolved_project_id})`,
          tenant_id: sql`coalesce(excluded.tenant_id, ${executionSignoffBlocks.tenant_id})`,
          detail: input.detail,
          resolved_at: null,
        },
      });
  } catch (err) {
    // Deliberately non-fatal — see the module header.
    console.error(
      `[execution-signoff-blocks] failed to record block card=${input.card_id} ` +
        `reason=${input.reason_code}:`,
      err,
    );
  }
}

/**
 * Mark every open block for a card resolved. Called when that card DOES manage
 * to create an approval — the configuration defect is gone, so the row must
 * stop showing up in the operator view. Rows are retained (not deleted) so
 * "how long was this card unreleasable" stays answerable.
 *
 * Never throws, for the same reason as recordSignoffBlock: bookkeeping must not
 * be able to fail a successful approval creation.
 */
export async function resolveSignoffBlocks(
  cardId: string,
  opts: { tenantId: string },
): Promise<void> {
  try {
    // ⛔ TENANT-SCOPED. `card_id` is caller-supplied text, so a card-only
    // predicate let a gate minted in tenant A retire tenant B's open blocks
    // (fr#1162 audit). Rows for THIS tenant are retired, plus the untenanted
    // rows — the not-found refusals recorded before any tenant could be
    // resolved — because a successful mint for the same card in this tenant is
    // exactly what supersedes them. Another tenant's rows are never touched.
    await db
      .update(executionSignoffBlocks)
      .set({ resolved_at: sql`now()` })
      .where(
        and(
          eq(executionSignoffBlocks.card_id, cardId),
          isNull(executionSignoffBlocks.resolved_at),
          or(
            eq(executionSignoffBlocks.tenant_id, opts.tenantId),
            isNull(executionSignoffBlocks.tenant_id),
          ),
        ),
      );
  } catch (err) {
    console.error(
      `[execution-signoff-blocks] failed to resolve blocks for card=${cardId}:`,
      err,
    );
  }
}

export interface SignoffBlockRow {
  id: string;
  card_id: string;
  board_id: string | null;
  requested_project_id: string | null;
  resolved_project_id: string | null;
  tenant_id: string | null;
  reason_code: SignoffBlockReason;
  detail: string;
  attempts: number;
  first_seen_at: Date;
  last_seen_at: Date;
  /** What an operator has to do about it — resolved from the reason code. */
  remedy: string;
}

/**
 * The open (unresolved) blocks, newest activity first.
 *
 * SUPPRESSED IS NOT STRANDED. `signoff_fixture_origin` rows are excluded: they
 * are not cards awaiting a fix, they are integration-test traffic fr
 * deliberately declined to mint an approval for (see
 * SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN). This endpoint's whole value is that a
 * non-zero count means a REAL defect — and the fixture population is large
 * enough to destroy that property outright: IT Flow1 alone produced 402 cards
 * and 37% of the BLOCKED backlog, so leaving these in would bury the real
 * unreleasable rows under synthetic ones within days. The rows are still
 * WRITTEN (queryable directly for "how much did we suppress"); they are only
 * absent from the operator worklist.
 */
export async function listOpenSignoffBlocks(): Promise<SignoffBlockRow[]> {
  const rows = await db
    .select()
    .from(executionSignoffBlocks)
    .where(
      and(
        isNull(executionSignoffBlocks.resolved_at),
        ne(executionSignoffBlocks.reason_code, SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN),
      ),
    )
    .orderBy(desc(executionSignoffBlocks.last_seen_at))
    .limit(OPEN_BLOCKS_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    card_id: r.card_id,
    board_id: r.board_id,
    requested_project_id: r.requested_project_id,
    resolved_project_id: r.resolved_project_id,
    tenant_id: r.tenant_id,
    reason_code: r.reason_code,
    detail: r.detail,
    attempts: r.attempts,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    remedy: SIGNOFF_BLOCK_REMEDIES[r.reason_code] ?? 'Unknown reason code.',
  }));
}
