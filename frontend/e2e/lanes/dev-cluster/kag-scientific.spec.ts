// `test` comes from the shared lane fixture, not @playwright/test: it carries
// an auto-attached FailureGate (e2e/support/failure-gate.ts) that fails this
// spec on a console.error or an uncaught pageerror even when every assertion
// below passes. Importing the plain `test` here would silently un-gate the file.
import { test, expect } from '../../support/fixtures';
import { optionalStage } from '../../support/optional-stage';

/**
 * Authed in-browser drive of the standalone KAG hub's new Scientific tab (PR B),
 * against the LIVE scientific upstream (via the KAG gateway port-forward) under
 * AUTH_BYPASS. See e2e/README.md.
 */

test('KAG hub: Scientific tab finds an entity and exposes the verification suite', async ({
  page,
}) => {
  // The hub tab is its own route since the nav standard (2026-10-03).
  await page.goto('/library/kag/scientific');
  await expect(page.getByTestId('kag-scientific-page')).toBeVisible();
  await expect(page.getByTestId('kag-scientific-tab')).toBeVisible();

  // Before selecting an entity the per-entity analyses are gated.
  await expect(page.getByTestId('kag-sci-noentity')).toBeVisible();

  // Find an entity via semantic search over the live tenant graph.
  await page.getByTestId('kag-sci-query').fill('echocardiography');
  await page.getByTestId('kag-sci-search').click();

  // If the live graph has matching entities, selecting one enables the suite.
  // When it has none this stage cannot run — but that is ANNOTATED, not folded
  // into a pass. Run with FR_E2E_REQUIRE_FULL=1 to demand it.
  await optionalStage(
    test.info(),
    {
      name: 'per-entity analysis',
      reason: 'the live tenant graph returned no match for "echocardiography"',
      trigger: page.getByTestId('kag-sci-select').first(),
      // Conditionally rendered — only a matching entity produces it — so
      // visibility is the real signal.
      presence: 'visible',
      // This 60s was silently ignored until the helper started waiting for real:
      // `isVisible()` discards its timeout, so a semantic search still in flight
      // was reported as "the graph returned no match".
      timeout: 60_000,
    },
    async () => {
      await page.getByTestId('kag-sci-select').first().click();
      await expect(page.getByTestId('kag-sci-run-entity')).toBeVisible();
      await page.getByTestId('kag-sci-run-entity').click();
      await expect(page.getByTestId('kag-sci-entity-results')).toBeVisible({ timeout: 60_000 });
    },
  );

  // Graph-wide formal verification is always available.
  await page.getByTestId('kag-sci-formal-claim').fill('A implies A');
  await page.getByTestId('kag-sci-run-formal').click();
  await expect(
    page.getByTestId('kag-sci-formal').or(page.getByTestId('kag-sci-formal-error')),
  ).toBeVisible({ timeout: 60_000 });
});
