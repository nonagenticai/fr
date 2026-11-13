// The kata routes (routes/katas.ts; docs/design/kata-super-admin.md §5 + the kata build contract).
// operationIds are BINDING: n8n-nodes-fr's ops and the kata flows call them by name.
//
// Callers (routes/katas.ts `KATA_ROUTE_CALLERS`, the one table the handlers read): a super_admin
// on a human token, and the CONVEYOR LICENCE (a licence of the v4 or AA conveyor tenant). No
// tenant role reaches any of them. The licence rows are on lib/licence-route-allowlist.ts; the
// super-admin-only routes are not, so a licence there is refused by the server's door.
import { z } from 'zod';

import { KATA_STATES } from '../../db/schema';
import { defineCapability, type Capability, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { isAuthenticatedSuperAdmin, isKataCaller } from '../rbac-rules';
import { frErrorBody, pathId, routeRule, unauthorizedBody, VALIDATE_AUTH_401 } from '../library/_shared';
import { LICENCE_ROUTE_DOOR_403 } from '../settings/_shared';

const iso = z.string().describe('ISO-8601 timestamp');
const state = z.enum(KATA_STATES);

const linkedCard = z.object({
  card_id: z.string(),
  board_id: z.string().nullable(),
  phase: z.string().nullable(),
  linked_at: iso,
  rerun_at: iso.optional().describe('Set once the kata re-pulled the card.'),
});

const kata = z.object({
  id: z.string().uuid().describe("The kata's id = its kata project's fr id (a project of the `kata` tenant)."),
  source_project_id: z.string().uuid(),
  source_tenant_id: z.string().uuid(),
  source_card_id: z.string().nullable(),
  source_execution_id: z.string().nullable(),
  source_board_id: z.string().nullable(),
  source_phase: z.string().nullable(),
  symptom: z.string(),
  opened_by: z.string().describe("'coach' (every licence open; a forwarded requested_by is not provenance)."),
  signature: z.string().describe('Immutable once opened.'),
  root_cause_class: z.string().nullable(),
  target_flow: z.string().nullable(),
  target_flow_id: z.string().nullable(),
  base_version_id: z.string().nullable(),
  published_version_id: z.string().nullable(),
  state,
  state_detail: z.string().nullable(),
  replay_passed: z.number().int().nullable(),
  replay_total: z.number().int().nullable(),
  evidence: z.record(z.unknown()),
  ops: z.array(z.record(z.unknown())).nullable(),
  replays: z.array(z.record(z.unknown())).nullable(),
  linked_cards: z.array(linkedCard),
  kata_board_id: z.string().nullable(),
  kata_card_id: z.string().nullable(),
  opened_at: iso,
  qa_at: iso.nullable(),
  published_at: iso.nullable(),
  closed_at: iso.nullable(),
  failed_at: iso.nullable(),
  rollback_requested_at: iso.nullable(),
  rollback_delivered_at: iso.nullable().describe('When kata-n8n accepted the rollback webhook; NULL while a requested rollback is undelivered (a repeat or Rollback resends it).'),
  rolled_back_at: iso.nullable(),
  rollback_refused_at: iso.nullable().describe("When a coach repeat's rollback was last refused by the rollback guard."),
  rollback_refused_reason: z.string().nullable().describe("'kata_rollback_no_base' or 'kata_rollback_superseded'."),
  cord_engaged_at: iso.nullable(),
  cord_held_seconds: z.number().int().describe('Total time this kata held the conveyor cord, accrued on every release.'),
  cord_released_at: iso.nullable().describe('When a super-admin released this FAILED kata\'s cord (POST /api/katas/:id/release); NULL while a failed kata still holds.'),
  cord_released_by: z.string().nullable().describe("'super_admin:<sub>' of that release."),
  updated_at: iso,
  cord: z.object({
    held: z.boolean().describe('The kata id is in andon_state.kata_holders: while running or qa, and once FAILED until a super-admin releases it (George 2026-11-04).'),
    since: iso.nullable(),
  }),
});

const windowStats = z.object({
  opened: z.number().int(),
  published: z.number().int(),
  failed: z.number().int(),
  rolled_back: z.number().int(),
  paused_seconds: z.number().int().describe('Cord time of the katas opened in the window (a held kata: so far).'),
});

const cordRelease = z
  .object({ released: z.boolean(), worker_scaled_up: z.boolean(), worker_scale_error: z.string().nullable() })
  .optional()
  .describe('Present when the change released the kata\'s hold on the cord: qa → published, or a super-admin Release of a failed kata. Entering failed never releases.');

const cordJoin = z
  .object({ worker_replicas: z.number().int().nullable(), worker_scale_error: z.string().nullable() })
  .describe(
    "The fresh kata's cord join (n8n-worker → 0). `worker_replicas` is the LIVE Deployment reading taken after the join, and a 201 is only returned when it measured exactly 0, so on this path the conveyor IS stopped. A non-null `worker_scale_error` therefore reports the scale PATCH's own problem (refused, threw, echoed a different count, or its follow-up read failed) while the Deployment still measured 0 — not that the worker may be running. When the live count is not 0 the open fails with 502 `kata_cord_not_effective` instead.",
  );

const AUTH_401: ResponseSpec = { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody };
const forbidden = (who: string): ResponseSpec => ({
  status: 403,
  description: `\`code\` 'kata_caller_not_allowed': not ${who} (every tenant role is refused). Or \`code\` ${LICENCE_ROUTE_DOOR_403}`,
  schema: frErrorBody,
});
const NOT_FOUND: ResponseSpec = { status: 404, description: "`code` 'kata_not_found'.", schema: frErrorBody };
const transition409 = (extra = ''): ResponseSpec => ({
  status: 409,
  description: `\`code\` 'kata_invalid_transition' (with \`details.from\`, \`details.to\`, \`details.allowed\`), 'kata_state_changed' (retry).${extra} Nothing changed.`,
  schema: frErrorBody,
});
const DEFAULT: ResponseSpec = {
  status: 'default',
  description:
    "400 `code` 'BAD_REQUEST' (not JSON). 422 'Validation error' (the body or query). 503 `code` 'andon_busy' (another cord decision is running; retry). fr's own 500.",
  schema: frErrorBody,
};

const SUPER = routeRule(isAuthenticatedSuperAdmin);
const SUPER_OR_LICENCE = routeRule(isKataCaller({ withSuperAdmin: true }));
const LICENCE_ONLY = routeRule(isKataCaller({ withSuperAdmin: false }));
const BOTH_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { licenceToken: [] }];
const LICENCE_SECURITY: Array<Record<string, string[]>> = [{ licenceToken: [] }];

const handler = (exportName: string) => lazyHandler(() => import('../../routes/katas'), { module: 'src/routes/katas.ts', exportName });

const R = {
  list: { method: 'GET' as const, path: '/api/katas' },
  get: { method: 'GET' as const, path: '/api/katas/:id' },
  open: { method: 'POST' as const, path: '/api/katas' },
  update: { method: 'PATCH' as const, path: '/api/katas/:id' },
  close: { method: 'POST' as const, path: '/api/katas/:id/close' },
  stop: { method: 'POST' as const, path: '/api/katas/:id/stop' },
  rollback: { method: 'POST' as const, path: '/api/katas/:id/rollback' },
  release: { method: 'POST' as const, path: '/api/katas/:id/release' },
};

const id = pathId('Kata id (a uuid; anything else answers 404 kata_not_found)');

const common = {
  area: 'andon' as const,
  errors: [],
  tenancy: 'platform' as const,
  agent: { expose: false as const, reason: 'out-of-agent-scope' as const },
};

export const KATA_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    ...common,
    id: 'katas.list',
    summary: 'Every kata, newest first, with today\'s and the last 7 days\' totals and the kata holding the cord (super-admin)',
    http: { ...R.list, operationId: 'listKatas' },
    input: z.object({
      state: state.optional(),
      project: z.string().uuid().optional().describe('The SOURCE project (the one that showed the symptom).'),
    }),
    output: z.object({
      items: z.array(kata),
      stats: z.object({ today: windowStats, last7d: windowStats }),
      holding: z.object({ kata_id: z.string().uuid(), since: iso.nullable() }).nullable(),
      failed_holders: z
        .array(z.string().uuid())
        .describe('FAILED katas still holding the cord: only a super-admin Release (POST /api/katas/:id/release) frees them.'),
    }),
    auth: { principal: 'user', rbac: SUPER(R.list) },
    effect: 'read',
    confirm: 'none',
    openapi: { tags: ['Katas'], responses: [AUTH_401, forbidden('a super_admin'), DEFAULT] },
    legacyHandler: handler('handleListKatas'),
  }),
  defineCapability({
    ...common,
    id: 'katas.get',
    summary: 'One kata: the row, its cord hold and its linked cards (super-admin, conveyor licence)',
    http: { ...R.get, operationId: 'getKata' },
    input: z.object({ id }),
    output: kata,
    auth: { principal: 'user', rbac: SUPER_OR_LICENCE(R.get) },
    effect: 'read',
    confirm: 'none',
    licence: { ops: ['katas.getKata'] },
    openapi: { tags: ['Katas'], security: BOTH_SECURITY, responses: [AUTH_401, forbidden('a super_admin or the conveyor licence'), NOT_FOUND, DEFAULT] },
    legacyHandler: handler('handleGetKata'),
  }),
  defineCapability({
    ...common,
    id: 'katas.open',
    summary: 'Open a kata from a symptom and start it: the conveyor pauses (conveyor licence); a super-admin hand-open goes through the coach',
    description:
      "CONVEYOR LICENCE: with `signature`, the most recent kata of that signature decides: running/qa → 200 `action:'linked'` (the " +
      "card joins `linked_cards`); published, or closed < 7 days ago → 200 `action:'rollback_requested'` (kata-n8n's `kata.rollback` is " +
      "posted after the request commits, and resent by a later repeat until it is delivered); otherwise a fresh kata: its project in the `kata` tenant, the row in `running`, the cord pulled (n8n-worker → 0) " +
      "and its first `wf_change` card created in TODO and moved to READY → 201 `action:'opened'` with `cord_join` (a non-null `cord_join.worker_scale_error` = the worker was NOT scaled to 0). SUPER-ADMIN: `source:'operator'` " +
      "with `source_project_id`, `source_card_id`, `symptom` (and optionally `source_execution_id`) is forwarded to the conveyor " +
      "coach's `kata.open` webhook → 202 `{status:'requested'}`; the coach then opens the kata with the licence.",
    http: { ...R.open, operationId: 'openKata' },
    input: z.object({
      source: z.literal('operator').optional().describe("Super-admin only, and then required: the hand-open."),
      source_project_id: z.string().uuid().describe('The project that showed the symptom (any tenant).'),
      source_card_id: z.string().optional().describe('Required on a hand-open.'),
      source_execution_id: z.string().optional(),
      source_board_id: z.string().optional().describe('Licence only.'),
      source_phase: z.string().optional().describe('Licence only.'),
      symptom: z.string(),
      signature: z.string().optional().describe('Licence: required. {flow_name, node, check} as the coach computes it.'),
      root_cause_class: z.string().optional(),
      target_flow: z.string().optional(),
      target_flow_id: z.string().optional(),
      base_version_id: z.string().optional(),
      evidence: z.record(z.unknown()).optional().describe('Licence: required. The coach\'s evidence object.'),
      requested_by: z
        .string()
        .uuid()
        .optional()
        .describe("Licence only: the super-admin's sub from a forwarded hand-open (`kata.open` payload). Accepted and ignored: a licence open always records `opened_by = 'coach'`."),
    }),
    output: z.union([
      z.object({ kata, action: z.literal('opened'), cord_join: cordJoin }),
      z.object({ kata, action: z.literal('linked') }),
      z.object({ kata, action: z.literal('rollback_requested'), rollback_webhook: z.object({ kind: z.string() }) }),
      z.object({ kata, action: z.literal('rollback_pending') }).describe('A repeat of a published kata whose rollback kata-n8n already accepted: nothing sent.'),
      z
        .object({
          kata,
          action: z.literal('rollback_refused'),
          reason: z.enum(['kata_rollback_no_base', 'kata_rollback_superseded']),
          later_kata_id: z.string().uuid().optional(),
        })
        .describe('A repeat whose rollback the guard refuses (no base_version_id, or a later kata published on the same target_flow): nothing requested or sent; recorded on the kata.'),
      z.object({ status: z.literal('requested') }),
    ]),
    auth: { principal: 'user', rbac: SUPER_OR_LICENCE(R.open) },
    effect: 'write',
    confirm: 'card',
    licence: { ops: ['katas.openKata'] },
    openapi: {
      tags: ['Katas'],
      security: BOTH_SECURITY,
      responses: [
        AUTH_401,
        forbidden('a super_admin or the conveyor licence'),
        { status: 404, description: "`code` 'kata_source_project_not_found'.", schema: frErrorBody },
        {
          status: 409,
          description:
            "`code` 'kata_open_in_progress' (the same signature is being opened right now; retry), 'kata_signature_open', " +
            "'catalogue_not_initialised', or the global andon is engaged (no project can be created). Super-admin hand-open: 'conveyor_paused' " +
            "(the operator cord is engaged or any kata — a failed one included — holds it; `details.operator`, `details.kata_holders`). Nothing changed.",
          schema: frErrorBody,
        },
        {
          status: 502,
          description:
            "`code` 'kata_first_card_failed' (the kata was failed and the cord released), 'kata_cord_not_effective' (the cord joined but the live n8n-worker Deployment was not measured at 0, so the kata was failed BEFORE its card reached READY and it keeps the hold until a super-admin releases it), " +
            "'kata_open_webhook_failed', or 'kata_rollback_webhook_failed' (a repeat: the rollback request committed, kata-n8n did not accept the webhook; the next repeat resends).",
          schema: frErrorBody,
        },
        {
          status: 503,
          description:
            "`code` 'kata_open_not_configured' (hand-open: CONVEYOR_N8N_WEBHOOK_BASE / CONVEYOR_START_WEBHOOK_SECRET unset; nothing sent), or " +
            "'kata_rollback_not_configured' (a repeat: the rollback request committed, the webhook cannot be sent).",
          schema: frErrorBody,
        },
        DEFAULT,
      ],
    },
    legacyHandler: handler('handleOpenKata'),
  }),
  defineCapability({
    ...common,
    id: 'katas.update',
    summary: "Report a kata's progress: fields in any state; a `state` only along the kata transitions (conveyor licence)",
    description:
      'A patch without `state` (or with the current one) updates fields in any state, except `base_version_id`, ' +
      '`target_flow` and `target_flow_id`: those only while the kata is running (also in the call that moves it on from ' +
      'running), else 409 `kata_field_frozen`. `signature` never changes: a different value is 400 `kata_signature_immutable`. ' +
      'A different `state` must be one of ' +
      'running→qa, qa→running (retry), qa→published (needs `base_version_id` and `published_version_id`, else 409 `kata_versions_missing`), ' +
      'running|qa→failed, published|closed→rolled_back (only after a rollback was ' +
      'requested). qa→published releases the kata\'s cord hold in the SAME transaction and accrues `cord_held_seconds`; ' +
      '→failed KEEPS the cord (George 2026-11-04: only a super-admin Release frees it). ' +
      '`linked_card_rerun` stamps `rerun_at` on those linked cards.',
    http: { ...R.update, operationId: 'updateKata' },
    input: z.object({
      id,
      state: state.optional(),
      state_detail: z.string().nullable().optional(),
      signature: z.string().optional().describe('Immutable: only the current value is accepted.'),
      root_cause_class: z.string().nullable().optional(),
      target_flow: z.string().nullable().optional(),
      target_flow_id: z.string().nullable().optional(),
      base_version_id: z.string().nullable().optional(),
      published_version_id: z.string().nullable().optional(),
      replay_passed: z.number().int().nullable().optional(),
      replay_total: z.number().int().nullable().optional(),
      ops: z.array(z.record(z.unknown())).optional(),
      replays: z.array(z.record(z.unknown())).optional(),
      linked_card_rerun: z.array(z.string()).optional(),
    }),
    output: z.object({ kata, cord_release: cordRelease }),
    auth: { principal: 'user', rbac: LICENCE_ONLY(R.update) },
    effect: 'write',
    confirm: 'card',
    licence: { ops: ['katas.updateKata'] },
    openapi: {
      tags: ['Katas'],
      security: LICENCE_SECURITY,
      responses: [
        AUTH_401,
        forbidden('the conveyor licence'),
        NOT_FOUND,
        transition409(" 'kata_rollback_not_requested', 'kata_signature_open' (another open kata has the signature), 'kata_field_frozen' (with `details.fields`: a running-only field outside running), 'kata_versions_missing' (publish without both versions; `details.fields`)."),
        { status: 400, description: "`code` 'kata_signature_immutable' (the patch changes or clears the signature), or 'BAD_REQUEST' (not JSON). Nothing changed.", schema: frErrorBody },
        DEFAULT,
      ],
    },
    legacyHandler: handler('handleUpdateKata'),
  }),
  defineCapability({
    ...common,
    id: 'katas.close',
    summary: 'Close a published kata and archive its kata project (conveyor licence)',
    description: 'Requires `published`. Archives the kata project (status archived; no PHI purge — a kata project holds none). 409 while the kata still holds the cord.',
    http: { ...R.close, operationId: 'closeKata' },
    input: z.object({ id }),
    output: z.object({ kata }),
    auth: { principal: 'user', rbac: LICENCE_ONLY(R.close) },
    effect: 'write',
    confirm: 'card',
    licence: { ops: ['katas.closeKata'] },
    openapi: {
      tags: ['Katas'],
      security: LICENCE_SECURITY,
      responses: [AUTH_401, forbidden('the conveyor licence'), NOT_FOUND, transition409(" 'kata_cord_held'."), DEFAULT],
    },
    legacyHandler: handler('handleCloseKata'),
  }),
  defineCapability({
    ...common,
    id: 'katas.stop',
    summary: 'Stop a running kata: failed and its kata project archived; it KEEPS the cord until a super-admin Release (super-admin break-glass)',
    http: { ...R.stop, operationId: 'stopKata' },
    input: z.object({ id }),
    output: z.object({ kata, cord_release: cordRelease }),
    auth: { principal: 'user', rbac: SUPER(R.stop) },
    effect: 'destructive',
    confirm: 'card-typed',
    openapi: { tags: ['Katas'], responses: [AUTH_401, forbidden('a super_admin'), NOT_FOUND, transition409(), DEFAULT] },
    legacyHandler: handler('handleStopKata'),
  }),
  defineCapability({
    ...common,
    id: 'katas.rollback',
    summary: "Roll a published or closed kata back: kata-n8n restores the flow's base version (super-admin)",
    description:
      "Sets `rollback_requested_at` (kept on a repeat) and calls kata-n8n's `kata.rollback` webhook with the kata id; the flow " +
      "re-reads the kata, restores `base_version_id`, reads it back and PATCHes `rolled_back`. 202 once kata-n8n accepted it.",
    http: { ...R.rollback, operationId: 'rollbackKata', successStatus: 202 },
    input: z.object({ id }),
    output: z.object({ status: z.literal('requested'), kata }),
    auth: { principal: 'user', rbac: SUPER(R.rollback) },
    effect: 'destructive',
    confirm: 'card-typed',
    openapi: {
      tags: ['Katas'],
      responses: [
        AUTH_401,
        forbidden('a super_admin'),
        NOT_FOUND,
        transition409(
          " 'kata_rollback_no_base' (no base_version_id recorded), 'kata_rollback_superseded' (a later kata published on the same target_flow; `details.later_kata_id`).",
        ),
        { status: 502, description: "`code` 'kata_rollback_webhook_failed' (rollback_requested_at is kept; retry).", schema: frErrorBody },
        { status: 503, description: "`code` 'kata_rollback_not_configured' (KATA_ROLLBACK_WEBHOOK_TOKEN unset; nothing changed).", schema: frErrorBody },
        DEFAULT,
      ],
    },
    legacyHandler: handler('handleRollbackKata'),
  }),
  defineCapability({
    ...common,
    id: 'katas.release',
    summary: "Release a FAILED kata's hold on the conveyor cord (super-admin only; George 2026-11-04)",
    description:
      'A failed kata keeps the cord: nothing releases it on a timer. This records who (`cord_released_by`) and when ' +
      '(`cord_released_at`), accrues `cord_held_seconds`, and removes the kata from the holder set; n8n-worker returns to 1 only ' +
      'when nobody else holds (the operator cord or any other kata) — `cord_release.worker_scaled_up`.',
    http: { ...R.release, operationId: 'releaseKata' },
    input: z.object({ id }),
    output: z.object({ kata, cord_release: cordRelease }),
    auth: { principal: 'user', rbac: SUPER(R.release) },
    effect: 'destructive',
    confirm: 'card-typed',
    openapi: {
      tags: ['Katas'],
      responses: [
        AUTH_401,
        forbidden('a super_admin'),
        NOT_FOUND,
        transition409(" 'kata_already_released' (this failed kata's cord was already released)."),
        DEFAULT,
      ],
    },
    legacyHandler: handler('handleReleaseKata'),
  }),
];
