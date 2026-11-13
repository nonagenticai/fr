#!/usr/bin/env bun
//
// CI guard — reject a non-tenant value being written into a tenant field.
//
// WHY THIS EXISTS (two real incidents, same shape, both invisible for months
// because nothing failed — not the compiler, not the database, not a test):
//
//   1. `src/agui/actions/kaizen.ts` wrote
//          tenant_id: ctx.tenantRoles?.[0] ?? 'default'
//      `ctx.tenantRoles` is the caller's list of Keycloak ROLE NAMES, so the
//      value actually persisted was the string `platform_incident_commander`.
//      `kaizen_candidates.tenant_id` was declared `text` at the time — not
//      `uuid`, not a foreign key to `tenants` — so postgres had nothing to
//      object to and stored the role name as the tenant. Every row written by
//      that path was scoped to a tenant that does not exist. (Migration 103
//      made that column `uuid`, so THIS exact shape now throws at INSERT. This
//      guard still earns its place: incident 2 below hands a USER uuid to the
//      tenant field, which is uuid-shaped and which no column type can catch.)
//
//   2. `src/routes/tools/analytics.ts` built its AuthedUser as
//          { id: ctx.userId, tenantId: <ternary> ... : ctx.userId }
//      i.e. a USER uuid handed to the TENANT field. Both fields are `string`
//      in TypeScript and both are uuid-shaped at runtime, so the type checker,
//      the zod schemas and postgres all agree it is fine. It is not: it makes
//      each user their own tenant and silently defeats tenant isolation.
//
// The common cause is loose typing on BOTH ends — `text`/`string` columns and
// `string` fields — which means the only place the mistake is visible is in
// the source line itself. So this guard reads the source line.
//
// SCOPE — deliberately NARROW. It flags a `tenant_id` / `tenantId` assignment
// only when the right-hand side either:
//   (a) mentions `tenantRoles` anywhere — a role list can never be a tenant id;
//       or
//   (b) has a branch that is an identifier chain ending in `.userId`
//       (`ctx.userId`, `verified.userId`, `identity.userId`, `a.b.userId`), or
//       is bare `userId`, or is `user.id` — a user id is not a tenant id.
// Nothing else. This is not a general wrong-type detector, and it must not
// become one: a broad scanner over `string`-typed fields produces false
// positives, and a guard that cries wolf gets disabled — which is strictly
// worse than no guard. If a third shape of this bug appears, add that shape
// explicitly rather than widening the rule.
//
// Rule (b) is a SHAPE, not a fixed list, because the fixed list was wrong. It
// used to be exactly `['ctx.userId', 'user.id', 'userId']` — but the two files
// this guard was written to protect bind the user as `verified.userId`
// (`src/routes/agui.ts`) and `identity.userId` (`src/agui/channels/index.ts`),
// so `tenantId: verified.userId` — the literal regression shape — was
// invisible to the guard that exists to catch it. Any `<binding>.userId` in a
// tenant field is wrong whatever the binding is named, so matching on the
// trailing `.userId` closes the blind spot without losing precision. It is
// deliberately NOT widened to `.id` in general: `.id` appears on every row,
// entity and record in the codebase, and that rule would produce exactly the
// false positives that get a guard deleted from CI.
//
// "A branch" means the guard splits the RHS on top-level `?:`, `??`, `||` and
// `&&` before comparing, and follows a multi-line RHS to the end of the
// statement. That is what incident (2) needs — its `ctx.userId` sits in the
// else-branch of a ternary, three lines below the `tenantId:` token.
//
// ── WHAT THIS GUARD DOES *NOT* CATCH ───────────────────────────────────────
// It is a LINE SCANNER, not a dataflow analysis: it sees the right-hand side
// as literally written and nothing else. One hop through a local binding
// defeats it completely, and BOTH incident shapes have such a form:
//
//     const t = ctx.userId;
//     await db.insert(x).values({ tenant_id: t });          // NOT FLAGGED
//
//     const r = ctx.tenantRoles;
//     await db.insert(x).values({ tenant_id: r[0] });        // NOT FLAGGED
//
// It also cannot see a value that arrives through a function parameter, a
// destructure (`const { userId } = ctx;` then `tenant_id: userId` IS caught,
// but `const { userId: u } = ctx;` then `tenant_id: u` is not), or a spread.
//
// So a green run does NOT mean "no user id reaches a tenant field". It means
// "no user id reaches a tenant field ON THE ASSIGNMENT LINE ITSELF" — which is
// where both real incidents were written, and where a reviewer skimming a diff
// is least likely to catch them. This limit is ACCEPTED, not a TODO: following
// bindings means scope-aware dataflow over the whole tree, which mispredicts on
// any non-trivial control flow, and a guard that cries wolf gets removed from
// CI — costing the signal it does have. Alias-laundered assignments stay a
// code-review concern.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * The backend root, derived from THIS FILE — never from `process.cwd()`.
 *
 * WHY: the roots below used to be walked as bare relative paths. Invoke the
 * guard from the repo root instead of `backend/` — which is what happens the
 * moment someone runs it by path, or CI stops running it from backend/ (as
 * `bun run ci:verify` does today) — and `readdirSync('src')` throws,
 * `listSourceFiles` swallows the error, and the guard printed
 * `OK: ... across 0 file(s)` and exited 0. It reported success for having
 * scanned nothing, which is worse than having no guard: CI is green and the
 * invariant is unprotected. `import.meta.dir` is `<repo>/backend/scripts`, so
 * its parent is the backend root and the scan covers the same files from any
 * working directory.
 */
export const BACKEND_DIR = dirname(import.meta.dir);

/** Root directory names, relative to `BACKEND_DIR`. Also used in messages. */
const ROOTS = ['src', 'scripts'];
const EXCLUDED_DIR_FRAGMENTS = ['/node_modules/'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

/** How many extra lines a right-hand side may span before we give up. */
const CONTINUATION_LINES = 8;

/**
 * Deliberate, recorded exceptions: path → one-line reason.
 *
 * Structured exactly like `KNOWN_UNCOVERED` in `src/agui/coverage-check.ts`,
 * and for the same reason. A guard with no exception mechanism has only two
 * end states: someone deletes the guard, or someone deletes the guard from CI.
 * Both lose the signal entirely. An entry here keeps the guard live and makes
 * the exception a thing a reviewer can see and argue with.
 *
 * Rules, mirroring the coverage-check ratchet:
 *   - **rot** — an entry whose file no longer exists is an error.
 *   - **redundancy** — an entry whose file has no offence is an error; delete it.
 *   - **vacuity** — a reason under MIN_REASON_LENGTH chars is an error.
 *
 * SEEDED EMPTY ON PURPOSE. Both known incidents are being fixed, not exempted.
 */
export const ALLOWLIST: Readonly<Record<string, string>> = {};

/** A reason shorter than this explains nothing; see coverage-check.ts. */
export const MIN_REASON_LENGTH = 30;

/**
 * An RHS branch that is an identifier chain ending in `.userId`.
 *
 * Anchored at both ends, so it matches the WHOLE branch and nothing else:
 * `ctx.userId`, `verified.userId`, `identity.userId`, `req.ctx.userId`,
 * `ctx?.userId`. It does not match `row.userIdHash`, `getUserId()`,
 * `userIds[0]` or any expression containing a call, index or operator —
 * `splitRhsBranches` has already peeled the ternary/`??`/`||`/`&&` arms, so a
 * branch that still contains anything else is not a bare user-id read.
 *
 * WHY A SHAPE AND NOT A LIST: the previous rule compared against the literal
 * list `['ctx.userId', 'user.id', 'userId']` and therefore did not flag
 * `verified.userId` or `identity.userId` — the exact bindings used by the two
 * files this guard protects. A user id is not a tenant id regardless of which
 * local name it was bound to.
 */
export const USER_ID_CHAIN_RE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.userId$/;

/** True when a (already-split, already-normalized) RHS branch reads a user id. */
export function isUserIdBranch(branch: string): boolean {
  // `userId` and `user.id` are spelled out because neither is an
  // `<something>.userId` chain, and both are real shapes seen in this codebase.
  if (branch === 'userId' || branch === 'user.id') return true;
  return USER_ID_CHAIN_RE.test(branch);
}

/** A role list is never a tenant id, wherever it appears in the RHS. */
export const BANNED_RHS_SUBSTRING = 'tenantRoles';

/**
 * `tenant_id:` / `tenantId:` (object literal, property) or `tenant_id =`
 * (assignment). `=` must not be `==`, `===` or `=>`.
 */
const FIELD_RE = /(?:^|[^\w$])(tenant_id|tenantId)\s*(:|=(?![=>]))/g;

export interface Offence {
  file: string;
  line: number;
  text: string;
  rhs: string;
  reason: string;
}

function isTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function isExcluded(path: string): boolean {
  return EXCLUDED_DIR_FRAGMENTS.some((frag) => path.includes(frag));
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
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !isTestFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True when the match at `matchIndex` sits inside a `//` comment, a JSDoc
 * continuation line, or a string literal. Crude but adequate — it exists so this file's own header, and
 * the prose in any doc comment, do not trip the guard.
 */
function isCommentOrString(line: string, matchIndex: number): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  const before = line.slice(0, matchIndex);
  let inString: '"' | "'" | '`' | null = null;
  for (let i = 0; i < before.length; i += 1) {
    const ch = before[i];
    if (inString === null) {
      if (ch === '"' || ch === "'" || ch === '`') inString = ch;
    } else if (ch === inString && before[i - 1] !== '\\') {
      inString = null;
    }
  }
  return inString !== null;
}

/**
 * Collect the right-hand side starting just after the `:` / `=`, following the
 * statement across up to CONTINUATION_LINES further lines. Stops at a `,` or
 * `;` at depth zero, or at a bracket that would close the enclosing scope.
 * Comments are dropped; string literals are kept verbatim.
 */
export function extractRhs(lines: string[], startLine: number, startCol: number): string {
  let out = '';
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inBlockComment = false;

  const lastLine = Math.min(lines.length - 1, startLine + CONTINUATION_LINES);
  for (let li = startLine; li <= lastLine; li += 1) {
    const line = lines[li] ?? '';
    let ci = li === startLine ? startCol : 0;
    // A continuation line joins with a space so `a\n? b` does not become `a? b`.
    if (li !== startLine) out += ' ';
    for (; ci < line.length; ci += 1) {
      const ch = line[ci] ?? '';
      const next = line[ci + 1] ?? '';
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          ci += 1;
        }
        continue;
      }
      if (inString !== null) {
        out += ch;
        if (ch === inString && line[ci - 1] !== '\\') inString = null;
        continue;
      }
      if (ch === '/' && next === '/') break; // line comment: rest of line is prose
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        ci += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        out += ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) return out.trim(); // closes the enclosing literal
        depth -= 1;
      }
      if (depth === 0 && (ch === ',' || ch === ';')) return out.trim();
      out += ch;
    }
  }
  return out.trim();
}

/**
 * Split an RHS into the value expressions it can evaluate to: the arms of a
 * `?:`, and each side of `??` / `||` / `&&`. Top level only — nested calls,
 * literals and index expressions are left intact, and `?.` is not a split.
 */
export function splitRhsBranches(rhs: string): string[] {
  const branches: string[] = [];
  let current = '';
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;

  for (let i = 0; i < rhs.length; i += 1) {
    const ch = rhs[i] ?? '';
    const next = rhs[i + 1] ?? '';
    if (inString !== null) {
      current += ch;
      if (ch === inString && rhs[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;

    if (depth === 0) {
      if (ch === '?' && next === '?') {
        branches.push(current);
        current = '';
        i += 1;
        continue;
      }
      if (ch === '?' && next !== '.' && next !== '?') {
        branches.push(current);
        current = '';
        continue;
      }
      if (ch === ':') {
        branches.push(current);
        current = '';
        continue;
      }
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
        branches.push(current);
        current = '';
        i += 1;
        continue;
      }
    }
    current += ch;
  }
  branches.push(current);
  return branches.map(normalizeBranch).filter((b) => b.length > 0);
}

/** Trim and peel any wrapping parentheses: `(ctx.userId)` → `ctx.userId`. */
export function normalizeBranch(branch: string): string {
  let out = branch.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * THE RULE. Pure: takes source text, returns the offences. No filesystem, no
 * process exit — so it is unit-testable directly.
 */
export function findTenantFieldMisuse(source: string, file = '<inline>'): Offence[] {
  const offences: Offence[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // A line can carry more than one tenant field (`{ tenantId: a, tenant_id: b }`),
    // so every match is examined, not just the first.
    FIELD_RE.lastIndex = 0;
    for (const m of line.matchAll(FIELD_RE)) {
      if (m.index === undefined) continue;

      const fieldName = m[1] ?? '';
      const fieldIndex = line.indexOf(fieldName, m.index);
      if (isCommentOrString(line, fieldIndex)) continue;

      const operatorIndex = line.indexOf(m[2] ?? ':', fieldIndex + fieldName.length);
      if (operatorIndex === -1) continue;

      const rhs = extractRhs(lines, i, operatorIndex + 1);
      if (rhs.length === 0) continue;

      let reason: string | null = null;
      if (rhs.includes(BANNED_RHS_SUBSTRING)) {
        reason = `\`${fieldName}\` assigned from \`${BANNED_RHS_SUBSTRING}\` — that is a list of Keycloak role names, not a tenant id`;
      } else {
        const hit = splitRhsBranches(rhs).find(isUserIdBranch);
        if (hit) {
          reason = `\`${fieldName}\` assigned from \`${hit}\` — that is a user id, not a tenant id`;
        }
      }
      if (reason === null) continue;

      offences.push({ file, line: i + 1, text: line.trim(), rhs, reason });
    }
  }
  return offences;
}

export interface AllowlistProblem {
  path: string;
  problem: string;
}

/** rot + vacuity + redundancy on ALLOWLIST; see the doc comment on ALLOWLIST. */
export function findAllowlistProblems(
  allowlist: Readonly<Record<string, string>>,
  offendingPaths: ReadonlySet<string>,
  fileExists: (path: string) => boolean,
): AllowlistProblem[] {
  const problems: AllowlistProblem[] = [];
  for (const [path, reason] of Object.entries(allowlist)) {
    if (!fileExists(path)) {
      problems.push({ path, problem: 'file no longer exists — delete this entry (rot)' });
      continue;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      problems.push({
        path,
        problem: `reason is ${reason.trim().length} chars, minimum is ${MIN_REASON_LENGTH} (vacuity)`,
      });
    }
    if (!offendingPaths.has(path)) {
      problems.push({ path, problem: 'file has no offence — delete this entry (redundancy)' });
    }
  }
  return problems;
}

/**
 * Exit code for "the guard ran and the code is bad". Distinct from
 * EXIT_BROKEN_GUARD so CI can tell a real offence from a broken invocation.
 */
export const EXIT_OFFENCES = 1;

/**
 * Exit code for "the guard itself is broken and proved nothing". A run that
 * scanned zero files is this, not a pass — see `emptyScanError`.
 */
export const EXIT_BROKEN_GUARD = 2;

/**
 * The message for a zero-file scan, or `null` when the scan actually covered
 * something. Pure, so the "zero files is an ERROR" invariant is assertable in a
 * unit test without spawning the CLI.
 *
 * WHY THIS EXISTS: a scan of zero files trivially finds zero offences, so the
 * success branch below cannot distinguish "the invariant holds" from "the walk
 * found nothing to look at". Before this, the latter printed
 * `OK: ... across 0 file(s)` and exited 0 — a guard that passes by scanning
 * nothing, which is how an invariant silently stops being enforced while CI
 * stays green. Zero files always means the invocation is broken (wrong cwd,
 * renamed root, empty checkout), never that the code is clean.
 */
export function emptyScanError(scanned: number, roots: ReadonlyArray<string>): string | null {
  if (scanned > 0) return null;
  return (
    `ERROR: the guard scanned 0 files — it proved NOTHING and is not a pass.\n\n` +
    `  looked in: ${roots.join(', ')}\n` +
    `  under:     ${BACKEND_DIR}\n\n` +
    `A zero-file scan means the invocation is broken (a renamed/missing root, an\n` +
    `incomplete checkout), not that the codebase is clean: zero files trivially\n` +
    `contain zero offences. Fix the invocation; do not treat this as green.`
  );
}

function main(): void {
  const offences: Offence[] = [];
  let scanned = 0;

  for (const root of ROOTS) {
    // Absolute, anchored on this script — see BACKEND_DIR. Reported paths stay
    // relative to the backend root (NOT to process.cwd()), so an ALLOWLIST key
    // means the same file no matter where the guard was invoked from.
    for (const file of listSourceFiles(join(BACKEND_DIR, root))) {
      if (isExcluded(file)) continue;
      scanned += 1;
      const rel = relative(BACKEND_DIR, file);
      offences.push(...findTenantFieldMisuse(readFileSync(file, 'utf8'), rel));
    }
  }

  // Checked FIRST: with zero files scanned every other signal below is vacuous
  // — no offences were possible, and every ALLOWLIST entry would look redundant.
  const emptyScan = emptyScanError(scanned, ROOTS);
  if (emptyScan !== null) {
    console.error(emptyScan);
    process.exit(EXIT_BROKEN_GUARD);
  }

  const offendingPaths = new Set(offences.map((o) => o.file));
  const allowlistProblems = findAllowlistProblems(ALLOWLIST, offendingPaths, (p) =>
    existsSync(join(BACKEND_DIR, p)),
  );
  const reported = offences.filter((o) => !(o.file in ALLOWLIST));

  if (allowlistProblems.length > 0) {
    console.error('ERROR: ALLOWLIST in scripts/check-tenant-field-misuse.ts is stale:\n');
    for (const p of allowlistProblems) {
      console.error(`  ${p.path}`);
      console.error(`    → ${p.problem}\n`);
    }
    process.exit(EXIT_OFFENCES);
  }

  if (reported.length === 0) {
    const exempt = Object.keys(ALLOWLIST).length;
    console.log(
      `OK: zero non-tenant values assigned to tenant_id/tenantId across ${scanned} file(s) in ${ROOTS.join(' + ')}` +
        (exempt > 0 ? ` (${exempt} allowlisted).` : '.'),
    );
    return;
  }

  console.error('ERROR: non-tenant value(s) assigned to a tenant field:\n');
  for (const o of reported) {
    console.error(`  ${o.file}:${o.line}`);
    console.error(`    ${o.text}`);
    console.error(`    → ${o.reason}\n`);
  }
  console.error(
    'A tenant field must receive a resolved tenant id — `ctx.tenantId`, the\n' +
      'session/claim-derived tenant, or a value read from a tenants row. Neither\n' +
      'the caller role list nor the user id is one, and neither the TypeScript\n' +
      '`string` type nor the `text` column will stop you writing it.\n' +
      'If an exception is genuinely correct, add it to ALLOWLIST at the top of\n' +
      'scripts/check-tenant-field-misuse.ts with a reason of at least ' +
      `${MIN_REASON_LENGTH} characters.`,
  );
  process.exit(EXIT_OFFENCES);
}

if (import.meta.main) main();
