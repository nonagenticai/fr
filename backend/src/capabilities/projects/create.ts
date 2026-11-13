// fr-agui SPEC §8.1 P0b — re-expressed as a capability, no behaviour change.
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
//
// ⛔ ONE DOOR (R3). The web route is `handleCreateProject` and the channel handler
// (agui/actions/projects-create.ts) reaches the same `createProjectCore`;
// tests/unit/routes/project-insert-single-door.test.ts stays unchanged.
//
// The agent input is the P0a create card's shape (`title`, not the route body's
// `name`); `createBodyFor` maps it. Unifying the two is a behaviour change, so it
// is not done here.
import { z } from 'zod';

import { ApprovalModeSchema } from '../../types/api';

import { defineCapability } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedTenantUser } from '../rbac-rules';

export const projectsCreateInput = z.object({
  title: z.string().trim().min(1).max(255).describe('The project name'),
  project_type: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('A startable project type NAME from conveyor.list_project_types (startable: true)'),
  description: z.string().max(5000).optional(),
  problem_statement: z.string().max(5000).optional().describe('What problem the project solves'),
  desired_outcome: z.string().max(5000).optional().describe('What success looks like'),
  repository_url: z.string().url().optional().describe('Optional primary repository URL'),
  approval_mode: ApprovalModeSchema.optional().describe(
    "Which sign-offs the user is asked for: 'brief_and_closure' (default: only the brief and the closure sign-off), 'autonomous' (nothing), 'auto_drafts' or 'all'. Set only when the user asks.",
  ),
});

export const projectsCreateOutput = z.object({
  project_id: z.string().uuid(),
  name: z.string(),
  project_type: z.string().nullable(),
  replayed: z.boolean(),
  url: z.string(),
});

export type ProjectsCreateInput = z.infer<typeof projectsCreateInput>;
export type ProjectsCreateOutput = z.infer<typeof projectsCreateOutput>;

export const projectsCreateCapability = defineCapability<ProjectsCreateInput, ProjectsCreateOutput>({
  id: 'projects.create',
  area: 'projects',
  summary:
    'Create a new project of a startable type. On the web this opens a create card the user ' +
    'reviews and confirms (the agent never creates it); never include tokens or secrets.',
  http: {
    method: 'POST',
    path: '/api/projects',
    operationId: 'createProject',
    idempotencyHeader: 'Idempotency-Key',
    successStatus: 201,
  },
  input: projectsCreateInput,
  output: projectsCreateOutput,
  errors: [
    { status: 503, code: 'conveyor_not_configured' },
    { status: 422, code: 'project_type_not_startable' },
  ],
  auth: { principal: 'user', rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) } },
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  conveyorGated: true,
  agent: {
    expose: true,
    tier: 'core',
    card: 'project-create',
    cronSafe: false,
    idempotencyKey: (i) => `projects.create:${i.project_type}:${i.title}`,
    channelPendingText: (input, ctx, approvalId) =>
      `Create ${input.project_type} project "${input.title}" in ${ctx.tenantName || ctx.tenantId || 'your workspace'}? ` +
      `Reply "approve ${approvalId}" to create it or "reject ${approvalId}" to cancel.`,
  },
  licence: { ops: ['projects.createProject'] },
  // Deliberately NOT autoApproveForInitiator: a chat `start` must park and be
  // confirmed by an explicit `approve <id>` (George OQ-7).
  approval: { type: 'single-approver', approver: 'initiator' },
  openapi: {
    frozen: {
        summary: 'Create new project',
        tags: ['Projects'],
        operationId: 'createProject',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectCreate' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Project created',
            content: {
              'application/json': {
                // The row (a superset of Project) PLUS the Planka board this create made —
                // handleCreateProject returns `{ ...project, planka: { boardId } }`.
                schema: { $ref: '#/components/schemas/ProjectCreateResponse' },
              },
            },
          },
          '503': {
            description:
              'conveyor_not_configured: this instance has no v4 conveyor wiring (REQUIREMENTS_SERVICE_TOKEN, ' +
              'CONVEYOR_START_WEBHOOK_URL, CONVEYOR_START_WEBHOOK_SECRET). Refused before any side effect.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } },
          },
        },
      },
  },
  /** Runs ONLY when a parked channel invocation is approved; the web never reaches it. */
  handler: lazyActionHandler(() => import('../../agui/actions/projects-create'), {
    module: 'src/agui/actions/projects-create.ts',
    exportName: 'projectsCreateChannelHandler',
  }),
  legacyHandler: lazyHandler(() => import('../../routes/projects'), {
    module: 'src/routes/projects.ts',
    exportName: 'handleCreateProject',
  }),
});
