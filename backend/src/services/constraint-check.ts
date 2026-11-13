// src/services/constraint-check.ts
//
// THE LANDING GATE FOR PROJECT CONSTRAINTS.
//
// Pure: given a project's stored constraints and a PR's file list (GitHub's
// `GET /repos/{o}/{r}/pulls/{n}/files` shape: filename, status, patch?), decide
// whether landing that PR would break a rule the requester set. No I/O here —
// the route (routes/project-constraint-check.ts) fetches, this decides.
//
// ── WHAT IS CHECKED ──────────────────────────────────────────────────────────
// Exactly CHECKABLE_KINDS (types/project-constraints.ts). must_keep_api_compatible,
// custom, legacy free-text strings and unrecognised shapes are reported in
// `unchecked` — never silently passed, never pretended-checked.
//
// ── BOTH RULE FAMILIES FAIL CLOSED: THE ONE RULE ────────────────────────────
// Dependency rules (`no_new_dependencies`, `no_dependency_upgrades`) and
// language rules (`no_language_version_change`, `pin_language_version`) share
// one principle: a change to a file IN SCOPE that this file cannot positively
// read is a violation ("cannot verify"), never a pass. Details per family below.
//
// Under `no_new_dependencies` / `no_dependency_upgrades`, a PR passes ONLY if
// every dependency-relevant change is in a format this file FULLY parses and
// every changed line in it is positively classified. Concretely:
//   1. DEPENDENCY_FILE_PATTERNS is the single, deliberately broad list of
//      dependency-relevant files (basename or path glob, case-insensitive).
//   2. A changed / added / DELETED / renamed file matching it (both
//      `filename` and `previous_filename` are checked) that is NOT a parsed
//      format → `dependency file not parsed; cannot verify`.
//   3. Inside a parsed format, a changed line the parser cannot positively
//      classify → `<file>: … cannot verify`. Nothing is silently ignored:
//      only lines positively inside a known NON-dependency section pass.
//   4. A rename that changes a file's parsed format (e.g. notes.txt →
//      requirements.txt) → cannot verify: the content was never diffed.
//   5. A parsed manifest whose `patch` GitHub omitted (large/binary diffs) →
//      `patch unavailable; cannot verify`.
//   6. A CHECKABLE kind whose stored params fail to parse → violation.
//   7. A submodule pointer (`Subproject commit <sha>` lines in the patch) is a
//      dependency pin on another repository: a moved pointer violates
//      `no_dependency_upgrades`, a new one violates `no_new_dependencies`.
//      `.gitmodules` is block-on-change like any unparsed file.
// The cost is an occasional false block a human can clear by editing the
// constraint; the cost of the opposite is a silent breach of a rule the system
// claimed to enforce. The answer to "the gate missed format X" is never a new
// special case — X is already blocked unless it is in the parsed list.
//
// PARSED (may pass):
//   * package.json — dependencies/devDependencies/peer/optional/bundle(d)
//     sections are deps, `engines` is language; a line in a known
//     non-dependency field (NPM_NON_DEP_KEYS: scripts, exports, files, …)
//     passes; ANY other field (overrides, resolutions, pnpm, workspaces,
//     packageManager, unknown) or a position the hunk does not show → cannot
//     verify.
//   * pyproject.toml — a changed line passes only inside a table known NOT to
//     hold dependencies (PY_NON_DEP_TABLES: [tool.ruff], [tool.pytest…],
//     [tool.mypy], [tool.coverage…], [project.urls], [project.scripts], …) or
//     on a known metadata key of [project] / [tool.poetry]. Every other table
//     or array — [build-system], [dependency-groups] `dev = [`,
//     optional-dependencies `test = [`, [tool.*] dev-dependencies, unknown
//     tables — has DEPENDENCY semantics (entries are deps; an entry that is
//     not a requirement → cannot verify). A table the hunk does not show and
//     cannot be recovered from GitHub's hunk-header context → cannot verify.
//   * requirements*.txt / *requirements*.txt / requirements/*.txt — PEP 508,
//     `-e`, URL/VCS/path lines are deps; `--hash` is integrity data; a changed
//     `-r`/`-c` include → `include changed; cannot verify`; any other option
//     (index URLs, find-links, …) or unparseable line → cannot verify.
//   * go.mod — require lines are deps; go/toolchain are language;
//     module/retract/godebug/ignore pass; replace/exclude/tool or anything
//     unrecognised → cannot verify.
//   * Cargo.toml — [*dependencies] tables (incl. target./workspace.) are deps;
//     known non-dependency tables (package, lib, bin, profile, features, lints,
//     …) pass; [patch.*], [replace] and unknown tables have dependency
//     semantics; an unseen table → cannot verify.
//   * Lockfiles of those ecosystems (LOCKFILES) — see LOCKFILES below.
//
// BLOCK-ON-CHANGE (never parsed; any change is a violation): everything else in
// DEPENDENCY_FILE_PATTERNS — setup.py, setup.cfg, requirements*.in,
// constraints*.txt, Pipfile(.lock), environment.yml, go.work, Gemfile(.lock),
// gems.rb, *.gemspec, pom.xml, *.gradle*, *.versions.toml, composer.*, mix.*,
// *.csproj/*.fsproj/*.vbproj, Directory.*.props, packages.config, paket.*,
// Package.swift/.resolved, Podfile(.lock), Cartfile*, pubspec.*, deno.*,
// flake.*, vcpkg.json, conanfile.*, .gitmodules, pylock*.toml,
// requirements*.lock, pixi.*, pip.conf/pip.ini, .npmrc, .yarnrc(.yml),
// .pnpmfile.cjs, bunfig.toml, package.yaml/json5, .cargo/config(.toml) — and
// any case variant of a parsed name (`Package.json` is not what npm reads).
//
// ── LANGUAGE RULES FAIL CLOSED ───────────────────────────────────────────────
// Under `no_language_version_change` / `pin_language_version`:
//   1. LANGUAGE_VERSION_FILE_PATTERNS lists the KNOWN files that can set a
//      language/runtime version (.python-version, .nvmrc, .tool-versions,
//      mise.toml, runtime.txt, setup.cfg, setup.py, Pipfile, go.work,
//      Gemfile, *.gemspec, global.json, …).
//   2. A change (either side of a rename) to a matching file whose language
//      fields are not positively parsed → `language version file not parsed;
//      cannot verify`. PARSED: whole-file VERSION_FILES, package.json
//      `engines`, pyproject `requires-python` / poetry `python`, go.mod
//      `go`/`toolchain`, Cargo.toml `rust-version`.
//   3. Inside a parsed manifest, a changed line the parser cannot PLACE (hunk
//      position unknown, or a package.json field that may carry a version:
//      volta, devEngines, packageManager, pnpm, unknown) → cannot verify.
//   4. A patch GitHub omitted → `patch unavailable; cannot verify`.
// `pin_language_version` "cannot verify" is scoped to the languages the file
// can set (an unreadable package.json cannot break a python pin); placed
// values are still checked against the pin.
//
// ── LOCKFILES (the documented choice) ────────────────────────────────────────
// A lockfile change is only relevant to `no_dependency_upgrades`, and it is a
// violation UNLESS it is "explained": some manifest of the same ecosystem at or
// below the lockfile's directory also has dependency-line changes in this PR
// (whose own add/upgrade verdicts are reported on the manifest). A lockfile that
// moved with no manifest dependency change is a re-resolve, i.e. transitive
// versions changed — an upgrade the user forbade. `no_new_dependencies` ignores
// lockfiles: a new DIRECT dependency must appear in a manifest, and transitive
// additions are not something the requester can reason about.
//
// "Some dependency change" means a REAL one: after normalising whitespace,
// commas and quotes, a dependency was added, removed or had its spec changed.
// A whitespace-only or trailing-comma-only touch of a dependency line does not
// explain a lockfile. A real change (e.g. one new dependency) explains the
// whole lockfile diff — lockfiles are not parsed, so a re-resolve riding along
// with a genuine addition is NOT detected.
//
// ── OUT OF SCOPE — NOT DETECTED (stated plainly so nobody reads it as coverage)
//   * Package installs inside Dockerfiles (`RUN pip install x`, `FROM
//     python:3.12`), CI workflow steps (setup-* actions, matrices, `npm i`),
//     and shell/Make/other scripts.
//   * Vendored source trees (vendor/, third_party/, copied code).
//   * Bazel / Buck / Pants (MODULE.bazel, WORKSPACE, BUCK, …).
//   * Helm chart and Terraform module/provider versions (Chart.yaml,
//     *.tf, .terraform.lock.hcl).
//   * Binary artifacts (jars, wheels, tarballs committed to the repo).
//   * Any other file not in DEPENDENCY_FILE_PATTERNS / LANGUAGE_VERSION_FILE_PATTERNS.
// Adding a pattern is the fix for a missed manifest format; the lists are
// broad on purpose.

import {
  CHECKABLE_KINDS,
  ProjectConstraintSchema,
  type CheckableKind,
  type ProjectConstraint,
} from '../types/project-constraints';

// ─── public types ────────────────────────────────────────────────────────────

/** One entry of GitHub's PR files list (only the fields we read). */
export interface PrFile {
  filename: string;
  status: string; // added | removed | modified | renamed | copied | changed | unchanged
  patch?: string | null;
  previous_filename?: string | null;
}

export interface ConstraintViolation {
  kind: string;
  file: string | null;
  detail: string;
}

export type ConstraintVerdict = 'pass' | 'violation' | 'unchecked_only';

export interface ConstraintEvaluation {
  verdict: ConstraintVerdict;
  violations: ConstraintViolation[];
  /** Kinds present but not enforced. `legacy_text` = pre-vocabulary string, `unrecognised` = unparseable shape. */
  unchecked: string[];
}

export const PATCH_UNAVAILABLE = 'patch unavailable; cannot verify';

// ─── constraint partitioning ─────────────────────────────────────────────────

type CheckableConstraint = Extract<ProjectConstraint, { kind: CheckableKind }>;

interface Partitioned {
  checkable: CheckableConstraint[];
  unchecked: string[];
  malformed: ConstraintViolation[];
}

function isCheckableKind(k: unknown): k is CheckableKind {
  return typeof k === 'string' && (CHECKABLE_KINDS as readonly string[]).includes(k);
}

export function partitionConstraints(raw: unknown): Partitioned {
  const out: Partitioned = { checkable: [], unchecked: [], malformed: [] };
  if (!Array.isArray(raw)) return out;
  const unchecked = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) unchecked.add('legacy_text');
      continue;
    }
    const parsed = ProjectConstraintSchema.safeParse(item);
    if (parsed.success) {
      if (isCheckableKind(parsed.data.kind)) out.checkable.push(parsed.data as CheckableConstraint);
      else unchecked.add(parsed.data.kind);
      continue;
    }
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (isCheckableKind(kind)) {
      // The user asked for an enforced rule we cannot read. Fail closed.
      out.malformed.push({
        kind,
        file: null,
        detail: 'constraint is malformed (failed schema validation); cannot verify',
      });
    } else {
      unchecked.add('unrecognised');
    }
  }
  out.unchecked = [...unchecked];
  return out;
}

/** True when evaluating this project's constraints needs the PR diff at all. */
export function hasCheckableConstraints(raw: unknown): boolean {
  return partitionConstraints(raw).checkable.length > 0;
}

// ─── diff model ──────────────────────────────────────────────────────────────

interface DiffLine {
  sign: '+' | '-' | ' ';
  text: string;
  /** First line of a hunk that starts at line 1 of the old or new file. */
  hunkAtTop: boolean;
  hunkStart: boolean;
  /** GitHub's hunk-header context (text after the second `@@`), trimmed; '' when absent. */
  hunkContext: string;
}

function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let hunkStart = false;
  let hunkAtTop = false;
  let hunkContext = '';
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
      hunkAtTop = !!m && (m[1] === '1' || m[1] === '0' || m[2] === '1');
      hunkContext = (m?.[3] ?? '').trim();
      hunkStart = true;
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = raw[0];
    const sign: DiffLine['sign'] = c === '+' ? '+' : c === '-' ? '-' : ' ';
    const text = c === '+' || c === '-' || c === ' ' ? raw.slice(1) : raw;
    out.push({ sign, text, hunkAtTop, hunkStart, hunkContext });
    hunkStart = false;
  }
  return out;
}

interface DepLine {
  name: string;
  spec: string;
  sign: '+' | '-';
}

interface LangLine {
  language: string;
  value: string;
  sign: '+' | '-';
}

interface Extracted {
  deps: DepLine[];
  langs: LangLine[];
  /** Dependency-rule "cannot verify" details this file raises (fail closed). */
  uncheckable?: string[];
  /** Language-rule "cannot verify" details: a changed line the parser could not place (fail closed). */
  langUncheckable?: string[];
}

// ─── file classification ─────────────────────────────────────────────────────

type Ecosystem = 'npm' | 'python' | 'go' | 'cargo';

const LOCKFILES: Record<string, Ecosystem> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'npm',
  'pnpm-lock.yaml': 'npm',
  'bun.lock': 'npm',
  'bun.lockb': 'npm',
  'uv.lock': 'python',
  'poetry.lock': 'python',
  'pdm.lock': 'python',
  'go.sum': 'go',
  'Cargo.lock': 'cargo',
};

/** Whole-file language version pins → the language they set (null = per-line, .tool-versions). */
const VERSION_FILES: Record<string, string | null> = {
  '.python-version': 'python',
  '.nvmrc': 'node',
  '.node-version': 'node',
  '.ruby-version': 'ruby',
  '.tool-versions': null,
  'rust-toolchain': 'rust',
  'rust-toolchain.toml': 'rust',
};

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** requirements*.txt, *requirements*.txt, requirements/*.txt — all the same pip format. */
function isRequirementsFile(path: string): boolean {
  if (/requirements[^/]*\.txt$/i.test(basename(path))) return true;
  return /(^|\/)requirements\/[^/]+\.txt$/i.test(path);
}

/**
 * EVERY file that can declare, pin, resolve or source a dependency — broad on
 * purpose. Basename glob when the pattern has no '/', else a path-suffix glob;
 * `*` never crosses '/'; always case-insensitive. Under a dependency rule a
 * change to a matching file is a violation unless the file is one of the
 * FULLY PARSED formats (parsedFormat below). Adding a pattern can only block
 * more; forgetting one is the only way this gate goes blind.
 */
export const DEPENDENCY_FILE_PATTERNS: readonly string[] = [
  // JavaScript / TypeScript
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', '.pnpmfile.cjs', '.yarnrc.yml', '.yarnrc', 'package.yaml',
  'package.json5', '.npmrc', 'bunfig.toml',
  // Python
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements*.txt', '*requirements*.txt',
  'requirements/*.txt', 'requirements*.in', '*requirements*.in', 'requirements/*.in', 'constraints*.txt',
  'Pipfile', 'Pipfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'environment.yml', 'environment.yaml',
  'conda*.yml', 'conda*.yaml', 'pylock.toml', 'pylock.*.toml', 'requirements*.lock', 'pip.conf', 'pip.ini',
  'pixi.toml', 'pixi.lock',
  // Go
  'go.mod', 'go.sum', 'go.work', 'go.work.sum',
  // Rust
  'Cargo.toml', 'Cargo.lock', '.cargo/config.toml', '.cargo/config',
  // Ruby
  'Gemfile', 'Gemfile.lock', 'gems.rb', 'gems.locked', '*.gemspec',
  // JVM
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle*', 'gradle/libs.versions.toml',
  '*.versions.toml', 'gradle.lockfile', 'build.sbt',
  // PHP / Elixir
  'composer.json', 'composer.lock', 'mix.exs', 'mix.lock',
  // .NET
  '*.csproj', '*.fsproj', '*.vbproj', 'Directory.Packages.props', 'Directory.Build.props', 'packages.config',
  'packages.lock.json', 'paket.dependencies', 'paket.lock',
  // Swift / ObjC
  'Package.swift', 'Package.resolved', 'Podfile', 'Podfile.lock', 'Cartfile*',
  // Dart / Deno / Nix / C++
  'pubspec.yaml', 'pubspec.lock', 'deno.json', 'deno.jsonc', 'deno.lock', 'flake.nix', 'flake.lock',
  'vcpkg.json', 'conanfile.*',
  // git submodules pin other repositories
  '.gitmodules',
];

function globToRegExpSource(g: string): string {
  return g
    .split('')
    .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
}

const DEPENDENCY_FILE_RES: readonly RegExp[] = DEPENDENCY_FILE_PATTERNS.map((pat) =>
  pat.includes('/')
    ? new RegExp(`(^|/)${globToRegExpSource(pat)}$`, 'i')
    : new RegExp(`^${globToRegExpSource(pat)}$`, 'i'),
);

/** Does `path` match DEPENDENCY_FILE_PATTERNS? */
export function isDependencyFile(path: string): boolean {
  const p = path.replace(/^\/+/, '');
  const b = basename(p);
  return DEPENDENCY_FILE_PATTERNS.some((pat, i) => DEPENDENCY_FILE_RES[i]!.test(pat.includes('/') ? p : b));
}

/**
 * EVERY file that can set a language / runtime version — broad on purpose,
 * same glob semantics as DEPENDENCY_FILE_PATTERNS. Under a language rule a
 * change to a matching file is a violation unless it is a LANGUAGE-PARSED
 * format (whole-file VERSION_FILES, package.json, pyproject.toml, go.mod,
 * Cargo.toml) and every changed line in it was placed.
 */
export const LANGUAGE_VERSION_FILE_PATTERNS: readonly string[] = [
  // whole-file pins
  '.python-version', '.nvmrc', '.node-version', '.tool-versions', '.ruby-version', '.java-version', '.go-version',
  '.terraform-version', '.bun-version', 'rust-toolchain', 'rust-toolchain.toml', 'runtime.txt', '.sdkmanrc',
  'mise.toml', '.mise.toml', 'mise.*.toml', '.mise.*.toml', '.rtx.toml', 'global.json',
  // manifests that embed a language version
  'package.json', 'pyproject.toml', 'setup.cfg', 'setup.py', 'Pipfile', 'environment.yml', 'environment.yaml',
  'go.mod', 'go.work', 'Cargo.toml', 'Gemfile', 'gems.rb', '*.gemspec',
];

const LANGUAGE_VERSION_FILE_RES: readonly RegExp[] = LANGUAGE_VERSION_FILE_PATTERNS.map((pat) =>
  pat.includes('/')
    ? new RegExp(`(^|/)${globToRegExpSource(pat)}$`, 'i')
    : new RegExp(`^${globToRegExpSource(pat)}$`, 'i'),
);

/** Does `path` match LANGUAGE_VERSION_FILE_PATTERNS? */
export function isLanguageVersionFile(path: string): boolean {
  const p = path.replace(/^\/+/, '');
  const b = basename(p);
  return LANGUAGE_VERSION_FILE_PATTERNS.some((pat, i) => LANGUAGE_VERSION_FILE_RES[i]!.test(pat.includes('/') ? p : b));
}

/**
 * The languages a language-version file can set; null = any (multi-tool
 * files). Scopes `pin_language_version` "cannot verify": an unreadable
 * package.json cannot break a python pin.
 */
function languagesOf(path: string): string[] | null {
  const b = basename(path).toLowerCase();
  if (b === 'package.json') return ['node', 'bun', 'deno'];
  if (['pyproject.toml', 'setup.cfg', 'setup.py', 'pipfile', 'runtime.txt', '.python-version'].includes(b)) return ['python'];
  if (['go.mod', 'go.work', '.go-version'].includes(b)) return ['go'];
  if (['cargo.toml', 'rust-toolchain', 'rust-toolchain.toml'].includes(b)) return ['rust'];
  if (['gemfile', 'gems.rb', '.ruby-version'].includes(b) || b.endsWith('.gemspec')) return ['ruby'];
  if (['.nvmrc', '.node-version'].includes(b)) return ['node'];
  if (b === '.bun-version') return ['bun'];
  if (b === '.java-version') return ['java'];
  if (b === '.terraform-version') return ['terraform'];
  return null;
}

/** The formats whose language-version lines this file positively parses (exact names). */
function languageParsed(path: string): boolean {
  const b = basename(path);
  return b in VERSION_FILES || ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'].includes(b);
}

export const LANGUAGE_FILE_NOT_PARSED = 'language version file not parsed; cannot verify';

type ParsedFormat = 'package.json' | 'pyproject' | 'requirements' | 'go.mod' | 'cargo' | 'lockfile';

/**
 * The FULLY PARSED formats — the only dependency files that may pass. Exact
 * (case-sensitive) names: `Package.json` is not what npm reads, so it is
 * blocked, not parsed.
 */
function parsedFormat(path: string): ParsedFormat | null {
  const b = basename(path);
  if (b === 'package.json') return 'package.json';
  if (b === 'pyproject.toml') return 'pyproject';
  if (isRequirementsFile(path)) return 'requirements';
  if (b === 'go.mod') return 'go.mod';
  if (b === 'Cargo.toml') return 'cargo';
  if (b in LOCKFILES) return 'lockfile';
  return null;
}

export const DEPENDENCY_FILE_NOT_PARSED = 'dependency file not parsed; cannot verify';
export const RENAMED_ACROSS_FORMATS = 'renamed into or out of a dependency format; cannot verify';
export const INCLUDE_CHANGED = 'include changed; cannot verify';
export const SUBMODULE_BUMPED = 'submodule pointer changed (pins another repository at a new commit)';
export const SUBMODULE_ADDED = 'adds a submodule (a new pinned repository)';

/**
 * Git marks a submodule (gitlink) pointer change with `Subproject commit <sha>`
 * lines; GitHub's files API shows exactly that as the patch.
 *
 * ⛔ A gitlink's patch is NOTHING BUT those lines (one `-` and/or one `+`). A
 * `Subproject commit` line inside an ordinary file — e.g. in a pyproject
 * description string — is just text, and must never short-circuit that file's
 * dependency analysis (audit 4: it switched the gate off for the whole file).
 * Dependency and language files are therefore never gitlinks.
 */
function submoduleChange(
  patch: string | null | undefined,
  path: string,
): { minus: boolean; plus: boolean } | null {
  if (typeof patch !== 'string') return null;
  if (isDependencyFile(path) || isLanguageVersionFile(path)) return null;
  const changed = patch
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
  const gitlink = /^[-+]Subproject commit [0-9a-f]+(?:-dirty)?\s*$/;
  if (changed.length === 0 || changed.length > 2 || !changed.every((l) => gitlink.test(l))) return null;
  const minus = changed.filter((l) => l.startsWith('-')).length;
  const plus = changed.filter((l) => l.startsWith('+')).length;
  if (minus > 1 || plus > 1) return null;
  return { minus: minus === 1, plus: plus === 1 };
}

/** Spec normalised for "did it really change": whitespace, commas and quotes are not changes. */
function normSpec(s: string): string {
  return s.replace(/[\s,'"]/g, '');
}

/**
 * Does this manifest's diff change a dependency for real — a name added or
 * removed, or a spec changed — after normalisation? A whitespace-only or
 * trailing-comma-only touch of a dependency line does not.
 */
function hasRealDependencyChange(deps: DepLine[]): boolean {
  const count = new Map<string, number>();
  for (const d of deps) {
    const k = `${d.name}\0${normSpec(d.spec)}`;
    count.set(k, (count.get(k) ?? 0) + (d.sign === '+' ? 1 : -1));
  }
  return [...count.values()].some((n) => n !== 0);
}

function manifestEcosystem(path: string): Ecosystem | null {
  switch (parsedFormat(path)) {
    case 'package.json':
      return 'npm';
    case 'pyproject':
    case 'requirements':
      return 'python';
    case 'go.mod':
      return 'go';
    case 'cargo':
      return 'cargo';
    default:
      return null;
  }
}

// ─── language normalisation ──────────────────────────────────────────────────

const LANGUAGE_ALIASES: Record<string, string> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  node: 'node',
  nodejs: 'node',
  'node.js': 'node',
  javascript: 'node',
  typescript: 'node',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  ruby: 'ruby',
  bun: 'bun',
  deno: 'deno',
};

export function normalizeLanguage(l: string): string {
  const k = l.trim().toLowerCase();
  return LANGUAGE_ALIASES[k] ?? k;
}

/**
 * Does a version value written in a file honour an exact pin?
 * "3.12" pins 3.12.x (dot-boundary prefix); a range like ">=3.12" is judged by
 * its FIRST version number, so ">=3.11,<3.13" under pin 3.12 is a violation
 * (conservative). A value with no version number (e.g. "lts/iron") never
 * satisfies a pin.
 */
export function versionSatisfiesPin(value: string, pin: string): boolean {
  const pinNum = /\d+(?:\.\d+)*/.exec(pin)?.[0];
  const valNum = /\d+(?:\.\d+)*/.exec(value)?.[0];
  if (!pinNum || !valNum) return false;
  return valNum === pinNum || valNum.startsWith(`${pinNum}.`);
}

// ─── per-format extractors ───────────────────────────────────────────────────

const TOML_NON_DEP_KEYS = new Set([
  'version',
  'name',
  'requires-python',
  'rust-version',
  'edition',
  'target-version',
  'python_version',
  'python-version',
  'minversion',
  'required-version',
  'license',
  'description',
  'readme',
]);

/** TOML value that looks like a dependency version spec. */
function looksLikeTomlSpec(v: string): boolean {
  return /^\s*(?:[\^~*]|[<>]=?|==|=|\d)/.test(v);
}

/** A changed line that carries content (not blank, not pure punctuation). */
function isStructuralOnly(t: string): boolean {
  return /^[\s{}[\](),]*$/.test(t);
}

function cannotVerify(out: Extracted, detail: string): void {
  if (!out.uncheckable!.includes(detail)) out.uncheckable!.push(detail);
}

function cannotVerifyLanguage(out: Extracted, detail: string): void {
  out.langUncheckable ??= [];
  if (!out.langUncheckable.includes(detail)) out.langUncheckable.push(detail);
}

const NPM_DEP_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
]);

/**
 * Top-level package.json fields POSITIVELY known not to declare, pin, resolve
 * or source a dependency. Anything else that changes (overrides, resolutions,
 * pnpm, workspaces, packageManager, volta, catalog, an unknown key) is
 * "cannot verify".
 */
const NPM_NON_DEP_KEYS = new Set([
  'name', 'version', 'description', 'keywords', 'homepage', 'bugs', 'license', 'author', 'contributors',
  'maintainers', 'funding', 'files', 'main', 'module', 'browser', 'types', 'typings', 'typesVersions',
  'exports', 'imports', 'bin', 'man', 'directories', 'repository', 'scripts', 'config', 'private',
  'publishConfig', 'type', 'sideEffects', 'os', 'cpu', 'prettier', 'eslintConfig', 'stylelint', 'jest',
  'babel', 'browserslist', 'lint-staged', 'husky', 'commitlint', 'svelte', 'source', 'unpkg', 'jsdelivr',
  'displayName', 'icon', 'categories', 'activationEvents', 'contributes', 'galleryBanner', 'preview',
  'c8', 'nyc', 'ava', 'mocha', 'xo',
]);

/** npm-style version spec (also git/url/workspace/alias protocols). */
function looksLikeNpmSpec(v: string): boolean {
  return /^(?:[\^~]|[<>]=?|=|\*$|x$|latest$|next$|v?\d|workspace:|npm:|file:|link:|git|github:|https?:|catalog:)/i.test(
    v.trim(),
  );
}

/** Walk a line's JSON punctuation outside strings. */
function jsonBrackets(text: string): Array<'open' | 'close'> {
  const out: Array<'open' | 'close'> = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') out.push('open');
    else if (c === '}' || c === ']') out.push('close');
  }
  return out;
}

const PKG_UNKNOWN_POSITION = 'package.json: changed line outside a visible section; cannot verify';

/**
 * Top-level package.json fields positively known NOT to carry a language
 * version. `engines` is parsed; everything else (volta, devEngines,
 * packageManager, pnpm — `pnpm.executionEnv.nodeVersion` — or an unknown key)
 * is "cannot verify" under the language rules.
 */
const NPM_NON_LANGUAGE_KEYS = new Set([...NPM_NON_DEP_KEYS, ...NPM_DEP_SECTIONS, 'overrides', 'resolutions', 'workspaces']);

function extractPackageJson(lines: DiffLine[]): Extracted {
  const out: Extracted = { deps: [], langs: [], uncheckable: [] };
  // Container path from the file root: [] = before the root `{`, ['$'] = top
  // level, ['$', 'dependencies'] = inside that section. null = the hunk does
  // not show where we are.
  let path: string[] | null = null;
  const pairRe = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

  for (const l of lines) {
    if (l.hunkStart) path = l.hunkAtTop ? [] : null;
    const text = l.text;
    const t = text.trim();
    const indent = /^\s*/.exec(text)![0].replace(/\t/g, '  ').length;
    const keyed = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/.exec(text);
    const key = keyed?.[1];
    const rest = (keyed?.[2] ?? '').trim();

    // Re-synchronise an unknown position on a top-level line (pretty-printed
    // JSON puts top-level keys and their closing braces at indent <= 2).
    if (path === null && indent <= 2) {
      if (keyed) path = ['$'];
      else if (/^[}\]],?$/.test(t)) {
        path = ['$'];
        continue;
      }
    }
    if (path !== null && path.length === 0 && keyed) path = ['$'];

    // Which top-level field does this line belong to?
    const section: string | null =
      path === null ? null : path.length === 1 ? key ?? null : path.length >= 2 ? path[1]! : null;
    const changed = l.sign !== ' ' && t !== '' && !isStructuralOnly(t);

    if (changed) {
      const sign = l.sign as '+' | '-';
      if (section === null) {
        // Fail closed; still name a nested "pkg": "<spec>" pair so the detail is useful.
        if (keyed && indent >= 2 && key !== 'version' && /^"/.test(rest)) {
          const v = /^"((?:[^"\\]|\\.)*)"/.exec(rest)![1]!;
          if (looksLikeNpmSpec(v)) out.deps.push({ name: key!, spec: v.trim(), sign });
        }
        cannotVerify(out, PKG_UNKNOWN_POSITION);
        cannotVerifyLanguage(out, PKG_UNKNOWN_POSITION);
      } else if (NPM_DEP_SECTIONS.has(section)) {
        if (path!.length === 1) {
          // "dependencies": { ... } opener — inline pairs are deps, the opener alone is structure.
          for (const m of rest.matchAll(pairRe)) out.deps.push({ name: m[1]!, spec: m[2]!.trim(), sign });
        } else if (path!.length === 2 && keyed && /^"/.test(rest)) {
          out.deps.push({ name: key!, spec: /^"((?:[^"\\]|\\.)*)"/.exec(rest)![1]!.trim(), sign });
        } else if (path!.length === 2 && !keyed && /^"[^"]+",?$/.test(t)) {
          out.deps.push({ name: t.replace(/[",]/g, ''), spec: '', sign }); // bundleDependencies array
        } else {
          cannotVerify(out, `package.json: unrecognised line in "${section}"; cannot verify`);
        }
      } else if (section === 'engines') {
        const pairs = path!.length === 1 ? [...rest.matchAll(pairRe)] : keyed ? [...text.matchAll(pairRe)] : [];
        for (const m of pairs) out.langs.push({ language: normalizeLanguage(m[1]!), value: m[2]!.trim(), sign });
        if (path!.length > 1 && pairs.length === 0) {
          cannotVerify(out, 'package.json: unrecognised line in "engines"; cannot verify');
          cannotVerifyLanguage(out, 'package.json: unrecognised line in "engines"; cannot verify');
        }
      } else if (!NPM_NON_DEP_KEYS.has(section)) {
        cannotVerify(out, `package.json: "${section}" is not a known non-dependency field; cannot verify`);
      }
      if (section !== null && section !== 'engines' && !NPM_NON_LANGUAGE_KEYS.has(section))
        cannotVerifyLanguage(out, `package.json: "${section}" may set a language version; cannot verify`);
    }

    // Structure: push the keyed container first, then anonymous ones.
    if (path !== null) {
      let first = true;
      for (const b of jsonBrackets(text)) {
        if (b === 'open') {
          path.push(first && keyed ? key! : path.length === 0 ? '$' : '<anon>');
          first = false;
        } else if (path.length > 0) path.pop();
      }
    }
  }
  return out;
}

function normalizePyName(n: string): string {
  return n.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Parse one PEP 508 requirement string ("httpx[http2]>=0.27; python_version>'3'"). */
function parsePep508(s: string): { name: string; spec: string } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const rest = (m[3] ?? '').trim();
  const hasOp = /^(===|==|>=|<=|~=|!=|>|<|@)/.test(rest);
  if (!(hasOp || rest === '' || rest.startsWith(';') || rest.startsWith('('))) return null;
  return { name: normalizePyName(m[1]!), spec: rest };
}

/** A URL / VCS / local-path requirement ("git+https://…@v1#egg=x", "./pkg", "https://…/x.whl"). */
function looksLikeUrlOrPathReq(t: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|git\+|hg\+|svn\+|bzr\+|file:|\.{1,2}\/|\/|~\/)/i.test(t);
}

/**
 * Stable name for a URL/path requirement: the `#egg=` fragment when present,
 * else the location with any trailing `@ref` and fragment stripped — so
 * `git+…/x.git@v1` → `git+…/x.git@v2` pairs as an UPGRADE, not a new dep.
 */
function urlReqName(loc: string): { name: string; spec: string } {
  const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(loc)?.[1];
  const noFrag = loc.replace(/#.*$/, '');
  const lastSlash = noFrag.lastIndexOf('/');
  const at = noFrag.indexOf('@', lastSlash + 1);
  const base = at > lastSlash && lastSlash !== -1 ? noFrag.slice(0, at) : noFrag;
  return { name: egg ? normalizePyName(egg) : base, spec: loc };
}

/** A requirement string (PEP 508 or URL/path) → dep, or null when it is neither. */
function parseRequirement(s: string): { name: string; spec: string } | null {
  const t = s.trim();
  if (looksLikeUrlOrPathReq(t)) return urlReqName(t.split(/\s+/)[0]!);
  return parsePep508(t);
}

function extractRequirements(lines: DiffLine[]): Extracted {
  const out: Extracted = { deps: [], langs: [], uncheckable: [] };
  for (const l of lines) {
    if (l.sign === ' ') continue;
    // `#` only starts a comment at line start or after whitespace (URLs carry `#egg=`);
    // a trailing `\` is a line continuation (pip-compile's `--hash` layout).
    const t = l.text.replace(/(^|\s)#.*$/, '').replace(/\\\s*$/, '').trim();
    if (!t) continue;
    if (t.startsWith('-')) {
      // -r / --requirement / -c / --constraint: the included file is not in this diff.
      if (/^(?:-r|-c|--requirement|--constraint)(?:\s|=|$)|^-[rc]\S/.test(t)) {
        cannotVerify(out, INCLUDE_CHANGED);
        continue;
      }
      const ed = /^(?:-e|--editable)(?:\s+|=)(\S+)/.exec(t) ?? /^-e(\S+)/.exec(t);
      if (ed) {
        const r = urlReqName(ed[1]!);
        out.deps.push({ name: r.name, spec: r.spec, sign: l.sign });
        continue;
      }
      // Integrity data for the requirement above it — never a dependency by itself.
      if (/^--hash[=\s]/.test(t)) continue;
      // Index URLs, find-links, trusted hosts, binary policy, …: they change
      // WHERE or WHAT gets installed, and this parser does not model them.
      cannotVerify(out, `requirements: option "${t.split(/[\s=]/)[0]}" changed; cannot verify`);
      continue;
    }
    const r = parseRequirement(t);
    if (r) out.deps.push({ name: r.name, spec: r.spec, sign: l.sign });
    else cannotVerify(out, 'requirements: unparseable line; cannot verify');
  }
  return out;
}

function quotedStrings(s: string): string[] {
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

/**
 * pyproject tables POSITIVELY known not to hold dependencies. Everything not
 * matched here (and not [project] / [tool.poetry], which are mixed) has
 * dependency semantics — including [build-system], [dependency-groups],
 * [project.optional-dependencies] and every unknown [tool.*] table.
 */
const PY_NON_DEP_TABLES: readonly RegExp[] = [
  /^project\.(urls|scripts|gui-scripts|entry-points(\..+)?|authors|maintainers|license|readme)$/,
  /^tool\.(ruff|black|isort|mypy|pytest|coverage|pyright|basedpyright|pylint|flake8|pydocstyle|codespell|bandit|commitizen|bumpversion|bumpver|towncrier|interrogate|vulture|yapf|autopep8|docformatter|semantic_release|setuptools_scm|pycln|refurb|sqlfluff|djlint|typos|pyupgrade|pydoclint)(\..+)?$/,
  /^tool\.poetry\.(scripts|urls|plugins(\..+)?)$/,
  /^tool\.setuptools\.(packages(\..+)?|package-data|package-dir|exclude-package-data|data-files)$/,
  /^tool\.hatch\.(version|build(\.targets\.[^.]+)?)$/,
];

/** Keys of [project] positively known not to be dependencies. */
const PY_PROJECT_NON_DEP_KEYS = new Set([
  'name', 'version', 'description', 'readme', 'license', 'license-files', 'authors', 'maintainers',
  'keywords', 'classifiers', 'urls', 'scripts', 'gui-scripts', 'entry-points', 'import-names',
  'import-namespaces',
]);
/** Keys of [tool.poetry] positively known not to be dependencies. */
const PY_POETRY_NON_DEP_KEYS = new Set([
  'name', 'version', 'description', 'authors', 'maintainers', 'license', 'readme', 'homepage', 'repository',
  'documentation', 'keywords', 'classifiers', 'packages', 'include', 'exclude', 'package-mode',
]);

type PyTableClass = 'nondep' | 'project' | 'poetry' | 'dep';

function classifyPyTable(t: string): PyTableClass {
  if (t === 'project') return 'project';
  if (t === 'tool.poetry') return 'poetry';
  if (PY_NON_DEP_TABLES.some((re) => re.test(t))) return 'nondep';
  return 'dep';
}

const PY_UNKNOWN_POSITION = 'pyproject.toml: changed line in a table the diff does not show; cannot verify';

function extractPyproject(lines: DiffLine[]): Extracted {
  const out: Extracted = { deps: [], langs: [], uncheckable: [] };
  let table: string | null = null; // null = unknown
  let array: string | null | undefined = undefined; // undefined = unknown, null = none
  let headerChanged = false;

  /** Dependency semantics for one requirement-string entry. */
  const depEntry = (s: string, sign: '+' | '-', where: string) => {
    const r = parseRequirement(s);
    if (r) out.deps.push({ name: r.name, spec: r.spec, sign });
    else cannotVerify(out, `pyproject.toml: "${s}" in ${where} is not a requirement; cannot verify`);
  };

  for (const l of lines) {
    if (l.hunkStart) {
      table = l.hunkAtTop ? '' : null;
      array = l.hunkAtTop ? null : undefined;
      headerChanged = false;
      if (!l.hunkAtTop && l.hunkContext) {
        // GitHub's hunk header carries the nearest preceding "section" line:
        // a table header or a `key = [` array opener. Recover what we can.
        const ctx = l.hunkContext.replace(/\s+#.*$/, '').trim();
        const ctxHeader = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(ctx);
        const ctxArray = /^([A-Za-z0-9_."'-]+)\s*=\s*\[([^\]]*)$/.exec(ctx);
        if (ctxHeader) {
          table = ctxHeader[1]!.replace(/["']/g, '');
          array = null;
        } else if (ctxArray) {
          array = ctxArray[1]!.replace(/["']/g, ''); // table stays unknown
        }
      }
    }
    const t = l.text.replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('#')) continue;
    const changed = l.sign !== ' ';
    const sign = l.sign as '+' | '-';

    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(t);
    if (header) {
      table = header[1]!.replace(/["']/g, '');
      array = null;
      // A changed header re-homes the unchanged entries below it: those
      // entries were never diffed, so they cannot be verified.
      headerChanged = changed && classifyPyTable(table) !== 'nondep';
      continue;
    }

    const cls: PyTableClass | null = table === null ? null : table === '' ? 'dep' : classifyPyTable(table);
    // A changed line whose table the diff does not show may be requires-python
    // (or a tool's python pin) anywhere: the language rules cannot place it.
    if (changed && cls === null && !isStructuralOnly(t)) cannotVerifyLanguage(out, PY_UNKNOWN_POSITION);
    if (cls === 'nondep') continue;
    if (!changed) {
      if (headerChanged && !isStructuralOnly(t)) cannotVerify(out, 'pyproject.toml: table header changed above unchanged entries; cannot verify');
      // Still track array state from context lines below.
    }

    const kv = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(t);
    if (kv) {
      const key = kv[1]!.replace(/["']/g, '');
      const value = kv[2]!;
      const opensArray = value.startsWith('[');
      array = opensArray && !value.includes(']') ? key : null;
      if (!changed) continue;

      if (key === 'requires-python' || (key === 'python' && cls !== 'project')) {
        out.langs.push({ language: 'python', value: quotedStrings(value)[0] ?? value, sign });
        if (cls === null) cannotVerify(out, PY_UNKNOWN_POSITION);
        continue;
      }
      if (cls === null) {
        // Unknown table: an array opener has dependency semantics; anything else is unknowable.
        if (opensArray) for (const s of quotedStrings(value)) depEntry(s, sign, `"${key}"`);
        cannotVerify(out, PY_UNKNOWN_POSITION);
        continue;
      }
      if (cls === 'project' || cls === 'poetry') {
        const nonDep = cls === 'project' ? PY_PROJECT_NON_DEP_KEYS : PY_POETRY_NON_DEP_KEYS;
        if (nonDep.has(key)) continue;
        if (cls === 'project' && (key === 'dependencies' || key === 'optional-dependencies') && opensArray) {
          for (const s of quotedStrings(value)) depEntry(s, sign, `"${key}"`);
          continue;
        }
        cannotVerify(out, `pyproject.toml: [${table}] "${key}" is not a known non-dependency key; cannot verify`);
        continue;
      }
      // Dependency semantics: an array of requirements, or `name = spec` (poetry style).
      if (opensArray) {
        for (const s of quotedStrings(value)) depEntry(s, sign, `[${table}] "${key}"`);
        continue;
      }
      const inlineVersion = /version\s*=\s*["']([^"']*)["']/.exec(value)?.[1];
      const str = quotedStrings(value)[0];
      const spec = value.startsWith('{') ? inlineVersion ?? value : str ?? value;
      out.deps.push({ name: normalizePyName(key), spec, sign });
      continue;
    }

    if (t.startsWith(']')) {
      array = null;
      continue;
    }
    if (!changed || isStructuralOnly(t)) continue;

    // An array entry (or anything else) on a changed line.
    if (cls === null || array === undefined || array === null) {
      // Unknown table + known array name = dependency semantics; otherwise unknowable.
      if (typeof array === 'string') {
        for (const s of quotedStrings(t)) depEntry(s, sign, `"${array}"`);
        if (cls === null && quotedStrings(t).length === 0) cannotVerify(out, PY_UNKNOWN_POSITION);
        if (cls !== null && quotedStrings(t).length === 0)
          cannotVerify(out, `pyproject.toml: unrecognised line in [${table}]; cannot verify`);
      } else {
        const qs = quotedStrings(t);
        for (const s of qs) {
          const r = parseRequirement(s);
          if (r) out.deps.push({ name: r.name, spec: r.spec, sign });
        }
        cannotVerify(out, cls === null ? PY_UNKNOWN_POSITION : `pyproject.toml: unrecognised line in [${table}]; cannot verify`);
      }
      continue;
    }
    if (cls === 'project' || cls === 'poetry') {
      const nonDep = cls === 'project' ? PY_PROJECT_NON_DEP_KEYS : PY_POETRY_NON_DEP_KEYS;
      if (nonDep.has(array)) continue;
      if (cls === 'project' && array === 'dependencies') {
        for (const s of quotedStrings(t)) depEntry(s, sign, '"dependencies"');
        if (quotedStrings(t).length === 0) cannotVerify(out, 'pyproject.toml: unrecognised line in [project] "dependencies"; cannot verify');
        continue;
      }
      cannotVerify(out, `pyproject.toml: [${table}] "${array}" is not a known non-dependency key; cannot verify`);
      continue;
    }
    const qs = quotedStrings(t);
    if (qs.length === 0) cannotVerify(out, `pyproject.toml: unrecognised line in [${table}] "${array}"; cannot verify`);
    for (const s of qs) depEntry(s, sign, `[${table}] "${array}"`);
  }
  return out;
}

const GO_UNKNOWN = 'go.mod: unrecognised directive or position; cannot verify';

function extractGoMod(lines: DiffLine[]): Extracted {
  const out: Extracted = { deps: [], langs: [], uncheckable: [] };
  let block: string | null = null; // directive of the open `x (` block, 'none', or null = unknown
  for (const l of lines) {
    if (l.hunkStart) {
      block = l.hunkAtTop ? 'none' : null;
      // GitHub's hunk context is the nearest line starting with a letter: often `require (`.
      const ctx = /^(\w+)\s*\($/.exec(l.hunkContext.trim());
      if (!l.hunkAtTop && ctx) block = ctx[1]!;
    }
    const t = l.text.replace(/\/\/.*$/, '').trim();
    if (!t) continue;
    const sign = l.sign;
    const blockOpen = /^(\w+)\s*\($/.exec(t);
    if (blockOpen) {
      block = blockOpen[1]!;
      if (sign !== ' ' && !['require', 'retract', 'godebug', 'ignore'].includes(block))
        cannotVerify(out, `go.mod: "${block}" directive changed; cannot verify`);
      continue;
    }
    if (t === ')') {
      block = 'none';
      continue;
    }
    if (sign === ' ') continue;

    const inBlock = block !== 'none' && block !== null;
    const directive = inBlock ? block! : /^(\w+)\b/.exec(t)?.[1] ?? '';
    const body = inBlock ? t : t.slice(directive.length).trim();

    if (!inBlock && directive === 'go') {
      out.langs.push({ language: 'go', value: body, sign });
      continue;
    }
    if (!inBlock && directive === 'toolchain') {
      out.langs.push({ language: 'go', value: body.replace(/^go/, ''), sign });
      continue;
    }
    if (block === null) {
      // Position unknown: a `path vX` line may be require OR exclude. Name it, then fail closed.
      const m = /^(\S+)\s+(v\S+)$/.exec(t);
      if (m) out.deps.push({ name: m[1]!, spec: m[2]!, sign });
      cannotVerify(out, GO_UNKNOWN);
      cannotVerifyLanguage(out, GO_UNKNOWN);
      continue;
    }
    switch (directive) {
      case 'require': {
        const m = /^(\S+)\s+(v\S+)$/.exec(body);
        if (m) out.deps.push({ name: m[1]!, spec: m[2]!, sign });
        else cannotVerify(out, 'go.mod: unrecognised require line; cannot verify');
        break;
      }
      case 'module':
      case 'retract':
      case 'godebug':
      case 'ignore':
        break; // about this module itself, not what it depends on
      default:
        // replace / exclude / tool / anything newer: changes what is built.
        cannotVerify(out, directive ? `go.mod: "${directive}" directive changed; cannot verify` : GO_UNKNOWN);
    }
  }
  return out;
}

/** Cargo tables positively known not to hold dependencies. */
function isCargoNonDepTable(t: string): boolean {
  return /^(package|lib|bin|test|bench|example|badges|features|lints|profile|workspace\.package|workspace\.lints|workspace\.metadata|package\.metadata)(\..+)?$/.test(
    t,
  );
}

const CARGO_UNKNOWN_POSITION = 'Cargo.toml: changed line in a table the diff does not show; cannot verify';

function extractCargoToml(lines: DiffLine[]): Extracted {
  const out: Extracted = { deps: [], langs: [], uncheckable: [] };
  let table: string | null = null;
  let array: string | null = null;
  for (const l of lines) {
    if (l.hunkStart) {
      table = l.hunkAtTop ? '' : null;
      array = null;
    }
    const t = l.text.replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(t);
    if (header) {
      table = header[1]!.replace(/["']/g, '');
      array = null;
      continue;
    }
    const kv = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(t);
    if (kv) array = kv[2]!.startsWith('[') && !kv[2]!.includes(']') ? kv[1]!.replace(/["']/g, '') : null;
    else if (t.startsWith(']')) {
      array = null;
      continue;
    }
    if (l.sign === ' ' || isStructuralOnly(t)) continue;
    const sign = l.sign;

    if (kv && kv[1]!.replace(/["']/g, '') === 'rust-version') {
      out.langs.push({ language: 'rust', value: quotedStrings(kv[2]!)[0] ?? kv[2]!, sign });
      if (table === null) {
        cannotVerify(out, CARGO_UNKNOWN_POSITION);
        cannotVerifyLanguage(out, CARGO_UNKNOWN_POSITION);
      }
      continue;
    }
    if (table === null) cannotVerifyLanguage(out, CARGO_UNKNOWN_POSITION);
    if (table !== null && table !== '' && isCargoNonDepTable(table)) continue;
    if (table === 'workspace' && kv && ['members', 'exclude', 'default-members'].includes(kv[1]!)) continue;
    if (table === 'workspace' && !kv && array !== null) continue; // members list continuation

    if (!kv) {
      // Multi-line array entry: only a dependency's `features` list is known-harmless.
      if (table !== null && array === 'features') continue;
      cannotVerify(out, table === null ? CARGO_UNKNOWN_POSITION : `Cargo.toml: unrecognised line in [${table}]; cannot verify`);
      continue;
    }
    const key = kv[1]!.replace(/["']/g, '');
    const value = kv[2]!;
    const inlineVersion = /version\s*=\s*["']([^"']*)["']/.exec(value)?.[1];
    const spec = value.startsWith('{') ? inlineVersion ?? value : quotedStrings(value)[0] ?? value;
    const depName = key.replace(/\.workspace$/, ''); // `serde.workspace = true`

    if (table === null) {
      if (!TOML_NON_DEP_KEYS.has(key) && ((value.startsWith('{') && inlineVersion !== undefined) || looksLikeTomlSpec(spec)))
        out.deps.push({ name: depName, spec, sign });
      cannotVerify(out, CARGO_UNKNOWN_POSITION);
      continue;
    }
    const subtable = /(^|\.)(dev-|build-)?dependencies\.([^.]+)$/.exec(table);
    if (subtable) {
      // [dependencies.foo]: version / source keys identify WHAT is built.
      if (['features', 'optional', 'default-features', 'default_features'].includes(key)) continue;
      out.deps.push({ name: subtable[3]!, spec: key === 'version' ? spec : `${key}=${spec}`, sign });
      continue;
    }
    // [*dependencies], [patch.*], [replace], [workspace] non-member keys and
    // unknown tables: dependency semantics.
    out.deps.push({ name: depName, spec, sign });
  }
  return out;
}

/** Whole-file version pins. Returns the language lines the patch sets/removes. */
function extractVersionFile(path: string, lines: DiffLine[]): Extracted {
  const out: Extracted = { deps: [], langs: [] };
  const b = basename(path);
  const lang = VERSION_FILES[b];
  for (const l of lines) {
    if (l.sign === ' ') continue;
    const t = l.text.replace(/#.*$/, '').trim();
    if (!t) continue;
    if (b === '.tool-versions') {
      const [tool, ver] = t.split(/\s+/);
      if (tool && ver) out.langs.push({ language: normalizeLanguage(tool), value: ver, sign: l.sign });
      continue;
    }
    if (b === 'rust-toolchain.toml' || (b === 'rust-toolchain' && t.includes('='))) {
      const ch = /^channel\s*=\s*["']([^"']+)["']/.exec(t);
      if (ch) out.langs.push({ language: 'rust', value: ch[1]!, sign: l.sign });
      continue;
    }
    out.langs.push({ language: lang ?? 'unknown', value: t.replace(/^(python-|node-|v)/i, ''), sign: l.sign });
  }
  return out;
}

// ─── analysis per file ───────────────────────────────────────────────────────

interface FileAnalysis {
  file: PrFile;
  ecosystem: Ecosystem | null;
  isManifest: boolean;
  lockEcosystem: Ecosystem | null;
  isVersionFile: boolean;
  /** Manifest that can carry an embedded language version (package.json engines, …). */
  carriesLanguage: boolean;
  patchMissing: boolean;
  extracted: Extracted;
}

function analyze(file: PrFile): FileAnalysis {
  const path = file.filename;
  const b = basename(path);
  const ecosystem = manifestEcosystem(path);
  const isVersionFile = b in VERSION_FILES;
  const lockEcosystem = LOCKFILES[b] ?? null;
  const patch = typeof file.patch === 'string' ? file.patch : null;
  // GitHub omits `patch` for large/binary diffs. A pure rename with no content
  // change also has no patch, and that is NOT missing information.
  const pureRename = file.status === 'renamed' && patch === null && !!file.previous_filename;
  const patchMissing = patch === null && !pureRename && file.status !== 'unchanged';
  const lines = patch ? parsePatch(patch) : [];

  let extracted: Extracted = { deps: [], langs: [] };
  const format = parsedFormat(path);
  if (format === 'package.json') extracted = extractPackageJson(lines);
  else if (format === 'pyproject') extracted = extractPyproject(lines);
  else if (format === 'requirements') extracted = extractRequirements(lines);
  else if (format === 'go.mod') extracted = extractGoMod(lines);
  else if (format === 'cargo') extracted = extractCargoToml(lines);
  else if (isVersionFile) extracted = extractVersionFile(path, lines);

  return {
    file,
    ecosystem,
    isManifest: ecosystem !== null,
    lockEcosystem,
    isVersionFile,
    carriesLanguage: ecosystem !== null && !isRequirementsFile(path),
    patchMissing,
    extracted,
  };
}

// ─── glob matching ───────────────────────────────────────────────────────────

function stripGlob(g: string): string {
  return g.trim().replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Does `path` fall under a protected glob? Deliberately generous (this is a
 * block list, so over-matching is the safe direction):
 *   * full-path glob match (Bun.Glob);
 *   * a pattern with no '/' also matches the basename anywhere ("*.lock");
 *   * a plain directory ("src/legacy" or "src/legacy/") matches everything under it.
 */
export function pathMatchesGlob(path: string, glob: string): boolean {
  const g = stripGlob(glob);
  if (!g) return false;
  const p = path.replace(/^\/+/, '');
  const dir = g.replace(/\/+$/, '');
  if (p === dir || p.startsWith(`${dir}/`)) return true;
  const matcher = new Bun.Glob(g.endsWith('/') ? `${g}**` : g);
  if (matcher.match(p)) return true;
  if (!g.includes('/') && matcher.match(basename(p))) return true;
  return false;
}

// ─── the evaluator ───────────────────────────────────────────────────────────

function has(kinds: Set<string>, k: CheckableKind): boolean {
  return kinds.has(k);
}

export function evaluateConstraints(raw: unknown, files: PrFile[]): ConstraintEvaluation {
  const { checkable, unchecked, malformed } = partitionConstraints(raw);
  const violations: ConstraintViolation[] = [...malformed];
  const kinds = new Set<string>(checkable.map((c) => c.kind));

  const analyses = checkable.length > 0 ? files.map(analyze) : [];

  // ── no_files_touched ──
  for (const c of checkable) {
    if (c.kind !== 'no_files_touched') continue;
    for (const f of files) {
      const paths = [f.filename, f.previous_filename].filter((p): p is string => !!p);
      for (const g of c.globs) {
        const hit = paths.find((p) => pathMatchesGlob(p, g));
        if (hit) {
          violations.push({
            kind: 'no_files_touched',
            file: f.filename,
            detail: `${hit} matches protected path "${g}" (${f.status})`,
          });
          break;
        }
      }
    }
  }

  // ── dependencies ──
  const depKinds = (['no_new_dependencies', 'no_dependency_upgrades'] as const).filter((k) => has(kinds, k));
  if (depKinds.length > 0) {
    const cannotVerifyAll = (file: string, detail: string) => {
      for (const k of depKinds) violations.push({ kind: k, file, detail });
    };
    for (const a of analyses) {
      // A submodule pointer IS a dependency pin on another repository.
      const sub = submoduleChange(a.file.patch, a.file.filename);
      if (sub) {
        const added = a.file.status === 'added' || (sub.plus && !sub.minus);
        if (added && has(kinds, 'no_new_dependencies'))
          violations.push({ kind: 'no_new_dependencies', file: a.file.filename, detail: SUBMODULE_ADDED });
        if (!added && sub.plus && has(kinds, 'no_dependency_upgrades'))
          violations.push({ kind: 'no_dependency_upgrades', file: a.file.filename, detail: SUBMODULE_BUMPED });
        continue;
      }
      // THE fail-closed rule: a dependency-relevant path (either side of a
      // rename) in a format we do not parse blocks — added, modified or deleted.
      const paths = [a.file.filename, a.file.previous_filename].filter((p): p is string => !!p);
      const unparsed = paths.find((p) => isDependencyFile(p) && parsedFormat(p) === null);
      if (unparsed) {
        cannotVerifyAll(unparsed, DEPENDENCY_FILE_NOT_PARSED);
        continue;
      }
      // A rename that changes the format re-interprets content nobody diffed
      // (notes.txt → requirements.txt; requirements.txt → pyproject.toml).
      const prev = a.file.previous_filename;
      if (prev && prev !== a.file.filename && parsedFormat(prev) !== parsedFormat(a.file.filename)) {
        cannotVerifyAll(a.file.filename, RENAMED_ACROSS_FORMATS);
        continue;
      }
      if (!a.isManifest || a.file.status === 'removed') continue;
      const cannot = a.extracted.uncheckable ?? [];
      if (a.patchMissing) {
        for (const k of depKinds) violations.push({ kind: k, file: a.file.filename, detail: PATCH_UNAVAILABLE });
        continue;
      }
      for (const detail of cannot) {
        for (const k of depKinds) violations.push({ kind: k, file: a.file.filename, detail });
      }
      const removed = new Map<string, Set<string>>();
      for (const d of a.extracted.deps) {
        if (d.sign !== '-') continue;
        if (!removed.has(d.name)) removed.set(d.name, new Set());
        removed.get(d.name)!.add(d.spec);
      }
      for (const d of a.extracted.deps) {
        if (d.sign !== '+') continue;
        const before = removed.get(d.name);
        if (!before) {
          if (has(kinds, 'no_new_dependencies')) {
            violations.push({
              kind: 'no_new_dependencies',
              file: a.file.filename,
              detail: `adds dependency "${d.name}"${d.spec ? ` (${d.spec})` : ''}`,
            });
          }
        } else if (!before.has(d.spec) && has(kinds, 'no_dependency_upgrades')) {
          violations.push({
            kind: 'no_dependency_upgrades',
            file: a.file.filename,
            detail: `changes "${d.name}" from ${[...before].join(' | ') || '(unspecified)'} to ${d.spec || '(unspecified)'}`,
          });
        }
      }
    }
  }

  // ── lockfiles (no_dependency_upgrades only; see header) ──
  if (has(kinds, 'no_dependency_upgrades')) {
    for (const a of analyses) {
      if (!a.lockEcosystem) continue;
      const lockDir = dirname(a.file.filename);
      const explained = analyses.some(
        (m) =>
          m.isManifest &&
          m.ecosystem !== null &&
          m.ecosystem === a.lockEcosystem &&
          (lockDir === '' ||
            dirname(m.file.filename) === lockDir ||
            dirname(m.file.filename).startsWith(`${lockDir}/`)) &&
          (m.patchMissing ||
            m.file.status === 'removed' ||
            hasRealDependencyChange(m.extracted.deps) ||
            (m.extracted.uncheckable?.length ?? 0) > 0),
      );
      if (!explained) {
        violations.push({
          kind: 'no_dependency_upgrades',
          file: a.file.filename,
          detail:
            'lockfile changed with no dependency change in a matching manifest; resolved versions may have been upgraded',
        });
      }
    }
  }

  // ── language versions ──
  const pins = checkable.filter(
    (c): c is Extract<CheckableConstraint, { kind: 'pin_language_version' }> => c.kind === 'pin_language_version',
  );
  const noLangChange = has(kinds, 'no_language_version_change');
  if (noLangChange || pins.length > 0) {
    /** Fail closed under every active language rule whose language this file can set. */
    const cannotVerifyLang = (file: string, detail: string) => {
      if (noLangChange) violations.push({ kind: 'no_language_version_change', file, detail });
      const langs = languagesOf(file);
      for (const p of pins) {
        if (langs === null || langs.includes(normalizeLanguage(p.language)))
          violations.push({ kind: 'pin_language_version', file, detail });
      }
    };
    for (const a of analyses) {
      // THE fail-closed rule, language edition: a language-version-bearing path
      // (either side of a rename) whose format we do not parse blocks.
      const langPaths = [a.file.filename, a.file.previous_filename].filter((p): p is string => !!p);
      const unparsedLang = langPaths.find((p) => isLanguageVersionFile(p) && !languageParsed(p));
      if (unparsedLang) {
        cannotVerifyLang(unparsedLang, LANGUAGE_FILE_NOT_PARSED);
        continue;
      }
      const prevLang = a.file.previous_filename;
      if (
        prevLang &&
        prevLang !== a.file.filename &&
        isLanguageVersionFile(prevLang) &&
        basename(prevLang) !== basename(a.file.filename)
      ) {
        cannotVerifyLang(prevLang, RENAMED_ACROSS_FORMATS);
        continue;
      }
      if (!a.isVersionFile && !a.carriesLanguage) continue;
      const fname = a.file.filename;
      const wholeFileLang = a.isVersionFile ? VERSION_FILES[basename(fname)] ?? null : null;

      if (a.isVersionFile) {
        // Any add/remove/modify/rename of a version pin file IS a version change.
        if (noLangChange) {
          violations.push({
            kind: 'no_language_version_change',
            file: fname,
            detail: `language version file ${a.file.status}`,
          });
        }
        for (const p of pins) {
          const lang = normalizeLanguage(p.language);
          if (wholeFileLang !== null && wholeFileLang !== lang) continue;
          if (a.file.status === 'removed') {
            const removesLang = a.extracted.langs.some((ll) => ll.sign === '-' && ll.language === lang);
            if (wholeFileLang === lang || removesLang || a.patchMissing) {
              violations.push({ kind: 'pin_language_version', file: fname, detail: `removes the ${lang} version pin` });
            }
            continue;
          }
          if (a.patchMissing) {
            violations.push({ kind: 'pin_language_version', file: fname, detail: PATCH_UNAVAILABLE });
            continue;
          }
          for (const ll of a.extracted.langs) {
            if (ll.sign === '+' && ll.language === lang && !versionSatisfiesPin(ll.value, p.version)) {
              violations.push({
                kind: 'pin_language_version',
                file: fname,
                detail: `sets ${lang} to ${ll.value}; pinned at ${p.version}`,
              });
            }
          }
        }
        continue;
      }

      // Manifest that can embed a language version.
      if (a.file.status === 'removed') continue;
      if (a.patchMissing) {
        if (noLangChange) violations.push({ kind: 'no_language_version_change', file: fname, detail: PATCH_UNAVAILABLE });
        if (pins.length > 0) violations.push({ kind: 'pin_language_version', file: fname, detail: PATCH_UNAVAILABLE });
        continue;
      }
      for (const detail of a.extracted.langUncheckable ?? []) cannotVerifyLang(fname, detail);
      if (noLangChange) {
        const byLang = new Map<string, { plus: string[]; minus: string[] }>();
        for (const ll of a.extracted.langs) {
          if (!byLang.has(ll.language)) byLang.set(ll.language, { plus: [], minus: [] });
          byLang.get(ll.language)![ll.sign === '+' ? 'plus' : 'minus'].push(ll.value);
        }
        for (const [lang, { plus, minus }] of byLang) {
          const same = plus.length === minus.length && [...plus].sort().join('\0') === [...minus].sort().join('\0');
          if (!same) {
            violations.push({
              kind: 'no_language_version_change',
              file: fname,
              detail: `changes ${lang} version from ${minus.join(' | ') || '(unset)'} to ${plus.join(' | ') || '(unset)'}`,
            });
          }
        }
      }
      for (const p of pins) {
        const lang = normalizeLanguage(p.language);
        for (const ll of a.extracted.langs) {
          if (ll.sign === '+' && ll.language === lang && !versionSatisfiesPin(ll.value, p.version)) {
            violations.push({
              kind: 'pin_language_version',
              file: fname,
              detail: `sets ${lang} to ${ll.value}; pinned at ${p.version}`,
            });
          }
        }
      }
    }
  }

  const verdict: ConstraintVerdict =
    violations.length > 0
      ? 'violation'
      : checkable.length === 0 && unchecked.length > 0
        ? 'unchecked_only'
        : 'pass';
  return { verdict, violations, unchecked };
}
