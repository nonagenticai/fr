import type { Page } from '@playwright/test';
// `test` comes from the shared lane fixture, not @playwright/test: it carries
// an auto-attached FailureGate (e2e/support/failure-gate.ts) that fails this
// spec on a console.error or an uncaught pageerror even when every assertion
// below passes. Importing the plain `test` here would silently un-gate the file.
import { test, expect } from '../../support/fixtures';
import { optionalStage } from '../../support/optional-stage';

/**
 * Authed in-browser drive of the 6-stage research stepper, end-to-end, against
 * the LIVE in-cluster discovery + ingestion + scientific upstreams (via the KAG
 * gateway port-forward) under AUTH_BYPASS. See e2e/README.md for bring-up.
 *
 * The medical query proves the relevance fix (cardiology, not arxiv physics);
 * the push proves entity extraction; verify + the embedded knowledge-graph
 * deliverable prove the closed loop. Assertions are structural (live data is not
 * deterministic) with generous waits.
 */

const MEDICAL_QUERY = 'stress echocardiography prognosis';

// The lane's 90s default is not enough for this drive. Stage 2 alone fans out
// to PubMed / Europe PMC / Semantic Scholar / arXiv / Crossref, and stage 4
// pushes into the graph; measured here, the search alone repeatedly exceeded
// the 60s the first paper card was given, leaving the panel on "Searching…"
// and the failure pointing at a missing card rather than at a slow upstream.
//
// Raised in the spec rather than in `playwright.config.ts` so the other
// dev-cluster specs keep the tighter budget — a lane-wide bump would hide
// genuine slowness everywhere else, which is what this lane exists to surface.
test.setTimeout(300_000);

async function advance(page: Page): Promise<void> {
  await page.getByTestId('research-stepper-advance').click();
}

/**
 * Go to a stage by NAME, not by counting clicks.
 *
 * This spec used to walk the rail with bare `advance()` calls and a comment
 * saying which stage each one landed on. When a **Screening** stage was
 * inserted between Discover and Appraise, every comment after it became a lie:
 * the two advances that meant "→ Appraise, → Build" landed on Screening and
 * Appraise, so `research-push-btn` never rendered and the drive failed 30s
 * later pointing at the Build stage — which was fine.
 *
 * Nothing caught it. The `dev-cluster` lane needs a live stack, so CI does not
 * run it; a positional assumption here is invisible until somebody runs the
 * lane by hand.
 *
 * Naming the destination makes stage insertion a non-event.
 *
 * It ADVANCES rather than jumping: the rail marks a stage reachable only once
 * the ones before it are done, so clicking `…-step-build` from Discover hits a
 * disabled control and waits forever. Pressing "advance" until the named stage
 * is `data-state="active"` respects that gating and still does not care how
 * many stages lie between here and there.
 */
async function goToStage(page: Page, id: string): Promise<void> {
  const step = page.getByTestId(`research-stepper-step-${id}`);
  // Bounded: a stepper that will not advance must fail loudly rather than spin
  // until the suite-level timeout, which reports the wrong stage.
  for (let i = 0; i < 10; i += 1) {
    if ((await step.getAttribute('data-state')) === 'active') return;
    await advance(page);
    await page.waitForTimeout(250);
  }
  await expect(step).toHaveAttribute('data-state', 'active', { timeout: 15_000 });
}

test('research stepper: input → discover → appraise → build → verify → synthesize', async ({
  page,
}) => {
  // Auth bypass means we land on the page, not a Keycloak redirect.
  await page.goto('/library/research');
  await expect(page.getByTestId('research-page')).toBeVisible();
  await expect(page.getByTestId('research-stepper')).toBeVisible();

  // Stage 1 — Input: type the query, the detector classifies it.
  await page.getByTestId('research-query').fill(MEDICAL_QUERY);
  await expect(page.getByTestId('research-input-type-pill')).toBeVisible();
  await advance(page); // → Discover

  // Stage 2 — Discover: run the live search; expect on-topic results.
  await expect(page.getByTestId('research-build').or(page.getByTestId('research-search-btn'))).toBeVisible();
  // See the note in research-screening.spec.ts: the lane's several live
  // fan-outs compound, and the default 25-per-source repeatedly outran the
  // wait. Relevance — the thing this query exists to prove — is unaffected by
  // depth; the sources are still all queried.
  await page.getByTestId('research-per-source').fill('5');
  await page.getByTestId('research-search-btn').click();
  await expect(page.getByTestId('research-paper-card').first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('research-result-summary')).toContainText('results from');

  // Select the first paper into the working set.
  await page
    .getByTestId('research-paper-card')
    .first()
    .locator('input[type="checkbox"]')
    .check();
  await goToStage(page, 'build');

  // Stage 4 — Build: push to the graph; the live ingest returns per-paper jobs.
  await expect(page.getByTestId('research-push-btn')).toBeVisible();
  await page.getByTestId('research-push-btn').click();
  await expect(page.getByTestId('research-push-jobs')).toBeVisible({ timeout: 90_000 });

  await goToStage(page, 'verify');

  // Stage 5 — Verify: run the scientific suite on a pushed entity (when one
  // produced graph entities). Some pushes legitimately link none, so this stage
  // is conditional — but a stage that did not run is ANNOTATED, never silently
  // folded into a pass. Run with FR_E2E_REQUIRE_FULL=1 to demand it.
  await optionalStage(
    test.info(),
    {
      name: 'verify (stage 5)',
      reason: 'the live push linked no graph entities, so no verify button rendered',
      trigger: page.getByTestId('research-verify-btn').first(),
      // `visible` is the right question here — the button is conditionally
      // rendered, so its absence really is "the push linked nothing".
      presence: 'visible',
      // Explicit, because the check is now a real wait. It used to be a snapshot
      // read racing the live push that had just been kicked off one line above,
      // so a slow ingest reported "linked no graph entities" — an environmental
      // delay recorded as a fact about the data.
      timeout: 60_000,
    },
    async () => {
      await page.getByTestId('research-verify-btn').first().click();
      await expect(page.getByTestId('trust-breakdown').first()).toBeVisible({ timeout: 60_000 });
    },
  );

  await goToStage(page, 'synthesize');

  // Stage 6 — Synthesize: the deliverables, including the NEW embedded
  // knowledge-graph panel (PR A).
  await expect(page.getByTestId('deliverable-tabs')).toBeVisible();
  await page.getByTestId('deliverable-tab-graph').click();
  await expect(page.getByTestId('research-corpus-graph')).toBeVisible();
});
