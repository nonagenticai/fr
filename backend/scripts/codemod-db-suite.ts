#!/usr/bin/env bun
// scripts/codemod-db-suite.ts
//
// Migrate tests/integration/** off the vacuous `if (!reachable) return;` idiom
// and onto tests/integration/helpers/db-suite.ts (`createDbSuite` / `itDb`).
//
// ⚠️ WHY THIS IS AN AST CODEMOD AND NOT A SED SCRIPT
// --------------------------------------------------
// The SAME text — `if (!reachable) return;` — is a BUG inside a `test()` body
// (the test passes having asserted nothing) and a CORRECT TEARDOWN GUARD inside
// `afterAll()` (without it, cleanup runs against a dead handle and the file
// errors for the wrong reason). ~1/3 of the ~295 occurrences are the correct
// kind, and 50-odd files contain BOTH shapes bound to the SAME identifier, so
// no textual discriminator exists. Only the position in the syntax tree — the
// nearest enclosing `test(...)`/`it(...)` call — separates them.
//
// MEASURED, not assumed: in the dominant shape the reachability probe runs
// inside `beforeAll`, NOT at module scope. That is decisive — `test.skipIf` is
// evaluated when a test is REGISTERED, which happens before any `beforeAll`
// body runs, so these files structurally cannot be repaired by pointing skipIf
// at their own flag. They need db-suite's module-level top-level-await probe.
//
// The transform is therefore deliberately MINIMAL — it does not touch the local
// flag or its probe at all:
//   1. `test('…', async () => { if (!reachable) return; … })`
//        → `itDb('…', async () => { … })`
//      ONLY when the guard is the first statement of a body whose nearest
//      enclosing call is a bare `test`/`it` identifier.
//   2. a local `const itDb = test.skipIf(!reachable);` (some files roll their own)
//        → deleted; the helper's `itDb` takes over.
//   3. inserts `const { itDb } = createDbSuite('<label>');` + the import.
// The local `let reachable` flag and EVERY before*/after* guard survive verbatim,
// so teardown never runs against a dead handle.
//
// Everything it declines to rewrite is PRINTED with file:line and a reason.
// Idempotent: a file already importing `createDbSuite` with no convertible
// guard left produces zero edits on a second run.
//
// Usage:
//   bun scripts/codemod-db-suite.ts                    # census / dry run, all files
//   bun scripts/codemod-db-suite.ts --apply <files...> # rewrite the named files

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, dirname, resolve, basename } from 'node:path';

import ts from 'typescript';

const ROOT = resolve(import.meta.dir, '..');
const HELPER = resolve(ROOT, 'tests/integration/helpers/db-suite.ts');

interface Skip {
  file: string;
  line: number;
  reason: string;
  text: string;
}
interface FileReport {
  file: string;
  converted: number;
  skips: Skip[];
  changed: boolean;
  note?: string;
}

type Edit = { start: number; end: number; text: string };

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The function-like node a statement lives in, and the call that received it. */
function enclosingCall(node: ts.Node): { fn: ts.Node; call: ts.CallExpression } | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n)
    ) {
      const p = n.parent;
      if (p && ts.isCallExpression(p) && p.arguments.some((a) => a === n)) {
        return { fn: n, call: p };
      }
      return undefined; // a plain helper function — not a hook, not a test
    }
    n = n.parent;
  }
  return undefined;
}

/** Root identifier of a callee: `test` for `test`, `test.skipIf(x)`, `test.only`. */
function calleeRoot(call: ts.CallExpression): { root: string; bare: boolean } {
  let e: ts.Expression = call.expression;
  let bare = true;
  for (;;) {
    if (ts.isIdentifier(e)) return { root: e.text, bare };
    if (ts.isPropertyAccessExpression(e)) {
      bare = false;
      e = e.expression;
      continue;
    }
    if (ts.isCallExpression(e)) {
      bare = false;
      e = e.expression;
      continue;
    }
    return { root: '<complex>', bare: false };
  }
}

const HOOKS = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const TESTS = new Set(['test', 'it']);

/** `if (!X) return;` / `if (!X) { return; }` → the identifier X, else undefined. */
function simpleNegatedGuard(stmt: ts.Statement): string | undefined {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return undefined;
  const t = stmt.thenStatement;
  const isBareReturn =
    (ts.isReturnStatement(t) && !t.expression) ||
    (ts.isBlock(t) &&
      t.statements.length === 1 &&
      ts.isReturnStatement(t.statements[0]!) &&
      !t.statements[0]!.expression);
  if (!isBareReturn) return undefined;
  const c = stmt.expression;
  if (
    ts.isPrefixUnaryExpression(c) &&
    c.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(c.operand)
  ) {
    return c.operand.text;
  }
  return undefined;
}

/** Any `if (…!X…) return;` where X appears — used to catch compound guards. */
function guardMentions(stmt: ts.Statement, name: string): boolean {
  if (!ts.isIfStatement(stmt)) return false;
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name) hit = true;
    ts.forEachChild(n, visit);
  };
  visit(stmt.expression);
  return hit;
}

/**
 * The file's reachability flag: a module-scope `let X = false;` that is assigned
 * `true` SOMEWHERE in the file. Deliberately does NOT require the probe to be
 * adjacent — measured, the probe usually sits inside `beforeAll`.
 */
function findFlag(sf: ts.SourceFile): string | undefined {
  const candidates: string[] = [];
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    if (!(s.declarationList.flags & ts.NodeFlags.Let)) continue;
    for (const d of s.declarationList.declarations) {
      if (
        ts.isIdentifier(d.name) &&
        d.initializer &&
        d.initializer.kind === ts.SyntaxKind.FalseKeyword
      ) {
        candidates.push(d.name.text);
      }
    }
  }
  if (candidates.length === 0) return undefined;
  const assigned = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.right.kind === ts.SyntaxKind.TrueKeyword
    ) {
      assigned.add(n.left.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return candidates.find((c) => assigned.has(c));
}

/**
 * A file's own hand-rolled `itDb` — either `test.skipIf(!X)` or a wrapper
 * `(name, fn) => test(name, async () => { if (!X) return; await fn(); })`.
 *
 * ⚠️ MEASURED THE HARD WAY. An earlier revision replaced ANY such wrapper
 * wholesale, and silently deleted the per-test setup that
 * a notifications integration test smuggled inside its
 * wrapper (`await ensureApprovalRow()` before every body). A wrapper that does
 * MORE than guard-and-delegate is therefore refused and reported, never
 * rewritten: dropping its extra statements is a regression the test suite
 * cannot see, because the tests it breaks were vacuous to begin with.
 */
function findLocalItDb(
  sf: ts.SourceFile,
  name: string,
): { start: number; end: number; safe: boolean; why: string; line: number } | undefined {
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    const d = s.declarationList.declarations[0];
    if (!d || !ts.isIdentifier(d.name) || d.name.text !== 'itDb' || !d.initializer) continue;
    const init = d.initializer;
    const span = {
      start: s.getStart(sf),
      end: s.getEnd(),
      line: lineOf(sf, s.getStart(sf)),
    };
    if (!init.getText(sf).includes(name)) continue;

    // `const itDb = test.skipIf(!reachable);` — pure, nothing to lose.
    if (ts.isCallExpression(init)) return { ...span, safe: true, why: '' };

    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) {
      return { ...span, safe: false, why: 'local itDb is neither a call nor a function literal' };
    }
    // Unwrap `(name, fn) => test(name, async () => { … })` down to the callback body.
    let body: ts.Node = init.body;
    if (ts.isBlock(body)) {
      if (body.statements.length !== 1) {
        return { ...span, safe: false, why: 'local itDb wrapper body has >1 statement' };
      }
      const only = body.statements[0]!;
      if (!ts.isExpressionStatement(only) && !ts.isReturnStatement(only)) {
        return { ...span, safe: false, why: 'local itDb wrapper body is not a single call' };
      }
      body = (only as ts.ExpressionStatement | ts.ReturnStatement).expression!;
    }
    if (!ts.isCallExpression(body)) {
      return { ...span, safe: false, why: 'local itDb wrapper does not directly call test()' };
    }
    const inner = body.arguments[1];
    if (!inner || (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner))) {
      return { ...span, safe: false, why: 'local itDb wrapper has no inline test callback' };
    }
    const stmts = ts.isBlock(inner.body) ? [...inner.body.statements] : [];
    // Everything that is NOT the reachability guard and NOT the `fn()` delegation
    // is work that would be LOST. Refuse the file if any such statement exists.
    const extra = stmts.filter((st) => {
      if (simpleNegatedGuard(st) === name) return false;
      const t = st.getText(sf).replace(/\s+/g, ' ').trim().replace(/;$/, '');
      return !/^(await )?fn\(\)$/.test(t) && !/^return (await )?fn\(\)$/.test(t);
    });
    if (extra.length > 0) {
      return {
        ...span,
        safe: false,
        why:
          `local itDb wrapper also runs per-test setup that would be LOST: ` +
          extra.map((e) => `\`${e.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}\``).join(', '),
      };
    }
    return { ...span, safe: true, why: '' };
  }
  return undefined;
}

function importSpecifier(file: string): string {
  let rel = relative(dirname(file), HELPER).replace(/\.ts$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function processFile(file: string, apply: boolean): FileReport {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const rel = relative(ROOT, file);
  const skips: Skip[] = [];
  const edits: Edit[] = [];

  const flag = findFlag(sf);
  const alreadyMigrated = src.includes('createDbSuite');

  if (!flag) {
    if (!alreadyMigrated && /if \(![A-Za-z_$][\w$]*\) return;/.test(src)) {
      skips.push({
        file: rel,
        line: 1,
        reason: 'FILE: has an `if (!X) return;` but no module-scope `let X = false` set to true',
        text: '(whole file)',
      });
    }
    return { file: rel, converted: 0, skips, changed: false };
  }
  const NAME = flag;

  // ---- classify every guard in the file -------------------------------------
  let convertible: { ifStmt: ts.Statement; call: ts.CallExpression }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const stmts = node.statements;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i]!;
        if (!guardMentions(s, NAME)) continue;
        const line = lineOf(sf, s.getStart(sf));
        const text = s.getText(sf).split('\n')[0]!.trim();
        const enc = enclosingCall(s);
        if (!enc) {
          skips.push({ file: rel, line, reason: 'guard is not inside any call callback', text });
          continue;
        }
        const { root, bare } = calleeRoot(enc.call);
        if (HOOKS.has(root)) {
          // ✅ THE LEGITIMATE KIND. Teardown must not run against a dead handle.
          continue;
        }
        if (!TESTS.has(root)) {
          skips.push({
            file: rel,
            line,
            reason: `enclosing call is \`${root}\` (not test/it/hook) — needs a human`,
            text,
          });
          continue;
        }
        if (!bare) {
          skips.push({
            file: rel,
            line,
            reason: `enclosing call is \`${enc.call.expression.getText(sf)}\` — not a bare test()/it()`,
            text,
          });
          continue;
        }
        if (simpleNegatedGuard(s) !== NAME) {
          skips.push({
            file: rel,
            line,
            reason: `compound or non-bare-return guard (not exactly \`if (!${NAME}) return;\`)`,
            text,
          });
          continue;
        }
        if (i !== 0) {
          skips.push({
            file: rel,
            line,
            reason: `guard is statement #${i + 1} of the body, not the first — setup would move`,
            text,
          });
          continue;
        }
        if (enc.fn.parent !== enc.call || (enc.call.arguments[1] as ts.Node) !== enc.fn) {
          skips.push({ file: rel, line, reason: 'callback is not argument 2 of the call', text });
          continue;
        }
        convertible.push({ ifStmt: s, call: enc.call });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // A file's own `const itDb = …` wrapper is replaced WHOLESALE, so any guard
  // living inside that declaration must not also get a per-site edit — the two
  // ranges overlap and applying both corrupts the file.
  const localRange = findLocalItDb(sf, NAME);
  if (localRange && !localRange.safe) {
    // Abort the WHOLE file: its tests all route through a wrapper we cannot
    // safely replace, so a partial rewrite would leave the file incoherent.
    skips.push({
      file: rel,
      line: localRange.line,
      reason: `FILE NOT CONVERTED — ${localRange.why}`,
      text: 'const itDb = …',
    });
    return { file: rel, converted: 0, skips, changed: false };
  }
  let absorbed = 0;
  if (localRange) {
    const before = convertible.length;
    convertible = convertible.filter(
      ({ ifStmt }) =>
        ifStmt.getStart(sf) < localRange.start || ifStmt.getEnd() > localRange.end,
    );
    absorbed = before - convertible.length;
  }

  if (convertible.length === 0 && absorbed === 0) {
    return {
      file: rel,
      converted: 0,
      skips,
      changed: false,
      note: alreadyMigrated ? 'already migrated' : 'no convertible guard',
    };
  }

  // ---- build edits ----------------------------------------------------------
  const label = basename(file).replace(/\.integration\.test\.ts$|\.test\.ts$|\.ts$/, '');

  // A file's hand-rolled `const itDb = test.skipIf(!reachable)` is REPLACED in
  // place (it cannot work — the flag is still false at registration time);
  // otherwise the suite is declared right after the imports.
  const local = localRange;
  const decl = `const { itDb } = createDbSuite('${label}');`;
  if (local) edits.push({ start: local.start, end: local.end, text: decl });

  for (const { ifStmt, call } of convertible) {
    edits.push({ start: call.expression.getStart(sf), end: call.expression.getEnd(), text: 'itDb' });
    // Swallow the trailing newline/indent so no blank line is left behind.
    let end = ifStmt.getEnd();
    while (end < src.length && (src[end] === ' ' || src[end] === '\t')) end++;
    if (src[end] === '\r') end++;
    if (src[end] === '\n') end++;
    let start = ifStmt.getStart(sf);
    while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) start--;
    edits.push({ start, end, text: '' });
  }

  // import (+ the suite declaration, when there was no local itDb to replace),
  // inserted after the last existing import statement.
  let lastImportEnd = 0;
  for (const s of sf.statements) if (ts.isImportDeclaration(s)) lastImportEnd = s.getEnd();
  let imp = `\n\nimport { createDbSuite } from '${importSpecifier(file)}';`;
  if (!local) imp += `\n\n${decl}`;
  edits.push({ start: lastImportEnd, end: lastImportEnd, text: imp });

  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  if (apply) writeFileSync(file, out, 'utf8');
  return { file: rel, converted: convertible.length + absorbed, skips, changed: true };
}

// ---- main -------------------------------------------------------------------
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
let files = argv.filter((a) => !a.startsWith('--')).map((f) => resolve(f));
if (files.length === 0) {
  files = [...new Bun.Glob('tests/integration/**/*.ts').scanSync({ cwd: ROOT, absolute: true })]
    .filter((f) => f !== HELPER)
    .sort();
}

const reports = files.map((f) => processFile(f, apply));
const allSkips = reports.flatMap((r) => r.skips);
const changed = reports.filter((r) => r.changed);

console.log(`\n=== ${apply ? 'APPLIED' : 'DRY RUN'} — ${files.length} file(s) examined ===\n`);
for (const r of changed) console.log(`  ${r.converted} guard(s)  ${r.file}`);
console.log(`\n--- SKIPPED SITES (${allSkips.length}) — each needs a human ---`);
for (const s of allSkips) console.log(`  ${s.file}:${s.line}  ${s.reason}\n      ${s.text}`);
console.log(
  `\ntotal: ${changed.reduce((n, r) => n + r.converted, 0)} guard(s) converted in ${changed.length} file(s); ${allSkips.length} skipped\n`,
);
