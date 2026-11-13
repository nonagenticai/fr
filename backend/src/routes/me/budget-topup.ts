// src/routes/me/budget-topup.ts
//
// Tenant-admin self-serve budget top-up.
//
// A workspace-admin tops up THEIR OWN tenant's token budget by picking a
// package (every field a dropdown). No money changes hands today — the fleet
// has no payment processor — so this runs through the payment SEAM
// (services/billing/topup.ts) with FreeSettlement. When Stripe is wired, the
// route is untouched: only the injected Settlement changes.
//
// AUTH is per-tenant and DB-backed. The `workspace-admin` realm role in the JWT
// is global, but membership-of-THIS-tenant lives in the `user_roles` table
// (grantRole on provision). So the gate is `hasRole(user, activeTenant,
// 'workspace-admin')` — a user who is workspace-admin of tenant A must not top
// up tenant B by switching X-Active-Tenant. Super-admins bypass (they act
// across tenants; the super-admin console has its own any-tenant top-up).
// The Keycloak realm `tenant_admin` role also admits, but ONLY for the tenant
// named by the raw `tenant_id` claim (`isRealmTenantAdminOf`) — it is
// tenant-pinned, unlike the global `workspace-admin` claim, which is why this
// gate uses that arm and not `isWorkspaceAdminVia`.
//
// Every top-up writes a `budget_topups` audit row FIRST (status 'pending'),
// then settles, then allocates, then finalizes the row — so a crash mid-flight
// leaves a visible trail, exactly like the provisioning audit.

import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { getRequestContext } from '../../middleware/request-context';
import { db, budgetTopups } from '../../db/client';
import { hasRole, isRealmTenantAdminOf } from '../../services/user-roles';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import {
  isIntegrationError,
  integrationErrorResponse,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import { TOPUP_PACKAGES, findPackage, topUpBudget } from '../../services/billing/topup';
import { topUp } from '../../services/metering-admin';
import { config } from '../../config';
// The body schema (idempotency_key REQUIRED: a money endpoint) lives in
// ./budget-topup-schemas (side-effect free), shared with the capability declaration
// (fr-agui P4b part 3, capabilities/account/usage.ts).
import { TopupBody } from './budget-topup-schemas';

// ---------------------------------------------------------------------------
// Kill switch — BUDGET_TOPUP_ENABLED (config.budgetTopup.enabled, default OFF).
//
// George's ruling 2026-10-02: "No free top-up." Every package is priced 0 and
// FreeSettlement always reports "paid", so an open top-up route is unlimited
// free tokens for any tenant-admin. Until a real payment gateway is wired into
// the settlement seam, both top-up POSTs refuse with 409 BEFORE the audit
// INSERT or any billing call, and the package listings return no packages.
// ---------------------------------------------------------------------------
export function isBudgetTopupEnabled(): boolean {
  return config.budgetTopup.enabled;
}

export function topupUnavailableResponse(): Response {
  return jsonResponse(
    {
      error: 'topup_unavailable',
      message: 'Top-ups are unavailable until payment processing is enabled.',
    },
    409,
  );
}

/** Packages to LIST: none while top-up is disabled (shared by both dropdowns). */
export function listedTopupPackages(): Array<(typeof TOPUP_PACKAGES)[number]> {
  return isBudgetTopupEnabled() ? [...TOPUP_PACKAGES] : [];
}

function activeTenantId(): string | undefined {
  try {
    return getRequestContext().tenantId;
  } catch {
    return undefined;
  }
}

/** `GET /api/me/budget/packages` — the top-up options a dropdown binds to. */
export async function handleListTopupPackages(req: Request): Promise<Response> {
  await validateAuth(req);
  return jsonResponse({ packages: listedTopupPackages(), topupEnabled: isBudgetTopupEnabled() });
}

/**
 * `POST /api/me/budget/topup` — tenant-admin tops up their own active tenant.
 */
export async function handleTopUpMyBudget(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status =
      (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  const tenantId = activeTenantId();
  if (!tenantId) {
    return jsonResponse({ error: 'no active tenant' }, 400);
  }

  // Per-tenant gate: workspace-admin of THIS tenant, or a super-admin.
  const allowed =
    isSuperAdmin(user) ||
    isRealmTenantAdminOf(user, tenantId) ||
    (await hasRole(user.id, tenantId, 'workspace-admin'));
  if (!allowed) {
    return jsonResponse({ error: 'workspace-admin required for this tenant' }, 403);
  }

  if (!isBudgetTopupEnabled()) return topupUnavailableResponse();

  let body: z.infer<typeof TopupBody>;
  try {
    body = TopupBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'invalid request body', details: e.errors }, 422);
    }
    if (e instanceof SyntaxError) return jsonResponse({ error: 'invalid JSON body' }, 400);
    throw e;
  }

  const pkg = findPackage(body.package_id);
  if (!pkg) {
    return jsonResponse(
      { error: `unknown package '${body.package_id}'`, packages: TOPUP_PACKAGES.map((p) => p.id) },
      404,
    );
  }

  return runTopUp({ tenantId, actorUserId: user.id, pkg, idempotencyKey: body.idempotency_key });
}

/**
 * Shared top-up execution (used by the tenant-admin route and the super-admin
 * console route). Audits FIRST, then settle → allocate → finalize.
 *
 * IDEMPOTENT on (tenant_id, idempotency_key) — migration 118. The audit INSERT
 * is the dedupe gate, not a separate pre-flight SELECT: a SELECT-then-INSERT has
 * a window two concurrent submits both pass, which is precisely the double-click
 * this closes. ON CONFLICT DO NOTHING means the loser of that race inserts
 * nothing, so it never reaches `topUpBudget` and never allocates a second
 * billing budget; it replays the winner's outcome instead.
 */
export async function runTopUp(args: {
  tenantId: string;
  actorUserId: string;
  pkg: { id: string; tokens: number; priceUsd: number };
  idempotencyKey: string;
}): Promise<Response> {
  const { tenantId, actorUserId, pkg, idempotencyKey } = args;

  // 0. Kill switch (see top of file). Backstop for every caller: no audit row,
  //    no settlement, no allocation while top-up is disabled.
  if (!isBudgetTopupEnabled()) return topupUnavailableResponse();

  // 1. Open the audit row up front so a mid-flight crash leaves a trail. This
  //    INSERT is also the idempotency gate (see the docstring).
  const [row] = await db
    .insert(budgetTopups)
    .values({
      tenant_id: tenantId,
      actor_user_id: actorUserId,
      package_id: pkg.id,
      tokens: pkg.tokens,
      price_usd: String(pkg.priceUsd),
      status: 'pending',
      payment_status: pkg.priceUsd > 0 ? 'pending' : 'free',
      idempotency_key: idempotencyKey,
    })
    .onConflictDoNothing({
      target: [budgetTopups.tenant_id, budgetTopups.idempotency_key],
    })
    .returning({ id: budgetTopups.id });

  // No row inserted => this key already allocated (or is allocating). Replay the
  // ORIGINAL outcome. ⛔ Never fall through to topUpBudget here: that is the
  // double-credit. A 'failed' original is reported as such so the caller can
  // retry with a NEW key — retrying the SAME key must never re-allocate.
  if (!row) {
    const [existing] = await db
      .select()
      .from(budgetTopups)
      .where(
        and(
          eq(budgetTopups.tenant_id, tenantId),
          eq(budgetTopups.idempotency_key, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) {
      // The conflict proved a row exists, so an empty read is not "absent" — it
      // is a read that disagrees with the write we just made. Failing loudly
      // beats allocating a second budget on the strength of a bad read.
      return jsonResponse({ error: 'idempotency conflict but original not readable' }, 500);
    }
    return jsonResponse(
      {
        topup_id: existing.id,
        budget_id: existing.budget_id,
        tokens: existing.tokens,
        package_id: existing.package_id,
        payment_status: existing.payment_status,
        status: existing.status,
        idempotent_replay: true,
      },
      200,
    );
  }

  try {
    const result = await topUpBudget(
      {
        tenantId,
        tokens: pkg.tokens,
        priceUsd: pkg.priceUsd,
        packageId: pkg.id,
        actorUserId,
      },
      {
        // The `allocate` step: hand the tokens to billing's topup endpoint.
        allocate: async (intent) => {
          const { id } = await topUp({ tenantId: intent.tenantId, budgetTokens: intent.tokens });
          return { budgetId: id };
        },
      },
    );

    await db
      .update(budgetTopups)
      .set({
        budget_id: result.budgetId,
        payment_ref: result.paymentRef,
        payment_status: result.paymentStatus,
        status: 'allocated',
        updated_at: new Date(),
      })
      .where(eq(budgetTopups.id, row.id));

    return jsonResponse(
      {
        topup_id: row.id,
        budget_id: result.budgetId,
        tokens: result.tokens,
        package_id: result.packageId,
        payment_status: result.paymentStatus,
      },
      201,
    );
  } catch (e) {
    // Record the failure on the audit row (settle refused, or allocation
    // errored) rather than leaving it 'pending'.
    // ⚠️ A swallowed WRITE. If this UPDATE never lands the caller is 5xx'd but
    // the audit row stays 'pending' FOREVER in `GET /api/me/budget/topups` —
    // there is no reaper — so a top-up that definitively failed reads to the
    // tenant as one still in flight. The swallow is KEPT (this path must still
    // return the integration error, not become a second failure), but it is now
    // recorded, and `.returning` is what makes a ZERO-ROW match visible: an
    // UPDATE that matched nothing does not throw and is otherwise byte-identical
    // to success.
    const failedUpdate = await db
      .update(budgetTopups)
      .set({
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
        updated_at: new Date(),
      })
      .where(eq(budgetTopups.id, row.id))
      .returning({ id: budgetTopups.id })
      .catch((err) => {
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `top-up ${row.id} stays 'pending' forever in GET /api/me/budget/topups, so a failed top-up reads to the tenant as one still in flight`,
        });
        // ⛔ NOT `[]`. An empty array would also satisfy the zero-row test
        // below, emitting a SECOND report asserting the UPDATE "matched 0 rows"
        // — a cause that did not happen (it THREW; it never matched anything).
        // That double-counts ONE failure in the ranking `alreadyReported` exists
        // to protect. `null` is the sentinel for "never resolved", so the
        // zero-row check is reachable only when the UPDATE actually RESOLVED.
        return null;
      });
    if (failedUpdate !== null && failedUpdate.length === 0) {
      reportSwallowedFailure(
        new Error(`budget_topups UPDATE matched 0 rows for ${row.id}`),
        {
          service: 'fr-db',
          degradedTo: `top-up ${row.id} not marked failed (0 rows matched); it stays 'pending' forever in GET /api/me/budget/topups`,
        },
      );
    }
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

/** `GET /api/me/budget/topups` — this tenant's top-up history (audit). */
export async function handleListMyTopups(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const tenantId = activeTenantId();
  if (!tenantId) return jsonResponse({ error: 'no active tenant' }, 400);

  const allowed =
    isSuperAdmin(user) ||
    isRealmTenantAdminOf(user, tenantId) ||
    (await hasRole(user.id, tenantId, 'workspace-admin'));
  if (!allowed) return jsonResponse({ error: 'workspace-admin required for this tenant' }, 403);

  const rows = await db
    .select()
    .from(budgetTopups)
    .where(and(eq(budgetTopups.tenant_id, tenantId)))
    .orderBy(desc(budgetTopups.created_at))
    .limit(50);

  return jsonResponse({ topups: rows });
}
