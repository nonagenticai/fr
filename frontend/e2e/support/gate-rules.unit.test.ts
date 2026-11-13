// e2e/support/gate-rules.unit.test.ts
//
// These lock in the FailureGate's NARROWNESS. The gate's value is entirely a
// function of what it refuses to ignore, and every allow-list entry makes it
// blinder. Mutating a spec by hand and watching it go red proves the rules were
// narrow on the day it was done; these prove they stay narrow, in CI, forever.
//
// The most important cases here are the negative ones: a first-party 5xx must
// ALWAYS be reportable. If someone widens a pattern to quiet a red run, one of
// these fails.

import { describe, it, expect } from 'vitest';
import {
  isBenignConsole,
  isUnprovisionedUpstream,
  isReportableResponse,
  isReportableRequestFailure,
  policyForProject,
  APP_ONLY_GATE,
  FULL_GATE,
  WS_HANDSHAKE_FAILURE,
  UNPROVISIONED_UPSTREAMS,
} from './gate-rules';

const ORIGIN = 'http://127.0.0.1:5173';

describe('isReportableResponse — first-party 5xx must always trip the gate', () => {
  it.each([
    ['/api/me/notification-prefs', 500],
    ['/api/me/workspaces', 503],
    ['/api/projects', 500],
    ['/api/license/status', 502],
    ['/api/me/channels', 504],
  ])('reports %s -> %i', (path, status) => {
    expect(isReportableResponse(status, `${ORIGIN}${path}`)).toBe(true);
  });

  it('ignores non-5xx, including 4xx which are legitimate app responses', () => {
    for (const status of [200, 201, 204, 304, 400, 401, 403, 404, 409, 429]) {
      expect(isReportableResponse(status, `${ORIGIN}/api/me/workspaces`)).toBe(false);
    }
  });

  it('ignores 5xx from non-API urls (assets, vite modules)', () => {
    expect(isReportableResponse(500, `${ORIGIN}/src/lib/api/client.ts`)).toBe(false);
    expect(isReportableResponse(500, `${ORIGIN}/favicon.ico`)).toBe(false);
  });
});

describe('isReportableResponse — unprovisioned upstreams are exempt', () => {
  it.each([
    '/api/tools/n8n/executions?limit=100',
    '/api/workflows',
    '/api/workflows?status=active',
    '/api/assets/workers',
    '/api/conveyor/project-types',
  ])('exempts %s', (path) => {
    expect(isReportableResponse(502, `${ORIGIN}${path}`)).toBe(false);
  });

  it('does NOT exempt look-alike first-party routes', () => {
    // The guard against a lazily-widened pattern: these must stay reportable.
    // `/api/workflows` is exempt, but a nested first-party resource is not.
    expect(isReportableResponse(500, `${ORIGIN}/api/workflow-runs`)).toBe(true);
    expect(isReportableResponse(500, `${ORIGIN}/api/assets/artifacts`)).toBe(true);
    expect(isReportableResponse(500, `${ORIGIN}/api/tools/kag/search`)).toBe(true);
    expect(isReportableResponse(500, `${ORIGIN}/api/me/channel-prefs`)).toBe(true);
  });
});

describe('isReportableRequestFailure', () => {
  it('reports a genuine connection failure to a first-party api route', () => {
    expect(
      isReportableRequestFailure(`${ORIGIN}/api/me/workspaces`, 'net::ERR_CONNECTION_REFUSED'),
    ).toBe(true);
  });

  it('ignores ERR_ABORTED — the mocked lane aborts /api calls on purpose', () => {
    expect(isReportableRequestFailure(`${ORIGIN}/api/me/workspaces`, 'net::ERR_ABORTED')).toBe(
      false,
    );
  });

  it('ignores non-api urls', () => {
    expect(isReportableRequestFailure(`${ORIGIN}/favicon.ico`, 'net::ERR_FAILED')).toBe(false);
  });

  it('exempts unprovisioned upstreams', () => {
    expect(
      isReportableRequestFailure(`${ORIGIN}/api/tools/n8n/executions`, 'net::ERR_FAILED'),
    ).toBe(false);
  });
});

describe('isBenignConsole', () => {
  it('ignores vite dev-server bookkeeping', () => {
    expect(isBenignConsole('[vite] connected.')).toBe(true);
    expect(isBenignConsole('[vite] hot updated: /src/routes/+page.svelte')).toBe(true);
  });

  it('ignores the urlless generic resource-load echo (judged by url elsewhere)', () => {
    expect(
      isBenignConsole('Failed to load resource: the server responded with a status of 502 ()'),
    ).toBe(true);
  });

  it('does NOT ignore real application errors', () => {
    for (const msg of [
      'TypeError: Cannot read properties of undefined (reading "id")',
      'Uncaught (in promise) Error: boom',
      'Svelte error: effect_update_depth_exceeded',
      'Error: license gate failed to resolve',
    ]) {
      expect(isBenignConsole(msg)).toBe(false);
    }
  });

  it('honours a per-scenario ignore without leaking into the defaults', () => {
    const msg = 'DELIBERATE: provoked by the error-path scenario';
    expect(isBenignConsole(msg)).toBe(false);
    expect(isBenignConsole(msg, [/^DELIBERATE:/])).toBe(true);
  });
});

describe('allow-list hygiene', () => {
  it('every unprovisioned-upstream pattern is anchored to a specific /api path', () => {
    // Blocks the failure mode where someone adds /api/ or a bare .* and
    // silently exempts the entire backend.
    for (const re of UNPROVISIONED_UPSTREAMS) {
      expect(re.source).toContain('api');
      expect(isReportableResponse(500, `${ORIGIN}/api/me/workspaces`)).toBe(true);
    }
  });

  it('the exemption list stays small — growth should mean provisioning, not ignoring', () => {
    expect(UNPROVISIONED_UPSTREAMS.length).toBeLessThanOrEqual(6);
  });
});

describe('policyForProject — strictness is per lane, and unknown lanes fail SAFE', () => {
  it('dev-cluster drives a real stack, so every arm is armed', () => {
    for (const lane of ['dev-cluster']) {
      expect(policyForProject(lane)).toEqual(FULL_GATE);
    }
    // Exhaustive on purpose: a new arm added to GatePolicy fails this until
    // someone states what FULL_GATE does with it, rather than defaulting in.
    expect(FULL_GATE).toEqual({
      consoleErrors: true,
      pageErrors: true,
      httpServerErrors: true,
      requestFailures: true,
      browserTransportConsoleIgnores: [],
    });
  });

  it('mocked keeps the app-authored arms and drops the transport arms', () => {
    // The lane runs NO backend, so a 5xx/failed request there is the absence of
    // a page.route() stub, not a defect. Console + pageerror stay ON: those are
    // the app's own behaviour and are meaningful with or without a backend.
    expect(policyForProject('mocked')).toEqual(APP_ONLY_GATE);
    expect(policyForProject('mocked').consoleErrors).toBe(true);
    expect(policyForProject('mocked').pageErrors).toBe(true);
    expect(policyForProject('mocked').httpServerErrors).toBe(false);
    expect(policyForProject('mocked').requestFailures).toBe(false);
  });

  it('a lane named after an Object.prototype member does NOT return a function', () => {
    // With bare bracket access on an object literal, `POLICY_BY_PROJECT['constructor']`
    // returns Object itself — not undefined, so `?? FULL_GATE` never fires, every
    // arm reads `undefined` -> falsy, and the gate watches NOTHING while
    // reporting pass. The lookup is a Map so this cannot happen.
    for (const lane of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const p = policyForProject(lane);
      expect(typeof p).toBe('object');
      expect(p).toEqual(FULL_GATE);
    }
  });

  it('an unlisted lane gets the FULL gate, never an empty one', () => {
    // The failure this pins: a lane added to playwright.config.ts and forgotten
    // here must be born loud, not born silently unguarded and reporting pass.
    for (const lane of ['', 'some-new-lane', 'staging', 'undefined']) {
      expect(policyForProject(lane)).toEqual(FULL_GATE);
    }
  });

  it('no lane is configured with every arm off', () => {
    // A policy of all-false is a gate that cannot fail — indistinguishable from
    // having deleted it, but it still reads as "gated" at the call site.
    for (const lane of ['mocked', 'dev-cluster', 'anything-else']) {
      const p = policyForProject(lane);
      expect(Object.values(p).some(Boolean)).toBe(true);
    }
  });
});

describe('browserTransportConsoleIgnores — policy-scoped, and NARROW', () => {
  // The exact line Chrome writes when the kanban socket cannot handshake. The
  // `mocked` lane cannot provision it away: `page.route()` does not intercept a
  // WebSocket handshake, so `src/lib/ws/kanbanSocket.ts:78` is unstubbable there.
  const WS_LINE =
    "WebSocket connection to 'ws://localhost:5198/api/kanban/ws' failed: " +
    'Connection closed before receiving a handshake response';

  it('mocked exempts the WebSocket handshake line', () => {
    expect(isBenignConsole(WS_LINE, APP_ONLY_GATE.browserTransportConsoleIgnores)).toBe(true);
  });

  it('the FULL gate still FAILS on it — a real backend means a real defect', () => {
    // The whole point of scoping this to the policy instead of BENIGN_CONSOLE.
    expect(FULL_GATE.browserTransportConsoleIgnores).toEqual([]);
    expect(isBenignConsole(WS_LINE, FULL_GATE.browserTransportConsoleIgnores)).toBe(false);
    // And it is not in the global list either, which would blind every lane.
    expect(isBenignConsole(WS_LINE)).toBe(false);
  });

  it('a DIFFERENT console.error from the same component still trips mocked', () => {
    // The narrowness proof: the exemption buys silence for one browser-emitted
    // transport line, not for the kanban socket's own code.
    for (const msg of [
      '[kanban] socket dropped and will not reconnect',
      '[kanban] failed to apply a realtime event TypeError: undefined is not an object',
      "TypeError: Cannot read properties of null (reading 'board')",
      '[kanban] failed to rename the card ApiError: planka_upstream_error',
    ]) {
      expect(isBenignConsole(msg, APP_ONLY_GATE.browserTransportConsoleIgnores)).toBe(false);
    }
  });

  it('the pattern is anchored to an origin-rooted /api/ path', () => {
    // A handshake failure to anything that is NOT a first-party /api/ route is
    // still reported — a third-party realtime service, or a mistyped host.
    expect(WS_HANDSHAKE_FAILURE.test(WS_LINE)).toBe(true);
    for (const other of [
      "WebSocket connection to 'wss://realtime.thirdparty.io/socket' failed: bad handshake",
      "WebSocket connection to 'ws://localhost:5198/ws/kanban' failed: bad handshake",
    ]) {
      expect(WS_HANDSHAKE_FAILURE.test(other)).toBe(false);
      expect(isBenignConsole(other, APP_ONLY_GATE.browserTransportConsoleIgnores)).toBe(false);
    }
  });

  it('the exemption cannot be smuggled in mid-message', () => {
    // Anchored with ^, so an app line that merely QUOTES the browser's wording
    // does not inherit the exemption.
    const quoted = `[kanban] giving up after: ${WS_LINE}`;
    expect(isBenignConsole(quoted, APP_ONLY_GATE.browserTransportConsoleIgnores)).toBe(false);
  });

  it('each policy carries a transport-ignore list that stays tiny', () => {
    for (const lane of ['mocked', 'dev-cluster', 'anything-else']) {
      expect(policyForProject(lane).browserTransportConsoleIgnores.length).toBeLessThanOrEqual(2);
    }
  });
});
