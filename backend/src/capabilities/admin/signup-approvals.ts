// Early-access signup v2 (routes/signup-approvals.ts, services/signup/*), declared as capabilities.
//
//   signup_approvals.intake             POST /api/signup-approvals/intake                  service: the early-access-intake handler's SA
//   signup_approvals.telegram_decision  POST /api/signup-approvals/:id/telegram-decision   service: chat-bridge's SA (contract C3)
//   signup_approvals.{list,get,invite,approve,reject,retry,resolve_repair}                 super_admin (the /admin/onboarding screen)
//   signup_approvals.{remove,removal_retry,removal_resolve}                                super_admin: remove an approved workspace
//
// The two service doors verify their own token (service-token.ts: issuer, `exp`, azp, aud, role, no
// super_admin) — deny-all at the registry / agent layer. The super_admin routes keep their handlers
// (`legacyHandler`); fr is super_admin-provisioning-only, so none is agent-exposed. Every route
// answers 503 `signup_not_configured` unless FR_SIGNUP_ENABLED=true.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, type Capability, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { caughtAuthResponses, frErrorBody, pathId, routeRule, settingsCapabilities } from '../observe/_shared';

const never = { type: 'custom' as const, check: async () => false };
const BEARER = [{ bearerAuth: [] }];
const TAG = 'Early Access';
const MODULE = 'src/routes/signup-approvals.ts';
const load = () => import('../../routes/signup-approvals');

const LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl'] as const;
const NOT_CONFIGURED = "503: `error` 'signup_not_configured' (FR_SIGNUP_ENABLED is not true on this deployment). ";
const GATE = "403: `error` 'super-admin only'. ";
const BODY = "422: `error` 'invalid request body' (`details`: the zod issues; unknown keys refused). 400: `error` 'invalid JSON body'. ";

const step = z
  .object({
    status: z.enum(['ok', 'skipped', 'failed', 'waiting', 'unknown']),
    at: z.string(),
    code: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    detail: z.record(z.unknown()).optional(),
  })
  .describe('One provisioning step outcome.');

const approval = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    company: z.string().nullable(),
    message: z.string().nullable(),
    locale: z.enum(LOCALES).nullable(),
    source: z.enum(['web', 'chat', 'invite']),
    status: z.enum(['pending', 'approved', 'rejected', 'removed']),
    created_at: z.string(),
    decided_at: z.string().nullable(),
    decided_via: z.enum(['onboarding', 'telegram']).nullable(),
    decider_actor: z.string().nullable(),
    approving: z.boolean().describe('An approve holds the claim right now.'),
    tenant_name: z.string().nullable(),
    tenant_slug: z.string().nullable(),
    tenant_id: z.string().nullable(),
    suggested_tenant_name: z.string(),
    steps: z.record(step).describe('identity, provision, workspace, budget, catalogue, bundle, invite_email.'),
    steps_not_ok: z.array(z.object({ step: z.string(), status: z.string(), code: z.string().nullable() })),
    email_state: z.enum(['sent', 'waiting']),
    steps_attempts: z.number().int(),
    steps_next_attempt_at: z.string().nullable(),
    reject_repair: z
      .object({
        state: z.enum(['pending', 'done', 'failed', 'blocked', 'resolved_manually']),
        attempts: z.number(),
        next_attempt_at: z.string().nullable(),
        last_error: z.string().nullable(),
        blockers: z.array(z.string()),
        undid: z.array(z.string()),
        note: z.string().nullable(),
      })
      .nullable(),
    removal: z
      .object({
        state: z.enum(['pending', 'blocked', 'failed', 'done', 'resolved_manually']),
        tenant_id: z.string(),
        tenant_slug: z.string(),
        requested_by: z.string(),
        requested_at: z.string(),
        attempts: z.number(),
        last_attempt_at: z.string().nullable(),
        last_error: z.string().nullable(),
        blockers: z.array(z.string()),
        steps: z
          .record(
            z.object({
              status: z.enum(['ok', 'skipped', 'failed', 'blocked']),
              at: z.string(),
              code: z.string().nullable().optional(),
              error: z.string().nullable().optional(),
              detail: z.record(z.unknown()).optional(),
            }),
          )
          .describe('provisioning, licences, licences_tenant, workspace, grants, identity, finalize.'),
        note: z.string().nullable(),
      })
      .nullable()
      .describe('The early-access removal (null until a super_admin removes the approved row).'),
  })
  .describe('A signup approval as the onboarding screen shows it.');

const approved = z.object({
  approval,
  tenantId: z.string(),
  tenant: z.object({ id: z.string(), name: z.string().nullable(), slug: z.string().nullable() }),
  emailState: z.enum(['sent', 'waiting']).describe('`waiting`: the email follows once every step is ok (the tick retries).'),
  stepsNotOk: z.array(z.object({ step: z.string(), status: z.string(), code: z.string().nullable() })),
});

const id = { id: pathId('Signup approval id (a uuid; malformed = 404)') };

const APPROVE_ERRORS =
  "404 `error` 'approval_not_found'. 400 'approval_not_pending'. 409 'approval_in_progress' / 'approval_claim_lost' / " +
  "'identity_exists' (the address already has a realm login — provision it from Admin → Users) / 'tenant_name_unavailable'. " +
  "502 'provision_failed' / 'identity_failed' / 'licences_unreadable' / a licences refusal code. ";

export const SIGNUP_ADMIN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'signup_approvals',
    tag: TAG,
    tenancy: 'platform',
    module: MODULE,
    load,
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'signup_approvals.list', method: 'GET', path: '/api/signup-approvals', handler: 'handleListSignupApprovals', effect: 'read',
      summary: 'The early-access signup queue',
      input: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'removed', 'needs_attention']).optional() }),
      output: z.object({ items: z.array(approval).describe('Newest first, at most 500.') }),
      responses: caughtAuthResponses({ status: 'own' }, NOT_CONFIGURED + GATE + "422 `error` 'invalid_status_filter'. "),
    },
    {
      id: 'signup_approvals.get', method: 'GET', path: '/api/signup-approvals/:id', handler: 'handleGetSignupApproval', effect: 'read',
      summary: 'One early-access signup',
      input: z.object(id),
      output: z.object({ data: approval }),
      responses: caughtAuthResponses({ status: 'own' }, NOT_CONFIGURED + GATE + "404 `error` 'approval_not_found'. "),
    },
    {
      id: 'signup_approvals.invite', method: 'POST', path: '/api/signup-approvals/invite', handler: 'handleInviteSignup', effect: 'write',
      summary: 'Invite a person straight into early access (records a signup and approves it)',
      description:
        "A pending signup for the address is reused (its language overwritten by `locale`). Runs the same approve as POST …/:id/approve: " +
        'a new workspace, the requester its admin, the conveyor bundle, then ONE set-password email in `locale`.',
      input: z
        .object({
          email: z.string().email(),
          name: z.string().min(1).max(160),
          company: z.string().max(160).optional(),
          tenantName: z.string().min(2).max(120).optional(),
          locale: z.enum(LOCALES).optional(),
        })
        .strict(),
      output: approved.extend({ reusedPending: z.boolean() }),
      responses: caughtAuthResponses({ status: 'own', write: true }, NOT_CONFIGURED + GATE + BODY + APPROVE_ERRORS),
    },
    {
      id: 'signup_approvals.approve', method: 'POST', path: '/api/signup-approvals/:id/approve', handler: 'handleApproveSignup', effect: 'write',
      summary: 'Approve an early-access signup into a new workspace',
      description:
        'Mints the requester\'s login (no credential), provisions the tenant + licences (reserved slug), seats them as workspace admin, ' +
        'sets the budget, imports the PM catalogue, ensures the conveyor bundle, then sends ONE email (UPDATE_PASSWORD + VERIFY_EMAIL, ' +
        'landing at FR_PUBLIC_URL/). A failed later step is recorded and retried by the 5-minute tick; the email waits for it.',
      input: z.object({ ...id, tenantName: z.string().min(2).max(120).optional() }),
      output: approved,
      responses: caughtAuthResponses({ status: 'own', write: true }, NOT_CONFIGURED + GATE + BODY + APPROVE_ERRORS),
    },
    {
      id: 'signup_approvals.reject', method: 'POST', path: '/api/signup-approvals/:id/reject', handler: 'handleRejectSignup', effect: 'destructive',
      summary: 'Reject an early-access signup (and undo what an aborted approve of it left behind)',
      description:
        'On a rejected row whose cleanup is pending / blocked / failed this is the Retry of that cleanup. The cleanup reverses the ' +
        'provisioning run, archives the licences tenant, revokes the admin grant and deletes the login fr minted — never past a blocker.',
      input: z.object(id),
      output: z.object({ approval }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        NOT_CONFIGURED + GATE +
          "404 'approval_not_found'. 400 'approval_not_pending'. 409 'approval_in_progress' / 'signup_workspace_in_use' (`blockers`). " +
          "502 'signup_reject_cleanup_failed' (rejected; the cleanup is retried). ",
      ),
    },
    {
      id: 'signup_approvals.retry', method: 'POST', path: '/api/signup-approvals/:id/retry', handler: 'handleRetrySignupSteps', effect: 'write',
      summary: "Re-run an approved signup's unfinished provisioning steps now",
      input: z.object(id),
      output: z.object({ approval }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        NOT_CONFIGURED + GATE + "404 'approval_not_found'. 400 'approval_not_approved'. 409 'steps_in_progress'. ",
      ),
    },
    {
      id: 'signup_approvals.resolve_repair', method: 'POST', path: '/api/signup-approvals/:id/resolve-repair', handler: 'handleResolveSignupRepair', effect: 'write',
      summary: "Close a rejected signup's failed / blocked cleanup with a note",
      input: z.object({ ...id, note: z.string().min(1).max(1000), acknowledgeLiveAccess: z.boolean().optional() }),
      output: z.object({ approval }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        NOT_CONFIGURED + GATE + BODY + "404 'approval_not_found'. 409 'reject_repair_not_resolvable'. 422 'reject_repair_live_access_unacknowledged'. ",
      ),
    },
    {
      id: 'signup_approvals.remove', method: 'POST', path: '/api/signup-approvals/:id/remove', handler: 'handleRemoveSignup', effect: 'destructive',
      summary: 'Remove an approved early-access workspace end to end (confirm = its slug)',
      description:
        "Only an `approved` row with no blocker (another member's role in the workspace; a tenant this signup did not found). " +
        'Marks the row `removed`, then: reverses the provisioning run, revokes EVERY licence of the tenant (the person\'s and the ' +
        'conveyor bundle\'s) and confirms none is live, archives the licences tenant and the fr workspace, deletes the requester\'s ' +
        'role grants and the realm-fr login this signup minted, and releases the slug. Each step is recorded on `removal.steps` and ' +
        'audited in provisioning_audit; a failed step stops the run (Retry: POST …/removal/retry).',
      input: z.object({ ...id, confirm: z.string().min(1).max(64).describe('The workspace slug, typed back.') }),
      output: z.object({ approval }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        NOT_CONFIGURED + GATE + BODY +
          "404 'approval_not_found'. 400 'approval_not_approved'. 422 'removal_confirm_mismatch'. 409 'signup_removal_blocked' " +
          "(`blockers`; nothing changed when refused up front) / 'signup_already_removed' / 'signup_no_workspace' / 'steps_in_progress'. " +
          "502 'signup_removal_failed' (the row is `removed` with `removal.state = failed`; Retry). ",
      ),
    },
    {
      id: 'signup_approvals.removal_retry', method: 'POST', path: '/api/signup-approvals/:id/removal/retry', handler: 'handleRetrySignupRemoval', effect: 'destructive',
      summary: 'Re-run a pending / failed / blocked early-access removal (finished steps are skipped)',
      input: z.object(id),
      output: z.object({ approval }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        NOT_CONFIGURED + GATE +
          "404 'approval_not_found'. 409 'removal_not_retryable' / 'removal_in_progress' / 'signup_removal_blocked' (`blockers`). " +
          "502 'signup_removal_failed'. ",
      ),
    },
    {
      id: 'signup_approvals.removal_resolve', method: 'POST', path: '/api/signup-approvals/:id/removal/resolve', handler: 'handleResolveSignupRemoval', effect: 'write',
      summary: 'Close a failed / blocked early-access removal by hand, with a note (releases the slug)',
      input: z.object({ ...id, note: z.string().min(1).max(1000), acknowledgeLiveAccess: z.boolean().optional() }),
      output: z.object({ approval }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        NOT_CONFIGURED + GATE + BODY + "404 'approval_not_found'. 409 'removal_not_resolvable'. 422 'removal_live_access_unacknowledged'. ",
      ),
    },
  ],
);

const SERVICE_RESPONSES = (extra: string): ResponseSpec[] => [
  { status: 401, description: "`error` 'unauthorized': no bearer, or the token is unverifiable / expired / lacks `exp`.", schema: frErrorBody },
  {
    status: 'default',
    description: extra + NOT_CONFIGURED + BODY,
    schema: frErrorBody,
  },
];

export const SIGNUP_SERVICE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'signup_approvals.intake',
    area: 'signup_approvals',
    summary: 'Queue an early-access request (the early-access-intake handler, service account only)',
    description:
      "Auth: a portal-realm client-credentials token whose `azp` is in FR_SIGNUP_INTAKE_AZP (default `fr-signup-intake`), `aud` " +
      "contains it, realm role FR_SIGNUP_INTAKE_ROLE (default `fr-signup-intake`), no `super_admin`, `exp` required. 202 " +
      "`{status: 'queued' | 'already_pending'}`; a NEW row is announced in the fr signups Telegram topic with Approve / Reject buttons.",
    http: { method: 'POST', path: '/api/signup-approvals/intake', operationId: 'signupApprovalsIntake', successStatus: 202 },
    input: z
      .object({
        email: z.string().email().max(320),
        name: z.string().min(1).max(160),
        company: z.string().max(160).optional(),
        message: z.string().max(2000).optional(),
        source: z.enum(['web', 'chat']),
        locale: z.string().max(35).optional().describe('Lenient (C6): `de-DE` → de; unknown → not told (English).'),
        turnstileToken: z.string().max(4096).optional().describe('Accepted and ignored (the handler verified Turnstile).'),
      })
      .strict(),
    output: z.object({ status: z.enum(['queued', 'already_pending']) }),
    errors: [],
    auth: { principal: 'service', rbac: never },
    tenancy: 'platform',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'service-to-service' },
    openapi: {
      tags: [TAG],
      security: BEARER,
      responses: SERVICE_RESPONSES("403: `error` 'signup_intake_forbidden'. 503: `error` 'signup_queue_full'. "),
    },
    legacyHandler: lazyHandler(load, { module: MODULE, exportName: 'handleSignupIntake' }),
  }),
  defineCapability({
    id: 'signup_approvals.telegram_decision',
    area: 'signup_approvals',
    summary: "Carry out George's Approve / Reject tap from Telegram (chat-bridge's service account, contract C3)",
    description:
      'Auth: `azp` in FR_SIGNUP_DECIDER_AZP (default `chat-bridge-signup-decider`), `aud` contains it, realm role FR_SIGNUP_DECIDER_ROLE ' +
      "(default `fr-signup-decide`), no `super_admin`, `exp` required. Approve = the onboarding approve with defaults. 200 " +
      "`{status: 'approved'|'rejected'|'already_decided', tenantId?, summary}` (summary ≤ 200 chars, plain); 502 " +
      "`{status: 'failed', code, summary}` (the row stays pending). Idempotent.",
    http: { method: 'POST', path: '/api/signup-approvals/:id/telegram-decision', operationId: 'signupApprovalsTelegramDecision' },
    input: z
      .object({
        id: pathId('Signup approval id'),
        action: z.enum(['approve', 'reject']),
        telegramUserId: z.number().int().positive(),
      }),
    output: z.object({
      status: z.enum(['approved', 'rejected', 'already_decided']),
      tenantId: z.string().optional(),
      outcome: z.string().optional(),
      cleanup: z.string().optional(),
      summary: z.string().max(200),
    }),
    errors: [],
    auth: { principal: 'service', rbac: never },
    tenancy: 'platform',
    effect: 'write',
    confirm: 'card',
    agent: { expose: false, reason: 'service-to-service' },
    openapi: {
      tags: [TAG],
      security: BEARER,
      responses: SERVICE_RESPONSES(
        "403: `error` 'signup_decider_forbidden'. 404: `error` 'approval_not_found'. 502: `{status: 'failed', code, summary}`. ",
      ),
    },
    legacyHandler: lazyHandler(load, { module: MODULE, exportName: 'handleSignupTelegramDecision' }),
  }),
];
