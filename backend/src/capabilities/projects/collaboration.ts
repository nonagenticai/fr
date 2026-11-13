// fr-agui SPEC §13 P4d-2a — spec drain: the project collaboration routes that ALREADY had an
// operation in the served spec (the openapi.ts literal) — metrics, bug reports (reads),
// documents, comments, knowledge areas and the caller's own identity reads — re-expressed as
// capabilities with NO behaviour change (`legacyHandler`), each literal operation VERBATIM in
// `openapi.frozen` (capabilities/frozen-routes.ts; the licence-door 403 is the one edit, where
// the route is off the licence allowlist and the literal declared neither a 403 nor a default).
//
// Gates (the handlers', declared as the rule):
//   * validateAuth (its licence / conveyor doors) then `ctxTenantId` — the project read lane
//     (`loadProjectForRead`), the write lane (`loadTenantScopedProject`), the tenant pin, or a
//     comment's author (PUT; DELETE also a tenant member allowed on the project);
//   * `PUT /api/workspace/members/:userId/knowledge-areas`: workspace-admin of the request
//     tenant (`requireWorkspaceAdmin`);
//   * `PUT /api/projects/:id/knowledge-allocation/:userId`: the project write lane, any member
//     of the project's tenant (George 2026-10-16), a licence refused;
//   * `GET /api/me/{project,approval}-workspaces`: any authenticated caller (the handler catches
//     validateAuth and answers its own 401).
// The project agent reads documents and comments through its own actions
// (agui/actions/project-assets.ts), which run these routes as the human.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { routeRule } from '../library/_shared';
import { isAuthenticatedUser, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { workspaceAdminRule } from '../settings/_shared';

const COLLABORATION_ROUTES: FrozenRoute[] = [
  {
    area: 'metrics', id: 'metrics.get_project', method: 'GET', path: '/api/projects/:projectId/metrics', handler: 'handleGetProjectMetrics', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["metrics.getProjectMetrics"],
    source: { module: 'src/routes/metrics.ts', load: () => import('../../routes/metrics') },
    tenancy: 'project',
    frozen: {
      summary: 'Get project metrics',
      tags: ['Metrics'],
      operationId: 'getProjectMetrics',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Project metrics',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      },
    },
  },
  {
    area: 'metrics', id: 'metrics.get_aggregate', method: 'GET', path: '/api/metrics/aggregate', handler: 'handleGetAggregateMetrics', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["metrics.getAggregateMetrics"],
    source: { module: 'src/routes/metrics.ts', load: () => import('../../routes/metrics') },
    frozen: {
      summary: 'Get aggregate metrics',
      tags: ['Metrics'],
      operationId: 'getAggregateMetrics',
      responses: {
        '200': {
          description: 'Aggregate metrics',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      },
    },
  },
  {
    area: 'reports', id: 'reports.list_bug_reports', method: 'GET', path: '/api/reports', handler: 'handleListReports', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["report.listBugReportsForCard"],
    source: { module: 'src/routes/reports.ts', load: () => import('../../routes/reports') },
    frozen: {
      summary: 'List reports in the caller\'s tenant',
      description:
        'project_reports rows, newest first (routes/reports.ts handleListReports). Tenant-scoped: NULL-tenant ' +
        'rows never match. `total` counts the whole matching population; `total_kind` says whether it is exact.',
      tags: ['Report'],
      operationId: 'listReports',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'type', in: 'query', required: false, description: 'report_type filter (e.g. bug_report, bug_fix, status)', schema: { type: 'string' } },
        { name: 'project_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
        { name: 'card_id', in: 'query', required: false, description: 'Planka card id', schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, description: 'Page size; default 20, capped at 200', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      ],
      responses: {
        '200': {
          description: 'One page of reports',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { type: 'object' } },
                  total: { type: 'integer', nullable: true },
                  total_kind: { type: 'string' },
                },
              },
            },
          },
        },
        '401': { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'reports', id: 'reports.get_bug_report', method: 'GET', path: '/api/reports/:reportId', handler: 'handleGetReport', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["report.getBugReport"],
    source: { module: 'src/routes/reports.ts', load: () => import('../../routes/reports') },
    frozen: {
      summary: 'Get one report',
      description:
        'The project_reports row itself, no envelope (routes/reports.ts handleGetReport). A missing, ' +
        'cross-tenant or non-uuid id is the same 404.',
      tags: ['Report'],
      operationId: 'getReport',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'reportId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': { description: 'The report row', content: { 'application/json': { schema: { type: 'object' } } } },
        '401': { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Report not found (absent, another tenant, or not a uuid)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'documents', id: 'documents.list_for_project', method: 'GET', path: '/api/projects/:id/documents', handler: 'handleListProjectDocuments', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["documents.listProjectDocuments"],
    source: { module: 'src/routes/documents.ts', load: () => import('../../routes/documents') },
    tenancy: 'project',
    frozen: {
      summary: 'List project documents',
      tags: ['Documents'],
      operationId: 'listProjectDocuments',
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
          description: 'List of documents',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  documents: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Document' },
                  },
                  total: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    area: 'documents', id: 'documents.upload', method: 'POST', path: '/api/documents/upload', handler: 'handleUploadDocument', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["documents.uploadDocument"],
    source: { module: 'src/routes/documents.ts', load: () => import('../../routes/documents') },
    // A non-multipart body: the handler's own catch around `req.formData()` (was fr's 500).
    nonJson400: { error: 'multipart/form-data body required', what: 'the body is not multipart/form-data' },
    frozen: {
      summary: 'Upload document',
      tags: ['Documents'],
      operationId: 'uploadDocument',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: {
                file: { type: 'string', format: 'binary' },
                project_id: {
                  type: 'string',
                  format: 'uuid',
                  nullable: true,
                  description:
                    'Optional. Omit for workspace-scoped knowledge (usable by all workflows in the tenant); set to pin the document to a specific project.',
                },
                send_to_kag: {
                  type: 'boolean',
                  default: true,
                  description:
                    'When false the document is parsed but NOT indexed into the knowledge graph.',
                },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Document uploaded',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Document' },
            },
          },
        },
      },
    },
  },
  {
    area: 'documents', id: 'documents.get_status', method: 'GET', path: '/api/documents/:id/status', handler: 'handleGetDocumentStatus', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["documents.getDocumentStatus"],
    source: { module: 'src/routes/documents.ts', load: () => import('../../routes/documents') },
    frozen: {
      summary: 'Get document status',
      tags: ['Documents'],
      operationId: 'getDocumentStatus',
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
          description: 'Document status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Document' },
            },
          },
        },
      },
    },
  },
  {
    area: 'comments', id: 'comments.list', method: 'GET', path: '/api/projects/:projectId/comments', handler: 'handleListComments', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["comments.listComments"],
    source: { module: 'src/routes/comments.ts', load: () => import('../../routes/comments') },
    tenancy: 'project',
    frozen: {
      summary: 'List project comments',
      tags: ['Comments'],
      operationId: 'listComments',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'page',
          in: 'query',
          schema: { type: 'integer', default: 1 },
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', default: 50 },
        },
      ],
      responses: {
        '200': {
          description: 'List of comments',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  comments: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Comment' },
                  },
                  total: { type: 'integer' },
                  page: { type: 'integer' },
                  limit: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    area: 'comments', id: 'comments.create', method: 'POST', path: '/api/projects/:projectId/comments', handler: 'handleCreateComment', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    nonJson400: true,
    licenceOps: ["comments.createComment"],
    source: { module: 'src/routes/comments.ts', load: () => import('../../routes/comments') },
    tenancy: 'project',
    frozen: {
      summary: 'Add comment to project',
      tags: ['Comments'],
      operationId: 'createComment',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['content'],
              properties: {
                content: { type: 'string' },
                mentions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      user_id: { type: 'string', format: 'uuid' },
                      username: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Comment created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Comment' },
            },
          },
        },
      },
    },
  },
  {
    area: 'comments', id: 'comments.update', method: 'PUT', path: '/api/comments/:commentId', handler: 'handleUpdateComment', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    nonJson400: true,
    source: { module: 'src/routes/comments.ts', load: () => import('../../routes/comments') },
    frozen: {
      summary: 'Update comment',
      tags: ['Comments'],
      operationId: 'updateComment',
      parameters: [
        {
          name: 'commentId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                content: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Comment updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Comment' },
            },
          },
        },
      },
    },
  },
  {
    area: 'comments', id: 'comments.delete', method: 'DELETE', path: '/api/comments/:commentId', handler: 'handleDeleteComment', effect: 'destructive',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/comments.ts', load: () => import('../../routes/comments') },
    frozen: {
      summary: 'Delete comment',
      tags: ['Comments'],
      operationId: 'deleteComment',
      parameters: [
        {
          name: 'commentId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '204': { description: 'Comment deleted' },
      },
    },
  },
  {
    area: 'knowledge_areas', id: 'knowledge_areas.list', method: 'GET', path: '/api/tenant/knowledge-areas', handler: 'handleListKnowledgeAreas', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/tenant/knowledge-areas.ts', load: () => import('../../routes/tenant/knowledge-areas') },
    frozen: {
      summary: 'List the knowledge-area vocabulary',
      description:
        'The caller tenant\'s knowledge areas = its requirements_management capabilities ' +
        '(sorted by name), each with its title and the tenant\'s card types in it. ' +
        '**This endpoint IS the source of truth for every `areas[]` value the two write paths ' +
        'accept** for that tenant.\n\n' +
        'A knowledge area says WHO TO ASK. It is **not an authority**: holding one grants ' +
        'nothing, authority lives in `user_roles` and nowhere else.\n\n' +
        'Authz: `validateAuth` — any authenticated member, reading its own (request) tenant. ' +
        '409 `catalogue_not_initialised` when the tenant has no PM catalogue.\n\n' +
        '⚠️ The envelope is `{items}` with **no `total`** (it would be `items.length` restated).',
      tags: ['Knowledge Areas'],
      operationId: 'listKnowledgeAreas',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description:
            'The tenant vocabulary, sorted by area name (a picker does not reshuffle between reads)',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['items'],
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeAreaEntry' } },
            },
          } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'knowledge_areas', id: 'knowledge_areas.set_member', method: 'PUT', path: '/api/workspace/members/:userId/knowledge-areas', handler: 'handleSetMemberKnowledgeAreas', effect: 'write',
    rule: workspaceAdminRule(),
    source: { module: 'src/routes/workspace/knowledge-areas.ts', load: () => import('../../routes/workspace/knowledge-areas') },
    frozen: {
      summary: 'Replace a member’s standing knowledge areas',
      description:
        'Records who to ask, tenant-wide, for one member. **Grants nothing** — the knowledge axis ' +
        'is separate from the authority axis (`user_roles`, CHECK-locked to `workspace-admin` | ' +
        '`workspace-member`), which is why this is a separate route and a separate file from the ' +
        'role grant/revoke endpoints.\n\n' +
        'Authz: `requireWorkspaceAdmin` — the tenant comes from the REQUEST CONTEXT, never the ' +
        'body or a param, and `super_admin` is deliberately excluded.\n\n' +
        '⛔ The target must ALREADY hold `workspace-admin` or `workspace-member` in this tenant, ' +
        'else **404**. Areas annotate an existing membership; without the check the endpoint ' +
        'writes a row that is invisible in `GET /api/tenant/members`, so the admin sees the save ' +
        '"succeed" and nothing change. It is not enforceable by a foreign key: `user_roles`’ ' +
        'unique key names a ROLE, and this fact is role-independent.',
      tags: ['Knowledge Areas'],
      operationId: 'setMemberKnowledgeAreas',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'userId',
          in: 'path',
          required: true,
          description:
            'Keycloak subject id of the member. `user_roles.user_id` and ' +
            '`member_knowledge_areas.user_id` are TEXT, so a legacy non-UUID subject is valid here ' +
            '(unlike PUT /api/projects/{id}/knowledge-allocation/{userId}, which needs a uuid).',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/SetKnowledgeAreasBody' } } },
      },
      responses: {
        '200': {
          description: 'The stored set, normalised (duplicates collapsed, sorted)',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['user_id', 'areas', 'changed'],
            properties: {
              user_id: { type: 'string' },
              areas: { type: 'array', items: { type: 'string' } },
              changed: {
                type: 'boolean',
                description:
                  'FALSE when the stored set already equalled the requested one. The honest report ' +
                  'of an idempotent write, and deliberately not an error.',
              },
            },
          } } },
        },
        '400': { description: 'Body was not valid JSON', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'workspace-admin role required in the active tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': {
          description:
            'The target holds no workspace role in this tenant. Grant `workspace-member` first (POST /api/workspace/members/{userId}/roles)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': {
          description:
            'Body failed validation — an unknown area, a non-array `areas`, or an extra property (`.strict()`). The response carries the permitted set in `allowed` and the zod issues in `details`',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['error', 'allowed'],
            properties: {
              error: { type: 'string' },
              allowed: {
                type: 'array',
                items: { type: 'string' },
                description: 'The 15 permitted areas, as served by GET /api/tenant/knowledge-areas.',
              },
              details: { type: 'array', items: { type: 'object' } },
            },
          } } },
        },
      },
    },
  },
  {
    area: 'knowledge_areas', id: 'knowledge_areas.set_project_allocation', method: 'PUT', path: '/api/projects/:id/knowledge-allocation/:userId', handler: 'handleSetProjectMemberKnowledgeAllocation', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/project-knowledge-allocation.ts', load: () => import('../../routes/project-knowledge-allocation') },
    tenancy: 'project',
    frozen: {
      summary: 'Replace one member’s knowledge allocation on a project',
      description:
        'Allocates a tenant member to this project for a set of areas — "just an update to the ' +
        'allocation", maintainable after the project has started. Full-set replacement, so it is ' +
        'idempotent and needs no delete verb.\n\n' +
        '⭐ `role` is part of `project_stakeholders`’ PRIMARY KEY, so changing an allocation is a ' +
        'DELETE plus an INSERT, not an UPDATE. Both run inside ONE transaction: a reader sees the ' +
        'old allocation or the new one, never a member holding neither, and a crash mid-change ' +
        'cannot leave it that way. The write is a minimal diff, so `added_at` on areas the admin ' +
        'did not touch keeps meaning "allocated since" instead of "last time somebody pressed ' +
        'Save".\n\n' +
        '⛔ Cannot read, write or delete `project_stakeholders` rows with role ' +
        '`execution_signoff`: a body naming a reserved stakeholder role is refused 403 ' +
        '`reserved_stakeholder_role`, and the read and the write are scoped to the tenant\'s area ' +
        'vocabulary (its RM capability names, minus reserved stakeholder roles).\n\n' +
        'Authz (George 2026-10-16, fr-agui P2-c1): ANY member of the project\'s tenant — the ' +
        'member write lane (`findTenantScopedProject` + `projectWritableByCaller`; an archived ' +
        'project is 409 `project_archived`); a licence caller is refused 403. The target must ' +
        'already hold a workspace role in the tenant that owns the project (else 404) — ' +
        '`project_stakeholders` is read by the execution-approval path, so an unknown subject ' +
        'there is not inert.',
      tags: ['Knowledge Areas'],
      operationId: 'setProjectMemberKnowledgeAllocation',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Project id. A malformed id answers 404, not 400.',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'userId',
          in: 'path',
          required: true,
          description:
            'Keycloak subject id, which here MUST be UUID-shaped: `project_stakeholders.user_id` ' +
            'is a `uuid NOT NULL` column (migration 074) while `user_roles.user_id` is TEXT. A ' +
            'legacy non-UUID subject is a legitimate tenant member who can hold standing areas ' +
            'but cannot be allocated to a project, and gets a 422 saying so rather than a bare ' +
            '500 from postgres 22P02.',
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/SetKnowledgeAreasBody' } } },
      },
      responses: {
        '200': {
          description: 'The stored allocation, normalised (duplicates collapsed, sorted)',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['project_id', 'user_id', 'areas', 'changed'],
            properties: {
              project_id: { type: 'string', format: 'uuid' },
              user_id: { type: 'string', format: 'uuid' },
              areas: { type: 'array', items: { type: 'string' } },
              changed: {
                type: 'boolean',
                description: 'FALSE when the stored allocation already equalled the requested one.',
              },
            },
          } } },
        },
        '400': { description: 'Body was not valid JSON', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: '`reserved_stakeholder_role` (the body names `execution_signoff`), or `licence_caller_refused`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': {
          description:
            'Project not found (absent, another tenant\'s, untagged, not a uuid — one answer), or the target holds no workspace role in the tenant that owns it',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': {
          description:
            'Body failed validation (unknown area, non-array `areas`, extra property), or `userId` is not UUID-shaped. The body-validation shape carries `allowed` and `details`; the uuid shape carries `detail` and `user_id`',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['error'],
            properties: {
              error: { type: 'string' },
              detail: { type: 'string' },
              user_id: { type: 'string' },
              allowed: { type: 'array', items: { type: 'string' } },
              details: { type: 'array', items: { type: 'object' } },
            },
          } } },
        },
      },
    },
  },
  {
    area: 'me', id: 'me.list_project_workspaces', method: 'GET', path: '/api/me/project-workspaces', handler: 'handleListMyProjectWorkspaces', effect: 'read',
    rule: routeRule(isAuthenticatedUser),
    source: { module: 'src/routes/me/project-workspaces.ts', load: () => import('../../routes/me/project-workspaces') },
    tenancy: 'self',
    frozen: {
      summary: 'Platform workspaces where the caller has projects (empty-state hint)',
      description:
        'fr row 14b. Backs the projects page empty state ("No projects in this workspace. ' +
        'Switch workspace"). Lists ONLY platform workspaces (isPlatformTenant) other than the ' +
        'active one, each with the count of non-archived projects the caller would see after ' +
        'switching. A customer workspace is never named or counted, for any caller.',
      tags: ['Auth'],
      operationId: 'listMyProjectWorkspaces',
      responses: {
        '200': {
          description: 'Platform workspaces with visible projects',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        project_count: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': { description: 'Unauthenticated' },
      },
    },
  },
  {
    area: 'me', id: 'me.list_approval_workspaces', method: 'GET', path: '/api/me/approval-workspaces', handler: 'handleListMyApprovalWorkspaces', effect: 'read',
    rule: routeRule(isAuthenticatedUser),
    source: { module: 'src/routes/me/approval-workspaces.ts', load: () => import('../../routes/me/approval-workspaces') },
    tenancy: 'self',
    frozen: {
      summary: 'Platform workspaces with pending approvals (approvals switch hint)',
      description:
        'fr row 14d. Backs the approvals page hint shown when the active workspace has nothing ' +
        'pending. Super-admin only (anyone else gets an empty list). Lists ONLY platform ' +
        'workspaces (isPlatformTenant) the X-Active-Tenant switch admits, other than the active ' +
        'one, each with its pending approval count. A customer workspace is never named or counted.',
      tags: ['Auth'],
      operationId: 'listMyApprovalWorkspaces',
      responses: {
        '200': {
          description: 'Platform workspaces with pending approvals',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        pending_count: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': { description: 'Unauthenticated' },
      },
    },
  },
  {
    area: 'me', id: 'me.get_current_user', method: 'GET', path: '/api/auth/me', handler: 'handleGetCurrentUser', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["auth.getCurrentUser"],
    source: { module: 'src/routes/auth.ts', load: () => import('../../routes/auth') },
    tenancy: 'self',
    frozen: {
      summary: 'Get current user',
      tags: ['Auth'],
      operationId: 'getCurrentUser',
      responses: {
        '200': {
          description: 'Current user details',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  preferred_username: { type: 'string' },
                  conveyor_configured: {
                    type: 'boolean',
                    description:
                      'Whether this instance has the v4 conveyor wiring (RM token + start webhook URL + secret). ' +
                      'False ⇒ project creation and the project-request flow answer 503 conveyor_not_configured.',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
];

export const PROJECT_COLLABORATION_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities({ area: 'projects', tenancy: 'tenant', module: 'src/routes/documents.ts', load: () => import('../../routes/documents') }, COLLABORATION_ROUTES);
