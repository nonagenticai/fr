// routes/workspace/knowledge-areas.ts
//
// THE TENANT-ADMIN WRITE PATH for a member's knowledge areas.
//   PUT /api/workspace/members/:userId/knowledge-areas
//
// ── WHY A SEPARATE FILE FROM routes/workspace/members.ts ─────────────────────
// That file's whole surface is the AUTHORITY axis: list, grant, revoke, on a
// column CHECK-locked to 'workspace-admin' | 'workspace-member'. This is the
// KNOWLEDGE axis — who to ask, granting nothing. Keeping them apart is what
// stops a future edit to "the members routes" from accidentally teaching the
// grant handler a knowledge area, or the areas handler a role. It reuses that
// file's `requireWorkspaceAdmin` rather than reimplementing it: a copied gate is
// one more place that has to remember `ctxTenantId`, the deliberate exclusion of
// `super_admin`, and the 401/403 split.
//
// ── AUTHZ ───────────────────────────────────────────────────────────────────
// `requireWorkspaceAdmin` — unchanged, unrelaxed. The operator's ask is
// explicitly "the tenant-admin should be able to update member roles", so this is
// the right gate, and the tenant comes from the REQUEST CONTEXT, never the body
// or a param (`.strict()` on the body makes a smuggled `tenant_id` a 422 today
// rather than a field silently dropped).
//
// ── WHY PUT AND NOT POST/DELETE ─────────────────────────────────────────────
// The body is a member's COMPLETE set of areas, so the verb is a replacement.
// That is what makes it IDEMPOTENT — sending the same set twice writes nothing
// and returns `changed: false` — and it means "remove an area" needs no second
// endpoint, no second guard and no second test. `{"areas": []}` is a legal body
// meaning "this member holds no areas".

import { z } from 'zod';

import { jsonResponse } from '../../utils/response';
import { emitSpan } from '../../telemetry/spans';
import { userRolesService } from '../../services/user-roles';
import { knowledgeAreasService } from '../../services/knowledge-areas';
import { SetAreasBody, knowledgeAreasOf, normaliseAreas, unknownAreas } from '../../lib/knowledge-areas';
import { requireWorkspaceAdmin } from './members';

/** PUT /api/workspace/members/:userId/knowledge-areas */
export async function handleSetMemberKnowledgeAreas(
  req: Request,
  userId: string,
): Promise<Response> {
  const gate = await requireWorkspaceAdmin(req);
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

  const areas = normaliseAreas(body.areas);
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
    'fr.workspace.members.knowledge_areas.set',
    {
      'user.id': user.id,
      'target.user_id': userId,
      'tenant.id': tenantId,
      'areas.count': areas.length,
    },
    async () => {
      // ⛔ THE TARGET MUST ALREADY BE A MEMBER OF THIS TENANT.
      //
      // Without this check the endpoint happily records knowledge areas for a
      // user id that holds no grant here — a row that is invisible in
      // `GET /api/tenant/members` (which folds `user_roles`, not this table), so
      // the admin sees their save "succeed" and then sees nothing change. Worse,
      // it is how a routing consumer ends up suggesting somebody who has no
      // access to the work at all.
      //
      // ⛔ AND IT IS *NOT* ENFORCEABLE BY A FOREIGN KEY. `user_roles`'s unique
      // key is (user_id, tenant_id, ROLE), so there is no (tenant_id, user_id)
      // key for a FK to point at; a membership FK would have to name a role, and
      // this fact is role-independent. Hence a check here, where it can return a
      // diagnosis instead of a constraint violation.
      const roles = await Promise.all(
        // Both values `user_roles.role` may legally hold (migration 104's CHECK).
        // Deliberately derived from the grantable vocabulary rather than a fresh
        // literal pair — see routes/workspace/members.ts `WorkspaceRole`.
        ['workspace-admin', 'workspace-member'].map((role) =>
          userRolesService.hasRole(userId, tenantId, role),
        ),
      );
      if (!roles.some(Boolean)) {
        return jsonResponse(
          {
            error: 'not a member of this workspace',
            detail:
              'Knowledge areas annotate an existing membership. Grant the user ' +
              'workspace-member (POST /api/workspace/members/:userId/roles) first.',
            user_id: userId,
          },
          404,
        );
      }

      const result = await knowledgeAreasService.setAreasForMember(
        tenantId,
        userId,
        areas,
        user.id,
      );
      return jsonResponse({
        user_id: userId,
        areas: result.areas,
        /**
         * FALSE when the stored set already equalled the requested one. This is
         * the honest report of an idempotent write, and it is deliberately not
         * an error: the same shape `handleGrantWorkspaceMemberRole` uses for
         * `granted`.
         */
        changed: result.changed,
      });
    },
  );
}
