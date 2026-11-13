// src/routes/admin/assets/projects.ts
//
// Super-admin asset console — projects proxy.
//
// Surface (rooted at /api/admin/assets/projects):
//   GET    /                  — list (`?untagged=1`: fleet view only — the
//                                untagged projects, id/name/archived only)
//   GET    /:id                — fetch one
//   PATCH  /:id                — fr-local admin fields only (status;
//                                status='archived' is REJECTED — see below).
//                                name/title/description and every other
//                                RM-owned field → 422 rm_owned_field (v4 ruling 1)
//   DELETE /:id                — soft delete (status='archived') via the shared
//                                `archiveProjectWithPurge` service, which purges
//                                the project's documents' downstream PHI first
//
// Notes specific to this kind:
//
// 1. The `projects` table has NO `tenant_id` / `workspace_id` column;
//    projects are owned by a Keycloak user (`owner_id`). The admin
//    console's "active workspace" therefore can't be a SQL filter.
//    Scope rule:
//      - active tenant === system + caller is super-admin → fleet view:
//        every project whose own tag (`project_data.keycloak_tenant_id`) is a
//        PLATFORM tenant (fr row 14c). A customer-tagged project is never in
//        the fleet view, and a NULL/blank tag fails closed (excluded).
//      - any other workspace → `owner_id = user.id` AND tag == the active
//        tenant (fr row 14b), identical to /api/projects.
//    `is_system` is always `false` (projects aren't inherited).
//
// 2. Create is intentionally NOT exposed here. Project creation needs
//    repo URL + provisioning side effects (planka board, container,
//    secret bindings) — that flow lives at POST /api/projects and is
//    deliberately not duplicated. The admin console links out to the
//    main /projects flow for create.

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { DELIVERED_PROJECT_STATUS } from '../../../lib/project-live-status';
import { db } from '../../../db/client';
import { projects } from '../../../db/schema';
import { validateAuth } from '../../../middleware/auth';
import { getRequestContext } from '../../../integrations/_lib/context';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../middleware/internal-tenant-only';
import { isSuperAdmin } from '../../../lib/super-admin-gate';
import {
  archiveProjectWithPurge,
  ProjectArchiveGuardRefusedError,
} from '../../../services/project-archive';
import { PROJECT_KC_TENANT, projectTaggedForTenant } from '../../../lib/project-access';
import { jsonResponse } from '../../../utils/response';
import { PLATFORM_TENANT_IDS } from '../../assets/_lib/system-union';
import { gateReadAsset, gateWriteAsset } from './_lib/gate';
import { PatchProjectSchema } from './projects-schemas';
import { RM_OWNED_PATCH_KEYS, RM_OWNED_PROJECT_FIELD } from '../../projects';

type AnyRecord = Record<string, unknown>;
function tagSystem<T extends AnyRecord>(row: T, isSystem: boolean): T & { is_system: boolean } {
  return { ...row, is_system: isSystem };
}

/**
 * Return true if the caller should see the fleet view (all projects),
 * false if they should be scoped to their own owner_id rows.
 */
function isFleetView(
  user: { roles?: readonly string[] },
  tenantId: string,
): boolean {
  return tenantId === INTERNAL_SYSTEM_TENANT_ID && isSuperAdmin(user);
}

/**
 * fr row 14c: the fleet view's SQL barrier — the project's own tag is a
 * PLATFORM tenant. `IN (...)` never matches a NULL tag, so untagged rows fail
 * closed.
 *
 * fr row 14d: this SQL predicate is now the ONLY decision for every lane —
 * list, GET, and the PATCH/DELETE writes. The JS twins (`isFleetPlatformRow`,
 * `isOwnedInActiveTenant`) trimmed the tag via `projectKcTenantTag`, so a
 * whitespace-padded platform tag was invisible to list/GET (exact SQL match)
 * yet PATCH 200 / DELETE 204 succeeded. Exact match everywhere is the
 * fail-closed choice: a padded or blank tag is a malformed tag, and a
 * malformed tag must grant nothing (it still surfaces nowhere but
 * `?untagged=1`'s blank lane, never as a platform row). Do not reintroduce a
 * trimming JS twin for an access decision.
 */
function fleetPlatformTagged() {
  return inArray(PROJECT_KC_TENANT, [...PLATFORM_TENANT_IDS]);
}

/**
 * ⛔ P1-TEAM-a: the admin asset console does NOT inherit the tenant-member
 * widening (George 2026-10-15 — role gates stay). Its non-fleet lane keeps the
 * pre-P1-TEAM rule, spelled locally so a change to the member lane in
 * lib/project-access.ts can never widen this console: owner AND the project's
 * own tag == the active tenant (fr row 14b; blank active fails closed).
 */
function adminConsoleOwnedProjectInTenant(userId: string, active: string) {
  return and(eq(projects.owner_id, userId), projectTaggedForTenant(active))!;
}

/**
 * The single access predicate for one caller, shared by GET, PATCH's UPDATE
 * and DELETE's load + archive flip: fleet → platform-tagged; anyone else →
 * owner AND tag == active tenant (fr row 14b; blank active fails closed).
 */
function accessPredicate(fleet: boolean, userId: string, active: string) {
  return fleet ? fleetPlatformTagged() : adminConsoleOwnedProjectInTenant(userId, active);
}

export async function handleListAdminProjects(req: Request): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const ctx = getRequestContext();
  const active = ctx.tenantId;
  if (!active) return jsonResponse({ error: 'no_active_tenant' }, 400);

  const fleet = isFleetView(user, active);
  // fr row 14c: read-only list of the UNTAGGED projects (they are in no
  // tenant's view, fleet included), so a platform super-admin can find them.
  // Identity columns only — never project_data or any content.
  if (new URL(req.url).searchParams.get('untagged') === '1') {
    if (!fleet) return jsonResponse({ error: 'fleet_view_only' }, 403);
    const untagged = await db
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projects)
      .where(or(isNull(PROJECT_KC_TENANT), eq(sql`btrim(${PROJECT_KC_TENANT})`, '')));
    return jsonResponse({
      projects: untagged.map((r) => ({ id: r.id, name: r.name, archived: r.status === 'archived' })),
    });
  }

  const rows = fleet
    ? await db.select().from(projects).where(fleetPlatformTagged())
    : // fr row 14b: owner AND the project's own tag == the active tenant.
      // Ownership alone never grants cross-tenant access; NULL tag fails closed.
      await db.select().from(projects).where(adminConsoleOwnedProjectInTenant(user.id, active));

  const tagged = rows.map((r) => tagSystem(r as unknown as AnyRecord, false));
  return jsonResponse({ projects: tagged });
}

export async function handleGetAdminProject(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const ctx = getRequestContext();
  const active = ctx.tenantId;
  if (!active) return jsonResponse({ error: 'no_active_tenant' }, 400);

  const fleet = isFleetView(user, active);
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), accessPredicate(fleet, user.id, active)));
  if (!row) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse({ project: tagSystem(row as unknown as AnyRecord, false) });
}

// Only fr-local admin fields. ⛔ The name/title, the description and every other
// RM-owned field are requirements_management's after the request (George v4
// ruling 1; only the PM writes them): a body naming one is refused 422
// `rm_owned_field` with `fields`, exactly like PATCH /api/projects/:id
// (RM_OWNED_PATCH_KEYS). fr's own row `status` (submitted|active) stays — it is
// fr's lifecycle column, not RM's. Status updates beyond {active|submitted}
// stay in the main flow because they trigger downstream effects.
//
// `'archived'` is deliberately NOT accepted here. Archiving is not a metadata
// edit — it carries the HIPAA right-to-delete obligation to purge every one of
// the project's documents' downstream PHI first (see services/project-archive.ts).
// A bare PATCH that wrote status='archived' would archive the project while
// leaving that PHI live, i.e. it would be an alternate route around the DELETE
// handler's purge. Archive goes through DELETE /api/admin/assets/projects/:id.
// (`PatchProjectSchema` itself: ./projects-schemas.ts, side-effect free — fr-agui P4c part 2.)

/** fr-local admin keys that share a name with an RM-owned PATCH key (fr's row status). */
const FR_LOCAL_ADMIN_KEYS: ReadonlySet<string> = new Set(['status']);

export async function handleUpdateAdminProject(
  req: Request,
  id: string,
): Promise<Response> {
  // We re-implement the ownership gate here because gateWriteAsset is built
  // around the tenant/workspace-admin model; projects' authority lives on
  // owner_id. Super-admin on system (fleet view) reaches PLATFORM-tagged
  // projects only (fr row 14c); else owner AND tag == active must match.
  try {
    await validateAuth(req);
  } catch (e) {
    const status =
      (e as { status?: number; statusCode?: number }).statusCode ??
      (e as { status?: number }).status ??
      401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }
  // gateWriteAsset still enforces "super-admin only on system tenant" for
  // mutations — even projects mutations — so a non-super-admin can never
  // write while X-Active-Tenant pins them to system.
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  const user = gate.user;

  let body;
  try {
    const raw = (await req.json()) as unknown;
    // Explicit, stable rejection ahead of the schema so the console shows WHY
    // rather than a generic enum error. Archiving must run the purge — see the
    // note on PatchProjectSchema.
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { status?: unknown }).status === 'archived'
    ) {
      return jsonResponse(
        {
          error: 'archive_via_delete',
          detail:
            "status='archived' cannot be set via PATCH: archiving must purge the " +
            "project's documents' downstream PHI first (HIPAA right-to-delete). " +
            'Use DELETE /api/admin/assets/projects/:id.',
        },
        400,
      );
    }
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const owned = Object.keys(raw as Record<string, unknown>)
        .filter((k) => RM_OWNED_PATCH_KEYS.has(k) && !FR_LOCAL_ADMIN_KEYS.has(k))
        .sort();
      if (owned.length > 0) {
        return jsonResponse(
          {
            error: RM_OWNED_PROJECT_FIELD,
            code: RM_OWNED_PROJECT_FIELD,
            fields: owned,
            detail:
              `requirements_management owns ${owned.join(', ')} after the project request; ` +
              `only the PM writes ${owned.length === 1 ? 'it' : 'them'} — fr accepts no edit`,
          },
          422,
        );
      }
    }
    body = PatchProjectSchema.parse(raw);
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }

  const ctx = getRequestContext();
  const active = ctx.tenantId ?? '';
  const fleet = isFleetView(user, active);

  const update: Partial<typeof projects.$inferInsert> = { updated_at: new Date() };
  if (body.status !== undefined) update.status = body.status;

  // fr row 14d: the access predicate is IN the UPDATE's WHERE — check and
  // write are one statement, so a concurrent retag cannot slip between a
  // load-then-decide and a write-by-id. 0 rows → 404 (missing and
  // not-yours look identical; existence is not leaked).
  // Migration 173: `delivered` is TERMINAL (written once RM closes the project —
  // services/project-delivered.ts). A status PATCH would revert it to submitted/active — re-opening
  // the repo's one-live-bug_hunt slot behind the evidence's back — so a status write never lands on
  // a delivered row (guard IN the UPDATE: race-safe).
  const notDelivered = body.status !== undefined ? ne(projects.status, DELIVERED_PROJECT_STATUS) : undefined;
  const [updated] = await db
    .update(projects)
    .set(update)
    .where(and(eq(projects.id, id), accessPredicate(fleet, user.id, active), notDelivered))
    .returning();
  if (!updated) {
    if (notDelivered) {
      const [visible] = await db
        .select({ status: projects.status })
        .from(projects)
        .where(and(eq(projects.id, id), accessPredicate(fleet, user.id, active)));
      if (visible?.status === DELIVERED_PROJECT_STATUS) {
        return jsonResponse(
          {
            error: 'project_delivered',
            detail: "a delivered project's status is terminal; it cannot be set via PATCH (archive via DELETE).",
          },
          409,
        );
      }
    }
    return jsonResponse({ error: 'not_found' }, 404);
  }
  return jsonResponse({ project: tagSystem(updated as unknown as AnyRecord, false) });
}

// OPTIONAL body `{ "keep_board": true }` on the admin DELETE — archive the
// project but leave its Planka board standing (fr#1142). DELETE bodies are
// optional by definition and every shipped caller sends none, so an absent or
// empty body MUST NOT be a 400: parse defensively and default to the existing
// behaviour (tear down). Strict boolean only — `"keep_board": "yes"` and any
// other truthy-but-non-boolean value stay `false` rather than being coerced,
// so a client mistake reads as "unset" instead of silently doing the opposite
// of what a loose-truthy read would produce.
// Deliberately NOT on the user-facing DELETE /api/projects/:id — `keep_board`
// is available to whoever `gateWriteAsset` already admits to this endpoint
// (fleet super-admin, or the workspace-admin who owns the project's tenant),
// not just super-admins. That is not a wider escalation than the delete
// itself already grants: anyone who may archive this project outright may
// also choose to leave its board standing while doing so.
export async function parseKeepBoard(req: Request): Promise<boolean> {
  try {
    const raw = await req.text();
    if (!raw.trim()) return false;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { keep_board?: unknown }).keep_board === 'boolean'
    ) {
      return (parsed as { keep_board: boolean }).keep_board;
    }
    return false;
  } catch {
    // Unreadable/non-JSON body: ignored, not rejected. The delete is the
    // request; `keep_board` is a modifier, and its absence has a safe default.
    return false;
  }
}

export async function handleDeleteAdminProject(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const keepBoard = await parseKeepBoard(req);

  const ctx = getRequestContext();
  const active = ctx.tenantId ?? '';
  const fleet = isFleetView(user, active);

  // fr row 14d: the load carries the SAME SQL predicate as list/GET (no
  // trimming JS twin), and the archive's status flip carries it again as
  // `guard`, so the write itself refuses a row that stopped qualifying.
  // Residual window, stated: the purge and approval void run BEFORE the flip
  // (they must — see services/project-archive.ts) and are not covered by the
  // guard; closing that needs a row lock held across external I/O, which
  // would deadlock against the archive's own by-id writes on other
  // connections. Nothing on this surface can retag (PatchProjectSchema is
  // strict), so the window is theoretical.
  const guard = accessPredicate(fleet, user.id, active);
  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), guard));
  if (!existing) return jsonResponse({ error: 'not_found' }, 404);

  // Soft delete via the ONE sanctioned archive path (services/project-archive.ts):
  // purge every document's downstream PHI first (HIPAA right-to-delete), then flip
  // status to 'archived', then tear the Planka board down. Fail-closed comes free:
  // a purge failure THROWS, so the archive does not happen and the delete stays
  // retryable. This matters most HERE — a fleet-view super-admin reaches other
  // (platform) tenants' projects from this surface, so a non-purging archive was a
  // cross-tenant right-to-delete bypass.
  //
  // Note the caller's active tenant is passed for context only; each document is
  // purged under ITS OWN recorded tenant (record-and-replay). A fleet-view admin's
  // active tenant is the internal system tenant, which matches zero real document
  // rows — scoping the purge by it would silently purge nothing.
  // `actor` is recorded on every approval this archive voids (fr#1134) —
  // `approvals.voided_by` is free text and the super-admin's own id is the
  // honest answer to "who withdrew this question".
  try {
    await archiveProjectWithPurge(existing, {
      tenantId: active,
      keepBoard,
      actor: user.id,
      guard,
    });
  } catch (e) {
    if (e instanceof ProjectArchiveGuardRefusedError) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    throw e;
  }

  return new Response(null, { status: 204 });
}
