// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: the service-to-service and inbound
// webhook routes that ALREADY had an operation in the openapi.ts literal, re-expressed with NO
// behaviour change (`legacyHandler`):
//   * the six n8n webhooks — approval-request (X-Webhook-Secret, `principal: 'webhook'`) and five that take
//     ONLY an allowlisted licence bearer (`licenceOnly`; `principal: 'service'`, P4d-2e audit label fix):
//     card-approval, report, card-phase-lease, plan-event, executed-activity;
//   * the five `/api/internal/*` service routes (X-Internal-Token per caller, or unauthenticated by
//     design for the andon read-failure report; computed-checks also takes an allowlisted licence);
//   * `POST /api/reports/:reportId/fix` (the bug-fix ledger write; licence / orchestrator /
//     super-admin) and `POST /api/notifications/dispatch` (the internal-tenant communication hub,
//     licence-allowlisted).
//
// Each literal operation moves VERBATIM into `openapi.frozen` (capabilities/frozen-routes.ts); the
// only edits are the measured ones, named by id in tests/unit/capabilities/p4d2d-capabilities.test.ts
// (the server's licence-door 403 on an operation off the licence allowlist that declared no 403 /
// default; a non-JSON 400 measured through the real pipeline).
//
// Auth (the handlers', unchanged): a webhook / service caller is NOT a user. Its declared rule
// denies everything at the registry layer (these never run through the agent or the confirm route);
// the route's own handler enforces its secret / token / licence exactly as before.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { isAuthenticatedUserInInternalTenant, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { routeRule } from '../account/_shared';

/** Never through the registry or the agent: deny-all at that layer (the handler owns its auth). */
const never = () => ({ type: 'custom' as const, check: async () => false });
const resolvedTenant = routeRule(isAuthenticatedUserInResolvedTenant);
const internalTenant = routeRule(isAuthenticatedUserInInternalTenant);

const SERVICE_ROUTES: FrozenRoute[] = [
  {
    id: 'webhooks.n8n_approval_request', method: 'POST', path: '/api/webhooks/n8n/approval-request', handler: 'handleN8nApprovalRequest', effect: 'write',
    unauthorized401: "`error` 'Invalid or missing webhook secret' (X-Webhook-Secret absent or wrong; when N8N_WEBHOOK_SECRET is unset, production refuses every call).",
    nonJson400: true,
    rule: never,
    principal: 'webhook', agentReason: 'service-to-service',
    source: { module: 'src/routes/webhooks.ts', load: () => import('../../routes/webhooks') },
    frozen: {
      summary: 'Receive approval request from n8n',
      description:
        'X-Webhook-Secret ONLY (handleN8nApprovalRequest calls validateWebhookSecret first). ' +
        'A bearer token is never accepted here, so this is not a typed-client operation: ' +
        '`x-internal` keeps the n8n-nodes-fr generator from exposing an op that could only ever 401.',
      tags: ['Webhooks'],
      operationId: 'n8nApprovalRequest',
      security: [{ webhookSecret: [] }],
      'x-internal': true,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['fr_project_id', 'card_id', 'card_name', 'reason', 'callback_path', 'required_approvers'],
              properties: {
                fr_project_id: { type: 'string', format: 'uuid' },
                card_id: { type: 'string' },
                card_name: { type: 'string' },
                reason: { type: 'string' },
                callback_path: { type: 'string' },
                required_approvers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      user_id: { type: 'string', format: 'uuid' },
                      role: { type: 'string' },
                    },
                  },
                },
                deadline_hours: { type: 'number', default: 24 },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Approval created' },
      },
    },
  },
  {
    id: 'webhooks.n8n_card_approval', method: 'POST', path: '/api/webhooks/n8n/card-approval', handler: 'handleN8nCardApproval', effect: 'write',
    rule: never,
    principal: 'service' /* P4d-2e: a licence bearer ONLY (licenceOnly), not X-Webhook-Secret */, agentReason: 'service-to-service',
    licenceOps: ['approvals.cardApproval'],
    source: { module: 'src/routes/webhooks.ts', load: () => import('../../routes/webhooks') },
    frozen: {
      summary: 'Mint (or dedupe onto) the card approval gate n8n raises for a blocked card',
      description:
        'fr LICENCE token ONLY (G5, George 2026-10-10: X-Webhook-Secret and Keycloak JWTs are 401), ' +
        'so `x-internal` (never a typed-client op). The licence mints every gate kind (COVERAGE, ' +
        'MERGE / SPLIT / DROP, phase advance, the bug-fix marker) bound to its tenant: boardId is ' +
        'required and its tenant, any tenant_id / project_id, the card and its lists must be the ' +
        "licence's, and a MERGE's PR must be in the project's repository (403 licence_tenant_mismatch); " +
        'recipient, approver_user_id, learning_card_id and a non-default callback_path are 403 ' +
        'licence_field_forbidden. Optional `callback_url` (D17): the n8n Wait node resume URL — origin in ' +
        'N8N_CALLBACK_ORIGINS (empty by default), https unless that origin is http, no userinfo, path under ' +
        '/webhook-waiting/, else 422 callback_url_not_allowed; the decision is then POSTed to it exactly as ' +
        'given and to no callback_path. Only the body fields the ' +
        'U3 coverage sign-off owns are declared here; the rest of the body is N8nCardApprovalSchema ' +
        '(src/routes/webhooks.ts). `qa.coverage_signoff` is never SENT: it is derived from ' +
        'deblock_action COVERAGE + block_reason_class no_computed_check + a `no_computed_check:` block ' +
        'reason, and then `metadata.coverage_request` (AA-TRACE §6.14, inline only) is validated strictly ' +
        '(422). `coverage_request.source`: absent or `r3` = R3 computed the request — qa_head_sha and ' +
        'commit_sha are 40 lowercase hex and artifacts is required; `derived` = ncn blocked-escalate derived ' +
        'it on the legacy QA path where NO computed check ran — qa_head_sha and commit_sha are each absent or ' +
        'null, the two treated identically and stored as null (a string is 422 derived_request_has_sha); ' +
        'artifacts is absent or [] (stored as []; any entry is 422 derived_request_claims_computed); EVERY ' +
        "criterion's computed is EXACTLY {executed:false, outcome:'not_run'} — no other key — and " +
        'test_summary is all zero (else 422 derived_request_claims_computed). Any other source is 422 ' +
        'coverage_request_source_invalid. The block reason is `block_reason`, else `change_summary`, after ' +
        "stripping ONE leading `block reason: ` field wrapper (ncn Merge Procedure Hint's). " +
        'criteria are non-empty with unique criterion_id for every source. The effective source is persisted ' +
        'as approvals.metadata.coverage_request_source.',
      tags: ['Webhooks'],
      operationId: 'n8nCardApproval',
      security: [{ licenceToken: [] }],
      'x-internal': true,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['card_id', 'card_name', 'reason'],
              additionalProperties: true,
              properties: {
                card_id: { type: 'string' },
                card_name: { type: 'string' },
                reason: { type: 'string' },
                artifact_ref: {
                  allOf: [{ $ref: '#/components/schemas/ApprovalArtifactRef' }],
                  nullable: true,
                  description:
                    'D13: the ONE artifact this approval is about (see ApprovalArtifactRef for the 422/409 ' +
                    'codes). Echoed on the 201 body and on the decision callback.',
                },
                deblock_action: { type: 'string' },
                block_reason_class: { type: 'string' },
                metadata: {
                  type: 'object',
                  properties: {
                    coverage_request: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['card_id', 'card_type', 'criteria', 'test_summary'],
                      properties: {
                        source: { type: 'string', enum: ['r3', 'derived'] },
                        card_id: { type: 'string' },
                        card_type: { type: 'string' },
                        qa_head_sha: {
                          type: 'string',
                          nullable: true,
                          pattern: '^[0-9a-f]{40}$',
                          description:
                            'Required 40-hex when source is absent/r3. When source is derived: absent or null ' +
                            '(identical; stored as null) — a string is 422 derived_request_has_sha.',
                        },
                        commit_sha: {
                          type: 'string',
                          nullable: true,
                          pattern: '^[0-9a-f]{40}$',
                          description:
                            'Required 40-hex when source is absent/r3. When source is derived: absent or null ' +
                            '(identical; stored as null) — a string is 422 derived_request_has_sha.',
                        },
                        pr_url: {
                          type: 'string',
                          format: 'uri',
                          nullable: true,
                          maxLength: 2048,
                          description:
                            'Required url when source is absent/r3 (else 422 coverage_request_invalid). When source ' +
                            'is derived: absent, null (identical; stored as null) or a url — a derived card often has no PR.',
                        },
                        criteria: {
                          type: 'array',
                          minItems: 1,
                          items: {
                            type: 'object',
                            required: ['criterion_id', 'text', 'reason_not_computed'],
                            properties: {
                              criterion_id: { type: 'string' },
                              text: { type: 'string' },
                              scenario_id: { type: 'string', nullable: true },
                              scenario_gherkin: { type: 'string', nullable: true },
                              computed: {
                                type: 'object',
                                nullable: true,
                                description:
                                  "r3: R3's not_run record, carried as-is. derived: REQUIRED and EXACTLY " +
                                  "{executed:false, outcome:'not_run'} — exactly these two keys, no other " +
                                  '(else 422 derived_request_claims_computed).',
                              },
                              reason_not_computed: { type: 'string' },
                            },
                          },
                        },
                        artifacts: {
                          type: 'array',
                          items: { type: 'object' },
                          description:
                            'Required when source is absent/r3 (may be []). When source is derived: absent or [] ' +
                            '(stored as []) — any entry is 422 derived_request_claims_computed.',
                        },
                        test_summary: {
                          type: 'object',
                          required: ['passed', 'failed', 'skipped'],
                          properties: {
                            passed: { type: 'integer', minimum: 0 },
                            failed: { type: 'integer', minimum: 0 },
                            skipped: { type: 'integer', minimum: 0 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Deduplicated onto the open gate for this card' },
        '201': { description: 'Approval created' },
        '400': { description: 'No tenant could be resolved from tenant_id / boardId; nothing was created' },
        '401': { description: 'X-Webhook-Secret missing or wrong' },
        '403': { description: 'Refused fixture-origin sign-off (code signoff_fixture_origin); nothing was created' },
        '409': {
          description:
            'Conflicts with stored state: open_gate_conflict (the card holds an open gate asking a different ' +
            'question), bug_card_already_has_approval, report_not_found / report_hash_mismatch / ' +
            'report_card_mismatch (bug-fix marker); nothing was created',
        },
        '422': {
          description:
            'Malformed request: body schema, coverage_derivation_incomplete, coverage_request_*, ' +
            'derived_request_has_sha, derived_request_claims_computed, u3_kind_*, ' +
            'bug_fix_authorization_metadata_invalid, ...',
        },
      },
    },
  },
  {
    id: 'webhooks.n8n_report', method: 'POST', path: '/api/webhooks/n8n/report', handler: 'handleN8nReport', effect: 'write',
    rule: never,
    principal: 'service' /* P4d-2e: a licence bearer ONLY (licenceOnly), not X-Webhook-Secret */, agentReason: 'service-to-service',
    licenceOps: ['report.persistBugReport'],
    source: { module: 'src/routes/reports.ts', load: () => import('../../routes/reports') },
    frozen: {
      summary: 'Store a report n8n generated',
      description:
        'fr LICENCE token ONLY (G4: X-Webhook-Secret removed; lib/licence-door.ts licenceOnly). ' +
        '`report_type: bug_report` takes the insert-once, content-hashed path (services/reports/bug-report.ts: ' +
        'tenant_id required and the licence\'s; 201 stored / 200 the SAME row when (tenant_id, content_hash) ' +
        'already exists). Every other report_type is the generic path (status, sprint, dependency, quality, ' +
        'custom) and is filed under the licence tenant. Every tenant hint sent (tenant_id, project_id, ' +
        'board_id) must resolve to the licence tenant, else 403 licence_tenant_mismatch and nothing written.',
      tags: ['Report'],
      operationId: 'persistReport',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['report_type', 'title', 'summary'],
              properties: {
                report_type: { type: 'string', enum: ['status', 'sprint', 'dependency', 'quality', 'custom', 'bug_report'] },
                title: { type: 'string', minLength: 1 },
                summary: { type: 'string', minLength: 1 },
                details: { type: 'object' },
                card_id: { type: 'string', description: 'Required for bug_report' },
                board_id: { type: 'string' },
                project_id: { type: 'string', format: 'uuid' },
                tenant_id: { type: 'string', format: 'uuid', description: 'Required for bug_report; must be the licence tenant' },
                trace_id: { type: 'string', description: 'bug_report only: AA-TRACE join key (the X-AA-Trace-Id header is the primary carrier)' },
                content_hash: { type: 'string', description: 'bug_report only: fr recomputes it and refuses a mismatch' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'bug_report already stored (insert-once): the stored row', content: { 'application/json': { schema: { type: 'object' } } } },
        '201': { description: 'Stored', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': { description: 'Invalid body (schema failure)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'No licence token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'A tenant hint names another tenant (licence_tenant_mismatch)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'webhooks.n8n_card_phase_lease', method: 'POST', path: '/api/webhooks/n8n/card-phase-lease', handler: 'handleCardPhaseLease', effect: 'write',
    licenceOps: ['cardPhaseLease.claim', 'cardPhaseLease.verify', 'cardPhaseLease.renew', 'cardPhaseLease.release', 'cardPhaseLease.releaseHolder', 'cardPhaseLease.unwait'],
    rule: never,
    principal: 'service' /* P4d-2e: a licence bearer ONLY (licenceOnly), not X-Webhook-Secret */, agentReason: 'service-to-service',
    source: { module: 'src/routes/webhooks/card-phase-lease.ts', load: () => import('../../routes/webhooks/card-phase-lease') },
    frozen: {
      summary: 'The atomic card-phase lease (claim / verify / renew / release / unwait / release_holder)',
      description:
        'ONE DOOR (G4): a bearer through validateAuth — an fr licence token or a Keycloak JWT; X-Webhook-Secret ' +
        'is removed. Degrades CLOSED: `granted: true` only when the atomic statement returned a row; any DB ' +
        'error is a 5xx the caller must read as not-granted (routes/webhooks/card-phase-lease.ts). ' +
        '`release_holder` names a holder and carries no card_id.',
      tags: ['Webhooks'],
      operationId: 'n8nCardPhaseLease',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['op', 'tenant_id'],
              properties: {
                op: { type: 'string', enum: ['claim', 'verify', 'renew', 'release', 'unwait', 'release_holder'] },
                tenant_id: { type: 'string' },
                card_id: { type: 'string', description: 'Required for every op except release_holder' },
                holder: { type: 'string', maxLength: 128, description: 'Required for claim and release_holder' },
                lease_id: { type: 'string', maxLength: 128, description: 'Required for verify / renew / release' },
                ttl_seconds: { type: 'integer', minimum: 0, maximum: 86400 },
                preempt: { type: 'boolean' },
                waiter: { type: 'string', maxLength: 256, description: 'claim: the waiting card; required for unwait' },
                waiter_board_id: { type: 'string', maxLength: 256 },
                return_next_waiter: { type: 'boolean' },
                reentrant: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'The lease verdict (granted / held / valid / released ...)', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': { description: 'Invalid JSON, invalid payload, or a field required for this op is missing', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'webhooks.n8n_plan_event', method: 'POST', path: '/api/webhooks/n8n/plan-event', handler: 'handlePlanEventWebhook', effect: 'write',
    rule: never,
    principal: 'service' /* P4d-2e: a licence bearer ONLY (licenceOnly), not X-Webhook-Secret */, agentReason: 'service-to-service',
    licenceOps: ['planLedger.recordEvent'],
    source: { module: 'src/routes/webhooks/plan-ledger.ts', load: () => import('../../routes/webhooks/plan-ledger') },
    frozen: {
      summary: 'Append a split/reclassify plan event for a card (U11)',
      description:
        'Append-only write to `card_plan_events` (migration 148; UPDATE/DELETE refused by a DB trigger). Auth: ' +
        'an fr licence token only (X-Webhook-Secret removed, G4), as POST /api/webhooks/n8n/report; tenant_id must be the licence\'s (403 licence_tenant_mismatch). Tenant: `tenant_id` (uuid) is REQUIRED; missing or ' +
        'not a uuid → 400 `tenant_id_required`, before any lookup or write. There is no fallback: `project_id` / ' +
        '`board_id` never choose a tenant; if sent, each must resolve to `tenant_id`, and an unknown or foreign ' +
        'one is answered exactly like an unpinned card. The pin is looked up UNDER `tenant_id` only, and the row ' +
        'is filed under it. No pin on the card, a pin minted under ANOTHER tenant, or an inconsistent hint → the ' +
        'same 409 `card_not_pinned` (indistinguishable by design); nothing written. Schema failure (missing ' +
        '`list` included) → 422 `validation_failed`. ' +
        'Record-only: never moves or gates a card. Only a `rule` split at ready/qa/blocked or a `rule` ' +
        'reclassify at qa/blocked can re-plan a card (DOING never splits); such an event MUST carry ' +
        '`detail.new_plan` (same shape as the pin: {plan: {<list>: {activity_sequence: string[]}}, ...}) and ' +
        '`new_plan_sha` = sha256 of its canonical JSON (keys sorted recursively, array order kept), verified ' +
        'server-side: missing → 422 `new_plan_required`, malformed → 422 `new_plan_invalid`, mismatch → 422 ' +
        '`new_plan_sha_mismatch`. Such an event must also carry `prev_plan_sha` (the sha of the plan it ' +
        'replaces); missing → 422 `prev_plan_sha_required`. Other events record without a plan. `at` is the ' +
        'caller\'s claim, stored for information only: the row is stamped `recorded_at` server-side and ' +
        'conformance orders and governs by that alone.',
      tags: ['Webhooks'],
      operationId: 'n8nPlanEvent',
      security: [{ licenceToken: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['card_id', 'kind', 'computed_by', 'list', 'tenant_id'],
          properties: {
            card_id: { type: 'string' },
            kind: { type: 'string', enum: ['split', 'reclassify'] },
            computed_by: { type: 'string', enum: ['rule', 'llm'] },
            list: {
              type: 'string',
              enum: ['todo', 'ready', 'doing', 'qa', 'blocked', 'done'],
              description: 'The list the event was emitted from. Decides whether it can excuse a deviation.',
            },
            actor_execution_id: { type: 'string' },
            prev_plan_sha: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            new_plan_sha: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            detail: { type: 'object', additionalProperties: true },
            at: { type: 'string', format: 'date-time', description: 'Informational only; defaults to now(). Ordering uses the server-stamped recorded_at.' },
            trace_id: {
              type: 'string',
              format: 'uuid',
              description:
                'AA-TRACE §1 UUIDv7 join key (or the X-AA-Trace-Id header). Malformed → 422 trace_id_malformed; ' +
                'header ≠ body → 400 trace_id_conflict; absent → stored NULL. Not used by conformance.',
            },
            tenant_id: { type: 'string', format: 'uuid', description: 'REQUIRED. The pin is looked up under this tenant only; the row is filed under it.' },
            project_id: { type: 'string', format: 'uuid', description: 'Optional consistency check: must resolve to tenant_id, else 409 card_not_pinned. Never chooses a tenant.' },
            board_id: { type: 'string', description: 'Optional consistency check: must resolve to tenant_id, else 409 card_not_pinned. Never chooses a tenant.' },
          },
        } } },
      },
      responses: {
        '201': { description: 'Recorded' },
        '400': { description: 'body is not JSON, or tenant_id_required (missing or not a uuid)' },
        '401': { description: 'No / refused fr licence token (an X-Webhook-Secret header is ignored, G4)' },
        '409': { description: 'card_not_pinned (unpinned, pinned under another tenant, or a project_id/board_id hint not resolving to tenant_id)' },
        '422': { description: 'validation_failed' },
      },
    },
  },
  {
    id: 'webhooks.n8n_executed_activity', method: 'POST', path: '/api/webhooks/n8n/executed-activity', handler: 'handleExecutedActivityWebhook', effect: 'write',
    rule: never,
    principal: 'service' /* P4d-2e: a licence bearer ONLY (licenceOnly), not X-Webhook-Secret */, agentReason: 'service-to-service',
    licenceOps: ['planLedger.recordActivity'],
    source: { module: 'src/routes/webhooks/plan-ledger.ts', load: () => import('../../routes/webhooks/plan-ledger') },
    frozen: {
      summary: 'Append an executed activity for a card (U11)',
      description:
        'Append-only write to `card_executed_activities` (migration 148). Same auth and tenant rules as ' +
        'POST /api/webhooks/n8n/plan-event: `tenant_id` REQUIRED (missing/invalid → 400 `tenant_id_required`), ' +
        'no fallback, hints consistency-checked only. Record-only: never moves, gates or halts a card.',
      tags: ['Webhooks'],
      operationId: 'n8nExecutedActivity',
      security: [{ licenceToken: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['card_id', 'list', 'pattern', 'activity', 'tenant_id'],
          properties: {
            card_id: { type: 'string' },
            list: {
              type: 'string',
              enum: ['todo', 'ready', 'doing', 'qa', 'blocked', 'done'],
              description: 'The list the activity ran in. Closed set, lowercase; anything else → 422.',
            },
            pattern: { type: 'string' },
            activity: { type: 'string' },
            execution_id: { type: 'string' },
            at: { type: 'string', format: 'date-time', description: 'Informational only; defaults to now(). Ordering uses the server-stamped recorded_at.' },
            trace_id: {
              type: 'string',
              format: 'uuid',
              description:
                'AA-TRACE §1 UUIDv7 join key (or the X-AA-Trace-Id header). Malformed → 422 trace_id_malformed; ' +
                'header ≠ body → 400 trace_id_conflict; absent → stored NULL. Not used by conformance.',
            },
            tenant_id: { type: 'string', format: 'uuid', description: 'REQUIRED. The pin is looked up under this tenant only; the row is filed under it.' },
            project_id: { type: 'string', format: 'uuid', description: 'Optional consistency check: must resolve to tenant_id, else 409 card_not_pinned. Never chooses a tenant.' },
            board_id: { type: 'string', description: 'Optional consistency check: must resolve to tenant_id, else 409 card_not_pinned. Never chooses a tenant.' },
          },
        } } },
      },
      responses: {
        '201': { description: 'Recorded' },
        '400': { description: 'body is not JSON, or tenant_id_required (missing or not a uuid)' },
        '401': { description: 'No / refused fr licence token (an X-Webhook-Secret header is ignored, G4)' },
        '409': { description: 'card_not_pinned (unpinned, pinned under another tenant, or a project_id/board_id hint not resolving to tenant_id)' },
        '422': { description: 'validation_failed' },
      },
    },
  },
  {
    area: 'reports', id: 'reports.mark_bug_report_fixed', method: 'POST', path: '/api/reports/:reportId/fix', handler: 'handleMarkBugReportFixed', effect: 'write',
    unauthorized401: "`error` 'Missing or invalid Authorization header' / 'Invalid or expired token' (validateAuth).",
    nonJson400: true,
    rule: resolvedTenant,
    tenancy: 'tenant',
    licenceOps: ['report.markBugReportFixed'],
    source: { module: 'src/routes/reports.ts', load: () => import('../../routes/reports') },
    frozen: {
      "summary": "Record that a bug_report is fixed",
      "description": "APPEND-ONLY (George 2026-10-11): writes a `bug_fix` report row pointing at the bug_report; the insert-once, content-hashed bug_report row itself is never changed. At most one fix per bug_report: the same commit again is 200 with the stored row; a different commit is 409 `bug_report_already_fixed`. Callers: a licence (the conveyor) or the aa-orchestrator role, or a super-admin; tenant-scoped like GET /api/reports/{reportId}.",
      "tags": [
        "Report"
      ],
      "operationId": "markBugReportFixed",
      "security": [
        {
          "bearerAuth": []
        }
      ],
      "parameters": [
        {
          "name": "reportId",
          "in": "path",
          "required": true,
          "description": "The bug_report's id",
          "schema": {
            "type": "string",
            "format": "uuid"
          }
        }
      ],
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "additionalProperties": false,
              "required": ["commit_sha"],
              "properties": {
                "commit_sha": { "type": "string", "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$", "description": "The FULL commit sha (40 or 64 hex); abbreviations are refused" },
                "pr_url": { "type": "string", "format": "uri" },
                "card_id": { "type": "string" },
                "note": { "type": "string" }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Already recorded with the same commit (the stored row)",
          "content": { "application/json": { "schema": { "type": "object" } } }
        },
        "201": {
          "description": "The new bug_fix row",
          "content": { "application/json": { "schema": { "type": "object" } } }
        },
        "403": {
          "description": "Not the conveyor (licence / orchestrator) or a super-admin",
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
        },
        "404": {
          "description": "No such bug_report in the caller's tenant",
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
        },
        "409": {
          "description": "Already recorded as fixed by a different commit (bug_report_already_fixed)",
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
        },
        "422": {
          "description": "commit_sha is not a full sha, or an unknown key",
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
        }
      }
    },
  },
  {
    area: 'notifications', id: 'notifications.dispatch_notification', method: 'POST', path: '/api/notifications/dispatch', handler: 'handleDispatchNotification', effect: 'write',
    rule: internalTenant,
    tenancy: 'tenant',
    licenceOps: ['notification.dispatch'],
    source: { module: 'src/routes/notifications/dispatch.ts', load: () => import('../../routes/notifications/dispatch') },
    frozen: {
      summary: 'Dispatch an outbound notification (internal tenants, or a licence to its own tenant\'s users)',
      description:
        'The decoupled communication-hub seam: callers ask fr to notify instead of owning a ' +
        'messaging channel themselves. Exactly two routing modes — `recipientUserId` fans the ' +
        "message out across that user's enabled channel prefs, while `channel` + `address` sends " +
        'to one explicit target (e.g. a telegram ops group) with no user mapping. ' +
        '⚠️ This body is camelCase, unlike the snake_case improvement-card surface. ' +
        'Admits the SYSTEM tenant as well as the three improvement workspaces ' +
        '(`requireAnyInternalTenant`); the execution tenant and every customer tenant get **404, ' +
        'not 403**. ' +
        'A **licence** caller (the tenant\'s conveyor seat) is admitted TENANT-BOUND and only in ' +
        '`recipientUserId` mode: any `channel`/`address` field is 403 ' +
        '`licence_raw_address_forbidden`, and a recipient without a workspace role in the ' +
        'licence\'s tenant (unknown, or in another tenant — one answer for both) is 403 ' +
        '`licence_recipient_not_in_tenant`. Nothing is sent on either refusal. ' +
        "A licence may not choose `engagementType` (omit it; it is always 'licence_notification', " +
        'anything else is 403 `licence_engagement_type_forbidden`), its `correlationId` must match ' +
        '`^[A-Za-z0-9._-]{1,128}$` (else 400 `licence_correlation_id_invalid`) and is stored as ' +
        '`licence:<tenantId>:<correlationId>` (generated when omitted), and its `text` may not carry a ' +
        'bracketed machine tag — any `[<word>:` such as `[ApprovalId:…]` / `[AnswerFor:…]`, case- and ' +
        'whitespace-insensitive (403 `licence_reply_tag_forbidden`); ordinary brackets like `[draft]` are fine. ' +
        'Two constraints OpenAPI 3.0 cannot express, both enforced by zod `.refine` and both ' +
        'returning 422: (1) provide `recipientUserId`, OR both `channel` and `address`; ' +
        "(2) `actionId` is REQUIRED whenever `kind` is not 'text' (i.e. for 'action-result' and " +
        "'action-error'). " +
        '⚠️ Success is **202 `{ queued: true }`**, not 200/201 — the send is issued and the ' +
        'caller is never blocked on the channel outcome. 202 does NOT imply a delivery record: ' +
        'the `recipientUserId` mode writes one engagement_deliveries row per attempt, but the ' +
        '`channel` + `address` mode writes NOTHING and drops the adapter result, so a transport ' +
        'failure there leaves no durable trace.',
      tags: ['Notifications'],
      operationId: 'dispatchNotification',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string', minLength: 1, maxLength: 10000 },
                recipientUserId: {
                  type: 'string',
                  format: 'uuid',
                  description:
                    "Fan-out mode. Required unless both `channel` and `address` are given.",
                },
                channel: {
                  type: 'string',
                  enum: [
                    'teams',
                    'telegram',
                    'websocket',
                    'email',
                    'voice',
                    'inapp',
                  ],
                  description:
                    'Direct mode. Must be accompanied by `address`. An enum value with no ' +
                    'registered adapter is a 422, not a 400.',
                },
                address: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 512,
                  description: 'Direct mode target; required with `channel`.',
                },
                kind: {
                  type: 'string',
                  enum: ['text', 'action-result', 'action-error'],
                  default: 'text',
                  description:
                    "Anything other than 'text' requires `actionId`.",
                },
                actionId: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description:
                    "Required when `kind` !== 'text'; carried through as the message meta.",
                },
                correlationId: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description: "Defaults to '' on the built message when omitted.",
                },
                engagementType: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 64,
                  description:
                    "Defaults to 'notification'. A licence caller may not set it (always " +
                    "'licence_notification').",
                },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Send issued (queued); not a delivery confirmation',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  queued: { type: 'boolean', enum: [true] },
                  notSent: {
                    type: 'array',
                    description:
                      "Present only when a channel sent NOTHING because its delivery record could not be " +
                      "written first (licence notifications are recorded before they are sent; error " +
                      "'delivery_record_failed').",
                    items: {
                      type: 'object',
                      required: ['channel', 'error'],
                      properties: {
                        channel: { type: 'string' },
                        error: { type: 'string', enum: ['delivery_record_failed'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Licence caller only: `licence_correlation_id_invalid` (correlationId outside ' +
            '`^[A-Za-z0-9._-]{1,128}$`)',
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
          description:
            'Licence caller only: `licence_raw_address_forbidden` (channel/address mode), ' +
            '`licence_recipient_not_in_tenant` (recipient holds no workspace role in the licence\'s tenant), ' +
            '`licence_engagement_type_forbidden` (engagementType other than licence_notification) or ' +
            '`licence_reply_tag_forbidden` (text carries a bracketed machine tag `[<word>:`, e.g. [ApprovalId:…] / [AnswerFor:…])',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '404': {
          description:
            'Caller is not one of the four internal tenants — 404, not 403, so the surface stays ' +
            'private',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '422': {
          description:
            "Invalid JSON or body failed validation (`{ error: 'Validation error', details }`), " +
            "or the requested channel has no registered adapter " +
            "(`{ error: \"channel '<x>' not registered\" }`)",
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
    area: 'internal', id: 'internal.report_andon_read_failure', method: 'POST', path: '/api/internal/andon/read-failure', handler: 'handlePostAndonReadFailure', effect: 'write',
    rule: never,
    principal: 'service', agentReason: 'service-to-service',
    source: { module: 'src/routes/andon.ts', load: () => import('../../routes/andon') },
    frozen: {
      summary: 'The n8n andon chokepoint brake reports a cord it could NOT read (fr#1195)',
      description:
        'UNAUTHENTICATED, same posture as `GET /api/internal/andon`: NetworkPolicy on the fr namespace ' +
        'plus the `/api/internal/` path prefix are the gate. A Bearer here would fail exactly when the ' +
        'auth stack is the thing that is down, i.e. in the outage class this endpoint exists to describe. ' +
        'The brake fails CLOSED after a grace window, so a cord it cannot READ halts autonomous work with ' +
        'nobody having chosen that \u2014 and fr cannot observe those events itself, because a consult that ' +
        'never arrived leaves no trace in any series fr publishes. Hence `consecutive` is REPORTED by the ' +
        'caller, not derived here. Feeds three counters/gauges on `GET /api/metrics/prom` \u2014 ' +
        '`fr_andon_halt_total{cause,caller}`, `fr_andon_probe_unreadable_total{caller}` and ' +
        '`fr_andon_probe_unreadable_streak` \u2014 and NOTHING else; `fr_andon_engaged` is unreachable from ' +
        'this handler and keeps meaning exactly \'is the cord pulled\'. `caller` is an untrusted label ' +
        'value: charset-restricted to [A-Za-z0-9_.:-], clamped to 64 chars, and collapsed to `other` once ' +
        '32 distinct callers are known, so the series count is bounded whatever is POSTed. UNKNOWN KEYS ' +
        'ARE IGNORED (the n8n half ships from another repo on another schedule); the three fields below ' +
        'are validated strictly and a 400 carries `code: invalid_read_failure_report` so the caller can ' +
        'tell a rejected REPORT from an unreadable CORD.',
      tags: ['Internal'],
      operationId: 'reportAndonReadFailure',
      'x-internal': true,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['caller', 'consecutive', 'halted'],
              properties: {
                caller: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 256,
                  description:
                    'Who failed to read the cord \u2014 a workflow name. Self-asserted, NOT an identity: used only as a bounded metric label. Longer than 256 chars is refused rather than truncated.',
                },
                consecutive: {
                  type: 'integer',
                  minimum: 1,
                  description:
                    'Failed reads IN A ROW as counted by the caller. Clamped to 100000; `< 1` is refused because it would contradict the report existing.',
                },
                halted: {
                  type: 'boolean',
                  description:
                    'Did the caller HALT on this one (grace window expired)? No default in either direction \u2014 a brake that cannot say gets a 400.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Recorded. Echoes the NORMALISED caller so the caller can see that its label was clamped or collapsed into `other`.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['accepted', 'caller', 'consecutive', 'halted'],
                properties: {
                  accepted: { type: 'boolean' },
                  caller: { type: 'string' },
                  consecutive: { type: 'integer' },
                  halted: { type: 'boolean' },
                },
              },
            },
          },
        },
        '400': {
          description:
            '`invalid_read_failure_report` \u2014 body not JSON/not an object, or one of the three fields missing or of the wrong type. `details.reason` names which.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  },
  {
    area: 'internal', id: 'internal.get_card_platform_owner', method: 'GET', path: '/api/internal/cards/:cardId/platform-owner', handler: 'handleGetCardPlatformOwner', effect: 'read',
    rule: never,
    principal: 'service', agentReason: 'service-to-service',
    source: { module: 'src/routes/internal-card-platform-owner.ts', load: () => import('../../routes/internal-card-platform-owner') },
    frozen: {
      summary: "Is this card owned by a PLATFORM tenant? (worker_management prompt-release check)",
      description:
        'X-Internal-Token ONLY, compared constant-time (HMAC) to FR_WM_CARD_LOOKUP_TOKEN (worker_management\'s own token). ' +
        'Unset env -> 503 `card_lookup_unconfigured`. A missing/wrong token, a cardId that is not 19 digits, a missing card, ' +
        'an unattributable board and a CUSTOMER-tenant card all return the SAME 404 `card_not_found` body. ' +
        'Planka/DB failure -> 503 `card_lookup_unavailable`. 200 only for a card whose board resolves to a platform tenant.',
      tags: ['Internal'],
      operationId: 'getCardPlatformOwner',
      security: [{ internalToken: [] }],
      'x-internal': true,
      parameters: [
        { name: 'cardId', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9]{19}$' } },
      ],
      responses: {
        '200': {
          description: 'Platform-owned card',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['card_id', 'tenant_id', 'platform'],
                properties: {
                  card_id: { type: 'string' },
                  tenant_id: { type: 'string' },
                  platform: { type: 'boolean', enum: [true] },
                },
              },
            },
          },
        },
        '404': { description: '`card_not_found` — bad token, malformed id, missing, unattributable or customer card (indistinguishable)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '503': { description: '`card_lookup_unconfigured` (env unset) or `card_lookup_unavailable` (Planka/DB failure)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'internal', id: 'internal.post_card_computed_check', method: 'POST', path: '/api/internal/cards/:cardId/computed-checks', handler: 'handleInternalComputedCheck', effect: 'write',
    rule: never,
    principal: 'service', agentReason: 'service-to-service',
    licenceOps: ['computedChecks.write'],
    source: { module: 'src/routes/internal-computed-checks.ts', load: () => import('../../routes/internal-computed-checks') },
    frozen: {
      summary: 'Record a COMPUTED evaluator verdict for a card (the DONE guard reads it)',
      description:
        'Two doors (G4, 2026-10-10). An fr LICENCE token (no X-Internal-Token) writes ONLY the n8n kinds ' +
        'verify_coding / grid_qa_computed (written_by n8n.verify-coding / n8n.grid-qa), and only for a card whose board is in the licence tenant (else 403 ' +
        'licence_tenant_mismatch). X-Internal-Token: ' +
        'FR_COMPUTED_CHECK_START_TOKEN (start_plan_checks as n8n.start-plan-checks — unset until U-PS-TOKEN, and a start_plan_checks `pass` is refused 422 pass_without_computed_evidence until then). ' +
        'The former N8N / GRID tokens match no caller any more (401). `written_by` is derived from the door/kind. ' +
        'A bearer without a valid token (a human JWT) -> 403 `computed_check_writer_required`; no credential -> 401; every env ' +
        'unset, or two callers sharing a token -> 503. A pass needs computed evidence (verify_coding, grid_qa_computed: ' +
        'computed_ops_passed >= 1; r10: isolation true) or 422 ' +
        '`pass_without_computed_evidence`. Finally the ' +
        "card's card_type is read from Planka (unreadable -> 503 `card_type_unavailable`) and the kind must be allowed for " +
        'it by the kind<->card-type table (backend/src/lib/computed-kind-table.ts), else 422 ' +
        '`kind_not_allowed_for_card_type` with `card_type` and `check_kind`. Append-only.',
      tags: ['Internal'],
      operationId: 'postInternalCardComputedCheck',
      security: [{ internalToken: [] }],
      'x-internal': true,
      parameters: [{ name: 'cardId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['check_kind', 'verdict', 'evidence_sha'],
              properties: {
                check_kind: {
                  type: 'string',
                  enum: ['verify_coding', 'r10_proof_core', 'grid_qa_computed', 'start_plan_checks'],
                },
                verdict: { type: 'string', enum: ['pass', 'fail'] },
                evidence_sha: { type: 'string', pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$' },
                computed_ops_passed: { type: 'integer', minimum: 0 },
                isolation: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Recorded', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Body not JSON or fails the schema', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: '`invalid_internal_token`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: '`computed_check_writer_required` (user token) or `check_kind_not_permitted`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: '`pass_without_computed_evidence` or `kind_not_allowed_for_card_type` (with `card_type`, `check_kind`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '503': { description: '`computed_check_receiver_unconfigured` (no writer token set), `computed_check_receiver_misconfigured` (two callers share a token) or `card_type_unavailable` (Planka card read failed)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    area: 'internal', id: 'internal.get_projects_tenant_map', method: 'GET', path: '/api/internal/projects/tenant-map', handler: 'handleGetProjectsTenantMap', effect: 'read',
    rule: never,
    principal: 'service', agentReason: 'service-to-service',
    source: { module: 'src/routes/internal-projects-tenant-map.ts', load: () => import('../../routes/internal-projects-tenant-map') },
    frozen: {
      summary: "Every project's owning tenant, for billing-service's project-ownership check",
      description:
        'X-Internal-Token ONLY, compared constant-time to FR_BILLING_INTERNAL_TOKEN (billing-service\'s own token). ' +
        'Unset env -> 503 (fail closed); missing/wrong token -> 401. Returns ALL projects, archived included. ' +
        '`tenant_id` is `project_data->>keycloak_tenant_id`, null when absent.',
      tags: ['Internal'],
      operationId: 'getProjectsTenantMap',
      security: [{ internalToken: [] }],
      'x-internal': true,
      responses: {
        '200': {
          description: 'Project -> tenant map',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projects', 'generated_at'],
                properties: {
                  projects: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['project_id', 'tenant_id', 'archived'],
                      properties: {
                        project_id: { type: 'string', format: 'uuid' },
                        tenant_id: { type: 'string', format: 'uuid', nullable: true },
                        archived: { type: 'boolean' },
                      },
                    },
                  },
                  generated_at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        '401': { description: 'Missing or wrong X-Internal-Token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '503': { description: '`tenant_map_not_configured` — FR_BILLING_INTERNAL_TOKEN unset', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
];

export const SERVICE_FROZEN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities(
  { area: 'webhooks', tenancy: 'tenant', module: 'src/routes/webhooks.ts', load: () => import('../../routes/webhooks') },
  SERVICE_ROUTES,
);
