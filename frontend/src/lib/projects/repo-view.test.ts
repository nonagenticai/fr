// src/lib/projects/repo-view.test.ts
//
// The reader three pages now share. Before this module existed the SAME
// predicate was written three times — `/projects`, `/projects/[id]/settings` and
// `/admin/assets/projects` — and the copies had already drifted: the card fell
// back to `rows[0]` as the primary where settings refused to name one at all.
// Three copies are free to drift and the drift is invisible, because each page
// goes on looking locally correct. These are the assertions that hold the single
// copy to its contract.
//
// ⛔ THE STATE THAT MATTERS IS `unknown`. `repositories` is a NEW field, so a
// bundle can meet a backend that does not send it, and collapsing `unknown` into
// `none` renders an upstream gap as a confident "no repositories attached" — this
// codebase's standing defect class (fr#1259), an absence rendered as a result.
//
// ⚠️ These are UNIT assertions on the reader, and they do NOT replace mounted
// route tests. The original
// defect lived in markup that printed one scalar while the array was already on
// the wire, so a test at this level cannot fail while a template ignores the
// answer. Both levels are load-bearing; neither substitutes for the other.

import { describe, expect, test } from 'vitest';
import { readProjectRepoView, repoLabelFromUrl } from './repo-view';

const PRIMARY = 'https://github.com/acme/fr';
const SECOND = 'https://github.com/acme/kag';
const THIRD = 'https://github.com/acme/platform';

/** Three attached repositories, primary FIRST as the backend sends them. */
const THREE_REPOS = [
  { repo_id: 'r-1', url: PRIMARY, branch: 'main', name: 'acme/fr', is_primary: true },
  { repo_id: 'r-2', url: SECOND, branch: 'develop', name: 'acme/kag', is_primary: false },
  { repo_id: 'r-3', url: THIRD, branch: 'main', name: 'acme/platform', is_primary: false },
];

describe('readProjectRepoView — listed', () => {
  test('rows arrived: every one is carried, ordered primary-first', () => {
    // MUTATION: return only the primary row (drop `rows` / `others`) — the
    // pre-fix reading, where a three-repo project was indistinguishable from one.
    const view = readProjectRepoView({ repositories: THREE_REPOS, repo_count: 3 });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.rows.map((r) => r.url)).toEqual([PRIMARY, SECOND, THIRD]);
    expect(view.primary?.url).toBe(PRIMARY);
    expect(view.others.map((r) => r.url)).toEqual([SECOND, THIRD]);
    expect(view.total).toBe(3);
    expect(view.countOutrunsRows).toBe(false);
  });

  test('`is_primary` is the authority, not payload position', () => {
    // MUTATION: `const primary = ordered[0]` without the flag check, or drop the
    // sort — which names whichever row the payload happened to send first.
    const view = readProjectRepoView({
      repositories: [
        { ...THREE_REPOS[0], is_primary: false },
        { ...THREE_REPOS[1], is_primary: true },
        THREE_REPOS[2],
      ],
      repo_count: 3,
    });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.primary?.url).toBe(SECOND);
    expect(view.rows[0].url).toBe(SECOND);
    // The non-primary rows keep the order they arrived in — a stable sort, so a
    // caller rendering `others` does not reshuffle the list on every read.
    expect(view.others.map((r) => r.url)).toEqual([PRIMARY, THIRD]);
  });

  test('NO ROW CLAIMS PRIMARY: `primary` is null rather than a guess', () => {
    // MUTATION: `primary = ordered[0]` as a fallback — exactly the divergence the
    // /projects card carried while /settings refused it. 0..N rows with EXACTLY
    // ONE primary is the backend's invariant; a broken invariant must be visible.
    const view = readProjectRepoView({
      repositories: THREE_REPOS.map((r) => ({ ...r, is_primary: false })),
      repo_count: 3,
    });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.primary).toBeNull();
    // The rows are still all there: refusing to name a primary is not refusing
    // to show the set.
    expect(view.rows).toHaveLength(3);
  });

  test('COUNT OUTRUNS THE ROWS: the shortfall is disclosed, not clamped away', () => {
    // MUTATION: `total = rows.length`, so a server that counts 5 and names 3
    // hands the caller a list that reads as complete.
    const view = readProjectRepoView({ repositories: THREE_REPOS, repo_count: 5 });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.total).toBe(5);
    expect(view.rows).toHaveLength(3);
    expect(view.countOutrunsRows).toBe(true);
  });

  test('A STALE COUNT MUST NOT HIDE A ROW: total is never below the rows', () => {
    // MUTATION: `total = counted ?? rows.length` — a `repo_count` of 1 beside 3
    // rows would then claim one repository while three were handed over.
    const view = readProjectRepoView({ repositories: THREE_REPOS, repo_count: 1 });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.total).toBe(3);
    expect(view.countOutrunsRows).toBe(false);
  });

  test('an unreadable entry beside readable ones shrinks what is NAMED, not the total', () => {
    // MUTATION: drop `raw.length` from the `total` maximum — the unusable entry
    // then vanishes from both the rows and the count, so nothing discloses it.
    const view = readProjectRepoView({ repositories: [THREE_REPOS[0], { branch: 'main' }] });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.rows).toHaveLength(1);
    expect(view.total).toBe(2);
    expect(view.countOutrunsRows).toBe(true);
  });
});

describe('readProjectRepoView — none', () => {
  test('an EMPTY array with a zero count is the only thing that means none', () => {
    // MUTATION: return `{kind:'unknown'}` here too — every caller would then say
    // "not reported" for a project that genuinely has nothing attached, which
    // makes the honest answer unreachable and the disclosure worthless.
    expect(readProjectRepoView({ repositories: [], repo_count: 0 })).toEqual({ kind: 'none' });
  });

  test('an EMPTY array with no count at all is still none', () => {
    // MUTATION: require `repo_count === 0` before answering `none`, which turns
    // the ordinary no-repositories response into an unknown.
    expect(readProjectRepoView({ repositories: [] })).toEqual({ kind: 'none' });
  });
});

describe('readProjectRepoView — unknown', () => {
  test('THE FIELD IS ABSENT: unknown/unreported, never none', () => {
    // MUTATION: `if (!Array.isArray(raw)) return { kind: 'none' }` — fr#1259's
    // class one field down, an absence rendered as a result.
    expect(readProjectRepoView({ id: 'p-1', repository_url: PRIMARY })).toEqual({
      kind: 'unknown',
      reason: 'unreported',
      declaredCount: null,
    });
  });

  test('a non-array `repositories` is unknown, not none', () => {
    // MUTATION: coerce a non-array to `[]` before the empty check, which routes
    // a malformed payload straight into "no repositories attached".
    for (const bad of [null, 'two', 3, {}, undefined]) {
      expect(readProjectRepoView({ repositories: bad }).kind).toBe('unknown');
    }
  });

  test('a null / undefined project is unknown, not none', () => {
    // MUTATION: return `{kind:'none'}` for a missing project — the settings page
    // reads this while its load is still in flight, and would flash a false
    // "no repositories attached" before the payload arrives.
    expect(readProjectRepoView(null).kind).toBe('unknown');
    expect(readProjectRepoView(undefined).kind).toBe('unknown');
  });

  test('A COUNT WITHOUT THE ROWS is unknown but carries the declared number', () => {
    // MUTATION: drop `declaredCount` (or set it to null here) — the admin table
    // reads it to print "4 repositories" for a backend that counts without
    // enumerating, and would fall back to "not reported" with a real number in
    // hand.
    expect(readProjectRepoView({ repo_count: 4 })).toEqual({
      kind: 'unknown',
      reason: 'unreported',
      declaredCount: 4,
    });
  });

  test('AN EMPTY ARRAY BESIDE A POSITIVE COUNT is a contradiction, not a zero', () => {
    // MUTATION: `if (rows.length === 0) return { kind: 'none' }` ignoring the
    // count — a half-populated response then reads as a confident "nothing
    // attached".
    expect(readProjectRepoView({ repositories: [], repo_count: 3 })).toEqual({
      kind: 'unknown',
      reason: 'contradiction',
      declaredCount: 3,
    });
  });

  test('an array whose every entry is unreadable is a contradiction, not a zero', () => {
    // MUTATION: drop the `raw.length > 0` check — our own parse failure would
    // then be published as the server's answer, "no repositories attached".
    const view = readProjectRepoView({ repositories: [{ branch: 'main' }, null, 'x'] });
    expect(view).toEqual({ kind: 'unknown', reason: 'contradiction', declaredCount: null });
  });

  test('the two unknown reasons are DISTINGUISHABLE, and the admin table needs that', () => {
    // MUTATION: collapse `reason` to a single value. `unreported` + a count is a
    // number the server stated; `contradiction` + a count is a number the server
    // contradicted. The admin column prints the first and refuses the second, so
    // one shared reason makes it either mute or credulous.
    const unreported = readProjectRepoView({ repo_count: 3 });
    const contradiction = readProjectRepoView({ repositories: [], repo_count: 3 });

    expect(unreported.kind).toBe('unknown');
    expect(contradiction.kind).toBe('unknown');
    if (unreported.kind !== 'unknown' || contradiction.kind !== 'unknown') return;
    expect(unreported.reason).not.toBe(contradiction.reason);
    expect(unreported.declaredCount).toBe(3);
    expect(contradiction.declaredCount).toBe(3);
  });
});

describe('readProjectRepoView — row parsing', () => {
  test('a row keyed only by `url` keeps its identity; missing fields stay null', () => {
    // MUTATION: require `repo_id`, which silently drops rows a caller could still
    // key and link, shrinking the list without saying so.
    const view = readProjectRepoView({ repositories: [{ url: PRIMARY }] });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.rows[0]).toEqual({
      repo_id: PRIMARY,
      url: PRIMARY,
      branch: null,
      name: null,
      is_primary: false,
    });
  });

  test('`is_primary` is only true for the boolean true, never for a truthy value', () => {
    // MUTATION: `is_primary: !!o.is_primary` — a string `"false"` from a loose
    // serialiser is truthy, so the wrong row would be badged primary.
    const view = readProjectRepoView({
      repositories: [{ repo_id: 'r-1', url: PRIMARY, is_primary: 'false' }],
    });

    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.rows[0].is_primary).toBe(false);
    expect(view.primary).toBeNull();
  });

  test('a non-finite `repo_count` is treated as absent, never as 0', () => {
    // MUTATION: `Number(declared) || 0` — NaN becomes 0, which turns an
    // unparseable count into an explicit "none" the server never sent.
    expect(readProjectRepoView({ repositories: [], repo_count: Number.NaN }).kind).toBe('none');
    const view = readProjectRepoView({ repositories: THREE_REPOS, repo_count: 'many' });
    expect(view.kind).toBe('listed');
    if (view.kind !== 'listed') return;
    expect(view.total).toBe(3);
  });
});

// UI review 2026-10-07: shared repository rows carried another project's name,
// so the label is derived from the URL and the stored name is only a fallback.
describe('repoLabelFromUrl', () => {
  test.each([
    ['https://github.com/acme/fr', 'acme/fr'],
    ['https://github.com/acme/fr.git', 'acme/fr'],
    ['https://github.com/acme/fr/', 'acme/fr'],
    ['git@github.com:acme/kag.git', 'acme/kag'],
    ['git@github.com:acme/kag', 'acme/kag'],
    ['ssh://git@github.com/acme/platform.git', 'acme/platform'],
  ])('%s → %s', (url, expected) => {
    expect(repoLabelFromUrl(url, 'Some Other Project')).toBe(expected);
  });

  test('the URL wins over a stored name that belongs to another project', () => {
    expect(repoLabelFromUrl('https://github.com/o/r', 'Project B')).toBe('o/r');
  });

  test('falls back to the stored name when the URL has no owner/repo', () => {
    expect(repoLabelFromUrl('https://github.com/', 'my-repo')).toBe('my-repo');
    expect(repoLabelFromUrl('not a url', 'my-repo')).toBe('my-repo');
  });

  test('falls back to the raw URL when there is no stored name', () => {
    expect(repoLabelFromUrl('not a url', null)).toBe('not a url');
    expect(repoLabelFromUrl('/local/path-only', '  ')).toBe('/local/path-only');
  });

  test('empty input yields an empty label, not a crash', () => {
    expect(repoLabelFromUrl(undefined)).toBe('');
    expect(repoLabelFromUrl('', null)).toBe('');
  });
});
