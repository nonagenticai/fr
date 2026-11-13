// fr-agui SPEC §13 P4b (part 3) — spec drain: the analysis-to-kanban bridge
// `/api/tools/bridge/*` (routes/tools/bridge.ts), re-expressed with NO behaviour
// change (`legacyHandler`).
//
// ⚠️ FEATURE-FLAGGED. Nine of the ten rows were mounted only when FR_FEATURE_BRIDGE
// is on (`registerBridgeRoutes`); the commit callback always (`registerBridgeCommitRoute`:
// approvals parked before a rollback still call back into it). The declarations
// keep that: `http.mountedWhen` makes deriveRouter skip the nine when the flag is
// off. The served spec documents all ten either way (a flagged-off route answers
// the router's 404).
//
// ⚠️ THE ROUTES' AGENT TWINS STAY WHERE THEY ARE. The hand-written `bridge.*`
// actions (agui/actions/bridge.ts) are registered unconditionally and are not
// derived from here (`agent.expose:false`); the capability id equals the action
// name where one exists, so a later unit flips one declaration (KAG precedent,
// capabilities/kag/tools.ts).
//
// Gates, as the handlers enforce them (every route but the source list funnels
// through `buildBridgeCtx`):
//   * `GET /sources` — validateAuth only (its doors): `isAuthenticatedUser`;
//   * the rest — `project_id` present (query or body; 400 BEFORE authentication
//     when it is missing), validateAuth, `project_id` a uuid (400), then
//     `ctxTenantId(user.tenantId)` (the frame tenant, else the JWT one; with
//     neither it THROWS → 500): `isAuthenticatedUserInResolvedTenant`. The named
//     project must then be one of that tenant's (else 404 `draft_not_found`
//     'Project not found') — a RESOURCE check on the input, not the principal rule.
//     Drafts are listed for the caller's own (`drafter_id`) only.
//
// Inputs: no route validates its body against a schema (TypeScript casts only), so
// nothing refuses an unknown key; the declared bodies are typed and `.passthrough()`.
import { z } from 'zod';

import { FR_FEATURE_BRIDGE } from '../../config/feature-flags';
import { defaultConfirm, defineCapability, type Capability, type HttpMethod, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { isAuthenticatedUser, isAuthenticatedUserInResolvedTenant, type CapabilityRoute } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, unauthorizedBody } from '../settings/_shared';

const PRODUCERS = ['coding', 'kag', 'artifacts'] as const;
const DRAFT_STATUSES = ['editing', 'submitted', 'committed', 'rejected', 'deduped'] as const;

const iso = z.string().describe('ISO-8601 timestamp');

/** A `card_drafts` row as `jsonResponse` serialises it. */
const draftRow = z.object({
  id: z.string(),
  project_id: z.string(),
  drafter_id: z.string(),
  initiator: z.enum(['user', 'agent', 'cron']),
  producer: z.enum(PRODUCERS),
  run_id: z.string(),
  output_id: z.string(),
  stable_id: z.string(),
  content_digest: z.string(),
  title: z.string(),
  body_md: z.string(),
  target_project_id: z.string().nullable(),
  target_board_id: z.string().nullable(),
  target_list_id: z.string().nullable(),
  assignee_user_id: z.string().nullable(),
  labels: z.array(z.string()),
  status: z.enum(DRAFT_STATUSES),
  approval_id: z.string().nullable().describe('Set on submit.'),
  committed_card_id: z.string().nullable().describe('The Planka card, set on commit.'),
  dedup_of_card_id: z.string().nullable().describe('The existing card this draft duplicates.'),
  metadata: z.record(z.unknown()).describe('Bookkeeping (idempotency key, output-id set, coding job id).'),
  created_at: iso,
  updated_at: iso,
});

/** A producer's `ToolOutput` (domain/bridge/types.ts). */
const toolOutput = z.object({
  producer: z.enum(PRODUCERS),
  run_id: z.string(),
  output_id: z.string(),
  stable_id: z.string(),
  title: z.string(),
  body_md: z.string(),
  severity: z.enum(['low', 'moderate', 'high', 'critical']).optional(),
  source_ref: z
    .object({
      file_path: z.string().optional(),
      line_number: z.number().optional(),
      url: z.string().optional(),
      artifact_id: z.string().optional(),
      tool: z.string().optional(),
      rule_id: z.string().optional(),
    })
    .optional(),
  suggested_labels: z.array(z.string()).optional(),
  suggested_project_id: z.string().optional(),
});

const projectId = z.string().describe("The project (uuid): one of the request tenant's (else 404 'Project not found').");

/** The card fields a draft can be given (create `overrides`, PATCH `patch`). */
const draftFields = {
  title: z.string().optional(),
  body_md: z.string().optional(),
  target_project_id: z.string().optional(),
  target_board_id: z.string().optional(),
  target_list_id: z.string().optional().describe('The Planka list (column) the card lands in; checked on submit.'),
  labels: z.array(z.string()).optional(),
};

const ROUTE_400 =
  "400: `error.code` 'BAD_REQUEST' — `project_id` missing (answered BEFORE authentication) or not a uuid, the body is not JSON, " +
  'or a required field is missing. ';
const PROJECT_404 = "404: `error.code` 'draft_not_found' ('Project not found': not one of the request tenant's projects). ";
const NO_TENANT_500 = "500: fr's own (`error`), e.g. no tenant resolvable for the caller (no frame, no JWT tenant), or the database is unreachable.";

function responses(extra: string, o: { scoped?: boolean } = { scoped: true }): ResponseSpec[] {
  return [
    { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
    {
      status: 'default',
      description: (o.scoped ? ROUTE_400 + PROJECT_404 : '') + extra + DOOR_403 + ' ' + NO_TENANT_500,
      schema: frErrorBody,
    },
  ];
}

interface BridgeRoute {
  id: `bridge.${string}`;
  method: HttpMethod;
  path: string;
  handler: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  effect: Capability['effect'];
  responses: ResponseSpec[];
  successStatus?: 201;
  rule?: (route: CapabilityRoute) => Capability['auth']['rbac'];
  /** Mounted whatever FR_FEATURE_BRIDGE says (the commit callback). */
  alwaysMounted?: true;
}

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function bridgeCapability(r: BridgeRoute): Capability<unknown, unknown> {
  return defineCapability({
    id: r.id,
    area: 'bridge',
    summary: r.summary,
    ...(r.description !== undefined ? { description: r.description } : {}),
    http: {
      method: r.method,
      path: r.path,
      operationId: camel(r.id),
      ...(r.successStatus !== undefined ? { successStatus: r.successStatus } : {}),
      ...(r.alwaysMounted ? {} : { mountedWhen: () => FR_FEATURE_BRIDGE }),
    },
    input: r.input,
    output: r.output,
    errors: [],
    auth: { principal: 'user', rbac: (r.rule ?? routeRule(isAuthenticatedUserInResolvedTenant))({ method: r.method, path: r.path }) },
    tenancy: 'tenant',
    effect: r.effect,
    confirm: defaultConfirm(r.effect),
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { tags: ['Bridge'], responses: [...r.responses] },
    legacyHandler: lazyHandler(() => import('../../routes/tools/bridge'), { module: 'src/routes/tools/bridge.ts', exportName: r.handler }),
  });
}

const draftId = { id: pathId('Draft id') };
const created = z.object({ data: z.array(draftRow), meta: z.object({ replayed: z.boolean() }) });

export const BRIDGE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  bridgeCapability({
    id: 'bridge.list_sources', method: 'GET', path: '/api/tools/bridge/sources', handler: 'handleListSources',
    summary: 'The registered bridge producers (coding, kag, artifacts)', effect: 'read',
    input: z.object({}),
    output: z.object({ data: z.array(z.object({ id: z.enum(PRODUCERS), label: z.string() })) }),
    responses: responses('', { scoped: false }),
    rule: routeRule(isAuthenticatedUser),
  }),
  bridgeCapability({
    id: 'bridge.list_outputs', method: 'GET', path: '/api/tools/bridge/sources/:producer/outputs', handler: 'handleListOutputs',
    summary: "A producer's outputs for a project, each marked when it is already a card", effect: 'read',
    description:
      'Every other query parameter is handed to the producer as a filter (coding: `job_id`; …). `project_id` and `user_id` ' +
      'always come from the authenticated call, never the query. `meta.dedup` maps an output id to the card it already is.',
    input: z
      .object({
        producer: z.enum(PRODUCERS).describe('coding | kag | artifacts (else 404 unknown_producer)'),
        project_id: projectId,
      })
      .passthrough(),
    output: z.object({
      data: z.array(toolOutput),
      meta: z.object({
        dedup: z.record(z.object({ card_id: z.string(), match: z.enum(['stable_id', 'digest']) })),
        count: z.number().int(),
        dedup_known_count: z.number().int(),
      }),
    }),
    responses: responses(
      "404: `error.code` 'unknown_producer'. Any producer failure is relayed (`error.code` 'UPSTREAM_…' or a bridge code; " +
        'its 4xx pass through, its 401 / 5xx or no answer is 502). ',
    ),
  }),
  bridgeCapability({
    id: 'bridge.draft_cards_from_outputs', method: 'POST', path: '/api/tools/bridge/drafts', handler: 'handleCreateDrafts',
    summary: 'Draft one kanban card per producer output (editing; deduplicated against existing cards)', effect: 'write', successStatus: 201,
    description:
      'Idempotent on (project, producer, `idempotency_key`, the output-id SET): a replay answers 200 with `meta.replayed` and ' +
      'the original rows. A draft whose output is already a card is created `deduped`.',
    input: z
      .object({
        project_id: projectId,
        producer: z.enum(PRODUCERS),
        output_ids: z.array(z.string()).describe('Required (an array; else 400).'),
        overrides: z.object(draftFields).extend({ assignee_user_id: z.string().optional() }).passthrough().optional(),
        idempotency_key: z.string().optional(),
        coding_job_id: z.string().optional().describe("producer 'coding': the run whose findings carry these output ids (else X-Coding-Job-Id)."),
      })
      .passthrough(),
    output: created,
    responses: [
      { status: 200, description: 'An idempotent replay: the ORIGINAL drafts, nothing created again.', schema: created },
      ...responses(
        "404: `error.code` 'unknown_producer', 'output_not_found', 'coding_output_not_cached' / 'coding_output_unresolvable'. " +
          "422: 'coding_stable_id_unrecoverable'. 502: 'draft_insert_failed'. ",
      ),
    ],
  }),
  bridgeCapability({
    id: 'bridge.list_drafts', method: 'GET', path: '/api/tools/bridge/drafts', handler: 'handleListDrafts',
    summary: "The caller's own drafts in a project, newest first (capped)", effect: 'read',
    description:
      'Truncation rides in HEADERS, not the body: `X-Applied-Limit`, `X-Truncated` (true iff more rows exist) and ' +
      '`X-Count-State` (exact | at_least; absent ⇒ unknown).',
    input: z.object({
      project_id: projectId,
      status: z.string().optional().describe('Comma-separated draft statuses to keep (editing, submitted, committed, rejected, deduped).'),
      limit: z.string().optional().describe('A positive integer (else 400), default 100, capped at 200.'),
    }),
    output: z.object({ items: z.array(draftRow) }),
    responses: responses(''),
  }),
  bridgeCapability({
    id: 'bridge.get_draft', method: 'GET', path: '/api/tools/bridge/drafts/:id', handler: 'handleGetDraft',
    summary: 'One draft of a project', effect: 'read',
    input: z.object({ ...draftId, project_id: projectId }),
    output: z.object({ data: draftRow }),
    responses: responses("404: `error.code` 'draft_not_found' (not a draft of that project). "),
  }),
  bridgeCapability({
    id: 'bridge.edit_draft', method: 'PATCH', path: '/api/tools/bridge/drafts/:id', handler: 'handlePatchDraft',
    summary: 'Edit a draft that is still editing (title, body, target list, assignee, labels)', effect: 'write',
    input: z
      .object({
        ...draftId,
        project_id: projectId,
        patch: z.object(draftFields).extend({ assignee_user_id: z.string().nullable().optional() }).passthrough().describe('Required.'),
      })
      .passthrough(),
    output: z.object({ data: draftRow }),
    responses: responses("404: `error.code` 'draft_not_found'. 409: 'draft_not_editable' (no longer editing). 502: 'draft_update_failed'. "),
  }),
  bridgeCapability({
    id: 'bridge.submit_draft', method: 'POST', path: '/api/tools/bridge/drafts/:id/submit', handler: 'handleSubmitDraft',
    summary: 'Submit a draft for approval (it becomes a card once approved)', effect: 'write',
    input: z.object({ ...draftId, project_id: projectId }).passthrough(),
    output: z.object({
      data: z.object({ approval_id: z.string(), draft: draftRow, broadcasted_to: z.number().int().describe('Channels the approval request reached.') }),
    }),
    responses: responses(
      "404: `error.code` 'draft_not_found', 'target_list_not_found'. 409: 'draft_not_submittable'. 422: 'draft_missing_target_list'. " +
        "502: 'approval_insert_failed'. ",
    ),
  }),
  bridgeCapability({
    id: 'bridge.reject_draft', method: 'POST', path: '/api/tools/bridge/drafts/:id/reject', handler: 'handleRejectDraft',
    summary: 'Reject a draft', effect: 'write',
    input: z.object({ ...draftId, project_id: projectId, reason: z.string().optional() }).passthrough(),
    output: z.object({ data: draftRow }),
    responses: responses("404: `error.code` 'draft_not_found'. 409: 'draft_not_rejectable'. "),
  }),
  bridgeCapability({
    id: 'bridge.commit_draft', method: 'POST', path: '/api/tools/bridge/drafts/:id/commit', handler: 'handleCommitDraft',
    summary: 'Commit an approved draft to the kanban board (the approval callback)', effect: 'write',
    description:
      'Mounted whatever FR_FEATURE_BRIDGE says: approvals parked before a rollback still call back here. Idempotent: a draft ' +
      'already committed answers its card with `idempotent: true`.',
    input: z.object({ ...draftId, project_id: projectId }).passthrough(),
    output: z.object({ data: z.object({ card_id: z.string().describe('The Planka card.'), idempotent: z.boolean() }) }),
    responses: responses(
      "404: `error.code` 'draft_not_found'. 409: 'draft_not_committable'. 502: 'kanban_unexpected_response' or a Planka failure " +
        "(`error.code` 'UPSTREAM_…'). ",
    ),
    alwaysMounted: true,
  }),
  bridgeCapability({
    id: 'bridge.lookup_link', method: 'GET', path: '/api/tools/bridge/links', handler: 'handleLookupLink',
    summary: 'Whether a producer output (by stable id) is already a card in a project', effect: 'read',
    input: z.object({
      producer: z.enum(PRODUCERS).describe('Required (else 400; an unknown one 404).'),
      stable_id: z.string().describe('Required (else 400).'),
      project_id: projectId,
    }),
    output: z.object({
      data: z.object({
        match: z.enum(['stable_id']).nullable().describe("'stable_id': already a card (`card_id`); null: not yet."),
        card_id: z.string().optional().describe('The Planka card (with a match only).'),
      }),
    }),
    responses: responses("404: `error.code` 'unknown_producer'. "),
  }),
];
