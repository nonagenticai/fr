// tests/unit/services/constraint-check.test.ts
//
// Table-driven: every CHECKABLE kind gets at least one diff that MUST violate
// and one that MUST pass. A rule with no proven failing case is theatre.

import { describe, expect, test } from 'bun:test';

import {
  INCLUDE_CHANGED,
  LANGUAGE_FILE_NOT_PARSED,
  LANGUAGE_VERSION_FILE_PATTERNS,
  PATCH_UNAVAILABLE,
  SUBMODULE_ADDED,
  SUBMODULE_BUMPED,
  DEPENDENCY_FILE_NOT_PARSED,
  DEPENDENCY_FILE_PATTERNS,
  evaluateConstraints,
  isDependencyFile,
  isLanguageVersionFile,
  pathMatchesGlob,
  versionSatisfiesPin,
  type PrFile,
} from '../../../src/services/constraint-check';
import { CHECKABLE_KINDS, type CheckableKind } from '../../../src/types/project-constraints';

/** Exhaustiveness pin: every CHECKABLE kind has a rule in src/services/constraint-check.ts. */
const ENFORCED_KINDS: readonly CheckableKind[] = [
  'no_files_touched',
  'no_new_dependencies',
  'no_dependency_upgrades',
  'no_language_version_change',
  'pin_language_version',
];

/** Build a GitHub-style patch: one hunk NOT at the top of the file unless `top`. */
function patch(lines: string[], top = false): string {
  return [`@@ -${top ? 1 : 40},7 +${top ? 1 : 40},8 @@`, ...lines].join('\n');
}

const f = (filename: string, p: string | null, status = 'modified', previous_filename?: string): PrFile => ({
  filename,
  status,
  patch: p,
  previous_filename,
});

const NEW_DEP = { kind: 'no_new_dependencies' } as const;
const NO_UPG = { kind: 'no_dependency_upgrades' } as const;
const NO_LANG = { kind: 'no_language_version_change' } as const;
const PIN_PY = { kind: 'pin_language_version', language: 'python', version: '3.12' } as const;
const PIN_NODE = { kind: 'pin_language_version', language: 'node', version: '20' } as const;
const PIN_GO = { kind: 'pin_language_version', language: 'go', version: '1.22' } as const;

// ─── package.json ────────────────────────────────────────────────────────────
const PKG_ADD = patch([' "dependencies": {', '   "zod": "^3.24.1",', '+  "lodash": "^4.17.21",', '   "jose": "^5.9.6"']);
const PKG_UPGRADE = patch([' "dependencies": {', '-  "zod": "^3.24.1",', '+  "zod": "^3.25.0",', '   "jose": "^5.9.6"']);
const PKG_SCRIPTS = patch([' "scripts": {', '-  "build": "tsc",', '+  "build": "tsc -b",', '   "test": "bun test"']);
const PKG_ENGINES = patch([' "engines": {', '-  "node": ">=18"', '+  "node": ">=22"', ' },']);
const PKG_ADD_UNKNOWN_SECTION = patch(['     "zod": "^3.24.1",', '+    "left-pad": "1.3.0",', '     "jose": "^5.9.6"']);
const PKG_MOVE_TO_DEV = patch([
  ' "dependencies": {',
  '-  "typescript": "^5.9.3",',
  '   "zod": "^3.24.1"',
  ' },',
  ' "devDependencies": {',
  '+  "typescript": "^5.9.3",',
]);

// ─── python ──────────────────────────────────────────────────────────────────
const PY_ADD = patch(['[project]', ' dependencies = [', '   "fastapi>=0.115",', '+  "httpx>=0.27",', ' ]']);
const PY_UPGRADE = patch([' dependencies = [', '-  "fastapi>=0.115",', '+  "fastapi>=0.116",', ' ]']);
const PY_REQUIRES = patch([' name = "svc"', '-requires-python = ">=3.12"', '+requires-python = ">=3.13"']);
const PY_METADATA = patch(['[project]', '-description = "old"', '+description = "new"']);
const PY_POETRY = patch(['[tool.poetry.dependencies]', ' python = "^3.12"', '+requests = "^2.32"']);
const PY_UV_DEV = patch(['[tool.uv]', ' dev-dependencies = [', '+  "pytest>=8",', ' ]']);
const REQ_ADD = patch(['+requests==2.32.3', ' flask==3.0.0'], true);
const REQ_UPGRADE = patch(['-flask==3.0.0', '+flask==3.1.0'], true);
const REQ_COMMENT = patch(['+# a comment', ' flask==3.0.0'], true);

// ─── go / cargo ──────────────────────────────────────────────────────────────
const GO_ADD = patch([' require (', ' \tgithub.com/a/b v1.2.3', '+\tgithub.com/c/d v0.4.0', ' )']);
const GO_UPGRADE = patch([' require (', '-\tgithub.com/a/b v1.2.3', '+\tgithub.com/a/b v1.3.0', ' )']);
const GO_DIRECTIVE = patch([' module example.com/x', ' ', '-go 1.22', '+go 1.23'], true);
const CARGO_ADD = patch(['[dependencies]', ' serde = "1.0"', '+tokio = { version = "1.40", features = ["full"] }']);
const CARGO_UPGRADE = patch(['[dependencies]', '-serde = "1.0"', '+serde = "1.1"']);
const CARGO_PKG_VERSION = patch(['[package]', '-version = "0.1.0"', '+version = "0.2.0"']);

describe('exhaustiveness', () => {
  test('every CHECKABLE kind has a rule, and nothing else claims one', () => {
    expect(new Set(ENFORCED_KINDS)).toEqual(new Set(CHECKABLE_KINDS));
    expect(CHECKABLE_KINDS).not.toContain('must_keep_api_compatible' as never);
    expect(CHECKABLE_KINDS).not.toContain('custom' as never);
  });
});

type Case = {
  name: string;
  constraints: unknown[];
  files: PrFile[];
  verdict: 'pass' | 'violation' | 'unchecked_only';
  violationKinds?: string[];
  detailIncludes?: string;
};

const CASES: Case[] = [
  // ── no_new_dependencies ──
  { name: 'npm: new dep → violation', constraints: [NEW_DEP], files: [f('package.json', PKG_ADD)], verdict: 'violation', violationKinds: ['no_new_dependencies'], detailIncludes: 'lodash' },
  { name: 'npm: upgrade is not a NEW dep', constraints: [NEW_DEP], files: [f('package.json', PKG_UPGRADE)], verdict: 'pass' },
  { name: 'npm: scripts edit is clean', constraints: [NEW_DEP, NO_UPG], files: [f('package.json', PKG_SCRIPTS)], verdict: 'pass' },
  { name: 'npm: moving a dep to devDependencies is not new', constraints: [NEW_DEP, NO_UPG], files: [f('package.json', PKG_MOVE_TO_DEV)], verdict: 'pass' },
  { name: 'npm: unseen section + version-spec pair → presumed dep (fail closed)', constraints: [NEW_DEP], files: [f('web/package.json', PKG_ADD_UNKNOWN_SECTION)], verdict: 'violation', violationKinds: ['no_new_dependencies'] },
  { name: 'pyproject: new dep → violation', constraints: [NEW_DEP], files: [f('pyproject.toml', PY_ADD)], verdict: 'violation', violationKinds: ['no_new_dependencies'], detailIncludes: 'httpx' },
  { name: 'pyproject: poetry dep → violation', constraints: [NEW_DEP], files: [f('pyproject.toml', PY_POETRY)], verdict: 'violation', violationKinds: ['no_new_dependencies'], detailIncludes: 'requests' },
  { name: 'pyproject: tool.uv dev-dependencies → violation', constraints: [NEW_DEP], files: [f('pyproject.toml', PY_UV_DEV)], verdict: 'violation', violationKinds: ['no_new_dependencies'] },
  { name: 'pyproject: metadata edit is clean', constraints: [NEW_DEP, NO_UPG], files: [f('pyproject.toml', PY_METADATA)], verdict: 'pass' },
  { name: 'requirements.txt: new dep → violation', constraints: [NEW_DEP], files: [f('requirements-dev.txt', REQ_ADD)], verdict: 'violation', violationKinds: ['no_new_dependencies'] },
  { name: 'requirements.txt: comment only is clean', constraints: [NEW_DEP], files: [f('requirements.txt', REQ_COMMENT)], verdict: 'pass' },
  { name: 'go.mod: new require → violation', constraints: [NEW_DEP], files: [f('go.mod', GO_ADD)], verdict: 'violation', violationKinds: ['no_new_dependencies'] },
  { name: 'Cargo.toml: new dep → violation', constraints: [NEW_DEP], files: [f('Cargo.toml', CARGO_ADD)], verdict: 'violation', violationKinds: ['no_new_dependencies'], detailIncludes: 'tokio' },
  { name: 'Cargo.toml: package version bump is clean', constraints: [NEW_DEP, NO_UPG], files: [f('Cargo.toml', CARGO_PKG_VERSION)], verdict: 'pass' },
  { name: 'non-manifest source file is clean', constraints: [NEW_DEP, NO_UPG], files: [f('src/app.ts', patch(['+import x from "lodash";']))], verdict: 'pass' },

  // ── no_dependency_upgrades ──
  { name: 'npm: upgrade → violation', constraints: [NO_UPG], files: [f('package.json', PKG_UPGRADE)], verdict: 'violation', violationKinds: ['no_dependency_upgrades'], detailIncludes: 'zod' },
  { name: 'npm: new dep is not an upgrade', constraints: [NO_UPG], files: [f('package.json', PKG_ADD), f('package-lock.json', null)], verdict: 'pass' },
  { name: 'pyproject: upgrade → violation', constraints: [NO_UPG], files: [f('pyproject.toml', PY_UPGRADE)], verdict: 'violation', violationKinds: ['no_dependency_upgrades'] },
  { name: 'requirements.txt: upgrade → violation', constraints: [NO_UPG], files: [f('requirements.txt', REQ_UPGRADE)], verdict: 'violation', violationKinds: ['no_dependency_upgrades'] },
  { name: 'go.mod: upgrade → violation', constraints: [NO_UPG], files: [f('go.mod', GO_UPGRADE)], verdict: 'violation', violationKinds: ['no_dependency_upgrades'] },
  { name: 'Cargo.toml: upgrade → violation', constraints: [NO_UPG], files: [f('Cargo.toml', CARGO_UPGRADE)], verdict: 'violation', violationKinds: ['no_dependency_upgrades'] },
  { name: 'lockfile-only change → upgrade violation', constraints: [NO_UPG], files: [f('uv.lock', patch(['-version = "1.0"', '+version = "1.1"']))], verdict: 'violation', violationKinds: ['no_dependency_upgrades'], detailIncludes: 'lockfile' },
  { name: 'lockfile + non-dep manifest edit → still a violation', constraints: [NO_UPG], files: [f('package.json', PKG_SCRIPTS), f('bun.lock', null)], verdict: 'violation', violationKinds: ['no_dependency_upgrades'] },
  { name: 'nested manifest explains a root lockfile', constraints: [NO_UPG], files: [f('crates/a/Cargo.toml', patch(['[dependencies]', '-serde = "1.0"'])), f('Cargo.lock', patch(['-x']))], verdict: 'pass' },
  { name: 'lockfile is ignored by no_new_dependencies alone', constraints: [NEW_DEP], files: [f('go.sum', patch(['+x']))], verdict: 'pass' },

  // ── no_language_version_change ──
  { name: '.python-version change → violation', constraints: [NO_LANG], files: [f('.python-version', patch(['-3.12', '+3.13'], true))], verdict: 'violation', violationKinds: ['no_language_version_change'] },
  { name: '.nvmrc added → violation', constraints: [NO_LANG], files: [f('.nvmrc', patch(['+22'], true), 'added')], verdict: 'violation', violationKinds: ['no_language_version_change'] },
  { name: 'package.json engines change → violation', constraints: [NO_LANG], files: [f('package.json', PKG_ENGINES)], verdict: 'violation', violationKinds: ['no_language_version_change'] },
  { name: 'requires-python change → violation', constraints: [NO_LANG], files: [f('pyproject.toml', PY_REQUIRES)], verdict: 'violation', violationKinds: ['no_language_version_change'] },
  { name: 'go directive change → violation', constraints: [NO_LANG], files: [f('go.mod', GO_DIRECTIVE)], verdict: 'violation', violationKinds: ['no_language_version_change'] },
  { name: 'rust-toolchain.toml change → violation', constraints: [NO_LANG], files: [f('rust-toolchain.toml', patch(['[toolchain]', '-channel = "1.80"', '+channel = "1.82"'], true))], verdict: 'violation', violationKinds: ['no_language_version_change'] },
  { name: 'dependency edit is not a language change', constraints: [NO_LANG], files: [f('package.json', PKG_UPGRADE), f('pyproject.toml', PY_ADD)], verdict: 'pass' },

  // ── pin_language_version ──
  { name: 'pin python 3.12: .python-version → 3.13 violates', constraints: [PIN_PY], files: [f('.python-version', patch(['-3.12.4', '+3.13.0'], true))], verdict: 'violation', violationKinds: ['pin_language_version'] },
  { name: 'pin python 3.12: .python-version patch 3.12.4 → 3.12.7 is clean', constraints: [PIN_PY], files: [f('.python-version', patch(['-3.12.4', '+3.12.7'], true))], verdict: 'pass' },
  { name: 'pin python 3.12: requires-python >=3.13 violates', constraints: [PIN_PY], files: [f('pyproject.toml', PY_REQUIRES)], verdict: 'violation', violationKinds: ['pin_language_version'] },
  { name: 'pin python 3.12: .nvmrc change is another language', constraints: [PIN_PY], files: [f('.nvmrc', patch(['-18', '+22'], true))], verdict: 'pass' },
  { name: 'pin node 20: engines >=22 violates', constraints: [PIN_NODE], files: [f('package.json', PKG_ENGINES)], verdict: 'violation', violationKinds: ['pin_language_version'] },
  { name: 'pin go 1.22: go 1.23 violates', constraints: [PIN_GO], files: [f('go.mod', GO_DIRECTIVE)], verdict: 'violation', violationKinds: ['pin_language_version'] },
  { name: 'pin go 1.22 (as golang in .tool-versions) → nodejs line is clean', constraints: [PIN_GO], files: [f('.tool-versions', patch(['-nodejs 20.1.0', '+nodejs 22.0.0'], true))], verdict: 'pass' },
  { name: 'pin go 1.22: .tool-versions golang 1.23 violates', constraints: [PIN_GO], files: [f('.tool-versions', patch(['-golang 1.22.1', '+golang 1.23.0'], true))], verdict: 'violation', violationKinds: ['pin_language_version'] },
  { name: 'pin python: removing .python-version violates', constraints: [PIN_PY], files: [f('.python-version', patch(['-3.12'], true), 'removed')], verdict: 'violation', violationKinds: ['pin_language_version'] },

  // ── no_files_touched ──
  { name: 'globbed path touched → violation', constraints: [{ kind: 'no_files_touched', globs: ['migrations/**'] }], files: [f('migrations/001_init.sql', patch(['+x']))], verdict: 'violation', violationKinds: ['no_files_touched'] },
  { name: 'globbed path untouched → pass', constraints: [{ kind: 'no_files_touched', globs: ['migrations/**'] }], files: [f('src/migrations.ts', patch(['+x']))], verdict: 'pass' },
  { name: 'rename OUT of a protected path → violation', constraints: [{ kind: 'no_files_touched', globs: ['src/legacy/*.py'] }], files: [f('src/new/a.py', null, 'renamed', 'src/legacy/a.py')], verdict: 'violation', violationKinds: ['no_files_touched'] },
  { name: 'slash-less glob matches basename anywhere', constraints: [{ kind: 'no_files_touched', globs: ['Dockerfile'] }], files: [f('svc/Dockerfile', patch(['+x']))], verdict: 'violation', violationKinds: ['no_files_touched'] },
  { name: 'plain directory protects everything below', constraints: [{ kind: 'no_files_touched', globs: ['./infra/'] }], files: [f('infra/k8s/deploy.yaml', patch(['+x']))], verdict: 'violation', violationKinds: ['no_files_touched'] },

  // ── missing patch: fail closed ──
  { name: 'manifest with no patch → cannot verify', constraints: [NEW_DEP, NO_UPG], files: [f('package.json', null)], verdict: 'violation', violationKinds: ['no_new_dependencies', 'no_dependency_upgrades'], detailIncludes: PATCH_UNAVAILABLE },
  { name: 'pyproject with no patch under a pin → cannot verify', constraints: [PIN_PY], files: [f('pyproject.toml', null)], verdict: 'violation', violationKinds: ['pin_language_version'], detailIncludes: PATCH_UNAVAILABLE },
  { name: 'non-manifest with no patch is fine', constraints: [NEW_DEP], files: [f('assets/logo.png', null)], verdict: 'pass' },
  { name: 'pure rename of a manifest (no content change) is fine', constraints: [NEW_DEP], files: [f('pkg/b/package.json', null, 'renamed', 'pkg/a/package.json')], verdict: 'pass' },

  // ── unchecked / empty ──
  { name: 'no constraints → pass', constraints: [], files: [f('package.json', PKG_ADD)], verdict: 'pass' },
  { name: 'custom + api-compat only → unchecked_only', constraints: [{ kind: 'custom', text: 'be nice' }, { kind: 'must_keep_api_compatible' }], files: [f('package.json', PKG_ADD)], verdict: 'unchecked_only' },
  { name: 'legacy strings are unchecked, never parsed as rules', constraints: ['do not upgrade python', 'no new deps'], files: [f('.python-version', patch(['-3.12', '+3.13'], true)), f('package.json', PKG_ADD)], verdict: 'unchecked_only' },
  { name: 'malformed CHECKABLE constraint fails closed', constraints: [{ kind: 'no_files_touched', globs: [] }], files: [], verdict: 'violation', violationKinds: ['no_files_touched'], detailIncludes: 'malformed' },
];

describe('evaluateConstraints', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const r = evaluateConstraints(c.constraints, c.files);
      expect(r.verdict).toBe(c.verdict);
      if (c.violationKinds) {
        expect([...new Set(r.violations.map((v) => v.kind))].sort()).toEqual([...c.violationKinds].sort());
      } else {
        expect(r.violations).toEqual([]);
      }
      if (c.detailIncludes) {
        expect(r.violations.some((v) => v.detail.includes(c.detailIncludes!))).toBe(true);
      }
    });
  }

  test('unchecked kinds are reported alongside a pass', () => {
    const r = evaluateConstraints(
      [NEW_DEP, { kind: 'custom', text: 'x' }, { kind: 'must_keep_api_compatible' }, 'legacy', { kind: 'nope' }],
      [f('src/a.ts', patch(['+x']))],
    );
    expect(r.verdict).toBe('pass');
    expect(new Set(r.unchecked)).toEqual(new Set(['custom', 'must_keep_api_compatible', 'legacy_text', 'unrecognised']));
  });

  test('non-array constraints are treated as none', () => {
    expect(evaluateConstraints(null, [])).toEqual({ verdict: 'pass', violations: [], unchecked: [] });
    expect(evaluateConstraints({ kind: 'no_new_dependencies' }, [])).toEqual({ verdict: 'pass', violations: [], unchecked: [] });
  });
});

// ─── fail-closed parser gaps (audit 2026-09-22) ──────────────────────────────
/** A hunk NOT at the top of the file whose GitHub header carries `context`. */
function ctxPatch(context: string, lines: string[]): string {
  return [`@@ -40,7 +40,8 @@ ${context}`, ...lines].join('\n');
}

describe('pyproject: hunk that starts mid-list', () => {
  test('hunk-header context `dependencies = [` → a bare added requirement is a new dependency', () => {
    const r = evaluateConstraints([NEW_DEP], [
      f('pyproject.toml', ctxPatch('dependencies = [', ['   "fastapi>=0.115",', '+  "httpx",', ' ]'])),
    ]);
    expect(r.verdict).toBe('violation');
    expect(r.violations[0]!.detail).toContain('httpx');
  });

  test('no hunk-header context at all → an added quoted requirement string still counts (fail closed)', () => {
    const r = evaluateConstraints([NEW_DEP], [f('pyproject.toml', patch(['   "fastapi",', '+  "httpx[http2]",']))]);
    expect(r.verdict).toBe('violation');
  });

  test('hunk-header context naming a poetry dependency table → a versionless git dep is a new dependency', () => {
    const r = evaluateConstraints([NEW_DEP], [
      f('pyproject.toml', ctxPatch('[tool.poetry.dependencies]', [' python = "^3.12"', '+mylib = { git = "https://github.com/a/mylib" }'])),
    ]);
    expect(r.verdict).toBe('violation');
    expect(r.violations[0]!.detail).toContain('mylib');
  });

  test('an array whose TABLE the diff does not show has dependency semantics (fail closed)', () => {
    // `select = [` could be [tool.ruff] — or an unknown tool's dependency list.
    const r = evaluateConstraints([NEW_DEP], [f('pyproject.toml', ctxPatch('select = [', ['   "E",', '+  "E501",', ' ]']))]);
    expect(r.verdict).toBe('violation');
  });

  test('the same array edit under a VISIBLE [tool.ruff] header passes', () => {
    const r = evaluateConstraints([NEW_DEP, NO_UPG], [
      f('pyproject.toml', patch(['[tool.ruff.lint]', ' select = [', '   "E",', '+  "E501",', ' ]'])),
    ]);
    expect(r.violations).toEqual([]);
  });
});

describe('requirements.txt: option / URL lines', () => {
  const REQ = (lines: string[]) => f('requirements.txt', patch(lines, true));
  test.each([
    ['-e git+https://github.com/a/b.git#egg=b'],
    ['--editable ./libs/local'],
    ['git+https://github.com/a/c.git@v1.0'],
    ['https://files.example.com/pkg-1.0-py3-none-any.whl'],
    ['mypkg @ https://files.example.com/mypkg-1.0.tar.gz'],
  ])('%s is a new dependency', (line) => {
    const r = evaluateConstraints([NEW_DEP], [REQ([`+${line}`, ' flask==3.0.0'])]);
    expect(r.verdict).toBe('violation');
    expect(r.violations.map((v) => v.kind)).toEqual(['no_new_dependencies']);
  });

  test('-e VCS ref bump is an upgrade, not a new dependency', () => {
    const lines = ['--e git+https://github.com/a/b.git@v1#egg=b', '+-e git+https://github.com/a/b.git@v2#egg=b'];
    expect(evaluateConstraints([NEW_DEP], [REQ(lines)]).verdict).toBe('pass');
    const up = evaluateConstraints([NO_UPG], [REQ(lines)]);
    expect(up.verdict).toBe('violation');
    expect(up.violations[0]!.kind).toBe('no_dependency_upgrades');
  });

  test.each([['-r base.txt'], ['--requirement=dev.txt'], ['-c constraints.txt'], ['--constraint constraints.txt']])(
    'changed include line %s → cannot verify under both rules',
    (line) => {
      const r = evaluateConstraints([NEW_DEP, NO_UPG], [REQ([`+${line}`])]);
      expect(r.verdict).toBe('violation');
      expect(r.violations.map((v) => v.kind).sort()).toEqual(['no_dependency_upgrades', 'no_new_dependencies']);
      expect(r.violations.every((v) => v.detail === INCLUDE_CHANGED)).toBe(true);
    },
  );

  test('a non-dependency option line (--hash) stays clean', () => {
    expect(evaluateConstraints([NEW_DEP, NO_UPG], [REQ(['+    --hash=sha256:abc'])]).verdict).toBe('pass');
  });
});

describe('known-but-unparsed dependency manifests', () => {
  const FILES = [
    'Gemfile', 'Gemfile.lock', 'Pipfile', 'Pipfile.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    'settings.gradle', 'settings.gradle.kts', 'composer.json', 'composer.lock', 'mix.exs', 'svc/App.csproj',
    'packages.config', 'Package.swift', 'ios/Podfile',
  ];
  test.each(FILES.map((x) => [x]))('%s changed → cannot verify under each dependency rule', (name) => {
    for (const k of [NEW_DEP, NO_UPG]) {
      const r = evaluateConstraints([k], [f(name, patch(['+  something']))]);
      expect(r.verdict).toBe('violation');
      expect(r.violations.some((v) => v.kind === k.kind && v.file === name && v.detail === DEPENDENCY_FILE_NOT_PARSED)).toBe(true);
    }
  });

  test('unparsed manifest with no patch is still cannot-verify', () => {
    const r = evaluateConstraints([NEW_DEP], [f('pom.xml', null)]);
    expect(r.violations).toEqual([{ kind: 'no_new_dependencies', file: 'pom.xml', detail: DEPENDENCY_FILE_NOT_PARSED }]);
  });

  test('unparsed manifest is irrelevant to non-dependency rules', () => {
    // (Gemfile / setup.py can set a language version, so they are language files too — see below.)
    expect(evaluateConstraints([NO_LANG], [f('pom.xml', patch(['+<dependency/>']))]).verdict).toBe('pass');
  });

  test('DELETING an unparsed manifest is cannot-verify too (its replacement may live elsewhere)', () => {
    const r = evaluateConstraints([NEW_DEP], [f('Gemfile', patch(['-gem "rails"']), 'removed')]);
    expect(r.violations).toEqual([{ kind: 'no_new_dependencies', file: 'Gemfile', detail: DEPENDENCY_FILE_NOT_PARSED }]);
  });
});

describe('helpers', () => {
  test('versionSatisfiesPin', () => {
    expect(versionSatisfiesPin('3.12.4', '3.12')).toBe(true);
    expect(versionSatisfiesPin('>=3.12', '3.12')).toBe(true);
    expect(versionSatisfiesPin('3.1', '3.12')).toBe(false);
    expect(versionSatisfiesPin('3.13', '3.12')).toBe(false);
    expect(versionSatisfiesPin('lts/iron', '20')).toBe(false);
  });

  test('pathMatchesGlob', () => {
    expect(pathMatchesGlob('src/legacy/a.py', 'src/legacy/*.py')).toBe(true);
    expect(pathMatchesGlob('src/legacy/deep/a.py', 'src/legacy/*.py')).toBe(false);
    expect(pathMatchesGlob('a/b.lock', '*.lock')).toBe(true);
    expect(pathMatchesGlob('src/legacyx/a.py', 'src/legacy')).toBe(false);
  });
});

// ─── FAIL CLOSED BY DEFAULT (audit 2026-09-22, second pass) ───────────────────
// Every example the audit found passing, plus the clean controls that must
// still pass. A new format is blocked unless it is in the parsed list.
describe('fail closed: dependency files the parser does not fully understand', () => {
  type Row = { name: string; files: PrFile[]; kinds?: unknown[]; blocks: boolean; detail?: string };
  const BOTH = [NEW_DEP, NO_UPG];
  const ROWS: Row[] = [
    // pyproject: unversioned additions mid-list in dependency groups
    { name: 'pyproject [dependency-groups] `dev = [` (context) mid-list unversioned add', files: [f('pyproject.toml', ctxPatch('dev = [', ['   "pytest",', '+  "hypothesis",', ' ]']))], blocks: true, detail: 'hypothesis' },
    { name: 'pyproject optional-dependencies `test = [` (context) mid-list unversioned add', files: [f('pyproject.toml', ctxPatch('test = [', ['   "pytest",', '+  "respx",', ' ]']))], blocks: true, detail: 'respx' },
    { name: 'pyproject visible [dependency-groups] dev = [ add', files: [f('pyproject.toml', patch(['[dependency-groups]', 'dev = [', '   "pytest",', '+  "hypothesis",', ' ]']))], blocks: true, detail: 'hypothesis' },
    { name: 'pyproject visible [project.optional-dependencies] test = [ add', files: [f('pyproject.toml', patch(['[project.optional-dependencies]', 'test = [', '+  "respx",', ' ]']))], blocks: true, detail: 'respx' },
    { name: 'pyproject [tool.pdm.dev-dependencies] add', files: [f('pyproject.toml', patch(['[tool.pdm.dev-dependencies]', 'lint = [', '+  "ruff",', ' ]']))], blocks: true, detail: 'ruff' },
    { name: 'pyproject [build-system] requires change is a dependency change', files: [f('pyproject.toml', patch(['[build-system]', '-requires = ["hatchling"]', '+requires = ["hatchling", "hatch-vcs"]']))], blocks: true, detail: 'hatch-vcs' },
    { name: 'pyproject unknown position (no header, no context) → cannot verify', files: [f('pyproject.toml', patch([' foo = 1', '+bar = true']))], blocks: true, detail: 'cannot verify' },
    { name: 'pyproject [project] dynamic = ["dependencies"] → cannot verify', files: [f('pyproject.toml', patch(['[project]', '+dynamic = ["dependencies"]']))], blocks: true, detail: 'cannot verify' },
    { name: 'pyproject unknown [tool.x] table has dependency semantics', files: [f('pyproject.toml', patch(['[tool.hatch.envs.default]', 'dependencies = [', '+  "coverage",', ']']))], blocks: true, detail: 'coverage' },
    // block-on-change formats
    ...['setup.py', 'setup.cfg', 'requirements.in', 'requirements/dev.in', 'constraints.txt', 'mygem.gemspec',
      'gradle/libs.versions.toml', 'deps.versions.toml', 'go.work', 'deno.json', 'flake.lock', 'vcpkg.json',
      'conanfile.py', '.gitmodules', 'pubspec.yaml', 'Cartfile.resolved', 'environment.yml', 'Directory.Packages.props',
      'app/App.fsproj', 'Package.json'].map((name): Row => ({
      name: `${name} change → dependency file not parsed`,
      files: [f(name, patch(['+anything']))],
      blocks: true,
      detail: DEPENDENCY_FILE_NOT_PARSED,
    })),
    { name: 'delete Gemfile + add gems.rb', files: [f('Gemfile', patch(['-gem "rails"']), 'removed'), f('gems.rb', patch(['+gem "rails"']), 'added')], blocks: true, detail: DEPENDENCY_FILE_NOT_PARSED },
    { name: 'rename INTO an unparsed format (notes.txt → setup.cfg)', files: [f('setup.cfg', null, 'renamed', 'notes.txt')], blocks: true, detail: DEPENDENCY_FILE_NOT_PARSED },
    { name: 'rename OUT of an unparsed format (Gemfile → Gemfile.bak)', files: [f('Gemfile.bak', null, 'renamed', 'Gemfile')], blocks: true, detail: DEPENDENCY_FILE_NOT_PARSED },
    { name: 'rename into a parsed format (notes.txt → requirements.txt)', files: [f('requirements.txt', null, 'renamed', 'notes.txt')], blocks: true, detail: 'renamed' },
    // parsed formats: unclassifiable lines
    { name: 'package.json overrides edit → cannot verify', files: [f('package.json', patch([' "overrides": {', '+  "lodash": "4.17.21"', ' }']))], blocks: true, detail: '"overrides"' },
    { name: 'package.json packageManager bump → cannot verify', files: [f('package.json', patch(['-  "packageManager": "pnpm@8.0.0",', '+  "packageManager": "pnpm@9.0.0",']))], blocks: true, detail: 'packageManager' },
    { name: 'requirements --index-url change → cannot verify', files: [f('requirements.txt', patch(['+--index-url https://evil.example/simple'], true))], blocks: true, detail: 'cannot verify' },
    { name: 'requirements unparseable line → cannot verify', files: [f('requirements.txt', patch(['+this is not a requirement!'], true))], blocks: true, detail: 'cannot verify' },
    { name: 'go.mod replace directive → cannot verify', files: [f('go.mod', patch(['+replace github.com/a/b => github.com/evil/b v1.0.0'], true))], blocks: true, detail: 'replace' },
    { name: 'go.mod hunk position unknown → cannot verify', files: [f('go.mod', patch(['+\tgithub.com/c/d v0.4.0']))], blocks: true, detail: 'cannot verify' },
    { name: 'Cargo.toml [patch.crates-io] → dependency semantics', files: [f('Cargo.toml', patch(['[patch.crates-io]', '+serde = { git = "https://github.com/evil/serde" }']))], blocks: true, detail: 'serde' },
    { name: 'Cargo.toml [dependencies.foo] git rev change → upgrade', kinds: [NO_UPG], files: [f('Cargo.toml', patch(['[dependencies.foo]', '-rev = "aaa"', '+rev = "bbb"']))], blocks: true, detail: 'foo' },
    { name: 'Cargo.toml unseen table → cannot verify', files: [f('Cargo.toml', patch([' a = 1', '+b = 2']))], blocks: true, detail: 'cannot verify' },
    // clean controls
    { name: 'README.md + src/x.ts still pass', files: [f('README.md', patch(['+hello'])), f('src/x.ts', patch(['+export const x = 1;']))], blocks: false },
    { name: '[tool.ruff] edit passes', files: [f('pyproject.toml', patch(['[tool.ruff]', ' line-length = 100', '-select = ["E"]', '+select = ["E", "F"]']))], blocks: false },
    { name: '[tool.pytest.ini_options] edit passes', files: [f('pyproject.toml', patch(['[tool.pytest.ini_options]', '+addopts = "-q"']))], blocks: false },
    { name: '[project] description + classifiers edit passes', files: [f('pyproject.toml', patch(['[project]', '-description = "a"', '+description = "b"', ' classifiers = [', '+  "Typing :: Typed",', ' ]']))], blocks: false },
    { name: 'package.json exports edit passes', files: [f('package.json', patch([' "exports": {', '   ".": {', '-    "import": "./a.js"', '+    "import": "./b.js"', '   }', ' },']))], blocks: false },
    { name: 'go.mod module/retract edit passes', files: [f('go.mod', patch(['-module example.com/x', '+module example.com/y', '+retract v1.0.0'], true))], blocks: false },
    { name: 'Cargo.toml [package] + features edit passes', files: [f('Cargo.toml', patch(['[package]', '-description = "a"', '+description = "b"', '[features]', '+extra = ["dep:serde"]']))], blocks: false },
    { name: 'requirements --hash change passes', files: [f('requirements.txt', patch(['-    --hash=sha256:aaa', '+    --hash=sha256:bbb'], true))], blocks: false },
    { name: 'pure rename of a parsed manifest (same format) passes', files: [f('pkg/b/package.json', null, 'renamed', 'pkg/a/package.json')], blocks: false },
  ];

  for (const row of ROWS) {
    test(row.name, () => {
      const r = evaluateConstraints(row.kinds ?? BOTH, row.files);
      if (!row.blocks) {
        expect(r.violations).toEqual([]);
        expect(r.verdict).toBe('pass');
        return;
      }
      expect(r.verdict).toBe('violation');
      const kinds = new Set(r.violations.map((v) => v.kind));
      for (const k of row.kinds ?? BOTH) {
        // Additions trip only no_new_dependencies; "cannot verify" trips every active dependency rule.
        if (row.detail && /cannot verify|not parsed|renamed/.test(row.detail)) expect(kinds.has((k as { kind: string }).kind)).toBe(true);
      }
      if (row.detail) expect(r.violations.some((v) => v.detail.includes(row.detail!))).toBe(true);
    });
  }

  test('delete Gemfile + add gems.rb: BOTH files are named', () => {
    const r = evaluateConstraints([NEW_DEP], [f('Gemfile', null, 'removed'), f('gems.rb', patch(['+gem "rails"']), 'added')]);
    expect(r.violations).toEqual([
      { kind: 'no_new_dependencies', file: 'Gemfile', detail: DEPENDENCY_FILE_NOT_PARSED },
      { kind: 'no_new_dependencies', file: 'gems.rb', detail: DEPENDENCY_FILE_NOT_PARSED },
    ]);
  });

  test('DEPENDENCY_FILE_PATTERNS: case-insensitive basename + path globs, no false hits', () => {
    for (const p of ['GEMFILE', 'a/b/requirements-dev.in', 'x/gradle/libs.versions.toml', 'dev-requirements.txt', 'svc/Build.Gradle.kts'])
      expect(isDependencyFile(p)).toBe(true);
    for (const p of ['README.md', 'src/x.ts', 'docs/package.json.md', 'gradle/wrapper.properties', 'setup.py.orig'])
      expect(isDependencyFile(p)).toBe(false);
  });

  test('only language rules active → dependency files are not blocked', () => {
    expect(evaluateConstraints([NO_LANG], [f('composer.json', patch(['+x']))]).verdict).toBe('pass');
  });
});

// ─── FAIL CLOSED, third pass (review pullrequestreview-5274680835) ──────────
describe('lockfile explained only by a REAL manifest dependency change', () => {
  const LOCK = 'lockfile changed with no dependency change';
  test('trailing-comma-only touch of a package.json dep line does not explain a lockfile', () => {
    const r = evaluateConstraints([NO_UPG], [
      f('package.json', patch([' "dependencies": {', '-    "a": "^1.0.0"', '+    "a": "^1.0.0",', '     "b": "^2.0.0"', ' }'])),
      f('package-lock.json', patch(['-"version": "4.17.20"', '+"version": "4.17.21"'])),
    ]);
    expect(r.verdict).toBe('violation');
    expect(r.violations.map((v) => [v.file, v.detail.slice(0, LOCK.length)])).toEqual([['package-lock.json', LOCK]]);
  });

  test('whitespace-only requirements.txt touch does not explain uv.lock', () => {
    const r = evaluateConstraints([NO_UPG], [
      f('requirements.txt', patch(['-flask==3.0.0', '+flask==3.0.0 '], true)),
      f('uv.lock', patch(['-x', '+y'], true)),
    ]);
    expect(r.violations.map((v) => v.file)).toEqual(['uv.lock']);
  });

  test('control: a real addition in the manifest still explains the lockfile', () => {
    const r = evaluateConstraints([NO_UPG], [
      f('package.json', patch([' "dependencies": {', '-    "a": "^1.0.0"', '+    "a": "^1.0.0",', '+    "b": "^2.0.0"', ' }'])),
      f('package-lock.json', patch(['-"version": "4.17.20"', '+"version": "4.17.21"'])),
    ]);
    expect(r.violations).toEqual([]);
  });
});

describe('submodule pointers are dependency pins', () => {
  const BUMP = '@@ -1 +1 @@\n-Subproject commit aaaa\n+Subproject commit bbbb';
  test('gitlink bump → no_dependency_upgrades violation', () => {
    const r = evaluateConstraints([NEW_DEP, NO_UPG], [f('vendor/libfoo', BUMP)]);
    expect(r.violations).toEqual([{ kind: 'no_dependency_upgrades', file: 'vendor/libfoo', detail: SUBMODULE_BUMPED }]);
  });
  test('new submodule → no_new_dependencies violation', () => {
    const r = evaluateConstraints([NEW_DEP, NO_UPG], [
      f('vendor/libbar', '@@ -0,0 +1 @@\n+Subproject commit cccc', 'added'),
    ]);
    expect(r.violations).toEqual([{ kind: 'no_new_dependencies', file: 'vendor/libbar', detail: SUBMODULE_ADDED }]);
  });
  // Audit 4: a `Subproject commit` line INSIDE an ordinary file is just text and
  // must never switch off that file's dependency analysis.
  test('Subproject line inside pyproject does not mask an added dependency', () => {
    const p = '@@ -1,4 +1,4 @@ dependencies = [\n-Subproject commit abc\n+    "evil==6.6.6",\n';
    const r = evaluateConstraints([NEW_DEP], [f('pyproject.toml', p)]);
    expect(r.verdict).toBe('violation');
    expect(r.violations.some((v) => v.detail === SUBMODULE_ADDED || v.detail === SUBMODULE_BUMPED)).toBe(false);
  });
  test('Subproject line beside a requirements bump does not mask the upgrade', () => {
    const p = '@@ -1,2 +1,2 @@\n-Subproject commit abc\n-a==1\n+a==2\n';
    const r = evaluateConstraints([NO_UPG], [f('requirements.txt', p)]);
    expect(r.verdict).toBe('violation');
    // It must be the REAL upgrade that is reported, not a bogus submodule bump.
    expect(r.violations.some((v) => v.detail === SUBMODULE_BUMPED)).toBe(false);
  });
  test('a non-dependency file with Subproject text plus other edits is not a gitlink', () => {
    const p = '@@ -1,2 +1,2 @@\n-Subproject commit abc\n+Subproject commit def\n+other text\n';
    const r = evaluateConstraints([NEW_DEP, NO_UPG], [f('docs/notes.md', p)]);
    expect(r.verdict).toBe('pass');
  });
  test('.gitmodules change still blocks both rules', () => {
    const r = evaluateConstraints([NEW_DEP, NO_UPG], [f('.gitmodules', patch(['+[submodule "x"]'], true))]);
    expect(r.violations.map((v) => v.kind).sort()).toEqual(['no_dependency_upgrades', 'no_new_dependencies']);
  });
});

describe('DEPENDENCY_FILE_PATTERNS: in-ecosystem config / lock formats block on change', () => {
  const NEW = [
    'pylock.toml', 'pylock.dev.toml', 'requirements-dev.lock', 'requirements.lock', '.pnpmfile.cjs', '.yarnrc.yml',
    '.yarnrc', 'package.yaml', 'package.json5', '.cargo/config.toml', 'crates/x/.cargo/config', '.npmrc', 'pip.conf',
    'pip.ini', 'pixi.toml', 'pixi.lock', 'bunfig.toml',
  ];
  test.each(NEW.map((x) => [x]))('%s → dependency file not parsed under both rules', (name) => {
    const r = evaluateConstraints([NEW_DEP, NO_UPG], [f(name, patch(['-x', '+y'], true))]);
    expect(r.violations.map((v) => [v.kind, v.detail]).sort()).toEqual([
      ['no_dependency_upgrades', DEPENDENCY_FILE_NOT_PARSED],
      ['no_new_dependencies', DEPENDENCY_FILE_NOT_PARSED],
    ]);
  });
  test('out-of-scope files stay invisible (documented, not coverage)', () => {
    for (const x of ['MODULE.bazel', 'Chart.yaml', 'Dockerfile', '.github/workflows/ci.yml', '.terraform.lock.hcl', 'cargo/config.toml'])
      expect(isDependencyFile(x)).toBe(false);
  });
});

describe('language rules fail closed', () => {
  const ENGINES_MIDFILE = patch(['     "npm": ">=9",', '     "pnpm": ">=8",', '-    "node": ">=18"', '+    "node": ">=22"', '   },', '   "x": 1']);
  test('engines node change the parser cannot place → no_language_version_change cannot verify', () => {
    const r = evaluateConstraints([NO_LANG], [f('package.json', ENGINES_MIDFILE)]);
    expect(r.verdict).toBe('violation');
    expect(r.violations.every((v) => v.kind === 'no_language_version_change' && v.detail.includes('cannot verify'))).toBe(true);
  });
  test('same unplaced change under pin node 18 → pin cannot verify', () => {
    const r = evaluateConstraints([{ kind: 'pin_language_version', language: 'node', version: '18' }], [f('package.json', ENGINES_MIDFILE)]);
    expect(r.violations.map((v) => v.kind)).toEqual(['pin_language_version']);
  });
  test('an unplaced package.json line cannot break a python pin (scoped)', () => {
    expect(evaluateConstraints([PIN_PY], [f('package.json', ENGINES_MIDFILE)]).verdict).toBe('pass');
  });
  test('package.json volta node → cannot verify', () => {
    const r = evaluateConstraints([NO_LANG], [
      f('package.json', patch(['{', '  "volta": {', '-    "node": "18.0.0"', '+    "node": "22.0.0"', '  }'], true)),
    ]);
    expect(r.violations.map((v) => v.detail)).toEqual(['package.json: "volta" may set a language version; cannot verify']);
  });
  test('package.json devEngines → cannot verify', () => {
    const r = evaluateConstraints([NO_LANG], [
      f('package.json', patch(['{', '  "devEngines": {', '+    "runtime": { "name": "node", "version": ">=22" }', '  }'], true)),
    ]);
    expect(r.verdict).toBe('violation');
  });
  test('pyproject requires-python in an unseen table → cannot verify under both language rules', () => {
    const r = evaluateConstraints([NO_LANG, PIN_PY], [f('pyproject.toml', patch([' foo = 1', '-requires-python = ">=3.12"', '+requires-python = ">=3.12.1"']))]);
    // >=3.12.1 honours the 3.12 pin by value — only the unknown position blocks it.
    const cannot = r.violations.filter((v) => v.detail.includes('cannot verify')).map((v) => v.kind).sort();
    expect(cannot).toEqual(['no_language_version_change', 'pin_language_version']);
  });
  test('Cargo.toml line in an unseen table → cannot verify', () => {
    expect(evaluateConstraints([NO_LANG], [f('Cargo.toml', patch([' a = 1', '+b = 2']))]).verdict).toBe('violation');
  });
  test('go.mod line at an unknown position → cannot verify', () => {
    expect(evaluateConstraints([NO_LANG], [f('go.mod', patch(['+\tgithub.com/c/d v0.4.0']))]).verdict).toBe('violation');
  });
  test.each([
    ['setup.cfg', '-python_requires = >=3.9', '+python_requires = >=3.13'],
    ['go.work', '-go 1.21', '+go 1.24'],
    ['setup.py', '-    python_requires=">=3.9",', '+    python_requires=">=3.13",'],
    ['runtime.txt', '-python-3.12.1', '+python-3.13.0'],
    ['.java-version', '-17', '+21'],
    ['mise.toml', '-node = "20"', '+node = "22"'],
    ['Pipfile', '-python_version = "3.12"', '+python_version = "3.13"'],
    ['.sdkmanrc', '-java=17.0.2-tem', '+java=21.0.1-tem'],
  ])('%s change → language version file not parsed', (name, minus, plus) => {
    const r = evaluateConstraints([NO_LANG], [f(name, patch([minus, plus], true))]);
    expect(r.violations).toEqual([{ kind: 'no_language_version_change', file: name, detail: LANGUAGE_FILE_NOT_PARSED }]);
  });
  test('go.work change blocks a go pin, not a python pin', () => {
    const file = f('go.work', patch(['-go 1.21', '+go 1.24'], true));
    expect(evaluateConstraints([PIN_GO], [file]).verdict).toBe('violation');
    expect(evaluateConstraints([PIN_PY], [file]).verdict).toBe('pass');
  });
  test('renaming a version file away (.nvmrc → .nvmrc.bak) → cannot verify', () => {
    expect(evaluateConstraints([NO_LANG], [f('.nvmrc.bak', null, 'renamed', '.nvmrc')]).verdict).toBe('violation');
  });
  test('controls: placed positives keep working exactly', () => {
    expect(evaluateConstraints([NO_LANG], [f('package.json', PKG_SCRIPTS)]).verdict).toBe('pass');
    expect(evaluateConstraints([NO_LANG], [f('package.json', PKG_UPGRADE)]).verdict).toBe('pass');
    expect(evaluateConstraints([PIN_NODE], [f('package.json', patch([' "engines": {', '-  "node": ">=20.1"', '+  "node": ">=20.4"', ' },']))]).verdict).toBe('pass');
    expect(evaluateConstraints([NO_LANG], [f('pyproject.toml', patch(['[tool.ruff]', '-line-length = 88', '+line-length = 100']))]).verdict).toBe('pass');
    expect(evaluateConstraints([NO_LANG], [f('pkg/b/package.json', null, 'renamed', 'pkg/a/package.json')]).verdict).toBe('pass');
    expect(evaluateConstraints([NO_LANG], [f('src/app.ts', patch(['+x']))]).verdict).toBe('pass');
  });
  test('LANGUAGE_VERSION_FILE_PATTERNS matches case-insensitively, no false hits', () => {
    for (const x of ['.NVMRC', 'svc/setup.cfg', 'a/b/go.work', 'x.gemspec', '.mise.local.toml']) expect(isLanguageVersionFile(x)).toBe(true);
    for (const x of ['README.md', 'Dockerfile', 'src/setup.cfg.md']) expect(isLanguageVersionFile(x)).toBe(false);
  });
});
