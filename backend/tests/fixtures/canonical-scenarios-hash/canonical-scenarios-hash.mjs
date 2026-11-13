// canonical-scenarios-hash v1 — REFERENCE implementation (movies-db, 2026-10-02).
// Single source of the algorithm. Every implementation (ncn scripts/lib/gherkin-check.mjs,
// fr TS, R3b, U3) MUST reproduce vectors.json byte-for-byte in its own CI.
import { createHash } from 'node:crypto';

// gherkin text normalisation: CRLF/CR -> LF; strip trailing whitespace (space, tab) per line;
// drop trailing empty lines; exactly ONE trailing "\n". null/undefined gherkin stays null.
// No Unicode normalisation (NFC is NOT applied — bytes as given), no inner-whitespace collapse.
export function normaliseGherkin(g) {
  if (g === null || g === undefined) return null;
  if (typeof g !== 'string') throw new TypeError('gherkin must be string|null');
  const lines = g.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines.join('\n') + '\n' : null; // empty/whitespace-only == null
}

// canonical JSON: objects with keys sorted by UTF-16 code unit order, no whitespace,
// JSON.stringify escaping for strings; arrays keep order.
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

// input: array of {scenario_id, criterion_id, title, gherkin} (extra fields IGNORED, e.g. status/source/failing_test).
// projection: exactly these 4 keys; gherkin normalised. sorted by scenario_id (code-unit order).
// duplicate scenario_id -> error. hash = lowercase hex sha256 of UTF-8 canon(projection).
export function canonicalScenariosString(scenarios) {
  if (!Array.isArray(scenarios)) throw new TypeError('scenarios must be an array');
  const proj = scenarios.map((s) => ({
    scenario_id: String(s.scenario_id), criterion_id: String(s.criterion_id),
    title: String(s.title ?? ''), gherkin: normaliseGherkin(s.gherkin),
  }));
  proj.sort((a, b) => (a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0));
  for (let i = 1; i < proj.length; i++) if (proj[i].scenario_id === proj[i - 1].scenario_id) throw new Error('duplicate scenario_id ' + proj[i].scenario_id);
  return canon(proj);
}
export function scenariosHash(scenarios) {
  return createHash('sha256').update(canonicalScenariosString(scenarios), 'utf8').digest('hex');
}
