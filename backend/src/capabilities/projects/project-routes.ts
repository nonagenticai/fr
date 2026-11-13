// fr-agui SPEC §13 P4d-2a — spec drain: the project / cards / approvals routes that had NO
// operation in the served spec (pinned in LEGACY_UNDECLARED), re-expressed with NO behaviour
// change (`legacyHandler`). Every one is a NEW operation (operationId = camelCase(id)),
// `out-of-agent-scope`: the project agent reads the cockpit, the phase rail, the board, the
// documents list and an approval's document through its own hand-written actions, which run
// THESE routes as the human (agui/actions/project-core.ts, project-assets.ts) — unchanged.
//
// None of these routes is on the licence route allowlist: a licence bearer is refused 403
// `licence_route_not_allowed` right after routing, before the handler (DOOR_403).
//
// Gates (the handlers', declared as the rule): validateAuth (its licence / conveyor doors),
// then `ctxTenantId` — the frame tenant, else the JWT one — and the route's own lane:
//   * the project READ lane (`loadProjectForRead`): cockpit, phase, activity, board;
//   * the project WRITE lane (`loadTenantScopedProject`): PATCH (after the body checks);
//   * the project's tenant compared with the request tenant (`projectsInTenant` /
//     `reportingDomain.projectStatus`): asset bindings, the project status report;
//   * the approval's reach (`loadReachableApproval`): the approval document;
//   * the tenant pin only: my cards, recent activity, my documents (tenant OR mine), and the
//     owner of a document (DELETE).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { assetType } from '../../db/schema';
import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, caughtAuthResponses, frErrorBody, isoTime, standardResponses, unauthorizedBody } from '../account/_shared';
import { NO_TENANT_500 } from '../schedules/_shared';
import { suggestion } from '../schedules/suggested-schedules';
import { LICENCE_ROUTE_DOOR_403, pathId, preHandlerRefusalBody, routeRule, settingsCapabilities } from '../settings/_shared';
/** The cockpit v2 panel envelope (services/cockpit/panel.ts). */
const panelOf = (data: z.ZodTypeAny) =>
  z.object({
    data: data.nullable(),
    as_of: z.string().nullable(),
    health: z.enum(['ok', 'degraded', 'down']),
    down_since: z.string().optional(),
    detail_code: z.string().optional(),
  });

const rule = routeRule(isAuthenticatedUserInResolvedTenant);
const projectId = (name: string) =>
  z.object({ [name]: pathId("Project id (a uuid; a malformed id is the same 404 as an absent project)") });

const PROJECT_404 = "404: `error` 'Project not found' (absent, malformed id, or not readable in the request tenant). ";
const ARCHIVED_409 = "409: `code` 'project_archived' (writes to an archived project are refused). ";
const RM_409 =
  "409: `code` 'project_tenant_unknown', 'rm_project_missing', 'rm_project_ambiguous', 'project_type_missing', " +
  "'project_type_not_in_catalogue' or 'catalogue_not_initialised' (`details`); requirements_management unreachable or " +
  "failing: its relayed status in the integration envelope (`error.code`). ";
const PLANKA =
  "Planka failing: `error` (safe text, `message`/`details` for a validation refusal) with its status mapped — 400, 401, 403, " +
  '429, or 502 (Planka unreachable, the agent credential refused). ';
const COUNT =
  "`total` / `total_kind` ('exact' | 'at_least' | 'unknown') follow the count headers (X-Total-Relation, X-Truncated, …). ";

/** A `serializeCount` envelope over `item` rows. */
const counted = (item: z.ZodTypeAny) =>
  z.object({ data: z.array(item), total: z.number().int().nullable(), total_kind: z.enum(['exact', 'at_least', 'unknown']) });

const activityRow = z.object({
  id: z.string().describe("Prefixed by its source ('approval-decision:', 'comment:', 'report:')."),
  actor: z.string().nullable().describe('A display name when it resolves, else the raw id or text (e.g. n8n).'),
  verb: z.string(),
  target: z.string(),
  ts: isoTime,
});

const railNode = z.object({
  phase: z.string(),
  label: z.string(),
  state: z.enum(['done', 'active', 'gate', 'upcoming']),
  isGate: z.boolean(),
  gate_kinds: z.array(z.string()).optional(),
});

const projectRow = z
  .object({ id: z.string(), name: z.string(), status: z.string(), project_data: z.unknown() })
  .passthrough()
  .describe('The `projects` row as stored.');

const plankaLabel = z.object({ id: z.string(), name: z.string().nullable(), color: z.string() }).passthrough();

const documentRow = z
  .object({
    id: z.string(),
    project_id: z.string().nullable(),
    user_id: z.string(),
    filename: z.string(),
    file_size: z.number().int(),
    mime_type: z.string(),
    status: z.string().describe("pending | processing | completed | failed | rejected | parsed"),
    error_message: z.string().nullable().describe('Client-safe text.'),
    tenant_id: z.string(),
    created_at: isoTime,
  })
  .passthrough();

const ROUTES_MODULE = (m: string, load: () => Promise<Record<string, unknown>>) => ({ module: `src/routes/${m}.ts`, load });

export const PROJECT_ROUTE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...settingsCapabilities(
    { area: 'projects', tag: 'Projects', tenancy: 'project', rule, ...ROUTES_MODULE('project-cockpit', () => import('../../routes/project-cockpit')) },
    [
      {
        id: 'projects.get_cockpit', method: 'GET', path: '/api/projects/:id/cockpit', handler: 'handleGetProjectCockpit',
        summary: "A project's cockpit: status, actions waiting on people, lifecycle rail, cards, approvals, flows, cost", effect: 'read',
        description:
          'Every panel is `{ data, as_of, health: ok|degraded|down, down_since?, detail_code? }`: a source that fails or is ' +
          'slow degrades its own panel (its last known value, or `down`), never the whole answer. `detail_code` is a short ' +
          'machine code, never an upstream message. `scope=header` returns only `project` and `status`.',
        input: z.object({
          ...projectId('id').shape,
          scope: z.enum(['full', 'header']).optional().describe("'header' = only the project and status panels (default 'full')."),
        }),
        output: z
          .object({
            scope: z.enum(['full', 'header']),
            ...Object.fromEntries(['project', 'status'].map((k) => [k, panelOf(z.unknown())])),
          })
          .passthrough(),
        responses: standardResponses(PROJECT_404 + 'An upstream failure that escapes a block: the integration envelope. '),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'projects', tag: 'Projects', tenancy: 'project', rule, ...ROUTES_MODULE('projects', () => import('../../routes/projects')) },
    [
      {
        id: 'projects.get_phase', method: 'GET', path: '/api/projects/:id/phase', handler: 'handleGetProjectPhase',
        summary: "A project's phase and its lifecycle rail (owned by requirements_management; read-only)", effect: 'read',
        input: projectId('id'),
        output: z.object({
          project_id: z.string(),
          phase: z.string().nullable(),
          phase_updated_at: z.string().nullable(),
          next_gate: z.string().nullable(),
          nodes: z.array(railNode).describe('[] when the phase is not on the rail (or the plan is unresolvable).'),
        }),
        responses: standardResponses(PROJECT_404 + RM_409),
      },
      {
        id: 'projects.patch', method: 'PATCH', path: '/api/projects/:id', handler: 'handlePatchProject',
        summary: 'Edit a project (accepts NO field: requirements_management owns them after the project request)', effect: 'write',
        description:
          'The body is checked BEFORE the project is read: a non-JSON body is 400, a requirements_management-owned key is 422 ' +
          "(`details.code` 'rm_owned_field', `details.fields`), any other key is 422 'Validation error'. Only `{}` passes, and " +
          'writes nothing: the answer is the stored row.',
        input: z.object({ id: pathId('Project id') }).strict(),
        output: projectRow,
        responses: standardResponses(
          "400: `error` 'invalid JSON body'. 422: `error` 'requirements_management owns … — fr accepts no edit' " +
            "(`details.code` 'rm_owned_field', `details.fields`) or 'Validation error' (`details`). " +
            PROJECT_404 +
            ARCHIVED_409,
        ),
      },
      // P4d-2e — the last LEGACY_UNDECLARED project route. The AG-UI `projects.provision` action
      // (agui/actions/project-outputs.ts, a capability-invoke card) is a separate id and unchanged.
      {
        id: 'projects.provision_container', method: 'POST', path: '/api/projects/:id/provision', handler: 'handleProvisionProject',
        summary: "(Re)provision the project's code container on coding-gateway and initialise its graph", effect: 'write',
        description:
          'Reads NO body. Write lane (`loadTenantScopedProject`). A project with no `repository_url` is 200 with `provision: ' +
          "{ status: 'not_applicable', reason: 'no_repository' }` and nothing is called or written. Otherwise coding-gateway " +
          'provisions the container (idempotent: the same slug returns the existing one); the graph initialisation and the deep ' +
          'codebase analysis are best-effort (`graph_init_warning` / `analysis_warning`, never a failure). The answer is the ' +
          'updated `projects` row.',
        input: z.object({ id: pathId('Project id') }),
        output: projectRow.extend({
          provision: z.object({ status: z.literal('not_applicable'), reason: z.literal('no_repository') }).optional(),
          graph_init_warning: z.string().nullable().optional(),
          analysis_warning: z.string().nullable().optional(),
        }),
        responses: [
          ...standardResponses(
            PROJECT_404 +
              ARCHIVED_409 +
              "The provision call failing: `error` 'provision_failed' with `code`, `permanent`, `detail`, `message`, `status` (and " +
              "`branch` / `repository` when the upstream named them), at coding-gateway's 4xx/5xx status, else 502. ",
          ),
          // Not on the licence route allowlist: a licence bearer is refused before the handler (measured).
          { status: 403, description: `${LICENCE_ROUTE_DOOR_403} Or a request-context refusal (\`code\`), before routing.`, schema: preHandlerRefusalBody },
        ],
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'activity', tag: 'Projects', tenancy: 'tenant', rule, ...ROUTES_MODULE('dashboard', () => import('../../routes/dashboard')) },
    [
      {
        id: 'projects.list_activity', method: 'GET', path: '/api/projects/:projectId/activity', handler: 'handleProjectActivity',
        tenancy: 'project',
        summary: "A project's recent activity (approval decisions, comments, reports), newest first", effect: 'read',
        input: projectId('projectId').extend({
          limit: z.coerce.number().int().optional().describe('Default 20, clamped to 1..50 (a non-number is the default).'),
        }),
        output: counted(activityRow),
        responses: caughtAuthResponses({ status: '401' }, COUNT + PROJECT_404),
      },
      {
        id: 'activity.list_recent', method: 'GET', path: '/api/activity', handler: 'handleListRecentActivity',
        summary: "The request tenant's recent activity (approval decisions), newest first", effect: 'read',
        input: z.object({
          limit: z.coerce.number().int().optional().describe('Default 10, clamped to 1..50 (a non-number is the default).'),
        }),
        output: counted(activityRow),
        responses: caughtAuthResponses({ status: '401' }, COUNT),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'cards', tag: 'Cards', tenancy: 'tenant', rule, ...ROUTES_MODULE('dashboard', () => import('../../routes/dashboard')) },
    [
      {
        id: 'cards.list_mine', method: 'GET', path: '/api/cards', handler: 'handleListMyCardsAcrossProjects',
        summary: "The caller's cards across the request tenant's boards, in the named lists", effect: 'read',
        description: 'Reads at most 32 active boards of the tenant (as the Planka agent), keeping cards the caller is a member of.',
        input: z.object({
          assignee: z.literal('me').describe("Required, and only 'me' (else 400 `error` 'unsupported_assignee', `detail`)."),
          list: z.string().optional().describe('Comma-separated list names (case-insensitive); empty answers no cards.'),
        }),
        output: counted(
          z.object({
            id: z.string(),
            list: z.string().describe('The list name, upper-cased.'),
            name: z.string(),
            boardId: z.string(),
            listId: z.string(),
            projectId: z.string().nullable(),
            streamId: z.string(),
            dueDate: z.string().nullable(),
            position: z.number().nullable(),
            type: z.string(),
          }),
        ),
        responses: caughtAuthResponses(
          { status: '401' },
          COUNT + "400: `error` 'unsupported_assignee' (`detail`). Every board (or card) read failing: " + PLANKA,
        ),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'projects', tag: 'Projects', tenancy: 'project', rule, ...ROUTES_MODULE('assets/bindings', () => import('../../routes/assets/bindings')) },
    [
      {
        id: 'projects.list_asset_bindings', method: 'GET', path: '/api/projects/:project_id/asset-bindings', handler: 'handleListProjectBindings',
        summary: 'The assets bound to a project, by kind', effect: 'read',
        input: z.object({ project_id: pathId('Project id (a strict uuid, else 400)') }),
        output: z.object({
          data: z.object(
            Object.fromEntries(
              assetType.enumValues.map(
                (k) => [k, z.array(z.string()).describe('Bound asset ids (always present, possibly empty).')],
              ),
            ),
          ),
        }),
        responses: standardResponses(
          "400: `error.code` 'BAD_REQUEST' ('invalid project_id'). 404: `error.code` 'NOT_FOUND' ('project not found': absent, " +
            'or not a project of the request tenant). ',
        ),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'projects', tag: 'Kanban', tenancy: 'project', rule, ...ROUTES_MODULE('kanban/index', () => import('../../routes/kanban')) },
    [
      {
        id: 'projects.get_board', method: 'GET', path: '/api/projects/:id/kanban', handler: 'handleGetProjectKanban',
        summary: "A project's kanban board: its lists, cards and labels (read as the Planka agent)", effect: 'read',
        description: 'No board linked: `{ board: null, message }`; a board Planka no longer has: `{ board: null, stale: true, message }`.',
        input: projectId('id'),
        output: z
          .object({
            project_id: z.string().optional(),
            board: z.object({ id: z.string(), name: z.string(), projectId: z.string() }).passthrough().nullable(),
            stale: z.literal(true).optional(),
            message: z.string().optional(),
            lists: z.array(z.object({ id: z.string(), name: z.string(), position: z.number() }).passthrough()).optional(),
            cards: z
              .array(
                z
                  .object({
                    id: z.string(),
                    name: z.string(),
                    description: z.string().nullable(),
                    listId: z.string(),
                    boardId: z.string(),
                    position: z.number(),
                    dueDate: z.string().nullable(),
                    labels: z.array(plankaLabel),
                    memberIds: z.array(z.string()),
                  })
                  .passthrough(),
              )
              .optional(),
            labels: z.array(plankaLabel).optional(),
          })
          .passthrough(),
        responses: standardResponses(PROJECT_404 + PLANKA),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'approvals', tag: 'Approvals', tenancy: 'tenant', rule, ...ROUTES_MODULE('approvals', () => import('../../routes/approvals')) },
    [
      {
        id: 'approvals.get_document', method: 'GET', path: '/api/approvals/:approvalId/document', handler: 'handleGetApprovalDocument',
        summary: 'The document an approval asks the approver to review (its stored bytes)', effect: 'read',
        description:
          'Only a document-upload approval (`kag.upload_document[_sync]`) carries one. Served inline with its stored content type, ' +
          '`Content-Disposition: inline; filename=…`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.',
        input: z.object({ approvalId: pathId('Approval id (a strict uuid; anything else is 404)') }),
        output: z.unknown().describe('The document bytes.'),
        responseContentType: 'application/octet-stream',
        responses: standardResponses(
          "404: `error` 'Approval not found' (absent, malformed id, another tenant's, or a project approval the caller is " +
            "neither requester, roster member nor project member of) or 'No document for this approval'. ",
        ),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'documents', tag: 'Documents', tenancy: 'tenant', rule, ...ROUTES_MODULE('documents', () => import('../../routes/documents')) },
    [
      {
        id: 'documents.list', method: 'GET', path: '/api/documents', handler: 'handleListUserDocuments',
        summary: "The documents of the request tenant, and the caller's own", effect: 'read',
        description: '`total` is the number of `items` (not paged).',
        input: z.object({
          project_id: z.string().optional().describe('Only this project’s documents (a filter: a malformed id is 400).'),
        }),
        output: z.object({ items: z.array(documentRow), total: z.number().int() }),
        responses: standardResponses("400: `error` 'invalid request parameter' (a malformed `project_id`). "),
      },
      {
        id: 'documents.delete', method: 'DELETE', path: '/api/documents/:id', handler: 'handleDeleteDocument',
        summary: 'Delete one of your documents (its data is purged from KAG first)', effect: 'destructive',
        description:
          'Owner only. The KAG copy is purged BEFORE the row is deleted; a failed purge deletes nothing (502, retry). Answers ' +
          '200 `{ id, deleted: true }`.',
        input: z.object({ id: pathId("Document id (a uuid; anything else is 404)") }),
        output: z.object({ id: z.string(), deleted: z.literal(true) }),
        responses: standardResponses(
          "404: `error` 'Document not found' (absent, malformed id, or not yours). 409: `error` 'Document cannot be deleted: it " +
            "predates tenant capture …' (`details.reason` 'tenant_not_recorded'). 502: `error` 'Failed to purge document data from " +
            "KAG; document not deleted. Please retry.' (`details`). ",
        ),
      },
    ],
  ),
  ...settingsCapabilities(
    { area: 'reports', tag: 'Reporting', tenancy: 'project', rule, ...ROUTES_MODULE('reports/index', () => import('../../routes/reports/index')) },
    [
      {
        id: 'reports.get_project_status', method: 'GET', path: '/api/reports/project-status/:projectId', handler: 'handleProjectStatusReport',
        summary: "A project's status report: the project, open approvals, recent decisions, board progress", effect: 'read',
        input: z.object({ projectId: pathId('Project id (a uuid, else 400)') }),
        output: z.object({
          data: z.object({
            project: projectRow,
            openApprovals: z.array(z.object({ id: z.string(), project_id: z.string().nullable(), description: z.string(), status: z.string(), created_at: isoTime }).passthrough()),
            recentDecisions: z
              .array(
                z.object({
                  approval_id: z.string(),
                  approver_id: z.string(),
                  approver_name: z.string().nullable(),
                  decision: z.string(),
                  decided_at: isoTime,
                  comment: z.string().nullable(),
                  decided_by_kind: z.enum(['human', 'triage_agent', 'rule', 'agent']).describe('Who decided: a person, the Claude triage agent, an fr rule (migration 211), or an agent member (migration 220).'),
                }),
              )
              .describe('At most 25, newest first.'),
            boardProgress: z
              .object({ lists: z.array(z.object({ id: z.string(), name: z.string(), cardCount: z.number().int().nullable(), cardCountComplete: z.boolean() })) })
              .nullable()
              .describe('null when the project has no board.'),
          }),
        }),
        responses: standardResponses(
          "400: `error` 'projectId must be a UUID'. 404: `error` 'Project not found' (absent, or not a project of the request " +
            'tenant). Every board read failing: ' +
            PLANKA,
        ),
      },
    ],
  ),
  ...settingsCapabilities(
    {
      area: 'suggested_schedules', tag: 'Suggested Schedules', tenancy: 'project', rule,
      ...ROUTES_MODULE('suggested-schedules', () => import('../../routes/suggested-schedules')),
    },
    [
    {
      id: 'suggested_schedules.list_for_project', method: 'GET', path: '/api/projects/:projectId/suggested-schedules',
      handler: 'handleListSuggestedSchedules', tenancy: 'project',
      summary: "One project's suggested schedules (its Suggestion Inbox)", effect: 'read',
      description: 'Newest first. `total` is the number of `items` (the list is not paged).',
      input: z.object({
        projectId: pathId('Project id (a uuid; anything else is the same 404 as an absent project)'),
        status: z.enum(['new', 'accepted', 'dismissed']).optional().describe('Filter by status; any other value is 400.'),
      }),
      output: z.object({ items: z.array(suggestion), total: z.number().int() }),
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        {
          status: 'default',
          description:
            "404: `error` 'project_id does not exist' (absent, malformed id, or another tenant's project). " +
            "403: `error` 'dept-role required on department …' / \"dept-role 'dept-member' or higher required …\" (the project's " +
            "department gate; a workspace-admin passes). 400: `error` 'invalid status filter: … (expected new|accepted|dismissed)'. " +
            `${DOOR_403} ${NO_TENANT_500}`,
          schema: frErrorBody,
        },
      ],
    },
    ],
  ),
];

