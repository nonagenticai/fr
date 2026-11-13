// Expiration rendering for the approvals queue.
//
// Extracted from `+page.svelte` so it can be tested directly — following the
// same convention as `routes/(admin)/admin/(platform)/licenses/page-helpers.ts`.
// It was inline and untestable, which is part of why the NULL defect below
// survived: nothing could assert on it without rendering the page.

/** NULL/undefined = "no deadline, ever" (backend migration 105). */
export type ExpiresAt = string | Date | null | undefined;

export interface ExpirationDisplay {
  text: string;
  isExpired: boolean;
  isExpiringSoon: boolean;
}

/**
 * ⛔ THE NULL CASE IS THE WHOLE POINT.
 *
 * `approvals.expires_at` is nullable since backend migration 105, where NULL
 * means "no deadline, ever" — a card-blocking approval must not expire. This
 * function used to do a bare `new Date(expiresAt)`, and `new Date(null)` is
 * epoch 0, so every NULL row computed a hugely negative diff and rendered as a
 * red danger clock reading "Expired".
 *
 * Measured in production 2026-09-06: 712 of 1,083 approved rows. It is
 * currently confined to the Approved tab only because migration 107 backfilled
 * the pending ones — that same migration's header records the population at
 * 794 PENDING rows on 2026-09-02, i.e. rows humans were being asked to decide.
 *
 * The backend never had this bug: `lib/approval-deadline.ts::hasPassedDeadline`
 * guards `== null`, and the expiry worker compares in SQL where NULL is simply
 * skipped. `db/schema.ts` warns about this exact mistake directly above the
 * column. Only the UI read NULL as a date.
 */
export function formatExpiration(expiresAt: ExpiresAt): ExpirationDisplay {
  if (expiresAt === null || expiresAt === undefined) {
    return { text: 'No deadline', isExpired: false, isExpiringSoon: false };
  }

  const date = new Date(expiresAt);
  // An unparseable value is not "expired" either — NaN comparisons are all
  // false, but the negative-diff branch would otherwise be reached via NaN < 0
  // being false, so state it explicitly rather than relying on that.
  if (Number.isNaN(date.getTime())) {
    return { text: 'No deadline', isExpired: false, isExpiringSoon: false };
  }

  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  const isExpired = diffMs < 0;
  const isExpiringSoon = diffDays >= 0 && diffDays <= 2;

  if (isExpired) {
    return { text: 'Expired', isExpired: true, isExpiringSoon: false };
  } else if (diffDays === 0) {
    return { text: 'Expires today', isExpired: false, isExpiringSoon: true };
  } else if (diffDays === 1) {
    return { text: 'Expires tomorrow', isExpired: false, isExpiringSoon: true };
  } else if (diffDays <= 2) {
    return { text: `Expires in ${diffDays} days`, isExpired: false, isExpiringSoon: true };
  }
  return {
    text: `Expires ${date.toLocaleDateString()}`,
    isExpired: false,
    isExpiringSoon: false,
  };
}
