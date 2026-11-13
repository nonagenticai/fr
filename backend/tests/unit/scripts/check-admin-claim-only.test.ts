// tests/unit/scripts/check-admin-claim-only.test.ts
//
// Unit tests for `scripts/check-admin-claim-only.ts` — the guard that rejects an
// authorization decision made from the raw Keycloak `admin` claim.
//
// The guard is a CLI, and a CLI is untestable, so the rule lives in the pure
// `findAdminClaimOnly` (source text in, offences out) and the CLI body sits
// behind `if (import.meta.main)`.
//
// The RED cases below are the REAL defect, verbatim: six destructive KAG
// job-control verbs gated on `user.roles.includes('admin')`, a claim the live
// `user_roles` table shows is carried by nobody (workspace-admin=12,
// workspace-member=1, admin=1 — and that one is a nil-UUID seed artifact). If a
// refactor makes the guard vacuous, these go green and this file fails.

import { describe, expect, test } from 'bun:test';

import {
  emptyScanError,
  findAdminClaimOnly,
} from '../../../scripts/check-admin-claim-only';

describe('the shape that actually shipped is caught', () => {
  test('the kag.ts gate — a bare admin-claim test', () => {
    const found = findAdminClaimOnly(
      `export async function requireRole(req: Request, role: string) {
  const user = await validateAuth(req);
  if (!user.roles.includes('admin')) {
    throw new UnauthorizedError("Role 'admin' required");
  }
  return user;
}`,
      'src/middleware/auth.ts',
    );
    expect(found.length).toBe(1);
    expect(found[0]!.line).toBe(3);
  });

  test('the claim-only pair, with NO database fallback', () => {
    // services/scheduled-triggers/list.ts read like it honoured workspace-admin. They do not: `workspace-admin` is
    // a `user_roles` row, never a realm role, so BOTH halves were false for
    // every real workspace admin and their lists silently narrowed.
    const found = findAdminClaimOnly(
      `  const isWorkspaceAdmin =
    user.roles.includes('workspace-admin') || user.roles.includes('admin');`,
      'src/services/scheduled-triggers/list.ts',
    );
    expect(found.length).toBe(1);
  });

  test('double quotes and backticks are the same defect', () => {
    expect(findAdminClaimOnly(`if (u.roles.includes("admin")) return true;`).length).toBe(1);
    expect(findAdminClaimOnly('if (u.roles.includes(`admin`)) return true;').length).toBe(1);
  });
});

describe('what the guard must NOT flag', () => {
  test('a comment describing the defect is not the defect', () => {
    // Every file fixed here explains the old shape in a comment. If prose
    // tripped the guard, the fix itself could not land — and the obvious
    // "fix" would be to delete the explanation.
    const found = findAdminClaimOnly(
      `// This used to be user.roles.includes('admin'), which matched nobody.
  return userRolesService.isWorkspaceAdminVia(user, tenantId, hasRole);`,
    );
    expect(found).toEqual([]);
  });

  test('the super-admin realm role is a legitimate claim check', () => {
    // `super_admin` IS a signed realm role; reading it is the sanctioned path.
    // A guard that flagged it would be wrong and would get switched off.
    expect(findAdminClaimOnly(`if (user.roles.includes('super_admin')) return true;`)).toEqual([]);
  });

  test('the super-admin gate is not flagged even next to a role variable', () => {
    expect(
      findAdminClaimOnly(`if (u.roles.includes('super_admin') || u.roles.includes('viewer')) {}`),
    ).toEqual([]);
  });
});

describe('the generic-gate shape — the case this guard first MISSED', () => {
  test('a role held in a VARIABLE is flagged', () => {
    // ⚠️ This is why the rule is not keyed to the literal alone.
    //
    // MEASURED: the first version of this guard, which flagged only
    // `includes('admin')`, reported ZERO offences against the pre-fix
    // routes/assets/kag.ts — it could not see the defect it was written for.
    // Those six sites called `requireRole(req, 'admin')`, and the `includes`
    // lived one level down in middleware/auth.ts as `includes(role)`. A rule
    // keyed to the literal is blind to any helper that takes the role as a
    // parameter, which is exactly what a helper is for.
    //
    // Re-measured with this rule in place: the pre-fix tree reports
    // `src/middleware/auth.ts:65` — the helper itself, which is the root, rather
    // than the six call sites that merely used it.
    const found = findAdminClaimOnly(
      `  if (!user.roles.includes(role)) {\n    throw new UnauthorizedError();\n  }`,
      'src/middleware/auth.ts',
    );
    expect(found.length).toBe(1);
  });

  test('the price of that rule is one legitimate match, which is ALLOWLISTED', () => {
    // middleware/bridge-auth.ts is the identical SHAPE checking a
    // SERVICE-ACCOUNT role. That is not distinguishable by syntax — a machine
    // identity genuinely does carry its realm role, and there is no user_roles
    // row to consult for one. So it is a recorded exemption rather than a hole
    // in the rule that would silently cover the next occurrence too.
    expect(findAdminClaimOnly(`if (!bypass && !user.roles.includes(role)) {`).length).toBe(1);
  });
});

describe('a scan that reads zero files is an ERROR, never a pass', () => {
  test('zero scanned files returns an error string', () => {
    // Zero files trivially contain zero offences, so the success branch cannot
    // tell "the invariant holds" from "the walk found nothing to look at".
    const err = emptyScanError(0, ['src', 'scripts']);
    expect(err).toContain('proved NOTHING');
  });

  test('a non-empty scan returns null', () => {
    expect(emptyScanError(470, ['src', 'scripts'])).toBeNull();
  });
});

describe('the spellings the rule was BLIND to until 2026-09-08', () => {
  // ⚠️ MEASURED with positive controls before the fix: the rule was anchored on
  // `\.roles\s*\.\s*includes`, and every case in this block returned ZERO
  // offences. They are not four defects — they are ONE defect with four
  // spellings, and the first of them is the DOMINANT spelling in this repo.
  // Only `user.roles.includes('admin')` and the helper's `u.roles.includes(role)`
  // ever fired, which is why the guard read green while `src/lib/project-access.ts`
  // had been reading the claim, unrecorded, the whole time.

  test('optional chaining — the dominant spelling here', () => {
    expect(findAdminClaimOnly(`if (user.roles?.includes('admin')) return true;`).length).toBe(1);
    expect(findAdminClaimOnly(`if (user?.roles?.includes(role)) return true;`).length).toBe(1);
  });

  test('a destructured bare `roles` receiver', () => {
    const found = findAdminClaimOnly(
      `  const { roles } = user;\n  if (!roles.includes('admin')) throw new UnauthorizedError();`,
      'src/routes/x.ts',
    );
    expect(found.length).toBe(1);
    expect(found[0]!.line).toBe(2);
  });

  test('`some` with an equality predicate is the same question', () => {
    expect(findAdminClaimOnly(`if (user.roles.some(r => r === 'admin')) return true;`).length).toBe(
      1,
    );
    expect(
      findAdminClaimOnly(`if (user.roles?.some((r) => r === requiredRole)) return true;`).length,
    ).toBe(1);
    // …written the other way round.
    expect(findAdminClaimOnly(`if (user.roles.some((r) => 'admin' === r)) {}`).length).toBe(1);
  });

  test('`indexOf(...) !== -1` decides exactly the same authority', () => {
    expect(findAdminClaimOnly(`if (user.roles.indexOf('admin') !== -1) return true;`).length).toBe(
      1,
    );
    expect(findAdminClaimOnly(`if (u.roles?.indexOf(role) > -1) return true;`).length).toBe(1);
  });

  test('a deeper receiver chain is not a hiding place', () => {
    expect(findAdminClaimOnly(`if (req.user.roles.includes('admin')) return true;`).length).toBe(1);
  });
});

describe('the widened rule is not an ALWAYS-FIRE rule', () => {
  // Widening a guard buys detection with false positives, and a guard that
  // flags innocent code gets switched off. These are the negatives drawn from
  // the very class the widening admitted: a bare `roles.` receiver, optional
  // chaining, and `some`/`indexOf` — none of which is an authorization
  // decision about the `admin` claim.

  test('a non-authorization `roles` collection is untouched', () => {
    expect(findAdminClaimOnly(`if (post.roles.includes(tag)) return true;`)).toEqual([]);
    // ⚠️ VACUOUS AS A CONTROL, kept only as documentation. `category` is not in
    // ADMIN_ARG, so this line passes whether the predicate is bounded or spans
    // the whole line. It is exactly why the first widening shipped broken — see
    // the block below, whose negatives DO fail against the unbounded rule.
    expect(findAdminClaimOnly(`const hit = post.roles?.some((r) => r === category);`)).toEqual([]);
    expect(findAdminClaimOnly(`const at = post.roles.indexOf(tag);`)).toEqual([]);
  });

  test('super_admin stays sanctioned in every new spelling', () => {
    expect(findAdminClaimOnly(`if (user.roles?.includes('super_admin')) return true;`)).toEqual([]);
    expect(findAdminClaimOnly(`if (roles.some((r) => r === 'super_admin')) return true;`)).toEqual(
      [],
    );
  });

  test('a DIFFERENT variable whose name merely ends in Roles is not this question', () => {
    // `workspaceRoles` / `userRoles` are already the resolved user_roles rows in
    // several call sites — flagging them would flag the FIX.
    expect(findAdminClaimOnly(`if (workspaceRoles.includes('admin')) return true;`)).toEqual([]);
    expect(findAdminClaimOnly(`if (userRoles?.includes(role)) return true;`)).toEqual([]);
  });

  test('prose describing the new spellings still does not trip the guard', () => {
    expect(
      findAdminClaimOnly(`  // was: user.roles?.some((r) => r === 'admin') — matched nobody`),
    ).toEqual([]);
  });
});

describe('the `some` predicate is BOUNDED to the lambda parameter', () => {
  // ⚠️ EVERY case in this block FIRES against the first widened rule
  // (`some\s*\(.*?(?:===?\s*ADMIN_ARG|…)`), whose `.*?` spanned the whole LINE.
  // That is the point: the previous negative control (`post.roles?.some((r) =>
  // r === category)`) passed under BOTH the broken rule and the fixed one,
  // because `category` is not in ADMIN_ARG — so it never exercised the span it
  // was supposed to be guarding. A negative that cannot go red when the rule is
  // over-broad proves nothing.
  //
  // Restore the `.*?` alternative and all four of these go red. That is the
  // mutation proof that they are not vacuous.

  test('a member-access predicate is NOT the parameter — this is the FIX, not the defect', () => {
    // `roles` here holds RESOLVED user_roles rows, so `r.name === 'admin'` is
    // the sanctioned shape. The unbounded rule flagged the very fix it demands,
    // which is how a guard earns an exemption and then rots.
    expect(findAdminClaimOnly(`return roles.some((r) => r.name === 'admin');`)).toEqual([]);
  });

  test('an unrelated `.role` LATER on the line cannot complete the match', () => {
    expect(
      findAdminClaimOnly(
        `if (roles.some((r) => r.startsWith('team:')) && card.role === 'owner') return;`,
      ),
    ).toEqual([]);
  });

  test('a `some` asking a different question is not rescued by a neighbouring statement', () => {
    // The `some` asks about 'member'. It fired only because an unrelated
    // `assignment.role !==` shared the line.
    expect(
      findAdminClaimOnly(
        `const isMember = user.roles.some((r) => r === 'member'); if (assignment.role !== 'lead') skip();`,
      ),
    ).toEqual([]);
  });

  test('POSITIVE CONTROL: bounding did not turn `some` into match-nothing', () => {
    // Without this, "bound the predicate" could have been implemented as a
    // regex that matches nothing, which passes every negative above.
    expect(findAdminClaimOnly(`if (!user.roles.some((r) => r === 'admin')) throw x;`).length).toBe(
      1,
    );
  });

  test('a TS-annotated lambda parameter is still the same defect', () => {
    expect(findAdminClaimOnly(`if (user.roles.some((r: string) => r === 'admin')) {}`).length).toBe(
      1,
    );
  });
});

describe('what bounding `some` deliberately did NOT fix', () => {
  test('`dto.roles.includes(role)` still fires, and is not distinguishable', () => {
    // ⚠️ RECORDED, NOT FIXED — and the reason is measured, not assumed.
    //
    // This line is DTO input validation, not an authority decision, and it does
    // fire. But it fires through the (b) bare-identifier rule, NOT through the
    // unbounded span, and the region the rule matches is BYTE-IDENTICAL to the
    // shipped defect and to the allowlisted legitimate gate:
    //
    //   dto.roles.includes(role)            → ".roles.includes(role)"
    //   user.roles.includes(role)           → ".roles.includes(role)"   ← the
    //       root cause in middleware/auth.ts, behind six destructive KAG verbs
    //   !bypass && !user.roles.includes(role) → ".roles.includes(role)" ← the
    //       bridge-auth.ts service-account gate, already an EXEMPT entry
    //
    // Making this clean requires either narrowing `includes` (which re-blinds
    // the guard to the defect it exists for) or an allowlist of "principal"
    // receiver names (which is how the rule got blind to four spellings in the
    // first place). Neither is a fix; both are the rot. So the cost is the one
    // the SCOPE (b) docstring already priced in for bridge-auth.ts, paid again
    // — not a new unbounded blast radius.
    expect(
      findAdminClaimOnly(`if (!dto.roles.includes(role)) throw new ValidationError('unknown role');`)
        .length,
    ).toBe(1);
    // …and the two lines it cannot be told apart from.
    expect(findAdminClaimOnly(`  if (!user.roles.includes(role)) {`).length).toBe(1);
    expect(findAdminClaimOnly(`if (!bypass && !user.roles.includes(role)) {`).length).toBe(1);
  });
});

describe('a CONST naming an admin role — the spelling that survived #1043', () => {
  // ⚠️ MEASURED against the rule as it stood after the receiver learned `?.`
  // (#1043). The receiver fix was real, and these three still MATCHED:
  //
  //     user.roles.includes('admin')                 <- literal
  //     user.roles?.includes('admin')                <- optional chain
  //     user.roles?.includes(role)                   <- parameter identifier
  //
  // …while BOTH lines of the actual subject still MISSED:
  //
  //     user.roles?.includes(WORKSPACE_ADMIN_ROLE)   <- streams/policy.ts:89
  //     user.roles?.includes(LEGACY_ADMIN_ROLE)      <- streams/policy.ts:90
  //
  // ADMIN_ARG held five spellings: three quotings of the LITERAL and three
  // PARAMETER names. A module const is neither, so the guard read
  // `OK: zero claim-only admin checks across 498 file(s)` with the two live
  // grants in front of it. That zero was blind, not clean.

  test('the two subject lines from streams/policy.ts are flagged', () => {
    expect(
      findAdminClaimOnly(
        `  if (user.roles?.includes(WORKSPACE_ADMIN_ROLE)) return true;`,
        'src/services/streams/policy.ts',
      ).length,
    ).toBe(1);
    expect(
      findAdminClaimOnly(
        `  if (user.roles?.includes(LEGACY_ADMIN_ROLE)) return true;`,
        'src/services/streams/policy.ts',
      ).length,
    ).toBe(1);
  });

  test('the pre-existing positive controls did not regress', () => {
    // Widening ADMIN_ARG is an edit to the alternation every other case shares.
    // A botched alternation (a stray group, a swallowed branch) can make the
    // NEW case pass while quietly killing the old ones, and every negative test
    // in this file would stay green. So the three are re-asserted HERE, beside
    // the change that could break them.
    expect(findAdminClaimOnly(`if (user.roles.includes('admin')) return true;`).length).toBe(1);
    expect(findAdminClaimOnly(`if (user.roles?.includes('admin')) return true;`).length).toBe(1);
    expect(findAdminClaimOnly(`if (user.roles?.includes(role)) return true;`).length).toBe(1);
  });

  test('camelCase and a bare ADMIN are the same argument', () => {
    // SCREAMING_SNAKE is a convention, not the property. A rule keyed to the
    // convention is one rename away from blind again.
    expect(findAdminClaimOnly(`if (u.roles?.includes(adminRole)) return true;`).length).toBe(1);
    expect(findAdminClaimOnly(`if (u.roles.includes(ADMIN)) return true;`).length).toBe(1);
    expect(findAdminClaimOnly(`if (u.roles.some((r) => r === ADMIN_ROLE)) return true;`).length).toBe(
      1,
    );
    expect(findAdminClaimOnly(`if (u.roles.indexOf(ADMIN_ROLE) !== -1) return true;`).length).toBe(1);
  });

  test('the widening is not an always-fire rule — three REAL in-tree lines stay clean', () => {
    // ⚠️ These are copied verbatim from the tree, not invented. A widened rule
    // that flagged them would be a rule someone switches off, and the lines it
    // would flag are the ones with nothing to do with admin authority.
    //
    //   src/routes/assets/internal-create.ts:79 — a workflow-runner gate
    //   src/agui/rbac.ts:241                    — a MEMBER-ACCESS argument
    //   src/services/streams/policy.ts:111      — the dept-manager claim
    expect(findAdminClaimOnly(`  if (!roles.includes(WORKFLOW_RUNNER_ROLE)) {`)).toEqual([]);
    expect(findAdminClaimOnly(`      if (!roles.includes(rule.role)) {`)).toEqual([]);
    expect(findAdminClaimOnly(`  if (user.roles?.includes(DEPT_MANAGER_ROLE)) return true;`)).toEqual(
      [],
    );
  });

  test('an admin const is flagged, and super-admin-gate.ts RECORDS the reading', () => {
    // ⛔ The literal `'super_admin'` stays unflagged (asserted above); the const
    // spelling does NOT. That asymmetry is deliberate: with a literal the VALUE
    // is on the line and is visibly the sanctioned realm role; with an
    // identifier it is not, and `SUPER_ADMIN_REALM_ROLE` could be bound to
    // anything. So the identifier is flagged and the one file that asks it
    // carries the reading in EXEMPT, where a human can check it.
    //
    // ⚠️ This entry pre-dates the widening and was VACUOUS until now — the old
    // ADMIN_ARG never matched its only line, so the exemption excused nothing.
    // This is the assertion that it now does work.
    expect(
      findAdminClaimOnly(`  return roles?.includes(SUPER_ADMIN_REALM_ROLE) ?? false;`).length,
    ).toBe(1);
  });
});
