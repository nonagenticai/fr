// tests/unit/agui/tenant-role-names.test.ts
//
// `agui/rbac.ts` evaluates `{type:'tenant-role', role:'X'}` as
// `ctx.tenantRoles.includes(X)`. If the Keycloak realm never issues a role
// named X, that rule is not a policy — it is an unconditional deny that no
// grant can lift, and it fails exactly like a correctly-refused request.
//
// ⚠️ THERE IS A LIVE INSTANCE OF THAT, AND IT IS A REALM GAP, NOT A CODE BUG.
// `defaultRule()` (rbac.ts) documents its project-less default as "require
// baseline tenant role 'user'". Measured 2026-08-27 against the portal realm: a
// verified super-admin's `realm_access.roles` holds 15 entries — including
// admin, super_admin, tenant_admin, platform-admin — and NONE of them is
// `user`. So every action that declares no `rbac` field is currently
// unreachable for everyone (14 of them: 8 bridge, 6 streams).
//
// The fix for that is in KEYCLOAK — issue the baseline role — not here. An
// earlier attempt to "fix" it by making the default an explicit deny was
// reverted: it silently rewrote a documented policy to match a
// misconfiguration, and two existing rbac tests correctly objected.
//
// This file is a RATCHET, not a realm check — a source scan cannot know what
// Keycloak issues, and a role can be withdrawn without any code changing. What
// it can do is force the question: adding a role name means editing the set
// below, which is the moment to go and confirm the realm issues it.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every role name a `tenant-role` rule is allowed to reference.
 *
 * Adding an entry means: you have confirmed the portal Keycloak realm issues
 * this role to the callers who need it. Verify with a real token, e.g. decode
 * `realm_access.roles` from a live login — do not assume, the `user` incident
 * above is what assuming looks like.
 */
const KNOWN_REFERENCED_REALM_ROLES: ReadonlyMap<string, string> = new Map([
  [
    'admin',
    "ISSUED. Present on a live super-admin token 2026-08-27 alongside super_admin/tenant_admin. Used by secrets.list.",
  ],
  [
    'user',
    "REQUIRED BY defaultRule() BUT NOT ISSUED by the portal realm as of 2026-08-27 — a known Keycloak configuration gap. Until it is issued, every action declaring no `rbac` is unreachable. Do NOT 'fix' this by weakening defaultRule; grant the role.",
  ],
]);

const SRC = path.join(import.meta.dir, '..', '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Every `{type:'tenant-role', role:'X'}` literal in src/, as `file:line -> X`.
 *
 * Comment lines are skipped: prose that QUOTES a rule (including the comments
 * explaining why `'user'` was removed) is not a rule, and a scanner that cannot
 * tell the difference reports its own documentation as a violation.
 */
function findTenantRoleRules(): Array<{ file: string; line: number; role: string }> {
  const re = /type:\s*'tenant-role'\s*,\s*role:\s*'([^']+)'/;
  const found: Array<{ file: string; line: number; role: string }> = [];
  for (const file of walk(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
      const m = re.exec(raw);
      if (m) found.push({ file: path.relative(SRC, file), line: i + 1, role: m[1]! });
    });
  }
  return found;
}

describe('tenant-role rules may only name roles someone has vouched for', () => {
  test('every referenced role name is accounted for', () => {
    const rules = findTenantRoleRules();
    // Non-vacuity: an empty scan would make the assertion below trivially true
    // and the ratchet would rot silently.
    expect(rules.length).toBeGreaterThan(0);

    const unaccounted = rules.filter((r) => !KNOWN_REFERENCED_REALM_ROLES.has(r.role));
    expect(
      unaccounted.map((u) => `${u.file}:${u.line} references tenant role '${u.role}'`),
    ).toEqual([]);
  });

  test('every accounted-for role carries a substantive reason', () => {
    // A one-word note is not a vouch. Same rule as coverage-check.ts's
    // KNOWN_UNCOVERED: a reason under 30 chars means nobody actually checked.
    const thin = [...KNOWN_REFERENCED_REALM_ROLES.entries()]
      .filter(([, reason]) => reason.trim().length < 30)
      .map(([role]) => role);
    expect(thin).toEqual([]);
  });

  test('the set has not rotted — each entry is still referenced somewhere', () => {
    // An entry for a role no rule mentions any more is stale bookkeeping, and a
    // stale allowlist reads as "accounted for" while accounting for nothing.
    const referenced = new Set(findTenantRoleRules().map((r) => r.role));
    const orphans = [...KNOWN_REFERENCED_REALM_ROLES.keys()].filter(
      (role) => !referenced.has(role),
    );
    expect(orphans).toEqual([]);
  });
});
