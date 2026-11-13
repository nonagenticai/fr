// src/lib/keycloak-lookup-metrics.ts
//
// ⛔ WHAT THIS COUNTS, AND WHY A COUNTER RATHER THAN A LOG LINE (issue #1031).
//
// `KeycloakService.getUserById` had TWO exits that returned `null` emitting
// nothing, and they were indistinguishable from each other and from a
// legitimate "no such user":
//
//   (A) `getAdminAuth()` threw  -> `catch { return null }`. NO HTTP REQUEST IS
//       EVER ISSUED. fr is misconfigured and every lookup returns null forever.
//   (B) the admin API answered 404 -> `return null`, deliberately unlogged,
//       because logging every 404 is noise.
//
// The two have OPPOSITE fixes — (A) is "fix fr's client credentials", (B) is
// "the subject is not in this realm" — and fr emitted nothing that told them
// apart. That is the defect; neither branch on its own is.
//
// ── THE MEASUREMENT THAT MOTIVATES THE `realm` LABEL ─────────────────────────
// An unsaturated 7-day ingress census (istio-ingressgateway lines matching
// `/admin/realms/` + `/users/`, 1,784 lines, limit 5,000, NOT saturated):
//
//   realms seen              : {'portal': 1756}
//   distinct ids looked up   : 118
//   ids that EVER return 200 :   9      <- positive control: the client works
//   ids returning ONLY 404   : 109  (92%)
//   404s / 200s              : 1658 / 94
//
// So ~92% of the subjects fr looks up are absent from the realm it asks, and
// that produced NO log signal at all. The leading (UNTESTED, and deliberately
// not acted on here) hypothesis is that those subjects live in fr's other realm
// `KEYCLOAK_SECURE_APPS_REALM` while lookups go to `KEYCLOAK_REALM`. A miss that
// does not say WHICH realm it asked is unactionable, hence the label.
//
// ── WHY A COUNTER, AND NOT "log the 404 after all" ───────────────────────────
// The 404 line was suppressed on purpose and re-introducing it would get it
// deleted again — 1,658 lines in 7 days of a route that must stay readable. A
// counter is SILENT PER EVENT by construction, so it cannot regress into that
// noise, while `rate(...[1h])` over it is exactly the "is this SUSTAINED?"
// question a single 404 must not answer. Chosen over a first-then-every-Nth
// log because an Nth-line sampler still writes to the same stream the original
// line was deleted from, and because a sampled log cannot give a RATE: you get
// a count with no denominator.
//
// ⭐ `found` is a load-bearing series, not decoration. A miss COUNT is not a
// miss RATE, and the whole discriminator in #1031 was "does this credential
// resolve anybody at all?" — 9 ids resolving is what excluded the broken-client
// reading. Without `found` in the same denominator, a Prometheus reader can see
// misses rise and cannot tell a wrong-realm population from a dead client.
//
// Lives in `lib/` for the same reason `metering-span-metrics.ts` does:
// `routes/metrics.ts` imports the render helper, and nothing on a hot path may
// transitively pull in `db/client`.

/**
 * How one `getUserById` call ended. Closed set — five series per realm, so the
 * cardinality is bounded by the realm config, not by traffic.
 *
 * `found`             — 2xx, a profile was returned. THE DENOMINATOR.
 * `not_found`         — the admin API answered 404. Silent per event, by design.
 * `admin_auth_failed` — branch (A): `getAdminAuth()` threw, NO request issued.
 *                       Its own series precisely so it can never be read as a
 *                       404; a proxy cannot see this arm at all (no line is
 *                       emitted upstream), so before this counter no ratio
 *                       between (A) and (B) could be established from anywhere.
 * `upstream_error`    — non-2xx that is not 404 (5xx, 401, 403). Already logged.
 * `transport_error`   — the fetch threw: timeout, DNS, refused. Already logged.
 */
export const KEYCLOAK_LOOKUP_OUTCOMES = [
  'found',
  'not_found',
  'admin_auth_failed',
  'upstream_error',
  'transport_error',
] as const;
export type KeycloakLookupOutcome = (typeof KEYCLOAK_LOOKUP_OUTCOMES)[number];

/**
 * Series -> count. The VALUE carries the label pair; the key is only an identity.
 *
 * This was `Map<string, number>` keyed on the two labels joined by a space and
 * rendered with `split(' ')`. That silently TRUNCATES: a realm containing a
 * space renders `realm="a"` and collides with a realm actually named `a` — two
 * realms summing into one series, in the metric whose entire purpose is to name
 * the realm that produced a miss. Storing the pair means nothing is parsed back
 * out, so no separator can be wrong. The key keeps a NUL join purely as an
 * identity; it never reaches the output.
 */
const lookupTotals = new Map<
  string,
  { outcome: KeycloakLookupOutcome; realm: string; count: number }
>();

const key = (outcome: KeycloakLookupOutcome, realm: string): string =>
  `${outcome}\u0000${realm}`;

/** Prometheus label values are quoted; keep a stray quote/backslash from breaking the line. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Record one completed `getUserById` attempt.
 *
 * `realm` is the realm the lookup ASKED, passed in rather than read from
 * `config` here: the point of the label is to name the realm that produced the
 * miss, and a helper that re-derived it from config could not tell the truth if
 * the caller ever asks a second realm.
 */
export function recordKeycloakUserLookup(
  outcome: KeycloakLookupOutcome,
  realm: string,
): void {
  const k = key(outcome, realm);
  const prev = lookupTotals.get(k);
  if (prev) prev.count += 1;
  else lookupTotals.set(k, { outcome, realm, count: 1 });
}

/**
 * Prometheus text exposition. Only series that have actually fired are emitted
 * — an unseeded `not_found{realm="secure-apps"} 0` would assert fr asks a realm
 * it has never asked, which is the very confusion this metric exists to settle.
 */
export function renderKeycloakLookupMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_keycloak_user_lookup_total Keycloak admin-API user lookups by fr-backend, split by outcome and the realm queried.',
    '# TYPE fr_keycloak_user_lookup_total counter',
  ];
  for (const { outcome, realm, count } of lookupTotals.values()) {
    lines.push(
      `fr_keycloak_user_lookup_total{outcome="${escapeLabel(outcome)}",realm="${escapeLabel(realm)}"} ${count}`,
    );
  }
  return lines;
}
