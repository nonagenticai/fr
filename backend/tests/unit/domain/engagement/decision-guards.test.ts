// tests/unit/domain/engagement/decision-guards.test.ts
//
// Pure predicate tests for domain/engagement/decision-guards.ts — the shared
// functions `routes/approvals.ts`, `routes/teams-webhook.ts` and
// `routes/telegram-webhook.ts` all call so a change to the rule cannot drift
// into three copies. No db, no request. The
// DB-bound per-seat discriminating cases were the chat-seat-guard-parity
// integration suite, deleted 2026-10-29 under the no-test-doubles ruling —
// no longer in the suite.

import { evaluateRosterQuorum } from '../../../../src/services/approval-consensus';
import { test, expect, describe } from 'bun:test';
import {
  isRequesterDecidingOwnApproval,
  selectDischargedRosterRow,
} from '../../../../src/domain/engagement/decision-guards';

describe('isRequesterDecidingOwnApproval', () => {
  test('true when the decider IS the requester', () => {
    expect(isRequesterDecidingOwnApproval('user-1', 'user-1')).toBe(true);
  });
  test('false when the decider differs from the requester', () => {
    expect(isRequesterDecidingOwnApproval('user-1', 'user-2')).toBe(false);
  });
  test('false when the requester is null (n8n / KAG worker ingest) — nothing to compare', () => {
    expect(isRequesterDecidingOwnApproval(null, 'user-1')).toBe(false);
  });
  test('false when the requester is undefined', () => {
    expect(isRequesterDecidingOwnApproval(undefined, 'user-1')).toBe(false);
  });

  // Mutation control: pin the actual comparison, not merely its truth table shape.
  // A mutant that always returns `true` (or always `false`) would still satisfy a
  // suite that only checked one branch each; asserting BOTH true and false cases
  // is what makes the mutant below observable.
  test('mutation control: an always-true stub fails the negative case', () => {
    const mutant = (_r: string | null | undefined, _d: string): boolean => true;
    expect(mutant('user-1', 'user-2')).not.toBe(isRequesterDecidingOwnApproval('user-1', 'user-2'));
  });
});

describe('selectDischargedRosterRow', () => {
  const rowA = { id: 'roster-a', user_id: 'user-a' };
  const rowB = { id: 'roster-b', user_id: 'user-b' };
  const rowUnnamed = { id: 'roster-c', user_id: null };

  test('prefers a row that names the caller directly', () => {
    const chosen = selectDischargedRosterRow([rowB, rowA], [], 'user-a');
    expect(chosen?.id).toBe('roster-a');
  });

  // ⛔ fr#1059 (George's ruling "role slot"): the "any open row, then any row" fallback is the
  // OVERRIDE arm only — the HTTP seat passes `{ override: true }` for its super-admin and
  // solo-tenant-god callers. Each override test below is paired with its non-override
  // counterpart: a caller with no claim (not named, no held role) gets `undefined`, and the
  // seat refuses. These tests pinned the old UNCONDITIONAL fallback before fr#1059.
  test('OVERRIDE: falls back to any row not already discharged when no row names the caller', () => {
    const chosen = selectDischargedRosterRow(
      [rowA, rowB],
      [{ required_approver_id: 'roster-a' }],
      'role-holder-not-on-roster',
      [],
      { override: true },
    );
    expect(chosen?.id).toBe('roster-b');
  });

  test('NO OVERRIDE: a caller neither named nor holding a role gets undefined (fr#1059)', () => {
    const chosen = selectDischargedRosterRow(
      [rowA, rowB],
      [{ required_approver_id: 'roster-a' }],
      'role-holder-not-on-roster',
    );
    expect(chosen).toBeUndefined();
    // and an explicit `override: false` is the same as omitting it
    expect(
      selectDischargedRosterRow([rowA, rowB], [], 'role-holder-not-on-roster', [], { override: false }),
    ).toBeUndefined();
  });

  test('OVERRIDE: falls back to an already-discharged row as a defined last resort', () => {
    const chosen = selectDischargedRosterRow(
      [rowA],
      [{ required_approver_id: 'roster-a' }],
      'someone-else',
      [],
      { override: true },
    );
    expect(chosen?.id).toBe('roster-a');
  });

  test('NO OVERRIDE: no last-resort already-discharged row for a caller with no claim', () => {
    const chosen = selectDischargedRosterRow(
      [rowA],
      [{ required_approver_id: 'roster-a' }],
      'someone-else',
    );
    expect(chosen).toBeUndefined();
  });

  test('returns undefined for an empty candidate set (card-approval flow, no roster)', () => {
    expect(selectDischargedRosterRow([], [], 'user-a')).toBeUndefined();
    expect(selectDischargedRosterRow([], [], 'user-a', [], { override: true })).toBeUndefined();
  });

  test('OVERRIDE: an unnamed row (user_id null) is still a valid discharge target', () => {
    const chosen = selectDischargedRosterRow([rowUnnamed], [], 'user-a', [], { override: true });
    expect(chosen?.id).toBe('roster-c');
  });

  test('NO OVERRIDE: an unnamed, role-less row is NOT dischargeable by an arbitrary caller', () => {
    expect(selectDischargedRosterRow([rowUnnamed], [], 'user-a')).toBeUndefined();
  });

  test('NO OVERRIDE: a held-role row IS dischargeable — the role slot (fr#1059)', () => {
    // The row names user-a; the caller is not user-a but holds the row's role.
    const slot = { id: 'roster-slot', user_id: 'user-a', role: 'execution_signoff' };
    expect(
      selectDischargedRosterRow([slot], [], 'user-x', ['execution_signoff'])?.id,
    ).toBe('roster-slot');
    // ...and the same caller WITHOUT the role is refused.
    expect(selectDischargedRosterRow([slot], [], 'user-x', ['card_approver'])).toBeUndefined();
  });

  // Mutation control: pin the ORDER of preference, not just "some row comes back".
  // Reversing the preference (already-discharged before not-yet-discharged) would
  // pick roster-a here instead of roster-b, and a suite asserting only "a row was
  // returned" would not notice.
  test('mutation control: preference order is load-bearing', () => {
    const wrongOrderPick = [rowA, rowB].find((r) =>
      [{ required_approver_id: 'roster-a' }].map((d) => d.required_approver_id).includes(r.id),
    );
    const rightPick = selectDischargedRosterRow(
      [rowA, rowB],
      [{ required_approver_id: 'roster-a' }],
      'role-holder-not-on-roster',
      [],
      { override: true },
    );
    expect(rightPick?.id).toBe('roster-b');
    expect(wrongOrderPick?.id).not.toBe(rightPick?.id);
  });
});

// ── fr#1237: WHICH obligation, WHEN MORE THAN ONE MATCHES ────────────────────────
//
// ⛔ WHY EVERY FIXTURE BELOW SEEDS TWO OR MORE MATCHING OBLIGATIONS. A single-row
// roster cannot distinguish ANY selection rule from any other — `[only]` is the
// answer to all of them — so a one-row fixture would go green against the exact
// `.find()`/`[0]` code this rung set replaces. This lane has already shipped that
// mistake once: a control seeded `[…0001, …dead]` where `'0' < 'd'`, so the
// INSERTION order already WAS the sorted order, and reverting the fix left the
// suite green.
//
// ⭐ SO EVERY ID PAIR HERE IS CHOSEN SO THAT THE ORDER UNDER TEST AND THE ORDER THE
// OLD CODE USED GIVE DIFFERENT ANSWERS, and each test says which pair it is pinning.
describe('selectDischargedRosterRow — fr#1237 discharge order', () => {
  // ⛔ THESE ARE `required_approvers.role` VALUES, WHICH IS FREE TEXT — not the
  // CHECK-constrained `user_roles.role` vocabulary. An earlier revision of this block
  // seeded `workspace-admin` / `workspace-member` here, which is a THIRD vocabulary that
  // never appears in this column (measured on production `fr` 2026-09-27: the
  // intersection of `required_approvers.role` with `user_roles.role` is 0 rows, against a
  // non-zero control of 13 `user_roles` rows) — so the fixture was testing a shape that
  // cannot occur. These two are the real column's top two values (3730 and 915 rows), and
  // they are also realm roles `approverIdentityFilter` matches on, so `callerRoles`
  // holding them is the production shape too. See `selectDischargedRosterRow`'s docblock
  // for all three vocabularies named apart.
  const SIGNOFF = 'execution_signoff';
  const CARD = 'card_approver';

  // ⭐ THE ID PAIR IS THE POINT. `ra-0001-card` < `ra-ffff-signoff` lexically, so the
  // card_approver row is FIRST both in the array as passed AND under the `id` tie-break.
  // Nothing but the held-role rung can return the execution_signoff row, which is what
  // makes that rung observable rather than coincidentally satisfied by the sort.
  const cardObligation = { id: 'ra-0001-card', user_id: 'ghost-subject-1', role: CARD };
  const signoffObligation = { id: 'ra-ffff-signoff', user_id: 'ghost-subject-2', role: SIGNOFF };
  const CALLER = 'caller-not-named-on-the-roster';

  test('prefers the obligation naming a role the caller ACTUALLY HOLDS', () => {
    const chosen = selectDischargedRosterRow(
      [cardObligation, signoffObligation],
      [],
      CALLER,
      [SIGNOFF],
    );
    expect(chosen?.id).toBe('ra-ffff-signoff');
  });

  test('DISCRIMINATING PAIR: the same two rows, a caller holding the OTHER role', () => {
    // Same candidate set, same order, only the held role differs — so a mutant that
    // ignores `callerRoles` cannot satisfy both halves.
    const asSignoff = selectDischargedRosterRow(
      [cardObligation, signoffObligation],
      [],
      CALLER,
      [SIGNOFF],
    );
    const asCard = selectDischargedRosterRow(
      [cardObligation, signoffObligation],
      [],
      CALLER,
      [CARD],
    );
    expect(asSignoff?.id).toBe('ra-ffff-signoff');
    expect(asCard?.id).toBe('ra-0001-card');
    expect(asSignoff?.id).not.toBe(asCard?.id);
  });

  test('a role the caller does NOT hold is not a preference, however real the role is', () => {
    // `tech_lead` is a value `required_approvers.role` CAN legitimately hold — it is the
    // schema's own example at db/schema.ts:1384, and the column is unconstrained TEXT. It
    // is simply not a role THIS caller's realm claim carries. A rung that matched "has a
    // role at all" rather than "has a role I hold" would pick it.
    const techLead = { id: 'ra-0000-tech', user_id: 'ghost-3', role: 'tech_lead' };
    const chosen = selectDischargedRosterRow([techLead, signoffObligation], [], CALLER, [SIGNOFF]);
    expect(chosen?.id).toBe('ra-ffff-signoff');
  });

  test('OVERRIDE: rung 2 only ever picks an UNDISCHARGED row', () => {
    // The execution_signoff row is the caller's role match AND already discharged, so the
    // answer must fall through (override arm) to the undischarged card_approver row.
    const chosen = selectDischargedRosterRow(
      [cardObligation, signoffObligation],
      [{ required_approver_id: 'ra-ffff-signoff' }],
      CALLER,
      [SIGNOFF],
      { override: true },
    );
    expect(chosen?.id).toBe('ra-0001-card');
  });

  test('NO OVERRIDE: the held-role row already discharged ⇒ undefined, never the other role (fr#1059)', () => {
    const chosen = selectDischargedRosterRow(
      [cardObligation, signoffObligation],
      [{ required_approver_id: 'ra-ffff-signoff' }],
      CALLER,
      [SIGNOFF],
    );
    expect(chosen).toBeUndefined();
  });

  test('a row naming the caller still outranks a held-role row', () => {
    // ⭐ ID PAIR: `ra-0000-role` < `ra-9999-mine`, so BOTH the array order and the id
    // sort put the role row first. Only rung 1 returns the caller's own row.
    const roleRow = { id: 'ra-0000-role', user_id: 'ghost-4', role: SIGNOFF };
    const mine = { id: 'ra-9999-mine', user_id: CALLER, role: null };
    const chosen = selectDischargedRosterRow([roleRow, mine], [], CALLER, [SIGNOFF]);
    expect(chosen?.id).toBe('ra-9999-mine');
  });

  test('`created_at` outranks `id`, and the array order is used for neither', () => {
    // ⭐ THE THREE ORDERS DELIBERATELY DISAGREE:
    //   array order     → ra-aaaa-late   (what the old `.find()` returned)
    //   id order        → ra-aaaa-late   ('a' < 'z')
    //   created_at order→ ra-zzzz-early  (Jan before Feb)  ← the only correct answer
    // So this one assertion refutes BOTH the old behaviour and an id-only sort.
    const late = {
      id: 'ra-aaaa-late',
      user_id: 'ghost-5',
      role: SIGNOFF,
      created_at: '2026-02-01T00:00:00Z',
    };
    const early = {
      id: 'ra-zzzz-early',
      user_id: 'ghost-6',
      role: SIGNOFF,
      created_at: '2026-01-01T00:00:00Z',
    };
    const chosen = selectDischargedRosterRow([late, early], [], CALLER, [SIGNOFF]);
    expect(chosen?.id).toBe('ra-zzzz-early');
  });

  test('OVERRIDE: with no `created_at` — the REAL required_approvers shape — the order is total', () => {
    // ⛔ `required_approvers` has NO timestamp column (db/schema.ts:1376-1385), so this
    // is the shape every production call actually passes. ⭐ ID PAIR: `ra-aaaa` <
    // `ra-zzzz`, and the array is seeded z-FIRST, so the old code returned `ra-zzzz`
    // here and the sorted answer is `ra-aaaa` — they differ, which is the whole test.
    // (fr#1059: neither row names CALLER nor asks for a role, so only the override arm
    // reaches the ordered fallback; the role-holder variant below pins the same order
    // without override.)
    const rowZ = { id: 'ra-zzzz', user_id: 'ghost-z' };
    const rowA = { id: 'ra-aaaa', user_id: 'ghost-a' };
    const zFirst = selectDischargedRosterRow([rowZ, rowA], [], CALLER, [], { override: true });
    const aFirst = selectDischargedRosterRow([rowA, rowZ], [], CALLER, [], { override: true });
    // Both permutations agree...
    expect(zFirst?.id).toBe('ra-aaaa');
    expect(aFirst?.id).toBe('ra-aaaa');
    // ...and the answer is NOT simply "whatever came first", which is what the
    // unordered `db.select()` used to decide.
    expect(zFirst?.id).not.toBe('ra-zzzz');
    // Without override the same caller has no claim on either row.
    expect(selectDischargedRosterRow([rowZ, rowA], [], CALLER)).toBeUndefined();
  });

  test('NO OVERRIDE: same total order for a role-holder on two role rows with no `created_at`', () => {
    const rowZ = { id: 'ra-zzzz', user_id: 'ghost-z', role: SIGNOFF };
    const rowA = { id: 'ra-aaaa', user_id: 'ghost-a', role: SIGNOFF };
    expect(selectDischargedRosterRow([rowZ, rowA], [], CALLER, [SIGNOFF])?.id).toBe('ra-aaaa');
    expect(selectDischargedRosterRow([rowA, rowZ], [], CALLER, [SIGNOFF])?.id).toBe('ra-aaaa');
  });

  test('the caller’s array is not reordered as a side effect of asking', () => {
    // The HTTP seat re-reads `candidateRosterRows` for its quorum tally, so sorting
    // in place would silently reorder a set another computation depends on.
    const rows = [{ id: 'ra-zzzz', user_id: 'z' }, { id: 'ra-aaaa', user_id: 'a' }];
    selectDischargedRosterRow(rows, [], CALLER);
    expect(rows.map((r) => r.id)).toEqual(['ra-zzzz', 'ra-aaaa']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-TEAM-b audit — a MULTI-ROW roster with a NAMED approver plus a tenant MEMBER (the
// override arm). The member necessarily takes a row naming someone else
// (`required_approvers.user_id` is NOT NULL); the named approver keeps recording on their
// OWN row, and the quorum counts the member as a fungible stand-in — so both count.
// ─────────────────────────────────────────────────────────────────────────────
describe('member override + named approver on a multi-row roster (picker + quorum)', () => {
  // `roster-1` sorts first, so the override takes exactly ALICE's row.
  const alice = { id: 'roster-1', user_id: 'alice', role: null };
  const carol = { id: 'roster-2', user_id: 'carol', role: null };
  const roster = [alice, carol];

  test('member first, then the named approver ⇒ the gate completes (both decisions count)', () => {
    const memberRow = selectDischargedRosterRow(roster, [], 'bob-member', [], { override: true });
    expect(memberRow?.id).toBe('roster-1'); // Alice's row: the stranding shape
    const prior = [{ required_approver_id: memberRow!.id }];
    // Alice's seat narrows her to the rows naming her — she stays on her own row.
    const aliceRow = selectDischargedRosterRow([alice], prior, 'alice');
    expect(aliceRow?.id).toBe('roster-1');
    const decisions = [
      { decision: 'approved', required_approver_id: memberRow!.id, approver_id: 'bob-member' },
      { decision: 'approved', required_approver_id: aliceRow!.id, approver_id: 'alice' },
    ];
    expect(evaluateRosterQuorum(roster, decisions)).toBe('approved');
  });

  test('ONE member decision on a two-row roster stays pending (one decision, one obligation)', () => {
    expect(
      evaluateRosterQuorum(roster, [{ decision: 'approved', required_approver_id: 'roster-1', approver_id: 'bob-member' }]),
    ).toBe('pending');
    // …and the named approver ALONE does not complete it either.
    expect(
      evaluateRosterQuorum(roster, [{ decision: 'approved', required_approver_id: 'roster-1', approver_id: 'alice' }]),
    ).toBe('pending');
  });

  test('a named approver on two rows, one taken by an override, lands on their OPEN row', () => {
    const a1 = { id: 'roster-1', user_id: 'alice' };
    const a2 = { id: 'roster-2', user_id: 'alice' };
    expect(selectDischargedRosterRow([a1, a2], [{ required_approver_id: 'roster-1' }], 'alice')?.id).toBe('roster-2');
  });

  test('CONTROL: a role-less row\'s stand-in still never fills a ROLE row (pools are per role)', () => {
    const roleRow = { id: 'roster-r', user_id: 'dave', role: 'execution_signoff' };
    expect(
      evaluateRosterQuorum(
        [alice, roleRow],
        [
          { decision: 'approved', required_approver_id: 'roster-1', approver_id: 'bob-member' },
          { decision: 'approved', required_approver_id: 'roster-1', approver_id: 'alice' },
        ],
      ),
    ).toBe('pending');
  });
});
