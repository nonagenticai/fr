// e2e/support/fixtures.ts
//
// The `test` the two PLAYWRIGHT lanes (`mocked`, `dev-cluster`) build on. It is
// plain `@playwright/test` plus ONE auto fixture: the FailureGate.
//
// WHY THIS FILE EXISTS
// Gating used to be PER SPEC. Six of the sixteen lane specs registered their own
// console/pageerror listeners and ten did not, so whether a run was
// console-checked depended on which spec you happened to run — and a new spec
// was unguarded by default, silently. Importing `test` from here makes the gate
// the default and opting out impossible: the fixture is `{ auto: true }`, so a
// spec cannot dodge it by not declaring it.
//
// STRICTNESS IS PER LANE, resolved from `testInfo.project.name` — see
// `gate-rules.ts` (`policyForProject`) for the reasoning, which is: `mocked`
// runs with no backend at all, so its transport arms would assert the presence
// of a fixture rather than the health of the app.

import { expect, test as base } from '@playwright/test';

import { FailureGate } from './failure-gate';
import { policyForProject } from './gate-rules';

export interface LaneFixtures {
  /**
   * Auto-attached: no test has to ask for it, so a spec cannot opt out of the
   * gate by forgetting to request the fixture. Declare it in a test's arguments
   * only when the test needs `gate.ignore(...)` for an error path it provokes on
   * purpose.
   */
  gate: FailureGate;
}

export const test = base.extend<LaneFixtures>({
  gate: [
    async ({ page }, use, testInfo) => {
      // NOTE for a multi-context drive: a spec that takes `{ browser }` and
      // opens its own pages leaves this gate watching an unused blank page, so
      // it is inert there; such a spec keeps its own per-page listeners.
      //
      // Precisely what that leaves covered, because "stricter" is only half
      // true: their HTTP arms are gated on `onReviewsSurface()`
      // (`pathname.startsWith('/api/assets/kag/reviews')`), so ON THAT SURFACE
      // they are stricter than this gate (any non-2xx, not merely 5xx) — but
      // OFF it they cover nothing, whereas this gate's `httpServerErrors` arm
      // covers every origin-rooted `/api/` route. So a 5xx on a non-reviews
      // route in those two specs is caught by NOTHING. That gap is PRE-EXISTING
      // — it is how those specs were written before this fixture landed, and
      // this change neither introduces nor closes it. Closing it means giving
      // the gate a way to watch a caller-supplied page; deliberately out of
      // scope here. This fixture is additive, never a replacement for a
      // narrower check.
      const gate = new FailureGate(page, policyForProject(testInfo.project.name));
      gate.attach();
      await use(gate);
      gate.assertClean(testInfo);
    },
    { auto: true },
  ],
});

export { expect };
