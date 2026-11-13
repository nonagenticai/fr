// routes/tenant/usage-breakdown.ts
//
// Usage split by WHO PAYS (funding), per project and per member.
//
//   GET /api/tenant/usage/breakdown   workspace-admin of the active tenant, or
//                                     super-admin. Proxies billing
//                                     `/api/usage/breakdown`, pinned to the
//                                     active tenant (X-Tenant-Id). Any member.
//   GET /api/me/usage/funding         any signed-in user. Proxies billing
//                                     `/api/usage/breakdown/me` with the
//                                     caller's OWN verified sub as X-Actor-Id.
//
// Query (both): from, to (inclusive YYYY-MM-DD, ≤ 92 days, default last 30),
// group_by (CSV of project,actor,funding,app,provider,model,day), and CSV
// filters project_id, funding, app, provider, model — plus actor_id on the
// tenant route only. The tenant is NEVER a param: it is the request context's
// active tenant (routes/tenant/members.ts explains why). /me takes no actor
// filter: its actor is the caller, full stop.
//
// ── AUTHZ ────────────────────────────────────────────────────────────────────
//
// Per-member spend is admin data (billing guards /breakdown with
// require_service_caller for exactly that reason, so fr's secure-apps SA bearer
// is what reaches it — the bearer proves fr is trusted, THIS gate proves the
// human is an admin of THIS tenant). Same gate as /api/tenant/billing. A
// non-admin reads only /me, whose actor billing takes from X-Actor-Id = the
// caller's sub; nothing in the request can change it.
//
// ── MONEY ────────────────────────────────────────────────────────────────────
//
// lib/usage-funding.ts: super-admin incurred, everyone else billed (markup),
// withheld when the markup is unknown; tenant_byo is never marked up.
//
// ── NAMES ────────────────────────────────────────────────────────────────────
//
// project → fr's projects table, only for projects in the caller's tenant;
// actor → Keycloak (`resolveUsers`), as /api/tenant/billing does. null dims are
// the unattributed bucket and stay null (the UI labels them "Unattributed").
// A failed lookup never drops a row: `names_unavailable` says which axis.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { isValidUuid } from '../../utils/tenant';
import { hasRole, isRealmTenantAdminOf } from '../../services/user-roles';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import {
  isIntegrationError,
  integrationErrorResponse,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import {
  getTenantUsageCrossBreakdown,
  getMyUsageCrossBreakdown,
  type UpstreamUsageCrossBreakdown,
  type UsageCrossQuery,
} from '../../integrations/metering/usage';
import { fetchTenantMarkupPct } from '../me/usage';
import { projectNamesInTenant, resolveAll, type People } from './billing';
import {
  BREAKDOWN_DIMS,
  foldRows,
  fundingTotals,
  parseGroupBy,
  pickFilters,
  resolveWindow,
  upstreamGroupBy,
  type BreakdownDim,
  type CostLens,
  type FundingTotal,
} from '../../lib/usage-funding';
import type { User } from '../../types/api';

interface UsageBreakdownRow {
  dims: Record<string, string | null>;
  /** Display names for the project / actor dims (null = unknown or unattributed). */
  names: { project?: string | null; actor?: string | null; actor_email?: string | null };
  events: number;
  input_tokens: number;
  output_tokens: number;
  /** null when withheld (markup unknown, fr-paid funding). */
  cost_usd: number | null;
}

interface UsageBreakdownPayload {
  scope: 'tenant' | 'me';
  tenant_id: string;
  /** /me only: the caller's sub. */
  actor_id?: string;
  from: string;
  to: string;
  group_by: BreakdownDim[];
  cost_basis: 'incurred' | 'billed' | 'unavailable';
  totals: { events: number; input_tokens: number; output_tokens: number; cost_usd: number | null };
  by_funding: FundingTotal[];
  rows: UsageBreakdownRow[];
  /** billing capped the rows; totals / by_funding still cover everything. */
  truncated: boolean;
  names_unavailable: { projects: boolean; actors: boolean };
}

const TENANT_FILTERS = ['project_id', 'actor_id', 'funding', 'app', 'provider', 'model'] as const;
const ME_FILTERS = ['project_id', 'funding', 'app', 'provider', 'model'] as const;
const ME_DIMS: readonly BreakdownDim[] = BREAKDOWN_DIMS.filter((d) => d !== 'actor');

type Parsed = { dims: BreakdownDim[]; window: { from: string; to: string }; filters: Record<string, string> };

function parse(
  req: Request,
  fallback: readonly BreakdownDim[],
  allowedDims: readonly BreakdownDim[],
  allowedFilters: readonly string[],
): Parsed | Response {
  const params = new URL(req.url).searchParams;
  const window = resolveWindow(params);
  if ('error' in window) return jsonResponse({ error: window.error }, 422);
  const dims = parseGroupBy(params.get('group_by'), fallback, allowedDims);
  if ('error' in dims) return jsonResponse({ error: dims.error }, 422);
  return { dims, window, filters: pickFilters(params, allowedFilters) };
}

/** Upstream query for the main read (dims ∪ funding) and the funding-totals read. */
function queries(p: Parsed): { main: UsageCrossQuery; totals: UsageCrossQuery } {
  const base = { from: p.window.from, to: p.window.to, ...p.filters };
  return {
    main: { ...base, group_by: upstreamGroupBy(p.dims).join(',') },
    totals: { ...base, group_by: 'funding' },
  };
}

async function lensFor(user: User, tenantId: string): Promise<CostLens> {
  if (isSuperAdmin(user)) return { basis: 'incurred' };
  const m = await fetchTenantMarkupPct(tenantId);
  return m === null ? { basis: 'unavailable' } : { basis: 'billed', markupPct: m };
}

async function shape(opts: {
  scope: 'tenant' | 'me';
  tenantId: string;
  actorId?: string;
  parsed: Parsed;
  main: UpstreamUsageCrossBreakdown;
  totalsRead: UpstreamUsageCrossBreakdown;
  lens: CostLens;
  path: string;
}): Promise<UsageBreakdownPayload> {
  const { parsed, main, lens } = opts;
  const rows = foldRows(main.rows ?? [], parsed.dims, lens);
  const { by_funding, totals } = fundingTotals(opts.totalsRead.rows ?? [], lens);

  const names_unavailable = { projects: false, actors: false };
  let projectNames: Record<string, string> = {};
  if (parsed.dims.includes('project')) {
    const ids = [...new Set(rows.map((r) => r.dims.project).filter((v): v is string => !!v))];
    try {
      projectNames = await projectNamesInTenant(ids, opts.tenantId);
    } catch (e) {
      names_unavailable.projects = true;
      reportSwallowedFailure(e, {
        service: 'fr-db',
        path: opts.path,
        degradedTo: 'project rows listed by id; names_unavailable.projects=true',
      });
    }
  }
  let people: People = {};
  if (parsed.dims.includes('actor')) {
    const ids = [...new Set(rows.map((r) => r.dims.actor).filter((v): v is string => !!v && isValidUuid(v)))];
    try {
      people = ids.length ? await resolveAll(ids) : {};
    } catch (e) {
      names_unavailable.actors = true;
      reportSwallowedFailure(e, {
        service: 'keycloak',
        path: opts.path,
        degradedTo: 'actor rows listed by id; names_unavailable.actors=true',
      });
    }
  }

  const out: UsageBreakdownRow[] = rows.map((r) => {
    const names: UsageBreakdownRow['names'] = {};
    if (parsed.dims.includes('project')) {
      const pid = r.dims.project;
      names.project = pid ? (projectNames[pid.toLowerCase()] ?? null) : null;
      if (pid && names.project === null) names_unavailable.projects = true;
    }
    if (parsed.dims.includes('actor')) {
      const aid = r.dims.actor;
      const p = aid ? (people[aid] ?? people[aid.toLowerCase()]) : undefined;
      names.actor = p?.name ?? null;
      names.actor_email = p?.email ?? null;
      if (aid && !p) names_unavailable.actors = true;
    }
    return { ...r, names };
  });

  return {
    scope: opts.scope,
    tenant_id: opts.tenantId,
    ...(opts.actorId ? { actor_id: opts.actorId } : {}),
    from: main.from ?? parsed.window.from,
    to: main.to ?? parsed.window.to,
    group_by: parsed.dims,
    cost_basis: lens.basis,
    totals,
    by_funding,
    rows: out,
    truncated: Boolean(main.truncated),
    names_unavailable,
  };
}

/** GET /api/tenant/usage/breakdown — workspace-admin of the active tenant, or super-admin. */
export async function handleGetTenantUsageBreakdown(req: Request): Promise<Response> {
  let user: User;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const tenantId = ctxTenantId(user.tenantId);
  const allowed = isSuperAdmin(user) ||
    isRealmTenantAdminOf(user, tenantId) ||
    (await hasRole(user.id, tenantId, 'workspace-admin'));
  if (!allowed) {
    return jsonResponse({ error: 'workspace-admin required for this tenant' }, 403);
  }

  const parsed = parse(req, ['project', 'actor', 'funding'], BREAKDOWN_DIMS, TENANT_FILTERS);
  if (parsed instanceof Response) return parsed;
  const q = queries(parsed);
  try {
    const [main, totalsRead, lens] = await Promise.all([
      getTenantUsageCrossBreakdown({ tenantId, query: q.main }),
      getTenantUsageCrossBreakdown({ tenantId, query: q.totals }),
      lensFor(user, tenantId),
    ]);
    return jsonResponse({
      data: await shape({
        scope: 'tenant',
        tenantId,
        parsed,
        main,
        totalsRead,
        lens,
        path: '/api/tenant/usage/breakdown',
      }),
    });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

/** GET /api/me/usage/funding — the caller's own usage by project × funding. */
export async function handleGetMyUsageFunding(req: Request): Promise<Response> {
  let user: User;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const tenantId = ctxTenantId(user.tenantId);
  // billing 401s a non-uuid actor; say so here rather than proxy a guaranteed failure.
  if (!isValidUuid(user.id)) {
    return jsonResponse({ error: 'caller has no actor id (Keycloak sub)' }, 400);
  }
  const parsed = parse(req, ['project', 'funding'], ME_DIMS, ME_FILTERS);
  if (parsed instanceof Response) return parsed;
  const q = queries(parsed);
  const actorId = user.id;
  try {
    const [main, totalsRead, lens] = await Promise.all([
      getMyUsageCrossBreakdown({ tenantId, actorId, query: q.main }),
      getMyUsageCrossBreakdown({ tenantId, actorId, query: q.totals }),
      lensFor(user, tenantId),
    ]);
    return jsonResponse({
      data: await shape({
        scope: 'me',
        tenantId,
        actorId,
        parsed,
        main,
        totalsRead,
        lens,
        path: '/api/me/usage/funding',
      }),
    });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}
