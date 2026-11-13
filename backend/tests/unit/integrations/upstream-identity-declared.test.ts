// Every HTTP client fr builds must SAY which identity it presents upstream, and
// this file pins what each one says.
//
// The compiler already enforces PRESENCE — `sendAuthorization` is a required
// field of `HttpClientOptions`, and `bunx tsc --noEmit` (`bun run ci:verify`) refuses
// a call site that omits it. What the compiler cannot enforce is the VALUE, and
// the value is the whole defect: #848 shipped because forwarding the end user's
// Keycloak JWT to Planka was a guaranteed 401 that nothing could see. Flipping
// one of these back to `true` re-arms exactly that, silently.
//
// So this is a ratchet, not a style check. A new client fails here until its
// decision is recorded below — which is the point: the decision should cost a
// line of thought, not be inherited from a default.
//
// Each `false` is licensed by the UPSTREAM's own auth code, cited at the call
// site itself. Read those comments before changing anything here.
import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../../../src');

/**
 * A client is any `createHttpClient(` / `new HttpClient(` — the census keys off
 * CLIENTS, not declarations. Keying off declarations was itself a hole: a call
 * site that declared nothing simply did not appear, so "no undeclared clients"
 * was vacuously true for exactly the file it needed to catch.
 */
const CLIENT = /\b(?:createHttpClient|new HttpClient)\s*\(/g;

/** Matches either layout — own line or inline — but never a mention in prose. */
const DECL = /sendAuthorization:\s*(true|false)/g;

/** Comments mention this option by name (kag.ts:394 does); prose is not a decision. */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Site { clients: number; declared: string[] }

function census(): Map<string, Site> {
  const found = new Map<string, Site>();
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    // The option's own definition lives here; it declares a type, not a client.
    if (rel === 'integrations/_lib/http-client.ts') continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    const clients = [...code.matchAll(CLIENT)].length;
    if (clients === 0) continue;
    found.set(rel, {
      clients,
      declared: [...code.matchAll(DECL)].map((m) => m[1]!),
    });
  }
  return found;
}

/**
 * The recorded decision for every client under `src/`.
 *
 * `false` — the upstream does not authenticate the end user by their Keycloak
 *           bearer; the call site names the upstream file:line that proves it.
 * `true`  — it does, or the question is genuinely open and the call site says
 *           what is unknown. An honest `true` is a result, not a failure.
 *
 * As of 2026-08-31 NO production client is `true`. That is a measured outcome,
 * not a rule: every upstream fr talks to authenticates by licence-token-in-
 * `X-Tenant-Id`, a service credential, an api key, or a bearer the call site
 * passes explicitly. The option stays because the next upstream may genuinely
 * read the end user's token — the point was never to reach zero, it was to stop
 * the answer being decided by an absent line.
 */
const EXPECTED: Record<string, 'true' | 'false'> = {
  // Third-party products with their own identity systems — the #848 shape.
  'integrations/kanban.ts': 'false',              // Planka issues its own tokens
  'integrations/n8n.ts': 'false',                 // X-N8N-API-KEY, not bearer
  'domain/engagement/adapters/teams.ts': 'false', // webhook secret is in the URL
  // First-party services on the licence-token-as-X-Tenant-Id convention.
  'integrations/coding/client.ts': 'false',
  'integrations/architecture.ts': 'false',
  'integrations/decisions.ts': 'false',
  'integrations/pm.ts': 'false',
  // The tenant PM catalogue (/pm/<vocabulary>) on the same RM: X-Tenant-Id only.
  'integrations/pm-catalogue.ts': 'false',
  'integrations/principles.ts': 'false',
  // The quality-history read on the SAME requirements_management entities as the
  // CRUD adapters above. Same upstream, same answer: it resolves the tenant
  // from `X-Tenant-Id` alone (kag_common/auth/__init__.py:409-414) and never
  // reads `Authorization`.
  'integrations/quality-history.ts': 'false',
  'integrations/requirements.ts': 'false',
  'integrations/requirements-management.ts': 'false',
  'integrations/toc.ts': 'false',
  'integrations/secrets.ts': 'false',
  'integrations/workers.ts': 'false',
  'integrations/artifacts.ts': 'false',
  'integrations/inference-router.ts': 'false',
  'integrations/kag-orchestrator.ts': 'false',    // scoped to /health/lag
  'services/prometheus-client.ts': 'false',       // Prometheus has no bearer auth
  'integrations/kag.ts': 'false',                 // kag ignores it; #880 vouch is path-scoped
  'integrations/media.ts': 'false',               // same kag gateway
  'integrations/research.ts': 'false',            // same kag gateway
  'integrations/metering/usage.ts': 'false',      // admin call carries its own secure-apps bearer
};

describe('upstream identity is declared, not inherited', () => {
  const found = census();

  // Fail-closed. A scan that finds nothing must not read as "nothing is wrong" —
  // that is the failure mode this whole lane exists to kill. Non-vacuity only:
  // the `vanished` / `undeclared` equality below pins the exact set.
  test('the census actually found the clients', () => {
    expect(found.size).toBeGreaterThan(0);
  });

  test('every client declares exactly one identity', () => {
    const mismatched = [...found]
      .filter(([, s]) => s.declared.length !== s.clients)
      .map(([f, s]) => `${f}: ${s.clients} client(s), ${s.declared.length} declaration(s)`)
      .sort();
    expect(mismatched).toEqual([]);
  });

  test('no client is missing from the recorded decisions', () => {
    const undeclared = [...found.keys()].filter((f) => !(f in EXPECTED)).sort();
    // A new client landed without recording its identity decision here. Add it,
    // and cite the upstream file:line at the call site.
    expect(undeclared).toEqual([]);
  });

  test('no recorded decision has lost its client', () => {
    const vanished = Object.keys(EXPECTED).filter((f) => !found.has(f)).sort();
    expect(vanished).toEqual([]);
  });

  // The invariant this PR established, said out loud so it is legible rather
  // than implied by 26 map entries. Not a prohibition: if an upstream genuinely
  // authenticates the end user by their Keycloak bearer, set it `true`, say so
  // at the call site with the upstream's file:line, and update this test's
  // expectation in the same commit. The point is that it costs a decision.
  test('no production client forwards the end-user Keycloak JWT', () => {
    const forwarding = [...found]
      .filter(([, s]) => s.declared.includes('true'))
      .map(([f]) => f)
      .sort();
    expect(forwarding).toEqual([]);
  });

  test('every client still presents the identity it recorded', () => {
    const drifted = [...found]
      .filter(([f, s]) => f in EXPECTED && s.declared[0] !== EXPECTED[f])
      .map(([f, s]) => `${f}: recorded ${EXPECTED[f]}, source says ${s.declared[0]}`)
      .sort();
    expect(drifted).toEqual([]);
  });
});
