// src/types/api.ts
import { z } from "zod";
import {
  ProjectConstraintSchema,
  ProjectDependencySchema,
} from "./project-constraints";

import { ScopeLevelSchema } from "./scope-level";
import { QuestionModeSchema } from "./question-mode";
import { CardPrioritySchema } from "../services/improvement-cards/request-schema";
// Value import of the `asset_type` pgEnum. db/schema.ts has a 5-module runtime
// closure (custom-types, knowledge-areas, card-types + its JSON) that does NOT
// reach types/ — so this is not the circular import the old comment feared.
// Deliberately NOT db/client.ts (that opens a pool) and NOT routes/.
import { assetType } from "../db/schema";

// Common
export const ErrorResponseSchema = z.object({
  error: z.string(),
  details: z.any().optional(),
});

export const SuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

// User (from Keycloak JWT)
export interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  tenantId: string;
  /**
   * Department id from the JWT `dept_id` claim. Optional — present only
   * when the Keycloak user-attribute → access-token claim mapper has been
   * deployed (gitops realm-portal-configmap). Used by streams.policy
   * `dept-manager` gate.
   */
  deptId?: string;
  avatar_url?: string;
  /**
   * Legible tenant display name from the JWT `tenant_name` claim. Optional —
   * Keycloak only emits this once the realm migration lands; until then
   * this is `null` and callers must rely on `tenantId` alone.
   */
  tenantName?: string | null;
  /**
   * The RAW `tenant_id` claim, set only when the token carries it as a
   * non-empty string. Distinct from `tenantId`, which `deriveTenantId` falls
   * back to `sub` for. Authorization that pins to the claimed tenant (the
   * realm `tenant_admin` arm, `services/user-roles.ts :: isRealmTenantAdminOf`)
   * must read THIS field so a claim-less token fails closed.
   */
  tenantClaim?: string;
  /**
   * Actor kind, set ONLY by `keycloak.validateToken` from the verified claims
   * (`utils/tenant.ts isServiceAccountClaims`): `true` for a CLIENT-CREDENTIALS
   * service account, `false` otherwise (password-grant operators included).
   * Absent on a `User` built elsewhere. Read by the priority audit
   * (`lib/priority-change.ts actorKind` → priority_change_events.actor_kind).
   */
  isServiceAccount?: boolean;
  /**
   * The verified `preferred_username` claim, set ONLY by
   * `keycloak.validateToken` (and the dev-only AUTH_BYPASS identity). Recorded
   * by the priority audit (priority_change_events.actor_username): the `name`
   * claim is empty for the conveyor's operator accounts, so the username is
   * the only legible identity of an automation actor.
   */
  username?: string;
  /**
   * The verified `azp` (authorized party — the Keycloak client the token was
   * issued to), set ONLY by `keycloak.validateToken`. Read by
   * `lib/priority-change.ts isConveyorActor`, together with `username` and the
   * realm `roles`. ⚠️ Never key on a `client_id` claim: Keycloak does not
   * guarantee one on a client-credentials token; `azp` is always present.
   */
  azp?: string;
  /**
   * The VERIFIED token issuer (one of KEYCLOAK_TRUSTED_ISSUERS), set ONLY by
   * `keycloak.validateToken`. Unset for AUTH_BYPASS / licence callers / test
   * fakes. The service doors pin it per client (FR_BRIDGE_ISSUER,
   * FR_CONVEYOR_ISSUER) — realm-per-app F1.
   */
  issuer?: string;
  /** The Keycloak realm of `issuer`. */
  realm?: string;
  /**
   * George 2026-10-27: is this an fr super-admin session (fr realm issuer + fr browser client, a
   * human)? Set ONLY by `keycloak.validateToken`, from the SIGNED claims, by the ONE classifier
   * `superAdminSessionTrustFromClaims` (lib/super-admin-session-trust.ts). Absent ⇒ untrusted.
   */
  superAdminSessionTrust?: import('../lib/super-admin-session-trust').SuperAdminSessionTrust;
  /**
   * How this user authenticated. `'licence'` = a non-JWT licence token
   * verified by the licences service (`lib/licence-introspect.ts`): tenant
   * PINNED to the introspected `tenant_id`, NO realm roles. Absent for a
   * Keycloak JWT (and the AUTH_BYPASS identity) — routes that must tell the
   * two apart key on `authKind === 'licence'`.
   */
  authKind?: 'licence';
  /**
   * Licence callers only: the licences service's own `Subject.id`
   * (introspected `subject_id`) — NOT a Keycloak sub. This is what licences /
   * inference-router expect in `X-Subject-Id` (fr#1052). `id` above is
   * `subject_keycloak_sub ?? subject_actor_sub ?? subject_id`.
   */
  licenceSubjectId?: string;
  /** Licence callers only: the introspected `license_id`. */
  licenseId?: string;
}

// Repository
//
// ⭐ `name` STAYS OPTIONAL ON THE WIRE, DELIBERATELY. A repository name can
// ALWAYS be resolved from the repository url (`owner/repo`), so requiring it
// here would 422 a caller for omitting something the server can compute — and
// it would have to be required in four schemas plus the frontend mirror
// (`frontend/src/lib/types/api.ts`), which is the two-emitter divergence this
// file already warns about below. What IS enforced:
//   · optional-but-never-blank here (`.trim().min(1)`) — an EXPLICIT '' or
//     '   ' is a 422, not a silently stored blank;
//   · a non-blank value guaranteed before every DB write by
//     `lib/repository-name.ts :: resolveRepositoryName` (all four insert paths);
//   · `NOT NULL` + `CHECK (btrim(name) <> '')` in migration 133 — the hard
//     constraint, so a future insert path that forgets the helper fails loudly
//     instead of writing blank.
export const RepositoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  url: z.string().min(1),
  branch: z.string().optional().default("main"),
  path: z.string().optional(),
  description: z.string().optional(),
  secret_id: z.string().uuid().optional(),
});

export const RepositoryUpdateSchema = z.object({
  // Optional (a PATCH-shaped body omits what it does not change) but never
  // blank: an explicit '' / '   ' on update is the other way a name went blank,
  // and handleUpdateRepository writes `name` whenever it is not `undefined`.
  name: z.string().trim().min(1).max(255).optional(),
  url: z.string().min(1).optional(),
  branch: z.string().optional(),
  path: z.string().optional(),
  description: z.string().optional(),
  secret_id: z.string().uuid().nullable().optional(),
});

export type RepositoryCreate = z.infer<typeof RepositoryCreateSchema>;
export type RepositoryUpdate = z.infer<typeof RepositoryUpdateSchema>;

// Project ↔ Repository membership (migration 072 / task #25 scope B PR 2).
//
// Discriminator-free body: `repo_id` attaches an existing repository the
// caller owns; otherwise the create-or-attach path upserts a repositories
// row owned by the caller (ON CONFLICT (user_id, url) keeps it idempotent)
// before linking. `is_primary` defaults to false because the very first
// attach against a project that ALREADY has a primary (the backfilled
// row) must not silently demote it; promote-to-primary is its own route.
export const ProjectRepositoryAttachSchema = z
  .object({
    repo_id: z.string().uuid().optional(),
    url: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    // `.trim()` before `.min(1)`: '   ' passed the old check and was stored.
    name: z.string().trim().min(1).max(255).optional(),
    is_primary: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.repo_id) || Boolean(v.url), {
    message: "either repo_id or url is required",
  });

export type ProjectRepositoryAttach = z.infer<
  typeof ProjectRepositoryAttachSchema
>;

export const ProjectRepositoryListItemSchema = z.object({
  repo_id: z.string().uuid(),
  url: z.string(),
  branch: z.string().nullable(),
  name: z.string().nullable(),
  container_name: z.string().nullable(),
  is_primary: z.boolean(),
  added_at: z.string(),
});

export type ProjectRepositoryListItem = z.infer<
  typeof ProjectRepositoryListItemSchema
>;

// Asset kinds — single-sourced from the `asset_type` pgEnum (migration 030),
// the same source src/routes/assets/bindings.ts ASSET_KINDS derives from.
// Derived from db/schema.ts rather than routes/ to keep types/ below routes/.
export const PROJECT_BOUND_ASSET_KINDS = assetType.enumValues;

// Per-kind asset-id arrays the project creation form sends. Each kind is
// optional; an empty/missing kind means "no bindings of this kind". The
// values are pass-through asset ids (string-typed because upstream id
// formats vary — uuid for most, slugged-name for procedures).
export const BoundAssetsSchema = z
  .object(
    Object.fromEntries(
      PROJECT_BOUND_ASSET_KINDS.map((k) => [
        k,
        z.array(z.string().min(1)).optional(),
      ]),
    ) as Record<
      (typeof PROJECT_BOUND_ASSET_KINDS)[number],
      z.ZodOptional<z.ZodArray<z.ZodString>>
    >,
  )
  .strict();

export type BoundAssets = z.infer<typeof BoundAssetsSchema>;

// Milestone sub-schema. EXPORTED for the same reason as
// OutlineDeliverableSchema: the promote path re-validates the milestones jsonb
// it reads off the approved outline before writing `project_milestones`.
export const MilestoneSchema = z.object({
  name: z.string(),
  target_date: z.string().optional(),
});

// Risk sub-schema
const RiskSchema = z.object({
  description: z.string(),
  likelihood: z.string().optional(),
  impact: z.string().optional(),
  mitigation: z.string().optional(),
});

// (PUT /api/projects/:id/brief and its ProjectBriefUpdateSchema are RETIRED —
// George 2026-10-13, D15/R16: the brief is read-only in fr after create; every
// later version is the PM's, written to requirements_management directly.)

// Project
// ⛔ CULLED 2026-09-23 — DO NOT ADD THESE BACK WITHOUT A NAMED READER:
// `env_placeholders`, `data_classification`, `target_environment`, `resourcing`,
// `key_deliverables` had ZERO readers — they reached projects.project_data via
// the rest destructure in routes/projects.ts and stopped there. `effort_estimate`
// and `milestones` are SUPERSEDED, not dead: migration 127 moved them to Stage B
// as projects.approved_effort_estimate and the project_milestones table, where
// the agent proposes and a human approves. A user cannot author either before
// anyone has read the repository.
// ⚠️ MilestoneSchema SURVIVES this cull — ProjectOutlineSchema still uses it and
// promoteProjectRequest (routes/project-requests.ts:705) re-validates the
// outline's milestones jsonb through it. The key going away is not the schema
// going away.
// ⚠️ Zod STRIPS unknown keys, so a project_data row stored before this cull still
// parses; it simply keeps its old content. No data migration was run, by design.
// The mirror is frontend/src/lib/types/api.ts — a key deleted in one file and not
// the other is the two-emitter defect this repo keeps hitting. Change BOTH.
// ⚠️ `ProjectCreateSchema` below is now a plain ALIAS of this object. It used to
// be this object wrapped in the repo↔scope coherence refines, which is why the
// split existed at all (zod 3 `.refine()` returns a ZodEffects, which has no
// `.extend()` / `.partial()`). Those refines were DELETED 2026-09-30 — see the
// tombstone above `ProjectCreateSchema` — so the two names now validate
// identically. Keep parsing whole create bodies through `ProjectCreateSchema`:
// it is the name every door already reads, and it is where a future whole-body
// rule would land.
/**
 * Rewrite-project vocabulary, mirrored from RM `src/schemas/pm_intake.py`
 * (`RepositoryRole`, `TargetLanguage`, the 40-hex `sha` validator). FORMAT checks
 * only; RM owns the rewrite rules (≥1 source, each pinned; exactly one target, and
 * it is the primary; language set).
 */
export const RepositoryRoleSchema = z.enum(["source", "target"]);
export const RewriteLanguageSchema = z.enum(["python", "rust"]);
/** A full commit sha: exactly 40 hex characters (RM stores it lowercase). */
export const CommitShaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/, "sha must be a full 40-character commit hash");

/**
 * A repository PIN (George 2026-11-07): the exact version of the repository the
 * project takes as input. A full 40-hex commit SHA, a GitHub pull request number
 * (`123` / `#123`) or a GitHub PR URL. A PR is RESOLVED to its `head.sha` by
 * `services/repository-pins.ts` at create, so RM's `ProjectRepository.sha` contract
 * stays a 40-hex commit and every existing consumer (the rewrite flows) is unchanged.
 */
export const PIN_SHA_RE = /^[0-9a-fA-F]{40}$/;
export const PIN_PR_NUMBER_RE = /^#?\d{1,10}$/;
export const PIN_PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d{1,10}\/?$/i;
export const PIN_MESSAGE =
  "pin must be a full 40-character commit hash, a PR number (#123), or a GitHub pull request URL";
export const RepositoryPinSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (v) => PIN_SHA_RE.test(v) || PIN_PR_NUMBER_RE.test(v) || PIN_PR_URL_RE.test(v),
    { message: PIN_MESSAGE },
  );

/**
 * Which conveyor sign-offs the user is asked for (George 2026-10-27), mirrored from
 * RM `src/schemas/pm_intake.py` `ApprovalMode`:
 *   'all'               → every approval is asked
 *   'auto_drafts'       → start-draft confirmations are auto-accepted
 *   'brief_and_closure' → only the brief sign-off and the project-closure sign-off (fr's default, see DEFAULT_APPROVAL_MODE)
 *   'autonomous'        → nothing is asked
 * Stored ONLY on the RM project (`it_inputs.approval_mode`); n8n reads it there.
 */
export const APPROVAL_MODES = ["all", "auto_drafts", "brief_and_closure", "autonomous"] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/**
 * The approval mode fr stores on RM when a create carries none (George 2026-10-31,
 * design R329): only the brief and the closure sign-off ask a person; everything in
 * between auto-approves. fr still always sets it, so the stored mode never depends on
 * the n8n fallback for an unset value.
 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "brief_and_closure";

export const ProjectCreateFields = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  // OPTIONAL (George 2026-10-13): a project need not have a repository. Missing or
  // null = no repo; repo-dependent features treat that as not applicable. The CP
  // sentinel (FR_REPO_SENTINEL) still parses here and is refused by the approve /
  // submit gates when it is PROVIDED.
  repository_url: z.string().url().nullish(),
  branch: z.string().default("main"),

  // Extended fields (all optional at Zod level; frontend enforces required)
  project_type: z.string().optional(),
  // Validated against the ONE canonical vocabulary (types/scope-level.ts). This
  // was `z.string().optional()`, which let 'single_repo' / 'small' through the
  // door and then 400'd every downstream approval card. Fail at the door instead.
  scope_level: ScopeLevelSchema.optional(),
  // A level of the owner tenant's RM priority levels. The create doors refuse a
  // bad value as 400 invalid_priority BEFORE this parse
  // (lib/priority-change.ts refuseInvalidCreatePriority); a given value goes to
  // RM (priority_level_id — fr keeps no project_data copy) and is audited once
  // (null → value) by routes/projects.ts createSingleProject.
  priority: CardPrioritySchema.optional(),
  // SPEC.md lifecycle-class enum — orthogonal to project_type (which is
  // the delivery-shape categorisation). n8n's project-start workflow keys
  // off this to pick the right card_type set. Flows into project_data
  // JSONB on persist; never a dedicated column for v1.
  lifecycle_class: z
    .enum(["system", "workflow-improvement", "execution", "prompt-improvement"])
    .optional(),

  // How the project's repositories relate to one another — the declaration a
  // multi-repo project makes about itself, and the ONLY input the conveyor has
  // for that question (it is NOT derivable from repo count, which says how many
  // there are and nothing about whether they move together):
  //   'coordinated' (default) → one product worked across N repos; changes are
  //                             planned, reviewed and landed as one unit.
  //   'independent'           → N separate workstreams that happen to share a
  //                             project; each repo progresses on its own.
  // ⚠️ Orthogonal to `scope_level`, which is a GRANULARITY vocabulary
  // (multi_repo…function) and is DERIVED from repo count, not asked. Do not
  // re-couple the two.
  // Defaulted, not optional-at-output, to match the NOT NULL DEFAULT
  // 'coordinated' column in db/schema.ts (`projects.coordination_mode`, with a
  // CHECK on the same two values) — so a body that omits it persists the same
  // value the database would have chosen, and no reader needs a fallback.
  // Mirror: `ProjectCreate.coordination_mode` in frontend/src/lib/types/api.ts.
  coordination_mode: z.enum(["coordinated", "independent"]).default("coordinated"),

  // Programme coordination (D6/3C). Optional parent-programme link for a
  // DELIVERY project — the pmProgrammes asset id that groups this repo-owning,
  // orchestrating project with its siblings. The planning-plane PM-asset
  // "project" already carries programme_id (requirements service); this brings
  // the same grouping to the delivery projects that actually own repos + fire
  // n8n, so N of them can be coordinated under one Programme. Flows into
  // project_data JSONB on persist (never a dedicated column; mirrors
  // lifecycle_class/it_flow) and is filterable via GET /api/projects?programme_id=.
  programme_id: z.string().uuid().optional(),

  // IT_MVP flow selector for EXEC-tenant `it` projects. Picks which analysis
  // card the project_setup card spawns next (IT_MVP_SUBSPEC Flows 1/2/3):
  //   'dependency' (default, absent) → development_chore   (Flow 1)
  //   'security'                     → security_analysis   (Flow 2, → development_security_patch)
  //   'source-security'              → security_analysis   (Flow 2s, → development_source_security_patch; SAST/bandit)
  //   'iac'                          → security_analysis   (Flow 2i, → development_iac_security_patch; trivy-config)
  //   'bug'                          → bug_analysis        (Flow 3, → development_bug_fix)
  //   'refactor'                     → architecture_refactoring (Flow 4, carries
  //                                    target_files + test_command, NOT target_packages)
  // 'security' / 'source-security' / 'iac' all share the security_analysis card;
  // its doing.action scans profile-aware (scanContainerDependencies for security,
  // scanContainerSecurity for source-security/iac, keyed on dispatch_context.it_flow),
  // and AA Pattern - Done Finalize routes the analysis→patch hop by it_flow.
  // Flows into project_data JSONB on persist (never a dedicated column); n8n's
  // AA Pattern - Done Finalize reads project_data.it_flow at the project_setup
  // spawn step. Absent ⇒ Flow 1, so existing dependency-upgrade projects are
  // byte-identical.
  //   'rewrite'                      → rewrite the code in another language: the
  //                                    `role: "source"` repositories (each pinned to
  //                                    a commit `sha`) are read, the one
  //                                    `role: "target"` repository (the primary) is
  //                                    written; `brief.target_language` is the target
  //                                    language (extracted from the request at create —
  //                                    George 2026-11-07 — when the caller omits it).
  // fr checks FORMAT only for 'rewrite' (George: fr is a facilitator, never a
  // judge): RM decides whether the repository set is a valid rewrite.
  it_flow: z
    .enum(["dependency", "security", "source-security", "iac", "bug", "refactor", "rewrite"])
    .optional(),

  // A rewrite's target language is NOT an IT input any more: it is a fact about the
  // REQUEST, so it lives on the BRIEF (`target_language`, George 2026-11-07) — see the
  // brief block above. `ApprovalMode` below is the only post-hoc it_inputs key left.

  // Approval mode (any project type): RM's `ItInputs.approval_mode`, mirrored BY
  // HAND from RM. RM-only (IT_INPUT_KEYS →
  // RM_ONLY_PROJECT_DATA_KEYS); absent ⇒ fr stores DEFAULT_APPROVAL_MODE
  // ('brief_and_closure') on RM (project-intake.ts rmItInputsOf).
  approval_mode: ApprovalModeSchema.optional(),

  // U3/A6 (fr#1388) — which QUESTION path the conveyor takes for this project:
  // 'structured' | 'free_text' (canonical list: types/question-mode.ts). Flows
  // into project_data JSONB via the `...extendedFields` rest-destructure; ncn
  // reads it via GET /api/projects/:id. Absent ⇒ 'free_text'. `null` is accepted
  // as "unset" and is NOT persisted (routes/projects.ts drops it), so the stored
  // key is only ever absent or one of the two values. Anything else — a typo, a
  // case variant like 'Structured', a number — is a 422 here, before any write,
  // instead of a BLOCKED card later. Same rule on PATCH /api/projects/:id.
  question_mode: QuestionModeSchema.nullable().optional(),

  // IT_MVP Flow 2/3 remediation inputs. Optional at intake; flow into project_data
  // JSONB via projects.ts `...extendedFields` (rest-destructure of the validated
  // body). AA Pattern - Done Finalize "Build Spawn Body" propagates them onto the
  // development_security_patch / development_bug_fix card brief, where the seeded
  // doing.action procedures read them as `dispatch_context.*` (see fr
  // backend/src/scripts/seed-it-procedures.ts). All absent ⇒ the consumer's safe
  // fallbacks apply, so Flow 1 / existing projects are unchanged.
  //   min_severity      → security scan floor (development_security_patch)
  //   test_command      → post-fix verification command, argv form (both types)
  //   test_workdir      → working dir for the test command
  //   bug_test_command  → the currently-failing test command, argv form (development_bug_fix)
  //   failing_test_ref  → identifier of the failing test (development_bug_fix)
  //   target_files      → files the remediation worker may edit
  //   finding_description → SAST/security finding text (development_security_patch)
  //   bug_description   → bug report text (development_bug_fix)
  // NOTE: test_command / bug_test_command are ARGV arrays (e.g.
  // ['/workspace/.venv/bin/python','-m','pytest','-q']) — the coding-gateway exec
  // is argv-only (no shell), and doing-orchestrate's dispatch_context keeps them as
  // arrays. A non-array value is ignored in favour of the pytest default.
  min_severity: z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL"]).optional(),
  test_command: z.array(z.string()).optional(),
  test_workdir: z.string().optional(),
  bug_test_command: z.array(z.string()).optional(),
  failing_test_ref: z.string().optional(),
  target_files: z.array(z.string()).optional(),
  finding_description: z.string().optional(),
  bug_description: z.string().optional(),

  // People & Roles
  requestor: z.string().optional(),
  // Self-declared TEST FIXTURE. Set true by an integration-test driver so fr
  // never mints a human sign-off for the project's cards
  // (lib/execution-signoff.ts isFixtureOrigin → SIGNOFF_BLOCK_REASONS.
  // FIXTURE_ORIGIN). Flows into project_data JSONB via the `...extendedFields`
  // rest-destructure in routes/projects.ts:424 — no column, no migration.
  //
  // This is the marker a NEW driver should set. The requestor allowlist
  // (FR_FIXTURE_REQUESTORS) exists because the 129 IT Flow1 projects already in
  // the database predate this field and can never carry it; the two are OR'd,
  // not AND'd, for exactly that reason.
  fixture: z.boolean().optional(),
  stakeholders: z.array(z.string()).optional(),
  approvers: z.array(z.string()).optional(),

  // Problem & Objectives
  problem_statement: z.string().optional(),
  desired_outcome: z.string().optional(),
  business_case: z.string().optional(),

  // Scope & Requirements
  success_criteria: z.array(z.string()).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  in_scope: z.array(z.string()).optional(),
  out_of_scope: z.array(z.string()).optional(),
  high_level_requirements: z.array(z.string()).optional(),
  // Rewrite (it_flow='rewrite') only. RM's `ProjectBrief.target_language` (mirrored by
  // hand like approval_mode). The FORM does not ask for it (George 2026-11-07): when a
  // rewrite create omits it, fr extracts the target language from the project request
  // (services/catalogue/target-language.ts) and fills it here, so it lands in brief v1.
  target_language: RewriteLanguageSchema.optional(),
  assumptions: z.array(z.string()).optional(),
  access_requirements: z.array(z.string()).optional(),

  // Repository & Environment
  //
  // `primary` is the project's denormalised primary repo (kept on
  // `projects.repository_url/branch/container_name` so existing readers
  // — AG-UI brief, coding adapter, head-sha resolver — don't change
  // shape). `additional` lets a project be created with extra repos
  // attached in the same transaction; each one becomes a non-primary
  // `project_repositories` row pointing at a `repositories` row resolved
  // by (caller user_id, url) ON CONFLICT.
  repo: z
    .object({
      primary: z.object({
        url: z.string(),
        branch: z.string().optional(),
        path: z.string().optional(),
        // Rewrite projects only (absent everywhere else, so other payloads are
        // unchanged): RM's ProjectRepository.role / .sha, passed through by
        // services/catalogue/project-intake.ts rmRepositoriesOf.
        role: RepositoryRoleSchema.optional(),
        sha: CommitShaSchema.optional(),
        // The exact version to take as input (any IT project, George 2026-11-07).
        // A commit SHA or a PR; resolved to `sha` before RM is called.
        pin: RepositoryPinSchema.optional(),
      }),
      additional: z
        .array(
          z.object({
            url: z.string().min(1),
            branch: z.string().min(1).optional(),
            // `.trim()` before `.min(1)` — see RepositoryCreateSchema.
            name: z.string().trim().min(1).max(255).optional(),
            role: RepositoryRoleSchema.optional(),
            sha: CommitShaSchema.optional(),
            pin: RepositoryPinSchema.optional(),
          }),
        )
        .optional(),
    })
    .optional(),

  // Secrets & Documents
  secret_ids: z.array(z.string().uuid()).optional(),
  document_ids: z.array(z.string().uuid()).optional(),
  repository_id: z.string().uuid().optional(),

  // Timeline & Risks
  deadline: z.string().optional(),
  // ⚠️ BOTH SHAPES, deliberately. Every project created before the typed
  // vocabulary (types/project-constraints.ts) carries string[], and the
  // redesigned form now sends the typed union. ProjectCreateSchema is the ENGINE
  // contract that both the direct create and request approval re-parse, so
  // accepting only the new shape would 422 every legacy request on approve, and
  // accepting only the old shape would 422 every new one. renderConstraintsForBrief
  // renders either kind into the agent brief.
  constraints: z.array(z.union([z.string(), ProjectConstraintSchema])).optional(),
  dependencies: z.array(z.union([z.string(), ProjectDependencySchema])).optional(),
  risks: z.array(RiskSchema).optional(),

  // Resources & Notes
  budget: z.string().optional(),
  notes: z.string().optional(),

  // Spec 2 §4 — project shape selector. Defaults to 'deliverable' to keep
  // backwards compatibility for clients that don't ship the field yet.
  // Switching shape after creation is rejected by handlePatchProject.
  shape: z.enum(["deliverable", "continuous_flow"]).default("deliverable"),

  // EXEC-tenant `it`-project pipeline: target packages to upgrade. Required when
  // project_type==='it' on the EXEC tenant; the project_start_request_analysis
  // workflow reads this to size the dep-upgrade work.
  target_packages: z
    .array(
      z.object({
        name: z.string().min(1),
        target_version: z.string().min(1),
      }),
    )
    .optional(),

  // EXEC-tenant `it`-project CVE sweep. When true, target_packages may be empty
  // and the development_chore doing step runs in DISCOVERY mode (upgradeCves —
  // coding-security scans with OSV.dev/pip-audit and bumps every dependency
  // carrying a fixable CVE at/above min_severity) instead of a targeted upgrade.
  cve_sweep: z.boolean().optional(),

  // EXEC-tenant `it` BUG HUNT (hunt mode of it_flow='bug'). When true the project
  // hunts for bugs without a known failing test: test_command (the repo's ordinary
  // suite command — it need not fail) is REQUIRED and bug_test_command is
  // FORBIDDEN. EXEC-only, never a fixture, branch must be a NAME (never sha-like).
  // Enforced by routes/projects.ts assertItExecIntakeInputs; one live hunt per
  // (tenant, repo) via assertNoLiveBugHuntProject + migration 163.
  bug_hunt: z.boolean().optional(),

  // Library assets the user picks at project-creation time. Each kind is
  // an optional array of upstream asset ids. The backend writes one
  // asset_bindings row per (kind, id) referencing the new project, and
  // — for EXEC-tenant `it` projects — embeds the same grouping inside
  // the project_start_request JSON brief on the intake card so n8n
  // receives the full library scope on project birth.
  bound_assets: BoundAssetsSchema.optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// ⛔ THE REPO ↔ SCOPE COHERENCE RULE IS DELETED (2026-09-30) — DO NOT RESTORE IT
// ═══════════════════════════════════════════════════════════════════════════
//
// `RepoScopeView`, `liveDoorRepoCount`, `multiRepoHasTwoRepos`,
// `manyReposNeedMultiRepo`, `withRepoScopeCoherence`, `MULTI_REPO_NEEDS_TWO_REPOS`
// and `MANY_REPOS_NEED_MULTI_REPO` were HERE and are GONE. The rule bound
// `scope_level` to repository count in BOTH directions: 'multi_repo' required
// ≥2 repos, and >1 repo required 'multi_repo'.
//
// ⛔ IT IS NOT RELAXED, IT IS WRONG. `scope_level` is a GRANULARITY vocabulary
// (multi_repo, repo, app, module, component, file, class, function — see
// types/scope-level.ts) and granularity is ORTHOGONAL to how many repositories a
// project names. The second direction therefore REFUSED the ordinary case of two
// repos at granularity 'module'. A rule whose false-positive is the common case
// cannot be tightened into correctness.
//
// `scope_level` is no longer asked for: it is DERIVED from repo count in
// routes/projects.ts as `explicit ?? (repoCount >= 2 ? 'multi_repo' : undefined)`.
// What a multi-repo project actually declares about itself is
// `coordination_mode` (above), which repo count cannot express.
//
// The two matching refines on `ProjectRequestSchema` (below) went with it; the
// `at most one repository may be primary` refine there is UNRELATED and stays.
// The frontend's third emitter, `coherenceError()` in
// components/project-request/RepositoryRepeater.svelte, is deleted too.

/**
 * project_type on the CREATE door: a type NAME, shape-checked only. The
 * vocabulary is the TENANT's requirements_management project types (design:
 * fr consumes RM vocabulary, George 2026-10-12) — there is no fr list. The
 * create engine (routes/projects.ts createSingleProject) validates the name
 * against the OWNING tenant's catalogue (services/catalogue/tenant-catalogue.ts):
 * an unknown name is 422 `project_type_unknown` carrying that tenant's list; a
 * tenant with no catalogue is 409 `catalogue_not_initialised`. The fields
 * schema (`ProjectCreateFields`) stays open as before, so a draft carrying a
 * legacy/LLM-invented type still lands as an editable draft.
 */
export const ProjectTypeSchema = z.string().trim().min(1).max(100);

/** The create door. Every whole-body validation goes through THIS, not the fields. */
export const ProjectCreateSchema = ProjectCreateFields.extend({
  project_type: ProjectTypeSchema.optional(),
});

export const ProjectResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  repository_url: z.string().nullable(),
  branch: z.string(),
  // `delivered` (migration 173): RM closed the project (services/project-delivered.ts); older rows: a bug_hunt whose PR exists.
  status: z.enum(["submitted", "active", "archived", "failed", "delivered"]),

  // n8n/Planka references
  n8n_project_id: z.string().nullable(),
  planka_board_id: z.string().nullable(),

  repository_provisioned: z.boolean(),
  // Migration 061 — TRUE only when coding-gateway's graph-initialize actually
  // succeeded. The Architecture / Dependency / Quality tabs need this;
  // `repository_provisioned` alone is not enough, since a container can exist
  // with no code graph behind it.
  graph_initialized: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});


// ═══════════════════════════════════════════════════════════════════════════
// STAGE A — THE PROJECT REQUEST
// ═══════════════════════════════════════════════════════════════════════════
//
// What a customer can actually KNOW when they ask for work. Deliberately NOT
// ProjectCreateSchema: that schema conflates the request with the agreed
// outline, which is why the form asks a user to commit to deliverables,
// milestones, effort and budget before anyone has looked at the repository.
//
// ⭐ THE RULE THIS SCHEMA IS BUILT ON: every field here has a NAMED READER.
// An exhaustive reader-grep found 21 fields that ProjectCreateSchema accepts
// and nothing reads — they reach projects.project_data through a rest
// destructure and stop there. None of them appear below. A zod schema is
// exactly the artefact that made those 21 look alive, so membership here is
// justified by a reader, never by the field having existed before.
//
// ⚠️ THE READER MAY LIVE OUTSIDE backend/src. `test_command`, `failing_test_ref`,
// `target_files` and `min_severity` have no in-repo reader and ARE alive —
// n8n consumes them via dispatch_context (scripts/seed-it-procedures.ts). A
// reader-grep confined to backend/src reports them dead and is wrong. That is
// the trap this class of cleanup sets for itself.

/** One repository a request names. Stage A can name N of them. */
export const ProjectRequestRepositorySchema = z.object({
  url: z.string().url(),
  branch: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  is_primary: z.boolean().default(false),
});

export const ProjectRequestSchema = z
  .object({
    // ── identity ────────────────────────────────────────────────────────────
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    shape: z.enum(["deliverable", "continuous_flow"]).default("deliverable"),
    project_type: z.string().optional(),
    // Reader: routes/projects.ts (column) + handleGetProjectBrief. Validated
    // against the one canonical vocabulary — a bad value here silently 400'd
    // 78% of all card mints before migration 088.
    scope_level: ScopeLevelSchema.optional(),

    // ── repositories — N of them, which is the point ─────────────────────────
    // The form offered a `multi_repo` scope level and one repo field. The
    // backend has stored N per project since migration 072; only the request
    // side and the form were missing.
    repositories: z.array(ProjectRequestRepositorySchema).min(1),

    // ── the brief the agent is actually given ───────────────────────────────
    problem_statement: z.string().optional(),
    desired_outcome: z.string().optional(),
    business_case: z.string().optional(),
    success_criteria: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),

    // ── rules on the work (typed — see types/project-constraints.ts) ────────
    constraints: z.array(ProjectConstraintSchema).optional(),
    dependencies: z.array(ProjectDependencySchema).optional(),
    risks: z.array(RiskSchema).optional(),

    // ── sign-off ────────────────────────────────────────────────────────────
    // ⚠️ MUST BE UUIDs. These seed project_stakeholders role execution_signoff
    // (routes/projects.ts:659-691). The old form collected free text, which
    // explicitSignoffIds filtered out, logged to a console.warn nobody reads,
    // and silently fell back to the project owner — so the roster the user
    // believed they set never existed. Enforcing uuid here is the fix.
    approvers: z.array(z.string().uuid()).optional(),

    // ── IT remediation inputs (project_type === 'it') ───────────────────────
    it_flow: z
      .enum(["dependency", "security", "source-security", "iac", "bug", "refactor"])
      .optional(),
    cve_sweep: z.boolean().optional(),
    // `bug_hunt` is deliberately ABSENT here: bug hunts are EXEC-only (see ProjectCreateSchema).
    // ⚠️ {name, target_version}, NOT string[]. The frontend has been sending
    // bare strings against this shape, so every IT dependency project with a
    // named package 422s. The backend shape is the correct one — the analysis
    // workflow sizes the upgrade from target_version — so the frontend moves.
    target_packages: z
      .array(z.object({ name: z.string().min(1), target_version: z.string().min(1) }))
      .optional(),
    test_command: z.array(z.string()).optional(),
    bug_test_command: z.array(z.string()).optional(),
    failing_test_ref: z.string().optional(),
    target_files: z.array(z.string()).optional(),
    // ⛔ THIS ENUM DISAGREES WITH THE LIVE ONE AND IS A TRAP. ProjectCreateSchema
    // (above, ~:299) declares `["LOW","MODERATE","HIGH","CRITICAL"]`; this one is
    // lowercase AND spells the second level `medium` where the live vocabulary
    // says `MODERATE`. The n8n procedures that read it require the uppercase form
    // (`dispatch_context.min_severity` is passed straight to the scanner's
    // `minSeverity`), so anything validated HERE and forwarded to the create door
    // would be refused — or, worse, accepted as a `medium` no scanner recognises.
    //
    // ⚠️ Deletion of this whole schema was proposed 2026-10-01 and REFUSED on
    // measurement: `backend/tests/unit/types/project-request-schema.test.ts`
    // imports `ProjectRequestSchema` and has 7 describe blocks over it, so it is
    // not an unused export — it is an export whose only consumer is its own test.
    // It is still parsed by NO live route (the note below the refine says so).
    // Removing it is a two-file change (schema + that test) and a decision about
    // whether Stage A keeps a declared shape at all, not a cleanup. Do not
    // "align" this enum in isolation either: making it uppercase would make a
    // dead schema look like the authority on a vocabulary it does not own.
    min_severity: z.enum(["low", "medium", "high", "critical"]).optional(),

    // ── library assets bound at request time ────────────────────────────────
    bound_assets: BoundAssetsSchema.optional(),
  })
  // ⛔ THE REPO ↔ SCOPE COHERENCE REFINES WERE HERE AND ARE DELETED (2026-09-30).
  // They mirrored the pair on ProjectCreateSchema (counted on
  // `repositories.length` here, `1 + repo.additional.length` there) and are gone
  // for the same reason: `scope_level` is a GRANULARITY vocabulary, orthogonal to
  // repository count, and the ">1 repo requires 'multi_repo'" direction refused
  // the ordinary case of two repos at granularity 'module'. `scope_level` is now
  // DERIVED from repo count, not asked. See the tombstone above
  // `ProjectCreateSchema`. The `is_primary` refine below is UNRELATED and stays.
  // ⚠️ NO LIVE ROUTE PARSES THIS SCHEMA (measured) — the refines were removed here
  // for consistency, not because they were enforcing anything.
  .refine((v) => v.repositories.filter((r) => r.is_primary).length <= 1, {
    message: "at most one repository may be primary",
    path: ["repositories"],
  });

export type ProjectRequestInput = z.infer<typeof ProjectRequestSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// STAGE B — THE OUTLINE
// ═══════════════════════════════════════════════════════════════════════════
//
// What is AGREED after analysis. The agent proposes it; the user approves or
// amends it. These fields were on the REQUEST form, where a user was asked to
// author them before anyone had looked at the repo — which is both unanswerable
// and the reason they were all dead.

// Forward-compatible with the conveyor roadmap's per-deliverable contract
// ({kind, schema, lands_where, checked_by}): a deliverable is never a bare
// string, and `acceptance_criteria` is a list a QA oracle can grade item by
// item. `kind` is a free string until that roadmap publishes its vocabulary.
// ⚠️ EXPORTED for the promote path (routes/project-requests.ts
// `buildApprovedScopeRows`), which re-validates the jsonb it reads back off a
// `project_outlines` row before copying it into `project_deliverables`
// (migration 127). The column is `jsonb`, so drizzle hands it back as
// `unknown` — re-parsing here is what turns it back into a typed row rather
// than a cast nobody checked.
//
// ⛔ `kind` HERE IS NOT `project_deliverables.kind`. This one is the conveyor
// roadmap's free-string per-deliverable contract kind ('artifact', 'doc', …);
// that one is the CLOSED 'deliverable' | 'intermediate' vocabulary, decided by
// WHICH ARRAY the item was in. Migration 127 has no column for this field and
// the promote path drops it — see buildApprovedScopeRows.
export const OutlineDeliverableSchema = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  acceptance_criteria: z.array(z.string().min(1)).default([]),
  checked_by: z.string().min(1).optional(),
  // ── WHICH REPOSITORIES THIS DELIVERABLE CHANGES ────────────────────────
  // ⭐ WHY THESE TWO KEYS EXIST HERE AND NOT IN A `.passthrough()`. Zod v3's
  // DEFAULT IS STRIP: an unnamed key is discarded SILENTLY and the webhook
  // still answers 201. The outline worker
  // (n8n_custom_nodes `workflows/patterns/project-request-outline.json`,
  // "Parse Outline") emits `repos` per deliverable and marks a defaulted
  // attribution with `repos_source`; without these two lines that whole
  // producer change lands INERT — nothing errors, nothing is stored, and the
  // only symptom is an attribution that is never there.
  // ⛔ `.passthrough()` was the wrong fix and is deliberately NOT used: it
  // would accept EVERY unknown key on a machine-authenticated webhook body,
  // i.e. trade one silent strip for unbounded silent acceptance. Name the
  // fields.
  //
  // ⚠️ ABSENT ≠ EMPTY, so no `.default([])`. The producer emits `repos` only
  // when it has an attribution (a stated-and-recognised set, or the primary
  // repo as a fallback) and OMITS the key when the request carries no repo at
  // all. An absent key therefore means "not attributed"; `[]` would be the
  // false claim "attributed to no repository".
  //
  // The items are the REQUEST'S OWN SPELLING of the url (the producer matches
  // canonically but emits the spelling fr and the coding adapter know), so
  // this is `.min(1)` and NOT `.url()` — a `git@host:org/repo.git` remote is a
  // legitimate value that `z.string().url()` refuses, and refusing it here
  // 422s the entire outline delivery.
  repos: z.array(z.string().min(1)).optional(),
  // ⚠️ A PLAIN OPTIONAL STRING, NOT AN ENUM, AND THE REASON IS THE BLAST
  // RADIUS OF BEING WRONG. The only value today's producer can emit is
  // 'default_primary' (measured: one assignment, in the `else if (PRIMARY_URL)`
  // branch of "Parse Outline"; the object is RECONSTRUCTED field by field, so
  // no other value can reach fr from that node). But this is a body schema on
  // the conveyor's critical path: an enum turns any future marker the producer
  // adds into a 422 that loses the WHOLE outline — every deliverable, not just
  // the unknown marker — and the outline worker is not co-deployed with fr.
  // A wider type costs a reader one unrecognised string; a narrower one costs
  // the delivery. `.max(64)` bounds it (same reason `proposed_by` is capped).
  repos_source: z.string().min(1).max(64).optional(),
  // ── U-PS-COMMIT (migration 169): ROLLING-WAVE MINTING ───────────────────
  // A template start writes every template deliverable; those not minted at
  // the decomposition commit carry `deferred: true` + the template's `minter`
  // (pm Deliverable.minter, free text <=255 — same bound as pm). Both OPTIONAL:
  // absent ⇒ deferred=false, minter=NULL = today's behaviour (minted at
  // commit). Named, not passthrough (see `repos` above). `deferred` without a
  // `minter` is refused at promote (buildApprovedScopeRows) — nobody would
  // ever mint it.
  deferred: z.boolean().optional(),
  minter: z.string().min(1).max(255).optional(),
  // ── U-PS-PHASEEXIT (migration 171, fr#1481) ─────────────────────────────
  // Which deliverable of the outline's phase_plan (pm template Deliverable.id)
  // this item IS — the join lib/plan-phase-exit.ts (read model) uses to know the phase a
  // row is placed in. Absent ⇒ NULL = legacy (no plan). Same slug shape as pm
  // (SLUG_PATTERN) and the column CHECK, so a value that could never join is a
  // 422 here rather than a deliverable the plan view can never place.
  plan_deliverable_id: z.string().regex(/^[a-z][a-z0-9_]*$/).max(200).optional(),
});

export const ProjectOutlineSchema = z.object({
  summary: z.string().optional(),
  deliverables: z.array(OutlineDeliverableSchema).default([]),
  intermediate_deliverables: z.array(OutlineDeliverableSchema).default([]),
  milestones: z.array(MilestoneSchema).default([]),
  effort_estimate: z
    .object({
      value: z.number().positive(),
      unit: z.enum(["hours", "days", "weeks"]),
      note: z.string().optional(),
    })
    .optional(),
  // ⚠️ AN ESTIMATE, NOT A TRACKED BUDGET, and the UI must not imply otherwise.
  // MEASURED 2026-09-21: billing_service carries no project_id on any event or
  // rollup table, and fr stamps project_id onto billing_metering_events, which
  // has no token or cost columns at all — cost lives on billing_cost_events,
  // a stream fr does not produce on. Per-project SPEND is a separate multi-repo
  // unit. Nothing here may be presented as money spent.
  cost_estimate: z
    .object({
      currency: z.string().length(3),
      amount: z.number().nonnegative(),
      basis: z.string().optional(),
    })
    .optional(),
});

export type ProjectOutlineInput = z.infer<typeof ProjectOutlineSchema>;
export type OutlineDeliverable = z.infer<typeof OutlineDeliverableSchema>;
export type OutlineMilestone = z.infer<typeof MilestoneSchema>;

export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
