// tests/unit/services/outline-constraint-scan.test.ts
//
// The outline contradiction detector. Pure, no database — the module is a pure
// function precisely so this suite drives the REAL logic rather than a mock of
// it.
//
// ⭐ THE TWO ASSERTIONS THAT MATTER, and why both are here:
//   1. A VIOLATING FIXTURE is flagged.
//   2. A PASSING CONTROL — an outline that restates the same constraint as a
//      promise to obey it — is NOT flagged.
// (1) alone is passed by a detector that returns a finding for every input.
// (2) alone is passed by a detector that returns nothing, ever. Only the pair
//     can fail, which is the whole point.

import { describe, test, expect } from 'bun:test';
import {
  scanOutlineForContradictions,
  renderContradictionsForApproval,
  outlineSegments,
  OUTLINE_SCANNABLE_KINDS,
  APPROVAL_NOTICE_CAP,
  type ScannableOutline,
} from '../../../src/services/outline-constraint-scan';
import { CHECKABLE_KINDS } from '../../../src/types/project-constraints';

const NO_NEW_DEPS = [{ kind: 'no_new_dependencies' as const }];

/** The violating fixture: an outline that says it will add a dependency. */
const VIOLATING: ScannableOutline = {
  summary: 'Replace the hand-rolled cache with a maintained one.',
  deliverables: [
    {
      kind: 'artifact',
      title: 'Cache layer',
      description:
        'Add a new dependency on ioredis and route all reads through it. The old module is deleted.',
      acceptance_criteria: ['Cache hit ratio above 90%'],
    },
  ],
  intermediate_deliverables: [],
  milestones: [{ name: 'Cache layer landed' }],
};

/**
 * The passing control: SAME request, SAME constraint, a compliant outline —
 * and deliberately one that MENTIONS dependencies, so it exercises the same
 * code path as the fixture instead of trivially avoiding every keyword.
 */
const COMPLIANT: ScannableOutline = {
  summary: 'Replace the hand-rolled cache with a maintained one.',
  deliverables: [
    {
      kind: 'artifact',
      title: 'Cache layer',
      description:
        'Rewrite the cache on the standard library only. No new dependencies are added; the existing dependency set is untouched.',
      acceptance_criteria: ['Cache hit ratio above 90%'],
    },
  ],
  intermediate_deliverables: [],
  milestones: [{ name: 'Cache layer landed' }],
};

describe('the violating fixture and its control', () => {
  test('VIOLATING: an outline that says it adds a dependency IS flagged', () => {
    const r = scanOutlineForContradictions(NO_NEW_DEPS, VIOLATING);
    expect(r.contradictions.length).toBeGreaterThan(0);
    expect(r.contradictions.map((c) => c.kind)).toContain('no_new_dependencies');
    // The finding must LOCATE itself, or a human cannot act on it.
    expect(r.contradictions[0]!.where).toBe('deliverables[0].description');
    expect(r.contradictions[0]!.quote).toContain('ioredis');
  });

  test('CONTROL: a compliant outline under the SAME constraint is NOT flagged', () => {
    const r = scanOutlineForContradictions(NO_NEW_DEPS, COMPLIANT);
    expect(r.contradictions).toEqual([]);
  });

  test('CONTROL: the violating outline with NO constraints set is NOT flagged', () => {
    // Pins that the finding comes from the constraint, not from the prose alone.
    expect(scanOutlineForContradictions([], VIOLATING).contradictions).toEqual([]);
    expect(scanOutlineForContradictions(undefined, VIOLATING).contradictions).toEqual([]);
  });

  test('the render is empty for the control and non-empty for the fixture', () => {
    expect(renderContradictionsForApproval(scanOutlineForContradictions(NO_NEW_DEPS, COMPLIANT))).toBeNull();
    const text = renderContradictionsForApproval(
      scanOutlineForContradictions(NO_NEW_DEPS, VIOLATING),
    );
    expect(text).toContain('CONSTRAINT CONTRADICTIONS');
    expect(text).toContain('ioredis');
    // ⛔ It must NEVER print an AFFIRMATIVE clean bill of health. Note the
    // block DOES contain the word "complies" — inside the disclaimer that an
    // absence of findings would not have meant compliance. That sentence is
    // required, so this asserts on the overclaim shapes, not on a keyword.
    expect(text).not.toMatch(/no contradictions|✅|constraints? (?:are )?(?:met|satisfied)|outline complies with/i);
    expect(text).toContain('would NOT have meant the outline complies');
  });
});

describe('per-kind detection, each with its own control', () => {
  const outlineWith = (description: string): ScannableOutline => ({
    deliverables: [{ kind: 'artifact', title: 'T', description, acceptance_criteria: [] }],
  });

  test('no_dependency_upgrades: bumping a package fires; pinning it does not', () => {
    const c = [{ kind: 'no_dependency_upgrades' as const }];
    expect(
      scanOutlineForContradictions(c, outlineWith('Bump the express package to v5.')).contradictions,
    ).not.toEqual([]);
    expect(
      scanOutlineForContradictions(c, outlineWith('No packages are upgraded; versions stay as they are.')).contradictions,
    ).toEqual([]);
  });

  test('no_language_version_change: a named migration fires; staying put does not', () => {
    const c = [{ kind: 'no_language_version_change' as const }];
    expect(
      scanOutlineForContradictions(c, outlineWith('Migrate the service to Python 3.13.')).contradictions,
    ).not.toEqual([]);
    expect(
      scanOutlineForContradictions(c, outlineWith('The service stays on Python 3.11 throughout.')).contradictions,
    ).toEqual([]);
  });

  test('pin_language_version: a DIFFERENT version fires, the PINNED one does not', () => {
    const c = [{ kind: 'pin_language_version' as const, language: 'python', version: '3.11' }];
    const bad = scanOutlineForContradictions(c, outlineWith('Ship on Python 3.13.'));
    expect(bad.contradictions).not.toEqual([]);
    expect(bad.contradictions[0]!.detail).toContain('3.11');
    // The pinned version, and a patch release of it, both satisfy the pin.
    expect(scanOutlineForContradictions(c, outlineWith('Ship on Python 3.11.')).contradictions).toEqual([]);
    expect(scanOutlineForContradictions(c, outlineWith('Ship on Python 3.11.9.')).contradictions).toEqual([]);
    // A DIFFERENT language at a different version is not this pin's business.
    expect(scanOutlineForContradictions(c, outlineWith('Ship on Node 22.')).contradictions).toEqual([]);
  });

  test('no_files_touched: naming a forbidden path fires; naming a permitted one does not', () => {
    const c = [{ kind: 'no_files_touched' as const, globs: ['src/legacy/**'] }];
    expect(
      scanOutlineForContradictions(c, outlineWith('Refactor src/legacy/parser.ts into the new module.')).contradictions,
    ).not.toEqual([]);
    expect(
      scanOutlineForContradictions(c, outlineWith('Refactor src/modern/parser.ts into the new module.')).contradictions,
    ).toEqual([]);
    // A URL that happens to contain the glob's tail must not fire.
    expect(
      scanOutlineForContradictions(c, outlineWith('See https://example.com/src/legacy/parser.ts for background.')).contradictions,
    ).toEqual([]);
  });
});

describe('honesty about what it cannot evaluate', () => {
  test('must_keep_api_compatible and custom are reported unevaluable, never as a pass', () => {
    const r = scanOutlineForContradictions(
      [{ kind: 'must_keep_api_compatible' }, { kind: 'custom', text: 'keep it tidy' }],
      VIOLATING,
    );
    expect(r.contradictions).toEqual([]);
    expect(r.unevaluable.sort()).toEqual(['custom', 'must_keep_api_compatible']);
  });

  test('legacy free-text constraints are reported unevaluable', () => {
    const r = scanOutlineForContradictions(['do not upgrade python'], VIOLATING);
    expect(r.unevaluable).toContain('legacy_text');
    expect(r.contradictions).toEqual([]);
  });

  // ⛔ THIS TEST USED TO BE THE HOLE. It asserted `contradictions == []` and
  // NOTHING ELSE, so it passed while `partitionConstraints`'s third bucket was
  // destructured away and the constraint vanished from the result entirely. An
  // assertion that only checks the bucket a defect does not touch is a test that
  // cannot fail. Both halves of the result are now inspected, and the outcome
  // for a malformed row is stated positively rather than by omission.
  test('a malformed constraint does not throw, fabricates no finding, and DOES NOT VANISH', () => {
    const r = scanOutlineForContradictions([{ kind: 'pin_language_version' }, 42, null], VIOLATING);
    expect(r.contradictions).toEqual([]);
    // The requester DID set an enforced rule; it must be reported, not dropped.
    expect(r.malformed).toEqual(['pin_language_version']);
    expect(r.unevaluable).toContain('pin_language_version (malformed)');
    // And it must reach the human even with zero contradictions, because
    // constraint-check.ts:1254 counts the identical row as a violation later.
    const text = renderContradictionsForApproval(r);
    expect(text).not.toBeNull();
    expect(text).toContain('pin_language_version');
    expect(text).toContain('COULD NOT BE READ');
    // Still never a reassurance.
    expect(text).not.toMatch(/no contradictions|✅|constraints? (?:are )?(?:met|satisfied)|outline complies with/i);
  });

  test('no_files_touched with missing or empty globs is malformed, not silence', () => {
    // The exact shape that disappeared: `constraint-check.ts` treats both as a
    // violation, so neither may produce an all-empty result here.
    for (const bad of [{ kind: 'no_files_touched' }, { kind: 'no_files_touched', globs: [] }]) {
      const r = scanOutlineForContradictions([bad], VIOLATING);
      expect(r.contradictions).toEqual([]);
      expect(r.malformed).toEqual(['no_files_touched']);
      expect(renderContradictionsForApproval(r)).not.toBeNull();
    }
  });

  test('a WELL-FORMED constraint set reports no malformed kinds', () => {
    // The negative control: without it the two assertions above are passed by a
    // scan that calls everything malformed.
    expect(scanOutlineForContradictions(NO_NEW_DEPS, VIOLATING).malformed).toEqual([]);
    expect(
      scanOutlineForContradictions([{ kind: 'no_files_touched', globs: ['src/**'] }], VIOLATING)
        .malformed,
    ).toEqual([]);
  });

  test('a scannable kind list that drifts from CHECKABLE_KINDS cannot silently overclaim', () => {
    // Every kind this scan claims must be a real checkable kind.
    for (const k of OUTLINE_SCANNABLE_KINDS) {
      expect(CHECKABLE_KINDS as readonly string[]).toContain(k);
    }
    // A checkable kind with no rule here must land in `unevaluable`. If someone
    // adds a kind to CHECKABLE_KINDS and forgets this file, this fails.
    for (const k of CHECKABLE_KINDS) {
      if ((OUTLINE_SCANNABLE_KINDS as readonly string[]).includes(k)) continue;
      const params =
        k === 'no_files_touched'
          ? { kind: k, globs: ['x'] }
          : k === 'pin_language_version'
            ? { kind: k, language: 'python', version: '3.11' }
            : { kind: k };
      expect(scanOutlineForContradictions([params], VIOLATING).unevaluable).toContain(k);
    }
  });
});

describe('the prose harvest is exhaustive', () => {
  test('every authored string field of an outline is collected', () => {
    const wheres = outlineSegments({
      summary: 's',
      deliverables: [{ kind: 'k', title: 't', description: 'd', acceptance_criteria: ['a'] }],
      intermediate_deliverables: [{ kind: 'k', title: 't2', description: 'd2', acceptance_criteria: ['a2'] }],
      milestones: [{ name: 'm' }],
    }).map((s) => s.where);
    expect(wheres).toEqual([
      'summary',
      'deliverables[0].title',
      'deliverables[0].description',
      'deliverables[0].acceptance_criteria[0]',
      'intermediate_deliverables[0].title',
      'intermediate_deliverables[0].description',
      'intermediate_deliverables[0].acceptance_criteria[0]',
      'milestones[0].name',
    ]);
  });

  test('a violation hiding in an acceptance criterion is still found', () => {
    const r = scanOutlineForContradictions(NO_NEW_DEPS, {
      deliverables: [
        { kind: 'artifact', title: 'T', acceptance_criteria: ['pip install redis succeeds'] },
      ],
    });
    expect(r.contradictions[0]!.where).toBe('deliverables[0].acceptance_criteria[0]');
  });

  test('an empty or junk outline yields nothing and does not throw', () => {
    expect(scanOutlineForContradictions(NO_NEW_DEPS, null).contradictions).toEqual([]);
    expect(scanOutlineForContradictions(NO_NEW_DEPS, {}).contradictions).toEqual([]);
    expect(
      scanOutlineForContradictions(NO_NEW_DEPS, { deliverables: 'not an array' } as never).contradictions,
    ).toEqual([]);
  });
});

// ─── the five measured false positives ───────────────────────────────────────
//
// All five were CONSTRUCTED AND REPRODUCED against the real module on
// 2026-09-24. Four are now suppressed; ONE IS DELIBERATELY KEPT and its test
// pins the kept behaviour together with the disclosure that makes it honest —
// because a false positive nobody is warned about is the defect, not the match.
//
// ⚠️ EVERY CASE HERE CARRIES ITS TRUE POSITIVE. Each suppression is one regex
// away from deleting a real detection, and a suppression test on its own is
// passed by a detector that has been switched off.
describe('measured false positives, each paired with the detection it must not eat', () => {
  const outlineWith = (description: string): ScannableOutline => ({
    deliverables: [{ kind: 'artifact', title: 'T', description, acceptance_criteria: [] }],
  });
  const fires = (c: unknown, text: string) =>
    scanOutlineForContradictions(c, outlineWith(text)).contradictions.length > 0;

  test('FIXED 1/5 — a DOCUMENT version is not a dependency upgrade', () => {
    const c = [{ kind: 'no_dependency_upgrades' as const }];
    expect(fires(c, 'Update the onboarding guide to 2.0 of the internal process handbook.')).toBe(false);
    expect(fires(c, 'Update the API docs to version 3.')).toBe(false);
    // TRUE POSITIVES the fix must not eat — the same shape with a real package.
    expect(fires(c, 'Update axios to 2.0 across the service.')).toBe(true);
    expect(fires(c, 'Bump express to v5.')).toBe(true);
    expect(fires(c, 'Upgrade the redis client to version 5.')).toBe(true);
    // ⚠️ MEASURED, and PRE-EXISTING, not caused by the document-version fix:
    // "Move the redis client to version 5." does NOT fire, because `move` was
    // never in this rule's verb list (only the LANGUAGE rule has it). Pinned so
    // the gap is a recorded limit rather than a surprise.
    expect(fires(c, 'Move the redis client to version 5.')).toBe(false);
    // And a sentence that does BOTH still reports the dependency half.
    expect(fires(c, 'Update the guide to 2.0 and bump express to 5.')).toBe(true);
  });

  test('FIXED 2/5 — `Node.js` is a product name, not a path matching *.js', () => {
    const c = [{ kind: 'no_files_touched' as const, globs: ['*.js'] }];
    expect(fires(c, 'Port the Node.js service to TypeScript.')).toBe(false);
    expect(fires(c, 'The Next.js frontend is out of scope.')).toBe(false);
    // TRUE POSITIVES: real .js files, including one under a directory.
    expect(fires(c, 'Rewrite loader.js in place.')).toBe(true);
    expect(
      scanOutlineForContradictions(
        [{ kind: 'no_files_touched' as const, globs: ['packages/**'] }],
        outlineWith('Edit packages/node.js/index.js to add the shim.'),
      ).contradictions.length,
    ).toBeGreaterThan(0);
  });

  test('KEPT 3/5 — a negated pin mismatch still fires, AND SAYS IT MAY BE WRONG', () => {
    const c = [{ kind: 'pin_language_version' as const, language: 'python', version: '3.11' }];
    const r = scanOutlineForContradictions(c, outlineWith('We will NOT migrate to Python 3.13.'));
    // KEPT ON PURPOSE: suppressing on negation would delete the detection this
    // rule exists for — a real pin breach is commonly written "we will not stay
    // on 3.11". The honesty is in the disclosure, not in silence.
    expect(r.contradictions.length).toBeGreaterThan(0);
    expect(r.contradictions[0]!.detail).toContain('SENTENCE IS NEGATED');
    expect(r.contradictions[0]!.detail).toMatch(/may be one the outline is RULING OUT/);
    // The disclosure must be CONDITIONAL, or it is wallpaper: a non-negated
    // mismatch must NOT carry it.
    const plain = scanOutlineForContradictions(c, outlineWith('Ship on Python 3.13.'));
    expect(plain.contradictions[0]!.detail).not.toContain('SENTENCE IS NEGATED');
    // And the real breach phrased with a negation is exactly what stays caught —
    // this is the sentence the module's own comment cites as the reason for the
    // skip, so it is pinned here rather than asserted in prose.
    expect(fires(c, 'We will NOT stay on Python 3.11, we move to Python 3.13.')).toBe(true);
    // ⚠️ MEASURED LIMIT of that justification: the skip only rescues the breach
    // when the NEW version is named beside its language inside the SAME window.
    // Across a `;` (a window boundary) with a bare number, nothing fires — so the
    // kept false positive buys less than the comment implies. Pinned, not hidden.
    expect(fires(c, 'We will not stay on Python 3.11; the service moves to 3.13.')).toBe(false);
  });

  test('FIXED 4/5 — a command quoted in order to FORBID it is not an intent', () => {
    const c = [{ kind: 'no_new_dependencies' as const }];
    expect(fires(c, 'Add a CI guard that fails if `npm install express` appears in any workflow.')).toBe(false);
    expect(fires(c, 'The linter rejects `pip install requests` in every recipe.')).toBe(false);
    // TRUE POSITIVE: the same command in an INLINE span as a real intent.
    // ⛔ Inline code is deliberately still scanned — "Run `npm install x`" is how
    // a real intent is usually written, so stripping it would delete detection.
    expect(fires(c, 'Run `npm install express` to add the router.')).toBe(true);
    expect(fires(c, 'Add a new dependency on ioredis.')).toBe(true);
  });

  test('FIXED 5/5 — a FENCED code block is quoted material, not authored prose', () => {
    const c = [{ kind: 'no_new_dependencies' as const }];
    expect(
      fires(c, 'Document the forbidden command:\n```\nnpm install express\n```\nand explain why.'),
    ).toBe(false);
    // The prose AROUND a fence is still scanned, so a real intent beside a fence
    // is not lost with it.
    expect(
      fires(c, 'Add a new dependency on ioredis.\n```\nsome sample config\n```'),
    ).toBe(true);
  });
});

// ─── three more measured false positives, all firing WITH the uncertainty
// header attached (2026-09-24 audit of fr PR #1193) ──────────────────────────
describe('three more measured false positives, each paired with the detection it must not eat', () => {
  const outlineWith = (description: string): ScannableOutline => ({
    deliverables: [{ kind: 'artifact', title: 'T', description, acceptance_criteria: [] }],
  });
  const fires = (c: unknown, text: string) =>
    scanOutlineForContradictions(c, outlineWith(text)).contradictions.length > 0;

  test('FIXED — "using only the standard library" is not a new dependency', () => {
    const c = [{ kind: 'no_new_dependencies' as const }];
    expect(
      fires(c, 'add a new module to the existing package, using only the standard library'),
    ).toBe(false);
    expect(fires(c, 'This ships with no third-party dependencies.')).toBe(false);
    // TRUE POSITIVE the fix must not eat.
    expect(fires(c, 'Add a new dependency on ioredis.')).toBe(true);
  });

  test('FIXED — a mitigating clause after a `;` suppresses the intent clause beside it', () => {
    const c = [{ kind: 'no_new_dependencies' as const }];
    // ⭐ Row 2 of the audit: the printed quote used to contain its OWN
    // negation ("…might add a dependency; we will reject that in review.")
    // and `suppressed()` did not catch it, because the `;` split the intent
    // clause from the clause that reads it back out of existence.
    expect(
      fires(
        c,
        'The risk is that a contributor might add a dependency; we will reject that in review.',
      ),
    ).toBe(false);
    // TRUE POSITIVE the fix must not eat: the mitigating clause must stay
    // scoped to its OWN sentence, not bleed into an unrelated one.
    expect(
      fires(
        c,
        'No packages are upgraded; versions stay as they are. Add a new dependency on ioredis.',
      ),
    ).toBe(true);
  });

  test('FIXED — reading a file is not touching it under `no_files_touched`', () => {
    const c = [{ kind: 'no_files_touched' as const, globs: ['**/*'] }];
    expect(
      fires(c, 'We will read config/settings.yaml to understand the current layout.'),
    ).toBe(false);
    // TRUE POSITIVES the fix must not eat: an actual edit still fires, even
    // when a read verb is named in the very same sentence.
    expect(fires(c, 'Edit config/settings.yaml to add a new key.')).toBe(true);
    expect(fires(c, 'Read config/settings.yaml, then edit it directly.')).toBe(true);
  });
});

describe('the write is bounded, and the truncation says so', () => {
  test('a huge finding list is capped at the sibling limit and announces the omission', () => {
    // 200 deliverables, each stating several breaches: the measured shape that
    // rendered 233,513 characters into an unpaginated queue row.
    const huge: ScannableOutline = {
      deliverables: Array.from({ length: 200 }, (_, i) => ({
        kind: 'artifact',
        title: `D${i}`,
        description: `Add a new dependency on pkg${i}. Then pull in another library for pkg${i}.`,
        acceptance_criteria: [`pip install pkg${i} succeeds`],
      })),
    };
    const r = scanOutlineForContradictions(NO_NEW_DEPS, huge);
    expect(r.contradictions.length).toBeGreaterThan(400);
    const text = renderContradictionsForApproval(r)!;
    expect(text.length).toBeLessThanOrEqual(APPROVAL_NOTICE_CAP);
    // ⛔ An absence must not render as a result: the count and the cap are named.
    expect(text).toContain('WERE OMITTED');
    expect(text).toContain(String(r.contradictions.length));
    expect(text).toContain('THIS LIST IS INCOMPLETE');
    // Findings are dropped WHOLE — the last kept line is a quote, not a fragment.
    expect(text).not.toMatch(/“[^”]*$/);
  });

  test('a small finding list is NOT truncated and claims no omission', () => {
    // The control: without it the assertions above are passed by a renderer that
    // always announces an omission.
    const text = renderContradictionsForApproval(
      scanOutlineForContradictions(NO_NEW_DEPS, VIOLATING),
    )!;
    expect(text.length).toBeLessThanOrEqual(APPROVAL_NOTICE_CAP);
    expect(text).not.toContain('WERE OMITTED');
    expect(text).toContain('ioredis');
  });
});

describe('a finding is presented as possible, never as established intent', () => {
  test('the rendered block names its own fallibility and asserts no intent', () => {
    const text = renderContradictionsForApproval(
      scanOutlineForContradictions(NO_NEW_DEPS, VIOLATING),
    )!;
    expect(text).toContain('POSSIBLE CONSTRAINT CONTRADICTIONS');
    expect(text).toMatch(/CAN BE WRONG/);
    expect(text).toMatch(/KEYWORD MATCH/);
    expect(text).toContain('NOT a finding of fact');
    // ⛔ And it must not assert what the outline WILL do. The old block opened
    // "This outline SAYS it will do something the request forbids" — a flat
    // assertion, on a line that was wrong for 5 of 5 constructed inputs.
    expect(text).not.toMatch(/This outline SAYS it will/);
    expect(text).not.toMatch(/the outline states an intent/);
    // Still no reassurance, in either direction.
    expect(text).not.toMatch(/no contradictions|✅|constraints? (?:are )?(?:met|satisfied)|outline complies with/i);
  });
});
