// A NULL deadline means "never expires". The inline form this replaces said the opposite.
import { describe, expect, it } from 'bun:test';
import { hasPassedDeadline, deadlineFromHours, DEFAULT_TTL_DAYS } from '../../src/lib/approval-deadline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { N8nApprovalRequestSchema, N8nCardApprovalSchema } from '../../src/routes/webhooks';
import { createExecutionApprovalSchema } from '../../src/routes/execution-approvals';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('hasPassedDeadline', () => {
  it('a NULL deadline has NOT passed — the whole point', () => {
    expect(hasPassedDeadline(null)).toBe(false);
    expect(hasPassedDeadline(undefined)).toBe(false);
  });

  // ⛔ THE REGRESSION THIS FILE EXISTS FOR. `new Date(null)` is epoch 0, so the previous
  // inline `new Date() > new Date(approval.expires_at)` returned TRUE for a NULL deadline and
  // made the approval permanently undecidable. Pin the coercion itself, so the bug cannot
  // return by someone "simplifying" this back to a bare comparison.
  it('does not coerce NULL to epoch 0 (the defect being fixed)', () => {
    expect(new Date(null as unknown as number).getTime()).toBe(0); // the JS behaviour, pinned
    expect(new Date() > new Date(null as unknown as number)).toBe(true); // what the old code computed
    expect(hasPassedDeadline(null)).toBe(false); // what it must compute now
  });

  // CONTROL: a function that always returns false would pass every test above. These fail it.
  it('still expires a real deadline that has passed', () => {
    expect(hasPassedDeadline(new Date(Date.now() - HOUR))).toBe(true);
    expect(hasPassedDeadline('2026-08-30T00:00:00Z')).toBe(true);
  });

  it('does not expire a deadline still in the future', () => {
    expect(hasPassedDeadline(new Date(Date.now() + HOUR))).toBe(false);
  });

  it('fails OPEN on an unparseable deadline rather than refusing the human', () => {
    expect(hasPassedDeadline('not-a-date')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE WRITE SIDE. Everything above made the READER understand NULL; none of it made NULL
// REACHABLE. Measured 2026-09-01, a month after the column was made nullable: 169 of 262
// pending approvals still carried a 24h TTL and 63 were due within 8h, because both remaining
// writers manufactured a deadline out of nothing — `body.expires_in_hours ?? 24` and
// `z.number().default(24)`. A nullable column is not a nullable API.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe('deadlineFromHours', () => {
  /** `fn()` evaluated between two clock reads: its offset from "now" is bracketed. */
  function offsetMs(fn: () => Date): { min: number; max: number } {
    const before = Date.now();
    const at = fn().getTime();
    const after = Date.now();
    return { min: at - after, max: at - before };
  }

  // ⛔ INVERTED 2026-09-02 BY EXPLICIT OPERATOR DECISION. This assertion used to read
  // "returns null when no deadline was requested — absent means absent", and the block
  // above still explains why that was right. It is NOT deleted noise: it was the spec,
  // and it is being overruled deliberately, not drifted past. See the header of
  // src/lib/approval-deadline.ts for the numbers the operator was shown (794 pending
  // NULL-expiry rows, 791 with a callback_path, 297 of them restored by migration 106).
  // If the decision is ever reversed, this is the assertion to restore first.
  it('an absent deadline now takes DEFAULT_TTL_DAYS, not null', () => {
    for (const absent of [undefined, null]) {
      const o = offsetMs(() => deadlineFromHours(absent));
      expect(o.min).toBeLessThanOrEqual(DEFAULT_TTL_DAYS * DAY);
      expect(o.max).toBeGreaterThanOrEqual(DEFAULT_TTL_DAYS * DAY);
    }
    // ⭐ AND IT IS A REAL DEADLINE, NOT A SENTINEL — it must be in the future, or the change is inert.
    expect(hasPassedDeadline(deadlineFromHours(null))).toBe(false);
  });

  // ⭐ THE MUTANT THIS KILLS: restoring `hours ?? 24`, or writing `!hours` instead of
  // `hours == null`. Both make an EXPLICIT 0 mean something the caller did not say — one turns
  // it into a day, the other into "no deadline". 0 hours is a caller asking for an immediate
  // deadline, and it is not this function's job to overrule them.
  it('honours an explicit 0 rather than treating it as absent', () => {
    const o = offsetMs(() => deadlineFromHours(0));
    expect(o.min).toBeLessThanOrEqual(0);
    expect(o.max).toBeGreaterThanOrEqual(0);
  });

  it('still builds a real deadline when one IS requested', () => {
    for (const hours of [24, 48]) {
      const o = offsetMs(() => deadlineFromHours(hours));
      expect(o.min).toBeLessThanOrEqual(hours * HOUR);
      expect(o.max).toBeGreaterThanOrEqual(hours * HOUR);
    }
  });

  // CONTROL: a function that always returned null would pass the first test and nothing else.
  // Paired with the round-trip below, the reader and the writer are pinned against each other.
  it('round-trips with hasPassedDeadline — the reader and writer must never disagree', () => {
    expect(hasPassedDeadline(deadlineFromHours(-1))).toBe(true);
    expect(hasPassedDeadline(deadlineFromHours(1))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE THREE WRITERS. `deadlineFromHours` being correct proves nothing if a write path does not
// call it — and that is precisely the shape of the bug: #900 fixed ONE of three writers and the
// other two kept inventing deadlines for a month while the reader, the column and the migration
// were all correct. These assertions are about REACHABILITY, not arithmetic.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe('the write paths that can mint a deadline', () => {
  it('no writer schema manufactures a default TTL', () => {
    // Parsing a minimal payload must leave the field ABSENT. A `.default(24)` anywhere here
    // makes NULL unreachable through the API no matter what the column allows.
    expect(
      N8nApprovalRequestSchema.parse({
        fr_project_id: '00000000-0000-4000-8000-000000000001',
        card_id: 'c-1', card_name: 'n', reason: 'r', callback_path: 'p',
        required_approvers: [{ user_id: '00000000-0000-4000-8000-000000000002' }],
      }).deadline_hours,
    ).toBeUndefined();

    expect(
      N8nCardApprovalSchema.parse({ card_id: 'c-1', card_name: 'n', reason: 'r' }).deadline_hours,
    ).toBeUndefined();

    expect(
      createExecutionApprovalSchema.parse({
        card_id: 'c-1', boardId: 'b-1', metadata: { boardId: 'b-1', doingListId: 'd-1' },
      }).expires_in_hours,
    ).toBeUndefined();
  });

  // ⭐ THE MUTANT THIS EXISTS FOR: restoring `?? 24` at a CALL SITE. The schemas above would
  // still parse to undefined and every arithmetic test above would still pass, because the
  // default would be re-applied one line later — which is exactly what
  // `const expiresHours = body.expires_in_hours ?? 24` did for a month after the column was
  // made nullable. Reachability has to be asserted where the Date is actually constructed.
  it('every card-blocking writer constructs its deadline through deadlineFromHours', () => {
    const src = (p: string) => readFileSync(join(import.meta.dir, '..', '..', 'src', p), 'utf8');
    for (const p of ['routes/webhooks.ts', 'routes/execution-approvals.ts']) {
      const body = src(p)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect({ file: p, uses: body.includes('deadlineFromHours(') }).toEqual({ file: p, uses: true });
      // The two shapes that reintroduce the defect, in code rather than in prose.
      expect({ file: p, coalesce: /expires_in_hours\s*\?\?\s*\d/.test(body) })
        .toEqual({ file: p, coalesce: false });
      expect({ file: p, zodDefault: /deadline_hours:\s*z\.number\(\)\.default\(/.test(body) })
        .toEqual({ file: p, zodDefault: false });
      // ⭐ webhooks.ts has TWO card-blocking writers, so "the helper is imported somewhere in
      // this file" is not enough — deleting the call at ONE site leaves the other and the
      // check above still passes. These pin the two hand-rolled shapes that actually existed,
      // so a call site that goes back to building the Date itself is caught wherever it is.
      expect({ file: p, handRolled: /expiresAt\s*=\s*new Date\(\)/.test(body) })
        .toEqual({ file: p, handRolled: false });
      expect({ file: p, setHours: /expiresAt\.setHours\(/.test(body) })
        .toEqual({ file: p, setHours: false });
    }
  });
});
