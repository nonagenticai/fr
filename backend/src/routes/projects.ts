// src/routes/projects.ts
import { assertConveyorConfigured, conveyorNotConfiguredResponse } from '../lib/conveyor-configured-gate';
import { z } from 'zod';
import {
  db,
  projects,
  documents,
  departments,
  streams,
  repositories,
  projectRepositories,
  projectStakeholders,
} from '../db/client';
import { and, eq, inArray, count, sql as drizzleSql } from 'drizzle-orm';
import { ProjectCreateSchema, type ProjectCreate } from '../types/api';
import { renderConstraintsForBrief } from '../types/project-constraints';
import {
  prioritySetBy,
  recordPriorityChange,
  refuseInvalidCreatePriority,
} from '../lib/priority-change';
import {
  EVIDENCE_FIELD_PHRASE,
  hasScenarioEvidenceKey,
  SCENARIO_CODES,
  SCENARIO_REFUSAL_QA_NEEDS_INFO,
} from '../services/gherkin-scenarios';
import { validateAuth, validateAuthWithToken } from '../middleware/auth';
// fr#1508: a separate statement, placed away from the project-live-status import
// below, which the taxonomy PRs (fr#1495/#1497) also edit; avoids a textual conflict.
import { assertGlobalAndonReleased } from '../lib/global-andon-gate';
import {
  loadTenantScopedProject,
  loadProjectForRead,
  tenantScopedProjectFilter,
  licenceProjectScope,
  projectWriteSelfScope,
  projectArchivableByTenantMember,
  isSuperAdminSwitchedView,
  isSuperAdminHomeView,
  projectReadableAsGetProjectFilter,
} from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { isUuidShape } from '../lib/uuid-shape';
import { deriveRepositoryNameFromUrl, resolveRepositoryName } from '../lib/repository-name';
import { loadProjectRepositories, loadRepositoriesForProjects } from '../services/project-repositories';
import {
  FR_REPO_SENTINEL,
  platformRepoRefusalBody,
} from './project-request-repo-gate';
import { classifyProvisionFailure, clientSafeProvisionFailure } from '../lib/provision-failure';
import { slugContainerName } from '../lib/container-name';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  ValidationError,
  clientSafePlankaErrorMessage,
  pgErrorCode,
} from '../utils/errors';
import { jsonResponse, createdResponse, noContentResponse } from '../utils/response';
import { plankaAsAgent } from '../services/planka/with-auth';
import { createProjectWithDefaultBoard, discardPlankaProjectOfFailedCreate, type IntakeResult } from '../services/planka/intake';
import { assertBoardLinkable, linkBoardInRm, linkBoardThenStartConveyor } from '../services/rm-board-link';
import { PlankaError } from '../services/planka/errors';
import {
  provisionRepository as provisionRepositorySpine,
  initializeGraph as initializeGraphSpine,
  analyzeCodebase as analyzeCodebaseSpine,
} from '../integrations/coding';
import {
  clientSafeCaughtErrorText,
  clientSafeIntegrationErrorMessage,
  isIntegrationError,
  shouldRedactUpstreamDetailForCaller,
} from '../integrations/_lib/errors';
import type { GithubGitHubRepoRequest } from '@fr/service-client-coding';
import { EXECUTION_TENANT_ID } from './tenants';
import { canonicalTenantName } from '../middleware/internal-tenant-only';
import { getTenantIsServiceAccountSubject } from '../integrations/_lib/context';
import { reportConveyorRefusal } from '../lib/conveyor-refusal-metrics';
import { bulkBindAssets, findForeignAssets } from './assets/bindings';
import { isValidUuid } from '../utils/tenant';
import { projectIsLive, projectIsNotPreApproval, projectIsVisible } from '../lib/project-live-status';
import { deliveryFromRm } from '../services/project-delivered';
import { BUG_HUNT_FLAG_PROJECT_TYPES, isBugHuntFlagProjectType } from '../lib/bug-hunt-project-types';
import {
  templateRequiredForCreate,
  templateStartProjectData,
  outlineClosedGatePhase,
  type ProjectStartTemplate,
} from '../lib/project-start-template';
import { isFixtureOrigin, resolveSignoffStakeholderIds } from '../lib/execution-signoff';
import { findDefaultAgentMemberId } from '../domain/engagement/agent-members';
import { isTenantMemberForDecision } from '../services/tenant-member-recipients';
import { validateWebhookSecret } from './webhooks';
import { nextGate, railNodes } from '../lib/project-phase';
import {
  ensureRmProjectForFrProject,
  freshProjectState,
  getProjectBriefVersion,
  listProjectBriefVersions,
  projectCapabilities,
  phasesOfState,
  projectStatesFor,
  projectTypeAndPhase,
  type ProjectStateOrError,
} from '../services/catalogue/project-state';
import { frIntakeFieldsFromRm, frKeptProjectData, rmIntakeOfCreate, RM_ONLY_PROJECT_DATA_KEYS, type FrCreateRmIntake } from '../services/catalogue/project-intake';
import { extractTargetLanguage, needsTargetLanguage, requestTextOf } from '../services/catalogue/target-language';
import { resolveRepositoryPins } from '../services/repository-pins';
import {
  isStartableProjectType,
  projectTypes as catalogueProjectTypes,
  SETUP_PHASE,
  type CatalogueProjectType,
} from '../services/catalogue/tenant-catalogue';
import {
  legacyPriorityText,
  resolveTenantPriority,
} from '../services/catalogue/priority-levels';
import { boardSpecFor } from '../services/catalogue/board-template';
import { loadPlanForRail, planNextGate, planRailNodes } from '../lib/plan-phase-exit';
import { recordPhaseGateReport } from '../services/phase-gate-report';
import {
  archiveProjectRow,
  archiveProjectWithPurge,
  teardownProjectPlankaResources,
} from '../services/project-archive';

// shouldOrchestrateProjectStart moved VERBATIM to lib/project-orchestration.ts
// (fr#1476 / U-PS-ENTRY) so the AG-UI create path can apply the SAME gate
// without importing this route module. Re-exported here so every existing
// importer (routes, tests, the frontend mirror's comments) keeps its path.
import { shouldOrchestrateProjectStart } from '../lib/project-orchestration';
export { shouldOrchestrateProjectStart };

/**
 * How many repositories a create body names: the primary plus every
 * `repo.additional` entry. The primary is counted unconditionally because
 * `repository_url` / `repo.primary.url` is what every existing caller sends;
 * a body with neither still reads as 1 and therefore never derives
 * 'multi_repo', which is the correct answer for a repo-less project.
 */
function projectRepoCount(v: Pick<ProjectCreate, 'repo'>): number {
  return 1 + (v.repo?.additional?.length ?? 0);
}

/**
 * `scope_level` is no longer asked for at the door (the coherence refines in
 * types/api.ts were removed — see the tombstone there). It is DERIVED:
 *
 *     explicit ?? (repoCount >= 2 ? 'multi_repo' : undefined)
 *
 * ⭐ THE `??` IS THE POINT, NOT A CONVENIENCE. `scope_level` is a GRANULARITY
 * vocabulary (multi_repo / repo / app / module / component / file / class /
 * function) and granularity is ORTHOGONAL to repository count. A caller that
 * explicitly says `module` with three repos KEEPS `module`; making the
 * derivation unconditional would overwrite a granularity the caller chose with
 * a fact that now travels in `repo_count` + `coordination_mode`.
 *
 * Measured before writing this: nothing in backend/src branches on the literal
 * `'multi_repo'`, so deriving it is safe in both directions.
 */
function deriveProjectScopeLevel(
  v: Pick<ProjectCreate, 'scope_level' | 'repo'>,
): ProjectCreate['scope_level'] | undefined {
  if (v.scope_level) return v.scope_level;
  return projectRepoCount(v) >= 2 ? 'multi_repo' : undefined;
}

// Authenticated user shape, derived from the auth middleware so the factored
// single-project creator can take it as a parameter without re-importing the
// User type.
type AuthUser = Awaited<ReturnType<typeof validateAuthWithToken>>['user'];

// Error raised inside `createSingleProject` for the cases that used to be
// early `jsonResponse(...)` returns in the handler. The single-project handler
// maps it back to that exact response; the bulk handler records it as a
// per-item failure and keeps going. `payload` is the original response body
// and `httpStatus` its status code, so single-project behaviour is unchanged.
export class ProjectCreateError extends Error {
  constructor(
    public readonly payload: Record<string, unknown>,
    public readonly httpStatus: number,
  ) {
    super(
      typeof payload.message === 'string'
        ? payload.message
        : 'project create failed',
    );
    this.name = 'ProjectCreateError';
  }
}

/**
 * Evidence PREFLIGHT for project create — the Planka chokepoint's own detector
 * (`hasScenarioEvidenceKey`, `allowOnEntries: false`, exactly what
 * `assertPlankaCardBodyCarriesNoEvidence` runs) over `problem_statement`, which
 * still reaches Planka as the board project's description when no
 * `description` is given. Called before any Planka/secrets/DB write, so a
 * refusal leaves nothing behind. Same 400 + code + details shape as the kanban
 * routes' `assertDescriptionScenarios`. (fr creates NO card on project create —
 * George 2026-10-12, fr is a facilitator; v4 R80/R81: n8n's
 * `trigger.conveyor_start` creates the first card.)
 */
function assertProjectCreateCarriesNoEvidence(validated: ProjectCreate): void {
  if (hasScenarioEvidenceKey(validated.problem_statement, { allowOnEntries: false })) {
    throw new AppError(
      400,
      'project create: the problem statement carries repro evidence ' +
        `(${EVIDENCE_FIELD_PHRASE}); repro evidence is stored in fr only and is never sent to Planka. ` +
        'Refused, nothing written',
      { issues: [], qa_needs_info: SCENARIO_REFUSAL_QA_NEEDS_INFO },
    ).withCode(SCENARIO_CODES.evidenceOutsideDocument);
  }
}

// Factored single-project creator. Holds everything the original
// `handleCreateProject` did between body-parse and the final response:
// tenant-isolation gate → Planka board/lists (NO card) → secrets-service
// token store → atomic FR project + repo rows + the RM POST → the RM board
// link, then the conveyor start webhook (n8n creates the first card). Throws
// `ProjectCreateError` for the mapped early-return cases and `BadRequestError`
// for the target_packages guard. (`handleCreateProjectsBulk`, the N-times
// fan-out caller, was deleted in fr-agui P4d-2a — George 2026-10-17, zero callers.)
// `extraProjectData` is shallow-merged into `project_data` JSONB — the CP→fr
// bridge approve path (routes/project-requests.ts) uses it to stamp
// `external_origin` (CP provenance + the project_request id) onto the promoted
// project for bidirectional traceability. Omitted by the create caller.
// ── project-definition scope fields, delivered into both agent briefs ───────
//
// `in_scope`, `out_of_scope`, `high_level_requirements` and `assumptions` are
// accepted by ProjectCreateSchema and persisted into `project_data` via the
// `...extendedFields` rest-destructure. Until this helper existed an exhaustive
// grep of backend/src found ZERO readers for all four: the user typed the
// scope of the work and no brief, card or agent ever saw it — the same defect
// `constraints` / `dependencies` / `risks` carried before they were delivered.
//
// ⚠️ A KEY IS OMITTED WHEN THERE IS NOTHING TO SAY, and that is deliberate.
// `"out_of_scope": []` is a positive statement — "the requester was asked and
// said nothing is out of scope" — which is a DIFFERENT and false claim from
// "the requester did not answer". The existing array keys here (`constraints`,
// `acceptance_criteria`, …) emit `[]` because live n8n consumers already
// destructure them and an absent key would break those consumers; these four
// have no consumer yet, so they start honest. Same reason `renderConstraints-
// ForBrief` returns null rather than '' for an empty list.
//
// Non-string entries are dropped rather than coerced: `project_data` is jsonb
// and nothing guarantees a legacy row holds string[]. Blank/whitespace entries
// are dropped for the same reason `renderConstraintsForBrief` trims them — a
// list of empty strings has nothing in it to tell an agent.
export const BRIEF_SCOPE_FIELDS = [
  'in_scope',
  'out_of_scope',
  'high_level_requirements',
  'assumptions',
] as const;

// The union (not plain `Record<string, unknown>`) is so BOTH callers pass
// without a cast: the push brief hands it the zod-parsed `ProjectCreate`, the
// pull brief hands it the raw `project_data` jsonb record.
export function scopeFieldsForBrief(
  src: Record<string, unknown> | ProjectCreate | undefined | null,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!src) return out;
  for (const key of BRIEF_SCOPE_FIELDS) {
    const raw = (src as Record<string, unknown>)[key];
    if (!Array.isArray(raw)) continue;
    const items = raw
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (items.length > 0) out[key] = items;
  }
  return out;
}

// Project type → owning tenant, and the ONE creatability rule shared with the type picker:
// `lib/project-type-tenant.ts`. Re-exported below so every existing importer keeps its path.
import {
  PROJECT_TYPE_TENANT,
  projectTypeCreatableOn,
  projectTypeTenant,
} from '../lib/project-type-tenant';

export { PROJECT_TYPE_TENANT, projectTypeCreatableOn, projectTypeTenant } from '../lib/project-type-tenant';
export { SYSTEM_OPS_PROJECT_TYPE } from '../lib/project-type-tenant';

/**
 * Enforce the project type → tenant map before any Planka / secrets / DB write.
 * Throws ProjectCreateError → 400 `project_type_tenant_mismatch` when
 * `projectTypeCreatableOn` is false, i.e.:
 *   * any project is created on SYSTEM whose mapped type it is not (execution
 *     types, unmapped types, or no type);
 *   * an execution type is therefore refused on …0001, and
 *     accepted on EXECUTION or a customer tenant (the customer's own program/it).
 * Unmapped types on EXECUTION / a customer tenant are unaffected.
 */
export function assertProjectTypeTenant(
  projectType: string | undefined,
  activeTenantId: string,
): void {
  if (projectTypeCreatableOn(projectType, activeTenantId)) return;
  const expected = projectTypeTenant(projectType);
  const allowedHere = Object.entries(PROJECT_TYPE_TENANT)
    .filter(([, t]) => t === activeTenantId)
    .map(([k]) => k);
  throw new ProjectCreateError(
    {
      error: 'project_type_tenant_mismatch',
      message:
        `project_type "${projectType ?? '(none)'}" may not be created on tenant ` +
        `${activeTenantId} (${canonicalTenantName(activeTenantId) ?? 'unknown'}); ` +
        (expected !== undefined
          ? `it belongs to tenant ${expected} (${canonicalTenantName(expected) ?? 'unknown'})` +
            (expected === EXECUTION_TENANT_ID ? ' or a customer tenant' : '')
          : `this tenant accepts ${allowedHere.length ? allowedHere.join(', ') : 'no projects'}`) +
        '. Switch workspace and retry.',
      project_type: projectType ?? null,
      expected_tenant_id: expected ?? null,
      active_tenant_id: activeTenantId,
    },
    400,
  );
}

const PROJECT_TYPE_UNKNOWN = 'project_type_unknown';

/**
 * Refuse a create the owning tenant's requirements_management catalogue cannot
 * start — BEFORE any write, so the answer is the input contract and nothing has
 * been created:
 *   * no type / empty string ⇒ 422 `project_type_required` (RM creates every
 *     project with its type; v4). There is no untyped create.
 *   * a name the tenant does not define ⇒ 422 `project_type_unknown`, carrying
 *     the tenant's own list in `allowed` so the caller can correct it.
 *   * a type RM has RETIRED (`retired_at` set) ⇒ 422 `project_type_retired`,
 *     checked BEFORE `not_startable`: a retired type is refused whatever its
 *     phase list says, and the message has to name the real reason.
 *   * a type whose phase list does not start with `setup` ⇒ 422
 *     `project_type_not_startable`, carrying the startable names in `allowed`.
 * A tenant with no catalogue throws CatalogueNotInitialised (409
 * `catalogue_not_initialised`) — there is no fallback list. Returns the matched
 * RM type.
 */
/** RM's code (mirrored, fail-fast): a project is created with its project type. */
const PROJECT_TYPE_REQUIRED = 'project_type_required';
/** RM retired the type: it still exists in the catalogue but nothing may start one. */
const PROJECT_TYPE_RETIRED = 'project_type_retired';
/** A type whose RM phase list does not start with `setup` (v4: not startable). */
const PROJECT_TYPE_NOT_STARTABLE = 'project_type_not_startable';

async function assertProjectTypeInCatalogue(
  projectType: string | undefined,
  ownerTenantId: string,
): Promise<CatalogueProjectType> {
  // requirements_management REQUIRES project_type_id on POST /pm/projects (v4,
  // 422 project_type_required), and the RM POST is the create's last step — so
  // the same input-contract refusal is answered here, before any write.
  if (projectType === undefined || projectType === '') {
    throw new ProjectCreateError(
      {
        error: PROJECT_TYPE_REQUIRED,
        message: 'project_type is required: requirements_management creates every project with its project type',
        tenant_id: ownerTenantId,
      },
      422,
    );
  }
  const types = await catalogueProjectTypes(ownerTenantId);
  const hit = types.find((t) => t.name === projectType);
  // "Allowed" means allowed HERE: a type pinned to another tenant (kata in the conveyor
  // workspace) is never offered by the picker, so it must not be listed as an option in a
  // refusal either — the same predicate the picker publishes as `startable`.
  const allowedHere = types
    .filter((t) => isStartableProjectType(t) && projectTypeCreatableOn(t.name, ownerTenantId))
    .map((t) => t.name);
  // RM's retirement is checked FIRST: a retired type must be refused even when
  // its phase list would otherwise look startable, and "retired" is the reason
  // the caller needs to hear — not a missing `setup` phase.
  if (hit?.retired_at) {
    throw new ProjectCreateError(
      {
        error: PROJECT_TYPE_RETIRED,
        message: `project_type "${projectType}" is retired and cannot start a project`,
        project_type: projectType,
        tenant_id: ownerTenantId,
        allowed: allowedHere,
      },
      422,
    );
  }
  if (hit && isStartableProjectType(hit)) return hit;
  if (hit) {
    // v4 (George 2026-10-13): RM creates every project in phase `setup` and
    // refuses a type without one (409 project_type_missing_setup_phase); v4
    // scope is the IT kinds. Same input contract, answered before any write.
    throw new ProjectCreateError(
      {
        error: PROJECT_TYPE_NOT_STARTABLE,
        message: `project_type "${projectType}" cannot start a project: its requirements_management phase list does not start with "${SETUP_PHASE}"`,
        project_type: projectType,
        tenant_id: ownerTenantId,
        allowed: allowedHere,
      },
      422,
    );
  }
  throw new ProjectCreateError(
    {
      error: PROJECT_TYPE_UNKNOWN,
      message: `project_type "${projectType}" is not a project type of tenant ${ownerTenantId}`,
      project_type: projectType,
      tenant_id: ownerTenantId,
      allowed: types.map((t) => t.name),
    },
    422,
  );
}

// (assertSystemOpsCreator is GONE — v4: `system_ops` has no `setup` phase, so
// it cannot start a project; POST /api/projects answers 422
// project_type_not_startable.)

// (IMPROVEMENT_PROJECT_KIND / isImprovementProjectType /
// assertImprovementProjectCreator are GONE with the adopt path — v4: those
// types cannot start a project.)

/**
 * A Keycloak service account's `sub` is a caller identity, never a tenant
 * (TENANCY_AND_IMPROVEMENT.md §2.4). Refuse a create whose tenant is one.
 */
function assertTenantIsNotServiceAccountSubject(): void {
  if (!getTenantIsServiceAccountSubject()) return;
  throw new ProjectCreateError(
    {
      error: 'service_account_subject_not_a_tenant',
      message:
        'the token is a service account with no tenant_id claim, so its sub ' +
        'would be used as a tenant id; authenticate as the tenant this call ' +
        'acts for instead (e.g. a tenant licence token)',
    },
    403,
  );
}

// A ref coding-containers treats as a commit sha. ⛔ This MIRRORS
// coding-containers src/core/kubernetes_container_provisioner.py:379 `_GIT_SHA_RE`
// and MUST stay byte-identical: a ref matching it is FULL-cloned (not
// `--depth 1`), which exposes the repo's whole history — for a grading fixture
// like ems that is the seeded defects in `git log -p`. That covers short shas
// AND all-hex branch names, not only 40-hex. Pinned by it-intake-guard.test.ts.
export const GIT_SHA_LIKE_REF_RE = /^[0-9a-fA-F]{7,40}$/;

// Every branch a create body can carry: top-level `branch`, `repo.primary.branch`
// and each `repo.additional[].branch` (the form sends the first two).
function createBodyBranches(
  validated: Pick<ProjectCreate, 'branch' | 'repo'>,
): string[] {
  const out: string[] = [];
  if (typeof validated.branch === 'string') out.push(validated.branch);
  const primary = validated.repo?.primary?.branch;
  if (typeof primary === 'string') out.push(primary);
  for (const extra of validated.repo?.additional ?? []) {
    if (typeof extra.branch === 'string') out.push(extra.branch);
  }
  return out;
}

/**
 * The create body's primary repository url, or `undefined` when it names none
 * (George 2026-10-13, migration 190: a repository is OPTIONAL). Same precedence
 * every create door uses — `repo.primary.url`, then `repository_url` — with a
 * blank/whitespace value read as "no repo", never stored as ''.
 */
export function projectCreateRepoUrl(
  validated: Pick<ProjectCreate, 'repo' | 'repository_url'>,
): string | undefined {
  const url = validated.repo?.primary?.url || validated.repository_url;
  return typeof url === 'string' && url.trim().length > 0 ? url : undefined;
}

/**
 * The repository-dependent features that CANNOT run without a repository, as
 * one pure gate (before any write). A bug hunt runs a repo's test suite and
 * opens a fix PR on it; a CVE sweep upgrades a repo's dependencies. Every other
 * repo-dependent step treats "no repo" as NOT APPLICABLE instead of refusing.
 * 422 `repository_required_for_<feature>`.
 */
export function assertRepositoryForRepoFeatures(
  validated: Pick<ProjectCreate, 'repo' | 'repository_url' | 'bug_hunt' | 'cve_sweep'>,
): void {
  // The CP placeholder means "fill this in": refused when PROVIDED, at every
  // create door (omitting the repository is fine).
  if (validated.repository_url === FR_REPO_SENTINEL || validated.repo?.primary?.url === FR_REPO_SENTINEL) {
    throw new ValidationError(
      'repository_url is still the CP placeholder — set a real repository, or omit repository_url for a project without one',
      { code: 'repository_url_required' },
    );
  }
  if (projectCreateRepoUrl(validated) !== undefined) return;
  if (validated.bug_hunt === true) {
    throw new ValidationError(
      'repository_required_for_bug_hunt: a bug hunt runs a repository\'s test suite and opens a fix PR on it — set repository_url',
      { code: 'repository_required_for_bug_hunt' },
    );
  }
  if (validated.cve_sweep === true) {
    throw new ValidationError(
      'repository_required_for_cve_sweep: a CVE sweep upgrades a repository\'s dependencies — set repository_url',
      { code: 'repository_required_for_cve_sweep' },
    );
  }
}

// EXEC-tenant `it` intake guard, extracted so it is unit-testable without the
// full create harness. The dependency-upgrade flow needs an explicit
// `target_packages` list (or `cve_sweep=true` discovery mode). The remediation
// flows carry their OWN inputs instead, so `target_packages` does not apply:
//   - it_flow="bug"      → bug_test_command / failing_test_ref / target_files
//   - it_flow="security" → min_severity
// Requiring target_packages for these structurally blocked Flow 2/3 at intake
// (the reason the live bug/security capstones were never driven). Non-`it` /
// non-EXEC projects are a no-op here — EXCEPT bug_hunt, which is refused there.
//   - it_flow="bug" + bug_hunt=true → test_command (suite), NO bug_test_command
export function assertItExecIntakeInputs(
  validated: Pick<
    ProjectCreate,
    | 'project_type'
    | 'it_flow'
    | 'target_packages'
    | 'cve_sweep'
    | 'bug_test_command'
    | 'bug_hunt'
    | 'test_command'
    | 'branch'
    | 'repo'
    | 'fixture'
    | 'requestor'
  >,
  activeTenantId: string,
): void {
  // bug_hunt is EXEC-only and only on a bug-hunt project type: RM's `bug_hunt_fix`,
  // or the LEGACY fr `it` (lib/bug-hunt-project-types.ts). Checked BEFORE the early
  // return below, which would otherwise silently skip every hunt rule for a customer
  // tenant (and, for `bug_hunt_fix`, for every tenant).
  if (
    validated.bug_hunt === true &&
    (!isBugHuntFlagProjectType(validated.project_type) || activeTenantId !== EXECUTION_TENANT_ID)
  ) {
    throw new BadRequestError(
      'bug_hunt_exec_only: bug_hunt is only allowed on project_type="bug_hunt_fix" (or legacy "it") projects on the EXEC tenant',
    ).withCode('bug_hunt_exec_only');
  }
  // The hunt rules apply to every hunt type, so they run BEFORE the `it`-only return.
  if (validated.bug_hunt === true) {
    assertBugHuntIntakeInputs(validated);
    return;
  }
  if (
    // legacy (pre-RM) project type
    validated.project_type !== 'it' ||
    activeTenantId !== EXECUTION_TENANT_ID
  ) {
    return;
  }
  // A remediation flow carries its OWN inputs (target_files / test_command for
  // refactor; severity+scan for security; a repro for bug) and therefore must not
  // be held to the dependency-upgrade `target_packages` requirement below.
  const isRemediationFlow =
    validated.it_flow === 'bug' ||
    validated.it_flow === 'security' ||
    validated.it_flow === 'source-security' ||
    validated.it_flow === 'iac' ||
    validated.it_flow === 'refactor' ||
    // A rewrite carries its own inputs (source/target repositories, language);
    // RM, not fr, judges whether they form a valid rewrite.
    validated.it_flow === 'rewrite';
  if (!isRemediationFlow) {
    const hasTargets =
      !!validated.target_packages && validated.target_packages.length > 0;
    if (!validated.cve_sweep && !hasTargets) {
      throw new BadRequestError(
        'target_packages must be a non-empty array for project_type="it" dependency upgrades on the EXEC tenant (or set cve_sweep=true to run a discovery CVE sweep; bug/security remediation flows carry their own inputs)',
      );
    }
  }
  if (
    validated.it_flow === 'bug' &&
    !(
      Array.isArray(validated.bug_test_command) &&
      validated.bug_test_command.length > 0
    )
  ) {
    throw new BadRequestError(
      'bug_test_command (argv array of the currently-failing test) is required for project_type="it" it_flow="bug" on the EXEC tenant',
    );
  }
}

// HUNT-mode inputs (it_flow='bug' with no known failing test), shared by every hunt type.
function assertBugHuntIntakeInputs(
  validated: Pick<
    ProjectCreate,
    'it_flow' | 'bug_test_command' | 'test_command' | 'branch' | 'repo' | 'fixture' | 'requestor'
  >,
): void {
  // HUNT mode of it_flow='bug': no failing test is known yet (finding one is
  // the hunt's OUTPUT), so the hunt runs the repo's ordinary suite command.
  if (validated.it_flow !== 'bug') {
    throw new BadRequestError(
      'bug_hunt_requires_bug_flow: bug_hunt=true requires it_flow="bug"',
    ).withCode('bug_hunt_requires_bug_flow');
  }
  const hasSuiteCommand =
    Array.isArray(validated.test_command) &&
    validated.test_command.some((a) => typeof a === 'string' && a.trim().length > 0);
  if (!hasSuiteCommand) {
    throw new BadRequestError(
      "bug_hunt_requires_test_command: test_command (argv array of the repo's test suite command; it need not fail) is required when bug_hunt=true",
    ).withCode('bug_hunt_requires_test_command');
  }
  // ANY sent bug_test_command, even [], is refused: downstream a project-level
  // bug_test_command is read as "the failing test", which a hunt does not have.
  if (validated.bug_test_command !== undefined) {
    throw new BadRequestError(
      'bug_test_command_not_allowed_for_hunt: a bug hunt has no known failing test; send test_command instead',
    ).withCode('bug_test_command_not_allowed_for_hunt');
  }
  // A fixture-origin project never gets a human sign-off minted
  // (execution-approvals.ts isFixtureOrigin), so the hunt's single
  // bug_fix_authorization would never appear. No boardId exists yet.
  if (
    isFixtureOrigin({
      projectData: { fixture: validated.fixture, requestor: validated.requestor },
    })
  ) {
    throw new BadRequestError(
      'bug_hunt_fixture_forbidden: a bug hunt project must not be fixture-origin (fixture=true or a fixture requestor); its approval would never be minted',
    ).withCode('bug_hunt_fixture_forbidden');
  }
  const shaLike = createBodyBranches(validated).find((b) => GIT_SHA_LIKE_REF_RE.test(b));
  if (shaLike !== undefined) {
    throw new BadRequestError(
      `bug_hunt_branch_must_be_name: branch "${shaLike}" looks like a commit sha; a bug hunt must name a branch (a sha-like ref is full-cloned, exposing history)`,
    ).withCode('bug_hunt_branch_must_be_name');
  }
}

// The Planka teardown moved to `services/project-archive.ts` alongside
// `archiveProjectWithPurge` (the single sanctioned archive path, shared with the
// admin-console surface). Re-exported here so existing importers keep their
// import path.
export { teardownProjectPlankaResources };

// Bug-hunt duplicate guard — REFUSE, never supersede (deliberately unlike
// cve_sweep below). A hunt project in flight IS run evidence, so auto-archiving
// it would destroy a run; retiring an old hunt is an explicit operator archive.
// Same (repository_url, keycloak_tenant_id) match shape as
// supersedePriorCveSweepProjects. This check-then-insert is NOT race-safe on its
// own: migration 163's partial unique index `BUG_HUNT_UNIQUE_INDEX` (predicate now 189's) is the
// backstop, mapped to the same 409 in createProjectCore's insert transaction.
export const BUG_HUNT_UNIQUE_INDEX = 'projects_one_live_bug_hunt_per_repo_idx';

function bugHuntProjectExistsError(existingProjectId: string | undefined): ProjectCreateError {
  return new ProjectCreateError(
    {
      error: 'bug_hunt_project_exists',
      message:
        'a live (non-archived) bug_hunt project already exists for this repository in this tenant; archive it before creating another',
      ...(existingProjectId ? { existing_project_id: existingProjectId } : {}),
    },
    409,
  );
}

export async function assertNoLiveBugHuntProject(params: {
  repositoryUrl: string;
  tenantId: string;
}): Promise<void> {
  const { repositoryUrl, tenantId } = params;
  if (!repositoryUrl || repositoryUrl.trim().length === 0) return;
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.repository_url, repositoryUrl),
        // Every hunt type (RM `bug_hunt_fix` + legacy `it`) — migration 189's predicate.
        inArray(projects.project_type, [...BUG_HUNT_FLAG_PROJECT_TYPES]),
        // Live = not archived AND not a request's pre-approval row (pending /
        // cancelled) — the same list migration 164's partial index uses.
        projectIsLive(),
        drizzleSql`${projects.project_data}->>'bug_hunt' = 'true'`,
        drizzleSql`${projects.project_data}->>'keycloak_tenant_id' = ${tenantId}`,
      ),
    )
    .limit(1);
  if (existing) throw bugHuntProjectExistsError(existing.id);
}

// True only for a unique violation on BUG_HUNT_UNIQUE_INDEX. Drizzle wraps the
// postgres.js error, so the constraint_name may sit on `err` or `err.cause`;
// a 23505 on any OTHER constraint is not ours and is rethrown by the caller.
export function isBugHuntUniqueViolation(err: unknown): boolean {
  if (pgErrorCode(err) !== '23505') return false;
  for (const candidate of [err, (err as { cause?: unknown })?.cause]) {
    const e = candidate as { code?: unknown; constraint_name?: unknown } | null;
    if (e?.code === '23505' && e.constraint_name === BUG_HUNT_UNIQUE_INDEX) return true;
  }
  return false;
}

// CVE-sweep re-drive supersession — the root-cause fix for board pile-up.
// A cve_sweep `it` project re-driven for the SAME repo used to create a brand-
// new Planka project+board every run (the single-POST create path has no find-
// or-create, and nothing tears the board down on closure), so identical
// "CVE sweep — <repo>" boards accumulated indefinitely (17 duplicate
// worker_management boards observed live). Before a new sweep drive creates its
// board, archive + tear down any prior NON-archived cve_sweep project for the
// same (repository_url, keycloak_tenant_id) so at most ONE live sweep board
// exists per repo. Matched WITHIN the same tenant (project_data.keycloak_tenant_id),
// so a customer re-drive only supersedes their own prior sweep — never crosses
// tenants. Best-effort teardown: a Planka failure is logged, not raised, and the
// new drive proceeds. Returns the number of prior projects superseded.
// Extracted (like assertItExecIntakeInputs) so it is unit-testable against the
// DB without the full Planka/secrets create harness.
export async function supersedePriorCveSweepProjects(params: {
  repositoryUrl: string;
  tenantId: string;
}): Promise<number> {
  const { repositoryUrl, tenantId } = params;
  if (!repositoryUrl || repositoryUrl.trim().length === 0) return 0;
  const priors = await db
    .select({
      id: projects.id,
      planka_board_id: projects.planka_board_id,
      planka_project_id: projects.planka_project_id,
      // Carries keycloak_tenant_id — the archive closes linked PM rows under it.
      project_data: projects.project_data,
    })
    .from(projects)
    .where(
      and(
        eq(projects.repository_url, repositoryUrl),
        // legacy (pre-RM) project type
        eq(projects.project_type, 'it'),
        // Never supersede a request's pending/cancelled pre-approval row: it has
        // no board to tear down and is not a live sweep.
        projectIsLive(),
        drizzleSql`${projects.project_data}->>'cve_sweep' = 'true'`,
        drizzleSql`${projects.project_data}->>'keycloak_tenant_id' = ${tenantId}`,
      ),
    );
  if (priors.length === 0) return 0;

  // HIPAA right-to-delete on the BULK archive surface.
  //
  // This used to bulk-`UPDATE ... SET status='archived'` unconditionally, with no
  // purge. That was a live, user-triggerable ePHI bypass: documents CAN be attached
  // to a cve_sweep project (POST /api/documents gates only on
  // loadTenantScopedProject — there is no project_type exclusion), archiving is a
  // soft UPDATE so the documents.project_id ON DELETE RESTRICT FK (migration 090)
  // never fires, and handleListProjects hides archived rows. Net effect: the PHI
  // survived downstream AND went invisible in fr.
  //
  // The fix is TARGETED on purpose. Routing every supersede through the fail-closed
  // helper would make project CREATION fail whenever KAG is down — a supersede runs
  // inline inside createProjectCore — which is far too broad a blast radius for a
  // path whose priors almost never carry documents. So we split by the only thing
  // that actually matters:
  //
  //   * priors with ZERO documents  -> `archiveProjectRow`, which does the same
  //     archive MINUS the purge. No KAG call is made at all, so a KAG outage
  //     still cannot break project creation — that property is the whole reason
  //     this branch exists and it is preserved exactly.
  //     ⚠️ It is NOT the old bulk UPDATE any more (fr#1134). That bulk flip
  //     archived the prior WITHOUT voiding its pending approvals, so this was a
  //     second archive path carrying the defect the shared service had just been
  //     taught to close: the approvals vanished from the list query while their
  //     cards stayed BLOCKED forever. The void here is fail-closed for the same
  //     reason the purge is on the other branch — if voiding a prior's approvals
  //     throws, the supersede THROWS and project creation fails loudly, rather
  //     than archiving a project whose stuck approvals nobody can reach.
  //   * priors WITH documents       -> archiveProjectWithPurge, which purges each
  //     document's downstream PHI first and THROWS on failure. Creation fails
  //     loudly instead of silently orphaning PHI.
  const priorIds = priors.map((p) => p.id);
  const docRows = await db
    .select({ project_id: documents.project_id })
    .from(documents)
    .where(inArray(documents.project_id, priorIds));
  const idsWithDocuments = new Set(docRows.map((r) => r.project_id).filter((id): id is string => !!id));

  const withPhi = priors.filter((p) => idsWithDocuments.has(p.id));
  const withoutPhi = priors.filter((p) => !idsWithDocuments.has(p.id));

  // PHI-bearing priors FIRST, so a purge failure aborts before anything at all has
  // been archived — the whole supersede stays retryable rather than leaving a
  // half-archived set behind.
  for (const prior of withPhi) {
    try {
      // No human is behind a CVE-sweep supersede, so the void actor is the
      // machine path itself rather than a borrowed user id — `voided_by` is
      // free text and must say what actually withdrew the approval.
      await archiveProjectWithPurge(prior, {
        tenantId,
        actor: 'system:cve-sweep-supersede',
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot supersede prior CVE-sweep project ${prior.id} (repo ${repositoryUrl}, ` +
          `tenant ${tenantId}): it has uploaded document(s), and purging their ` +
          `downstream PHI from KAG failed, so archiving it would hide the project ` +
          `while its ePHI stayed live. Refusing to archive; NOTHING in this supersede ` +
          `was archived and the operation is safe to retry. Fix the KAG/ingestion ` +
          `outage and retry the create, or delete that project's documents explicitly ` +
          `via DELETE /api/documents/:id first. Underlying purge error: ${detail}`,
        { cause: err },
      );
    }
  }

  // Document-free priors: the SAME archive as above minus the purge, per prior.
  // Deliberately per-row rather than the old single bulk UPDATE — each prior's
  // pending approvals must be voided against that prior's id, which a bulk
  // `inArray` flip has no place to do. A throw propagates (fail-closed).
  for (const prior of withoutPhi) {
    await archiveProjectRow(prior, { actor: 'system:cve-sweep-supersede' });
  }

  console.log(
    `[projects.create] superseded ${priors.length} prior cve_sweep project(s) ` +
      `for repo ${repositoryUrl} (tenant ${tenantId}) — ` +
      `${withPhi.length} with documents (PHI purged), ${withoutPhi.length} without`,
  );
  return priors.length;
}

/**
 * The tenant that OWNS a new project's board, for the conveyor editor grant
 * (services/planka/conveyor-membership.ts — platform tenants only).
 *
 * ⛔ Strict tenant separation: it is the OWNER, never the decider. A promoted
 * project REQUEST carries `repoGateTenantId` = the request's own `tenant_id`;
 * a super-admin may decide a CUSTOMER request cross-tenant from a platform
 * workspace (approvals → onOutlineDecided → promoteProjectRequest), so the
 * caller's active tenant would wrongly grant the conveyor a customer board.
 * Present → that owner; `null`/empty (owner unknown) → `undefined`, which the
 * grant treats as not-platform (fail closed). Absent → the caller's active
 * tenant, which IS the owner on the direct-create and bulk roads.
 */
export function conveyorGrantTenantId(
  input: { repoGateTenantId?: string | null },
  activeTenantId: string | undefined,
): string | undefined {
  if ('repoGateTenantId' in input) return input.repoGateTenantId || undefined;
  return activeTenantId;
}

function preApprovalProjectNotPendingError(projectId: string, status: string | null) {
  return new ProjectCreateError(
    {
      error: 'pre_approval_project_not_pending',
      message:
        `project ${projectId} is ${status ? `'${status}'` : 'missing or no longer pending'}; ` +
        'only a pending pre-approval project can be promoted',
    },
    409,
  );
}

async function assertPreApprovalProjectPending(projectId: string): Promise<void> {
  const [row] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row || row.status !== 'pending') {
    throw preApprovalProjectNotPendingError(projectId, row?.status ?? null);
  }
}

interface CreateSingleProjectResult {
  project: typeof projects.$inferSelect;
  planka: IntakeResult;
}


/**
 * Get-or-create the RM pm_project of a new fr project (services/catalogue/
 * project-state.ts `ensureRmProjectForFrProject`: type, full intake, brief v1;
 * RM sets phase `setup`), THEN link it to the Planka board fr just built
 * (services/rm-board-link.ts `linkBoardInRm`, one attempt). Either failing
 * becomes the SAME ProjectCreateError `rm_project_link_failed` — 502 for an
 * outage, RM's own 4xx (e.g. 422 project_type_required, 409
 * planka_board_in_use) passed through. Callers run it LAST inside the fr row's
 * transaction, so a failure rolls the fr row back and tears the board down.
 * Returns RM's board answer: the only source of the row's board-id cache.
 */
async function linkRmProject(params: {
  projectId: string;
  tenantId: string;
  title: string;
  description: string | null;
  catalogueType: { id: string } | null;
  createdByUserId: string;
  /** The FULL fr intake + brief v1 (RM is its only store; the brief is always sent). */
  intake: FrCreateRmIntake;
  /** The Planka board fr built for the project (step 1). */
  board: { plankaProjectId: string | null; plankaBoardId: string; listIds: Readonly<Record<string, string>> };
}): Promise<{ rmPmProjectId: string; planka_board_id: string; planka_project_id: string | null }> {
  try {
    // Before the RM POST (RM refuses fr's DELETE): a board fr cannot link fails the create first.
    assertBoardLinkable(params.board);
    const { rmPmProjectId } = await ensureRmProjectForFrProject({
      projectId: params.projectId,
      tenantId: params.tenantId,
      title: params.title,
      description: params.description,
      projectTypeId: params.catalogueType?.id ?? null,
      createdByUserId: params.createdByUserId,
      intake: params.intake,
    });
    const board = await linkBoardInRm({ tenantId: params.tenantId, rmPmProjectId, ...params.board });
    return { rmPmProjectId, ...board };
  } catch (err) {
    console.error(`[projects.create] RM pm_project link failed for project ${params.projectId}:`, err);
    const upstream = isIntegrationError(err) ? err.upstreamStatus : undefined;
    const status = upstream !== undefined && upstream >= 400 && upstream < 500 && upstream !== 401 ? upstream : 502;
    throw new ProjectCreateError(
      {
        error: 'rm_project_link_failed',
        message:
          'the project could not be registered in requirements_management (which owns its type and phase); ' +
          'nothing was created — retry',
        ...(isIntegrationError(err) && upstream !== undefined && status !== 502
          ? { upstream_status: upstream, upstream_detail: (err.upstreamBody as { detail?: unknown } | undefined)?.detail ?? null }
          : {}),
      },
      status,
    );
  }
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * THE CREATE'S COMMIT (R345/R351): ONE transaction holding every fr write of the create
 * (`writeRow`: the row and its bindings) and, LAST, the RM POST + the RM board link
 * (`linkRmProject`) and the board-id cache written from RM's link answer. Any failure — an fr
 * write, RM refusing or unreachable, the board unlinkable — rolls the fr row back (a pre-approval
 * row stays `pending`) and tears the Planka project + board down (best effort, never throws), then
 * rethrows: RM's failures are `rm_project_link_failed`. A failed LINK after a successful POST leaves
 * the RM row without a board (RM refuses its DELETE): a retry of the same create GETs it by origin
 * (no second POST) and links the retry's board.
 */
export async function commitProjectAndLinkRm(input: {
  projectId: string;
  /** The Planka project + board step 1 built, and the board's list ids. */
  planka: { projectId: string; boardId: string; listIds: Readonly<Record<string, string>> };
  rm: Omit<Parameters<typeof linkRmProject>[0], 'projectId' | 'board'>;
  writeRow: (tx: DbTx) => Promise<typeof projects.$inferSelect>;
}): Promise<{ project: typeof projects.$inferSelect; rmLink: Awaited<ReturnType<typeof linkRmProject>> }> {
  try {
    return await db
      .transaction(async (tx) => {
        await input.writeRow(tx);
        const rmLink = await linkRmProject({
          ...input.rm,
          projectId: input.projectId,
          board: { plankaProjectId: input.planka.projectId, plankaBoardId: input.planka.boardId, listIds: input.planka.listIds },
        });
        const [cached] = await tx
          .update(projects)
          .set({ planka_board_id: rmLink.planka_board_id, planka_project_id: rmLink.planka_project_id })
          .where(eq(projects.id, input.projectId))
          .returning();
        if (!cached) throw new Error("Failed to cache RM's board link on the project row");
        return { project: cached, rmLink };
      })
      .catch((err: unknown) => {
        if (isBugHuntUniqueViolation(err)) throw bugHuntProjectExistsError(undefined);
        throw err;
      });
  } catch (err) {
    await discardPlankaProjectOfFailedCreate(plankaAsAgent(), { projectId: input.planka.projectId, boardId: input.planka.boardId });
    throw err;
  }
}

export async function createSingleProject(input: {
  validated: ProjectCreate;
  user: AuthUser;
  extraProjectData?: Record<string, unknown>;
  /**
   * The tenant that OWNS this creation, for the platform-repo ownership gate.
   * Omitted → the caller's active tenant. A promoted project REQUEST passes the
   * request's own `tenant_id`: the approver (e.g. an outline decided from a
   * platform workspace) is not whose repo set this is. `null` = unknown = the
   * gate refuses internal-owner repos (fail closed).
   */
  repoGateTenantId?: string | null;
  /**
   * A project request's pre-approval row (status `pending`, allocated at submit
   * — routes/project-request-lifecycle.ts allocatePreApprovalProject). When
   * given, that id IS the project id and step 4 UPDATEs the row pending →
   * active instead of inserting; refused (409) unless the row is `pending`.
   * Every side effect still runs exactly once. Omitted ⇒ unchanged behaviour.
   */
  existingProjectId?: string;
  /**
   * The id a NEW project is created under, chosen by the caller: POST
   * /api/projects's `Idempotency-Key` (a UUID, validated and checked for an
   * existing row by handleCreateProject). It is the RM pm_project's
   * origin_project_id, so a retry after an RM-accepted-but-fr-commit-failed
   * create reuses that RM row (get-or-create by origin) instead of orphaning it.
   * Ignored when `existingProjectId` is given. Omitted ⇒ a fresh random id.
   */
  newProjectId?: string;
  /**
   * U-PS-ROUTE / U-PS-ENTRY: the template this project starts from. Passed ONLY
   * by promoteProjectRequest, built from the approved outline version's stored
   * phase_plan — there is no body field for it, so a direct POST /api/projects
   * can never claim one. Set ⇒ the row is stamped template_id/hash (no phase:
   * n8n sets it in RM), start_mode='template' and the
   * outline approval as the contract close. Omitted ⇒ unchanged behaviour
   * (unless PROJECT_START_TEMPLATE_REQUIRED refuses an orchestrated EXEC create).
   */
  startTemplate?: ProjectStartTemplate;
  /**
   * false ⇒ the conveyor start webhook is NOT sent after the create (the RM board link still
   * runs; services/rm-board-link.ts `startConveyor`). Passed ONLY by the kata open
   * (services/katas/open.ts): fr creates a kata's first card itself. Omitted ⇒ unchanged.
   */
  startConveyor?: boolean;
}): Promise<CreateSingleProjectResult> {
  // ⛔ v4 wiring gate (George 2026-10-13): every create door funnels here
  // (AG-UI agent.create_project, bulk, request promotion), so this is the
  // backstop; the HTTP doors also refuse before their own side effects.
  assertConveyorConfigured();
  const { user } = input;
  // Reassigned by the intake resolution below (repository pins → sha; a rewrite's
  // target language → extracted from the request). Everything downstream reads this.
  let validated = input.validated;

  // Tenant gates (five-tenant ruling 2026-09-28), FIRST — pure, before the andon
  // read and any write: a service-account sub is never a tenant, and the
  // project type pins the tenant.
  const activeTenantId = ctxTenantId(user.tenantId);
  assertTenantIsNotServiceAccountSubject();
  // ⛔ THE OWNING TENANT (strict tenant separation, George 2026-09-30). A
  // promoted project REQUEST is created by whoever DECIDED it — e.g. a platform
  // super-admin deciding a customer's outline from their own workspace — but it
  // BELONGS to the request's tenant. ONE resolver (conveyorGrantTenantId):
  // `repoGateTenantId` absent ⇒ the active tenant (a caller creating their own
  // project, unchanged); present + non-empty ⇒ that tenant; present but
  // null/undefined/'' ⇒ unknown ⇒ REFUSED here, before anything is written.
  // An unknown owner never falls back to the decider — that fallback is the
  // cross-tenant stamp this closes. Every owner-scoped decision below (type
  // pin, orchestration, EXEC intake inputs, project_data.keycloak_tenant_id,
  // CVE supersede, the conveyor grant, the board's keycloak_tenant_id stamp)
  // uses `ownerTenantId`, never `activeTenantId`.
  const ownerTenantId = conveyorGrantTenantId(input, activeTenantId);
  if (!ownerTenantId) {
    throw new ProjectCreateError(
      {
        error: 'owning_tenant_unknown',
        message:
          'this creation names an owning tenant but its value is empty; refusing ' +
          "rather than creating the project under the deciding user's workspace",
      },
      422,
    );
  }
  assertProjectTypeTenant(validated.project_type, ownerTenantId);
  // The VOCABULARY: the type must be one of the OWNING tenant's RM project types
  // (never the decider's). After the pure tenancy gates, before any write.
  const catalogueType = await assertProjectTypeInCatalogue(validated.project_type, ownerTenantId);
  // ⛔ No phase is written here (George 2026-10-13): RM holds the project's
  // phase and n8n is its ONLY writer. fr's `project_phase` column is no longer
  // written by fr (its DB default stays until the follow-up drop).
  // ⛔ PLATFORM-REPO OWNERSHIP GATE (owner ruling 2026-09-30) — AFTER the
  // tenant gates (so a service-account sub still gets its own 403, not this
  // 422) and BEFORE the andon read and any write: only a platform tenant may put an
  // internal-owner (`nonagenticai`) repo into fr — public or not. Every url
  // this creation would store is checked: the primary (both spellings) and
  // every `repo.additional[]` entry.
  const repoGateRefusal = platformRepoRefusalBody(
    [
      validated.repository_url ?? '',
      validated.repo?.primary?.url ?? '',
      ...(validated.repo?.additional ?? []).map((a) => a.url ?? ''),
    ],
    'repoGateTenantId' in input ? input.repoGateTenantId : activeTenantId,
  );
  if (repoGateRefusal) throw new ProjectCreateError(repoGateRefusal, 422);

  // Global andon: creating a project fires the conveyor start webhook, which
  // starts the pipeline. Refuse new project work
  // while the cord is engaged (before any Planka/secrets side effects) so the
  // freeze can't be bypassed by creating fresh work.
  await assertGlobalAndonReleased();

  // A pre-approval row must still be `pending` BEFORE any Planka/secrets write
  // (the conditional UPDATE in step 4 is the race backstop).
  if (input.existingProjectId) {
    await assertPreApprovalProjectPending(input.existingProjectId);
  }

  // ── THE INTAKE RESOLUTION (George 2026-11-07) ─────────────────────────────
  // 1. A repository `pin` (a commit SHA or a PR) becomes the row's 40-hex `sha`, so
  //    RM's contract is unchanged and the rewrite flows keep reading `repositories[].sha`.
  //    A PR costs one GitHub read; a SHA costs none. Before every write.
  // 2. A rewrite created WITHOUT `language` has its target language extracted from the
  //    request (the form no longer asks for it). No answer ⇒ a named 422, never a
  //    guessed value; the worker being down is a 503.
  const resolvedRepo = await resolveRepositoryPins(validated.repo, { tenantId: ownerTenantId });
  validated = { ...validated, ...(resolvedRepo ? { repo: resolvedRepo } : {}) };
  if (needsTargetLanguage(validated)) {
    const targetLanguage = await extractTargetLanguage(
      requestTextOf(validated as Record<string, unknown>),
    );
    if (!targetLanguage) {
      throw new ProjectCreateError(
        {
          error: 'rewrite_language_not_stated',
          message:
            'this is a rewrite but its target language could not be found in the project request; ' +
            "name it there (e.g. 'rewrite the ingestion service in Rust')",
        },
        422,
      );
    }
    // It belongs on the BRIEF (George 2026-11-07): recorded with the rest of the request,
    // read by the rewrite flows as `brief.target_language`.
    validated = { ...validated, target_language: targetLanguage };
  }

  // Determine repository_url: from repo.primary.url or top-level field.
  // undefined = NO repository (George 2026-10-13, migration 190: optional) — the
  // row stores NULL and every repo-dependent step below treats it as not
  // applicable (gate, provisioning rows, CVE supersede, hunt guard, brief).
  const repoUrl = projectCreateRepoUrl(validated);
  const repoBranch = validated.repo?.primary?.branch || validated.branch;

  // Derived `scope_level` — the operator ruled it is no longer asked for. See
  // deriveProjectScopeLevel: the `??` is load-bearing (an explicit granularity
  // always wins) and the count it derives from is `projectRepoCount`.
  const derivedScopeLevel = deriveProjectScopeLevel(validated);

  // EXEC-tenant `it` projects drive the n8n project pipeline (project_start_
  // request_analysis → project_setup → development_chore → project_closure).
  // The first card carries github_url + target_packages, so target_packages is
  // mandatory here UNLESS cve_sweep=true (DISCOVERY mode: development_chore runs
  // upgradeCves to bump every dependency with a fixable CVE, so no explicit
  // target list is needed). Repository access is the GitHub App's (coding-github
  // resolve_github_token): there is no per-project token (George 2026-10-18).
  // Fail FAST on the remaining requirement before any Planka writes.
  // Feature projects join the SAME organic project-start pipeline as `it`
  // projects (n8n's trigger.conveyor_start creates the first card — fr creates
  // none). `it` keeps its extra target_packages guard below; `feature` carries no
  // package list — the orchestration decomposes from the problem/outcome brief.
  // See shouldOrchestrateProjectStart for the full gate (incl. customer
  // cve_sweep readiness — a non-EXEC `it`+cve_sweep project orchestrates).
  const isOrchestratedProject = shouldOrchestrateProjectStart({
    projectType: validated.project_type,
    cveSweep: validated.cve_sweep,
    tenantId: ownerTenantId,
    execTenantId: EXECUTION_TENANT_ID,
  });
  // U-PS-ENTRY (flag PROJECT_START_TEMPLATE_REQUIRED, default OFF): with the
  // flag on, an orchestrated EXEC project is born ONLY from a promoted request
  // whose approved outline carries a template — promote is the one entry path.
  // Before any Planka / secrets / DB write, so a refusal leaves nothing behind.
  if (
    templateRequiredForCreate({
      orchestrated: isOrchestratedProject,
      ownerTenantId,
      execTenantId: EXECUTION_TENANT_ID,
      hasTemplate: input.startTemplate !== undefined,
    })
  ) {
    throw new ProjectCreateError(
      {
        error: 'template_required',
        message:
          'an orchestrated EXEC project starts only from a project request whose approved ' +
          'outline carries a template (PROJECT_START_TEMPLATE_REQUIRED is on); submit a ' +
          'project request instead of creating the project directly',
        project_type: validated.project_type ?? null,
      },
      422,
    );
  }

  // Fail FAST on the EXEC-tenant `it` intake requirements before any Planka
  // writes (dependency flow needs target_packages; bug/security carry their own).
  assertItExecIntakeInputs(validated, ownerTenantId);
  // The two features that are MEANINGLESS without a repository refuse a
  // repo-less create (422 repository_required_for_<feature>); everything else
  // treats "no repo" as not applicable.
  assertRepositoryForRepoFeatures(validated);

  // Bug-hunt duplicate guard (409, refuse — never supersede) before any Planka
  // write. Race backstop: migration 163/189's unique index, mapped in step 4 below.
  if (isBugHuntFlagProjectType(validated.project_type) && validated.bug_hunt === true && repoUrl) {
    await assertNoLiveBugHuntProject({ repositoryUrl: repoUrl, tenantId: ownerTenantId });
  }

  // Repro-evidence PREFLIGHT — before ANY Planka/secrets/DB write (the cve
  // supersede below archives rows). See assertProjectCreateCarriesNoEvidence.
  assertProjectCreateCarriesNoEvidence(validated);

  // Build project_data JSONB with all extended fields (the dedicated-column ones
  // are destructured out below).
  const {
    name,
    repository_url,
    branch,
    project_type,
    scope_level,
    // A dedicated column (`projects.coordination_mode`, db/schema.ts), so it is
    // destructured OUT of extendedFields for the same reason `scope_level` is —
    // otherwise it is persisted twice and project_data can disagree with the row.
    coordination_mode,
    shape,
    bound_assets,
    // fr#1388 — split out so an explicit `null` ("unset") is never persisted:
    // the stored key is only ever absent or a QUESTION_MODES value.
    question_mode,
    ...extendedFields
  } = validated;
  // Persist the project's keycloak tenant on the row. Projects are not
  // department-assigned (dept_id stays null), so the dept→workspace chain
  // can't recover tenant scope downstream; POST /api/execution/approvals
  // reads project_data.keycloak_tenant_id as the authoritative tenant.
  // ownerTenantId is the workspace the project belongs to (also stamped on
  // the board's keycloak_tenant_id custom field) — NOT the deciding user's
  // active workspace on a promoted request.
  // A priority given at create is an effective change (unset → value): it is
  // audited ONCE inside the insert transaction below with the server-derived
  // provenance (`priority_set_by` on the audit row; never caller-settable).
  // The OWNER tenant's RM priority level (design Q3 = b): 400 invalid_priority
  // outside its levels. The level id goes to RM in the ONE create POST
  // (rmIntakeOfCreate priority_level_id); fr keeps NO priority copy in
  // project_data — readers ask RM (project-state.ts). The audit row stays fr's.
  const createLevel =
    validated.priority !== undefined
      ? (await resolveTenantPriority(ownerTenantId, validated.priority)).level
      : undefined;
  const createPriority = createLevel ? legacyPriorityText(createLevel) : undefined;
  const createSetBy = createPriority !== undefined ? prioritySetBy(user) : undefined;
  // ⛔ The intake, the brief and the priority are stored in RM ONLY (rm#213,
  // George 2026-10-13): project_data keeps just fr's own decision keys
  // (tenancy, the RM link, the bug-hunt / CVE-sweep / IT-flow / fixture gates —
  // services/catalogue/project-intake.ts says why each one stays).
  const projectData = {
    ...frKeptProjectData(extendedFields),
    keycloak_tenant_id: ownerTenantId,
    ...(input.extraProjectData ?? {}),
    // Server-built, written LAST so no body field or extraProjectData key can
    // forge a template start or its contract close.
    ...(input.startTemplate ? templateStartProjectData(input.startTemplate) : {}),
  };

  // 0. Tenant-isolation gate on the picked library scope (trigger/channel
  //    are checked against fr-local tables; see findForeignAssets). Runs
  //    before any Planka / secrets / DB write — a foreign asset id 400s
  //    here with nothing created.
  if (bound_assets && Object.keys(bound_assets).length > 0) {
    // Checked against the OWNING tenant: on a promoted customer request the
    // decider's (platform) assets must never bind into the customer project.
    const foreign = await findForeignAssets(bound_assets, ownerTenantId);
    if (foreign.length > 0) {
      const detail = foreign.map((f) => `${f.kind}:${f.id}`).join(', ');
      throw new ProjectCreateError(
        {
          error: 'bound_asset_not_in_tenant',
          message: `bound_assets references ids not in your tenant: ${detail}`,
        },
        400,
      );
    }
  }

  // The board = the OWNER tenant's RM board template for the project type
  // (else its `default` template) — 409 catalogue_not_initialised without one.
  // Read BEFORE any write (the RM link below is the first one).
  const boardSpec = await boardSpecFor(ownerTenantId, validated.project_type ?? null);

  // Pre-generate the project id: the RM pm_project's origin_project_id, and the
  // GitHub-token secret identifier (step 3), both reference it.
  const projectId = input.existingProjectId ?? input.newProjectId ?? crypto.randomUUID();

  // THE RM POST + BOARD LINK ARE THE LAST FALLIBLE STEPS (George 2026-10-13,
  // v4 D15/R16; R345/R351: RM enforces it — after create every fr-delegated
  // write to the pm_project but the board link is 403
  // project_writes_are_pm_only, so an RM row can be neither fixed up nor
  // deleted afterwards). Order: the Planka board (1) → the fr row and its
  // bindings, and INSIDE that same transaction, last, the ONE RM POST (project
  // type + full intake + brief v1), the board link, and the board-id cache
  // written from RM's link answer (4z). An RM refusal or outage on either
  // therefore rolls the fr row back and the board is torn down
  // (compensatePlanka). fr stores no RM id: readers resolve it from RM by
  // origin_project_id. RM sets the first phase (`setup`) itself.
  let rmLink: Awaited<ReturnType<typeof linkRmProject>> | null = null;
  let plankaCreated: { projectId: string; boardId: string } | null = null;
  let planka: Awaited<ReturnType<typeof createProjectWithDefaultBoard>>;
  let project: typeof projects.$inferSelect;
  try {

    // 0b. CVE-sweep re-drive supersession. Archive + tear down any prior live
    //     cve_sweep board for this same (repo, tenant) BEFORE creating this run's
    //     board, so identical "CVE sweep — <repo>" boards stop piling up. Scoped
    //     to cve_sweep `it` projects only — general project-create semantics are
    //     untouched.
    //     ⚠️ NOT best-effort any more (fr#1134): the Planka teardown itself is
    //     best-effort, but the void-pending-approvals step underneath it is
    //     fail-closed on BOTH branches (documents or not), same as the PHI-bearing
    //     archive path above. A void failure here THROWS and this project create
    //     fails, retryable — see supersedePriorCveSweepProjects.
    // legacy (pre-RM) project type
    if (validated.project_type === 'it' && validated.cve_sweep === true && repoUrl) {
      await supersedePriorCveSweepProjects({
        repositoryUrl: repoUrl,
        tenantId: ownerTenantId,
      });
    }

    // 1. Create project + board + default lists in Planka — NO card (George
    //    2026-10-12: fr is a facilitator and never creates or moves cards; v4
    //    R80/R81: n8n's trigger.conveyor_start creates the first card).
    //    (synchronous). Runs as fr's one configured Planka account — Planka use
    //    is per tenant, not per user (George, 2026-10-10); fr's own gates above
    //    decided this caller may create the project.
    try {
      planka = await createProjectWithDefaultBoard(
        plankaAsAgent(),
        {
          name: validated.name,
          description: validated.description ?? validated.problem_statement ?? undefined,
        },
        // The tenant that OWNS the board (a promoted request's own tenant, not
        // the decider's) — gates the conveyor editor grant to platform tenants.
        ownerTenantId,
        boardSpec,
      );
      plankaCreated = { projectId: planka.project.id, boardId: planka.board.id };
    } catch (err) {
      if (err instanceof PlankaError) {
        throw new ProjectCreateError(
          {
            error: 'planka_intake_failed',
            message: clientSafePlankaErrorMessage(err, 'projects create intake'),
            status: err.status,
          },
          502,
        );
      }
      throw err;
    }

    // 4. Persist FR project row + creation-time asset bindings atomically.
    //    The project row and its bindings are one logical unit: a project
    //    without its picked library scope is a degraded state. Wrapping both
    //    in a transaction means a binding failure rolls the project row back
    //    too, so the user retries against a clean slate instead of a half-
    //    created project. (Planka resources from steps 1–3 are external and
    //    not part of this transaction; tenant validation already ran at
    //    step 0, so the only failures here are genuine DB errors.)
    // A concurrent bug-hunt create that slipped past assertNoLiveBugHuntProject
    // loses HERE on migration 163's unique index ⇒ the same 409. The loser's
    // Planka project/board from step 1 is left behind (no teardown exists on
    // this path today).
    // From here the compensation (Planka teardown) is commitProjectAndLinkRm's.
    const builtBoard = plankaCreated!;
    plankaCreated = null;
    ({ project, rmLink } = await commitProjectAndLinkRm({
      projectId,
      planka: { projectId: builtBoard.projectId, boardId: builtBoard.boardId, listIds: planka.listIds ?? {} },
      rm: {
        tenantId: ownerTenantId,
        title: validated.name,
        description: validated.description ?? null,
        catalogueType,
        createdByUserId: user.id,
        // The FULL intake + the brief as version 1 (RM derives author user from
        // the delegated call).
        intake: rmIntakeOfCreate(
          { ...validated, question_mode: question_mode ?? undefined },
          { scopeLevel: derivedScopeLevel ?? null, priorityLevelId: createLevel?.id ?? null },
        ),
      },
      writeRow: async (tx) => {
      const columns = {
        name: validated.name,
        repository_url: repoUrl ?? null,
        branch: repoBranch,
        description: validated.description,
        owner_id: user.id,
        status: 'active',
        project_type: validated.project_type,
        // DERIVED, not the raw field — an explicit granularity is preserved and
        // a 2+-repo body with no scope_level lands 'multi_repo'.
        scope_level: derivedScopeLevel,
        // The declaration a multi-repo project makes about itself. The zod field
        // carries `.default('coordinated')`, so this is always a concrete value;
        // the column's own NOT NULL DEFAULT covers rows written by other doors.
        coordination_mode,
        shape: validated.shape,
        project_data: projectData,
        // The board-id cache is written from RM's link answer (4z), never from Planka's.
        planka_project_id: null,
        planka_board_id: null,
        // U-PS-ROUTE: a template start records its template; the outline approval
        // was the contract close (project_data.contract_close). Its first phase is
        // n8n's to set in RM — fr writes no phase.
        ...(input.startTemplate
          ? {
              template_id: input.startTemplate.templateId,
              template_hash: input.startTemplate.templateHash,
            }
          : {}),
      };
      // Pre-approval row ⇒ the SAME row goes pending → active with every column
      // the insert would write; conditional on `pending`, so a concurrent
      // reject/withdraw (→ cancelled) or a second approve makes this a refusal.
      const [row] = input.existingProjectId
        ? await tx
            .update(projects)
            .set({ ...columns, updated_at: new Date() })
            .where(and(eq(projects.id, projectId), eq(projects.status, 'pending')))
            .returning()
        : await tx.insert(projects).values({ id: projectId, ...columns }).returning();

      if (!row) {
        if (input.existingProjectId) throw preApprovalProjectNotPendingError(projectId, null);
        throw new Error('Failed to create project row');
      }

      // ONE audit row for a create-time priority (from null), in this
      // transaction: a failed insert rolls the project row back.
      if (createPriority !== undefined && createSetBy !== undefined) {
        // Scoped to the inserted row's own tenant tag (= ownerTenantId; the
        // actor stays the decider).
        await recordPriorityChange(tx, {
          user,
          project: row,
          cardId: null,
          from: null,
          to: createPriority,
          toLevelId: createLevel?.id ?? null,
          setBy: createSetBy,
        });
      }

      if (bound_assets && Object.keys(bound_assets).length > 0) {
        await bulkBindAssets(projectId, user.id, bound_assets, tx);
      }

      // Multi-repo bootstrap (migration 072). Upsert the primary into
      // `repositories` + link via `project_repositories` is_primary=true so
      // /api/projects/:id/repositories returns it consistently from day one.
      // Any `repo.additional` entries follow as is_primary=false rows in the
      // same transaction. The repositories upsert is keyed on
      // `(user_id, url)` (UNIQUE added by migration 072), keeping the path
      // idempotent against repos the user already owns.
      if (repoUrl && repoUrl.trim().length > 0) {
        const [primaryRepo] = await tx
          .insert(repositories)
          .values({
            user_id: user.id,
            // Named from the URL (owner/repo) when it has one, NOT the project
            // name: this row is shared per (user, url) and the upsert never
            // renames it, so a project-title name leaked into every later project
            // on the same repository (UI review 2026-10-07). A url with no
            // derivable owner/repo still falls back to the project name rather
            // than failing the create.
            name: deriveRepositoryNameFromUrl(repoUrl) ?? resolveRepositoryName(validated.name, repoUrl),
            url: repoUrl,
            branch: repoBranch ?? 'main',
          })
          .onConflictDoUpdate({
            target: [repositories.user_id, repositories.url],
            set: { updated_at: new Date() },
          })
          .returning({ id: repositories.id });
        if (!primaryRepo) {
          throw new Error('Failed to upsert primary repository');
        }
        await tx
          .insert(projectRepositories)
          .values({
            project_id: projectId,
            repo_id: primaryRepo.id,
            is_primary: true,
            // Position 0 is the primary, by definition. `added_at` defaults to
            // `transaction_timestamp()`, so every row this transaction inserts
            // shares a BYTE-IDENTICAL timestamp and cannot tiebreak the ordering
            // in services/project-repositories.ts — `position` is the only
            // discriminator that survives a re-read.
            position: 0,
          })
          .onConflictDoNothing({
            target: [projectRepositories.project_id, projectRepositories.repo_id],
          });
      }

      const additional = validated.repo?.additional ?? [];
      // `.entries()` for the index — `position` has to reflect the caller's
      // submitted order, which is the only order the UI and the brief can show.
      for (const [i, extra] of additional.entries()) {
        const [extraRepo] = await tx
          .insert(repositories)
          .values({
            user_id: user.id,
            // Was `?? null` — the additional-repo path is the one a multi-repo
            // create uses, and it is exactly where blank names came from.
            name: resolveRepositoryName(extra.name, extra.url, 'repo.additional[].name'),
            url: extra.url,
            branch: extra.branch ?? 'main',
          })
          .onConflictDoUpdate({
            target: [repositories.user_id, repositories.url],
            set: { updated_at: new Date() },
          })
          .returning({ id: repositories.id });
        if (!extraRepo) {
          throw new Error('Failed to upsert additional repository');
        }
        await tx
          .insert(projectRepositories)
          .values({
            project_id: projectId,
            repo_id: extraRepo.id,
            is_primary: false,
            // `i + 1` — the primary owns 0. ⚠️ A body with NO primary url (the
            // `repoUrl` guard above skipped) therefore starts at 1 and leaves 0
            // empty; the ORDER is still correct, which is all `position` is for.
            position: i + 1,
          })
          .onConflictDoNothing({
            target: [projectRepositories.project_id, projectRepositories.repo_id],
          });
      }

      // Execution sign-off roster (migration 074). Persist each approver that
      // is a concrete Keycloak user id (UUID) into project_stakeholders with
      // role 'execution_signoff' — the auditable source-of-truth the AA
      // ready-prefetch policy gate reads via POST /api/execution/approvals to
      // build an approval + fan out. The full approvers list (UUIDs and
      // free-text names) lives in RM's brief (rm#213; fr keeps no
      // project_data copy). Non-UUID entries stay in RM only — they can't seed
      // required_approvers (uuid NOT NULL).
      const approverIds = validated.approvers ?? [];
      const explicitSignoffIds = [...new Set(approverIds.filter(isValidUuid))];
      const droppedApprovers = approverIds.length - explicitSignoffIds.length;
      if (droppedApprovers > 0) {
        console.warn(
          `[projects.create] ${droppedApprovers} approver(s) on project ${projectId} ` +
            `are not UUIDs; kept in the RM brief's approvers but NOT seeded into ` +
            `project_stakeholders (execution sign-off needs concrete user ids).`,
        );
      }
      // Never leave the execution sign-off roster empty: a gate-eligible project
      // with no approver would dead-strand its decision_development card in
      // BLOCKED (POST /api/execution/approvals 422s on an empty roster, and the
      // n8n caller swallows it). Fall back to the owner when no explicit approver
      // was supplied — an explicit roster always wins.
      let signoffUserIds = resolveSignoffStakeholderIds(approverIds, user.id);
      // An agent-proof tenant (fr #1683) has no human member. A project created by a
      // delegating licence falls back to its owner, but that subject is NOT a member of
      // the owning tenant, so every execution gate would name an undecidable approver.
      // Name the tenant's own agent member instead: it holds a `user_roles` row in the
      // tenant and can decide. Still ONE approver, so the quorum does not change.
      if (
        explicitSignoffIds.length === 0 &&
        signoffUserIds.length > 0 &&
        !(await isTenantMemberForDecision(ownerTenantId, user.id))
      ) {
        const agentMemberId = await findDefaultAgentMemberId(ownerTenantId);
        if (agentMemberId) {
          signoffUserIds = [agentMemberId];
          console.log(
            `[projects.create] owner ${user.id} is not a member of tenant ${ownerTenantId}; ` +
              `seeded the tenant's agent member ${agentMemberId} as the execution_signoff stakeholder.`,
          );
        }
      }
      if (explicitSignoffIds.length === 0 && signoffUserIds.length > 0 && signoffUserIds[0] === user.id) {
        console.log(
          `[projects.create] no UUID approver supplied for project ${projectId}; ` +
            `seeded owner ${user.id} as the default execution_signoff stakeholder.`,
        );
      }
      if (signoffUserIds.length > 0) {
        await tx
          .insert(projectStakeholders)
          .values(
            signoffUserIds.map((uid) => ({
              project_id: projectId,
              user_id: uid,
              role: 'execution_signoff',
            })),
          )
          .onConflictDoNothing();
      }

      return row;
      },
    }));
  } catch (err) {
    // A failure BEFORE the commit step (none today after the board exists); from the commit step
    // on, commitProjectAndLinkRm tears the board down itself.
    if (plankaCreated) await discardPlankaProjectOfFailedCreate(plankaAsAgent(), plankaCreated);
    throw err;
  }

  // U-PS-ROUTE: the outline approval closes the type's gate in front of
  // phase_plan.phases[0] — record it as the phase-gate report that gate's
  // approval would have written. WHICH phase is gated is RM's catalogue
  // (`has_gate` on the type's phases), never an fr constant; no gated phase ⇒
  // no report (gates are approvals only, no fallback). After the commit; never
  // throws.
  const outlineGatePhase =
    input.startTemplate && catalogueType
      ? outlineClosedGatePhase(catalogueType.phases, input.startTemplate.phasePlan.phases[0]!)
      : null;
  if (input.startTemplate && !outlineGatePhase) {
    console.warn(
      `[projects.create] template start of project ${projectId}: type ` +
        `${validated.project_type ?? '(none)'} has no RM-gated phase before ` +
        `'${input.startTemplate.phasePlan.phases[0]}'; no phase-gate report recorded.`,
    );
  }
  if (input.startTemplate && outlineGatePhase) {
    await recordPhaseGateReport({
      projectId,
      tenantId: ownerTenantId,
      fromPhase: outlineGatePhase,
      toPhase: input.startTemplate.phasePlan.phases[0]!,
      approvalId: input.startTemplate.approvalId,
      decidedBy: input.startTemplate.decidedBy,
      source: 'outline_approval',
    });
  }

  // 5. THE CONVEYOR START WEBHOOK (services/rm-board-link.ts,
  //    services/conveyor-start-webhook.ts): the project row has committed, and
  //    its RM pm_project is linked to its board (4z) — n8n resolves Planka
  //    webhooks to the RM project through that link. Tell n8n ONCE. Detached:
  //    it runs after this create answers and can never fail the create. Inert
  //    when CONVEYOR_START_WEBHOOK_URL is unset. A kata (`startConveyor: false`)
  //    sends no start: fr creates its first card itself.
  const linked = rmLink as Awaited<ReturnType<typeof linkRmProject>> | null;
  if (linked?.rmPmProjectId && input.startConveyor !== false) {
    linkBoardThenStartConveyor({
      tenantId: ownerTenantId,
      rmPmProjectId: linked.rmPmProjectId,
      frProjectId: projectId,
      plankaProjectId: linked.planka_project_id,
      plankaBoardId: linked.planka_board_id,
      listIds: planka.listIds ?? {},
      boardLinked: true,
    });
  }

  return { project, planka };
}

// POST /api/projects - Create new project
const IdempotencyKeySchema = z.string().uuid();

/**
 * The project an `Idempotency-Key` already names, judged for a replay of a
 * direct create by THIS caller:
 *  - no row ⇒ `none` (create under that id);
 *  - the caller's own direct create (same owning tenant, same creator, not a
 *    request's `pending` placeholder) ⇒ `replay` (return it, create nothing);
 *  - anything else — another tenant's or another user's project, or a
 *    pre-approval placeholder — ⇒ `conflict` (409; the key is not reusable).
 */
async function projectForIdempotencyKey(
  key: string,
  user: AuthUser,
): Promise<{ kind: 'none' } | { kind: 'replay'; row: typeof projects.$inferSelect } | { kind: 'conflict' }> {
  const [row] = await db.select().from(projects).where(eq(projects.id, key)).limit(1);
  if (!row) return { kind: 'none' };
  const rowTenant = (row.project_data as Record<string, unknown> | null)?.keycloak_tenant_id;
  const sameCaller =
    rowTenant === ctxTenantId(user.tenantId) && row.owner_id === user.id && row.status !== 'pending';
  return sameCaller ? { kind: 'replay', row } : { kind: 'conflict' };
}

/**
 * The outcome of {@link createProjectCore}: the HTTP status and body the create
 * door answers with. A route turns it into a Response; the channel handler of
 * `projects.create` (agui/actions/projects-create.ts) reads it directly.
 */
interface CreateProjectCoreResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The create door's engine, shared by `POST /api/projects` and the channel
 * handler of `projects.create` (fr-agui SPEC §6.1). Keeps the route's order:
 * conveyor gate → schema parse → idempotency (replay 200 / conflict 409) →
 * {@link createSingleProject} (the ONE insert site). Throws what the route threw
 * (a zod error, an AppError); returns every answer the route made itself.
 * `idempotencyKey` must already be a validated, lower-cased UUID.
 */
export async function createProjectCore(input: {
  body: unknown;
  user: AuthUser;
  idempotencyKey?: string;
}): Promise<CreateProjectCoreResult> {
  assertConveyorConfigured();
  const { user, idempotencyKey } = input;
  refuseInvalidCreatePriority(input.body);
  const validated = ProjectCreateSchema.parse(input.body);

  if (idempotencyKey) {
    const existing = await projectForIdempotencyKey(idempotencyKey, user);
    if (existing.kind === 'replay') return replayResult(existing.row);
    if (existing.kind === 'conflict') return idempotencyKeyConflictResult();
  }

  try {
    const { project, planka } = await createSingleProject({
      validated,
      user,
      ...(idempotencyKey ? { newProjectId: idempotencyKey } : {}),
    });
    return {
      status: 201,
      body: { ...project, planka: { boardId: planka.board.id } },
    };
  } catch (err) {
    // A concurrent attempt with the same key won the insert: answer as its replay.
    if (idempotencyKey) {
      let raced: Awaited<ReturnType<typeof projectForIdempotencyKey>> | undefined;
      try {
        raced = await projectForIdempotencyKey(idempotencyKey, user);
      } catch (lookupErr) {
        // The ORIGINAL create error is what the caller gets; this lookup is advisory.
        console.error('[projects.create] idempotency replay lookup failed:', lookupErr);
      }
      if (raced?.kind === 'replay') return replayResult(raced.row);
      if (raced?.kind === 'conflict') return idempotencyKeyConflictResult();
    }
    if (err instanceof ProjectCreateError) {
      return { status: err.httpStatus, body: err.payload as Record<string, unknown> };
    }
    throw err;
  }
}

function idempotencyKeyConflictResult(): CreateProjectCoreResult {
  return {
    status: 409,
    body: {
      error: 'idempotency_key_conflict',
      message: 'this Idempotency-Key already names a project that is not your own direct create; use a new key',
    },
  };
}

function replayResult(row: typeof projects.$inferSelect): CreateProjectCoreResult {
  return {
    status: 200,
    body: { ...row, planka: { boardId: row.planka_board_id }, idempotent_replay: true },
  };
}

export async function handleCreateProject(req: Request): Promise<Response> {
  // ⛔ v4 wiring gate (George 2026-10-13), FIRST — before auth, which can upsert
  // the caller's user row, and before any DB/RM/Planka side effect.
  const notConfigured = conveyorNotConfiguredResponse();
  if (notConfigured) return notConfigured;
  const { user } = await validateAuthWithToken(req);

  const body = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });

  // `Idempotency-Key` (optional, a UUID) — the ProjectForm (and the agent's
  // ProjectCreateCard) sends one per form session. It IS the new project's id
  // (and so the RM origin_project_id): a retry returns the project the first
  // attempt made (200), and a retry after an RM-accepted-but-fr-commit-failed
  // create re-links that RM row instead of leaving it orphaned.
  const rawKey = req.headers.get('Idempotency-Key');
  let idempotencyKey: string | undefined;
  if (rawKey !== null) {
    const parsedKey = IdempotencyKeySchema.safeParse(rawKey.trim().toLowerCase());
    if (!parsedKey.success) {
      // Parse the body first, as before: a bad body still answers its own error.
      refuseInvalidCreatePriority(body);
      ProjectCreateSchema.parse(body);
      return jsonResponse(
        { error: 'invalid_idempotency_key', message: 'Idempotency-Key must be a UUID' },
        400,
      );
    }
    idempotencyKey = parsedKey.data;
  }

  const out = await createProjectCore({ body, user, ...(idempotencyKey ? { idempotencyKey } : {}) });
  return out.status === 201 ? createdResponse(out.body) : jsonResponse(out.body, out.status);
}

// `tenantScopedProjectFilter` now lives in `../lib/project-access` (shared with
// every project sub-resource handler). The list/get/delete callers below keep
// their call text unchanged via the import.

// GET /api/projects - List user's projects (scoped to active tenant)
//
// Super-admin tenant-switch completeness (Phase 2): when a super-admin has
// switched into another workspace via the X-Active-Tenant header, the list is
// made tenant-complete rather than owner-scoped:
//   - `includeAllOwners` drops the `owner_id` predicate so the demo execution
//     project (and any other user's work in that workspace) is visible.
//   - the continuous-improvement boards live in the `streams` table, not
//     `projects`, so they are surfaced as read-only `kind:'continuous'`
//     project-shaped entries pointing at their Planka board.
/** The only two fields `keepAfterBoardLivenessCheck` is allowed to read. */
interface ProjectListRowForBoardCheck {
  status?: string | null;
  /**
   * `true` the board exists in Planka, `false` it is confirmed GONE,
   * `undefined` nobody knows (no board, or the Planka check itself failed).
   */
  board_live?: boolean;
}

/**
 * Does this listed project survive the live-Planka-board cross-check?
 *
 * ## Why this is an exported function and not an inline `.filter(...)`
 *
 * It is the SECOND predicate narrowing `GET /api/projects` below
 * `GET /api/projects/:id`, and the defect being repaired here is that exactly
 * such a second predicate went unnoticed: a fix widened the FIRST one
 * (`tenantScopedProjectFilter`), was reported closed on evidence that never
 * looked at `status`, and the list still returned at most one project because
 * `ne(status,'archived')` was untouched. An inline arrow is not addressable by a
 * test, so "the archived exemption was quietly deleted" would be a silent
 * regression. This is addressable.
 *
 * ## The rule
 *
 * A board confirmed gone means opening the project 404s, so it is dropped —
 * `undefined` is NOT a drop, because a Planka hiccup must never blank the list.
 *
 * ⭐ An `archived` row is EXEMPT. This drop is about what may be OFFERED, and an
 * archived project is never offered: it only ever reaches a caller that passed
 * `?include_archived=1`, and it comes back marked unselectable. It is there to
 * be NAMED. Measured 2026-09-24 on production, this exemption is doing most of
 * the work: of the 189 archived projects still carrying a `planka_board_id`,
 * only **14** boards still exist in Planka, and of the 86 asset-referenced
 * projects that resolve in `projects`, **37 are archived with a dead board** —
 * so without the exemption 43% of the relation directory would still have
 * rendered as bare uuids and the repair would have looked done again.
 *
 * On the default path this exemption is a no-op: the query returned no archived
 * rows for it to spare.
 */
export function keepAfterBoardLivenessCheck(p: ProjectListRowForBoardCheck): boolean {
  if (p.status === 'archived') return true;
  return p.board_live !== false;
}

/**
 * How many rows `keepAfterBoardLivenessCheck` WITHHELD from this list.
 *
 * ## ⛔ Why this exists — the same defect class, one layer down
 *
 * `archived_excluded` was added (fr#1259) because `{items:[],total:0}` could not
 * say whether a workspace has no projects or holds projects that are all
 * archived, so `/projects` rendered "No projects yet / Create Your First
 * Project" over 133 archived rows: AN ABSENCE RENDERED AS A RESULT.
 *
 * The board-liveness drop above reintroduces exactly that. It runs AFTER
 * `archived_excluded` has been counted, and it drops non-archived rows whose
 * board is confirmed gone — so a workspace whose only projects are
 * active-with-a-dead-board answers `{items:[], archived_excluded:0}`, which the
 * page is entitled to read as "explicitly nothing was withheld, therefore this
 * is a first run". That is a false statement produced by a correct filter, and
 * `archived_excluded` cannot carry it: the two counts are DISJOINT BY
 * CONSTRUCTION — `keepAfterBoardLivenessCheck` returns `true` for every
 * `archived` row, so no row can ever be counted by both.
 *
 * ## The rule
 *
 * A row is counted iff the predicate rejected it, i.e. `status !== 'archived'`
 * AND `board_live === false` (CONFIRMED gone — `undefined` is a Planka hiccup or
 * no board at all, is never dropped, and is therefore never counted). So this is
 * 0 whenever the live-Planka cross-check did not run or did not resolve, which is
 * correct: that request withheld nothing on these grounds.
 *
 * ## ⛔ It is a companion to the filter, not a second definition of it
 *
 * It is a fold over the SAME exported predicate rather than its own
 * `board_live === false` test, so a change to the drop rule cannot make the
 * count describe a population the filter no longer removes. The invariant
 * `kept.length + withheld === rows.length` holds.
 */
function countWithheldByBoardLivenessCheck(
  rows: ReadonlyArray<ProjectListRowForBoardCheck>,
): number {
  let withheld = 0;
  for (const row of rows) {
    if (!keepAfterBoardLivenessCheck(row)) withheld += 1;
  }
  return withheld;
}

/** The caller shape the project READ lanes take (a validated user, or an agent read identity). */
export type ProjectReadUser = Pick<Awaited<ReturnType<typeof validateAuth>>, 'id' | 'tenantId'> & {
  roles?: readonly string[];
  authKind?: Awaited<ReturnType<typeof validateAuth>>['authKind'];
};

/** `?programme_id=` → the filter: a uuid matches, anything else matches nothing, absent ⇒ none. */
function programmeFilterFor(programmeId: string | null) {
  return programmeId && isValidUuid(programmeId)
    ? drizzleSql`${projects.project_data}->>'programme_id' = ${programmeId}`
    : programmeId
      ? drizzleSql`false`
      : undefined;
}

/**
 * ⭐ THE PROJECT LIST QUERY of `GET /api/projects`, as one function — shared with
 * the agent's `projects.list` (agui/actions/projects-read.ts, fr-agui SPEC §6.0),
 * so the doorway agent lists exactly the projects the classic list shows the
 * same person. Projects only; the streams the route appends for a switched
 * super-admin stay in the route.
 *
 * ⭐ SUPER-ADMIN HOME VIEW — the same relaxation `selectProjectVisibleToGetProject`
 * applies to the single-project read (`crossTenantReadOnly`, a READ lane: it must
 * stay false for every mutating caller; see `tenantScopedProjectFilter`).
 */
export async function selectListedProjectRows(
  user: ProjectReadUser,
  activeTenantId: string,
  opts: { includeArchived: boolean; programmeId: string | null },
) {
  const includeAllOwners = isSuperAdminSwitchedView(user, activeTenantId);
  const crossTenantReadOnly = isSuperAdminHomeView(user);
  const includeArchived = opts.includeArchived;
  const programmeFilter = programmeFilterFor(opts.programmeId);
  return db
    .select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
          includeAllOwners,
          crossTenantReadOnly,
          ...licenceProjectScope(user),
        }),
        // A fresh login must never surface projects that no longer exist. `archived`
        // is the soft-delete state; the reconcile script (scripts/reconcile-orphaned-projects.ts)
        // archives projects whose Planka board was deleted out-of-band.
        // Lifted ONLY by `?include_archived=1` — see that flag's comment above.
        // A project request's pre-approval row (`pending`, or `cancelled` after
        // reject/withdraw) is never a project to list — not even under
        // include_archived (lib/project-live-status.ts).
        // A DELIVERED hunt (migration 173) is not live work but IS listed: it
        // is finished, not deleted — projectIsVisible, not projectIsLive.
        ...(includeArchived ? [projectIsNotPreApproval()] : [projectIsVisible()]),
        ...(programmeFilter ? [programmeFilter] : []),
      ),
    );
}

export async function handleListProjects(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  const includeAllOwners = isSuperAdminSwitchedView(user, activeTenantId);
  // ⭐ SUPER-ADMIN HOME VIEW — same relaxation `selectProjectVisibleToGetProject`
  // already applies to the single-project read, extended to the LIST (a read
  // lane; `crossTenantReadOnly` must stay false for every mutating caller —
  // see `tenantScopedProjectFilter`'s own comment for why this route was
  // previously left out of that widening).
  //
  // ⛔ THE DEFECT THIS CLOSES. Without this, a super-admin in home view (no
  // X-Active-Tenant switch) hit the owner-scoped fallback of
  // `tenantScopedProjectFilter` — `owner_id = user.id` — same as an ordinary
  // user, even though `handleGetProject` already hands that identity ANY
  // project by id (`crossTenantReadOnly: true`). Measured in production
  // 2026-09-24: 263 `projects` rows, all `dept_id IS NULL`, owned by 8
  // distinct `owner_id`s — a super-admin test identity owning none of them
  // got `GET /api/projects` → `{items:[],total:0}` while
  // `GET /api/projects/:id` resolved any of the 263 by id. Both the
  // `type:'relation'` project picker (`relationDirectory.ts
  // loadProjectDirectory`) and the detail-page relation-label resolver read
  // this SAME `GET /api/projects` as their one directory, so the empty list
  // was simultaneously the picker's "No projects to pick from" and the detail
  // page's bare-uuid render — one cause, two symptoms.
  // (The list query itself is `selectListedProjectRows`, which computes the SAME
  // flag; it is computed here too because the archived count below must be over
  // the list query's own predicate.)
  const crossTenantReadOnly = isSuperAdminHomeView(user);

  // D6/3C — coordinate N delivery projects under one Programme. `?programme_id=`
  // filters to the delivery projects grouped under that pmProgrammes asset
  // (stored in project_data JSONB on create). Absent ⇒ unfiltered (unchanged).
  // A malformed (non-uuid) value yields an empty list rather than a scan of all.
  const listParams = new URL(req.url).searchParams;

  // ⭐ `?include_archived=1` — the DIRECTORY read, as distinct from the BROWSER
  // read. Absent (every existing caller) ⇒ byte-identical to before.
  //
  // ## Why an opt-in and not a widening of the default
  //
  // Measured on production 2026-09-24 (worker4, read-only): `projects` holds
  // **262 `archived` and 1 `active`**. So the two are not variations of one
  // list, they are two different questions with opposite right answers:
  //
  //   - "which projects may I open / pick / create under?" — the browser. The
  //     answer must EXCLUDE archived: it is the soft-delete state written by
  //     `services/project-archive.ts` (PHI purged, approvals voided, Planka
  //     board torn down), so an archived project is a deleted project and
  //     offering one is offering a 404. That is the default, unchanged.
  //   - "what is the NAME of the project this row already points at?" — the
  //     directory behind `type:'relation'` (`relationDirectory.ts`
  //     `loadProjectDirectory`, read by both `RelationPicker` and the detail
  //     page's label resolver). Here excluding archived is the DEFECT: measured
  //     in `requirements_api`, 16,457 asset rows carry a `project_id` and only
  //     **40** of them point at the one `active` project; of the 125 distinct
  //     project ids those rows reference, 86 resolve in `projects` and **85 of
  //     the 86 are archived**. A directory that excludes archived can name
  //     1 of 86 referenced projects and renders the other 85 as bare uuids.
  //
  // ⛔ WIDENING THE DEFAULT WAS THE WRONG FIX and is why this is a parameter:
  // it would put all 262 soft-deleted projects into every picker and every
  // project browser. The rows are made SELECTABLE-or-not on the client from the
  // `status` each item already carries (see `RelationPicker.svelte`'s
  // `selectableOptions`) — displaying an existing reference and offering a new
  // one are different permissions, and only the first is widened here.
  //
  // This grants NO new tenant reach: it relaxes one status predicate inside
  // whatever `tenantScopedProjectFilter` already admits.
  const includeArchived = ['1', 'true', 'yes'].includes(
    (listParams.get('include_archived') ?? '').trim().toLowerCase(),
  );

  const programmeId = listParams.get('programme_id');
  const programmeFilter = programmeFilterFor(programmeId);

  const rows = await selectListedProjectRows(user, activeTenantId, { includeArchived, programmeId });

  const userProjects: unknown[] = rows.map((r) => r.project);

  // Surface the active tenant's continuous-improvement boards (streams) as
  // read-only project cards. Gated to super-admins viewing a switched tenant.
  // Only the kaizen-loop kinds (workflow / prompt / procedure) — NOT the
  // asset-authoring streams (principle / requirement / decision), which are
  // a different, noisier surface and not what "continuous projects" means.
  // Suppressed under a programme filter: streams are not programme-linked, so a
  // `?programme_id=` query returns only the grouped delivery projects.
  if (includeAllOwners && !programmeFilter) {
    const streamRows = await db
      .select({
        id: streams.id,
        name: streams.name,
        kind: streams.kind,
        planka_board_id: streams.planka_board_id,
        created_at: streams.created_at,
        updated_at: streams.updated_at,
      })
      .from(streams)
      .where(
        and(
          eq(streams.tenant_id, activeTenantId),
          eq(streams.is_active, true),
          inArray(streams.kind, ['workflow', 'prompt']),
        ),
      );

    for (const s of streamRows) {
      userProjects.push({
        // The stream's OWN uuid — not a `stream:`-prefixed synthetic id.
        //
        // WHY THIS CHANGED (2026-09-04). This minted `stream:${s.id}`. That
        // string is not a uuid, so any caller that fed a listed id back into a
        // route that puts it in a `uuid` column made Postgres raise 22P02
        // (`invalid input syntax for type uuid`), which escaped as a bare HTTP
        // 500. fr was handing out an id fr could not read.
        //
        // MEASURED on the deployed pod (fr-79866f74b6-4sg9d, revision
        // a4600cd9): a 37-minute window held 13 HTTP 500s and ALL 13 were this
        // id, on authenticated traffic —
        //     GET /api/projects/:id                     x6
        //     GET /api/projects/:id/approvals           x2
        //     GET /api/assets/{workflows,requirements,
        //         procedures,principles,kag-documents}  x5
        // An earlier round of the same defect (2026-09-01) hit
        // GET /api/reports/project-status/:projectId and
        // GET /api/tools/bridge/links; those two routes were fixed one at a
        // time, which is why `lib/uuid-shape.ts` exists. This removes the
        // class at the source: an id from this list is always uuid-shaped.
        //
        // The distinction the frontend needs is carried by the EXISTING
        // `kind: 'continuous'` discriminator below (see `isRealProject` in
        // frontend `$lib/projects/is-real-project`), never by the id's shape.
        // A stream uuid is not a `projects` row id — do not treat it as one.
        id: s.id,
        owner_id: '',
        name: s.name,
        // A continuous stream has no repository (NULL, never '').
        repository_url: null,
        branch: '',
        status: 'active',
        shape: 'continuous_flow',
        dept_id: null,
        planka_board_id: s.planka_board_id,
        repository_provisioned: false,
        project_type: s.kind,
        // A continuous stream has NO lifecycle phase: the off-spine `continuous`
        // phase was dropped (design: fr consumes RM vocabulary — continuous
        // projects are out of scope, George 10-11). `kind` below is the marker.
        project_phase: null,
        kind: 'continuous',
        created_at: s.created_at,
        updated_at: s.updated_at,
      });
    }
  }

  // R2/B3: fr never reconciles planka_board_id against live Planka, so the UI
  // links to boards that were deleted there. Cross-check each item's board id
  // (real projects AND synthetic continuous-stream cards) against the live
  // Planka board set (one agent call — the agent sees every board) so the
  // frontend can hide dead links. Best-effort: a Planka hiccup leaves board_live
  // undefined and never breaks the list.
  const itemsWithBoards = userProjects as Array<{ planka_board_id?: string | null }>;
  let liveBoardIds: Set<string> | null = null;
  if (itemsWithBoards.some((p) => p.planka_board_id)) {
    try {
      const resp = await plankaAsAgent().projects.listWithIncluded();
      liveBoardIds = new Set((resp.included?.boards ?? []).map((b) => b.id));
    } catch {
      liveBoardIds = null;
    }
  }
  // ⚠️ NAMED, and the filter applied SEPARATELY below, so the pre-filter row set
  // is still in hand afterwards. `dead_board_excluded` is a count of what the
  // filter REMOVED, and a fold over a list that has already been filtered can
  // only ever answer 0 — the shape of a gate that cannot fail.
  const rowsWithBoardLive = itemsWithBoards.map((p) => ({
    ...p,
    board_live:
      liveBoardIds === null || !p.planka_board_id
        ? undefined
        : liveBoardIds.has(p.planka_board_id),
  }));
  const items = rowsWithBoardLive
    // When the live Planka check succeeded, drop items whose board is confirmed gone so a
    // fresh login never offers a project that 404s on open (immediate guard; the reconcile
    // script makes it durable by archiving them). `undefined` (no board / check unavailable)
    // is kept — a Planka hiccup must never blank the list.
    //
    // ⚠️ THE SECOND PREDICATE — see `keepAfterBoardLivenessCheck`, which is
    // where its rule and its measurements live. It is a named export rather
    // than an inline arrow precisely because it is a SECOND narrowing predicate
    // on this list, and the defect this route is being repaired for is that a
    // second narrowing predicate went unnoticed and untested behind the first.
    .filter((p) => keepAfterBoardLivenessCheck(p as ProjectListRowForBoardCheck));

  // Every listed project carries its repository set, like GET /:id does.
  const repoSets = await loadRepositoriesForProjects(
    items
      .map((p) => (p as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && isUuidShape(id)),
  );
  for (const p of items as Array<Record<string, unknown>>) {
    const set = typeof p.id === 'string' ? repoSets.get(p.id) : undefined;
    if (set) {
      p.repositories = set.repositories;
      p.repo_count = set.count;
    }
  }

  // Every listed PROJECT shows RM's type + phase (one paged RM read per tenant,
  // not one per row). A continuous stream is not a project and has neither.
  const projectRows = (items as Array<Record<string, unknown>>).filter(
    (p) => p.kind !== 'continuous' && typeof p.id === 'string',
  );
  const states = await projectStatesFor(
    projectRows.map((p) => ({ id: p.id as string, name: (p.name as string | null) ?? null, project_data: p.project_data })),
  );
  for (const p of projectRows) {
    const st = states.get(p.id as string);
    // RM closed ⇒ the row reads delivered, derived per read (services/project-delivered.ts;
    // the reconcile worker is the only writer, and this read writes nothing).
    Object.assign(p, deliveryFromRm(p as { status: string }, st?.ok ? st.state : undefined), rmStateFields(p, st));
  }

  // ⭐ THE SECOND DISCRIMINATOR (see `countWithheldByBoardLivenessCheck` for the
  // whole argument). The filter one line above runs AFTER `archived_excluded` is
  // computed below and drops NON-ARCHIVED rows whose Planka board is confirmed
  // gone, so without this number a workspace holding only active-with-a-dead-board
  // projects answers `{items:[], archived_excluded:0}` — an explicit "nothing was
  // withheld" that licenses the first-run pitch. Same defect class as fr#1259,
  // one predicate lower.
  //
  // ⛔ NOT CONFUSABLE WITH `archived_excluded`, by construction: the predicate
  // exempts every `archived` row, so the two counts partition the withheld rows
  // and never double-count one. Different provenance too — this folds the rows
  // the list query RETURNED, while `archived_excluded` is a separate `count()`
  // over rows the list query never selected.
  //
  // ⛔ THE FILTER IS UNCHANGED. This adds a signal beside the list; a project
  // whose board is gone still must not be offered, because opening it 404s.
  const deadBoardExcluded = countWithheldByBoardLivenessCheck(
    rowsWithBoardLive as ProjectListRowForBoardCheck[],
  );

  // ⭐ THE DISCRIMINATOR (fr#1259): "you have no projects at all" vs "you have
  // projects and every one of them is archived". Those are the SAME
  // `{items:[],total:0}` on the wire, and the frontend had no way to tell them
  // apart, so `/projects` rendered both as "No projects yet / Create Your First
  // Project".
  //
  // ⛔ WHY THIS IS NOT COSMETIC. Measured on production 2026-09-30: `projects`
  // holds **133 rows and EVERY ONE is `archived`** (the same population the
  // `include_archived` comment above measured at 262/1 on 09-24). So the CORRECT
  // default `ne(status,'archived')` predicate makes this route answer
  // `{items:[],total:0}` to every caller, and the first-run pitch is what every
  // user of the primary nav item sees while the system holds 133 projects. An
  // absence rendered as a result.
  //
  // ⛔ THE FILTER IS UNCHANGED, DELIBERATELY. This adds a signal BESIDE the list;
  // it does not widen what the list returns. `RelationPicker`, the project
  // browser and every picker depend on archived staying out by default — read the
  // `?include_archived=1` comment above for the measurement that says widening
  // the default was the wrong fix.
  //
  // It counts what THIS request WITHHELD, which is why it is 0 under
  // `?include_archived=1` (that request withheld nothing) rather than a second,
  // differently-scoped population number the caller would have to reconcile
  // against `items`. Same tenant/owner scoping and same programme filter as the
  // list query above — a count scoped differently from the list it annotates
  // would be a number about a population the caller cannot see.
  //
  // ⚠️ IT ANNOTATES ONE PREDICATE, NOT ALL OF THEM. `items` can also be emptied
  // by `keepAfterBoardLivenessCheck` above; this number says nothing about that,
  // and a reader must not infer "0 archived_excluded ⇒ the workspace is genuinely
  // empty" — only "archived_excluded > 0 ⇒ archived rows were withheld". THAT
  // inference was the live defect, and `dead_board_excluded` below is what closes
  // it: "genuinely empty" now requires BOTH counts to be an explicit 0.
  let archivedExcluded = 0;
  if (!includeArchived) {
    const archivedCountRows = await db
      .select({ n: count() })
      .from(projects)
      // Mirrors the list query's join: `tenantScopedProjectFilter` can predicate
      // on `departments`, so dropping it here would change which rows the count
      // is over.
      .leftJoin(departments, eq(projects.dept_id, departments.id))
      .where(
        and(
          tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
            includeAllOwners,
            crossTenantReadOnly,
            ...licenceProjectScope(user),
          }),
          eq(projects.status, 'archived'),
          ...(programmeFilter ? [programmeFilter] : []),
        ),
      );
    archivedExcluded = Number(archivedCountRows[0]?.n ?? 0);
  }

  return jsonResponse({
    items,
    total: items.length,
    archived_excluded: archivedExcluded,
    // ⚠️ ALWAYS PRESENT, like `archived_excluded` and for the same reason: an
    // OMITTED key means "the server did not say", and the client must not be able
    // to read that as 0. Single return point, so both are unconditional.
    dead_board_excluded: deadBoardExcluded,
  });
}

/**
 * The project's TYPE and PHASE as the API shows them: RM's (George 2026-10-13 —
 * RM owns both, n8n writes the phase), overlaid on fr's row so the columns of
 * the same name are never what a reader sees. An unreadable RM state shows
 * type/phase null WITH `project_state_unavailable_reason` (a list or detail
 * read must not fail on it, and null alone would read as "not started").
 */
function rmStateFields(p: { project_data?: unknown }, st: ProjectStateOrError | undefined): Record<string, unknown> {
  // THE INTAKE + BRIEF are RM's too (rm#213, George 2026-10-13; fr keeps no
  // copy): `project_data` is fr's own keys with RM's intake overlaid in fr's flat
  // vocabulary (problem_statement, test_command, question_mode …), so n8n and the
  // UI keep reading the same keys — from RM. No local fallback: unreadable ⇒ fr's
  // keys only, plus `intake_unavailable_reason`.
  // A pre-v4 priority copy in project_data is never served: the priority is RM's.
  const {
    priority: _legacyPriority,
    priority_level_id: _legacyPriorityLevelId,
    priority_set_by: _legacyPrioritySetBy,
    ...frData
  } = (p.project_data ?? {}) as Record<string, unknown>;
  if (st?.ok) {
    const pm = st.state.pm;
    return {
      project_type: st.state.projectType,
      project_phase: st.state.phase,
      project_phase_updated_at: st.state.phaseUpdatedAt,
      // RM's lifecycle status (`closed` once the PM closes the project, D22):
      // the phase stays the last phase, so the closure is only visible here.
      rm_status: st.state.pm.status ?? null,
      // RM's priority (priority_level_id → the tenant level's name + rank);
      // fr keeps no copy (v4: RM is the source of truth).
      priority_level_id: st.state.priority?.levelId ?? null,
      priority_name: st.state.priority?.name ?? null,
      priority_rank: st.state.priority?.rank ?? null,
      rm_pm_project_id: st.state.rmPmProjectId,
      project_state_unavailable_reason: null,
      project_data: { ...frData, ...frIntakeFieldsFromRm(pm) },
      brief_version: pm.brief_version ?? null,
      brief_author_kind: pm.brief_author_kind ?? null,
      brief_updated_at: pm.brief_updated_at ?? null,
      intake_unavailable_reason: null,
    };
  }
  const reason = st ? `${st.code}: ${st.message}` : 'not read';
  return {
    project_type: null,
    project_phase: null,
    project_phase_updated_at: null,
    rm_status: null,
    priority_level_id: null,
    priority_name: null,
    priority_rank: null,
    // RM could not be read, so its id is unknown (fr keeps no copy).
    rm_pm_project_id: null,
    project_state_unavailable_reason: reason,
    project_data: frData,
    brief_version: null,
    brief_author_kind: null,
    brief_updated_at: null,
    intake_unavailable_reason: reason,
  };
}

// GET /api/projects/:id - Get project by ID (scoped to active tenant)
/**
 * The visibility rule of `GET /api/projects/:id`, as a reusable query: the row
 * that route would hand this caller, or `undefined`. Shared with the JWT lane
 * of `GET /api/projects/:id/brief`, whose whole authorization argument is "the
 * brief is a projection of a row this caller can already GET" — so the two
 * must scope byte-identically, and one query is the only way to stop them
 * drifting. ⛔ READ-ONLY: it sets `crossTenantReadOnly` for a super-admin in
 * home view, so it must never gate a mutation.
 *
 * Exported for the agent's `projects.get` read (agui/actions/projects-read.ts),
 * so the agent and `GET /api/projects/:id` answer from ONE query, not two.
 */
export async function selectProjectVisibleToGetProject(
  user: ProjectReadUser,
  projectId: string,
) {
  if (!isUuidShape(projectId)) return undefined;
  const activeTenantId = ctxTenantId(user.tenantId);
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        eq(projects.id, projectId),
        // ⭐ The ONE definition (lib/project-access.ts), shared with every
        // surface that emits a navigable project id (fr-agui SPEC §7.5).
        // Super-admin switched view: every owner in the switched workspace;
        // super-admin HOME view: the read-only, tag-bounded relaxation (a
        // project whose approvals this seat is shown must not 404 on its own
        // cockpit) — `super_admin` ONLY, via lib/super-admin-gate.ts.
        projectReadableAsGetProjectFilter(user, activeTenantId),
      ),
    );

  return rows[0]?.project;
}

/**
 * `GET /api/projects/:id`.
 *
 * ⭐ The read DERIVES RM's closure and writes NOTHING (D-run12-9). The RM state
 * comes from `projectStatesFor`, the shared bulk loader the list route uses,
 * and `deliveryFromRm` (services/project-delivered.ts) turns it into the
 * response columns. Storing a delivery is the reconcile worker's job —
 * `stampDeliveryIfRmClosed` — never a read's.
 *
 * ⛔ There is deliberately NO parameter here for a caller to supply the RM
 * state (backend/CLAUDE.md, owner ruling 2026-10-29: no optional
 * fake-collaborator parameters, no test-only hooks in `src/`). The consequence
 * is stated rather than hidden: "a GET never writes" has NO CI test. Proving it
 * needs a CLOSED RM state, which needs a live requirements_management; CI does
 * not have one, and faking it is banned. The property is verified live instead.
 * Coverage may drop; that is accepted. Do not add a seam back to "fix" this.
 */
export async function handleGetProject(req: Request, projectId: string): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  // Shape-check BEFORE the query. `projects.id` is a `uuid` column, so a
  // non-UUID never reached a row — it reached Postgres, which raised 22P02
  // `invalid input syntax for type uuid`, and that escaped as a bare 500.
  // Measured in production: `GET /api/projects/stream:9b9fc446-…` → 500 in
  // 25.3 ms, and the cockpit page polls this route every ~11 s, so the URL was
  // hard-broken and reported back by the frontend's own `client_error`
  // telemetry.
  //
  // ⚠️ CORRECTED 2026-09-04, hours after this guard landed in #953. That PR's
  // version of this comment said the id was fr's OWN and that minting
  // `stream:${s.id}` "is correct and stays". The MINT IS GONE — `handleListProjects`
  // now emits the stream's own uuid and the existing `kind: 'continuous'`
  // discriminator carries the distinction. The reversal was an explicit operator
  // decision plus a consumer census: the list has zero backend consumers, its item
  // shape is unpinned, and exactly one consumer broke — `ProjectSwitcher.svelte`
  // discriminated on the `stream:` PREFIX, which against a bare uuid matches
  // nothing and so FAILED OPEN, leaking continuous boards into the switcher.
  // Handing out an id no route can resolve is the defect; guarding every route
  // that receives it is the mitigation, not the fix.
  //
  // THIS GUARD STILL EARNS ITS PLACE and is deliberately kept: a non-UUID can
  // still arrive from a typed URL, a stale bookmark, or an agent replaying an
  // old id, and the shape check is decided without touching the database.
  //
  // 404, NOT the 400 the report/bridge routes chose, and the difference is the
  // route's own contract: this handler's whole existence answer is a
  // don't-leak-existence 404 (see below). A `stream:`-prefixed id can never
  // match a `uuid` row under ANY tenant, so "not found" is both true and the
  // answer this surface already gives — and 400 here would make a malformed id
  // distinguishable from a well-formed one the caller may not see, which is
  // exactly what the 404-for-everything rule exists to prevent.
  //
  // Third and fourth sites of the same defect: `lib/uuid-shape.ts` fixed
  // `reports/project-status` and `tools/bridge` on 2026-09-01 and these two
  // were missed.
  if (!isUuidShape(projectId)) {
    throw new NotFoundError('Project not found');
  }

  const project = await selectProjectVisibleToGetProject(user, projectId);
  if (!project) {
    // ⭐ ONE CASE IS NOT AMBIGUOUS, AND IT IS THE ONE PRODUCTION IS HITTING.
    //
    // This 404 is deliberately ambiguous — another tenant's row and a genuinely
    // missing row must be indistinguishable, and that stays. But when the id is a
    // canonical TENANT (workspace) uuid it is neither: a workspace id can never
    // be a `projects.id`, under any tenant, so no scoping decision was involved
    // and nothing is leaked by saying so in fr's OWN telemetry. Measured
    // 2026-09-10, prod pod: `GET /api/projects/0195f48b-d000-7000-8000-000000000004`
    // → 404 x4, and that uuid is `prompt-improvement` (migration 062).
    //
    // ⛔ RESPONSE TEXT IS UNCHANGED on purpose. This route is reachable by any
    // authenticated user; the diagnosis goes to the log and the counter, not to
    // the caller. Only the webhook receiver — secret-authenticated, machine
    // caller, no cross-tenant reader — says it out loud.
    //
    // ⚠️ Counted ONLY for the tenant-id case. An ordinary cross-tenant 404 here
    // is normal traffic (the cockpit polls this route every ~11s), and counting
    // it would bury the signal in its own denominator.
    const tenantName = canonicalTenantName(projectId);
    if (tenantName) {
      reportConveyorRefusal({
        surface: 'project_read',
        reason: 'project_id_is_tenant_id',
        subject_id: projectId,
        detail: { tenant_name: tenantName, caller_tenant_id: activeTenantId ?? null },
      });
    }
    // Don't leak existence across tenants — same 404 whether the row
    // is in another tenant or genuinely missing.
    throw new NotFoundError('Project not found');
  }

  // The multi-repo outbound contract. ⛔ The scalars in `...project`
  // (`repository_url`, `branch`) are RETAINED deliberately — n8n and the
  // frontend destructure them and the primary repo stays meaningful. Adding
  // the set is the fix; removing the scalars would be a second defect.
  // `coordination_mode` is a column, so it already arrives via the spread; it
  // is named explicitly so the three-key contract is legible at the seam and
  // survives any future narrowing of what is spread here.
  const repoSet = await loadProjectRepositories(project.id);
  const [state] = (await projectStatesFor([project])).values();
  // RM closed ⇒ the response reads delivered; nothing is written here
  // (services/project-delivered.ts — the reconcile worker stores it; a read never writes).
  const delivery = deliveryFromRm(project, state?.ok ? state.state : undefined);
  return jsonResponse({
    ...project,
    ...delivery,
    repositories: repoSet.repositories,
    repo_count: repoSet.count,
    coordination_mode: project.coordination_mode,
    // The project's RM pm_project and RM's type + phase (George 2026-10-13).
    ...rmStateFields(project, state),
  });
}

// DELETE /api/projects/:id - Delete project (scoped to active tenant)
export async function handleDeleteProject(req: Request, projectId: string): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  const rows = await db
    .select({ project: projects })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(
      and(
        eq(projects.id, projectId),
        // ⭐ P1-TEAM-a (George 2026-10-15): ANY member of the project's tenant may
        // archive it — an explicit, named gate, not a read lane's inheritance.
        // A member of another tenant matches nothing (404).
        projectArchivableByTenantMember(user, activeTenantId),
      ),
    );

  const project = rows[0]?.project;
  if (!project) {
    throw new NotFoundError('Project not found');
  }

  // The shared archive effect: purge every document's downstream PHI (HIPAA
  // right-to-delete, fail-closed) → flip status to 'archived' → tear the Planka
  // board down. Lives in services/project-archive.ts so the admin-console DELETE
  // surface runs the identical sequence and cannot drift back into a bypass.
  // `actor` is recorded on every approval this archive voids (fr#1134) — see
  // `approvals.voided_by`. No `keepBoard` here: leaving a live board behind is
  // a super-admin decision, taken on the admin surface.
  await archiveProjectWithPurge(project, {
    tenantId: activeTenantId,
    actor: user.id,
  });

  return noContentResponse();
}

// POST /api/projects/:id/provision - Provision coding-containers entry
// Calls coding-gateway POST /api/containers/ with the project's repo URL and a
// slugged container_name. On success, stamps projects.container_name and
// projects.repository_provisioned=true so the Architecture / Dependency /
// Quality tabs have something to read. Idempotent when `force_rebuild` is off
// — re-POSTing the same slug just returns the existing container.
export async function handleProvisionProject(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);

  const project = await loadTenantScopedProject(db, user, projectId);

  // NO REPOSITORY ⇒ provisioning is NOT APPLICABLE (George 2026-10-13,
  // migration 190): there is nothing to clone, so no coding-gateway call and no
  // write. A 200 that says so — never an error, never a container for ''.
  if (!project.repository_url) {
    return jsonResponse({
      ...project,
      provision: { status: 'not_applicable', reason: 'no_repository' },
    });
  }
  const repositoryUrl = project.repository_url;

  const slug = slugContainerName(project.name);
  const provisionBody: GithubGitHubRepoRequest = {
    repo_url: repositoryUrl,
    // Preserve the legacy default: the spine forwards the body verbatim, so the
    // 'main' fallback (previously applied inside the Stack-1 client) moves here.
    branch: project.branch ?? 'main',
    container_name: slug,
    description: project.description ?? undefined,
    // No secret_config_id: the clone authenticates with the GitHub App (coding-containers'
    // App clone token), there is no per-project token (George 2026-10-18).
  };

  // The spine is throw-based: provisionRepository resolves to a typed
  // ProvisionResponse or throws an IntegrationError. Provision is the ONLY leg
  // that fails the request (S10 non-blocking); initialize + analyze below
  // degrade to warnings in the 200.
  let provisioned;
  try {
    provisioned = await provisionRepositorySpine(
      provisionBody,
      ctxTenantId(user.tenantId),
    );
  } catch (err) {
    if (isIntegrationError(err)) {
      const status =
        err.upstreamStatus && err.upstreamStatus >= 400 && err.upstreamStatus < 600
          ? err.upstreamStatus
          : 502;
      // fr#1142 — name the cause instead of shipping one label for every
      // failure. `error` stays `provision_failed` (the stable family label an
      // existing consumer matches); `code`/`permanent` are what distinguish a
      // deleted branch — which no retry can fix — from a sick upstream, which a
      // retry can. Without that distinction a blocked sweep re-drove 53 cards
      // into the same GitHub 404 for weeks (203 re-drive comments). The
      // classifier reads the upstream's own sentence and NEVER invents a class:
      // an unreadable message yields `provision_failed` + `permanent: false`,
      // i.e. exactly the pre-existing behaviour.
      const fallback = {
        branch: provisionBody.branch,
        repositoryUrl: project.repository_url,
      };
      // Raw upstream text (and anything the classifier read out of it) is for
      // super-admins only; everyone else gets fr's own row + a generic message.
      const redact = shouldRedactUpstreamDetailForCaller();
      const fullClassified = classifyProvisionFailure(err.message, fallback);
      const classified = redact
        ? clientSafeProvisionFailure(fullClassified, fallback)
        : fullClassified;
      return jsonResponse(
        {
          error: 'provision_failed',
          code: classified.code,
          permanent: classified.permanent,
          detail: classified.detail,
          ...(classified.branch ? { branch: classified.branch } : {}),
          ...(classified.repository ? { repository: classified.repository } : {}),
          message: clientSafeIntegrationErrorMessage(err, status),
          status,
        },
        status,
      );
    }
    throw err;
  }

  // ProvisionResponse nests the provisioned container under `container`; fall
  // back to our local slug if the upstream ever omits it.
  const provisionedName: string =
    provisioned.container?.container_name ?? slug;

  // Initialize the graph DB so the Architecture / Dependency / Quality tabs
  // have something to query. Treat 409 (already exists) as success — the flow
  // must be idempotent so users can click Provision twice without breaking.
  // Non-409 failures are surfaced as a warning in the response but don't block
  // the provision from being considered complete; users can retry.
  //
  // `graphInitialized` tracks whether the graph step ACTUALLY succeeded — it
  // is persisted separately from `repository_provisioned` (which only means
  // the container exists). Previously this column was set TRUE unconditionally
  // and a failed graph-init silently produced a "provisioned" project whose
  // Architecture tab 404s. See plan i-was-testing-fr-lazy-reef.md Bug 2.
  let graphInitWarning: string | null = null;
  let graphInitialized = false;
  try {
    // Resolves on 2xx OR upstream 409 (the spine collapses "graph already
    // exists" into a no-op success), so a repeated Provision stays idempotent.
    // Any other non-2xx throws IntegrationError → recorded as a warning below.
    await initializeGraphSpine(
      { container_name: provisionedName },
      ctxTenantId(user.tenantId),
    );
    graphInitialized = true;
  } catch (err) {
    console.warn('[projects.provision] graph init failed:', err);
    graphInitWarning = clientSafeCaughtErrorText(err, 'graph initialisation failed — retry provisioning');
  }

  // initializeGraph only creates the graph row; the deep file scan that
  // actually populates coding.nodes / coding.edges has to be kicked
  // separately. Without it the Architecture / Quality tabs render an
  // empty graph against a fully cloned repo. Non-fatal: fall through and
  // surface as analysis_warning so the user can retry.
  let analysisWarning: string | null = null;
  if (graphInitialized) {
    try {
      await analyzeCodebaseSpine(
        { container_name: provisionedName, analysis_type: 'deep' },
        ctxTenantId(user.tenantId),
      );
    } catch (err) {
      console.warn('[projects.provision] codebase analysis failed:', err);
      analysisWarning = clientSafeCaughtErrorText(err, 'codebase analysis failed — retry provisioning');
    }
  }

  // Re-stamp the denormalised cache columns on BOTH `projects` and the
  // primary repository's `repositories.container_name` inside the same
  // tx. /quality and other readers join through project_repositories to
  // repositories.container_name, so if we only update projects the join
  // continues to render the pre-provision placeholder. Extends the
  // provision flow to mirror the handlePromoteProjectRepository
  // transactional re-stamp pattern.
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(projects)
      .set({
        container_name: provisionedName,
        repository_provisioned: true,
        graph_initialized: graphInitialized,
        updated_at: new Date(),
      })
      // Self-protecting WHERE (#402): owner_id is redundant with the
      // loadTenantScopedProject gate above today, but keeps the mutation safe
      // if that gate is ever refactored away.
      .where(projectWriteSelfScope(user, projectId))
      .returning();
    if (!rows[0]) {
      throw new NotFoundError('Project not found');
    }

    // EVERY attached repo, not just the primary. A coordinated multi-repo
    // workspace is ONE container holding N checkouts, so N repositories share
    // `provisionedName`; stamping only the primary left repos 2..N carrying the
    // pre-provision placeholder, and /quality and friends join through
    // project_repositories -> repositories.container_name, so those rows
    // rendered the stale name forever.
    //
    // Safe to widen here: `primaryRepo` was read for this UPDATE and nothing
    // else — no later step in this transaction or in the handler needs exactly
    // one row (the response is built from `rows[0]` of the `projects` update
    // above), so there is no single-row assumption to break.
    const attachedRepos = await tx
      .select({ repo_id: projectRepositories.repo_id })
      .from(projectRepositories)
      .where(eq(projectRepositories.project_id, projectId));

    if (attachedRepos.length > 0) {
      await tx
        .update(repositories)
        .set({
          container_name: provisionedName,
          updated_at: new Date(),
        })
        .where(
          inArray(
            repositories.id,
            attachedRepos.map((r) => r.repo_id),
          ),
        );
    }

    return rows;
  });

  return jsonResponse({
    ...updated,
    graph_init_warning: graphInitWarning,
    analysis_warning: analysisWarning,
  });
}

// GET /api/projects/:id/status - Get project status
export async function handleGetProjectStatus(req: Request, projectId: string): Promise<Response> {
  const user = await validateAuth(req);

  // READ lane: cross-tenant for a super-admin in HOME view only.
  // ⛔ The mutating handlers in this file stay on `loadTenantScopedProject`.
  const project = await loadProjectForRead(db, user, projectId);

  // The SAME derivation GET /api/projects/:id uses, so the two can never
  // disagree: the stored column is only 'delivered' once the reconcile worker
  // has stamped it, and this route would otherwise answer `active` for a
  // project whose detail read says `delivered` (services/project-delivered.ts).
  const [state] = (await projectStatesFor([project])).values();
  const status = deliveryFromRm(project, state?.ok ? state.state : undefined).status;

  return jsonResponse({
    project_id: project.id,
    status,
  });
}

// PATCH /api/projects/:id — NO human (or other fr-side) edit of an RM-owned
// project field after the request (George 2026-10-13, v4 D15/R16).
//
// ⭐ requirements_management owns the project after the request and ONLY the PM
// (n8n) writes it. Every field this route used to write lives in RM: name
// (RM `title`), description, priority (RM `priority_level_id`), question_mode,
// programme_id, branch (RM `repositories[].branch`) and shape (RM intake) — so
// this route writes NONE of them, to fr or to RM, for any caller (the old
// conveyor-priority { priority, rule } lane included: the PM sets an RM
// project's priority in RM itself). A body naming one is refused 422
// `rm_owned_field` with `fields` — input-contract validation, not judging.
//
// What stays editable here: NOTHING. fr keeps no human-editable project field
// that is not RM's (the fr-only `project_data` keys — tenancy tag, RM link,
// bug_hunt / cve_sweep / it_flow / fixture / requestor — are server-built and
// were never PATCH-able). The route stays registered: an empty body is a
// scoped no-op that answers the project row (the same 404 for a project out of
// scope), so a caller probing it learns nothing new.
export const RM_OWNED_PROJECT_FIELD = 'rm_owned_field';
/** Body keys PATCH /api/projects/:id refuses as RM-owned (RM's title/intake/brief/state). */
export const RM_OWNED_PATCH_KEYS: ReadonlySet<string> = new Set([
  'name',
  'title',
  'description',
  'branch',
  'programme_id',
  'question_mode',
  'priority',
  'priority_level_id',
  'shape',
  'status',
  'project_type',
  'project_type_id',
  'phase',
  'project_phase',
  'brief',
  'repository_url',
  'scope_level',
  'coordination_mode',
  ...RM_ONLY_PROJECT_DATA_KEYS,
]);

/** The (empty) editable PATCH body: strict, so any other key is a plain 422. */
export const PatchProjectBodySchema = z.object({}).strict();

export async function handlePatchProject(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const owned = Object.keys(raw as Record<string, unknown>).filter((k) => RM_OWNED_PATCH_KEYS.has(k)).sort();
    if (owned.length > 0) {
      throw new ValidationError(
        `requirements_management owns ${owned.join(', ')} after the project request; only the PM writes ${owned.length === 1 ? 'it' : 'them'} — fr accepts no edit`,
        { code: RM_OWNED_PROJECT_FIELD, fields: owned },
      );
    }
  }
  PatchProjectBodySchema.parse(raw);
  // Existence + ownership check leaks nothing: the same 404 as handleGetProject
  // for a cross-tenant or unknown id. Nothing is written.
  const project = await loadTenantScopedProject(db, user, projectId);
  return jsonResponse(project);
}

// GET /api/projects/:id/phase — the macro phase rail's data.
//
// Returns the project's current lifecycle phase plus the projected rail nodes
// (done/active/gate/upcoming) and the next gated phase. ⭐ RM OWNS THE PHASE
// (George 2026-10-13; n8n is the only writer): the phase, its stamp and the
// project's type are read from the project's RM pm_project
// (services/catalogue/project-state.ts), and the phases are the ORDERED phases
// of that RM type with RM's titles and `has_gate` — fr's own project_phase /
// project_type columns are not read. A new project is in phase `setup` (RM sets
// it at create — v4 D16), the first phase of every startable type, so it
// renders like any other phase (`setup` active, the rest upcoming). `phase:
// null` is only a DEFENSIVE fallback (a row RM holds no phase for): every node
// pending, next_gate from the start of the list. Any tenant-scoped viewer of the project may read it. A recorded phase
// that is not one of the type's phases answers an empty rail (never an
// invented position).
export async function handleGetProjectPhase(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // READ lane: cross-tenant for a super-admin in HOME view only.
  // ⛔ The mutating handlers in this file stay on `loadTenantScopedProject`.
  const project = await loadProjectForRead(db, user, projectId);
  const state = await projectTypeAndPhase(project);
  const phase = state.phase;

  // fr#1482: a PLAN project's rail is its plan's phases (server-projected from
  // the stored plan, labelled with the tenant's RM titles). Same keys as the
  // legacy answer; a plan whose phases cannot place the current phase answers
  // an empty rail.
  if (project.template_id) {
    const plan = await loadPlanForRail(projectId);
    const nodes = 'unresolvable' in plan ? null : planRailNodes(plan.plan, phase, plan.labels);
    return jsonResponse({
      project_id: projectId,
      phase,
      phase_updated_at: state.phaseUpdatedAt,
      next_gate: 'unresolvable' in plan ? null : planNextGate(plan.plan, phase),
      nodes: nodes ?? [],
    });
  }

  const phases = await phasesOfState(state);
  return jsonResponse({
    project_id: projectId,
    phase,
    phase_updated_at: state.phaseUpdatedAt,
    next_gate: nextGate(phases, phase),
    nodes: railNodes(phases, phase) ?? [],
  });
}

// GET /api/projects/:id/brief — system read of a project's project-start brief.
//
// System-only (X-Webhook-Secret), mirroring the PATCH /phase seam: the project-
// start analysis orchestration (n8n) runs as the system and needs the project's
// problem/outcome framing to build a *contexted* decomposition. The doing-cell
// dispatch only carries router fields (card_id/card_type/tenant), not the brief,
// so the orchestration fetches it here by project_id. No tenant scoping — the
// system owns every project's lifecycle (same rationale as the phase stamp).
// Returns only the brief fields the orchestration consumes.
//
// JWT lane (typed n8n op `projects.getProjectBrief`): with no X-Webhook-Secret
// header the caller authenticates with a bearer token and is scoped EXACTLY as
// `GET /api/projects/:id` scopes it (`selectProjectVisibleToGetProject`, one
// shared query). That route already returns the whole row, `project_data`
// included, so this lane hands a caller a SUBSET of what it can already read —
// it grants no new visibility. Anything that route 404s, this 404s.
export async function handleGetProjectBrief(
  req: Request,
  projectId: string,
): Promise<Response> {
  let project: typeof projects.$inferSelect | undefined;
  if (req.headers.get('X-Webhook-Secret') !== null) {
    validateWebhookSecret(req);
    // The system read stays unscoped, but a non-UUID id never reaches the uuid
    // column (it would 500 on 22P02); it is the same 404 as a missing row.
    if (isUuidShape(projectId)) {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      project = rows[0];
    }
  } else {
    const user = await validateAuth(req);
    project = await selectProjectVisibleToGetProject(user, projectId);
  }
  if (!project) throw new NotFoundError('Project not found');

  // Same three keys as GET /api/projects/:id, from
  // the same loader. ⛔ `repository_url` / `branch` above are RETAINED.
  const repoSet = await loadProjectRepositories(project.id);
  // RM owns the project's type AND its brief (George 2026-10-13: the brief is
  // RM's versioned record; fr keeps no copy). Read FRESH — a conveyor version
  // written straight to RM must be what n8n frames from next. A failed read
  // FAILS this read (503 rm_brief_unavailable): a null brief would misframe
  // every agent, and fr has nothing local to fall back on.
  let rmState: Awaited<ReturnType<typeof freshProjectState>>;
  try {
    rmState = await freshProjectState(project);
  } catch (err) {
    throw rmBriefRefusal(err) ?? err;
  }
  const pd = frIntakeFieldsFromRm(rmState.pm);
  return jsonResponse({
    project_id: project.id,
    name: project.name,
    project_type: rmState.projectType,
    repository_url: project.repository_url,
    branch: project.branch,
    repositories: repoSet.repositories,
    repo_count: repoSet.count,
    coordination_mode: project.coordination_mode,
    // Which RM brief version this is (null = RM holds no brief yet — a legacy
    // project the backfill has not reached).
    brief_version: rmState.pm.brief_version ?? null,
    brief_author_kind: rmState.pm.brief_author_kind ?? null,
    brief_updated_at: rmState.pm.brief_updated_at ?? null,
    problem_statement: pd.problem_statement ?? null,
    desired_outcome: pd.desired_outcome ?? null,
    business_case: pd.business_case ?? null,
    acceptance_criteria: Array.isArray(pd.acceptance_criteria)
      ? pd.acceptance_criteria
      : [],
    success_criteria: Array.isArray(pd.success_criteria)
      ? pd.success_criteria
      : [],
    target_packages: Array.isArray(pd.target_packages)
      ? pd.target_packages
      : [],
    // ⚠️ `artifacts` is not intake and RM does not hold it: it is written by NO
    // fr door either (kept because n8n may destructure it — an absent key and
    // an empty array fail differently), so it stays fr's own project_data key.
    artifacts: Array.isArray((project.project_data as Record<string, unknown> | null)?.artifacts)
      ? ((project.project_data as Record<string, unknown>).artifacts as unknown[])
      : [],
    scope_level: project.scope_level ?? null,
    // `constraints_text` is the rendered form (an agent reads prose); the
    // structured array is what the landing gate checks against.
    constraints: Array.isArray(pd.constraints) ? pd.constraints : [],
    constraints_text: renderConstraintsForBrief(pd.constraints),
    dependencies: Array.isArray(pd.dependencies) ? pd.dependencies : [],
    risks: Array.isArray(pd.risks) ? pd.risks : [],
    // stakeholders / approvers / deadline / budget / notes — RM brief keys the
    // project page shows; present only when RM holds a value.
    ...Object.fromEntries(
      (['stakeholders', 'approvers', 'deadline', 'budget', 'notes', 'access_requirements'] as const)
        .filter((k) => pd[k] !== undefined)
        .map((k) => [k, pd[k]]),
    ),
    // in_scope / out_of_scope / high_level_requirements / assumptions —
    // each key is present ONLY when it has content (see scopeFieldsForBrief).
    ...scopeFieldsForBrief(pd),
  });
}

/**
 * The visibility of a brief-version read: exactly GET /api/projects/:id's
 * (`selectProjectVisibleToGetProject`), plus the system webhook lane.
 */
async function projectForBriefRead(req: Request, projectId: string) {
  if (req.headers.get('X-Webhook-Secret') !== null) {
    validateWebhookSecret(req);
    if (!isUuidShape(projectId)) return undefined;
    const rows = await db.select().from(projects).where(eq(projects.id, projectId));
    return rows[0];
  }
  return await selectProjectVisibleToGetProject(await validateAuth(req), projectId);
}

/**
 * GET /api/projects/:id/brief/versions — the brief's RM versions, newest first,
 * without the snapshots: `{ data: { versions: [{version, author_kind,
 * author_subject_id, note, created_at}], total, current_version } }`.
 */
export async function handleListProjectBriefVersions(req: Request, projectId: string): Promise<Response> {
  const project = await projectForBriefRead(req, projectId);
  if (!project) throw new NotFoundError('Project not found');
  try {
    const { state, versions } = await listProjectBriefVersions(project);
    return jsonResponse({
      data: { versions, total: versions.length, current_version: state.pm.brief_version ?? null },
    });
  } catch (err) {
    throw rmBriefRefusal(err) ?? err;
  }
}

/** GET /api/projects/:id/brief/versions/:version — one full RM brief snapshot. */
export async function handleGetProjectBriefVersion(
  req: Request,
  projectId: string,
  versionParam: string,
): Promise<Response> {
  if (!/^[1-9]\d{0,8}$/.test(versionParam)) throw new NotFoundError('Brief version not found');
  const project = await projectForBriefRead(req, projectId);
  if (!project) throw new NotFoundError('Project not found');
  try {
    return jsonResponse({ data: await getProjectBriefVersion(project, Number(versionParam)) });
  } catch (err) {
    if (isIntegrationError(err) && err.upstreamStatus === 404) throw new NotFoundError('Brief version not found');
    throw rmBriefRefusal(err) ?? err;
  }
}

/**
 * GET /api/projects/:id/capabilities — R271: the capabilities the PM selected
 * for the project (R260, rm#225) and why, plus the selection history, READ-ONLY.
 * fr is a facilitator: it displays what the PM decided and has NO write path
 * (RM's PUT is PM_ONLY; fr never calls it). Visibility exactly as
 * GET /api/projects/:id (or the system webhook lane), like the brief reads.
 *
 * `{ data: { project_type, selected: [{name, capability_id, reason, approval_id,
 * selected_at}], implicit, events: [{id, added, removed, approval_id,
 * subject_id, created_at}], total_events } }`. A project the PM has not selected
 * for yet (every pre-R260 project) answers `selected: []`, `events: []` — an
 * EMPTY selection, which is a real answer; an RM failure is 503
 * `rm_capabilities_unavailable`, never an empty list.
 */
export async function handleGetProjectCapabilities(req: Request, projectId: string): Promise<Response> {
  const project = await projectForBriefRead(req, projectId);
  if (!project) throw new NotFoundError('Project not found');
  try {
    const { capabilities, events } = await projectCapabilities(project);
    return jsonResponse({
      data: {
        project_type: capabilities.project_type ?? null,
        selected: Array.isArray(capabilities.selected) ? capabilities.selected : [],
        implicit: Array.isArray(capabilities.implicit) ? capabilities.implicit : [],
        events,
        total_events: events.length,
      },
    });
  } catch (err) {
    if (!isIntegrationError(err)) throw err;
    if (err.upstreamStatus === 404) throw new NotFoundError('Project not found');
    throw new AppError(
      503,
      "the project's capability selection is stored in requirements_management, which is unavailable — retry",
      { upstream_status: err.upstreamStatus ?? null },
    ).withCode('rm_capabilities_unavailable');
  }
}

/**
 * An RM refusal of a brief READ, as fr's answer (passed through; fr writes no
 * brief after create — D15/R16):
 *   409 — RM's conflict, its `code` kept;
 *   422 / 400 — RM's validation, its `code` kept;
 * An RM outage is 503 `rm_brief_unavailable`. A 404 is the caller's. Anything
 * else is not RM's.
 */
function rmBriefRefusal(err: unknown): AppError | null {
  if (!isIntegrationError(err)) return null;
  const status = err.upstreamStatus;
  const detail = (err.upstreamBody as { detail?: unknown } | undefined)?.detail ?? null;
  const code = typeof (detail as { code?: unknown } | null)?.code === 'string' ? (detail as { code: string }).code : null;
  const message =
    typeof (detail as { message?: unknown } | null)?.message === 'string'
      ? (detail as { message: string }).message
      : typeof detail === 'string'
        ? detail
        : null;
  if (status === 409) {
    return new AppError(409, message ?? 'requirements_management refused the request (conflict)', {
      upstream_status: 409,
      upstream_detail: detail,
    }).withCode(code ?? 'rm_conflict');
  }
  if (status === 422 || status === 400) {
    return new ValidationError(message ?? 'requirements_management refused the brief', {
      code: code ?? 'rm_validation_failed',
      upstream_status: status,
      upstream_detail: detail,
    });
  }
  if (status === 404) return null;
  return new AppError(
    503,
    'the project brief is stored in requirements_management, which is unavailable; nothing was changed — retry',
    { upstream_status: status ?? null },
  ).withCode('rm_brief_unavailable');
}

// (PUT /api/projects/:id/brief is RETIRED — George 2026-10-13, D15/R16: the
// brief is read-only after create. v1 is the user's create; every later version
// is the PM's, written to requirements_management directly; fr only displays.)
