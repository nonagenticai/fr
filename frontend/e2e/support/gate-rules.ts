// e2e/support/gate-rules.ts
//
// The FailureGate's classification rules, kept PURE and separate from the
// Playwright plumbing so they can be unit-tested in CI (see gate-rules.unit.test.ts).
//
// This matters because the rules are an allow-list: every entry makes the gate
// blinder. Hand-checking them once, by mutating a spec and watching it go red,
// proves they were narrow ON THAT DAY. The unit tests prove they stay narrow.

/**
 * Console noise that is NOT evidence of a bug. Keep this list SHORT and give
 * every entry a reason — an over-broad pattern silently disarms the gate, which
 * is worse than not having one. Never add a pattern to make a red scenario
 * green; fix the app, or use the per-scenario `gate.ignore()` escape hatch.
 */
export const BENIGN_CONSOLE: readonly RegExp[] = [
  // Vite dev-server bookkeeping, not app behaviour.
  /\[vite\] (hot updated|connected|connecting)/i,
  // Chrome's generic echo of a failed network request. It carries NO url, so it
  // cannot be judged on its own — and it is redundant: the response /
  // requestfailed listeners see the same failure WITH the url and decide there.
  // Dropping it avoids an undiscriminatable duplicate; it does not weaken the gate.
  /^Failed to load resource:/i,
];

/**
 * Routes that PROXY TO AN UPSTREAM the e2e stack does not run. Their 5xx is a
 * property of the environment, not a defect.
 *
 * The stack deliberately points optional integrations at unreachable
 * placeholders (N8N_WEBHOOK_URL=http://n8n.invalid:5678). The
 * backend correctly answers 502 when it cannot reach them, and the app shell
 * polls them in the background on every page, so without this the lane flaked
 * on whether a poll landed inside a scenario's window (measured ~1 run in 4).
 *
 * Every entry was verified in the backend log as an upstream connect failure,
 * e.g. `fr.n8n.list status=error` -> 502 and `GET /api/assets/workers 502` in
 * ~200ms (a DNS/connect failure to `.invalid`).
 *
 * RULE for adding one: the handler must actually proxy somewhere unprovisioned.
 * A 5xx from a first-party route that only touches Postgres must ALWAYS fail —
 * if you are tempted to add one of those, the app is broken. Provisioning the
 * upstream always beats extending this list.
 */
export const UNPROVISIONED_UPSTREAMS: readonly RegExp[] = [
  /\/api\/tools\/n8n\//, // n8n integration  -> N8N_WEBHOOK_URL
  /\/api\/workflows(\?|$)/, // n8n-backed workflow list
  /\/api\/assets\/workers(\?|$)/, // worker fleet service
  // requirements_management: not run in fr CI (owner ruling 2026-10-29); the app
  // shell's phase titles poll it (lib/projects/phaseTitles.svelte.ts).
  /\/api\/conveyor\/project-types(\?|$)/,
];

/**
 * Backend API calls only: ORIGIN-ROOTED `/api/…`.
 *
 * A bare `/\/api\//` also matches Vite's dev source modules under
 * `/src/lib/api/…`, so a 5xx serving a source file would be misreported as a
 * backend failure. `license-gate.spec.ts` documents the same trap for
 * `page.route` globs — the gate has to anchor for exactly the same reason.
 */
const BACKEND_API = /^https?:\/\/[^/]+\/api\//;

function isBackendApi(url: string): boolean {
  return BACKEND_API.test(url);
}

export function isBenignConsole(text: string, extraIgnores: readonly RegExp[] = []): boolean {
  return BENIGN_CONSOLE.some((re) => re.test(text)) || extraIgnores.some((re) => re.test(text));
}

export function isUnprovisionedUpstream(url: string): boolean {
  return UNPROVISIONED_UPSTREAMS.some((re) => re.test(url));
}

/**
 * Should a response trip the gate? Only 5xx on a first-party `/api/` route.
 */
export function isReportableResponse(status: number, url: string): boolean {
  if (status < 500) return false;
  if (!isBackendApi(url)) return false;
  return !isUnprovisionedUpstream(url);
}

/**
 * Should a failed request trip the gate? `ERR_ABORTED` is excluded because the
 * mocked lane calls `route.abort()` on purpose and Playwright reports that
 * through the same event.
 */
export function isReportableRequestFailure(url: string, errorText: string): boolean {
  if (!isBackendApi(url)) return false;
  if (errorText.includes('ERR_ABORTED')) return false;
  return !isUnprovisionedUpstream(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-lane strictness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chrome's own report of a failed WebSocket handshake. BROWSER-EMITTED, not
 * app-authored: the app never sees this string, Chrome writes it straight to the
 * console channel.
 *
 * Anchored on the exact Chrome wording AND on an origin-rooted `/api/` path, so
 * a failed handshake to any other host — a third-party realtime service, a
 * mistyped absolute URL — is still reported.
 */
export const WS_HANDSHAKE_FAILURE =
  /^WebSocket connection to 'wss?:\/\/[^']*\/api\/[^']*' failed:/i;

/**
 * Which arms of the gate are armed, plus the console noise a given lane cannot
 * provision away. One FailureGate implementation, four switches and one list —
 * NOT a forked class per lane, because a fork is how two gates drift until one
 * of them silently stops gating.
 */
export interface GatePolicy {
  /**
   * `console.error` lines emitted by the page.
   *
   * NB this is `msg.type() === 'error'` — EVERY console.error the page emits,
   * whoever wrote it. It is deliberately NOT "app-authored only": Chrome tags no
   * origin on a console message, so app-authorship is not reliably detectable
   * (you would have to sniff stack frames, which are absent on browser-emitted
   * lines — the very lines you would be trying to classify). The honest
   * description is "every console.error, minus `BENIGN_CONSOLE` and minus this
   * policy's `browserTransportConsoleIgnores`".
   */
  consoleErrors: boolean;
  /** Uncaught exceptions / unhandled rejections that reached the page. */
  pageErrors: boolean;
  /** 5xx on an origin-rooted `/api/` route. */
  httpServerErrors: boolean;
  /** Requests to `/api/` that never landed (connection refused, DNS, …). */
  requestFailures: boolean;
  /**
   * Console lines the BROWSER writes about TRANSPORT, exempt for this lane only.
   *
   * This exists because switching `httpServerErrors`/`requestFailures` off is
   * not sufficient to stop judging transport: some transport failures are
   * reported by Chrome on the CONSOLE channel rather than the response channel,
   * and would walk straight back in through `consoleErrors`. A policy that has
   * declined to judge transport must decline consistently, or its stated
   * contract is a fiction.
   *
   * Scoped to the POLICY, never global: `FULL_GATE` keeps an empty list, so the
   * same line still fails `dev-cluster`, where a backend exists
   * and a failed handshake is a real defect. A `BENIGN_CONSOLE` entry would have
   * blinded those lanes too.
   */
  browserTransportConsoleIgnores: readonly RegExp[];
}

/** Everything armed. The default, and what a lane gets if it is not listed. */
export const FULL_GATE: GatePolicy = {
  consoleErrors: true,
  pageErrors: true,
  httpServerErrors: true,
  requestFailures: true,
  // EMPTY ON PURPOSE. These lanes run a real backend, so a failed WebSocket
  // handshake is a defect they exist to catch.
  browserTransportConsoleIgnores: [],
};

/**
 * ── WHY THE MOCKED LANE IS NOT ON THE FULL GATE ──────────────────────────────
 *
 * The `mocked` lane runs NO BACKEND — by design. Two mechanisms produce that,
 * and it is worth naming both because they fail differently:
 *
 *   1. the (deleted) mocked-lane helper `cockpit-helpers.ts` installed a deliberate catch-all
 *      `page.route(BACKEND_API, (route) => route.abort())`, and a spec then
 *      re-registers the handful of routes it actually cares about on top. This
 *      is the operative mechanism for the six specs that use those helpers, and
 *      an aborted route surfaces as `net::ERR_FAILED` — which
 *      `isReportableRequestFailure` does NOT exclude (it only excludes
 *      `ERR_ABORTED`), so it would trip the gate.
 *   2. For anything not covered by a stub, the lane's dev server runs with
 *      `FR_BACKEND_URL=none` (playwright.config.ts), so `vite.config.ts` installs
 *      no proxy and answers every `/api/*` request itself with an empty 502.
 *
 * Either way the failure is the lane's contract, not a symptom.
 *
 * Arming `httpServerErrors` / `requestFailures` there would therefore assert
 * THE PRESENCE OF A FIXTURE, not the health of the app: a spec would go red for
 * not stubbing a route it does not exercise, and the pressure to get green would
 * be to blanket-stub `/api/**` — which is exactly how a real regression in a
 * sibling panel turns into a pass (see the note at
 * `research-screening.spec.ts` (former mocked lane), "the console stays clean").
 *
 * What IS meaningful with no backend is the app's own behaviour: a template that
 * throws, an effect that rejects, a `console.error` the app wrote. Those two
 * arms are lane-independent and stay on. This lane is CI-blocking, so its gate
 * has to be one whose red always means "the app misbehaved".
 *
 * ── AND WHY IT NEEDS `browserTransportConsoleIgnores` ────────────────────────
 *
 * Switching the two transport arms off was not enough. `src/lib/ws/kanbanSocket.ts:78`
 * opens `/api/kanban/ws`, and `page.route()` CANNOT intercept a WebSocket
 * handshake — so unlike every HTTP route, this one is structurally unstubbable:
 * the lane cannot provision it and cannot mock it away. Chrome then reports the
 * failure on the CONSOLE channel, where the still-armed `consoleErrors` caught
 * it — deterministically failing two kanban specs the moment no backend is
 * listening, i.e. exactly the CI condition.
 *
 * Excluding it here RESTORES this policy's stated intent rather than weakening
 * it: the policy already declined to judge transport, and this is transport,
 * merely reported down a different channel. The exclusion is policy-scoped, so
 * `dev-cluster` still fails on it.
 *
 * `dev-cluster` drives a real stack, so a 5xx or a dropped request there IS the
 * signal — it gets the full gate. It never runs in CI, so the blast radius of a
 * false red is one developer, not the pipeline.
 */
export const APP_ONLY_GATE: GatePolicy = {
  consoleErrors: true,
  pageErrors: true,
  httpServerErrors: false,
  requestFailures: false,
  browserTransportConsoleIgnores: [WS_HANDSHAKE_FAILURE],
};

/**
 * A `Map`, NOT an object literal.
 *
 * With bare bracket access on an object, a lookup reaches `Object.prototype`: a
 * project named `constructor`, `toString` or `valueOf` returns a FUNCTION, which
 * is not `undefined`, so `?? FULL_GATE` never fires, every arm reads `undefined`
 * → falsy, and the gate silently watches nothing while reporting pass. That is
 * precisely the failure this lookup exists to prevent, so it must not be
 * reachable through the lookup itself.
 */
const POLICY_BY_PROJECT: ReadonlyMap<string, GatePolicy> = new Map([
  ['mocked', APP_ONLY_GATE],
  ['dev-cluster', FULL_GATE],
]);

/**
 * Strictness for a Playwright project name.
 *
 * Unknown names FAIL SAFE to the full gate: a lane added tomorrow gets gated
 * loudly and its author relaxes it deliberately, rather than being born with a
 * gate that watches nothing and reports pass.
 */
export function policyForProject(projectName: string): GatePolicy {
  return POLICY_BY_PROJECT.get(projectName) ?? FULL_GATE;
}
