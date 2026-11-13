// tests/unit/routes/dashboard-identity.test.ts
//
// #1037 — routes/dashboard.ts compared a Keycloak `sub` (UUID) against a
// Planka `user_account.id` (snowflake integer) in two places. Neither
// comparison could ever be true, so `GET /api/cards?assignee=me` was
// permanently empty and `/api/activity` permanently rendered raw UUIDs.
//
// ⚠️ WHAT THESE TESTS ASSERT, AND WHY IT IS NOT THE ROW COUNT. The estate
// holds exactly ONE `kanban.card_membership` row and it belongs to a bot, so
// a CORRECTLY fixed `assignee=me` still returns zero rows for every human
// today. A test that asserted "returns empty" would pin the bug as the spec,
// and a test that asserted "returns rows" could not be made to pass at all.
// The property under test is therefore THE ID SPACE OF THE COMPARISON — which
// operand is compared against which — not the result set. Each fixture below
// deliberately contains BOTH id shapes so that a comparison made in the wrong
// space produces a different, assertable answer rather than merely an empty
// one.
//
// Scope: the pure membership fold `selectMyCardIds` (behavioural) and a
// structural pin on `routes/dashboard.ts` that the handler feeds it the
// RESOLVED Planka id. The Keycloak/Planka lookups themselves need live
// services and are verified live, not here.
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectMyCardIds } from '../../../src/routes/dashboard';

// ---------------------------------------------------------------------------
// Fixtures. The literal shapes matter: a UUID for anything fr-side, a
// snowflake integer for anything Planka-side. Values are the real shapes
// measured in the estate on 2026-09-08.
// ---------------------------------------------------------------------------

/** Keycloak `sub` of the calling user — what `validateAuth` puts in `user.id`. */
const CALLER_SUB = '32969c16-6ecd-49fe-a106-ba13e6640dc8';
/** The SAME person's Planka `user_account.id`. Nothing derives one from the other. */
const CALLER_PLANKA_ID = '1560328737491256322';

// ---------------------------------------------------------------------------
// assignee=me. Broken but LATENT: a correct fix also returns zero rows today,
// so every assertion here is about the operand, not the result.
// ---------------------------------------------------------------------------

describe('selectMyCardIds compares memberships in the PLANKA id space', () => {
  // Both id shapes are present in the SAME fixture. A comparison made in the
  // wrong space therefore returns a DIFFERENT card, not an empty set — which
  // is what makes this assertable at all given the estate has one live
  // membership row.
  const MEMBERSHIPS = [
    { userId: CALLER_PLANKA_ID, cardId: 'card-selected-by-planka-id' },
    { userId: CALLER_SUB, cardId: 'card-selected-by-raw-sub' },
    { userId: '1560278692305830913', cardId: 'card-of-someone-else' },
  ];

  test('the membership comparison input is the mapped Planka id', () => {
    const selected = selectMyCardIds(MEMBERSHIPS, CALLER_PLANKA_ID);

    expect([...selected]).toEqual(['card-selected-by-planka-id']);
  });

  test('a raw sub as the operand selects the WRONG card — the pre-fix behaviour', () => {
    // Not a spec for the endpoint: a demonstration that the fixture can tell
    // the two id spaces apart, so the assertion above is not vacuous. If both
    // operands gave the same answer, that test would prove nothing.
    const selected = selectMyCardIds(MEMBERSHIPS, CALLER_SUB);

    expect([...selected]).toEqual(['card-selected-by-raw-sub']);
  });

  test('an unmapped caller selects nothing and does not fall back to the raw sub', () => {
    const selected = selectMyCardIds(MEMBERSHIPS, undefined);

    expect([...selected]).toEqual([]);
  });
});

describe('the handler wires the RESOLVED id into the comparison', () => {
  // A structural pin, and labelled as one. The membership filter sits inside
  // a loop guarded by a `streams` query and a real `listCardsByList` import,
  // neither of which can be substituted without `mock.module()` (banned), so
  // the one-line wiring `selectMyCardIds(memberships, callerPlankaUserId)` is
  // not reachable behaviourally from a unit test. This asserts on the actual
  // source file — not a copy — so the exact revert it guards against does
  // fail it.
  // Comment lines are stripped first: this file's own docblock QUOTES the
  // broken comparison in order to explain it, and a naive substring search
  // would match that explanation and red on a correct file.
  const CODE_LINES = readFileSync(
    join(import.meta.dir, '../../../src/routes/dashboard.ts'),
    'utf8',
  )
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });

  test('the resolved Planka id, not user.id, is the filter operand', () => {
    const wiring = CODE_LINES.filter((l) =>
      l.includes('selectMyCardIds(memberships, callerPlankaUserId)'),
    );
    // Non-vacuity: the correct call must exist for the offending-pattern check
    // below to mean anything. No count of the call sites is pinned.
    expect(wiring.length).toBeGreaterThan(0);

    // The unsatisfiable comparison #1037 is about, in either spelling.
    const offending = CODE_LINES.filter((l) =>
      /m\.userId\s*===\s*user\.id|selectMyCardIds\([^)]*,\s*user\.id\s*\)/.test(l),
    );
    expect(offending).toEqual([]);
  });
});
