// tests/unit/scripts/check-migration-dml-probed.test.ts
//
// Unit tests for `scripts/check-migration-dml-probed.ts` — the guard that
// stops a data-changing migration numbered >= 112 from shipping invisible to
// the migration runner's backfill probe.
//
// The guard is a CLI (walks the tree, calls process.exit), so the rule itself
// lives in pure functions (`stripSqlComments`, `findDataEffects`,
// `parseProbedMigrations`, `scanMigrations`) and the CLI body sits behind
// `if (import.meta.main)`. Same shape as
// `tests/unit/scripts/check-tenant-field-misuse.test.ts`.
//
// ⚠️ WHY THIS FILE MATTERS MORE THAN USUAL. The guard ships with ZERO
// violators by design — the floor was set one past 111, the highest migration
// on the tree when it was written, and the two files that have since landed at
// or above it (112 pure DDL, 113 probed) both satisfy the rule — so
// a green CI run says nothing at all about whether the rule can still fire.
// The only evidence that it fires is here: a synthetic 112 with DML must be
// REJECTED, and the same file with the annotation must be ACCEPTED. If a
// refactor makes the guard vacuous, these go green-on-nothing and this file
// fails.
//
// The comment-stripping cases are not decoration either. Every migration in
// this tree carries a long `--` prose header that discusses UPDATE/DELETE by
// name; a guard that counted prose would be all false positives and would be
// switched off within a week.
//
// No `mock.module()` (banned repo-wide, CI-guarded by
// `scripts/check-no-test-doubles.ts`) — none is needed.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  ANNOTATION,
  EXIT_BROKEN_GUARD,
  EXIT_OFFENCES,
  FLOOR_MIGRATION,
  HISTORICAL_DML_MIN,
  findDataEffects,
  parseProbedMigrations,
  scanMigrations,
  stripSqlComments,
} from '../../../scripts/check-migration-dml-probed';

const BACKEND_DIR = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const GUARD = join(BACKEND_DIR, 'scripts', 'check-migration-dml-probed.ts');

// ---------------------------------------------------------------------------
// The current tree
// ---------------------------------------------------------------------------

describe('the guard is GREEN on the tree it ships with', () => {
  test('the CLI exits 0 on the real migrations directory', () => {
    const proc = Bun.spawnSync(['bun', 'run', GUARD], { cwd: BACKEND_DIR });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain('OK');
    expect(proc.exitCode).toBe(0);
  });

  test('zero violations, because the floor is one past the highest migration', () => {
    const { violations } = scanMigrations();
    expect(violations).toEqual([]);
  });

  test('the detector still recognises the grandfathered DML migrations', () => {
    // The non-vacuity control the CLI enforces. Measured 2026-09-06: 24 of the
    // 111 migrations contain DML, of which only 072/076/081/104 are probed.
    const { historicalDml } = scanMigrations({ probed: new Set() });
    expect(historicalDml.length).toBeGreaterThanOrEqual(HISTORICAL_DML_MIN);
    // Aliased UPDATEs (`UPDATE projects p SET …`) were the blind spot found
    // while building this; pin the four that exposed it.
    for (const n of ['036', '047', '080', '107']) {
      expect(historicalDml.some((f) => f.startsWith(n))).toBe(true);
    }
  });

  test('the probe registry is parsed off disk, not restated', () => {
    const probed = parseProbedMigrations(
      readFileSync(join(BACKEND_DIR, 'src', 'db', 'migration-runner.ts'), 'utf8'),
    );
    // Non-vacuity only — the probe registry must not parse to nothing. No count
    // of registry entries is pinned; the named entry below is the positive control.
    expect(probed.size).toBeGreaterThan(0);
    expect(probed.has('104_user_roles_role_check.sql')).toBe(true);
  });

  test('the two exit codes are distinct — a finding is not a broken run', () => {
    expect(EXIT_OFFENCES).not.toBe(EXIT_BROKEN_GUARD);
  });
});

// ---------------------------------------------------------------------------
// The rule, against synthetic migrations
// ---------------------------------------------------------------------------

describe('scanMigrations — the rule at and above the floor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fr-dml-probed-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql: string) => writeFile(join(dir, name), sql);
  const scan = (probed: string[] = []) =>
    scanMigrations({ migrationsDir: dir, probed: new Set(probed) });

  const DML_112 = `-- 112_backfill_widget_owner.sql
--
-- Long prose header of the kind every migration in this tree carries.
-- It talks about the UPDATE it performs and the DELETE FROM it does not.
UPDATE widgets w
   SET owner_id = '00000000-0000-0000-0000-000000000000'
 WHERE owner_id IS NULL;
`;

  test('RED: a >=112 migration with DML, no probe and no annotation is a violation', async () => {
    await write('112_backfill_widget_owner.sql', DML_112);
    const { violations, scanned } = scan();
    expect(scanned).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe('112_backfill_widget_owner.sql');
    // Exactly ONE effect: the real UPDATE on line 5. The prose on line 4 names
    // both UPDATE and DELETE FROM and must contribute nothing.
    expect(violations[0]!.effects).toHaveLength(1);
    expect(violations[0]!.effects[0]!.kind).toBe('UPDATE');
    expect(violations[0]!.effects[0]!.line).toBe(5);
  });

  test('GREEN: the same file with the annotation in its header passes', async () => {
    await write(
      '112_backfill_widget_owner.sql',
      DML_112.replace(
        '-- Long prose',
        `-- ⚠️ ${ANNOTATION}: a fresh database has no rows to back-fill.\n-- Long prose`,
      ),
    );
    expect(scan().violations).toEqual([]);
  });

  test('GREEN: the same file with a COLUMN_PROBES entry passes', async () => {
    await write('112_backfill_widget_owner.sql', DML_112);
    expect(scan(['112_backfill_widget_owner.sql']).violations).toEqual([]);
  });

  test('GREEN: a >=112 DDL-only migration needs neither probe nor annotation', async () => {
    await write(
      '113_widgets_add_column.sql',
      `-- 113_widgets_add_column.sql
-- Pure DDL. drizzle-kit push reproduces this from schema.ts, so a stamped-
-- but-unrun file loses nothing. Mentions UPDATE and DELETE FROM in prose only.
ALTER TABLE widgets ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE widgets ADD CONSTRAINT widgets_owner_fk FOREIGN KEY (owner_id)
  REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS widgets_label_idx ON widgets (label);
`,
    );
    const { scanned, violations } = scan();
    expect(scanned).toBe(1);
    expect(violations).toEqual([]);
  });

  test('GREEN: an unprobed DML migration BELOW the floor is grandfathered', async () => {
    await write('111_legacy_backfill.sql', DML_112);
    const { scanned, violations, historicalDml } = scan();
    expect(scanned).toBe(0);
    expect(violations).toEqual([]);
    expect(historicalDml).toEqual(['111_legacy_backfill.sql']);
  });

  test('RED: INSERT / DELETE / TRUNCATE / TRIGGER / FUNCTION are each in scope', async () => {
    await write('112_insert.sql', 'INSERT INTO widgets (id) VALUES (1);');
    await write('113_delete.sql', 'DELETE FROM widgets WHERE id = 1;');
    await write('114_truncate.sql', 'TRUNCATE widget_cache;');
    await write(
      '115_trigger.sql',
      'CREATE OR REPLACE FUNCTION t() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;\n' +
        'CREATE TRIGGER widgets_t BEFORE INSERT ON widgets FOR EACH ROW EXECUTE FUNCTION t();',
    );
    const { violations } = scan();
    expect(violations.map((v) => v.number).sort()).toEqual([112, 113, 114, 115]);
    const kinds = violations.flatMap((v) => v.effects.map((e) => e.kind));
    for (const k of ['INSERT', 'DELETE', 'TRUNCATE', 'CREATE TRIGGER', 'CREATE FUNCTION']) {
      expect(kinds).toContain(k);
    }
  });

  test('the annotation must be a COMMENT — inside a string literal it does not count', async () => {
    await write(
      '112_sneaky.sql',
      `INSERT INTO audit (note) VALUES ('${ANNOTATION}');\n`,
    );
    expect(scan().violations).toHaveLength(1);
  });

  test('FLOOR_MIGRATION is one past the highest shipped migration', () => {
    expect(FLOOR_MIGRATION).toBe(112);
  });
});

// ---------------------------------------------------------------------------
// Comment stripping — load-bearing, see the guard's header
// ---------------------------------------------------------------------------

describe('stripSqlComments', () => {
  test('prose in a -- header is a comment, not code', () => {
    const { code, comments } = stripSqlComments(
      '-- this header discusses the UPDATE widgets SET it performs\nSELECT 1;\n',
    );
    expect(findDataEffects(code)).toEqual([]);
    expect(comments).toContain('UPDATE widgets SET');
  });

  test('a -- inside a string literal is NOT a comment', () => {
    const { code } = stripSqlComments(
      "INSERT INTO notes (body) VALUES ('-- not a comment');\nUPDATE notes n SET seen = true;\n",
    );
    // The UPDATE on line 2 survives: the quote did not swallow the file.
    expect(findDataEffects(code).map((e) => e.kind).sort()).toEqual(['INSERT', 'UPDATE']);
  });

  test("'' escapes do not terminate a literal early", () => {
    const { code } = stripSqlComments("SELECT 'it''s -- fine'; UPDATE t x SET a = 1;");
    expect(findDataEffects(code).map((e) => e.kind)).toEqual(['UPDATE']);
  });

  test('dollar-quoted bodies survive intact, comments after them still strip', () => {
    const { code, comments } = stripSqlComments(
      `DO $$ BEGIN UPDATE approvals a SET expires_at = now(); END $$;\n-- trailing INSERT INTO prose\n`,
    );
    expect(findDataEffects(code).map((e) => e.kind)).toEqual(['UPDATE']);
    expect(comments).toContain('INSERT INTO prose');
  });

  test('a $tag$ body containing -- is not truncated', () => {
    const { code } = stripSqlComments(
      "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN RAISE NOTICE '-- x'; END $body$ LANGUAGE plpgsql;\nDELETE FROM t;",
    );
    expect(findDataEffects(code).map((e) => e.kind).sort()).toEqual([
      'CREATE FUNCTION',
      'DELETE',
    ]);
  });

  test('nested /* */ blocks are stripped whole', () => {
    const { code, comments } = stripSqlComments(
      '/* outer /* inner UPDATE t x SET a = 1; */ still comment */ SELECT 1;',
    );
    expect(findDataEffects(code)).toEqual([]);
    expect(comments).toContain('still comment');
  });

  test('line numbers survive stripping', () => {
    const { code } = stripSqlComments('-- one\n/* two\n   three */\nDELETE FROM t;\n');
    expect(findDataEffects(code)[0]!.line).toBe(4);
  });
});

describe('findDataEffects — the DDL false-friends that must NOT match', () => {
  test('ON DELETE CASCADE / ON UPDATE CASCADE are not DML', () => {
    const sql =
      'ALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES c(id) ON DELETE CASCADE ON UPDATE CASCADE;';
    expect(findDataEffects(sql)).toEqual([]);
  });

  test('SELECT … FOR UPDATE SKIP LOCKED is not DML', () => {
    expect(findDataEffects('SELECT id FROM q ORDER BY id FOR UPDATE SKIP LOCKED;')).toEqual([]);
  });

  test('an aliased UPDATE across lines IS DML', () => {
    expect(findDataEffects('UPDATE projects p\n   SET dept_id = d.id\n').map((e) => e.kind)).toEqual(
      ['UPDATE'],
    );
  });
});

// ---------------------------------------------------------------------------
// ⭐ THE FIVE SHAPES THE DETECTOR WAS BLIND TO (audit, 2026-09-06)
//
// ⛔ THESE CASES ARE THE ONLY NON-VACUITY PROOF THESE PATTERNS HAVE. The
// HISTORICAL_DML_MIN control re-measured at exactly 24 after they were added:
// no migration below the floor uses MERGE, CTAS, a materialized view or
// setval(), so the control cannot notice if one of these regexes is broken.
// Break a pattern and only this block goes red.
//
// Each construct writes rows or moves state that `drizzle-kit push` cannot
// reproduce, so each was a way to land a data effect on a green CI while the
// guard reported a clean tree.
// ---------------------------------------------------------------------------

describe('findDataEffects — the constructs the detector was blind to', () => {
  test('MERGE INTO is DML (Postgres 15+; this fleet runs 18)', () => {
    const sql =
      'MERGE INTO approvals a USING staging s ON a.id = s.id\n' +
      ' WHEN MATCHED THEN UPDATE SET card_id = s.card_id\n' +
      ' WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);';
    expect(findDataEffects(sql).map((e) => e.kind)).toContain('MERGE');
  });

  test('CREATE TABLE AS SELECT materialises rows push cannot reproduce', () => {
    expect(
      findDataEffects('CREATE TABLE approvals_snapshot AS SELECT * FROM approvals;').map(
        (e) => e.kind,
      ),
    ).toEqual(['CREATE TABLE AS']);
  });

  test('CREATE TABLE … AS WITH … (a CTE-fed CTAS) is caught too', () => {
    expect(
      findDataEffects(
        'CREATE UNLOGGED TABLE IF NOT EXISTS t AS WITH x AS (SELECT 1) SELECT * FROM x;',
      ).map((e) => e.kind),
    ).toEqual(['CREATE TABLE AS']);
  });

  test('a plain CREATE TABLE is NOT DML — the anchor must hold', () => {
    expect(
      findDataEffects('CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY, name text);'),
    ).toEqual([]);
  });

  test('a column-list CTAS still matches', () => {
    expect(
      findDataEffects('CREATE TABLE t (a, b) AS SELECT x, y FROM src;').map((e) => e.kind),
    ).toEqual(['CREATE TABLE AS']);
  });

  test('CREATE MATERIALIZED VIEW is a data effect — push emits no views', () => {
    expect(
      findDataEffects('CREATE MATERIALIZED VIEW mv AS SELECT count(*) FROM approvals;').map(
        (e) => e.kind,
      ),
    ).toEqual(['CREATE MATERIALIZED VIEW']);
  });

  test('REFRESH MATERIALIZED VIEW is a data effect', () => {
    expect(
      findDataEffects('REFRESH MATERIALIZED VIEW CONCURRENTLY mv;').map((e) => e.kind),
    ).toEqual(['REFRESH MATERIALIZED VIEW']);
  });

  test('setval() advances a sequence — the silent duplicate-key', () => {
    expect(
      findDataEffects("SELECT setval('approvals_seq', (SELECT max(n) FROM approvals));").map(
        (e) => e.kind,
      ),
    ).toEqual(['SETVAL']);
  });

  // ⛔ CORRECTED 2026-09-06 (SECOND AUDIT). THIS CASE USED TO ASSERT
  //   test('nextval()/currval() are reads, not effects', () =>
  //     expect(findDataEffects("SELECT nextval('s'), currval('s');")).toEqual([]))
  // and it was WRONG ON THE FACTS, which made it worse than a missing case: it
  // pinned the detector's blind spot as the specification, so adding the
  // `nextval(` pattern would have gone RED and looked like the regression.
  //
  // `nextval()` is NOT a read. It ADVANCES the sequence as a side effect of
  // being evaluated, and the advance is non-transactional. The detector's own
  // comment on `setval(` already named `nextval()` as the thing that collides
  // after a stamped-not-run migration — the guard listed one and not the other
  // while its prose claimed both.
  //
  // `currval()` genuinely IS a read: it returns the value nextval() last
  // produced in this session and moves nothing. The two must not be treated
  // alike, which is why they are asserted separately below.
  test('nextval() ADVANCES a sequence — it is an effect, not a read', () => {
    expect(
      findDataEffects("INSERT INTO t (id) VALUES (nextval('t_id_seq'));").map((e) => e.kind).sort(),
    ).toEqual(['INSERT', 'NEXTVAL']);
    // Bare, with no INSERT around it — reserving a block of ids is still an effect.
    expect(findDataEffects("SELECT nextval('s');").map((e) => e.kind)).toEqual(['NEXTVAL']);
  });

  test('currval() really is a read and is NOT flagged', () => {
    // The control that stops the pattern above from being a blanket "any
    // *val( is DML" rule, which would flag a genuinely side-effect-free read.
    expect(findDataEffects("SELECT currval('s');")).toEqual([]);
  });

  test('all five are still found after comment stripping', () => {
    const { code } = stripSqlComments(
      '-- MERGE INTO discussed in prose must not count\n' +
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;\n" +
        'REFRESH MATERIALIZED VIEW mv;\n',
    );
    const kinds = findDataEffects(code).map((e) => e.kind);
    expect(kinds).toContain('MERGE');
    expect(kinds).toContain('REFRESH MATERIALIZED VIEW');
    // The prose occurrence on line 1 is stripped, so MERGE is found ONCE.
    expect(kinds.filter((k) => k === 'MERGE').length).toBe(1);
  });
});
