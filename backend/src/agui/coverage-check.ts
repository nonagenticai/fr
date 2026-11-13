/**
 * E-14 — Integration coverage check.
 *
 * After every `registerAction` call has run at server boot, scan the
 * `src/integrations/` directory and assert that each integration module
 * (one .ts file per third-party surface) has at least one registered
 * read-kind action whose name is namespaced under that module's basename
 * (e.g. `kanban.list_boards` covers `kanban.ts`).
 *
 * This catches the regression where a slice file is added or renamed but
 * its `registerAction(...)` call is never wired (or the registry import
 * is never executed because no route imports the module).
 *
 * Initial enforcement mode is `warn`: log uncovered modules, but never
 * crash boot. Flip to `strict` via `FR_ENFORCE_ACTION_COVERAGE=strict`
 * once the warn-mode dashboard is clean.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { listActions } from './registry';

/**
 * Modules that are knowingly uncovered, each with the reason.
 *
 * Why this list exists: without it the check has only two outcomes — silently
 * warn forever (fr), or throw on every boot (kag, which is what it did: a
 * `[FATAL] Unhandled rejection … 8 uncovered integration module(s)` on every
 * single start). Neither distinguishes "nobody has written this action catalog
 * yet" from "this module is not agent-facing and never will be", so the signal
 * was worth nothing and nobody acted on it.
 *
 * With the list, the check answers a question that CAN go red for a real
 * reason: *has a NEW integration module appeared with no read action?* That is
 * the regression E-14 was written to catch, and it is currently undetectable
 * because the check is already failing.
 *
 * Rules, enforced below:
 *   - **rot** — an entry whose module no longer exists is an error.
 *   - **redundancy** — an entry that IS covered is an error; delete it.
 *   - **vacuity** — a reason under 30 chars is an error.
 *   - **ratchet** — `MAX_KNOWN_UNCOVERED` must be lowered whenever the list
 *     shrinks, so this can only ever get smaller.
 */
/**
 * The three entries below are now PERMANENT exemptions, decided rather than
 * deferred. Each was previously worded as an open question ("candidate for
 * permanent exemption", "arguably not agent-facing"); leaving them that way is
 * what let the list read as a backlog nobody owned.
 *
 * The four that WERE a genuine backlog — `architecture`, `pm`, `research`,
 * `media` — are gone from this list: they have real read surfaces and now have
 * real catalogs (`src/agui/actions/{architecture,pm,research,media}.ts`), so
 * the ratchet drops 8 → 4.
 *
 * The test for "should this be exempt" is NOT "is it hard to write a catalog".
 * It is: would an agent reading this mid-conversation be answering a user's
 * question, or reading operational telemetry it cannot act on? The remaining
 * entries fail that test for stated reasons.
 */
export const KNOWN_UNCOVERED: Readonly<Record<string, string>> = {
  'kag-orchestrator':
    'PERMANENT. Health-probe HTTP wrapper (getKagLag/getKagLatency) — ops telemetry with no agent-facing read surface. An agent reading lag figures mid-conversation cannot act on them; alerting owns this, not the action catalog.',
  'inference-router':
    'PERMANENT. Canary state + replay invocation log — an operator/observability surface. Exposing replay logs to an agent widens the blast radius of a prompt-injected read for no user-facing benefit.',
  'requirements-management':
    'PERMANENT. Container-binding cache + principle-conflict query; the agent-facing surface is already fully served by the requirements.* actions, so a catalog here would duplicate a covered surface.',
};

/**
 * One-way ratchet. Lower this in the same PR that covers a module. Never raise
 * it — a new integration module without a read action must fail the check, not
 * quietly extend the allowance.
 *
 * 8 → 4 when architecture/pm/research/media got catalogs; 4 → 3 when
 * `procedure-management` was deleted (procedure_management retired). The
 * remaining 3 are permanent by the decision recorded above.
 */
export const MAX_KNOWN_UNCOVERED = 3;

const MIN_REASON_LENGTH = 30;

export interface CoverageReport {
  /**
   * Basenames of integration files with no registered action AND no entry in
   * KNOWN_UNCOVERED — i.e. the ones that should fail the build.
   */
  uncoveredModules: string[];
  /** Uncovered but explicitly accounted for. Reported, never fatal. */
  knownUncoveredModules: string[];
  totalIntegrations: number;
  totalRegisteredActions: number;
}

/**
 * Map an integration module's FILE basename to the action-name namespace that
 * can actually cover it.
 *
 * ⚠️ This is not cosmetic. `registry.ts`'s `NAME_RE` is
 * `/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/` — **no hyphens** — so `'demo-tool.read'`
 * throws `InvalidActionNameError`. This check used to demand an action prefixed
 * with the basename VERBATIM, so for any hyphenated filename it required a name
 * the registry is contractually forbidden to accept. The rule was
 * **unsatisfiable, not unfinished**.
 *
 * Measured on main when this was found: 22 integration modules, 5 hyphenated
 * (`inference-router`, `kag-orchestrator`, `procedure-management`,
 * `quality-judges`, `requirements-management`). All 5 uncovered modules were
 * hyphenated; all 5 hyphenated modules were uncovered; no non-hyphenated module
 * was exempt — and `MAX_KNOWN_UNCOVERED` was exactly the hyphenated count.
 *
 * That does NOT make the four KNOWN_UNCOVERED reasons dishonest — they are
 * substantive on their face. It makes them, until now, **unfalsifiable**: nobody
 * could have covered those modules even if the reasons had been wrong. Fixing
 * the rule is what makes the exemption list mean something.
 *
 * Deliberately NOT fixed by relaxing `NAME_RE`: that would weaken a tested
 * contract governing every action in the registry to accommodate five filenames.
 */
export function actionNamespaceFor(basename: string): string {
  return basename.replaceAll('-', '_');
}

function defaultEnforce(): 'warn' | 'strict' {
  return process.env.FR_ENFORCE_ACTION_COVERAGE === 'strict' ? 'strict' : 'warn';
}

/**
 * The integration module basenames in a directory listing: `.ts` sources only,
 * skipping shared/internal modules (`_lib.ts`, anything starting with `_`) and
 * `.test.ts` files.
 */
export function integrationModuleBasenames(fileNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of fileNames) {
    if (name.startsWith('_')) continue;
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    out.push(path.basename(name, '.ts'));
  }
  return out;
}

/**
 * Classify every module as covered, knowingly uncovered or uncovered. PURE.
 *
 * Module is "covered" iff at least one registered read action has a name
 * matching `^<namespace>\..+`. Writes are excluded — coverage tracks the read
 * surface explicitly per the E-14 contract.
 *
 * Throws when the exemption list is not honest. These are errors in EVERY mode,
 * including 'warn': a rotten or dishonest exemption list is worse than no list,
 * because it reads as "accounted for" while accounting for nothing. Same
 * reasoning as the quarantine ratchet's rot/redundancy/vacuity rules.
 */
export function classifyCoverage(
  moduleBasenames: readonly string[],
  actions: ReadonlyArray<{ kind: string; name: string }>,
  known: Readonly<Record<string, string>>,
  maxKnown: number,
): CoverageReport {
  const allUncovered: string[] = [];
  for (const base of moduleBasenames) {
    const prefix = `${actionNamespaceFor(base)}.`;
    const covered = actions.some(
      (a) => a.kind === 'read' && a.name.startsWith(prefix) && a.name.length > prefix.length,
    );
    if (!covered) allUncovered.push(base);
  }

  const listProblems: string[] = [];
  for (const [mod, reason] of Object.entries(known)) {
    if (!moduleBasenames.includes(mod)) {
      listProblems.push(`ROT: "${mod}" is in KNOWN_UNCOVERED but no such integration module exists — delete the entry`);
    } else if (!allUncovered.includes(mod)) {
      listProblems.push(`REDUNDANT: "${mod}" is in KNOWN_UNCOVERED but IS covered — delete the entry and lower MAX_KNOWN_UNCOVERED`);
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      listProblems.push(`VACUOUS: "${mod}" needs a real reason (>= ${MIN_REASON_LENGTH} chars), got "${reason}"`);
    }
  }
  const knownCount = Object.keys(known).length;
  if (knownCount > maxKnown) {
    listProblems.push(`RATCHET: KNOWN_UNCOVERED has ${knownCount} entries but MAX_KNOWN_UNCOVERED is ${maxKnown} — the list may only shrink`);
  }
  if (listProblems.length > 0) {
    throw new Error(`[agui/coverage] exemption list is not honest:\n  ${listProblems.join('\n  ')}`);
  }

  return {
    uncoveredModules: allUncovered.filter((m) => !(m in known)),
    knownUncoveredModules: allUncovered.filter((m) => m in known),
    totalIntegrations: moduleBasenames.length,
    totalRegisteredActions: actions.length,
  };
}

/**
 * Check `src/integrations` (relative to cwd) against the live registry.
 * 'warn' (default) returns the report and logs a WARN per uncovered module;
 * 'strict' (`FR_ENFORCE_ACTION_COVERAGE=strict`) additionally throws.
 */
export async function runCoverageCheck(): Promise<CoverageReport> {
  const integrationsDir = path.join('src', 'integrations');
  const enforce = defaultEnforce();

  const entries = await readdir(integrationsDir, { withFileTypes: true });
  const moduleBasenames = integrationModuleBasenames(
    entries.filter((e) => e.isFile()).map((e) => e.name),
  );
  const report = classifyCoverage(moduleBasenames, listActions(), KNOWN_UNCOVERED, MAX_KNOWN_UNCOVERED);
  const { knownUncoveredModules, uncoveredModules } = report;

  if (knownUncoveredModules.length > 0) {
    console.log(
      `[agui/coverage] ${knownUncoveredModules.length} module(s) knowingly uncovered (see KNOWN_UNCOVERED): ${knownUncoveredModules.join(', ')}`,
    );
  }

  if (uncoveredModules.length > 0) {
    for (const m of uncoveredModules) {
      console.warn(
        `[agui/coverage] integration module "${m}" has no registered read action with prefix "${actionNamespaceFor(m)}." — wire its registerAction() call, remove the file, or add it to KNOWN_UNCOVERED with a reason`,
      );
    }
    if (enforce === 'strict') {
      throw new Error(
        `[agui/coverage] strict enforcement: ${uncoveredModules.length} unaccounted uncovered integration module(s): ${uncoveredModules.join(', ')}`,
      );
    }
  } else {
    console.log(
      `[agui/coverage] all ${report.totalIntegrations} integration module(s) accounted for by ${report.totalRegisteredActions} registered action(s)`,
    );
  }

  return report;
}
