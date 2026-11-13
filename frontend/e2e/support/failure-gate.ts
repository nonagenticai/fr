// e2e/support/failure-gate.ts
//
// Fails a test on evidence the app broke, EVEN IF every explicit assertion
// passed. Assertions only check what the author thought to check; a page that
// renders the expected heading while throwing in an effect, or while its data
// call 500s and the UI silently falls back to an empty state, passes a normal
// spec. This gate closes that hole.
//
// Watched: browser console.error, uncaught pageerror, 5xx responses from the
// backend (`/api/**`), and requests to `/api/**` that never landed (connection
// refused, DNS) — a test that "passes" against a half-dead backend is worthless.
//
// The console arm is EVERY `console.error` the page emits, not only ones the app
// authored — Chrome tags no origin on a console message, so app-authorship is
// not reliably detectable. What narrows it is subtraction, in three scopes:
// `BENIGN_CONSOLE` (global), the policy's `browserTransportConsoleIgnores`
// (per lane), and `gate.ignore()` (per test).
//
// WHICH of those four arms is live is a PROPERTY OF THE LANE, passed in as a
// `GatePolicy` (see gate-rules.ts, `policyForProject`). It is one class with
// four switches on purpose: a per-lane fork of this file is how two gates drift
// apart until one of them quietly stops gating while still reporting pass.
//
// Shared by every lane, so whether a run is console-checked never depends on
// which spec you happened to run.

import type { Page, Response, TestInfo } from '@playwright/test';
// Classification rules live in a pure module so they are unit-tested in CI
// (gate-rules.unit.test.ts) — an allow-list that is only hand-verified once
// drifts into a blanket suppressor.
import {
  FULL_GATE,
  isBenignConsole,
  isReportableRequestFailure,
  isReportableResponse,
  type GatePolicy,
} from './gate-rules';

export interface GateViolation {
  kind: 'console' | 'pageerror' | 'http-5xx' | 'requestfailed';
  detail: string;
}

export class FailureGate {
  private readonly violations: GateViolation[] = [];
  private readonly extraIgnores: RegExp[] = [];

  /**
   * `policy` defaults to the FULL gate deliberately. A caller that forgets to
   * pass one gets MORE gating, never less — the opposite default would let a new
   * lane be born silently unguarded.
   */
  constructor(
    private readonly page: Page,
    private readonly policy: GatePolicy = FULL_GATE,
  ) {}

  attach(): void {
    if (this.policy.consoleErrors) {
      this.page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (this.isIgnored(text)) return;
        this.violations.push({ kind: 'console', detail: text });
      });
    }

    if (this.policy.pageErrors) {
      this.page.on('pageerror', (err) => {
        const text = `${err.name}: ${err.message}`;
        if (this.isIgnored(text)) return;
        this.violations.push({ kind: 'pageerror', detail: `${text}\n${err.stack ?? ''}`.trim() });
      });
    }

    if (this.policy.httpServerErrors) {
      this.page.on('response', (res: Response) => {
        if (!isReportableResponse(res.status(), res.url())) return;
        this.violations.push({
          kind: 'http-5xx',
          detail: `${res.status()} ${res.request().method()} ${res.url()}`,
        });
      });
    }

    if (this.policy.requestFailures) {
      this.page.on('requestfailed', (req) => {
        const failure = req.failure()?.errorText ?? 'unknown';
        if (!isReportableRequestFailure(req.url(), failure)) return;
        this.violations.push({
          kind: 'requestfailed',
          detail: `${req.method()} ${req.url()} — ${failure}`,
        });
      });
    }
  }

  /**
   * Narrow, per-test escape hatch for a message a specific test PROVOKES ON
   * PURPOSE (e.g. a step that asserts the error path). Pass the tightest pattern
   * that matches, and only from a place that documents why.
   */
  ignore(pattern: RegExp): void {
    this.extraIgnores.push(pattern);
  }

  /**
   * Three tiers, widest to narrowest: `BENIGN_CONSOLE` (global, every lane),
   * the POLICY's `browserTransportConsoleIgnores` (this lane only — see
   * gate-rules.ts for why transport lines Chrome reports on the console channel
   * have to be excluded wherever the transport arms are off), and `extraIgnores`
   * (this test only, via `gate.ignore()`).
   */
  private isIgnored(text: string): boolean {
    return isBenignConsole(text, [
      ...this.policy.browserTransportConsoleIgnores,
      ...this.extraIgnores,
    ]);
  }

  /**
   * Called in fixture teardown. Skips when the test already failed so the real
   * assertion error stays the headline rather than being buried under gate noise
   * that is usually a downstream symptom of it.
   */
  assertClean(testInfo: TestInfo): void {
    if (this.violations.length === 0) return;
    if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
      // Still surface them — they are usually the WHY behind the failure.
      testInfo.annotations.push({
        type: 'failure-gate',
        description: this.format(),
      });
      return;
    }
    throw new Error(
      `Test assertions passed, but the app misbehaved during the run:\n\n${this.format()}\n\n` +
        `Every assertion in this test passed — that is the point of this gate. ` +
        `Fix the app, or, if the test provokes this on purpose, call gate.ignore(/…/) where it does.`,
    );
  }

  private format(): string {
    return this.violations
      .map((v, i) => `  ${i + 1}. [${v.kind}] ${v.detail}`)
      .join('\n');
  }
}
