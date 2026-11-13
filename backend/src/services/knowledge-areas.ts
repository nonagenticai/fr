// src/services/knowledge-areas.ts
//
// DB ACCESS for per-member knowledge areas (`member_knowledge_areas`, migration
// 135) and for per-project ALLOCATION of those same areas
// (`project_stakeholders`, migration 074).
//
// The vocabulary and every pure rule live in lib/knowledge-areas.ts — read that
// file first. This one only talks to postgres.
//
// ── TWO TABLES, ONE VOCABULARY, AND THE REASON THEY ARE SEPARATE ────────────
// `member_knowledge_areas` is the TENANT-WIDE fact: "member A knows about
// `architecture`". `project_stakeholders` is the PER-PROJECT allocation: "on
// THIS project, ask member A about `architecture`". A project allocation is
// deliberately NOT required to be a subset of the tenant-wide set — a person can
// be the right one to ask on one project without that being a standing claim —
// but the tenant-wide set is what the project-creation form prefills from, which
// is the operator's "prefill based on known tenant members and their roles".
//
// ⛔ THE ONE THING THIS MODULE MUST NEVER TOUCH: `project_stakeholders` rows whose
// role is `execution_signoff`. That role is the EXECUTION SIGN-OFF ROSTER —
// `routes/execution-approvals.ts` reads it to build an approval's
// `required_approvers` and fan out to each approver. Changing who signs off is a
// different decision, with a different blast radius, and it is explicitly out of
// this module's scope. Every write below is therefore SCOPED TO THE TENANT'S
// AREA VOCABULARY (`inArray(role, areaRoles(vocabulary))`), never to "all roles this user
// holds on this project". MEASURED on the prod primary 2026-09-27:
// `project_stakeholders` holds 113 rows and exactly ONE distinct role,
// `execution_signoff` — i.e. TODAY EVERY ROW IN THAT TABLE IS ONE THIS MODULE
// MUST NOT DELETE. A `delete where project_id = $1 and user_id = $2` would have
// silently emptied a live sign-off roster.

import { and, eq, inArray } from 'drizzle-orm';

import {
  db as defaultDb,
  memberKnowledgeAreas,
  projectStakeholders,
} from '../db/client';
import { NON_AREA_STAKEHOLDER_ROLES, normaliseAreas, planAllocation } from '../lib/knowledge-areas';

/**
 * The roles an allocation read/write may touch: the tenant's knowledge areas
 * (its RM capability names, passed by the caller) minus the reserved
 * stakeholder roles — so `execution_signoff` can never be read or deleted here.
 */
function areaRoles(vocabulary: readonly string[]): string[] {
  return [...new Set(vocabulary)].filter((r) => !NON_AREA_STAKEHOLDER_ROLES.includes(r));
}

/**
 * Either the root db handle or an open transaction handle — the same
 * `DbExecutor` shape `routes/assets/bindings.ts` uses, so the read helpers below
 * can be called INSIDE one of the write transactions (to compute the diff
 * against the rows that transaction can see) as well as standalone.
 */
export type KnowledgeAreasDb =
  | typeof defaultDb
  | Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

/** user_id -> their areas, sorted. Members with none are ABSENT from the map. */
export type AreasByUser = Map<string, string[]>;

function fold(rows: ReadonlyArray<{ user_id: string; area: string }>): AreasByUser {
  const out: AreasByUser = new Map();
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push(r.area);
    out.set(r.user_id, list);
  }
  for (const [k, v] of out) out.set(k, normaliseAreas(v));
  return out;
}

/**
 * Every recorded area for every member of `tenantId`.
 *
 * ⚠️ A member with no areas is ABSENT from the returned map, not present with an
 * empty array — the table has no row to return for them. Callers MUST default to
 * `[]`, and the directory read does. That is also why the map cannot be used to
 * answer "is this user a member": `user_roles` answers that.
 */
export async function listAreasForTenant(
  tenantId: string,
  db: KnowledgeAreasDb = defaultDb,
): Promise<AreasByUser> {
  const rows = await db
    .select({ user_id: memberKnowledgeAreas.user_id, area: memberKnowledgeAreas.area })
    .from(memberKnowledgeAreas)
    .where(eq(memberKnowledgeAreas.tenant_id, tenantId));
  return fold(rows);
}

/** One member's tenant-wide areas, sorted. `[]` when none are recorded. */
export async function listAreasForMember(
  tenantId: string,
  userId: string,
  db: KnowledgeAreasDb = defaultDb,
): Promise<string[]> {
  const rows = await db
    .select({ area: memberKnowledgeAreas.area })
    .from(memberKnowledgeAreas)
    .where(
      and(
        eq(memberKnowledgeAreas.tenant_id, tenantId),
        eq(memberKnowledgeAreas.user_id, userId),
      ),
    );
  return normaliseAreas(rows.map((r) => r.area));
}

/**
 * Replace a member's tenant-wide areas with exactly `desired`.
 *
 * ⭐ ATOMIC AND IDEMPOTENT. One transaction, and the DELETE + INSERT inside it
 * are a diff (`planAllocation`), not a blind wipe-and-rewrite: an area the admin
 * did not touch keeps its original `assigned_at`, so that column keeps answering
 * "held since" instead of quietly becoming "last time somebody pressed Save".
 * Setting the same set twice writes nothing and returns `changed: false`.
 *
 * A concurrent second admin saving the same set races only into
 * `onConflictDoNothing`, which is why the PK is `(tenant_id, user_id, area)`.
 */
export async function setAreasForMember(
  tenantId: string,
  userId: string,
  desired: readonly string[],
  assignedBy: string,
  db: KnowledgeAreasDb = defaultDb,
): Promise<{ areas: string[]; changed: boolean }> {
  const normalised = normaliseAreas(desired);
  return db.transaction(async (tx) => {
    const current = await listAreasForMember(tenantId, userId, tx);
    const plan = planAllocation(current, normalised);

    if (plan.toDelete.length > 0) {
      await tx
        .delete(memberKnowledgeAreas)
        .where(
          and(
            eq(memberKnowledgeAreas.tenant_id, tenantId),
            eq(memberKnowledgeAreas.user_id, userId),
            inArray(memberKnowledgeAreas.area, plan.toDelete),
          ),
        );
    }
    if (plan.toInsert.length > 0) {
      await tx
        .insert(memberKnowledgeAreas)
        .values(
          plan.toInsert.map((area) => ({
            tenant_id: tenantId,
            user_id: userId,
            area,
            assigned_by: assignedBy,
          })),
        )
        .onConflictDoNothing({
          target: [
            memberKnowledgeAreas.tenant_id,
            memberKnowledgeAreas.user_id,
            memberKnowledgeAreas.area,
          ],
        });
    }
    return { areas: normalised, changed: plan.changed };
  });
}

// ---------------------------------------------------------------------------
// Per-project allocation — `project_stakeholders`, KNOWLEDGE-AREA ROLES ONLY
// ---------------------------------------------------------------------------

/**
 * Every knowledge-area allocation on `projectId`, folded per user.
 *
 * ⛔ FILTERED TO THE 15 AREAS. `execution_signoff` rows exist on essentially
 * every project (113 of 113 rows on prod) and are NOT allocations — returning
 * them would put the sign-off roster into an areas picker, where the first Save
 * would write it back as if it were one.
 */
export async function listProjectAllocation(
  projectId: string,
  vocabulary: readonly string[],
  db: KnowledgeAreasDb = defaultDb,
): Promise<AreasByUser> {
  const roles = areaRoles(vocabulary);
  if (roles.length === 0) return new Map();
  const rows = await db
    .select({ user_id: projectStakeholders.user_id, area: projectStakeholders.role })
    .from(projectStakeholders)
    .where(
      and(
        eq(projectStakeholders.project_id, projectId),
        inArray(projectStakeholders.role, roles),
      ),
    );
  return fold(rows);
}

/** One member's knowledge-area allocation on one project, sorted. */
export async function listProjectAllocationForMember(
  projectId: string,
  userId: string,
  vocabulary: readonly string[],
  db: KnowledgeAreasDb = defaultDb,
): Promise<string[]> {
  const roles = areaRoles(vocabulary);
  if (roles.length === 0) return [];
  const rows = await db
    .select({ role: projectStakeholders.role })
    .from(projectStakeholders)
    .where(
      and(
        eq(projectStakeholders.project_id, projectId),
        eq(projectStakeholders.user_id, userId),
        inArray(projectStakeholders.role, roles),
      ),
    );
  return normaliseAreas(rows.map((r) => r.role));
}

/**
 * Set a member's knowledge-area allocation on a project to exactly `desired`.
 *
 * ⭐ THIS IS THE OPERATOR'S "just an update to the allocation", and it is NOT an
 * UPDATE statement. `project_stakeholders`'s primary key is
 * `(project_id, user_id, ROLE)` — the role is part of the row's IDENTITY — so
 * changing `design` to `testing` cannot be `SET role = ...`: it is the deletion
 * of one row and the insertion of another. Doing that in two round trips leaves
 * a window in which the member holds NEITHER area (or, if ordered the other way,
 * BOTH), and a crash in the window leaves it there permanently. So both
 * statements run inside ONE `db.transaction`, and the caller either sees the old
 * allocation or the new one.
 *
 * ⛔ AND THE DELETE IS SCOPED TO THE 15-AREA VOCABULARY, never to the member's
 * whole row set on this project. That single `inArray` is what keeps this
 * endpoint out of the execution sign-off roster — see the module header.
 */
export async function setProjectAllocationForMember(
  projectId: string,
  userId: string,
  desired: readonly string[],
  vocabulary: readonly string[],
  db: KnowledgeAreasDb = defaultDb,
): Promise<{ areas: string[]; changed: boolean }> {
  const normalised = normaliseAreas(desired);
  const allowed = new Set(areaRoles(vocabulary));
  const outside = normalised.filter((a) => !allowed.has(a));
  if (outside.length > 0) {
    // The route validates first; this is the service's own fence (a reserved
    // role such as execution_signoff must never be written as an "area").
    throw new Error(`setProjectAllocationForMember: not knowledge areas: ${outside.join(', ')}`);
  }
  return db.transaction(async (tx) => {
    const current = await listProjectAllocationForMember(projectId, userId, vocabulary, tx);
    const plan = planAllocation(current, normalised);

    if (plan.toDelete.length > 0) {
      await tx
        .delete(projectStakeholders)
        .where(
          and(
            eq(projectStakeholders.project_id, projectId),
            eq(projectStakeholders.user_id, userId),
            // ⛔ `plan.toDelete` is a subset of the area roles by construction
            // (it comes from `listProjectAllocationForMember`, which already
            // filters), so `execution_signoff` can never appear here.
            inArray(projectStakeholders.role, plan.toDelete),
          ),
        );
    }
    if (plan.toInsert.length > 0) {
      await tx
        .insert(projectStakeholders)
        .values(
          plan.toInsert.map((area) => ({
            project_id: projectId,
            user_id: userId,
            role: area,
          })),
        )
        .onConflictDoNothing({
          target: [
            projectStakeholders.project_id,
            projectStakeholders.user_id,
            projectStakeholders.role,
          ],
        });
    }
    return { areas: normalised, changed: plan.changed };
  });
}

export const knowledgeAreasService = {
  listAreasForTenant,
  listAreasForMember,
  setAreasForMember,
  listProjectAllocation,
  listProjectAllocationForMember,
  setProjectAllocationForMember,
};
