// src/routes/asset-authoring/publish.ts
//
// Plan 7 Stage 2.2 — POST /api/asset-authoring/publish.
//
// LLM workers backing the asset-authoring streams (principle / requirement
// / decision development) emit a `card_type`-tagged envelope; this route
// validates the payload against the matching zod patch schema in
// src/services/asset-authoring/output-schemas.ts and dispatches to the
// upstream createPrinciple / createRequirement / createDecision integration.
//
// Auth: routes through `validateAuth` like every other /api/* route. The
// upstream-create integrations carry their own X-Tenant-Id propagation via
// the shared HttpClient, per the upstream-license-token-pattern memory —
// nothing to do here.
//
// ⛔ EVERY card_type IS WORKSPACE-ADMIN GATED (fr#1219 for change_*, fr#1448 for
// the create arm). See the RBAC bridge below.
//
// ⛔ CARD OWNER (fr#1437 (5)). The write lands in `ctxTenantId(user.tenantId)` —
// for the conveyor's system-workflow-operator that is the SYSTEM tenant,
// whatever tenant owns the `card_id`. `assertPublishCardOwner`
// (lib/asset-authoring-card-owner.ts) classifies the card's owner and refuses a
// customer or unresolvable card (fr#1448: unconditionally) AFTER the
// workspace-admin gate and BEFORE every dispatch, so a refusal writes nothing. LIMIT: customer cards cannot use asset authoring until
// per-tenant operator identity exists (ncn#2032); option A (writing into the
// card's tenant) is rejected as the rm#187 class.

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId, tryCtxTenantId } from '../../middleware/request-context';
import { assertPublishCardOwner } from '../../lib/asset-authoring-card-owner';
import { ForbiddenError } from '../../utils/errors';
import type { User } from '../../types/api';
import { userRolesService } from '../../services/user-roles';
import { jsonResponse } from '../../utils/response';
import {
  PrinciplePatch,
  RequirementPatch,
  DecisionPatch,
} from '../../services/asset-authoring/output-schemas';
import {
  principlePatchToIn,
  requirementPatchToIn,
  decisionPatchToIn,
} from '../../services/asset-authoring/patch-to-in';
import {
  createPrinciple as defaultCreatePrinciple,
  updatePrinciple as defaultUpdatePrinciple,
} from '../../integrations/principles';
import {
  createRequirement as defaultCreateRequirement,
  updateRequirement as defaultUpdateRequirement,
} from '../../integrations/requirements';
import {
  createDecision as defaultCreateDecision,
  updateDecision as defaultUpdateDecision,
} from '../../integrations/decisions';

// ---------- RBAC bridge (fr#1219) ------------------------------------------
//
// ⛔ THE HOLE. `change_{principle,requirement,decision}_development` do not
// author a new asset — they REWRITE an existing one, dispatching to the very
// same `updateRequirement` / `updatePrinciple` / `updateDecision` integrations
// that `routes/assets/requirements.ts` (and its siblings) put behind a
// workspace-admin gate. This route reached them with nothing but
// `validateAuth`, so any authenticated member of any tenant could rewrite a
// tenant-wide governance row by POSTing a `change_*` envelope here — the
// library UI's own PUT is refused for exactly that person.
//
// ⭐ THE SAME WRAPPER, NOT A NEW ONE. `routes/assets/requirements.ts:95` is the
// canonical site for this decision and this is a byte-for-byte copy of its
// `assertWorkspaceAdmin`: `isWorkspaceAdminVia` + `ctxTenantId` +
// `ForbiddenError('workspace-admin role required')`. Corroborated by
// `routes/admin/departments.ts::requireWorkspaceAdmin` and
// `routes/assets/kag.ts::requireWorkspaceAdmin`.
//
// ⛔ Never a claim-only check — `scripts/check-admin-claim-only.ts` fails CI on
// that shape, and `user.roles.includes('admin')` matches no real grant because
// authority lives in `user_roles`.
//
// ⛔ THE CREATE ARM IS GATED TOO (fr#1448). It used to stay member-level, on
// the sibling `routes/assets/requirements.ts` decision that "gating creation is
// a separate product decision". That decision is now made: authoring a
// tenant-wide governance asset is a workspace-admin act on every card_type, and
// the conveyor caller the ungated arm existed for is frozen.
async function assertWorkspaceAdmin(user: User): Promise<void> {
  const ok = await userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
  if (!ok) {
    throw new ForbiddenError('workspace-admin role required');
  }
}

const RequestEnvelope = z.object({
  card_type: z.enum([
    'principle_development',
    'requirement_development',
    'decision_development',
    // change_*_development revise an existing asset (PUT) instead of
    // authoring a new one (POST). They require `asset_id`.
    'change_principle_development',
    'change_requirement_development',
    'change_decision_development',
  ]),
  payload: z.unknown(),
  card_id: z.string().optional(),
  /** Target asset id — required for the change_*_development (update) path. */
  asset_id: z.string().optional(),
});

export async function handlePublishAsset(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  let env: z.infer<typeof RequestEnvelope>;
  try {
    env = RequestEnvelope.parse(await req.json());
  } catch {
    return jsonResponse({ error: 'unknown_asset_card_type' }, 400);
  }

  // ⛔ THE GATE GOES FIRST, for EVERY card_type (fr#1219 change_*, fr#1448
  // create): before the card-owner check, before the `asset_id` validation and
  // before every create/update dispatch. An unprivileged caller gets the
  // refusal, never a 400 that first tells them which field was missing, and a
  // refusal reaches no upstream service and writes nothing.
  await assertWorkspaceAdmin(user);

  // fr#1448 / fr#1437 (5): a customer-owned or unresolvable card is refused 403
  // before any upstream call.
  await assertPublishCardOwner({
    cardId: env.card_id,
    cardType: env.card_type,
    user,
    // Log-only, and must not throw where the write itself would not.
    writerTenant: tryCtxTenantId() || user.tenantId,
  });

  const create = {
    createPrinciple: defaultCreatePrinciple,
    createRequirement: defaultCreateRequirement,
    createDecision: defaultCreateDecision,
  };
  const update = {
    updatePrinciple: defaultUpdatePrinciple,
    updateRequirement: defaultUpdateRequirement,
    updateDecision: defaultUpdateDecision,
  };

  // change_*_development → revise an existing asset (PUT). Requires asset_id.
  const isChange = env.card_type.startsWith('change_');

  if (isChange && !env.asset_id) {
    return jsonResponse({ error: 'asset_id_required' }, 400);
  }

  try {
    if (env.card_type === 'change_principle_development') {
      const body = principlePatchToIn(PrinciplePatch.parse(env.payload));
      const out = await update.updatePrinciple(env.asset_id as string, body);
      return jsonResponse(
        { asset_kind: 'principle', id: out.id, card_id: env.card_id ?? null, updated: true },
        200,
      );
    }
    if (env.card_type === 'change_requirement_development') {
      const body = requirementPatchToIn(RequirementPatch.parse(env.payload));
      const out = await update.updateRequirement(env.asset_id as string, body);
      return jsonResponse(
        { asset_kind: 'requirement', id: out.id, card_id: env.card_id ?? null, updated: true },
        200,
      );
    }
    if (env.card_type === 'change_decision_development') {
      const body = decisionPatchToIn(DecisionPatch.parse(env.payload));
      const out = await update.updateDecision(env.asset_id as string, body);
      return jsonResponse(
        { asset_kind: 'decision', id: out.id, card_id: env.card_id ?? null, updated: true },
        200,
      );
    }
    if (env.card_type === 'principle_development') {
      const body = principlePatchToIn(PrinciplePatch.parse(env.payload));
      const out = await create.createPrinciple(body);
      return jsonResponse(
        {
          asset_kind: 'principle',
          id: out.id,
          card_id: env.card_id ?? null,
        },
        201,
      );
    }
    if (env.card_type === 'requirement_development') {
      const body = requirementPatchToIn(RequirementPatch.parse(env.payload));
      const out = await create.createRequirement(body);
      return jsonResponse(
        {
          asset_kind: 'requirement',
          id: out.id,
          card_id: env.card_id ?? null,
        },
        201,
      );
    }
    // env.card_type === 'decision_development'
    const body = decisionPatchToIn(DecisionPatch.parse(env.payload));
    const out = await create.createDecision(body);
    return jsonResponse(
      { asset_kind: 'decision', id: out.id, card_id: env.card_id ?? null },
      201,
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'validation_failed', issues: e.issues }, 400);
    }
    throw e;
  }
}
