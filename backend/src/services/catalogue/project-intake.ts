// src/services/catalogue/project-intake.ts
//
// THE MAPPING between fr's project create fields and requirements_management's
// pm_project INTAKE + versioned BRIEF (rm#213 / rm#215, George 2026-10-13):
//
//   * the user creates a project in fr; the project is STORED IN RM with ALL of
//     the user's intake, the brief as version 1;
//   * the conveyor's enhancements become new brief versions;
//   * fr DISPLAYS the brief from RM and keeps NO local copy of intake or brief.
//
// ⛔ WHAT fr STILL KEEPS IN `projects.project_data` — and why. Each key below has
// an fr-side reader that decides something SYNCHRONOUSLY inside fr's own DB or
// request path, where an RM read would either be impossible (a SQL predicate /
// unique index) or turn an RM outage into a wrong decision:
//
//   keycloak_tenant_id      tenancy: the authoritative owner tag (19 SQL readers)
//   programme_id            GET /api/projects?programme_id= is a SQL filter
//   bug_hunt                migration 163's unique index (one live hunt per repo)
//   cve_sweep               supersedePriorCveSweepProjects selects on it in SQL
//   it_flow                 routes/cards/project.ts picks the IT analysis card
//   fixture, requestor      lib/execution-signoff.ts isFixtureOrigin: whether a
//                           human sign-off is minted (must not fail open)
//   + every server-built key (external_origin, template start, contract close …)
//
// Everything else the create door accepts lives ONLY in RM — the PRIORITY
// included (`priority_level_id`, read back through project-state.ts; fr keeps no
// copy — v4, RM is the source of truth; its audit row is priority_change_events).

import type { ProjectIn, ProjectBrief, ItInputs, ProjectRepository } from '@fr/service-client-requirements';
import type { PmProjectIn, PmProjectRow } from '../../integrations/pm';
import { DEFAULT_APPROVAL_MODE } from '../../types/api';

/** Every key of RM's `ProjectBrief`, compiler-checked in both directions. */
const BRIEF_FIELDS = {
  problem_statement: true,
  desired_outcome: true,
  business_case: true,
  success_criteria: true,
  acceptance_criteria: true,
  in_scope: true,
  out_of_scope: true,
  high_level_requirements: true,
  // A rewrite's target language, extracted from the REQUEST (George 2026-11-07).
  target_language: true,
  assumptions: true,
  access_requirements: true,
  stakeholders: true,
  approvers: true,
  deadline: true,
  budget: true,
  notes: true,
  constraints: true,
  dependencies: true,
  risks: true,
} satisfies Record<keyof ProjectBrief, true>;

export type BriefKey = keyof ProjectBrief;
export const BRIEF_KEYS: readonly BriefKey[] = Object.keys(BRIEF_FIELDS) as BriefKey[];

/** Every key of RM's `ItInputs` (fr's IT-project inputs), compiler-checked. */
const IT_INPUT_FIELDS = {
  it_flow: true,
  min_severity: true,
  cve_sweep: true,
  bug_hunt: true,
  target_packages: true,
  test_command: true,
  bug_test_command: true,
  test_workdir: true,
  failing_test_ref: true,
  finding_description: true,
  bug_description: true,
  target_files: true,
  // A rewrite's target language is NOT here: it is on the brief (BRIEF_FIELDS above).
  // Which conveyor sign-offs the user is asked for (George 2026-10-27): RM-only.
  approval_mode: true,
} satisfies Record<keyof ItInputs, true>;

export const IT_INPUT_KEYS: readonly (keyof ItInputs)[] = Object.keys(IT_INPUT_FIELDS) as (keyof ItInputs)[];

/**
 * The fr project_data keys fr KEEPS (see the header). Server-built keys
 * (extraProjectData, the template start) are added by the create path itself.
 */
export const FR_KEPT_INTAKE_KEYS = ['programme_id', 'bug_hunt', 'cve_sweep', 'it_flow', 'fixture', 'requestor'] as const;

/**
 * Every fr create key that now lives ONLY in RM — the brief, the IT inputs fr
 * does not decide on, and the rest of the intake. PATCH /api/projects/:id
 * refuses them as RM-owned (RM_OWNED_PATCH_KEYS), and a test asserts
 * project_data carries none of them.
 */
export const RM_ONLY_PROJECT_DATA_KEYS: readonly string[] = [
  ...BRIEF_KEYS,
  ...IT_INPUT_KEYS.filter((k) => !(FR_KEPT_INTAKE_KEYS as readonly string[]).includes(k)),
  'question_mode',
  'lifecycle_class',
  'secret_ids',
  'document_ids',
  'repository_id',
  'repo',
  'expected_size',
  // The priority: RM's `priority_level_id` (+ its legacy text). No fr copy.
  'priority',
  'priority_level_id',
];

/** The fr create fields this module reads (a structural subset of ProjectCreate). */
export interface FrCreateIntake {
  [key: string]: unknown;
  repo?: {
    primary: { url: string; branch?: string; path?: string; role?: RepoRole; sha?: string };
    additional?: Array<{ url: string; branch?: string; name?: string; role?: RepoRole; sha?: string }>;
  };
  repository_url?: string | null;
  branch?: string;
  repository_id?: string;
  coordination_mode?: 'coordinated' | 'independent';
  shape?: 'deliverable' | 'continuous_flow';
  question_mode?: 'structured' | 'free_text' | null;
  lifecycle_class?: 'system' | 'workflow-improvement' | 'execution' | 'prompt-improvement';
  fixture?: boolean;
  requestor?: string;
  programme_id?: string;
  secret_ids?: string[];
  document_ids?: string[];
  bound_assets?: Record<string, string[] | undefined>;
}

/** RM's `ProjectRepository.role` (rewrite projects). */
type RepoRole = NonNullable<ProjectRepository['role']>;

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * The RM repositories list of an fr create body (primary first, at most one primary).
 * A rewrite project's `role` / `sha` pass through untouched; when absent they are
 * OMITTED (never null), so every non-rewrite list is byte-identical to before.
 */
export function rmRepositoriesOf(v: FrCreateIntake): ProjectRepository[] | undefined {
  if (v.repo?.primary?.url) {
    const p = v.repo.primary;
    return [
      defined({ url: p.url, branch: p.branch ?? v.branch ?? null, path: p.path, primary: true, role: p.role, sha: p.sha }) as ProjectRepository,
      ...(v.repo.additional ?? []).map(
        (r) => defined({ url: r.url, branch: r.branch ?? null, name: r.name, primary: false, role: r.role, sha: r.sha }) as ProjectRepository,
      ),
    ];
  }
  if (v.repository_url) return [{ url: v.repository_url, branch: v.branch ?? null, primary: true }];
  return undefined;
}

/** The brief (v1) of an fr create body: every ProjectBrief key the body carries. */
export function rmBriefOf(v: Record<string, unknown>): ProjectBrief {
  const brief: Record<string, unknown> = {};
  for (const k of BRIEF_KEYS) {
    if (v[k] !== undefined && v[k] !== null) brief[k] = v[k];
  }
  return brief as ProjectBrief;
}

/**
 * The RM ItInputs of an fr create body. `approval_mode` is ALWAYS set: a body
 * without one gets DEFAULT_APPROVAL_MODE (George 2026-10-31, R329), so the stored
 * mode never depends on the flows' fallback for an unset value. This is the one place every
 * fr create path (form, POST /api/projects, project-request approve, the agent's
 * projects.create) writes RM `it_inputs`.
 */
export function rmItInputsOf(v: Record<string, unknown>): ItInputs {
  const out: Record<string, unknown> = {};
  for (const k of IT_INPUT_KEYS) {
    if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
  }
  out.approval_mode ??= DEFAULT_APPROVAL_MODE;
  return out as ItInputs;
}

/**
 * The FULL RM intake of an fr project create (ProjectIn minus the link/type,
 * which the caller adds) — `brief` always present (`{}` when empty). `scopeLevel` is fr's DERIVED value; `priorityLevelId`
 * the owner tenant's resolved RM level.
 */
export function rmIntakeOfCreate(
  v: FrCreateIntake,
  extra: { scopeLevel?: string | null; priorityLevelId?: string | null },
): FrCreateRmIntake {
  const attachments =
    (v.secret_ids?.length ?? 0) > 0 || (v.document_ids?.length ?? 0) > 0
      ? { secret_ids: v.secret_ids ?? [], document_ids: v.document_ids ?? [] }
      : undefined;
  const intake = defined({
    repositories: rmRepositoriesOf(v),
    repository_id: v.repository_id,
    coordination_mode: v.coordination_mode,
    scope_level: (extra.scopeLevel ?? undefined) as ProjectIn['scope_level'],
    shape: v.shape,
    question_mode: v.question_mode ?? undefined,
    lifecycle_class: v.lifecycle_class,
    fixture: v.fixture,
    priority_level_id: extra.priorityLevelId ?? undefined,
    requested_by: v.requestor,
    programme_id: v.programme_id,
    it_inputs: rmItInputsOf(v),
    attachments,
    bound_assets: v.bound_assets && Object.keys(v.bound_assets).length > 0 ? (v.bound_assets as ProjectIn['bound_assets']) : undefined,
  });
  // ALWAYS a brief (RM: 422 `brief_required`), `{}` when the user filled none.
  // No author kind: RM derives it from fr's delegated call.
  return { ...intake, brief: rmBriefOf(v) };
}

/**
 * The RM intake of an fr create: every intake key optional, the brief REQUIRED
 * (RM refuses a project POST without one — 422 `brief_required`).
 */
export type FrCreateRmIntake = Partial<PmProjectIn> & { brief: ProjectBrief };

/** fr's project_data for a new project: only the keys fr KEEPS (see header). */
export function frKeptProjectData(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FR_KEPT_INTAKE_KEYS) {
    if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
  }
  return out;
}

/**
 * RM's intake + brief of a pm_project in fr's FLAT project_data vocabulary
 * (problem_statement, test_command, question_mode, requestor, secret_ids …), for
 * the readers that consumed those keys from project_data (n8n via GET
 * /api/projects/:id, the brief). Only keys RM holds a value for are present.
 */
export function frIntakeFieldsFromRm(row: PmProjectRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const brief = (row.brief ?? {}) as Record<string, unknown>;
  for (const k of BRIEF_KEYS) if (brief[k] !== undefined && brief[k] !== null) out[k] = brief[k];
  const it = (row.it_inputs ?? {}) as Record<string, unknown>;
  for (const k of IT_INPUT_KEYS) if (it[k] !== undefined && it[k] !== null) out[k] = it[k];
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) out[k] = v;
  };
  put('question_mode', row.question_mode);
  put('lifecycle_class', row.lifecycle_class);
  put('fixture', row.fixture);
  put('requestor', row.requested_by);
  put('expected_size', row.expected_size);
  put('repository_id', row.repository_id);
  put('bound_assets', row.bound_assets);
  if (row.attachments) {
    put('secret_ids', row.attachments.secret_ids);
    put('document_ids', row.attachments.document_ids);
  }
  return out;
}
