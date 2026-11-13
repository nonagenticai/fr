// routes/tenant/billing.ts
//
// GET /api/tenant/billing?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The customer-facing answer to "who and what spent this workspace's money":
// spend per PROJECT and per acting MEMBER over a date range, each with an
// explicit Unattributed bucket and a coverage %.
//
// ── SOURCES ─────────────────────────────────────────────────────────────────
//
//   projects ← billing GET /api/costs/tenant/{id}          (CostDaily.by_project)
//   members  ← billing GET /api/costs/tenant/{id}/actors   (CostActorDaily.by_actor)
//
// Two SEPARATE rollups. Billing says their totals are equal for one window; we
// check rather than trust. If they disagree the response carries all three
// numbers and `totals_mismatch: true` — the page shows the disagreement instead
// of silently picking one.
//
// ── GATE ────────────────────────────────────────────────────────────────────
//
// Per-member spend is admin data (billing narrowed /actors to service callers
// for exactly that reason). Same gate as routes/me/budget-topup.ts: a super-admin,
// or `workspace-admin` of THIS tenant in `user_roles`. The tenant comes from the
// request context, never a param — see routes/tenant/members.ts for why.
//
// ── NAMES ───────────────────────────────────────────────────────────────────
//
// Billing stores uuids only. Project names come from fr's `projects` table and
// are returned ONLY for projects that belong to the caller's tenant (billing's
// ProjectCostBreakdown doc: a project id is caller-supplied, so resolving a
// forged uuid unscoped would read another tenant's project name). Member names
// come from Keycloak. A failed lookup never drops a row: the row stays, with
// `name: null` / `resolved: false`, and `names_unavailable` says why.
//
// `names_unavailable.<axis>` is DERIVED FROM THE ROWS (lib/resolution.ts
// `anyRowUnresolved`), OR'd with "the lookup itself threw". It used to be only
// the latter, so a project outside the tenant (or missing from fr's table) and
// an actor Keycloak did not return rendered `name: null` beside a flag reading
// `false` — the page showed bare ids as though every name were known.

import { eq, inArray } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { isValidUuid } from '../../utils/tenant';
import { hasRole, isRealmTenantAdminOf } from '../../services/user-roles';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { keycloak } from '../../services/keycloak';
import { db, projects, departments } from '../../db/client';
import {
  isIntegrationError,
  integrationErrorResponse,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import {
  getTenantCostBreakdown,
  getTenantActorCost,
  projectCostChunkCount,
  PROJECT_COST_MAX_CHUNKS,
  UNATTRIBUTED_PROJECT_ID,
  UNATTRIBUTED_ACTOR_ID,
  type TenantCostBreakdown,
  type TenantActorCost,
} from '../../integrations/metering/usage';
import { anyRowUnresolved } from '../../lib/resolution';
import { applyMarkup } from '../../lib/money';
import { fetchTenantMarkupPct } from '../me/usage';

const RESOLVE_CHUNK = 50;
/** Reconciliation tolerance, USD. Sums are exact micro-dollar integers upstream. */
export const TOTALS_TOLERANCE_USD = 1e-6;
/** Default window when the caller gives none: the last 7 days incl. today (UTC). */
export const DEFAULT_WINDOW_DAYS = 7;

export interface TenantBillingProject {
  id: string;
  /** Null when the project is not in fr's table for this tenant. */
  name: string | null;
  cost_usd: number;
  requests: number;
}

export interface TenantBillingMember {
  id: string;
  name: string | null;
  email: string | null;
  /** False when Keycloak did not resolve the actor id. The row is still listed. */
  resolved: boolean;
  cost_usd: number;
  /** Portion of cost_usd billed to the customer's own provider key (BYO). */
  byo_cost_usd: number;
  requests: number;
}

export interface TenantBilling {
  from: string;
  to: string;
  /** Attributed projects only; the sentinel is in `unattributed.project_usd`. */
  projects: TenantBillingProject[];
  /** Attributed members only; the sentinel is in `unattributed.member_usd`. */
  members: TenantBillingMember[];
  unattributed: {
    project_usd: number;
    project_requests: number;
    member_usd: number;
    member_requests: number;
  };
  /** Billing's tenant total (CostDaily) — the authoritative spend figure. */
  total_cost_usd: number;
  totals: { tenant_usd: number; projects_usd: number; members_usd: number };
  /** True when tenant / projects / members totals differ by > 1e-6 USD. */
  totals_mismatch: boolean;
  /** Attributed share of each axis, 0..100; null when that axis has no spend. */
  coverage: { project_pct: number | null; member_pct: number | null };
  names_unavailable: { projects: boolean; members: boolean };
  /**
   * What every cost figure above is: `'incurred'` (fr's raw provider cost —
   * super-admin only) or `'billed'` (incurred × the tenant's markup, the same
   * figure /settings/usage shows). A non-super-admin whose markup is unknown
   * gets `TenantBillingWithheld` instead — never the incurred figures.
   */
  cost_basis: 'incurred' | 'billed';
}

/**
 * The page payload for a non-super-admin when the tenant's markup cannot be
 * established: every fr cost figure is `null` (`cost_basis: 'unavailable'`).
 * Request counts, names, coverage ratios and the customer's own BYO spend stay.
 */
export type TenantBillingWithheld = Omit<
  TenantBilling,
  'projects' | 'members' | 'unattributed' | 'total_cost_usd' | 'totals' | 'cost_basis'
> & {
  projects: Array<Omit<TenantBillingProject, 'cost_usd'> & { cost_usd: null }>;
  members: Array<Omit<TenantBillingMember, 'cost_usd'> & { cost_usd: null }>;
  unattributed: {
    project_usd: null;
    project_requests: number;
    member_usd: null;
    member_requests: number;
  };
  total_cost_usd: null;
  totals: { tenant_usd: null; projects_usd: null; members_usd: null };
  cost_basis: 'unavailable';
};

export type People = Record<string, { id: string; email: string | null; name: string }>;

const toMicros = (n: number): number => Math.round(n * 1e6);
const fromMicros = (m: number): number => m / 1e6;

function pct(attributedMicros: number, totalMicros: number): number | null {
  if (totalMicros <= 0) return null;
  return Math.round((attributedMicros / totalMicros) * 10_000) / 100;
}

/**
 * Pure: fold the two billing rollups + name lookups into the page payload.
 *
 * Every upstream row survives. Unknown project ids and unresolved actors stay
 * as rows with null names; the two sentinels become the Unattributed buckets.
 */
export function toTenantBilling(input: {
  from: string;
  to: string;
  breakdown: Pick<TenantCostBreakdown, 'total_cost_usd' | 'by_project'>;
  actors: Pick<TenantActorCost, 'total_cost_usd' | 'by_actor'>;
  projectNames: Record<string, string>;
  people: People;
  /** True when the lookup for that axis THREW. Row-level gaps are derived here. */
  lookupFailed?: { projects: boolean; members: boolean };
}): TenantBilling {
  const { breakdown, actors, projectNames, people } = input;

  let projectsMicros = 0;
  let unattrProjectMicros = 0;
  let unattrProjectReq = 0;
  const projectRows: TenantBillingProject[] = [];
  for (const r of breakdown.by_project) {
    const m = toMicros(r.cost_usd);
    projectsMicros += m;
    if (r.project_id.toLowerCase() === UNATTRIBUTED_PROJECT_ID) {
      unattrProjectMicros += m;
      unattrProjectReq += r.request_count;
      continue;
    }
    projectRows.push({
      id: r.project_id,
      name: projectNames[r.project_id.toLowerCase()] ?? null,
      cost_usd: fromMicros(m),
      requests: r.request_count,
    });
  }

  let membersMicros = 0;
  let unattrMemberMicros = 0;
  let unattrMemberReq = 0;
  const memberRows: TenantBillingMember[] = [];
  for (const a of actors.by_actor) {
    const m = toMicros(a.cost_usd);
    membersMicros += m;
    if (a.actor_id.toLowerCase() === UNATTRIBUTED_ACTOR_ID) {
      unattrMemberMicros += m;
      unattrMemberReq += a.request_count;
      continue;
    }
    const p = people[a.actor_id] ?? people[a.actor_id.toLowerCase()];
    memberRows.push({
      id: a.actor_id,
      name: p?.name ?? null,
      email: p?.email ?? null,
      resolved: Boolean(p),
      cost_usd: fromMicros(m),
      byo_cost_usd: a.byo_cost_usd,
      requests: a.request_count,
    });
  }

  const byCost = <T extends { cost_usd: number; id: string }>(a: T, b: T) =>
    b.cost_usd - a.cost_usd || a.id.localeCompare(b.id);
  projectRows.sort(byCost);
  memberRows.sort(byCost);

  const tenantMicros = toMicros(breakdown.total_cost_usd);
  const tol = toMicros(TOTALS_TOLERANCE_USD);
  const totalsMismatch =
    Math.abs(tenantMicros - projectsMicros) > tol ||
    Math.abs(tenantMicros - membersMicros) > tol ||
    Math.abs(projectsMicros - membersMicros) > tol;

  return {
    from: input.from,
    to: input.to,
    projects: projectRows,
    members: memberRows,
    unattributed: {
      project_usd: fromMicros(unattrProjectMicros),
      project_requests: unattrProjectReq,
      member_usd: fromMicros(unattrMemberMicros),
      member_requests: unattrMemberReq,
    },
    total_cost_usd: fromMicros(tenantMicros),
    totals: {
      tenant_usd: fromMicros(tenantMicros),
      projects_usd: fromMicros(projectsMicros),
      members_usd: fromMicros(membersMicros),
    },
    totals_mismatch: totalsMismatch,
    coverage: {
      project_pct: pct(projectsMicros - unattrProjectMicros, projectsMicros),
      member_pct: pct(membersMicros - unattrMemberMicros, membersMicros),
    },
    names_unavailable: {
      projects:
        Boolean(input.lookupFailed?.projects) ||
        anyRowUnresolved(projectRows, (p) => p.name !== null),
      members:
        Boolean(input.lookupFailed?.members) || anyRowUnresolved(memberRows, (m) => m.resolved),
    },
    cost_basis: 'incurred',
  };
}

/**
 * Pure: re-express an incurred-cost `TenantBilling` as BILLED cost, the way
 * routes/me/usage.ts does (`applyMarkup`, billing.py's rounding). billing's
 * `/api/costs/tenant/{id}` rollups are what fr BOOKS (billing_service alembic
 * 0021: `cost_usd` "keeps its meaning — what we book"; markup is applied on
 * top), so handing them to a workspace-admin unmarked disclosed fr's margin.
 *
 * `totals_mismatch` and `coverage` are computed on incurred micros BEFORE this
 * runs and are carried unchanged: per-row cent rounding must not manufacture a
 * reconciliation failure. `byo_cost_usd` is the customer's OWN provider bill
 * and is not fr's cost, so it is not marked up.
 */
export function toBilledTenantBilling(b: TenantBilling, markupPct: number): TenantBilling {
  const billed = (usd: number): number => Number(applyMarkup(usd.toFixed(6), markupPct));
  return {
    ...b,
    projects: b.projects.map((p) => ({ ...p, cost_usd: billed(p.cost_usd) })),
    members: b.members.map((m) => ({ ...m, cost_usd: billed(m.cost_usd) })),
    unattributed: {
      ...b.unattributed,
      project_usd: billed(b.unattributed.project_usd),
      member_usd: billed(b.unattributed.member_usd),
    },
    total_cost_usd: billed(b.total_cost_usd),
    totals: {
      tenant_usd: billed(b.totals.tenant_usd),
      projects_usd: billed(b.totals.projects_usd),
      members_usd: billed(b.totals.members_usd),
    },
    cost_basis: 'billed',
  };
}

/** Markup unknown, non-super-admin: withhold every fr cost figure (owner ruling). */
export function toWithheldTenantBilling(b: TenantBilling): TenantBillingWithheld {
  return {
    ...b,
    projects: b.projects.map((p) => ({ ...p, cost_usd: null })),
    members: b.members.map((m) => ({ ...m, cost_usd: null })),
    unattributed: { ...b.unattributed, project_usd: null, member_usd: null },
    total_cost_usd: null,
    totals: { tenant_usd: null, projects_usd: null, members_usd: null },
    cost_basis: 'unavailable',
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** Resolve `from`/`to` query params; default last 7 days (UTC, inclusive). */
export function resolveRange(params: URLSearchParams): { from: string; to: string } | { error: string } {
  const today = new Date().toISOString().slice(0, 10);
  const to = params.get('to') ?? today;
  const from =
    params.get('from') ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_WINDOW_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  if (!isRealDay(from) || !isRealDay(to)) return { error: 'from/to must be YYYY-MM-DD' };
  if (from > to) return { error: 'from must be on or before to' };
  if (projectCostChunkCount(from, to) > PROJECT_COST_MAX_CHUNKS) {
    return { error: 'date range too wide' };
  }
  return { from, to };
}

/** Names of the given project ids that belong to `tenantId` (see header). */
export async function projectNamesInTenant(
  ids: string[],
  tenantId: string,
): Promise<Record<string, string>> {
  const valid = [...new Set(ids.filter((id) => isValidUuid(id)))];
  if (valid.length === 0) return {};
  // Tenant resolved exactly like routes/assets/bindings.ts `projectsInTenant`:
  // departments.workspace_id, falling back to project_data.keycloak_tenant_id.
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      deptTenant: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(inArray(projects.id, valid));
  const out: Record<string, string> = {};
  for (const r of rows) {
    const t =
      r.deptTenant ??
      (r.project_data as { keycloak_tenant_id?: string } | null)?.keycloak_tenant_id ??
      null;
    if (t === tenantId) out[String(r.id).toLowerCase()] = r.name;
  }
  return out;
}

export async function resolveAll(ids: string[]): Promise<People> {
  const out: People = {};
  for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
    Object.assign(
      out,
      await keycloak.resolveUsers(ids.slice(i, i + RESOLVE_CHUNK), RESOLVE_CHUNK),
    );
  }
  return out;
}

/** GET /api/tenant/billing — workspace-admin of the active tenant, or super-admin. */
export async function handleGetTenantBilling(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const tenantId = ctxTenantId(user.tenantId);
  const allowed =
    isSuperAdmin(user) ||
    isRealmTenantAdminOf(user, tenantId) ||
    (await hasRole(user.id, tenantId, 'workspace-admin'));
  if (!allowed) {
    return jsonResponse({ error: 'workspace-admin required for this tenant' }, 403);
  }

  const range = resolveRange(new URL(req.url).searchParams);
  if ('error' in range) return jsonResponse({ error: range.error }, 422);

  const superAdmin = isSuperAdmin(user);
  let breakdown: TenantCostBreakdown;
  let actors: TenantActorCost;
  let markupPct: number | null = null;
  try {
    [breakdown, actors, markupPct] = await Promise.all([
      getTenantCostBreakdown({ tenantId, from: range.from, to: range.to }),
      getTenantActorCost({ tenantId, from: range.from, to: range.to }),
      // Incurred cost is super-admin data; everyone else is shown billed.
      superAdmin ? Promise.resolve(null) : fetchTenantMarkupPct(tenantId),
    ]);
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }

  const lookupFailed = { projects: false, members: false };

  let projectNames: Record<string, string> = {};
  try {
    projectNames = await projectNamesInTenant(
      breakdown.by_project
        .map((r) => r.project_id)
        .filter((id) => id !== UNATTRIBUTED_PROJECT_ID),
      tenantId,
    );
  } catch (e) {
    lookupFailed.projects = true;
    reportSwallowedFailure(e, {
      service: 'fr-db',
      path: '/api/tenant/billing',
      degradedTo: 'project rows listed by id with name null; names_unavailable.projects=true',
    });
  }

  let people: People = {};
  try {
    people = await resolveAll(
      actors.by_actor.map((a) => a.actor_id).filter((id) => id !== UNATTRIBUTED_ACTOR_ID),
    );
  } catch (e) {
    lookupFailed.members = true;
    reportSwallowedFailure(e, {
      service: 'keycloak',
      path: '/api/tenant/billing',
      degradedTo: 'member rows listed by id with resolved=false; names_unavailable.members=true',
    });
  }

  const incurred = toTenantBilling({
    from: range.from,
    to: range.to,
    breakdown,
    actors,
    projectNames,
    people,
    lookupFailed,
  });
  return jsonResponse({
    data: superAdmin
      ? incurred
      : markupPct === null
        ? toWithheldTenantBilling(incurred)
        : toBilledTenantBilling(incurred, markupPct),
  });
}
