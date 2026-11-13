// backend/src/lib/approval-deadline.ts
//
// A CARD-BLOCKING APPROVAL MUST NOT EXPIRE, AND `null` IS HOW IT SAYS SO.
//
// There is no approval-expiration requirement anywhere in the AA specification. Measured
// 2026-08-31: `grep -ci expir` returns 0 across all nine documents in
// `n8n_custom_nodes/AA_IMPLEMENTATION/` — PHILOSOPHY, GOVERNANCE, SPEC, BACKLOG,
// PRODUCTION_READINESS, RECURSIVE_DECOMPOSITION_SPEC, READYING_REDESIGN, IT_MVP_SUBSPEC,
// ACTIVITY_PATTERNS. PHILOSOPHY defines BLOCKED as the "Human-input gate: requests for input,
// decisions, approvals" — BLOCKED *is* the wait state, so a deadline on it is the defect.
// The 24h that produced 435 expiries came from a single `z.number().default(24)` on the
// webhook schema; `blocked-escalate.json :: Call FR` never sent a deadline at all.
//
// ⛔ WHY THIS IS A NAMED FUNCTION AND NOT AN INLINE COMPARISON. The inline form was
//     if (new Date() > new Date(approval.expires_at))
// and `new Date(null)` is **epoch 0, not Invalid Date**. So a NULL deadline coerces to
// 1970 and `now > 1970` is TRUE: making the column nullable without this change would have
// turned "never expires" into "permanently undecidable" — strictly worse than the 24h TTL it
// replaces, because the row is dead on arrival instead of after a day. SQL's three-valued
// logic makes the reaper's `expires_at <= now()` skip NULL correctly all by itself; JS does
// the exact opposite, and that asymmetry is the whole reason this file exists.
//
// Mirrors `workers/approval-expiry.ts`'s predicate deliberately: the reaper decides what
// EXPIRES, this decides what is REFUSED as expired, and the two must never disagree.

/**
 * True when the approval carries a deadline AND that deadline has passed.
 *
 * @param expires_at the stored deadline, or `null` meaning "no deadline, ever".
 */
export function hasPassedDeadline(
  expires_at: Date | string | null | undefined,
): boolean {
  const now = new Date();
  // `== null` catches both null and undefined, and deliberately NOT `!expires_at` —
  // that would also swallow the epoch-0 Date this function exists to keep out.
  if (expires_at == null) return false;
  const deadline = expires_at instanceof Date ? expires_at : new Date(expires_at);
  // An unparseable deadline is not a licence to refuse: fail OPEN toward the human, and
  // let the reaper (which compares in Postgres) be the authority on expiry.
  if (Number.isNaN(deadline.getTime())) return false;
  return now > deadline;
}

/**
 * The WRITE side of the same rule, and the reason it lives next to its reader.
 *
 * ⛔ A NULLABLE COLUMN IS NOT A NULLABLE API. Migration 105 made `expires_at` nullable and
 * `hasPassedDeadline` above taught the reader what NULL means — and 132 card-blocking approvals
 * kept expiring anyway, because both writers still manufactured a deadline out of nothing:
 * `body.expires_in_hours ?? 24` in routes/execution-approvals.ts and `z.number().default(24)`
 * on the routes/webhooks.ts schema. NULL was not expressible through either. Measured
 * 2026-09-01: 169 of 262 pending approvals still carried a 24h TTL, 63 of them due within 8h,
 * against 93 that reached NULL only because ONE writer (webhooks.ts's escalate path) happened
 * to omit the column entirely.
 *
 * ⭐ "No deadline requested" and "a deadline of zero hours" are different answers, so this takes
 * `null | undefined` rather than a falsy check: `hours ?? 24` and `!hours` both silently turn an
 * explicit 0 into something else.
 *
 * @param hours the caller's requested TTL, or null/undefined for "no deadline, ever".
 */
/**
 * ── 2026-09-02: DEFAULT_TTL_DAYS ADDED BY EXPLICIT OPERATOR DECISION ─────────────────
 *
 * ⛔ READ THIS BEFORE "RESTORING" THE null RETURN. Everything above is still an accurate
 * description of why NULL was correct, and it was not deleted or softened. It is
 * OVERRIDDEN, knowingly, by an operator who was shown the conflict twice and confirmed
 * both times. Recording it as a decision rather than letting the code silently contradict
 * its own header.
 *
 * WHAT THE OPERATOR WAS TOLD, MEASURED ON PRODUCTION 2026-09-02:
 *   794  pending approvals with expires_at IS NULL
 *   791  of those carry a callback_path — so the reaper fires 791 sendN8nExpiryCallback
 *        invocations when they mature, into an n8n instance already the subject of a
 *        232 GB/day WAL incident
 *   297  of those are rows migration 106 DELIBERATELY restored to NULL, whose header says
 *        "without this the reaper would re-expire every restored row on its very next tick"
 *
 * ⚠️ AND ONE FACT THAT CHANGED UNDER THE DECISION: the premise was "the queue only grows".
 * It no longer does — 729 approvals were decided in the 24h to 2026-09-02 (approved
 * 354 -> 1083) while pending fell 1069 -> 794. If this is ever revisited, revisit it on
 * that number, not on the original one.
 *
 * ⛔ THE FOUR WRITERS THAT ALREADY MANUFACTURE A 24h TTL ARE NOT TOUCHED HERE and are NOT
 * the source of the NULLs: routes/approvals.ts:784, routes/improvement-approvals.ts:181,
 * domain/engagement/action-approvals.ts:195, domain/bridge/submit.ts:147. The NULLs come
 * through THIS helper. Changing it is a one-file change; changing those four would be a
 * different decision about a different population.
 */
export const DEFAULT_TTL_DAYS = 14;

export function deadlineFromHours(
  hours: number | null | undefined,
): Date {
  const now = new Date();
  // ⚠️ The return type is no longer `| null`. That is deliberate and is the whole change:
  // TypeScript will now surface every call site that still branches on a null deadline,
  // rather than letting "no deadline" quietly become epoch 0 at some reader — which is the
  // exact failure `hasPassedDeadline` above exists to prevent.
  if (hours == null) return new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}
