// src/services/improvement-cards/create-lease.ts
//
// Issue #996 — a short-autocommit CREATE LEASE that answers exactly one
// question: "is another request creating a card for this (board, asset) right
// now?"
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// `routes/cards/improvement.ts` step 3b pre-reads `findOpenCardForAsset` and
// returns the existing OPEN card instead of minting a second one. That read is
// a TOCTOU: the create it guards takes tens of seconds (measured 2026-08-16:
// 54–104s per card, 10/10 samples), so two emitters firing inside that window
// both read "no open card" and both create. The lease closes the window.
//
// ---------------------------------------------------------------------------
// The core inversion: the lease NEVER stores or returns a card id
// ---------------------------------------------------------------------------
// Two earlier designs stored the minted card id in the lease row and handed it
// back to losers. Both were withdrawn: the stored id is not OPEN-scoped, so a
// re-emit after the card reached DONE would be answered with the DONE card and
// a genuine fresh degradation could never re-emit.
//
// Here `value_json` holds `{owner}` ONLY, and it is read for exactly one
// purpose: to decide whether *this* process may DELETE the row. The only
// source of a card id anywhere on the path stays `findOpenCardForAsset`, which
// is OPEN-scoped by construction.
//
// ---------------------------------------------------------------------------
// Mechanism: the conditional upsert from domain/engagement/dedup-claim.ts
// ---------------------------------------------------------------------------
// Deliberately the SAME shape as `claimIdempotencyKey`, not a new primitive:
//
//   INSERT ... ON CONFLICT (user_id, key) DO UPDATE ... WHERE expires_at <= NOW()
//
// One autocommit statement, so there is no TOCTOU between "is it expired?" and
// "take it", no advisory lock, and no connection held after it returns
// (pgbouncer-safe). Postgres row-locks the conflicting row before evaluating
// the DO UPDATE ... WHERE and re-evaluates against the winner's committed row
// version, so under contention exactly one caller wins.
//
// ⚠️ The `WHERE ... expires_at <= NOW()` predicate is load-bearing in BOTH
// directions. Without it (a bare `DO NOTHING`) an EXPIRED lease keeps winning
// the conflict forever and suppresses creation permanently — that is the exact
// bug dedup-claim.ts documents having shipped for three months. Mutant M9.
//
// ---------------------------------------------------------------------------
// Honest caveat (carried over from the design)
// ---------------------------------------------------------------------------
// This is a race-window REDUCER, not a hard exactly-once. Planka has no unique
// constraint on asset_id. A hard guarantee needs a `card_asset_binding(board_id,
// asset_id)` table with a partial unique index in fr's own DB. That is a
// worthwhile follow-up, not a prerequisite: the measured failure is a
// seconds-wide window, which the lease closes.

import { queryClient } from '../../db/client';
import { REQUEST_TIMEOUT_MS as PLANKA_REQUEST_TIMEOUT_MS } from '../planka/http';
import { IMPROVEMENT_CARD_TIMEOUT_MS } from './mint-client';
import { GROUP_FIELDS, GROUP_POSITIONS } from './field-groups';

// ---------------------------------------------------------------------------
// TTL derivation — COMPUTED from the real constants, never a chosen number
// ---------------------------------------------------------------------------
//
// ⚠️ CORRECTION TO THE AGREED DESIGN (measured 2026-09-07). The design derived
// `CREATE_LEASE_TTL_SECS = 900` from "26 sequential Planka calls × CRUD_TIMEOUT_MS
// 30_000 = 780s, ×1.15". BOTH inputs were wrong against the code:
//
//   * the widest deduped card_type is `workflow_development`, whose worst case
//     on an ALREADY-PROVISIONED board is 71 sequential Planka calls, not 26
//     (1 cards.create + 1 board GET + 1 GET retry + 52 declarative
//     custom-field writes + 4 taskLists.create + 12 tasks.create — the task
//     lists are gone since card types moved to RM, which models no protocol). The retry
//     term is easy to drop when reading this: an audit recomputed the
//     breakdown as 70 because the prose omitted it while the code included
//     it — the code is the conservative one, and now they agree.
//     `services/planka/custom-fields.ts`
//     independently records "~45–60 sequential Planka round-trips" for this
//     request, also well above 26.
//   * `CRUD_TIMEOUT_MS = 30_000` is the timeout of the outbound integration
//     proxies in `src/integrations/*.ts`. The Planka client this path actually
//     uses is `services/planka/http.ts`, whose per-call ceiling is
//     REQUEST_TIMEOUT_MS = 15_000.
//
// Rather than restate either number, the ceiling below is COMPUTED from the
// modules that own them, so it self-corrects when a field group gains a field
// or the Planka timeout changes. A hand-edited literal here is mutant M1/M2.

/** Groups `valuesFromRequest` populates at create time (everything but Runtime State). */
const DECLARATIVE_GROUPS = (
  Object.keys(GROUP_POSITIONS) as Array<keyof typeof GROUP_POSITIONS>
).filter((g) => g !== 'Runtime State');

/**
 * `PlankaHttp.request` retries an idempotent GET ONCE on a transient network
 * failure, so the single board GET on this path can cost two timeouts.
 * Mutations are never retried.
 */
const PLANKA_GET_RETRIES = 1;

/** Safety margin over the computed ceiling. */
const TTL_MARGIN = 1.15;

/**
 * Worst-case number of SEQUENTIAL Planka round-trips one `createImprovementCard`
 * can make for the widest deduped card_type. Field names are the RM board
 * template's (field-groups.ts mirrors it); fr never creates a field on this
 * path, so a board missing one only makes the create SHORTER.
 *
 * Every term is read from the module that owns it — nothing here is a literal
 * copied from a design document.
 */
export function worstCaseCreateCallCount(): number {
  const fieldWrites = DECLARATIVE_GROUPS.reduce(
    (n, g) => n + GROUP_FIELDS[g].length,
    0,
  );
  return (
    1 + // cards.create
    1 + // the one READ-ONLY board GET (resolveBoardFieldGroups)
    PLANKA_GET_RETRIES + // …which can be retried once
    fieldWrites
  );
}

/**
 * Seconds a single create can occupy in the worst case: every Planka call
 * hanging until its own timeout.
 */
export function createLeaseCeilingSecs(): number {
  return Math.ceil(
    (worstCaseCreateCallCount() * PLANKA_REQUEST_TIMEOUT_MS) / 1000,
  );
}

/**
 * Lease lifetime. MUST be ≥ the computed ceiling (a lease that expires while
 * its winner is still creating lets a second caller create — the very
 * duplicate this exists to stop) and MUST NOT be open-ended (a crashed pod
 * suppresses creation for exactly this long, with nothing to release it).
 */
export const CREATE_LEASE_TTL_SECS = Math.ceil(
  createLeaseCeilingSecs() * TTL_MARGIN,
);

/**
 * Upper bound on the lease: the margin must stay a margin. Twice the ceiling
 * is the most a stale lease from a crashed pod may suppress creation for.
 */
export function maxCreateLeaseTtlSecs(): number {
  return createLeaseCeilingSecs() * 2;
}

// ---------------------------------------------------------------------------
// Loser wait — derived from the in-process caller's own abort
// ---------------------------------------------------------------------------
//
// `services/improvement-cards/mint-client.ts` aborts its self-call at
// IMPROVEMENT_CARD_TIMEOUT_MS = 30_000, so a loser that waits longer than a
// third of that turns a dedup into a client timeout.

/** Hard ceiling for the loser's poll, derived from the caller's abort. */
export function maxLoserMarkerWaitMs(): number {
  return Math.floor(IMPROVEMENT_CARD_TIMEOUT_MS / 3);
}

/**
 * Minimum the loser must tolerate before giving up: a winner that has just
 * called `cards.create` needs the card to become visible to a subsequent board
 * GET. Bounded below so a "make it snappy" edit to 0 cannot silently turn every
 * loser into `create_in_progress` (mutant M3).
 */
export const MARKER_VISIBILITY_BUDGET_MS = 2_000;

/** How long a loser polls `findOpenCardForAsset` before answering. */
export const LOSER_MARKER_WAIT_MS = 6_000;

/** Poll cadence inside that window. */
export const LOSER_POLL_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/**
 * Lease key. Board-scoped rather than stream-scoped because the dedup read it
 * guards (`findOpenCardForAsset`) is board-scoped; tenant scoping comes from
 * the table's `user_id` column, which is part of the primary key.
 */
export function createLeaseKey(plankaBoardId: string, assetId: string): string {
  return `improvement-card:create:${plankaBoardId}:${assetId}`;
}

/**
 * Lease NAMESPACE (the `user_id` column) for POST /api/cards/project.
 *
 * ⚠️ Not the caller's active tenant. One project is legitimately visible under
 * TWO active tenants at once — its EXEC owner's home view and the
 * aa-orchestrator acting for the project's `keycloak_tenant_id` — and the
 * OPEN-card read the lease guards is scoped to the project's board, not to the
 * caller. A tenant-keyed lease gives those two callers DIFFERENT rows, so both
 * win, both create, and the board gets a duplicate card. Keying on the project
 * gives every permitted caller the same row. The prefix keeps it disjoint from
 * the tenant/user ids the improvement route and the action cache store here.
 */
export function projectCreateLeaseNamespace(projectId: string): string {
  return `project:${projectId}`;
}

// ---------------------------------------------------------------------------
// Claim / release
// ---------------------------------------------------------------------------

/**
 * Take the create lease for `key` under `tenantId`, stamped with `owner`.
 *
 * Returns true when this caller took it (row absent, or an EXPIRED row taken
 * over atomically), false when a live unexpired lease exists or another
 * concurrent caller won.
 *
 * `value_json` carries `{owner}` and nothing else — deliberately no card id.
 */
export async function claimCreateLease(
  tenantId: string,
  key: string,
  owner: string,
  ttlSeconds: number = CREATE_LEASE_TTL_SECS,
): Promise<boolean> {
  const rows = await queryClient<{ claimed: number }[]>`
    INSERT INTO action_idempotency (user_id, key, value_json, expires_at)
    VALUES (
      ${tenantId},
      ${key},
      ${JSON.stringify({ owner })}::jsonb,
      NOW() + make_interval(secs => ${ttlSeconds})
    )
    ON CONFLICT (user_id, key) DO UPDATE
       SET value_json = EXCLUDED.value_json,
           expires_at = EXCLUDED.expires_at,
           created_at = NOW()
     WHERE action_idempotency.expires_at <= NOW()
    RETURNING 1 AS claimed
  `;
  return rows.length === 1;
}

/**
 * Release the lease — OWNER-SCOPED.
 *
 * The `value_json->>'owner'` predicate is load-bearing (mutant M11): if a
 * winner overruns its TTL and a second caller takes the lease over, the late
 * winner finishing its create must NOT delete the taker's live lease. Without
 * the predicate it would, and the taker's create would race a third caller.
 *
 * Returns true when a row was actually removed.
 *
 * MUST run on the module-level `queryClient`, never inside a caller's
 * transaction: the claim autocommits and survives a rollback of any enclosing
 * transaction, so the release has to be equally independent.
 */
export async function releaseCreateLease(
  tenantId: string,
  key: string,
  owner: string,
): Promise<boolean> {
  const rows = await queryClient<{ released: number }[]>`
    DELETE FROM action_idempotency
     WHERE user_id = ${tenantId}
       AND key = ${key}
       AND value_json->>'owner' = ${owner}
    RETURNING 1 AS released
  `;
  return rows.length === 1;
}

/**
 * Does `owner` STILL hold an unexpired lease for `key` under `tenantId`, with at
 * least `minRemainingSecs` left on it?
 *
 * A holder that may have overrun its TTL asks this immediately before a write
 * the lease exists to serialise: an expired lease can already have been taken
 * over by a second caller, and writing anyway is the lost update the lease was
 * taken to prevent. `minRemainingSecs` lets the caller demand that the lease
 * outlive the write it is about to make, not merely the instant of the check.
 * Read-only, one autocommit statement on the module-level `queryClient`.
 */
export async function createLeaseStillHeld(
  tenantId: string,
  key: string,
  owner: string,
  minRemainingSecs = 0,
): Promise<boolean> {
  const rows = await queryClient<{ held: number }[]>`
    SELECT 1 AS held
      FROM action_idempotency
     WHERE user_id = ${tenantId}
       AND key = ${key}
       AND value_json->>'owner' = ${owner}
       AND expires_at > NOW() + make_interval(secs => ${minRemainingSecs})
  `;
  return rows.length === 1;
}

/**
 * Release that never throws.
 *
 * The card is already minted by the time this runs. Throwing here would fail a
 * request whose card exists, inviting a retry that mints a second one — which
 * is the defect this whole module exists to prevent. So a failed DELETE is
 * logged and swallowed; the lease then expires on its TTL.
 */
export async function releaseCreateLeaseQuietly(
  tenantId: string,
  key: string,
  owner: string,
): Promise<void> {
  try {
    await releaseCreateLease(tenantId, key, owner);
  } catch (err) {
    console.error(
      '[improvement-card create-lease] release failed; lease will expire on TTL',
      { key, ttlSecs: CREATE_LEASE_TTL_SECS },
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Loser poll
// ---------------------------------------------------------------------------

/**
 * Poll `find` until it yields a card id or the budget runs out.
 *
 * Losers NEVER create. This is the whole of their behaviour: they watch for the
 * winner's card to appear and answer with it, or admit that a create is still
 * in progress. `find` is the caller's bound `findOpenCardForAsset` — the only
 * source of a card id on this path.
 */
export async function waitForOpenCard(
  find: () => Promise<string | null>,
  waitMs: number = LOSER_MARKER_WAIT_MS,
  pollIntervalMs: number = LOSER_POLL_INTERVAL_MS,
): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) =>
      setTimeout(r, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))),
    );
  }
}
