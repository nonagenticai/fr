// Unit tests for the package-license gate decision logic (two exemption axes).
//
// Axis 1 (route): platform-global / SPA-bootstrap routes are exempt regardless
//   of tenant.
// Axis 2 (tenant): internal platform tenants (system) are not
//   licensable fr/kag customers, so any route is exempt for them — this is what
//   lets a super-admin operate the system workspace without fr_license_required.
// Plus the DEPLOYMENT-scoped app-key resolution (servingAppKey / resolveAppKey)
// and the single decision seam (packageGateDecision).

import { describe, expect, test } from 'bun:test';

import {
  isPackageLicenseExempt,
  isRouteExempt,
  packageGateDecision,
  packageRequestView,
  resolveAppKey,
  sanitizeHeaderForLog,
  servingAppKey,
  type PackageGateFlags,
} from '../../../src/lib/package-license-gate';
import {
  INTERNAL_SYSTEM_TENANT_ID,
  EXECUTION_TENANT_ID,
} from '../../../src/middleware/internal-tenant-only';

const CUSTOMER_TENANT = '0190b6a0-0000-7000-8000-0000000000aa'; // a normal, non-internal tenant

describe('isRouteExempt (axis 1)', () => {
  test('exempt prefixes', () => {
    expect(isRouteExempt('/api/auth/me')).toBe(true);
    expect(isRouteExempt('/api/me/workspaces')).toBe(true);
    expect(isRouteExempt('/api/webhooks/n8n')).toBe(true);
    expect(isRouteExempt('/api/internal/andon')).toBe(true);
    expect(isRouteExempt('/api/admin/pricing/provider-pricing')).toBe(true);
    expect(isRouteExempt('/api/admin/pricing/markup-rules')).toBe(true);
  });

  test('exact-match exemptions', () => {
    expect(isRouteExempt('/api/license/status')).toBe(true);
    expect(isRouteExempt('/api/project-requests')).toBe(true);
  });

  test('non-exempt routes — incl. other /api/admin/* which stay tenant-gated', () => {
    expect(isRouteExempt('/api/cards')).toBe(false);
    expect(isRouteExempt('/api/andon')).toBe(false);
    expect(isRouteExempt('/api/admin/departments')).toBe(false);
    expect(isRouteExempt('/api/admin/assets/projects')).toBe(false);
    // /api/project-requests is exact-exempt but a sub-path is not.
    expect(isRouteExempt('/api/project-requests/abc/approve')).toBe(false);
  });
});

describe('isPackageLicenseExempt (axes 1 + 2 combined)', () => {
  test('internal platform tenants are exempt on ANY route (axis 2)', () => {
    // The regression this fix targets: super-admin on the system workspace
    // hitting the global app shell (andon, kanban liveness, cards).
    expect(isPackageLicenseExempt('/api/andon', INTERNAL_SYSTEM_TENANT_ID)).toBe(true);
    expect(isPackageLicenseExempt('/api/cards', INTERNAL_SYSTEM_TENANT_ID)).toBe(true);
    expect(isPackageLicenseExempt('/api/kanban/boards', INTERNAL_SYSTEM_TENANT_ID)).toBe(true);
    // The deleted prompt-improvement tenant (2026-11-03) is no longer internal: gated.
    expect(isPackageLicenseExempt('/api/kanban/boards', '0195f48b-d000-7000-8000-000000000004')).toBe(false);
  });

  test('a non-exempt route on a normal customer tenant is NOT exempt (gate runs)', () => {
    expect(isPackageLicenseExempt('/api/andon', CUSTOMER_TENANT)).toBe(false);
    expect(isPackageLicenseExempt('/api/cards', CUSTOMER_TENANT)).toBe(false);
  });

  test('the execution tenant is NOT internal — it stays gated (should be licensed)', () => {
    expect(isPackageLicenseExempt('/api/cards', EXECUTION_TENANT_ID)).toBe(false);
  });

  test('route exemption still applies regardless of tenant (axis 1)', () => {
    expect(isPackageLicenseExempt('/api/admin/pricing/provider-pricing', CUSTOMER_TENANT)).toBe(true);
    expect(isPackageLicenseExempt('/api/me/workspaces', CUSTOMER_TENANT)).toBe(true);
  });

  test('null / undefined tenant on a non-exempt route is not tenant-exempt', () => {
    // The falsy-tenant no-op lives in requireFrLicense; the predicate just says
    // "not exempt by either axis here".
    expect(isPackageLicenseExempt('/api/cards', null)).toBe(false);
    expect(isPackageLicenseExempt('/api/cards', undefined)).toBe(false);
  });
});

// Deployment shapes. These are the ONLY two that exist in prod: one image, and
// each Deployment sets exactly one gate flag.
const FR_DEPLOYMENT: PackageGateFlags = { fr: true, kag: false };
const KAG_DEPLOYMENT: PackageGateFlags = { fr: false, kag: true };
const UNGATED: PackageGateFlags = { fr: false, kag: false }; // dev / CI
const BOTH_ON: PackageGateFlags = { fr: true, kag: true };

const reqWith = (h?: Record<string, string>, path = '/api/cards') =>
  new Request(`https://fr-backend.example.com${path}`, { headers: h });

// Absolute path to backend/src — used by the two source-level guards below
// (the PACKAGE_APP_KEY scan and the /api/license/status wiring guard).
const SRC_DIR = new URL('../../../src', import.meta.url).pathname;
const SERVER_SRC = await Bun.file(`${SRC_DIR}/server.ts`).text();

describe('servingAppKey — the product is a DEPLOYMENT fact, not a request one', () => {
  test('derived from whichever gate is enabled', () => {
    expect(servingAppKey(FR_DEPLOYMENT)).toBe('fr');
    expect(servingAppKey(KAG_DEPLOYMENT)).toBe('kag');
  });

  test('both-off and both-on fall back to fr (the historical default)', () => {
    expect(servingAppKey(UNGATED)).toBe('fr');
    expect(servingAppKey(BOTH_ON)).toBe('fr');
  });

  // ⛔ INVERTED. This describe used to assert `servingAppKey(FR_DEPLOYMENT,
  // 'kag') === 'kag'` — i.e. it PINNED an env override that won over the flags
  // with no cross-check. `PACKAGE_APP_KEY=kag` on the fr Deployment (which sets
  // FR_LICENSE_GATE_ENABLED=true) therefore resolved every request to the kag
  // branch, whose flag is off there, so packageGateDecision returned 'skip' for
  // every tenant on every route: a silent, fleet-wide gate kill-switch, no boot
  // log and no 403. It was set nowhere in gitops. The parameter is deleted.
  test('THE KILL-SWITCH IS GONE: the derivation takes ONLY the flags', () => {
    expect(servingAppKey.length).toBe(1);
  });

  test('no source file reads PACKAGE_APP_KEY / config.packageAppKey any more', async () => {
    // Arity alone would be satisfied by re-reading the env inside the function
    // or re-adding a config field consumed at the call site. This closes both.
    const offenders: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const rel of glob.scan({ cwd: SRC_DIR })) {
      const text = await Bun.file(`${SRC_DIR}/${rel}`).text();
      if (/process\.env\.PACKAGE_APP_KEY/.test(text) || /config\.packageAppKey/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Rewritten from the old `describe('appKeyOf')`, which pinned the bug: it
// asserted a client-supplied `X-App-Key: kag` yields 'kag' with NO reference to
// which product the deployment actually gates. The rule is now CONFIRM-ONLY and
// the gate flags are not even a parameter — the header can only agree with the
// serving key or be ignored.
describe('resolveAppKey — a client header may only CONFIRM the served product', () => {
  describe('on the fr deployment (FR_LICENSE_GATE_ENABLED=true only)', () => {
    const resolve = (h?: Record<string, string>) => resolveAppKey(reqWith(h), 'fr');

    test('THE DEFECT: X-App-Key: kag must NOT select the ungated kag branch', () => {
      expect(resolve({ 'x-app-key': 'kag' }).appKey).toBe('fr');
    });

    test('case-insensitively so — KAG is the same claim', () => {
      expect(resolve({ 'x-app-key': 'KAG' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': 'Kag' }).appKey).toBe('fr');
    });

    test('no header → the serving key', () => {
      expect(resolve().appKey).toBe('fr');
      expect(resolve({ 'x-app-key': '' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': '   ' }).appKey).toBe('fr');
    });

    test('the value is TRIMMED before it is compared', () => {
      // ⚠️ TWO reasons the obvious version of this test is decorative, both of
      // which the predecessor (`resolve({'x-app-key':'   '}).appKey === 'fr'`)
      // fell into:
      //   1. ASCII padding is invisible here. WHATWG Headers already strips
      //      leading/trailing HTTP whitespace (SP/TAB/CR/LF) on construction, so
      //      `'  fr  '` is ALREADY 'fr' before resolveAppKey sees it — asserted
      //      below so the assumption is pinned rather than assumed.
      //   2. `appKey` is invisible here. Under confirm-only every value on this
      //      deployment resolves to 'fr' whether it matched or not; only the
      //      REPORTING channel distinguishes "confirmed" from "rejected".
      // U+00A0 is what actually discriminates: it is NOT HTTP whitespace, so it
      // survives the Headers normalisation, but String.trim() strips it. Drop
      // the .trim() and this padded-but-legitimate header starts writing a warn
      // line per request on an unauthenticated path.
      expect(reqWith({ 'x-app-key': '  fr  ' }).headers.get('x-app-key')).toBe('fr');
      expect(reqWith({ 'x-app-key': '\u00a0fr' }).headers.get('x-app-key')).toBe('\u00a0fr');
      expect(resolve({ 'x-app-key': '\u00a0fr' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': '\u00a0fr' }).rejectedHeaderForLog).toBeUndefined();
      expect(resolve({ 'x-app-key': 'fr\u00a0' }).rejectedHeaderForLog).toBeUndefined();
    });

    test('garbage → the serving key, never a throw', () => {
      expect(() => resolve({ 'x-app-key': 'coding' })).not.toThrow();
      expect(resolve({ 'x-app-key': 'coding' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': '../../etc/passwd' }).appKey).toBe('fr');
    });

    test('the rejected value is reported SANITISED — this path is unauthenticated', () => {
      // The header is recorded nowhere else today; this is the only signal that
      // someone is probing for the sibling product's gate. But it is
      // attacker-controlled text on a route reachable WITHOUT credentials, and
      // it lands in console.warn → stdout → Loki. Interpolating it verbatim
      // (what this test used to assert) is an unauthenticated log-write
      // primitive: ~8 KB per request plus newline log-injection. The value is
      // sanitised HERE, so the raw string never leaves this module and no log
      // site can get it wrong.
      expect(resolve({ 'x-app-key': 'kag' }).rejectedHeaderForLog).toBe('"kag"');
      expect(resolve({ 'x-app-key': 'KAG' }).rejectedHeaderForLog).toBe('"KAG"');
      expect(resolve({ 'x-app-key': 'coding' }).rejectedHeaderForLog).toBe('"coding"');
    });

    test('an oversized header is TRUNCATED, not echoed', () => {
      const huge = 'z'.repeat(8192);
      const reported = resolve({ 'x-app-key': huge }).rejectedHeaderForLog;
      expect(reported).toBeDefined();
      expect(reported!.length).toBeLessThanOrEqual(40);
      expect(reported!.length).toBeLessThan(huge.length);
    });

    test('legit traffic is NOT reported — no header, and the serving key itself', () => {
      expect(resolve().rejectedHeaderForLog).toBeUndefined();
      expect(resolve({ 'x-app-key': 'fr' }).rejectedHeaderForLog).toBeUndefined();
      expect(resolve({ 'x-app-key': 'FR' }).rejectedHeaderForLog).toBeUndefined();
      expect(resolve({ 'x-app-key': 'fr' }).appKey).toBe('fr');
    });
  });

  describe('sanitizeHeaderForLog — the log-injection half', () => {
    test('control characters are escaped, so no forged log record can be written', () => {
      // Headers() rejects a raw newline, so the injection payload is exercised
      // against the sanitiser directly — it is the function that must hold.
      const injected = 'kag"\n[package-gate] serving=kag path=/api/cards';
      const out = sanitizeHeaderForLog(injected);
      expect(out).not.toContain('\n');
      expect(out).not.toContain('\r');
      expect(sanitizeHeaderForLog('a\r\nb')).toBe('"a\\r\\nb"');
    });

    test('output is hard-capped at 40 characters', () => {
      expect(sanitizeHeaderForLog('z'.repeat(10_000)).length).toBe(40);
    });
  });

  describe('on the kag deployment (KAG_LICENSE_GATE_ENABLED=true only)', () => {
    const resolve = (h?: Record<string, string>) => resolveAppKey(reqWith(h), 'kag');

    test('THE MIRROR DEFECT: NO header must resolve to kag, not fr', () => {
      // The worse half: the old appKeyOf returned 'fr' for any value that was
      // not exactly 'kag' — INCLUDING an absent header — and the fr gate is off
      // on this deployment, so any in-mesh caller sending nothing was ungated.
      expect(resolve().appKey).toBe('kag');
      expect(resolve({ 'x-app-key': '' }).appKey).toBe('kag');
    });

    test('X-App-Key: fr must NOT select the ungated fr branch', () => {
      expect(resolve({ 'x-app-key': 'fr' }).appKey).toBe('kag');
      expect(resolve({ 'x-app-key': 'FR' }).appKey).toBe('kag');
      expect(resolve({ 'x-app-key': 'fr' }).rejectedHeaderForLog).toBe('"fr"');
    });

    test('X-App-Key: kag still works — legit edge traffic is unaffected', () => {
      // The only thing confirm-only costs: this must keep resolving to kag, and
      // silently. It does, via `requested === serving`.
      expect(resolve({ 'x-app-key': 'kag' }).appKey).toBe('kag');
      expect(resolve({ 'x-app-key': 'KAG' }).appKey).toBe('kag');
      expect(resolve({ 'x-app-key': '\u00a0kag\u00a0' }).appKey).toBe('kag');
      expect(resolve({ 'x-app-key': 'kag' }).rejectedHeaderForLog).toBeUndefined();
      // U+00A0 padding — NOT HTTP whitespace, so it survives the Headers
      // normalisation and only String.trim() removes it. This is the assertion
      // that dies if the trim goes; a plain ' kag ' would not, WHATWG Headers
      // having already stripped that before resolveAppKey ever sees it.
      expect(resolve({ 'x-app-key': '\u00a0kag\u00a0' }).rejectedHeaderForLog).toBeUndefined();
    });

    test('garbage → kag', () => {
      expect(resolve({ 'x-app-key': 'coding' }).appKey).toBe('kag');
    });
  });

  // ⛔ INVERTED. This describe used to assert that with BOTH gates on a header
  // could legitimately pick either product ("both are gated here, so neither
  // selection skips a check"). That blesses a hole strictly worse than the one
  // the branch closes: `gates.kag === true` is evidence that SOMEONE is entitled
  // to kag, never that THIS caller is. A tenant holding kag but not fr — a real,
  // named population (the kag-frontend-only users) — could send `X-App-Key: kag`
  // and be checked ONLY against kag while walking into every fr route. And
  // multi-flag-on is the prescribed future shape for a shared deployment, so it
  // would be the default posture rather than an edge case.
  describe('with BOTH gates on, the header STILL cannot change the product', () => {
    const resolve = (h?: Record<string, string>) => resolveAppKey(reqWith(h), 'fr');

    test('a kag header on an fr-serving deployment is REJECTED, gates or no gates', () => {
      expect(resolve({ 'x-app-key': 'kag' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': 'KAG' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': 'kag' }).rejectedHeaderForLog).toBe('"kag"');
    });

    test('and the enforced check is the SERVED product, not the requested one', () => {
      // The end-to-end statement: an fr-serving deployment with kag also gated
      // must still demand the FR licence from a caller asking for kag.
      const { appKey } = resolve({ 'x-app-key': 'kag' });
      expect(packageGateDecision(appKey, '/api/cards', CUSTOMER_TENANT, BOTH_ON))
        .toBe('require-fr');
    });

    test('the serving key itself still confirms, silently', () => {
      expect(resolve({ 'x-app-key': 'fr' }).appKey).toBe('fr');
      expect(resolve({ 'x-app-key': 'fr' }).rejectedHeaderForLog).toBeUndefined();
      expect(resolve().appKey).toBe('fr');
    });
  });
});

describe('packageGateDecision — the single decision seam', () => {
  test('fr deployment: a forged X-App-Key: kag still requires the FR licence', () => {
    // The end-to-end statement of the defect: resolution + decision together.
    const { appKey } = resolveAppKey(reqWith({ 'x-app-key': 'kag' }), 'fr');
    expect(packageGateDecision(appKey, '/api/cards', CUSTOMER_TENANT, FR_DEPLOYMENT))
      .toBe('require-fr');
  });

  test('kag deployment: no header requires the KAG licence', () => {
    const { appKey } = resolveAppKey(reqWith(), 'kag');
    expect(packageGateDecision(appKey, '/api/cards', CUSTOMER_TENANT, KAG_DEPLOYMENT))
      .toBe('require-kag');
  });

  test('kag deployment: X-App-Key: kag requires the KAG licence', () => {
    const { appKey } = resolveAppKey(reqWith({ 'x-app-key': 'kag' }), 'kag');
    expect(packageGateDecision(appKey, '/api/cards', CUSTOMER_TENANT, KAG_DEPLOYMENT))
      .toBe('require-kag');
  });

  test('ZERO BLAST RADIUS: with both gates off EVERY combination skips', () => {
    // A disabled flag is a rollout lever, never a DENY. Dev, CI,
    // and tests/integration/prod-boot-shape.integration.test.ts all run with
    // both flags off and must be byte-for-byte unchanged.
    for (const appKey of ['fr', 'kag'] as const) {
      for (const path of ['/api/cards', '/api/andon', '/api/auth/me', '/api/me/workspaces']) {
        for (const tenant of [CUSTOMER_TENANT, INTERNAL_SYSTEM_TENANT_ID, null, undefined]) {
          expect(packageGateDecision(appKey, path, tenant, UNGATED)).toBe('skip');
        }
      }
    }
  });

  test('a single disabled flag still skips its own product (rollout lever, not DENY)', () => {
    // On the fr deployment kag is off; a kag decision must skip, not 403.
    expect(packageGateDecision('kag', '/api/cards', CUSTOMER_TENANT, FR_DEPLOYMENT))
      .toBe('skip');
    expect(packageGateDecision('fr', '/api/cards', CUSTOMER_TENANT, KAG_DEPLOYMENT))
      .toBe('skip');
  });

  test('route exemptions still short-circuit (axis 1)', () => {
    expect(packageGateDecision('fr', '/api/auth/me', CUSTOMER_TENANT, FR_DEPLOYMENT))
      .toBe('skip');
    expect(packageGateDecision('fr', '/api/me/workspaces', CUSTOMER_TENANT, FR_DEPLOYMENT))
      .toBe('skip');
    expect(packageGateDecision(
      'fr', '/api/admin/pricing/provider-pricing', CUSTOMER_TENANT, FR_DEPLOYMENT,
    )).toBe('skip');
    expect(packageGateDecision('kag', '/api/auth/me', CUSTOMER_TENANT, KAG_DEPLOYMENT))
      .toBe('skip');
  });

  test('internal platform tenants still short-circuit on ANY route (axis 2)', () => {
    expect(packageGateDecision('fr', '/api/cards', INTERNAL_SYSTEM_TENANT_ID, FR_DEPLOYMENT))
      .toBe('skip');
    expect(packageGateDecision('kag', '/api/cards', INTERNAL_SYSTEM_TENANT_ID, KAG_DEPLOYMENT))
      .toBe('skip');
  });

  test('the execution tenant stays gated — it is not internal', () => {
    expect(packageGateDecision('fr', '/api/cards', EXECUTION_TENANT_ID, FR_DEPLOYMENT))
      .toBe('require-fr');
  });

  test('a null / undefined tenant on a GATED deployment still returns require-*', () => {
    // ⚠️ The only null-tenant cells previously asserted lived inside the UNGATED
    // loop, where EVERY answer is 'skip' by construction — so they could not
    // distinguish this implementation from `() => 'skip'`. This is the cell that
    // can: the tenant axis must NOT swallow the decision here. The falsy-tenant
    // no-op is deliberately downstream, in requireFrLicense / requireKagLicense
    // (`if (!tenantId) return;`), because that is where AUTH_BYPASS and the
    // gate-flag no-op also live. Do not "optimise" it up into this seam.
    expect(packageGateDecision('fr', '/api/cards', null, FR_DEPLOYMENT)).toBe('require-fr');
    expect(packageGateDecision('fr', '/api/cards', undefined, FR_DEPLOYMENT)).toBe('require-fr');
    expect(packageGateDecision('kag', '/api/cards', null, KAG_DEPLOYMENT)).toBe('require-kag');
    expect(packageGateDecision('kag', '/api/cards', undefined, KAG_DEPLOYMENT)).toBe('require-kag');
  });
});

// ---------------------------------------------------------------------------
// The status probe and the enforcer must agree — and the wiring that makes them
// agree must be pinned.
//
// `/api/license/status` had ZERO test protection: an adversarial verifier
// reverted the endpoint to the pre-fix, header-trusting shape and to a
// hardcoded SERVING_APP_KEY, and both `tsc --noEmit` and the whole suite stayed
// green. No test referenced the status handler, `SERVING_APP_KEY` or
// `PACKAGE_GATES` at all. That is load-bearing: the post-merge live proof drives
// `/api/license/status`, so an untested divergence would let that probe certify
// a fix that is not in the enforcer.
// ---------------------------------------------------------------------------

/** Every header variant an in-mesh caller can put on the wire. */
const HEADER_VARIANTS: ReadonlyArray<readonly [string, Record<string, string> | undefined]> = [
  ['absent', undefined],
  ['empty', { 'x-app-key': '' }],
  ['whitespace', { 'x-app-key': '   ' }],
  ['fr', { 'x-app-key': 'fr' }],
  ['FR', { 'x-app-key': 'FR' }],
  ['padded fr', { 'x-app-key': ' fr ' }],
  ['kag', { 'x-app-key': 'kag' }],
  ['KAG', { 'x-app-key': 'KAG' }],
  ['padded kag', { 'x-app-key': ' kag ' }],
  ['coding', { 'x-app-key': 'coding' }],
  ['traversal', { 'x-app-key': '../../etc/passwd' }],
  ['oversized', { 'x-app-key': 'z'.repeat(8192) }],
];

const SHAPES: ReadonlyArray<readonly [string, PackageGateFlags]> = [
  ['FR_DEPLOYMENT', FR_DEPLOYMENT],
  ['KAG_DEPLOYMENT', KAG_DEPLOYMENT],
  ['BOTH_ON', BOTH_ON],
  ['UNGATED', UNGATED],
];

describe('packageRequestView — one derivation for the probe AND the enforcer', () => {
  test('gateEnabled is EXACTLY "the enforcer will check something" on every cell', () => {
    // If these two can drift, /api/license/status can report gateEnabled:false
    // (SPA renders "no gate") while the enforcer 403s, or the reverse — the SPA
    // shows a licence wall the gate is not actually applying.
    for (const [shapeName, gates] of SHAPES) {
      const serving = servingAppKey(gates);
      for (const [variantName, headers] of HEADER_VARIANTS) {
        const view = packageRequestView(reqWith(headers), gates, serving);
        const decision = packageGateDecision(
          view.appKey, '/api/cards', CUSTOMER_TENANT, gates,
        );
        expect(
          `${shapeName}/${variantName}: gateEnabled=${view.gateEnabled} decision=${decision}`,
        ).toBe(
          `${shapeName}/${variantName}: gateEnabled=${decision !== 'skip'} decision=${decision}`,
        );
      }
    }
  });

  test('ENUMERATION: no cell is ungated or wrong-product — including BOTH_ON', () => {
    // shapes × header variants, on the non-exempt route /api/cards with a normal
    // customer tenant. Two claims per cell:
    //   1. appKey is ALWAYS the deployment's serving key — the header can never
    //      move it. (The pre-fix code failed this for FR/kag and KAG/absent; the
    //      first fix attempt failed it for BOTH_ON/kag.)
    //   2. the decision is the serving product's require-*, unless the
    //      deployment gates nothing at all (UNGATED — the rollout lever).
    const cells: string[] = [];
    for (const [shapeName, gates] of SHAPES) {
      const serving = servingAppKey(gates);
      const expected = gates.fr || gates.kag
        ? (serving === 'fr' ? 'require-fr' : 'require-kag')
        : 'skip';
      for (const [variantName, headers] of HEADER_VARIANTS) {
        const view = packageRequestView(reqWith(headers), gates, serving);
        const decision = packageGateDecision(
          view.appKey, '/api/cards', CUSTOMER_TENANT, gates,
        );
        cells.push(`${shapeName}/${variantName} -> ${view.appKey}/${decision}`);
        expect(`${shapeName}/${variantName} -> ${view.appKey}`)
          .toBe(`${shapeName}/${variantName} -> ${serving}`);
        expect(`${shapeName}/${variantName} -> ${decision}`)
          .toBe(`${shapeName}/${variantName} -> ${expected}`);
      }
    }
    // Every cell of a gated shape enforces; the only 'skip' cells are UNGATED's.
    expect(cells).toHaveLength(SHAPES.length * HEADER_VARIANTS.length);
    expect(cells.filter((c) => c.endsWith('/skip')).every((c) => c.startsWith('UNGATED/')))
      .toBe(true);
    expect(cells.filter((c) => c.startsWith('UNGATED/'))).toHaveLength(HEADER_VARIANTS.length);
  });

  test('a rejected header reaches the view already sanitised', () => {
    const view = packageRequestView(reqWith({ 'x-app-key': 'kag' }), FR_DEPLOYMENT, 'fr');
    expect(view.rejectedHeaderForLog).toBe('"kag"');
  });
});

describe('server.ts wiring — the status probe cannot diverge from the enforcer', () => {
  // A lib-only test cannot see either mutation: both live in server.ts. These
  // guards are what go RED. Each pins a semantic invariant, not formatting.
  const serverSrc = SERVER_SRC;

  test('server.ts never reads the X-App-Key header itself', () => {
    // MUTATION 1: reverting /api/license/status to
    //   (req.headers.get('x-app-key')||'').toLowerCase()==='kag' ? 'kag' : 'fr'
    // reintroduces exactly this. resolveAppKey is the ONLY reader of that header
    // in the codebase.
    expect(serverSrc).not.toMatch(/headers\s*\.\s*get\(\s*['"`][Xx]-[Aa]pp-[Kk]ey['"`]\s*\)/);
  });

  test('SERVING_APP_KEY is DERIVED from the gate flags, never a literal', () => {
    // MUTATION 2: `const SERVING_APP_KEY: AppKey = 'fr'` — which silently pins
    // the kag deployment to fr and re-opens the ungated sibling.
    expect(serverSrc).toMatch(/const SERVING_APP_KEY = servingAppKey\(PACKAGE_GATES\);/);
  });

  test('/api/license/status derives (appKey, gateEnabled) from the shared view', () => {
    // Both mutations replace this line. Nothing else in server.ts may recompute
    // gateEnabled from PACKAGE_GATES.
    expect(serverSrc).toMatch(
      /const \{ appKey, gateEnabled \} = packageViewFor\(req, url\.pathname, ctx\.correlationId\);/,
    );
    expect(serverSrc).not.toMatch(/gateEnabled\s*=\s*appKey === ['"]kag['"]/);
  });

  test('the enforcer takes its app key from the SAME derivation', () => {
    expect(serverSrc).toMatch(
      /enforcePackageLicense\(\s*\n\s*packageViewFor\(req, url\.pathname, ctx\.correlationId\)\.appKey,/,
    );
  });

  test('the [package-gate] warn interpolates only the pre-sanitised value', () => {
    // CHANGE 4: this warn is reachable unauthenticated. The raw header must
    // never appear in it — the sanitising is done in the lib so it cannot be.
    const warn = serverSrc.match(/\[package-gate\] ignored client[^;]*;/s);
    expect(warn).not.toBeNull();
    expect(warn![0]).toContain('view.rejectedHeaderForLog');
    expect(warn![0]).not.toMatch(/\brejectedHeader\b(?!ForLog)/);
  });
});
