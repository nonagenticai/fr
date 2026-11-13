// src/lib/approval-roster-lane.ts
//
// The ROSTER visibility lane for approvals, and the honest vocabulary for
// saying which lanes a response actually applied.
//
// ⛔ THE DEFECT THIS CLOSES. `lib/project-access.ts :: tenantScopedProjectFilter`
// (:212, `eq(projects.owner_id, userId)`) pins every project-bound row to the
// project's OWNER unless the caller is a cross-tenant service view
// (`includeAllOwners`) or a super-admin in home view. A tenant member who is a
// REQUIRED APPROVER on a project someone else owns therefore never appeared in
// the approvals queue: they were rostered to DECIDE a row they could not FIND.
// `handleUpdateApproval` applies no owner filter at all, so the decide half
// always worked — the same find-vs-decide asymmetry the rest of that file
// documents for the super-admin seat, one identity over.
//
// And the envelope asserted a population it had not returned: it reported
// `scope: 'tenant'` while returning owner-pinned rows, with no field naming the
// owner pin. A number that is internally consistent with a scope nobody asked
// for cannot be contradicted by anything the client can see — which is why the
// vocabulary below exists alongside the lane.
//
// ⛔ WHY THIS IS A NEW LANE AND NOT AN EDIT TO `tenantScopedProjectFilter`.
// That filter is shared with `handleListProjects`, `handleDeleteProject`, the
// aggregate-metrics scan and the comment-delete owner subquery. Widening it to
// admit rostered approvers would widen PROJECT visibility as a side effect —
// being on an approval's roster is not a claim on the project. The roster lane
// is purely ADDITIVE and lives only where approvals are listed.

import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';

import { approvals, requiredApprovers, projects } from '../db/schema';

/**
 * THE approver-identity predicate. ONE definition, and every site that asks
 * "is this caller on the roster for this approval?" calls it.
 *
 * ⛔ MOVED HERE FROM `routes/approvals.ts` (was module-private at :925) and
 * RE-EXPORTED from there, so its four existing call sites — `loadReachableApproval`,
 * `handleUpdateApproval`, `handleTriageApproval`, `handleListMyApprovals` — are
 * textually untouched. It moved because the roster LANE below has to compose the
 * identical predicate, and a second copy of an authorization check is the exact
 * thing this function was extracted to stop (it was re-derived inline at those
 * four sites, byte-identical, shared by nothing).
 *
 * ⚠️ It answers ONLY "may this caller act?". It is deliberately NOT used for the
 * two other questions the same table is read for: ATTRIBUTION ("whose name goes
 * on this action" — the channel webhooks' empty-roster fallbacks) and
 * QUORUM/listing ("who are all the approvers"). Those are different questions and
 * must not silently inherit changes to this one.
 *
 * ⚠️ `required_approvers` is the de facto roster, NOT `approvals.approver_user_id`
 * — that column has zero readers in backend/src and migration-runner.ts calls it
 * VACUOUS. Do not "improve" this by also matching it.
 *
 * A caller holding no roles matches by user_id alone; `inArray` on an empty list
 * is not a match-everything, but the branch is explicit so that intent survives a
 * refactor.
 */
export function approverIdentityFilter(user: { id: string; roles?: readonly string[] | null }) {
  const userRoles = user.roles ?? [];
  return userRoles.length > 0
    ? or(
        eq(requiredApprovers.user_id, user.id),
        inArray(requiredApprovers.role, userRoles),
      )
    : eq(requiredApprovers.user_id, user.id);
}

/**
 * A standalone builder so this module can compose a correlated subquery without
 * importing `db`. `lib/project-access.ts` takes its handle as a parameter for the
 * same reason: a predicate builder that reaches for the live connection cannot be
 * rendered in a unit test, and cannot be composed into another statement's WHERE.
 */
const qb = new QueryBuilder();

/**
 * ⭐ THE ROSTER LANE. True for an approval this caller is ROSTERED on, by name or
 * by a role they hold, within the ACTIVE tenant.
 *
 * Renders (measured, `PgDialect.sqlToQuery`):
 *
 *   exists (select 1 from "required_approvers"
 *           where "required_approvers"."approval_id" = "approvals"."id"
 *             and "required_approvers"."tenant_id"   = $1
 *             and ("required_approvers"."user_id" = $2
 *                  or "required_approvers"."role" in ($3, …)))
 *
 * ⛔ `ra.tenant_id = <activeTenantId>` IS THE NEGATIVE CONTROL OF THIS WHOLE
 * CHANGE, AND IT IS NOT REDUNDANT WITH THE OUTER `approvals.tenant_id`. Role
 * strings like `tech_lead` / `card_approver` / `execution_signoff` are
 * TENANT-SHARED LABELS — the same string names a different set of people in every
 * workspace. Without this conjunct, holding `tech_lead` in tenant A matches a
 * roster row written for tenant B, and because this lane is OR-ed into the
 * visibility disjunction the match would SURFACE the row rather than merely
 * failing to hide it. The outer `eq(approvals.tenant_id, activeTenantId)` in
 * `handleListAllApprovals` is the second, independent fence: the inner conjunct
 * stops the ROSTER from crossing tenants, the outer one stops the APPROVAL from
 * crossing. Both must be present, and the integration suite deletes each one
 * separately and requires each deletion to go RED.
 *
 * ⚠️ `activeTenantId` — the frame's tenant, never `user.tenantId`. Under a
 * super-admin `X-Active-Tenant` switch or the orchestrator's `X-Tenant-Id` the two
 * differ, and the roster question is about the workspace the caller is ACTING IN.
 *
 * ⚠️ This lane deliberately says nothing about PROJECT ownership, archived state
 * or tenant breadth. Those are separate predicates that the caller ANDs on; see
 * `rosteredProjectLane` for the composition the list endpoints actually use.
 */
export function rosteredApprovalLane(
  user: { id: string; roles?: readonly string[] | null },
  activeTenantId: string,
) {
  return exists(
    qb
      .select({ one: sql`1` })
      .from(requiredApprovers)
      .where(
        and(
          eq(requiredApprovers.approval_id, approvals.id),
          eq(requiredApprovers.tenant_id, activeTenantId),
          approverIdentityFilter(user),
        ),
      ),
  );
}

/**
 * ⛔ ARCHIVED IS NOT A SCOPE STATEMENT, so the roster lane must not smuggle past
 * it. `handleListAllApprovals`'s project lane carries
 * `ne(projects.status,'archived')` and its own comment says archived "is a
 * lifecycle statement, not a scope one, and it holds for every viewer". A BARE
 * `rosteredApprovalLane` OR-ed in at the top level has no such predicate, so it
 * would have made approvals on ARCHIVED projects visible to a rostered
 * approver while they stay hidden from the project's own OWNER — a widening in a
 * dimension this change has no business touching.
 *
 * Under the endpoint's LEFT join to `projects`, `projects.status` is NULL for a
 * null-project row and `ne(...)` is therefore NULL (not true), which would
 * re-drop exactly the worker-ingest rows the null-project lane exists to keep.
 * Hence the explicit `isNull(approvals.project_id)` arm rather than a bare
 * `ne(...)`: "either this row is not project-bound, or its project is not
 * archived".
 */
export function rosterVisibleDespiteArchive() {
  return or(isNull(approvals.project_id), ne(projects.status, 'archived'));
}

/**
 * The roster lane as the list endpoints apply it: rostered AND not on an archived
 * project. Project-bound and null-project rows both pass, which is what makes this
 * usable as the SOLE predicate under `?actionable=1`.
 */
export function rosteredProjectLane(
  user: { id: string; roles?: readonly string[] | null },
  activeTenantId: string,
) {
  return and(rosteredApprovalLane(user, activeTenantId), rosterVisibleDespiteArchive());
}

/**
 * ⭐ THE REQUESTER LANE. True for an approval this caller RAISED.
 *
 * Renders (one conjunct, on the outer table):
 *
 *   "approvals"."requester_id" = $1
 *
 * ⛔ IT IS DELIBERATELY *NOT* SHAPED LIKE ITS SIBLING ABOVE, AND THE DIFFERENCE IS
 * NOT A STYLE CHOICE. `rosteredApprovalLane` needs `exists(select … from
 * required_approvers …)` because the roster is a SEPARATE TABLE and the question
 * is "does a row over there point back at this approval and name me?".
 * `requester_id` is a COLUMN ON `approvals` ITSELF (schema.ts:941), so the same
 * question is a single equality on the row already in scope. Mirroring the
 * subquery here would add a correlated scan of `required_approvers` that answers
 * nothing — cargo-culting the shape of the sibling instead of its reasoning.
 *
 * ⛔ AND THEREFORE: THIS LANE CARRIES NO TENANT CONJUNCT, AND THAT IS WHY IT TAKES
 * NO `activeTenantId` PARAMETER. Read this before adding one "for symmetry".
 * `rosteredApprovalLane`'s inner `ra.tenant_id = activeTenantId` is mandatory
 * because role strings (`tech_lead`, `card_approver`) are TENANT-SHARED LABELS —
 * the inner fence stops the ROSTER from crossing tenants. `requester_id` is a
 * bare user uuid, not a shared label: there is no second table and nothing for an
 * inner fence to fence. So the roster lane has TWO independent fences and this one
 * has EXACTLY ONE — the caller's outer `eq(approvals.tenant_id, activeTenantId)`.
 * A parameter this function ignored would advertise a self-fencing it does not do,
 * which is the single most expensive thing a reader could believe about it. The
 * integration suite therefore pins the outer fence for THIS lane explicitly rather
 * than inheriting it from the roster tests.
 *
 * ⚠️ VISIBILITY ONLY, NEVER AUTHORITY. Raising a request is not authority to
 * decide it, so this lane must never be OR-ed into the `?actionable=1` branch —
 * see the call site in `handleListAllApprovals`.
 *
 * ⚠️ Not a new capability: `handleListMyApprovals` has read this column as a
 * visibility arm since before this lane existed (`routes/approvals.ts:3614/3617`,
 * reported as `APPROVAL_LANE.REQUESTED_BY_ME`). This brings `/approvals/all` into
 * line with it; the vocabulary entry was already there.
 */
export function requesterApprovalLane(user: { id: string }) {
  return eq(approvals.requester_id, user.id);
}

/**
 * The requester lane as the list endpoints apply it: raised-by-me AND not on an
 * archived project.
 *
 * ⛔ `rosterVisibleDespiteArchive()` IS REUSED VERBATIM, NOT RE-DERIVED. A
 * requester must not see approvals on an archived project that the project's own
 * OWNER cannot see — the owner lane carries `ne(projects.status,'archived')` and
 * archived is a lifecycle statement that holds for every viewer. A bare
 * `requesterApprovalLane` OR-ed in at the top level would have widened exactly
 * that dimension, which this change has no business touching. Sharing the helper
 * (rather than writing a second `ne(...)`) is also what keeps the LEFT-join NULL
 * handling identical: see its docblock for why the `isNull(project_id)` arm is
 * required rather than a bare `ne`.
 */
export function requesterProjectLane(user: { id: string }) {
  return and(requesterApprovalLane(user), rosterVisibleDespiteArchive());
}

/**
 * ⭐ THE TENANT-MEMBER LANE (P1-TEAM-b, George 2026-10-15). The rows a CURRENT member of
 * the active tenant may decide through the 1-of-any member arm
 * (`routes/approvals.ts :: resolveDecideEligibility`), written as the same terms:
 *
 *   - the row has a roster in the active tenant (an empty roster has no obligation to
 *     discharge — `tenantMemberArmPrecondition`'s `rosterSize > 0`);
 *   - ACTION approvals are included (P1-TEAM-c, George 2026-10-15): any member may approve
 *     one, and it then runs AS THE APPROVER (`resolvePendingAction`), never the requester;
 *   - unless `requesterMayDecide`, the caller is not the HUMAN requester of it
 *     (`isHumanRequesterDecidingOwnApproval` — a conveyor-raised row, `source = 'n8n'`
 *     with no action and not minted with a person's JWT, has the system as requester).
 *
 * ⛔ MEMBERSHIP IS NOT IN THIS PREDICATE. The caller must establish it first
 * (`isTenantMemberForDecision`, fail closed) and only then OR this lane in; the outer
 * `approvals.tenant_id = activeTenantId` stays the tenant fence, and the inner
 * `ra.tenant_id` conjunct is a second one, exactly as on the roster lane.
 */
export function tenantMemberDecidableLane(
  user: { id: string },
  activeTenantId: string,
  opts: { requesterMayDecide: boolean },
) {
  const hasRoster = exists(
    qb
      .select({ one: sql`1` })
      .from(requiredApprovers)
      .where(and(
        eq(requiredApprovers.approval_id, approvals.id),
        eq(requiredApprovers.tenant_id, activeTenantId),
      )),
  );
  const systemRaised = and(
    eq(approvals.source, 'n8n'),
    isNull(approvals.action_id),
    sql`coalesce(${approvals.metadata} ->> 'requested_via', '') <> 'jwt'`,
  );
  return and(
    hasRoster,
    opts.requesterMayDecide
      ? undefined
      : or(
          // `requester_id` is nullable: NULL is nobody, never "me".
          isNull(approvals.requester_id),
          ne(approvals.requester_id, user.id),
          systemRaised,
        ),
  );
}

/** Kept beside the lane so a caller composing lanes by hand uses the same spelling. */
export const APPROVAL_PROJECT_BOUND = () => isNotNull(approvals.project_id);

/**
 * ⭐ THE SCOPE VOCABULARY — what `total` actually counted.
 *
 * ⛔ `'tenant'` IS GONE ON PURPOSE AND ITS REPLACEMENT IS NOT A RENAME. The old
 * value asserted a tenant-wide population while the query returned an
 * owner-pinned subset of it. Being internally consistent, nothing a client could
 * read would ever contradict it.
 *
 * ⚠️ FOUR OPERATOR SCRIPTS READ THIS FIELD WITH AN EXACT EQUALITY `sc == "tenant"`
 * (`~/.claude/scripts/lib/approvals-predicate.py:1324`,
 * `lib/approvals-ladder.py:673`, `lib/approvals-digest.py:71`,
 * `hooks/session-brief.py:773` — the last runs on every prompt in ~36 sessions).
 * Those readers are being widened to accept these values BEFORE this ships. That
 * is why `scope_lanes` is additive rather than a replacement, and why
 * `scope_tenant_id` / `tenants_seen` keep their names and meanings: a reader that
 * has not been updated must degrade to "unrecognised scope", never to a WRONG
 * tenant id.
 */
export const APPROVAL_SCOPE = {
  /** Every tenant — super-admin home view, or a cross-tenant service view. */
  ALL: 'all',
  /**
   * ⭐ One tenant, TENANT-WIDE (P1-TEAM-a, George 2026-10-15): every project-bound
   * row on ANY project of the active tenant (the member lane carries no owner
   * pin), plus rostered, raised and unscoped rows. The `/api/approvals/all`
   * default. `'tenant'` was retired on 2026-09-22 because it then asserted a
   * tenant-wide population over an owner-pinned result; the population IS
   * tenant-wide now, so the honest name is back — and every reader already
   * accepts it (the frontend decoder kept it as legacy; the operator scripts
   * compared `== "tenant"` first).
   */
  TENANT: 'tenant',
  /**
   * One tenant; rows the caller raised OR is rostered on. Now emitted ONLY by
   * `GET /api/approvals` without `?mine=1` (whose population is unchanged by
   * P1-TEAM-a); `/api/approvals/all` emits `TENANT`.
   */
  TENANT_OWNED_OR_ROSTERED: 'tenant_owned_or_rostered',
  /**
   * One tenant; ONLY rows the caller may decide: rostered (`?actionable=1`, `?mine=1`),
   * plus — on `?mine=1`, for a verified CURRENT member (P1-TEAM-b) — the tenant-member
   * lane. `scope_lanes` names which arms were applied (`rostered`, `tenant_member`).
   */
  TENANT_ROSTERED: 'tenant_rostered',
  /** One project, already authorized by the project read gate. */
  PROJECT: 'project',
} as const;

export type ApprovalScope = (typeof APPROVAL_SCOPE)[keyof typeof APPROVAL_SCOPE];

/**
 * ⭐ THE LANE VOCABULARY — which DISJUNCTS were actually OR-ed together.
 *
 * `scope` alone cannot carry this. `tenant_owned_or_rostered` is one string for a
 * predicate with three arms, and which arms are live depends on the caller's
 * identity: a super-admin's project arm has no owner pin at all. A client that
 * needs to know why a row is present — or why one is absent — needs the arms.
 *
 * ⚠️ TWO OF THESE ARE ADDITIONS TO THE THREE-VALUE SET THE BRIEF SPECIFIED, and
 * both exist because emitting one of the three would have been FALSE:
 *   - `TENANT_PROJECTS`: under `includeAllOwners` (a switched cross-tenant service
 *     view; the super-admin home-view lane was removed in fr row 14d) the project
 *     arm carries NO owner pin, so calling it `owned_projects` would re-commit
 *     the exact sin this vocabulary exists to end.
 *   - `REQUESTED_BY_ME`: `handleListMyApprovals`'s default (no `?mine=1`) arm ORs
 *     in `approvals.requester_id = user.id`. That arm is neither ownership of a
 *     project nor a roster row, and reporting `['rostered']` for a list that also
 *     returns rows the caller merely RAISED would assert a population it did not
 *     return. ⚠️ `handleListAllApprovals` now emits it too — see the member's own
 *     docblock below; this paragraph is the ORIGINAL justification, not the current
 *     list of emitters.
 */
export const APPROVAL_LANE = {
  /**
   * Project-bound rows on projects the caller OWNS (the owner pin is live).
   * ⚠️ NO LONGER EMITTED (P1-TEAM-a): no list carries an owner pin any more.
   * Kept in the closed vocabulary so a rollback image's envelope stays valid.
   */
  OWNED_PROJECTS: 'owned_projects',
  /** Project-bound rows with NO owner pin — every project of the active tenant (P1-TEAM-a: every caller). */
  TENANT_PROJECTS: 'tenant_projects',
  /** Rows the caller is on the roster for, by user id or by a role they hold. */
  ROSTERED: 'rostered',
  /** Rows with no project (n8n / KAG worker ingest), visible tenant-wide. */
  UNSCOPED_PROJECT: 'unscoped_project',
  /**
   * Rows the caller RAISED (`approvals.requester_id`).
   *
   * ⚠️ WAS `handleListMyApprovals` ONLY; `handleListAllApprovals` now emits it too,
   * as the FOURTH disjunct of its default visibility lane (`requesterProjectLane`).
   * Emitting it there is what keeps `scope: 'tenant_owned_or_rostered'` honest
   * without renaming it — that string already reads "owned OR rostered OR raised",
   * and widening a disjunction does not change what the name claims. NOT emitted
   * under `?actionable=1`: raising a request is not authority to decide it.
   */
  REQUESTED_BY_ME: 'requested_by_me',
  /**
   * Rows of the active tenant a CURRENT member may decide through the 1-of-any member
   * arm (P1-TEAM-b, George 2026-10-15) — `tenantMemberDecidableLane`. Emitted by
   * `handleListMyApprovals` only when the caller's membership was verified.
   */
  TENANT_MEMBER: 'tenant_member',
} as const;

export type ApprovalLane = (typeof APPROVAL_LANE)[keyof typeof APPROVAL_LANE];

/**
 * Decide `scope` from the three facts that actually govern it. Written as one
 * function so no endpoint can invent a fifth value or disagree with a sibling —
 * the `'tenant'` literal was hardcoded at three sites and drifted from the query
 * at all three.
 *
 * `crossTenant` has NO caller since fr row 14d: every approvals lane is pinned to
 * `approvals.tenant_id = <active tenant>`, so no list returns a multi-tenant
 * population and `'all'` is never emitted. Kept only so the vocabulary stays
 * closed; do not pass it without a cross-tenant lane that really exists.
 *
 * ⚠️ `rosteredOnly` WINS OVER `crossTenant` and that is deliberate: under
 * `?actionable=1` the roster lane's own `ra.tenant_id = activeTenantId` conjunct
 * confines the result to ONE tenant no matter what the outer predicate does, so
 * reporting `'all'` there would over-state the population. The integration suite
 * pins exactly this (`scope !== 'all'` on the cross-tenant negative control).
 */
export function describeScope(opts: {
  projectScoped?: boolean;
  rosteredOnly?: boolean;
  crossTenant?: boolean;
  /** The list's project arm is the tenant-member lane (P1-TEAM-a) ⇒ `'tenant'`. */
  tenantWide?: boolean;
}): ApprovalScope {
  if (opts.projectScoped) return APPROVAL_SCOPE.PROJECT;
  if (opts.rosteredOnly) return APPROVAL_SCOPE.TENANT_ROSTERED;
  if (opts.crossTenant) return APPROVAL_SCOPE.ALL;
  if (opts.tenantWide) return APPROVAL_SCOPE.TENANT;
  return APPROVAL_SCOPE.TENANT_OWNED_OR_ROSTERED;
}
