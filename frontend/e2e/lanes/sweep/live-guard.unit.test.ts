// e2e/lanes/sweep/live-guard.unit.test.ts
//
// These pin the NARROWNESS of the control that stands between a 168-route
// Playwright sweep and PRODUCTION fr, driven by a `super_admin` session. The
// interesting cases are the negative ones: the approvals control, the
// look-alike host, the deny term smuggled into a query string, and the mode
// string nobody declared.
//
// ⛔ WHAT A GREEN RUN HERE DOES NOT PROVE — the same four holes named at the
// top of `live-guard.ts`, restated because this file is where "it's tested"
// gets said: this suite exercises the DECISION FUNCTION in isolation. It does
// not prove the sweep calls it, that the route handler is installed before the
// first navigation, that an `abort` decision becomes `route.abort()`, or that
// requests outside Playwright's interception (service worker, sendBeacon,
// WebSocket) are covered at all. All of those can be broken with this suite
// fully green.

import { describe, it, expect } from 'vitest';
import { classifyRequest, ALLOWED_HOSTS, WRITE_DENY, type SweepMode } from './live-guard';

const APP = 'https://fr.nonagentic.ai';
const AUTH = 'https://auth.nonagentic.ai';
const ALL_MODES: SweepMode[] = ['read', 'interact', 'write-pass'];
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

describe('reads are always forwarded', () => {
  it.each(ALL_MODES)('GET /api/projects forwards in %s', (mode) => {
    expect(classifyRequest({ method: 'GET', url: `${APP}/api/projects`, mode })).toEqual({
      action: 'forward',
    });
  });

  it.each(ALL_MODES)('HEAD forwards in %s', (mode) => {
    expect(classifyRequest({ method: 'HEAD', url: `${APP}/api/projects`, mode })).toEqual({
      action: 'forward',
    });
  });

  it('a GET forwards even to a path the write deny-list names', () => {
    // The deny-list is about EFFECT, not secrecy. Reading the approvals list is
    // exactly what the sweep is for; only the write must be impossible.
    expect(
      classifyRequest({ method: 'GET', url: `${APP}/api/approvals`, mode: 'write-pass' }),
    ).toEqual({ action: 'forward' });
  });

  it('forwards a GET to the auth host, the sweep’s other allowed origin', () => {
    expect(
      classifyRequest({
        method: 'GET',
        url: `${AUTH}/realms/portal/.well-known/openid-configuration`,
        mode: 'read',
      }),
    ).toEqual({ action: 'forward' });
  });
});

describe('read and interact block EVERY write method', () => {
  it.each(WRITE_METHODS)('%s aborts in read', (method) => {
    expect(classifyRequest({ method, url: `${APP}/api/projects`, mode: 'read' })).toEqual({
      action: 'abort',
      reason: 'write-blocked-in-read-mode',
    });
  });

  it.each(WRITE_METHODS)('%s aborts in interact', (method) => {
    expect(classifyRequest({ method, url: `${APP}/api/projects`, mode: 'interact' })).toEqual({
      action: 'abort',
      reason: 'write-blocked-in-read-mode',
    });
  });

  it('an unrecognised method is treated as a write, not as a read', () => {
    // Fail-closed: only GET/HEAD earn the method-based forward. Anything else —
    // including a garbled or empty method — falls through to the mode rules.
    for (const method of ['PROPFIND', 'TRACE', '', 'GE T']) {
      expect(classifyRequest({ method, url: `${APP}/api/projects`, mode: 'read' })).toEqual({
        action: 'abort',
        reason: 'write-blocked-in-read-mode',
      });
    }
  });
});

describe('⭐ negative control — approvals are unreachable in EVERY mode', () => {
  // The load-bearing case. Approval decide/void is gated separately (the
  // decide/void token split) and a super_admin sweep must never be able to
  // reach it, including in the mode whose entire purpose is to permit writes.
  const url = `${APP}/api/approvals/abc/decision`;

  it.each(ALL_MODES)('PUT /api/approvals/abc/decision aborts in %s', (mode) => {
    const decision = classifyRequest({ method: 'PUT', url, mode });
    expect(decision.action).toBe('abort');
    expect(decision).not.toEqual({ action: 'forward' });
  });

  it('write-pass aborts it with the approvals reason, not a generic one', () => {
    // If this ever reads 'write-blocked-in-read-mode' the deny-list was never
    // consulted, and the pass would be safe only by accident of the mode.
    expect(classifyRequest({ method: 'PUT', url, mode: 'write-pass' })).toEqual({
      action: 'abort',
      reason: 'approvals-separately-gated',
    });
  });

  it.each(['POST', 'PATCH', 'DELETE'])('%s to an approvals path aborts in write-pass', (method) => {
    expect(
      classifyRequest({ method, url: `${APP}/api/approvals/abc/void`, mode: 'write-pass' }),
    ).toEqual({ action: 'abort', reason: 'approvals-separately-gated' });
  });

  it('a percent-encoded approvals path cannot slip past the pattern', () => {
    // `%61` is `a`. The server resolves this to /api/approvals; a regex over
    // the raw pathname does not. The guard matches the decoded form too.
    const decision = classifyRequest({
      method: 'PUT',
      url: `${APP}/api/%61pprovals/abc/decision`,
      mode: 'write-pass',
    });
    expect(decision.action).toBe('abort');
  });
});

describe('host rule — whole hostname, never a suffix', () => {
  it('aborts a host that merely ENDS in an allowed name', () => {
    // `fr.nonagentic.ai.evil.test` is an attacker-controlled domain. A
    // `.endsWith()` check would forward the super_admin session’s cookies to it.
    for (const mode of ALL_MODES) {
      expect(
        classifyRequest({
          method: 'GET',
          url: 'https://fr.nonagentic.ai.evil.test/api/projects',
          mode,
        }),
      ).toEqual({ action: 'abort', reason: 'host-not-allowlisted' });
    }
  });

  it('aborts localhost — the sweep runs against production, not a dev server', () => {
    expect(
      classifyRequest({ method: 'GET', url: 'http://localhost:5198/api/projects', mode: 'read' }),
    ).toEqual({ action: 'abort', reason: 'host-not-allowlisted' });
    expect(
      classifyRequest({ method: 'POST', url: 'http://localhost:5198/api/projects', mode: 'write-pass' }),
    ).toEqual({ action: 'abort', reason: 'host-not-allowlisted' });
  });

  it('the host rule outranks the method rule', () => {
    // Rule 1 runs first, so a bad host aborts even for a GET, which rule 2
    // would otherwise forward unconditionally.
    expect(
      classifyRequest({ method: 'GET', url: 'https://evil.test/api/projects', mode: 'read' })
        .action,
    ).toBe('abort');
  });

  it('userinfo and a look-alike prefix cannot forge the host', () => {
    // `https://fr.nonagentic.ai@evil.test/` has hostname `evil.test`. Parsing
    // rather than string-matching is what makes this refusable.
    for (const url of [
      'https://fr.nonagentic.ai@evil.test/api/projects',
      'https://notfr.nonagentic.ai/api/projects',
      'https://fr.nonagentic.ai.evil.test/api/projects',
    ]) {
      expect(classifyRequest({ method: 'GET', url, mode: 'read' })).toEqual({
        action: 'abort',
        reason: 'host-not-allowlisted',
      });
    }
  });

  it('a URL that does not parse aborts rather than throwing', () => {
    for (const url of ['not-a-url', '', '///', 'https://']) {
      expect(classifyRequest({ method: 'GET', url, mode: 'read' })).toEqual({
        action: 'abort',
        reason: 'host-not-allowlisted',
      });
    }
  });

  it('plaintext http to an ALLOWED host is still refused', () => {
    // Documented extension: a plaintext request would carry the super_admin
    // bearer token on the wire.
    expect(
      classifyRequest({ method: 'GET', url: 'http://fr.nonagentic.ai/api/projects', mode: 'read' }),
    ).toEqual({ action: 'abort', reason: 'host-not-allowlisted' });
  });

  it('ALLOWED_HOSTS is exactly the two production origins', () => {
    // Exhaustive on purpose: a third host added without a stated reason fails
    // here rather than quietly widening where a super_admin session may go.
    expect([...ALLOWED_HOSTS]).toEqual(['fr.nonagentic.ai', 'auth.nonagentic.ai']);
  });
});

describe('case-insensitivity, on both method and host', () => {
  it.each(['get', 'gEt', 'Get', 'head', 'HeAd'])('%s is recognised as a safe method', (method) => {
    expect(classifyRequest({ method, url: `${APP}/api/projects`, mode: 'read' })).toEqual({
      action: 'forward',
    });
  });

  it.each([
    'HTTPS://FR.NONAGENTIC.AI/api/projects',
    'https://Fr.NonAgentic.AI/api/projects',
    'https://AUTH.NONAGENTIC.AI/realms/portal',
  ])('%s is an allowed host', (url) => {
    expect(classifyRequest({ method: 'GET', url, mode: 'read' })).toEqual({ action: 'forward' });
  });

  it('a lowercase write method is still blocked in read mode', () => {
    // Case-folding must not become a hole: `post` is a write.
    expect(classifyRequest({ method: 'post', url: `${APP}/api/projects`, mode: 'read' })).toEqual({
      action: 'abort',
      reason: 'write-blocked-in-read-mode',
    });
  });

  it('a mixed-case deny path is still denied in write-pass', () => {
    expect(
      classifyRequest({ method: 'POST', url: `${APP}/api/Secrets/rotate`, mode: 'write-pass' })
        .action,
    ).toBe('abort');
  });
});

describe('unknown mode — the type system is not trusted at runtime', () => {
  it('a POST with a nonsense mode aborts', () => {
    expect(
      classifyRequest({
        method: 'POST',
        url: `${APP}/api/procedures`,
        mode: 'nonsense' as unknown as SweepMode,
      }),
    ).toEqual({ action: 'abort', reason: 'unknown-mode' });
  });

  it.each(['', 'READ', 'write', 'write_pass', 'constructor', '__proto__', 'toString'])(
    'mode %s aborts a write',
    (mode) => {
      // The Object.prototype names matter: with a bare object-literal lookup
      // `MODES['constructor']` returns Object, which is truthy, and the write
      // would forward. Set membership cannot do that.
      expect(
        classifyRequest({
          method: 'POST',
          url: `${APP}/api/procedures`,
          mode: mode as unknown as SweepMode,
        }),
      ).toEqual({ action: 'abort', reason: 'unknown-mode' });
    },
  );

  it.each([undefined, null, 0, {}, []])('non-string mode %s aborts a write', (mode) => {
    expect(
      classifyRequest({
        method: 'POST',
        url: `${APP}/api/procedures`,
        mode: mode as unknown as SweepMode,
      }),
    ).toEqual({ action: 'abort', reason: 'unknown-mode' });
  });
});

describe('write-pass forwards only the benign, and only in write-pass', () => {
  const url = `${APP}/api/procedures`;

  it('POST /api/procedures forwards in write-pass', () => {
    expect(classifyRequest({ method: 'POST', url, mode: 'write-pass' })).toEqual({
      action: 'forward',
    });
  });

  it.each(['read', 'interact'] as SweepMode[])('the same POST aborts in %s', (mode) => {
    expect(classifyRequest({ method: 'POST', url, mode })).toEqual({
      action: 'abort',
      reason: 'write-blocked-in-read-mode',
    });
  });
});

describe('rules read the PATHNAME, never the whole URL', () => {
  it('a deny term appearing only in the query string does NOT deny', () => {
    // Proves the rule reads the pathname. If this went red, every benign write
    // whose payload mentioned a denied noun would be blocked — noise that gets
    // a deny-list loosened, which is how the real hole opens.
    expect(
      classifyRequest({ method: 'POST', url: `${APP}/api/procedures?note=bulk`, mode: 'write-pass' }),
    ).toEqual({ action: 'forward' });
  });

  it.each([
    `${APP}/api/procedures?target=/api/approvals/abc/decision`,
    `${APP}/api/procedures?q=metering&scope=licenses`,
    `${APP}/api/procedures#/api/secrets`,
  ])('%s forwards — query and fragment are not the path', (url) => {
    expect(classifyRequest({ method: 'POST', url, mode: 'write-pass' })).toEqual({
      action: 'forward',
    });
  });

  it('a deny term in the query cannot LAUNDER a denied path either', () => {
    // The inverse of the case above, and the one that actually matters: the
    // path is denied regardless of what the query says.
    expect(
      classifyRequest({
        method: 'POST',
        url: `${APP}/api/approvals/abc/decision?dry_run=true&safe=yes`,
        mode: 'write-pass',
      }),
    ).toEqual({ action: 'abort', reason: 'approvals-separately-gated' });
  });
});

describe('WRITE_DENY coverage — every class the sweep must not write', () => {
  it.each([
    ['/api/approvals/abc/decision', 'approvals-separately-gated'],
    ['/api/approvals', 'approvals-separately-gated'],
    ['/api/admin/tenants', 'tenant-administration'],
    ['/api/admin/tenants/t1', 'tenant-administration'],
    ['/api/secrets', 'secret-material'],
    ['/api/secrets/rotate', 'secret-material'],
    ['/api/budgets/2026', 'budget-mutation'],
    ['/api/licenses/abc', 'licensing-mutation'],
    ['/api/licences/abc', 'licensing-mutation'],
    ['/api/license/status', 'licensing-mutation'],
    ['/api/metering/events', 'metering-writes-are-billing'],
    ['/api/tools/n8n/executions', 'triggers-external-execution'],
    ['/api/procedures/1/execute', 'triggers-external-execution'],
    ['/api/jobs/dispatch', 'triggers-external-execution'],
    ['/api/workflows/1/trigger', 'triggers-external-execution'],
    ['/api/webhooks/inbound', 'triggers-external-execution'],
    ['/api/cards/bulk', 'fans-out-to-many-rows'],
    ['/api/cards/batch/update', 'fans-out-to-many-rows'],
  ])('POST %s is denied in write-pass as %s', (path, why) => {
    expect(classifyRequest({ method: 'POST', url: `${APP}${path}`, mode: 'write-pass' })).toEqual({
      action: 'abort',
      reason: why,
    });
  });
});

describe('WRITE_DENY hygiene', () => {
  it('no pattern carries the global flag', () => {
    // A `g` RegExp keeps lastIndex between .test() calls, so the SECOND request
    // matched against it returns false and is FORWARDED. The deny-list would
    // work once per pattern per process and then silently stop.
    for (const entry of WRITE_DENY) {
      expect(entry.pattern.global).toBe(false);
      expect(entry.pattern.sticky).toBe(false);
    }
  });

  it('every entry carries a short, non-empty reason', () => {
    for (const entry of WRITE_DENY) {
      expect(entry.why.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeLessThanOrEqual(40);
    }
  });

  it('reasons are unique, so an abort names ONE rule', () => {
    const whys = WRITE_DENY.map((e) => e.why);
    expect(new Set(whys).size).toBe(whys.length);
  });

  it('no pattern is a blanket that denies everything', () => {
    // A lazily-widened pattern (`/api/`, or a bare `.*`) would make write-pass
    // identical to read mode while still reading as a considered list.
    for (const entry of WRITE_DENY) {
      expect(entry.pattern.test('/api/procedures')).toBe(false);
      expect(entry.pattern.test('/api/projects')).toBe(false);
      expect(entry.pattern.test('/')).toBe(false);
    }
  });

  it('the bulk/batch rule is anchored to a whole segment', () => {
    // `/api/bulkhead` is not a bulk operation. Narrowness here is what keeps
    // the list credible enough that nobody deletes an entry to stop the noise.
    expect(
      classifyRequest({ method: 'POST', url: `${APP}/api/bulkhead`, mode: 'write-pass' }),
    ).toEqual({ action: 'forward' });
  });

  it('the list is not empty', () => {
    expect(WRITE_DENY.length).toBeGreaterThanOrEqual(8);
  });
});

describe('decision shape', () => {
  it('a forward carries no reason and an abort always does', () => {
    const fwd = classifyRequest({ method: 'GET', url: `${APP}/api/projects`, mode: 'read' });
    expect(fwd).toEqual({ action: 'forward' });
    expect('reason' in fwd).toBe(false);

    const abort = classifyRequest({ method: 'POST', url: `${APP}/api/projects`, mode: 'read' });
    expect(abort.action).toBe('abort');
    expect(typeof (abort as { reason: string }).reason).toBe('string');
    expect((abort as { reason: string }).reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2b (IdP) and the asset hosts. BOTH were added after a measured failure:
// the first live run swept 0 of 168 routes because keycloak-js's token POST was
// refused as a write, and every clipping number would have been an artefact
// because the webfont never loaded. These tests exist so the two allowances
// cannot silently widen into "POST is fine on the auth host" or "any CDN".
// ---------------------------------------------------------------------------
describe('rule 2b — the OIDC code exchange is authentication, not a write', () => {
  const TOKEN = 'https://auth.nonagentic.ai/realms/portal/protocol/openid-connect/token';

  it('forwards the token POST in read mode — without it the app never authenticates', () => {
    expect(classifyRequest({ method: 'POST', url: TOKEN, mode: 'read' })).toEqual({ action: 'forward' });
  });

  it('forwards the token POST in interact and write-pass too', () => {
    expect(classifyRequest({ method: 'POST', url: TOKEN, mode: 'interact' }).action).toBe('forward');
    expect(classifyRequest({ method: 'POST', url: TOKEN, mode: 'write-pass' }).action).toBe('forward');
  });

  it('forwards the logout endpoint, which is the same path shape', () => {
    const logout = 'https://auth.nonagentic.ai/realms/portal/protocol/openid-connect/logout';
    expect(classifyRequest({ method: 'POST', url: logout, mode: 'read' }).action).toBe('forward');
  });

  it('⭐ does NOT widen to the rest of the IdP — a Keycloak ADMIN write is still refused', () => {
    const admin = 'https://auth.nonagentic.ai/admin/realms/portal/users';
    const d = classifyRequest({ method: 'POST', url: admin, mode: 'read' });
    expect(d.action).toBe('abort');
    expect(d.action === 'abort' && d.reason).toBe('write-blocked-in-read-mode');
  });

  it('⭐ the path allowance does not TRAVEL to another host', () => {
    const spoof = 'https://fr.nonagentic.ai/realms/portal/protocol/openid-connect/token';
    expect(classifyRequest({ method: 'POST', url: spoof, mode: 'read' }).action).toBe('abort');
  });
});

describe('asset hosts — readable so the layout is real, writable never', () => {
  it('forwards a stylesheet GET from the font CDN', () => {
    const css = 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400';
    expect(classifyRequest({ method: 'GET', url: css, mode: 'read' })).toEqual({ action: 'forward' });
  });

  it('forwards the font file GET from the font file host', () => {
    const woff = 'https://fonts.gstatic.com/s/fraunces/v31/some.woff2';
    expect(classifyRequest({ method: 'GET', url: woff, mode: 'read' }).action).toBe('forward');
  });

  it('⭐ refuses ANY write to an asset host, in every mode, with its own reason', () => {
    for (const mode of ['read', 'interact', 'write-pass'] as const) {
      const d = classifyRequest({ method: 'POST', url: 'https://fonts.googleapis.com/x', mode });
      expect(d.action, `mode ${mode}`).toBe('abort');
      expect(d.action === 'abort' && d.reason, `mode ${mode}`).toBe('write-to-asset-host');
    }
  });

  it('⭐ does not admit CDNs in general — an unlisted one is still refused', () => {
    const other = 'https://cdn.jsdelivr.net/npm/thing/dist.js';
    expect(classifyRequest({ method: 'GET', url: other, mode: 'read' }).action).toBe('abort');
  });

  it('a look-alike of an asset host is refused (suffix match would admit it)', () => {
    const evil = 'https://fonts.googleapis.com.evil.test/css2';
    expect(classifyRequest({ method: 'GET', url: evil, mode: 'read' }).action).toBe('abort');
  });
});
