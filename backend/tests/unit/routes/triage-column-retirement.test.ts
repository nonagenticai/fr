// tests/unit/routes/triage-column-retirement.test.ts
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────
// The four `approvals.triage_*` columns were WRITE-ONLY: three write sites and,
// outside those write paths, ZERO readers in backend/src and ZERO in frontend/src.
// The only read anywhere was inside `handleTriageApproval`, which read back the row
// it had just written from its own `.returning()` — and no route in server.ts ever
// reached that handler. Every stored row carried the same constant pair
// ('escalate','policy'), because `triageApproval()` is a hardcoded pass-through.
//
// This suite holds the retirement in place along FOUR independent axes, each with
// its killing mutation named at the test. It is deliberately a SOURCE-SHAPE suite
// and needs no database, so it runs in CI's `bun test tests/unit/ tests/auth/ src/`
// step rather than in an integration tranche — a shape regression must redden on
// every push, not only on the runs that get a Postgres.
//
// ⚠️ EVERY TEST HERE CARRIES A POSITIVE CONTROL. An absence assertion over source
// text is worthless without one: a typo'd path, a comment-stripper that eats the
// region, or a renamed symbol all produce "not found" and read exactly like a pass.
// Each control asserts something that MUST be present in the very same haystack.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const BACKEND_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const read = (rel: string): string =>
  readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');

/** The four columns this PR stops writing. */
const TRIAGE_COLUMNS = [
  'triage_verdict',
  'triage_actor',
  'triage_rationale',
  'triage_at',
] as const;

// ---------------------------------------------------------------------------
// Comment stripper
// ---------------------------------------------------------------------------
//
// The retirement is documented in LONG comments that necessarily name the very
// identifiers these tests forbid in code. A raw grep would therefore redden on the
// tombstones that explain the change — noise that would get the suite deleted.
//
// ⚠️ THE STRIPPER IS PART OF THE INSTRUMENT, SO IT IS ITSELF CONTROLLED. It tracks
// string and template-literal state so a `//` inside `'http://…'` is not mistaken
// for a comment, but it is not a parser and a regex literal containing an escaped
// slash could still mislead it. That failure direction is OVER-stripping, which
// could hide a real write — so every caller pairs its absence assertion with a
// positive control drawn from the same stripped text. If the stripper ate the
// region, the control fails and the test goes red rather than silently green.
//
// Newlines are preserved so a reported offset still maps to the real file.
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    // inside a string / template literal
    if (c === '\\') { out += c; if (d !== undefined) out += d; i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    out += c; i += 1;
  }
  return out;
}

/** Every .ts file under backend/src, excluding co-located tests. */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { walkSrc(full, out); continue; }
    if (!full.endsWith('.ts')) continue;
    if (full.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('the triage_* columns are no longer written by anything', () => {
  // KILLING MUTATION: restore ONE key — e.g. put `triage_verdict: verdict,` back on
  // the `gateValues` insert in routes/webhooks.ts — and this goes RED naming the file.
  test('no INSERT or .set() anywhere in backend/src names a triage_* key', () => {
    // src/db/schema.ts is covered by its own test below (migration 212 removed the
    // declarations), so it is excluded here.
    const SCHEMA = path.join(BACKEND_ROOT, 'src', 'db', 'schema.ts');
    const files = walkSrc(path.join(BACKEND_ROOT, 'src')).filter((f) => f !== SCHEMA);
    // CONTROL: the walker found a real tree, and it found the two files that used to
    // carry the keys. A walker pointed at an empty or wrong directory would otherwise
    // report "no offenders" and read exactly like a pass.
    expect(files).toContain(path.join(BACKEND_ROOT, 'src', 'routes', 'webhooks.ts'));
    expect(files).toContain(path.join(BACKEND_ROOT, 'src', 'routes', 'execution-approvals.ts'));
    expect(files).toContain(path.join(BACKEND_ROOT, 'src', 'routes', 'approvals.ts'));

    const keyRe = new RegExp(`\\b(${TRIAGE_COLUMNS.join('|')})\\s*:`);
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, idx) => {
        if (keyRe.test(line)) {
          offenders.push(`${path.relative(BACKEND_ROOT, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  // POSITIVE CONTROL for the test above. If the stripper or the walker silently
  // destroyed the regions that used to hold the triage keys, the assertion above
  // would pass vacuously. These are real, adjacent keys on the very same two
  // inserts; they must survive stripping.
  test('CONTROL — the inserts that used to carry the keys are still readable', () => {
    const webhooks = stripComments(read('src/routes/webhooks.ts'));
    expect(webhooks).toContain('approver_user_id:');
    expect(webhooks).toContain('callback_path:');

    const execApprovals = stripComments(read('src/routes/execution-approvals.ts'));
    expect(execApprovals).toContain("kind: 'execution.ready_signoff'");
    expect(execApprovals).toContain('callback_path:');
  });

  // The in-memory seam survives BECAUSE it still has a reader: webhooks.ts refuses a
  // mint on `verdict === 'escalate' && !routing.approver`. What was removed is the
  // PERSISTENCE, which nothing ever read back.
  // KILLING MUTATION: delete that guard's `verdict ===` clause and this goes RED —
  // at which point `triageApproval`/`resolveTriageVerdict` are genuinely uncalled in
  // backend/src and must be deleted with their tests rather than left as dead code.
  test('the routing-only triage call still has its in-memory reader', () => {
    const webhooks = stripComments(read('src/routes/webhooks.ts'));
    expect(webhooks).toContain('resolveTriageVerdict(triage.verdict)');
    expect(webhooks).toContain("verdict === 'escalate'");

    // and the sibling path no longer calls it at all
    const execApprovals = stripComments(read('src/routes/execution-approvals.ts'));
    expect(execApprovals).not.toContain('triageApproval');
    expect(execApprovals).not.toContain('resolveTriageVerdict');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('no route reaches handleTriageApproval', () => {
  // KILLING MUTATION: re-register the route — add
  // `router.add('PATCH', '/api/approvals/:approvalId/triage', handleTriageApproval)`
  // to server.ts — and this goes RED on both the symbol and the path assertion.
  test('the handler is gone and server.ts registers nothing that reaches it', () => {
    const approvalsRoute = stripComments(read('src/routes/approvals.ts'));
    expect(approvalsRoute).not.toContain('handleTriageApproval');
    expect(approvalsRoute).not.toContain('TriageApprovalSchema');

    const server = read('src/server.ts');
    expect(server).not.toContain('handleTriageApproval');
    expect(server).not.toContain('/triage');
  });

  // POSITIVE CONTROL. `server.ts` really is the file that registers approval routes,
  // and `approvals.ts` really is the file that exports their handlers — so a "not
  // found" above is a genuine absence and not a wrong path or an empty read.
  test('CONTROL — server.ts does register the sibling approval routes', () => {
    const server = read('src/server.ts');
    // fr-agui P4d-2a: GET /api/approvals/:approvalId is capability-derived too (capabilities/approvals/approvals.ts).
    expect(server).toContain('// GET /api/approvals/:approvalId is capability-derived (P4d-2a');
    expect(read('src/capabilities/approvals/approvals.ts')).toContain("handler: 'handleGetApproval'");
    // PUT /api/approvals/:approvalId is capability-derived since fr-agui P0b: its
    // handler is bound in the declaration and registered by deriveRouter(router).
    expect(server).toContain('deriveRouter(router)');
    const decideCap = read('src/capabilities/approvals/decide.ts');
    expect(decideCap).toContain("exportName: 'handleUpdateApproval'");
    expect(decideCap).toContain("path: '/api/approvals/:approvalId'");

    const approvalsRoute = stripComments(read('src/routes/approvals.ts'));
    expect(approvalsRoute).toContain('export async function handleUpdateApproval');
    expect(approvalsRoute).toContain('export async function handleGetApproval');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('migration 212 drops the columns in BOTH emitters', () => {
  // The ordering rule (a column may not be dropped in the release that still writes it) was met:
  // nothing has written the columns since 2026-09-23. Migration 212 drops all four and the CHECK,
  // and schema.ts stops declaring them in the same change, so push and migrate agree.
  //
  // KILLING MUTATION: put a `triage_verdict: text('triage_verdict')` declaration back in schema.ts,
  // or delete a DROP line from 212 — either goes RED here.
  test('schema.ts declares none of the four columns', () => {
    const schema = stripComments(read('src/db/schema.ts'));
    for (const col of TRIAGE_COLUMNS) {
      expect(schema).not.toContain(`${col}:`);
    }
    // CONTROL: the stripped schema still holds the approvals table and a sibling column.
    expect(schema).toContain("export const approvals = pgTable('approvals'");
    expect(schema).toContain("voided_reason: text('voided_reason')");
  });

  test('migration 101 still adds them (history is not rewritten)', () => {
    const sql = read('migrations/101_approval_triage.sql');
    for (const col of TRIAGE_COLUMNS) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(sql).toContain('ADD CONSTRAINT approvals_triage_verdict_check');
  });

  test('migration 212 drops every column and the CHECK, and is the only file that does', () => {
    const dir = path.join(BACKEND_ROOT, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files).toContain('212_drop_approval_triage_columns.sql');

    const droppers = new Map<string, string[]>();
    for (const file of files) {
      const code = readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n');
      const hits: string[] = [];
      for (const col of TRIAGE_COLUMNS) {
        if (new RegExp(`DROP\\s+COLUMN\\s+(IF\\s+EXISTS\\s+)?${col}\\b`, 'i').test(code)) hits.push(col);
      }
      if (/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?approvals_triage_verdict_check\b/i.test(code)) {
        hits.push('approvals_triage_verdict_check');
      }
      if (hits.length > 0) droppers.set(file, hits);
    }
    expect([...droppers.keys()]).toEqual(['212_drop_approval_triage_columns.sql']);
    expect(droppers.get('212_drop_approval_triage_columns.sql')!.sort()).toEqual(
      [...TRIAGE_COLUMNS, 'approvals_triage_verdict_check'].sort(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("migration 101's probe is a witness a push-built database CANNOT satisfy", () => {
  // ⛔ WHY THIS TEST EXISTS AT ALL. `drizzle-kit push` builds the CI database from
  // schema.ts, so any artefact schema.ts models is created WITHOUT the migration
  // running. A probe pointed at such an artefact passes on a database that never ran
  // the file — that is how 101 was once stamped applied without running, twice over:
  // first via `tableExists('approvals')`, then via `columnExists('approver_user_id')`.
  // A probe that cannot fail is worse than no probe: it launders "I did not look"
  // into "I checked".
  //
  // The other half of "push cannot satisfy it": the index must not be declared in the
  // drizzle schema. This is the omission the probe's honesty rests on, and it is
  // exactly the condition the migration-runner's own 104 entry warns can silently
  // disappear.
  // KILLING MUTATION: declare `index('approvals_undelivered_idx')` in schema.ts's
  // `approvals` extras and this goes RED — correctly, because at that moment push
  // starts creating it and the probe becomes vacuous.
  test('schema.ts does not declare the index the probe reads', () => {
    // ⚠️ COMMENTS ARE STRIPPED FIRST, AND THAT IS THE SEMANTICALLY CORRECT INSTRUMENT,
    // not a convenience: the question is whether schema.ts DECLARES the index, because
    // a declaration is what makes `drizzle-kit push` create it. Prose naming the index
    // — and the tombstone on the triage columns names it, deliberately, to explain
    // where the probe went — declares nothing and must not redden this.
    const schema = stripComments(read('src/db/schema.ts'));
    expect(schema).not.toContain('approvals_undelivered_idx');

    // CONTROL: schema.ts is the file that declares indexes elsewhere, and the stripper
    // did not eat it — so a "not found" above is an absence rather than a mis-read or
    // over-stripped file.
    expect(schema).toContain("index('project_stakeholders_user_id_idx')");
    expect(schema).toContain("export const approvals = pgTable('approvals'");
  });

  // …and the migration really is what creates it, so the probe has something to find
  // on a database that DID run the file.
  test('migration 101 creates the index the probe reads', () => {
    const sql = read('migrations/101_approval_triage.sql');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS approvals_undelivered_idx');
  });

  // The synthetic fixture the runner's own suite replays must satisfy the registered
  // probe, or all of tests/unit/db/migration-runner.test.ts reds on the post-run
  // integrity check rather than on the thing it describes.
  test('the migration-runner fixture creates it too', () => {
    const fixture = read('tests/unit/db/migration-runner.test.ts');
    expect(fixture).toContain('CREATE INDEX IF NOT EXISTS approvals_undelivered_idx');
  });
});
