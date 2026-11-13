// fr-agui SPEC §13 P4d-2a — spec drain: the approvals routes that ALREADY had an operation in
// the served spec (the openapi.ts literal), re-expressed as capabilities with NO behaviour
// change (`legacyHandler`), each literal operation VERBATIM in `openapi.frozen`
// (capabilities/frozen-routes.ts; the licence-door 403 is the one edit, where the route is
// off the licence allowlist and the literal declared neither a 403 nor a default).
//
// Not here: `approvals.decide` (PUT /api/approvals/:approvalId, P0b, ./decide.ts) and the
// approval's document read (`approvals.get_document`, a NEW operation: ./approval-document.ts).
//
// Gates (the handlers', declared as the rule):
//   * validateAuth (its licence / conveyor doors) then `ctxTenantId` — the project lane
//     (`loadProjectForRead` / `loadTenantScopedProject`) or the approval's tenant + reach;
//   * the licence-ONLY reads/fence (lib/licence-door.ts `requireLicenceCaller`): a licence
//     with a tenant, else 401 — on the licence allowlist;
//   * mint-design-units: the EXECUTION tenant only (403 `mint_design_units_exec_only`);
//   * void / stranded: a super-admin (`isSuperAdmin`); void also refuses a licence first.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { routeRule } from '../library/_shared';
import {
  isAuthenticatedSuperAdmin,
  isAuthenticatedUserInExecutionTenant,
  isAuthenticatedUserInResolvedTenant,
  isLicenceCallerWithTenant,
} from '../rbac-rules';

const APPROVAL_ROUTES: FrozenRoute[] = [
  {
    id: 'approvals.list_for_project', method: 'GET', path: '/api/projects/:projectId/approvals', handler: 'handleListApprovals', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["approvals.listApprovals"],
    tenancy: 'project',
    frozen: {
      summary: 'List project approvals',
      tags: ['Approvals'],
      operationId: 'listApprovals',
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
          description: 'List of approvals',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  approvals: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Approval' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'approvals.create', method: 'POST', path: '/api/projects/:projectId/approvals', handler: 'handleCreateApproval', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    nonJson400: true,
    licenceOps: ["approvals.createApproval"],
    tenancy: 'project',
    frozen: {
      summary: 'Create approval request',
      tags: ['Approvals'],
      operationId: 'createApproval',
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
              required: ['description', 'required_approvers'],
              properties: {
                description: { type: 'string', minLength: 1, maxLength: 2000 },
                change_summary: { type: 'string' },
                impact_analysis: { type: 'string' },
                required_approvers: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    required: ['user_id'],
                    properties: {
                      user_id: { type: 'string', format: 'uuid' },
                      role: { type: 'string' },
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
          description: 'Approval created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Approval' },
            },
          },
        },
      },
    },
  },
  {
    id: 'approvals.list_all', method: 'GET', path: '/api/approvals/all', handler: 'handleListAllApprovals', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["approvals.listAllApprovals"],
    frozen: {
      summary: 'List every approval the caller can see, across projects',
      description:
        'Cross-project approvals in the caller\'s active tenant, newest first, in one query (routes/approvals.ts ' +
        'handleListAllApprovals). Default population = four lanes: project-bound rows on projects the caller ' +
        'owns (or, for a super-admin in a switched view, every project of that tenant), rows the caller is ' +
        'rostered on, rows the caller requested, and null-project (n8n / KAG worker) rows. `actionable=1` ' +
        'narrows to the rostered lane alone. `scope` + `scope_lanes` say which population was served. No ' +
        'card_id or kind filter; for one card read GET /api/cards/{cardId} `open_approvals`. `items` and ' +
        '`data` are ONE PAGE; `total` counts the whole matching population.',
      tags: ['Approvals'],
      operationId: 'listAllApprovals',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          description: 'Restrict to one status. Absent or empty means every status; any other value is a 400.',
          schema: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'voided', 'executing', 'done', 'failed'] },
        },
        {
          name: 'deblock_action',
          in: 'query',
          required: false,
          description: 'Restrict to one metadata.deblock_action bucket: one of the deblock actions (the closed set in domain/engagement/deblock-actions.ts), `none` (no usable action) or `other` (a value outside the set). Absent or empty = no filter; any other value is a 400.',
          schema: { type: 'string' },
        },
        { name: 'project_id', in: 'query', required: false, description: 'Restrict to one project (rows, total and facets narrow together). Not a uuid → 400 invalid_project_id.', schema: { type: 'string', format: 'uuid' } },
        { name: 'actionable', in: 'query', required: false, description: "'1'/'true'/'yes' (or present with no value): only rows the caller is rostered on.", schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, description: 'Page size, >= 1, capped at 1000. Absent = no limit.', schema: { type: 'integer', minimum: 1 } },
        { name: 'offset', in: 'query', required: false, description: 'Rows to skip, >= 0. Absent = 0.', schema: { type: 'integer', minimum: 0 } },
        { name: 'kind_counts', in: 'query', required: false, description: "'1' adds `kind_totals` ({ [approval kind]: n } over the whole matching population).", schema: { type: 'string' } },
        { name: 'action_counts', in: 'query', required: false, description: "'1' adds `action_totals` ({ [deblock_action bucket]: n } over the population WITHOUT the deblock_action filter).", schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'One page of approvals',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Approval' } },
                  items: { type: 'array', items: { $ref: '#/components/schemas/Approval' } },
                  total: { type: 'integer' },
                  scope: { type: 'string', enum: ['all', 'tenant', 'tenant_rostered'] },
                  scope_tenant_id: { type: 'string', nullable: true },
                  scope_lanes: {
                    type: 'array',
                    items: { type: 'string', enum: ['owned_projects', 'tenant_projects', 'rostered', 'unscoped_project', 'requested_by_me'] },
                  },
                  limit: { type: 'integer', nullable: true },
                  offset: { type: 'integer' },
                  deblock_action: { type: 'string', nullable: true },
                  kind_totals: { type: 'object', additionalProperties: { type: 'integer' } },
                  action_totals: { type: 'object', additionalProperties: { type: 'integer' } },
                  approver_identities_truncated: { type: 'boolean' },
                },
              },
            },
          },
        },
        '400': { description: 'An unrecognised status / deblock_action, a malformed project_id, or a non-integer / out-of-range limit or offset', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'approvals.list_pending', method: 'GET', path: '/api/approvals', handler: 'handleListMyApprovals', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["approvals.listPendingApprovals"],
    frozen: {
      summary: 'List pending approvals for the caller',
      description:
        'Pending approvals only, ordered by created_at. With `mine=1`: approvals the caller is a ' +
        'required approver on (by user id or by a role they hold). Any other value, or absent: ' +
        'approvals the caller requested OR is a required approver on. Both also include, for a CURRENT ' +
        'member of the active tenant, every pending approval of that tenant the member may decide under ' +
        'the 1-of-any member rule (non-empty roster, not an action approval, not their own human-raised ' +
        'request). Tenant-scoped for every caller. `data` and `items` carry the same array.',
      tags: ['Approvals'],
      operationId: 'listPendingApprovals',
      parameters: [
        {
          name: 'mine',
          in: 'query',
          required: false,
          description: "'1' restricts the list to approvals the caller is eligible to decide.",
          schema: { type: 'string' },
        },
        {
          name: 'project_id',
          in: 'query',
          required: false,
          description: "Only approvals attached to this project (uuid). Malformed ⇒ 400 invalid_project_id.",
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Pending approvals',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Approval' },
                  },
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Approval' },
                  },
                  total: { type: 'integer' },
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
      },
    },
  },
  {
    id: 'approvals.get_bug_fix_for_card', method: 'GET', path: '/api/approvals/bug-fix-for-card/:bugCardId', handler: 'handleGetBugFixApprovalForCard', effect: 'read',
    rule: routeRule(isLicenceCallerWithTenant),
    licenceOps: ["approvals.getBugFixForCard"],
    source: { module: 'src/routes/approval-bug-fix-for-card.ts', load: () => import('../../routes/approval-bug-fix-for-card') },
    frozen: {
      summary: 'The one bug-fix authorization for a bug card (U3, internal)',
      description:
        'U3. Returns the `execution.ready_signoff` approval marked ' +
        "metadata.approval_kind='bug_fix_authorization' whose metadata.bug_card_id is `bugCardId`, in tenant " +
        '`tenant_id`, whose status is neither voided nor expired. At most one exists (migration 153 partial ' +
        'UNIQUE index, same predicate); newest first by (created_at, id). An expired authorization is not ' +
        'returned: the card is re-raised and the new row is the answer (404 until then). This is how a caller finds ' +
        'the authorization for a bug card; fr writes nothing onto the bug card. LICENCE DOOR ONLY ' +
        '(the X-Webhook-Secret door was removed, G4), no Keycloak-JWT lane; tenant_id must be the licence\'s. Tenant-predicated: another tenant\'s bug card is 404, ' +
        'identical to no approval. `decided_at` is the completion instant, null while pending. ' +
        'With `include_closed=true` the status predicate is dropped: the LATEST marked row for that bug card ' +
        'in that tenant in ANY status (pending/approved/rejected/expired/voided), same order and shape; 404 ' +
        'only when no marked row ever existed. Without it (absent or `false`) status is only ' +
        'pending/approved/rejected. Any other include_closed value is 400 include_closed_invalid.',
      tags: ['Approvals'],
      operationId: 'getBugFixForCard',
      // n8n-nodes-fr hand-writes this op (named getBugFixForCard) and keys on this marker; a
      // re-copy of the spec must neither rename it nor generate a duplicate handler.
      'x-n8n-manual': true,
      security: [{ licenceToken: [] }],
      parameters: [
        { name: 'bugCardId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'tenant_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
        {
          name: 'include_closed',
          in: 'query',
          required: false,
          description:
            "'true' returns the latest marked row in any status (expired/voided included); absent or 'false' " +
            'is the default (open + decided only). Any other value is 400 include_closed_invalid.',
          schema: { type: 'string', enum: ['true', 'false'] },
        },
      ],
      responses: {
        '200': {
          description: 'The bug-fix authorization',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    required: ['id', 'status', 'report_id', 'report_hash', 'decided_at'],
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      status: {
                        type: 'string',
                        // expired / voided ONLY with include_closed=true.
                        enum: ['pending', 'approved', 'rejected', 'expired', 'voided'],
                      },
                      report_id: { type: 'string', nullable: true },
                      report_hash: { type: 'string', nullable: true },
                      decided_at: { type: 'string', format: 'date-time', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            'tenant_id missing or not a uuid (tenant_id_invalid), or include_closed neither true nor false ' +
            '(include_closed_invalid)',
        },
        '401': { description: 'No / refused fr licence token (an X-Webhook-Secret header is ignored, G4)' },
        '404': { description: 'No bug-fix authorization for this bug card in this tenant (bug_fix_approval_not_found)' },
      },
    },
  },
  {
    id: 'approvals.get', method: 'GET', path: '/api/approvals/:approvalId', handler: 'handleGetApproval', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["approvals.getApproval"],
    frozen: {
      summary: 'Get approval details',
      tags: ['Approvals'],
      operationId: 'getApproval',
      parameters: [
        {
          name: 'approvalId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Approval details',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Approval' },
            },
          },
        },
      },
    },
  },
  {
    id: 'approvals.get_write_set', method: 'GET', path: '/api/approvals/:approvalId/write-set', handler: 'handleGetApprovalWriteSet', effect: 'read',
    rule: routeRule(isLicenceCallerWithTenant),
    licenceOps: ["approvals.getApprovalWriteSet"],
    source: { module: 'src/routes/approval-write-set.ts', load: () => import('../../routes/approval-write-set') },
    frozen: {
      summary: 'The approved, sealed write set of a write-set approval (U4, internal)',
      description:
        'U4. Every repo-relative path a proof card\'s PR may create, modify or delete. ' +
        '`feature`: an APPROVED `execution.feature_design_approval`; metadata.write_set is returned only ' +
        'after write_set_seal = sha256(RFC8785({v:1, write_set})) is RECOMPUTED and matches ' +
        '(409 write_set_seal_mismatch, nothing returned); no set or seal is 409 write_set_missing. ' +
        "`bug_fix`: an APPROVED `execution.ready_signoff` marked metadata.approval_kind='bug_fix_authorization'; " +
        'the cited bug_report/v1 H_r is RECOMPUTED and must equal metadata.report_hash (409 ' +
        'report_hash_mismatch); the set is DERIVED as the union of location.file and failing_test.path over ' +
        'the APPROVED bug_ids (0 approved: 409 no_approved_bugs). Same path rules (exact, no globs, no ' +
        "'..', no leading/trailing '/') and cap (40, write_set_too_broad) for both. Any other kind or status " +
        'is 409 not_a_write_set_approval. LICENCE DOOR ONLY (X-Webhook-Secret removed, G4); tenant_id must be the licence\'s. ' +
        "Tenant-predicated: another tenant's approval is 404, identical to a missing one.",
      tags: ['Approvals'],
      operationId: 'getApprovalWriteSet',
      security: [{ licenceToken: [] }],
      parameters: [
        { name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'tenant_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'The sealed write set',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    required: ['approval_id', 'source', 'write_set', 'write_set_seal'],
                    properties: {
                      approval_id: { type: 'string', format: 'uuid' },
                      source: { type: 'string', enum: ['feature', 'bug_fix'] },
                      write_set: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string' } },
                      write_set_seal: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    },
                  },
                },
              },
            },
          },
        },
        '400': { description: 'tenant_id missing or not a uuid (tenant_id_invalid)' },
        '401': { description: 'No / refused fr licence token (an X-Webhook-Secret header is ignored, G4)' },
        '404': { description: 'No such approval in this tenant (approval_not_found)' },
        '409': {
          description:
            'not_a_write_set_approval | write_set_missing | write_set_seal_mismatch | write_set_invalid | ' +
            'write_set_too_broad | report_not_found | report_hash_mismatch | approval_items_missing | no_approved_bugs',
        },
      },
    },
  },
  {
    id: 'approvals.fence_write_set', method: 'POST', path: '/api/approvals/:approvalId/write-set/fence', handler: 'handleApprovalWriteSetFence', effect: 'write',
    rule: routeRule(isLicenceCallerWithTenant),
    licenceOps: ["approvals.writeSetFence"],
    source: { module: 'src/routes/approval-write-set.ts', load: () => import('../../routes/approval-write-set') },
    frozen: {
      summary: 'PR-less write-set fence: a change set vs the sealed write set (U4, internal)',
      description:
        'U4. Resolves the write set EXACTLY as GET /api/approvals/{approvalId}/write-set (same 404/409 codes, ' +
        're-seal on read), then applies the one fence rule (lib/write-set.ts evaluateWriteSetFence) to ' +
        '`changed_paths` (added ∪ modified ∪ deleted ∪ rename-old ∪ rename-new). For use BEFORE a PR exists; ' +
        'POST /api/projects/constraint-check is the PR-head gate. outcome `in_set`: every path is in the set; ' +
        '`write_set_test_path_mismatch`: every out-of-set path is a test path; `diff_outside_write_set`: at least ' +
        'one out-of-set non-test path. `offending` is the out-of-set paths, byte-ordered, de-duplicated. ' +
        'An empty `changed_paths` is refused (400), never a vacuous in_set. Read-only. LICENCE DOOR ONLY ' +
        "(X-Webhook-Secret removed, G4); tenant_id must be the licence's. Tenant-predicated: another tenant's approval is 404.",
      tags: ['Approvals'],
      operationId: 'fenceApprovalWriteSet',
      security: [{ licenceToken: [] }],
      parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tenant_id', 'changed_paths'],
              properties: {
                tenant_id: { type: 'string', format: 'uuid' },
                changed_paths: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 6000,
                  items: { type: 'string', minLength: 1, maxLength: 1024 },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'The fence verdict',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    required: ['approval_id', 'outcome', 'offending', 'write_set_seal', 'checked_paths_count'],
                    properties: {
                      approval_id: { type: 'string', format: 'uuid' },
                      outcome: { type: 'string', enum: ['in_set', 'write_set_test_path_mismatch', 'diff_outside_write_set'] },
                      offending: { type: 'array', items: { type: 'string' } },
                      write_set_seal: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      checked_paths_count: { type: 'integer', minimum: 1 },
                    },
                  },
                },
              },
            },
          },
        },
        '400': { description: 'tenant_id missing or not a uuid (tenant_id_invalid); changed_paths malformed (changed_paths_invalid)' },
        '401': { description: 'No / refused fr licence token (an X-Webhook-Secret header is ignored, G4)' },
        '404': { description: 'No such approval in this tenant (approval_not_found)' },
        '409': {
          description:
            'not_a_write_set_approval | write_set_missing | write_set_seal_mismatch | write_set_invalid | ' +
            'write_set_too_broad | report_not_found | report_hash_mismatch | approval_items_missing | no_approved_bugs',
        },
      },
    },
  },
  {
    id: 'approvals.mint_design_units', method: 'POST', path: '/api/approvals/:approvalId/mint-design-units', handler: 'handleMintDesignUnits', effect: 'write',
    rule: routeRule(isAuthenticatedUserInExecutionTenant),
    licenceOps: ["approvals.mintDesignUnits"],
    source: { module: 'src/routes/approval-mint-design-units.ts', load: () => import('../../routes/approval-mint-design-units') },
    frozen: {
      summary: 'Mint one dev card per unit of a decided A3 handoff.v2 contract (C1-59, conveyor)',
      description:
        'P2.3 step 3. For an APPROVED `execution.feature_design_approval` with a stored approve decision ' +
        '(any decider — human or agent; item_decisions.decider_kind records which), re-verifies metadata.contract_hash over the stored ' +
        'metadata.handoff_contract, injects design_approval_id = the approval id, refuses a contract whose ' +
        'design_card_id is not the approval\'s card_id (the unit cards are parented under it), runs the ncn handoff.v2 ' +
        'checks (codes spelled as ncn scripts/lib/handoff-contract.mjs) and mints one card per unit through ' +
        'the POST /api/cards/project body under the EXEC tenant, asset_id `a3:<approval id>:<unit_key>`. ' +
        'Idempotent: a second call returns the same card ids with created=false. Any refusal mints ZERO ' +
        'cards and is commented on the design card (refusal_surfaced). EXEC tenant callers only. ' +
        'element_ids are checked structurally only and repository visibility is not checked (known gaps).',
      tags: ['Approvals'],
      operationId: 'mintDesignUnits',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        '200': {
          description: 'Every unit has its card (created now, or already existing)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    required: ['approval_id', 'contract_hash', 'cards', 'created_count'],
                    properties: {
                      approval_id: { type: 'string', format: 'uuid' },
                      contract_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      cards: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['unit_key', 'asset_id', 'card_type', 'card_id', 'created'],
                          properties: {
                            unit_key: { type: 'string' },
                            asset_id: { type: 'string' },
                            card_type: { type: 'string', enum: ['development_feature_new', 'development_feature_update'] },
                            card_id: { type: 'string' },
                            created: { type: 'boolean' },
                          },
                        },
                      },
                      created_count: { type: 'integer', minimum: 0 },
                    },
                  },
                },
              },
            },
          },
        },
        '401': { description: 'Missing or invalid bearer token' },
        '403': { description: 'Caller is not on the EXEC tenant (mint_design_units_exec_only)' },
        '404': { description: 'No such approval in this tenant (approval_not_found)' },
        '409': {
          description:
            'approval_kind_invalid | approval_not_approved | approval_not_decided | missing_contract | ' +
            'contract_hash_mismatch | design_card_mismatch | design_project_unresolved | mint_incomplete',
        },
        '422': { description: 'handoff_contract_refused (violations[] with ncn codes) | mint_refused' },
        '502': { description: 'mint_failed — retry the same call; it converges on the asset ids' },
      },
    },
  },
  {
    id: 'approvals.get_approved_items', method: 'GET', path: '/api/approvals/:approvalId/approved-items', handler: 'handleGetApprovedItems', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["approvals.getApprovedItems"],
    source: { module: 'src/routes/approval-approved-items.ts', load: () => import('../../routes/approval-approved-items') },
    frozen: {
      summary: 'Resolved APPROVED items of a decided U3 approval',
      description:
        'U3. For a decided-approved bug_fix_authorization row — any kind (generic deblock or ' +
        "execution.ready_signoff) with metadata.approval_kind='bug_fix_authorization' — one entry per " +
        'bug the G-12 A1 structured decision approved (∩ metadata.bug_ids), read from the cited U2 ' +
        'report; or `execution.feature_design_approval` (one entry per scenario). Tenant-predicated: ' +
        "another tenant's approval is 404. Pending/rejected is 409 approval_not_approved; a marked " +
        'generic row approved with a non-proceed deblock_action (anything but RETRY) is 409 ' +
        'not_authorised_for_fix; an unmarked row is 409 not_a_bug_fix_authorization. Never an empty list.',
      tags: ['Approvals'],
      operationId: 'getApprovedItems',
      // n8n-nodes-fr hand-writes this op's handler and keys on this marker; without it a
      // re-copy of the spec generates a duplicate getApprovedItems and the build fails.
      'x-n8n-manual': true,
      parameters: [
        { name: 'approvalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Approved items keyed by criterion_id',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['scenario_id', 'criterion_id', 'title', 'gherkin', 'status', 'source'],
                      properties: {
                        scenario_id: { type: 'string' },
                        criterion_id: { type: 'string' },
                        title: { type: 'string' },
                        gherkin: { type: 'string', nullable: true },
                        failing_test: {
                          type: 'object',
                          properties: { path: { type: 'string' }, name: { type: 'string' } },
                        },
                        status: { type: 'string', enum: ['approved'] },
                        source: { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '404': { description: 'Not found in the caller tenant' },
        '409': { description: 'Not a decided-approved bug_fix / feature_design approval' },
      },
    },
  },
  {
    id: 'approvals.void', method: 'POST', path: '/api/approvals/void', handler: 'handleVoidApprovals', effect: 'destructive',
    rule: routeRule(isAuthenticatedSuperAdmin),
    nonJson400: true,
    source: { module: 'src/routes/approval-void.ts', load: () => import('../../routes/approval-void') },
    frozen: {
      summary: 'Void pending approvals (super-admin only)',
      description:
        'Super-admin only (`super_admin` Keycloak realm role). Withdraws a named set of pending ' +
        'approvals; this is NOT a decision and writes no approval_decisions row. `dryRun` defaults ' +
        'to true: omit it and nothing is written, only a report is returned. Only rows currently ' +
        "status='pending' are voided; every id in the request (including duplicates) gets an " +
        'outcome. The batch runs in one transaction.',
      tags: ['Approvals'],
      operationId: 'voidApprovals',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['ids', 'reason'],
              properties: {
                ids: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 500,
                  items: { type: 'string', format: 'uuid' },
                },
                reason: {
                  type: 'string',
                  minLength: 10,
                  description: 'Recorded on each voided row. Trimmed before the length check.',
                },
                dryRun: { type: 'boolean', default: true },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Void report (a dry run when dryRun is true)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  dryRun: { type: 'boolean' },
                  reason: { type: 'string' },
                  results: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        outcome: {
                          type: 'string',
                          enum: ['would_void', 'voided', 'skipped_not_pending', 'not_found'],
                        },
                      },
                    },
                  },
                  counts: {
                    type: 'object',
                    properties: {
                      would_void: { type: 'integer' },
                      voided: { type: 'integer' },
                      skipped_not_pending: { type: 'integer' },
                      not_found: { type: 'integer' },
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
        '403': {
          description: 'Caller is not a super-admin',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '422': {
          description: 'Request body failed validation',
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
    id: 'approvals.create_execution', method: 'POST', path: '/api/execution/approvals', handler: 'handleCreateExecutionApproval', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["approvals.createExecutionApproval", "approvals.createExecutionApprovalSecret"],
    source: { module: 'src/routes/execution-approvals.ts', load: () => import('../../routes/execution-approvals') },
    frozen: {
      "summary": "Create an execution sign-off approval for a card",
      "description": "Mints the `execution.ready_signoff` gate for a card parked by the AA ready-prefetch policy gate. One bearer door: an fr licence token (the tenant's conveyor seat, i.e. n8n) or a Keycloak JWT. X-Webhook-Secret is NOT accepted (a secret-only request is 401). The resolved target must be reachable by the caller in its tenant: a project must pass the tenant gate every mutating project sub-resource uses (a licence reaches any project of its tenant), a stream must be owned by the caller's tenant; anything else is the same 404 as a missing target and writes no ledger row. The card, `metadata.boardId` and the resume lists (`doingListId`, `todoListId`, `qaListId`) must be on the resolved target's Planka board (fail closed, 404; fr#1451). A licence caller mints every kind the old secret door did (MERGE / SPLIT / DROP / canary / phase-advance / the bug-fix marker), tenant-bound: a MERGE's PR must be in the project's repository (403 licence_tenant_mismatch). The approver roster is NEVER taken from the request on either door: it is the project's `execution_signoff` stakeholders (or, for a stream board, the approver ladder). One open gate per card: a second create answers 200 with `deduplicated: true` and the existing gate.",
      "tags": [
        "Approvals"
      ],
      "operationId": "createExecutionApproval",
      "security": [
        {
          "licenceToken": []
        },
        {
          "bearerAuth": []
        }
      ],
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "card_id",
                "metadata"
              ],
              "properties": {
                "card_id": {
                  "type": "string",
                  "description": "Planka card id"
                },
                "project_id": {
                  "type": "string",
                  "description": "fr project id (preferred key)"
                },
                "boardId": {
                  "type": "string",
                  "description": "Planka board id (fallback key when project_id is absent)"
                },
                "callback_url": {
                  "type": "string",
                  "description": "D17, LICENCE caller only (a Keycloak JWT is 422 callback_url_not_allowed): the n8n Wait node's $execution.resumeUrl. Its origin must be in N8N_CALLBACK_ORIGINS (empty by default = every value refused), https unless the allowlisted origin is http, no userinfo, path starting /webhook-waiting/ (else 422 callback_url_not_allowed). When present the decision is POSTed to it exactly as given (X-Approval-Callback-Secret, redirects not followed) and to no callback_path. Never echoed back."
                },
                "artifact_ref": {
                  "allOf": [{ "$ref": "#/components/schemas/ApprovalArtifactRef" }],
                  "nullable": true,
                  "description": "D13: the ONE artifact this sign-off is about (see ApprovalArtifactRef for the 422/409 codes). Echoed on the created / deduplicated `data` and on the decision callback."
                },
                "reason": {
                  "type": "string",
                  "description": "Why THIS card needs a sign-off (the question the approver is shown)"
                },
                "action_name": {
                  "type": "string"
                },
                "change_summary": {
                  "type": "string"
                },
                "impact_analysis": {
                  "type": "string"
                },
                "expires_in_hours": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 168
                },
                "metadata": {
                  "type": "object",
                  // ⛔ NOT a passthrough on the JWT door. Kept in step with
                  // JWT_METADATA_ALLOWED_KEYS / JWT_METADATA_CONTROL_KEYS in
                  // routes/execution-approvals.ts by
                  // tests/unit/openapi-jwt-metadata-allowlist.test.ts.
                  "description": "Resume coordinates { doingListId, boardId, todoListId? } plus descriptive context. The two bearer kinds treat this object DIFFERENTLY. Licence (n8n conveyor seat): stored as sent (passthrough), except learning_card_id, stream_id, unresolved_project_id, requested_via, requested_by_user_id, which are refused with 422 `metadata_control_key_forbidden`; `proposal_check: 'required'` (licence door only — never on the JWT allowlist) has fr score `proposed_answer` with laya before minting: a proposal not confidently actionable is 422 `proposal_unclear` and NOTHING is written, the verdict is recorded as `metadata.proposal_score` (a caller-supplied value is always overwritten), and a laya outage mints the ask unscored; canary_action / list / additional_minutes name a platform-owned workflow route, so a non-platform licence naming any of them is 403 `licence_tenant_mismatch`, and a platform licence's are shape-checked (canary_action rollback|extend, card_type + list non-empty ≤128, additional_minutes integer 1..10080 only with extend) else 422 `invalid_canary_metadata`. Keycloak JWT: an ALLOWLIST, not a passthrough. Only these 23 data keys are kept: doingListId, todoListId, boardId, card_type, card_name, project_type, gate_terms, policy_key, policy_source, brief_fingerprint, risk_score, risk_threshold, risk_factors, open_questions, proposed_answer (a bare approve accepts it as the decision comment), degraded_legs, degraded_legs_soft, decision_authoring_gap, project_id_forwarded, project_id_rejected, project_id_rejected_reason, project_id_existence_checked, approval_kind (the bug_fix_authorization marker; it only makes the row web-only). Every other key is silently DROPPED (no error). These 16 control keys are refused with 422 `metadata_control_key_forbidden` naming the key: deblock_action, pr_url, pr_repo_owner, pr_repo_name, pr_number, advance_phase_on_approve, canary_action, list, additional_minutes, learning_card_id, qaListId, initiator, stream_id, unresolved_project_id, requested_via, requested_by_user_id; the one exception is `deblock_action: 'QUESTION'` together with a non-empty `open_questions` array, which is accepted. `card_type` is kept as a label only and is never read as a phase-advance signal on a JWT row.",
                  "additionalProperties": true
                }
              }
            }
          }
        }
      },
      "responses": {
        "201": {
          "description": "Approval created",
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "object",
                    "additionalProperties": true
                  }
                }
              }
            }
          }
        },
        "200": {
          "description": "The card already has an open gate (deduplicated)",
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "object",
                    "additionalProperties": true
                  },
                  "deduplicated": {
                    "type": "boolean"
                  }
                }
              }
            }
          }
        },
        "409": {
          "description":
            "U3, MARKED (metadata.approval_kind='bug_fix_authorization') requests only; an unmarked request " +
            "is deduplicated (200) as before. A marked request is answered with an existing row only when it " +
            "is the SAME request (report_hash, bug_card_id, bug_ids as a set). Otherwise: " +
            "`bug_card_already_has_approval` (details.existing_approval_id, existing_status) ONLY when the " +
            "existing row is this bug card's authorization — the row GET /api/approvals/bug-fix-for-card/{bugCardId} " +
            "returns; `open_gate_conflict` (details.existing_approval_id, existing_kind) when the decision card " +
            "holds any other open gate (an unmarked gate, or a marked row for a different bug card), for which " +
            "that read is 404.",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Error"
              }
            }
          }
        },
        "400": {
          "description": "Bad body, or the project has no tenant (system door)",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Error"
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
        "403": {
          "description": "Fixture-origin work: no human sign-off is minted",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Error"
              }
            }
          }
        },
        "404": {
          "description": "No project or improvement stream found (or not reachable by this caller)",
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Error"
              }
            }
          }
        },
        "422": {
          "description": "No (reachable) approvers, or an undecidable reason",
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
    id: 'approvals.list_stranded_execution', method: 'GET', path: '/api/execution/approvals/stranded', handler: 'handleListStrandedSignoffs', effect: 'read',
    rule: routeRule(isAuthenticatedSuperAdmin),
    licenceOps: ["approvals.listStrandedExecutionApprovals"],
    source: { module: 'src/routes/execution-approvals.ts', load: () => import('../../routes/execution-approvals') },
    frozen: {
      summary: 'List stranded approvals (super-admin only)',
      description:
        'Super-admin only; cross-tenant operator diagnostics. `unreleasable`: cards whose sign-off ' +
        'approval fr refused to create (fixture-origin refusals excluded); not affected by `kind`, ' +
        'and its summary count is the length of the returned list (capped at 500). `expired`: ' +
        'approvals closed by the expiry worker. `pending_past_expiry`: pending approvals past ' +
        'expires_at that the worker has not swept yet (should be 0). The `expired` and ' +
        '`pending_past_expiry` lists are capped at 500 rows, but their summary counts cover the full population.',
      tags: ['Approvals'],
      operationId: 'listStrandedExecutionApprovals',
      parameters: [
        {
          name: 'kind',
          in: 'query',
          required: false,
          description:
            'Restrict `expired` and `pending_past_expiry` to one approval kind. Absent or empty means ' +
            'every kind. Case-sensitive; any other value is a 400.',
          schema: {
            type: 'string',
            enum: [
              'generic',
              'improvement.design',
              'improvement.release',
              'execution.ready_signoff',
              'improvement.canary_action',
            ],
          },
        },
      ],
      responses: {
        '200': {
          description: 'Stranded approvals by bucket',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  summary: {
                    type: 'object',
                    properties: {
                      unreleasable: { type: 'integer' },
                      expired: { type: 'integer' },
                      pending_past_expiry: { type: 'integer' },
                    },
                  },
                  unreleasable: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        card_id: { type: 'string' },
                        board_id: { type: 'string', nullable: true },
                        requested_project_id: { type: 'string', nullable: true },
                        resolved_project_id: { type: 'string', nullable: true },
                        tenant_id: { type: 'string', nullable: true },
                        reason_code: {
                          type: 'string',
                          enum: [
                            'signoff_project_not_found',
                            'signoff_project_untenanted',
                            'signoff_no_approvers',
                            'signoff_no_reachable_approver',
                            'signoff_target_off_board',
                          ],
                        },
                        detail: { type: 'string' },
                        attempts: { type: 'integer' },
                        first_seen_at: { type: 'string', format: 'date-time' },
                        last_seen_at: { type: 'string', format: 'date-time' },
                        remedy: { type: 'string' },
                      },
                    },
                  },
                  expired: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        card_id: { type: 'string', nullable: true },
                        project_id: { type: 'string', format: 'uuid', nullable: true },
                        tenant_id: { type: 'string', format: 'uuid' },
                        kind: { type: 'string' },
                        status: { type: 'string' },
                        description: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                        expires_at: { type: 'string', format: 'date-time', nullable: true },
                        error_message: { type: 'string', nullable: true },
                      },
                    },
                  },
                  pending_past_expiry: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        card_id: { type: 'string', nullable: true },
                        project_id: { type: 'string', format: 'uuid', nullable: true },
                        tenant_id: { type: 'string', format: 'uuid' },
                        kind: { type: 'string' },
                        status: { type: 'string' },
                        description: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                        expires_at: { type: 'string', format: 'date-time', nullable: true },
                        error_message: { type: 'string', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'Unrecognised `kind` value',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
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
        '403': {
          description: 'Caller is not a super-admin',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  },
];

export const APPROVAL_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities({ area: 'approvals', tenancy: 'tenant', module: 'src/routes/approvals.ts', load: () => import('../../routes/approvals') }, APPROVAL_ROUTES);
