// src/workers/signup-onboarding-tick.ts — early-access signup v2: finish what an approval started.
//
// Every 5 minutes (FR_SIGNUP_TICK_INTERVAL_MS): an APPROVED signup whose provisioning steps did not
// all land (a licences / billing / catalogue blip; the email waiting for them) is re-run under the
// row's steps lease with a bounded backoff (5 min doubling, ≤ 10 attempts, then the screen's Retry),
// and a REJECTED signup whose cleanup is pending is finished (services/signup/core.ts).
//
// Multi-replica safe without an advisory lock: every row is taken with a conditional UPDATE lease
// (steps lease / repair lease), so two replicas never run the same row. Inert unless
// FR_SIGNUP_ENABLED=true.
import { runSignupTick } from '../services/signup/core';
import { signupEnabled } from '../services/signup/config';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export async function runSignupOnboardingTickOnce(): Promise<void> {
  if (!signupEnabled() || inFlight) return;
  inFlight = true;
  try {
    const r = await runSignupTick();
    if (r.stepRuns > 0 || r.repairRuns > 0) {
      console.log(`[signup-tick] step_runs=${r.stepRuns} repair_runs=${r.repairRuns}`);
    }
  } catch (err) {
    console.warn(`[signup-tick] tick failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    inFlight = false;
  }
}

export function startSignupOnboardingTick(): void {
  if (timer !== null) return;
  if (!signupEnabled()) {
    console.log('[signup-tick] not started: FR_SIGNUP_ENABLED is not true');
    return;
  }
  const intervalMs = Number(process.env.FR_SIGNUP_TICK_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
    console.warn('[signup-tick] interval invalid, refusing to start');
    return;
  }
  timer = setInterval(() => void runSignupOnboardingTickOnce(), intervalMs);
  console.log(`[signup-tick] started interval=${intervalMs}ms`);
}

export function stopSignupOnboardingTick(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
