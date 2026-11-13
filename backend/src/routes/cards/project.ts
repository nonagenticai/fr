// EXEC `it`-pipeline — POST /api/cards/project
//
// Spawns the NEXT card in a project's card-type chain (project_start_request_
// analysis → project_setup → development_chore → verification_test →
// project_closure). Called by
// every DONE-phase n8n workflow to hand off to the next card_type without
// shoving a Planka POST into the workflow JSON.
//
// Why a separate route (vs reusing POST /api/cards/improvement): the
// improvement route is `requireInternalTenant()`-gated and stream-keyed —
// wrong shape for EXEC + project_id. Loosening that gate would weaken the
// invariant that workers/n8n authoring system streams call only from the
// internal tenants. This route is project-scoped: the project_id resolves
// the board, the EXEC tenant scope is enforced via the project's
// `dept_id → workspace_id` chain (same projection used everywhere else).
//
// Auth: same as other cards routes — `validateAuth` + active-tenant must
// own the project. Plus the project must live on EXEC; non-EXEC project
// callers get 403 so we don't repurpose this route as a general card-spawner.

import {
  checkDescriptionScenarios,
  scenarioRefusalBody,
  scenarioRefusalStatus,
  splitScenarioEvidence,
} from '../../services/gherkin-scenarios';
import {
  deleteScenarioEvidence,
  insertScenarioEvidence,
} from '../../services/scenario-evidence';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import { db, projects, departments } from '../../db/client';
import {
  tenantScopedProjectFilter,
  licenceProjectScope,
  isSuperAdminSwitchedView,
} from '../../lib/project-access';
import { projectKcTenantTag } from '../../lib/project-owner-guard';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  clientSafePlankaErrorMessage,
} from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { plankaAsAgent } from '../../services/planka/with-auth';
import { resolveBoardFieldGroups, warnBoardFieldMissing } from '../../services/planka/custom-fields';
import type { BoardFieldGroup } from '../../services/planka/custom-fields';
import { dependencyUpgradeSubtype } from '../../services/catalogue/card-type-rules';
import {
  cardTypes as catalogueCardTypes,
  priorities as cataloguePriorities,
  projectCatalogueTenant,
} from '../../services/catalogue/tenant-catalogue';
import { CardPrioritySchema } from '../../services/improvement-cards/request-schema';
import { writeCardPriority } from '../../services/improvement-cards/card-priority';
import { findPriorityLevel, legacyPriorityText } from '../../services/catalogue/priority-levels';
import { fallbackBlockReason } from '../../services/card-block-reason';
import { isBlocked } from '../../lib/phase';
import {
  dependenciesThatRequire,
  linkParentChild,
  linkRequires,
  newPlankaRelationsCache,
  plankaRelationOps,
  removeFromRelationList,
  MalformedRelationFieldError,
  RelationWriteConflictError,
  RelationFieldCapacityError,
  type ParentChildLinkResult,
  type RelationOps,
} from '../../services/improvement-cards/relations';
import { PlankaError } from '../../services/planka/errors';
import type { PlankaClient } from '../../services/planka';
import {
  assetDedupesAcrossDone,
  findCardTypesForAsset,
  findOpenCardForAsset,
  partitionBoardLists,
} from '../../services/improvement-cards/dedup';
import {
  claimCreateLease,
  createLeaseKey,
  projectCreateLeaseNamespace,
  releaseCreateLeaseQuietly,
  waitForOpenCard,
} from '../../services/improvement-cards/create-lease';
import { isFindingSuppressed } from '../../services/findings/suppressions';
import { guardProjectId, type OwnershipCandidateProject } from '../../lib/project-owner-guard';
import {
  VERSION_STAMP_MAX_BYTES,
  VERSION_STAMP_POINTER_MAX_CHARS,
  buildVersionStampPointer,
  deleteVersionStamp,
  insertVersionStamp,
  versionStampSerialisedBytes,
  versionStampSha256,
} from '../../services/improvement-cards/version-stamp';
import {
  PLAN_PIN_METADATA_FIELD,
  buildPlanPinPointer,
  insertPlanPin,
  preparePlanPin,
  type PreparedPlanPin,
} from '../../services/improvement-cards/plan-pin';
import { assertProjectNotArchived } from '../../lib/project-live-status';
import type { User } from '../../types/api';
import {
  attachCardToDeliverable,
  detachCardFromDeliverable,
  isDeliverableRef,
  resolveMintDeliverable,
  type DeliverableAttachRefusal,
  type MintDeliverableRow,
} from '../../lib/deliverable-covers';
import { EXECUTION_TENANT_ID } from '../tenants';

/**
 * A deliverable link refused inside the create's rollback scope (fr#1481).
 * Caught below (the card is rolled back first); an AppError so that, should it
 * ever escape, handleError still answers its status + machine code.
 */
class DeliverableAttachRefused extends AppError {
  constructor(readonly refusal: DeliverableAttachRefusal) {
    super(refusal.status, refusal.body.error);
    this.name = 'DeliverableAttachRefused';
    this.withCode(refusal.body.error);
  }
}

/**
 * The Planka client this route family uses (the agent). Exported so a sibling
 * route that must READ a card before minting through `createProjectCardFor`
 * (POST /api/decompositions/split verifies its parent card is on the project's
 * board) uses the SAME client.
 */
export function projectCardPlankaAgent(): PlankaClient {
  return plankaAsAgent();
}

/**
 * The READ-ONLY board-group resolver this route family uses
 * (`resolveBoardFieldGroups`). Exported for the same reason as
 * `projectCardPlankaAgent`: a sibling route writing a Metadata field
 * (routes/cards/priority.ts) must resolve group/field ids the same way as the
 * create path. Never creates a group or field (v4 ruling 12).
 */
export function projectCardResolveGroups(): typeof resolveBoardFieldGroups {
  return resolveBoardFieldGroups;
}

const EMPTY_BOARD_GROUP = { groupId: '', fieldIds: {} as Record<string, string> };

/**
 * THE resolution of a project-card `target_list` name to a list on the board:
 * an EXACT name match (no trim, no case-fold), first match wins. Shared with
 * the READYING split (decomposition-split.ts), which decides "the parent sits
 * on TODO/READY" and "children can be minted into TODO" with this same
 * function, so those two answers cannot disagree with what the minter does.
 */
export function resolveProjectTargetList<L extends { name?: string | null }>(
  lists: readonly L[],
  targetList: string,
): L | undefined {
  return lists.find((l) => l.name === targetList);
}

const CARD_TYPE_NOT_IN_CATALOGUE = 'card_type_not_in_catalogue';

/**
 * THE card-type check of every project-card mint (POST /api/cards/project, the
 * decomposition commit and the READYING split): each `card_type` must be a card
 * type of the PROJECT's tenant in requirements_management (design: fr consumes RM
 * vocabulary — the old fr allowlist `PROJECT_CARD_TYPES` is gone, and there is no
 * local fallback). `tenantId` is the project row's tenant (`projectCatalogueTenant`
 * / the card stamp tenant), never the caller's.
 *
 * Returns null when every name is in the tenant's catalogue, else the 422 body
 * `card_type_not_in_catalogue` carrying the offending names and the tenant's
 * list. A tenant with no catalogue throws `CatalogueNotInitialised` (409).
 */
export async function cardTypeCatalogueRefusal(
  tenantId: string,
  requested: ReadonlyArray<string>,
): Promise<{ status: 422; body: Record<string, unknown> & { error: string } } | null> {
  const allowed = (await catalogueCardTypes(tenantId)).map((c) => c.name);
  const known = new Set(allowed);
  const invalid = [...new Set(requested.filter((t) => !known.has(t)))];
  if (invalid.length === 0) return null;
  return {
    status: 422,
    body: {
      error: CARD_TYPE_NOT_IN_CATALOGUE,
      message: `card_type(s) not in the PM catalogue of tenant ${tenantId}: ${invalid.join(', ')}`,
      tenant_id: tenantId,
      invalid,
      allowed,
    },
  };
}

/**
 * The security card_types of the project chain: the IT_MVP Flow 2/2s/2i
 * analysis card and the three remediation cards it spawns. A finding whose
 * fingerprint is the `asset_id` of any of these is a security finding, whatever
 * category a later caller declares for it (PUT /api/findings/suppressions).
 */
export const SECURITY_PROJECT_CARD_TYPES: ReadonlySet<string> = new Set<string>([
  'security_analysis',
  'development_security_patch',
  'development_source_security_patch',
  'development_iac_security_patch',
]);

/**
 * card_types of every card on the project's board stamped with
 * `Metadata.asset_id === assetId` (any list). Goes through the same Planka seam
 * as the card spawner (`plankaFactory` override). A project with no board has
 * no cards ⇒ []. Planka errors propagate — the caller must fail closed.
 */
export async function cardTypesForProjectAsset(
  project: { planka_board_id: string | null },
  assetId: string,
): Promise<string[]> {
  if (!project.planka_board_id) return [];
  const agent = plankaAsAgent();
  return await findCardTypesForAsset(agent, {
    boardId: project.planka_board_id,
    assetId,
  });
}

/**
 * The ONE shape a finding fingerprint may take — shared by
 * POST /api/cards/project `asset_id` and PUT /api/findings/suppressions
 * `fingerprint`, so a suppression can never be recorded under a key the card
 * spawner would refuse (or vice versa).
 *
 * The producer (n8n-nodes-conveyor-compute `findings.normalise`) emits
 * `<16 hex>.<ordinal>`, e.g. `3f2a9c01b7d4e8a6.0`. This is deliberately wider
 * than that — any printable non-whitespace ASCII, 1..200 chars — so a future
 * producer prefix does not need a backend change, while a padded or
 * whitespace-only value (`"   "`, `" x"`), which is always a caller bug and
 * would silently never match the stamped key, is a 400.
 */
export const FINDING_FINGERPRINT_PATTERN = '^[\\x21-\\x7E]{1,200}$';
/** Upper bound on `requires_card_ids` — each costs a Planka read plus two locked writes. */
export const MAX_REQUIRES_CARD_IDS = 20;

export const FindingFingerprintSchema = z
  .string()
  .regex(
    new RegExp(FINDING_FINGERPRINT_PATTERN),
    'fingerprint must be 1..200 printable ASCII characters with no whitespace',
  );

const CreateProjectCardSchema = z.object({
  project_id: z.string().uuid(),
  // A string here; membership in the PROJECT tenant's RM card types is checked
  // once the project is resolved (cardTypeCatalogueRefusal → 422).
  card_type: z.string().min(1).max(200),
  // Human-readable card title. Defaults to `{card_type} for {project_name}`
  // when omitted so workflow JSON can stay terse.
  card_name: z.string().min(1).max(200).optional(),
  // Free-text body. Workflows pass a structured JSON payload here for the
  // next workflow to parse — same convention as the project-start brief.
  description: z.string().optional(),
  // Card-Relations.parent_card — the spawning card's id. Walking parent_card
  // up the chain is how project_closure assembles the final report.
  parent_card_id: z.string().optional(),
  // List name to drop the new card on. Defaults to READY so the router fires
  // immediately. BLOCKED is allowed for human-handoff branches.
  target_list: z.enum(['TODO', 'READY', 'DOING', 'QA', 'BLOCKED']).default('READY'),
  // Stable finding fingerprint. When present the route (1) refuses to create
  // anything for a fingerprint in the finding_suppressions ledger, and (2)
  // dedupes onto an OPEN card on the project board already carrying this
  // Metadata.asset_id, under the same create lease as POST /api/cards/improvement.
  // Absent ⇒ behaviour is unchanged (no suppression read, no dedupe, no lease).
  asset_id: FindingFingerprintSchema.optional(),
  // Card ids this card must wait for (Card-Relations.requires). The conveyor
  // mints one fix card per group of findings; cards that touch the same file
  // must run in order, so the later card names the earlier ones here. Each id
  // must be a card on THIS project's board. Both sides are written (this
  // card's `requires`, each dependency's `required_by`) and the outcome is
  // reported as `requires_link`, so a caller can tell a link that was made
  // from a field that was dropped. Absent ⇒ behaviour is unchanged.
  //
  // Why here and not POST /api/cards/relations/link: that route is
  // requireInternalTenant()-gated and refuses the EXEC tenant this route serves.
  requires_card_ids: z
    .array(
      z
        .string()
        .regex(
          new RegExp(FINDING_FINGERPRINT_PATTERN),
          'card id must be 1..200 printable ASCII characters with no whitespace',
        ),
    )
    .max(MAX_REQUIRES_CARD_IDS)
    .optional(),
  // C1-46 — the card's full version stamp (an object). CREATE only: on a NEW
  // card the stamp is stored in fr (`card_version_stamps`, migration 140) and
  // the card carries only the pointer `{"store":"fr","sha256":"<hex>"}` in
  // `Metadata.version_stamp`. A dedupe hit / lease loser / suppressed
  // fingerprint writes neither. Absent ⇒ behaviour is unchanged.
  version_stamp: z.record(z.string(), z.unknown()).optional(),
  // U11 — the plan the minter computed for this card. CREATE only: on a NEW
  // card it is stored INSERT-ONCE in fr (`card_plan_pins`, migration 148) and
  // the card carries the pointer `{"store":"fr","sha256":"<hex>"}` in
  // `Metadata.plan_pin`. Shape-checked by preparePlanPin (422 on a bad shape),
  // so it is only an object here. Absent ⇒ behaviour is unchanged.
  plan_pin: z.record(z.string(), z.unknown()).optional(),
  // B7 — Metadata.priority. Same vocabulary as POST /api/cards/improvement
  // (request-schema.ts CardPrioritySchema). Without this key the non-strict
  // object STRIPPED a supplied priority and the card was created with none.
  // An out-of-vocabulary value is a 400, nothing created. Absent ⇒ no
  // priority is written (no default).
  priority: CardPrioritySchema.optional(),
  // fr#1481 — the DEFERRED deliverable this card belongs to: its plan slug
  // (pm Deliverable.id = project_deliverables.plan_deliverable_id, what a
  // template-configured minter knows) or its row uuid. When present the card
  // is attached to that deliverable with the SAME `card_contracts.covers` link
  // the decomposition commit writes (lib/deliverable-covers.ts), so the plan
  // read model counts it against the minter's reported `minted_count`.
  // Refused (nothing created): not on this project 404, not deferred 422,
  // already minted with every reported card attached 409. Idempotent: a retry
  // that dedupes onto an attached card links nothing new. Absent ⇒ unchanged.
  deliverable_id: z
    .string()
    .max(200)
    .refine(isDeliverableRef, 'deliverable_id must be a plan deliverable slug or a deliverable uuid')
    .optional(),
});

/** What the `requires` link did, per requested dependency id. */
interface RequiresLinkReport {
  /** The de-duplicated ids the caller asked for, in request order. */
  requested: string[];
  /** At least one side (`requires` or `required_by`) was written for these. */
  linked: string[];
  /** Both sides were already present — a retry. Zero writes. */
  already: string[];
}

/**
 * Refuse any requested dependency that is not a card on the project's own
 * board, BEFORE anything is created or linked — so a bad id costs no card, no
 * rollback and no dangling `required_by` on a sibling. One board belongs to
 * exactly one project, and the project was already resolved under the
 * caller's tenant, so the board check IS the project + tenant check.
 *
 * Returns the refusal Response, or null when every id is on the board.
 */
async function refuseForeignOrMissingRequires(
  agent: PlankaClient,
  boardId: string,
  ids: readonly string[],
): Promise<Response | null> {
  const missing: string[] = [];
  const foreign: string[] = [];
  for (const id of ids) {
    let cardBoardId: string | undefined;
    try {
      cardBoardId = (await agent.cards.get(id)).item?.boardId;
    } catch (err) {
      // 404, and 403 (a card on a board the agent cannot see), are both "not a
      // card on this project's board" from this caller's point of view.
      if (err instanceof PlankaError && (err.status === 404 || err.status === 403)) {
        missing.push(id);
        continue;
      }
      if (err instanceof PlankaError) {
        return jsonResponse(
          {
            error: 'planka_requires_card_fetch_failed',
            message: clientSafePlankaErrorMessage(err, 'cards/project requires-card fetch'),
            requires_card_id: id,
          },
          502,
        );
      }
      throw err;
    }
    if (String(cardBoardId ?? '') !== String(boardId)) foreign.push(id);
  }
  if (missing.length > 0) {
    return jsonResponse(
      { error: 'requires_card_not_found', requires_card_ids: missing },
      404,
    );
  }
  if (foreign.length > 0) {
    return jsonResponse(
      { error: 'requires_card_not_on_project_board', requires_card_ids: foreign },
      422,
    );
  }
  return null;
}

/**
 * Link `dependentId` → each id via the shared `linkRequires` primitive (same
 * advisory-lock + read-back discipline as the parent link). Idempotent: a
 * retry reports every id under `already` and issues no writes.
 */
async function linkRequiredCards(
  ops: RelationOps,
  dependentId: string,
  ids: readonly string[],
  /**
   * Out-param: every dependency whose `required_by` this call MAY have
   * appended `dependentId` to. Recorded BEFORE `linkRequires` runs, not after
   * it returns: `appendToRelationList` PATCHes and then read-back GETs, so a
   * failed read-back (503, or a conflict) throws after the PATCH already
   * landed. Recording on return would miss exactly that id and leave it
   * dangling. Over-recording is harmless — a strip of an id that is not there
   * returns 'absent', and a brand-new card's id was written by nobody else.
   */
  attemptedRequiredBy: string[] = [],
): Promise<RequiresLinkReport> {
  const report: RequiresLinkReport = { requested: [...ids], linked: [], already: [] };
  for (const dependencyId of ids) {
    attemptedRequiredBy.push(dependencyId);
    let r: Awaited<ReturnType<typeof linkRequires>>;
    try {
      r = await linkRequires(ops, { dependentId, dependencyId });
    } catch (err) {
      // The one case where "no PATCH reached this dependency" is PROVEN: its
      // `required_by` append refused at parse / capacity, which both throw
      // before the write. Un-record it so the rollback does not try to strip a
      // cell it cannot even parse (and report a dangling id that never was).
      if (
        (err instanceof MalformedRelationFieldError ||
          err instanceof RelationFieldCapacityError) &&
        err.cardId === dependencyId &&
        err.fieldName === 'required_by'
      ) {
        attemptedRequiredBy.pop();
      }
      throw err;
    }
    if (r.dependent_requires === 'appended' || r.dependency_required_by === 'appended') {
      report.linked.push(dependencyId);
    } else {
      report.already.push(dependencyId);
    }
  }
  return report;
}

/**
 * Resolve a project under the caller's active tenant — the projection every
 * project-scoped card route uses. Shared with routes/findings/suppressions.ts
 * so the suppression ledger is gated by exactly the same visibility rule as
 * the card spawner that reads it.
 */
export async function resolveCardRouteProject(
  user: User,
  activeTenantId: string,
  projectId: string,
) {
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        eq(projects.id, projectId),
        tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
          // Drop the owner filter only for the super-admin switched view (the
          // AA orchestrator's X-Tenant-Id override was removed by fr#1437).
          includeAllOwners: isSuperAdminSwitchedView(user, activeTenantId),
          ...licenceProjectScope(user),
        }),
      ),
    );
  return cardRouteTagBound(rows[0]?.project, activeTenantId);
}

/**
 * fr row 14b — the card-route resolvers are TAG-BOUND like every other project
 * loader: the project's own `keycloak_tenant_id` must equal the active tenant,
 * and an untagged row fails closed.
 *
 * Why this is needed on top of `tenantScopedProjectFilter`: the trusted
 * cross-tenant service view (`includeAllOwners` — the super-admin switch)
 * matches `tag = active OR
 * departments.workspace_id = active`. The dept half is NOT tag-based, so an
 * untagged (or foreign-tagged) project sitting in a department of the active
 * workspace resolved here. `resolveProject` (lib/project-access.ts) closes the
 * same lane with `guardProjectId`'s deny; these two resolvers never called it.
 * Same guard, same verdict (only `owned` passes), same counter/log side effect,
 * so a denial here is visible as `outcome="foreign"|"untagged"` exactly like
 * one in the shared seam. Denial ⇒ `undefined` ⇒ the callers' existing 404.
 */
function cardRouteTagBound<T extends OwnershipCandidateProject>(
  project: T | undefined,
  activeTenantId: string,
): T | undefined {
  if (!project) return undefined;
  return guardProjectId(project, activeTenantId, false).allowed ? project : undefined;
}

/**
 * `resolveCardRouteProject` keyed on the project's Planka BOARD instead of its
 * id — the SAME tenant projection (`tenantScopedProjectFilter`, owner filter
 * dropped only for the trusted cross-tenant service view). Used by POST
 * /api/cards/:id/scenario-evidence, whose caller names a CARD: the card's
 * board is the project's board, so "the project resolves under the caller's
 * tenant" is exactly "the card belongs to the caller's tenant", decided by the
 * one predicate POST /api/cards/project uses. undefined ⇒ not visible.
 */
export async function resolveCardRouteProjectByBoard(
  user: User,
  activeTenantId: string,
  boardId: string,
) {
  if (typeof boardId !== 'string' || boardId.length === 0) return undefined;
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        eq(projects.planka_board_id, boardId),
        tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
          includeAllOwners: isSuperAdminSwitchedView(user, activeTenantId),
          ...licenceProjectScope(user),
        }),
      ),
    )
    .limit(1);
  return cardRouteTagBound(rows[0]?.project, activeTenantId);
}

/**
 * fr row 14f — THE TENANT A PROJECT CARD IS STAMPED WITH.
 *
 * ⛔ It is the HUNTED/PARENT PROJECT's owning tenant (`projects.project_data
 * .keycloak_tenant_id`, read through the one shared accessor
 * `projectKcTenantTag` that `classifyProjectOwnership`/`guardProjectId` use —
 * NOT a second, parallel resolution), never the acting identity's active
 * tenant. `activeTenantId` honours the `X-Active-Tenant` /
 * `X-Tenant-Id` override (middleware/request-context.ts), so a card minted by
 * an orchestrator — or by anyone carrying an override — was labelled with the
 * MINTER's tenant rather than the owner's.
 *
 * ⛔ FAIL CLOSED. An untagged (or blank-tagged) project yields a 409 and
 * NOTHING is minted. There is no default and no fallback to the active tenant:
 * that fallback IS the mislabelling this closes. `activeTenantId` appears here
 * ONLY as diagnostics in the refusal body — it never becomes the stamp.
 *
 * ⚠️ `activeTenantId` keeps its OTHER job untouched: it is the AUTHORISATION
 * subject (`cardRouteTenantRefusal` below, and the tenant projection inside
 * `resolveCardRouteProject`). This function decides whose DATA the card is,
 * not who may mint it.
 *
 * ⚠️ MEASURED on origin/main: `resolveCardRouteProject` is already TAG-BOUND
 * (fr row 14b — `cardRouteTagBound` → `guardProjectId(...).allowed`, which
 * passes only `owned`), so by the time a caller reaches this function the tag
 * provably EQUALS `activeTenantId` and an untagged project has already 404'd.
 * This is therefore a SECOND, INDEPENDENT barrier: it removes the dependence
 * of the stamp's correctness on an invariant maintained in another function —
 * widen `cardRouteTagBound` (e.g. re-admit the non-tag-based
 * `departments.workspace_id` lane) and the stamp stays correct here.
 */
type CardStampTenant =
  | { ok: true; tenantId: string }
  | { ok: false; status: 409; body: Record<string, unknown> };

export function resolveCardStampTenant(
  project: { id: string; project_data: unknown },
  activeTenantId: string,
): CardStampTenant {
  const tenantId = projectKcTenantTag(project);
  if (!tenantId) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'project_tenant_unknown',
        message:
          `Project ${project.id} carries no tenant tag ` +
          '(project_data.keycloak_tenant_id); a card cannot be stamped with its ' +
          "owning tenant. Refusing rather than stamping the caller's active " +
          'tenant. Nothing was created.',
        project_id: project.id,
        active_tenant: activeTenantId,
      },
    };
  }
  return { ok: true, tenantId };
}

/**
 * The EXEC pin (see the handler): null when the caller may act, else the 403.
 */
export function cardRouteTenantRefusal(
  user: User,
  activeTenantId: string,
): Response | null {
  if (
    activeTenantId !== EXECUTION_TENANT_ID &&
    !isSuperAdminSwitchedView(user, activeTenantId)
  ) {
    return jsonResponse({ error: 'project_cards_only_on_exec_tenant' }, 403);
  }
  return null;
}

export async function handleCreateProjectCard(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse(
      { error: 'validation_failed', issues: [{ message: String(e) }] },
      400,
    );
  }
  return await createProjectCardFor(user, activeTenantId, body);
}

/**
 * The body of POST /api/cards/project for an ALREADY-AUTHENTICATED caller.
 *
 * Exported so POST /api/decompositions/commit (C1-58) mints its cards through
 * exactly this path — same schema, tenant scope, EXEC pin, suppression read,
 * asset_id dedupe, create lease, stamps, requires/parent links and rollback —
 * as an in-process call, never an HTTP self-call. The caller passes the
 * `user` its own `validateAuth` returned and the same `activeTenantId`, so the
 * project resolution and the EXEC pin below run again for every card.
 */
export async function createProjectCardFor(
  user: User,
  activeTenantId: string,
  body: unknown,
): Promise<Response> {
  let parsed: z.infer<typeof CreateProjectCardSchema>;
  try {
    parsed = CreateProjectCardSchema.parse(body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'validation_failed', issues: e.issues }, 400);
    }
    return jsonResponse(
      { error: 'validation_failed', issues: [{ message: String(e) }] },
      400,
    );
  }

  // gherkin_scenarios (fr#1338 / R3 repro contract v2): the description is a
  // free string, so the strict entry schema is applied to the card document
  // hydration will read. REFUSED (400 + code + qa_needs_info), never stripped.
  // Before any read or write — nothing is created.
  //
  // Then the evidence split (coordinator ruling movies-13): every entry's
  // `test_file_content` is taken OUT of the description Planka gets and stored
  // in fr's `card_scenario_evidence` (migration 154) once the card exists; the
  // card keeps `test_file_sha256` as the pointer. A description without
  // `test_file_content` is passed to Planka byte-identical.
  const scenarioRefusal = checkDescriptionScenarios(parsed.description);
  if (scenarioRefusal) return jsonResponse(scenarioRefusalBody(scenarioRefusal), scenarioRefusalStatus(scenarioRefusal));
  const scenarioSplit = splitScenarioEvidence(parsed.description);
  if ('refusal' in scenarioSplit) return jsonResponse(scenarioRefusalBody(scenarioSplit.refusal), 400);

  // Resolve the project under the caller's active tenant. The same
  // dept_id → workspace_id projection is used by handleGetProject; null
  // dept_id rows are visible only on the user's home tenant.
  const project = await resolveCardRouteProject(
    user,
    activeTenantId,
    parsed.project_id,
  );
  if (!project) {
    throw new NotFoundError('Project not found');
  }
  // fr#1499: no card is created on an ARCHIVED project — its board is torn
  // down at archive and every operator view hides it. 409 before any write.
  assertProjectNotArchived(project);

  // This route drives the AA phase-card chain. It is EXEC-pinned by default so
  // it can't be repurposed as a general-purpose card-spawner. Non-EXEC is
  // allowed ONLY for the super-admin switched view; every other non-EXEC
  // caller 403s. (The AA orchestrator's X-Tenant-Id cross-tenant override that
  // used to share this exception was removed by fr#1437/fr#1527.)
  const refusal = cardRouteTenantRefusal(user, activeTenantId);
  if (refusal) return refusal;

  // fr row 14f — whose DATA this card is, resolved from the PROJECT row the
  // lines above already loaded (no second query). BEFORE the suppression read,
  // the create lease and any Planka call: an untagged project is a 409 with
  // NOTHING created. See resolveCardStampTenant for why this never falls back
  // to `activeTenantId`, and for why the AUTHORISATION above deliberately
  // still uses it.
  const stampTenant = resolveCardStampTenant(project, activeTenantId);
  if (!stampTenant.ok) return jsonResponse(stampTenant.body, stampTenant.status);
  const projectTenantId = stampTenant.tenantId;

  // The card type must be one of the PROJECT tenant's RM card types (422
  // card_type_not_in_catalogue with the tenant's list) — nothing created.
  const typeRefusal = await cardTypeCatalogueRefusal(projectTenantId, [parsed.card_type]);
  if (typeRefusal) return jsonResponse(typeRefusal.body, typeRefusal.status);

  // B7 + design Q3 = b: a supplied priority must be one of the PROJECT tenant's
  // RM priority levels (400 invalid_priority, nothing created); Metadata.priority
  // gets the level's legacy text.
  let priorityText: string | undefined;
  if (parsed.priority !== undefined) {
    const levels = await cataloguePriorities(projectTenantId);
    const level = findPriorityLevel(levels, parsed.priority);
    if (!level) {
      // Same contract as the body's shape refusal (B7): 400 validation_failed
      // naming `priority`, with the tenant's levels — nothing created.
      return jsonResponse(
        {
          error: 'validation_failed',
          issues: [
            {
              path: ['priority'],
              message: `not a priority level of this project's tenant (allowed: ${levels.map(legacyPriorityText).join(', ')})`,
            },
          ],
        },
        400,
      );
    }
    priorityText = legacyPriorityText(level);
  }

  // fr#1481 — the deliverable this card attaches to, resolved ON THIS PROJECT
  // before the suppression read, the lease and any Planka call: a wrong
  // project / non-deferred deliverable is refused with nothing created.
  let deliverable: { ref: string; row: MintDeliverableRow; closed: DeliverableAttachRefusal | null } | null = null;
  if (parsed.deliverable_id !== undefined) {
    const d = await resolveMintDeliverable(project.id, parsed.deliverable_id);
    if (!d.ok) return jsonResponse(d.refusal.body, d.refusal.status);
    deliverable = { ref: parsed.deliverable_id, row: d.row, closed: d.closed };
  }
  // Added to a response ONLY when `deliverable_id` was sent, so a request
  // without it answers byte-identically to before.
  const linkEcho = (result: 'attached' | 'already' | null): Record<string, unknown> =>
    deliverable
      ? {
          deliverable_link: result === null
            ? null
            : { deliverable_id: deliverable.row.id, plan_deliverable_id: deliverable.row.plan_deliverable_id, result },
        }
      : {};

  // C1-46 — hash the stamp and build the Metadata pointer up front, and refuse
  // an over-long pointer BEFORE anything is created: 422, nothing written. The
  // real pointer is ~87 chars by construction; this is a guard on the pointer
  // ONLY and changes no other field's handling.
  let versionStamp: {
    stamp: Record<string, unknown>;
    sha256: string;
    pointer: string;
  } | null = null;
  if (parsed.version_stamp) {
    // Size cap FIRST (before hashing, the suppression read, the lease and any
    // Planka call): a stamp over 64 KiB serialised is a 422, nothing created.
    const stampBytes = versionStampSerialisedBytes(parsed.version_stamp);
    if (stampBytes > VERSION_STAMP_MAX_BYTES) {
      return jsonResponse(
        {
          error: 'version_stamp_too_large',
          message:
            `version_stamp is ${stampBytes} bytes serialised (UTF-8 JSON); ` +
            `the limit is ${VERSION_STAMP_MAX_BYTES} bytes. Nothing was created.`,
          field: 'version_stamp',
          max_bytes: VERSION_STAMP_MAX_BYTES,
          bytes: stampBytes,
        },
        422,
      );
    }
    const sha256 = versionStampSha256(parsed.version_stamp);
    const pointer = buildVersionStampPointer(sha256);
    if (pointer.length > VERSION_STAMP_POINTER_MAX_CHARS) {
      return jsonResponse(
        {
          error: 'version_stamp_pointer_too_long',
          message:
            `Metadata.version_stamp pointer is ${pointer.length} chars; ` +
            `the ceiling is ${VERSION_STAMP_POINTER_MAX_CHARS}. Nothing was created.`,
          max_chars: VERSION_STAMP_POINTER_MAX_CHARS,
          length: pointer.length,
        },
        422,
      );
    }
    versionStamp = { stamp: parsed.version_stamp, sha256, pointer };
  }

  // U11 — validate, size-cap and hash the plan pin up front (sha256 computed
  // HERE, server-side, never taken from the caller), and refuse a bad one with
  // a 422 BEFORE anything is created — the same placement as the stamp above.
  let planPin: PreparedPlanPin | null = null;
  if (parsed.plan_pin) {
    const prepared = preparePlanPin(
      parsed.plan_pin,
      buildPlanPinPointer,
    );
    if (!prepared.ok) return jsonResponse(prepared.body, prepared.status);
    planPin = prepared.pin;
  }

  // Suppression ledger (migration 130) — BEFORE any Planka call, the dedupe
  // read and the create lease. A fingerprint a human/QA marked false-positive
  // is never turned into a card again; the answer is a 200 so the conveyor
  // treats it as handled, not as a failure to retry. Keyed on the PROJECT, not
  // the active tenant: the owner's EXEC view and the orchestrator's customer-
  // tenant view of one project must see the same suppressions.
  if (
    parsed.asset_id &&
    (await isFindingSuppressed(
      project.id,
      parsed.asset_id,
    ))
  ) {
    return jsonResponse({ suppressed: true, card_id: null, ...linkEcho(null) }, 200);
  }

  if (!project.planka_board_id) {
    throw new BadRequestError(
      'Project has no planka_board_id — cannot spawn cards',
    );
  }

  const agent = plankaAsAgent();

  // Resolve target list by name on the project's board. `listByBoard` is the
  // existing helper used by handleCreateImprovementCard.
  let lists;
  try {
    lists = await agent.lists.listByBoard(project.planka_board_id);
  } catch (err) {
    if (err instanceof PlankaError) {
      return jsonResponse(
        {
          error: 'planka_list_fetch_failed',
          message: clientSafePlankaErrorMessage(err, 'cards/project list fetch'),
        },
        502,
      );
    }
    throw err;
  }
  const targetList = resolveProjectTargetList(lists, parsed.target_list);
  if (!targetList) {
    return jsonResponse(
      { error: 'target_list_not_found', list: parsed.target_list },
      404,
    );
  }

  const cardName = parsed.card_name ?? `${parsed.card_type} — ${project.name}`;
  const boardId = project.planka_board_id;

  // `requires_card_ids`: de-duplicated (request order kept), then validated
  // against THIS board before the dedupe read and before any create, so a bad
  // id never costs a card, a rollback, or a dangling `required_by`.
  const requiresIds = parsed.requires_card_ids
    ? [...new Set(parsed.requires_card_ids)]
    : null;
  if (requiresIds && requiresIds.length > 0) {
    const requiresRefusal = await refuseForeignOrMissingRequires(
      agent,
      boardId,
      requiresIds,
    );
    if (requiresRefusal) return requiresRefusal;
  }

  // RelationOps for the requires link, pre-seeded with the board's Relations
  // group so `plankaRelationOps` does not re-read the board per call. The
  // create path passes the group it already resolved; the dedupe path (which
  // returns before group resolution) resolves it here. Read-only: a board
  // without the template's Relations group skips the link writes with a warning.
  const requiresRelationOps = async (
    relationsGroup?: BoardFieldGroup,
  ): Promise<RelationOps> => {
    const rel =
      relationsGroup ??
      (await projectCardResolveGroups()(agent, boardId)).Relations ??
      EMPTY_BOARD_GROUP;
    const cache = newPlankaRelationsCache();
    cache.byBoard.set(boardId, rel);
    return plankaRelationOps(agent, boardId, cache);
  };

  // An OPEN card for this asset already exists. With `requires_card_ids`, the
  // existing card is linked to them too — the same idempotent link, so a retry
  // of a create whose first attempt landed (or a later emit that learned of a
  // new predecessor) converges on the union instead of silently dropping the
  // ordering. Nothing is created here, so nothing is rolled back on failure.
  const dedupedResponse = async (existingCardId: string): Promise<Response> => {
    // fr#1481 — a dedupe hit is attached too (idempotent: a retry of a create
    // whose first attempt landed AND attached links nothing new). Nothing was
    // created here, so a refusal leaves the existing card alone.
    let link: 'attached' | 'already' | null = null;
    if (deliverable) {
      const a = await attachCardToDeliverable({
        tenantId: projectTenantId,
        cardId: existingCardId,
        rowId: deliverable.row.id,
        ref: deliverable.ref,
      });
      if (!a.ok) {
        return jsonResponse({ ...a.refusal.body, card_id: existingCardId, deduped: true }, a.refusal.status);
      }
      link = a.result;
    }
    if (!requiresIds) {
      return jsonResponse({ card_id: existingCardId, deduped: true, ...linkEcho(link) }, 200);
    }
    if (requiresIds.includes(existingCardId)) {
      return jsonResponse(
        {
          error: 'requires_card_self_reference',
          card_id: existingCardId,
          deduped: true,
          requires_card_ids: [existingCardId],
        },
        400,
      );
    }
    let report: RequiresLinkReport;
    try {
      const ops = await requiresRelationOps();
      // Refuse BEFORE any write: a re-emit that dedupes onto A naming B, while
      // B already requires A, would otherwise deadlock A and B.
      const cycling = await dependenciesThatRequire(ops, existingCardId, requiresIds);
      if (cycling.length > 0) {
        return jsonResponse(
          {
            error: 'requires_cycle',
            message:
              `card ${existingCardId} is already required by ${cycling.join(', ')}; ` +
              'linking it to require them would deadlock both',
            card_id: existingCardId,
            deduped: true,
            requires_card_ids: cycling,
            requires_link: 'not_made',
          },
          409,
        );
      }
      report = await linkRequiredCards(ops, existingCardId, requiresIds);
    } catch (err) {
      if (
        err instanceof MalformedRelationFieldError ||
        err instanceof RelationWriteConflictError ||
        err instanceof RelationFieldCapacityError
      ) {
        return jsonResponse(
          {
            error: err.code,
            message: err.message,
            card_id: existingCardId,
            deduped: true,
            requires_card_ids: requiresIds,
            field: err.fieldName,
            details: err.details,
            requires_link: 'not_made',
          },
          409,
        );
      }
      if (err instanceof PlankaError) {
        return jsonResponse(
          {
            error: 'planka_requires_link_failed',
            message: clientSafePlankaErrorMessage(err, 'cards/project requires link'),
            card_id: existingCardId,
            deduped: true,
            requires_link: 'not_made',
          },
          502,
        );
      }
      throw err;
    }
    return jsonResponse(
      { card_id: existingCardId, deduped: true, requires_link: report, ...linkEcho(link) },
      200,
    );
  };

  // Open-card dedupe on `asset_id` — the SAME contract as
  // POST /api/cards/improvement step 3b-3d (read there for the full #996
  // argument), board-scoped to this project's board:
  //   * an OPEN card (any list except DONE) already carrying this
  //     Metadata.asset_id ⇒ 200 {card_id, deduped:true}, nothing created;
  //   * a card in DONE does NOT suppress — a finding that recurs after its fix
  //     card closed gets a fresh card — EXCEPT a `deliv:` / `split:` / `a3:`
  //     asset (see assetDedupesAcrossDone), where DONE suppresses as well;
  //   * a card in BLOCKED suppresses only until FR_BLOCKED_SUPPRESSION_TTL_DAYS
  //     (dedup.ts BLOCKED-SUPPRESSION essay) — unchanged, inherited as-is.
  // The pre-read alone is a TOCTOU, so the create below runs under the create
  // lease; losers never create, they answer with the winner's card.
  // Lease namespace is the PROJECT, not the caller's active tenant: the EXEC
  // owner and a super-admin switched into the project's tenant both reach this
  // board, and must contend for ONE lease row (create-lease.ts).
  const leaseNamespace = projectCreateLeaseNamespace(project.id);
  let heldLease: { key: string; owner: string } | undefined;
  if (parsed.asset_id) {
    const assetId = parsed.asset_id;
    // C1-58 ruling 4: a `deliv:<deliverable_id>` asset (one card per approved
    // project deliverable, minted by POST /api/decompositions/commit) dedupes
    // across DONE too — a delivered deliverable must never be re-minted by a
    // re-drive. Every OTHER prefix keeps the DONE-does-not-suppress rule below.
    const { openListIds, blockedListIds } = partitionBoardLists(lists, {
      includeDone: assetDedupesAcrossDone(assetId),
    });
    const findOpen = (): Promise<string | null> =>
      findOpenCardForAsset(agent, {
        boardId,
        assetId,
        openListIds,
        blockedListIds,
      });

    const existingCardId = await findOpen();
    if (existingCardId) {
      return await dedupedResponse(existingCardId);
    }

    const leaseKey = createLeaseKey(boardId, assetId);
    const owner = crypto.randomUUID();
    const won = await claimCreateLease(leaseNamespace, leaseKey, owner);
    if (!won) {
      const marker = await waitForOpenCard(findOpen);
      // create_in_progress: nothing to link yet. `requires_link` reports the
      // request with nothing linked, so the caller's retry is visibly owed.
      return marker
        ? await dedupedResponse(marker)
        : jsonResponse(
            {
              card_id: null,
              deduped: true,
              create_in_progress: true,
              ...(requiresIds
                ? { requires_link: { requested: requiresIds, linked: [], already: [] } }
                : {}),
              ...linkEcho(null),
            },
            200,
          );
    }

    // WINNER RECHECK — a previous winner may have created and released
    // between our pre-read and our claim (improvement.ts step 3d, mutant M5).
    const afterClaim = await findOpen();
    if (afterClaim) {
      await releaseCreateLeaseQuietly(leaseNamespace, leaseKey, owner);
      return await dedupedResponse(afterClaim);
    }
    heldLease = { key: leaseKey, owner };
  }

  // Everything from here to the 201 runs under `finally { release }` — a
  // throw anywhere (group provisioning, create, stamp, link) must not leak the
  // lease for a full TTL. `finally`, not `catch`: a non-Error rejection must
  // release too (improvement.ts mutants M6/M7).
  try {
    // fr#1481 — a NEW card for a deliverable whose minter already reported its
    // count with every card attached would exceed it: refused before the
    // create (the attach below re-checks under the row lock for races).
    if (deliverable?.closed) {
      return jsonResponse(deliverable.closed.body, deliverable.closed.status);
    }
    // The board's groups/fields as its RM template created them — READ-ONLY.
    // A field the board lacks is skipped with a warning (`stamp`), never
    // created (v4 ruling 12: the RM board template is the master).
    const groups = await projectCardResolveGroups()(agent, boardId);
    const metadata = groups.Metadata ?? EMPTY_BOARD_GROUP;
    const relations = groups.Relations ?? EMPTY_BOARD_GROUP;

    // Create the card. If any subsequent PATCH throws, delete the orphan so
    // we don't leak an unstamped (and thus undispatchable) card.
    let cardId: string;
    try {
      const card = await agent.cards.create({
        listId: targetList.id,
        name: cardName,
        description: scenarioSplit.description,
        position: 65536,
        type: 'project',
      });
      cardId = card.id;
    } catch (err) {
      if (err instanceof PlankaError) {
        return jsonResponse(
          {
            error: 'planka_card_create_failed',
            message: clientSafePlankaErrorMessage(err, 'cards/project card create'),
          },
          502,
        );
      }
      throw err;
    }

    const stamp = async (
      group: { groupId: string; fieldIds: Record<string, string> },
      fieldName: string,
      content: string,
      groupName = 'Metadata',
    ): Promise<void> => {
      const fieldId = group.fieldIds[fieldName];
      if (!fieldId) {
        warnBoardFieldMissing({ boardId, cardId, group: groupName, field: fieldName, context: 'cards.project.create' });
        return;
      }
      await agent.customFields.setCardCustomFieldValue({
        cardId,
        customFieldGroupId: group.groupId,
        customFieldId: fieldId,
        content,
      });
    };

    // OD-6 (AA BACKLOG §5): tag a dependency-upgrade card_input subtype so
    // kaizen scoring can score dependency upgrades as a class — WITHOUT a
    // dedicated card_type. WHICH card types qualify is the project tenant's RM
    // catalogue (card-type rule `dependency_upgrade`); the signal is the
    // project's IT_MVP flow (it_flow 'dependency', or the absent default). See
    // services/catalogue/card-type-rules.ts dependencyUpgradeSubtype().
    const itFlow = (project.project_data as Record<string, unknown> | null)?.[
      'it_flow'
    ];
    const subtype = await dependencyUpgradeSubtype(
      projectCatalogueTenant(project),
      parsed.card_type,
      typeof itFlow === 'string' ? itFlow : undefined,
    );

    // What the parent↔child link did, surfaced on the 201. Stays null when the
    // caller passed no `parent_card_id`.
    let linkResult: ParentChildLinkResult | null = null;
    // What the requires link did. Null when `requires_card_ids` was omitted.
    let requiresReport: RequiresLinkReport | null = null;
    // Which step a failure below came from.
    let linkPhase: 'stamp' | 'requires' | 'parent' = 'stamp';
    // Dependencies whose `required_by` this request may have appended the new
    // card to (recorded before each write) — stripped again if the card is
    // rolled back, so no dangling id survives.
    const attemptedRequiredBy: string[] = [];
    // Set only when THIS request inserted the `card_version_stamps` row, so the
    // rollback below deletes exactly the row it owns.
    let versionStampRowInserted = false;
    // fr#1338 — set BEFORE the evidence insert is attempted, so the rollback
    // below deletes by card id whatever may have been written for this
    // brand-new card (the insert is itself all-or-nothing; this also covers a
    // commit that landed but whose acknowledgement was lost).
    let scenarioEvidenceInserted = false;
    // Set only when THIS request inserted the `card_plan_pins` row. Unlike the
    // stamp row it is NEVER deleted on rollback — migration 148 refuses DELETE
    // — so the rollback only REPORTS it as kept.
    let planPinRowInserted = false;
    // fr#1481 — set only when THIS request inserted the deliverable link, so
    // the rollback below removes exactly the row it owns.
    let deliverableLinked = false;
    let deliverableLink: 'attached' | 'already' | null = null;

    try {
      await stamp(metadata, 'card_type', parsed.card_type);
      await stamp(metadata, 'work_type', 'project_management');
      await stamp(metadata, 'card_group', 'project_management');
      await stamp(metadata, 'project_id', parsed.project_id);
      // WITHOUT THIS, A CARD THAT BOUNCES ONCE IS STRANDED FOREVER.
      //
      // There are three ways a TODO card is selected, and two are off:
      //   * the router is event-driven — ONE SHOT per Planka move, no retry;
      //   * the watchdog `todo_retrigger` is gated on AA_WATCHDOG_TODO_DRAIN, measured
      //     ABSENT from the live n8n-config ConfigMap => default OFF;
      //   * `AA Maintenance - Todo Sweep` IS armed and healthy (142 successful runs in
      //     24 h, measured 2026-09-01) but its WHERE clause requires
      //     `keycloak_tenant_id <> ''`.
      // Only `projects.ts` stamped it, and only on the board's INTAKE card. Every card
      // minted through THIS route — chain successors (`done-finalize :: Spawn Next Card`),
      // decomposition cards, generated refactoring cards, and every drive-*.sh script —
      // was invisible to the sweep for the life of the board.
      //
      // MEASURED estate-wide before shipping: of 639 TODO cards, 536 carry no tenant, and
      // **82 of those pass every OTHER sweep clause** — i.e. this one line makes 82
      // stranded cards selectable. (On one inspected board the number was 0: all 12 of its
      // TODO cards also fail `requires`/`child_cards`, which are CORRECT exclusions. The
      // fix is real but it is not a universal unstick — do not claim it drains the backlog.)
      //
      // ⛔ fr row 14f — the PROJECT's owning tenant (`projectTenantId`, resolved
      // by `resolveCardStampTenant` above), NEVER `activeTenantId`. The field is
      // already declared in the Metadata group. An orchestrator (or any caller
      // with an X-Active-Tenant override) minting into a project it does not own
      // must label the card with the OWNER's tenant, or the sweep, the billing
      // lane and every tenant-scoped reader see it under the minter.
      await stamp(metadata, 'keycloak_tenant_id', projectTenantId);
      // B7 — only when supplied; inside this try so a failed stamp rolls the
      // card back like every other Metadata stamp.
      // Same writer as the edit door (routes/cards/priority.ts).
      if (priorityText !== undefined) {
        await writeCardPriority(agent, cardId, metadata, priorityText, { boardId, context: 'cards.project.create' });
      }
      // The dedupe key. Written INSIDE this try so a failed stamp rolls the card
      // back — an unstamped card would be invisible to findOpenCardForAsset and
      // the next emit would mint a duplicate. Same field improvement.ts writes
      // (valuesFromRequest → Metadata.asset_id).
      if (parsed.asset_id) {
        await stamp(metadata, 'asset_id', parsed.asset_id);
      }
      // C1-46 — the version stamp row, then its pointer. INSIDE this try so a
      // later failure (pointer stamp, requires/parent link) rolls both back:
      // the catch deletes the row together with the card. Row first, so the
      // pointer never names a row that does not exist.
      //
      // ⛔ Guarded on a REAL card id: only a create that returned one may write.
      // The dedupe hit, the lease loser (`create_in_progress`, card_id null)
      // and a suppressed fingerprint all return before the create and never
      // reach this line; the guard makes that a checked fact here as well.
      if (versionStamp) {
        if (typeof cardId !== 'string' || cardId.length === 0) {
          throw new Error('version_stamp: Planka create returned no card id; nothing stamped');
        }
        versionStampRowInserted = await insertVersionStamp({
          cardId,
          projectId: project.id,
          stamp: versionStamp.stamp,
          sha256: versionStamp.sha256,
        });
        if (!versionStampRowInserted) {
          // A row for a card id Planka has just minted: the pointer would name
          // a stamp that is not this one. Refuse rather than mislabel.
          throw new Error(
            `version_stamp: card_version_stamps already holds a row for new card ${cardId}`,
          );
        }
        await stamp(metadata, 'version_stamp', versionStamp.pointer);
      }
      // fr#1338 — the repro evidence Planka never sees. Same guard and rollback
      // as the version stamp row above: a real card id, inside this try.
      if (scenarioSplit.evidence.length > 0) {
        if (typeof cardId !== 'string' || cardId.length === 0) {
          throw new Error('scenario_evidence: Planka create returned no card id; nothing stored');
        }
        scenarioEvidenceInserted = true;
        // All or nothing (one transaction); throws when any row is not written.
        await insertScenarioEvidence({
          cardId,
          projectId: project.id,
          evidence: scenarioSplit.evidence,
        });
      }
      // U11 — the plan pin row, then its pointer: B13's ordering exactly (row
      // first, so the pointer never names a row that does not exist; both
      // inside this try, so a later failure deletes the card). Guarded on a
      // real card id like the stamp. ⛔ A row that ALREADY exists for the card
      // Planka has just minted is refused, never overwritten: the pointer is
      // written once, here, and nothing in fr rewrites it.
      if (planPin) {
        if (typeof cardId !== 'string' || cardId.length === 0) {
          throw new Error('plan_pin: Planka create returned no card id; nothing pinned');
        }
        // ⛔ fr row 14f — the pin row is owned by the PROJECT's tenant
        // (`projectTenantId`, the same `resolveCardStampTenant` result the
        // Metadata stamp uses), NEVER `activeTenantId`: a minter acting into a
        // project it does not own must not file the pin under itself.
        planPinRowInserted = await insertPlanPin({
          cardId,
          tenantId: projectTenantId,
          plan: planPin.plan,
          sha256: planPin.sha256,
        });
        if (!planPinRowInserted) {
          throw new Error(
            `plan_pin: card_plan_pins already holds a row for new card ${cardId}; the pin is never rewritten`,
          );
        }
        await stamp(metadata, PLAN_PIN_METADATA_FIELD, planPin.pointer);
      }
      if (subtype) {
        await stamp(metadata, 'subtype', subtype);
      }
      // ⛔ `target_list` accepts 'BLOCKED' (see the enum above — "allowed for
      // human-handoff branches"), and a card created straight into BLOCKED is a
      // BLOCKED transition like any other. Nothing on this path carries a
      // reason, so without this the card lands with an empty `block_reason`,
      // which `blocked-escalate :: __deriveReason` classifies
      // `unknown_no_reason_persisted` — and that classification makes the
      // escalation a QUESTION, which `approval-callback :: Resolve Target List`
      // treats as a deliberate HOLD, so the card can never leave BLOCKED.
      // See services/card-block-reason.ts.
      //
      // Written through the local `stamp` (inside the same try as every other
      // field) rather than the best-effort helper ON PURPOSE: on THIS path a
      // stamp failure already rolls the card back, so there is no half-created
      // card to protect — unlike the move routes, where the card has already
      // landed in BLOCKED by the time we are called.
      if (isBlocked(parsed.target_list)) {
        await stamp(
          groups['Runtime State'] ?? EMPTY_BOARD_GROUP,
          'block_reason',
          fallbackBlockReason('fr.cards.project.create'),
          'Runtime State',
        );
      }
      // fr#1481 — the deliverable link, INSIDE this try: the card and its
      // `covers` link land together or the card is rolled back (and the link
      // with it). Before requires/parent so a refusal leaves no relation to undo.
      if (deliverable) {
        const a = await attachCardToDeliverable({
          tenantId: projectTenantId,
          cardId,
          rowId: deliverable.row.id,
          ref: deliverable.ref,
        });
        if (!a.ok) throw new DeliverableAttachRefused(a.refusal);
        deliverableLinked = a.result === 'attached';
        deliverableLink = a.result;
      }
      if (requiresIds) {
        // Inside this try on purpose: a failed requires link rolls the new card
        // back exactly like a failed parent link. A card that should wait for a
        // sibling but carries no `requires` would be picked up immediately and
        // edit the same file concurrently — the very thing this field prevents.
        //
        // BEFORE the parent link, on purpose: a requires failure then leaves the
        // parent's `child_cards` untouched. The dependency side it may already
        // have written (`required_by`) is compensated in the catch below.
        linkPhase = 'requires';
        requiresReport = await linkRequiredCards(
          await requiresRelationOps(relations),
          cardId,
          requiresIds,
          attemptedRequiredBy,
        );
      }
      if (parsed.parent_card_id) {
        linkPhase = 'parent';
        // BOTH SIDES, via the shared primitive — not a one-sided stamp.
        //
        // This used to be `stamp(relations, 'parent_card', …)`, which wrote only the
        // CHILD's downward pointer and never touched the parent's `child_cards`. The
        // string `child_cards` did not appear in this file at all. That is not a
        // cosmetic asymmetry: every consumer that reasons about a parent's children
        // reads the PARENT's array, so a card created through this route was
        // structurally invisible to them.
        //
        //   - n8n `done-finalize.json :: Build Dep Check` reads the parent's
        //     `Relations.child_cards`; `Compute Progression` then advances the parent
        //     only when `blocking.length > 0` AND every child sits in DONE. With an
        //     empty array `blocking.length === 0`, so `advance` stays FALSE and the
        //     parent can NEVER progress — the children complete and the parent waits
        //     forever.
        //   - `todo-pickup.json :: Read Card Deps` reads the same array to decide
        //     whether a card is waiting on anything.
        //
        // So this is a strict unblock, not a new gate: it cannot cause a parent to
        // stall that previously advanced, because a parent with no `child_cards`
        // never advanced in the first place.
        //
        // `linkParentChild` already existed and was DARK — exposed via
        // `POST /api/cards/relations/link` with zero callers anywhere in the n8n
        // `workflows/` tree. It is idempotent (it reads current state and skips the
        // PATCH when the link is already present), so a retry of this route is safe.
        // ⭐ CONCURRENCY. `linkParentChild` used to be an unguarded
        // read-modify-write of the parent's `child_cards` cell: read the array,
        // push, PATCH the whole cell back. Two children spawned against the same
        // parent at the same time both read the pre-existing array and both
        // wrote their own one-element result — the second erased the first, and
        // BOTH requests returned 201 with a card_id.
        //
        // The damage does not surface here. It surfaces days later as a parent
        // that never leaves its list, because `Build Dep Check` (quoted above)
        // advances a parent only when every id in `child_cards` is DONE — and
        // the child that would have unblocked it is not in the array. That reads
        // like an n8n scheduling fault, which is why it survived: the 201 in the
        // log says the link was made.
        //
        // It is now serialised on a Postgres advisory lock across every fr
        // replica, and read back to verify. See the header of
        // `services/improvement-cards/relations.ts` for why a lock rather than
        // CAS (Planka's PATCH has no If-Match) and what it does NOT cover.
        linkResult = await linkParentChild(
          await requiresRelationOps(relations),
          { parentId: parsed.parent_card_id, childId: cardId },
        );
      }
    } catch (err) {
      // Orphan-delete on stamp failure — mirrors createImprovementCard's
      // rollback contract. An unlinked card is worse than no card: it is exactly
      // the invisible-to-Build-Dep-Check state this route exists to prevent.
      //
      // ⚠️ Whether the rollback SUCCEEDED is now reported. It used to be
      // swallowed, so a failed delete left a real orphan card on the board while
      // the response said only that the stamp failed.
      let rolledBack = true;
      try {
        await agent.cards.delete(cardId);
      } catch {
        rolledBack = false;
      }
      // fr#1481 — the deliverable link goes with the card (only when the delete
      // succeeded: a surviving card keeps its link, so the count stays true).
      let deliverableRollback: Record<string, unknown> = {};
      if (deliverableLinked) {
        let detached = false;
        if (rolledBack) {
          try {
            await detachCardFromDeliverable(cardId, deliverable!.row.id);
            detached = true;
          } catch (linkErr) {
            reportSwallowedFailure(linkErr, {
              service: 'fr-db',
              method: 'detachCardFromDeliverable',
              degradedTo: 'orphan card_contracts link reported as deliverable_link_rolled_back=false',
            });
          }
        }
        deliverableRollback = {
          deliverable_link_rolled_back: detached,
          ...(rolledBack ? {} : { deliverable_link_kept_for_surviving_card: true }),
        };
      }
      // C1-46 — the stamp row goes with the card. Only when the card delete
      // SUCCEEDED: a surviving card may carry its pointer, so its row stays
      // (same rule as `required_by` below). A failed row delete is reported,
      // never assumed.
      let versionStampRollback: Record<string, unknown> = {};
      if (versionStampRowInserted && rolledBack) {
        try {
          await deleteVersionStamp(cardId);
          versionStampRollback = { version_stamp_rolled_back: true };
        } catch (stampErr) {
          reportSwallowedFailure(stampErr, {
            service: 'fr-db',
            method: 'deleteVersionStamp',
            degradedTo: 'orphan card_version_stamps row reported as version_stamp_rolled_back=false',
          });
          versionStampRollback = { version_stamp_rolled_back: false };
        }
      } else if (versionStampRowInserted) {
        versionStampRollback = {
          version_stamp_rolled_back: false,
          version_stamp_kept_for_surviving_card: true,
        };
      }
      // fr#1338 — the evidence rows go with the card, by the same rule. Folded
      // into the same spread every refusal body below already carries.
      if (scenarioEvidenceInserted) {
        let evidenceRolledBack = false;
        if (rolledBack) {
          try {
            await deleteScenarioEvidence(cardId);
            evidenceRolledBack = true;
          } catch (evErr) {
            reportSwallowedFailure(evErr, {
              service: 'fr-db',
              method: 'deleteScenarioEvidence',
              degradedTo: 'orphan card_scenario_evidence rows reported as scenario_evidence_rolled_back=false',
            });
          }
        }
        versionStampRollback = {
          ...versionStampRollback,
          scenario_evidence_rolled_back: evidenceRolledBack,
          ...(rolledBack ? {} : { scenario_evidence_kept_for_surviving_card: true }),
        };
      }
      versionStampRollback = { ...versionStampRollback, ...deliverableRollback };
      // U11 — an inserted pin row is insert-once (migration 148 refuses DELETE),
      // so it outlives a rolled-back card. Planka ids are never reused, so the
      // row cannot be read as another card's plan. Reported, never hidden.
      if (planPinRowInserted) {
        versionStampRollback = {
          ...versionStampRollback,
          plan_pin_kept_for_rolled_back_card: rolledBack,
          ...(rolledBack ? {} : { plan_pin_kept_for_surviving_card: true }),
        };
      }
      // Strip the rolled-back card from every `required_by` this request may
      // have appended it to — otherwise a dependency would name a card that no
      // longer exists. 'removed' and 'absent' both mean clean; anything that
      // throws is reported as dangling. Reported, never assumed.
      //
      // Only when the delete SUCCEEDED: if the card survives, it still carries
      // its own `requires`, and stripping the dependency side would leave the
      // pair inconsistent. The surviving card keeps both sides; say so.
      let requiresRollback: Record<string, unknown> = {};
      if (attemptedRequiredBy.length > 0 && !rolledBack) {
        requiresRollback = {
          required_by_rolled_back: false,
          required_by_kept_for_surviving_card: [...attemptedRequiredBy],
        };
      } else if (attemptedRequiredBy.length > 0) {
        const danglingRequiredBy: string[] = [];
        let ops: RelationOps | null = null;
        try {
          ops = await requiresRelationOps(relations);
        } catch (stripErr) {
          reportSwallowedFailure(stripErr, {
            service: 'planka',
            method: 'requiresRelationOps',
            degradedTo: 'required_by strip skipped; ids reported as dangling_required_by',
          });
          danglingRequiredBy.push(...attemptedRequiredBy);
        }
        if (ops) {
          for (const dependencyId of attemptedRequiredBy) {
            try {
              await removeFromRelationList(ops, {
                cardId: dependencyId,
                fieldName: 'required_by',
                member: cardId,
              });
            } catch (stripErr) {
              reportSwallowedFailure(stripErr, {
                service: 'planka',
                method: 'removeFromRelationList',
                degradedTo: 'id reported as dangling_required_by',
              });
              danglingRequiredBy.push(dependencyId);
            }
          }
        }
        requiresRollback = {
          required_by_rolled_back: danglingRequiredBy.length === 0,
          ...(danglingRequiredBy.length > 0
            ? { dangling_required_by: danglingRequiredBy }
            : {}),
        };
      }
      if (err instanceof DeliverableAttachRefused) {
        return jsonResponse(
          { ...err.refusal.body, spawned_card_rolled_back: rolledBack, ...versionStampRollback },
          err.refusal.status,
        );
      }
      if (
        err instanceof MalformedRelationFieldError ||
        err instanceof RelationWriteConflictError ||
        err instanceof RelationFieldCapacityError
      ) {
        if (linkPhase === 'requires') {
          return jsonResponse(
            {
              error: err.code,
              message: err.message,
              requires_card_ids: requiresIds,
              field: err.fieldName,
              details: err.details,
              requires_link: 'not_made',
              spawned_card_rolled_back: rolledBack,
              ...requiresRollback,
              ...versionStampRollback,
            },
            409,
          );
        }
        // 409, not 502 and NOT 201: the card was created but the parent link was
        // refused, so the caller must not conclude the child is tracked. The
        // parent's existing value is untouched — that is the point of refusing.
        return jsonResponse(
          {
            error: err.code,
            message: err.message,
            parent_card_id: parsed.parent_card_id,
            field: err.fieldName,
            details: err.details,
            parent_link: 'not_made',
            spawned_card_rolled_back: rolledBack,
            ...requiresRollback,
            ...versionStampRollback,
          },
          409,
        );
      }
      if (err instanceof PlankaError) {
        if (linkPhase === 'requires') {
          return jsonResponse(
            {
              error: 'requires_link_failed',
              message: clientSafePlankaErrorMessage(err, 'cards/project requires link'),
              requires_card_ids: requiresIds,
              requires_link: 'not_made',
              spawned_card_rolled_back: rolledBack,
              ...requiresRollback,
              ...versionStampRollback,
            },
            502,
          );
        }
        return jsonResponse(
          {
            error: 'planka_field_stamp_failed',
            message: clientSafePlankaErrorMessage(err, 'cards/project field stamp'),
            spawned_card_rolled_back: rolledBack,
            ...requiresRollback,
            ...versionStampRollback,
          },
          502,
        );
      }
      throw err;
    }

    return jsonResponse(
      {
        card_id: cardId,
        board_id: project.planka_board_id,
        list_id: targetList.id,
        card_type: parsed.card_type,
        // What the parent↔child link ACTUALLY did, rather than leaving the
        // caller to infer it from the 201. `null` when no parent was requested.
        parent_card_id: parsed.parent_card_id ?? null,
        parent_link: linkResult,
        asset_id: parsed.asset_id ?? null,
        // What the requires link ACTUALLY did (`requested` / `linked` /
        // `already`). Null when `requires_card_ids` was omitted — so a caller
        // that sent it and reads null/absent knows the field was dropped.
        requires_link: requiresReport,
        // C1-46 — sha256 of the stored stamp (= the Metadata.version_stamp
        // pointer's sha256). Null when `version_stamp` was omitted.
        version_stamp_sha256: versionStamp?.sha256 ?? null,
        // fr#1338 — how many gherkin_scenarios entries had their
        // test_file_content stored in fr (card_scenario_evidence) instead of
        // Planka. 0 when none carried one.
        scenario_evidence_stored: scenarioSplit.evidence.length,
        // U11 — sha256 of the stored plan pin (= the Metadata.plan_pin
        // pointer's sha256). Null when `plan_pin` was omitted.
        plan_pin_sha256: planPin?.sha256 ?? null,
        // fr#1481 — present only when `deliverable_id` was sent.
        ...linkEcho(deliverableLink),
      },
      201,
    );
  } finally {
    if (heldLease) {
      await releaseCreateLeaseQuietly(
        leaseNamespace,
        heldLease.key,
        heldLease.owner,
      );
    }
  }
}
