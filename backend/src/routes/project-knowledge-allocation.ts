// routes/project-knowledge-allocation.ts
//
// PER-PROJECT ALLOCATION of knowledge areas — the maintainable half of the
// feature, and the operator's explicit "since the roles are predefined, this
// would just be an update to the allocation".
//
//   GET /api/projects/:id/knowledge-allocation
//   PUT /api/projects/:id/knowledge-allocation/:userId
//
// ── WHERE THE ROWS LIVE, AND WHY NOT A NEW TABLE ────────────────────────────
// `project_stakeholders` (migration 074). Its primary key is already
// `(project_id, user_id, role)` — "one user may hold multiple roles on a
// project", in that migration's own words — which is exactly the shape a
// multi-area allocation needs. A second table would be a second answer to "who
// is attached to this project, in what capacity", and the two would drift.
//
// ⛔ THE ONE THING THESE ROUTES MUST NEVER TOUCH: rows whose role is
// `execution_signoff`. That is the EXECUTION SIGN-OFF ROSTER that
// routes/execution-approvals.ts turns into an approval's `required_approvers`.
// MEASURED on the prod primary 2026-09-27: `project_stakeholders` holds 113 rows
// and exactly ONE distinct role — `execution_signoff` — so TODAY EVERY ROW IN
// THAT TABLE IS ONE THESE ROUTES MUST NOT DELETE. Both the read and the write
// are scoped to the 15-area vocabulary in services/knowledge-areas.ts
// (`inArray(role, KNOWLEDGE_AREAS)`), so `execution_signoff` is unreachable from
// here: it cannot be read out into a picker, and it cannot be written back or
// deleted. Changing who signs a project off is a different decision with a
// different blast radius and gets its own change.
//
// ── "CHANGING A ROLE" IS A DELETE + AN INSERT, NOT AN UPDATE ────────────────
// ⭐ `role` is part of the PRIMARY KEY, so it is part of the row's IDENTITY.
// `UPDATE project_stakeholders SET role = 'testing'` is not "the same row with a
// new role" — it is a different row, and postgres will collide if the target
// already exists. So an allocation change is the deletion of one row and the
// insertion of another, and the two run inside ONE `db.transaction`
// (`setProjectAllocationForMember`): a reader sees the old allocation or the new
// one, never a member holding neither area, and a crash mid-change cannot leave
// it that way. The diff also preserves `added_at` on areas the admin did not
// touch, so that column keeps meaning "allocated since" rather than quietly
// becoming "last time somebody pressed Save".
//
// ── AUTHZ: ANY MEMBER OF THE PROJECT'S TENANT (George 2026-10-16, ruling (b)) ──
// fr-agui P2-c1. These routes WERE workspace-admin only (`requireWorkspaceAdmin`
// + `findProjectForWorkspaceAdmin`). The ruling widens both to ANY member of the
// project's tenant — tenant-wide collaboration, the P1-TEAM-a "all actions by all
// members" — through the SAME project lanes every other P1-TEAM route uses:
//
//   GET  `findProjectForRead`      (lib/project-access.ts) — the project READ lane
//   PUT  `findTenantScopedProject` + `projectWritableByCaller` — the member WRITE
//        lane (a super-admin acting OUTSIDE its own tenant, a switched view, is not
//        a member there and keeps the owner pin) + `assertProjectNotArchived`
//
// Both lanes require the project's own tenant tag to equal the caller's ACTIVE
// tenant (an untagged or foreign row is the same 404 as a missing one), so the
// roster, the vocabulary and the write all run in the project's tenant. ⛔ A
// LICENCE caller is not a member and is refused 403 here as well as by the route
// door (lib/licence-route-allowlist.ts), so the gate does not depend on that list.
//
// ⛔ What did NOT widen: the `execution_signoff` fence. Any member may now write
// an allocation, so the fence is spelled at the route too: a body naming a
// reserved stakeholder role (`NON_AREA_STAKEHOLDER_ROLES`) is refused 403
// `reserved_stakeholder_role` before the vocabulary is read, beside the
// vocabulary filter and the service's own fence (services/knowledge-areas.ts).
//
// (History: `findProjectForWorkspaceAdmin` remains in lib/project-access.ts for
// its header's argument; ⚠️ its 0.8%-untagged measurement, 2026-09-27, applies to
// both lanes used here — an untagged project is refused, never guessed.)

import { z } from 'zod';

import { db } from '../db/client';
import { jsonResponse } from '../utils/response';
import { emitSpan } from '../telemetry/spans';
import { findProjectForRead, findTenantScopedProject, projectWritableByCaller } from '../lib/project-access';
import { assertProjectNotArchived } from '../lib/project-live-status';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { isUuidShape } from '../lib/uuid-shape';
import {
  NON_AREA_STAKEHOLDER_ROLES,
  SetAreasBody,
  hasAnyCoverage,
  knowledgeAreasOf,
  normaliseAreas,
  unknownAreas,
} from '../lib/knowledge-areas';
import { knowledgeAreasService } from '../services/knowledge-areas';
import { userRolesService } from '../services/user-roles';
import { resolveTenantDirectory, toTenantMembers } from './tenant/members';

/**
 * One candidate for this project's allocation.
 *
 * ⚠️ TWO AREA LISTS, AND THEY ANSWER DIFFERENT QUESTIONS. `knowledge_areas` is
 * the member's STANDING, tenant-wide set (`member_knowledge_areas`) — it is what
 * the project-creation form prefills from. `project_knowledge_areas` is what they
 * are actually allocated ON THIS PROJECT (`project_stakeholders`). A project
 * allocation is deliberately NOT required to be a subset of the standing set: a
 * person can be the right one to ask on one project without that becoming a
 * standing claim about them.
 */
export interface ProjectAllocationEntry {
  id: string;
  email: string | null;
  name: string | null;
  resolved: boolean;
  knowledge_areas: string[];
  project_knowledge_areas: string[];
}

/**
 * ⚠️ `{ items }` — a sanctioned shape for a NEW route
 * (fr's response-envelope convention). No `total`: it would be
 * `items.length` restated, which is the exact shape of the lies that guard
 * exists for.
 *
 * ⭐ `items` IS THE WHOLE TENANT ROSTER, not just the members already allocated,
 * and that is a deliberate anti-empty-picker choice. An allocation editor that
 * listed only existing rows would render EMPTY on every project in the estate
 * today (113 of 113 `project_stakeholders` rows are `execution_signoff`, so the
 * knowledge-area allocation of every project is currently the empty set), and an
 * empty editor is a false statement: it reads as "there is nobody to allocate"
 * when the truth is "nobody has been allocated yet". Listing candidates makes the
 * response empty only when the tenant genuinely has no members.
 *
 * The all-empty case is therefore still possible and still meaningful, so it must
 * remain visible rather than be papered over: when NO item carries any area at
 * all, a consumer that ranks or routes has nothing to rank and must refuse. That
 * question is `hasAnyCoverage` in lib/knowledge-areas.ts — asked once, there, so
 * no consumer reinvents it.
 */
export interface ProjectAllocationResponse {
  items: ProjectAllocationEntry[];
}

/**
 * Fold the roster, the standing areas and this project's allocation into the
 * wire shape. Pure and exported, so the join and the ordering are assertable
 * without a database or a Keycloak.
 *
 * Built on `toTenantMembers` rather than beside it: that function owns the
 * de-duplication of a person holding two roles, the `resolved:false`
 * keep-it-listed contract, and the unresolved-sort-last rule — all three
 * load-bearing, all three already tested. Re-deriving them here would be a
 * second answer to the same question.
 */
export function toProjectAllocation(
  grants: Parameters<typeof toTenantMembers>[0],
  people: Parameters<typeof toTenantMembers>[1],
  tenantAreas: ReadonlyMap<string, string[]>,
  projectAreas: ReadonlyMap<string, string[]>,
): ProjectAllocationEntry[] {
  return toTenantMembers(grants, people, tenantAreas).map((m) => ({
    ...m,
    // ⚠️ `?? []`: a member with no allocation is ABSENT from the map, not present
    // with an empty array — `project_stakeholders` has no row for them.
    project_knowledge_areas: projectAreas.get(m.id) ?? [],
  }));
}

/**
 * The P2-c1 gate (header): validateAuth (401 flattened to `unauthorized`, as
 * before), licence refused, then the project lane for `mode`. Every refusal of
 * the PROJECT is the one don't-leak-existence 404.
 */
async function requireProjectMember(
  req: Request,
  projectId: string,
  mode: 'read' | 'write',
): Promise<{ user: { id: string; roles: string[] }; tenantId: string } | { response: Response }> {
  let user;
  try {
    user = await validateAuth(req);
  } catch {
    return { response: jsonResponse({ error: 'unauthorized' }, 401) };
  }
  if (user.authKind === 'licence') {
    return { response: jsonResponse({ error: 'licence_caller_refused', code: 'licence_caller_refused' }, 403) };
  }
  const tenantId = ctxTenantId(user.tenantId);
  const project =
    mode === 'read' ? await findProjectForRead(db, user, projectId) : await findTenantScopedProject(db, user, projectId);
  // Same don't-leak-existence contract as lib/project-access.ts: "another
  // tenant's", "untagged", "syntactically impossible", "not writable in a
  // switched view" and "genuinely missing" all answer 404.
  if (!project || (mode === 'write' && !projectWritableByCaller(user, project))) {
    return { response: jsonResponse({ error: 'Project not found' }, 404) };
  }
  if (mode === 'write') assertProjectNotArchived(project);
  return { user, tenantId };
}

/** GET /api/projects/:id/knowledge-allocation */
export async function handleGetProjectKnowledgeAllocation(
  req: Request,
  projectId: string,
): Promise<Response> {
  const gate = await requireProjectMember(req, projectId, 'read');
  if ('response' in gate) return gate.response;
  const { user, tenantId } = gate;

  return emitSpan(
    'fr.projects.knowledge_allocation.list',
    { 'user.id': user.id, 'tenant.id': tenantId, 'project.id': projectId },
    async () => {
      const grants = await userRolesService.listGrantsForTenant(tenantId);
      const ids = [...new Set(grants.map((g) => g.user_id))];

      // A directory outage must not blank the candidate list — the grants ARE
      // the membership, names are decoration. Same contract, and the same
      // reasoning, as GET /api/tenant/members.
      let people: Record<string, { id: string; email: string | null; name: string }> = {};
      try {
        people = await resolveTenantDirectory(ids);
      } catch (e) {
        console.warn(
          `[project-knowledge-allocation] identity resolution failed for tenant ${tenantId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      const [tenantAreas, projectAreas] = await Promise.all([
        knowledgeAreasService.listAreasForTenant(tenantId),
        knowledgeAreasOf(tenantId).then((vocabulary) =>
          knowledgeAreasService.listProjectAllocation(projectId, vocabulary),
        ),
      ]);

      const items = toProjectAllocation(grants, people, tenantAreas, projectAreas);
      // Not returned (the envelope is `{items}` and must stay that way) — logged,
      // so the zero-coverage state is visible in the one place a reader looks
      // when a routing consumer later says it cannot decide. See
      // ProjectAllocationResponse for why it is not papered over.
      if (items.length > 0 && !hasAnyCoverage(items.map((i) => ({ areas: i.knowledge_areas })))) {
        console.warn(
          `[project-knowledge-allocation] tenant ${tenantId} has ${items.length} member(s) ` +
            'and ZERO recorded knowledge areas: any consumer that routes by area must ' +
            'refuse rather than rank an empty property.',
        );
      }
      // Bare literal, no `satisfies` — see the note in routes/tenant/
      // knowledge-areas.ts: the envelope guard parses the literal's keys and a
      // `satisfies` clause reads to it as an unsanctioned one-off shape.
      return jsonResponse({ items });
    },
  );
}

/** PUT /api/projects/:id/knowledge-allocation/:userId */
export async function handleSetProjectMemberKnowledgeAllocation(
  req: Request,
  projectId: string,
  userId: string,
): Promise<Response> {
  const gate = await requireProjectMember(req, projectId, 'write');
  if ('response' in gate) return gate.response;
  const { user, tenantId } = gate;

  let body: z.infer<typeof SetAreasBody>;
  try {
    body = SetAreasBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse(
        { error: 'invalid request body', details: e.errors },
        422,
      );
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    throw e;
  }

  // ⛔ SHAPE-CHECK THE USER ID BEFORE THE WRITE. `project_stakeholders.user_id`
  // is a `uuid NOT NULL` column (migration 074) while `user_roles.user_id` and
  // `member_knowledge_areas.user_id` are TEXT — so a legacy non-uuid Keycloak
  // subject is a legitimate tenant member with legitimate standing areas that
  // simply CANNOT be allocated to a project. Without this check postgres raises
  // 22P02 and it escapes as a bare 500, which is the exact failure
  // lib/uuid-shape.ts was written for. A 422 that says so is the honest answer.
  if (!isUuidShape(userId)) {
    return jsonResponse(
      {
        error: 'user_id must be a UUID',
        detail:
          'project_stakeholders.user_id is a uuid column (migration 074). This ' +
          'member can hold tenant-wide knowledge areas but cannot be allocated to ' +
          'a project until their subject id is a UUID.',
        user_id: userId,
      },
      422,
    );
  }

  const areas = normaliseAreas(body.areas);
  // ⛔ THE SIGN-OFF FENCE, at the route (header): never an "area", whatever the
  // tenant's RM vocabulary says — refused before the vocabulary is even read.
  const reserved = areas.filter((a) => NON_AREA_STAKEHOLDER_ROLES.includes(a));
  if (reserved.length > 0) {
    return jsonResponse(
      {
        error: 'reserved stakeholder role',
        code: 'reserved_stakeholder_role',
        message: `not a knowledge area and never written here: ${reserved.join(', ')} (the execution sign-off roster)`,
        reserved,
      },
      403,
    );
  }
  // The vocabulary is THIS tenant's RM capabilities (design Q1 = a).
  const vocabulary = await knowledgeAreasOf(tenantId);
  const unknown = unknownAreas(areas, vocabulary);
  if (unknown.length > 0) {
    return jsonResponse(
      {
        error: 'invalid request body',
        message: `not a knowledge area of this workspace: ${unknown.join(', ')}`,
        unknown,
        allowed: vocabulary,
      },
      422,
    );
  }

  return emitSpan(
    'fr.projects.knowledge_allocation.set',
    {
      'user.id': user.id,
      'target.user_id': userId,
      'tenant.id': tenantId,
      'project.id': projectId,
      'areas.count': areas.length,
    },
    async () => {
      // The target must be a member of THIS tenant. Otherwise the endpoint
      // attaches an outsider to a project — and `project_stakeholders` is read by
      // the execution-approval path, so an unknown subject there is not inert.
      const roles = await Promise.all(
        ['workspace-admin', 'workspace-member'].map((role) =>
          userRolesService.hasRole(userId, tenantId, role),
        ),
      );
      if (!roles.some(Boolean)) {
        return jsonResponse(
          {
            error: 'not a member of this workspace',
            detail:
              'Allocate only members of the tenant that owns this project. Grant ' +
              'workspace-member first (POST /api/workspace/members/:userId/roles).',
            user_id: userId,
          },
          404,
        );
      }

      const result = await knowledgeAreasService.setProjectAllocationForMember(
        projectId,
        userId,
        areas,
        vocabulary,
      );
      return jsonResponse({
        project_id: projectId,
        user_id: userId,
        areas: result.areas,
        /** FALSE when the stored allocation already equalled the requested one. */
        changed: result.changed,
      });
    },
  );
}
