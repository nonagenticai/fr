#!/usr/bin/env bun
//
// CI guard — reject an authorization decision made from the raw `admin` claim.
//
// WHY THIS EXISTS. Four independent sites decided "is this person an admin?"
// with nothing but the Keycloak claim:
//
//     if (!user.roles.includes('admin')) throw new UnauthorizedError(...)
//
// That test matches no real grant. Authority in this product lives in
// `user_roles`, whose live contents are workspace-admin=12, workspace-member=1,
// and a single `admin` row that is a nil-UUID AUTH_BYPASS seed artifact. So the
// check is not "merely stricter than intended" — it is closed to every actual
// administrator, while looking correct at the call site and passing every test
// that asserts it was invoked.
//
// Three of the four sites were found and fixed one at a time
// (`routes/channels.ts`, `routes/suggested-schedules.ts`,
// `routes/engagements/deliveries.ts`), each carrying its own inline copy. A
// fourth survived in `routes/assets/kag.ts` and gated six DESTRUCTIVE KAG
// job-control verbs for months. It survived precisely because the first three
// fixes were per-site: there was no shared helper to grep for, so nothing
// connected them. This guard exists to catch the SHAPE, which is what actually
// recurs, rather than any one function name.
//
// SCOPE, following scripts/check-tenant-field-misuse.ts. Flags
// `.roles.includes(X)` when X is:
//   (a) the literal 'admin' — the three inline sites; or
//   (b) a bare `role` / `requiredRole` IDENTIFIER — the generic-gate shape.
//
// ⚠️ (b) EXISTS BECAUSE THIS GUARD FAILED ITS OWN TEST WITHOUT IT. The first
// version had only (a), and MEASURED against the pre-fix `routes/assets/kag.ts`
// it reported ZERO offences — it could not see the very defect it was written
// for. That defect's claim check was not inline: the six sites called
// `requireRole(req, 'admin')`, and the `includes` lived one level down in
// `middleware/auth.ts` as `includes(role)`, a VARIABLE. A rule keyed to the
// literal is blind to any helper that takes the role as a parameter — which is
// precisely what a helper is for.
//
// (b) is what makes the guard non-vacuous, and the price is that it also matches
// the legitimate service-account gate in `middleware/bridge-auth.ts`. That is
// NOT distinguishable by syntax — it is the identical shape, checking a machine
// identity's realm role, which a service account genuinely does carry. So it is
// an ALLOWLIST entry with a written reason, the same way
// check-tenant-field-misuse.ts records its exceptions, rather than a hole in the
// rule that silently covers the next one too.
//
// `roles.includes('super_admin')` is NOT flagged: that realm role IS a signed
// claim and testing it is sanctioned.
//
// THE SANCTIONED ALTERNATIVES, and why the exempt files below are exempt:
//   * `services/user-roles.ts` is NO LONGER EXEMPT (2026-09-29, fr#1289). It
//     used to be, because `isWorkspaceAdminVia` opened with an UNPINNED fast
//     path — `roles.includes('workspace-admin') || roles.includes('admin')` —
//     that made the claim's bearer admin of ANY tenant. That arm was removed.
//     The legacy realm role `admin` is now a PINNED alias of `tenant_admin`
//     (`REALM_TENANT_ADMIN_ROLES`, honoured only when the raw `tenant_id` claim
//     equals the target tenant, in `isRealmTenantAdminOf`), which is still the
//     one correct place for the claim to be read for this purpose — but it no
//     longer contains a line of the flagged shape, so an exemption would only
//     hide a REINTRODUCED bare-claim check. Scanned like every other file.
//   * `lib/super-admin-gate.ts` — reads the signed `super_admin` realm role,
//     a different question with a different answer.
//   * `lib/project-access.ts` — `holdsOrchestratorRole` asks the SAME
//     machine-identity question as `bridge-auth.ts`, about the `aa-orchestrator`
//     realm role of the trusted AA service identity. ⚠️ It is listed here only
//     because widening the rule to optional chaining (2026-09-08) made it
//     visible; before that the guard could not see it at all, so its absence
//     from this list had never been a judgement.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Backend root derived from THIS FILE, never `process.cwd()`. */
export const BACKEND_DIR = dirname(import.meta.dir);

const ROOTS = ['src', 'scripts'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const EXIT_OFFENCES = 1;

/**
 * Files permitted to read the `admin` claim, path → reason.
 *
 * Keep this list SHORT and keep every reason specific: each entry must name why
 * the file is asking a DIFFERENT question (a machine identity's signed realm
 * role, or the canonical resolver that consults `user_roles`), never merely
 * that it was inconvenient to fix. Growth here is the shape spreading again.
 * ⛔ Never add a directory prefix — exemptions are exact paths only.
 */
const EXEMPT: Record<string, string> = {
  // ⛔ `src/services/user-roles.ts` was removed from this list on 2026-09-29
  // (fr#1289) together with its unpinned claim fast path. Do not re-add it: the
  // pinned `admin`/`tenant_admin` arm reads the claim without the flagged shape,
  // so the only thing an exemption there could ever cover is a regression.
  'src/lib/super-admin-gate.ts':
    'reads the signed super_admin realm role, a different question entirely',
  'src/middleware/bridge-auth.ts':
    'a SERVICE-ACCOUNT gate on PROJECT_REQUEST_WRITER_ROLE, not a user authority check — a machine identity really does carry its realm role in the token, and there is no user_roles row to consult for one',
  'src/lib/project-access.ts':
    'holdsOrchestratorRole tests the aa-orchestrator REALM role of the trusted AA service identity (the system seat of the phase / wip-slot / card-phase-lease lanes; its cross-tenant view was removed by fr#1437) — the same machine-identity question as bridge-auth.ts, not a user authority question, and there is no user_roles row for an orchestrator. It was invisible until the rule learned optional chaining (2026-09-08), so recording it is the first time it could be recorded at all.',
};

export interface Offence {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/**
 * A CONST IDENTIFIER naming an admin role — widened 2026-09-08 (#1042).
 *
 * ⚠️ MEASURED against the guard's own matcher before the widening. The receiver
 * had already learned optional chaining, and these still came back:
 *
 *     MATCH   user.roles.includes('admin')                  <- positive control
 *     MATCH   user.roles?.includes('admin')                 <- positive control
 *     MATCH   user.roles?.includes(role)                    <- positive control
 *     MISSED  user.roles?.includes(WORKSPACE_ADMIN_ROLE)    <- streams/policy.ts:89
 *     MISSED  user.roles?.includes(LEGACY_ADMIN_ROLE)       <- streams/policy.ts:90
 *
 * The five names in the alternation below are LITERAL spellings plus three
 * PARAMETER names. Neither covers the third way an admin role reaches
 * `includes`: a module const. That is not an exotic spelling — it is the tidier
 * one, so the rule was blind precisely to the code that had been cleaned up.
 *
 * Matched: any identifier CONTAINING `admin` in any case (`ADMIN_ROLE`,
 * `WORKSPACE_ADMIN_ROLE`, `adminRole`). Deliberately not restricted to
 * SCREAMING_SNAKE — camelCase is the same argument by a different convention,
 * and the `includes(` argument is anchored between `\(\s*` and `\s*\)`, so this
 * can only ever be the WHOLE argument, never a substring of a larger
 * expression. `rule.role` and `WORKFLOW_RUNNER_ROLE` therefore do not match.
 *
 * ⛔ THE LITERAL `'super_admin'` STAYS UNFLAGGED; A CONST DOES NOT. That is not
 * an inconsistency, it is the only readable distinction: with a literal the
 * VALUE is on the line and can be seen to be the sanctioned realm role; with an
 * identifier it is not, and `SUPER_ADMIN_ROLE` may be bound to anything. So the
 * identifier form is flagged and `lib/super-admin-gate.ts` — the one file that
 * asks it — records the reading in EXEMPT, where a human can check it. That
 * entry existed already and was vacuous until now; this widening is what makes
 * it do work.
 *
 * Residual, RECORDED NOT FIXED: `const A = 'admin'; roles.includes(A)` still
 * evades, because `A` names nothing. Closing that needs const-binding
 * resolution, which is a type-checker, not a line regex.
 *
 * ⚠️ AND IT IS DELIBERATELY BROAD IN THE OTHER DIRECTION: the lookahead matches
 * ANY identifier containing "admin", so `roles.includes(adminPanelUrl)` or
 * `roles.includes(ADMIN_DOCS_LINK)` would also flag. **Zero such lines exist in
 * the tree today** (verified by an audit scanning all 516 files with exemptions
 * ignored: 4 hits, all of them real role checks and all already exempt).
 *
 * That breadth is the intended trade. The RECEIVER is already `roles.includes(`
 * — passing a URL or a docs link to a role-membership test would be nonsense
 * code — so the realistic false-positive rate is near zero, while narrowing to a
 * shape like `*_ROLE` would re-open the exact hole this widening closes: an
 * identifier is free to be named anything. ⛔ If this ever DOES flag a
 * non-role identifier, add an exemption with the reason rather than narrowing
 * the pattern — a rule that flags valid code gets deleted, but a rule narrowed
 * to fit one caller stops catching the next one.
 */
const ADMIN_ROLE_IDENT = String.raw`\b(?=[\w$]*[Aa][Dd][Mm][Ii][Nn])[A-Za-z_$][\w$]*\b`;

/**
 * The role being asked about: the literal `admin`, the bare identifier a
 * generic gate passes down (see SCOPE (b) above), or a const naming an admin
 * role.
 */
const ADMIN_ARG =
  String.raw`(?:'admin'|"admin"|\`admin\`|\brole\b|\brequiredRole\b|\broleName\b` +
  String.raw`|${ADMIN_ROLE_IDENT})`;

/**
 * The receiver, MEASURED-widened 2026-09-08.
 *
 * ⚠️ The previous rule was anchored on a literal `\.roles\s*\.\s*includes`, and
 * a read-only sweep with positive controls showed it returned ZERO offences for
 * every one of these — all the identical defect:
 *
 *     user.roles?.includes('admin')            // OPTIONAL CHAINING — the
 *                                              // dominant spelling in this repo
 *     const { roles } = user; roles.includes('admin')   // destructured, bare
 *     user.roles.some((r) => r === 'admin')
 *     user.roles.indexOf('admin') !== -1
 *
 * So `roles` is matched on a NON-IDENTIFIER boundary rather than on a mandatory
 * leading dot — that admits `user.roles`, `req.user.roles` and a destructured
 * bare `roles` alike, while still rejecting `userRoles` / `workspaceRoles`,
 * which are different variables and not this question. `\s*\??\.` admits the
 * optional-chaining spelling.
 */
const ROLES_RECEIVER = String.raw`(?:^|[^\w$])roles\s*\??\.\s*`;

/**
 * The `some` PREDICATE, BOUNDED — corrected 2026-09-08.
 *
 * ⚠️ The first widened spelling was `some\s*\(.*?(?:===?\s*ADMIN_ARG|…)`. The
 * `.*?` spans the WHOLE LINE, so anything later on that line could complete the
 * match. MEASURED against `findAdminClaimOnly`, all four of these fired, and
 * none of them is an authority decision:
 *
 *     roles.some((r) => r.name === 'admin')                  // the RESOLVED
 *         // user_roles rows — i.e. the guard flagged the very FIX it demands
 *     roles.some((r) => r.startsWith('team:')) && card.role === 'owner'
 *     user.roles.some((r) => r === 'member'); … assignment.role !== 'lead'
 *
 * The predicate is now anchored to the lambda itself: the identifier being
 * compared must BE the lambda's parameter, enforced by a backreference (`\1`),
 * with no member access and no arbitrary span between them. `r.name === 'admin'`
 * therefore cannot match, because `r.name` is not `r`.
 *
 * Group 1 is the lambda parameter — ROLES_RECEIVER and every alternation above
 * are non-capturing, so `\1` is stable. An optional `(…)` wrapper and an
 * optional TS type annotation (`(r: string) => …`) are admitted; the annotation
 * class deliberately excludes `=`, so it can never swallow the `=>`.
 */
const SOME_PREDICATE =
  String.raw`some\s*\(\s*(?:\(\s*)?(\w+)\s*(?::\s*[\w.$\[\]<>|]+\s*)?\)?\s*=>\s*` +
  String.raw`(?:\1\s*(?:===?|!==?)\s*${ADMIN_ARG}|${ADMIN_ARG}\s*(?:===?|!==?)\s*\1)\s*\)`;

/**
 * `.includes(X)` / `.indexOf(X)` / `.some(r => r === X)` — three spellings of
 * ONE question. A rule that knew only `includes` was blind to the other two,
 * which is not a smaller defect: `indexOf(...) !== -1` decides exactly the same
 * authority from exactly the same claim.
 *
 * `includes` / `indexOf` are unchanged: their argument is already anchored
 * between `\(\s*` and `\s*\)`, so it can only ever be the bare token, never a
 * span. Only `some` needed bounding.
 */
const CLAIM_ONLY = new RegExp(
  ROLES_RECEIVER +
    String.raw`(?:(?:includes|indexOf)\s*\(\s*${ADMIN_ARG}\s*\)` +
    String.raw`|${SOME_PREDICATE})`,
);

/**
 * Pure so the invariant is unit-testable without spawning the CLI.
 */
export function findAdminClaimOnly(source: string, file = '<inline>'): Offence[] {
  const out: Offence[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    // Skip comments — this file and the fixed sites DESCRIBE the bad shape.
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (!CLAIM_ONLY.test(text)) continue;
    out.push({
      file,
      line: i + 1,
      text: trimmed,
      reason:
        "decides authority from the raw Keycloak 'admin' claim, which no real grant carries",
    });
  }
  return out;
}

/**
 * A scan of zero files finds zero offences, so success cannot distinguish
 * "clean" from "the walk found nothing". Zero always means a broken invocation.
 */
export function emptyScanError(scanned: number, roots: ReadonlyArray<string>): string | null {
  if (scanned > 0) return null;
  return (
    `ERROR: the guard scanned 0 files — it proved NOTHING and is not a pass.\n\n` +
    `  looked in: ${roots.join(', ')}\n` +
    `  under:     ${BACKEND_DIR}\n\n` +
    `Zero files trivially contain zero offences. Fix the invocation; do not\n` +
    `treat this as green.`
  );
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listSourceFiles(full));
    else if (SOURCE_EXTENSIONS.some((e) => entry.endsWith(e)) && !entry.includes('.test.'))
      out.push(full);
  }
  return out;
}

function main(): void {
  const offences: Offence[] = [];
  let scanned = 0;

  for (const root of ROOTS) {
    const abs = join(BACKEND_DIR, root);
    if (!existsSync(abs)) continue;
    for (const full of listSourceFiles(abs)) {
      const rel = relative(BACKEND_DIR, full);
      scanned++;
      if (EXEMPT[rel] !== undefined) continue;
      offences.push(...findAdminClaimOnly(readFileSync(full, 'utf8'), rel));
    }
  }

  const empty = emptyScanError(scanned, ROOTS);
  if (empty !== null) {
    console.error(empty);
    process.exit(EXIT_OFFENCES);
  }

  if (offences.length === 0) {
    console.log(
      `OK: zero claim-only admin checks across ${scanned} file(s) in ${ROOTS.join(' + ')}.`,
    );
    return;
  }

  console.error('ERROR: authorization decided from the raw `admin` claim:\n');
  for (const o of offences) {
    console.error(`  ${o.file}:${o.line}`);
    console.error(`    ${o.text}`);
    console.error(`    → ${o.reason}\n`);
  }
  console.error(
    'Authority lives in `user_roles`, not in the claim. Use\n' +
      '`isWorkspaceAdminOf` / `isWorkspaceAdminVia` from services/user-roles.ts, or\n' +
      'lib/super-admin-gate.ts for platform-wide authority.',
  );
  process.exit(EXIT_OFFENCES);
}

if (import.meta.main) main();
