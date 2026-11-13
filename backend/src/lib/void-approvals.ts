// src/lib/void-approvals.ts
//
// The ONE implementation of "void a named set of approvals".
//
// Voiding means "this ask was never answerable; withdraw it" — it is
// explicitly NOT a decision. The only deciding path remains
// PUT /api/approvals/:approvalId (routes/approvals.ts :: handleUpdateApproval);
// nothing in this module may set status='approved'/'rejected', write an
// `approval_decisions` row, or otherwise look like a human answered the
// question. It can only remove an unanswerable question from the queue, with a
// mandatory recorded reason.
//
// ── Why this lives here rather than inside the route ───────────────────────
// There are two legitimate ways to reach this transaction:
//   1. HTTP — POST /api/approvals/void (routes/approval-void.ts), gated on the
//      `super_admin` Keycloak realm role, for an operator holding a bearer
//      token.
//   2. In-cluster CLI — src/scripts/void-approvals.ts, for an operator who has
//      shell access to the pod but deliberately has NOT been handed a
//      super-admin token.
// Both must have IDENTICAL safety properties. If each grew its own copy of the
// transaction they would drift — and the drift would only ever be discovered
// after a bad write. So the transaction lives here once, and both callers are
// thin shells around it: the route adds auth + JSON shaping, the CLI adds argv
// + a printed tally. Neither may add a status, a filter, or a column.
//
// SAFETY PROPERTIES (all deliberate, all enforced below):
//   - `dryRun` is explicit at this boundary and DEFAULTS TO TRUE at both
//     callers (the zod schema below, and the CLI's `--execute` opt-in). A
//     caller that forgets the flag gets a report, never a write.
//   - Ids only, never a filter. A filter-driven mass void ("all pending with
//     no rationale") is exactly the unaudited-blast-radius failure a
//     named-ids-only seam replaces — do not widen this to accept a query.
//   - `reason` is mandatory (>=10 chars) — a void with no recorded reason is
//     an unaudited write.
//   - Only rows currently `status='pending'` may be voided. Every id handed in
//     gets a reported outcome — never a silent drop.
//   - The whole batch runs in ONE transaction: a partial void cannot happen.
//
// ⛔ NO AUDIT ROW IN `approval_decisions`. That table is the per-approver
// DECISION ledger — every row there answers "did a rostered approver approve
// or reject", and handleUpdateApproval's quorum math treats its mere presence
// as progress toward completion. Inserting a void row there would make an
// operator's withdrawal LOOK LIKE a decision to every reader of that table
// (the quorum tally, the GET decisions list, the n8n callback payload
// builder). The audit trail for a void lives on the `approvals` row itself
// instead — `voided_at` / `voided_reason` / `voided_by` (migration 110) — the
// same place `completed_at` and the `expired` transition already record every
// OTHER terminal, non-decision outcome (workers/approval-expiry.ts).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, approvals, projectRequests } from '../db/client';
import { projectOutlines } from '../db/schema';
import { appendHistorySql } from '../routes/project-request-history';
import { isPlatformTenant } from '../middleware/internal-tenant-only';
import { trackDetached } from './detached-work';
import { deliverApprovalCallbackUrls } from '../services/n8n-callback';

/**
 * The request shape, shared by BOTH callers so the two cannot diverge on what
 * counts as a valid void. The HTTP route parses a JSON body with it; the CLI
 * parses its argv into the same object and runs it through the same schema.
 */
export const VoidApprovalsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  reason: z
    .string()
    .trim()
    .min(
      10,
      'reason is required and must be at least 10 characters — a void with no recorded reason is an unaudited write',
    ),
  // ⛔ DEFAULTS TO TRUE. A caller that omits the flag — or a client that has
  // not yet been updated to send it — gets a REPORT, never a write. Only an
  // explicit `dryRun: false` performs the state change.
  dryRun: z.boolean().default(true),
});

export type VoidOutcome =
  | 'would_void'
  | 'voided'
  | 'skipped_not_pending'
  | 'not_found';

export interface VoidApprovalsOpts {
  /** Named ids only. May contain duplicates; de-duped for the DB round trip. */
  ids: string[];
  /** Mandatory recorded reason, already validated by `VoidApprovalsSchema`. */
  reason: string;
  /** TRUE = report only, write nothing. Callers default this to true. */
  dryRun: boolean;
  /**
   * Free-text operator identifier written to `approvals.voided_by`.
   *
   * That column is TEXT by design (migration 110): "an operator/user
   * identifier, not a decision-maker, mirroring `triage_actor`'s free-text
   * shape". There is no user record and no FK behind it — the HTTP route
   * passes the authenticated `user.id`, the CLI passes its `--actor` string,
   * and both are stored verbatim.
   */
  actor: string;
  /**
   * fr row 14d: when true, only rows whose `tenant_id` is a PLATFORM tenant
   * (`isPlatformTenant`) may be voided; a customer row is reported `not_found`
   * (indistinguishable from a missing id, so existence does not leak) and is
   * never written. Set by the super-admin HTTP route (POST /api/approvals/void):
   * a super-admin alone never crosses into a customer tenant. The in-process
   * lifecycle callers (project archive / request lifecycle) void the rows of
   * the project they are tearing down and leave it unset.
   */
  platformOnly?: boolean;
}

/**
 * Void a named set of approvals, in one transaction.
 *
 * Returns an outcome per UNIQUE id. Callers that accepted a possibly-duplicate
 * id list are responsible for re-expanding this map over their ORIGINAL list,
 * so every id the operator supplied gets a reported outcome — including
 * repeats. (Both shipped callers do exactly that.)
 */
export async function voidApprovals(
  opts: VoidApprovalsOpts,
): Promise<Map<string, VoidOutcome>> {
  // De-dupe for the DB round trip only — the caller still re-expands over its
  // original (possibly duplicate) `ids` array, so a repeated id is never
  // silently collapsed away.
  const uniqueIds = [...new Set(opts.ids)];

  const byId = await db.transaction(async (tx) => {
    // Cross-tenant by id — but, for the super-admin route, PLATFORM tenants
    // only (fr row 14d, `platformOnly`): a customer row is filtered out here,
    // before any status is read, so it reports `not_found` and is never in
    // `pendingIds`. The request still names specific ids rather than a scope.
    const existing = await tx
      .select({ id: approvals.id, status: approvals.status, tenant_id: approvals.tenant_id })
      .from(approvals)
      .where(inArray(approvals.id, uniqueIds));

    const statusById = new Map(
      existing
        .filter((r) => !opts.platformOnly || isPlatformTenant(r.tenant_id))
        .map((r) => [r.id, r.status]),
    );
    const byId = new Map<string, VoidOutcome>();
    const pendingIds: string[] = [];

    for (const id of uniqueIds) {
      const status = statusById.get(id);
      if (status === undefined) {
        byId.set(id, 'not_found');
      } else if (status !== 'pending') {
        byId.set(id, 'skipped_not_pending');
      } else {
        pendingIds.push(id); // resolved below, once we know what actually happened
      }
    }

    if (opts.dryRun) {
      for (const id of pendingIds) byId.set(id, 'would_void');
      return byId;
    }

    // Real run. One UPDATE per row rather than a single `= ANY(...)` batch:
    // per-row keeps the parameter binding identical to every other single-row
    // `${value}` interpolation already used in this repo rather than betting
    // on driver-specific array-binding for `ANY($1)`. Raw `sql` rather than
    // the drizzle table builder is retained from the original inline
    // implementation — `voided_at` / `voided_reason` / `voided_by` ARE now on
    // the `approvals` schema object (db/schema.ts, migration 110), so a
    // drizzle rewrite is possible, but it is deliberately not bundled into
    // this extraction: the point of the extraction is that the SQL that runs
    // is byte-for-byte the SQL that was already running.
    // Bounded by the same 1..500 the zod schema enforces, so this is at most
    // 500 statements inside ONE transaction — never a partial void, because
    // nothing here commits until the transaction returns.
    //
    // The WHERE re-asserts `status = 'pending'` so a row that transitioned
    // between the SELECT above and this UPDATE (a decider's PUT, an expiry
    // tick, a concurrent void) is never overwritten — the same discipline
    // workers/approval-expiry.ts's batch UPDATE and handleUpdateApproval's
    // optimistic-locked completion both use.
    for (const id of pendingIds) {
      const returned = await tx.execute<{ id: string }>(sql`
        UPDATE approvals
           SET status        = 'voided',
               voided_at     = now(),
               voided_reason = ${opts.reason},
               voided_by     = ${opts.actor},
               completed_at  = now(),
               updated_at    = now()
         WHERE id = ${id}
           AND status = 'pending'
        RETURNING id
      `);
      const didVoid = Array.isArray(returned) && returned.length > 0;
      byId.set(id, didVoid ? 'voided' : 'skipped_not_pending');
    }

    // An OUTLINE approval that is voided leaves its outline undecidable — but
    // until 2026-10-07 the outline stayed `proposed` and its request
    // `outline_proposed`, so the request page kept offering "Decide this
    // outline" over a withdrawn approval (UI review). Supersede the outline and
    // return the request to `submitted` (the outline-rejection edge,
    // from which a new outline can be proposed) in the SAME transaction as the
    // void. The withdraw path supersedes before it voids, so for it this finds
    // nothing and is a no-op.
    const voidedIds = [...byId].filter(([, o]) => o === 'voided').map(([id]) => id);
    if (voidedIds.length > 0) {
      const live = await tx
        .select({ id: projectOutlines.id, request_id: projectOutlines.request_id, approval_id: projectOutlines.approval_id })
        .from(projectOutlines)
        .where(
          and(
            inArray(projectOutlines.approval_id, voidedIds),
            eq(projectOutlines.status, 'proposed'),
          ),
        );
      for (const outline of live) {
        await tx
          .update(projectOutlines)
          .set({ status: 'superseded' })
          .where(and(eq(projectOutlines.id, outline.id), eq(projectOutlines.status, 'proposed')));
        const now = new Date();
        await tx
          .update(projectRequests)
          .set({
            status: 'submitted',
            updated_at: now,
            history: appendHistorySql({
              at: now.toISOString(),
              action: 'outline_voided',
              by: opts.actor,
              from_status: 'outline_proposed',
              detail: `outline approval ${outline.approval_id} voided: ${opts.reason}`,
            }),
          })
          .where(
            and(
              eq(projectRequests.id, outline.request_id),
              eq(projectRequests.status, 'outline_proposed'),
            ),
          );
      }
    }

    return byId;
  });

  // ── D17: resume every attached n8n Wait node with decision `voided` ──────────
  // AFTER the commit (the receiver may read the row back; an outbound call inside
  // the transaction would hold it for a network round trip), DETACHED (a void of
  // up to 500 rows must not wait on n8n), and best-effort: each URL row is claimed
  // and retried on its own, and anything this misses is due in the
  // approval-redelivery callback lane (an unattempted row of a voided approval).
  const voided = [...byId].filter(([, o]) => o === 'voided').map(([id]) => id);
  if (voided.length > 0) {
    let withUrls: string[] = [];
    try {
      const rows = await db.execute<{ approval_id: string }>(sql`
        SELECT DISTINCT approval_id FROM approval_callback_urls
         WHERE approval_id IN (${sql.join(voided.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      withUrls = (Array.isArray(rows) ? rows : []).map((r) => String(r.approval_id));
    } catch (err) {
      console.error(
        '[void-approvals] could not read attached callback_urls; the redelivery lane will send them:',
        err instanceof Error ? err.message : String(err),
      );
    }
    for (const id of withUrls) {
      void trackDetached(
        deliverApprovalCallbackUrls(id).catch((err: unknown) => {
          console.error(
            `[void-approvals] voided-callback send for approval ${id} threw (the redelivery lane retries it):`,
            err instanceof Error ? err.message : String(err),
          );
        }),
      );
    }
  }
  return byId;
}

/** Zeroed tally, so every outcome key is present even at count 0. */
export function emptyVoidCounts(): Record<VoidOutcome, number> {
  return {
    would_void: 0,
    voided: 0,
    skipped_not_pending: 0,
    not_found: 0,
  };
}
