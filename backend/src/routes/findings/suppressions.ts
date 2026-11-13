// Finding suppression ledger — PUT/GET /api/findings/suppressions
//
// A human/QA marks a conveyor finding (identified by its stable fingerprint —
// the `asset_id` the analysis card passes to POST /api/cards/project) as a
// FALSE POSITIVE for a project. POST /api/cards/project then refuses to turn
// that fingerprint into a card again (`{suppressed:true, card_id:null}`).
//
// Auth + tenant scope are IDENTICAL to POST /api/cards/project, by
// construction: the same `resolveCardRouteProject` visibility rule and the same
// EXEC pin (`cardRouteTenantRefusal`, which admits the trusted aa-orchestrator
// cross-tenant view). A ledger the card spawner reads must not be writable
// from a wider scope than the spawner itself.

import { z } from 'zod';

import { isSuperAdmin } from '../../lib/super-admin-gate';
import { holdsOrchestratorRole } from '../../lib/project-access';
import { isConveyorActor } from '../../lib/conveyor-identity';
import { projectKcTenantTag } from '../../lib/project-owner-guard';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { NotFoundError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import {
  deleteFindingSuppression,
  listFindingSuppressions,
  upsertFindingSuppression,
} from '../../services/findings/suppressions';
import { PlankaError } from '../../services/planka/errors';
import type { User } from '../../types/api';
import {
  cardRouteTenantRefusal,
  cardTypesForProjectAsset,
  FindingFingerprintSchema,
  resolveCardRouteProject,
  SECURITY_PROJECT_CARD_TYPES,
} from '../cards/project';

const PutSuppressionSchema = z.object({
  project_id: z.string().uuid(),
  // The SAME validator as POST /api/cards/project `asset_id` — the two must
  // accept exactly the same fingerprints or a suppression could be unmatchable.
  fingerprint: FindingFingerprintSchema,
  // Trimmed, then non-empty: a blank or whitespace-only reason records a
  // false-positive decision nobody can later audit, so it is a 400.
  reason: z.string().trim().min(1).max(2000),
  card_id: z.string().min(1).max(200).optional(),
  // Optional finding category (migration 132), trimmed + lower-cased. The
  // fingerprint (`<16 hex>.<ordinal>`) encodes no tool or category, so this is
  // only ONE input to the security gate — see classifyFindingSecurity: an
  // omitted category, or a card of a security card_type minted for this
  // fingerprint, makes the finding security whatever is declared here.
  category: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((c) => c.toLowerCase())
    .optional(),
});

const DeleteSuppressionSchema = z.object({
  project_id: z.string().uuid(),
  fingerprint: FindingFingerprintSchema,
  // Same rule as the PUT: an un-suppression nobody can later explain is a 400.
  reason: z.string().trim().min(1).max(2000),
});

// Exact security categories, plus a substring net so a producer's variant
// ('source_security', 'iac-security', 'vulnerability', 'secrets') is gated too.
// Deliberately errs toward REQUIRING elevation: a false "security" costs an
// owner click; a missed one lets the conveyor silence a vulnerability.
const SECURITY_CATEGORIES = new Set(['security', 'sast', 'dast', 'sca', 'iac', 'cve']);
const SECURITY_CATEGORY_MARKERS = ['secur', 'vuln', 'secret', 'cve'];

/** True when a (lower-cased) declared category is a security one. */
export function isSecurityFindingCategory(category: string | undefined | null): boolean {
  if (!category) return false;
  const c = category.toLowerCase();
  return (
    SECURITY_CATEGORIES.has(c) || SECURITY_CATEGORY_MARKERS.some((m) => c.includes(m))
  );
}

/**
 * Server-side, FAIL-CLOSED security classification of a fingerprint. Security
 * when ANY of:
 *   1. the declared category is a security one;
 *   2. no category was declared — an unlabelled finding is not trusted to be
 *      benign (a caller could otherwise dodge the gate by omitting it);
 *   3. a card on the project's board carries `Metadata.asset_id` = this
 *      fingerprint and a security card_type — the finding's own provenance
 *      overrides a mislabelled declaration.
 * (3) is read only when (1)/(2) did not already decide. A Planka failure
 * propagates: the caller must not read "could not look" as "not security".
 */
export async function classifyFindingSecurity(
  declaredCategory: string | undefined,
  project: { planka_board_id: string | null },
  fingerprint: string,
): Promise<{ security: boolean; basis: 'declared' | 'undeclared' | 'card' | null }> {
  if (isSecurityFindingCategory(declaredCategory)) return { security: true, basis: 'declared' };
  if (!declaredCategory) return { security: true, basis: 'undeclared' };
  const cardTypes = await cardTypesForProjectAsset(project, fingerprint);
  const fromCard = cardTypes.some(
    (t) => SECURITY_PROJECT_CARD_TYPES.has(t) || isSecurityFindingCategory(t),
  );
  return fromCard ? { security: true, basis: 'card' } : { security: false, basis: null };
}

/**
 * ⭐ Elevated suppression rights (P1-TEAM-a, George 2026-10-15: "all actions are
 * able to be done by all members of the tenant"): any HUMAN member of the
 * project's tenant — the project's own tag equals the caller's active tenant —
 * or a super_admin. Was: the project owner or a super_admin.
 *
 * ⛔ THE MACHINE SEATS ARE NOT MEMBERS HERE, and that is the invariant "the
 * licence and conveyor lanes are unchanged": this gate exists so the conveyor
 * cannot silence a vulnerability. A licence caller (a customer's n8n = that
 * tenant's conveyor), the `aa-orchestrator` seat and the dedicated conveyor
 * priority identity owned no project before, so were never elevated; they are
 * still refused.
 *
 * ⛔ An untagged project, or one tagged for another tenant, elevates no member
 * (the resolver above already refuses both; this is the second barrier).
 */
export function hasElevatedSuppressionRights(
  user: User,
  project: Parameters<typeof projectKcTenantTag>[0],
  activeTenantId: string,
): boolean {
  if (isSuperAdmin(user)) return true;
  if (user.authKind === 'licence' || holdsOrchestratorRole(user) || isConveyorActor(user)) return false;
  const tag = projectKcTenantTag(project);
  return typeof activeTenantId === 'string' && activeTenantId.trim() !== '' && tag === activeTenantId;
}

function elevationRefusal(action: string): Response {
  return jsonResponse(
    {
      error: 'suppression_requires_elevated_rights',
      message:
        `${action} requires a member of the project's workspace or a super_admin; ` +
        'project visibility alone is not enough.',
    },
    403,
  );
}

function validationFailed(e: unknown): Response {
  if (e instanceof z.ZodError) {
    return jsonResponse({ error: 'validation_failed', issues: e.issues }, 400);
  }
  return jsonResponse(
    { error: 'validation_failed', issues: [{ message: String(e) }] },
    400,
  );
}

/** PUT /api/findings/suppressions — idempotent upsert; the first decision wins. */
export async function handlePutFindingSuppression(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  let parsed: z.infer<typeof PutSuppressionSchema>;
  try {
    parsed = PutSuppressionSchema.parse(await req.json());
  } catch (e) {
    return validationFailed(e);
  }

  const project = await resolveCardRouteProject(
    user,
    activeTenantId,
    parsed.project_id,
  );
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  const refusal = cardRouteTenantRefusal(user, activeTenantId);
  if (refusal) return refusal;

  // Ordinary (non-security) suppressions keep the visibility + EXEC-pin rule
  // above; a security one additionally needs a human tenant member or a
  // super_admin (never a machine seat). The
  // classification is the SERVER's (classifyFindingSecurity), never only the
  // caller's declaration, and it runs before anything is written.
  let cls: Awaited<ReturnType<typeof classifyFindingSecurity>>;
  try {
    cls = await classifyFindingSecurity(parsed.category, project, parsed.fingerprint);
  } catch (err) {
    if (err instanceof PlankaError) {
      return jsonResponse(
        {
          error: 'finding_classification_failed',
          message:
            'Could not read the project board to classify this finding; ' +
            'nothing was recorded.',
        },
        502,
      );
    }
    throw err;
  }
  if (cls.security && !hasElevatedSuppressionRights(user, project, activeTenantId)) {
    return elevationRefusal('Suppressing a security finding');
  }

  // Persist what is KNOWN: a security card for this fingerprint overrides the
  // caller's non-security label ('security'); otherwise the declaration is kept
  // as given. An undeclared category stays null — it was GATED as security
  // (fail-closed), but recording 'security' would invent a fact nobody stated.
  const storedCategory = cls.basis === 'card' ? 'security' : (parsed.category ?? null);

  // Keyed on the PROJECT: the same row answers for every tenant view under
  // which this project is visible. The active tenant is recorded for audit.
  const { created, suppression } = await upsertFindingSuppression({
    projectId: project.id,
    fingerprint: parsed.fingerprint,
    recordedTenantId: activeTenantId,
    reason: parsed.reason,
    cardId: parsed.card_id ?? null,
    decidedBy: user.id,
    category: storedCategory,
  });

  return jsonResponse({ suppressed: true, created, suppression }, 200);
}

/**
 * DELETE /api/findings/suppressions — body {project_id, fingerprint, reason}.
 * Removes the suppression so the fingerprint can be minted into a card again.
 * Always needs elevated rights. 404 when there is no such suppression — a
 * repeat DELETE is an explicit 404, never a silent success.
 */
export async function handleDeleteFindingSuppression(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  let parsed: z.infer<typeof DeleteSuppressionSchema>;
  try {
    parsed = DeleteSuppressionSchema.parse(await req.json());
  } catch (e) {
    return validationFailed(e);
  }

  const project = await resolveCardRouteProject(
    user,
    activeTenantId,
    parsed.project_id,
  );
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  const refusal = cardRouteTenantRefusal(user, activeTenantId);
  if (refusal) return refusal;

  if (!hasElevatedSuppressionRights(user, project, activeTenantId)) {
    return elevationRefusal('Removing a finding suppression');
  }

  const removed = await deleteFindingSuppression({
    projectId: project.id,
    fingerprint: parsed.fingerprint,
    actingTenantId: activeTenantId,
    reason: parsed.reason,
    actor: user.id,
  });
  if (!removed) {
    return jsonResponse(
      {
        error: 'suppression_not_found',
        message: 'No suppression exists for this project and fingerprint.',
      },
      404,
    );
  }
  return jsonResponse({ suppressed: false, removed }, 200);
}

/** GET /api/findings/suppressions?project_id= — every suppression for a project. */
export async function handleListFindingSuppressions(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  const projectId = new URL(req.url).searchParams.get('project_id');
  const check = z.string().uuid().safeParse(projectId);
  if (!check.success) {
    return jsonResponse(
      {
        error: 'validation_failed',
        issues: [{ path: ['project_id'], message: 'project_id (uuid) is required' }],
      },
      400,
    );
  }

  const project = await resolveCardRouteProject(user, activeTenantId, check.data);
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  const refusal = cardRouteTenantRefusal(user, activeTenantId);
  if (refusal) return refusal;

  const items = await listFindingSuppressions(project.id);
  return jsonResponse({ items, total: items.length }, 200);
}
