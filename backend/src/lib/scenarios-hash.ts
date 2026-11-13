// src/lib/scenarios-hash.ts
//
// canonical-scenarios-hash v1 — fr's port of movies-db's REFERENCE implementation
// (~/.claude/plans/program/30-specs-contracts/canonical-scenarios-hash/
//  canonical-scenarios-hash.mjs + README.md). Used for U3
// `execution.feature_design_approval` `metadata.scenarios_hash`, recomputed at mint.
//
//   1. only scenario_id, criterion_id, title, gherkin participate; other fields IGNORED
//   2. gherkin: CRLF/CR → LF; strip trailing spaces/tabs per line; drop trailing empty
//      lines; exactly one trailing "\n". null / absent / whitespace-only ⇒ null. NO
//      Unicode normalisation, NO inner-whitespace collapse. title verbatim (String()).
//   3. project to exactly {scenario_id, criterion_id, title, gherkin}; sort by
//      scenario_id (UTF-16 code-unit order); a duplicate scenario_id THROWS
//   4. canonical JSON (keys sorted, no whitespace, JSON.stringify escaping)
//   5. lowercase hex sha256 over the UTF-8 bytes
//
// Conformance: tests/unit/lib/scenarios-hash.test.ts asserts every vendored golden
// vector (tests/fixtures/canonical-scenarios-hash/vectors.json, sha256 pinned beside it)
// byte-for-byte. Refresh the vectors only from movies-db's directory.
//
// canon is `canonicalizeJcs` (the U2 H_r canonicaliser): over this value domain —
// strings and null only — it is byte-identical to the reference's `canon`, and one
// implementation keeps two hashes in one approval from disagreeing on canonicalisation.
// PURE: no db, no env.

import { createHash } from 'node:crypto';

import { canonicalizeJcs } from './bug-report-hash';

/** The reference's `normaliseGherkin`, ported line for line. */
export function normaliseGherkin(g: unknown): string | null {
  if (g === null || g === undefined) return null;
  if (typeof g !== 'string') throw new TypeError('gherkin must be string|null');
  const lines = g
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\n')}\n` : null; // empty/whitespace-only == null
}

export interface ScenarioLike {
  scenario_id: unknown;
  criterion_id: unknown;
  title?: unknown;
  gherkin?: unknown;
}

/**
 * What the hash accepts: a typed scenario, or any parsed card-document entry
 * (`Record<string, unknown>`) — fr#1395 made this the ONE implementation, and the
 * card-document callers hold untyped entries. Type-only; the runtime projection
 * (String() / normaliseGherkin over the four keys) is unchanged.
 */
export type ScenarioInput = ScenarioLike | Readonly<Record<string, unknown>>;

/** The canonical string the hash is taken over (the reference's canonicalScenariosString). */
export function canonicalScenariosString(scenarios: readonly ScenarioInput[]): string {
  if (!Array.isArray(scenarios)) throw new TypeError('scenarios must be an array');
  const proj = scenarios.map((s) => ({
    scenario_id: String(s.scenario_id),
    criterion_id: String(s.criterion_id),
    title: String(s.title ?? ''),
    gherkin: normaliseGherkin(s.gherkin),
  }));
  proj.sort((a, b) => (a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0));
  for (let i = 1; i < proj.length; i++) {
    if (proj[i]!.scenario_id === proj[i - 1]!.scenario_id) {
      throw new Error(`duplicate scenario_id ${proj[i]!.scenario_id}`);
    }
  }
  return canonicalizeJcs(proj);
}

export function scenariosHash(scenarios: readonly ScenarioInput[]): string {
  return createHash('sha256').update(canonicalScenariosString(scenarios), 'utf8').digest('hex');
}
