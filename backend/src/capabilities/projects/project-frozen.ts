// fr-agui SPEC §13 P4d-2a (part 2) — spec drain: the literal tag 'Projects' routes that ALREADY had an operation in the
// served spec (the openapi.ts literal), re-expressed as capabilities with NO behaviour change
// (`legacyHandler`), each literal operation VERBATIM in `openapi.frozen`
// (capabilities/frozen-routes.ts; the licence-door 403 and the pipeline's non-JSON 400 are the
// only edits, each where the literal declared neither that status nor a default).
//
// P4d-2e: `DELETE /api/projects/:id` (deleteProject, the last literal operation) joins this file;
// `POST /api/projects/:id/provision` had no operation and is a NEW one (project-routes.ts).
//
// Gates (the handlers', declared as the rule):
//   * validateAuth (its licence / conveyor doors) then `ctxTenantId` — the project read lane
//     (`loadProjectForRead`: status, brief[/versions], capabilities, plan,
//     repositories GET), the write lane (`loadTenantScopedProject`: card priority, repository
//     attach / detach / promote — whose repo rows must also be the caller's own), or the
//     resolved tenant (quality/analyze);
//   * `GET /api/projects/:id/brief` has a second door, X-Webhook-Secret (system, unscoped);
//   * constraint-check: `requireAnyInternalTenant` — one of the four internal workspaces.
// The project agent reads the brief, its versions, the plan and the repositories through its
// own actions (agui/actions/project-core.ts), which run these routes as the human — unchanged.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { routeRule } from '../library/_shared';
import {
  isAuthenticatedUserInInternalTenant,
  isAuthenticatedUserInResolvedTenant,
} from '../rbac-rules';

const PROJECT_FROZEN_ROUTES: FrozenRoute[] = [
  {
    id: 'projects.check_constraints', method: 'POST', path: '/api/projects/constraint-check', handler: 'handleConstraintCheck', effect: 'write',
    rule: routeRule(isAuthenticatedUserInInternalTenant),
    licenceOps: ["projects.constraintCheck"],
    source: { module: 'src/routes/project-constraint-check.ts', load: () => import('../../routes/project-constraint-check') },
    tenancy: 'tenant',
    frozen: {
      summary: "Check a pull request against its project's constraints (landing gate)",
      description:
        'Evaluates a GitHub PR\'s changed files (`GET /repos/{owner}/{repo}/pulls/{n}/files`, ' +
        'paginated, token minted by coding-github) against the project\'s stored ' +
        '`project_data.constraints` (services/constraint-check.ts). Called by n8n merge paths ' +
        'BEFORE merging. **FAIL-CLOSED CONTRACT:** merge only on **200** with `verdict` ' +
        '`pass` or `unchecked_only`; a 200 `violation` or ANY non-200 (401/404/422/502) must ' +
        'block the merge. Enforced kinds: no_language_version_change, pin_language_version, ' +
        'no_dependency_upgrades, no_new_dependencies, no_files_touched. `must_keep_api_compatible`, ' +
        '`custom` and legacy free-text constraints are NOT checked and are listed in `unchecked`. ' +
        'A manifest whose patch GitHub omitted, a malformed enforced constraint, or a PR at ' +
        'GitHub\'s 3000-file ceiling is a `violation` (cannot verify). Resolve the project by ' +
        '`project_id`, or by `card_id` (Planka card → board → `projects.planka_board_id`); ' +
        '`project_id` wins when both are given. By `card_id`: a card Planka does not know → ' +
        '**404**; a card whose board has NO fr project → **200** `verdict: pass`, ' +
        '`project_id: null`, `reason: no_project` (not an fr project, nothing to enforce); a board ' +
        'mapped to more than one project → **502** `ambiguous board→project mapping`. ' +
        'Dependency rules fail closed on changed dependency manifests whose format is not parsed ' +
        '(Gemfile, pom.xml, build.gradle, composer.json, *.csproj, …) and on changed ' +
        'requirements `-r`/`-c` include lines. Internal-tenant only ' +
        '(`requireAnyInternalTenant`): any other tenant gets **404, not 403**.',
      tags: ['Projects'],
      operationId: 'constraintCheck',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['owner', 'repo', 'pr_number'],
              properties: {
                project_id: {
                  type: 'string',
                  format: 'uuid',
                  description: 'Required unless `card_id` is given.',
                },
                card_id: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 64,
                  description: 'Planka card id; required unless `project_id` is given.',
                },
                owner: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$', maxLength: 100 },
                repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$', maxLength: 100 },
                pr_number: { type: 'integer', minimum: 1 },
                write_set_approval_id: {
                  type: 'string',
                  format: 'uuid',
                  description:
                    'U4 write-set fence: the approval whose sealed write set the PR must stay inside ' +
                    '(GET /api/approvals/{approvalId}/write-set). Send together with `changed_paths`; either ' +
                    'one without the other is a `diff_outside_write_set` violation (fail-closed).',
                },
                changed_paths: {
                  type: 'array',
                  maxItems: 6000,
                  items: { type: 'string', minLength: 1, maxLength: 1024 },
                  description:
                    'U4 write-set fence: added ∪ modified ∪ deleted ∪ rename-old ∪ rename-new paths. UNIONED with ' +
                    'the PR\'s own file list (filename + previous_filename), so omission cannot shrink the set.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Evaluation completed. Only `pass` / `unchecked_only` permit a merge.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'project_id',
                  'owner',
                  'repo',
                  'pr_number',
                  'files_checked',
                  'verdict',
                  'violations',
                  'unchecked',
                ],
                properties: {
                  project_id: {
                    type: 'string',
                    format: 'uuid',
                    nullable: true,
                    description: 'null only when `reason` is `no_project`.',
                  },
                  reason: {
                    type: 'string',
                    enum: ['no_project'],
                    description:
                      'Present only when resolved by `card_id` and the card\'s board has no fr project ' +
                      '(verdict is then `pass`, nothing was checked — unless a U4 fence input was sent, which is then ' +
                      'a `write_set_tenant_unresolved` violation).',
                  },
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  pr_number: { type: 'integer' },
                  files_checked: {
                    type: 'integer',
                    description: '0 when the project has no enforced constraints (the diff is not fetched).',
                  },
                  verdict: { type: 'string', enum: ['pass', 'violation', 'unchecked_only'] },
                  violations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['kind', 'file', 'detail'],
                      properties: {
                        kind: {
                          type: 'string',
                          description:
                            'The violated constraint kind, or `check_error` for a PR too large to verify. U4 fence: ' +
                            '`diff_outside_write_set` (an out-of-set non-test path — block; also every fail-closed ' +
                            'fence refusal, with file null), `write_set_test_path_mismatch` (every out-of-set path ' +
                            'is a test file — qa_needs_info; one violation per offending path), or ' +
                            '`write_set_tenant_unresolved` (block, file null: no project tenant to scope the ' +
                            'write-set read by — no_project board or tenantless project; the write set is never read, and no ' +
                            'token is minted and no GitHub call is made). ' +
                            'Write-set paths are matched by exact string equality, never glob-expanded.',
                        },
                        file: { type: 'string', nullable: true },
                        detail: { type: 'string' },
                      },
                    },
                  },
                  unchecked: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Constraint kinds present but not enforced (`must_keep_api_compatible`, `custom`, ' +
                      '`legacy_text`, `unrecognised`).',
                  },
                  write_set: {
                    type: 'object',
                    description: 'Present iff a U4 fence input was sent.',
                    required: ['approval_id', 'outcome', 'offending'],
                    properties: {
                      approval_id: { type: 'string', format: 'uuid', nullable: true },
                      outcome: {
                        type: 'string',
                        nullable: true,
                        enum: ['in_set', 'write_set_test_path_mismatch', 'diff_outside_write_set'],
                        description: 'null when the fence could not run (a violation is then listed).',
                      },
                      offending: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  fence: {
                    type: 'object',
                    description:
                      'Present iff the U4 fence RAN against the PR diff (a fence input was sent and a project ' +
                      'tenant resolved). Binds the verdict to a commit for the A5 landing signoff: `head_sha` is ' +
                      'GitHub\'s `pulls/{n}` `head.sha`, read immediately before AND after the file list — if ' +
                      'the two differ the check fails closed with **502**, so the SHA and the checked list are ' +
                      'one snapshot. ⚠️ A push AFTER the second read cannot be seen here: the verdict holds only ' +
                      'for `head_sha`. The merge MUST pin it — pass `head_sha` as coding-github ' +
                      '`POST /merge-pull-request` `sha`, which GitHub refuses if the head has moved — and the A5 ' +
                      'landing signoff must bind the same SHA. Never merge on this verdict without that pin.',
                    required: ['head_sha', 'checked_paths_count', 'write_set_approval_id', 'write_set_seal'],
                    properties: {
                      head_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                      checked_paths_count: {
                        type: 'integer',
                        minimum: 0,
                        description: '|changed_paths ∪ PR filename ∪ PR previous_filename|.',
                      },
                      write_set_approval_id: {
                        type: 'string',
                        format: 'uuid',
                        nullable: true,
                        description: 'null when the write set could not be read (a violation is then listed).',
                      },
                      write_set_seal: {
                        type: 'string',
                        pattern: '^[0-9a-f]{64}$',
                        nullable: true,
                        description: 'The re-verified seal of the write set checked; null when unreadable.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': {
          description: 'Missing or invalid bearer token',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '404': {
          description:
            'Project not found by `project_id`, card not found in Planka, OR the caller is not an internal tenant ' +
            '(404, not 403). Either way: do not merge.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '422': {
          description: 'Invalid JSON or body failed validation (`{ error: \'Validation error\', details }`)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '502': {
          description:
            'Upstream failure — coding-github token mint, GitHub files API, Planka card lookup, or an ' +
            'ambiguous board→project mapping (more than one project on the card\'s board). ' +
            'The check did not run: do not merge.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  },
  {
    id: 'projects.get_status', method: 'GET', path: '/api/projects/:id/status', handler: 'handleGetProjectStatus', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["projects.getProjectStatus"],
    frozen: {
      summary: 'Get project status',
      tags: ['Projects'],
      operationId: 'getProjectStatus',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Project status',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  project_id: { type: 'string' },
                  status: { type: 'string' },
                  workflow_status: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'projects.set_card_priority', method: 'PATCH', path: '/api/projects/:projectId/cards/:cardId/priority', handler: 'handlePatchProjectCardPriority', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/cards/priority.ts', load: () => import('../../routes/cards/priority') },
    frozen: {
      summary: "Set or clear a card's priority (audited)",
      description:
        "Writes or clears Metadata.priority on a card of this project's Planka board, through the same writer POST /api/cards/project uses. Callable by people and by the conveyor's identities alike. Every effective change appends one priority_change_events row (actor, time, card, from, to, priority_set_by) in the same transaction; a no-op records nothing. The server stamps Runtime State provenance on every effective change from the verified identity: priority_set_by = operator:<sub> (service account, or username starting system-/claude-/aa-) else human:<sub>; priority_base = the new value (cleared by a clear). Neither can be sent by the caller. A rule tag (rule, conveyor_rule) is 400 conveyor_rule_not_accepted: no conveyor priority path exists yet. Tenant-scoped: any member of the project's tenant may set it (P1-TEAM, no owner check); a super-admin acting in a SWITCHED workspace (X-Active-Tenant) must also own the project. A project outside the caller's tenant, or a switched-view project the caller does not own, is 404. The card must be on the project's board (404 card_not_found); a project with no board is 409 project_board_not_provisioned.",
      tags: ['Projects'],
      operationId: 'setProjectCardPriority',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'cardId', in: 'path', required: true, description: 'Planka card id', schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['priority'],
              additionalProperties: false,
              properties: {
                priority: {
                  type: 'string',
                  nullable: true,
                  description: 'null clears the field. A priority level of the owning tenant (requirements_management `priority-levels`): its id, or its name case-insensitively (e.g. `P1`). Any other value is 400 `invalid_priority` with the tenant levels in `details.allowed`.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Priority written (or cleared)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['card_id', 'priority'],
                properties: {
                  card_id: { type: 'string' },
                  priority: { type: 'string', nullable: true, description: 'The level\'s legacy text (RM name upper-cased).' },
                  priority_level_id: { type: 'string', format: 'uuid', nullable: true, description: 'The RM priority-level id (the value of record).' },
                },
              },
            },
          },
        },
        '400': { description: 'invalid_priority (incl. any key other than priority, e.g. priority_set_by / priority_base), or conveyor_rule_not_accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Project or card not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '409': { description: 'project_board_not_provisioned', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '502': { description: 'Planka read/write failed' },
      },
    },
  },
  {
    id: 'projects.get_brief', method: 'GET', path: '/api/projects/:id/brief', handler: 'handleGetProjectBrief', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["projects.getProjectBrief"],
    frozen: {
      "summary": "Get a project's project-start brief",
      "description": "The brief fields the project-start analysis consumes (problem/outcome framing, criteria, constraints, dependencies, risks). Two doors: X-Webhook-Secret (system, unscoped) or a bearer JWT scoped exactly as `GET /api/projects/{id}` — which already returns the whole row, so this is a subset of what the caller can read.",
      "tags": [
        "Projects"
      ],
      "operationId": "getProjectBrief",
      "security": [
        {
          "bearerAuth": []
        }
      ],
      "parameters": [
        {
          "name": "id",
          "in": "path",
          "required": true,
          "description": "fr project id",
          "schema": {
            "type": "string",
            "format": "uuid"
          }
        }
      ],
      "responses": {
        "200": {
          "description": "The brief",
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "project_id": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "project_type": {
                    "type": "string",
                    "nullable": true
                  },
                  "repository_url": {
                    "type": "string",
                    "nullable": true
                  },
                  "branch": {
                    "type": "string",
                    "nullable": true
                  },
                  "problem_statement": {
                    "type": "string",
                    "nullable": true
                  },
                  "desired_outcome": {
                    "type": "string",
                    "nullable": true
                  },
                  "business_case": {
                    "type": "string",
                    "nullable": true
                  },
                  "acceptance_criteria": {
                    "type": "array",
                    "items": {}
                  },
                  "success_criteria": {
                    "type": "array",
                    "items": {}
                  },
                  "target_packages": {
                    "type": "array",
                    "items": {}
                  },
                  "artifacts": {
                    "type": "array",
                    "items": {}
                  },
                  "scope_level": {
                    "type": "string",
                    "nullable": true
                  },
                  "constraints": {
                    "type": "array",
                    "items": {}
                  },
                  "constraints_text": {
                    "type": "string",
                    "nullable": true
                  },
                  "dependencies": {
                    "type": "array",
                    "items": {}
                  },
                  "risks": {
                    "type": "array",
                    "items": {}
                  }
                }
              }
            }
          }
        },
        "401": {
          "description": "Unauthorized",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Error"
              }
            }
          }
        },
        "404": {
          "description": "Project not found",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Error"
              }
            }
          }
        }
      }
    },
  },
  {
    id: 'projects.list_brief_versions', method: 'GET', path: '/api/projects/:id/brief/versions', handler: 'handleListProjectBriefVersions', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    frozen: {
      "summary": "List a project's brief versions (RM)",
      "description": "The project's brief versions in requirements_management, newest first, without the snapshots. Visibility exactly as `GET /api/projects/{id}` (or X-Webhook-Secret). Returns `{ data: { versions: [{version, author_kind, author_subject_id, note, created_at}], total, current_version } }`. 503 `rm_brief_unavailable` when RM is unreachable.",
      "tags": ["Projects"],
      "operationId": "listProjectBriefVersions",
      "security": [{ "bearerAuth": [] }],
      "parameters": [{ "name": "id", "in": "path", "required": true, "description": "fr project id", "schema": { "type": "string", "format": "uuid" } }],
      "responses": {
        "200": { "description": "The versions", "content": { "application/json": { "schema": { "type": "object" } } } },
        "404": { "description": "Project not found", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
        "409": { "description": "`rm_project_missing` / `rm_project_ambiguous`: the project's RM pm_project cannot be resolved", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
        "503": { "description": "requirements_management unavailable", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
      }
    },
  },
  {
    id: 'projects.get_brief_version', method: 'GET', path: '/api/projects/:id/brief/versions/:version', handler: 'handleGetProjectBriefVersion', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    frozen: {
      "summary": "Get one brief version (RM)",
      "description": "One full brief snapshot from requirements_management: `{ data: { version, author_kind, author_subject_id, note, created_at, project_id, brief } }`. Visibility exactly as `GET /api/projects/{id}`.",
      "tags": ["Projects"],
      "operationId": "getProjectBriefVersion",
      "security": [{ "bearerAuth": [] }],
      "parameters": [
        { "name": "id", "in": "path", "required": true, "description": "fr project id", "schema": { "type": "string", "format": "uuid" } },
        { "name": "version", "in": "path", "required": true, "description": "brief version (1-based)", "schema": { "type": "integer", "minimum": 1 } }
      ],
      "responses": {
        "200": { "description": "The version", "content": { "application/json": { "schema": { "type": "object" } } } },
        "404": { "description": "Project or version not found", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
        "409": { "description": "`rm_project_missing` / `rm_project_ambiguous`: the project's RM pm_project cannot be resolved", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
        "503": { "description": "requirements_management unavailable", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
      }
    },
  },
  {
    id: 'projects.get_capabilities', method: 'GET', path: '/api/projects/:id/capabilities', handler: 'handleGetProjectCapabilities', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    frozen: {
      "summary": "Get a project's capability selection (RM, read-only)",
      "description": "The capabilities the PM selected for the project in requirements_management (R260) and why, plus the selection history newest first. READ-ONLY: only the PM / n8n writes the selection; fr has no write path. Visibility exactly as `GET /api/projects/{id}` (or X-Webhook-Secret). Returns `{ data: { project_type, selected: [{name, capability_id, reason, approval_id, selected_at}], implicit, events: [{id, project_id, added, removed, approval_id, subject_id, created_at}], total_events } }`; a project with no selection yet answers empty `selected` / `events`. 503 `rm_capabilities_unavailable` when RM is unreachable.",
      "tags": ["Projects"],
      "operationId": "getProjectCapabilities",
      "security": [{ "bearerAuth": [] }],
      "parameters": [{ "name": "id", "in": "path", "required": true, "description": "fr project id", "schema": { "type": "string", "format": "uuid" } }],
      "responses": {
        "200": { "description": "The selection and its history", "content": { "application/json": { "schema": { "type": "object" } } } },
        "404": { "description": "Project not found", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
        "409": { "description": "`rm_project_missing` / `rm_project_ambiguous`: the project's RM pm_project cannot be resolved", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
        "503": { "description": "requirements_management unavailable", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
      }
    },
  },
  {
    id: 'projects.analyze_quality', method: 'POST', path: '/api/projects/:id/quality/analyze', handler: 'handleAnalyzeProjectQuality', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/project-quality.ts', load: () => import('../../routes/project-quality') },
    frozen: {
      summary: 'Analyze the project repositories (ensures a workspace per repo first)',
      description:
        'Returns 202 immediately. In the background, per repo (primary first, max 5): provision a workspace when the stamped container is missing or reaped (stamping repositories.container_name), queue coding-analysis POST /api/quality/analyze, and wait for a new stored result. Same authorisation as Provision. The in-flight state is process-local.',
      tags: ['Projects'],
      operationId: 'analyzeProjectQuality',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '202': { description: '{ data: { analysis } } — started' },
        '404': { description: 'Project not found in the active tenant' },
        '409': { description: 'An analysis is already in flight; body carries its state' },
      },
    },
  },
  {
    id: 'projects.list_repositories', method: 'GET', path: '/api/projects/:id/repositories', handler: 'handleListProjectRepositories', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["projects.listProjectRepositories"],
    source: { module: 'src/routes/project-repositories.ts', load: () => import('../../routes/project-repositories') },
    frozen: {
      summary: "List the project's attached repositories (primary first)",
      tags: ['Projects'],
      operationId: 'listProjectRepositories',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Membership list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectRepositoriesList' },
            },
          },
        },
      },
    },
  },
  {
    id: 'projects.attach_repository', method: 'POST', path: '/api/projects/:id/repositories', handler: 'handleAttachProjectRepository', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/project-repositories.ts', load: () => import('../../routes/project-repositories') },
    // Its own `req.json().catch(() => throw BadRequestError('invalid JSON body'))`: the same 400 body
    // the pipeline gives an unguarded read.
    nonJson400: true,
    frozen: {
      summary: 'Attach a repository to the project (existing repo_id or create-or-attach by url)',
      tags: ['Projects'],
      operationId: 'attachProjectRepository',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ProjectRepositoryAttachBody' },
          },
        },
      },
      responses: { '201': { description: 'Attached (idempotent on repeat)' } },
    },
  },
  {
    id: 'projects.detach_repository', method: 'DELETE', path: '/api/projects/:id/repositories/:repo_id', handler: 'handleDetachProjectRepository', effect: 'destructive',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/project-repositories.ts', load: () => import('../../routes/project-repositories') },
    frozen: {
      summary: 'Detach a repository from the project (not the primary)',
      tags: ['Projects'],
      operationId: 'detachProjectRepository',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'repo_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '204': { description: 'Detached' },
        '409': { description: 'Refused: cannot detach the current primary repository' },
      },
    },
  },
  {
    id: 'projects.promote_repository', method: 'PUT', path: '/api/projects/:id/repositories/:repo_id/primary', handler: 'handlePromoteProjectRepository', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/project-repositories.ts', load: () => import('../../routes/project-repositories') },
    frozen: {
      summary: 'Promote a repository to primary (transactional swap + cache stamp)',
      tags: ['Projects'],
      operationId: 'promoteProjectRepository',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'repo_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Promoted; cache columns re-stamped on the project row',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectRepositoriesList' },
            },
          },
        },
        '409': { description: 'Container not bound to any architecture element in this project' },
        '422': { description: 'Target repository has no container_name yet — provision first' },
      },
    },
  },
  {
    id: 'projects.get_plan', method: 'GET', path: '/api/projects/:id/plan', handler: 'handleGetProjectPlan', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/project-plan.ts', load: () => import('../../routes/project-plan') },
    frozen: {
      summary: "A project's phase plan with computed phase-exit facts",
      description:
        'U-TX-API-PLAN (fr#1482). For a PLAN project (started from a template): the plan phases in order ' +
        'with their exit-gate approval kinds, each phase\'s deliverables (cardinality, minter, deferred, ' +
        'minted_at/minted_count, attached card counts per board list, completion + reason), the current ' +
        'phase, and per phase `exit_ready` + `blockers` — display only: fr never advances a phase (n8n is the only writer, via PATCH /phase). A ' +
        'template-less project answers `{data: {legacy: true, reason: "legacy, no plan"}}`. Same auth and ' +
        'tenant scope as GET /api/projects/{id}/phase.',
      tags: ['Projects'],
      operationId: 'getProjectPlan',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        '200': { description: '{data: legacy marker | plan view}', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Project not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '409': { description: 'plan_unresolvable: the project has a template but its plan cannot be read', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '502': { description: 'card_states_unavailable: the board could not be read', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
      },
    },
  },
  // P4d-2e — the LAST literal operation. The literal object VERBATIM; the only edits are the measured
  // ones (frozen-routes.ts): the licence-door 403 (not allowlisted, declares no 403 / default) and
  // validateAuth's 401 (the literal declared none). The AG-UI `projects.archive` action is a separate
  // id and unchanged. Gate: validateAuth then `projectArchivableByTenantMember` (any member of the
  // project's tenant, P1-TEAM-a); another tenant's or an absent project is 404 'Project not found'.
  {
    id: 'projects.delete_project', method: 'DELETE', path: '/api/projects/:id', handler: 'handleDeleteProject', effect: 'destructive',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    unauthorized401: "validateAuth's 401 (`error`: 'Missing or invalid Authorization header' / 'Invalid or expired token').",
    frozen: {
      summary: 'Delete project',
      tags: ['Projects'],
      operationId: 'deleteProject',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '204': { description: 'Project deleted' },
        // Measured (post-drain): a non-uuid id is the pipeline's path-shape 400; another tenant's or an
        // absent project is the handler's 404 'Project not found'.
        '400': { description: 'The `id` is not a uuid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: "'Project not found' — absent, or another tenant's project", content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
];

export const PROJECT_FROZEN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities({ area: 'projects', tenancy: 'project', module: 'src/routes/projects.ts', load: () => import('../../routes/projects') }, PROJECT_FROZEN_ROUTES);
