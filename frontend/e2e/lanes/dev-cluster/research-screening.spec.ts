// e2e/lanes/dev-cluster/research-screening.spec.ts
//
// The LIVE drive of the Screening WRITE path: fr backend under AUTH_BYPASS, into
// Evidence Review and its real Postgres. Nothing is stubbed.
//
// This is the spec that produces the shadow-smoke evidence: a review created, a
// protocol locked, a corpus sealed with a manifest hash the database recomputed
// at commit, a deduplication run against THAT corpus, and a flow ledger whose
// hash reproduces on a rebuild from zero.
//
// ## What this spec used to assert, and why that is gone
//
// It asserted the write was REFUSED — `screening-error` containing
// `human_principal_required` — on the grounds that the caller presented a tenant
// and no subject, i.e. a service principal. That is no longer reachable: the
// proxy forwards an identity under AUTH_BYPASS (PR #788), so
// `POST /api/assets/kag/reviews` answers `201` and the assertion could only
// ever fail. Relaxing it to match whatever the run produced would have turned a
// real signal into a green, so the proof MOVED rather than softened:
//
//   * the backend kag-reviews-proxy unit suite (deleted 2026-10-29, no-test-doubles
//     ruling; verify live) — "with no frame AND no authenticated identity, NO
//     subject is invented". The precondition that
//     makes the service's refusal meaningful: fr must never fabricate a subject
//     to get past it.
//   * `research-screening.spec.ts (former mocked lane, deleted 2026-10-29)` — "a problem+json code
//     reaches the UI instead of a generic failure", which is what the studio
//     does with such a refusal when one arrives.
//
// ## Why this lane needs a LOCAL Evidence Review
//
// The in-cluster Evidence Review runs `ENABLE_AUTH=true`: it requires a verified
// JWT or an `X-Research-Context` JWS and ignores `X-Tenant-Id` / `X-Subject-Id`
// entirely. Under AUTH_BYPASS there is no verifiable token, so the write path is
// simply not drivable against it without a real Keycloak reviewer identity.
// Point `EVIDENCE_REVIEW_URL` at a local instance running `ENABLE_AUTH=false` —
// see the dev-cluster section of `e2e/README.md` for the bring-up.
//
// ## Why `optionalStage` is NOT used here any more
//
// It used to wrap the whole drive, and the helper was a no-op gate
// (`isVisible()` ignores its timeout, and the rail button is always rendered),
// so the wrapper never fired. FIXING the helper would have been worse than
// leaving it: it would convert an empty live search into a SILENT SKIP of the
// entire write-path proof, and this file's own history records the live
// federated fan-out "repeatedly outran even a 180s wait". A stage that skips
// whenever the environment is slow, in a lane with `retries: 0`, proves nothing
// while reporting green.
//
// So an empty Discover result is a LOUD PRECONDITION FAILURE naming itself as
// an environment fact. `optionalStage` is still right where the variation is
// within the thing under test.

// `test` comes from the shared lane fixture, not @playwright/test: it carries
// an auto-attached FailureGate (e2e/support/failure-gate.ts) that fails this
// spec on a console.error or an uncaught pageerror even when every assertion
// below passes. Importing the plain `test` here would silently un-gate the file.
import { test, expect } from '../../support/fixtures';

test.describe.configure({ mode: 'serial' });

// The live federated search fans out to PubMed / Europe PMC / Semantic Scholar
// and routinely takes over a minute. The default 90s test timeout expired BEFORE
// the locator waits it contains, so the run died with "step-screening disabled"
// while the search was still in flight — a timeout reported as a product defect.
test.setTimeout(300_000);

test('Screening: locked protocol → sealed corpus → dedup → flow ledger', async ({ page }) => {
  const appErrors: string[] = [];
  /** Every non-2xx on the reviews surface, plus requests that never landed. */
  const reviewsFailures: string[] = [];

  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Resource-load failures are reported per request below, scoped to the
    // surface under test; folding them in here would make this a report on
    // whichever sibling panel the local bring-up cannot serve.
    if (/Failed to load resource/i.test(text)) return;
    appErrors.push(text);
  });
  page.on('pageerror', (e) => appErrors.push(String(e)));

  // ## The acceptance gate, and the three holes it used to have
  //
  // 1. It counted only 5xx. `ScreeningPanel.run()` catches everything into
  //    `screening-error` and never calls `console.error`, so a run in which
  //    EVERY write was refused 4xx satisfied both halves of the old gate. Any
  //    non-2xx on this surface is now a failure; a spec that provokes one on
  //    purpose must say so explicitly.
  // 2. It matched with `url.includes('/api/assets/kag/reviews')`, a substring
  //    test that also matches vite's dev module URLs under `/src/lib/api/...`.
  //    Anchored on the origin-rooted path instead — the same fix
  //    `support/gate-rules.ts` already had to make.
  // 3. It listened only for `response`. A dropped tunnel or a refused
  //    connection fires `requestfailed` and NO response event at all, so the
  //    gate stayed green for the one failure mode this lane exists to catch.
  const onReviewsSurface = (url: string): boolean => {
    try {
      return new URL(url).pathname.startsWith('/api/assets/kag/reviews');
    } catch {
      return false;
    }
  };
  page.on('response', (r) => {
    if (!onReviewsSurface(r.url())) return;
    if (r.status() >= 200 && r.status() < 300) return;
    reviewsFailures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (!onReviewsSurface(r.url())) return;
    reviewsFailures.push(`FAILED(${r.failure()?.errorText ?? 'unknown'}) ${r.method()} ${r.url()}`);
  });

  await page.goto('/library/research');

  // Reached THROUGH the stepper, not by jumping: the rail refuses a forward step
  // until the previous stage's gate passes, and Discover's gate is
  // `results.length > 0`. Driving the real path also means the candidates
  // Screening receives are the ones the live gateway actually returned.
  await page.getByTestId('research-stepper-step-input').waitFor();
  await page.getByRole('textbox').first().fill('tocilizumab covid-19 randomised');
  await page.getByTestId('research-stepper-advance').click();

  await page.getByTestId('research-stepper-step-discover').waitFor();

  // Fewer results per source. The lane runs several live federated drives back
  // to back, and at the default 25-per-source across five upstreams the fan-out
  // repeatedly outran even a 180s wait — the failure then reads as "the stage
  // never unlocked" when the truth is "the search had not come back". Nothing
  // here asserts volume; the stage's gate is `results > 0`.
  await page.getByTestId('research-per-source').fill('5');
  await page
    .getByRole('button', { name: /search/i })
    .first()
    .click();

  // The precondition, failed LOUDLY and named as an environment fact rather than
  // skipped. See the header for why this is not an `optionalStage`.
  await expect(
    page.getByTestId('research-stepper-step-screening'),
    'PRECONDITION: the live federated search returned no papers for this seed within 180s, ' +
      'so the Screening write path could not be driven at all. This is a fact about the ' +
      'environment, not about the code under test — but it is NOT a pass: nothing below ran.',
  ).toBeEnabled({ timeout: 180_000 });

  await page.getByTestId('research-stepper-step-screening').click();
  await expect(page.getByTestId('screening-panel')).toBeVisible();

  // ---- a review, a LOCKED protocol, an activated review --------------------
  await page.getByTestId('review-title').fill(`Shadow smoke ${new Date().toISOString()}`);
  // ONE reviewer, deliberately, and stated so nobody reads this drive as
  // covering the dual path. A browser session is one identity; requiring two
  // here would leave every record `not_yet_screened` forever. The two-reviewer
  // path — disagreement, conflict, governed unblinding, adjudication — needs
  // three separate identities and has no live lane.
  //
  // It is also what keeps `assign-reviewers` reachable: the stage enforces its
  // own `reviewers_required`, and a dual stage with one name is refused
  // `422 "this stage requires 2 reviewers; 1 were named"`.
  await page.getByTestId('reviewers-required').selectOption('1');
  // The project is required now, and is no longer the compiled-in string
  // `dogfood` — a real review must not be filed under the name of a test
  // programme. `create-review` stays disabled until it is named.
  await page.getByTestId('review-project').fill('shadow-smoke');
  // The eligibility statements are required now, and are no longer the prefilled
  // clinical sentences the panel used to ship ('hospitalised adults; randomised
  // controlled trials' / 'anything outside the inclusion statement'). Those went
  // into `protocol.content_hash`, which locks on activation and is sealed into
  // every export's `protocol_content_hash` — permanently, for a protocol nobody
  // wrote. So `create-review` stays disabled until BOTH are stated, exactly as
  // it already does for the project above.
  await page
    .getByTestId('review-criteria')
    .fill('adults hospitalised with COVID-19; randomised controlled trials');
  await page
    .getByTestId('review-exclusion-criteria')
    .fill('not a randomised trial, or not the target population');
  await page.getByTestId('create-review').click();

  // `active` is DERIVED from the append-only state history — there is no stored
  // column — so reading it here means the transition really landed in Postgres.
  await expect(page.getByTestId('review-state')).toHaveText('active', { timeout: 60_000 });
  await expect(page.getByTestId('screening-notice')).toContainText('no longer be edited');

  // ---- import + seal -------------------------------------------------------
  // The seal reads the SESSION, not this screen — so a session the gateway
  // cannot serve holds the import. Assert the source before clicking: without
  // this, an unreachable discovery-engine presents as `import-corpus` never
  // enabling and a 60s timeout describing a button, not a cause.
  await expect(page.getByTestId('corpus-source')).toContainText('discovery session');
  await page.getByTestId('import-corpus').click();
  // A POSITIVE wait first. `expect(screening-error).toHaveCount(0)` on its own
  // is not a check: the element lives inside `{#if error}`, so it is absent by
  // default and the assertion resolves on the first poll — before the write it
  // purports to be about has even returned. Wait for the thing the write
  // PRODUCES, then assert no error was raised.
  await expect(page.getByTestId('corpus-members')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('screening-error')).toHaveCount(0);

  const members = Number(await page.getByTestId('corpus-members').innerText());
  expect(members).toBeGreaterThan(0);

  // The seal. A deferred constraint trigger recomputed this at COMMIT; had it
  // disagreed with the membership the transaction would have been refused and
  // there would be nothing here to read.
  await expect(page.getByTestId('corpus-manifest')).toHaveText(/^sha256:[0-9a-f]{8}/);

  // ---- deduplication, against THIS corpus ----------------------------------
  await page.getByTestId('run-dedupe').click();
  // Again a positive first: either the engine proposed clusters or it recorded a
  // run that proposed none. Both are answers; "no element rendered" is not.
  await expect(
    page.getByTestId('merge-cluster').first().or(page.getByTestId('no-duplicates')),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('screening-error')).toHaveCount(0);
  // And the answer is about the corpus on screen. `dedup-stale` renders when the
  // newest run compared a SUPERSEDED corpus; seeing it straight after a run
  // against the current one would mean the run/corpus binding is wrong.
  await expect(page.getByTestId('dedup-stale')).toHaveCount(0);

  // ---- the flow ledger, and its rebuild ------------------------------------
  await page.getByTestId('load-flow').click();
  await expect(page.getByTestId('flow-counts')).toBeVisible({ timeout: 60_000 });

  const firstHash = await page.getByTestId('counts-hash').innerText();
  expect(firstHash).toMatch(/^sha256:[0-9a-f]{64}$/);

  await page.getByTestId('rebuild-flow').click();
  await expect(page.getByTestId('screening-notice')).toContainText('identical hash', {
    timeout: 60_000,
  });
  // Derived from immutable history, so a rebuild from zero must land on the same
  // value. A counter could drift here; a projection cannot.
  expect(await page.getByTestId('counts-hash').innerText()).toBe(firstHash);

  await page.screenshot({ path: 'test-results/screening-live-stage.png', fullPage: true });

  // ---- the acceptance gate -------------------------------------------------
  expect(appErrors, `application console errors: ${appErrors.join(' | ')}`).toEqual([]);
  expect(
    reviewsFailures,
    `non-2xx or failed requests on the reviews surface: ${reviewsFailures.join(' | ')}`,
  ).toEqual([]);
});
