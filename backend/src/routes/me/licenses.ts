// src/routes/me/licenses.ts
//
// fr "My licenses & tokens" aggregator. Mirrors portal-bff
// (src/routes/licenses.py) but scopes the result to fr-relevant apps
// (kanban + n8n + fr) and folds in the user's current-month metering
// usage + cost.

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { applyMarkup } from '../../lib/money';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { listAccessibleTenants } from '../../lib/accessible-tenants';
import { getRequestContext } from '../../middleware/request-context';
import {
  integrationErrorResponse,
  isIntegrationError,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import {
  adminListAllLicenses,
  licensesClient,
  type LicenseRecord,
} from '../../services/licenses';
import {
  type MyCostsResponse,
  type MyUsageResponse,
} from '../../services/metering';
import {
  getTenantUsageRange,
  getTenantCostsRange,
  getTenantUsageBreakdown,
  monthWindow,
  type UpstreamUsageResponse,
  type UpstreamCostResponse,
} from '../../integrations/metering/usage';

/**
 * App keys whose licenses are surfaced on fr's "My licenses" page.
 * Read per-call (not at module load) so per-test env overrides take effect
 * without needing module-cache invalidation. Cheap: ≤4 keys, runs once
 * per request alongside the upstream fetch.
 */
function getFrAppKeys(): string[] {
  return (process.env.FR_LICENSE_APP_KEYS ?? 'fr,kanban,n8n')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Per-user sliding-window rate limit on the regenerate-token proxy. A
// compromised browser cookie could spam this endpoint, churning license
// tokens upstream. We cap each user.id to N requests per window in-process
// (best-effort; fr is single-replica today, and the licenses service has
// its own server-side limits as the real backstop).
const REGEN_BUCKETS = new Map<string, number[]>();

function regenRatePerMin(): number {
  const raw = Number(process.env.FR_LICENSE_REGEN_RATE_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

function regenWindowMs(): number {
  const raw = Number(process.env.FR_LICENSE_REGEN_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

interface RateCheckBlocked {
  blocked: true;
  retryAfterSeconds: number;
}
interface RateCheckOk {
  blocked: false;
}

function checkAndRecordRegen(userId: string): RateCheckBlocked | RateCheckOk {
  const now = Date.now();
  const windowMs = regenWindowMs();
  const limit = regenRatePerMin();
  const cutoff = now - windowMs;
  const bucket = (REGEN_BUCKETS.get(userId) ?? []).filter((t) => t > cutoff);
  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? now;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1000),
    );
    REGEN_BUCKETS.set(userId, bucket);
    return { blocked: true, retryAfterSeconds };
  }
  bucket.push(now);
  REGEN_BUCKETS.set(userId, bucket);
  return { blocked: false };
}

function isFrApp(lic: LicenseRecord, allowedKeys: string[]): boolean {
  const k = lic.app?.key;
  return typeof k === 'string' && allowedKeys.includes(k);
}

/** Pull tenantId from ALS — undefined when no request frame is active. */
function tryActiveTenantId(): string | undefined {
  try {
    return getRequestContext().tenantId;
  } catch {
    return undefined;
  }
}

export interface MyLicensesResponse {
  subject_id: string;
  licenses: LicenseRecord[];
  usage: MyUsageResponse;
  costs: MyCostsResponse;
}

export async function handleListMyLicenses(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }
  // Scope usage + cost to the ACTIVE workspace (the tenant switcher), NOT
  // the logged-in subject. Real metering rolls up under a NULL-subject
  // sentinel, so a per-subject (/me) view is structurally always $0; the
  // Usage dashboard moved to workspace scope in #309 and this page now
  // mirrors it. The licenses list itself stays subject-scoped (the user's
  // own licenses), with the active tenant passed through explicitly.
  const activeTenantId = tryActiveTenantId();
  const range = monthWindow();

  // No active workspace → nothing to scope usage/cost to. Resolve to null
  // (→ EMPTY below) rather than calling upstream with no tenant, mirroring
  // routes/me/usage.ts. The breakdown is only consulted for markup_pct and
  // is best-effort (404-safe on older metering deploys).
  const usagePromise = activeTenantId
    ? getTenantUsageRange({ tenantId: activeTenantId, ...range, granularity: 'daily' })
    : Promise.resolve<UpstreamUsageResponse | null>(null);
  const costsPromise = activeTenantId
    ? getTenantCostsRange({ tenantId: activeTenantId, ...range })
    : Promise.resolve<UpstreamCostResponse | null>(null);
  const markupPromise = activeTenantId
    ? getTenantUsageBreakdown({ tenantId: activeTenantId, window: '30d' })
        .then((b) => b.markup_pct ?? null)
        .catch((err) => {
          // ⚠️ 404 ONLY -- see routes/me/usage.ts for the full reasoning. A bare
          // `() => null` here meant ANY metering failure set markupPct = null,
          // and `applyMarkup` returns its input unchanged for null, so the cost
          // card silently showed billed == incurred: the tenant priced AT COST,
          // indistinguishable from a legitimately zero-markup tenant.
          // A non-404 now REJECTS, which allSettled turns into a recorded entry
          // in `upstream_errors` below -- the card still renders, but it no
          // longer claims the figure is authoritative.
          if (!(isIntegrationError(err) && err.upstreamStatus === 404)) throw err;
          reportSwallowedFailure(err, {
            service: 'metering',
            method: 'GET',
            path: '/tenant-usage-breakdown',
            degradedTo: 'markup_pct=null (billed cost withheld for non-super-admins: cost_basis=unavailable)',
          });
          return null;
        })
    : Promise.resolve<number | null>(null);

  // allSettled (not all): one upstream blip shouldn't black-hole the others.
  // The page is a 3-card aggregator; partial data with a tagged outage is
  // strictly better UX than a single 500 with no signal which card failed.
  const [licensesResult, usageResult, costsResult, markupResult] =
    await Promise.allSettled([
      licensesClient.listLicensesForSubject(user.id, { tenantId: activeTenantId }),
      usagePromise,
      costsPromise,
      markupPromise,
    ]);

  /** The three cards the page cannot render without. `markup` is NOT one. */
  const PRIMARY_CARDS = ['licenses', 'usage', 'costs'] as const;
  const upstreamErrors: Record<string, string> = {};
  const recordError = (key: string, r: PromiseSettledResult<unknown>): void => {
    if (r.status === 'rejected') {
      const reason = r.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      // The raw message names fr's internal services and paths; it stays on
      // the log line. The browser only needs to know WHICH card is degraded.
      upstreamErrors[key] = 'unavailable';
      console.error(`[me/licenses] ${key} upstream failed:`, msg);
    }
  };
  recordError('licenses', licensesResult);
  recordError('usage', usageResult);
  recordError('costs', costsResult);
  // markup is recorded too. It used to be `.catch`'d to null unconditionally,
  // and this comment used to read "never an upstream error of its own" -- which
  // was the whole defect: the silence was documented as a feature.
  recordError('markup', markupResult);

  // If every primary upstream failed, signal 503 — the page would be empty
  // anyway, and the structured envelope tells the operator which cards failed.
  // ⚠️ Keyed on the three PRIMARY cards by name, not on `.length === 3`. The
  // count was a proxy for the predicate and silently stopped meaning the same
  // thing the moment `markup` became a fourth recordable key.
  if (PRIMARY_CARDS.every((k) => k in upstreamErrors)) {
    return jsonResponse(
      { error: 'upstream_unavailable', detail: upstreamErrors },
      503,
    );
  }

  const allLicenses = licensesResult.status === 'fulfilled' ? licensesResult.value : [];
  const markupPct = markupResult.status === 'fulfilled' ? markupResult.value : null;

  const usage =
    usageResult.status === 'fulfilled' && usageResult.value
      ? toMyUsage(user.id, usageResult.value)
      : EMPTY_USAGE(user.id);

  // Cost-card semantics mirror /settings/usage: normal users see BILLED
  // (incurred × tenant markup_pct); super-admins see raw INCURRED. The
  // per-provider rows carry incurred cost, so only super-admins get them
  // (empty for everyone else). markup_pct unknown (no tenant context, older
  // metering, or the markup read failed): a normal user gets NO figure
  // (`cost_basis: 'unavailable'`) — never the incurred one.
  const superAdmin = isSuperAdmin(user);
  const costs =
    costsResult.status === 'fulfilled' && costsResult.value
      ? toMyCosts(
          user.id,
          costsResult.value,
          superAdmin
            ? { display: costsResult.value.total_cost_usd ?? '0', basis: 'incurred' }
            : markupPct === null
              ? { display: null, basis: 'unavailable' }
              : {
                  display: applyMarkup(costsResult.value.total_cost_usd ?? '0', markupPct),
                  basis: 'billed',
                },
          superAdmin,
        )
      : EMPTY_COSTS(user.id);

  const allowedKeys = getFrAppKeys();
  const licenses = allLicenses.filter((lic) => isFrApp(lic, allowedKeys));
  const body: MyLicensesResponse & { upstream_errors?: Record<string, string> } = {
    subject_id: user.id,
    licenses,
    usage,
    costs,
  };
  if (Object.keys(upstreamErrors).length > 0) {
    body.upstream_errors = upstreamErrors;
  }
  return jsonResponse(body);
}

function EMPTY_USAGE(subjectId: string): MyUsageResponse {
  const now = new Date().toISOString();
  return {
    subject_id: subjectId,
    period: { from: now, to: now },
    totals: { request_count: 0, denied_count: 0, budget_denied_count: 0 },
    by_service: [],
  };
}

function EMPTY_COSTS(subjectId: string): MyCostsResponse {
  const now = new Date().toISOString();
  return {
    subject_id: subjectId,
    period: { from: now, to: now },
    totals: { input_tokens: 0, output_tokens: 0, total_cost_usd: '0.00' },
    cost_basis: 'billed',
    by_provider: [],
  };
}


/**
 * Adapt the tenant-scoped usage rollup (`/api/usage/tenant/{id}`) into the
 * licenses-page contract so the Svelte page reads the same shape it always
 * has. The tenant rollup has no budget-denied dimension → surface 0.
 */
function toMyUsage(subjectId: string, u: UpstreamUsageResponse): MyUsageResponse {
  return {
    subject_id: subjectId,
    period: { from: u.start, to: u.end },
    totals: {
      request_count: u.total_requests ?? 0,
      denied_count: u.total_denied ?? 0,
      budget_denied_count: 0,
    },
    by_service: (u.by_service ?? []).map((s) => ({
      service_key: s.service_key,
      request_count: s.request_count ?? 0,
      denied_count: s.denied_count ?? 0,
      budget_denied_count: 0,
    })),
  };
}

/**
 * Adapt the tenant-scoped cost rollup (`/api/costs/tenant/{id}`) into the
 * licenses-page contract. `displayCost` is the role-correct headline figure
 * (billed for normal users, incurred for super-admins); per-provider rows
 * keep their raw incurred cost. Note the upstream provider field is
 * `cost_usd`, which the licenses `CostBucket` calls `total_cost_usd`.
 */
function toMyCosts(
  subjectId: string,
  c: UpstreamCostResponse,
  displayCost: { display: string | null; basis: MyCostsResponse['cost_basis'] },
  /**
   * The per-provider rows carry INCURRED cost and internal provider names —
   * margin data. Only a super-admin gets them; everyone else gets `[]`.
   */
  includeProviders: boolean,
): MyCostsResponse {
  return {
    subject_id: subjectId,
    period: { from: c.start, to: c.end },
    totals: {
      input_tokens: c.total_input_tokens ?? 0,
      output_tokens: c.total_output_tokens ?? 0,
      total_cost_usd: displayCost.display,
    },
    cost_basis: displayCost.basis,
    by_provider: (includeProviders ? c.by_provider ?? [] : []).map((p) => ({
      provider: p.provider,
      input_tokens: p.input_tokens ?? 0,
      output_tokens: p.output_tokens ?? 0,
      total_cost_usd: p.cost_usd ?? '0.00',
    })),
  };
}

export async function handleRegenerateMyLicenseToken(
  req: Request,
  id: string,
): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }
  // Verify ownership: license_id must belong to one of the user's licenses
  // before we proxy. portal-bff does this server-side (routes/licenses.py:
  // 196-204) — never trust the path param alone.
  const owned = await licensesClient.listLicensesForSubject(user.id);
  if (!owned.some((l) => l.id === id)) {
    return jsonResponse({ error: 'license not found' }, 404);
  }
  const rate = checkAndRecordRegen(user.id);
  if (rate.blocked) {
    return jsonResponse(
      { error: 'rate limited', retry_after_seconds: rate.retryAfterSeconds },
      429,
    );
  }
  try {
    const result = await licensesClient.regenerateToken(id);
    return jsonResponse(result);
  } catch (e) {
    // Without this the rejection escapes to the generic handler, which has no
    // typed branch for an IntegrationError and answers 500 with
    // "Internal Server Error" — so a 409 whose body exists precisely to tell
    // the user what to do next reached the browser as an unexplained failure.
    // `integrationErrorResponse` preserves the upstream status (409 -> 409) and
    // emits `{error: {code, message, service, upstream: {status, body}}}`.
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

// ----- Super-admin per-tenant breakdown -------------------------------------

export interface PerTenantLicensesEntry {
  tenant_id: string;
  tenant_name: string | null;
  licenses: LicenseRecord[];
}

export interface PerTenantLicensesResponse {
  items: PerTenantLicensesEntry[];
}

/**
 * GET /api/me/licenses/by-tenant
 *
 * Super-admin only. Lists every license the calling user owns,
 * grouped by tenant — over the SAME workspace enumeration the header
 * switcher uses, `lib/accessible-tenants.ts`.
 *
 * ⚠️ This route used to keep its own copy of that enumeration, justified by a
 * comment saying the `/api/me/workspaces` handler "lives in a parallel
 * worktree". That reason expired, the copy drifted (no execution tenant, no
 * caller-own tenant), and the sibling `/api/me/usage/by-tenant` copy shipped
 * the same two omissions to the UI. One helper, three consumers — do not
 * re-fork it.
 *
 * ⛔ WHAT "BY TENANT" MEANS HERE (fixed 2026-11-06). The table answers "what
 * does each TENANT hold" — the page heading says exactly that. It used to read
 * `GET /licenses/user/{sub}`, which upstream ALWAYS filters by `subject_id`
 * first (licenses `main.py:4461-4462`); `X-Tenant-Id` only narrows that result
 * further. So it could only ever answer "what does THIS USER hold in that
 * tenant", and for a super-admin — the only caller this route admits — that is
 * nothing. Every workspace rendered "No fr-app licenses.", including ones
 * holding dozens (measured 2026-11-06: nonagentic-exec holds active `workers`,
 * `secrets`, `skill-builder` and `coding` licences and the page showed none).
 *
 * The tenant's own licences come from `GET /licenses/admin/all`, which carries
 * `tenant_id` and the joined app. ONE call also replaces the per-tenant fan-out
 * that had no timeout on this path (see the frontend's PER_TENANT_TIMEOUT_MS
 * note) — N upstream calls behind a single `Promise.all` with no deadline.
 * fr-only app key filter is applied to the grouped rows (same allowlist as the
 * single-tenant view).
 */
export async function handleListMyLicensesByTenant(req: Request): Promise<Response> {
  let user: Awaited<ReturnType<typeof validateAuth>>;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }
  if (!isSuperAdmin(user)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  const tenants = await listAccessibleTenants(user);
  const allowedKeys = getFrAppKeys();

  // ONE tenant-scoped read, not N subject-scoped ones — see the docstring.
  let registry: LicenseRecord[];
  try {
    registry = await adminListAllLicenses();
  } catch (e) {
    // ONE honest failure the page renders as an error, with its retry.
    // ⛔ Do NOT synthesize per-row `licenses: []` here: that is exactly the
    // defect this handler used to have — a failed read displayed as "these
    // tenants hold none", in a UI an operator acts on.
    reportSwallowedFailure(e, {
      service: 'licenses',
      method: 'GET',
      path: '/licenses/admin/all',
      degradedTo: 'the whole per-tenant licence breakdown is shown as an error',
    });
    return jsonResponse(
      {
        error: {
          code: 'LICENSES_UNREADABLE',
          message: 'Could not read the licence registry. Try again.',
        },
      },
      502,
    );
  }

  const byTenant = new Map<string, LicenseRecord[]>();
  for (const lic of registry) {
    if (!isFrApp(lic, allowedKeys)) continue;
    const tid = typeof lic.tenant_id === 'string' ? lic.tenant_id : '';
    if (!tid) continue;
    const bucket = byTenant.get(tid);
    if (bucket) bucket.push(lic);
    else byTenant.set(tid, [lic]);
  }

  const items: PerTenantLicensesEntry[] = tenants.map((t) => ({
    tenant_id: t.id,
    // `workspaces.name` is NOT NULL; the caller's own tenant falls back to its
    // id inside the helper. The field stays nullable on the wire.
    tenant_name: t.name,
    licenses: byTenant.get(t.id) ?? [],
  }));
  const body: PerTenantLicensesResponse = { items };
  return jsonResponse(body);
}
