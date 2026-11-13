// backend/src/db/advisory-lock-keys.ts
//
// THE ONLY PLACE an integer Postgres advisory-lock key may be declared in
// fr-backend. If you need a new one, add it here and import it. Do not write a
// bare integer literal into a worker, and do not copy this list into a comment
// anywhere else.
//
// Why this file exists — a MEASURED collision, not a style preference
// -------------------------------------------------------------------
// Until 2026-09-05, each advisory-lock user carried its own hand-copied comment
// registry of the form:
//
//     // Advisory-lock key (arbitrary 32-bit signed int). Must be unique across
//     // every advisory-lock user in fr-backend: 912347 = migration runner,
//     // 912348 = analytics rollup, 912349 = idempotency sweep, 912350 = this X.
//
// That comment WAS the defect mechanism. Two authors each copied the registry
// from a sibling worker, each read "912349 = idempotency sweep" as the highest
// taken slot, and each claimed 912350 as "this one":
//
//   * scheduled-trigger-run-prune.ts  claimed 912350 on 2026-08-05 (7b18cc80)
//   * approval-expiry.ts              claimed 912350 on 2026-08-08 (a1e9c96f)
//
// Neither author could see the other, because the registry was prose in a file
// they were not editing. The consequence is SILENT: both workers take the key
// with `pg_try_advisory_xact_lock`, so whichever ticks first makes the other's
// call return false. The loser then takes its normal "another replica is
// already running this worker" branch and skips its ENTIRE tick — no error, no
// throw, and no log line that names the real cause. Two unrelated workers
// serialise against each other and both look healthy while doing it.
//
// WHAT CENTRALISING DOES AND DOES NOT BUY — read this before trusting it
// ----------------------------------------------------------------------
// ⚠️ This file does NOT make the collision "impossible to express". An earlier
// draft of this docblock claimed exactly that, and it was FALSE — measured, on
// an open PR, the same day it was written.
//
// What this file buys is narrow and real: a duplicate value BETWEEN TWO
// REGISTERED OWNERS becomes two properties of one object literal, visible in
// one diff, and asserted against by `tests/unit/db/advisory-lock-keys.test.ts`.
//
// What it cannot buy is the other half. That test can only see keys that are
// already INSIDE `LOCK_KEYS`. A key declared anywhere else is invisible to it,
// and the test stays green while main carries the integer twice. The measured
// counterexample: open PR #921 (`fix/approvals-never-delivered-and-never-
// retried`) adds `src/workers/approval-redelivery.ts` carrying its own
// hand-copied keyspace comment and `const ADVISORY_LOCK_KEY = 912351;`. It
// touches files disjoint from the collision fix, so the two merge with zero
// conflict and every registry test stays green over a duplicated key.
//
// The half this file cannot close — an integer advisory-lock key declared
// OUTSIDE this file (a bare literal in a `pg_advisory_lock(...)` call, or a
// lock-named constant bound to a number) — is left to review.
//
// A SEPARATE KEYSPACE — do not assume this registry is exhaustive
// ---------------------------------------------------------------
// These integers are not the only advisory locks the backend takes. These call
// sites derive their key at runtime from `hashtext(...)` over a row-identifying
// string rather than from a registered constant:
//
//   * src/domain/engagement/idempotency.ts       — per-idempotency-key lock
//   * src/domain/engagement/notification-prefs.ts — per-user prefs replace,
//     `notification-prefs:<userId>`
//   * src/lib/priority-change.ts                 — per-card priority lock and the
//     conveyor priority lock
//   * src/routes/decomposition-commit.ts, decomposition-split.ts — per-project
//     decomposition lock
//   * src/routes/reports.ts                      — per-bug-report fix lock, `bug-fix:<id>`
//   * src/services/improvement-cards/relations.ts — per-card relation-field lock
//   * src/routes/andon.ts                        — the instance-cord lock,
//     `hashtext('fr.andon.instance-cord')` (operator pull/release, kata join/leave)
//   * src/services/workspace-admin-revoke-lock.ts — per-tenant workspace-admin
//     revoke lock, `hashtext('ws-admin-revoke:' || tenantId)` (fr#1312)
//
// Those are a DIFFERENT keyspace by design: they are per-row mutual exclusion,
// minted per value, and there is no fixed set of them to register. They are
// listed here only so the next author does not read this file, conclude the
// backend takes exactly six advisory locks, and be wrong.
//
// A hashtext-derived key CAN in principle collide with one of the integers
// below, and nothing here reduces that. ⚠️ An earlier draft claimed the
// "deliberately unusual 9123xx band" made such a collision "vanishingly
// unlikely". That is false and worth deleting rather than softening: `hashtext`
// is a hash, uniform over the whole int4 range, so the odds a given call site
// lands on a given key are 2^-32 whatever band that key sits in. Clustering the
// registered keys buys legibility for humans reading a `pg_locks` dump. It buys
// nothing probabilistic. If a hashtext collision ever matters, the fix is a
// disjoint keyspace (the two-int `pg_advisory_lock(classid, objid)` form), not
// a lucky band.
//
// Scope note: every consumer below uses the TRANSACTION-scoped variant
// (`pg_advisory_xact_lock` / `pg_try_advisory_xact_lock`), which releases at
// COMMIT/ROLLBACK. That is required, not incidental — fr-backend reaches
// Postgres through pgbouncer in transaction-pooling mode, where a session-
// scoped `pg_advisory_lock` and its later `pg_advisory_unlock` can land on
// different server backends and leak the lock forever. See the docblocks in
// workers/analytics-rollup.ts and workers/idempotency-sweep.ts.

/**
 * Registered integer advisory-lock keys, by owner.
 *
 * Keys are arbitrary 32-bit signed ints; the only requirement is that they are
 * unique within this object. Never reuse a retired key for a new owner — an
 * old pod mid-rollout may still be holding it.
 */
export const LOCK_KEYS = Object.freeze({
  /** src/db/migration-runner.ts — serialises schema migrations across pods. */
  migrationRunner: 912347,
  /** src/workers/analytics-rollup.ts — one replica per rollup tick. */
  analyticsRollup: 912348,
  /** src/workers/idempotency-sweep.ts — one replica per `action_idempotency` TTL sweep. */
  idempotencySweep: 912349,
  /**
   * src/workers/approval-expiry.ts — one replica per approval-expiry tick.
   *
   * KEPT 912350 through the 2026-09-05 collision fix, even though it is NOT
   * the older claim — scheduled-trigger-run-prune took 912350 first, on
   * 2026-08-05, three days before this worker did.
   *
   * ⚠️ WHY, honestly: because it had to be one of them and this one was
   * already written. There is no safety argument here, and an earlier version
   * of this comment asserted one that does not hold.
   *
   * The retracted claim was: "whichever worker changes key has a rolling-deploy
   * window where the old pod holds the old key and the new pod holds the new
   * one, so the tick can run twice concurrently; for the prune worker that is a
   * duplicated idempotent DELETE, but for THIS worker it would mean duplicate
   * `sendN8nExpiryCallback` deliveries to n8n." The window is real. The
   * consequence is not — verified against the code on 2026-09-05:
   *
   *   * `expireBatch` is a single statement whose subselect is
   *     `WHERE status = 'pending' AND expires_at <= now() … FOR UPDATE SKIP
   *     LOCKED`, and the UPDATE returns only the rows it actually transitioned
   *     (`RETURNING id, callback_path`).
   *   * `SKIP LOCKED` means a concurrent tick's subselect steps over every row
   *     the first tick has locked, and once that tick commits the rows are no
   *     longer `pending`. Two concurrent ticks therefore return DISJOINT row
   *     sets — the same row cannot come back from both.
   *   * `notifyExpired` iterates that returned array and nothing else, so a
   *     callback can only fire for a row this tick itself expired.
   *
   * So BOTH sides are safe under a mismatched-key window, and which one moves
   * is a free choice. It is recorded as a free choice on purpose: a permanent
   * registry is the worst place to leave a safety rationale that does not hold,
   * because the next author inherits it as a constraint and routes around it.
   */
  approvalExpiry: 912350,
  /**
   * src/workers/approval-redelivery.ts — one replica per notification
   * re-delivery tick.
   *
   * NO LONGER RESERVED. This entry was written while PR #921 was still open, as
   * a reservation, so the two branches could not collide whichever order they
   * landed in. #921 has now merged and the worker imports this key by name, so
   * the owner is real.
   *
   * The reservation worked exactly as intended and is worth recording: because
   * the integer reserved here was the one #921 already used inline, the whole
   * remedy on merge was a one-line swap to `LOCK_KEYS.approvalRedelivery` — no
   * renumber, and therefore no rolling-deploy window in which an old pod holds
   * one key while a new pod holds another.
   */
  approvalRedelivery: 912351,
  /**
   * src/workers/scheduled-trigger-run-prune.ts — one replica per retention prune.
   *
   * MOVED 912350 -> 912352 on 2026-09-05. Two moves in one, for two different
   * reasons:
   *   * off 912350, to break the measured collision with `approvalExpiry`;
   *   * past 912351, because PR #921 already claims that integer (see
   *     `approvalRedelivery` above) and the two branches touch disjoint files,
   *     so nothing but this would have stopped them merging into a fresh
   *     duplicate.
   *
   * This side moves because a duplicated tick here is a duplicated batched
   * DELETE over an append-only audit table, which is idempotent — not because
   * the other side is unsafe to move. See the `approvalExpiry` note.
   */
  scheduledTriggerRunPrune: 912352,
  /**
   * src/workers/deblock-callback-redelivery.ts — one replica per de-block
   * callback re-delivery tick.
   *
   * ⚠️ THIS OWNER HOLDS ITS KEY ACROSS OUTBOUND HTTP, unlike every other entry
   * here, and that is deliberate rather than an oversight — read the tick's
   * docblock before "fixing" it. Its selection is a pure SELECT, not an
   * `UPDATE … RETURNING`, so unlike approvalExpiry it has no row-level
   * transition to keep a second replica off the same rows; the lock is the only
   * mutual exclusion, and releasing it before the sends would let two replicas
   * move the same Planka card twice.
   *
   * The bound on the hold is therefore part of the contract: MAX_PER_RUN (10),
   * a 500 ms pace, and a tick deadline checked before every row. Planka's client
   * has a fixed 15s timeout its callers cannot override, so a hung read can
   * overshoot by one row — never by the batch.
   */
  deblockCallbackRedelivery: 912353,
  // 912354 is RETIRED (was wipSlotClaim, routes/webhooks/wip-slot.ts, removed 2026-10-13).
  // Never hand it to a new owner — an old pod mid-rollout may still be holding it.
});

/** The name of a registered advisory-lock owner. */
export type AdvisoryLockOwner = keyof typeof LOCK_KEYS;
