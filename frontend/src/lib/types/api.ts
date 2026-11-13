// Comprehensive TypeScript Type System for FR Frontend
// This file contains all API-related types, interfaces, and schemas

// =============================================================================
// COMMON TYPES
// =============================================================================

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
  success?: boolean;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
}

/**
 * API Error structure
 */
export interface ApiError {
  error: string;
  message?: string;
  details?: any;
  status?: number;
  code?: string;
}

/**
 * Generic list response
 */
export interface ListResponse<T> {
  items: T[];
  total: number;
  page?: number;
  limit?: number;
}

// =============================================================================
// USER TYPES
// =============================================================================

/**
 * User information from Keycloak JWT
 */
export interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  preferred_username?: string;
}

/**
 * User profile
 */
export interface UserProfile extends User {
  created_at?: string;
  updated_at?: string;
  is_active?: boolean;
}

// =============================================================================
// PROJECT TYPES
// =============================================================================

/**
 * Project status enum
 */
export type ProjectStatus = 'submitted' | 'initializing' | 'active' | 'archived' | 'failed' | 'delivered';

/**
 * `projects.delivery_evidence` (backend migration 173) — set together with
 * `delivered_at`. Current rows: RM closed the project. Older bug-hunt rows:
 * the hunt's terminal check proved its PR exists.
 */
export type ProjectDeliveryEvidence =
  | { source: 'rm_project_closed'; rm_pm_project_id: string; phase: string | null }
  | {
      computed_check_id: string;
      evidence_sha: string;
      outcome: string;
      hunt_card_id: string;
      pr: { number: number; head_sha: string; url: string };
    };

/**
 * Spec 2 §4 — project shape. `deliverable` is the existing
 * (target-output + end-date + burndown) shape; `continuous_flow` is the
 * open-ended kanban-with-recurring-intake shape introduced by migration
 * 041. Switching shape after creation is rejected by the backend with
 * 422 details.code='shape_immutable'.
 */
export type ProjectShape = 'deliverable' | 'continuous_flow';

/**
 * The CP→fr bridge RECEIVING half (migration 073). A project_request is a DRAFT
 * an upstream system (Common Practice) forwarded; a human reviews/edits/approves
 * it in fr before any project/board/n8n action. `payload` is the canonical
 * fr-mapped ProjectCreate the reviewer edits; `external_origin` is CP provenance.
 */
/**
 * Mirrors the project_requests status CHECK (backend migration 123).
 * `approved` = outline agreed, project not yet created; `promoted` = project exists.
 */
export type ProjectRequestStatus =
  | 'draft'
  | 'submitted'
  | 'analysing'
  | 'outline_proposed'
  | 'approved'
  | 'promoted'
  | 'rejected'
  | 'withdrawn'
  | 'failed';

export interface ProjectRequest {
  id: string;
  tenant_id: string;
  source: string;
  external_ref: string;
  external_origin: Record<string, unknown> | null;
  payload: Partial<ProjectCreate> & { name?: string };
  status: ProjectRequestStatus;
  rejection_reason: string | null;
  error: string | null;
  created_by: string | null;
  reviewed_by: string | null;
  project_id: string | null;
  history: { at: string; action: string; by?: string | null; detail?: string }[];
  created_at: string;
  updated_at: string;
  /**
   * `project_request_repositories` rows for this request, primary first — url,
   * branch, name, is_primary, plus the PERSISTED per-repo access verdict
   * (`access_state`, `access_detail`, `access_checked_at`). Emitted by
   * `handleGetProjectRequest` in `backend/src/routes/project-requests.ts`.
   *
   * ⛔ DELIBERATELY `unknown`, NOT A SHAPED TYPE, and that is not laziness.
   * `access_state` is a vocabulary with FOUR copies (this frontend's
   * `RepoAccessState`, the backend's, `RECORDABLE_ACCESS_STATES`, and migration
   * 123's CHECK constraint as widened by 126). A shaped type here would invite a
   * consumer to trust the wire and to treat a value its copy has not caught up
   * with as invalid — which would make a WIDENED backend render as a clean
   * request, the exact "outage as confident empty success" defect this codebase
   * keeps hitting. The reader in
   * `routes/projects/requests/[id]/+page.svelte` narrows every field itself and
   * prints an unrecognised state verbatim.
   *
   * ⚠️ Absent, `[]` and populated are THREE different answers: absent means the
   * backend did not report, `[]` means nothing has been checked, and neither is
   * a clean bill of health.
   */
  repositories?: unknown;
}

export interface ProjectRequestApproveResponse extends ProjectRequest {
  project: Project & { planka?: { boardId: string } };
}

/**
 * Conversational intake (D5) response — POST /api/project-requests/draft-from-text.
 * The single-turn extraction lands a DRAFT; the caller redirects to the review
 * page. `missing_required` lists fields the reviewer must still supply (e.g. a
 * real `repository_url` when the sentinel was used); `will_run_analysis` is false
 * when the inferred project_type won't fire the *_start_request_analysis card.
 */
export interface ProjectRequestDraftResponse {
  project_request_id: string;
  status: ProjectRequestStatus;
  payload: Partial<ProjectCreate> & { name?: string };
  missing_required: string[];
  will_run_analysis: boolean;
}

/**
 * Project entity
 */
export interface Project {
  id: string;
  owner_id: string;
  name: string;
  /** NULL = the project has no repository (optional since migration 190). */
  repository_url: string | null;
  branch: string;
  status: ProjectStatus;
  shape: ProjectShape;

  // Macro lifecycle phase (migration 081) — the cockpit phase rail's value.
  // Distinct from `status`. A phase NAME of the project's RM project type;
  // labels via `$lib/projects/phaseTitles` (RM titles).
  project_phase?: string | null;
  // RM's lifecycle status (`closed` once the PM closed the project); null = unread.
  rm_status?: string | null;

  // The project's PRIORITY, read from requirements_management (its
  // `priority_level_id` → the tenant level's name + rank). fr keeps no copy in
  // project_data (v4: RM is the source of truth). Null = RM holds none (or
  // `priority_rank` null = an id outside the tenant's levels).
  priority_level_id?: string | null;
  priority_name?: string | null;
  priority_rank?: number | null;

  // Owning department. `null` = workspace-scope project. Backend always
  // returns this column on GET /api/projects/:id; declared here so RBAC
  // helpers (canEditScheduledTrigger, …) can read it without casting.
  dept_id?: string | null;

  description?: string | null;

  // Super-admin tenant-switch: `continuous` marks a synthetic, read-only
  // entry that points at a continuous-improvement board (an fr `streams` row,
  // not a real projects row).
  //
  // THIS FIELD IS THE ONLY DISCRIMINATOR. `id` carries the stream's own uuid —
  // it is NOT distinguishable by shape from a real project id, and it is NOT a
  // `projects` row id, so it must never be passed to a /projects/:id route.
  // (It used to be `stream:`-prefixed; that value was unresolvable and made
  // uuid-column routes raise SQLSTATE 22P02 → HTTP 500.) Such entries link to
  // the kanban board view (via `planka_board_id`) rather than the
  // /projects/[id] cockpit. Filter with `$lib/projects/is-real-project`.
  //
  // Optionality unchanged: absent on every real project — only the synthetic
  // stream-backed entries carry it, and `undefined` is the "real project" case.
  kind?: 'continuous';

  // n8n/Planka references
  n8n_project_id?: string | null;
  planka_board_id?: string | null;
  // R2/B3: set by GET /api/projects — false when planka_board_id no longer
  // resolves to a live Planka board (deleted upstream). undefined = unknown
  // (Planka unreachable at list time); the UI then shows no staleness hint.
  board_live?: boolean;

  repository_provisioned: boolean;
  // Migration 061 — TRUE only when coding-gateway's graph-initialize actually
  // succeeded; the Architecture / Dependency / Quality tabs need it, because
  // `repository_provisioned` alone does not mean a code graph exists.
  // OPTIONAL on purpose: absent = UNKNOWN (an older backend that does not send
  // the field), which must never be read as `false`.
  graph_initialized?: boolean;
  container_name?: string | null;

  // Extended project data
  project_data?: any;
  project_type?: string | null;
  scope_level?: string | null;
  /**
   * How a multi-repository project's repositories relate — `coordinated` (one
   * product; a unit of work may span them) or `independent` (each repository is
   * its own workstream).
   *
   * ⚠️ OPTIONAL, AND ABSENT IS NOT `'independent'`. A single-repository project
   * is never asked, and a bundle can be served against a backend that predates
   * the field — so `undefined` means "nobody said", which is different from
   * either mode. Only an explicit value licenses a statement about coordination.
   */
  coordination_mode?: 'coordinated' | 'independent' | null;
  /**
   * EVERY repository attached to this project, primary first
   * (`is_primary DESC, position ASC, added_at ASC`). Emitted by
   * `GET /api/projects/:id` and the intake brief — see `repositories` in
   * `backend/src/routes/projects.ts`.
   *
   * ⚠️ ABSENT, `[]` AND `null` ARE THREE DIFFERENT ANSWERS, and a consumer that
   * collapses them renders an outage as a confident "no repositories":
   *   * absent  — this backend did not report repos (an older bundle/backend).
   *               Fall back to the `repository_url` scalar; claim nothing else.
   *   * `[]`    — the read SUCCEEDED and no repos are attached.
   *   * `null`  — the read FAILED; nothing is known.
   * ⛔ Do not add a `?? []` default here to make consuming easier. That default
   * is precisely the bug: it converts two unknowns into a factual claim.
   */
  repositories?: ProjectRepositoryRow[] | null;
  /**
   * `repositories.length` as the backend counted it. Carried rather than derived
   * so a header count cannot come from somebody's `?? []`, and so a count that
   * OUTRUNS the rows is visible as the inconsistency it is instead of silently
   * agreeing with a truncated list.
   */
  repo_count?: number | null;

  // D6/3C — optional link to a pmProgrammes asset (delivery-plane grouping).
  // Stored inside project_data JSONB on the backend; surfaced here (and by
  // GET /api/projects?programme_id=) so a programme can roll up its delivery
  // projects. `null`/absent = unlinked.
  programme_id?: string | null;

  // Andon-cord (migration 050). When true, every automated loop
  // (scheduled-trigger-tick, suggestion-heuristic, future agent loop)
  // pre-flight-skips this project. Toggled via POST /api/projects/:id/andon/{engage,disengage}.
  andon_engaged?: boolean;
  andon_engaged_at?: string | Date | null;
  andon_engaged_by?: string | null;

  // Migration 173 — both set (or both null) when status becomes 'delivered'.
  delivered_at?: string | Date | null;
  delivery_evidence?: ProjectDeliveryEvidence | null;

  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * `GET /api/projects` — list envelope.
 *
 * ⭐ `archived_excluded` IS THE DISCRIMINATOR, AND IT IS WHY THIS TYPE EXISTS
 * instead of a bare `ListResponse<Project>`. The route excludes `archived` rows
 * by default (`ne(status,'archived')`, unless `?include_archived=1`), so a
 * workspace that has never been used and a workspace whose every project is
 * archived both answer `{items:[],total:0}`. Measured on prod 2026-09-30: 133
 * projects, ALL archived — so the projects page told every user "No projects
 * yet / Create Your First Project" (fr#1259).
 *
 * ⚠️ OPTIONAL ON PURPOSE, AND `?? 0` IS THE WRONG WAY TO READ IT. A frontend
 * bundle can be served against a backend that predates the field; `undefined`
 * means "the server did not say", which is NOT "nothing was withheld". Only an
 * explicit `0` licenses a first-run message. See
 * `frontend/src/lib/components/projects/ProjectPortfolio.svelte`.
 *
 * It counts what THIS request withheld, so it is 0 under `?include_archived=1`.
 */
export interface ProjectListResponse extends ListResponse<Project> {
  archived_excluded?: number;

  /**
   * ⭐ THE SECOND DISCRIMINATOR — how many ACTIVE projects this request withheld
   * because their Planka board is confirmed gone.
   *
   * ⛔ WHY IT IS NOT REDUNDANT WITH `archived_excluded`. That count is taken
   * BEFORE the route's board-liveness drop, and the drop exempts every `archived`
   * row — so a workspace whose only projects are active-with-a-dead-board answers
   * `{items:[], total:0, archived_excluded:0}`. An EXPLICIT zero, i.e. the one
   * envelope the page treats as a licence to say "nothing has been created here".
   * That is fr#1259's defect class (an absence rendered as a result) reappearing
   * one predicate lower, and only a second, disjoint count can tell the two
   * apart. The two never describe the same row.
   *
   * ⚠️ OPTIONAL, AND `?? 0` IS AGAIN THE WRONG WAY TO READ IT. `undefined` means
   * "the server did not say" — a bundle can be served against a backend that has
   * `archived_excluded` but not this field, and reading that as 0 restores the
   * lie. The first-run message requires BOTH counts to be an explicit 0.
   *
   * 0 is meaningful and common: the drop only fires when the live-Planka
   * cross-check RESOLVED and the board is confirmed absent. A Planka hiccup
   * leaves `board_live` undefined, withholds nothing, and reports 0.
   */
  dead_board_excluded?: number;
}

/**
 * Milestone
 */
export interface ProjectMilestone {
  name: string;
  target_date?: string;
}

/**
 * Project risk
 */
export interface ProjectRisk {
  description: string;
  likelihood?: string;
  impact?: string;
  mitigation?: string;
}

/**
 * Create project payload
 */
// ⛔ CULLED 2026-09-23 — mirrors the same cull in backend/src/types/api.ts
// (ProjectCreateSchema): `env_placeholders`, `data_classification`,
// `target_environment`, `resourcing`, `key_deliverables` had zero readers;
// `effort_estimate` and `milestones` moved to Stage B under migration 127.
// The backend zod schema is the contract — never add a property here that
// ProjectCreateSchema does not accept, and never delete one from only one file.
// ⚠️ The ProjectMilestone interface above is still exported and still imported by
// ProjectForm.svelte; only the ProjectCreate.milestones property is gone.
/**
 * Rewrite-project vocabulary. Mirrors backend/src/types/api.ts
 * (RepositoryRoleSchema / RewriteLanguageSchema), which mirrors the project store.
 */
export type RepositoryRole = 'source' | 'target';
export type RewriteLanguage = 'python' | 'rust';

/**
 * Which conveyor sign-offs the user is asked for. Mirrors backend/src/types/api.ts
 * (APPROVAL_MODES), which mirrors the project store. fr's default is 'brief_and_closure'.
 */
export const APPROVAL_MODES = ['all', 'auto_drafts', 'brief_and_closure', 'autonomous'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
/** fr's default (George 2026-10-31, R329): only the brief and the closure sign-off. Mirrors backend DEFAULT_APPROVAL_MODE. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'brief_and_closure';
/** True for one of the four modes (a stored or agent-proposed value is untrusted). */
export function isApprovalMode(v: unknown): v is ApprovalMode {
	return typeof v === 'string' && (APPROVAL_MODES as readonly string[]).includes(v);
}

export interface ProjectCreate {
  name: string;
  /** OPTIONAL (George 2026-10-13): omit when the project has no repository. */
  repository_url?: string | null;
  /**
   * Spec 2 §4 — when omitted, backend defaults to 'deliverable' for
   * backwards compatibility with clients that don't ship the field yet.
   */
  shape?: ProjectShape;
  branch?: string;
  description?: string;

  // Extended fields
  project_type?: string;
  /**
   * A code-GRANULARITY vocabulary: `repo`, `app`, `module`, `component`, `file`,
   * `class`, `function` (canonical list: backend/src/types/scope-level.ts).
   *
   * ⛔ `'multi_repo'` IS NOT OFFERED BY THIS FORM ANY MORE, and this comment used
   * to describe the rule that is gone. Two refines on `ProjectCreateSchema` —
   * "'multi_repo' requires >=2 repositories" and ">1 repository requires
   * 'multi_repo'" — mirrored here in prose and at runtime by `coherenceError()`
   * in components/project-request/RepositoryRepeater.svelte. All of it is
   * DELETED (2026-09-30): repository COUNT is a fact the server can read off
   * `repo`, granularity is a separate question, and demanding they agree refused
   * the ordinary case of two repositories at granularity `module`. Measured:
   * nothing in the backend branched on the literal `'multi_repo'`. The server now
   * sets it from the count when >= 2 and keeps whatever granularity was chosen.
   *
   * ⚠️ Do not re-add a frontend coherence check for this. There is no zod here
   * (no `ProjectCreateSchema`, no zod dependency at all), so the only mirror
   * possible is hand-written — which is exactly how the deleted rule came to
   * outlive the backend refines it was copied from.
   */
  scope_level?: string;
  /**
   * How the repositories relate, for a MULTI-repository project: `coordinated`
   * (they are one product, so a unit of work may span them) or `independent`
   * (each is its own workstream). Defaults to `coordinated` server-side.
   *
   * ⚠️ OMITTED — not defaulted — when the project names fewer than two
   * repositories. The form hides the control below two, so sending a value there
   * would record a declaration the user was never shown. There are deliberately
   * NO per-repository roles: a flat list with exactly one primary. (The one
   * exception is the `rewrite` it_flow's source/target `role` on `repo`, which
   * is not a coordination claim; that flow omits this key.)
   */
  coordination_mode?: 'coordinated' | 'independent';
  /** A priority level of the owning tenant (RM): its id, or its name (e.g. `P1`). */
  priority?: string;

  /**
   * IT remediation inputs (project_type === 'it'). Mirrors the backend's
   * ProjectCreateSchema (backend/src/types/api.ts) — the backend has accepted
   * these all along; the form simply never exposed them, so the only way to
   * start a code-changing project was the CLI drive scripts.
   *
   * `it_flow` selects the remediation chain that done-finalize spawns:
   *   dependency (default) → development_chore
   *   security | source-security | iac → security_analysis → the matching patch
   *   bug → bug_analysis → development_bug_fix
   *   refactor → architecture refactoring; carries target_files/test_command
   *   rewrite → rewrite the code in another language: `repo.additional[]` rows
   *             with role 'source' (each pinned to a commit / PR) are read, the
   *             primary with role 'target' is written; `brief.target_language` is
   *             EXTRACTED from the request by the backend when absent.
   */
  it_flow?: 'dependency' | 'security' | 'source-security' | 'iac' | 'bug' | 'refactor' | 'rewrite';
  /**
   * Rewrite flow only: the language the code is rewritten INTO. Not asked by the form —
   * the backend extracts it from the request and records it on the project BRIEF
   * (George 2026-11-07).
   */
  target_language?: RewriteLanguage;
  /** Which conveyor sign-offs the user is asked for. Always sent by ProjectForm for an `it` project; the backend stores 'brief_and_closure' when absent. */
  approval_mode?: ApprovalMode;
  /**
   * fr#1388 (U3/A6) — the conveyor's QUESTION path. Canonical list:
   * backend/src/types/question-mode.ts (keep in lock-step). Absent ⇒ free_text;
   * `null` is accepted as "unset" and not persisted. Anything else is a 422.
   */
  question_mode?: 'structured' | 'free_text' | null;
  /**
   * Discovery mode: scan the repo for fixable CVEs instead of upgrading a named
   * list. When true, `target_packages` may be empty.
   */
  cve_sweep?: boolean;
  /**
   * Bug HUNT (hunt mode of it_flow === 'bug', EXEC tenant only): no failing test
   * is known yet. When true, `test_command` (the repo's suite command; it need
   * not fail) is required and `bug_test_command` must be absent. Mirrors the
   * backend's assertItExecIntakeInputs.
   */
  bug_hunt?: boolean;
  /** Named packages to upgrade. Required for the dependency flow unless cve_sweep. */
  /**
   * Packages to upgrade and the version to move each TO. Mirrors the backend
   * zod `{name, target_version}[]`. This was declared `string[]` here, which is
   * the root of the mismatch: the form sent bare names and every IT dependency
   * project with a named package 422'd.
   */
  target_packages?: { name: string; target_version: string }[];
  /** Post-fix verification command, ARGV form — e.g. ["pytest", "-q"]. */
  test_command?: string[];
  /** The currently-failing test, ARGV form. Required when it_flow === 'bug'. */
  bug_test_command?: string[];
  /**
   * The bug report text (bug flow). Read as `dispatch_context.bug_description`
   * by both `bug_analysis` and `development_bug_fix`; declared on the backend's
   * ProjectCreateSchema since the IT_MVP work but absent from this type and
   * from the form, so it was never sent.
   */
  bug_description?: string;
  /** Identifier of the failing test (bug flow). */
  failing_test_ref?: string;
  /** Repo-relative paths the remediation worker may edit. */
  target_files?: string[];
  /** Severity floor for the security scan. */
  min_severity?: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  /**
   * SPEC.md lifecycle-class enum (orthogonal to project_type). n8n's
   * project-start workflow keys off this to pick the right card_type
   * set. Persisted via project_data JSONB on the backend.
   */
  lifecycle_class?:
    | 'system'
    | 'workflow-improvement'
    | 'execution'
    | 'prompt-improvement';

  // People & Roles
  requestor?: string;
  stakeholders?: string[];
  approvers?: string[];

  // Problem & Objectives
  problem_statement?: string;
  desired_outcome?: string;
  business_case?: string;

  // Scope & Requirements
  success_criteria?: string[];
  acceptance_criteria?: string[];
  in_scope?: string[];
  out_of_scope?: string[];
  high_level_requirements?: string[];
  assumptions?: string[];
  access_requirements?: string[];

  // Repository & Environment
  repo?: {
    primary: {
      url: string;
      branch?: string;
      path?: string;
      /** Rewrite flow only: the primary is the repository written to. */
      role?: RepositoryRole;
      sha?: string;
      /** The exact version to take as input: a 40-hex commit or a PR. The backend resolves it to `sha`. */
      pin?: string;
    };
    /**
     * Every repository beyond the primary. The backend has accepted this and
     * written project_repositories rows since migration 072; the form simply
     * never sent it, so a project could not name its second repo at all.
     *
     * ⛔ There is deliberately NO `position` key here, and an earlier revision of
     * this comment argued the opposite — that stating the order explicitly beats
     * letting the backend infer it from array index. That argument was wrong on a
     * measurable point: `backend/src/types/api.ts` declares no `position` on either
     * `primary` or `additional`, so zod strips it and the field would be WRITE-ONLY
     * on the wire — a value the sender believes is carried and the receiver never
     * sees. It would also be a second producer of one fact, free to disagree with
     * the array it travels in.
     *
     * The ARRAY ORDER is the single source of truth. The server derives
     * `project_repositories.position` from the index (primary 0, then 1, 2 …) in
     * `backend/src/routes/projects.ts`. To change the order, change the order of
     * `additional`.
     */
    additional?: {
      url: string;
      branch?: string;
      name?: string;
      role?: RepositoryRole;
      sha?: string;
      /** The exact version to take as input: a 40-hex commit or a PR. The backend resolves it to `sha`. */
      pin?: string;
    }[];
  };

  // Secrets & Documents
  secret_ids?: string[];
  document_ids?: string[];
  repository_id?: string;

  // Timeline & Risks
  deadline?: string;
  /**
   * Legacy free-text strings (every project created before 2026-09-21) OR the
   * typed vocabulary in $lib/types/project-constraints. The backend engine
   * schema accepts both, so neither old nor new requests 422 on approval.
   */
  constraints?: (string | import('./project-constraints').ProjectConstraint)[];
  dependencies?: (string | import('./project-constraints').ProjectDependency)[];
  risks?: ProjectRisk[];

  // Resources & Notes
  budget?: string;
  notes?: string;

  /**
   * Library assets the user picked at project-creation time. Each kind
   * is an optional array of upstream asset ids. The backend writes one
   * asset_bindings row per (kind, id) and embeds the same grouping in
   * the project_start_request JSON brief on the intake card.
   */
  bound_assets?: {
    requirement?: string[];
    principle?: string[];
    decision?: string[];
    kag_document?: string[];
    workflow?: string[];
    trigger?: string[];
    channel?: string[];
    artifact?: string[];
  };
}

// (ProjectPatch is gone: PATCH /api/projects/:id accepts no field since D15/R16 —
// George 2026-10-13, every field it wrote is requirements_management's after the
// request and only the PM writes it. The backend answers 422 rm_owned_field.)

/**
 * Project status response
 */
export interface ProjectStatusResponse {
  project_id: string;
  status: ProjectStatus;
  workflow_status?: any;
  container_status?: {
    running: boolean;
    health?: string;
  };
}

/**
 * Project metrics
 */
export interface ProjectMetrics {
  id: string;
  project_id: string;
  date: string | Date;

  cycle_time_days: number | null;
  lead_time_days: number | null;
  throughput: number | null;
  success_rate: number | null;
  error_rate: number | null;
  quality_score: number | null;

  completed_tasks: number;
  failed_tasks: number;

  created_at: string | Date;
}

// =============================================================================
// SECRET TYPES
// =============================================================================

/**
 * Secret type enum
 */
export type SecretType = 'api_key' | 'oauth' | 'basic_auth' | 'custom';

/**
 * Secret entity (without sensitive data)
 */
export interface Secret {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  secret_type: SecretType;

  metadata?: Record<string, any>;
  is_valid: boolean;

  created_at: string | Date;
  updated_at: string | Date;
  last_used?: string | Date | null;
}

/**
 * Create secret payload
 */
export interface SecretCreate {
  name: string;
  description?: string;
  secret_type: SecretType;
  secret_value: string;
  metadata?: Record<string, any>;
}

/**
 * Update secret payload
 */
export interface SecretUpdate {
  name?: string;
  description?: string;
  secret_value?: string;
  metadata?: Record<string, any>;
  is_valid?: boolean;
}

// =============================================================================
// URL CREDENTIAL TYPES
// =============================================================================

/**
 * Credential authentication type
 */
export type CredentialAuthType = 'basic' | 'bearer' | 'api_key' | 'cookie' | 'custom';

/**
 * Basic auth credentials
 */
export interface BasicAuthCredentials {
  auth_type: 'basic';
  username: string;
  password: string;
}

/**
 * Bearer token credentials
 */
export interface BearerTokenCredentials {
  auth_type: 'bearer';
  auth_token: string;
}

/**
 * API key credentials
 */
export interface ApiKeyCredentials {
  auth_type: 'api_key';
  api_key: string;
  api_key_header?: string;
}

/**
 * Cookie credentials
 */
export interface CookieCredentials {
  auth_type: 'cookie';
  cookies: Record<string, string>;
}

/**
 * Custom headers credentials
 */
export interface CustomHeadersCredentials {
  auth_type: 'custom';
  custom_headers: Record<string, string>;
}

/**
 * Union of all credential types
 */
export type Credentials =
  | BasicAuthCredentials
  | BearerTokenCredentials
  | ApiKeyCredentials
  | CookieCredentials
  | CustomHeadersCredentials;

/**
 * URL Credential entity
 */
export interface URLCredential {
  credential_id: string;
  user_id: string;
  identifier: string;
  url: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  metadata: Record<string, any> | null;
}

/**
 * Create URL credential payload
 */
export interface URLCredentialCreate {
  identifier: string;
  url: string;
  credentials: Credentials;
  metadata?: Record<string, any>;
  ttl?: number;
}

/**
 * Update URL credential payload
 */
export interface URLCredentialUpdate {
  identifier?: string;
  url?: string;
  credentials?: Credentials;
  metadata?: Record<string, any>;
  ttl?: number;
}

// =============================================================================
// REPOSITORY TYPES
// =============================================================================

/**
 * Repository entity
 */
export interface Repository {
  id: string;
  user_id: string;
  name?: string | null;
  url: string;
  branch?: string | null;
  path?: string | null;
  description?: string | null;
  secret_id?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Create repository payload
 */
export interface RepositoryCreate {
  name?: string;
  url: string;
  branch?: string;
  path?: string;
  description?: string;
  secret_id?: string;
}

/**
 * Update repository payload
 */
export interface RepositoryUpdate {
  name?: string;
  url?: string;
  branch?: string;
  path?: string;
  description?: string;
  secret_id?: string | null;
}

// =============================================================================
// PROJECT ↔ REPOSITORY MEMBERSHIP (migration 072 / task #25 scope B PR 2)
// =============================================================================

/** One repository attached to a project, as the backend list returns it. */
export interface ProjectRepositoryListItem {
  repo_id: string;
  url: string;
  branch: string | null;
  name: string | null;
  container_name: string | null;
  is_primary: boolean;
  added_at: string;
}

/**
 * One repository as `GET /api/projects/:id` and the intake brief publish it.
 * Mirrors `ProjectRepositoryRow` in
 * `backend/src/services/project-repositories.ts` — the single loader every
 * backend consumer shares. ⚠️ Distinct from `ProjectRepositoryListItem`, which
 * is the richer shape of the dedicated `/repositories` sub-resource; do not
 * merge them, the two endpoints genuinely return different columns.
 */
export interface ProjectRepositoryRow {
  repo_id: string;
  url: string;
  branch: string | null;
  name: string;
  path: string | null;
  is_primary: boolean;
  position: number;
}

/**
 * List shape from `GET /api/projects/:id/repositories`. Items come back
 * primary-first; `primary_repository_id` is also surfaced at the top level
 * so the picker can fast-path the default selection without scanning.
 */
export interface ProjectRepositoriesList {
  items: ProjectRepositoryListItem[];
  total: number;
  primary_repository_id: string | null;
}

/**
 * `POST /api/projects/:id/repositories` body. Either `repo_id` (attach an
 * existing repository the caller owns) or `url` (create-or-attach by URL
 * via the backend's ON CONFLICT (user_id, url) upsert). The backend
 * rejects empty-both with 422.
 */
export interface ProjectRepositoryAttachBody {
  repo_id?: string;
  url?: string;
  branch?: string;
  name?: string;
}

/**
 * Response of attach. The `warning` field surfaces the SOFT validator-hop
 * outcome — `'container_not_bound_to_project'` means the backend's call
 * to req-mgmt's per-container validator (PR 1) returned 404, but the
 * attach still succeeded. Promote-to-primary is HARD: a 404 there comes
 * back as `409` from the backend instead.
 */
export interface ProjectRepositoryAttachResponse {
  repository: ProjectRepositoryListItem;
  warning: string | null;
  binding: unknown | null;
}

// =============================================================================
// DOCUMENT TYPES
// =============================================================================

/**
 * Document status enum.
 * `parsed`: send_to_kag=false opt-out path — content extracted by the
 * ingestion service but NOT indexed in the tenant/project knowledge graph.
 */
export type DocumentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'rejected' | 'parsed';

/**
 * Which pipeline stage lost data on a partially-indexed document.
 *
 * NOT the same set as `IngestionStageKey`: `'chunks'` is a karma-side notion
 * (the per-chunk fan-out) with no stepper row of its own, and `upload`/`parse`
 * can never be partial (they either produce a document or fail outright).
 */
export type KagDegradedStage = 'knowledge' | 'hierarchy' | 'index' | 'chunks';

/**
 * The six degradation columns the backend persists on the `documents` row
 * (karma PR #127 "partial credit": the pipeline now COMPLETES a job that lost
 * most of its chunks). Shared verbatim by `Document` and
 * `DocumentStatusResponse` so a poll and a list read can never drift.
 *
 * HONESTY CONTRACT — `kag_degraded` is a THREE-valued field:
 *   true      → the graph is knowingly incomplete; the UI must say so.
 *   false     → the backend evaluated the job and found it complete.
 *   null/undef→ UNKNOWN. Never "clean", never "degraded". 4 legacy prod rows
 *               and every parse-only (send_to_kag=false) upload carry NULL
 *               forever, so every consumer MUST test `=== true` — never
 *               truthiness, never `!== false`.
 */
export interface DocumentDegradationFields {
  kag_degraded?: boolean | null;
  kag_degraded_reason?: string | null;
  kag_degraded_stage?: KagDegradedStage | null;
  chunks_indexed?: number | null;
  chunks_failed?: number | null;
  chunks_total?: number | null;
}

/**
 * Document entity
 */
export interface Document extends DocumentDegradationFields {
  id: string;
  project_id?: string | null;
  user_id: string;
  filename: string;
  file_size: number;
  mime_type: string;
  status: DocumentStatus;

  kag_ingestion_id?: string | null;
  pages_detected?: number | null;
  entities_extracted?: number | null;
  error_message?: string | null;

  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Document upload response
 */
export interface DocumentUploadResponse {
  document: Document;
  message?: string;
}

/**
 * One stage of the async ingestion pipeline (Uploaded → Parsed → Extracting
 * knowledge → Building hierarchy → Indexed), as derived by the backend's
 * `deriveIngestionProgress`.
 */
export type IngestionStageState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export type IngestionStageKey = 'upload' | 'parse' | 'knowledge' | 'hierarchy' | 'index';

export interface IngestionStage {
  key: IngestionStageKey;
  label: string;
  state: IngestionStageState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Short human count, e.g. "4,827 entities", "201 sentences", "12 pages". */
  detail?: string;
  metrics?: Record<string, string | number | boolean>;
  /**
   * This stage finished but lost data. Deliberately a FLAG on a `done` stage
   * rather than a new `IngestionStageState` member: the stage really did
   * complete (karma's partial credit), and widening the state union would
   * silently change every `state === 'done'` branch in the stepper.
   */
  degraded?: boolean;
  degradedReason?: string | null;
}

/**
 * Staged, user-facing view of an in-flight upload — a read-through of the live
 * kag job returned by `GET /api/documents/:id/status`. `null` once the row is
 * terminal (the frontend renders the final state from `status` alone).
 */
export interface IngestionProgress {
  stages: IngestionStage[];
  currentStageKey: IngestionStageKey | null;
  percentComplete: number;
  /** `'degraded'` is TERMINAL-BUT-INCOMPLETE: the job finished, the graph did not. */
  terminal: 'ready' | 'degraded' | 'failed' | null;
  failedStageKey: IngestionStageKey | null;
  errorMessage: string | null;
  /**
   * Present (non-null) whenever the backend evaluated degradation for this
   * job. `null` = not evaluated / unknown — same honesty rule as
   * `Document.kag_degraded`: absence is never proof of a clean graph.
   */
  degradation: {
    degraded: boolean;
    reason: string | null;
    stage: KagDegradedStage | null;
    chunksIndexed: number | null;
    chunksFailed: number | null;
    chunksTotal: number | null;
  } | null;
  ids: {
    ingestionJobId: string | null;
    orchestratorJobId: string | null;
    tenantId: string | null;
  };
}

/**
 * Document status response
 */
export interface DocumentStatusResponse extends DocumentDegradationFields {
  id: string;
  status: DocumentStatus;
  // Staged progress for the upload stepper (read-through; null once terminal).
  progress?: IngestionProgress | null;
  // Settled by the backend's lazy reconcile once the kag job completes.
  pages_detected?: number | null;
  entities_extracted?: number | null;
  error_message?: string | null;
  // The six degradation columns are PERSISTED on the row, so they come back on
  // every poll AND after a reload — see DocumentDegradationFields.
}

// =============================================================================
// APPROVAL TYPES
// =============================================================================

/**
 * Approval status enum
 */
// 'expired' is TERMINAL and machine-written: backend workers/approval-expiry.ts
// transitions a `pending` approval whose expires_at has passed. It is NOT a
// decision — nobody approved or rejected — so it must never be conflated with
// 'rejected'. Listed here because the API really can return it; omitting it
// made an expired approval match no client-side filter and vanish from the UI
// entirely.
// 'voided' is ALSO terminal and non-deciding, but distinct from 'expired': an
// operator withdrew the ask because it was never answerable, on a named row,
// at a known time, for a stated reason (backend migration 110). It must not
// be conflated with 'rejected' (a human said no) or 'expired' (nobody
// answered in time).
// 'executing' | 'done' | 'failed' are written by the backend's E-5 action-approval
// bus (backend/src/domain/engagement/action-approvals.ts, including its
// reapStaleExecutingActions reaper) and are already admitted by the server's
// APPROVAL_STATUS_FILTERS. They were missing here for the same reason 'expired'
// and 'voided' each were in their turn: a status was added on the server and
// nothing brought this union forward. ⚠️ THE GAP WAS ALREADY VISIBLE IN THIS
// REPO — improvement/workflows/logic.test.ts iterates all three, so the type and
// its own tests disagreed. Unpopulated on prod (2026-09-13) is not a reason to omit
// them: `approvals.status` has no CHECK and no enum, so the first write is
// silent, and a union that cannot name a status makes it unhandleable rather
// than impossible.
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'voided'
  | 'executing'
  | 'done'
  | 'failed';

/**
 * Approval decision
 */
export type ApprovalDecision = 'approved' | 'rejected';

/**
 * Required approver
 */
export interface RequiredApprover {
  user_id: string;
  role?: string;
  approved?: boolean;
}

/**
 * Approval decision detail
 */
export interface ApprovalDecisionDetail {
  id?: string;
  approval_id?: string;
  approver_id: string;
  /** Resolved display name / e-mail (FR-9); null when unresolved. */
  approver_name?: string | null;
  approver_email?: string | null;
  decision: ApprovalDecision;
  comment?: string;
  decided_at: string | Date;
}

/**
 * Approval entity
 */
/**
 * `approvals.kind` — the Postgres `approval_kind` enum. Widened with `(string & {})`
 * because the column is a DB enum the backend can extend in a migration without
 * touching this file: an unknown member must degrade to "render the raw value",
 * never to a type error at the one place that reads it.
 */
export type ApprovalKind =
  | 'generic'
  | 'improvement.design'
  | 'improvement.release'
  | 'improvement.canary_action'
  | 'execution.ready_signoff'
  | (string & {});

export interface Approval {
  id: string;
  project_id: string;
  requester_id: string;
  /** Resolved display name / e-mail of the requester (FR-9); null when unresolved. */
  requester_name?: string | null;
  /** Resolved name when `voided_by` is a user id; null for free text or unresolved. */
  voided_by_name?: string | null;
  requester_email?: string | null;
  status: ApprovalStatus;
  /** Request family. Absent on responses minted before the column existed. */
  kind?: ApprovalKind;
  /**
   * Free-form row metadata. For `improvement.*` this is where the asset domain
   * lives (`asset_kind` / `card_type` = procedure | prompt | workflow) — the
   * `kind` enum has one improvement family for all three.
   */
  metadata?: Record<string, unknown> | null;
  /** A1 only — see {@link G12DecideTemplate}. Absent on every other row. */
  g12_decide?: G12DecideTemplate;
  /** A3 only — see {@link G12A3DecideTemplate}. Absent on every other row. */
  g12_decide_a3?: G12A3DecideTemplate;
  description: string;
  change_summary?: string;
  impact_analysis?: string;
  /**
   * D13 (backend migration 192): the ONE artifact this approval is about.
   * `version` absent = the artifact, not a pinned version. NULL = none; ABSENT =
   * an older backend.
   */
  artifact_ref?: { artifact_id: string; version?: number } | null;

  created_at: string | Date;
  /**
   * NULLABLE since backend migration 105: NULL means "no deadline, ever".
   * A card-blocking approval must not expire. This type said `string | Date`
   * while the column is `timestamp('expires_at')` with no `.notNull()`, which
   * is why tsc never flagged the bare `new Date(null)` comparisons that
   * rendered 712 approved rows as red "Expired".
   */
  expires_at: string | Date | null;
  completed_at?: string | Date | null;

  // Extended fields from list endpoint
  required_approvers?: RequiredApprover[];
  decisions?: ApprovalDecisionDetail[];

  // De-block callback state (backend migrations 113 / 119 / 121 / 134). All
  // three are OPTIONAL **and** NULLABLE because THREE meanings must stay
  // distinct: field ABSENT = an older backend that does not send it, so
  // UNKNOWN; field NULL = the backend spoke and there is no answer yet; field
  // SET = the answer. Collapsing absent into null is exactly the defect these
  // types exist to fix.
  /** n8n returned 2xx for the decision callback. An ack is transport, not effect. */
  callback_acked_at?: string | null;
  /**
   * The TERMINAL state of the de-block callback. NULL = not terminal, still a candidate.
   *
   * ⚠️ SIX VALUES SINCE MIGRATION 134, NOT FIVE. `read_degraded` (#1104) was
   * added to the CHECK constraint by that migration and is written by
   * `backend/src/workers/deblock-callback-redelivery.ts` today. While it was
   * missing from this union AND from
   * `$lib/approvals/callback-state.ts :: KNOWN_RESOLUTIONS`, such a row
   * rendered as `'unknown'` — "this fr build cannot say what happened" — which
   * was FALSE: the backend said exactly what happened, and the whole point of
   * migration 134 is that none of the other five values could say it honestly.
   * If migration 135 ever adds a seventh, both lists move in the same commit.
   */
  callback_resolution?:
    | 'moved'
    | 'not_blocked'
    | 'card_unreadable'
    | 'send_exhausted'
    | 'hold_acknowledged'
    | 'read_degraded'
    | null;
  /** fr was left not-knowing the outcome on the request path. NOT an ending — the row stays repairable. */
  callback_outcome_unknown_at?: string | null;

  // Present only for KAG document-upload approvals (worker-initiated ingest):
  // a lightweight descriptor of the pending file. The bytes themselves are NOT
  // in the JSON — fetch them via apiClient.approvals.getDocumentBlob(id) for the
  // approval-time preview. See backend handleGetApprovalDocument.
  document?: {
    filename: string;
    content_type: string;
    byte_size: number;
  };
}

/**
 * Create approval payload
 */
export interface ApprovalCreate {
  description: string;
  change_summary?: string;
  impact_analysis?: string;
  required_approvers: RequiredApprover[];
}

/**
 * Update approval payload
 */
export interface ApprovalUpdate {
  status: ApprovalStatus;
  comment?: string;
  reason?: string;
}

/**
 * Approve/Reject approval payload
 */
export interface ApprovalActionRequest {
  comment?: string;
  reason?: string;
  /** The decider's action override; sent today only as 'RECLASSIFY' (REALIGN R5). */
  deblock_action?: string;
  /** Required by the server iff approving with deblock_action=RECLASSIFY. */
  new_card_type?: string;
  /** COVERAGE: the criteria the decider marks as a gap (approve or reject). */
  rejected_criterion_ids?: string[];
  /** G-12 A1 (bug-fix authorization): the bugs the decider rejects; ⊆ metadata.bug_ids. */
  rejected_bug_ids?: string[];
  /** G-12 structured decision — required by the backend on a bug-fix authorization row. */
  g12_decision?: G12DecisionBody;
}

/** The G-12 decision body an A1 / A3 decide carries (backend u3-gates.ts G12DecisionSchema). */
export interface G12DecisionBody {
  rule_version: string;
  rule_row: string;
  inputs_hash: string;
  /** A1 only. */
  reject_reason_code?: string;
  /** A3: exactly one item, the design (item_id = metadata.design_artifact_id). */
  items?: Array<{ item_id: string; decision: 'approve' | 'reject'; reason_code: string }>;
}

/**
 * GET /api/approvals/:id `g12_decide_a3` — served ONLY on a pending, sealed
 * `execution.feature_design_approval` row to a caller who could decide it (backend
 * u3-gates.ts `webA3DecideTemplate`). inputs_hash is the SEALED a3_inputs_hash (design_hash
 * with the write-set seal folded in), never the bare design_hash.
 */
export interface G12A3DecideTemplate {
  rule_version: string;
  rule_row: string;
  inputs_hash: string;
  item_id: string;
  approve_codes: string[];
  reject_codes: string[];
}

/**
 * GET /api/approvals/:id `g12_decide` — served ONLY on a pending, marked
 * `execution.ready_signoff` row (backend u3-gates.ts `webA1DecideTemplate`). The
 * browser stamps these verbatim; it never re-spells a rule_version or a code.
 */
export interface G12DecideTemplate {
  rule_version: string;
  rule_row: string;
  inputs_hash: string;
  reject_codes: string[];
}

// =============================================================================
// COMMENT TYPES
// =============================================================================

/**
 * Comment mention
 */
export interface CommentMention {
  user_id: string;
  username: string;
}

/**
 * Comment entity
 */
export interface Comment {
  id: string;
  project_id: string;
  author_id: string;
  content: string;
  mentions?: CommentMention[];

  created_at: string | Date;
  updated_at: string | Date;
  edited: boolean;
}

/**
 * Create comment payload
 */
export interface CommentCreate {
  content: string;
  mentions?: CommentMention[];
}

/**
 * Update comment payload
 */
export interface CommentUpdate {
  content: string;
  mentions?: CommentMention[];
}

// =============================================================================
// QUALITY & ARCHITECTURE TYPES
// =============================================================================

/**
 * Quality gate status. `inconclusive` = coding-analysis abstained (no analysis
 * tool completed): the gate is NOT a pass, but it is also not a graded failure —
 * it must render muted, never red/amber. Emitted by adaptQualityGateResult.
 */
/**
 * `not_analyzed` (coding-analysis #107): nothing stored and nothing measured —
 * distinct from `inconclusive`, and never rendered with a score.
 */
export type QualityGateStatus = 'passed' | 'failed' | 'warning' | 'inconclusive' | 'not_analyzed';

/**
 * Quality metric
 */
export interface QualityMetric {
  name: string;
  value: number;
  threshold?: number;
  status: QualityGateStatus;
  description?: string;
}

/**
 * Quality gate response
 */
export interface QualityGate {
  container_name: string;
  status: QualityGateStatus;
  metrics: QualityMetric[];
  timestamp: string | Date;
  /** null when the scan was inconclusive (coding-analysis abstained). Never -1.0. */
  overall_score?: number | null;
  grade?: string;
  /** True when no analysis tool completed — the gate is NOT a pass. */
  inconclusive?: boolean;
  /**
   * True when some (not all) analysis tools completed — the grade is real but
   * computed from a subset (coding-analysis PR-U1). Mutually exclusive with
   * `inconclusive`. The tool lists back a "graded on N of M tools" caveat.
   */
  partial?: boolean;
  tools_attempted?: string[];
  tools_succeeded?: string[];
  tools_failed?: string[];
  recommendations?: string[];
  details?: any;
  /** Stored-run status of the graded result (complete|partial|inconclusive|failed|not_analyzed). */
  result_status?: string | null;
  result_id?: string | null;
  /** Commit the graded result measured; null = unknown. */
  commit_sha?: string | null;
  /** Whether the gate graded a stored row or analysed on a miss. */
  source?: 'stored' | 'analyzed' | null;
}

// ---------------------------------------------------------------------------
// Project Quality tab (fr#1305) — GET /api/projects/:id/quality
// ---------------------------------------------------------------------------

export type StoredQualityStatus = 'complete' | 'partial' | 'inconclusive' | 'failed' | 'not_analyzed';
export type QualitySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ProjectCiState = 'success' | 'failure' | 'pending' | 'none' | 'unknown';

export interface ProjectQualityIssue {
  tool: string | null;
  severity: QualitySeverity;
  severity_raw: string | null;
  message: string | null;
  file_path: string | null;
  line_number: number | null;
  rule_id: string | null;
}

export interface ProjectQualityLatest {
  container_name: string;
  status: StoredQualityStatus;
  result_id: string | null;
  commit_sha: string | null;
  analyzed_at: string | null;
  /** Present only for complete/partial. */
  overall_score: number | null;
  /** Letter only for complete; 'N/A' for inconclusive; null otherwise. */
  grade: string | null;
  tools_attempted: string[];
  tools_succeeded: string[];
  tools_failed: string[];
  issues_total: number;
  issues_truncated: boolean;
  issues: ProjectQualityIssue[];
  severity_counts: Record<QualitySeverity, number>;
  error_message?: string | null;
  message?: string;
}

export interface ProjectCiRun {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string | null;
  run_attempt: number | null;
  created_at: string | null;
}

export interface ProjectRepoQuality {
  repo_id: string;
  name: string;
  url: string;
  is_primary: boolean;
  container_name: string | null;
  /** null ONLY when the stored-result read failed (see latest_error). */
  latest: ProjectQualityLatest | null;
  latest_error?: string;
  /** Why a stored result was NOT attributed to this repo (renders not_analyzed). */
  mismatch?: 'result_belongs_to_another_repo' | 'repo_unverified' | 'shared_container';
  ci: { state: ProjectCiState; commit_sha: string | null; runs: ProjectCiRun[]; reason?: string };
}

export interface ProjectQualityAnalysis {
  state: 'provisioning' | 'analyzing' | 'done' | 'error';
  started_at: string;
  finished_at?: string;
  error?: string;
  repos: Array<{
    repo_id: string;
    name: string;
    container_name: string | null;
    state: 'pending' | 'provisioning' | 'analyzing' | 'done' | 'error';
    provisioned?: boolean;
    task_id?: string;
    result_id?: string | null;
    error?: string;
  }>;
}

export interface ProjectQuality {
  project_id: string;
  repositories: ProjectRepoQuality[];
  analyze_repo_cap: number;
  analysis: ProjectQualityAnalysis | null;
  /** Super-admin read of another tenant's project: nothing was read upstream. */
  cross_tenant?: boolean;
}

export interface ProjectQualityHistoryRow {
  id: string;
  commit_sha: string | null;
  status: StoredQualityStatus;
  overall_score: number | null;
  grade: string | null;
  tools_attempted: number;
  tools_succeeded: number;
  created_at: string | null;
}

export interface ProjectQualityHistory {
  repo_id: string;
  container_name: string | null;
  status: 'ok' | 'not_analyzed';
  results: ProjectQualityHistoryRow[];
}

/**
 * Architecture node
 */
export interface ArchitectureNode {
  id: string;
  label: string;
  type: string;
  metadata?: Record<string, any>;
}

/**
 * Architecture edge
 */
export interface ArchitectureEdge {
  source: string;
  target: string;
  type?: string;
  label?: string;
}

/**
 * Architecture graph response
 */
export interface ArchitectureGraph {
  container_name: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  metadata?: Record<string, any>;
  timestamp: string | Date;
}

/**
 * Dependency vulnerability
 */
export interface DependencyVulnerability {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affected_versions?: string;
  fixed_version?: string;
}

/**
 * Dependency item
 */
export interface Dependency {
  name: string;
  version: string;
  type?: 'direct' | 'transitive';
  license?: string;
  vulnerabilities?: DependencyVulnerability[];
}

/**
 * Dependency report response
 */
export interface DependencyReport {
  container_name: string;
  dependencies: Dependency[];
  total_count: number;
  vulnerable_count: number;
  critical_count: number;
  timestamp: string | Date;
  // Set by fr-backend when the live report (which needs the running job
  // container) is unavailable and it served the snapshot coding-analysis
  // persisted at analysis time — mirrors the Architecture graph's degrade path.
  degraded?: boolean;
  stale_as_of?: string | Date;
}

// =============================================================================
// METRICS TYPES
// =============================================================================

/**
 * Aggregate metrics response (matches backend /api/metrics/aggregate shape).
 */
export interface AggregateMetrics {
  time_period: { start: string; end: string };
  projects_count: number;
  aggregate_metrics: {
    average_cycle_time_days: number;
    average_lead_time_days: number;
    total_throughput: number;
    overall_success_rate: number;
    overall_error_rate: number;
    overall_quality_score: number;
    total_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
  };
  by_project: Array<{
    project_id: string;
    project_name: string;
    data_points: number;
  }>;
}

/**
 * Metrics query parameters
 */
export interface MetricsQueryParams extends QueryParams {
  start_date?: string;
  end_date?: string;
  project_id?: string;
  interval?: 'day' | 'week' | 'month';
}

// =============================================================================
// WORKFLOW TYPES
// =============================================================================

/**
 * Workflow status
 */
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Workflow entity
 */
export interface Workflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  flow_id?: string;
  config?: Record<string, any>;

  started_at?: string | Date;
  completed_at?: string | Date;
  error_message?: string;
}

// =============================================================================
// KANBAN / PLANKA TYPES
// =============================================================================

/**
 * Planka board summary (from list endpoint)
 */
export interface PlankaBoard {
  id: string;
  name: string;
  projectId: string;
  projectName?: string;
  position: number;
  /**
   * The fr project whose board this is (`projects.planka_board_id`), resolved
   * server-side by GET /api/kanban/boards within the caller's tenant; null for
   * a non-project (stream / ad-hoc) board. Absent from an older backend.
   * fr-agui SPEC §7.5: `/kanban?board=` of a project board → /projects/P/board.
   */
  frProjectId?: string | null;
}

/**
 * Planka list (column) within a board
 */
export interface PlankaList {
  id: string;
  name: string;
  boardId: string;
  position: number;
}

/**
 * Planka card
 */
export interface PlankaCard {
  id: string;
  name: string;
  description: string | null;
  listId: string;
  boardId: string;
  position: number;
  dueDate: string | null;
  stopwatch: any | null;
  labels: PlankaLabel[];
  memberIds: string[];
  commentCount?: number;
  isClosed?: boolean;
  type?: 'project' | 'story';
  // AA-spec card classification, sourced from Metadata.card_type customField.
  // null when the card was created outside the improvement-card flow.
  card_type?: string | null;
  card_group?: string | null;
}

/**
 * Planka label
 */
export interface PlankaLabel {
  id: string;
  name: string | null;
  color: string;
  boardId?: string;
  position?: number;
}

/**
 * Planka comment
 */
export interface PlankaComment {
  id: string;
  cardId: string;
  userId: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Planka task (checklist item)
 */
export interface PlankaTask {
  id: string;
  name: string;
  isCompleted: boolean;
  position: number;
  taskListId?: string;
  cardId?: string;
}

/**
 * Planka task-list (checklist container on a card)
 */
export interface PlankaTaskList {
  id: string;
  name: string;
  position: number;
  cardId?: string;
}

/**
 * Planka user (authored by kanban proxy)
 */
export interface PlankaUser {
  id: string;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

/**
 * Planka board membership (maps user <-> board)
 */
export interface PlankaBoardMembership {
  id: string;
  boardId: string;
  userId: string;
  role?: 'editor' | 'viewer';
  canComment?: boolean;
}

/**
 * Planka card membership (maps user <-> card)
 */
export interface PlankaCardMembership {
  id: string;
  cardId: string;
  userId: string;
}

/**
 * Planka board detail response
 */
export interface PlankaBoardDetail {
  board: PlankaBoard;
  lists: PlankaList[];
  cards: PlankaCard[];
  labels: PlankaLabel[];
  users?: PlankaUser[];
  boardMemberships?: PlankaBoardMembership[];
  cardMemberships?: PlankaCardMembership[];
  taskLists?: PlankaTaskList[];
  tasks?: PlankaTask[];
}

/**
 * Planka card detail response
 */
export interface PlankaCardDetail {
  card: PlankaCard;
  tasks: PlankaTask[];
  comments: PlankaComment[];
  /** `null` when the card's action log could not be read (never `[]`, which
   *  would claim the card genuinely has no history). */
  actions: any[] | null;
  taskLists?: PlankaTaskList[];
  users?: PlankaUser[];
  cardMemberships?: PlankaCardMembership[];
}

// --- Write payloads ---------------------------------------------------------

export interface PlankaCreateCardBody {
  name: string;
  description?: string;
  position?: number;
  dueDate?: string | null;
  type?: 'project' | 'story';
}

export interface PlankaUpdateCardBody {
  name?: string;
  description?: string | null;
  dueDate?: string | null;
  isClosed?: boolean;
}

export interface PlankaMoveCardBody {
  listId: string;
  position: number;
}

export interface PlankaDuplicateCardBody {
  name?: string;
}

export interface PlankaCreateCommentBody {
  text: string;
}

// =============================================================================
// REQUEST/RESPONSE INTERCEPTOR TYPES
// =============================================================================

/**
 * Request interceptor function
 */
export type RequestInterceptor = (
  url: string,
  options: RequestInit
) => Promise<{ url: string; options: RequestInit }> | { url: string; options: RequestInit };

/**
 * Response interceptor function
 */
export type ResponseInterceptor = (response: Response) => Promise<Response> | Response;

/**
 * Error interceptor function
 */
export type ErrorInterceptor = (error: Error) => Promise<never> | never;

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Query parameters for list endpoints
 */
export interface QueryParams {
  page?: number;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  status?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * API client configuration
 */
export interface ApiClientConfig {
  baseUrl?: string;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
}

/**
 * Loading state
 */
export interface LoadingState {
  isLoading: boolean;
  endpoint?: string;
  method?: string;
}

// =============================================================================
// SCHEDULED TRIGGER TYPES (Spec 2 §2-B)
// =============================================================================

export type ConnectorKind = 'file' | 'rss' | 'github_query' | 's3' | 'n8n_webhook';
/**
 * Kinds a user may create, edit or test. `file` stays in ConnectorKind only so
 * a legacy stored row still types; the backend refuses it on every path (H1).
 */
export type UserConnectorKind = Exclude<ConnectorKind, 'file'>;

export type ScheduledTriggerStatus = 'active' | 'paused' | 'disabled';

/**
 * Card-template shape persisted to `scheduled_triggers.card_template` (jsonb).
 * Mirrors backend `CardTemplateSchema` in routes/scheduled-triggers.ts and the
 * Drizzle column type in db/schema.ts.
 */
export interface ScheduledTriggerCardTemplate {
  card_type: string;
  labels?: string[];
  custom_fields?: Record<string, unknown>;
}

/**
 * A scheduled trigger row as returned by the API. Routes return the raw
 * Drizzle row (jsonResponse(row)), so this mirrors the `scheduled_triggers`
 * table columns 1:1 (see backend/src/db/schema.ts).
 */
export interface ScheduledTrigger {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  cron: string;
  timezone: string;
  source_connector: ConnectorKind;
  connector_config: Record<string, unknown>;
  payload_mapper: Record<string, string>;
  target_list: string;
  card_template: ScheduledTriggerCardTemplate;
  enabled: boolean;
  last_run_at?: string | null;
  last_run_status?:
    | 'ok'
    | 'error'
    | 'no_new_records'
    | 'skipped_no_connector'
    | 'config_invalid'
    | 'partial_failure'
    | null;
  last_run_error?: string | null;
  // Plan 2-D Phase 8 — provenance link populated only when the trigger
  // was promoted from a suggested-schedules row (POST
  // /api/suggested-schedules/:id/accept). NULL for hand-created
  // triggers. Drives the "from suggestion #<short>" badge on
  // /channels/[id].
  from_suggestion_id?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * POST /api/scheduled-triggers body. Mirrors backend `CreateBodySchema.strict()`.
 * Fields with backend defaults (timezone, target_list, enabled) are optional
 * here; `card_template` and `payload_mapper` are required (no defaults).
 */
export interface ScheduledTriggerCreate {
  project_id: string;
  name: string;
  cron: string;
  timezone?: string;
  source_connector: ConnectorKind;
  connector_config: Record<string, unknown>;
  payload_mapper: Record<string, string>;
  target_list?: string;
  card_template: ScheduledTriggerCardTemplate;
  enabled?: boolean;
}

/**
 * PATCH /api/scheduled-triggers/:id body. Mirrors backend
 * `PatchBodySchema.strict()`. Note `source_connector` is intentionally
 * NOT patchable — connector kind is fixed at create time.
 */
export interface ScheduledTriggerUpdate {
  name?: string;
  cron?: string;
  timezone?: string;
  connector_config?: Record<string, unknown>;
  payload_mapper?: Record<string, string>;
  target_list?: string;
  card_template?: ScheduledTriggerCardTemplate;
  enabled?: boolean;
}

/**
 * Audit row from `scheduled_trigger_runs` (Spec 2 §5.5). Status set is the
 * union of constraints in migrations 041 + 042. Used by Channels detail page.
 */
export type ScheduledTriggerRunStatus =
  | 'ok'
  | 'error'
  | 'no_new_records'
  | 'skipped_no_connector'
  | 'template_not_found'
  | 'render_error'
  | 'in_progress'
  | 'config_invalid'
  | 'partial_failure';

export type ScheduledTriggerRunKind = 'cron' | 'manual' | 'webhook';

export interface ScheduledTriggerRun {
  id: string;
  trigger_kind: 'scheduled_intake';
  trigger_id: string;
  tenant_id: string;
  project_id: string;
  fired_at: string;
  finished_at: string | null;
  status: ScheduledTriggerRunStatus;
  records_processed: number;
  error_message: string | null;
  kind: ScheduledTriggerRunKind;
  triggered_by_user_id: string | null;
  created_at: string;
}

