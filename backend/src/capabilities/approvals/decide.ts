// fr-agui SPEC §8.1 P0b — re-expressed as a capability, no behaviour change.
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
//
// The human's governance act on an approval that ALREADY exists, so it never
// parks (`parking:'never'`, allowed for this id only — agui/registry.ts). Input is
// `DecideInput`, mapped to the route's `UpdateApprovalSchema` + the path
// parameter by `decideInputToUpdateBody` (SPEC §5.2, A-coverage row).
import { z } from 'zod';

import { DEBLOCK_ACTIONS } from '../../domain/engagement/deblock-actions';
import { defineCapability } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedTenantUser } from '../rbac-rules';

export const MIN_APPROVAL_ID_PREFIX = 8;

/** SPEC §5.2 "Decide input: ONE shape, ONE mapping". */
export const DecideInputSchema = z.object({
  approvalId: z
    .string()
    .trim()
    .min(MIN_APPROVAL_ID_PREFIX)
    .max(36)
    .describe('The approval id (full UUID, or a unique prefix of at least 8 characters)'),
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(10_000).optional(),
  reason: z.string().max(10_000).optional(),
  deblock_action: z.enum(DEBLOCK_ACTIONS).optional(),
  new_card_type: z.string().max(200).optional(),
  rejected_criterion_ids: z.array(z.string().max(200)).max(500).optional(),
  // The structured G-12 decision the web sends for a conveyor question (`execution.question`),
  // a feature-design approval and a bug-fix authorization; validated by the decision route's
  // U3 gates exactly as on the web (owner ruling 2026-10-31: every channel is equivalent).
  g12_decision: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Structured G-12 decision {rule_row, rule_version, inputs_hash, items[], reject_reason_code?}'),
  rejected_bug_ids: z.array(z.string().max(200)).max(500).optional(),
});
export type DecideInput = z.infer<typeof DecideInputSchema>;

export const decideOutputSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
  status: z.string(),
  httpStatus: z.number().int(),
});
export type DecideOutput = z.infer<typeof decideOutputSchema>;

export const approvalsDecideCapability = defineCapability<DecideInput, DecideOutput>({
  id: 'approvals.decide',
  area: 'approvals',
  summary:
    'Prepare a decision (approve / reject) on an existing approval. On the web this opens a decision ' +
    "card the user confirms; the web Copilot agent never decides. Over the mcp channel an agent member's " +
    "agent decisions are allowed and recorded as decided_by_kind='agent'.",
  http: { method: 'PUT', path: '/api/approvals/:approvalId', operationId: 'updateApproval' },
  input: DecideInputSchema,
  output: decideOutputSchema,
  errors: [],
  auth: { principal: 'user', rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) } },
  tenancy: 'tenant',
  effect: 'write',
  confirm: 'card',
  agent: {
    expose: true,
    tier: 'core',
    card: 'approval-decide',
    cronSafe: false,
    idempotencyKey: (i) => `approvals.decide:${i.approvalId}:${i.decision}`,
  },
  // Required by registerAction for a write; never used, because parking:'never'.
  approval: { type: 'single-approver', approver: 'initiator' },
  parking: 'never',
  openapi: {
    frozen: {
        summary: 'Update approval',
        tags: ['Approvals'],
        operationId: 'updateApproval',
        parameters: [
          {
            name: 'approvalId',
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
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['approved', 'rejected'] },
                  comment: { type: 'string' },
                  // handleUpdateApproval: "A reason is required when rejecting"
                  // (422). Without it in the spec no generated client can reject.
                  reason: {
                    type: 'string',
                    description: 'Required when status is `rejected` (422 otherwise). Optional on approve.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Approval updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Approval' },
              },
            },
          },
          // ⛔ routes/approvals.ts returns 202, not 200, when the n8n callback
          // outcome is not yet settled — `decisionOutcomeIsSettled` in
          // services/n8n-callback.ts treats only 'sent' and
          // 'skipped-no-callback-path' as settled; every other outcome
          // ('pending', 'timeout-unknown', 'failed', the other 'skipped-*'
          // values, 'not-attempted') is a 202. A strict schema-validating
          // client that only expects 200 would otherwise reject a legitimate
          // response. Same body shape as 200: the decision WAS recorded (the
          // approval_decisions row and the completing UPDATE both committed
          // before the callback was attempted), but the downstream card move
          // is not yet confirmed.
          '202': {
            description:
              'Decision recorded, downstream card move not yet confirmed. The approval ' +
              'decision has been durably persisted, but fr does not yet know whether the ' +
              'n8n callback that moves the card landed — reconciliation is owed. Not an ' +
              'error: retrying this decision will fail with 422 (already decided).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Approval' },
              },
            },
          },
          // fr-agui P4d-2a (P4-carry "From P4d-1" FROZEN gap): the 403 this route really
          // answers — the server's licence route door (`code` 'licence_route_not_allowed':
          // a licence never decides, lib/licence-route-allowlist.ts) before the handler,
          // and the decision guard's ForbiddenError (requester_is_decider, `.withCode(APPROVER_IS_REQUESTER_CODE)`).
          // Every one carries `code`, so the body is a CodedError, like the other frozen ops' door 403.
          '403': {
            description:
              "`code` 'licence_route_not_allowed' (a licence-shaped bearer; refused right after routing, before the " +
              "handler) or 'conveyor_route_forbidden' (validateAuth's conveyor door); or `code` 'APPROVER_IS_REQUESTER' " +
              '(the decision guard: the requester may not be recorded as its decider).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } },
          },
        },
      },
  },
  handler: lazyActionHandler(() => import('../../agui/actions/approvals-decide'), {
    module: 'src/agui/actions/approvals-decide.ts',
    exportName: 'channelDecide',
  }),
  legacyHandler: lazyHandler(() => import('../../routes/approvals'), {
    module: 'src/routes/approvals.ts',
    exportName: 'handleUpdateApproval',
  }),
});
