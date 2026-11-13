// e2e/support/optional-stage.ts
//
// For a stage that can only run when LIVE data happened to produce it.
//
// The bug this replaces:
//
//   const btn = page.getByTestId('research-verify-btn').first();
//   if (await btn.isVisible().catch(() => false)) {
//     await btn.click();
//     await expect(page.getByTestId('trust-breakdown')).toBeVisible();
//   }
//
// When the live push linked no graph entities, the whole block was skipped and
// the test reported PASSED having verified nothing about stage 5 — the same
// "green but unverified" class as the cockpit spec that asserted a heading
// renamed months earlier. The branch itself is legitimate (live data really does
// vary); silently converting "did not run" into "passed" is not.
//
// This keeps the branch but makes the outcome VISIBLE: a skipped stage is
// recorded as a test annotation, so it shows in the HTML report and the run
// summary instead of vanishing. Set FR_E2E_REQUIRE_FULL=1 to turn a skipped
// stage into a failure, for a run where you mean to demand the whole path.

// ## The second bug: the gate itself did not gate
//
// `opts.trigger.isVisible(opts.timeout ? { timeout } : undefined)` looks like a
// bounded wait and is not one. `isVisible` is a SNAPSHOT read — Playwright
// accepts the option and ignores it, because it is not a waiting assertion — so
// every carefully argued `timeout: 180_000` in a call site did nothing at all.
//
// Worse, it was asking the wrong question. `research-screening.spec.ts` passed
// `research-stepper-step-screening`, and `ResearchStepper.svelte` renders EVERY
// rail step unconditionally as `<button ... disabled={!isReachable}>` — there is
// no `{#if}`. So the trigger was permanently visible, `present` was permanently
// `true`, `decideStage` could only ever return `'run'`, and the escape hatch
// could not fire even in principle. The helper reported a working gate for
// months while gating nothing.
//
// Hence `presence`. "Is it on the page" and "can it be used" are different
// questions, and which one is the real signal depends on the trigger: a button
// that is conditionally rendered answers the first, a permanently rendered rail
// step answers only the second.
//
// ## What a skipped run does and does not prove
//
// DOES: every other assertion in the scenario ran and held.
// DOES NOT: anything whatsoever about the skipped stage. It is not "passed with
// a caveat", it is "not executed". That is why the skip is annotated AND logged
// AND convertible into a failure with `FR_E2E_REQUIRE_FULL=1`, and why
// `research-screening{,-full,-dual}.spec.ts` no longer use this helper for
// reaching the Screening stage: an empty live search there would have silently
// skipped the entire write-path drive, and the live federated fan-out is known
// to outrun even a 180s wait. A hard precondition failure that names the
// environment is the honest answer for that case; this helper is for variation
// WITHIN the thing under test.

import { expect, type Locator, type TestInfo } from '@playwright/test';

export const ANNOTATION_TYPE = 'stage-not-exercised';

/**
 * How to decide whether the stage's trigger is really there.
 *
 * `visible` — the trigger is conditionally rendered, so its presence is the
 *   signal (`research-verify-btn`, `kag-sci-select`).
 * `enabled` — the trigger is ALWAYS rendered and only its disabled state
 *   changes, so visibility answers nothing (any `research-stepper-step-*`).
 */
export type PresenceMode = 'visible' | 'enabled';

/**
 * How long to wait when a call site does not say.
 *
 * Explicit, rather than inherited from Playwright's `actionTimeout`, which
 * defaults to 0 — meaning NO timeout. Falling through to that would turn a
 * never-arriving trigger into a hang capped only by the test timeout, which is
 * the failure this helper is least useful for.
 */
export const DEFAULT_PRESENCE_TIMEOUT_MS = 30_000;

/** True when the run demands every optional stage actually execute. */
export function requireFullCoverage(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FR_E2E_REQUIRE_FULL === '1';
}

/**
 * Pure decision, split out so it is unit-testable without a browser.
 */
export function decideStage(present: boolean, requireFull: boolean): 'run' | 'annotate' | 'fail' {
  if (present) return 'run';
  return requireFull ? 'fail' : 'annotate';
}

export function skippedStageMessage(name: string, reason: string): string {
  return (
    `stage "${name}" did not run: ${reason}. ` +
    `The scenario's other assertions still applied, but THIS stage verified nothing. ` +
    `Re-run with FR_E2E_REQUIRE_FULL=1 to make this a failure.`
  );
}

/**
 * Wait — really wait — for the trigger, and report whether it arrived.
 *
 * Both branches are WAITING checks. `isVisible()` was neither: it read the DOM
 * once and discarded any timeout it was handed.
 *
 * Exported so the mocked lane can prove the `enabled` branch against a real
 * disabled button, which is the case the old implementation got wrong.
 */
export async function isStagePresent(
  trigger: Locator,
  mode: PresenceMode,
  timeout: number = DEFAULT_PRESENCE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    if (mode === 'enabled') {
      await expect(trigger).toBeEnabled({ timeout });
    } else {
      await trigger.waitFor({ state: 'visible', timeout });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `body` only if `trigger` becomes usable, and make a no-run visible.
 *
 * @param testInfo pass `test.info()` from the spec.
 */
export async function optionalStage(
  testInfo: TestInfo,
  opts: {
    name: string;
    reason: string;
    trigger: Locator;
    timeout?: number;
    /**
     * Defaults to `visible`, which is right for a conditionally rendered
     * trigger. Pass `enabled` for anything that is always in the DOM — most
     * importantly every `research-stepper-step-*` button, where visibility is
     * a constant and only the disabled state carries information.
     */
    presence?: PresenceMode;
  },
  body: () => Promise<void>,
): Promise<boolean> {
  const present = await isStagePresent(
    opts.trigger,
    opts.presence ?? 'visible',
    opts.timeout ?? DEFAULT_PRESENCE_TIMEOUT_MS,
  );

  switch (decideStage(present, requireFullCoverage())) {
    case 'run':
      await body();
      return true;
    case 'fail':
      throw new Error(skippedStageMessage(opts.name, opts.reason));
    case 'annotate':
      testInfo.annotations.push({
        type: ANNOTATION_TYPE,
        description: skippedStageMessage(opts.name, opts.reason),
      });
      // eslint-disable-next-line no-console -- surfaces in the CI step log too
      console.warn(`[e2e] ${skippedStageMessage(opts.name, opts.reason)}`);
      return false;
  }
}
