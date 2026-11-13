// src/db/schema.ts
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  // Calendar day, no time and no zone — project_milestones.target_date
  // (migration 127). A milestone is agreed as a DATE; widening it to a
  // timestamptz would invent a time of day and a zone nobody agreed.
  date,
  boolean,
  integer,
  bigint,
  jsonb,
  numeric,
  // family_decisions.seq (migration 128) — a global, monotonic claim order.
  bigserial,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  check,
  real,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bytea } from './custom-types';
// Type-only import — erased at compile time, so no runtime module cycle even
// though lib/ sits "above" db/ in the layering.
import type { SignoffBlockReason } from '../lib/execution-signoff';

// Improvement-stream registry enums (migration 026). pgEnum uses the same
// underlying Postgres ENUM type names declared in the SQL migration; we
// keep them here so route + repository layers can consume the literal-
// union types Drizzle infers (`(typeof streamKindEnum)['enumValues'][number]`).
export const streamKindEnum = pgEnum('stream_kind', [
  'workflow',
  'prompt',
  'principle',
  'requirement',
  'decision',
]);
export const assetKindEnum = pgEnum('asset_kind', [
  'workflow',
  'prompt',
  'kag_source',
  'coding_repository',
  'requirement',
  'principle',
  'decision',
  'artifact',
  // Migration 144 (n8n_custom_nodes#1925). A kaizen_log row whose DONE
  // procedure did not resolve is attributed to the CARD itself; asset_id is
  // then NULL and kaizen_card_id identifies the card. NOT a stream member —
  // see STREAM_MEMBER_ASSET_KINDS below and the asset_stream_membership CHECK.
  'card',
]);

/**
 * The asset kinds that may be a member of an improvement stream: every
 * `asset_kind` value EXCEPT 'card' (migration 144 — a kaizen_log attribution
 * only, forbidden in asset_stream_membership by a CHECK). Derived, never
 * hand-copied. Every route that
 * validates a stream-membership kind reads this, not `assetKindEnum.enumValues`.
 */
export type StreamMemberAssetKind = Exclude<(typeof assetKindEnum.enumValues)[number], 'card'>;
export const STREAM_MEMBER_ASSET_KINDS = assetKindEnum.enumValues.filter(
  (k): k is StreamMemberAssetKind => k !== 'card',
) as unknown as readonly [StreamMemberAssetKind, ...StreamMemberAssetKind[]];

// Plan 5 Stage 1.1 (migration 038). Discriminator on `approvals` so the
// notification render layer + the n8n improvement subflows can dispatch
// per-kind. 'generic' covers all pre-improvement approvals.
export const approvalKindEnum = pgEnum('approval_kind', [
  'generic',
  'improvement.design',
  'improvement.release',
  // Migration 073 — AA ready-prefetch policy gate. A card parked in BLOCKED
  // awaiting human stakeholder sign-off before it may resume into DOING.
  'execution.ready_signoff',
  // Migration 086 — workflow-canary cockpit action. The improvement/workflows
  // "Extend canary" + "Rollback" controls raise a human-approval-gated routing
  // action; on approval n8n dispatches to worker_management keyed by
  // (card_type, list). metadata.canary_action ∈ {rollback, extend}.
  'improvement.canary_action',
  // Migration 123 — a human deciding a proposed project OUTLINE (Stage B).
  // Carries project_request_id instead of project_id: at decision time the
  // project does not exist yet, which is the whole point of the stage.
  'project_outline.approval',
  // Migration 152 (U3 / AA-TRACE §6.13): its decision carries a G-12 body, validated by the
  // shared decide path on every seat.
  'execution.feature_design_approval',
  // U3 proof-run kinds (src/services/approvals/u3-gates.ts); feature_design above is 152's.
  // qa.coverage_signoff is DERIVED at mint — migration 153. The bug-fix gate is NOT a kind
  // (RULING 10-01): it is the metadata.approval_kind 'bug_fix_authorization' marker.
  'qa.coverage_signoff',
  // Migration 156 — U4 G-12 A5: the BLOCKING landing sign-off. A proof PR merges only through
  // an approved A5 whose write-set check passed at the PR head (constraint-check
  // `diff_outside_write_set`, src/lib/write-set.ts).
  'execution.landing_signoff',
  // Migration 155 — U3 G-12 A6: a conveyor QUESTION stamped at mint with `metadata.question_id`
  // from the pre-registered answer table (services/approvals/question-registry.ts). Web-only.
  'execution.question',
  // Migration 200 — G8 / R313: a tenant_admin deciding whether a PROJECT copy of a governed
  // asset (requirement / principle / decision) replaces its tenant original. On approve fr
  // calls RM `POST /{kind}/{copy_id}/promote` (services/approvals/asset-promotion.ts).
  'asset.promotion',
  // Migration 204 — R318's board-move confirmation. Retired by R349 (2026-11-04): fr no longer
  // creates it; kept so historical rows still type-check against the DB's CHECK.
  'board.move_confirmation',
]);

// Projects table
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner_id: uuid('owner_id').notNull(), // Keycloak user ID
  name: text('name').notNull(),
  description: text('description'),
  // Migration 190 (George 2026-10-13): optional — a project need not have a repo.
  // NULL = no repository; repo-dependent features treat it as not applicable.
  repository_url: text('repository_url'),
  branch: text('branch').default('main').notNull(),
  // submitted, active, archived, failed, pending, cancelled, delivered.
  // `delivered` (migration 173) is terminal and NOT live
  // (lib/project-live-status.ts). RM closure is DERIVED per read
  // (services/project-delivered.ts); the ONLY writer of this column's
  // 'delivered' value is the reconcile worker
  // (workers/project-delivered-reconcile.ts), which stores it solely so the
  // bug-hunt partial unique index can free the repo's slot — a read never
  // writes. Rows stored earlier (the old read-time stamp, the removed
  // bug-hunt check) are the same state.
  status: text('status').notNull().default('submitted'),

  // Migration 173 — set together when a project becomes `delivered`: {source:'rm_project_closed',
  // rm_pm_project_id, phase} (services/project-delivered.ts); older bug-hunt rows carry
  // {computed_check_id, evidence_sha, outcome, hunt_card_id, pr:{number, head_sha, url}}. Kept on a later archive.
  delivered_at: timestamp('delivered_at', { withTimezone: true }),
  delivery_evidence: jsonb('delivery_evidence'),

  // n8n/Planka references
  n8n_project_id: text('n8n_project_id'),
  planka_board_id: text('planka_board_id'),
  planka_project_id: text('planka_project_id'),

  // coding-containers reference — set after POST /api/containers/ succeeds on
  // coding-gateway. Derived from the project name (slugged to match
  // ^[a-zA-Z][a-zA-Z0-9\-_]{0,62}$). Architecture / Dependency / Quality tabs
  // look this up against coding-gateway; without it they return 404.
  container_name: text('container_name'),

  // (`github_token_secret_id` is no longer declared, George 2026-10-18: repository access is
  // the GitHub App's; there is no per-project token. The column itself is dropped by a follow-up
  // migration once this release is live, so a rolling old pod never selects a missing column.)

  // TRUE only after the coding-containers container is created. Narrower than
  // it looks — it does NOT mean the code graph exists. See `graph_initialized`.
  repository_provisioned: boolean('repository_provisioned').default(false),

  // Migration 061. TRUE only when coding-gateway's graph-initialize step
  // actually succeeded (ok or 409 already-exists). The Architecture /
  // Dependency / Quality tabs need this — `repository_provisioned` alone is
  // not enough. handleProvisionProject keeps these two flags independent so
  // a failed graph-init no longer masquerades as a fully provisioned project.
  graph_initialized: boolean('graph_initialized').notNull().default(false),

  // Extended project data (JSONB for all template fields)
  project_data: jsonb('project_data'),
  project_type: text('project_type'),
  scope_level: text('scope_level'),

  // Spec 2 §4.1 — project shape. `deliverable` (default) is the existing
  // shape (target output + end date + burndown). `continuous_flow` is the
  // open-ended kanban-with-recurring-intake shape introduced by migration
  // 041; cron-driven `scheduled_triggers` rows mint cards into this
  // project's INBOX. `card_type` whitelist (work_intake_record only) is
  // enforced in the kanban create-card proxy. Switching shape after
  // creation is rejected with 422 (§13 RBAC).
  shape: text('shape', { enum: ['deliverable', 'continuous_flow'] })
    .notNull()
    .default('deliverable'),

  // Foundation Plan 2 — soft membership in a department. Migration 029
  // added the column; 032 backfilled it; 033 relaxed the FK to
  // ON DELETE SET NULL. Kept nullable in production to avoid blocking
  // multi-workspace clusters that can't deterministically backfill.
  // Critically, this declaration drives CI's `bunx drizzle-kit push` —
  // without it (or without `onDelete: 'set null'`) the projects table
  // on CI gets a NO-ACTION FK that blocks the workspaces-cascade chain
  // every test does in beforeEach, failing ~25 Plan 2 service+route
  // tests with FK-violation cleanup errors. The runtime references()
  // call needs `departments` defined first — its declaration is later
  // in this file, so we use a forward-ref function below.
  dept_id: uuid('dept_id').references(() => departments.id, {
    onDelete: 'set null',
  }),

  // Andon-cord (migration 050). When true, every automated loop
  // (scheduled-trigger-tick, suggestion-heuristic, future agent loop)
  // pre-flight-skips this project. Set via POST /api/projects/:id/andon/engage.
  andon_engaged: boolean('andon_engaged').notNull().default(false),
  andon_engaged_at: timestamp('andon_engaged_at', { withTimezone: true }),
  andon_engaged_by: text('andon_engaged_by'),
  // Migration 206 — R318: WHY the cord is engaged. 'operator' (a super_admin pulled it) or
  // 'move_request' (fr pulled it for a waiting board move). NULL on a released cord, and on a
  // cord engaged before 206 — read engaged + NULL as 'operator' (services/project-andon.ts).
  andon_reason: text('andon_reason', { enum: ['operator', 'move_request'] }),
  // The move request that pulled a 'move_request' cord (fr's CAS key while the conveyor
  // evaluates it) and the board.move_confirmation approval that holds it (the conveyor's
  // release key and gate bypass). Both NULL for an operator cord.
  andon_request_id: uuid('andon_request_id'),
  andon_approval_id: uuid('andon_approval_id'),

  // Macro lifecycle phase (migration 081) — the "Copilot-led" redesign's phase
  // rail. Distinct from `status` (operational submitted/active/archived/failed):
  // this is where the project sits on the AA spine
  //   request → preliminary_analysis → contract → deep_analysis → epic_design →
  //   enabler_architecture → enabler_development → feature_design →
  //   feature_development
  // with `continuous` for continuous_flow (kaizen/meta) boards. Plain text with
  // a documented vocabulary (mirrors `status`/`shape`) so adding phases is a code
  // change, not a DB-enum migration. n8n stamps it forward on gate approval via
  // PATCH /api/projects/:id/phase (contract gate wired first).
  project_phase: text('project_phase').notNull().default('request'),
  project_phase_updated_at: timestamp('project_phase_updated_at', {
    withTimezone: true,
  }),

  // Migration 127 — the effort estimate a human APPROVED, copied from
  // project_outlines.effort_estimate at promotion.
  // ⚠️ NOT the free-text ProjectCreate.effort_estimate that lands in
  // project_data: that one is a customer's guess typed BEFORE any analysis, is
  // read by nothing, and is deleted in this same PR. This column is the output
  // of a decision, named differently so no reader can confuse the two.
  // Nullable: every pre-outline-flow project, and any outline that agreed scope
  // without an effort figure.
  approved_effort_estimate: jsonb('approved_effort_estimate'),

  // Migration 143 — how this project's 0..N `project_repositories` are worked.
  // 'coordinated' = one unit of work across every repo; 'independent' = each
  // repo moves on its own. The DEFAULT backfilled every pre-existing row and
  // changes NO behaviour: single-repo behaviour as it stands already IS one
  // coordinated unit of work, so 'coordinated' asserts about those rows only
  // what was already true. Plain text + a named CHECK (below), not a pgEnum —
  // same choice as `shape`/`status`/`project_phase`, so a third mode stays a
  // code change rather than a DB-enum migration.
  coordination_mode: text('coordination_mode').notNull().default('coordinated'),

  // Migration 168 (U-PS-ENTRY) — the pm project template (`template_id@hash`)
  // this project was STARTED from, written only by promote from the approved
  // outline's phase_plan. Non-NULL ⇒ a plan project (its plan drives the GET
  // /plan read model and the rail; its phase is set by n8n via PATCH /phase like
  // any other). NULL ⇒ legacy.
  template_id: text('template_id'),
  template_hash: text('template_hash'),

  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
},
  // MEASURED before this change: a CI-shaped DB accepted
  // shape='NOT_A_SHAPE' and scope_level='NOT_A_SCOPE'. Prod rejects both.
  // ⛔ `project_phase` and `project_type` carry NO CHECK since migration 185:
  // both vocabularies are the TENANT's requirements_management catalogue
  // (services/catalogue/tenant-catalogue.ts), validated in the app — a global
  // list here would refuse every RM name fr never knew.
  (t) => [
    // Migration 168 — template id and version hash are written together or not at all.
    check(
      'projects_template_pair_check',
      sql`(${t.template_id} IS NULL) = (${t.template_hash} IS NULL)`,
    ),
    // Migration 173 — delivered_at and delivery_evidence together or not at all.
    check(
      'projects_delivery_pair_check',
      sql`(${t.delivered_at} IS NULL) = (${t.delivery_evidence} IS NULL)`,
    ),
    check(
      'projects_shape_check',
      sql`${t.shape} IN ('deliverable', 'continuous_flow')`,
    ),
    check(
      'projects_scope_level_canonical',
      sql`${t.scope_level} IS NULL OR ${t.scope_level} IN ('multi_repo', 'repo', 'app', 'module', 'component', 'file', 'class', 'function')`,
    ),
    // Migration 143. Named with the migration's own constraint name so
    // `drizzle-kit push` lands the identical CHECK on the CI database — an
    // unnamed one gets an auto-generated name push would not reproduce, and CI
    // would then accept a coordination_mode prod rejects.
    check(
      'projects_coordination_mode_check',
      sql`${t.coordination_mode} IN ('coordinated', 'independent')`,
    ),
    // Migration 206 — R318: why the project cord is engaged (named as the migration names it).
    check(
      'projects_andon_reason_check',
      sql`${t.andon_reason} IS NULL OR ${t.andon_reason} IN ('operator', 'move_request')`,
    ),
    // Migration 163 — at most ONE live bug_hunt `it` project per (tenant, repo):
    // the race backstop behind routes/projects.ts assertNoLiveBugHuntProject
    // (a violation maps to 409 bug_hunt_project_exists). Declared HERE too so
    // `drizzle-kit push` (the CI bootstrap) lands the same partial index.
    uniqueIndex('projects_one_live_bug_hunt_per_repo_idx')
      .on(sql`(project_data->>'keycloak_tenant_id')`, t.repository_url)
      .where(
        // Migration 164 widened "live" to exclude a project request's pre-approval
        // row, and 173 to exclude a DELIVERED hunt (lib/project-live-status.ts
        // NON_LIVE_PROJECT_STATUSES) so it frees the repo's slot. 189 widened the
        // type to RM's `bug_hunt_fix` + legacy `it` (lib/bug-hunt-project-types.ts).
        // 190 added `repository_url IS NOT NULL`: no repo ⇒ the guard does not apply.
        sql`${t.repository_url} IS NOT NULL AND project_type IN ('it', 'bug_hunt_fix') AND status NOT IN ('archived', 'pending', 'cancelled', 'delivered') AND project_data->>'bug_hunt' = 'true'`,
      ),
  ],
);

// Project requests (migration 079) — the CP→fr bridge RECEIVING half.
// An upstream system (Common Practice) forwards a winning solution here as a
// DRAFT a human reviews/edits/approves in fr before any project/board/n8n
// action. The row carries the canonical fr-mapped ProjectCreate `payload` + CP
// `external_origin` provenance and is idempotent on (tenant_id, external_ref).
// On approve, `createProjectCore` runs (identical to POST /api/projects) and
// `project_id` + status='promoted' are stamped. SQL source of truth is the
// migration; this declaration drives CI's `drizzle-kit push` and typed queries.
export const projectRequests = pgTable(
  'project_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    source: text('source').notNull(),
    external_ref: text('external_ref').notNull(),
    external_origin: jsonb('external_origin'),
    payload: jsonb('payload').notNull(),
    // draft | submitted | analysing | outline_proposed | approved
    //   | promoted | rejected | withdrawn | failed   (migration 123)
    status: text('status').notNull().default('draft'),
    // When the requester declared it finished. Distinct from created_at: a
    // bridged or free-text-intake request is born populated but unsubmitted.
    submitted_at: timestamp('submitted_at', { withTimezone: true }),
    rejection_reason: text('rejection_reason'),
    error: text('error'),
    created_by: uuid('created_by'),
    reviewed_by: uuid('reviewed_by'),
    project_id: uuid('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    history: jsonb('history')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Migration 170 (U-PS-S0): the discriminating request bits + bit_source
    // (lib/request-bits.ts). NULL = not recorded. repo_count is computed on read.
    request_bits: jsonb('request_bits'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // ⛔ Two emitters of migration 170's CHECK.
    requestBitsObjectCheck: check(
      'project_requests_request_bits_object_check',
      sql`${t.request_bits} IS NULL OR jsonb_typeof(${t.request_bits}) = 'object'`,
    ),
    tenantExternalRefUnique: unique(
      'project_requests_tenant_external_ref_unique',
    ).on(t.tenant_id, t.external_ref),
    tenantStatusIdx: index('project_requests_tenant_status_idx').on(
      t.tenant_id,
      t.status,
    ),
    // Widened by migration 123. `approved` was ALREADY permitted here and was
    // never written by any code path — it existed only as a `history` action
    // label. It now means OUTLINE AGREED, PROJECT NOT YET CREATED.
    // ⛔ This list and migration 123 are two emitters of one constraint: CI
    // builds from here via drizzle-kit push, a real database from the .sql.
    statusCheck: check(
      'project_requests_status_check',
      sql`${t.status} IN ('draft', 'submitted', 'analysing', 'outline_proposed', 'approved', 'promoted', 'rejected', 'withdrawn', 'failed')`,
    ),
  }),
);

// ── Stage A: the repositories a REQUEST names, before any project exists ─────
// `project_repositories` (migration 072) stores N repos per PROJECT. A request
// has no project yet, so the form's `multi_repo` scope level had nowhere to put
// the second repo — the literal defect reported 2026-09-21. Migration 123.
export const projectRequestRepositories = pgTable(
  'project_request_repositories',
  {
    request_id: uuid('request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    url: text('url').notNull(),
    branch: text('branch'),
    path: text('path'),
    name: text('name'),
    is_primary: boolean('is_primary').notNull().default(false),
    // `unknown` = not yet checked, deliberately distinct from `error` = we
    // looked and could not find out. ⚠️ SUPERSEDED 2026-09-22: migration 123's
    // COMMENT still says "advisory, never a gate" — that was the 2026-09-21
    // decision and is no longer true. Submit now REFUSES (422
    // repo_access_denied) unless every repo is public/private_granted; the gate
    // re-assesses live at submit (routes/project-request-lifecycle.ts) rather
    // than trusting this cached column.
    access_state: text('access_state').notNull().default('unknown'),
    access_detail: text('access_detail'),
    access_checked_at: timestamp('access_checked_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.request_id, t.position] }),
    onePrimary: uniqueIndex('project_request_repositories_one_primary_idx')
      .on(t.request_id)
      .where(sql`${t.is_primary}`),
    accessStateCheck: check(
      'project_request_repositories_access_state_check',
      // `platform_repo_forbidden` added by migration 126 — coding-github's
      // platform-repo tenant gate refused; distinct from `private_ungranted`
      // (no grant fixes it) and `error` (no re-check fixes it).
      sql`${t.access_state} IN ('unknown', 'public', 'private_granted', 'private_ungranted', 'platform_repo_forbidden', 'error')`,
    ),
  }),
);

// ── Stage B: the outline — what is AGREED after analysis ────────────────────
// Deliverables / intermediate deliverables / milestones / effort. Proposed by
// the agent, decided by a human, VERSIONED so an amendment is auditable rather
// than destructive. Migration 123.
//
// ⛔ The content lives here in NAMED columns and deliberately NOT inside
// `approvals.metadata`. A jsonb blob nothing reads by name is the exact
// write-only shape that put 21 unread fields into projects.project_data; only
// the DECISION belongs in `approvals` (see approval_id).
export const projectOutlines = pgTable(
  'project_outlines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    request_id: uuid('request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // proposed | superseded | approved | rejected
    status: text('status').notNull().default('proposed'),
    summary: text('summary'),
    deliverables: jsonb('deliverables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    intermediate_deliverables: jsonb('intermediate_deliverables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    milestones: jsonb('milestones')
      .notNull()
      .default(sql`'[]'::jsonb`),
    effort_estimate: jsonb('effort_estimate'),
    // The agent's PROPOSED cost. ⚠️ NOT a tracked budget — billing_service
    // carries no project_id on any event or rollup table, and fr stamps
    // project_id onto a stream with no cost columns. Never present this as
    // money spent.
    cost_estimate: jsonb('cost_estimate'),
    approval_id: uuid('approval_id').references(() => approvals.id, {
      onDelete: 'set null',
    }),
    proposed_by: text('proposed_by'),
    proposed_at: timestamp('proposed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    decided_by: uuid('decided_by'),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    decision_note: text('decision_note'),
    // Migration 167 (U-PS-OUTLINE) — the phase plan this VERSION was instantiated
    // with ({template_id, template_hash, phases[], ...}; lib/phase-plan.ts) and
    // its fr-computed JCS sha256. Both NULL on a legacy outline (no template).
    phase_plan: jsonb('phase_plan'),
    phase_plan_hash: text('phase_plan_hash'),
  },
  (t) => ({
    phasePlanPair: check(
      'project_outlines_phase_plan_pair_check',
      sql`(${t.phase_plan} IS NULL) = (${t.phase_plan_hash} IS NULL)`,
    ),
    phasePlanHashHex: check(
      'project_outlines_phase_plan_hash_hex',
      sql`${t.phase_plan_hash} IS NULL OR ${t.phase_plan_hash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestVersionUnique: unique('project_outlines_request_id_version_unique').on(
      t.request_id,
      t.version,
    ),
    // At most one outline awaiting a decision. Without this, an agent
    // re-delivering an outline (retry, duplicate webhook) silently raises a
    // SECOND approval and the user decides a version that is no longer current.
    oneLive: uniqueIndex('project_outlines_one_live_idx')
      .on(t.request_id)
      .where(sql`${t.status} = 'proposed'`),
    requestIdx: index('project_outlines_request_idx').on(t.request_id),
    statusCheck: check(
      'project_outlines_status_check',
      sql`${t.status} IN ('proposed', 'superseded', 'approved', 'rejected')`,
    ),
  }),
);

// ── The APPROVED scope, owned by the PROJECT ─────────────────────────────────
// Migration 127. Promotion re-parsed the Stage-A request payload and dropped
// everything a human actually signed off on the outline — deliverables,
// acceptance criteria, milestones, effort. These two tables plus
// projects.approved_effort_estimate are where the promote path writes it.
//
// ⭐ The project gets its own COPY, not a pointer: an outline is a versioned
// proposal that may be superseded or pruned, and the agreed scope must not
// change when it is. Hence source_outline_id is provenance with
// onDelete: 'set null' — see the migration header for the full argument.
//
// ⛔ fr-LOCAL BY DESIGN, and not the missing half of the PM service. There is no
// link to requirements_management because it has no deliverable and no acceptance
// entity to link to, and its activity tree is flat (measured by another lane
// 2026-09-23: 3,235 activities / 0 with a parent; `deliverable` appears zero
// times in its pm models, schemas and routers). Do not manufacture the PM half
// to create a join. `acceptance_criteria` is likewise NOT evidence of completion:
// AS OF 2026-09-23 artifacts.card_id was NULL on all 58,573 rows with 0 of 15
// upload sites setting it. ⚠️ That is a dated measurement, not a property — a peer
// lane has a PR open to write card_id (plus four dead provenance columns) at the
// WRITE END ONLY, no backfill, so newer artefacts become linkable while those
// 58,573 stay NULL. Narrow the caveat when it lands; the substance does not move —
// a populated card_id only makes a link cheaper to build later, it does not make
// this column evidence of anything.
export const projectDeliverables = pgTable(
  'project_deliverables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // PROVENANCE, not ownership: which outline version agreed this item.
    // set null + nullable so the approved scope SURVIVES the pruning of the
    // outline it was approved in. A cascade here would let an outline cleanup
    // silently delete a live project's agreed deliverables.
    source_outline_id: uuid('source_outline_id').references(() => projectOutlines.id, {
      onDelete: 'set null',
    }),
    position: integer('position').notNull(),
    // deliverable = the customer receives it; intermediate = needed to get
    // there. CLOSED vocabulary (unlike projects.project_phase, deliberately
    // open) because code BRANCHES on this value: an unrecognised kind does not
    // degrade a label, it drops the row out of the branch meant to handle it.
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    // Ordered free text with no internal structure to name — the one shape a
    // blob is honest about. NOT NULL DEFAULT '[]' so "none recorded" is an empty
    // list rather than a NULL every reader has to coalesce.
    acceptance_criteria: jsonb('acceptance_criteria')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Migration 151 (fr#1332): the repositories this deliverable changes,
    // verbatim from the outline's ncn#1939 attribution. NULLABLE and NULL is
    // NOT `{}`: NULL = not attributed, `{}` would claim "changes no repo".
    // Reader: the C1-58 intake minter (GET /api/projects/:id/deliverables →
    // per-child `repo` on POST /api/decompositions/commit).
    repos: text('repos').array(),
    // Migration 169 (U-PS-COMMIT): rolling-wave minting. deferred = the
    // decomposition commit mints NO card for this row; `minter` (pm template
    // Deliverable.minter) attaches its cards later and stamps minted_at +
    // minted_count once via POST /api/projects/:id/deliverables/:did/minted.
    // Completion: lib/deliverable-complete.ts. Defaults = today's semantics.
    deferred: boolean('deferred').notNull().default(false),
    minter: text('minter'),
    minted_at: timestamp('minted_at', { withTimezone: true }),
    minted_count: integer('minted_count'),
    // Migration 171 (U-PS-PHASEEXIT, fr#1481): which phase-plan deliverable
    // (pm template Deliverable.id) this row is — the join from a row to its
    // plan placement (phase, card_types, cardinality) that lib/plan-phase-exit.ts
    // (the read model) reads. Copied at promote from the outline deliverable. NULL = legacy.
    plan_deliverable_id: text('plan_deliverable_id'),
  },
  (t) => ({
    // ⚠️ NO separate index on (project_id): this constraint's btree LEADS on
    // project_id, so `WHERE project_id = $1 ORDER BY position` — the only access
    // pattern — is already served. A second index would be pure write
    // amplification. (project_outlines does carry both; that redundancy is not a
    // precedent worth copying.)
    projectPositionUnique: unique('project_deliverables_project_id_position_unique').on(
      t.project_id,
      t.position,
    ),
    // ⛔ THIS CHECK AND migration 127's ARE TWO EMITTERS OF ONE CONSTRAINT. CI
    // builds its database from here via drizzle-kit push and the runner stamps
    // 127 applied WITHOUT executing it; a real database gets the shape from the
    // .sql and never sees this file. Widening (or dropping) it in only one place
    // passes the suite in one environment and 23514s every write in the other —
    // the failure 113 shipped once and 119/122/123 each record.
    // tests/integration/migrations/127-project-deliverables.integration.test.ts
    // compares the two declarations against each other on a real Postgres.
    kindCheck: check(
      'project_deliverables_kind_check',
      sql`${t.kind} IN ('deliverable', 'intermediate')`,
    ),
    // ⛔ TWO EMITTERS of migration 169's CHECK — keep them identical.
    mintingCheck: check(
      'project_deliverables_minting_check',
      sql`(NOT ${t.deferred} OR ${t.minter} IS NOT NULL) AND ((${t.minted_at} IS NULL) = (${t.minted_count} IS NULL)) AND (${t.minted_at} IS NULL OR ${t.deferred}) AND (${t.minted_count} IS NULL OR ${t.minted_count} >= 0)`,
    ),
    // ⛔ TWO EMITTERS of migration 171's CHECK + UNIQUE — keep them identical.
    planDeliverableIdCheck: check(
      'project_deliverables_plan_deliverable_id_check',
      sql`${t.plan_deliverable_id} IS NULL OR ${t.plan_deliverable_id} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    projectPlanDeliverableUnique: unique('project_deliverables_project_plan_deliverable_unique').on(
      t.project_id,
      t.plan_deliverable_id,
    ),
  }),
);

// The APPROVED milestones. Composite PK mirrors project_request_repositories
// (migration 123): a milestone has no identity apart from its project and its
// place in the order, so it needs no surrogate id — and the PK's btree leads on
// project_id, so no separate index either.
//
// ⚠️ NOT requirements_management's `is_milestone`, which is a bare zero-duration
// boolean for cpm/evm/monte_carlo with no criteria and no artefact link.
export const projectMilestones = pgTable(
  'project_milestones',
  {
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    // NULLABLE: an outline may agree an ordering without committing to dates,
    // and a fabricated date is worse than none.
    target_date: date('target_date'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.project_id, t.position] }),
  }),
);

// Finding suppression ledger (migration 130). A fingerprint a human/QA marked
// false-positive for a project; POST /api/cards/project refuses to turn it into
// a card again. Keyed on (project_id, fingerprint) — the suppression follows the
// PROJECT, whichever permitted tenant view the caller acts from. ⛔ TWO EMITTERS
// OF ONE SHAPE with migration 130 — the PK name is spelled in both so
// push-built CI and prod carry the same constraint.
export const findingSuppressions = pgTable(
  'finding_suppressions',
  {
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    // Active tenant of the caller that RECORDED the decision — audit only,
    // never part of the key (a project is visible under more than one tenant).
    recorded_tenant_id: uuid('recorded_tenant_id').notNull(),
    reason: text('reason').notNull(),
    card_id: text('card_id'),
    decided_by: text('decided_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Migration 132. Caller-declared finding category; a security category
    // requires project owner or super_admin on PUT (routes/findings/suppressions.ts).
    category: text('category'),
  },
  (t) => ({
    pk: primaryKey({
      name: 'finding_suppressions_pkey',
      columns: [t.project_id, t.fingerprint],
    }),
  }),
);

// Finding suppression decision trail (migration 132). One row per state change
// of finding_suppressions: 'suppress' (a PUT that created the row) and
// 'unsuppress' (a DELETE that removed it), written in the SAME statement as the
// ledger change. ⛔ No FK on project_id: the trail must outlive the project,
// whose suppressions cascade away. ⛔ TWO EMITTERS OF ONE SHAPE with migration
// 132 — constraint and index names are spelled in both.
export const findingSuppressionEvents = pgTable(
  'finding_suppression_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenant_id: uuid('tenant_id').notNull(),
    project_id: uuid('project_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    action: text('action').notNull(),
    reason: text('reason').notNull(),
    category: text('category'),
    actor: text('actor').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    actionCheck: check(
      'finding_suppression_events_action_check',
      sql`${t.action} IN ('suppress', 'unsuppress')`,
    ),
    projectFpIdx: index('finding_suppression_events_project_fp_idx').on(
      t.project_id,
      t.fingerprint,
      t.created_at,
    ),
  }),
);

// Priority change trail (migration 160). One row per EFFECTIVE change of a
// project's `project_data.priority` (card_id NULL) or a card's
// `Metadata.priority` (card_id set) — written by routes/projects.ts
// handlePatchProject and routes/cards/priority.ts through
// lib/priority-change.ts recordPriorityChange, in the SAME transaction as the
// change it records. A no-op (from = to) is never recorded (CHECK below).
// Append-only by convention: no route updates or deletes rows.
// ⛔ No FK on project_id: the trail outlives the project (same as
// finding_suppression_events). ⛔ TWO EMITTERS OF ONE SHAPE with migration 160 —
// constraint and index names are spelled in both.
export const priorityChangeEvents = pgTable(
  'priority_change_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenant_id: uuid('tenant_id').notNull(),
    project_id: uuid('project_id').notNull(),
    card_id: text('card_id'),
    // LEGACY TEXT (P0..P3 / the RM level's name upper-cased) — kept for the
    // backfill window only (design Q3 = b); the values of record are the two
    // *_priority_level_id columns (migration 188). FOLLOW-UP: drop these two
    // once scripts/backfill-priority-level-ids.ts measures 100% for every tenant.
    from_priority: text('from_priority'),
    to_priority: text('to_priority'),
    // The tenant's requirements_management priority-level ids (migration 188).
    // No FK: the level lives in RM. NULL = unset, or not yet backfilled.
    from_priority_level_id: uuid('from_priority_level_id'),
    to_priority_level_id: uuid('to_priority_level_id'),
    actor_id: text('actor_id').notNull(),
    actor_username: text('actor_username'),
    actor_name: text('actor_name'),
    actor_kind: text('actor_kind').notNull(),
    // The provenance stamped on the card / project_data with this change
    // (lib/priority-change.ts prioritySetBy): `human:<sub>` | `operator:<sub>` |
    // `conveyor:<rule>` (the dedicated conveyor identity; migration 161 widened
    // the CHECK — keep this expression identical to that file).
    priority_set_by: text('priority_set_by').notNull(),
    changed_at: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // No `to_priority` vocabulary CHECK (migration 188 dropped 160's): the
    // vocabulary is the tenant's RM priority levels.
    changedCheck: check(
      'priority_change_events_changed_check',
      sql`${t.from_priority} IS DISTINCT FROM ${t.to_priority}`,
    ),
    actorKindCheck: check(
      'priority_change_events_actor_kind_check',
      sql`${t.actor_kind} IN ('user', 'service_account', 'unknown')`,
    ),
    setByCheck: check(
      'priority_change_events_set_by_check',
      sql`${t.priority_set_by} ~ '^(human|operator|conveyor):.+$'`,
    ),
    projectIdx: index('priority_change_events_project_idx').on(
      t.project_id,
      t.changed_at,
    ),
  }),
);

// ── Split-family contract substrate (roadmap B1) ─────────────────────────────
// Migration 128. Track B (RECURSIVE_DECOMPOSITION_SPEC.md) card_contracts /
// decompositions / contract_dependencies, plus split-coherence-design.md §5's
// family_bundles / family_decisions / interface_validations.
//
// ⛔ THIS FILE AND migration 128 ARE TWO EMITTERS OF ONE SHAPE. CI builds its
// database from here via drizzle-kit push and stamps 128 applied WITHOUT running
// it; production gets the shape from the .sql and never sees this file. Every
// CHECK, named UNIQUE and — above all — family_decisions_one_active_topic_idx is
// declared in both with the same name. The concurrency test
// (tests/integration/decomposition/family-decisions-claim.integration.test.ts)
// runs against the push-built CI database, so if the partial unique index were
// declared only in the .sql the test could not pass in CI at all.
//
// ⛔ NOT project_deliverables (migration 127): that is a PROJECT's approved scope;
// this is the machine contract of one CARD in a split tree.

// One row per split = one FAMILY. `id` is the caller-generated decomposition_id
// and IS the family_id everything below keys on. tenant_id scopes every read and
// write of the family.
export const decompositions = pgTable(
  'decompositions',
  {
    id: uuid('id').primaryKey(),
    tenant_id: uuid('tenant_id').notNull(),
    parent_card_id: text('parent_card_id').notNull(),
    // Migration 147 (ncn#1960) — Readying split provenance. NULL on a C1-58
    // commit family (not a split): 'rule' | 'invest_t' and a <= 200 char reason.
    computed_by: text('computed_by'),
    reason: text('reason'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    parentCardIdx: index('decompositions_parent_card_idx').on(t.parent_card_id),
    computedByCheck: check(
      'decompositions_computed_by_check',
      sql`${t.computed_by} IS NULL OR ${t.computed_by} IN ('rule', 'invest_t')`,
    ),
    reasonLengthCheck: check(
      'decompositions_reason_length_check',
      sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 200`,
    ),
  }),
);

// The per-card contract. card_id is NULLABLE: the stable identity is
// (family_id, child_key), resolved before the child's Planka card exists
// (Track B: a saga, not 2PC). A root card has family_id = child_key = NULL.
// The *_ids arrays are ids INTO requirements_management — no FK, another
// service's database.
export const cardContracts = pgTable(
  'card_contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    card_id: text('card_id'),
    family_id: uuid('family_id').references(() => decompositions.id, {
      onDelete: 'cascade',
    }),
    child_key: text('child_key'),
    depth: integer('depth').notNull().default(0),
    // split-coherence §3.3 step 1 reads `card_contracts.phase` ("no child is in
    // DOING"). NULL = never recorded — unknown, NOT todo. Lower-cased list names.
    phase: text('phase'),
    // decision | answer | action; NULL = not a leaf (Track B typed terminal classes).
    leaf_class: text('leaf_class'),
    scope_hash: text('scope_hash'),
    // [{id: 'crit_<sha1(text)[0:8]>', text}]
    criteria: jsonb('criteria')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Parent criterion ids this child claims to cover.
    covers: text('covers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    inputs: jsonb('inputs')
      .notNull()
      .default(sql`'[]'::jsonb`),
    output_schema: jsonb('output_schema'),
    proof_obligation: jsonb('proof_obligation'),
    dependency_bindings: jsonb('dependency_bindings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Ladder level of the split (split-coherence §1.2). OPEN vocabulary: non-it
    // projects split on another axis.
    scope_level: text('scope_level'),
    requirement_ids: uuid('requirement_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // The parent's OTHER requirement ids — read-only context (§1.4).
    context_requirement_ids: uuid('context_requirement_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    principle_ids: uuid('principle_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    decision_ids: uuid('decision_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    architecture_element_ids: uuid('architecture_element_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    toc_tree_id: text('toc_tree_id'),
    toc_goal_node_id: text('toc_goal_node_id'),
    toc_node_id: text('toc_node_id'),
    // {family_id, bundle_version, bundle_hash} (§1.4).
    bundle_ref: jsonb('bundle_ref'),
    interface_contract: jsonb('interface_contract'),
    // {"<spec>@<version>": {context_hash, item_ids, artifact_id}} (§2.4).
    context_packs: jsonb('context_packs')
      .notNull()
      .default(sql`'{}'::jsonb`),
    prompt_pins: jsonb('prompt_pins'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cardIdUnique: unique('card_contracts_card_id_unique').on(t.card_id),
    familyChildKeyUnique: unique('card_contracts_family_id_child_key_unique').on(
      t.family_id,
      t.child_key,
    ),
    familyChildKeyPairCheck: check(
      'card_contracts_family_child_key_pair_check',
      sql`(${t.family_id} IS NULL) = (${t.child_key} IS NULL)`,
    ),
    depthCheck: check('card_contracts_depth_check', sql`${t.depth} >= 0`),
    phaseCheck: check(
      'card_contracts_phase_check',
      sql`${t.phase} IS NULL OR ${t.phase} IN ('todo', 'ready', 'doing', 'qa', 'blocked', 'done')`,
    ),
    leafClassCheck: check(
      'card_contracts_leaf_class_check',
      sql`${t.leaf_class} IS NULL OR ${t.leaf_class} IN ('decision', 'answer', 'action')`,
    ),
  }),
);

// child_key REQUIRES requires_child_key (siblings in family_id). Cycle detection
// is the validator's job, not a constraint.
export const contractDependencies = pgTable(
  'contract_dependencies',
  {
    family_id: uuid('family_id')
      .notNull()
      .references(() => decompositions.id, { onDelete: 'cascade' }),
    child_key: text('child_key').notNull(),
    requires_child_key: text('requires_child_key').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.family_id, t.child_key, t.requires_child_key] }),
    noSelfEdge: check(
      'contract_dependencies_no_self_edge_check',
      sql`${t.child_key} <> ${t.requires_child_key}`,
    ),
  }),
);

// The frozen family context bundle (split-coherence §2.1). A version is written
// once; services/decomposition/family-bundles.ts refuses a second write of the
// same version with a different bundle_hash.
export const familyBundles = pgTable(
  'family_bundles',
  {
    family_id: uuid('family_id')
      .notNull()
      .references(() => decompositions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    bundle_hash: text('bundle_hash').notNull(),
    items: jsonb('items').notNull(),
    retrieval_trace: jsonb('retrieval_trace')
      .notNull()
      .default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.family_id, t.version] }),
    versionCheck: check('family_bundles_version_check', sql`${t.version} >= 1`),
  }),
);

// The ordering + uniqueness index of sibling decisions (split-coherence §3.2).
// Content lives in requirements_management; fr holds who claimed which topic and
// in what order. seq is GLOBAL: monotonic within a family, not dense.
//
// `superseded_by` is NOT in the design's column list, but the design's own
// predicate `UNIQUE(family_id, topic_slug) WHERE superseded_by IS NULL` names it —
// see migration 128's header.
export const familyDecisions = pgTable(
  'family_decisions',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    family_id: uuid('family_id')
      .notNull()
      .references(() => decompositions.id, { onDelete: 'cascade' }),
    topic_slug: text('topic_slug').notNull(),
    decision_id: uuid('decision_id').notNull(),
    child_key: text('child_key').notNull(),
    supersedes: uuid('supersedes'),
    superseded_by: uuid('superseded_by'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // ⭐ THE ATOMICITY of claimDecisionTopic. Same name + predicate as migration
    // 128. Dropping it makes every claim raise 42P10 (no arbiter index for the
    // ON CONFLICT … WHERE target), and the 8-concurrent-claims test goes red.
    oneActiveTopic: uniqueIndex('family_decisions_one_active_topic_idx')
      .on(t.family_id, t.topic_slug)
      .where(sql`${t.superseded_by} IS NULL`),
    familySeqIdx: index('family_decisions_family_seq_idx').on(t.family_id, t.seq),
    topicSlugCheck: check(
      'family_decisions_topic_slug_check',
      sql`${t.topic_slug} ~ '^[a-z0-9_]{3,40}$'`,
    ),
  }),
);

// One row per run of the family interface check (split-coherence §3.1).
// violations = [] ⇒ valid as of run_at; the latest row (MAX(id)) is the current
// verdict.
//
// `id` is a surrogate key (migration 129). 128 keyed this on (family_id, run_at),
// and run_at defaults to NOW() — the TRANSACTION start time — so two runs in one
// transaction collided on the PK. Same shape as migration 129: bigserial PK named
// interface_validations_pkey + interface_validations_family_id_idx.
export const interfaceValidations = pgTable(
  'interface_validations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    family_id: uuid('family_id')
      .notNull()
      .references(() => decompositions.id, { onDelete: 'cascade' }),
    run_at: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    violations: jsonb('violations')
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => ({
    familyIdIdx: index('interface_validations_family_id_idx').on(t.family_id, t.id),
  }),
);

// Documents table
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  // ON DELETE RESTRICT (migration 090): documents is the sole PHI-pointer table
  // (kag_ingestion_id / kag_document_id / tenant_id). A CASCADE here would drop
  // the pointer rows on project delete WITHOUT purging the downstream PHI they
  // reference (kag_graph chunks/entities/Neo4j, orchestrator job, MinIO images)
  // — orphaned PHI (HIPAA). RESTRICT forces the caller to run the fail-closed
  // right-to-delete purge first (purgeAndDeleteProjectDocuments), then delete
  // the rows, then delete/archive the project. See routes/documents.ts.
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'restrict' }),
  user_id: uuid('user_id').notNull(),
  filename: text('filename').notNull(),
  // No file_path: uploads stream straight to kag (multipart bytes), never to
  // fr's local disk — kag/ingestion is the source of truth (migration 070).
  file_size: integer('file_size').notNull(),
  mime_type: text('mime_type').notNull(),
  status: text('status').default('pending').notNull(), // pending, processing, completed, failed, rejected (virus scan), parsed (send_to_kag=false; parsed but NOT indexed in KAG)

  // The per-RUN job id ingestion returned at upload. NOT the document's identity:
  // a re-ingest of the same artifact mints a fresh job_id.
  kag_ingestion_id: text('kag_ingestion_id'),

  // Migration 087 — the STABLE, content-derived document identity from ingestion
  // (uuid5 over tenant:source:sha256(content)). This is the key kag_graph/Neo4j
  // chunks are written under and the key the HIPAA purge resolves to. Only known
  // once the worker has PARSED, so it is harvested from the job-status poll /
  // background reconcile, never at upload. Nullable: pre-087 and in-flight rows.
  kag_document_id: text('kag_document_id'),

  pages_detected: integer('pages_detected'),
  entities_extracted: integer('entities_extracted'),
  error_message: text('error_message'),

  // Migration 099 — KAG ingestion HONESTY flags. karma's partial-credit mode
  // (PR #127) + kag_orchestrator #123 let the pipeline COMPLETE a job that lost
  // most of its chunks; upstream reports it in kag_ingest.stage_history[].metrics
  // as degraded/partial + degraded_reason. Persisted here so a settled row can
  // still say "this graph is incomplete" long after the upstream job is gone.
  //
  // NULL means UNKNOWN — never "clean", never "degraded". Pre-099 rows, parse-only
  // rows, rows settled from a lost terminal callback with no degraded/partial key
  // in stage_history, and 404-orphaned rows all stay NULL. Only a poll that read an
  // actual degradation signal writes true/false, so anything treating `false` as a
  // positive all-clear MUST check for NULL first.
  kag_degraded: boolean('kag_degraded'),
  kag_degraded_reason: text('kag_degraded_reason'),
  /** 'knowledge' | 'hierarchy' | 'index' | 'chunks' — first degraded stage in pipeline order. */
  kag_degraded_stage: text('kag_degraded_stage'),
  // The karma stage's own headline counts, verbatim. NEVER derived from one
  // another — a missing count stays null rather than being invented by subtraction.
  chunks_indexed: integer('chunks_indexed'),
  chunks_failed: integer('chunks_failed'),
  chunks_total: integer('chunks_total'),

  // Migration 083 — the tenant the upload was scoped to (X-Tenant-Id at upload
  // time). Lets the background reconcile rebuild a request context to fetch the
  // correct tenant's kag job, and records the upload tenant so the HIPAA purge
  // REPLAYS the ingest tenant instead of re-deriving one from whoever presses
  // Delete (a wrong-tenant purge deletes nothing downstream and silently orphans
  // the PHI). Migration 089 makes this NOT NULL — with the four legacy rows
  // repaired, no document may exist without a recorded tenant, and `.notNull()`
  // here makes the type system reject any insert that omits it (compile-time
  // enforcement of the record-and-replay invariant, not just a runtime guard).
  tenant_id: uuid('tenant_id').notNull(),

  // Migration 116 — when the BACKGROUND RECONCILE last LOOKED at this row.
  // Distinct from `updated_at`, which records when the row last CHANGED.
  //
  // Conflating the two caused permanent head-of-line blocking: a job that is
  // parsed but still indexing yields an empty patch (correct — "keep polling"),
  // so `updated_at` never moved, so the row stayed the oldest member of the
  // `ORDER BY updated_at LIMIT batchSize` stale set forever and row batchSize+1
  // was never fetched. `services/document-reconcile.ts` now orders and filters
  // on THIS column and stamps it on every attempt — settled, no-op or thrown.
  //
  // NULL means "never attempted by the sweep" and sorts FIRST (never-attempted
  // rows lead). It is deliberately un-backfilled and has NO default: giving
  // existing rows a value would mark the longest-stuck documents as
  // recently-attempted and re-create the starvation. Only the reconcile writes
  // it; nothing should read it as a proxy for document freshness.
  last_reconcile_attempt_at: timestamp('last_reconcile_attempt_at', { withTimezone: true }),

  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Repositories table
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull(),
    // Migration 133 — REQUIRED and non-blank. Always resolvable from `url`
    // (`owner/repo`), so every insert path routes through
    // `lib/repository-name.ts :: resolveRepositoryName` rather than writing
    // `?? null`. ⚠️ drizzle-kit push bootstraps the CI database FROM THIS FILE,
    // so leaving it nullable here would build a CI schema migration 133 then
    // fails against — and would hand every reader a `string | null` for a
    // column that can no longer be null.
    name: text('name').notNull(),
    url: text('url').notNull(),
    branch: text('branch').default('main'),
    path: text('path'),
    description: text('description'),
    secret_id: uuid('secret_id'),
    // Migration 018 — onboarding mapping to the upstream coding-gateway.
    // NULL means "not onboarded"; the coding adapter raises REPO_NOT_ONBOARDED
    // before any gateway call. Populated when the repo is provisioned into
    // coding-containers via the existing CodeGraphClient.provisionRepository.
    container_name: text('container_name'),
    created_at: timestamp('created_at').defaultNow().notNull(),
    updated_at: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Migration 072 — backs the create-or-attach `ON CONFLICT (user_id, url)`
    // path in handleAttachProjectRepository and the project-create backfill.
    userUrlUnique: unique('repositories_user_id_url_unique').on(table.user_id, table.url),
    // Migration 133 — spelled with the SAME identifier as the SQL file so
    // drizzle-kit push reproduces it. NOT NULL alone still admits '' and '   ',
    // which is the value a form actually produces.
    nameNotBlank: check('repositories_name_not_blank', sql`btrim(${table.name}) <> ''`),
  }),
);

// Project ↔ Repository join (migration 072). N:M membership.
//
// `projects.repository_url/branch/container_name` STAY as a denormalised
// primary so existing readers (AG-UI project-start brief at
// routes/projects.ts:230–284, coding adapter resolveRepo() at
// integrations/coding/adapter.ts:81–127, head-sha resolver at
// integrations/coding/head-sha.ts:118–154) keep working unchanged. The
// join row is the operational truth; primary-promote keeps the cache
// columns in sync.
//
// `is_primary` is enforced unique-per-project via the partial unique
// index. Declared HERE (`uniqueIndex().where(...)`) AND in migration 072
// — the schema declaration lets `drizzle-kit push` (the fresh-CI-DB
// bootstrap path) land the same partial index the migration owns for
// prod, so neither path drops "at most one primary per project".
export const projectRepositories = pgTable(
  'project_repositories',
  {
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repo_id: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    is_primary: boolean('is_primary').notNull().default(false),
    added_at: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
    // Migration 143 — stable 0-based display order within a project; the
    // primary repo is 0. NOT tidiness: `added_at` above defaults to `now()`,
    // which is `transaction_timestamp()`, so every row one project-create
    // inserts carries a BYTE-IDENTICAL timestamp and the
    // `orderBy(desc(is_primary), asc(added_at))` at
    // src/routes/project-repositories.ts:95 has no tiebreak for the secondary
    // repos. Existing rows were ranked by `repo_id` (the only key on this table
    // that can discriminate rows of one project); see the migration header.
    // ⚠️ A push-built CI database never runs that backfill, so every row there
    // keeps 0 — tests must set `position` explicitly rather than expect
    // distinct values.
    position: integer('position').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.project_id, table.repo_id] }),
    primaryUnique: uniqueIndex('project_repositories_primary_unique')
      .on(table.project_id)
      .where(sql`is_primary`),
    repoIdx: index('project_repositories_repo_id_idx').on(table.repo_id),
  }),
);

// Coding analysis runs (migration 018). FR-minted job id + per-type
// findings/raw blobs. See backend/migrations/018_coding_analysis_runs.sql for
// the full design notes. The (project_id, repo_id, type,
// client_idempotency_key, created_at) tuple is the 10-minute dedup window
// the slice spec §"Error mapping" 409 rule names.
export const codingAnalysisRuns = pgTable('coding_analysis_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull(),
  project_id: uuid('project_id'),
  repo_id: uuid('repo_id').notNull(),
  container_name: text('container_name').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  upstream_id: text('upstream_id'),
  correlation_id: text('correlation_id').notNull(),
  client_idempotency_key: text('client_idempotency_key').notNull(),
  options_json: jsonb('options_json').$type<Record<string, unknown>>().notNull().default({}),
  findings_json: jsonb('findings_json').$type<unknown>(),
  findings_count: integer('findings_count'),
  raw_json: jsonb('raw_json').$type<unknown>(),
  scan_degraded: boolean('scan_degraded'),
  error_code: text('error_code'),
  error_message: text('error_message'),
  started_at: timestamp('started_at'),
  finished_at: timestamp('finished_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
},
  // Prod enforces both; CI had neither (plain `text` columns, no enum narrowing).
  (t) => [
    check(
      'coding_analysis_runs_status_check',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    check(
      'coding_analysis_runs_type_check',
      sql`${t.type} IN ('security', 'bug_hunt', 'quality', 'dependencies', 'tests')`,
    ),
  ],
);

// User secrets table
export const userSecrets = pgTable('user_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  secret_type: text('secret_type').notNull(), // api_key, oauth, basic_auth, custom

  // Encrypted data
  encrypted_value: bytea('encrypted_value').notNull(),
  iv: text('iv').notNull(), // Initialization vector

  metadata: jsonb('metadata').$type<Record<string, any> | null>(),
  is_valid: boolean('is_valid').default(true),

  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  last_used: timestamp('last_used'),
});

// Approvals table
export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Migration 043 — tenant scope for cross-tenant isolation. Required on
  // every insert; see handleListMyApprovals + role-match leak fix on PR #77.
  tenant_id: uuid('tenant_id').notNull(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  // Migration 123 — the project REQUEST this approval decides, for
  // kind = 'project_outline.approval'. NULL for every other approval, which is
  // the overwhelming majority: all three pre-existing raise sites require an
  // existing project.
  // ⚠️ NULLABLE ON BOTH SIDES BY DESIGN. An ordinary approval has no request;
  // an outline approval has no project YET. A NOT NULL on either column makes
  // one of the two populations unrepresentable.
  // This column is what lets the outline decision reuse the approvals machinery
  // — decisions, optimistic locking, WS broadcast, n8n callback — rather than
  // growing a second decision mechanism beside it.
  project_request_id: uuid('project_request_id').references(
    () => projectRequests.id,
    { onDelete: 'cascade' },
  ),
  requester_id: uuid('requester_id'),
  status: text('status').default('pending').notNull(), // pending, approved, rejected
  // Plan 5/6 discriminator (migration 038). Defaults to 'generic' so
  // existing approval flows are untouched.
  kind: approvalKindEnum('kind').notNull().default('generic'),
  description: text('description').notNull(),
  change_summary: text('change_summary'),
  impact_analysis: text('impact_analysis'),

  // Communication hub fields
  callback_path: text('callback_path'),   // n8n webhook callback path
  card_id: text('card_id'),               // Planka card ID
  source: text('source').default('web'),  // 'web' | 'n8n'
  metadata: jsonb('metadata').$type<Record<string, any> | null>(),            // {doingListId, todoListId, boardId, recipient, ...}
  // Migration 192 — D13: the ONE artifact this approval is about,
  // `{artifact_id, version?}` (lib/approval-artifact-ref.ts). NULL = none. Validated
  // at create against the approval's own project; returned on every read and
  // echoed on the decision callback.
  artifact_ref: jsonb('artifact_ref').$type<{ artifact_id: string; version?: number } | null>(),

  created_at: timestamp('created_at').defaultNow().notNull(),
  // Nullable since migration 105: NULL means "no deadline, ever". A card-blocking
  // approval must not expire — BLOCKED is the human-input gate, and the AA spec set
  // (nine documents) contains zero occurrences of "expir". Read it through
  // lib/approval-deadline.ts::hasPassedDeadline, never a bare `new Date(x)` comparison:
  // `new Date(null)` is epoch 0, so a bare compare reads NULL as maximally expired.
  expires_at: timestamp('expires_at'),
  completed_at: timestamp('completed_at'),

  // Migration 101 — WHO WAS ASKED, and WAS ANYONE ACTUALLY TOLD.
  // Nullable only to carry the 362 historical rows that asked nobody; new rows
  // resolve an addressable human at the boundary or fail loud. `notified_at` NULL at
  // expiry means the SYSTEM failed, not the person — without it, "expired" and
  // "asked and ignored" are the same row, which is how 335 never-delivered approvals
  // read as George's decisions.
  approver_user_id: uuid('approver_user_id'),
  notified_at: timestamp('notified_at', { withTimezone: true }),
  // Migration 186 — approval re-delivery attempt counter + backoff
  // (workers/approval-redelivery.ts). Bumped after every re-delivery pass that
  // did not confirm delivery; a row is not re-eligible before next_redelivery_at
  // (NULL = eligible now) and is skipped once attempts reach the worker's cap.
  redelivery_attempts: integer('redelivery_attempts').notNull().default(0),
  next_redelivery_at: timestamp('next_redelivery_at', { withTimezone: true }),

  // Migration 109 — WAS THE DECISION EVER DELIVERED TO n8n.
  //
  // `notified_at` (above) measures the INBOUND half: was a human ever told there
  // was something to decide. This measures the OUTBOUND half: once they decided,
  // did the callback that moves the card BLOCKED->DOING actually land. They are
  // different failures and they were previously both invisible in the same way.
  //
  // Stamped in exactly ONE place — services/n8n-callback.ts::deliverDecisionCallback,
  // after n8nClient.sendApprovalDecision returns without throwing (the client throws
  // on any non-2xx). It is a MEASUREMENT, never an intention: nothing may set it
  // optimistically, or "delivered" and "we tried" become the same row again.
  //
  // NULL = not known delivered, and that is the population
  // the re-delivery worker targets (workers/deblock-callback-redelivery.ts,
  // registered 2026-09-05; this said "none is registered yet"). Measured on prod 2026-09-04:
  // 320 cards stuck in BLOCKED behind 488 already-decided approvals, ~255 of them
  // because fr never sent / n8n never received. NULL on a pre-109 row means the
  // column did not exist yet, NOT that the send failed — which is why the worker
  // carries an age window rather than sweeping all of history.
  // ⚠️ MIGRATION 113 CHANGED WHAT THIS MEANS. Everything above describes the
  // column as it was stamped between 109 and 113: on n8n's 2xx TRANSPORT ACK.
  // That was a measurement of the wrong thing — n8n acks on receipt and moves
  // the Planka card afterwards, in a queue that has been measured giving up.
  // MEASURED 2026-09-06: of 373 callbacks "delivered" in 30h, 373/373 (253
  // distinct cards) were still in BLOCKED, and every one of them had been
  // retired from the re-delivery worker's population by this very stamp.
  //
  // From 113 it means THE CARD ACTUALLY LEFT BLOCKED, and it is written in
  // exactly one place: workers/deblock-callback-redelivery.ts, alongside
  // `callback_resolution = 'moved'`, after re-reading the card from Planka.
  // The ack now lives in `callback_acked_at` below.
  // ⚠️ Rows stamped BEFORE 113 still carry the old ack meaning — 113
  // deliberately does not clear them (that is a separately paced operator
  // repair, not a migration). Read `callback_resolution` when you need to know
  // what actually happened.
  callback_delivered_at: timestamp('callback_delivered_at', { withTimezone: true }),

  // Migration 113 — THE TRANSPORT ACK, told apart from the EFFECT.
  //
  // `callback_acked_at`: n8n returned 2xx. Stamped by
  // services/n8n-callback.ts::deliverDecisionCallback, which no longer writes
  // `callback_delivered_at` at all. An ack does NOT retire a row from the
  // re-delivery worker — it only starts a grace window, because the card may
  // still be moving.
  callback_acked_at: timestamp('callback_acked_at', { withTimezone: true }),

  // `callback_resolution`: the TERMINAL state, and the thing that stops the
  // worker re-selecting the same rows forever. FIVE values, kept
  // distinct on purpose so a future reader can tell them apart:
  //   'moved'           — we sent, and the card was then observed out of BLOCKED
  //   'not_blocked'     — the card was already off the board; we never sent
  //   'card_unreadable' — Planka answered 404 ON THE CARD'S OWN READ PATH
  //                       (/api/cards/:id) on CONSECUTIVE attempts spanning
  //                       hours of wall clock, in ticks that did not themselves
  //                       look like a Planka-wide outage
  //   'send_exhausted'  — MAX_SEND_ATTEMPTS sends, all acked, card never moved
  //   'hold_acknowledged' — the receiver's own 200 body reported `deliberate_hold`
  //                       (workers/deblock-callback-redelivery.ts,
  //                       `classifyReceiverHold`). Added by migration 119.
  //   'read_degraded'   — fr could never establish which list the card is in:
  //                       DEGRADED_STRIKES consecutive answerless reads spanning
  //                       DEGRADED_MIN_SPAN_MS, EACH charged only on a tick that
  //                       read OTHER cards successfully. Added by migration 134
  //                       (#1104). ⛔ NOT `card_unreadable`, which means Planka
  //                       answered 404 on the card's own read path and is evidence
  //                       ABOUT THE CARD; this value claims nothing about the card
  //                       at all, only that fr gave up looking. NOT `moved` either —
  //                       it stamps no `callback_delivered_at`.
  //   'card_left_blocked_since_approval' — APPROVED signoff rows only: the card's
  //                       Planka journey shows it left BLOCKED after the approval
  //                       was created, so we did not re-send. Migration 159.
  //   'card_tenant_not_platform' — APPROVED signoff rows only: the card's owning
  //                       tenant is not in PLATFORM_TENANT_IDS; never sent. 159.
  // NULL = not terminal, still a candidate.
  //
  // ⚠️ CORRECTED 2026-09-23: this list said "Exactly four values" and omitted
  // `hold_acknowledged` for as long as migration 119 has been live. The CHECK
  // constraint at the bottom of this table and the note beside it both said FIVE.
  // A reader who trusted the prose here would have written a `callback_resolution`
  // handler with a missing arm and no compile error. Grep
  // `approvals_callback_resolution_check` in this file to disprove this line.
  //
  // ⚠️ CORRECTED 2026-09-06: this line used to say "Constrained in SQL by
  // approvals_callback_resolution_check (drizzle has no CHECK primitive)".
  // Drizzle HAS a CHECK primitive — `check` is imported at the top of this file
  // and used 25 times below — and `drizzle-kit push` emits the constraints it
  // declares. The constraint is therefore declared in the table extras at the
  // bottom of this table, for the CI/prod parity every other CHECK here has
  // (tests/integration/services/db-invariants.integration.test.ts).
  callback_resolution: text('callback_resolution'),
  callback_resolved_at: timestamp('callback_resolved_at', { withTimezone: true }),

  // CONSECUTIVE unreadable reads; any successful read resets it to 0. A deleted
  // card and an unreachable Planka are indistinguishable in one read, so
  // retiring on the first miss would let one blip write off the whole backlog.
  callback_unreadable_reads: integer('callback_unreadable_reads').notNull().default(0),

  // WHEN the current run of consecutive unreadable reads began; NULL when there
  // is no run. The strike COUNT is a count of TICKS and ticks are 15 minutes
  // apart, so three of them is 45 minutes — far shorter than a Planka outage.
  // Retirement needs the run to span UNREADABLE_MIN_SPAN_MS of wall clock too,
  // and this is the clock it is measured on. Reset with the count.
  //
  // ⚠️ CORRECTED 2026-09-06 — the worker's constant block used to call the
  // 404-only rule and this clock "two independent terms, so either one alone
  // still refuses". FALSE, and false for the case it named. Both are PER-ROW, so
  // against a Planka that 404s every card neither refuses: term 1 sees only real
  // 404s, and this clock merely postpones the write-off by six hours, at which
  // point every row in the population matures at the same moment. The cross-row
  // guard is DEGRADED_TICK_MIN_READS / DEGRADED_TICK_GONE_RATIO in
  // workers/deblock-callback-redelivery.ts, and it is the only term that can
  // distinguish a deleted card from a broken Planka.
  callback_unreadable_first_at: timestamp('callback_unreadable_first_at', { withTimezone: true }),

  // Sends made for this row, ever. An acked-but-never-moved row re-entered the
  // worker's population every ACK_GRACE_MS and was re-sent forever; the n8n
  // receiver does not dedupe, so every one of those sends moves the card if it
  // ever does work. Bounded by MAX_SEND_ATTEMPTS → 'send_exhausted'.
  callback_send_attempts: integer('callback_send_attempts').notNull().default(0),

  // ── #1104, MIGRATION 134 ──────────────────────────────────────────────────
  // CONSECUTIVE reads that ANSWERED NOTHING about this card — a 5xx/timeout on
  // the card read, a 404 on the LIST read (which is not evidence about the card:
  // the card read returned 200 first), or a 200 with no listId/name. Any read
  // that DOES resolve the card's list resets it to 0.
  //
  // ⛔ DELIBERATELY NOT `callback_unreadable_reads`, AND THE SEPARATION IS THE
  // WHOLE POINT. That column counts DEFINITIVE misses (404 on /api/cards/:id) and
  // the worker's header spends a screen insisting an answerless read must never be
  // folded into it — a 504 is evidence about PLANKA, not about the card, and
  // charging it there is how one outage writes off a backlog. So a bound for these
  // reads needs a counter of its own, with a much longer span and a cross-row
  // guard of its own.
  //
  // ⚠️ A STRIKE HERE IS CHARGED ONLY ON A TICK THAT READ SOME OTHER CARD
  // SUCCESSFULLY. That is the discriminator between a permanently-unreadable card
  // and a transient Planka outage, and it is what makes an outage incapable of
  // incrementing this column at all. See `applyDegradedStrikes` in
  // workers/deblock-callback-redelivery.ts.
  callback_degraded_reads: integer('callback_degraded_reads').notNull().default(0),

  // WHEN the current run of answerless reads began; NULL when there is no run.
  // Reset with the count, and for the same reason `callback_unreadable_first_at`
  // exists: the strike COUNT counts ticks, and ticks are not time.
  callback_degraded_first_at: timestamp('callback_degraded_first_at', { withTimezone: true }),

  // Migration 122 — WHEN fr STOPPED WAITING WITHOUT LEARNING THE OUTCOME.
  //
  // ── THE DEFECT: THE INSTRUMENT DID NOT RECORD ITS OWN UNCERTAINTY ──────────
  // `routes/approvals.ts :: reportDecisionCallback` races the outbound decision
  // callback against `decisionRequestDeadlineMs()` (8s). When the deadline wins
  // it answers the decider `callback.outcome: 'pending'` with 202 — truthfully,
  // because fr genuinely does not know — and then wrote NOTHING ANYWHERE. No
  // column, no row, no field on `approval_decisions`. After the response was
  // read, that row was byte-identical to a row whose callback had never been
  // owed.
  //
  // ⛔ SO "HOW OFTEN DOES THIS HAPPEN" HAD NO ANSWER, AND A ZERO COUNT WAS NOT
  // EVIDENCE OF RARITY. It was evidence that nothing was counting. Measured on
  // prod 2026-09-15: 1,148 of 2,321 approved rows (49.5%) carry
  // `callback_acked_at IS NULL` across several resolutions, so the population
  // this path can draw from is large — and no query could isolate the slice this
  // branch produced. That is the whole reason this column exists: NOT to change
  // what fr does, only to make what it already does COUNTABLE.
  //
  // ── WHY IT IS *NOT* A SIXTH `callback_resolution` VALUE ────────────────────
  // ⛔ THE OBVIOUS MOVE IS THE WRONG ONE, AND THIS FILE ALREADY SAYS WHY TWICE.
  // `callback_resolution` is the DE-BLOCK WORKER'S TERMINAL VOCABULARY, and
  // `AND a.callback_resolution IS NULL` is a clause of its candidate predicate
  // (workers/deblock-callback-redelivery.ts :: candidateWhereBase). Writing any
  // value there retires the row from the ONLY repair path there is. At the exact
  // instant this branch fires, `callback_acked_at` is still NULL and the send is
  // still in flight — i.e. the row is a PRIME re-delivery candidate. Retiring it
  // on the grounds that fr did not wait long enough would strand precisely the
  // cards that most need repairing, which is the same shape as the migration-113
  // defect (373 of 373 rows retired by a stamp written too eagerly) pointed at a
  // new column. `services/n8n-callback.ts :: recordDecisionCallbackProblem`
  // refuses the identical move for the identical reason; so does the
  // `notARejectedHold` block in the de-block worker.
  //
  // ⇒ A column that means TERMINAL must only be written by something that
  //   reached a terminal state. This branch never does. So: a separate,
  //   NON-terminal observation column, exactly as migration 116 separated
  //   "we LOOKED at this row" from "we CHANGED this row".
  //
  // ── WHY THE NAME CANNOT BE READ AS A FAILURE ──────────────────────────────
  // ⭐ AN UNKNOWN IS NOT A FAILURE, AND THE TWO MAKE OPPOSITE CLAIMS ABOUT THE
  // RECEIVER. `failed` says the receiver did not take the work. This says only
  // that FR STOPPED LISTENING — see `DecisionCallbackOutcome :: 'timeout-unknown'`
  // in services/n8n-callback.ts for the measurement that forced that distinction
  // (66 rows in 3 days stamped "abandoned", against a receiver that recorded ZERO
  // errored executions in the same window, whose own p50 is 9,472 ms). The column
  // is therefore named for the EPISTEMIC state — the outcome was unknown at this
  // instant — and carries no failure word anywhere in it. A reader who wants
  // failures reads `error_message`; a reader who wants terminal states reads
  // `callback_resolution`; this column answers neither question and claims
  // nothing about the card.
  //
  // NULL means "fr was never left not-knowing on the request path for this row"
  // — the overwhelmingly common case, including every successful send. It is
  // deliberately NOT backfilled: there is no way to reconstruct which historical
  // rows took this branch, and stamping them would manufacture the very
  // measurement this column exists to start taking honestly.
  //
  // ⚠️ IT IS NOT AN ENDING. A stamped row stays fully repairable: the in-flight
  // send may still ack, and workers/deblock-callback-redelivery.ts still selects
  // it. Nothing may ever add this column to a candidate predicate as an exclusion.
  callback_outcome_unknown_at: timestamp('callback_outcome_unknown_at', { withTimezone: true }),

  // Migration 110 — the void seam. `voided` is a FIFTH status, deliberately not
  // folded into 'rejected' or 'expired': rejected means a human said no, expired
  // means nobody answered in time, voided means the ask was never ANSWERABLE and
  // is being withdrawn without a decision. Measured 2026-09-05: 240 pending rows
  // have zero `required_approvers`, no `gate_terms` and no producer rationale —
  // unanswerable by construction, 192 of them holding a card in BLOCKED.
  // ⛔ A void is NOT a decision: it writes no `approval_decisions` row, so the
  // quorum tally and every decision reader stay truthful about who decided what.
  voided_at: timestamp('voided_at', { withTimezone: true }),
  voided_reason: text('voided_reason'),
  voided_by: text('voided_by'),

  // Migration 212 DROPPED the four write-only `triage_*` columns (101) and
  // `approvals_triage_verdict_check`. Nothing wrote them since 2026-09-23 and nothing
  // ever read them. Who decided — a human, the triage agent or a rule — is recorded per
  // decision on `approval_decisions.decided_by_kind` (migration 211).

  // E-5: action-approval bus — binds an approval row to a pending action
  // invocation from the AG-UI registry (E-2). Null for traditional approvals.
  action_id: uuid('action_id'),
  action_name: text('action_name'),
  action_input_json: jsonb('action_input_json').$type<unknown>(),
  action_correlation_id: text('action_correlation_id'),
  action_channel: text('action_channel'),

  // E-5 stale-executing reaper: bumped on every status transition so the
  // reaper can detect rows wedged in `executing` past the threshold.
  // `error_message` records the reason (handler throw or reaper sweep).
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  error_message: text('error_message'),
},
  // Migration 113's terminal-state CHECK, declared here so `drizzle-kit push`
  // emits it on a CI-shaped database exactly as the SQL migration emits it in
  // prod — the parity rule stated at the `suggestedSchedules` extras below and
  // enforced by tests/integration/services/db-invariants.integration.test.ts.
  //
  // ⛔ AND THE MIGRATION'S PROBE DOES NOT DEPEND ON THIS. Until 2026-09-06,
  // migration 113 was probed by `constraintExists(approvals,
  // approvals_callback_resolution_check)` on the false premise that push emits
  // no CHECKs. Declaring the constraint here would then have made that probe
  // TRUE on a fresh push-built DB and the migration "applied" without ever
  // running — silently dropping its backfill. The probe now reads the backfill's
  // own receipt row in `_migration_effects`, which push cannot produce at all,
  // so this declaration is free. Do not move the probe back onto a constraint.
  //
  // ⚠️ EIGHT VALUES SINCE MIGRATION 159. `card_left_blocked_since_approval` and
  // `card_tenant_not_platform` are written by the same worker, only for an APPROVED
  // row on `execution-ready-signoff-callback`, INSTEAD of a re-send (MERGE-QUEUE fr
  // row 12). This list and 159's must match — the ⛔ below applies verbatim.
  //
  // ⚠️ SIX VALUES SINCE MIGRATION 134, NOT FIVE. `read_degraded` (#1104) is written
  // by the same worker when it could never establish which list a card is in, over
  // DEGRADED_STRIKES ticks spanning DEGRADED_MIN_SPAN_MS, each charged only on a
  // tick that read OTHER cards successfully. The ⛔ below applies to it verbatim.
  //
  // ⚠️ FIVE VALUES SINCE MIGRATION 119, NOT FOUR. `hold_acknowledged` is written
  // by workers/deblock-callback-redelivery.ts when the receiver's own 200 body
  // reports `deliberate_hold` — see `classifyReceiverHold` there. ⛔ THIS LIST AND
  // MIGRATION 119's MUST MATCH: a push-built CI database takes the constraint from
  // HERE and a migrated database takes it from THERE, so a value added to one only
  // passes the whole suite in one of the two environments and rejects every write
  // in the other, at runtime, with `tsc` green.
  (t) => [
    check(
      'approvals_callback_resolution_check',
      sql`${t.callback_resolution} IS NULL OR ${t.callback_resolution} IN ('moved', 'not_blocked', 'card_unreadable', 'send_exhausted', 'hold_acknowledged', 'read_degraded', 'card_left_blocked_since_approval', 'card_tenant_not_platform')`,
    ),
  ],
);

/** Migration 211 — `approval_decisions.decided_by_kind`. This list and 211's CHECK must match. */
export const DECIDED_BY_KINDS = ['human', 'triage_agent', 'rule', 'agent'] as const;
export type DecidedByKind = (typeof DECIDED_BY_KINDS)[number];

// Approval decisions table (tracks individual approver decisions)
/** `approval_decisions.via` (migration 219). */
export interface DecisionVia {
  channel: string;
  agent_member_id: string;
  product: string;
  job_id?: string;
}

export const approvalDecisions = pgTable('approval_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  approval_id: uuid('approval_id').references(() => approvals.id, { onDelete: 'cascade' }).notNull(),
  approver_id: uuid('approver_id').notNull(),
  decision: text('decision').notNull(), // approved, rejected
  comment: text('comment'),
  decided_at: timestamp('decided_at').defaultNow().notNull(),
  /**
   * WHICH roster obligation this decision discharged (migration 108, issue #923).
   *
   * `approverIdentityFilter` admits a caller by `required_approvers.user_id` OR by
   * a matching `required_approvers.role`. Both are legitimate, but without this
   * column a role-authorised decision was indistinguishable from the named
   * approver's, and quorum was a count-vs-count comparison that never asked whose
   * obligation had been met. Measured: 338 of 343 decisions were on approvals
   * whose rostered approver was a different uuid, and those approvals completed.
   *
   * NULL means "pre-108, unknown" — never "unrostered". It is not backfilled
   * because the caller's roles at decision time were never recorded, so any
   * backfill would be a guess written as a fact.
   */
  required_approver_id: uuid('required_approver_id'),
  /**
   * Migration 153 (U3) — the structured G-12 decision for a bug_fix_authorization MARKED
   * row (A1; plus rejected_bug_ids) and `execution.feature_design_approval` (A3):
   * {rule_row, rule_version, inputs_hash, items:[{item_id, decision, reason_code}]}.
   * NULL for every other decision. Its shape
   * CHECK lives only in the migration (probed by the runner).
   */
  item_decisions: jsonb('item_decisions').$type<Record<string, unknown> | null>(),
  /**
   * Migration 211 (cockpit R-CK1) — WHAT decided: `human` (a person), `triage_agent` (a Claude
   * approval-triage service account deciding as an ordinary approver uuid) or `rule` (fr policy
   * code, no person). The cockpit counts only `human` as waiting-on-people time. Every insert site
   * sets it explicitly via `lib/decided-by-kind.ts decidedByKindFor`; the DB default exists only so
   * the column could land NOT NULL on historical rows. CHECK in both emitters (below + 211).
   */
  decided_by_kind: text('decided_by_kind', { enum: DECIDED_BY_KINDS }).notNull().default('human'),
  // Migration 219 (fr #1683): how a decision arrived when not on the decider's own seat —
  // {channel, agent_member_id, product, job_id?} for staff answering through the agent member.
  via: jsonb('via').$type<DecisionVia | null>(),
}, (table) => ({
  decidedByKindCheck: check(
    'approval_decisions_decided_by_kind_check',
    sql`${table.decided_by_kind} IN ('human', 'triage_agent', 'rule', 'agent')`,
  ),
  // Migration 157 — one decision per approver per approval, enforced by the DATABASE.
  // Every seat already check-then-inserts this invariant (approvals.ts 422 "already made a
  // decision", teams {duplicate:true}); the index closes the race between the two
  // (concurrent deliveries / a Telegram webhook retry). Measured 0 duplicates 2026-10-02.
  // This index (+ recordDecision's FOR UPDATE re-check) is the exactly-once guarantee for a
  // DECISION; there is deliberately no Telegram update_id ledger (it lost messages).
  approvalApproverUnique: uniqueIndex('approval_decisions_approval_approver_unique').on(
    table.approval_id,
    table.approver_id,
  ),
}));

// Migration 191 (D17) — the n8n Wait node's `$execution.resumeUrl` for an
// approval a LICENCE mint raised, validated against N8N_CALLBACK_ORIGINS
// (lib/approval-callback-url.ts). 1:N — a create that dedupes onto an existing
// pending gate ATTACHES its URL (unique per approval + md5(url); re-attach is a
// no-op). On any terminal status (approved / rejected / expired / voided) every
// row is POSTed exactly as given, each with its OWN delivery state. The approval
// itself stores `callback_path` NULL. ⛔ A CAPABILITY (its `signature` query
// param is a secret) — a side table, not an `approvals` column, so no full-row
// read of `approvals` (REST, websocket, fan-out) can ever carry it. Never log it
// in full: origin + path prefix only.
export const approvalCallbackUrls = pgTable(
  'approval_callback_urls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approval_id: uuid('approval_id')
      .notNull()
      .references(() => approvals.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id').notNull(),
    callback_url: text('callback_url').notNull(),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    approvalUrlKey: uniqueIndex('approval_callback_urls_approval_url_key').on(
      t.approval_id,
      sql`md5(${t.callback_url})`,
    ),
    undeliveredIdx: index('approval_callback_urls_undelivered_idx')
      .on(t.next_attempt_at)
      .where(sql`${t.delivered_at} IS NULL`),
  }),
);

// Required approvers table (tracks who needs to approve)
export const requiredApprovers = pgTable('required_approvers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Migration 043 — tenant scope. role is a plain text label shared
  // across tenants, so role-match queries (handleListMyApprovals) MUST
  // filter on tenant_id to avoid cross-tenant leaks.
  tenant_id: uuid('tenant_id').notNull(),
  approval_id: uuid('approval_id').references(() => approvals.id, { onDelete: 'cascade' }).notNull(),
  user_id: uuid('user_id').notNull(),
  role: text('role'), // tech_lead, manager, owner, etc.
});

// Project stakeholders (migration 074) — the auditable record of who must
// sign off on a project's execution gate. Project-create persists one row per
// approver (role 'execution_signoff'); POST /api/execution/approvals reads
// them to build an approval's required_approvers + fan out. (project_id,
// user_id, role) is the natural key — one user may hold multiple roles.
export const projectStakeholders = pgTable('project_stakeholders', {
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  user_id: uuid('user_id').notNull(),                  // Keycloak subject UUID
  role: text('role').notNull().default('execution_signoff'),
  added_at: timestamp('added_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.project_id, table.user_id, table.role] }),
  userIdx: index('project_stakeholders_user_id_idx').on(table.user_id),
}));

// ── Per-member KNOWLEDGE AREAS (migration 135) ───────────────────────────────
//
// WHO TO ASK, not what anyone may do. An area is a knowledge domain used to
// route a consultation to a human ("for api questions member A, for business
// decisions member B"). It grants NO permission; authority lives in
// `user_roles` and nowhere else.
//
// ⛔ THIS IS NOT A WIDENING OF `user_roles.role`. That column is CHECK-locked by
// migration 104 to 'workspace-admin' | 'workspace-member' and ~13 gates read it
// as AUTHORITY. A knowledge area in that column would make `isWorkspaceAdminVia`
// and `listUsersByRole` answer a question nobody asked, and the first symptom
// would be an authorization bug rather than a routing one.
//
// ⭐ THE VOCABULARY IS THE TENANT'S RM CAPABILITIES (design: fr consumes RM
// vocabulary, Q1 = a). It is per tenant and lives in requirements_management,
// so there is no CHECK here (migration 187 dropped 135's); the write paths
// validate against the tenant's capability names (lib/knowledge-areas.ts).
export const memberKnowledgeAreas = pgTable(
  'member_knowledge_areas',
  {
    tenant_id: uuid('tenant_id').notNull(),
    // TEXT, matching `user_roles.user_id` (also text) — membership is the
    // population this table annotates, and a uuid column here would refuse
    // exactly the legacy non-uuid Keycloak subjects `user_roles` accepts.
    // ⚠️ `project_stakeholders.user_id` IS uuid; that asymmetry is pre-existing.
    user_id: text('user_id').notNull(),
    area: text('area').notNull(),
    assigned_at: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    // Nullable text, the same shape and reason as `user_roles.granted_by`.
    assigned_by: text('assigned_by'),
  },
  (t) => ({
    // A member may hold SEVERAL areas; re-recording one is an upsert, which is
    // where the write path's idempotency comes from.
    pk: primaryKey({ columns: [t.tenant_id, t.user_id, t.area] }),
    // ⛔ NO FK on tenant_id. MEASURED on the prod primary 2026-09-27: 13 grants
    // across 13 distinct tenants, `workspaces` holds 10 rows, and 8 of those 13
    // tenants have NO `workspaces` row — a FK would refuse a legitimate write
    // for 8 of 13 LIVE tenants. Membership is checked on the write path, where
    // it can return a diagnosis instead of a constraint violation.
    tenantAreaIdx: index('member_knowledge_areas_tenant_area_idx').on(t.tenant_id, t.area),
    // No area CHECK (migration 187 dropped 135's): the vocabulary is the
    // tenant's RM capabilities (design Q1 = a), validated on the write path.
  }),
);

// Execution sign-off blocks (migration 098) — the durable ledger of cards the
// AA ready-prefetch gate parked in BLOCKED but for which fr could NOT create an
// approval (unknown project / untenanted project / empty approver roster).
//
// The gate's caller (the n8n `Create Approval (Signoff)` HTTP node) runs with
// onError:continueRegularOutput, so the 404/400/422 fr returns is discarded and
// the card is stranded with no trace. A response status is advice to a caller
// that has already decided to ignore it; this row is the system's own memory,
// and it is what makes "which cards can never be released?" a SELECT instead of
// a cross-database join.
//
// One row per (card_id, reason_code) — the gate re-fires on every card touch,
// so a block is a counter (attempts/last_seen_at), not an event stream.
// tenant_id is NULLABLE by design: an unresolvable project has no resolvable
// tenant, and dropping those rows would discard exactly the evidence the table
// exists for. Reads are super-admin-only in consequence.
export const executionSignoffBlocks = pgTable('execution_signoff_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  card_id: text('card_id').notNull(),
  board_id: text('board_id'),
  // Verbatim, un-validated: a non-UUID project key is the case we must record.
  requested_project_id: text('requested_project_id'),
  // Set only when the project row resolved; no FK, so deleting a project does
  // not erase the evidence that its cards were stranded.
  resolved_project_id: uuid('resolved_project_id'),
  tenant_id: uuid('tenant_id'),
  reason_code: text('reason_code').$type<SignoffBlockReason>().notNull(),
  detail: text('detail').notNull(),
  attempts: integer('attempts').default(1).notNull(),
  first_seen_at: timestamp('first_seen_at').defaultNow().notNull(),
  last_seen_at: timestamp('last_seen_at').defaultNow().notNull(),
  resolved_at: timestamp('resolved_at'),
}, (table) => ({
  cardReasonKey: uniqueIndex('execution_signoff_blocks_card_reason_key').on(
    table.card_id,
    table.reason_code,
  ),
}));

// Comments table
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  author_id: uuid('author_id').notNull(),
  content: text('content').notNull(),
  mentions: jsonb('mentions'), // Array of {user_id, username}

  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  edited: boolean('edited').default(false),
});

// Project metrics table
export const projectMetrics = pgTable('project_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  date: timestamp('date', { mode: 'date' }).notNull(),

  cycle_time_days: integer('cycle_time_days'),
  lead_time_days: integer('lead_time_days'),
  throughput: integer('throughput'),
  success_rate: integer('success_rate'), // 0-100
  error_rate: integer('error_rate'), // 0-100
  quality_score: integer('quality_score'), // 0-100

  completed_tasks: integer('completed_tasks').default(0),
  failed_tasks: integer('failed_tasks').default(0),

  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Project reports table (n8n-generated reports pushed to FR)
export const projectReports = pgTable(
  'project_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Migration 080 — tenant scope for cross-tenant isolation. NULLABLE on
    // purpose: project_id is optional and some legacy Planka-only rows map to
    // no FR project/stream, so they cannot be attributed to a tenant. The read
    // paths (handleListReports / handleGetReport) filter on this column, so a
    // NULL-tenant row is fail-closed (invisible to every tenant). The write
    // path (handleN8nReport) derives it from project_id/board_id going forward.
    tenant_id: uuid('tenant_id'),
    project_id: uuid('project_id'),              // optional — may not map to FR project
    card_id: text('card_id'),                     // Planka card ID
    report_type: text('report_type').notNull(),   // 'status', 'sprint', 'dependency', 'quality', 'custom'
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details'),                    // structured report data
    board_id: text('board_id'),                   // Planka board
    generated_by: text('generated_by'),           // 'n8n', 'manual'
    // Migration 147 (U2) — H_r for report_type 'bug_report': sha256 of the RFC
    // 8785 canonical bug_report/v1 hash body (src/lib/bug-report-hash.ts),
    // recomputed server-side. NULL for every other report type. The partial
    // UNIQUE (tenant_id, content_hash) and the two CHECKs live ONLY in
    // migrations/147 (push cannot express the partial index; see the 147 probe).
    content_hash: text('content_hash'),
    // Migration 149 — AA-TRACE §1 join key (UUIDv7) of the run that wrote the
    // row; NULL = orphan write (§2). NOT part of H_r. The v7 CHECK and the
    // partial index live ONLY in migrations/149 (see the 149 probe).
    trace_id: uuid('trace_id'),
    created_at: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    // Tenant-leading indexes (migration 080) — the scoped list query
    // (WHERE tenant_id = $1 ORDER BY created_at DESC) and the per-project
    // filter both use a covering scan.
    tenantCreatedIdx: index('project_reports_tenant_created_idx').on(
      t.tenant_id,
      t.created_at,
    ),
    tenantProjectIdx: index('project_reports_tenant_project_idx').on(
      t.tenant_id,
      t.project_id,
    ),
  }),
);

// User channel preferences — who gets notified via which channel at which address.
// Used by NotificationService.fanOutToUser to resolve recipients from a user id.
// (user_id, channel, address) is the natural key.
export const userChannelPrefs = pgTable('user_channel_prefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: text('user_id').notNull(),
  channel: text('channel').notNull(),      // 'telegram' | 'teams' | 'websocket' | 'email'
  address: text('address').notNull(),       // phone / webhook URL / ws connection id / email
  tenant_id: text('tenant_id'),             // migration 216: the workspace this link acts in (NULL = unpinned)
  enabled: boolean('enabled').default(true).notNull(),
  is_default: boolean('is_default').default(false).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Engagement delivery log — audit of every send attempt across every channel.
// Written by fanOut for every recipient (success, failure, or skipped_disabled).
// `engagement_id` is TEXT + nullable so non-UUID future engagement types fit.
export const engagementDeliveries = pgTable('engagement_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  engagement_id: text('engagement_id'),
  engagement_type: text('engagement_type').notNull(), // 'approval' (initial)
  channel: text('channel').notNull(),
  recipient_user_id: text('recipient_user_id'),
  recipient_address: text('recipient_address').notNull(),
  status: text('status').notNull(),                    // 'sent' | 'failed' | 'skipped_disabled'
  error: text('error'),
  metadata_json: jsonb('metadata_json').$type<Record<string, any> | null>(),
  // E-8: binds a delivery row to an action invocation (null for legacy
  // approval-only deliveries).
  action_id: uuid('action_id'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Migration 078 — caches (chat_id, project_key) -> Telegram forum topic id so
// the TelegramAdapter creates ONE forum topic per project and reuses it across
// sends (createForumTopic always makes a new topic, so we must cache). Gated
// behind TELEGRAM_USE_TOPICS; only written when posting to a forum supergroup.
export const telegramForumTopics = pgTable(
  'telegram_forum_topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chat_id: text('chat_id').notNull(),
    project_key: text('project_key').notNull(),
    message_thread_id: integer('message_thread_id').notNull(),
    topic_name: text('topic_name'),
    created_at: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    chatProjectUnique: unique('telegram_forum_topics_chat_project_unique').on(
      table.chat_id,
      table.project_key,
    ),
  }),
);

// (migration 146's `telegram_pending_answers` — the "the bot asked this sender for an
// answer" marker — was DELETED by migration 223 with its state machine: owner ruling
// 2026-10-31, every channel runs the same flow and no channel keeps reply state.)

// WS1 Phase 1A — project-execution notification inbox. The durable per-user
// record of a non-approval lifecycle/outcome event. Written by
// NotificationService.fanOutEventToUser regardless of external-channel
// delivery; `read_at IS NULL` is the unread-badge predicate. Distinct from
// `inapp_messages` (a chat transcript with no read-state) on purpose.
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull(),
  user_id: text('user_id').notNull(),
  event_type: text('event_type').notNull(),  // see domain/engagement/event-types.ts
  severity: text('severity').default('info').notNull(), // info|success|warning|error
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  project_id: text('project_id'),
  card_id: text('card_id'),
  execution_id: text('execution_id'),
  source: text('source').default('n8n').notNull(),
  correlation_id: text('correlation_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
  read_at: timestamp('read_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// WS1 Phase 1A — per-user, per-event-type channel routing (the WHAT layer).
// `user_channel_prefs` answers WHERE a user is reachable; this answers WHICH
// event types reach WHICH channels. Composed at dispatch by
// domain/engagement/notification-prefs.ts; missing rows fall back to
// event-types.ts defaults. (user_id, event_type, channel) is the upsert key.
export const notificationPrefs = pgTable('notification_prefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: text('user_id').notNull(),
  event_type: text('event_type').notNull(),
  channel: text('channel').notNull(),  // 'email' | 'telegram' | 'teams' | 'websocket'
  enabled: boolean('enabled').default(true).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: unique('notification_prefs_user_event_channel_unique').on(
    t.user_id, t.event_type, t.channel,
  ),
}));

// E-4: action idempotency store — durable cache for agent-callable action
// invocations so retries across channels fold to a single execution.
// Composite primary key (user_id, key) — see migration 019. user_id is TEXT
// to match ActionContext.userId (declared `string`); the cache holds no FK
// joins to user-scoped rows, so the looser shape is sufficient.
export const actionIdempotency = pgTable(
  'action_idempotency',
  {
    user_id: text('user_id').notNull(),
    key: text('key').notNull(),
    value_json: jsonb('value_json').$type<unknown>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.key] }),
  }),
);

// E-13: agent session refresh tokens. Long-lived (30d) refresh credential
// the agent core exchanges for a short-lived FR access token. Service code
// (`services/agent-session.ts`) currently uses raw SQL via `Bun.sql` for
// rotation atomicity; this drizzle table mirrors migration
// `013_agent_sessions.sql` so future drizzle queries (admin UI listing,
// per-user revoke panel) can use the typed builder.
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: text('user_id').notNull(),
  refresh_token_hash: text('refresh_token_hash').notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
  replaced_by: uuid('replaced_by'),
  // Migration 097. Tenant resolved from the Keycloak token at issue time and
  // read back at refresh (which has no Keycloak context) to mint the access
  // token's `tenant_id` claim. NULL = pre-097 session; the invoke path falls
  // back to `getUserTenant`.
  tenant_id: uuid('tenant_id'),
});

// E-11 agent runtime sessions — per-(user, channel, thread) durable
// conversation state for the agent runtime. Distinct from `agentSessions`
// above (which is refresh-token rotation, E-13). See migration
// `025_agent_runtime_sessions.sql` for rationale.
//
// Plan 3 (`028_agent_runtime_sessions_messages.sql`) added `messages` (the
// LLM turn ledger persisted at every assistant-end) and `worker_name` (the
// worker_management worker driving this thread; per-project overrides land
// later without another migration).
export const agentRuntimeSessions = pgTable('agent_runtime_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull(),
  channel: text('channel').notNull(),
  thread_id: text('thread_id').notNull().default(''),
  state_json: jsonb('state_json').notNull().default({}),
  messages: jsonb('messages').notNull().default([]),
  worker_name: text('worker_name').notNull().default('fr-agent-default'),
  // Streams Frontend Removal plan, Task 1.2 (2026-05-04, migration 051).
  // Optional binding from thread → project. NULL = unbound (current state
  // for every existing thread). FK ON DELETE SET NULL so project deletion
  // doesn't cascade and orphan thread history. No consumer wired yet.
  project_id: uuid('project_id').references(() => projects.id, {
    onDelete: 'set null',
  }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// fr-agui SPEC §10.5 (P1c, migration 194) — append-only audit of agent
// proposals ('proposed') and of the human confirmations that executed them
// ('executed:<http status>', a request carrying X-Agent-Proposal-Id). project_id
// on every project-scoped row (SPEC §5.7 rule 5). input_hash = sha256 of the
// REDACTED input, never the input. No FK on project_id: an audit row outlives
// the project it names.
export const capabilityAudit = pgTable(
  'capability_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capability_id: text('capability_id'),
    proposal_id: text('proposal_id').notNull(),
    thread_id: text('thread_id'),
    user_id: text('user_id').notNull(),
    tenant_id: uuid('tenant_id'),
    project_id: uuid('project_id'),
    initiator: text('initiator').notNull(),
    input_hash: text('input_hash'),
    status: text('status').notNull(),
    correlation_id: text('correlation_id'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    proposal_idx: index('capability_audit_proposal_idx').on(t.proposal_id, t.user_id),
    project_ts_idx: index('capability_audit_project_ts_idx').on(t.project_id, t.ts),
  }),
);

// E-14: bridge slice — pre-approval staging row for promoting a tool output
// (coding analysis finding, KAG scrape failure, flagged artifact) to a
// Planka kanban card. Kept separate from `approvals` so that draft-editing
// states ('editing' | 'deduped') don't overload approval status semantics.
// On submit, `approval_id` links to a row in `approvals` created via the
// existing approval domain; `metadata.callback_path` carries the commit
// callback (callback_path is not first-class on approvals today).
export const cardDrafts = pgTable('card_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull(),
  drafter_id: uuid('drafter_id').notNull(),                 // user (or agent on behalf of user)
  initiator: text('initiator').notNull(),                    // 'user' | 'agent' | 'cron'
  producer: text('producer').notNull(),
  run_id: text('run_id').notNull(),
  output_id: text('output_id').notNull(),
  stable_id: text('stable_id').notNull(),                    // producer canonical key
  content_digest: text('content_digest').notNull(),          // sha256(normalized title+body)
  title: text('title').notNull(),
  body_md: text('body_md').notNull(),
  target_project_id: text('target_project_id'),
  target_board_id: text('target_board_id'),
  target_list_id: text('target_list_id'),
  assignee_user_id: uuid('assignee_user_id'),
  labels: text('labels').array().notNull().default([]),
  status: text('status').notNull().default('editing'),
  // 'editing' | 'submitted' | 'committed' | 'rejected' | 'deduped'
  approval_id: uuid('approval_id'),                          // FK to approvals, set on submit
  committed_card_id: text('committed_card_id'),              // Planka card id, set on commit
  dedup_of_card_id: text('dedup_of_card_id'),                // set if dedup'd to an existing card
  metadata: jsonb('metadata').$type<Record<string, any>>().notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// E-14: dedup index for the bridge. One row per
// `(project_id, producer, stable_id)` confirmed-committed Planka card. Used
// by `GET /tools/bridge/links` and on every list-outputs call so the UI can
// mark "already promoted". On commit we upsert via
// `ON CONFLICT (project_id, producer, stable_id) DO UPDATE`.
export const cardBridgeLinks = pgTable(
  'card_bridge_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id').notNull(),
    producer: text('producer').notNull(),
    stable_id: text('stable_id').notNull(),
    card_id: text('card_id').notNull(),                        // Planka card id
    run_id: text('run_id').notNull(),                          // last run that confirmed it
    content_digest: text('content_digest').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Mirrors the SQL `UNIQUE (project_id, producer, stable_id)` from
    // migration 014. Required by `dedup.ts::recordCommit` whose
    // `onConflictDoUpdate({ target: [project_id, producer, stable_id] })`
    // resolves to this constraint at runtime.
    bridge_link_unique: unique('card_bridge_links_unique').on(
      table.project_id,
      table.producer,
      table.stable_id,
    ),
  }),
);

// Slice 2026-04-24-n8n-observability-kanban-liveness — maps n8n-issued
// execution_id back to the fr (project, user, correlation) that triggered it.
// Written by `integrations/n8n.ts::triggerWorkflow()` before the webhook call.
// `counted_terminal` is the dedupe flag for `fr_n8n_executions_total`.
export const n8nExecutionMapping = pgTable('n8n_execution_mapping', {
  execution_id: text('execution_id').primaryKey(),
  workflow_id: text('workflow_id').notNull(),
  project_id: text('project_id').notNull(),
  user_id: text('user_id').notNull(),
  correlation_id: text('correlation_id').notNull(),
  initiated_via: text('initiated_via').notNull(),
  triggered_at: timestamp('triggered_at', { withTimezone: true }).defaultNow().notNull(),
  counted_terminal: boolean('counted_terminal').notNull().default(false),
  // fr#1322 (migration 145): tenant the run was triggered under. Nullable —
  // legacy rows stay NULL and are deliberately hidden on the customer path.
  tenant_id: text('tenant_id'),
});

// E-10: persistent in-app chat messages (inbound + outbound). Distinct from
// the ephemeral WebSocket push pipeline — rows here are durable history a
// user can scroll back through across sessions / devices.
export const inappMessages = pgTable('inapp_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull(),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  text: text('text').notNull(),
  correlation_id: text('correlation_id'),
  meta_json: jsonb('meta_json').$type<Record<string, unknown> | null>(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
},
  (t) => [
    check(
      'inapp_messages_direction_check',
      sql`${t.direction} IN ('inbound', 'outbound')`,
    ),
  ],
);

// Analytics rollups (Wave-3 slice — migration 022_analytics_rollups.sql).
// Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §8.1.
//
// Written by `workers/analytics-rollup.ts` every 5 minutes; read by
// `routes/tools/analytics.ts`. Routes never query Prometheus directly.
export const analyticsRollups = pgTable('analytics_rollups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull(),
  project_id: uuid('project_id'),
  user_id: uuid('user_id'),
  bucket_ts: timestamp('bucket_ts', { withTimezone: true }).notNull(),
  bucket_size: text('bucket_size').notNull(), // '5m' | '1h' | '1d' | '1w'
  metric_name: text('metric_name').notNull(),
  initiator: text('initiator').notNull().default('unknown'),
  channel: text('channel').notNull().default('unknown'),
  value: numeric('value').notNull(),
  dimensions: jsonb('dimensions').$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// One-row-per-tick worker bookkeeping. Drives the page's `stale` flag and
// the `fr_analytics_rollup_last_success_seconds` Prom gauge.
export const analyticsRollupMeta = pgTable('analytics_rollup_meta', {
  tick_name: text('tick_name').primaryKey(),
  last_success: timestamp('last_success', { withTimezone: true }),
  last_outcome: text('last_outcome'),
  last_error: text('last_error'),
  metrics_written: integer('metrics_written').notNull().default(0),
  prom_queries: integer('prom_queries').notNull().default(0),
  // Migration 115 — drop accounting. `prom_queries` counts queries ISSUED and
  // `metrics_written` counts rows that survived every filter; without the
  // columns below, "wrote nothing because Prometheus returned nothing" and
  // "wrote nothing because every sample was refused" are the SAME row
  // (`ok / metrics_written = 0`), which is how a worker that had never written
  // a row read healthy for its entire life (issue #1027).
  //
  // Invariant when `last_error IS NULL` (no upsert consumed a sample by
  // raising):
  //   prom_series = metrics_written + rows_dropped_no_tenant
  //                                 + rows_dropped_bad_value
  //
  // NULLABLE ON PURPOSE, and the NULL is load-bearing: NULL = NOT MEASURED
  // (tick predates the instrumentation), 0 = MEASURED ZERO. Defaulting these
  // to 0 like their two neighbours would have made the pre-115 row assert
  // `prom_series = 0` — i.e. fabricate the exact "Prometheus returned nothing"
  // conclusion the operator is trying to reach. Never render a NULL as 0.
  /** Series Prometheus actually returned, summed over the queries that succeeded. */
  prom_series: integer('prom_series'),
  /** Samples refused for a missing `tenant_id` (spec §6.2). Dropped, not written. */
  rows_dropped_no_tenant: integer('rows_dropped_no_tenant'),
  /** Samples refused for a non-finite `value`. Dropped, not written. */
  rows_dropped_bad_value: integer('rows_dropped_bad_value'),
  /**
   * Rows WRITTEN with `initiator='unknown'` because the series carried no
   * initiator label. A degradation counter, not a loss counter — these rows
   * are already inside `metrics_written`, so this is not a term of the
   * invariant above.
   */
  unknown_initiator_rows: integer('unknown_initiator_rows'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Migration 218 (fr #1683) — an agent product's own service member of a tenant: a
// synthetic version-8 UUID principal (no Keycloak user, no login) that acts
// over the `mcp` channel from the admin-created address `agent:<tenant>[:<product>]`
// as fr's autonomous user: agent decisions are allowed and recorded as
// decided_by_kind='agent'. See src/domain/engagement/agent-members.ts.
export const agentMembers = pgTable(
  'agent_members',
  {
    user_id: text('user_id').primaryKey(),
    tenant_id: uuid('tenant_id').notNull(),
    product: text('product').notNull(),
    address: text('address').notNull().unique(),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantProductUnique: unique('agent_members_tenant_product_unique').on(table.tenant_id, table.product),
    userIdShape: check('agent_members_user_id_check', sql`${table.user_id} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
    productShape: check('agent_members_product_check', sql`${table.product} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
    addressShape: check('agent_members_address_check', sql`${table.address} LIKE 'agent:%'`),
  }),
);

// User roles (migration 023). Replaces the tactical `FR_ADMIN_USER_IDS`
// env-var allowlist that previously gated the admin path on
// `routes/engagements/deliveries.ts`. The table is intentionally narrow:
//   - `user_id` is TEXT to match the Keycloak `sub` claim shape (uuid in
//     practice today, but Keycloak doesn't promise that across federation
//     providers).
//   - `tenant_id` is UUID — every other tenanted table here uses uuid.
//   - `role` is TEXT, constrained by migration 104's CHECK to
//     'workspace-admin' | 'workspace-member' (a CHECK, not an enum, so a
//     future role is a one-statement ALTER).
//   - `granted_by` is the user id of the granter ('system' for the env-var
//     bootstrap fallback). Nullable for self-grants / migrations.
//   - Unique on (user_id, tenant_id, role) so re-grants are upserts not dupes.
//   - `(tenant_id, role)` index supports the "list all admins for a tenant"
//     query used by the admin endpoint.
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: text('user_id').notNull(),
    tenant_id: uuid('tenant_id').notNull(),
    // tenant_name is the legible display string for `tenant_id` — see
    // migration 024 and src/utils/tenant.ts. Nullable: legacy rows + the
    // bootstrap tenant don't carry one.
    tenant_name: text('tenant_name'),
    // Constrained in the DATABASE by `user_roles_role_check` (migration 104) to
    // exactly 'workspace-admin' | 'workspace-member'. ⚠️ CORRECTED 2026-09-06 —
    // this said "Drizzle has no CHECK primitive here". It has one (`check`,
    // imported above, used 25 times in this file); the constraint simply is not
    // declared. ⛔ DO NOT DECLARE IT WITHOUT READING migration-runner.ts's 104
    // entry first: that migration's probe is `constraintExists(user_roles,
    // user_roles_role_check)`, so declaring it here makes `drizzle-kit push`
    // create it, the probe pass vacuously, and 104 stamped applied on a CI
    // database where its DELETE never ran. Move the probe onto 104's data effect
    // in the same commit, the way 113's is. Before 104 the column was wholly
    // unconstrained and held one `admin` row (a nil-UUID AUTH_BYPASS seed
    // artifact), which is the only reason `role = 'admin'` ever looked like a
    // real value. Do not widen this back without deciding what the new value
    // means to services/user-roles.ts.
    role: text('role').notNull(),
    granted_at: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    granted_by: text('granted_by'),
  },
  (t) => ({
    uniq_user_tenant_role: unique('uniq_user_roles_user_tenant_role').on(
      t.user_id,
      t.tenant_id,
      t.role,
    ),
  }),
);

// Foundation Plan 2 — workspaces (org root). The `id` is the same UUID as
// the tenant_id used elsewhere; backfill in migration 029 seeds one row per
// distinct tenant_id seen in user_roles. No `tenant_id` column here — the
// workspace IS the tenant.
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archived_at: timestamp('archived_at', { withTimezone: true }),
});

// Migration 065 — singleton row holding the global andon-cord state.
// One row, enforced at the DB level by `id = 1` PK + CHECK.
export const andonState = pgTable('andon_state', {
  id: integer('id').primaryKey().default(1),
  engaged: boolean('engaged').notNull().default(false),
  engaged_at: timestamp('engaged_at', { withTimezone: true }),
  engaged_by: text('engaged_by'),
  // Migration 226 — the cord's ACTUATOR is `n8n/n8n-worker` replicas (0 engaged,
  // 1 released), not a set of deactivated workflows. `worker_replicas` is the
  // value READ BACK from the API server after the last attempt: NULL = NOT
  // MEASURED, which is never the same fact as 0. `worker_scale_error` is that
  // attempt's failure summary; `worker_scaled_at` is when it ran (on a release it
  // means "the scale-up ran at", exactly as it meant "the pause ran at" before).
  worker_replicas: integer('worker_replicas'),
  worker_scaled_at: timestamp('worker_scaled_at', { withTimezone: true }),
  worker_scale_error: text('worker_scale_error'),
  // Migration 225 — the kata projects holding the conveyor n8n instance (George 2026-11-03).
  // The worker returns to 1 only when this is empty AND `engaged` is false (routes/andon.ts);
  // a kata never touches `engaged` (the operator's cord).
  kata_holders: uuid('kata_holders').array().notNull().default(sql`'{}'::uuid[]`),
}, (t) => ({
  // Migration 065 declares the singleton via an INLINE column check
  // (`id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`), which Postgres
  // auto-names `andon_state_id_check`. drizzle-kit push does NOT emit
  // that CHECK from `.default(1)` alone, so a CI-shaped (push-bootstrapped)
  // DB would accept id != 1 rows prod rejects — silently breaking the
  // "exactly one global cord state" invariant the whole feature relies on.
  // Table-level check() with the migration's auto-generated name closes
  // the CI↔prod parity gap. Same object, byte-identical pg_get_constraintdef.
  singleton: check('andon_state_id_check', sql`${t.id} = 1`),
}));

// Migration 229 — the kata record (docs/design/kata-super-admin.md §3b + the kata build
// contract). id = the kata project's fr id (a project of the `kata` tenant, migration 228).
// The kata's id is in andon_state.kata_holders EXACTLY while state ∈ (running, qa):
// services/katas enforces it per transition, in one transaction, and accrues
// cord_held_seconds from cord_engaged_at on every release.
export const KATA_STATES = ['running', 'qa', 'published', 'closed', 'failed', 'rolled_back'] as const;
export type KataState = (typeof KATA_STATES)[number];

/** One card blocked on the kata's signature; `rerun_at` once the kata re-pulled it. */
export interface KataLinkedCard {
  card_id: string;
  board_id: string | null;
  phase: string | null;
  linked_at: string;
  rerun_at?: string;
}

export const katas = pgTable(
  'katas',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source_project_id: uuid('source_project_id').notNull(),
    source_tenant_id: uuid('source_tenant_id').notNull(),
    source_card_id: text('source_card_id'),
    source_execution_id: text('source_execution_id'),
    source_board_id: text('source_board_id'),
    source_phase: text('source_phase'),
    symptom: text('symptom').notNull(),
    // 'coach' | 'super_admin:<sub>'
    opened_by: text('opened_by').notNull(),
    // Immutable once set (migration 231: NOT NULL; PATCH refuses a change).
    signature: text('signature').notNull(),
    root_cause_class: text('root_cause_class'),
    target_flow: text('target_flow'),
    target_flow_id: text('target_flow_id'),
    base_version_id: text('base_version_id'),
    published_version_id: text('published_version_id'),
    state: text('state', { enum: KATA_STATES }).notNull(),
    state_detail: text('state_detail'),
    replay_passed: integer('replay_passed'),
    replay_total: integer('replay_total'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ops: jsonb('ops'),
    replays: jsonb('replays'),
    linked_cards: jsonb('linked_cards').$type<KataLinkedCard[]>().notNull().default(sql`'[]'::jsonb`),
    kata_board_id: text('kata_board_id'),
    kata_card_id: text('kata_card_id'),
    // When the first card reached READY (services/katas/open.ts). NULL past a grace on a running
    // kata = a dead open (services/katas/core.ts decideOpen → 'stale').
    card_ready_at: timestamp('card_ready_at', { withTimezone: true }),
    opened_at: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    qa_at: timestamp('qa_at', { withTimezone: true }),
    published_at: timestamp('published_at', { withTimezone: true }),
    closed_at: timestamp('closed_at', { withTimezone: true }),
    failed_at: timestamp('failed_at', { withTimezone: true }),
    rollback_requested_at: timestamp('rollback_requested_at', { withTimezone: true }),
    // When kata-n8n ACCEPTED the `kata.rollback` webhook for this request. NULL while a requested
    // rollback has not been delivered, so a later coach repeat (or Rollback click) resends it.
    rollback_delivered_at: timestamp('rollback_delivered_at', { withTimezone: true }),
    rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
    // Migration 231: a coach repeat whose rollback the guard refused (no base / superseded).
    rollback_refused_at: timestamp('rollback_refused_at', { withTimezone: true }),
    rollback_refused_reason: text('rollback_refused_reason'),
    cord_engaged_at: timestamp('cord_engaged_at', { withTimezone: true }),
    cord_held_seconds: integer('cord_held_seconds').notNull().default(0),
    // Migration 231 (George 2026-11-04): a FAILED kata keeps the cord until a super-admin
    // releases it (POST /api/katas/:id/release) — who and when.
    cord_released_at: timestamp('cord_released_at', { withTimezone: true }),
    cord_released_by: text('cord_released_by'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stateCheck: check(
      'katas_state_check',
      sql`${t.state} IN ('running', 'qa', 'published', 'closed', 'failed', 'rolled_back')`,
    ),
    // K1: one open kata per signature.
    openSignatureUnique: uniqueIndex('katas_open_signature_unique')
      .on(t.signature)
      .where(sql`state IN ('running', 'qa', 'published')`),
    openedAtIdx: index('katas_opened_at_idx').on(t.opened_at.desc()),
    sourceProjectIdx: index('katas_source_project_idx').on(t.source_project_id),
  }),
);

// Migration 065 — append-only history of global andon flips, populated
// by AFTER UPDATE trigger on andon_state.engaged.
export const andonStateHistory = pgTable('andon_state_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  engaged: boolean('engaged').notNull(),
  changed_at: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  changed_by: text('changed_by'),
});

// Foundation Plan 2 — departments inside a workspace. `is_default = true`
// marks the auto-created landing department; the partial unique index
// `departments_one_default_per_workspace` enforces at most one default per
// workspace. `default_landing` is independent and may move between depts.
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    is_default: boolean('is_default').notNull().default(false),
    default_landing: boolean('default_landing').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    uq_name: unique().on(t.workspace_id, t.name),
    // Partial unique index: at most one default department per workspace.
    // Mirrors `departments_one_default_per_workspace` in migration 026.
    // CI uses `drizzle-kit push` to bootstrap the test schema, so without
    // this declaration the partial unique would not exist on the test DB
    // and `setDefaultDepartment` couldn't enforce single-default invariant.
    uq_default: uniqueIndex('departments_one_default_per_workspace')
      .on(t.workspace_id)
      .where(sql`${t.is_default} = true`),
  }),
);

// Foundation Plan 2 — Task 3: per-department role assignments.
export const departmentMembers = pgTable(
  'department_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dept_id: uuid('dept_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    role: text('role').notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq_member: unique().on(t.dept_id, t.user_id),
    role_check: check(
      'department_members_role_check',
      sql`${t.role} IN ('dept-admin', 'dept-manager', 'dept-member', 'dept-viewer')`,
    ),
  }),
);

export type DeptRole = 'dept-admin' | 'dept-manager' | 'dept-member' | 'dept-viewer';

// Foundation Plan 2 — Task 4: unified scope-assignment table for Library
// effective-set logic (Spec 1 §6.2). pgEnums mirror the SQL types declared
// in migration 028.
export const assetType = pgEnum('asset_type', [
  'requirement',
  'principle',
  'decision',
  'kag_document',
  'workflow',
  'trigger',
  'artifact',
  'channel',
]);

export const assignmentScope = pgEnum('assignment_scope', ['workspace', 'department', 'project']);

export const linkKind = pgEnum('link_kind', ['owns', 'override', 'block']);

export const assetAssignments = pgTable(
  'asset_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    asset_type: assetType('asset_type').notNull(),
    /**
     * `asset_id` is `text` rather than `uuid` so non-uuid asset ids
     * (e.g. n8n workflow string ids, channel slugs) can join. Routes that feed
     * this column string-coerce upstream ids via `applyEffectiveFilter`
     * (see src/routes/assets/_lib/effective-query.ts). Migration
     * 031_relax_asset_assignments_asset_id_to_text.sql performs the
     * column relaxation.
     */
    asset_id: text('asset_id').notNull(),
    scope_kind: assignmentScope('scope_kind').notNull(),
    target_id: uuid('target_id'),
    link_kind: linkKind('link_kind').notNull(),
    overrides_id: uuid('overrides_id'),
    effective_at: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    assigned_by: text('assigned_by').notNull(),
  },
  (t) => ({
    // Partial unique indexes, created by migration 030 and RE-KEYED ON THE
    // TENANT by migration 111. Two are required because Postgres treats NULLs
    // as distinct: a single UNIQUE over (workspace_id, asset_type, asset_id,
    // scope_kind, target_id) would not constrain the workspace-scope rows
    // (target_id IS NULL) at all.
    //
    // ⛔ `workspace_id` MUST stay in both keys. It is fr's tenant key. Without
    // it (the shape 030 shipped) an assignment row is unique GLOBALLY across
    // every tenant, and because the only writer — upsertOwns / upsertOwnsMany
    // in services/asset-assignments.ts — uses a BARE `.onConflictDoNothing()`
    // with no target, the second tenant's insert is DISCARDED and the statement
    // still returns success. Upstream ids (n8n workflow ids) are
    // process-global and identical for every tenant, so the first workspace to
    // list an asset type claimed the whole catalogue. MEASURED on prod before
    // 111: 2,288 workspace-scope rows over 2,288 DISTINCT asset_ids — zero
    // shared by two tenants — with one tenant holding 259 of 273 workflows.
    // `effectiveAssetIds` builds ADDITIVELY from this table, so the losing
    // tenants were answered 200 with a short list and no error anywhere.
    //
    // `workspace_id` leads because every read here (effectiveAssetIds,
    // listAssignmentsByScope, findParentOwnsId, the assignments list route)
    // filters on it first.
    uq_with_target: uniqueIndex('asset_assignments_uq_with_target')
      .on(t.workspace_id, t.asset_type, t.asset_id, t.scope_kind, t.target_id)
      .where(sql`${t.target_id} IS NOT NULL`),
    uq_workspace: uniqueIndex('asset_assignments_uq_workspace')
      .on(t.workspace_id, t.asset_type, t.asset_id, t.scope_kind)
      .where(sql`${t.target_id} IS NULL`),
    // Channels are workspace- or department-scoped only; never project-
    // scoped (Spec 1 §6.5). Enforced at the DB so the constraint can't
    // drift from prose. Mirrors the CHECK in migration 028.
    channel_not_project: check(
      'asset_assignments_channel_not_project_check',
      sql`${t.asset_type} <> 'channel' OR ${t.scope_kind} IN ('workspace', 'department')`,
    ),
    // override_overrides_id_check: only override-kind rows may carry an
    // overrides_id; owns/block must have it null.
    override_link: check(
      'asset_assignments_override_overrides_id_check',
      sql`(${t.link_kind} = 'override') = (${t.overrides_id} IS NOT NULL)`,
    ),
  }),
);

// Migration 067 — project-scoped asset bindings. Many-to-many between any
// asset kind (assetType enum) and projects. Bindings are the authoritative
// project-scope source for automation (n8n only sees explicitly-bound
// assets). Empty-bindings rows are tenant-wide and out of scope for n8n.
// asset_id is text to mirror asset_assignments (non-uuid upstream ids).
export const assetBindings = pgTable(
  'asset_bindings',
  {
    asset_kind: assetType('asset_kind').notNull(),
    asset_id: text('asset_id').notNull(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    bound_at: timestamp('bound_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    bound_by_user_id: text('bound_by_user_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.asset_kind, t.asset_id, t.project_id] }),
    project_idx: index('asset_bindings_project_id_idx').on(t.project_id),
    asset_idx: index('asset_bindings_asset_idx').on(t.asset_kind, t.asset_id),
  }),
);

// fr-agui P2 / OQ-16 (migration 196) — the claim + journal of one in-progress
// project-asset copy-on-write (`project_assets.edit`). One row per (project,
// kind, original) while the copy is being made; deleted on completion. See
// services/project-asset-copy-intents.ts.
export const projectAssetCopyIntents = pgTable(
  'project_asset_copy_intents',
  {
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    asset_kind: assetType('asset_kind').notNull(),
    original_id: text('original_id').notNull(),
    workspace_id: uuid('workspace_id').notNull(),
    copy_id: text('copy_id'),
    copy_ref: text('copy_ref'),
    copy_changes_key: text('copy_changes_key'),
    copy_create_started_at: timestamp('copy_create_started_at', { withTimezone: true }),
    claim_token: uuid('claim_token'),
    claimed_by: text('claimed_by').notNull(),
    claimed_at: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'project_asset_copy_intents_pk', columns: [t.project_id, t.asset_kind, t.original_id] }),
  }),
);

// R311 PR 5 (migration 199; n8n-workflows design/choices/v4/kanban-coach-errors.md
// §2.5) — one row per conveyor start fr sent (or tried to send) for a project.
// `attempt_n` = the number of earlier attempts recorded for the project: 0 keeps
// the bare Idempotency-Key `<fr id>`, n >= 1 sends `<fr id>:retry-<n>`. See
// services/conveyor-failures.ts.
// 'refused' (migration 203, U1): the conveyor answered 409 {code} — a start it can
// never accept; outcome_detail holds the code.
export const CONVEYOR_START_OUTCOMES = ['pending', 'delivered', 'failed', 'board_link_failed', 'inert', 'refused'] as const;
export type ConveyorStartOutcomeName = (typeof CONVEYOR_START_OUTCOMES)[number];
export const projectConveyorStartAttempts = pgTable(
  'project_conveyor_start_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id').notNull(),
    attempt_n: integer('attempt_n').notNull(),
    idempotency_key: text('idempotency_key').notNull(),
    requested_by: text('requested_by'),
    outcome: text('outcome', { enum: CONVEYOR_START_OUTCOMES }).notNull().default('pending'),
    outcome_detail: text('outcome_detail'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    project_n_key: uniqueIndex('project_conveyor_start_attempts_project_n_key').on(t.project_id, t.attempt_n),
    key_key: uniqueIndex('project_conveyor_start_attempts_key_key').on(t.idempotency_key),
    attempt_n_check: check('project_conveyor_start_attempts_attempt_n_check', sql`${t.attempt_n} >= 0`),
    outcome_check: check(
      'project_conveyor_start_attempts_outcome_check',
      sql`${t.outcome} IN ('pending', 'delivered', 'failed', 'board_link_failed', 'inert', 'refused')`,
    ),
  }),
);

// R311 PR 5 (migration 199; kanban-coach-errors.md §2.5 / §4.1) — the n8n
// `project.start_failed` / `project.coach_failed` notices, append-only. Idempotent
// on (project_id, execution_id) for a start failure and (tenant_id, execution_id)
// — the coach's execution id — for a coach failure.
// Migration 207 (R318 F1): 'move_stale', 'move_reverted', 'andon_unreadable' — idempotent on
// (tenant_id, kind, idempotency_key), the caller's notice key.
export const CONVEYOR_FAILURE_KINDS = ['start_failed', 'coach_failed', 'move_stale', 'move_reverted', 'andon_unreadable'] as const;
export type ConveyorFailureKind = (typeof CONVEYOR_FAILURE_KINDS)[number];
export const projectConveyorFailures = pgTable(
  'project_conveyor_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Migration 234: NULL = an unattached coach_failed notice (only an RM id was sent and RM could
    // not resolve it); the raw ids stay in rm_project_id / card_id.
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id').notNull(),
    kind: text('kind', { enum: CONVEYOR_FAILURE_KINDS }).notNull(),
    execution_id: text('execution_id').notNull(),
    idempotency_key: text('idempotency_key'),
    rm_project_id: text('rm_project_id'),
    card_id: text('card_id'),
    flow: text('flow'),
    node: text('node'),
    error_class: text('error_class'),
    error_text: text('error_text').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Migration 208: an `andon_unreadable` notice a member resumed (the conveyor accepted the
    // resume). Set once, compare-and-set on NULL; NULL on every other kind.
    resumed_at: timestamp('resumed_at', { withTimezone: true }),
    resumed_by: text('resumed_by'),
  },
  (t) => ({
    start_key: uniqueIndex('project_conveyor_failures_start_key')
      .on(t.project_id, t.execution_id)
      .where(sql`${t.kind} = 'start_failed'`),
    coach_key: uniqueIndex('project_conveyor_failures_coach_key')
      .on(t.tenant_id, t.execution_id)
      .where(sql`${t.kind} = 'coach_failed'`),
    notice_key: uniqueIndex('project_conveyor_failures_notice_key')
      .on(t.tenant_id, t.kind, t.idempotency_key)
      .where(sql`${t.kind} IN ('move_stale', 'move_reverted', 'andon_unreadable')`),
    project_created_idx: index('project_conveyor_failures_project_created_idx').on(t.project_id, t.created_at),
    kind_check: check(
      'project_conveyor_failures_kind_check',
      sql`${t.kind} IN ('start_failed', 'coach_failed', 'move_stale', 'move_reverted', 'andon_unreadable')`,
    ),
  }),
);

// Migration 213 (cockpit A5 / R-CK5) — one row per n8n execution, written by the n8n-custom
// execution hook through `POST /api/internal/conveyor/flow-runs` (services/conveyor-flow-runs.ts).
// Upserted on `execution_id`: the hook fires again when a waiting execution resumes. A
// `running`/`waiting` record never overwrites a terminal status that arrived first.
// `project_ref` is stored as received (an fr project id or an RM pm_project id); `project_id`
// and `tenant_id` are fr's resolution of it (null when it did not resolve to exactly one project).
export const CONVEYOR_FLOW_RUN_STATUSES = ['running', 'success', 'error', 'waiting', 'canceled', 'crashed'] as const;
export type ConveyorFlowRunStatus = (typeof CONVEYOR_FLOW_RUN_STATUSES)[number];
export const CONVEYOR_FLOW_RUN_TERMINAL_STATUSES = ['success', 'error', 'canceled', 'crashed'] as const;
export const conveyorFlowRuns = pgTable(
  'conveyor_flow_runs',
  {
    execution_id: text('execution_id').primaryKey(),
    workflow_id: text('workflow_id'),
    workflow_name: text('workflow_name'),
    card_id: text('card_id'),
    project_ref: text('project_ref'),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    tenant_id: uuid('tenant_id'),
    status: text('status', { enum: CONVEYOR_FLOW_RUN_STATUSES }).notNull(),
    /** Migration 214: n8n's own final status (a flow_error / agent_failed run is `status` error, n8n success). */
    n8n_status: text('n8n_status'),
    started_at: timestamp('started_at', { withTimezone: true }),
    stopped_at: timestamp('stopped_at', { withTimezone: true }),
    failed_node: text('failed_node'),
    error_class: text('error_class'),
    error_message: text('error_message'),
    retry_of: text('retry_of'),
    parent_execution_id: text('parent_execution_id'),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    project_started_idx: index('conveyor_flow_runs_project_started_idx').on(t.project_id, t.started_at.desc()),
    card_started_idx: index('conveyor_flow_runs_card_started_idx').on(t.card_id, t.started_at.desc()),
    status_check: check(
      'conveyor_flow_runs_status_check',
      sql`${t.status} IN ('running', 'success', 'error', 'waiting', 'canceled', 'crashed')`,
    ),
  }),
);
export type ConveyorFlowRunRow = typeof conveyorFlowRuns.$inferSelect;

// Early-access signup v2 (migration 202, services/signup/*). One row per access request (website
// intake or super_admin invite); see the migration header for every column's contract.
// 'removed' (migration 210): an approved signup a super_admin removed (services/signup/removal.ts).
export const SIGNUP_STATUSES = ['pending', 'approved', 'rejected', 'removed'] as const;
export const signupApprovals = pgTable(
  'signup_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    company: text('company'),
    message: text('message'),
    locale: text('locale'),
    source: text('source', { enum: ['web', 'chat', 'invite'] }).notNull(),
    intake_client: text('intake_client'),
    status: text('status', { enum: SIGNUP_STATUSES }).notNull().default('pending'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    decided_by: text('decided_by'),
    decided_via: text('decided_via', { enum: ['onboarding', 'telegram'] }),
    decider_actor: text('decider_actor'),
    approving_until: timestamp('approving_until', { withTimezone: true }),
    approving_claim: uuid('approving_claim'),
    tenant_name: text('tenant_name'),
    tenant_slug: text('tenant_slug'),
    tenant_id: uuid('tenant_id'),
    tenant_attempts: jsonb('tenant_attempts').$type<Record<string, unknown>>().notNull().default({}),
    kc_user_id: uuid('kc_user_id'),
    identity_minted: boolean('identity_minted').notNull().default(false),
    steps: jsonb('steps').$type<Record<string, unknown>>().notNull().default({}),
    steps_lease_until: timestamp('steps_lease_until', { withTimezone: true }),
    steps_lease_token: uuid('steps_lease_token'),
    steps_next_attempt_at: timestamp('steps_next_attempt_at', { withTimezone: true }),
    steps_attempts: integer('steps_attempts').notNull().default(0),
    reject_repair: jsonb('reject_repair').$type<Record<string, unknown>>(),
    // Migration 210: the early-access removal's record (NULL until a super_admin removes the row).
    removal: jsonb('removal').$type<Record<string, unknown>>(),
  },
  (t) => ({
    pending_email: uniqueIndex('signup_approvals_pending_email')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.status} = 'pending'`),
    tenant_slug_key: uniqueIndex('signup_approvals_tenant_slug_key')
      .on(t.tenant_slug)
      .where(sql`${t.tenant_slug} IS NOT NULL`),
    status_created_idx: index('signup_approvals_status_created_idx').on(t.status, t.created_at),
    steps_due_idx: index('signup_approvals_steps_due_idx')
      .on(t.steps_next_attempt_at)
      .where(sql`${t.steps_next_attempt_at} IS NOT NULL`),
    reject_repair_state_idx: index('signup_approvals_reject_repair_state_idx')
      .on(sql`(${t.reject_repair}->>'state')`)
      .where(sql`${t.reject_repair} IS NOT NULL`),
    removal_state_idx: index('signup_approvals_removal_state_idx')
      .on(sql`(${t.removal}->>'state')`)
      .where(sql`${t.removal} IS NOT NULL`),
    message_check: check('signup_approvals_message_check', sql`${t.message} IS NULL OR char_length(${t.message}) <= 2000`),
    locale_check: check(
      'signup_approvals_locale_check',
      sql`${t.locale} IS NULL OR ${t.locale} IN ('ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl')`,
    ),
    source_check: check('signup_approvals_source_check', sql`${t.source} IN ('web', 'chat', 'invite')`),
    status_check: check('signup_approvals_status_check', sql`${t.status} IN ('pending', 'approved', 'rejected', 'removed')`),
    decided_via_check: check(
      'signup_approvals_decided_via_check',
      sql`${t.decided_via} IS NULL OR ${t.decided_via} IN ('onboarding', 'telegram')`,
    ),
    tenant_slug_check: check(
      'signup_approvals_tenant_slug_check',
      sql`${t.tenant_slug} IS NULL OR ${t.tenant_slug} ~ '^[a-z0-9-]{2,40}$'`,
    ),
    steps_attempts_check: check('signup_approvals_steps_attempts_check', sql`${t.steps_attempts} >= 0`),
  }),
);

// Foundation Plan 2 follow-up — channels registry. See migration
// 030_channels_registry.sql for the full design. Channels are
// workspace-scoped (`dept_id` = NULL) or department-scoped (`dept_id` set);
// per Spec 1 §6.5 they're NEVER project-scoped. `credentials_enc` is
// write-only: the route layer redacts it on every GET response.
export const channelKind = pgEnum('channel_kind', [
  'teams',
  'email',
  'web',
  'inapp',
  'voice',
]);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dept_id: uuid('dept_id').references(() => departments.id, {
      onDelete: 'cascade',
    }),
    kind: channelKind('kind').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    credentials_enc: text('credentials_enc'),
    // bound_assets origin columns (migration 069). Mirrors scheduled_triggers
    // (migration 068) and the upstream services. Channels are never
    // project-scoped (Spec 1 §6.5), so origin_kind is 'tenant' or 'workflow'.
    origin_kind: text('origin_kind').notNull().default('tenant'),
    origin_project_id: uuid('origin_project_id'),
    origin_workflow_run_id: text('origin_workflow_run_id'),
    created_by_user_id: text('created_by_user_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    uq_workspace_name: unique('channels_workspace_name_unique').on(
      t.workspace_id,
      t.name,
    ),
    // Prod enforces this; CI did not.
    origin_kind_check: check(
      'channels_origin_kind_check',
      sql`${t.origin_kind} IN ('tenant', 'workflow')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Improvement-stream registry (parallel session, migration 026). A stream
// is a tenant-owned bundle of similar assets (workflows OR prompts) sharing
// one Planka improvement board, threshold rules, an optional eval set, and
// an optional owning department.
// ---------------------------------------------------------------------------
export const streams = pgTable(
  'streams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    kind: streamKindEnum('kind').notNull(),
    name: text('name').notNull(),
    // Streams Frontend Removal plan, Task 1.1 (migration 050). Stable
    // per-tenant identifier so n8n aggregator credentials can resolve the
    // two baseline system streams by name instead of UUID.
    slug: text('slug').notNull(),
    // TEXT (not UUID) to mirror the existing projects.planka_project_id
    // convention — Planka returns string ids end-to-end.
    planka_project_id: text('planka_project_id').notNull(),
    planka_board_id: text('planka_board_id').notNull(),
    threshold_rules: jsonb('threshold_rules')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    eval_set_id: uuid('eval_set_id'),
    owner_dept_id: uuid('owner_dept_id'),
    // Migration 120. The fr PROJECT whose repository this stream's improvement
    // work targets — read by the stream detector and passed as the minted card's
    // project_id, from which done-finalize resolves repository_url via
    // GET /api/projects/{id}.
    // NULLable because no existing row has an answer to backfill from (measured
    // 2026-09-13: all 18 live rows) and a fabricated pairing is the same class of
    // defect as the 508 unresolvable cards this closes. A stream with NULL here is
    // still evaluated; it simply cannot mint a card — the detector refuses at the
    // mint site, naming the stream.
    // ⚠️ NOT planka_project_id above: that is a TEXT Planka board-container id with
    // no foreign key, and it 404s against /api/projects exactly as the tenant id did.
    // ⛔ Adding it here is necessary but NOT sufficient — routes/assets/streams.ts
    // :: shapeStream is a hand-written serializer that already silently drops `slug`
    // and the andon_* columns, and it is the detector's last gate.
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    min_significance_n: integer('min_significance_n').notNull().default(30),
    is_active: boolean('is_active').notNull().default(true),
    // Plan 4 Lane F — opt-out flag. TRUE = arm auto-rollback monitor with a
    // real observation window; FALSE = caller (Plan 5/6 n8n subflow) skips
    // canary observation. fr-backend stores; n8n enforces. Migration 027.
    canary_enabled: boolean('canary_enabled').notNull().default(true),
    // Plan 5 Stage 1.4 (migration 040). Per-stream notification fan-out
    // config. Array of { kind, target, on: ('design'|'release'|'rollback'|
    // 'canary'|'done')[] }. CHECK constraint guarantees the column is a JSON array;
    // per-entry shape is validated in the application layer (see
    // routes/assets/streams.ts).
    notification_channels: jsonb('notification_channels')
      .$type<StreamNotificationChannel[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Andon-cord (migration 050b). When true, the (currently disabled)
    // improvement n8n loops + every automated tick that touches this
    // stream pre-flight-skips. Improvement streams default-engage on
    // insert via the trg_streams_default_engage_andon trigger.
    andon_engaged: boolean('andon_engaged').notNull().default(false),
    andon_engaged_at: timestamp('andon_engaged_at', { withTimezone: true }),
    andon_engaged_by: text('andon_engaged_by'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Migration 050. Enforces the slug invariant per tenant — two streams
    // under the same tenant cannot share a slug, but the same slug can
    // appear across different tenants.
    tenantSlugUniq: uniqueIndex('streams_tenant_slug_uniq').on(
      t.tenant_id,
      t.slug,
    ),
    // Kind pin. LINEAGE: 038 → 060 → 062 → 066 → 230. The CURRENT prod form
    // is migration 230: the workflow / prompt / procedure kinds were pinned
    // to the three v3 improvement tenants, which 230 deleted (2026-11-03), so
    // only the three asset kinds (principle/requirement/decision) remain, on
    // any tenant. Compares kind::text against string literals (not enum
    // literals) exactly as the migration does; expression copied verbatim
    // from 230 so push and migration land the same pg_get_constraintdef.
    kindTenantCheck: check(
      'streams_kind_tenant_check',
      sql`(${t.kind}::text = 'principle')
        OR (${t.kind}::text = 'requirement')
        OR (${t.kind}::text = 'decision')`,
    ),
    // Migration 044. A write-time shape guard: notification_channels must be
    // a JSON array (per-entry shape validated in the app layer via zod).
    // drizzle-kit push emits the jsonb column + default but NOT the CHECK, so
    // a push-bootstrapped CI DB would accept a non-array object/scalar prod
    // rejects. Table-level check() with the migration's constraint name.
    notificationChannelsIsArray: check(
      'streams_notification_channels_is_array',
      sql`jsonb_typeof(${t.notification_channels}) = 'array'`,
    ),
  }),
);

// Plan 5 Stage 1.4 — notification-channel entry shape on `streams`.
// Lives next to the table so route + repository code shares the type.
export type StreamNotificationChannelKind = 'teams' | 'email' | 'inapp';
// 'canary' (WS-3) — the workflow-canary cockpit action (Extend / Rollback)
// raised as kind='improvement.canary_action'. A dedicated event so stream
// channels can subscribe to canary lifecycle actions distinctly from the
// post-hoc auto 'rollback' event.
export type StreamNotificationEvent = 'design' | 'release' | 'rollback' | 'canary' | 'done';
export interface StreamNotificationChannel {
  kind: StreamNotificationChannelKind;
  target: string;
  on: StreamNotificationEvent[];
}

export const assetStreamMembership = pgTable(
  'asset_stream_membership',
  {
    asset_kind: assetKindEnum('asset_kind').notNull(),
    asset_id: uuid('asset_id').notNull(),
    stream_id: uuid('stream_id')
      .notNull()
      .references(() => streams.id, { onDelete: 'cascade' }),
    added_at: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.asset_kind, t.asset_id, t.stream_id] }),
    // Migration 144: 'card' is a kaizen_log attribution, never a stream member.
    notCard: check('asset_stream_membership_not_card', sql`${t.asset_kind}::text <> 'card'`),
  }),
);

// The asset-stream provisioner's umbrella-project registry (migration 041). Kept by migration 230
// while POST /api/cards/improvement still provisions asset-authoring streams (its rows of the three
// deleted improvement tenants were removed).
export const tenantImprovementProjects = pgTable(
  'tenant_improvement_projects',
  {
    tenant_id: uuid('tenant_id').notNull(),
    kind: streamKindEnum('kind').notNull(),
    planka_project_id: text('planka_project_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.kind] }),
  }),
);

// Notification log table (tracks all notification delivery attempts)
export const notificationLog = pgTable('notification_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  approval_id: uuid('approval_id').references(() => approvals.id, { onDelete: 'cascade' }).notNull(),
  channel: text('channel').notNull(),       // 'telegram', 'websocket', 'email', 'teams'
  recipient: text('recipient').notNull(),   // phone number, user_id, email
  status: text('status').default('pending').notNull(), // pending, sent, failed, delivered
  sent_at: timestamp('sent_at'),
  error_message: text('error_message'),
  metadata: jsonb('metadata').$type<Record<string, any> | null>(),              // channel-specific data
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// =====================================================================
// Spec 2 — Continuous-Flow Project Model
// Migration: 041_spec_2_continuous_flow.sql
// Spec: docs/archive/2026-04-27-continuous-project-model-design.md
// =====================================================================

// §5.1 — cron-driven inbound work pulls. The fr-backend tick worker
// (workers/scheduled-trigger-tick.ts) claims due rows via SKIP LOCKED.
// In Plan 2-A connector dispatch is a no-op (status='skipped_no_connector');
// Plan 2-B wires the n8n subflow.
export const scheduledTriggers = pgTable('scheduled_triggers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull(),
  project_id: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  source_connector: text('source_connector', {
    enum: ['file', 's3', 'rss', 'imap', 'github_query', 'n8n_webhook'],
  }).notNull(),
  connector_config: jsonb('connector_config')
    .$type<Record<string, unknown>>()
    .notNull(),
  payload_mapper: jsonb('payload_mapper')
    .$type<Record<string, string>>()
    .notNull(),
  target_list: text('target_list').notNull().default('INBOX'),
  card_template: jsonb('card_template')
    .$type<{
      card_type: string;
      labels?: string[];
      custom_fields?: Record<string, unknown>;
    }>()
    .notNull(),
  enabled: boolean('enabled').notNull().default(true),
  last_run_at: timestamp('last_run_at', { withTimezone: true }),
  last_run_status: text('last_run_status', {
    enum: ['ok', 'error', 'no_new_records', 'skipped_no_connector', 'config_invalid', 'partial_failure'],
  }),
  last_run_error: text('last_run_error'),
  // Migration 094 — consecutive permanent-dispatch-failure ledger. The tick
  // worker increments it on a permanent HTTP status (404/401/400/…), resets it
  // to 0 on any successful dispatch, and only auto-disables the row once it
  // reaches PERMANENT_FAILURE_DISABLE_THRESHOLD. Requiring N consecutive
  // failures is what keeps a merely DEACTIVATED n8n workflow — which answers
  // 404 for the length of an edit — from permanently switching off a healthy
  // trigger.
  permanent_failure_count: integer('permanent_failure_count')
    .notNull()
    .default(0),
  // Migration 094 — durable marker telling an AUTO disable apart from a human
  // one. NULL when a person switched the row off (or when it is enabled); the
  // worker writes a stable token. Cleared on a human re-enable.
  disabled_reason: text('disabled_reason'),
  // Plan 2-D Phase 8 — provenance link for triggers that were promoted from
  // a suggested-schedules row via POST /api/suggested-schedules/:id/accept.
  // NULL for hand-created triggers. No FK by design: see migration 047.
  from_suggestion_id: uuid('from_suggestion_id'),
  // bound_assets origin columns (migration 068). Mirrors the upstream
  // services that already carry these (requirements/principles/decisions/
  // artifacts).
  origin_kind: text('origin_kind').notNull().default('project'),
  origin_project_id: uuid('origin_project_id'),
  origin_workflow_run_id: text('origin_workflow_run_id'),
  created_by_user_id: text('created_by_user_id'),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
},
  // Mirrors the four CHECKs prod actually enforces on this table. They lived
  // only in migration SQL, which CI never executes (the runner stamps 91 of
  // 93 migrations as applied without running them — see migration-runner.ts),
  // so CI accepted rows prod rejects. MEASURED before this change: a CI-shaped
  // DB accepted source_connector='TOTALLY_NOT_A_CONNECTOR', cron='',
  // origin_kind='NOT_AN_ORIGIN' and last_run_status='NOT_A_STATUS' in one row.
  // That is the same hole that let source_connector:'imap' (enum-valid in TS,
  // no registry entry) reach the cron tick and wedge every tenant's scheduler.
  (t) => [
    check(
      'scheduled_triggers_source_connector_check',
      sql`${t.source_connector} IN ('file', 's3', 'rss', 'imap', 'github_query', 'n8n_webhook')`,
    ),
    check(
      'scheduled_triggers_last_run_status_check',
      sql`${t.last_run_status} IS NULL OR ${t.last_run_status} IN ('ok', 'error', 'no_new_records', 'skipped_no_connector', 'config_invalid', 'partial_failure')`,
    ),
    check(
      'scheduled_triggers_origin_kind_check',
      sql`${t.origin_kind} IN ('tenant', 'project', 'workflow')`,
    ),
    check('scheduled_triggers_cron_nonempty', sql`length(${t.cron}) > 0`),
  ],
);

// §5.5 — append-only audit log of scheduled-trigger runs. trigger_kind +
// trigger_id together identify the parent row. Read by the per-trigger /runs endpoint.
export const scheduledTriggerRuns = pgTable('scheduled_trigger_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  trigger_kind: text('trigger_kind', {
    enum: ['scheduled_intake'],
  }).notNull(),
  trigger_id: uuid('trigger_id').notNull(),
  tenant_id: uuid('tenant_id').notNull(),
  project_id: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  fired_at: timestamp('fired_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  status: text('status', {
    enum: [
      'ok',
      'error',
      'no_new_records',
      'skipped_no_connector',
      'template_not_found',
      'render_error',
      'in_progress',
      'config_invalid',
      'partial_failure',
    ],
  }).notNull(),
  records_processed: integer('records_processed').notNull().default(0),
  error_message: text('error_message'),
  kind: text('kind', { enum: ['cron', 'manual', 'webhook'] }).notNull().default('cron'),
  triggered_by_user_id: text('triggered_by_user_id'),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
},
  // This is the audit table the delivery-truth work writes to, so an
  // unconstrained `status` meant a run could record a status no reader
  // understands and no test would catch it.
  (t) => [
    check(
      'scheduled_trigger_runs_status_check',
      sql`${t.status} IN ('ok', 'error', 'no_new_records', 'skipped_no_connector', 'template_not_found', 'render_error', 'in_progress', 'config_invalid', 'partial_failure')`,
    ),
    check(
      'scheduled_trigger_runs_trigger_kind_check',
      sql`${t.trigger_kind} IN ('scheduled_intake')`,
    ),
    check(
      'scheduled_trigger_runs_kind_check',
      sql`${t.kind} IN ('cron', 'manual', 'webhook')`,
    ),
    // Supports the retention reaper (workers/scheduled-trigger-run-prune.ts),
    // which deletes on `created_at`. Both indexes migration 045 created are
    // composite and lead with a column the reaper does not filter on, so without
    // this it seq-scans the whole table every tick.
    //
    // Declared HERE as well as in migration 095 on purpose, and the duplication is
    // load-bearing rather than sloppy: a fresh database is provisioned by
    // `drizzle-kit push` (from THIS file) and the migration runner then BACKFILLS
    // `_migrations` with every known filename as a no-op apply — so 095 never
    // executes there and the index would simply not exist. Prod has a real
    // migration history and applies 095 normally. Both paths are needed for both
    // kinds of database to end up with the index. (Caught by the reaper's own
    // integration test asserting the index exists — it went RED in CI while
    // passing locally, which is exactly this split.)
    index('scheduled_trigger_runs_created_at_idx').on(t.created_at),
  ],
);

// Spec 2 §9 / Plan 2-D Phase 5 (`044_suggested_schedules.sql`) —
// candidate schedules for the Suggestion Inbox surface. A row here is a
// *proposal* the user can accept (atomic promote → scheduled_triggers)
// or dismiss. Two `source` values:
//
//   - 'manual'    : admin / QA insertion via POST /api/internal/suggested-schedules
//   - 'heuristic' : future auto-detector (out of scope this phase)
//
// `payload` carries `suggested_*` keys mirroring scheduled_triggers fields
// (suggested_cron, suggested_timezone, suggested_source_connector,
// suggested_connector_config, suggested_payload_mapper, suggested_target_list,
// suggested_card_template, suggested_name). The accept handler reads these
// out and INSERTs into `scheduled_triggers` inside the same tx that flips
// status to 'accepted', so we never double-promote.
//
// `promoted_trigger_id` is ON DELETE SET NULL: keep the audit row visible
// even if an admin later deletes the promoted trigger.
export const suggestedSchedules = pgTable(
  'suggested_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id'),
    source: text('source', { enum: ['manual', 'heuristic'] }).notNull(),
    ad_hoc_summary: text('ad_hoc_summary').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status', { enum: ['new', 'accepted', 'dismissed'] })
      .notNull()
      .default('new'),
    promoted_trigger_id: uuid('promoted_trigger_id').references(
      () => scheduledTriggers.id,
      { onDelete: 'set null' },
    ),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // Drizzle's `text('...', { enum })` only narrows the TS type — it does
  // NOT emit a SQL CHECK. Without these, drizzle-kit push creates the
  // table without the CHECK, and the migration's `CREATE TABLE IF NOT
  // EXISTS` is then a no-op, so the constraint never lands. Declaring
  // the table-level check() ensures drizzle-kit push creates them too.
  (t) => [
    check(
      'suggested_schedules_source_check',
      sql`${t.source} IN ('manual', 'heuristic')`,
    ),
    check(
      'suggested_schedules_status_check',
      sql`${t.status} IN ('new', 'accepted', 'dismissed')`,
    ),
  ],
);

export type ScheduledTrigger = typeof scheduledTriggers.$inferSelect;
export type ScheduledTriggerInsert = typeof scheduledTriggers.$inferInsert;
export type ScheduledTriggerRun = typeof scheduledTriggerRuns.$inferSelect;
export type ScheduledTriggerRunInsert = typeof scheduledTriggerRuns.$inferInsert;
export type SuggestedSchedule = typeof suggestedSchedules.$inferSelect;
export type SuggestedScheduleInsert = typeof suggestedSchedules.$inferInsert;

// =====================================================================
// Super-admin user provisioning audit trail
// Migration: 056_provisioning_audit.sql (action CHECK widened by 209 and 210)
// Spec ref: ~/.claude/plans/confirmed-spec-2-spicy-breeze.md (Task 1)
// =====================================================================

// Records every super-admin provisioning action (Keycloak user create +
// license mint + budget set) with status. The `payload` carries the
// inbound request shape; `result` carries downstream IDs (keycloak user
// id, license id) so partial failures can be diagnosed without replaying
// the whole flow. CHECK constraints are declared at the table level so
// drizzle-kit push emits them on a fresh DB (drizzle's text-with-enum
// only narrows the TS type, never the SQL).
export const provisioningAudit = pgTable(
  'provisioning_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor_user_id: text('actor_user_id').notNull(),
    action: text('action', {
      // + 'resend_set_password_email' (migration 209, fr#1634); + 'remove_signup' /
      // 'remove_signup_step' (migration 210, the early-access removal).
      enum: [
        'provision_user',
        'revoke_user',
        'reissue_token',
        'resend_set_password_email',
        'remove_signup',
        'remove_signup_step',
      ],
    }).notNull(),
    target_email: text('target_email').notNull(),
    target_user_id: text('target_user_id'),
    tenant_id: uuid('tenant_id'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    result: jsonb('result')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status', {
      enum: ['pending', 'success', 'partial', 'error'],
    })
      .notNull()
      .default('pending'),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      'provisioning_audit_action_check',
      sql`${t.action} IN ('provision_user','revoke_user','reissue_token','resend_set_password_email','remove_signup','remove_signup_step')`,
    ),
    check(
      'provisioning_audit_status_check',
      sql`${t.status} IN ('pending','success','partial','error')`,
    ),
  ],
);

export type ProvisioningAudit = typeof provisioningAudit.$inferSelect;
export type ProvisioningAuditInsert = typeof provisioningAudit.$inferInsert;

// Migration 215 — George 2026-10-27: a super_admin is TENANT-ADMIN in any tenant
// it switches into, and every such action is audited. One append-only row per
// WRITE a super_admin sends while switched (X-Active-Tenant) into a tenant other
// than their own JWT tenant, with the status the handler answered
// (lib/super-admin-tenant-audit.ts). APPEND-ONLY: a row trigger refuses every
// UPDATE/DELETE (migration 215). No FK on tenant_id: the row outlives the
// workspace it names.
export const superAdminTenantActions = pgTable(
  'super_admin_tenant_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor_user_id: text('actor_user_id').notNull(),
    tenant_id: uuid('tenant_id').notNull(),
    home_tenant_id: text('home_tenant_id'),
    method: text('method').notNull(),
    route: text('route').notNull(),
    status: integer('status').notNull(),
    // An agent-action row (registry `invokeAction`): the action name and its outcome.
    action_name: text('action_name'),
    outcome: text('outcome'),
    correlation_id: text('correlation_id'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenant_ts_idx: index('super_admin_tenant_actions_tenant_ts_idx').on(t.tenant_id, t.ts.desc()),
    actor_ts_idx: index('super_admin_tenant_actions_actor_ts_idx').on(t.actor_user_id, t.ts.desc()),
  }),
);

// Budget top-up audit + PAYMENT record.
//
// fr owns the top-up intent + payment record; billing_service owns the token
// budget (its token_budgets table has no metadata column). `budget_id` links
// this row to the allocated budget. The `payment_*` columns are the seam for a
// future Stripe/other integration: today `payment_status='free'` and
// `payment_ref` is a `free-…` sentinel; when a provider is wired, they hold the
// real PaymentIntent id + status with NO schema change. Actor + tenant + tokens
// give a full audit even before money is involved.
export const budgetTopups = pgTable(
  'budget_topups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    actor_user_id: text('actor_user_id').notNull(),
    package_id: text('package_id').notNull(),
    tokens: bigint('tokens', { mode: 'number' }).notNull(),
    price_usd: numeric('price_usd').notNull().default('0'),
    /** billing token_budgets.id once allocation succeeds; null on a failed/pending settle. */
    budget_id: uuid('budget_id'),
    payment_ref: text('payment_ref'),
    payment_status: text('payment_status', {
      enum: ['free', 'paid', 'pending', 'failed'],
    })
      .notNull()
      .default('free'),
    status: text('status', {
      enum: ['pending', 'allocated', 'failed'],
    })
      .notNull()
      .default('pending'),
    error: text('error'),
    /**
     * Caller-minted dedupe key (migration 118). REQUIRED — a money endpoint must
     * not accept an unkeyed write. `runTopUp` INSERTs ON CONFLICT DO NOTHING and
     * returns the ORIGINAL row's outcome on a conflict, so a double-clicked
     * button / proxy retry / client retry allocates the package exactly once
     * instead of stacking a second 1M-100M-token billing budget.
     */
    idempotency_key: text('idempotency_key').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Per-TENANT, not global: two tenants must not be able to collide on a
    // guessable key, and the key only has to be unique to the client that
    // minted it. ON CONFLICT (tenant_id, idempotency_key) infers from this.
    uniqueIndex('budget_topups_tenant_idempotency_key').on(t.tenant_id, t.idempotency_key),
    check(
      'budget_topups_payment_status_check',
      sql`${t.payment_status} IN ('free','paid','pending','failed')`,
    ),
    check('budget_topups_status_check', sql`${t.status} IN ('pending','allocated','failed')`),
  ],
);

export type BudgetTopup = typeof budgetTopups.$inferSelect;
export type BudgetTopupInsert = typeof budgetTopups.$inferInsert;

// Idempotency receipts for billing_service's budget threshold-crossing
// webhooks (POST /api/webhooks/billing/budget-threshold). billing already
// dedupes at source on (budget_id, threshold_pct, period_start), but a network
// retry or double-delivery could still arrive twice — an INSERT ... ON CONFLICT
// DO NOTHING here makes the receiver fan out at most once per crossing.
// tenant_id is `uuid` as of migration 103. It was TEXT, hedged against "a legacy
// non-uuid billing tenant" — a hedge that never had a row to protect: the table
// held ZERO rows when 103 shipped. budget_id STAYS text (it is billing's own
// identifier, not a tenant). Rows are an append-only audit — never read back
// except via the ON CONFLICT probe.
export const budgetAlertReceipts = pgTable(
  'budget_alert_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    budget_id: text('budget_id').notNull(),
    threshold_pct: integer('threshold_pct').notNull(),
    period_start: timestamp('period_start', { withTimezone: true }).notNull(),
    received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Matches billing's budget_overage_alerts dedupe key. budget_id is globally
    // unique, so tenant_id is not part of the key.
    unique('budget_alert_receipts_dedupe').on(t.budget_id, t.threshold_pct, t.period_start),
  ],
);

export type BudgetAlertReceipt = typeof budgetAlertReceipts.$inferSelect;
export type BudgetAlertReceiptInsert = typeof budgetAlertReceipts.$inferInsert;

// Plan 6 Wave D — per-card store for KAG entity links discovered by the
// Seeker activity during READYING. Written by n8n's `ActionWriteSeekerLinks`
// step inside ready-prefetch.json; read by `GET /api/cards/:id` to
// populate the `kag_seeker[]` payload that closes the W-1 stub at
// cards/get.ts:303-308. Idempotent on (card_id, kag_entity_id) via the
// unique constraint — n8n retries are safe.
export const cardSeekerLinks = pgTable(
  'card_seeker_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    card_id: text('card_id').notNull(),
    kag_entity_id: uuid('kag_entity_id').notNull(),
    score: real('score'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    card_idx: index('card_seeker_links_card_id_idx').on(t.card_id),
    uq: unique('card_seeker_links_unique').on(t.card_id, t.kag_entity_id),
  }),
);

// `campaign_jobs` and `campaign_governance_controls` were DROPPED by migration 197 (George,
// 2026-10-18): the bulk fan-out and the campaign kill-switch that used them were deleted in
// fr-agui P4d-2a / P4d-2d.


// Migration 125 — public GitHub App installations bound to an fr tenant
// (workspace). A customer repo token is only ever minted by coding-github for
// an installation bound HERE to the requesting tenant (lookup:
// GET /api/internal/github-app/binding). One ACTIVE binding per installation
// (partial unique index); a revoked row stays for audit and frees the id for a
// new binding. `tenant_id` carries no FK, matching the other tenant_id columns.
export const githubAppInstallations = pgTable(
  'github_app_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    installation_id: bigint('installation_id', { mode: 'number' }).notNull(),
    account_login: text('account_login').notNull(),
    account_type: text('account_type').notNull(),
    installed_by_user_id: uuid('installed_by_user_id').notNull(),
    github_user_login: text('github_user_login').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    last_verified_at: timestamp('last_verified_at', { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    activeInstallation: uniqueIndex('github_app_installations_active_installation_idx')
      .on(t.installation_id)
      .where(sql`${t.revoked_at} IS NULL`),
    tenantLogin: index('github_app_installations_tenant_login_idx').on(
      t.tenant_id,
      sql`lower(${t.account_login})`,
    ),
  }),
);

export type GithubAppInstallation = typeof githubAppInstallations.$inferSelect;
