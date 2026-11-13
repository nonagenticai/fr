// src/services/outline-constraint-scan.ts
//
// A CONTRADICTION DETECTOR FOR A PROPOSED OUTLINE. NOT A GATE.
//
// ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
// A project request's `constraints` are ASSEMBLED INTO THE ANALYSIS BRIEF
// (routes/projects.ts `renderConstraintsForBrief`) and then nothing looks at
// what the agent sent back. The only enforcement that exists is
// `services/constraint-check.ts`, a PRE-MERGE gate on a PR DIFF — by which
// point a human has already agreed the outline that planned the breach.
// So: when the analysis agent proposes an outline, read the outline's own prose
// and report where it CONTRADICTS a rule the requester set.
//
// ── WHY THIS IS NOT constraint-check.ts IN A DIFFERENT HAT ───────────────────
// `evaluateConstraints(raw, files: PrFile[])` is irreducibly diff-shaped: every
// rule it owns is "which changed LINE of which MANIFEST FILE", built on
// `parsePatch`, per-ecosystem manifest parsers and a lockfile-explanation rule.
// An outline has no files and no patches, so none of that can run.
//
// ⭐ AND THE FAIL DIRECTION IS INVERTED, which is the real reason this is a
// separate module rather than a mode of that one. constraint-check.ts fails
// CLOSED: a dependency-relevant change it cannot positively read is a
// violation, because at merge time silence must not read as a pass. This file
// MUST fail OPEN: an outline is prose, and "I could not find a contradiction"
// is the NORMAL case for a compliant outline. A fail-closed text scan would
// flag every outline ever written and be turned off within a day.
//
// ⛔ THEREFORE — THE SENTENCE THAT MUST TRAVEL WITH EVERY CONSUMER:
// A FINDING IS EVIDENCE. AN EMPTY RESULT IS NOT. This detects an outline that
// SAYS it will do the forbidden thing; it cannot detect one that does the
// forbidden thing silently, because at outline time no code exists to inspect.
// Never render an empty result as "outline complies" — render it as nothing at
// all. `scanOutlineForContradictions` has no `pass` verdict on purpose: there
// is no value it could return that would mean "compliant", so it returns none.
//
// ── WHAT IS REUSED FROM constraint-check.ts (genuinely, not decoratively) ────
//   * `partitionConstraints` — raw jsonb -> checkable / unchecked / malformed.
//     Same two live shapes (typed union + legacy `string`), same malformed
//     handling. Re-implementing it here would let the two readers of one column
//     disagree about what a row means.
//   * `versionSatisfiesPin` + `normalizeLanguage` — `pin_language_version` is
//     the one kind with PARAMETERS, so a version named in the outline can be
//     judged against the pin by exactly the rule the merge gate will later use.
//     Two gates on one pin must not have two opinions of "3.12 satisfies 3.12".
//   * `pathMatchesGlob` — `no_files_touched` globs are matched against paths
//     harvested from the prose by the same matcher the diff gate uses.
//
// ── WHAT IS NOT EVALUABLE PRE-IMPLEMENTATION, AND SAID SO ────────────────────
//   * `must_keep_api_compatible` — not evaluable here, and (per
//     types/project-constraints.ts) not diff-evaluable either. A breaking
//     change need not be announced or even touch a recognisable file.
//   * `custom` and legacy free-text strings — an arbitrary prose rule against
//     arbitrary prose. Matching those is a judgement, not a check; pretending
//     otherwise is how a detector starts lying. Reported as `unevaluable` so a
//     caller cannot mistake their silence for coverage.
//
// The remaining five kinds are DETECTION-ONLY, per the header rule above.

import {
  partitionConstraints,
  normalizeLanguage,
  versionSatisfiesPin,
  pathMatchesGlob,
} from './constraint-check';

// ─── public types ────────────────────────────────────────────────────────────

/** One place a proposed outline says it will breach a rule the requester set. */
export interface OutlineContradiction {
  /** The constraint kind contradicted (a `CHECKABLE_KINDS` member). */
  kind: string;
  /** Where in the outline, e.g. `deliverables[1].description`. */
  where: string;
  /** The offending fragment, trimmed and length-capped, so a human can judge it. */
  quote: string;
  /** Why this fragment contradicts the rule. */
  detail: string;
}

export interface OutlineScanResult {
  contradictions: OutlineContradiction[];
  /**
   * Constraint kinds present on the request that this scan CANNOT evaluate
   * against an outline. `legacy_text` = pre-vocabulary string, `unrecognised` =
   * unparseable shape. Never omitted, never folded into a pass.
   *
   * ⛔ A MALFORMED checkable constraint appears here too, tagged
   * `<kind> (malformed)` — see `malformed` below for why it may not be dropped.
   */
  unevaluable: string[];
  /**
   * Checkable kinds the requester DID set but whose row fr cannot parse
   * (`partitionConstraints`'s third bucket).
   *
   * ⭐ THIS IS NOT THE SAME THING AS `unevaluable`, and conflating the two is
   * how it went missing. `unevaluable` means "this scan never claimed to check
   * that kind". `malformed` means "the requester asked for an ENFORCED rule and
   * the stored row is unreadable" — which `constraint-check.ts:1254` will treat
   * as a VIOLATION at merge time. So the decider agreeing the outline now is
   * agreeing something the merge gate is already going to refuse, and that must
   * reach them. Before 2026-09-24 this bucket was destructured away and the row
   * disappeared from the result entirely.
   */
  malformed: string[];
}

/**
 * The kinds this file can produce a contradiction for. NOT a claim of
 * enforcement — see the header. Deliberately a subset of `CHECKABLE_KINDS`:
 * `partitionConstraints` may hand us a checkable kind this scan has no rule
 * for, and such a kind must land in `unevaluable`, not vanish.
 */
export const OUTLINE_SCANNABLE_KINDS = [
  'no_new_dependencies',
  'no_dependency_upgrades',
  'no_language_version_change',
  'pin_language_version',
  'no_files_touched',
] as const;

const SCANNABLE = new Set<string>(OUTLINE_SCANNABLE_KINDS);

/** Max characters of an offending fragment carried into a finding. */
const QUOTE_CAP = 200;

// ─── the outline, flattened into (where, text) segments ──────────────────────
//
// A segment is roughly a sentence-sized unit of authored prose. Rules match
// WITHIN a segment, never across two, so "…do not add a dependency." followed
// by "Upgrade nothing." cannot be spliced into a false positive.

interface Segment {
  where: string;
  text: string;
}

/** The subset of a `project_outlines` row / ProjectOutlineInput we read. */
export interface ScannableOutline {
  summary?: string | null;
  deliverables?: unknown;
  intermediate_deliverables?: unknown;
  milestones?: unknown;
}

/**
 * Remove FENCED code blocks (``` … ```) before anything is scanned.
 *
 * ⭐ A fence is QUOTED MATERIAL, not an authored sentence: an outline fences the
 * command it is documenting, forbidding or diffing about. Measured on the real
 * module 2026-09-24: a fenced `npm install express` under the prose "Document
 * the forbidden command" produced a `no_new_dependencies` finding.
 *
 * ⚠️ INLINE spans (`like this`) are deliberately NOT stripped. "Run `npm
 * install express`" is one of the commonest ways a real intent is written, and
 * stripping inline code would delete detection, not noise. The prohibition-
 * context guard below is what handles the inline false positive instead.
 * An unterminated fence closes at end of text, so a half-written fence cannot
 * leak its body back into the scan.
 */
function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ');
}

function pushText(out: Segment[], where: string, value: unknown): void {
  if (typeof value !== 'string') return;
  const t = stripFencedCode(value).trim();
  if (t) out.push({ where, text: t });
}

function pushDeliverables(out: Segment[], key: string, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  raw.forEach((d, i) => {
    if (!d || typeof d !== 'object') return;
    const item = d as Record<string, unknown>;
    pushText(out, `${key}[${i}].title`, item.title);
    pushText(out, `${key}[${i}].description`, item.description);
    if (Array.isArray(item.acceptance_criteria)) {
      item.acceptance_criteria.forEach((ac, j) =>
        pushText(out, `${key}[${i}].acceptance_criteria[${j}]`, ac),
      );
    }
    // `kind` and `checked_by` are short controlled-vocabulary tokens, not
    // authored prose; scanning them would only manufacture noise.
  });
}

/**
 * Every piece of authored prose in an outline, with its path.
 *
 * ⚠️ Exported for the tests, which assert the harvest is EXHAUSTIVE. A rule
 * that works perfectly on a field this function forgot to collect is a gate
 * that cannot fail — the defect this whole lane exists to avoid.
 */
export function outlineSegments(outline: ScannableOutline | null | undefined): Segment[] {
  const out: Segment[] = [];
  if (!outline || typeof outline !== 'object') return out;
  pushText(out, 'summary', outline.summary);
  pushDeliverables(out, 'deliverables', outline.deliverables);
  pushDeliverables(out, 'intermediate_deliverables', outline.intermediate_deliverables);
  if (Array.isArray(outline.milestones)) {
    outline.milestones.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      pushText(out, `milestones[${i}].name`, (m as Record<string, unknown>).name);
    });
  }
  return out;
}

/**
 * Split a segment into SENTENCES — `.`/`!`/`?`/newline only, deliberately NOT
 * `;`. A semicolon joins two clauses of one authored thought ("…might add a
 * dependency; we will reject that in review."), and splitting on it separates
 * an intent from its own mitigating clause. Two genuinely different sentences
 * still separate here, which is what keeps a compliant sentence elsewhere in
 * the same paragraph from suppressing an unrelated intent sentence.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Split one sentence into `;`-joined clauses, for QUOTING and MATCHING. A
 * clause is the unit a finding's `quote` is built from — narrow, so the
 * excerpt a human reads stays sentence-of-thought-sized rather than a whole
 * paragraph.
 *
 * ⚠️ NOT the unit `suppressed()` is judged over — see `sentenceOf` below.
 * `clauses('No packages are upgraded; versions stay as they are.')` still
 * returns two windows, so "…add a new dependency" and "Upgrade nothing."
 * (`fr#1187`-shaped, from two DIFFERENT clauses of one compliant sentence)
 * are matched separately, exactly as before this split existed.
 */
function clauses(sentence: string): string[] {
  return sentence
    .split(/(?<=;)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * All clause-windows of a segment, flattened — the exact sequence the old
 * single-pass `windows()` produced (sentence-split then clause-split, in
 * order, is the same partition as splitting on `[.;!?\n]` in one pass).
 * Kept as the export the test suite's exhaustiveness check walks.
 */
function windows(text: string): string[] {
  return sentences(text).flatMap(clauses);
}

function quote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= QUOTE_CAP ? t : `${t.slice(0, QUOTE_CAP - 1)}…`;
}

// ─── the negation guard ──────────────────────────────────────────────────────
//
// An outline that RESTATES the constraint ("no new dependencies will be added",
// "without upgrading any package") is the single most common shape of a
// COMPLIANT outline, and every naive verb match fires on it. Suppressing it is
// not politeness — a detector whose commonest finding is a compliant outline
// gets ignored, and then it detects nothing at all.
//
// This is a heuristic and it cuts BOTH ways: an outline that says "no new
// dependencies" and then adds one is not caught. That is the same
// detection-only limit the header states; it is not a new hole.
const NEGATION_RE =
  /\b(no|not|never|without|avoid|avoids|avoiding|refrain|zero|neither|nor|don't|do not|does not|doesn't|cannot|can't|won't|will not|must not|mustn't|should not|shouldn't|rather than|instead of|no need to|free of)\b/i;

function negated(window: string): boolean {
  return NEGATION_RE.test(window);
}

// ─── the prohibition-context guard ───────────────────────────────────────────
//
// A sentence that describes a MECHANISM FOR PREVENTING the forbidden thing
// states an intent NOT to do it, and every command regex fires on it because
// the sentence has to NAME the command in order to ban it. Measured on the real
// module 2026-09-24: "Add a CI guard that fails if `npm install express`
// appears in any workflow" produced a `no_new_dependencies` finding — an
// outline PROTECTING the constraint reported as breaching it.
//
// This is the same class as NEGATION_RE (the sentence's polarity is negative,
// it just says so with a noun instead of "not"), so it is applied in exactly
// the same places and to exactly the same kinds. It cuts both ways in the same
// way, and the header's detection-only rule covers that.
const PROHIBITION_CONTEXT_RE =
  /\b(lint|lints|linter|linting|guard|guards|guardrail|pre[- ]commit|ci\s+(?:check|guard|job|rule|gate)|policy\s+check|reject|rejects|rejecting|forbid|forbids|forbidden|forbidding|prohibit|prohibits|prohibited|disallow|disallows|disallowed|block|blocks|blocking|prevent|prevents|preventing|refuse|refuses|fail\s+(?:if|when|the\s+build)|fails\s+(?:if|when|the\s+build)|failing\s+(?:if|when))\b/i;

// ─── the standard-library-only guard ────────────────────────────────────────
//
// A sentence that DECLARES the implementation is stdlib-only is a compliance
// statement for `no_new_dependencies`/`no_dependency_upgrades`, even when it
// also uses the verb those rules match on. Measured on the real module
// 2026-09-24: "add a new module to the existing package, using only the
// standard library" fired `no_new_dependencies` — the object of "add" is a
// MODULE the outline is writing, not a package it is pulling in, and the
// sentence says so outright. Same class as NEGATION_RE: the polarity is
// negative, phrased as an exclusivity claim ("only") rather than "not".
const STDLIB_ONLY_RE =
  /\b(?:using|use|uses|with|via|built with|written with|built using|relying on)\b[^.;!?\n]{0,20}?\bonly\b[^.;!?\n]{0,10}?\bstandard\s+librar(?:y|ies)\b|\bstandard\s+librar(?:y|ies)\s+only\b|\bno\s+third[- ]party\s+(?:dependenc(?:y|ies)|packages?|librar(?:y|ies))\b|\bstdlib[- ]only\b/i;

/**
 * True when the window's polarity is negative — it restates the constraint, or
 * it describes machinery that enforces it, or it declares a stdlib-only
 * implementation. Either way the named verb is not an intent to act.
 */
function suppressed(window: string): boolean {
  return negated(window) || PROHIBITION_CONTEXT_RE.test(window) || STDLIB_ONLY_RE.test(window);
}

// ─── rule: no_new_dependencies ───────────────────────────────────────────────

const ADD_DEP_RES: readonly RegExp[] = [
  // "add a new library", "introduce a dependency", "pull in a crate"
  /\b(add|adds|adding|introduce|introduces|introducing|pull in|pulls in|pulling in|bring in|brings in|bringing in|vendor|vendors|vendoring|adopt|adopts|adopting)\b[^.;!?\n]{0,80}?\b(dependenc(?:y|ies)|packages?|librar(?:y|ies)|crates?|gems?|third[- ]party)\b/i,
  // the other word order: "a new dependency on redis will be added"
  /\b(dependenc(?:y|ies)|packages?|librar(?:y|ies)|crates?|gems?)\b[^.;!?\n]{0,60}?\b(will be added|is added|are added|to be added|gets added)\b/i,
  // "a new dependency", "new third-party library"
  /\bnew\b[^.;!?\n]{0,30}?\b(dependenc(?:y|ies)|packages?|librar(?:y|ies)|crates?|gems?|third[- ]party)\b/i,
  // package-manager add/install commands name a concrete package
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+(?!-)[@\w][\w@./-]*/i,
  /\bpip3?\s+install\s+(?!-)[\w][\w[\]@.=<>-]*/i,
  /\b(?:poetry|uv|pdm|rye)\s+add\s+(?!-)[\w][\w[\]@.=<>-]*/i,
  /\bcargo\s+add\s+(?!-)[\w][\w@./-]*/i,
  /\bgo\s+get\s+(?!-)[\w][\w@./-]*/i,
  /\b(?:gem|composer)\s+(?:install|require)\s+(?!-)[\w][\w@./-]*/i,
];

// ─── rule: no_dependency_upgrades ────────────────────────────────────────────

/**
 * A DOCUMENT is not a dependency, and "2.0" beside one is not a version bump.
 *
 * ⭐ Measured on the real module 2026-09-24: under `no_dependency_upgrades`,
 * "Update the onboarding guide to 2.0 of the internal process handbook" fired
 * the bare `verb … to <version>` rule below. Nothing in that sentence is a
 * package. This list is the OBJECT vocabulary that disqualifies that ONE weak
 * rule; the rules that name a dependency noun outright are untouched by it.
 */
const DOC_ARTEFACT_RE =
  /\b(guide|guides|guideline|guidelines|doc|docs|document|documents|documentation|handbook|manual|readme|changelog|release\s+notes?|spec|specs|specification|specifications|playbook|runbook|policy|policies|procedure|procedures|process|processes|onboarding|tutorial|walkthrough|wiki|article|whitepaper|paper|slide|slides|deck|diagram|template|templates|standard|standards|checklist|charter|report|reports|curriculum|syllabus|contract|copy|content|page|pages|schema\s+docs?|api\s+docs?)\b/i;

/**
 * "update X to <version>" — the weakest of the upgrade rules, because the only
 * dependency-ish evidence it has is a version number.
 *
 * It fires only when the OBJECT between the verb and the version is not a
 * document (see `DOC_ARTEFACT_RE`). Every match in the window is examined, not
 * just the first: "Update the guide to 2.0 and bump express to 5" must still
 * report the express half, so suppressing on "a doc word appears anywhere in
 * the window" would have traded one false positive for a false negative.
 */
const UPGRADE_TO_VERSION_RE =
  /\b(?:upgrade|upgrades|upgrading|bump|bumps|bumping|update|updates|updating)\b([^.;!?\n]{0,60}?)\bto\s+v?\d+(?:\.\d+)*/gi;

function namesANonDocumentVersionBump(window: string): boolean {
  const re = new RegExp(UPGRADE_TO_VERSION_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    if (!DOC_ARTEFACT_RE.test(m[1] ?? '')) return true;
  }
  return false;
}

/**
 * The same ambiguity one word earlier: "Update the guide to version 2.0" reaches
 * the dependency-noun rule through the word `version` alone. So `version(s)` is
 * split off from the unambiguous dependency nouns and gated on the same object
 * test. `lockfile` stays unambiguous — nothing but dependencies has one.
 */
const UPGRADE_TO_WORD_VERSION_RE =
  /\b(?:upgrade|upgrades|upgrading|bump|bumps|bumping|update|updates|updating)\b([^.;!?\n]{0,80}?)\bversions?\b/gi;

function namesANonDocumentVersionWord(window: string): boolean {
  const re = new RegExp(UPGRADE_TO_WORD_VERSION_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    if (!DOC_ARTEFACT_RE.test(m[1] ?? '')) return true;
  }
  return false;
}

const UPGRADE_DEP_RES: readonly RegExp[] = [
  /\b(upgrade|upgrades|upgrading|bump|bumps|bumping|update|updates|updating)\b[^.;!?\n]{0,80}?\b(dependenc(?:y|ies)|packages?|librar(?:y|ies)|crates?|gems?|lock(?:file)?)\b/i,
  /\b(dependenc(?:y|ies)|packages?|librar(?:y|ies)|crates?|gems?)\b[^.;!?\n]{0,60}?\b(upgraded|bumped|updated)\b/i,
  // ⚠️ the "update axios to 2.0" / "bump express to v5" shape is NOT a plain
  // regex here — it is `namesANonDocumentVersionBump` above.
  /\b(?:npm|pnpm|yarn|bun)\s+(?:update|upgrade|up)\b/i,
  /\bpip3?\s+install\s+[^\n]*--upgrade\b/i,
  /\bcargo\s+update\b/i,
  /\bgo\s+get\s+-u\b/i,
  /\b(?:poetry|uv|pdm|rye)\s+(?:update|upgrade|lock\s+--upgrade)\b/i,
];

// ─── rule: language versions ─────────────────────────────────────────────────
//
// `LANGUAGE_TOKEN_RE` deliberately spells out aliases rather than deriving them
// from constraint-check's LANGUAGE_ALIASES map: that map keys on what a
// MANIFEST FIELD is called, and prose says "Node.js" where a manifest says
// "node". `normalizeLanguage` still does the comparing, so the two agree on
// identity even though they differ on spelling.
const LANGUAGE_TOKEN_RE =
  /\b(python|python3|py|node|node\.js|nodejs|npm|typescript|ts|javascript|js|go|golang|rust|rustc|ruby|java|jdk|kotlin|scala|php|dotnet|\.net|c#|csharp|swift|bun|deno|elixir|erlang)\b/gi;

const LANG_CHANGE_VERB_RE =
  /\b(upgrade|upgrades|upgrading|downgrade|downgrades|downgrading|bump|bumps|bumping|migrate|migrates|migrating|move|moves|moving|switch|switches|switching|port|ports|porting|update|updates|updating|raise|raises|raising|target|targets|targeting|adopt|adopts|adopting|jump|jumps|jumping)\b/i;

const VERSION_RE = /\bv?(\d+(?:\.\d+)*)\b/;

/**
 * Language/version pairs named in one window: the language token plus the first
 * version number appearing WITHIN `NEAR` characters after it.
 *
 * Proximity, not "anywhere in the window", is what stops "migrate the Python
 * service to 3 new modules" pairing `python` with `3`. It is still a heuristic,
 * and the header's detection-only rule is what covers its misses.
 */
const NEAR = 40;

interface LangMention {
  language: string;
  version: string;
  fragment: string;
}

function langMentions(window: string): LangMention[] {
  const out: LangMention[] = [];
  // Fresh regex per call: a module-level /g regex carries `lastIndex` between
  // calls and would skip mentions in every other window.
  const re = new RegExp(LANGUAGE_TOKEN_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    const token = m[0];
    const after = window.slice(m.index + token.length, m.index + token.length + NEAR);
    const v = VERSION_RE.exec(after);
    const version = v?.[1];
    if (!v || !version) continue;
    out.push({
      language: token,
      version,
      fragment: window.slice(m.index, m.index + token.length + v.index + v[0].length),
    });
  }
  return out;
}

// ─── rule: no_files_touched ──────────────────────────────────────────────────
//
// Harvest path-like tokens from prose. A token qualifies only if it contains a
// `/` or looks like `name.ext`, so ordinary words and sentence-final periods do
// not become paths. URLs are stripped first: `https://github.com/x/y` would
// otherwise match a glob like `**/y`.
const URL_RE = /\bhttps?:\/\/\S+/gi;
const PATH_TOKEN_RE = /[A-Za-z0-9_@.*-]+(?:\/[A-Za-z0-9_@.*-]+)+\/?|[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;

/**
 * Technology names that are SHAPED like `name.ext` and are never a path.
 *
 * ⭐ Measured on the real module 2026-09-24: `no_files_touched` with
 * `globs: ['*.js']` flagged "Port the Node.js service to TypeScript" — the
 * product name `Node.js` was harvested as a path and matched `*.js`. That is
 * the exact inversion of the sentence's meaning: the outline is LEAVING
 * JavaScript.
 *
 * ⚠️ Only the bare-name branch is affected. A token containing `/` — the shape
 * of a real path — is never stoplisted, so `packages/node.js/index.js` still
 * matches. The cost of this list is an outline that means a file literally
 * NAMED `node.js`; the cost of not having it is a false finding on every
 * outline that mentions Node.
 */
const NON_PATH_NAMES = new Set([
  'node.js',
  'nodejs.org',
  'next.js',
  'nuxt.js',
  'nest.js',
  'vue.js',
  'react.js',
  'angular.js',
  'ember.js',
  'backbone.js',
  'express.js',
  'jquery.js',
  'three.js',
  'd3.js',
  'chart.js',
  'io.js',
  'socket.io',
  'asp.net',
  'vb.net',
  '.net',
  'i.e',
  'e.g',
  'etc',
  'vs.net',
]);

function pathTokens(window: string): string[] {
  const cleaned = window.replace(URL_RE, ' ');
  const out: string[] = [];
  const re = new RegExp(PATH_TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    // Trim trailing punctuation a sentence leaves attached.
    const t = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!t) continue;
    if (!t.includes('/') && NON_PATH_NAMES.has(t.toLowerCase())) continue;
    out.push(t);
  }
  return out;
}

/**
 * Verbs of MERE ACCESS — looking at a file to learn something, never to
 * change it.
 *
 * ⭐ Measured on the real module 2026-09-24: `no_files_touched` with
 * `globs: ['**\/*']` flagged "We will read config/settings.yaml to understand
 * the current layout." — `no_files_touched` means "do not CHANGE this path",
 * and reading one to inform the work is the opposite of that intent.
 */
const FILE_READ_ONLY_RE =
  /\b(read|reads|reading|review|reviews|reviewing|inspect|inspects|inspecting|consult|consults|consulting|reference|references|referencing|look(?:s|ing)? at|examine|examines|examining|understand|understands|understanding|study|studies|studying|view|views|viewing|check(?:s|ing)? the (?:contents|layout|structure|format)\s+of)\b/i;

/**
 * Verbs that DO change a file's contents or existence. Present alongside a
 * read verb in the SAME window means the window describes more than looking —
 * "Read the config, then edit it directly" must still fire.
 */
const FILE_WRITE_RE =
  /\b(edit|edits|editing|modify|modifies|modifying|change|changes|changing|update|updates|updating|write|writes|writing|create|creates|creating|delete|deletes|deleting|remove|removes|removing|rename|renames|renaming|move|moves|moving|refactor|refactors|refactoring|rewrite|rewrites|rewriting|patch|patches|patching|touch|touches|touching|append|appends|appending|replace|replaces|replacing|add|adds|adding|save|saves|saving|overwrite|overwrites|overwriting)\b/i;

/**
 * True when the window names ONLY a read of the path, never a change to it.
 * `no_files_touched` forbids touching, not reading, so this window is not the
 * intent that rule exists to catch.
 *
 * ⚠️ Requires the write list to be ABSENT, not merely the read list present:
 * "Read the config, then edit config/settings.yaml" names both, and the write
 * half must still be caught.
 */
function readOnlyAccess(window: string): boolean {
  return FILE_READ_ONLY_RE.test(window) && !FILE_WRITE_RE.test(window);
}

// ─── the scan ────────────────────────────────────────────────────────────────

/**
 * Report where a proposed outline contradicts the request's constraints.
 *
 * ⛔ PURE, and a NON-BLOCKING reporter: it has no verdict, cannot reject, and
 * returns `contradictions: []` both for a compliant outline and for one it
 * simply could not read. See the header for why that ambiguity is deliberate
 * and why no consumer may render it as a pass.
 *
 * @param rawConstraints `project_requests.payload.constraints` verbatim (jsonb;
 *   may be a typed union, legacy `string[]`, undefined, or junk).
 * @param outline the proposed outline (a `project_outlines` row or the webhook
 *   body — only the prose fields are read).
 */
export function scanOutlineForContradictions(
  rawConstraints: unknown,
  outline: ScannableOutline | null | undefined,
): OutlineScanResult {
  // ⛔ ALL THREE BUCKETS, and `malformed` is not optional. Destructuring only
  // two is what made a `no_files_touched` with missing/empty `globs` vanish from
  // the result while `constraint-check.ts:1254` counted the identical row as a
  // violation. See `OutlineScanResult.malformed`.
  const { checkable, unchecked, malformed } = partitionConstraints(rawConstraints);
  const unevaluable = new Set<string>(unchecked);
  const malformedKinds = [...new Set(malformed.map((v) => v.kind))].sort();
  for (const k of malformedKinds) unevaluable.add(`${k} (malformed)`);

  // A checkable kind with no rule in this file is unevaluable HERE. Derived
  // from the set rather than assumed equal to CHECKABLE_KINDS, so adding a kind
  // to the merge gate cannot silently create a rule this scan pretends to have.
  for (const c of checkable) {
    if (!SCANNABLE.has(c.kind)) unevaluable.add(c.kind);
  }
  // `must_keep_api_compatible` arrives via `unchecked` already (it is not a
  // CHECKABLE_KIND), so it needs no special case here — partitionConstraints is
  // the one place that decision lives.

  const contradictions: OutlineContradiction[] = [];
  const active = checkable.filter((c) => SCANNABLE.has(c.kind));
  if (active.length === 0) {
    return { contradictions, unevaluable: [...unevaluable], malformed: malformedKinds };
  }

  const segments = outlineSegments(outline);

  for (const seg of segments) {
    for (const sentence of sentences(seg.text)) {
      const clauseList = clauses(sentence);
      // ⭐ Judged over the WHOLE SENTENCE, not the clause: "…might add a
      // dependency; we will reject that in review." is one authored thought
      // split by a semicolon, and the mitigating clause must be able to
      // suppress the intent clause beside it. Cross-SENTENCE isolation (a
      // compliant sentence elsewhere in the paragraph must NOT suppress an
      // unrelated intent sentence) still holds, because `sentences()` — not
      // `clauses()` — is what `.` / `!` / `?` / `\n` break on.
      const sentenceSuppressed = clauseList.some(suppressed);

      for (const w of clauseList) {
      const isNegated = sentenceSuppressed;

      for (const c of active) {
        switch (c.kind) {
          case 'no_new_dependencies': {
            if (isNegated) break;
            if (ADD_DEP_RES.some((re) => re.test(w))) {
              contradictions.push({
                kind: c.kind,
                where: seg.where,
                quote: quote(w),
                detail:
                  'this sentence READS AS an intent to add a dependency, which the request forbids',
              });
            }
            break;
          }
          case 'no_dependency_upgrades': {
            if (isNegated) break;
            if (
              UPGRADE_DEP_RES.some((re) => re.test(w)) ||
              namesANonDocumentVersionBump(w) ||
              namesANonDocumentVersionWord(w)
            ) {
              contradictions.push({
                kind: c.kind,
                where: seg.where,
                quote: quote(w),
                detail:
                  'this sentence READS AS an intent to upgrade a dependency, which the request forbids',
              });
            }
            break;
          }
          case 'no_language_version_change': {
            if (isNegated) break;
            if (!LANG_CHANGE_VERB_RE.test(w)) break;
            const first = langMentions(w)[0];
            if (first) {
              contradictions.push({
                kind: c.kind,
                where: seg.where,
                quote: quote(w),
                detail: `this sentence names a ${first.language} version change (${first.language} ${first.version}), which the request forbids`,
              });
            }
            break;
          }
          case 'pin_language_version': {
            // ⭐ The one rule that does NOT need a verb and is NOT suppressed by
            // a negation: the constraint carries the language AND the exact
            // version, so a different version named beside that language
            // contradicts the pin however the sentence is phrased — including
            // "we will NOT stay on Python 3.11, we move to 3.13".
            //
            // ⚠️ KEPT DELIBERATELY, 2026-09-24, and it IS a false-positive
            // source: "We will NOT migrate to Python 3.13" fires under a 3.11
            // pin (measured). The skip is load-bearing — the commonest real
            // breach of a pin is phrased with a negation ("we will not stay on
            // 3.11"), and the negation attaches to the OLD version, not the new
            // one. Telling those two apart needs to know which version the
            // "not" governs, which is parsing, not a keyword. Suppressing on
            // negation here would delete the detection this rule exists for.
            // ⇒ So the skip stays and the finding DISCLOSES it instead: a
            // negated window says so in its own `detail`, on the line the human
            // reads, rather than in a comment only this file's authors see.
            const want = normalizeLanguage(c.language);
            const negatedWindow = negated(w);
            for (const m of langMentions(w)) {
              if (normalizeLanguage(m.language) !== want) continue;
              if (versionSatisfiesPin(m.version, c.version)) continue;
              contradictions.push({
                kind: c.kind,
                where: seg.where,
                quote: quote(w),
                detail:
                  `this sentence names ${m.language} ${m.version}, but the request pins ${c.language} at ${c.version}` +
                  (negatedWindow
                    ? ' — ⚠️ AND THE SENTENCE IS NEGATED, so this version may be one the outline is RULING OUT rather than adopting. This rule reports a pin mismatch regardless of phrasing (a real breach is often written "we will not stay on the pinned version"), so read the quote before acting on it.'
                    : ''),
              });
            }
            break;
          }
          case 'no_files_touched': {
            if (isNegated) break;
            if (readOnlyAccess(w)) break;
            for (const token of pathTokens(w)) {
              const hit = c.globs.find((g) => pathMatchesGlob(token, g));
              if (!hit) continue;
              contradictions.push({
                kind: c.kind,
                where: seg.where,
                quote: quote(w),
                detail: `this sentence names \`${token}\`, which looks like a path the request forbids touching (${hit})`,
              });
              break; // one finding per window per constraint
            }
            break;
          }
        }
      }
      }
    }
  }

  return {
    contradictions: dedupe(contradictions),
    unevaluable: [...unevaluable],
    malformed: malformedKinds,
  };
}

/** Collapse identical (kind, where, quote) findings — several rules can fire on one sentence. */
function dedupe(list: OutlineContradiction[]): OutlineContradiction[] {
  const seen = new Set<string>();
  const out: OutlineContradiction[] = [];
  for (const c of list) {
    const k = `${c.kind}\u0000${c.where}\u0000${c.quote}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ─── rendering for the approval card ────────────────────────────────────────

/**
 * The cap on the block this function returns.
 *
 * ⭐ 4000 MATCHES THE NAMED SIBLING DOOR on the SAME COLUMN:
 * `routes/webhooks.ts:513` (`change_summary: z.string().max(4000)`), which
 * `routes/execution-approvals.ts:197` also uses. Not invented here, and
 * deliberately NOT the 8000 of `routes/improvement-approvals.ts:81`: 4000 is
 * the limit the two doors that write this column agree on.
 *
 * ⛔ WHY A CAP AT ALL. `approvals.change_summary` is bare `text` (db/schema.ts:947)
 * with no validator on the path this module feeds, and the block is rendered
 * UNPAGINATED at `frontend/src/routes/approvals/+page.svelte:2679`. Measured
 * 2026-09-24: a 200-deliverable outline produces 1,400 findings = 233,513
 * characters — 123× the longest `change_summary` in production (1,902 over 5,019
 * rows). An unreadable wall in a queue row is a denial of service against the
 * decider this module exists to inform.
 *
 * ⛔ AND WHY TRUNCATION IS ANNOUNCED. The sibling doors REJECT rather than
 * truncate, which is right for producer-supplied text but wrong here: this text
 * is generated on a machine-authenticated webhook the scan must not be able to
 * fail (see the call site's fail-open contract), so the only options are
 * truncate or drop. A silently truncated finding list is an absence rendering as
 * a result — the exact defect class this module's header is about. So findings
 * are dropped WHOLE (never mid-quote) and the block says how many went.
 */
export const APPROVAL_NOTICE_CAP = 4000;

/**
 * Render findings as the prose block appended to the outline approval's
 * `change_summary` — the field the decider's card already displays.
 *
 * ⚠️ Returns null when there is NOTHING TO SAY, and that is the whole contract:
 * a compliant outline must add no text at all. Emitting "no contradictions
 * found" would be exactly the overclaim the header forbids — this scan cannot
 * establish compliance, so it must never print a sentence that reads like it.
 * `unevaluable` kinds are listed ONLY alongside something actionable, for the
 * same reason: on their own they would be a report about nothing.
 *
 * ⛔ WHAT A FINDING IS ALLOWED TO CLAIM, changed 2026-09-24. Every line is a
 * TEXT-MATCH over prose and 5 of 5 constructed inputs produced a WRONG one, so
 * this block may not assert what the outline intends. It presents each line as a
 * sentence worth a human's eye and names the ways it can be wrong. An advisory
 * detector that sounds certain is worse than one that sounds unsure: the
 * decider's only defence against a false finding is being told it is possible.
 *
 * ⚠️ A MALFORMED constraint is reported even with zero findings — it is not a
 * silence, it is a rule the merge gate will refuse later
 * (`constraint-check.ts:1254`). This is the only case where the block appears
 * without a contradiction, and it is a warning, never a reassurance.
 */
export function renderContradictionsForApproval(result: OutlineScanResult): string | null {
  const malformed = result.malformed ?? [];
  if (result.contradictions.length === 0 && malformed.length === 0) return null;

  const head: string[] = [];
  if (result.contradictions.length > 0) {
    head.push(
      '⚠️ POSSIBLE CONSTRAINT CONTRADICTIONS IN THIS OUTLINE — FOR YOUR JUDGEMENT',
      '',
      'Each line below is a KEYWORD MATCH over the outline’s own prose. It is a',
      'sentence worth your eye, NOT a finding of fact, and it CAN BE WRONG: a',
      'version number that belongs to a document, a product name shaped like a',
      'filename, a command quoted in order to forbid it. Read the quote and judge',
      'it yourself — nothing here is blocked, refused or decided by this scan.',
      '',
      'And an absence of findings would NOT have meant the outline complies: this',
      'scan reads what the outline SAYS, and at outline time there is no code to',
      'inspect.',
      '',
    );
  } else {
    head.push(
      '⚠️ A CONSTRAINT ON THIS REQUEST COULD NOT BE READ',
      '',
      'No contradicting sentence was looked for against the rule(s) below, because',
      'the stored constraint is unparseable. The pre-merge gate treats the same row',
      'as a violation, so agreeing this outline agrees work that gate will refuse.',
      '',
    );
  }

  const tail: string[] = [];
  if (malformed.length > 0) {
    tail.push('');
    tail.push(
      `Malformed constraint(s) on this request — set by the requester, unreadable by fr, NOT evaluated here and treated as a violation by the pre-merge gate: ${malformed
        .slice()
        .sort()
        .join(', ')}.`,
    );
  }
  if (result.unevaluable.length > 0) {
    tail.push('');
    tail.push(
      `Not evaluable against an outline (delivered to the agent, checked by nothing here): ${result.unevaluable
        .slice()
        .sort()
        .join(', ')}.`,
    );
  }

  const findingLines = result.contradictions.map(
    (c) => `• [${c.kind}] ${c.where}: ${c.detail}\n    “${c.quote}”`,
  );

  // Fit as many WHOLE findings as the cap allows, then say what was dropped.
  const overhead = (kept: number, omitted: number) =>
    head.join('\n').length +
    tail.join('\n').length +
    (omitted > 0 ? truncationNotice(kept, result.contradictions.length).length + 2 : 0);

  let kept = findingLines.length;
  let used = findingLines.join('\n').length + overhead(kept, 0);
  while (kept > 0 && used > APPROVAL_NOTICE_CAP) {
    kept -= 1;
    used =
      findingLines.slice(0, kept).join('\n').length +
      overhead(kept, result.contradictions.length - kept);
  }

  const lines = [...head, ...findingLines.slice(0, kept)];
  if (kept < result.contradictions.length) {
    lines.push('');
    lines.push(truncationNotice(kept, result.contradictions.length));
  }
  lines.push(...tail);
  return lines.join('\n');
}

/**
 * ⛔ The omission must be a SENTENCE, not a shorter list. A reader who cannot
 * tell a 12-finding outline from a 1,400-finding one whose tail was cut has been
 * handed an absence dressed as a result.
 */
function truncationNotice(kept: number, total: number): string {
  return `⚠️ ${total - kept} FURTHER POSSIBLE CONTRADICTION(S) WERE OMITTED — ${total} were found and only ${kept} fit this field’s ${APPROVAL_NOTICE_CAP}-character limit (matching routes/webhooks.ts:513). THIS LIST IS INCOMPLETE; the omitted lines were not judged and are not stored anywhere. An outline producing this many is itself worth questioning.`;
}
