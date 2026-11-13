// tests/unit/scripts/check-tenant-field-misuse.test.ts
//
// Unit tests for `scripts/check-tenant-field-misuse.ts` — the guard that
// rejects a non-tenant value being written into `tenant_id` / `tenantId`.
//
// The guard is a CLI (walks the tree, calls process.exit), and a CLI is
// untestable, so the rule itself lives in the pure `findTenantFieldMisuse`
// (source text in, offences out) and the CLI body sits behind
// `if (import.meta.main)`. This file imports the module and drives the rule
// directly: no filesystem, no subprocess, no process teardown.
//
// A guard nobody tested is a guard that fails open. The two RED cases below
// are the two real incidents that motivated the guard, verbatim; if a refactor
// makes the guard vacuous, they go green and this file fails.
//
// Two further vacuity modes, both MEASURED as live defects, have their own
// blocks below:
//   - the guard scanned zero files and called that a pass (wrong cwd) — see
//     "a scan that reads zero files is an ERROR, never a pass";
//   - the rule was a literal list of RHS spellings and so missed the two
//     bindings the guard exists to protect — see "the bindings this guard was
//     written to protect".
// And the guard's ONE accepted blind spot (one-hop aliases) is pinned in
// "the KNOWN LIMIT", so a green run is never over-read.
//
// No `mock.module()` (banned repo-wide, CI-guarded by
// `scripts/check-no-test-doubles.ts`) — none is needed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  ALLOWLIST,
  BACKEND_DIR,
  EXIT_BROKEN_GUARD,
  EXIT_OFFENCES,
  MIN_REASON_LENGTH,
  emptyScanError,
  extractRhs,
  findAllowlistProblems,
  findTenantFieldMisuse,
  isUserIdBranch,
  normalizeBranch,
  splitRhsBranches,
} from '../../../scripts/check-tenant-field-misuse';

describe('findTenantFieldMisuse — the two real incidents', () => {
  // src/agui/actions/kaizen.ts:68 — a Keycloak ROLE NAME written into a `text`
  // tenant_id column, which postgres accepted without complaint.
  const KAIZEN_SNIPPET = `
    await db.insert(kaizenCandidates).values({
      title,
      tenant_id: ctx.tenantRoles?.[0] ?? 'default',
    });
  `;

  // src/routes/tools/analytics.ts — a USER uuid in the TENANT field, hidden in
  // the else-branch of a multi-line ternary, with a comment on the same line.
  const ANALYTICS_SNIPPET = `
    function actionUserFromCtx(ctx: ActionContext): AuthedUser {
      return {
        id: ctx.userId,
        tenantId: process.env.AUTH_BYPASS === 'true'
          ? '00000000-0000-0000-0000-000000000000'
          : (ctx.userId /* placeholder — real tenant resolution lands later */),
      };
    }
  `;

  test('RED: flags a role name assigned to tenant_id', () => {
    const offences = findTenantFieldMisuse(KAIZEN_SNIPPET, 'kaizen.ts');
    expect(offences).toHaveLength(1);
    expect(offences[0]!.text).toContain('ctx.tenantRoles');
    expect(offences[0]!.reason).toContain('role names');
    expect(offences[0]!.file).toBe('kaizen.ts');
  });

  test('RED: flags a single-line `tenantId: ctx.userId`', () => {
    const offences = findTenantFieldMisuse('const u = { tenantId: ctx.userId };');
    expect(offences).toHaveLength(1);
    expect(offences[0]!.reason).toContain('user id, not a tenant id');
  });

  test('RED: flags ctx.userId in a multi-line ternary branch', () => {
    const offences = findTenantFieldMisuse(ANALYTICS_SNIPPET, 'analytics.ts');
    expect(offences).toHaveLength(1);
    expect(offences[0]!.rhs).toContain('ctx.userId');
    // The `id: ctx.userId` on the line above is NOT a tenant field: only one hit.
    expect(offences[0]!.text.startsWith('tenantId:')).toBe(true);
  });

  test('GREEN: a resolved tenant id passes', () => {
    expect(findTenantFieldMisuse('const x = { tenant_id: ctx.tenantId };')).toHaveLength(0);
  });

  test('non-vacuity: PASS and FAIL snippets differ only in the right-hand side', () => {
    const fail = 'const x = { tenant_id: ctx.userId };';
    const pass = 'const x = { tenant_id: ctx.tenantId };';
    expect(findTenantFieldMisuse(fail)).toHaveLength(1);
    expect(findTenantFieldMisuse(pass)).toHaveLength(0);
  });
});

/**
 * The original three literal shapes. No longer the rule — `isUserIdBranch` is —
 * but kept as a regression list: every entry here MUST stay flagged, proving the
 * broadened rule never dropped one of them.
 */
const BANNED_EXACT_RHS: ReadonlyArray<string> = ['ctx.userId', 'user.id', 'userId'];

describe('findTenantFieldMisuse — every banned exact RHS is live', () => {
  for (const rhs of BANNED_EXACT_RHS) {
    test(`flags \`tenantId: ${rhs}\``, () => {
      expect(findTenantFieldMisuse(`const x = { tenantId: ${rhs} };`)).toHaveLength(1);
    });
    test(`flags \`obj.tenant_id = ${rhs}\``, () => {
      expect(findTenantFieldMisuse(`row.tenant_id = ${rhs};`)).toHaveLength(1);
    });
    // BANNED_EXACT_RHS stopped being the rule when it was broadened to a shape.
    // It stays as a regression list: broadening must never DROP one of the
    // three original shapes, so assert the predicate still covers each.
    test(`isUserIdBranch still covers the original \`${rhs}\``, () => {
      expect(isUserIdBranch(rhs)).toBe(true);
    });
  }
});

describe('findTenantFieldMisuse — the bindings this guard was written to protect', () => {
  // THE BLIND SPOT THAT SHIPPED. The rule was the literal list
  // ['ctx.userId', 'user.id', 'userId'], but the two files the guard exists for
  // do not call the binding `ctx`: src/routes/agui.ts binds `verified`, and
  // src/agui/channels/index.ts binds `identity`. So the exact regression the
  // guard was built to prevent — a user uuid in the tenant field of an AG-UI
  // context — walked straight past it. Each user then becomes their own tenant
  // and tenant isolation is silently gone; nothing throws, because both fields
  // are `string` and both values are uuid-shaped.
  test('RED: flags `tenantId: verified.userId` (routes/agui.ts shape)', () => {
    const offences = findTenantFieldMisuse('const ctx = { tenantId: verified.userId };');
    expect(offences).toHaveLength(1);
    expect(offences[0]!.reason).toContain('verified.userId');
    expect(offences[0]!.reason).toContain('user id, not a tenant id');
  });

  test('RED: flags `tenant_id: identity.userId` (channels/index.ts shape)', () => {
    const offences = findTenantFieldMisuse('await persist({ tenant_id: identity.userId });');
    expect(offences).toHaveLength(1);
    expect(offences[0]!.reason).toContain('identity.userId');
  });

  test('RED: the binding name is irrelevant — any `<x>.userId` is flagged', () => {
    for (const chain of ['session.userId', 'req.ctx.userId', 'claims?.userId', '_u.userId']) {
      expect(findTenantFieldMisuse(`const x = { tenantId: ${chain} };`)).toHaveLength(1);
    }
  });

  test('RED: a `.userId` chain hidden in a ternary else-branch is flagged', () => {
    const src = "const x = { tenantId: bypass ? 'seed-tenant' : verified.userId };";
    expect(findTenantFieldMisuse(src)).toHaveLength(1);
  });

  test('GREEN: the resolved tenant on the same bindings stays clean', () => {
    // Non-vacuity for the pair above: identical lines, RHS is the tenant field
    // rather than the user field, and the guard must stay silent.
    expect(findTenantFieldMisuse('const ctx = { tenantId: ctx.tenantId };')).toHaveLength(0);
    expect(findTenantFieldMisuse('const ctx = { tenantId: verified.tenantId };')).toHaveLength(0);
    expect(findTenantFieldMisuse('const tenantId = claims.tenant_id;')).toHaveLength(0);
  });

  test('GREEN: `.userId` is not widened to `.id`, and near-misses do not match', () => {
    // Widening to `.id` would flag legitimate code everywhere and get the guard
    // deleted from CI. These are the shapes that must stay quiet.
    expect(isUserIdBranch('row.id')).toBe(false);
    expect(isUserIdBranch('project.id')).toBe(false);
    expect(isUserIdBranch('row.userIdHash')).toBe(false);
    expect(isUserIdBranch('getUserId()')).toBe(false);
    expect(isUserIdBranch('userIds[0]')).toBe(false);
    expect(isUserIdBranch('tenantId')).toBe(false);
    expect(isUserIdBranch('homeTenantId')).toBe(false);
  });
});

describe('the KNOWN LIMIT: a one-hop alias is not caught', () => {
  // Documented in the script header, asserted here so nobody later reads a
  // green run as "no user id can reach a tenant field". The guard is a line
  // scanner; the value is laundered through a local binding and the assignment
  // line looks innocent. These tests exist to PIN the limit, not to bless it —
  // if a future change makes them fail by starting to catch these, that is an
  // improvement and the expectations should be flipped deliberately, after
  // checking the false-positive cost.
  test('LIMIT: `const t = ctx.userId; tenant_id: t` slips through', () => {
    const src = 'const t = ctx.userId;\nawait db.insert(x).values({ tenant_id: t });';
    expect(findTenantFieldMisuse(src)).toHaveLength(0);
  });

  test('LIMIT: `const r = ctx.tenantRoles; tenant_id: r[0]` slips through', () => {
    const src = 'const r = ctx.tenantRoles;\nawait db.insert(x).values({ tenant_id: r[0] });';
    expect(findTenantFieldMisuse(src)).toHaveLength(0);
  });
});

describe('a scan that reads zero files is an ERROR, never a pass', () => {
  // DEFECT MEASURED: ROOTS were relative and main() never asserted it scanned
  // anything, so running the guard from the repo root instead of backend/ made
  // readdirSync throw, listSourceFiles swallow it, and the guard print
  // `OK: ... across 0 file(s)` and exit 0. CI was green while the invariant was
  // completely unenforced. Zero files trivially contain zero offences, so the
  // success branch cannot distinguish "clean" from "never looked".
  test('zero files scanned produces an error message', () => {
    const err = emptyScanError(0, ['src', 'scripts']);
    expect(err).not.toBeNull();
    expect(err).toContain('0 files');
    expect(err).toContain('not a pass');
  });

  test('a non-empty scan produces no error', () => {
    expect(emptyScanError(1, ['src', 'scripts'])).toBeNull();
    expect(emptyScanError(1200, ['src', 'scripts'])).toBeNull();
  });

  test('the broken-guard exit is distinguishable from the offence exit', () => {
    // Two different failures must not look alike in CI output: "your code is
    // wrong" and "the guard never ran" need different fixes.
    expect(EXIT_BROKEN_GUARD).not.toBe(EXIT_OFFENCES);
    expect(EXIT_BROKEN_GUARD).toBeGreaterThan(0);
    expect(EXIT_OFFENCES).toBeGreaterThan(0);
  });

  test('the roots resolve off the script, so the scan cannot depend on cwd', () => {
    // This is the assertion that would have caught the original defect: the
    // roots must exist as resolved, no matter what process.cwd() is when the
    // guard (or this test) runs.
    expect(BACKEND_DIR.endsWith('/backend')).toBe(true);
    expect(existsSync(join(BACKEND_DIR, 'src'))).toBe(true);
    expect(existsSync(join(BACKEND_DIR, 'scripts'))).toBe(true);
  });
});

describe('findTenantFieldMisuse — narrowness (no false positives)', () => {
  // Every line below is real, measured out of the fr backend today. If the
  // guard widens, these are what start crying wolf and get it disabled.
  const LEGITIMATE = [
    'return await fn({ id: user.id, tenantId: user.tenantId, roles: user.roles });',
    'return { id: user.id, tenantId: ctxTenantId(user.tenantId) };',
    'return { userId: row.user_id, tenantId: row.tenant_id, refreshToken: newRaw };',
    'licensesClient.listLicensesForSubject(user.id, { tenantId: activeTenantId }),',
    '  { id: userId, tenantId: homeTenantId },',
    'export async function approvalBacklog(userId: string, tenantId: string) {}',
    'interface Row { tenantId?: string }',
    'if (row.tenantId === userId) return null;',
    'const scoped = rows.filter((r) => r.tenant_id === tenantId);',
  ];

  for (const line of LEGITIMATE) {
    test(`does not flag: ${line.slice(0, 56)}`, () => {
      expect(findTenantFieldMisuse(line)).toHaveLength(0);
    });
  }

  test('does not flag a line comment (this guard’s own header must not trip it)', () => {
    const src = "// tenant_id: ctx.tenantRoles?.[0] was the bug\n * tenantId: ctx.userId was the other one";
    expect(findTenantFieldMisuse(src)).toHaveLength(0);
  });

  test('does not flag a string literal describing the bug', () => {
    expect(findTenantFieldMisuse("const msg = 'tenantId: ctx.userId is wrong';")).toHaveLength(0);
  });

  test('flags both tenant fields on one line', () => {
    const offences = findTenantFieldMisuse('const x = { tenantId: ctx.userId, tenant_id: userId };');
    expect(offences).toHaveLength(2);
  });
});

describe('extractRhs / splitRhsBranches / normalizeBranch', () => {
  test('extractRhs stops at the depth-0 comma', () => {
    const lines = ['  tenantId: resolve(a, b), other: 1'];
    expect(extractRhs(lines, 0, lines[0]!.indexOf(':') + 1)).toBe('resolve(a, b)');
  });

  test('extractRhs strips a trailing line comment', () => {
    const lines = ['  tenantId: ctx.userId // wrong'];
    expect(extractRhs(lines, 0, lines[0]!.indexOf(':') + 1)).toBe('ctx.userId');
  });

  test('splitRhsBranches does not split optional chaining', () => {
    expect(splitRhsBranches('ctx.tenantRoles?.[0]')).toEqual(['ctx.tenantRoles?.[0]']);
  });

  test('splitRhsBranches splits ternary and nullish arms', () => {
    expect(splitRhsBranches("a ? b : c ?? d")).toEqual(['a', 'b', 'c', 'd']);
  });

  test('normalizeBranch peels wrapping parentheses', () => {
    expect(normalizeBranch('  ((ctx.userId)) ')).toBe('ctx.userId');
  });
});

describe('ALLOWLIST', () => {
  test('is seeded empty — both known incidents are fixed, not exempted', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(0);
  });

  const exists = (p: string) => p !== 'gone.ts';

  test('rot: an entry whose file is gone is a problem', () => {
    const problems = findAllowlistProblems({ 'gone.ts': 'x'.repeat(40) }, new Set(['gone.ts']), exists);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('rot');
  });

  test('vacuity: a reason under the minimum is a problem', () => {
    const short = 'x'.repeat(MIN_REASON_LENGTH - 1);
    const problems = findAllowlistProblems({ 'a.ts': short }, new Set(['a.ts']), exists);
    expect(problems.some((p) => p.problem.includes('vacuity'))).toBe(true);
  });

  test('redundancy: an entry with no offence is a problem', () => {
    const problems = findAllowlistProblems({ 'a.ts': 'x'.repeat(40) }, new Set<string>(), exists);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('redundancy');
  });

  test('a well-formed entry for a real offence is accepted', () => {
    const problems = findAllowlistProblems({ 'a.ts': 'x'.repeat(40) }, new Set(['a.ts']), exists);
    expect(problems).toHaveLength(0);
  });
});
