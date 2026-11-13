// src/lib/projects/project-read-path.test.ts
//
// THE GUARD. `loadProject` fixed six pages; nothing forced the seventh, and
// nothing forces the eighth.
//
// The defect this family exists to prevent is not a display bug: a project read
// that failed was collapsed to `null` by `.catch(() => null)` and then rendered
// as a confident claim the fetch had never earned — on the board page, an
// instruction to RE-CREATE a project that exists and is fine. The fix was the
// shared `loadProject` helper, which keeps "absent" (404, a real answer) apart
// from "unreadable" (anything else). Six pages adopted it. Adoption by six
// authors is not an invariant; the next page inherits the old defect for free.
//
// So this test reads the ROUTE FILES THEMSELVES and asserts the invariant:
//
//   Every project-entity read on a page under routes/(project)/projects/[id]/**
//   goes through `loadProject`, or carries an explicit waiver saying why it
//   cannot — and a waived PRIMARY load owes the honest-failure state anyway.
//
// It lives here, colocated with the helper it protects, because CI already runs
// `vitest run` over `src/**/*.test.ts`: the guard registers itself and needs no
// workflow change to be enforced.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = join(HERE, '..', '..'); // src/
const ROUTE_ROOT = join(FRONTEND_SRC, 'routes', '(project)', 'projects', '[id]');

// ── What counts as reading THE PROJECT ENTITY ────────────────────────────────
// Only reads. `apiClient.projects.provision(...)` and the andon POSTs are
// mutations and must not be flagged — a guard that cries about writes gets
// waived wholesale, and then it protects nothing.
const DIRECT_PROJECT_READS: { name: string; re: RegExp }[] = [
  { name: 'apiClient.projects.get(...)', re: /apiClient\s*\.\s*projects\s*\.\s*get\s*\(/g },
  { name: 'fetchProjectCockpit(...)', re: /fetchProjectCockpit\s*\(/g },
  // authFetch on the project entity itself — `/api/projects/${id}` with NOTHING
  // after the id. A sub-resource (`/api/projects/${id}/andon/...`) is a
  // different read and is not this invariant's business.
  { name: 'authFetch(`/api/projects/${id}`)', re: /authFetch\s*\(\s*`\/api\/projects\/\$\{[^`{}]*\}`/g },
];

/** A waiver must sit on one of the WAIVER_LOOKBACK lines above the read. */
const WAIVER_LOOKBACK = 14;
const WAIVER_RE = /PROJECT-READ-WAIVER:\s*(primary-load|post-mutation refresh)\b/;
/** The honest-failure marker the six adopting pages all render. */
const UNREADABLE_MARKER = 'data-testid="project-unreadable"';
const HELPER_IMPORT = '$lib/projects/load-project';

interface Finding {
  file: string; // repo-relative, for the failure message
  line: number;
  what: string;
  waiver: string | null;
}

// EVERY `.svelte` file under routes/(project)/projects/[id]/**, not just `+page.svelte`.
// A page that delegates to a route-local component (e.g. the architecture
// sub-routes all mount `architecture/ProjectArchitecture.svelte`) moves its
// project read into that component; a `+page.svelte`-only walker then loses the
// read AND the adopter, and a raw `.catch(() => null)` there would be invisible.
// Layouts are included for the same reason: they can read the project too.
function routeSvelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeSvelteFiles(full));
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out.sort();
}

/** Pure, so it can be exercised against synthetic sources below. */
function findReads(source: string, file: string): Finding[] {
  const lines = source.split('\n');
  const found: Finding[] = [];
  for (const { name, re } of DIRECT_PROJECT_READS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const lineNo = source.slice(0, m.index).split('\n').length;
      const above = lines.slice(Math.max(0, lineNo - 1 - WAIVER_LOOKBACK), lineNo).join('\n');
      const w = above.match(WAIVER_RE);
      found.push({ file, line: lineNo, what: name, waiver: w ? w[1] : null });
    }
  }
  return found;
}

const FILES = routeSvelteFiles(ROUTE_ROOT).map((abs) => ({
  abs,
  rel: `frontend/src/${relative(FRONTEND_SRC, abs).split(sep).join('/')}`,
  source: readFileSync(abs, 'utf8'),
}));

function fix(rel: string, line: number, what: string): string {
  return [
    `${rel}:${line} reads the project directly via ${what}.`,
    `Route it through the shared helper instead:`,
    `    import { loadProject } from '${HELPER_IMPORT}';`,
    `    const { project, unreadable } = await loadProject(projectId);`,
    `and render an honest state when \`unreadable\` — never an absence claim`,
    `("not found", "not provisioned", "not linked", "re-create it"): a failed`,
    `read has not earned any of them.`,
    `If this read genuinely cannot use the helper (a different endpoint, or a`,
    `refresh after a write you just made), put a comment within ${WAIVER_LOOKBACK} lines above it:`,
    `    // PROJECT-READ-WAIVER: primary-load — <why the helper cannot serve it>`,
    `    // PROJECT-READ-WAIVER: post-mutation refresh — <why this is not the initial load>`,
    `A \`primary-load\` waiver still owes the family's honest-failure state:`,
    `the file performing the read must render ${UNREADABLE_MARKER}.`,
  ].join('\n');
}

describe('project sub-pages read the project through the shared path', () => {
  it('the roster is non-empty and includes the known adopters', () => {
    // A glob that silently matches nothing would make every assertion below
    // vacuously green. Pin the floor.
    expect(FILES.length).toBeGreaterThanOrEqual(20);
    // Route-local components ARE scanned (regression: a `+page.svelte`-only
    // walker dropped the architecture adopter once its read moved into a
    // shared component mounted by graph/dependencies/quality-gate).
    const rels = FILES.map((f) => f.rel);
    expect(rels).toContain('frontend/src/routes/(project)/projects/[id]/architecture/ProjectArchitecture.svelte');
    expect(rels.some((r) => !r.endsWith('/+page.svelte'))).toBe(true);
    const adopters = FILES.filter((f) => f.source.includes(HELPER_IMPORT)).map((f) => f.rel);
    // quality stub retired (fr#1306); needs-you left in R4 and board in R5 — both read the cockpit
    // read model (`fetchProjectCockpit`), not the project row, and render their own unreadable state.
    expect(adopters.length).toBeGreaterThanOrEqual(3);
    for (const page of ['architecture', 'governance', 'settings']) {
      expect(adopters.some((a) => a.includes(`/[id]/${page}/`))).toBe(true);
    }
  });

  it('the detector can actually fire (positive + negative control)', () => {
    // The guard's own instrument. A regex set that matches nothing passes every
    // real assertion here without protecting anything.
    const raw = `const p = await apiClient.projects.get(projectId).catch(() => null);`;
    expect(findReads(raw, 'x')).toHaveLength(1);
    expect(findReads(raw, 'x')[0].waiver).toBeNull();

    const cockpit = 'const c = await fetchProjectCockpit(id);';
    expect(findReads(cockpit, 'x')).toHaveLength(1);

    const entity = 'const r = await authFetch(`/api/projects/${projectId}`);';
    expect(findReads(entity, 'x')).toHaveLength(1);

    // Negatives: the shared path, a mutation, and a SUB-resource are all fine.
    expect(findReads(`const { project } = await loadProject(projectId);`, 'x')).toHaveLength(0);
    expect(findReads(`await apiClient.projects.provision(projectId);`, 'x')).toHaveLength(0);
    expect(
      findReads('await authFetch(`/api/projects/${projectId}/andon/${verb}`, {method:"POST"});', 'x'),
    ).toHaveLength(0);

    // A waiver is recognised, and only when it is close enough to the read.
    const waived = `// PROJECT-READ-WAIVER: primary-load — different endpoint\nawait fetchProjectCockpit(id);`;
    expect(findReads(waived, 'x')[0].waiver).toBe('primary-load');
    const tooFar = `// PROJECT-READ-WAIVER: primary-load — stale\n${'\n'.repeat(WAIVER_LOOKBACK + 2)}await fetchProjectCockpit(id);`;
    expect(findReads(tooFar, 'x')[0].waiver).toBeNull();
  });

  it('NO page reads the project outside the shared path without a waiver', () => {
    const offenders = FILES.flatMap((f) => findReads(f.source, f.rel)).filter((r) => !r.waiver);
    const message = offenders.map((o) => fix(o.file, o.line, o.what)).join('\n\n---\n\n');
    expect(offenders.map((o) => `${o.file}:${o.line} (${o.what})`), message).toEqual([]);
  });

  it('a waived PRIMARY load still renders the honest-unreadable state', () => {
    // The waiver buys an exemption from the HELPER, never from the OBLIGATION.
    // Without this, "I read a different endpoint" reopens the exact hole.
    // Judged PER FILE, for pages and route-local components alike: the file that
    // performs the waived read must render the marker itself. A component that
    // hands the failure to its parent via a prop would be flagged — deliberately
    // conservative (it fails loud, never blind); render the marker where the read
    // happens.
    const bad = FILES.filter(
      (f) =>
        findReads(f.source, f.rel).some((r) => r.waiver === 'primary-load') &&
        !f.source.includes(UNREADABLE_MARKER),
    ).map((f) => f.rel);
    expect(
      bad,
      `These files waived the shared helper for their PRIMARY project load but render no\n` +
        `honest-failure state. Add the family's marker to the failure branch:\n` +
        `    <p ${UNREADABLE_MARKER}>The project could not be read … it has NOT been shown\n` +
        `    to be missing. Retry, and report it if it persists.</p>\n` +
        `Offending file(s):\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });

  it('an adopting page actually CONSUMES the unreadable flag', () => {
    // `const { project } = await loadProject(id)` compiles, renders the same
    // wrong claim as before, and would otherwise pass this guard.
    const bad = FILES.filter(
      (f) => f.source.includes(HELPER_IMPORT) && !/\bunreadable\b/.test(f.source),
    ).map((f) => f.rel);
    expect(
      bad,
      `These files import loadProject but never reference \`unreadable\`, so a FAILED read\n` +
        `is indistinguishable from an absent project again — the whole point of the helper.\n` +
        `Read the flag and branch on it.\nOffending file(s):\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no waiver is left behind after the read it waived is gone', () => {
    // Keeps waivers honest: a stale blanket comment must not pre-authorise a
    // future raw read someone drops next to it.
    const bad = FILES.filter(
      (f) => WAIVER_RE.test(f.source) && findReads(f.source, f.rel).every((r) => !r.waiver),
    ).map((f) => f.rel);
    expect(
      bad,
      `These files carry a PROJECT-READ-WAIVER comment that no longer sits above any direct\n` +
        `project read. Delete the comment.\nOffending file(s):\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });
});
