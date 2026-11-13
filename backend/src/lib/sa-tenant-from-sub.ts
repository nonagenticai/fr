// src/lib/sa-tenant-from-sub.ts
//
// fr#1448 — OBSERVE where a NON-HUMAN platform identity got its tenant from its
// own `sub`.
//
// WHY. `deriveTenantId` (utils/tenant.ts) takes the JWT `tenant_id` claim, else
// `sub`. For a human that fallback is the per-user workspace; for a platform
// identity with no `tenant_id` claim it is the identity's Keycloak USER id,
// which is not a tenant — every row it writes there is orphaned. Measured in
// prod: 15 rows under the fr-backend service account's sub.
//
// Two populations, one counter:
//   * `service_account` — `isServiceAccountClaims` (a client-credentials token).
//     fr#1270 already flags this as `ctx.tenantIsServiceAccountSubject` and two
//     routes refuse on it.
//   * `system_operator_user` — the password-grant SYSTEM OPERATOR users
//     (`system-workflow-operator` / `system-execution-operator` on client
//     portal-bff). They are NOT service accounts by `isServiceAccountClaims`, so
//     nothing saw them. They are named by Keycloak user id in
//     `FR_SYSTEM_OPERATOR_SUBS` (comma-separated, parsed ONCE at import; a
//     malformed entry fails boot). An operator NOT in that list is invisible
//     here by construction — the list is the boundary.
//
// ⛔ OBSERVATION ONLY, behaviour-identical. Nothing here refuses, nothing reads
// or writes the request context, and `observeTenantFromSub` never throws. It
// deliberately does NOT widen `isServiceAccountClaims` /
// `isServiceAccountSubjectTenant` / `ctx.tenantIsServiceAccountSubject`: doing
// so would fire fr#1270's two existing refusals on the operators.
//
// ENFORCE COMES LATER, and needs two things this PR does not build: a ROUTE
// ALLOWLIST (SA writes that legitimately take their tenant from the body or the
// resource — webhooks, execution-approvals, reports) and a DB-layer guard (the
// per-statement READ ONLY wrapper the retired 14j support switch had is in git
// history). This counter is the measurement that
// change needs.
//
// Mechanism: the `active-tenant-header-metrics.ts` / `orchestrator-tenant-
// binding.ts` shape — closed label sets, pre-zeroed (absence ≠ zero),
// hand-rendered for routes/metrics.ts, one capped + deduped warn line for the
// "who". The pathname is a LOG field, never a metric label.

import { isServiceAccountClaims } from '../utils/tenant';
import { isReadMethod } from './super-admin-tenant-audit';
import { isUuidShape } from './uuid-shape';

// ── closed sets ─────────────────────────────────────────────────────────────

export const SA_TENANT_FROM_SUB_KINDS = [
  /** client-credentials token (`isServiceAccountClaims`), no `tenant_id` claim. */
  'service_account',
  /** a listed FR_SYSTEM_OPERATOR_SUBS password-grant operator, no `tenant_id` claim. */
  'system_operator_user',
] as const;
export type SaTenantFromSubKind = (typeof SA_TENANT_FROM_SUB_KINDS)[number];

export const SA_TENANT_FROM_SUB_METHOD_CLASSES = [
  /** GET / HEAD / OPTIONS (`isReadMethod`). */
  'read',
  /** everything else. */
  'write',
] as const;
export type SaTenantFromSubMethodClass = (typeof SA_TENANT_FROM_SUB_METHOD_CLASSES)[number];

// ── FR_SYSTEM_OPERATOR_SUBS ─────────────────────────────────────────────────

/**
 * Parse `FR_SYSTEM_OPERATOR_SUBS`: comma-separated Keycloak user ids, trimmed,
 * lower-cased, deduped. Unset / empty / whitespace ⇒ []. A MALFORMED entry
 * THROWS naming it — the list is a boundary, and silently dropping an entry
 * would hide an operator from this counter (and later from enforce).
 */
export function parseSystemOperatorSubs(raw: string | undefined): readonly string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (id === '') continue;
    if (!isUuidShape(id)) {
      throw new Error(
        `[sa-tenant-from-sub] FR_SYSTEM_OPERATOR_SUBS: malformed entry ${JSON.stringify(part.trim())} (expected a Keycloak user uuid)`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The stable log tag. Grep / Loki-query this, never the free-text message. */
export const SA_TENANT_FROM_SUB_TAG = '[sa-tenant-from-sub]';

const SYSTEM_OPERATOR_SUBS_FROM_ENV = parseSystemOperatorSubs(process.env.FR_SYSTEM_OPERATOR_SUBS);
const systemOperatorSubs: readonly string[] = SYSTEM_OPERATOR_SUBS_FROM_ENV;

// One boot line: the ids are Keycloak user ids, not secrets, and an empty list
// is the thing an operator must be able to see (the second population is then
// unobserved).
console.log(
  `${SA_TENANT_FROM_SUB_TAG} system operator subs: ${SYSTEM_OPERATOR_SUBS_FROM_ENV.length} [${SYSTEM_OPERATOR_SUBS_FROM_ENV.join(',')}]`,
);

/** The parsed list in effect (env at import). */
export function systemOperatorSubsInEffect(): readonly string[] {
  return systemOperatorSubs;
}

// ── the classifier (pure) ───────────────────────────────────────────────────

/**
 * Pure: did a non-human platform identity get `tenantId` from its own `sub`?
 *   - null unless the tenant is still the JWT-derived one (`activeTenantSource
 *     === 'jwt'` — a header override displaces the sub), claims are present,
 *     they carry NO non-empty `tenant_id` (the same test `deriveTenantId` uses),
 *     and `tenantId === claims.sub`;
 *   - then `isServiceAccountClaims` ⇒ 'service_account';
 *   - else `sub` ∈ FR_SYSTEM_OPERATOR_SUBS ⇒ 'system_operator_user';
 *   - else null — humans, and any operator NOT in the list.
 */
export function classifyTenantFromSub(args: {
  claims: Record<string, unknown> | undefined;
  tenantId: string | undefined;
  activeTenantSource: 'jwt' | 'header';
}): SaTenantFromSubKind | null {
  if (args.activeTenantSource !== 'jwt') return null;
  const claims = args.claims;
  if (!claims) return null;
  const claimedTenant = claims.tenant_id;
  if (typeof claimedTenant === 'string' && claimedTenant.length > 0) return null;
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (args.tenantId !== sub) return null;
  if (isServiceAccountClaims(claims)) return 'service_account';
  if (systemOperatorSubs.includes(sub.toLowerCase())) return 'system_operator_user';
  return null;
}

// ── metrics + log ───────────────────────────────────────────────────────────

const fromSubTotal = new Map<string, number>();
function zeroFromSubCounters(): void {
  fromSubTotal.clear();
  for (const k of SA_TENANT_FROM_SUB_KINDS) {
    for (const m of SA_TENANT_FROM_SUB_METHOD_CLASSES) fromSubTotal.set(`${k}|${m}`, 0);
  }
}
zeroFromSubCounters();

// One line per distinct (kind, method, pathname, sub), capped. The COUNTER is
// never deduped — it is the rate; the log line is only the "who".
const LOG_CAP = 500;
const loggedKeys = new Set<string>();

// `buildRequestContext` runs more than once for some requests (server.ts, then
// e.g. routes/tools/bridge.ts from the same Request). Count each Request ONCE.
// Weak: no retention.
const countedRequests = new WeakSet<Request>();


function methodClass(method: string): SaTenantFromSubMethodClass {
  return isReadMethod(method) ? 'read' : 'write';
}

function routePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Classify one request and, when a platform identity's tenant came from its own
 * sub, count it (+1 on `{kind, method_class}`) and log the first sighting of
 * each (kind, method, pathname, sub). Returns the kind (null = not counted).
 * NEVER throws and never touches the request context: it runs on every
 * request's context-build path.
 */
export function observeTenantFromSub(
  req: Request,
  args: {
    claims: Record<string, unknown> | undefined;
    tenantId: string | undefined;
    activeTenantSource: 'jwt' | 'header';
  },
): SaTenantFromSubKind | null {
  try {
    const kind = classifyTenantFromSub(args);
    if (kind === null) return null;
    if (countedRequests.has(req)) return kind;
    countedRequests.add(req);
    const method = req.method.toUpperCase();
    const key = `${kind}|${methodClass(method)}`;
    fromSubTotal.set(key, (fromSubTotal.get(key) ?? 0) + 1);
    try {
      const pathname = routePath(req.url);
      const sub = args.tenantId ?? '';
      const logKey = `${kind}|${method}|${pathname}|${sub}`;
      if (!loggedKeys.has(logKey) && loggedKeys.size < LOG_CAP) {
        loggedKeys.add(logKey);
        console.warn(
          SA_TENANT_FROM_SUB_TAG,
          JSON.stringify({ event: 'sa_tenant_from_sub', kind, method, pathname, sub }),
        );
      }
    } catch {
      // The counter already moved; a broken logger must not fail the request.
    }
    return kind;
  } catch {
    return null;
  }
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderSaTenantFromSubMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_sa_tenant_from_sub_total Requests whose tenant buildRequestContext derived from the caller\'s own sub while the caller is a non-human platform identity with no tenant_id claim (fr#1448): kind=service_account (client-credentials) or system_operator_user (listed in FR_SYSTEM_OPERATOR_SUBS); method_class read=GET/HEAD/OPTIONS. Observe only; see the [sa-tenant-from-sub] log line for who and where.',
    '# TYPE fr_sa_tenant_from_sub_total counter',
  ];
  for (const k of SA_TENANT_FROM_SUB_KINDS) {
    for (const m of SA_TENANT_FROM_SUB_METHOD_CLASSES) {
      lines.push(
        `fr_sa_tenant_from_sub_total{kind="${k}",method_class="${m}"} ${fromSubTotal.get(`${k}|${m}`) ?? 0}`,
      );
    }
  }
  return lines;
}
