// tests/unit/routes/assets/project-scope-caller-census.test.ts
//
// THE CENSUS THE project-scope-headers INTEGRATION SUITE (deleted 2026-10-29) COULD NOT TAKE.
//
// That file enumerates the callers of `applyEffectiveFilter` it drives, and its
// header derives that set by "grepping `applyEffectiveFilter` under src/routes/".
// `effective-query.ts` then warns, beside the `[]` it returns for a ghost
// project: "⚠️ If you add an eleventh caller, this justification goes stale
// silently — the empty set is still returned, the header simply is not."
//
// ⛔ THAT WARNING WAS ALREADY TRUE WHEN IT WAS WRITTEN. The eleventh caller is
// `src/agui/actions/agent-search.ts`, which is NOT under `src/routes/` and
// therefore outside the reach of a `src/routes/`-scoped grep AND of a hand-kept
// `ROUTE_CASES` array. A test that enumerates only the routes cannot fail when a
// caller appears somewhere else, which is the one thing the warning asks for.
//
// So this file re-scopes the census to ALL of `backend/src/` and makes it
// mechanical: every file that CALLS the filter must either publish
// `projectScopeHeaders`, or appear below with a written justification AND a
// pattern proving the alternative disclosure is still in that file. A bare
// exemption list would be a licence not to look.
//
// ⚠️ Deliberately a UNIT test, not an addition to the integration file: this is
// static analysis of the source tree and must run even when Postgres is not
// reachable. The integration file's DB-gated bodies cannot carry a check whose
// whole value is that it runs on every commit.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

const SRC = `${import.meta.dir}/../../../../src`;

/**
 * Strip comments before matching, or the census reports PROSE as a caller.
 * `effective-query.ts` and several AG-UI actions name `applyEffectiveFilter(...)`
 * with parentheses inside explanatory comments; counting those would produce
 * false unheadered callers, and a false red is what teaches people to widen an
 * exemption list until it means nothing.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function callsTheFilter(src: string): boolean {
  return /\bapplyEffectiveFilter\s*\(/.test(stripComments(src));
}

interface Exemption {
  /** Path relative to `src/`. */
  file: string;
  /** Why a header is the wrong instrument HERE. */
  why: string;
  /**
   * Proof the alternative disclosure still exists in that file. The exemption is
   * only as alive as this pattern — delete the disclosure and the exemption stops
   * holding, which is the difference between an exemption and a blind spot.
   */
  requires: RegExp;
}

const EXEMPT: readonly Exemption[] = [
  {
    file: 'routes/assets/_lib/system-union.ts',
    why:
      'The SHARED helper, not a surface. It holds the filter call on behalf of ' +
      'requirements, decisions and principles — which is exactly why a ' +
      'grep for `applyEffectiveFilter` under src/routes/ under-counts the nine route ' +
      'callers by three. It emits no response of its own, so it cannot emit a header; ' +
      'the obligation belongs to its three consumers and is verified against them ' +
      'below rather than waived.',
    requires: /export async function listWithSystemUnion/,
  },
  {
    file: 'agui/actions/agent-search.ts',
    why:
      'The ELEVENTH caller, and not an HTTP envelope: the AG-UI action layer answers ' +
      'events, not `{data}` + headers, so `X-Project-Resolved` has no wire to travel ' +
      'on. It discharges the same obligation IN THE BODY via `project_scope: ' +
      '{project_id, resolution}` (see its outputSchema; the suite that pinned all ' +
      'three resolution states was deleted 2026-10-29). Its projectId is session/auth-derived rather than a ' +
      'caller-supplied query param.',
    requires: /project_scope/,
  },
];

/**
 * The three routes that reach the filter THROUGH `system-union.ts`. They are the
 * discharge of that file's exemption, so they are checked, not assumed.
 */
const SYSTEM_UNION_CONSUMERS = [
  'routes/assets/requirements.ts',
  'routes/assets/decisions.ts',
  'routes/assets/principles.ts',
] as const;

const sources = new Map<string, string>();
const callers: string[] = [];
for await (const rel of new Glob('**/*.ts').scan({ cwd: SRC })) {
  const text = await Bun.file(`${SRC}/${rel}`).text();
  sources.set(rel, text);
  if (callsTheFilter(text)) callers.push(rel);
}
callers.sort();

describe('every applyEffectiveFilter caller under src/ discloses its project scope', () => {
  test('the scanner discriminates — controls before conclusions', () => {
    // A census that matched nothing would pass every assertion below. These are
    // the controls that make the empty-offence result mean something.
    expect(sources.size).toBeGreaterThan(0);

    // POSITIVE: a known direct caller is found.
    expect(callers).toContain('routes/assets/channels.ts');
    // POSITIVE: the out-of-routes caller this census exists for is found — a
    // src/routes/-scoped instrument returns everything else and misses only this.
    expect(callers).toContain('agui/actions/agent-search.ts');

    // NEGATIVE: the DEFINITION is not a caller (it declares
    // `applyEffectiveFilter<T …>(`, and a sloppier pattern would count it).
    expect(callers).not.toContain('routes/assets/_lib/effective-query.ts');
    // NEGATIVE: `toc.ts` reads `?project_id=` but hands it to `getTocConfig`,
    // never to the filter, and returns a config object — no empty set to explain.
    expect(callers).not.toContain('routes/assets/toc.ts');

    // The comment-stripper itself, both directions, on fixtures rather than on
    // today's tree — there is no prose-only mention with parens in src/ right now,
    // so the tree cannot control this and a fixture must.
    expect(callsTheFilter('// see applyEffectiveFilter(workspaceId, assetType)\n')).toBe(
      false,
    );
    expect(callsTheFilter('/* applyEffectiveFilter(a, b) */\nconst x = 1;\n')).toBe(false);
    expect(callsTheFilter('const rows = await applyEffectiveFilter(a, b, c);')).toBe(true);
  });

  test('no caller is silent: header, or a justified exemption that still holds', () => {
    const offences: string[] = [];
    for (const file of callers) {
      const code = stripComments(sources.get(file)!);
      const headered = /projectScopeHeaders/.test(code);
      const exemption = EXEMPT.find((e) => e.file === file);

      if (headered) {
        // A headered file must NOT also be exempt, or the list rots into a set of
        // waivers nobody re-reads.
        if (exemption) offences.push(`${file} (STALE EXEMPTION: it now emits the header)`);
        continue;
      }
      if (!exemption) {
        offences.push(`${file} (no projectScopeHeaders and no exemption)`);
        continue;
      }
      // ⛔ THE MUTATION THIS FILE EXISTS TO KILL: remove the `agent-search.ts`
      // entry from EXEMPT and this reddens, naming the file. It also reddens if
      // agent-search keeps the exemption but loses `project_scope` — the
      // disclosure, not the paperwork, is what earns the waiver.
      if (!exemption.requires.test(sources.get(file)!)) {
        offences.push(`${file} (exempt, but its stated disclosure is GONE)`);
      }
      expect(exemption.why.length).toBeGreaterThan(40);
    }
    expect(offences).toEqual([]);
  });

  test('every route-level guard discriminates on `=== undefined`, never on truthiness', () => {
    // ⛔ WHY A SOURCE-SHAPE ASSERTION AND NOT A BEHAVIOURAL ONE. Section 4b of
    // the project-scope-headers integration suite (deleted 2026-10-29) pinned the ORDERING of this guard on
    // `principles`, because its upstream is a fetch recorder and "the refusal
    // happened before any upstream read" is therefore observable. MEASURED: the
    // same mutation on `channels` (`projectId === undefined ?` → `!projectId ?`)
    // leaves that whole integration file GREEN — the seam one layer down throws the
    // identical BadRequestError, and the three DB-backed routes (channels,
    // triggers, workflows) have no recorder to expose which layer refused.
    //
    // So the discriminator itself is asserted structurally, across all nine callers
    // at once. `!projectId` is the ORIGINAL defect of this whole change: it makes a
    // present-but-empty `?project_id=` mean "do not scope", i.e. the entire
    // workspace, where `=== undefined` sends it to the UUID check and a loud 400.
    const guards: string[] = [];
    for (const [file, text] of sources) {
      if (/\bawait projectExists\s*\(/.test(stripComments(text))) guards.push(file);
    }
    guards.sort();

    // CONTROL: the census found the family, not a subset of one. The named
    // routes below are the control; no count of the family is pinned (a new
    // route using projectExists must not red this test).
    expect(guards).toContain('routes/assets/_lib/effective-query.ts');
    expect(guards).toContain('routes/assets/channels.ts');
    expect(guards).toContain('routes/assets/requirements.ts');

    const offenders: string[] = [];
    for (const file of guards) {
      // The seam is not a route and has no `projectResolved` to compute; its own
      // `projectId === undefined` check is pinned behaviourally by section 4a of
      // the integration file, which calls it directly with `''`.
      if (file === 'routes/assets/_lib/effective-query.ts') continue;
      const flat = stripComments(sources.get(file)!).replace(/\s+/g, ' ');
      if (
        !flat.includes(
          'projectId === undefined ? undefined : await projectExists(projectId)',
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);

    // CONTROL on the matcher, both directions — otherwise `offenders === []` is
    // equally consistent with a pattern that can never match anything.
    const flatten = (s: string) => stripComments(s).replace(/\s+/g, ' ');
    expect(
      flatten('const projectResolved =\n  !projectId ? undefined : await projectExists(projectId);'),
    ).not.toContain('projectId === undefined ? undefined : await projectExists(projectId)');
    expect(
      flatten(
        'const projectResolved =\n  projectId === undefined ? undefined : await projectExists(projectId);',
      ),
    ).toContain('projectId === undefined ? undefined : await projectExists(projectId)');
  });

  test('system-union.ts is exempt only because its three consumers DO emit the header', () => {
    // The exemption above says the obligation moved to the consumers. That is a
    // claim about three other files, so it is measured here instead of trusted.
    for (const consumer of SYSTEM_UNION_CONSUMERS) {
      const code = sources.get(consumer);
      expect(code, `${consumer} missing from src/ — the census names a dead file`).toBeString();
      const stripped = stripComments(code!);
      expect(stripped, consumer).toContain('listWithSystemUnion');
      expect(stripped, consumer).toContain('projectScopeHeaders');
    }
  });
});
