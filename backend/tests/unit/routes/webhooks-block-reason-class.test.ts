// tests/unit/routes/webhooks-block-reason-class.test.ts
//
// ncn#1956: the coordinator tripwire counts PENDING approvals by block class
// (`metadata->>'block_reason_class'`). ncn's Blocked Escalate computes the class; fr's
// closed `N8nCardApprovalSchema` stripped it. Both halves are pinned here:
//
//   SCHEMA half  — the key is accepted, normalised, and the object stays CLOSED.
//   PERSIST half — the card-approval mint spreads it into metadata, truthiness-gated.
//
// The persist half is a SOURCE assertion: the mint sits behind a database
// and a shared-secret webhook, and the route has no injected-insert seam, so a source
// window bounded inside `handleN8nCardApproval` is the only form that runs in CI without
// Postgres. MUTANT (measured): delete the spread → the persist tests go RED.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { N8nCardApprovalSchema } from '../../../src/routes/webhooks';

const base = { card_id: 'card-1', card_name: 'Ship it', reason: 'blocked', boardId: 'board-1' };

describe('block_reason_class — schema half', () => {
  test('the class is accepted and preserved', () => {
    const parsed = N8nCardApprovalSchema.parse({ ...base, block_reason_class: 'upstream_run_failure' });
    expect(parsed.block_reason_class).toBe('upstream_run_failure');
  });

  test('omitting it parses and the key is ABSENT, not null and not "undefined"', () => {
    const parsed = N8nCardApprovalSchema.parse(base) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'block_reason_class')).toBe(false);
  });

  test('the value is normalised to a lowercase token, not refused', () => {
    // Failure direction: an odd-cased class must still reach the tripwire, never 400 the
    // escalation and strand the card with no approval at all.
    const parsed = N8nCardApprovalSchema.parse({ ...base, block_reason_class: '  Upstream_Run_Failure ' });
    expect(parsed.block_reason_class).toBe('upstream_run_failure');
  });

  test('an unknown class is accepted — no vocabulary validation at the door', () => {
    const parsed = N8nCardApprovalSchema.parse({ ...base, block_reason_class: 'a_class_fr_never_heard_of' });
    expect(parsed.block_reason_class).toBe('a_class_fr_never_heard_of');
  });

  test('over 100 chars and non-strings are refused', () => {
    expect(() => N8nCardApprovalSchema.parse({ ...base, block_reason_class: 'x'.repeat(101) })).toThrow();
    expect(() => N8nCardApprovalSchema.parse({ ...base, block_reason_class: 42 })).toThrow();
  });

  test('the schema stays CLOSED — the near-miss key `reason_class` and junk are stripped', () => {
    // MUTANT: `.passthrough()` on N8nCardApprovalSchema turns this RED. `reason_class` is
    // deliberately NOT an alias: no producer on ncn origin/main sends it.
    const parsed = N8nCardApprovalSchema.parse({
      ...base,
      reason_class: 'upstream_run_failure',
      totally_unvalidated: { nested: 'junk' },
    }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'reason_class')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'totally_unvalidated')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'block_reason_class')).toBe(false);
  });
});

describe('block_reason_class — persist half (card-approval mint)', () => {
  const src = readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'routes', 'webhooks.ts'), 'utf8');
  const PERSIST =
    '...(validated.block_reason_class ? { block_reason_class: validated.block_reason_class } : {})';

  // Window bounded at BOTH ends strictly inside door two (a byte-zero-anchored
  // window was vacuous).
  const doorIdx = src.indexOf('export async function handleN8nCardApproval');
  // The door mints through mintGateOnePerBugCard (U3 strict marked dedupe; unmarked = mintOneOpenGate).
  const mintIdx = src.indexOf('await mintGateOnePerBugCard(', doorIdx);

  test('the window anchors resolve', () => {
    expect(doorIdx).toBeGreaterThan(0);
    expect(mintIdx).toBeGreaterThan(doorIdx);
  });

  test('the class is spread into the approval metadata BEFORE the mint', () => {
    expect(src.slice(doorIdx, mintIdx)).toContain(PERSIST);
  });

  test('the spread is truthiness-gated — no unconditional null/undefined write', () => {
    expect(src).not.toContain('block_reason_class: validated.block_reason_class ?? null');
    expect(src).not.toContain('block_reason_class: validated.block_reason_class,');
  });
});
