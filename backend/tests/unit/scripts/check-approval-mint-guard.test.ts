// tests/unit/scripts/check-approval-mint-guard.test.ts
//
// The guard must catch a mint that can address an approval to nobody — and must
// NOT be satisfied by a refusal about something else, or by a refusal that
// belongs to some OTHER function.
//
// MEASURED on prod 2026-09-05: 1,482 approvals pending, 925 expiring within 5
// days. Of the 274 never notified, a full triage scored ALL 274
// `insufficient_evidence` — zero decidable — because 241 name no approver at
// all. `approval-routing.ts` already states the contract ("the caller must fail
// loud, never write the row"); the mint sites ignore it.
//
// ⚠️ THIS FILE PREVIOUSLY PINNED THE BUG AS THE SPEC. It contained a test named
// "a refusal further back than the window does not count", which asserted the
// 130-line lookback window was correct behaviour. The window was the defect: it
// answered PROXIMITY when the question is CONTAINMENT, so an insert with no
// refusal in its own body was reported `guarded` merely for sitting under an
// unrelated guarded function. That test would have outvoted the fix, so it is
// replaced here by its inverse — the distance-independence tests below.

import { describe, expect, test } from 'bun:test';

import {
  codeOnly,
  findMintSites,
  unguardedError,
  selfTestFailures,
  MAX_UNGUARDED_MINT_SITES,
  MAX_UNANSWERABLE_MINT_SITES,
  KNOWN_UNANSWERABLE_MINT_FILES,
  MIN_MINT_SITES,
  type MintSite,
} from '../../../scripts/check-approval-mint-guard';

const insert = '      .insert(approvals)';
const one = (content: string): MintSite | undefined =>
  findMintSites([{ path: '/x/backend/src/a.ts', content }])[0];

describe('classifying a mint site', () => {
  test('an insert with no approver refusal is UNGUARDED', () => {
    expect(one(['async function mint() {', '  const row = {};', insert, '}'].join('\n'))?.guarded).toBe(
      false,
    );
  });

  test('an insert preceded by a refusal keyed on the approver, in its own scope, is guarded', () => {
    const content = [
      'async function mint() {',
      '  const routing = await resolveApprover({ tenantId });',
      '  if (!routing.approver) {',
      '    throw new ValidationError("No reachable human approver");',
      '  }',
      insert,
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(true);
  });
});

describe('a refusal that does not actually guard THIS insert does NOT count', () => {
  test('a throw about a duplicate leaves the site UNGUARDED', () => {
    // THE case this guard exists for. `handleCreateApproval` throws — about a
    // duplicate ("An approval is already pending for this project") — and still
    // writes a row addressed to nobody. A check keyed on `throw` alone would
    // pass it, and 241 unanswerable rows is what that costs.
    const content = [
      'async function mint() {',
      '  if (existing) {',
      '    throw new ValidationError("An approval is already pending for this project");',
      '  }',
      insert,
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(false);
  });

  test('a refusal in an UNRELATED function above it does not guard it — at ANY distance', () => {
    // THE REGRESSION TEST. Reproduced on the real tree before the fix: an
    // unguarded mint 22 lines below an unrelated guarded function was reported
    // `guarded` and CI exited 0; the identical pair with 200 filler lines
    // between them was correctly reported UNGUARDED. Same code, opposite
    // verdict, decided by line distance alone.
    const pair = (gap: number): string =>
      [
        'async function unrelated(ctx) {',
        '  if (!ctx.approver) {',
        '    throw new Error("no approver");',
        '  }',
        '}',
      ]
        .concat(Array.from({ length: gap }, () => '// filler'))
        .concat(['async function mint(db, row) {', insert, '}'])
        .join('\n');

    // Both must be UNGUARDED, and — the point — the verdict must not depend on
    // the gap. Under the old window these two disagreed with each other.
    expect(one(pair(20))?.guarded).toBe(false);
    expect(one(pair(400))?.guarded).toBe(false);
  });

  test('a neighbour whose whole BODY is on ONE LINE does not guard it either — at ANY distance', () => {
    // ⭐ THE SECOND REGRESSION. The test above passes only because its fixture
    // puts the neighbour's braces on separate lines, which is exactly congruent
    // with the blind spot of the first containment implementation: it recorded
    // the block path at each line's START, so a scope that opens AND closes
    // within one line was never seen to open, and its refusal was credited to
    // the PARENT scope — which IS an ancestor of the insert.
    //
    // MEASURED on the previous head of this branch: every fixture below
    // reported `guarded`, at gap 20 AND gap 400. It was never the distance.
    const nested = (gap: number): string =>
      [
        'export function register(app) {',
        '  async function unrelated(ctx) { if (!ctx.approver) { throw new Error("no approver"); } }',
      ]
        .concat(Array.from({ length: gap }, () => '  // filler'))
        .concat(['  async function mint(db, row) {', insert, '  }', '}'])
        .join('\n');

    expect(one(nested(20))?.guarded).toBe(false);
    expect(one(nested(400))?.guarded).toBe(false);

    // Same shape as a one-line sibling method in an object literal...
    const literal = (gap: number): string =>
      [
        'export const service = {',
        '  unrelated(ctx) { if (!ctx.approver) throw new Error("no approver"); },',
      ]
        .concat(Array.from({ length: gap }, () => '  // filler'))
        .concat(['  async mint(db, row) {', insert, '  },', '};'])
        .join('\n');

    expect(one(literal(20))?.guarded).toBe(false);
    expect(one(literal(400))?.guarded).toBe(false);

    // ...and as a one-line arrow helper declared beside the mint. `assertApprover`
    // refuses for its OWN caller, never for this write.
    const arrow = (gap: number): string =>
      [
        'export function register(app) {',
        '  const assertApprover = (c) => { if (!c.approver) throw new Error("no approver"); };',
      ]
        .concat(Array.from({ length: gap }, () => '  // filler'))
        .concat(['  async function mint(db, row) {', insert, '  }', '}'])
        .join('\n');

    expect(one(arrow(20))?.guarded).toBe(false);
    expect(one(arrow(400))?.guarded).toBe(false);
  });

  test('a refusal in a DIFFERENT switch arm does not guard the insert', () => {
    // `case "b"` is reached without ever evaluating the refusal in `case "a"`.
    const arms = (gap: number): string =>
      [
        'async function mint(db, row, kind) {',
        '  switch (kind) {',
        '    case "a": { if (!approver) { throw new Error("no approver"); } break; }',
      ]
        .concat(Array.from({ length: gap }, () => '    // filler'))
        .concat(['    case "b": {', insert, '    }', '  }', '}'])
        .join('\n');

    expect(one(arms(20))?.guarded).toBe(false);
    expect(one(arms(400))?.guarded).toBe(false);
  });

  test('⛔ ANTI-OVERCORRECTION: an inlined refusal that DOES guard still counts', () => {
    // The cheap way to pass the two tests above is to distrust any refusal that
    // shares a line with a brace. That would reclassify real guards as
    // offenders. The distinction is positional, not typographic: here the
    // condition sits BEFORE that block's `{`, so it is on the insert's own path;
    // in the fixtures above a whole BODY sits after one, so it is not.
    const content = [
      'async function mint(db, ctx, row) {',
      '  if (!ctx.approver) { throw new ValidationError("No reachable human approver"); }',
      insert,
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(true);
  });

  test('a CONDITIONAL refusal in a sibling branch does not guard an insert outside it', () => {
    // `if (!approver) throw` nested inside another branch runs on only one path,
    // so it cannot be the thing that makes the write safe.
    const content = [
      'async function mint(db, row) {',
      '  if (mode === "strict") {',
      '    if (!approver) throw new Error("no approver");',
      '  }',
      insert,
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(false);
  });

  test('a condition that only LOGS the missing approver does not guard the write', () => {
    // INHERITED, not introduced by the containment rewrite: REFUSAL_RE matches
    // the CONDITION, never the CONSEQUENCE. Measured on `backend/src`
    // 2026-09-08 before fixing it: 4 of the 7 REFUSAL_RE matches in the tree
    // have no `throw`/`return` near them, and ZERO mint sites changed verdict —
    // all four are unguarded either way — so this could only tighten.
    const content = [
      'async function mint(db, ctx, row) {',
      '  if (!ctx.approver) {',
      '    logger.warn("no approver; sending to nobody");',
      '  }',
      insert,
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(false);
  });

  test('an insert INSIDE the refused branch is not guarded by the condition that selected it', () => {
    // The write runs precisely when there is no approver — the condition is the
    // reason this row is unanswerable, not the thing preventing it.
    const content = [
      'async function mint(db, ctx, row) {',
      '  if (!ctx.approver) {',
      '    logger.warn("degraded");',
      insert,
      '    throw new Error("after the write, too late");',
      '  }',
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(false);
  });

  test('a refusal AFTER the insert does not guard it', () => {
    const content = [
      'async function mint(db, row) {',
      insert,
      '  if (!approver) throw new Error("no approver");',
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(false);
  });

  test('a refusal that is only a COMMENT or a STRING does not count', () => {
    // The old check matched raw text, so writing the words in a comment was
    // enough. REFUSAL_RE now runs on the lexed line.
    const content = [
      'async function mint(db, row) {',
      '  // if (!approver) throw new Error("no approver");',
      '  log("if (!approver) throw");',
      insert,
      '}',
    ].join('\n');
    expect(one(content)?.guarded).toBe(false);
  });
});

describe('the lexer that makes brace depth trustworthy', () => {
  test('braces inside strings, templates and regexes do not move the depth', () => {
    const src = ['const a = "{{{";', 'const b = `x${ y }{`;', 'const c = /^\\{/;', 'const d = 1 / 2;'].join(
      '\n',
    );
    const out = codeOnly(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('{{{');
    // `${ }` is blanked as a unit, so the literal contributes no unbalanced brace.
    expect((out.match(/[{}]/g) ?? []).length).toBe(0);
  });

  test('a file whose braces do not balance is reported UNGUARDED, never guarded', () => {
    // FAIL-CLOSED. Every way the lexer can be wrong must cost a false positive,
    // never a false assurance.
    const content = ['async function mint(db, row) {', '  if (!approver) throw new Error("x");', insert].join(
      '\n',
    ); // deliberately missing the closing brace
    const site = one(content);
    expect(site?.unlexable).toBe(true);
    expect(site?.guarded).toBe(false);
  });
});

/**
 * `unguardedError` now judges TWO axes, so a fixture exercising one must hold the
 * OTHER at its pinned count — otherwise every case below fails for the wrong
 * reason and the tests stop being about what they are named after.
 */
const sites = (
  unguarded: number,
  guarded = 0,
  unanswerable = MAX_UNANSWERABLE_MINT_SITES,
): MintSite[] => {
  // ⚠️ The TOTAL must be at least `MIN_MINT_SITES` (5) or the census floor fires
  // first and the fixture stops being about the axis it is named after.
  const all: MintSite[] = [
    ...Array.from({ length: unguarded }, (_, i) => ({
      file: `/x/backend/src/f${i}.ts`,
      line: 1,
      guarded: false,
      answerable: true,
      unlexable: false,
    })),
    ...Array.from({ length: guarded }, (_, i) => ({
      file: `/x/backend/src/g${i}.ts`,
      line: 1,
      guarded: true,
      answerable: true,
      unlexable: false,
    })),
  ];
  // ⚠️ The unanswerable ones must be NAMED FROM THE ALLOWLIST, or every fixture
  // below trips `KNOWN_UNANSWERABLE_MINT_FILES` and each case fails for a reason
  // it is not named after. Beyond the allowlist's length the names run out on
  // purpose — a fixture with MORE unanswerable sites than the allowlist permits is
  // exactly the over-ceiling case, and the count check fires first.
  for (let i = 0; i < Math.min(unanswerable, all.length); i += 1) {
    all[i]!.answerable = false;
    const known = KNOWN_UNANSWERABLE_MINT_FILES[i];
    if (known) all[i]!.file = `/x/${known}`;
  }
  return all;
};

describe('the ratchet is two-sided', () => {
  // ⚠️ `+ 1 guarded` is not padding: the real tree is FOUR offenders and ONE
  // guarded site, and a 4-site fixture now trips the census floor (`MIN_MINT_SITES`
  // was corrected 4 → 5 in this PR) instead of the axis it is named after.
  test('at the pinned count it passes', () => {
    expect(unguardedError(sites(MAX_UNGUARDED_MINT_SITES, 1))).toBeNull();
  });

  test('one MORE unguarded site fails', () => {
    const over = unguardedError(sites(MAX_UNGUARDED_MINT_SITES + 1));
    expect(over).not.toBeNull();
    expect(over).toContain('above the ceiling');
  });

  test('one FEWER unguarded site ALSO fails, demanding the literal be lowered', () => {
    // Without this the ceiling equals its own population and the guard passes
    // whether the code improves, stagnates, or regresses back to 4.
    const under = unguardedError(sites(MAX_UNGUARDED_MINT_SITES - 1, 2));
    expect(under).not.toBeNull();
    expect(under).toContain('BELOW the ratchet floor');
  });

  test('guarded sites do not count against the ceiling', () => {
    expect(unguardedError(sites(MAX_UNGUARDED_MINT_SITES, 50))).toBeNull();
  });

  test('a census below the floor fails even when no offender count changed', () => {
    const thin = unguardedError(sites(MIN_MINT_SITES - 1));
    expect(thin).not.toBeNull();
    expect(thin).toContain('census floor');
  });

  test('an unlexable site fails loudly rather than being counted as guarded', () => {
    const broken = unguardedError([
      ...sites(MAX_UNGUARDED_MINT_SITES),
      { file: '/x/backend/src/z.ts', line: 9, guarded: false, answerable: false, unlexable: true },
    ]);
    expect(broken).toContain('do not lex to');
  });
});

/**
 * ── THE SECOND AXIS: THE ANSWERABILITY CHOKEPOINT ──────────────────────────
 *
 * ⛔ WHY THIS EXISTS AT ALL. Before it, a NEW mint site that called
 * `resolveApprover`, threw on `approver: null`, and then inserted a row with
 * `requester_id`, `expires_at` and `metadata` all unset was reported `guarded`
 * and the guard exited 0 — MEASURED 2026-09-26 on this branch's base with a
 * throwaway fixture under `src/domain/__repro/`. Nothing moved: a guarded site
 * raises `sites.length` (a FLOOR, so more is fine) and leaves `bad.length` at 4.
 * So the entire class "a sixth door that refuses a null approver and skips the
 * answerability gate" shipped green.
 *
 * ⚠️ That was a FUTURE hole, not a live bypass. All five real sites are accounted
 * for and none of them is such a door; the fixture that demonstrated it was the
 * auditor's own, and the claim of a live sixth door was retracted.
 */
describe('the answerability axis classifies independently of the approver axis', () => {
  test('the fixture that used to pass: refuses a null approver, never reaches the gate', () => {
    const site = one(
      [
        'async function mintSixthDoor(db, ctx, row) {',
        '  const routing = await resolveApprover({ tenantId: ctx.tenantId });',
        '  if (!routing.approver) {',
        '    throw new ValidationError("No reachable human approver");',
        '  }',
        insert,
        '}',
      ].join('\n'),
    );
    // BOTH halves matter. `guarded` true is what made it invisible; `answerable`
    // false is what now catches it. If a future edit collapses one into the
    // other, this pair stops holding and the axis has become redundant.
    expect(site?.guarded).toBe(true);
    expect(site?.answerable).toBe(false);
  });

  test("the real chokepoint's own shape is recognised — gate in the body, insert nested deeper", () => {
    const site = one(
      [
        'async function mintOneOpenGate(params) {',
        '  const values = await ensureAnswerable(params);',
        '  for (let attempt = 0; attempt < 2; attempt += 1) {',
        '    const [row] = await db',
        insert,
        '      .values(values)',
        '      .returning();',
        '    if (row) return row;',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(true);
  });

  test('a gate call in a NEIGHBOURING scope does not count — at ANY distance', () => {
    const body = (gap: number): string =>
      [
        'export function register(app) {',
        '  async function other(params) { const v = await ensureAnswerable(params); return v; }',
        ...Array.from({ length: gap }, (_, i) => `  const filler${i} = ${i};`),
        '  async function mint(db, row) {',
        insert,
        '  }',
        '}',
      ].join('\n');
    expect(one(body(0))?.answerable).toBe(false);
    expect(one(body(400))?.answerable).toBe(false);
  });

  test('a gate call AFTER the insert does not count', () => {
    const site = one(
      [
        'async function mint(db, params, row) {',
        insert,
        '  await ensureAnswerable(params);',
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  test("the gate's own DECLARATION does not self-certify the file that holds it", () => {
    // `one-open-gate.ts` both declares `ensureAnswerable` and holds a mint site,
    // so a module-scope match must never be credited to an insert below it.
    const site = one(
      [
        'export async function ensureAnswerable(params) { return params.values; }',
        'async function mintElsewhere(db, row) {',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  test('a gate named only in a COMMENT or a STRING does not count', () => {
    const site = one(
      [
        'async function mint(db, row) {',
        // ⚠️ Spelled as the FULL credited form, not a bare mention: since the
        // pattern demands `= await ensureAnswerable(`, a bare mention would be
        // refused by the pattern alone and this test would pass without `codeOnly`
        // doing anything — a lexer regression would go unnoticed.
        '  // const values = await ensureAnswerable(params); runs upstream, we promise',
        '  logger.info("const values = await ensureAnswerable(params)");',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  /**
   * ⭐ THE FOUR SPELLINGS THAT SET `answerable` WITHOUT GATING ANYTHING.
   *
   * MEASURED 2026-09-26 against the previous pattern `\bensureAnswerable\s*\(`:
   * every one of these read `answerable: true`. The pattern now demands the
   * assignment-and-await form, which is the ONLY form the single real call site
   * (`one-open-gate.ts:532`) has.
   */
  test('(I) `void ensureAnswerable(p)` — no await — does NOT count', () => {
    // The accidental one: the gate's refusal is a rejected promise nobody waits
    // for, so the insert below runs and the row is written anyway.
    const site = one(
      [
        'async function mint(db, params, row) {',
        '  void ensureAnswerable(params);',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  test('(H) an awaited call whose RESULT IS DISCARDED does NOT count', () => {
    // `ensureAnswerable` resolves a missing requester and deadline and RETURNS the
    // values to write; dropping them writes `params.values` and mints the defect.
    const site = one(
      [
        'async function mint(db, params, row) {',
        '  await ensureAnswerable(params);',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  test('(N) a call through a MEMBER expression does not count', () => {
    // `\b` matched after a `.`, so a shim reachable as `legacyShim.ensureAnswerable`
    // was credited as the chokepoint.
    const site = one(
      [
        'async function mint(db, params, row) {',
        '  const values = await legacyShim.ensureAnswerable(params);',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  test('(L) a gate behind `||` — skippable — does not count', () => {
    const site = one(
      [
        'async function mint(db, params, row) {',
        '  const values = params.skipGate || (await ensureAnswerable(params));',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(false);
  });

  /**
   * ⛔ ANTI-OVERCORRECTION. Tightening a regex can refuse legitimate code, and on
   * this axis a false refusal reads as "another ungated door" — loud, but wrong.
   * These two shapes gate exactly as well as the canonical one and must stay
   * credited.
   */
  test('a DESTRUCTURING bind of the gate result still counts', () => {
    const site = one(
      [
        'async function mint(db, params) {',
        '  const { values } = await ensureAnswerable(params);',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(true);
  });

  test('a plain RE-assignment of the gate result still counts', () => {
    const site = one(
      [
        'async function mint(db, params) {',
        '  let values;',
        '  values = await ensureAnswerable(params);',
        insert,
        '}',
      ].join('\n'),
    );
    expect(site?.answerable).toBe(true);
  });

  test('an unlexable file is reported unanswerable, never answerable', () => {
    // Fail-closed in the same direction as `guarded`: an untrustworthy parse
    // never yields a pass.
    const site = one(
      [
        'async function mint(db, params, row) {',
        '  const values = await ensureAnswerable(params);',
        insert,
        // deliberately unbalanced
      ].join('\n'),
    );
    expect(site?.unlexable).toBe(true);
    expect(site?.answerable).toBe(false);
  });
});

describe('the answerability ratchet is two-sided too', () => {
  test('at the pinned count it passes', () => {
    expect(unguardedError(sites(MAX_UNGUARDED_MINT_SITES, 1))).toBeNull();
  });

  test('one MORE site skipping the gate fails, and names the gate', () => {
    const over = unguardedError(
      sites(MAX_UNGUARDED_MINT_SITES, 1, MAX_UNANSWERABLE_MINT_SITES + 1),
    );
    expect(over).not.toBeNull();
    expect(over).toContain('WITHOUT passing through the');
    expect(over).toContain('ensureAnswerable');
  });

  test('one FEWER ALSO fails, demanding the literal be lowered in the same PR', () => {
    const under = unguardedError(
      sites(MAX_UNGUARDED_MINT_SITES, 1, MAX_UNANSWERABLE_MINT_SITES - 1),
    );
    expect(under).not.toBeNull();
    expect(under).toContain('skip the answerability gate');
  });

  test('a guarded site is NOT excused from the answerability axis', () => {
    // The whole hole in one assertion: a new site that refuses a null approver
    // must still be counted here.
    const withSixthDoor: MintSite[] = [
      ...sites(MAX_UNGUARDED_MINT_SITES),
      { file: '/x/backend/src/sixth.ts', line: 14, guarded: true, answerable: false, unlexable: false },
    ];
    const err = unguardedError(withSixthDoor);
    expect(err).not.toBeNull();
    expect(err).toContain('backend/src/sixth.ts:14');
  });
});

/**
 * ── THE COUNT-PRESERVING SWAP ──────────────────────────────────────────────
 *
 * MEASURED 2026-09-26: gating one existing door AND adding a new ungated door in
 * the same PR leaves the unanswerable total at 4, so BOTH sides of
 * `MAX_UNANSWERABLE_MINT_SITES` stay silent about a tree that just gained a door
 * nobody can answer. A count cannot see a swap; only the identity set can.
 */
describe('the answerability ratchet pins the identity set, not just the count', () => {
  const swap = (): MintSite[] => {
    const all = sites(MAX_UNGUARDED_MINT_SITES, 1, MAX_UNANSWERABLE_MINT_SITES);
    // One listed door gets gated...
    const fixed = all.find((s) => !s.answerable)!;
    fixed.answerable = true;
    // ...and a brand-new ungated door arrives. Total unanswerable: unchanged.
    all.push({
      file: '/x/backend/src/routes/brand-new-door.ts',
      line: 77,
      guarded: true,
      answerable: false,
      unlexable: false,
    });
    return all;
  };

  test('the swap really does preserve the count — otherwise this proves nothing', () => {
    expect(swap().filter((s) => !s.answerable).length).toBe(MAX_UNANSWERABLE_MINT_SITES);
  });

  test('...and it FAILS anyway, naming the new door', () => {
    const err = unguardedError(swap());
    expect(err).not.toBeNull();
    expect(err).toContain('NOT\nin KNOWN_UNANSWERABLE_MINT_FILES');
    expect(err).toContain('backend/src/routes/brand-new-door.ts:77');
    // ⛔ And it must not suggest the easy way out.
    expect(err).toContain('Do NOT add the file to the allowlist');
  });

  test('the listed files at the pinned count still pass', () => {
    expect(unguardedError(sites(MAX_UNGUARDED_MINT_SITES, 1, MAX_UNANSWERABLE_MINT_SITES))).toBeNull();
  });

  test('the allowlist and the ceiling describe the same population', () => {
    // If these drift, one was edited and the other forgotten: the identity check
    // then either admits a door or blocks a fix. The guard's own self-test asserts
    // this too, on every CI run.
    expect(KNOWN_UNANSWERABLE_MINT_FILES.length).toBe(MAX_UNANSWERABLE_MINT_SITES);
  });
});

describe("the guard's own anti-vacuity self-test", () => {
  test('the shipped classifier passes it', () => {
    expect(selfTestFailures()).toEqual([]);
  });
});

describe('the real tree', () => {
  test('the scan finds the known mint sites, and the pinned count matches reality', async () => {
    // Guards against a scan that silently finds nothing — "zero offences" from
    // zero files read is not a pass — and pins that the literal still equals
    // reality, so changing it is a deliberate edit.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dir, '..', '..', '..', 'src');
    const files: Array<{ path: string; content: string }> = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) {
          if (e !== 'node_modules' && e !== '__tests__') walk(p);
        } else if (e.endsWith('.ts') && !e.includes('.test.')) {
          files.push({ path: p, content: readFileSync(p, 'utf8') });
        }
      }
    };
    walk(root);

    const sites = findMintSites(files);
    expect(sites.length).toBeGreaterThanOrEqual(MIN_MINT_SITES);
    expect(sites.filter((s) => !s.guarded).length).toBe(MAX_UNGUARDED_MINT_SITES);
    // The same pin on the second axis, for the same reason: if this drifts, the
    // literal was changed without the code, or the detector went blind.
    expect(sites.filter((s) => !s.answerable).length).toBe(MAX_UNANSWERABLE_MINT_SITES);
    // ⭐ And WHICH files they are, not just how many — the count-preserving swap
    // above is invisible to the line before this one.
    expect(
      sites
        .filter((s) => !s.answerable)
        .map((s) => s.file.replace(/^.*\/backend\//, 'backend/'))
        .sort(),
    ).toEqual([...KNOWN_UNANSWERABLE_MINT_FILES].sort());
    // ⭐ And the ONE site that IS gated is the chokepoint itself. Without this the
    // answerability census could be satisfied by a tree in which nothing at all
    // reaches the gate — a floor of 4-out-of-4 reads identical to 4-out-of-5.
    // 2026-10-09: the contract-gate sign-off route (added 2026-10-07) was DELETED
    // by owner ruling, so the chokepoint is again the only gated site.
    // G8 / R313: the asset.promotion minter writes the values ensureAnswerable returns.
    expect(
      sites
        .filter((s) => s.answerable)
        .map((s) => s.file.replace(/^.*\/backend\//, 'backend/'))
        .sort(),
    ).toEqual(['backend/src/domain/approvals/one-open-gate.ts', 'backend/src/services/approvals/asset-promotion.ts']);
    // Every real backend file must lex; if this ever fails, `codeOnly` met a
    // construct it does not understand and the whole tree's verdict is suspect.
    expect(sites.filter((s) => s.unlexable)).toEqual([]);
  });
});
