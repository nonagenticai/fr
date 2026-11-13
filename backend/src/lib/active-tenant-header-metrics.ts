// src/lib/active-tenant-header-metrics.ts
//
// One counter: what `buildRequestContext` (middleware/request-context.ts) DECIDED
// about an inbound `X-Active-Tenant` header, split only by the outcome. Eight label
// values (George 2026-10-27 replaced 14j's `support_switch` with
// `honoured_workspace_switch` and split `refused_archived` /
// `refused_service_account` / `refused_untrusted_session` out of
// `refused_not_switchable`), a CLOSED set — no
// tenant, user or route label, ever (those are unbounded and ride in the log
// lines instead: `[active-tenant-header-ignored]` here, `[super-admin-switch]`
// in lib/super-admin-tenant-audit.ts).
//
// WHY IT EXISTS (fr row 14d-0). The header is honoured only for a SIGNED
// `super_admin` targeting a switchable tenant; every other shape silently falls
// back to the home tenant (JWT `tenant_id`, else `sub`). fr logged neither the
// header nor the decision, so nobody could say how often a non-super_admin sends
// a header that differs from their home tenant — and a later PR (14d) will turn a
// refused super_admin switch into a 403. This counter is the measurement that
// change needs. ⛔ OBSERVATION ONLY: it changes no resolved tenant. The decision
// is still made by the unchanged `if` in request-context.ts; `classify…` below
// re-derives the same predicate for labelling.
//
// The mechanism is `card-phase-lease-emit-metrics.ts` / `priority-compensation-
// metrics.ts`'s shape: closed label set, pre-seeded to zero (absence ≠ zero),
// increment-only recorder, `render*` for routes/metrics.ts. Lives in `lib/` so
// routes/metrics.ts can render it without importing
// the request-context / JWKS graph.

import type { SwitchTargetDecision } from './super-admin-switch-target';

export const ACTIVE_TENANT_HEADER_OUTCOMES = [
  /** super_admin, PLATFORM target, differs from home — the header is applied. */
  'honoured_switch',
  /**
   * George 2026-10-27: an fr super-admin session switched into an existing,
   * non-archived CUSTOMER workspace — applied with full tenant-admin rights
   * and audited (`[super-admin-switch]` line + a row per write).
   */
  'honoured_workspace_switch',
  /** header equals the caller's home tenant (any caller) — a no-op either way. */
  'own_tenant_noop',
  /** non-super_admin sent a well-formed header ≠ home — ignored (home tenant used). */
  'ignored_not_super_admin',
  /** super_admin asked for a tenant fr has no workspace for — 403 active_tenant_not_permitted, reason `unknown` (fr row 14d; was a silent fallback to home under 14d-0). */
  'refused_not_switchable',
  /** super_admin asked for an ARCHIVED workspace — 403 active_tenant_not_permitted, reason `archived`. */
  'refused_archived',
  /** a service account holding super_admin asked for a customer workspace — 403, reason `service_account`. */
  'refused_service_account',
  /** a super_admin token from another realm / client (not an fr session) asked for a customer workspace — 403, reason `untrusted_session`. */
  'refused_untrusted_session',
  /** header present but not a well-formed tenant uuid (incl. empty) — ignored. */
  'malformed',
] as const;
export type ActiveTenantHeaderOutcome = (typeof ACTIVE_TENANT_HEADER_OUTCOMES)[number];

/** The stable log tag. Grep / Loki-query this, never the free-text message. */
export const ACTIVE_TENANT_HEADER_IGNORED_TAG = '[active-tenant-header-ignored]';

const outcomesTotal = new Map<ActiveTenantHeaderOutcome, number>(
  ACTIVE_TENANT_HEADER_OUTCOMES.map((o) => [o, 0]),
);

/**
 * Pure: label the decision request-context.ts made. Returns `null` when the
 * header was absent (no increment). Mirrors the honouring predicate in
 * `buildRequestContext` term for term; it never feeds back into it.
 */
export function classifyActiveTenantHeader(args: {
  header: string | null | undefined;
  wellFormed: boolean;
  homeTenantId: string | undefined;
  callerIsSuperAdmin: boolean;
  /** `decideActiveTenantSwitch`'s answer (`null` when it did not apply). */
  decision: SwitchTargetDecision | null;
}): ActiveTenantHeaderOutcome | null {
  if (args.header === null || args.header === undefined) return null;
  if (!args.header || !args.wellFormed) return 'malformed';
  if (args.homeTenantId !== undefined && args.header === args.homeTenantId) {
    return 'own_tenant_noop';
  }
  if (!args.callerIsSuperAdmin || args.decision === null) return 'ignored_not_super_admin';
  if (args.decision.ok) {
    return args.decision.kind === 'workspace' ? 'honoured_workspace_switch' : 'honoured_switch';
  }
  switch (args.decision.reason) {
    case 'archived':
      return 'refused_archived';
    case 'service_account':
      return 'refused_service_account';
    case 'untrusted_session':
      return 'refused_untrusted_session';
    case 'unknown':
      return 'refused_not_switchable';
  }
}

// Noisy-log guard, the `usage-spans.ts` `warnUnattributedOnce` shape: the
// frontend's `authFetch` sends X-Active-Tenant on EVERY request, so a
// multi-workspace member would otherwise log once per request. One line per
// distinct (outcome, caller, requested tenant), capped. The COUNTER is never
// deduped — it is the rate; the log line is only the "who".
const IGNORED_LOG_CAP = 500;
const loggedKeys = new Set<string>();

function routePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Count one decision and, for the two "header ignored" outcomes only, emit one
 * warn-level structured line. Never throws: it runs on every request's
 * context-build path, which must not fail because of telemetry.
 */
export function recordActiveTenantHeaderOutcome(args: {
  outcome: ActiveTenantHeaderOutcome;
  requestedTenantId: string;
  homeTenantId: string | undefined;
  sub: string | undefined;
  clientId: string | undefined;
  url: string;
}): void {
  outcomesTotal.set(args.outcome, (outcomesTotal.get(args.outcome) ?? 0) + 1);
  if (
    args.outcome !== 'ignored_not_super_admin' &&
    args.outcome !== 'refused_not_switchable' &&
    args.outcome !== 'refused_archived' &&
    args.outcome !== 'refused_service_account' &&
    args.outcome !== 'refused_untrusted_session'
  ) {
    return;
  }
  try {
    const caller = args.sub ?? args.clientId ?? '';
    const key = `${args.outcome}|${caller}|${args.requestedTenantId}`;
    if (loggedKeys.has(key) || loggedKeys.size >= IGNORED_LOG_CAP) return;
    loggedKeys.add(key);
    console.warn(
      ACTIVE_TENANT_HEADER_IGNORED_TAG,
      JSON.stringify({
        event: 'active_tenant_header_ignored',
        outcome: args.outcome,
        requested_tenant_id: args.requestedTenantId,
        home_tenant_id: args.homeTenantId ?? null,
        sub: args.sub ?? null,
        ...(args.sub ? {} : { client_id: args.clientId ?? null }),
        route: routePath(args.url),
      }),
    );
  } catch {
    // The counter already moved; a broken logger must not fail the request.
  }
}

/** Prometheus text-exposition lines for the counter. Rendered by routes/metrics.ts. */
export function renderActiveTenantHeaderMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_active_tenant_header_total Requests carrying an X-Active-Tenant header, by what buildRequestContext decided. ignored_not_super_admin falls back to the home tenant (ignored); refused_* are answered 403 active_tenant_not_permitted (reason unknown / archived / service_account / untrusted_session); honoured_workspace_switch is a super_admin acting as tenant-admin in a customer workspace (George 2026-10-27, audited by the [super-admin-switch] line); see the [active-tenant-header-ignored] log line for who was refused or ignored.',
    '# TYPE fr_active_tenant_header_total counter',
  ];
  for (const o of ACTIVE_TENANT_HEADER_OUTCOMES) {
    lines.push(`fr_active_tenant_header_total{outcome="${o}"} ${outcomesTotal.get(o) ?? 0}`);
  }
  return lines;
}
