// A NULL deadline is not an expired one.
//
// `approvals.expires_at` is nullable (backend migration 105): NULL means "no
// deadline, ever", because a card-blocking approval must not expire. The
// approvals queue did a bare `new Date(expiresAt)`, and `new Date(null)` is
// epoch 0 — so every NULL row rendered a red danger clock reading "Expired".
//
// Production, 2026-09-06: 712 of 1,083 approved rows. Confined to the Approved
// tab today only because migration 107 backfilled the pending ones — its own
// header records that population at 794 PENDING rows on 2026-09-02, i.e. rows
// humans were being asked to act on.
//
// The frontend type said `expires_at: string | Date` (non-nullable) while the
// column has no `.notNull()`, which is exactly why tsc never objected.

import { describe, expect, it } from 'vitest';
import { formatExpiration } from './expiration';

const DAY = 86_400_000;

describe('formatExpiration — a NULL deadline is not an expired one', () => {
  it('renders NULL as "No deadline", NOT as expired', () => {
    const got = formatExpiration(null);
    // Fails on THIS assertion (true !== false) when the null guard is removed:
    // new Date(null) is epoch 0, so isExpired computes true.
    expect(got.isExpired).toBe(false);
    expect(got.text).toBe('No deadline');
    expect(got.isExpiringSoon).toBe(false);
  });

  it('renders undefined the same way', () => {
    expect(formatExpiration(undefined)).toEqual({
      text: 'No deadline',
      isExpired: false,
      isExpiringSoon: false,
    });
  });

  it('an unparseable value is not "expired" either', () => {
    expect(formatExpiration('not-a-date').isExpired).toBe(false);
  });

  // ── the real deadlines must keep working — this is the control ──────────
  it('still flags a genuinely past deadline as Expired', () => {
    const got = formatExpiration(new Date(Date.now() - 3 * DAY));
    expect(got.isExpired).toBe(true);
    expect(got.text).toBe('Expired');
  });

  it('still flags a near deadline as expiring soon', () => {
    const got = formatExpiration(new Date(Date.now() + 1.5 * DAY));
    expect(got.isExpired).toBe(false);
    expect(got.isExpiringSoon).toBe(true);
  });

  it('a far deadline is neither expired nor soon', () => {
    const got = formatExpiration(new Date(Date.now() + 30 * DAY));
    expect(got.isExpired).toBe(false);
    expect(got.isExpiringSoon).toBe(false);
    expect(got.text.startsWith('Expires ')).toBe(true);
  });

  it('accepts an ISO string, not only a Date', () => {
    expect(formatExpiration(new Date(Date.now() - DAY).toISOString()).isExpired).toBe(true);
  });
});
