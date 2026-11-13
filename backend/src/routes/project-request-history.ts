// src/routes/project-request-history.ts
//
// APPENDING TO `project_requests.history` WITHOUT LOSING ENTRIES.
//
// ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────
//
// The previous helper lived in routes/project-requests.ts and was a
// read-modify-write in TypeScript:
//
//     const prior = Array.isArray(existing) ? existing : [];
//     return [...prior, entry];            // ...then UPDATE SET history = <whole array>
//
// It took the array from a row SELECTed earlier and wrote the result whole. Two
// writers that both read before either wrote produced last-writer-wins: one
// transition vanished from the audit trail, leaving a status change with no
// record of who made it or why. Nothing failed, nothing logged.
//
// MEASURED 2026-09-21 against postgres 18, two writers on one row:
//   read-modify-write  -> 1 entry survives  [{"action":"user_edit"}]
//   SQL-side append    -> 2 entries survive [{"action":"agent_outline"},
//                                            {"action":"user_edit"}]
// The entry the old path destroyed was the AGENT's, which is the one no human
// can reconstruct from memory.
//
// ── WHY IT MATTERS NOW AND DID NOT BEFORE ────────────────────────────────────
//
// It was survivable while transitions were rare and every one came from a human
// clicking in a browser: six append sites, a table nobody drives concurrently.
// The two-stage lifecycle adds five states AND an inbound agent callback, so
// "an agent posts an outline while the requester edits the draft" stops being
// the unlucky case and becomes the ordinary one.
//
// ⚠️ This is NOT a hypothetical hardening. It is a defect that was already
// present and already silent; the lifecycle work is what makes it fire.
//
// Kept in its own module so it can be tested without importing the route file,
// which pulls in the database client and half the service layer. A helper that
// can only be exercised through a handler is a helper nobody exercises.

import { sql, type SQL } from 'drizzle-orm';
import { projectRequests } from '../db/schema';

/** One entry in the request's audit trail. */
export type HistoryEntry = {
  at: string;
  action: string;
  by?: string | null;
  from_status?: string;
  detail?: string;
};

/**
 * Build `history = history || '[…]'::jsonb` for an UPDATE ... SET.
 *
 * Postgres does the concatenation against the row it holds the lock on, so
 * neither writer needs to have seen the other, and no caller needs to have
 * SELECTed the current value first.
 *
 * ⚠️ The `coalesce` is for legacy rows only — the column is NOT NULL DEFAULT
 * '[]' — but `NULL || anything` is NULL in SQL, so without it a single bad row
 * would ERASE its own history rather than fail loudly. A silent erase is the
 * failure mode this whole module exists to remove; it would be careless to
 * reintroduce it in the fix.
 *
 * Variadic because one transition can legitimately record two facts (a
 * promotion and the CommonPractice feedback that followed it), and they belong
 * in ONE statement — two statements are two chances to interleave.
 */
export function appendHistorySql(...entries: HistoryEntry[]): SQL<unknown> {
  return sql`coalesce(${projectRequests.history}, '[]'::jsonb) || ${JSON.stringify(
    entries,
  )}::jsonb`;
}
