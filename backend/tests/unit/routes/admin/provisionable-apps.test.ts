// tests/unit/routes/admin/provisionable-apps.test.ts
//
// The provisioning picker used to offer all 47 registry apps. Only 7 are
// end-user products; the rest are internal platform modules (licences held by
// SERVICES) or n8n custom-node action packages (held by automation).
//
// What that cost, measured in production 2026-08-26: an operator ticked
// `coding`, `n8n` and `observability` for one person because the form offered
// them, and the run aborted 10.8s in on `meta_prompt_core_actions` — an n8n
// action package with ZERO active plans — leaving five already-minted licences
// orphaned, because provisioning is not transactional.
//
// The seven keys used to be a literal here and in the frontend page-helpers,
// pinned together by a drift test. Both copies are GONE: the classification is
// `app.audience` in the licences service (migration 022). The drift test went
// with them — a gate for a constant that no longer exists is dead weight, and
// leaving it would have pinned two files that no longer contain the thing.
//
// These are pure assertions: no DB, no HTTP.

import { test, expect, describe } from 'bun:test';

import {
  selectAppsNotForPeople,
  selectAppsWithoutActivePlan,
} from '../../../../src/routes/admin/super-admin';

describe('selectAppsNotForPeople', () => {
  const catalogue = [
    { key: 'fr', audience: 'human' as const },
    { key: 'commonpractice', audience: 'human' as const },
    { key: 'coding', audience: 'platform' as const },
    { key: 'n8n', audience: 'platform' as const },
    { key: 'observability', audience: 'platform' as const },
    { key: 'meta_prompt_core_actions', audience: 'automation' as const },
  ];

  test('refuses exactly the three platform modules the operator was wrongly offered', () => {
    expect(
      selectAppsNotForPeople(['fr', 'coding', 'n8n', 'observability'], catalogue).sort(),
    ).toEqual(['coding', 'n8n', 'observability']);
  });

  test('refuses n8n action packages — never held by a person', () => {
    expect(selectAppsNotForPeople(['meta_prompt_core_actions'], catalogue)).toEqual([
      'meta_prompt_core_actions',
    ]);
  });

  test('a human-audience request is empty, so the guard never blocks the happy path', () => {
    expect(selectAppsNotForPeople(['fr', 'commonpractice'], catalogue)).toEqual([]);
  });

  test('an UNKNOWN key is left to the engine, not reported here', () => {
    // Catalogue membership is the engine's answer to give (UPSTREAM_NOT_FOUND
    // naming the available keys). Duplicating it here would be a second source
    // of truth for which apps exist.
    expect(selectAppsNotForPeople(['no-such-app'], catalogue)).toEqual([]);
  });

  test('an audience value this code has never heard of is REFUSED, not admitted', () => {
    // Fail closed on the unrecognised. An allowlist of known-bad values would
    // admit anything added to the enum later; testing for `human` refuses it.
    const future = [{ key: 'weird', audience: 'partner' as unknown as undefined }];
    expect(selectAppsNotForPeople(['weird'], future)).toEqual(['weird']);
  });

  test('a row with NO audience is refused rather than admitted by omission', () => {
    // The all-rows-missing case is handled one level up, in preflightApps,
    // which reports a version mismatch instead of blaming the selection. A
    // SINGLE row missing the field is different: the catalogue knows about
    // audience, this row just has none, so it is not for a person.
    expect(selectAppsNotForPeople(['nofield'], [{ key: 'nofield', audience: undefined }])).toEqual([
      'nofield',
    ]);
  });
});

const APPS = [
  { id: 'id-fr', key: 'fr' },
  { id: 'id-w2v', key: 'w2v' },
  { id: 'id-mpca', key: 'meta_prompt_core_actions' },
  { id: 'id-revoked', key: 'commonpractice' },
];

const PLANS = [
  { app_id: 'id-fr', revoked: false },
  { app_id: 'id-w2v', revoked: false },
  // meta_prompt_core_actions: no row at all — the live 2026-08-26 shape.
  // commonpractice: a row, but revoked — must NOT count as active.
  { app_id: 'id-revoked', revoked: true },
];

describe('selectAppsWithoutActivePlan', () => {
  test('flags the app that actually aborted the production run', () => {
    expect(selectAppsWithoutActivePlan(['fr', 'meta_prompt_core_actions'], APPS, PLANS)).toEqual([
      'meta_prompt_core_actions',
    ]);
  });

  test('a revoked plan does not count as active', () => {
    // "has plan rows" is the wrong question; production carries revoked rows.
    expect(selectAppsWithoutActivePlan(['commonpractice'], APPS, PLANS)).toEqual([
      'commonpractice',
    ]);
  });

  test('a healthy request is empty, so the guard never blocks the happy path', () => {
    expect(selectAppsWithoutActivePlan(['fr', 'w2v'], APPS, PLANS)).toEqual([]);
  });

  test('an UNKNOWN key is left to the engine, not reported here', () => {
    // The engine already answers unknown keys with an UPSTREAM_NOT_FOUND that
    // names the available ones; duplicating catalog membership here would be a
    // second source of truth.
    expect(selectAppsWithoutActivePlan(['no-such-app'], APPS, PLANS)).toEqual([]);
  });

  test('reports every offender, not just the first', () => {
    expect(
      selectAppsWithoutActivePlan(
        ['fr', 'meta_prompt_core_actions', 'commonpractice'],
        APPS,
        PLANS,
      ),
    ).toEqual(['meta_prompt_core_actions', 'commonpractice']);
  });

  test('an empty catalog does not mass-flag every requested app', () => {
    // Guards against a degraded catalog read turning into a blanket refusal.
    expect(selectAppsWithoutActivePlan(['fr', 'w2v'], [], [])).toEqual([]);
  });
});

/** The first file under `dir` declaring PROVISIONABLE_APP_KEYS, or null. */
