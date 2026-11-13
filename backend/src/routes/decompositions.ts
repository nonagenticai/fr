// src/routes/decompositions.ts
//
// fr routes for split-family state (roadmap B1; split-coherence-design.md §3.2,
// §5, §6; migration 128). Registered in server.ts; documented in openapi.ts.
//
//   POST /api/decompositions/:familyId/decisions   claimDecisionTopic
//   GET  /api/decompositions/:familyId/decisions   listFamilyDecisions(?after_seq=)
//   PUT  /api/decompositions/:familyId/bundle      putBundle (write-once per version)
//   GET  /api/decompositions/:familyId/bundle      getBundle(?version=)
//   GET  /api/cards/:cardId/contract               contracts.get(card_id)
//
// TENANCY. Every family is owned by `decompositions.tenant_id`; every handler
// resolves the family under the caller's request-context tenant and answers 404
// for a family that is absent OR belongs to another tenant (indistinguishable on
// purpose — don't leak existence).
//
// WRITE ROLE GATE (fr #1173 audit follow-up). The two WRITES — the decision claim
// POST and the bundle PUT — require a workspace-admin of the active tenant (the
// canonical `userRolesService.isWorkspaceAdminVia`: Keycloak claim OR a
// `user_roles` grant) or a platform super_admin (`lib/super-admin-gate.ts`, the
// call-site opt-in `routes/settings/llm-provider.ts` uses). Anyone else gets 403.
// The gate runs BEFORE the family lookup, so a refused caller learns nothing
// about which families exist. The READS stay tenant-scoped only.
//
// NOT HERE (named by the design, not built in B1's first cut — see the report):
//   POST /api/decompositions/validate, GET /api/decompositions/:id (Track B), and
//   POST /api/decompositions/:familyId/interfaces/validate + its GET.
// POST /api/decompositions/commit now exists in routes/decomposition-commit.ts
// (C1-58: one family per approved-project decomposition) with the
// POST /api/cards/project auth path, NOT this file's family-writer gate. A family
// it did not record is still a 404 here.

import { z } from 'zod';

import { validateAuth } from '../middleware/auth';
import { getTenantId } from '../integrations/_lib/context';
import { IntegrationError } from '../integrations/_lib/errors';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { userRolesService } from '../services/user-roles';
import type { User } from '../types/api';
import { jsonResponse } from '../utils/response';
import {
  TOPIC_SLUG_RE,
  claimDecisionTopic,
  findFamilyForTenant,
  listFamilyDecisions,
} from '../services/decomposition/family-decisions';
import { getFamilyBundle, putFamilyBundle } from '../services/decomposition/family-bundles';
import { getCardContract } from '../services/decomposition/contracts';

function requireTenant(): string {
  const tenant = getTenantId();
  if (!tenant) {
    // fr cannot name the
    // tenant this read/write would be scoped to — MISSING_TENANT (409).
    throw new IntegrationError({
      code: 'MISSING_TENANT',
      message: 'Tenant context required',
    });
  }
  return tenant;
}

async function requireFamily(familyId: string): Promise<{ id: string }> {
  const tenant = requireTenant();
  const family = await findFamilyForTenant(familyId, tenant);
  if (!family) throw new NotFoundError('Decomposition family not found');
  return family;
}

/**
 * 403 unless `user` may WRITE split-family state in `tenant`. Reuses the
 * canonical workspace-admin predicate (never a claim-only check —
 * scripts/check-admin-claim-only.ts) plus the super_admin call-site opt-in.
 * `isWorkspaceAdminVia` is called with `hasRole` passed through, per its header.
 */
export async function requireFamilyWriter(user: User, tenant: string): Promise<void> {
  if (isSuperAdmin(user)) return;
  if (await userRolesService.isWorkspaceAdminVia(user, tenant, userRolesService.hasRole)) return;
  throw new ForbiddenError('workspace-admin role required to write split-family state');
}

function validationFailed(e: unknown): Response {
  const issues = e instanceof z.ZodError ? e.issues : [{ message: String(e) }];
  return jsonResponse({ error: 'validation_failed', issues }, 400);
}

// ── decisions ────────────────────────────────────────────────────────────────

// `.strict()` on purpose: a caller sending `supersedes` must be REFUSED, not
// silently treated as a plain claim — supersede is not implemented (see
// services/decomposition/family-decisions.ts for why).
export const ClaimDecisionTopicBody = z
  .object({
    topic_slug: z.string().regex(TOPIC_SLUG_RE),
    decision_id: z.string().uuid(),
    child_key: z.string().min(1).max(200),
  })
  .strict();

/**
 * POST /api/decompositions/:familyId/decisions  {topic_slug, decision_id, child_key}
 *   201 {seq, decision_id, child_key, topic_slug}           — this call claimed the topic
 *   200 {seq, decision_id, child_key, topic_slug, replayed} — already this caller's claim
 *   409 {error:'topic_already_decided', decision_id, seq, child_key} — another child holds it
 *   403 — caller is not a workspace-admin of the tenant (or super_admin)
 */
export async function handleClaimDecisionTopic(req: Request, familyId: string): Promise<Response> {
  const user = await validateAuth(req);
  await requireFamilyWriter(user, requireTenant());
  const family = await requireFamily(familyId);

  let body: z.infer<typeof ClaimDecisionTopicBody>;
  try {
    body = ClaimDecisionTopicBody.parse(await req.json());
  } catch (e) {
    return validationFailed(e);
  }

  const r = await claimDecisionTopic({
    familyId: family.id,
    topicSlug: body.topic_slug,
    decisionId: body.decision_id,
    childKey: body.child_key,
  });

  if (r.outcome === 'conflict') {
    return jsonResponse(
      {
        error: 'topic_already_decided',
        topic_slug: body.topic_slug,
        decision_id: r.decision_id,
        seq: r.seq,
        child_key: r.child_key,
      },
      409,
    );
  }
  return jsonResponse(
    {
      seq: r.seq,
      topic_slug: body.topic_slug,
      decision_id: r.decision_id,
      child_key: r.child_key,
      replayed: r.outcome === 'replayed',
    },
    r.outcome === 'claimed' ? 201 : 200,
  );
}

const AfterSeqQuery = z.coerce.number().int().min(0).default(0);

/** GET /api/decompositions/:familyId/decisions?after_seq=N → {data:[…]} oldest first. */
export async function handleListFamilyDecisions(req: Request, familyId: string): Promise<Response> {
  await validateAuth(req);
  const family = await requireFamily(familyId);

  const raw = new URL(req.url).searchParams.get('after_seq') ?? undefined;
  const parsed = AfterSeqQuery.safeParse(raw);
  if (!parsed.success) return validationFailed(parsed.error);

  const data = await listFamilyDecisions(family.id, parsed.data);
  return jsonResponse({ data });
}

// ── bundle ───────────────────────────────────────────────────────────────────

export const PutFamilyBundleBody = z
  .object({
    version: z.number().int().min(1),
    bundle_hash: z.string().min(1).max(200),
    items: z.array(z.unknown()),
    retrieval_trace: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * PUT /api/decompositions/:familyId/bundle  {version, bundle_hash, items, retrieval_trace?}
 *   201 created · 200 unchanged (same hash, idempotent) ·
 *   409 bundle_version_frozen (same version, different hash — a changed bundle is a new version) ·
 *   403 — caller is not a workspace-admin of the tenant (or super_admin)
 */
export async function handlePutFamilyBundle(req: Request, familyId: string): Promise<Response> {
  const user = await validateAuth(req);
  await requireFamilyWriter(user, requireTenant());
  const family = await requireFamily(familyId);

  let body: z.infer<typeof PutFamilyBundleBody>;
  try {
    body = PutFamilyBundleBody.parse(await req.json());
  } catch (e) {
    return validationFailed(e);
  }

  const r = await putFamilyBundle({
    familyId: family.id,
    version: body.version,
    bundleHash: body.bundle_hash,
    items: body.items,
    retrievalTrace: body.retrieval_trace,
  });
  if (r.outcome === 'conflict') {
    return jsonResponse(
      {
        error: 'bundle_version_frozen',
        version: r.version,
        existing_bundle_hash: r.existing_bundle_hash,
      },
      409,
    );
  }
  return jsonResponse(
    { version: r.version, bundle_hash: r.bundle_hash, created: r.outcome === 'created' },
    r.outcome === 'created' ? 201 : 200,
  );
}

const VersionQuery = z.coerce.number().int().min(1).optional();

/** GET /api/decompositions/:familyId/bundle?version=N → {data} (latest when version omitted). */
export async function handleGetFamilyBundle(req: Request, familyId: string): Promise<Response> {
  await validateAuth(req);
  const family = await requireFamily(familyId);

  const raw = new URL(req.url).searchParams.get('version') ?? undefined;
  const parsed = VersionQuery.safeParse(raw);
  if (!parsed.success) return validationFailed(parsed.error);

  const bundle = await getFamilyBundle(family.id, parsed.data);
  if (!bundle) throw new NotFoundError('Family bundle not found');
  return jsonResponse({ data: bundle });
}

// ── contract ─────────────────────────────────────────────────────────────────

/** GET /api/cards/:cardId/contract → {data} or 404 (no contract, or another tenant's). */
export async function handleGetCardContract(req: Request, cardId: string): Promise<Response> {
  await validateAuth(req);
  const tenant = requireTenant();
  const contract = await getCardContract(decodeURIComponent(cardId), tenant);
  if (!contract) throw new NotFoundError('Card contract not found');
  return jsonResponse({ data: contract });
}
