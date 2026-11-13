// U2 — H_r (src/lib/bug-report-hash.ts): RFC 8785 canonicalisation + hash body.
//
// The pinned vector below was computed INDEPENDENTLY of this module, with
// Python's json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)
// + hashlib.sha256 — a second implementation (the bug fingerprint ids too:
// hashlib.sha256(f"{file}\n{line}\n{kind}")), so a shared bug in "sort keys and
// stringify" cannot make the test agree with itself.
import { describe, expect, test } from 'bun:test';

import {
  BugReportDetailsSchema,
  bugFingerprint,
  bugReportHash,
  bugReportHashBody,
  canonicalizeJcs,
  type BugReportHashInput,
} from '../../../src/lib/bug-report-hash';

const ID_A = 'eb2d4266fd6cb256f73a14d5e37f35f049367ccefe1ce6af9acff43bcebffbc8'; // src/a.ts 10 null-deref
const ID_E = 'a2e09aee5f43da72b39a63256720d12302ff976af835777772f7f6f04f1eb9b1'; // src/é.ts 2 unquoted-string

const BASE: BugReportHashInput = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  project_id: null,
  card_id: '1700000000000000001',
  hunt: {
    status: 'completed',
    scanned_files: 42,
    tracked_source_files: 42,
    root_cause_analysis: null,
    // Deliberately UNSORTED: the canonical form below lists them sorted.
    excluded_dirs: ['node_modules', '.git', 'dist'],
    excluded_entry_kinds: ['symlink', 'non_utf8_path', 'submodule'],
    worktree_dirty: false,
  },
  repo: 'nonagenticai/fr',
  commit_sha: '5b0e3b77357a7fb2ce5de96cefe13f3b709ed82a',
  bugs: [
    {
      id: ID_A,
      kind: 'null-deref',
      location: { file: 'src/a.ts', line: 10 },
      failing_test: { path: 'tests/a.test.ts', name: 'a fails' },
      fix_outline: ['guard null', 'add test'],
    },
    {
      id: ID_E,
      kind: 'unquoted-string',
      location: { file: 'src/é.ts', line: 2 },
      failing_test: { path: 'tests/b.test.ts', name: 'b "quoted"' },
      fix_outline: ['x'],
    },
  ],
};

const PY_CANONICAL =
  '{"bugs":[{"failing_test":{"name":"b \\"quoted\\"","path":"tests/b.test.ts"},"fix_outline":["x"],"id":"a2e09aee5f43da72b39a63256720d12302ff976af835777772f7f6f04f1eb9b1","kind":"unquoted-string","location":{"file":"src/é.ts","line":2}},{"failing_test":{"name":"a fails","path":"tests/a.test.ts"},"fix_outline":["guard null","add test"],"id":"eb2d4266fd6cb256f73a14d5e37f35f049367ccefe1ce6af9acff43bcebffbc8","kind":"null-deref","location":{"file":"src/a.ts","line":10}}],"card_id":"1700000000000000001","commit_sha":"5b0e3b77357a7fb2ce5de96cefe13f3b709ed82a","hunt":{"excluded_dirs":[".git","dist","node_modules"],"excluded_entry_kinds":["non_utf8_path","submodule","symlink"],"root_cause_analysis":null,"scanned_files":42,"status":"completed","tracked_source_files":42,"worktree_dirty":false},"project_id":null,"repo":"nonagenticai/fr","schema":"bug_report/v1","tenant_id":"11111111-1111-4111-8111-111111111111"}';
// Regenerated 2026-10-04 when the hunt's declared scope (excluded_dirs,
// excluded_entry_kinds, worktree_dirty) joined H_r — same Python recipe, with
// both scope arrays sorted (Python sorted()).
const PY_HASH = 'ae66bdad22f5fd62450662e3ff37f6b26d07ad79cc81f199e4f6499c08429171';
const PY_HASH_EMPTY = 'c9f0af2965160a574d1954ca9eea0e9117b660d9e9467d143689083e9413ca05';

describe('bugFingerprint (bug id)', () => {
  test('matches an independent implementation (Python hashlib)', () => {
    expect(bugFingerprint('src/a.ts', 10, 'null-deref')).toBe(ID_A);
    expect(bugFingerprint('src/é.ts', 2, 'unquoted-string')).toBe(ID_E);
  });
  test('each of file, line, kind moves the id', () => {
    const ids = new Set([
      ID_A,
      bugFingerprint('src/b.ts', 10, 'null-deref'),
      bugFingerprint('src/a.ts', 11, 'null-deref'),
      bugFingerprint('src/a.ts', 10, 'other'),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe('canonicalizeJcs', () => {
  test('sorts keys recursively, no whitespace, keeps array order', () => {
    expect(canonicalizeJcs({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  test('key order of the input does not change the output', () => {
    expect(canonicalizeJcs({ x: 1, y: 'z', a: true })).toBe(canonicalizeJcs({ a: true, y: 'z', x: 1 }));
  });

  test('sorts keys by UTF-16 code units (RFC 8785 §3.2.3)', () => {
    // U+00E9 (é) sorts after 'z' (U+007A); '€' (€) after both.
    expect(canonicalizeJcs({ '€': 1, é: 2, z: 3 })).toBe('{"z":3,"é":2,"€":1}');
  });

  test('escapes strings the way ECMAScript JSON.stringify does', () => {
    expect(canonicalizeJcs('a"b\\c\n\u0001')).toBe('"a\\"b\\\\c\\n\\u0001"');
  });

  test('refuses values outside the admitted domain instead of approximating', () => {
    expect(() => canonicalizeJcs(1.5)).toThrow(TypeError);
    expect(() => canonicalizeJcs(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalizeJcs(2 ** 60)).toThrow(TypeError);
    expect(() => canonicalizeJcs({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalizeJcs(new Date(0))).toThrow(TypeError);
    expect(() => canonicalizeJcs(1n)).toThrow(TypeError);
  });

  test('matches an independent implementation (Python) byte for byte', () => {
    expect(canonicalizeJcs(bugReportHashBody(BASE))).toBe(PY_CANONICAL);
  });
});

describe('bugReportHash (H_r)', () => {
  test('pinned vector from an independent implementation', () => {
    expect(bugReportHash(BASE)).toBe(PY_HASH);
  });

  test('pinned vector for an honest empty result (complete hunt, no bugs)', () => {
    expect(bugReportHash({ ...BASE, bugs: [] })).toBe(PY_HASH_EMPTY);
  });

  test('deterministic: same input → same hash, 64 lowercase hex', () => {
    const a = bugReportHash(BASE);
    const b = bugReportHash(structuredClone(BASE) as BugReportHashInput);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('order-independent over bugs[]', () => {
    const reversed = { ...BASE, bugs: [...BASE.bugs].reverse() };
    expect(reversed.bugs[0]!.id).toBe(ID_E); // control: the order really changed
    expect(bugReportHash(reversed)).toBe(PY_HASH);
  });

  test('severity and confidence are excluded; unknown extra fields are dropped', () => {
    const scored = {
      ...BASE,
      bugs: BASE.bugs.map((b, i) => ({
        ...b,
        severity: i ? 'low' : 'critical',
        confidence: 0.37,
        smuggled: 'x',
      })),
    } as unknown as BugReportHashInput;
    expect(bugReportHash(scored)).toBe(PY_HASH);
  });

  test('trace_id is NOT hashed (a join key, not content): a smuggled trace_id leaves H_r unchanged', () => {
    const traced = { ...BASE, trace_id: '01999f3c-0000-7000-8000-000000000001' } as unknown as BugReportHashInput;
    expect(bugReportHash(traced)).toBe(PY_HASH);
  });

  test('order-independent over hunt.excluded_dirs and hunt.excluded_entry_kinds (they are sets)', () => {
    const reordered: BugReportHashInput = {
      ...BASE,
      hunt: { ...BASE.hunt, excluded_dirs: ['dist', 'node_modules', '.git'], excluded_entry_kinds: ['submodule', 'symlink', 'non_utf8_path'] },
    };
    expect(reordered.hunt.excluded_dirs).not.toEqual(BASE.hunt.excluded_dirs); // control: the order really changed
    expect(bugReportHash(reordered)).toBe(PY_HASH);
    // the input is not mutated by the sort
    expect(BASE.hunt.excluded_dirs).toEqual(['node_modules', '.git', 'dist']);
  });

  test('absent project_id hashes the same as an explicit null', () => {
    const { project_id: _omit, ...noProject } = BASE;
    expect(bugReportHash(noProject as BugReportHashInput)).toBe(PY_HASH);
  });

  test('every hashed field moves the hash (each change is a different artifact)', () => {
    const b0 = BASE.bugs[0]!;
    const variants: BugReportHashInput[] = [
      { ...BASE, tenant_id: '22222222-2222-4222-8222-222222222222' },
      { ...BASE, project_id: '33333333-3333-4333-8333-333333333333' },
      { ...BASE, card_id: '1700000000000000002' },
      { ...BASE, hunt: { ...BASE.hunt, scanned_files: 43, tracked_source_files: 43 } },
      { ...BASE, hunt: { ...BASE.hunt, status: 'analyzer_failed' } },
      { ...BASE, hunt: { ...BASE.hunt, root_cause_analysis: 'All clear.' } },
      { ...BASE, hunt: { ...BASE.hunt, excluded_dirs: ['node_modules', '.git'] } },
      { ...BASE, hunt: { ...BASE.hunt, excluded_dirs: ['node_modules', '.git', 'dist', 'vendor'] } },
      { ...BASE, hunt: { ...BASE.hunt, excluded_entry_kinds: ['symlink', 'submodule'] } },
      { ...BASE, hunt: { ...BASE.hunt, worktree_dirty: true } },
      { ...BASE, repo: 'nonagenticai/other' },
      { ...BASE, commit_sha: '0000000000000000000000000000000000000000' },
      { ...BASE, bugs: [{ ...b0, kind: 'other-kind' }, BASE.bugs[1]!] },
      { ...BASE, bugs: [{ ...b0, location: { file: 'src/a.ts', line: 11 } }, BASE.bugs[1]!] },
      { ...BASE, bugs: [{ ...b0, failing_test: { path: 'tests/a.test.ts', name: 'other' } }, BASE.bugs[1]!] },
      // fix_outline order is semantic (a sequence of steps).
      { ...BASE, bugs: [{ ...b0, fix_outline: ['add test', 'guard null'] }, BASE.bugs[1]!] },
      { ...BASE, bugs: [b0] },
    ];
    const hashes = new Set(variants.map(bugReportHash));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(PY_HASH)).toBe(false);
  });
});

describe('BugReportDetailsSchema', () => {
  const details = {
    schema: 'bug_report/v1',
    hunt: {
      status: 'completed',
      scanned_files: 42,
      tracked_source_files: 42,
      root_cause_analysis: null as string | null,
      excluded_dirs: ['.git', 'node_modules'],
      excluded_entry_kinds: ['non_utf8_path', 'submodule', 'symlink'],
      worktree_dirty: false,
    },
    repo: 'r',
    commit_sha: 'c',
    bugs: BASE.bugs,
  };
  const paths = (r: { success: boolean; error?: { issues: Array<{ path: Array<string | number> }> } }) =>
    (r.error?.issues ?? []).map((i) => i.path.join('.'));

  test('accepts a well-formed v1 body', () => {
    expect(BugReportDetailsSchema.safeParse(details).success).toBe(true);
  });

  test('hunt: complete + empty bugs is an honest empty result (accepted)', () => {
    expect(BugReportDetailsSchema.safeParse({ ...details, bugs: [] }).success).toBe(true);
  });

  test('hunt: analyzer_failed is refused, even with no bugs', () => {
    const r = BugReportDetailsSchema.safeParse({ ...details, bugs: [], hunt: { ...details.hunt, status: 'analyzer_failed' } });
    expect(r.success).toBe(false);
    expect(paths(r)).toContain('hunt.status');
  });

  test('hunt: a partial scan (scanned < tracked) is refused', () => {
    const r = BugReportDetailsSchema.safeParse({ ...details, bugs: [], hunt: { ...details.hunt, scanned_files: 41 } });
    expect(r.success).toBe(false);
    expect(paths(r)).toEqual(['hunt.scanned_files']);
  });

  test('hunt.root_cause_analysis "Analysis failed: …" is refused EVEN WITH status completed', () => {
    const r = BugReportDetailsSchema.safeParse({ ...details, bugs: [], hunt: { ...details.hunt, root_cause_analysis: 'Analysis failed: x' } });
    expect(r.success).toBe(false);
    expect(paths(r)).toEqual(['hunt.root_cause_analysis']);
  });

  test('hunt.root_cause_analysis null or normal text is accepted; the key itself is required', () => {
    expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, root_cause_analysis: null } }).success).toBe(true);
    expect(
      BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, root_cause_analysis: 'Two null derefs in a.ts.' } }).success,
    ).toBe(true);
    // Only the PREFIX refuses: the phrase elsewhere in a normal text is fine.
    expect(
      BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, root_cause_analysis: 'Earlier note: Analysis failed: x' } }).success,
    ).toBe(true);
    const { root_cause_analysis: _r, ...noRca } = details.hunt;
    expect(paths(BugReportDetailsSchema.safeParse({ ...details, hunt: noRca }))).toEqual(['hunt.root_cause_analysis']);
  });

  test('hunt: missing, or a negative / fractional count, is refused', () => {
    const { hunt: _h, ...noHunt } = details;
    expect(paths(BugReportDetailsSchema.safeParse(noHunt))).toContain('hunt');
    expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, scanned_files: -1, tracked_source_files: -1 } }).success).toBe(false);
    expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, scanned_files: 1.5, tracked_source_files: 1.5 } }).success).toBe(false);
  });

  test('hunt scope: each of excluded_dirs, excluded_entry_kinds, worktree_dirty is REQUIRED', () => {
    for (const key of ['excluded_dirs', 'excluded_entry_kinds', 'worktree_dirty'] as const) {
      const { [key]: _omit, ...rest } = details.hunt;
      expect(paths(BugReportDetailsSchema.safeParse({ ...details, hunt: rest }))).toEqual([`hunt.${key}`]);
    }
  });

  test('hunt scope: worktree_dirty null (or a non-boolean) is refused; true and false are accepted', () => {
    expect(paths(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, worktree_dirty: null } }))).toEqual([
      'hunt.worktree_dirty',
    ]);
    expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, worktree_dirty: 'false' } }).success).toBe(false);
    expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, worktree_dirty: true } }).success).toBe(true);
  });

  test('hunt scope: an excluded_entry_kinds value outside the agent enum is refused', () => {
    expect(
      paths(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, excluded_entry_kinds: ['symlink', 'hardlink'] } })),
    ).toEqual(['hunt.excluded_entry_kinds.1']);
    // control: every agent kind, and the empty set, are accepted
    for (const kinds of [['non_utf8_path'], ['submodule'], ['symlink'], []]) {
      expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, excluded_entry_kinds: kinds } }).success).toBe(true);
    }
  });

  test('hunt scope: duplicate or empty-string entries are refused', () => {
    expect(paths(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, excluded_dirs: ['.git', 'dist', '.git'] } }))).toEqual([
      'hunt.excluded_dirs.2',
    ]);
    expect(paths(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, excluded_dirs: [''] } }))).toEqual([
      'hunt.excluded_dirs.0',
    ]);
    expect(
      paths(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, excluded_entry_kinds: ['symlink', 'symlink'] } })),
    ).toEqual(['hunt.excluded_entry_kinds.1']);
    expect(BugReportDetailsSchema.safeParse({ ...details, hunt: { ...details.hunt, excluded_dirs: [] } }).success).toBe(true);
  });

  test('a bug id that is not sha256(file\\nline\\nkind) is refused', () => {
    const r = BugReportDetailsSchema.safeParse({ ...details, bugs: [{ ...BASE.bugs[0]!, id: ID_E }] });
    expect(r.success).toBe(false);
    expect(paths(r)).toEqual(['bugs.0.id']);
    // control: the right id for the same item is accepted
    expect(BugReportDetailsSchema.safeParse({ ...details, bugs: [BASE.bugs[0]] }).success).toBe(true);
  });

  test('a bug missing kind is refused', () => {
    const { kind: _k, ...noKind } = BASE.bugs[0]!;
    expect(BugReportDetailsSchema.safeParse({ ...details, bugs: [noKind] }).success).toBe(false);
  });

  test('refuses duplicate bug ids, a bug missing its failing test, a non-integer line, another schema id', () => {
    expect(paths(BugReportDetailsSchema.safeParse({ ...details, bugs: [BASE.bugs[0], BASE.bugs[0]] }))).toEqual([
      'bugs.1.id',
    ]);
    const { failing_test: _f, ...noTest } = BASE.bugs[0]!;
    expect(BugReportDetailsSchema.safeParse({ ...details, bugs: [noTest] }).success).toBe(false);
    expect(
      BugReportDetailsSchema.safeParse({
        ...details,
        bugs: [{ ...BASE.bugs[0], location: { file: 'src/a.ts', line: 1.5 } }],
      }).success,
    ).toBe(false);
    expect(BugReportDetailsSchema.safeParse({ ...details, schema: 'bug_report/v2' }).success).toBe(false);
  });
});
