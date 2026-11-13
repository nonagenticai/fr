// e2e/lanes/sweep/live-guard.ts
//
// THE SAFETY CONTROL FOR THE PRODUCTION ROUTE SWEEP.
//
// The sweep walks 168 routes against LIVE https://fr.nonagentic.ai while
// authenticated as a `super_admin`. That session can decide an approval, void a
// licence, rewrite a tenant, or fire an n8n workflow — with no tenant scoping
// to blunt the blast radius, because super_admin has none. This module is the
// single place that decides whether a request the browser is about to make is
// allowed to leave the machine. Every arm FAILS CLOSED: anything it cannot
// positively recognise as safe is aborted.
//
// ⛔ WHAT WOULD MAKE THIS FILE'S TESTS GREEN WHILE THE SWEEP IS STILL UNSAFE.
// Read this before trusting a green run:
//
//  1. THIS MODULE CLASSIFIES; IT DOES NOT ENFORCE. Green here proves the
//     decision function is correct, never that the sweep CALLS it, that the
//     `page.route()` handler is registered on `'**/*'` before the first
//     navigation, or that an `abort` decision is turned into `route.abort()`
//     rather than logged. A sweep that imports this and forgets to wire it is
//     indistinguishable from a sweep that wires it — from here.
//  2. IT ONLY SEES WHAT PLAYWRIGHT ROUTES. Requests a service worker replays,
//     a `navigator.sendBeacon` on unload, a WebSocket frame, or anything issued
//     from a context without the handler installed never reaches this function.
//     Those are unguarded and this file cannot tell you so.
//  3. IT JUDGES THE REQUEST, NOT THE EFFECT. A benign-looking POST whose
//     backend handler internally fans out to an approval decide is forwarded.
//     WRITE_DENY is a deny-list over an ALLOW-BY-DEFAULT write mode: any
//     destructive endpoint nobody enumerated below is forwarded in
//     `write-pass`. The read-only modes carry the real guarantee; `write-pass`
//     is only ever as good as this list.
//  4. A GREEN SUITE SAYS NOTHING ABOUT THE MODE THE SWEEP ACTUALLY PASSES.
//     `write-pass` is a deliberate, per-run decision. Defaulting it anywhere is
//     the defect this file cannot see.
//
// TWO DELIBERATE EXTENSIONS beyond the stated rules, both strictly stricter,
// both reported under rule 1's reason because they mean "this URL is not one
// this sweep may address":
//   - `https:` is required. A plaintext `http://` request to an allowed host
//     would carry the super_admin bearer token in the clear.
//   - The pathname must decode. `%61pprovals` is `approvals` to the server but
//     not to a regex over the raw pathname, so a URL whose escapes cannot be
//     decoded is refused rather than matched half-blind. Deny patterns are
//     tested against BOTH the raw and the decoded pathname.

export type SweepMode = 'read' | 'interact' | 'write-pass';

export type Decision = { action: 'forward' } | { action: 'abort'; reason: string };

/**
 * The only two hosts the sweep may address: the app itself and the Keycloak
 * realm it authenticates against. Compared as a WHOLE, case-insensitive
 * hostname — never as a suffix, so `fr.nonagentic.ai.evil.test` is refused.
 */
export const ALLOWED_HOSTS: readonly string[] = ['fr.nonagentic.ai', 'auth.nonagentic.ai'];

/**
 * The IdP host, and the ONLY path prefix on it at which a non-GET is permitted.
 *
 * ⭐ MEASURED 2026-09-10: without this, the sweep swept NOTHING — 0 of 168
 * routes, four shards, ~180 aborts each. keycloak-js completes the
 * authorization-code flow by POSTing to
 * `/realms/portal/protocol/openid-connect/token`, and rule 3 refused it as a
 * write. Every route then bounced back to login and died with "Execution
 * context was destroyed, most likely because of a navigation".
 *
 * That POST is an AUTHENTICATION MECHANIC, not a data write: it exchanges a
 * code the IdP itself just issued. The allowance is deliberately double-scoped
 * — this exact host AND this path shape — so it can never widen into "POST is
 * fine on the auth host".
 */
const IDP_HOST = 'auth.nonagentic.ai';
const IDP_WRITE_PATH = /^\/realms\/[^/]+\/protocol\/openid-connect\//;

/**
 * Hosts allowed for GET/HEAD ONLY — never for any write, in any mode.
 *
 * ⚠️ Blocking these is not cosmetic. This sweep MEASURES horizontal clipping,
 * and clipping is a function of rendered text width. A page that fell back from
 * Fraunces to the system font lays out differently, so with fonts blocked every
 * clipping number would be an artefact of the instrument. Correctness of the
 * measurement is why these are here; convenience is not.
 */
export const ASSET_HOSTS: readonly string[] = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/**
 * Sets, not object literals, for every membership test in this file: a bare
 * `obj[key]` lookup returns `Object` itself for keys like `constructor` or
 * `__proto__`, so a `?? fallback` never fires and the guard silently treats an
 * attacker-shaped mode string as configured. See the same note in
 * `e2e/support/gate-rules.unit.test.ts`.
 */
const ALLOWED_HOST_SET = new Set(ALLOWED_HOSTS.map((h) => h.toLowerCase()));
const ASSET_HOST_SET = new Set(ASSET_HOSTS.map((h) => h.toLowerCase()));
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const KNOWN_MODES = new Set<string>(['read', 'interact', 'write-pass']);
const READ_ONLY_MODES = new Set<string>(['read', 'interact']);

/**
 * Paths that must never be written to, even in `write-pass`.
 *
 * ⛔ Every pattern is matched against the PATHNAME ONLY. Matching the full URL
 * would let `?note=bulk` satisfy a rule (noise) and, worse, let a deny term be
 * pushed into a query string to make a genuinely destructive path look covered.
 *
 * ⛔ No pattern may carry the `g` flag. A global RegExp keeps `lastIndex`
 * between `.test()` calls, so the SECOND request against the same pattern
 * returns false and is forwarded. There is a unit test pinning this.
 */
export const WRITE_DENY: readonly { pattern: RegExp; why: string }[] = [
  {
    // Approval decide/void is gated separately (the decide/void token split);
    // a sweep must never be able to reach it by any method.
    pattern: /(^|\/)api\/approvals(\/|$)/i,
    why: 'approvals-separately-gated',
  },
  {
    pattern: /(^|\/)admin\/tenants(\/|$)/i,
    why: 'tenant-administration',
  },
  {
    pattern: /(^|\/)secrets?(\/|$)/i,
    why: 'secret-material',
  },
  {
    pattern: /(^|\/)budgets?(\/|$)/i,
    why: 'budget-mutation',
  },
  {
    // licence / license / licences / licenses — both spellings, both numbers.
    pattern: /(^|\/)licen[cs]es?(\/|$)/i,
    why: 'licensing-mutation',
  },
  {
    pattern: /(^|\/)metering(\/|$)/i,
    why: 'metering-writes-are-billing',
  },
  {
    // Deliberately matched as a SEGMENT PREFIX rather than a whole segment:
    // these are the paths that make something happen outside fr (n8n, worker
    // dispatch, webhooks). `/api/n8n-tools` and `/api/procedures/1/execute`
    // must both be caught. Over-denying a write costs a skipped request;
    // under-denying one costs a production side effect.
    pattern: /\/(n8n|execute|dispatch|trigger|webhook)/i,
    why: 'triggers-external-execution',
  },
  {
    // A whole path SEGMENT `bulk` or `batch` — one request, many rows.
    // `/api/bulkhead` is not a bulk operation and is not denied.
    pattern: /(^|\/)(bulk|batch)(\/|$)/i,
    why: 'fans-out-to-many-rows',
  },
];

/** Rule 1's reason, used for every "this URL is not addressable" refusal. */
const HOST_REFUSAL = 'host-not-allowlisted';

const ABORT = (reason: string): Decision => ({ action: 'abort', reason });
const FORWARD: Decision = { action: 'forward' };

/**
 * The pathnames a deny pattern is tested against: the raw one and, when it
 * differs, its percent-decoded form. Returns `null` when the URL cannot be
 * parsed or its escapes cannot be decoded — both of which are refusals, not
 * "no deny matched".
 */
function addressableParts(url: unknown): { hostname: string; paths: string[] } | null {
  if (typeof url !== 'string' || url === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Extension, documented at the top of this file: plaintext would put the
  // super_admin bearer token on the wire.
  if (parsed.protocol !== 'https:') return null;

  const raw = parsed.pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escapes: the server would resolve this to some path, and we
    // cannot say which. Refuse rather than pattern-match the raw bytes.
    return null;
  }

  return {
    hostname: parsed.hostname.toLowerCase(),
    paths: raw === decoded ? [raw] : [raw, decoded],
  };
}

/**
 * The single decision point for the live sweep. Precedence is exactly the
 * order of the branches below; each returns, so no later rule can widen an
 * earlier refusal.
 */
export function classifyRequest(input: { method: string; url: string; mode: SweepMode }): Decision {
  // Rule 1 — the URL must parse, be https, decode, and name an allow-listed
  // host by WHOLE hostname. Runs first so nothing downstream ever reasons
  // about an address the sweep may not touch.
  const parts = addressableParts(input?.url);
  if (parts === null) return ABORT(HOST_REFUSAL);
  const isAssetHost = ASSET_HOST_SET.has(parts.hostname);
  if (!ALLOWED_HOST_SET.has(parts.hostname) && !isAssetHost) return ABORT(HOST_REFUSAL);

  const method = typeof input?.method === 'string' ? input.method.trim().toUpperCase() : '';
  const mode = input?.mode as unknown;

  // Rule 2 — GET/HEAD are safe on their METHOD, independent of mode. This is
  // why an unrecognised mode does not block a read: the safety here does not
  // come from the mode at all.
  if (SAFE_METHODS.has(method)) return FORWARD;

  // An asset host is a READ surface only. Reaching here means a non-GET was
  // aimed at a font CDN, which nothing legitimate does.
  if (isAssetHost) return ABORT('write-to-asset-host');

  // Rule 2b — the IdP's OIDC endpoints. Scoped to the IdP host AND the
  // openid-connect path shape; see IDP_WRITE_PATH for why this is not a write.
  if (parts.hostname === IDP_HOST && parts.paths.some((pth) => IDP_WRITE_PATH.test(pth))) {
    return FORWARD;
  }

  // Everything below is a WRITE (or an unrecognised method, which is treated
  // as a write — fail closed).

  // Rule 3 — the read-only modes refuse every write, with no exceptions and no
  // path inspection. This is the arm carrying the sweep's actual guarantee.
  if (typeof mode === 'string' && READ_ONLY_MODES.has(mode)) {
    return ABORT('write-blocked-in-read-mode');
  }

  // Rule 4 — write-pass: refuse anything the deny-list names, on the pathname.
  if (mode === 'write-pass') {
    for (const entry of WRITE_DENY) {
      for (const path of parts.paths) {
        if (entry.pattern.test(path)) return ABORT(entry.why);
      }
    }
    return FORWARD;
  }

  // Rule 5 — any other mode value. The type system is not trusted at runtime:
  // a mode read from an env var, a JSON config, or a typo arrives here as an
  // arbitrary string and must not fall through to a forward.
  return ABORT('unknown-mode');
}
