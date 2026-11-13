// src/routes/engagements/deliveries.ts
//
// Wave 4 / Task 4.1 — read-only API over the `engagement_deliveries` audit
// table populated by `notifications.fanOutToUser` and the action-approvals
// fan-out paths. The frontend (Wave 5) renders this as the delivery audit
// trail; operators use it to debug a missing message without poking the DB.
//
// Endpoints:
//   GET /api/engagements/deliveries
//   GET /api/engagements/deliveries/:id
//
// Authn: existing FR auth middleware (`validateAuth`). Authz: BOTH handlers
// share ONE visibility clause (`visibilityClause` below) — see issue #988.
//   - Everyone: their own rows (`recipient_user_id = ctx.userId`), always,
//     and never tenant-scoped.
//   - Admins: additionally the rows whose APPROVAL belongs to the caller's
//     active tenant. Admin is no longer an unscoped read of every tenant.
//   - Super-admin in home view: the omniscient read (the only way anyone
//     audits rows whose tenant cannot be established).
//     The `userId` query param is silently ignored for non-admins (no 403,
//     just a no-op override) — it is a FILTER under the clause above, never
//     the gate.
//
// Admin bridge:
//   E-12 RBAC (`src/agui/rbac.ts`) only knows `tenant-role`, `project-role`,
//   `project-member`, `public`, `custom` — no generic `{ type: 'role',
//   role: 'admin' }`. Admin status is resolved by `isWorkspaceAdminVia`:
//   a `user_roles` row with role='workspace-admin' for the caller's tenant,
//   or the realm `tenant_admin` / `admin` role pinned to the raw `tenant_id`
//   claim. There is no DB-level 'admin' role (migration 104 CHECK).
//
// Tenant id contract:
//   `user.tenantId` MUST be a UUID (UUIDv7 going forward — see
//   src/utils/tenant.ts). Legacy Keycloak claims that still emit a
//   non-UUID string (e.g. "gerard-dev") gracefully degrade to "no
//   DB-backed admin" via the user_roles short-circuit; the Keycloak
//   `roles` claim path runs first and remains functional for those
//   users until the realm migration ships UUIDv7 + tenant_name claims.
import { z } from 'zod';
import { ListQuerySchema } from './deliveries-schemas';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { approvals, db, engagementDeliveries } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { isValidUuid } from '../../utils/tenant';
import type { User } from '../../types/api';
import { jsonResponse } from '../../utils/response';
import { serializeCount } from '../../lib/resolution';
import { NotFoundError } from '../../utils/errors';
import { userRolesService } from '../../services/user-roles';
import { clientSafeStoredErrorText, clientSafeStoredJson } from '../../integrations/_lib/errors';

/**
 * `engagement_deliveries.error` holds the RAW transport failure — an adapter's
 * caught `err.message` (relay hosts, internal paths) or an approved action's
 * thrown text. Operators triage from that column, so it is stored as-is and
 * rewritten here, on the way out, for every caller who is not a super-admin.
 */
const DELIVERY_ERROR_REDACTED = 'Delivery failed — the detail is available to an operator';
type DeliveryRow = typeof engagementDeliveries.$inferSelect;
/**
 * `metadata_json` is the same class of leak one level down: for an approved
 * action it is the handler's raw return value (`executeApprovedAction`), so an
 * action that reports a failure in its OUTPUT (`errors: [...]`,
 * `kanban_error`, ...) stores that text there — and rows written before the
 * per-action write-path fixes still hold raw adapter / upstream text. Every
 * error-keyed string is rewritten for a non-super-admin; the column is not.
 */
const DELIVERY_METADATA_ERROR_REDACTED = 'failed — the detail is available to an operator';
function clientSafeDelivery(row: DeliveryRow): DeliveryRow {
  return {
    ...row,
    error: clientSafeStoredErrorText(row.error, DELIVERY_ERROR_REDACTED),
    metadata_json: clientSafeStoredJson(row.metadata_json, DELIVERY_METADATA_ERROR_REDACTED),
  };
}

// ---------- Admin bridge ---------------------------------------------------

/**
 * Admin check — delegates to `isWorkspaceAdminVia` (THE RULE lives there).
 */
async function isAdmin(user: User): Promise<boolean> {
  // Same defect as channels.ts: the DB path checked only 'admin', a value no
  // real grant carries. Shared test reads only 'workspace-admin' from the DB.
  return userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
}

// ---------- Shared visibility (issue #988) --------------------------------
//
// `engagement_deliveries` has NO tenant_id column, so "which tenant does this
// row belong to" is only answerable through the approval the delivery was
// raised for: `engagement_id` (TEXT) -> `approvals.id` (uuid). Both handlers
// used to gate on `isAdmin(user)` alone, which resolves against the CALLER's
// tenant and never the ROW's — so `GET /api/engagements/deliveries?limit=500`
// as any tenant's admin returned rows from every tenant.
//
// Both read paths now build on ONE clause, so neither can be fixed — or
// re-broken — alone:
//
//   visible(row) = recipient_user_id = ctx.userId                       -- self, ALWAYS
//               OR ((isAdmin || isSuperAdmin) && a.tenant_id = <active tenant>)  -- a = approvals
//
// fr row 14d: the super-admin home-view `true` lane (every tenant's rows,
// orphans included) is GONE. A super-admin reads the ACTIVE tenant's rows like
// a tenant admin; reaching another workspace is the explicit switch.
//
// Four load-bearing details, each measured. Do not "simplify" them:
//
//  1. The join NEVER casts the text column. `engagement_id` is TEXT and holds
//     non-UUID values, so `engagement_id::uuid` THROWS and takes the whole
//     query with it (a 500, not a filtered result). uuid -> text is total, so
//     the cast goes on `approvals.id` instead.
//  2. LEFT JOIN + `a.tenant_id = $x` is null-rejecting, which is exactly the
//     wanted behaviour: a row whose approval does not exist (null, orphaned,
//     or non-UUID `engagement_id`) has no establishable tenant and is
//     therefore invisible to everyone except its own recipient. That fails
//     CLOSED for free — no extra predicate, and no exception for it.
//  3. Self rows are deliberately NOT tenant-scoped. 91% of rows have
//     recipient-tenant != approval-tenant (a fallback approver in tenant Y
//     legitimately receives an approval raised in tenant X), so scoping self
//     rows would delete most recipients' own delivery log.
//  4. The admin disjunct is guarded by `isValidUuid(activeTenant)`.
//     `ctxTenantId()` can return a legacy non-UUID claim such as
//     'gerard-dev' — the documented live prod 500 of 2026-04-27 — and
//     comparing that against a uuid column throws. When the active tenant is
//     not a uuid the disjunct is omitted entirely => self rows only. Fail
//     closed, never 500.

/**
 * The delivery -> approval edge. `approvals.id` (uuid) is cast to text; the
 * TEXT `engagement_id` is never cast to uuid (see note 1 above).
 */
const APPROVAL_JOIN: SQL = sql`${approvals.id}::text = ${engagementDeliveries.engagement_id}`;

/** The shared clause. See the block comment above for why each term exists. */
function visibilityClause(user: User, admin: boolean): SQL {
  // Self rows, always, unscoped by tenant (note 3).
  const disjuncts: SQL[] = [
    eq(engagementDeliveries.recipient_user_id, user.id),
  ];

  // fr row 14d: a super-admin gets the tenant-admin disjunct (active tenant
  // only), never a cross-tenant `true`.
  if (admin || isSuperAdmin(user)) {
    const activeTenant = ctxTenantId(user.tenantId);
    // Note 4 — a non-uuid tenant claim omits the disjunct instead of throwing.
    if (isValidUuid(activeTenant)) {
      disjuncts.push(eq(approvals.tenant_id, activeTenant));
    }
  }

  return disjuncts.length === 1 ? disjuncts[0]! : or(...disjuncts)!;
}

/**
 * The single query both handlers read through: the visibility clause AND'ed
 * with whatever request filters the caller supplied (`extra`). Callers add
 * ordering / limits; they never add another WHERE.
 */
function visibleDeliveries(user: User, admin: boolean, extra: SQL[]) {
  return db
    .select(getTableColumns(engagementDeliveries))
    .from(engagementDeliveries)
    .leftJoin(approvals, APPROVAL_JOIN)
    .where(deliveriesWhere(user, admin, extra));
}

/**
 * ⭐ THE PREDICATE, EXTRACTED SO THE PAGE AND ITS COUNT CANNOT DIVERGE.
 *
 * The trap this closes: "WHETHER
 * `totalMatching` COUNTS THE SAME PREDICATE AS THE ROWS — a `COUNT(*)` over a
 * different WHERE is a fresh lie in the sanctioned spelling." A re-derived copy
 * of this `and(...)` is exactly how that happens, so there is only one copy and
 * both readers call it. Same for the JOIN: `visibilityClause` can reference
 * `approvals`, so a count that skipped `APPROVAL_JOIN` would not even compile
 * the same query.
 */
function deliveriesWhere(user: User, admin: boolean, extra: SQL[]): SQL {
  return and(visibilityClause(user, admin), ...extra)!;
}

/** The TRUE match count for the same set `visibleDeliveries` pages over. */
function countVisibleDeliveries(user: User, admin: boolean, extra: SQL[]) {
  return db
    .select({ n: count() })
    .from(engagementDeliveries)
    .leftJoin(approvals, APPROVAL_JOIN)
    .where(deliveriesWhere(user, admin, extra));
}

// ---------- Query schema --------------------------------------------------

// The list query schema lives in deliveries-schemas.ts (side-effect free: the
// fr-agui capability declaration shares it, P4c part 1).

type ListQuery = z.infer<typeof ListQuerySchema>;

const DEFAULT_LIMIT = 100;

// ---------- Handlers ------------------------------------------------------

/** GET /api/engagements/deliveries */
export async function handleListDeliveries(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const params: ListQuery = ListQuerySchema.parse(raw);
  const admin = await isAdmin(user);

  // `userId` is a FILTER AND'ed under the visibility clause, never the gate
  // (which is what the pre-#988 code made it: admin + no userId meant no
  // recipient predicate at all, and there was no tenant predicate anywhere).
  // Non-admins keep the documented no-op override — the clause already pins
  // them to their own rows, so honouring their param would turn a documented
  // silent-ignore into an empty list.
  const canFilterByUser = admin || isSuperAdmin(user);
  const recipientUserId = canFilterByUser ? params.userId ?? null : null;

  const conditions: SQL[] = [];
  if (recipientUserId !== null) {
    conditions.push(eq(engagementDeliveries.recipient_user_id, recipientUserId));
  }
  if (params.channel) {
    conditions.push(eq(engagementDeliveries.channel, params.channel));
  }
  if (params.status) {
    conditions.push(eq(engagementDeliveries.status, params.status));
  }
  if (params.actionId) {
    conditions.push(eq(engagementDeliveries.action_id, params.actionId));
  }
  if (params.since) {
    conditions.push(gte(engagementDeliveries.created_at, new Date(params.since)));
  }

  const limit = params.limit ?? DEFAULT_LIMIT;

  const [rows, totalRows] = await Promise.all([
    visibleDeliveries(user, admin, conditions)
      .orderBy(desc(engagementDeliveries.created_at))
      .limit(limit),
    countVisibleDeliveries(user, admin, conditions),
  ]);

  // `meta.count` is the TRUE number of matching deliveries, not the size of the
  // page that was just cut, and `count_kind` states which of the two it is.
  //
  // ⚠️ THE EARLIER VERSION OF THIS SITE KEPT `count: rows.length` AND JUSTIFIED
  // IT WITH A CLAIM ABOUT THE FRONTEND THAT THE FRONTEND REFUTES. It said
  // `frontend/src/routes/engagements/deliveries/+page.svelte:176` "ends
  // pagination when the returned count is strictly less than the requested
  // limit", so an honest total would loop forever. MEASURED 2026-09-26: that
  // page's end-of-list test is `+page.svelte:179`,
  //
  //     let hasMore = $derived(rows.length === limit);   // rows = out.data
  //
  // — it reads `out.data`, and `out.meta` is read NOWHERE in the page (the only
  // uses of `out` are at :127 and :129, both `out.data`). `listDeliveries` has
  // exactly one caller. So the pager measures the array it renders and an
  // honest `meta.count` cannot reach it.
  //
  // ⛔ The lesson is the one this whole change is about: the exemption was not
  // wrong because the number was wrong, it was wrong because the REASON was
  // never measured. An unverified justification is the same defect as an
  // unverified count.
  //
  // `X-Truncated` stays `false` here even on a cut page, and that is the
  // repo's adjudicated meaning: a COUNT(*) ran, so the TOTAL is not truncated
  // even though the PAGE was. Same wording as
  // `tests/integration/routes/scheduled-reports.integration.test.ts:447`.
  const { total, total_kind, headers } = serializeCount({
    rows,
    appliedLimit: limit,
    totalMatching: totalRows[0]?.n ?? null,
  });
  return jsonResponse(
    { data: rows.map(clientSafeDelivery), meta: { count: total, count_kind: total_kind } },
    200,
    headers,
  );
}

/** GET /api/engagements/deliveries/:id */
export async function handleGetDelivery(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);

  // Validate path param so a malformed id doesn't reach the driver as a
  // CAST failure (which would surface as a 500). Non-uuid → 404, mirroring
  // the "not yours and not admin" path.
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) {
    throw new NotFoundError('Delivery not found');
  }

  const admin = await isAdmin(user);

  // The id is just one more AND'ed predicate on the SHARED query — there is no
  // `isAdmin(user) ||` short-circuit here any more. An invisible row is
  // indistinguishable from a missing one (404 either way), which is also what
  // keeps us from leaking the existence of another tenant's delivery.
  const rows = await visibleDeliveries(user, admin, [
    eq(engagementDeliveries.id, parsed.data),
  ]).limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError('Delivery not found');

  return jsonResponse({ data: clientSafeDelivery(row) });
}
