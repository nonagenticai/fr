// src/capabilities/spec-document.ts
//
// fr-agui SPEC §13 P4d-2e — the NON-path parts of the served OpenAPI document: info, servers,
// the shared `components` (security schemes, and the schemas the frozen operations `$ref`), the
// document-level security and the tag list. Every OPERATION is a capability's
// (`capabilities/registry.ts` → derive-openapi.ts `deriveOperation`); the hand-written
// `src/openapi.ts` literal that used to hold paths is deleted. The path ORDER is the committed
// `served-spec.lock.json`'s (capabilities/served-spec.ts).
//
// ⛔ `paths` stays an EMPTY object here: it pins where `paths` sits in the served document's key
// order (buildOpenApiSpec throws on a path written here). A NEW operation's tag must be listed in
// `tags` (tests/unit/openapi-spec-integrity.test.ts). Any edit here changes the served spec and
// therefore the lock (scripts/check-served-spec.ts).
import { STREAM_MEMBER_ASSET_KINDS } from '../db/schema';
// Vocabularies the create door owns, DERIVED rather than re-typed: a second copy of
// an enum is how the two disagree. (`ProjectCreate` below mirrors types/api.ts.)
import { APPROVAL_MODES, PROJECT_BOUND_ASSET_KINDS, RewriteLanguageSchema } from '../types/api';
import { QUESTION_MODES } from '../types/question-mode';
import { SCOPE_LEVELS } from '../types/scope-level';

export const SPEC_DOCUMENT = {
  openapi: '3.0.0',
  info: {
    title: 'FR Backend API',
    version: '1.0.0',
    description: 'FR Backend API for managing projects, documents, metrics, comments, approvals, and secrets. Integrates with n8n for workflow orchestration.',
  },
  servers: [
    {
      url: 'http://localhost:8888',
      description: 'Local development server',
    },
    {
      url: 'http://fr-backend:8888',
      description: 'Docker container server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Keycloak JWT token',
      },
      // The shared n8n system secret. Routes that accept ONLY this header cannot
      // be called with a bearer token, so they are marked `x-internal: true` and
      // the n8n-nodes-fr generator does not expose them as typed ops.
      // Per-caller internal token (one service = one secret). Compared
      // constant-time to a DEDICATED env per caller; routes using it are
      // `x-internal: true` (never a typed n8n op).
      internalToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Internal-Token',
        description: 'Per-caller service token (e.g. FR_BILLING_INTERNAL_TOKEN for billing-service). Not a user credential.',
      },
      webhookSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Webhook-Secret',
        description: 'Shared n8n system secret (utils/webhook-secret.ts). Not a user credential.',
      },
      // G4 (2026-10-10): an fr LICENCE token — the opaque licences-service token a customer's n8n
      // holds (lib/licence-introspect.ts; tenant pinned, member level). The only door on the
      // routes the n8n node calls whose shared-secret door was removed.
      licenceToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'fr licence token (opaque, introspected at the licences service; tenant-pinned). Not a Keycloak JWT.',
      },
    },
    schemas: {
      ProjectCardRequiresLink: {
        type: 'object',
        description:
          'What POST /api/cards/project did with `requires_card_ids`. A caller that sent the field ' +
          'must assert `linked ∪ already` covers `requested`; an absent or null value means the ' +
          'field was not applied.',
        required: ['requested', 'linked', 'already'],
        properties: {
          requested: {
            type: 'array',
            items: { type: 'string' },
            description: 'The de-duplicated ids requested, in request order.',
          },
          linked: {
            type: 'array',
            items: { type: 'string' },
            description: 'At least one side (`requires` / `required_by`) was written.',
          },
          already: {
            type: 'array',
            items: { type: 'string' },
            description: 'Both sides were already present (a retry); zero writes.',
          },
        },
      },
      FindingSuppression: {
        type: 'object',
        description:
          'One false-positive decision, keyed on (project_id, fingerprint) — never on the caller\'s tenant.',
        required: [
          'project_id',
          'fingerprint',
          'recorded_tenant_id',
          'reason',
          'card_id',
          'decided_by',
          'created_at',
        ],
        properties: {
          project_id: { type: 'string', format: 'uuid' },
          fingerprint: { type: 'string' },
          recorded_tenant_id: {
            type: 'string',
            format: 'uuid',
            description: 'Active tenant of the caller that recorded the decision (audit only).',
          },
          reason: { type: 'string' },
          card_id: { type: 'string', nullable: true },
          decided_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          category: {
            type: 'string',
            nullable: true,
            description: 'Caller-declared finding category (lower-cased), null when not given.',
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'object' },
        },
      },
      // A refusal whose machine code is ALSO a top-level `code` (the
      // AppError.withCode convention, utils/errors.ts) — what a caller branches
      // on. `error` is unchanged; route-specific fields ride alongside.
      CodedError: {
        type: 'object',
        required: ['error', 'code'],
        properties: {
          error: { type: 'string' },
          code: { type: 'string', description: 'Stable machine-readable refusal code.' },
          message: { type: 'string' },
          details: { type: 'object' },
        },
        additionalProperties: true,
      },
      // POST /api/cards/{cardId}/scenario-evidence: a refusal raised AFTER this
      // request committed its rows — the rows it created are deleted and the
      // outcome is reported, never assumed.
      ScenarioEvidenceRollback: {
        allOf: [
          { $ref: '#/components/schemas/CodedError' },
          {
            type: 'object',
            required: ['card_id'],
            properties: {
              card_id: { type: 'string' },
              scenario_evidence_rolled_back: {
                type: 'boolean',
                description: 'Present after a description-update failure: every row this request created was deleted.',
              },
              scenario_evidence_rows_removed: { type: 'integer' },
              scenario_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'The scenario_ids whose rows this request had created.',
              },
            },
          },
        ],
      },
      // ---- Improvement-stream registry (Plan 3 §3) ----
      StreamKind: { type: 'string', enum: ['workflow', 'prompt'] },
      // Stream-membership asset kinds: the `asset_kind` pgEnum minus 'card'
      // (migration 144 — a kaizen_log attribution, never a stream member).
      // Derived, never hand-copied.
      AssetKind: {
        type: 'string',
        enum: [...STREAM_MEMBER_ASSET_KINDS],
      },
      Stream: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
          kind: { $ref: '#/components/schemas/StreamKind' },
          name: { type: 'string' },
          planka_project_id: { type: 'string' },
          planka_board_id: { type: 'string' },
          threshold_rules: { type: 'object', additionalProperties: true },
          eval_set_id: { type: 'string', format: 'uuid', nullable: true },
          owner_dept_id: { type: 'string', format: 'uuid', nullable: true },
          // Migration 120. NOT planka_project_id above — that is a text Planka
          // board-container id. This is projects(id), and it is what the stream
          // detector passes as the minted card's project_id.
          project_id: { type: 'string', format: 'uuid', nullable: true },
          min_significance_n: { type: 'integer' },
          is_active: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      StreamCreate: {
        type: 'object',
        // `slug` is required by createStreamSchema (routes/assets/streams.ts) and
        // streams.slug is NOT NULL (migration 050); without it every create is a 422.
        required: ['kind', 'name', 'slug'],
        properties: {
          kind: { $ref: '#/components/schemas/StreamKind' },
          name: { type: 'string', maxLength: 200 },
          slug: { type: 'string', minLength: 1, maxLength: 200, description: 'Stable stream slug (GET /api/assets/streams/by-slug/{slug})' },
          threshold_rules: { type: 'object', additionalProperties: true },
          eval_set_id: { type: 'string', format: 'uuid', nullable: true },
          owner_dept_id: { type: 'string', format: 'uuid', nullable: true },
          min_significance_n: { type: 'integer', minimum: 1 },
        },
      },
      StreamPatch: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 200 },
          threshold_rules: { type: 'object', additionalProperties: true },
          min_significance_n: { type: 'integer', minimum: 1 },
          owner_dept_id: { type: 'string', format: 'uuid', nullable: true },
          eval_set_id: { type: 'string', format: 'uuid', nullable: true },
          project_id: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      StreamMember: {
        type: 'object',
        properties: {
          stream_id: { type: 'string', format: 'uuid' },
          asset_kind: { $ref: '#/components/schemas/AssetKind' },
          asset_id: { type: 'string', format: 'uuid' },
          added_at: { type: 'string', format: 'date-time' },
        },
      },
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          owner_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          repository_url: { type: 'string', nullable: true, description: 'NULL = the project has no repository (optional since migration 190).' },
          branch: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['submitted', 'active', 'archived', 'failed', 'delivered'],
          },
          n8n_project_id: { type: 'string', nullable: true },
          planka_board_id: { type: 'string', nullable: true },
          repository_provisioned: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      ProjectRepositoryListItem: {
        type: 'object',
        required: ['repo_id', 'url', 'is_primary', 'added_at'],
        properties: {
          repo_id: { type: 'string', format: 'uuid' },
          url: { type: 'string' },
          branch: { type: 'string', nullable: true },
          name: { type: 'string', nullable: true },
          container_name: { type: 'string', nullable: true },
          is_primary: { type: 'boolean' },
          added_at: { type: 'string', format: 'date-time' },
        },
      },
      ProjectRepositoriesList: {
        type: 'object',
        required: ['items', 'total', 'primary_repository_id'],
        properties: {
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/ProjectRepositoryListItem' },
          },
          total: { type: 'integer' },
          primary_repository_id: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      ProjectRepositoryAttachBody: {
        type: 'object',
        description:
          'Either repo_id (attach existing) or url (create-or-attach by url). Refused if both absent.',
        properties: {
          repo_id: { type: 'string', format: 'uuid' },
          url: { type: 'string' },
          branch: { type: 'string' },
          name: { type: 'string' },
        },
      },
      // ── POST /api/projects — THE CREATE DOOR'S INPUT CONTRACT ───────────────
      // Mirrors `ProjectCreateSchema` (types/api.ts), the schema `createProjectCore`
      // parses: every top-level key the door accepts is a property below, in the
      // same order. The old schema carried only name/repository_url/branch, so every
      // generated client (n8n-nodes-fr is generated from THIS document) could not
      // send a project type at all — and the door refuses an untyped create.
      // `tests/unit/capabilities/project-create-spec-contract.test.ts` fails if this
      // component and the route's schema drift apart in either direction.
      //
      // ⛔ `project_type` is REQUIRED here although the zod schema leaves it
      // optional: the door refuses an untyped create with 422 project_type_required
      // (routes/projects.ts assertProjectTypeInCatalogue) BEFORE any write, because
      // requirements_management creates every project with its type. The zod schema
      // stays open only so a stored project-request draft carrying a legacy or
      // invented type still parses — the LIVE door does not.
      ProjectCreate: {
        type: 'object',
        required: ['name', 'project_type'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string' },
          repository_url: {
            type: 'string',
            format: 'uri',
            nullable: true,
            description:
              'Optional — a project need not have a repository. The CP placeholder https://example.invalid/REPLACE-IN-FR is refused when provided.',
          },
          branch: {
            type: 'string',
            default: 'main',
            description:
              'Branch the primary repository is read from (default main). A value shaped like a commit sha (7–40 hex) is treated as a pinned ref and FULL-cloned instead of shallow-cloned.',
          },
          project_type: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description:
              "Required. A startable project type NAME (never a display label) from the OWNING tenant's " +
              'requirements_management catalogue — GET /api/conveyor/project-types, the rows with `startable: true`. ' +
              'Validated against that tenant\'s list before any write: an unknown name is 422 project_type_unknown ' +
              '(carrying `allowed`), and a type whose phase list does not start with `setup` is 422 ' +
              'project_type_not_startable. There is no fr-side default.',
          },
          scope_level: {
            type: 'string',
            enum: [...SCOPE_LEVELS],
            description:
              'Granularity of the work, NOT a repository count. No longer asked for: omitted ⇒ derived from the ' +
              'repository count (two or more ⇒ multi_repo). An explicit value always wins.',
          },
          priority: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description:
              "A priority level (name or id) of the OWNING tenant's RM priority levels. A value outside them is " +
              'refused 400 invalid_priority before any write.',
          },
          lifecycle_class: {
            type: 'string',
            enum: ['system', 'workflow-improvement', 'execution', 'prompt-improvement'],
            description: 'Lifecycle class, orthogonal to project_type. n8n keys the card-type set off it.',
          },
          coordination_mode: {
            type: 'string',
            enum: ['coordinated', 'independent'],
            default: 'coordinated',
            description:
              'How this project\'s repositories relate: `coordinated` = one product worked across N repos and ' +
              'landed as one unit; `independent` = separate workstreams that share a project. Orthogonal to scope_level.',
          },
          programme_id: {
            type: 'string',
            format: 'uuid',
            description: 'The pmProgrammes asset id of the programme this delivery project belongs to.',
          },
          it_flow: {
            type: 'string',
            enum: ['dependency', 'security', 'source-security', 'iac', 'bug', 'refactor', 'rewrite'],
            description:
              'IT-pipeline flow selector (IT_MVP Flows 1/2/2s/2i/3/4 plus rewrite). Picks which analysis card ' +
              'project_setup spawns; absent ⇒ dependency.',
          },
          target_language: {
            type: 'string',
            enum: [...RewriteLanguageSchema.options],
            description:
              'Rewrite projects only (it_flow=rewrite): the TARGET language, recorded on the ' +
              'project BRIEF. Omit it — the backend extracts it from the project request; send ' +
              'it only to override that.',
          },
          approval_mode: {
            type: 'string',
            enum: [...APPROVAL_MODES],
            description:
              "Which sign-offs the user is asked for: 'brief_and_closure' (default: only the brief and the " +
              "closure sign-off), 'autonomous' (nothing), 'auto_drafts' or 'all'. fr always stores one on RM.",
          },
          question_mode: {
            type: 'string',
            enum: [...QUESTION_MODES],
            nullable: true,
            description:
              "Which QUESTION path the conveyor takes: 'structured' (execution.question, one question per " +
              "approval) or 'free_text'. Absent/null ⇒ free_text.",
          },
          min_severity: {
            type: 'string',
            enum: ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'],
            description:
              'Security scan floor for the remediation flows. UPPERCASE: these literals go straight to the ' +
              'scanner\'s minSeverity.',
          },
          test_command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Post-fix verification command in ARGV form (no shell) — e.g. ["python","-m","pytest","-q"].',
          },
          test_workdir: { type: 'string', description: 'Working directory for test_command.' },
          bug_test_command: {
            type: 'array',
            items: { type: 'string' },
            description: 'ARGV form of the currently-failing test, for it_flow=bug. Forbidden when bug_hunt is true.',
          },
          failing_test_ref: { type: 'string', description: 'Identifier of the failing test (it_flow=bug).' },
          target_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files the remediation worker may edit.',
          },
          finding_description: { type: 'string', description: 'SAST/security finding text (security flows).' },
          bug_description: { type: 'string', description: 'Bug report text (it_flow=bug).' },
          requestor: { type: 'string', description: 'Who asked for the project (free text).' },
          fixture: {
            type: 'boolean',
            description:
              "Self-declared TEST FIXTURE marker. true ⇒ fr mints no human execution sign-off for this project's " +
              'cards (lib/execution-signoff.ts). Integration-test drivers only.',
          },
          stakeholders: {
            type: 'array',
            items: { type: 'string' },
            description: 'People involved in the project (brief key `stakeholders`).',
          },
          approvers: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Keycloak user ids (UUIDs) that seed the project's execution sign-off roster. A non-UUID entry is " +
              'dropped with a warning: only concrete user ids can sign off.',
          },
          problem_statement: { type: 'string', description: 'What problem the project solves.' },
          desired_outcome: { type: 'string', description: 'What success looks like.' },
          business_case: { type: 'string', description: 'Why the work is worth doing.' },
          success_criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'How success is measured.',
          },
          acceptance_criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Conditions a deliverable must satisfy.',
          },
          in_scope: { type: 'array', items: { type: 'string' }, description: 'What the work covers.' },
          out_of_scope: { type: 'array', items: { type: 'string' }, description: 'What the work does not cover.' },
          high_level_requirements: { type: 'array', items: { type: 'string' } },
          assumptions: { type: 'array', items: { type: 'string' } },
          access_requirements: {
            type: 'array',
            items: { type: 'string' },
            description: 'Access the work needs (credentials, environments).',
          },
          // The project's repositories. `primary` is denormalised onto
          // repository_url/branch on the row; every `additional` entry becomes a
          // non-primary project_repositories row in the same transaction.
          repo: {
            type: 'object',
            required: ['primary'],
            properties: {
              primary: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string' },
                  branch: { type: 'string' },
                  path: { type: 'string', description: 'Sub-path of the repository the work is scoped to.' },
                  role: {
                    type: 'string',
                    enum: ['source', 'target'],
                    description: 'Rewrite projects only: the source repos are read, the one target repo is written.',
                  },
                  sha: {
                    type: 'string',
                    pattern: '^[0-9a-fA-F]{40}$',
                    description: 'Rewrite projects only: the full 40-hex commit sha this repository is pinned to.',
                  },
                  pin: {
                    type: 'string',
                    description:
                      'The exact version this repository is taken at (George 2026-11-07): a full 40-hex ' +
                      'commit SHA, a PR number (#123) or a GitHub PR URL. A PR is resolved to its head ' +
                      'commit at create and stored as `sha`.',
                  },
                },
              },
              additional: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string', minLength: 1 },
                    branch: { type: 'string', minLength: 1 },
                    name: { type: 'string', minLength: 1, maxLength: 255 },
                    role: { type: 'string', enum: ['source', 'target'] },
                    sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
                    pin: {
                      type: 'string',
                      description:
                        'The exact version to take as input: a full 40-hex commit SHA, a PR number (#123) ' +
                        'or a GitHub PR URL; resolved to its head commit at create.',
                    },
                  },
                },
              },
            },
          },
          secret_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
            description: 'Existing secrets attached to the project (attachments.secret_ids on the RM intake).',
          },
          document_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
            description: 'Existing documents attached to the project (attachments.document_ids on the RM intake).',
          },
          repository_id: {
            type: 'string',
            format: 'uuid',
            description: "An existing repositories row, when the caller has already resolved one.",
          },
          deadline: { type: 'string', description: 'Free-text deadline carried into the brief.' },
          // BOTH shapes are accepted on purpose: rows created before the typed
          // vocabulary carry string[], and the form now sends the typed union.
          // Accepting only one would 422 every legacy project-request approval.
          constraints: {
            type: 'array',
            description:
              'Rules on how the repository may be changed. Both the legacy free-text strings and the typed ' +
              'constraint objects (types/project-constraints.ts) are accepted; the brief renders either.',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  required: ['kind'],
                  properties: {
                    kind: {
                      type: 'string',
                      enum: [
                        'no_language_version_change',
                        'pin_language_version',
                        'no_dependency_upgrades',
                        'no_new_dependencies',
                        'no_files_touched',
                        'must_keep_api_compatible',
                        'custom',
                      ],
                    },
                    language: { type: 'string', description: 'pin_language_version only.' },
                    version: { type: 'string', description: 'pin_language_version only.' },
                    globs: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'no_files_touched only: paths the work may not touch.',
                    },
                    text: { type: 'string', maxLength: 2000, description: 'custom only: delivered to the agent verbatim.' },
                  },
                },
              ],
            },
          },
          dependencies: {
            type: 'array',
            description: 'Things the project must keep working with (legacy strings and typed objects are both accepted).',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  required: ['name', 'kind'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 200 },
                    kind: { type: 'string', enum: ['service', 'library', 'api'] },
                    note: { type: 'string', maxLength: 2000 },
                  },
                },
              ],
            },
          },
          risks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['description'],
              properties: {
                description: { type: 'string' },
                likelihood: { type: 'string' },
                impact: { type: 'string' },
                mitigation: { type: 'string' },
              },
            },
          },
          budget: { type: 'string', description: 'Free-text budget carried into the brief — not a billing amount.' },
          notes: { type: 'string', description: 'Free-text notes carried into the brief.' },
          shape: {
            type: 'string',
            enum: ['deliverable', 'continuous_flow'],
            default: 'deliverable',
            description: 'Project shape selector; switching it after creation is refused.',
          },
          target_packages: {
            type: 'array',
            description:
              'Dependency upgrades to size the work by. Required for project_type="it" on the EXEC tenant unless ' +
              'cve_sweep is true.',
            items: {
              type: 'object',
              required: ['name', 'target_version'],
              properties: {
                name: { type: 'string', minLength: 1 },
                target_version: { type: 'string', minLength: 1 },
              },
            },
          },
          cve_sweep: {
            type: 'boolean',
            description:
              'When true, target_packages may be empty and the chore step DISCOVERS dependencies carrying a ' +
              'fixable CVE at/above min_severity instead of doing a targeted upgrade.',
          },
          bug_hunt: {
            type: 'boolean',
            description:
              'Hunt mode of it_flow=bug: no known failing test, so test_command is required and bug_test_command ' +
              'is forbidden. EXEC tenant only, never a fixture, and one live hunt per (tenant, repository).',
          },
          // Library assets picked at creation time. `.strict()` on the route's
          // schema: an unknown key here is a 422, not a silently dropped field.
          bound_assets: {
            type: 'object',
            additionalProperties: false,
            description:
              'Library assets picked at creation time, one optional array of asset ids per kind. Each becomes an ' +
              'asset_bindings row on the new project; for an EXEC `it` project the same grouping also rides the ' +
              'project_start_request brief. Unknown keys are refused.',
            properties: Object.fromEntries(
              PROJECT_BOUND_ASSET_KINDS.map((k) => [
                k,
                { type: 'array', items: { type: 'string', minLength: 1 } },
              ]),
            ),
          },
        },
      },
      // What POST /api/projects answers 201 with: the created `projects` row (a
      // SUPERSET of Project — project_data, project_type, coordination_mode … ride
      // along) plus the Planka board the create just made. `planka` is the field a
      // create caller cannot get from any other operation, so it belongs to THIS
      // operation's response, not the shared Project schema (GET does not return it).
      ProjectCreateResponse: {
        allOf: [
          { $ref: '#/components/schemas/Project' },
          {
            type: 'object',
            required: ['planka'],
            properties: {
              planka: {
                type: 'object',
                required: ['boardId'],
                properties: {
                  boardId: {
                    type: 'string',
                    description: 'The Planka board this create made (the row\'s planka_board_id).',
                  },
                },
              },
            },
          },
        ],
      },
      Secret: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['github_token', 'api_key', 'ssh_key', 'other'] },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      // Mirrors SecretCreateSchema (src/types/secrets.ts). The old `type` / `value`
      // names (and the github_token/ssh_key/other enum) were never accepted: every
      // create built from this schema was a 422.
      SecretCreate: {
        type: 'object',
        required: ['name', 'secret_type', 'secret_value'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string' },
          secret_type: { type: 'string', enum: ['api_key', 'oauth', 'basic_auth', 'custom'] },
          // fr-agui P4d-2d: the capability's `secrets.input` (/secret_value), marked like ProjectCreate.github_access_token.
          secret_value: { type: 'string', minLength: 1, description: 'The secret value (will be encrypted)', 'x-secret': true },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      // Mirrors SecretUpdateSchema (src/types/secrets.ts). `secret_value` is the
      // only key that rotates the stored value; a body carrying `value` was
      // stripped by zod and the PUT answered 200 having changed nothing.
      SecretUpdate: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string' },
          secret_value: { type: 'string', minLength: 1, description: 'New secret value (will be encrypted)', 'x-secret': true },
        },
      },
      Document: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          filename: { type: 'string' },
          file_size: { type: 'integer' },
          mime_type: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'completed', 'failed', 'rejected', 'parsed'],
          },
          kag_ingestion_id: { type: 'string', nullable: true },
          pages_detected: { type: 'integer', nullable: true },
          entities_extracted: { type: 'integer', nullable: true },
          error_message: { type: 'string', nullable: true },
          // Migration 099. null = UNKNOWN (no degradation evidence from upstream),
          // NOT "clean" — do not render `false` and `null` the same way.
          kag_degraded: { type: 'boolean', nullable: true },
          kag_degraded_reason: { type: 'string', nullable: true },
          kag_degraded_stage: {
            type: 'string',
            nullable: true,
            enum: ['knowledge', 'hierarchy', 'index', 'chunks'],
          },
          chunks_indexed: { type: 'integer', nullable: true },
          chunks_failed: { type: 'integer', nullable: true },
          chunks_total: { type: 'integer', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Comment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          author_id: { type: 'string', format: 'uuid' },
          content: { type: 'string' },
          mentions: { type: 'array', items: { type: 'object' }, nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          edited: { type: 'boolean' },
        },
      },
      Approval: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          approver_id: { type: 'string', format: 'uuid' },
          // Every status an approvals row can actually hold, kept in lockstep with
          // APPROVAL_STATUS_FILTERS (routes/approvals.ts) — that list is the source
          // of truth and carries the provenance for each value. `pending` is the
          // column default; `approved` / `rejected` come from handleUpdateApproval;
          // `expired` from workers/approval-expiry.ts (EXPIRED_STATUS); `voided`
          // from lib/void-approvals.ts (the only writer); `executing` / `done` /
          // `failed` from the E-5 action-approval bus
          // (domain/engagement/action-approvals.ts).
          //
          // ⚠️ `approvals.status` is `text NOT NULL DEFAULT 'pending'` with NO CHECK
          // and no enum type (schema.ts; migration 110 confirms the absence), so the
          // database will not stop the next status either — a new one becomes legal
          // the moment application code writes it. Anyone adding a status must add
          // it HERE and to APPROVAL_STATUS_FILTERS in the same change; this enum is
          // published, so omitting one makes a real response fail validation for
          // every consumer generating a client from this spec.
          status: {
            type: 'string',
            enum: [
              'pending',
              'approved',
              'rejected',
              'expired',
              'voided',
              'executing',
              'done',
              'failed',
            ],
          },
          comment: { type: 'string', nullable: true },
          // The reason a `voided` row was voided, or null on every other status. Written by
          // lib/void-approvals.ts (the only writer) and already served at runtime — the row is
          // spread, not projected — so omitting it here only made the CONTRACT disagree with the
          // wire. The conveyor's n8n side reads it to tell a restart's withdrawal ("project
          // restarted…") from any other void.
          voided_reason: { type: 'string', nullable: true },
          // D13 (migration 192): the ONE artifact the approval is about, or null.
          artifact_ref: { allOf: [{ $ref: '#/components/schemas/ApprovalArtifactRef' }], nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      // D13 (George 2026-10-13: ONE ref per approval) — lib/approval-artifact-ref.ts.
      ApprovalArtifactRef: {
        type: 'object',
        additionalProperties: false,
        required: ['artifact_id'],
        description:
          'The artifact an approval asks a human to approve. Validated at create against the ' +
          "approval's own project: malformed = 422 artifact_ref_invalid; not an artifact of that " +
          'project (or the approval resolves to no project, or `version` is above the artifact\'s ' +
          'current version) = 422 artifact_ref_not_found. `version` omitted = the artifact, not a ' +
          'pinned version. A create that dedupes onto an open gate naming a DIFFERENT ref is 409 ' +
          'artifact_ref_conflict; the gate keeps its own ref.',
        properties: {
          artifact_id: {
            type: 'string',
            // NOT format: uuid — artifact_service mints 128 random bits, so the RFC variant
            // nibble is arbitrary; any 8-4-4-4-12 hex is a valid artifact id.
            pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            description: 'An artifact_service id: 8-4-4-4-12 hex, any version/variant nibble.',
          },
          version: { type: 'integer', minimum: 1 },
        },
      },
      // ---- Knowledge areas (fr#1245 lane) ----
      //
      // The vocabulary is PER TENANT: the tenant's requirements_management capabilities
      // (design: fr consumes RM vocabulary, Q1 = a). So `area` is `type: string`, never an
      // enum; the live list is GET /api/tenant/knowledge-areas, and the write paths answer
      // 422 with the tenant's permitted set in `allowed`.
      UsageFundingBreakdown: {
        type: 'object',
        required: ['scope', 'tenant_id', 'from', 'to', 'group_by', 'cost_basis', 'totals', 'by_funding', 'rows', 'truncated', 'names_unavailable'],
        properties: {
          scope: { type: 'string', enum: ['tenant', 'me'] },
          tenant_id: { type: 'string' },
          actor_id: { type: 'string' },
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          group_by: { type: 'array', items: { type: 'string' } },
          cost_basis: { type: 'string', enum: ['incurred', 'billed', 'unavailable'] },
          totals: { $ref: '#/components/schemas/UsageFundingMetrics' },
          by_funding: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/UsageFundingMetrics' },
                { type: 'object', properties: { funding: { type: 'string', enum: ['local_gpu', 'platform_external', 'tenant_byo', 'unknown'] } } },
              ],
            },
          },
          rows: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/UsageFundingMetrics' },
                {
                  type: 'object',
                  properties: {
                    dims: { type: 'object', additionalProperties: { type: 'string', nullable: true } },
                    names: { type: 'object', additionalProperties: { type: 'string', nullable: true } },
                  },
                },
              ],
            },
          },
          truncated: { type: 'boolean' },
          names_unavailable: { type: 'object', properties: { projects: { type: 'boolean' }, actors: { type: 'boolean' } } },
        },
      },
      UsageFundingMetrics: {
        type: 'object',
        properties: {
          events: { type: 'integer' },
          input_tokens: { type: 'integer' },
          output_tokens: { type: 'integer' },
          cost_usd: { type: 'number', nullable: true },
        },
      },
      KnowledgeAreaEntry: {
        type: 'object',
        description:
          'One knowledge area of the caller tenant = one of its RM capabilities, with the ' +
          'tenant\'s card types in it.',
        required: ['area', 'title', 'card_types'],
        properties: {
          area: {
            type: 'string',
            description:
              'The RM capability name. THE VALUE WRITTEN TO THE API, never a display label.',
          },
          title: { type: 'string', description: 'The RM capability title (display label).' },
          card_types: {
            type: 'array',
            items: { type: 'string' },
            description: 'The tenant\'s card types in this capability.',
          },
        },
      },
      SetKnowledgeAreasBody: {
        type: 'object',
        description:
          'A member’s COMPLETE set of areas — a replacement, not a patch. That is what makes both ' +
          'PUTs idempotent (the same set twice writes nothing and returns `changed: false`) and why ' +
          '"remove an area" needs no second verb. `{"areas": []}` is a legal, meaningful body ' +
          'meaning "this member holds no areas"; the zod schema is deliberately NOT `.min(1)`.\n\n' +
          '⛔ `.strict()`: any property other than `areas` is a **422**, not a silently dropped ' +
          'field. A `tenant_id` smuggled into the body must fail loudly — the tenant comes from the ' +
          'request context and nowhere else.',
        required: ['areas'],
        properties: {
          areas: {
            type: 'array',
            maxItems: 15,
            items: {
              type: 'string',
              description:
                'A knowledge area. The permitted set is the 15 served by ' +
                'GET /api/tenant/knowledge-areas — NOT enumerated here on purpose (see the ' +
                'comment above KnowledgeAreaEntry). An unknown value is a 422 naming it, with ' +
                'the full permitted set in the response’s `allowed`.',
            },
          },
        },
      },
      ProjectAllocationEntry: {
        type: 'object',
        description:
          'One CANDIDATE for a project’s allocation — the whole tenant roster, not only the members ' +
          'already allocated. An editor listing only existing rows would render EMPTY on every ' +
          'project in the estate today, and an empty editor reads as "there is nobody to allocate" ' +
          'when the truth is "nobody has been allocated yet".\n\n' +
          '⚠️ TWO AREA LISTS, ANSWERING DIFFERENT QUESTIONS. `knowledge_areas` is the member’s ' +
          'STANDING, tenant-wide set (`member_knowledge_areas`). `project_knowledge_areas` is what ' +
          'they hold ON THIS PROJECT (`project_stakeholders`). A project allocation is deliberately ' +
          'NOT required to be a subset of the standing set.',
        required: ['id', 'email', 'name', 'resolved', 'knowledge_areas', 'project_knowledge_areas'],
        properties: {
          id: {
            type: 'string',
            description: 'Keycloak subject id of the member (`user_roles.user_id`, TEXT).',
          },
          email: { type: 'string', nullable: true, description: 'Null when the directory could not resolve the id — see `resolved`.' },
          name: { type: 'string', nullable: true },
          resolved: {
            type: 'boolean',
            description:
              'FALSE when the Keycloak lookup did not return this id (a dangling grant: deleted ' +
              'account, wrong realm). The row is STILL listed — hiding it would hide real access — ' +
              'and unresolved entries sort LAST so an id cannot read as a person you meant to pick. ' +
              'A directory outage makes every row `resolved: false` rather than blanking the list.',
          },
          knowledge_areas: { type: 'array', items: { type: 'string' }, description: 'Standing, tenant-wide areas. `[]` when the member has none recorded.' },
          project_knowledge_areas: { type: 'array', items: { type: 'string' }, description: 'Areas allocated on THIS project. `[]` when the member has no allocation row.' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {} as Record<string, Record<string, unknown>>,
  tags: [
    { name: 'System', description: 'System endpoints' },
    { name: 'Conveyor', description: 'Read-only conveyor taxonomy catalogue (vendored ncn roster)' },
    { name: 'Auth', description: 'Authentication endpoints' },
    { name: 'Billing', description: 'Usage and spend: per project, per member, split by funding (local GPU / platform-paid / tenant BYO)' },
    { name: 'Projects', description: 'Project management' },
    { name: 'Project Requests', description: 'Project requests: draft → submit → approve (promotes to a project through the one create door), reject, withdraw' },
    { name: 'Secrets', description: 'Secret management' },
    { name: 'Documents', description: 'Document management' },
    { name: 'Comments', description: 'Project comments' },
    { name: 'Approvals', description: 'Approval workflows' },
    { name: 'Webhooks', description: 'Webhook receivers for n8n callbacks' },
    { name: 'Metrics', description: 'Metrics and analytics' },
    { name: 'Streams', description: 'Asset authoring: publish an authored principle, requirement or decision' },
    { name: 'Cards', description: 'Card creation and card-scoped writes driven by the AA conveyor' },
    { name: 'Report', description: 'Reports (bug reports, status reports) and the append-only bug-fix records' },
    { name: 'Notifications', description: 'Outbound notification dispatch (Telegram, email, in-app, …)' },
    { name: 'GitHub App', description: 'Public GitHub App installs bound to a tenant' },
    { name: 'Internal', description: 'Service-to-service reads gated by a per-caller X-Internal-Token (x-internal; not typed-client ops)' },
    { name: 'Kanban', description: 'Planka card moves through fr: tenant-gated, DONE-guarded (computed pass required for the proof subset)' },
    { name: 'Kanban Assets', description: "The super_admin Planka passthrough (projects, boards, lists, cards, labels, task lists, tasks) as fr's one Planka account, with no tenant scoping; the DONE and bug-fix PARK guards still apply to a move." },
    { name: 'Decompositions', description: 'Split-family contract substrate: decision log, context bundles, card contracts' },
    { name: 'LLM Provider', description: 'Per-tenant BYO LLM provider settings (proxied to worker_management tenant-config)' },
    { name: 'Pricing', description: 'Owner pricing administration proxied to billing (FX rates)' },
    { name: 'Tenant Inference', description: 'Owner per-tenant inference set-up: IR policy read/activate and provisioning apply (setup, tiers, EUR budget, byo_mode)' },
    { name: 'Knowledge Areas', description: 'Who to ask, granting nothing: the derived 15-area vocabulary, a member\u2019s standing set, and per-project allocation' },
    // fr-agui P4a1: the capability-derived /api/assets/kag + /api/tools/kag operations.
    { name: 'KAG', description: 'Tenant knowledge graph: retrieval, graph reads and analytics, NLP/ML compute, ingestion (upload, scrape) and job control' },
    // fr-agui P4a2: the capability-derived /api/research/{discover,scientific} and /api/research/media operations.
    { name: 'Research', description: 'Research workspace: Discovery Engine (academic search, sessions, scoring, snowball, review exports, push to KAG) and Scientific Processor (verify, topology, explain, stats, formal proofs, pipeline, sandbox). Proxies over the KAG gateway, scoped to the request tenant. A refusal is `{ error, code? }` from fr (401 / coded 403 / 500) or `{ error: { code, message, upstream? } }` for fr\'s input refusals (400 BAD_REQUEST / BAD_PATH) and every relayed upstream failure: the upstream\'s 4xx passes through, its 401 / 5xx / an unreachable upstream is 502, a timeout 504.' },
    { name: 'Media', description: 'Media Discovery: media search, items, transcripts, scoring and collections (read and compute only). Same tenant scoping and refusal bodies as Research.' },
    // fr-agui P4a3: the capability-derived /api/assets/architecture and /api/assets/toc operations.
    { name: 'Architecture', description: 'Tenant enterprise architecture (ArchiMate): elements, relationships (immutable), views and standards. Proxies over requirements_management, scoped to the request tenant (409 MISSING_TENANT without one).' },
    { name: 'TOC', description: 'Theory-of-Constraints trees: trees, nodes, edges, the graph, the 8-CLR quality score and the tenant TOC settings. Proxies over requirements_management, scoped to the request tenant (409 MISSING_TENANT without one).' },
    { name: 'URL Credentials', description: "The caller's own credentials for scraped URLs, stored in secrets-service. GET by id returns the DECRYPTED credential (secret output)." },
    { name: 'Channels', description: "The workspace's channel registry (Teams, email, web, in-app, voice). Reads: any member of the request tenant; writes: workspace-admin. Channel credentials are write-only." },
    { name: 'Connectors', description: 'Scheduled-trigger connector dry-runs ("Test connection").' },
    { name: 'In-App Messages', description: "The caller's own in-app chat history (D9)." },
    // fr-agui P4b part 2: GET /api/tenant/members moved here from 'Knowledge Areas' (it lists the tenant's members).
    { name: 'Tenant', description: "The request tenant's own directory: its members (the approver picker), with their knowledge areas." },
    { name: 'Scheduled Triggers', description: "Cron-driven inbound work pulls (scheduled_intake) on the request tenant's continuous-flow projects, and their run audit log. Rows of another tenant are 404; a row's project department gates it (workspace-admin, or dept-member to read / dept-manager to write)." },
    { name: 'Suggested Schedules', description: 'The Suggestion Inbox actions: promote a suggested schedule into a scheduled trigger, or dismiss it.' },
    { name: 'Reporting', description: "Read-only reports: the caller's approval backlog, a worker's recent activity, an asset's version history." },
    { name: 'Workers', description: "The request tenant's worker registry (proxied to worker_management, 409 MISSING_TENANT without a request tenant). Reads: any member; registry writes: workspace-admin; the routes that spend the tenant's LLM key (message, providers, chat): workspace-admin or super_admin." },
    { name: 'Workflows', description: 'Read-only browsers over the PRODUCTION n8n workflow catalogue. Platform callers (super_admin, or an active platform tenant) see it; a customer tenant gets empty lists and the 404 an unknown id gets.' },
    // fr-agui P4b part 3.
    { name: 'Account', description: "The caller's own account: channel preferences, fr licences and tokens, the workspaces they can act in, and artifacts across the request tenant's projects." },
    { name: 'Repositories', description: "The caller's repository catalogue (keyed by the caller). Attaching a catalogue row to a project is a project operation." },
    { name: 'Bridge', description: "The analysis-to-kanban bridge: turn a producer's outputs (coding findings, KAG, artifacts) into draft kanban cards of a project in the request tenant, submit them for approval, commit. Mounted with FR_FEATURE_BRIDGE (the commit callback always)." },
    { name: 'Analytics', description: "Read-only rollups of the request tenant's activity (KPIs, breakdowns, per-channel sends, CSV export). Incurred cost is a super_admin's only." },
    // fr-agui P4c part 1.
    { name: 'Card Types', description: "The request tenant's card types, read from its requirements_management PM catalogue." },
    { name: 'Library', description: "The request tenant's library: the governed asset kinds (requirements, principles, decisions — proxied to requirements_management, the SYSTEM tenant's rows unioned in), the Library page's list surfaces (channels, triggers, workflows, KAG documents), and an asset's usage rollups and quality history. Reads and creates: any member; an in-place edit or delete of a governed asset: a workspace-admin, a super-admin, or a member on an asset created in their project." },
    { name: 'Asset Bindings', description: "Which projects of the request tenant an asset is bound to (bind, list, unbind). Any member may bind; binding is NOT ownership." },
    { name: 'Asset Scope', description: "Where the request tenant's library assets apply: the owns / override / block edges per scope." },
    { name: 'Traceability', description: "The request tenant's cross-domain traceability graph (requirements_management architecture relationships)." },
    { name: 'Measure', description: "Throughput, inventory and operating expense of the request tenant's streams. Incurred cost is a super_admin's only." },
    { name: 'Engagements', description: 'The delivery audit trail: where each approval / notification message was sent, and how it went. Callers see their own rows; a workspace-admin or super_admin also the active tenant\'s.' },
    { name: 'Departments', description: "The request tenant's departments and their members. Reads: any member; department writes: workspace-admin; member writes: workspace-admin or that department's dept-admin." },
    { name: 'Andon', description: "The GLOBAL andon cord: one switch that halts the platform conveyor across every workspace. Anyone signed in reads it (a customer tenant sees a neutral released cord); pulling, releasing and the drain / history views are a super_admin's." },
    { name: 'Katas', description: "The kata record: one attempt to fix the SYSTEM (a flow, a prompt, a tool or gate code) so a symptom seen in one project goes away for every project. A kata pauses the whole conveyor n8n while it runs. Super-admin and the conveyor licence only; no tenant role reaches these." },
    { name: 'Verification', description: 'Super-admin verification read models (served-model timeline, alerts): upstream payloads verbatim, one read-model block each. Invisible (404) to anyone else.' },
    { name: 'Control Tower', description: 'The super-admin platform control tower: composed read-model blocks that each degrade on their own. Invisible (404) to anyone else.' },
    // fr-agui P4c part 2.
    { name: 'Asset Console', description: "The operator view of the request tenant's library (principles, requirements, decisions), its projects, and the production n8n workflows. Reads: any signed-in member; writes: a workspace-admin of the request tenant, a super_admin in the system tenant." },
    { name: 'Platform Access', description: 'Who holds an fr role in which workspace, across every tenant, and the super-admin grant / revoke of those roles.' },
    // fr-agui P4c part 3 (the nine billing pricing-config routes join the existing 'Pricing' tag).
    { name: 'Licensing Console', description: "The super-admin licensing console: the licences service's admin API (apps, plans, regions, licences and their tokens, tenants and their BYO posture, offerings) proxied, plus the person typeahead and any tenant's token budget / top-up. Raw tokens are shown once." },
    { name: 'Early Access', description: 'Early-access signup v2: the website intake and the Telegram decision (service accounts only), and the super_admin onboarding queue + invite. Off unless FR_SIGNUP_ENABLED=true.' },
    { name: 'User Provisioning', description: 'The super-admin onboarding / offboarding of a person (and further seats) through the provisioning engine. One-time secrets (temporary password, licence tokens) are shown once.' },
    { name: 'AG-UI', description: 'The agent transport: the AG-UI invoke stream, the registry catalogue, agent sessions, agent threads and the agent chat loop (FR agent access token, not a Keycloak bearer, except where stated).' },
    { name: 'Coding', description: 'The coding spine over coding-gateway (containers, graphs, quality gate, dependency reports and scans, repository provisioning) and the coding analysis jobs.' },
    { name: 'Client Errors', description: 'The frontend error sink: unauthenticated by design, body-capped and rate-limited.' },
    // fr-agui P4d-2e.
    { name: 'Artifacts', description: "The artifact browser over artifact_service: the request tenant's artifacts, a manifest, an inline preview, the single-use download, and the human review of an n8n-produced artifact." },
  ],
};
