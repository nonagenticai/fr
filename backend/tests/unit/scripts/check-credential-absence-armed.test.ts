// backend/tests/unit/scripts/check-credential-absence-armed.test.ts
//
// The guard under test asserts that a credential-ABSENCE assertion runs in a
// frame that HAD a credential to leak. This file is the guard's own
// falsifiability proof: for every escape closed on 2026-09-07 there is a
// positive control here that FAILS if the fix is reverted, a negative control
// so the rule cannot pass by always firing, and a process-level control that
// runs the real CLI with the argv CI uses.
//
// ⚠️ NO MUTANT FIXTURE IS WRITTEN INTO `tests/`. Sibling guards walk this tree
// and count what they find, so a deliberately-broken `.test.ts` here would be
// read as a real defect by a different guard. Unit fixtures are in-memory
// strings passed to the exported `scanFile`; the two controls that need a real
// process use a throwaway tree under the OS temp dir and the guard's `--root=`
// seam.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_DETECTED, scanFile, testBlocks } from '../../../scripts/check-credential-absence-armed';

const BT = '`'; // backtick, so tagged-template fixtures stay readable here
const src = (...lines: string[]) => lines.join('\n');

// ⚠️ Every fixture line that IS a credential-absence assertion lives here, at
// module level, ABOVE the first test header — deliberately. The guard reads
// assertions from a view that keeps string literals (it must: the receiver in
// `res.headers.get('authorization')` lives inside one), so a fixture written
// inline in a test body would be scanned as a real unarmed assertion and this
// file would fail the guard it tests. Outside any block, they are invisible.
const ABSENCE = "  expect(captured.headers.authorization).toBeUndefined();";
const ABSENCE_VIA_LOCAL = [
  '  const sent = captured.headers.authorization;',
  '  expect(sent).toBeUndefined();',
];
const ARM = "  await withRequestContext({ bearerToken: CALLER_JWT }, async () => {});";

// ---------------------------------------------------------------------------
// GAP B — `.each` headers were invisible, so their blocks never existed
// ---------------------------------------------------------------------------
// The old TEST_HEADER required a quote IMMEDIATELY after `test(`. A `.each`
// header therefore matched nothing: the block's assertions were either absorbed
// into the PREVIOUS test's body (inheriting its arming, right or wrong) or, in
// a file whose every test is `.each`, dropped from the denominator entirely.
// MEASURED on this repo: 34 files changed block count once `.each` was
// recognised (+61 blocks), and tests/integration/routes/assets/
// workers.integration.test.ts went from 0 blocks to 1 — a whole file that the
// guard had been silently skipping.
describe('gap B: .each blocks are scanned', () => {
  test('array-table form is DETECTED and unarmed', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        "import { test, expect } from 'bun:test';",
        "test.each([['a'], ['b']])('forwards no credential for %s', async () => {",
        ABSENCE,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
    expect(f[0]!.waiver).toBeUndefined();
    expect(f[0]!.test).toBe('forwards no credential for %s');
  });

  test('generic-annotated array-table form is DETECTED', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        'test.each<[string, number]>([' + "['a', 1], ['b', 2]" + "])('no bearer for %s', async () => {",
        ABSENCE,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
  });

  test('tagged-template table form is DETECTED', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        'test.each' + BT + 'route   | verb',
        "  ${'/a'} | ${'GET'}",
        BT + "('no bearer on $route', async () => {",
        ABSENCE,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
  });

  test('it.each and describe.each open blocks too', () => {
    expect(
      testBlocks(src("it.each([[1]])('a %s', () => {});", "describe.each([[1]])('b %s', () => {});")).map(
        (b) => b.name,
      ),
    ).toEqual(['a %s', 'b %s']);
  });

  // Guards the SCOPE of the gap-B fix. Admitting plain `describe(` would move
  // block boundaries across the whole suite — a denominator change with no
  // defect behind it — so it is deliberately still not a block.
  test('plain describe( is still NOT a block', () => {
    expect(testBlocks("describe('group', () => {});").map((b) => b.name)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GAP C — the WORD `bearerToken` armed a test that supplied no credential
// ---------------------------------------------------------------------------
// MEASURED before the fix: adding the comment "we deliberately supply no
// bearerToken" to an unarmed test moved the repo count from 18 armed to 19.
// The guard could be disarmed by describing it.
describe('gap C: only CODE arms a test', () => {
  test('bearerToken in a COMMENT does not arm', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        "test('empty frame', async () => {",
        '  // this hop is deliberately entered with no bearerToken at all',
        ABSENCE,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
  });

  test('bearerToken in a STRING LITERAL does not arm', () => {
    const f = scanFile(
      'fixture.test.ts',
      src("test('empty frame', async () => {", "  const note = 'bearerToken';", ABSENCE, '});'),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
  });

  test('a block comment cannot open a phantom test block', () => {
    expect(testBlocks(src('/*', "test('commented out', () => {});", '*/')).map((b) => b.name)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GAP D — the assertion itself was invisible through a local variable
// ---------------------------------------------------------------------------
// `CREDENTIAL_RECEIVER` was tested only against the literal text inside
// `expect(...)`, so binding the header to a local first hid not merely the
// arming but the ASSERTION, and the block never entered the denominator.
describe('gap D: a credential bound to a local is still an absence assertion', () => {
  test('same-block binding is DETECTED', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        "test('routes through a local', async () => {",
        ...ABSENCE_VIA_LOCAL,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
  });

  // Conservative by design: a binding from an unrelated expression must not
  // drag an ordinary assertion into the denominator, or the guard inflates its
  // own count and the MIN_DETECTED floor stops meaning anything.
  test('a local bound from a NON-credential expression is not a finding', () => {
    expect(
      scanFile(
        'fixture.test.ts',
        src("test('unrelated', async () => {", '  const sent = captured.body.name;', '  expect(sent).toBeUndefined();', '});'),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shape the guard already caught — the fix must not trade one for another
// ---------------------------------------------------------------------------
test('the original plain test( unarmed shape is still DETECTED', () => {
  const f = scanFile('fixture.test.ts', src("test('no bearer forwarded', async () => {", ABSENCE, '});'));
  expect(f).toHaveLength(1);
  expect(f[0]!.armed).toBe(false);
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — without these the fix could be an always-fire rule
// ---------------------------------------------------------------------------
describe('a properly armed test is NOT flagged', () => {
  test('inline bearerToken in the body arms it', () => {
    const f = scanFile('fixture.test.ts', src("test('armed', async () => {", ARM, ABSENCE, '});'));
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(true);
  });

  test('an armed .each block is not flagged either', () => {
    const f = scanFile(
      'fixture.test.ts',
      src("test.each([['a']])('armed %s', async () => {", ARM, ABSENCE, '});'),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(true);
  });

  test('entering the frame with a file-level bearerToken constant arms it', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        'const CALLER_FRAME = { bearerToken: CALLER_JWT };',
        "test('armed via file constant', async () => {",
        '  await withRequestContext(CALLER_FRAME, async () => {});',
        ABSENCE,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(true);
  });

  test('a file with no credential assertions yields nothing', () => {
    expect(scanFile('fixture.test.ts', src("test('plain', () => { expect(1).toBe(1); });"))).toEqual([]);
  });

  test('an inline waiver with a reason is carried, not silently dropped', () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        "test('parser only', async () => {",
        '  // unarmed-absence-ok: pure parser, there is no request frame',
        ABSENCE,
        '});',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.armed).toBe(false);
    expect(f[0]!.waiver).toBe('pure parser, there is no request frame');
  });
});

// ---------------------------------------------------------------------------
// fr#1507 — test WRAPPERS were invisible, so the preceding it( absorbed them
// ---------------------------------------------------------------------------
// `itDb(` (tests/integration/helpers/db-suite.ts) heads ~2300 blocks in this
// repo. Unrecognised, each was folded into the last `it(` above it: its
// assertions were graded against THAT block's arming, and a waiver written for
// one of them covered every `itDb` down to the next `it(`. fr#1506 had to add
// such a waiver to the internal-computed-checks route suite; with
// this fix the false positive it answered no longer arises and it is removed.
describe('fr#1507: test wrappers open blocks', () => {
  test('MUST-FAIL: an unarmed absence in an itDb after an armed it( is reported AT the itDb line', () => {
    const f = scanFile(
      'fixture.test.ts',
      src("it('armed neighbour', async () => {", ARM, '});', '', "itDb('leaks nothing?', async () => {", ABSENCE, '});'),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(5);
    expect(f[0]!.test).toBe('leaks nothing?');
    expect(f[0]!.armed).toBe(false);
  });

  test("a waiver in the preceding it( no longer covers the itDb's unarmed assertion", () => {
    const f = scanFile(
      'fixture.test.ts',
      src(
        "it('parser only', async () => {",
        '  // unarmed-absence-ok: pure parser, there is no request frame',
        ABSENCE,
        '});',
        "itDb('real db path', async () => {",
        ABSENCE,
        '});',
      ),
    );
    expect(f.map((x) => [x.line, x.waiver === undefined])).toEqual([
      [1, false],
      [5, true],
    ]);
  });

  test('wrappers the FILE declares are admitted: createDbSuite alias, curried skipIf, (name, fn) arrow and function', () => {
    const names = testBlocks(
      src(
        "const { itDb: itDbBase } = createDbSuite('x');",
        'const itSkip = test.skipIf(!reachable);',
        'const ifReachable = (name: string, fn: () => Promise<void>) => test(name, fn);',
        'function ifDb(name: string, fn: () => Promise<void>): void { test(name, fn); }',
        "itDbBase('a', async () => {});",
        "itSkip('b', async () => {});",
        "ifReachable('c', async () => {});",
        "ifDb('d', async () => {});",
      ),
    ).map((b) => b.name);
    expect(names).toEqual(['a', 'b', 'c', 'd']);
  });

  test('test.skipIf(cond)(name, fn) called directly opens a block', () => {
    expect(testBlocks(src("test.skipIf(!dbReachable)('direct', async () => {});")).map((b) => b.name)).toEqual([
      'direct',
    ]);
  });

  // Negative controls: the rule must not admit every call that takes a name.
  test('NOT wrappers: a (name, body: string) helper, an undeclared call, a declaration inside a string', () => {
    const names = testBlocks(
      src(
        'const write = (name: string, body: string) => writeFile(name, body);',
        "const fixture = 'const fake = (name: string, fn: () => void) => test(name, fn);';",
        "write('a.txt', 'x');",
        "fake('b', () => {});",
        "someHelper('c', () => {});",
      ),
    ).map((b) => b.name);
    expect(names).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PROCESS-LEVEL CONTROLS — the real CLI, not the exported function
// ---------------------------------------------------------------------------
// A unit test that only calls `scanFile` grades a copy of the guard, not the
// guard: it cannot see a broken argv path, a wrong walk root, or an exit code
// that never becomes non-zero. These spawn the script.

const BACKEND = join(import.meta.dir, '..', '..', '..');
const GUARD = 'scripts/check-credential-absence-armed.ts';
const temps: string[] = [];

async function fixtureDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fr-cred-absence-guard-'));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body, 'utf8');
  }
  return dir;
}

async function runGuard(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(['bun', 'run', GUARD, ...args], { cwd: BACKEND, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

describe('the CLI fails closed', () => {
  test('zero test files walked is a non-zero exit, not a clean run', async () => {
    const dir = await fixtureDir();
    const r = await runGuard([`--root=${dir}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('walked zero test files');
  });

  test('detections below MIN_DETECTED are a non-zero exit', async () => {
    const dir = await fixtureDir({
      'a.test.ts': src("test('armed', async () => {", ARM, ABSENCE, '});'),
    });
    const r = await runGuard([`--root=${dir}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`below the MIN_DETECTED floor of ${MIN_DETECTED}`);
  });

  test('an UNARMED finding exits non-zero and names the file:line', async () => {
    const dir = await fixtureDir({
      'a.test.ts': src("test.each([['a']])('unarmed %s', async () => {", ABSENCE, '});'),
    });
    const r = await runGuard([`--root=${dir}`, '--report-only']);
    // --report-only keeps the exit at 0 on purpose; the UNARMED section is the
    // thing being asserted. The floor still applies, so this run dies on the
    // floor — which is itself the proof the finding was COUNTED.
    expect(r.stderr).toContain('detected 1 credential-absence assertions');
  });
});

test('PROCESS CONTROL: the real repo run, with the argv CI uses', async () => {
  // scripts/ci-verify.sh
  //   run: cd backend && bun run scripts/check-credential-absence-armed.ts
  const r = await runGuard([]);
  const line = r.stdout
    .split('\n')
    .find((l) => l.includes('[check-credential-absence-armed]'));
  expect(line).toBeDefined();
  // The denominator must be IN the output. A guard that prints only a verdict
  // cannot be audited for rot: "0 UNARMED" over 3 files reads like "0 UNARMED"
  // over 591.
  const m = line!.match(
    /(\d+) files, (\d+) credential-absence assertions: (\d+) armed, (\d+) waived, (\d+) UNARMED/,
  );
  expect(m).not.toBeNull();
  const n = m!.slice(1).map(Number);
  const [files, found, armed, waived, unarmed] = n as [number, number, number, number, number];
  // Non-vacuity only: the run must have scanned a real tree. The count is not
  // pinned (it moves with every file); the guard's own denominator line is.
  expect(files).toBeGreaterThan(0);
  expect(found).toBeGreaterThanOrEqual(MIN_DETECTED);
  expect(armed + waived + unarmed).toBe(found);
  expect(r.code).toBe(0);
});
