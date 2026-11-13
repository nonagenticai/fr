// src/routes/signup-approvals.ts — early-access signup v2 (fr's half of the CommonPractice flow).
//
//   POST /api/signup-approvals/intake                    the early-access-intake handler's SA (service-token.ts)
//   POST /api/signup-approvals/:id/telegram-decision     chat-bridge's SA, relaying George's tap (contract C3)
//   GET  /api/signup-approvals                           super_admin: the queue (?status=pending|approved|rejected|needs_attention)
//   GET  /api/signup-approvals/:id                       super_admin
//   POST /api/signup-approvals/invite                    super_admin: invite straight into early access
//   POST /api/signup-approvals/:id/approve               super_admin (optional `tenantName`)
//   POST /api/signup-approvals/:id/reject                super_admin (on a rejected row: Retry its cleanup)
//   POST /api/signup-approvals/:id/retry                 super_admin: re-run an approved row's unfinished steps
//   POST /api/signup-approvals/:id/resolve-repair        super_admin: close a failed / blocked cleanup with a note
//   POST /api/signup-approvals/:id/remove                super_admin: REMOVE an approved workspace (confirm = slug)
//   POST /api/signup-approvals/:id/removal/retry         super_admin: re-run a pending / failed / blocked removal
//   POST /api/signup-approvals/:id/removal/resolve       super_admin: close a failed / blocked removal with a note
//
// ⛔ Every route answers 503 `signup_not_configured` unless FR_SIGNUP_ENABLED=true (config.ts): only
// the main fr.nonagentic.ai Deployment takes signups. fr stays super_admin-provisioning-only
// (George 2026-10-12): the queue and the invite are super_admin surfaces; the two service doors can
// only queue a request and relay George's own decision.
import { z } from 'zod';

import { validateAuth } from '../middleware/auth';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { jsonResponse } from '../utils/response';
import { db, signupApprovals } from '../db/client';
import { and, eq, sql } from 'drizzle-orm';
import { normaliseSignupLocale, SIGNUP_LOCALES, signupEnabled, signupQueueMax } from '../services/signup/config';
import {
  requireSignupDeciderCaller,
  requireSignupIntakeCaller,
  SignupAuthError,
} from '../services/signup/service-token';
import { multiLineText, singleLineText } from '../services/signup/untrusted-text';
import { notifyNewSignup } from '../services/signup/telegram';
import { defaultTenantName } from '../services/signup/naming';
import { removalOf, resolveRemoval, retryRemoval, startRemoval, type RemovalRun } from '../services/signup/removal';
import { attributeRequestTo } from '../integrations/_lib/context';
import { INTERNAL_SYSTEM_TENANT_ID } from '../middleware/internal-tenant-only';
import {
  approveSignup,
  emailState,
  listSignups,
  loadSignup,
  pendingSignupCount,
  rejectSignup,
  resolveRejectRepair,
  retrySignupSteps,
  SignupError,
  stepsNotOk,
  type RejectRepairState,
  type SignupActor,
  type SignupRow,
} from '../services/signup/core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(err: unknown): Response {
  if (err instanceof SignupError) return jsonResponse({ error: err.code, detail: err.message, ...(err.details ?? {}) }, err.statusCode);
  if (err instanceof SignupAuthError) return jsonResponse({ error: err.code, detail: err.message }, err.statusCode);
  if (err instanceof z.ZodError) return jsonResponse({ error: 'invalid request body', details: err.errors }, 422);
  if (err instanceof SyntaxError) return jsonResponse({ error: 'invalid JSON body' }, 400);
  console.error('[signup] unexpected error:', err);
  return jsonResponse({ error: 'signup_internal_error', detail: err instanceof Error ? err.message : String(err) }, 500);
}

function notConfigured(): Response {
  return jsonResponse(
    { error: 'signup_not_configured', detail: 'Early-access signup is not enabled on this deployment (FR_SIGNUP_ENABLED).' },
    503,
  );
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function requireSuperAdminActor(req: Request): Promise<SignupActor | Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }
  if (!isSuperAdmin(user)) return jsonResponse({ error: 'super-admin only' }, 403);
  return { kind: 'super_admin', userId: user.id };
}

/** The row as the screen shows it (no lease/claim internals). */
export function signupView(row: SignupRow) {
  const rr = row.reject_repair as RejectRepairState | null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    company: row.company,
    message: row.message,
    locale: row.locale,
    source: row.source,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_via: row.decided_via,
    decider_actor: row.decider_actor,
    approving: row.approving_until !== null && row.approving_until.getTime() > Date.now(),
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
    tenant_id: row.tenant_id,
    suggested_tenant_name: row.tenant_name ?? defaultTenantName(row),
    steps: row.steps,
    steps_not_ok: stepsNotOk(row),
    email_state: emailState(row),
    steps_attempts: row.steps_attempts,
    steps_next_attempt_at: row.steps_next_attempt_at,
    reject_repair: rr
      ? {
          state: rr.state,
          attempts: rr.attempts,
          next_attempt_at: rr.nextAttemptAt,
          last_error: rr.lastError,
          blockers: rr.blockers ?? [],
          undid: rr.undid ?? [],
          note: rr.note ?? null,
        }
      : null,
    removal: removalView(row),
  };
}

function removalView(row: SignupRow) {
  const r = removalOf(row);
  if (!r) return null;
  return {
    state: r.state,
    tenant_id: r.tenantId,
    tenant_slug: r.tenantSlug,
    requested_by: r.requestedBy,
    requested_at: r.requestedAt,
    attempts: r.attempts,
    last_attempt_at: r.lastAttemptAt,
    last_error: r.lastError,
    blockers: r.blockers ?? [],
    steps: r.steps ?? {},
    note: r.note ?? null,
  };
}

// ---- intake (service account) ----

const intakeSchema = z
  .object({
    email: z.string().trim().email().max(320),
    name: singleLineText(160),
    company: singleLineText(160).optional(),
    message: multiLineText(2000).optional(),
    source: z.enum(['web', 'chat']),
    // C6: lenient — an unknown / malformed tag is "not told" (→ en), never a 422.
    locale: z.string().max(35).optional(),
    // Accepted for contract compatibility with the shared intake body; fr has no Turnstile of its
    // own (the intake handler verified it before calling).
    turnstileToken: z.string().max(4096).optional(),
  })
  .strict();

export async function handleSignupIntake(req: Request): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  try {
    const caller = await requireSignupIntakeCaller(req);
    // Metering: this door's token is the intake handler's service account (no tenant), so its span
    // billed the nil tenant. A request for access is platform onboarding traffic: the internal system
    // tenant, exactly where the super_admin onboarding routes' spans land.
    attributeRequestTo({ userId: caller.subject, tenantId: INTERNAL_SYSTEM_TENANT_ID });
    const body = intakeSchema.parse(await readJson(req));
    const pending = await pendingSignupCount();
    if (pending >= signupQueueMax()) {
      console.warn(`[signup] queue full pending=${pending} intake_client=${caller.azp}`);
      return jsonResponse({ error: 'signup_queue_full', detail: 'Sign-up requests are temporarily closed.' }, 503);
    }
    const locale = normaliseSignupLocale(body.locale);
    const [row] = await db
      .insert(signupApprovals)
      .values({
        email: body.email,
        name: body.name,
        company: body.company ?? null,
        message: body.message ?? null,
        locale,
        source: body.source,
        intake_client: caller.azp,
      })
      .onConflictDoNothing()
      .returning({ id: signupApprovals.id });
    if (!row) return jsonResponse({ status: 'already_pending' }, 202);
    notifyNewSignup({
      id: row.id,
      source: body.source,
      pendingTotal: pending + 1,
      email: body.email,
      name: body.name,
      company: body.company ?? null,
      message: body.message ?? null,
      locale,
    });
    return jsonResponse({ status: 'queued' }, 202);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- queue (super_admin) ----

const LIST_FILTERS = new Set(['pending', 'approved', 'rejected', 'removed', 'needs_attention']);

export async function handleListSignupApprovals(req: Request): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    const status = new URL(req.url).searchParams.get('status');
    if (status !== null && !LIST_FILTERS.has(status)) {
      return jsonResponse({ error: 'invalid_status_filter', detail: `status must be one of ${[...LIST_FILTERS].join(', ')}` }, 422);
    }
    const rows = await listSignups(status);
    return jsonResponse({ items: rows.map(signupView) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetSignupApproval(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    const row = id && UUID_RE.test(id) ? await loadSignup(id) : null;
    if (!row) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    return jsonResponse({ data: signupView(row) });
  } catch (err) {
    return errorResponse(err);
  }
}

const approveSchema = z.object({ tenantName: z.string().trim().min(2).max(120).optional() }).strict();

function approveBody(out: Awaited<ReturnType<typeof approveSignup>>) {
  return {
    approval: signupView(out.row),
    tenantId: out.tenantId,
    tenant: { id: out.tenantId, name: out.tenantName, slug: out.tenantSlug },
    emailState: out.emailState,
    stepsNotOk: out.notOk,
  };
}

export async function handleApproveSignup(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    const body = approveSchema.parse(await readJson(req));
    return jsonResponse(approveBody(await approveSignup(id, { tenantName: body.tenantName }, actor)));
  } catch (err) {
    return errorResponse(err);
  }
}

function rejectRepairError(out: Awaited<ReturnType<typeof rejectSignup>>): Response | null {
  const r = out.repair;
  if (!r) return null;
  if (r.state === 'blocked') {
    return jsonResponse(
      {
        error: 'signup_workspace_in_use',
        detail: 'The workspace this rejected signup founded is in use, so the cleanup will not offboard it.',
        blockers: r.blockers ?? [],
        approval: signupView(out.row),
      },
      409,
    );
  }
  if (r.state === 'pending' || r.state === 'failed') {
    return jsonResponse(
      {
        error: 'signup_reject_cleanup_failed',
        detail:
          `${out.decidedHere ? 'Rejected' : 'The signup is rejected'}, but undoing what its approve did failed: ${r.lastError ?? 'unknown'}. ` +
          (r.state === 'failed' ? 'It is no longer retried automatically; Retry it here.' : 'It is retried automatically.'),
        approval: signupView(out.row),
      },
      502,
    );
  }
  return null;
}

export async function handleRejectSignup(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    const out = await rejectSignup(id, actor);
    return rejectRepairError(out) ?? jsonResponse({ approval: signupView(out.row) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRetrySignupSteps(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    return jsonResponse({ approval: signupView(await retrySignupSteps(id, actor)) });
  } catch (err) {
    return errorResponse(err);
  }
}

const resolveSchema = z
  .object({
    note: z.string().trim().min(1).max(1000),
    acknowledgeLiveAccess: z.boolean().optional(),
  })
  .strict();

export async function handleResolveSignupRepair(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    const body = resolveSchema.parse(await readJson(req));
    return jsonResponse({ approval: signupView(await resolveRejectRepair(id, actor, body.note, body.acknowledgeLiveAccess === true)) });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- removal of an approved workspace (super_admin; services/signup/removal.ts) ----

/** done → 200; blocked → 409; failed / still pending → 502. The row (and its removal) rides every answer. */
function removalResponse(run: RemovalRun): Response {
  const r = run.removal;
  const approval = signupView(run.row);
  if (r?.state === 'done' || r?.state === 'resolved_manually') return jsonResponse({ approval });
  if (r?.state === 'blocked') {
    return jsonResponse(
      { error: 'signup_removal_blocked', detail: `The removal is blocked: ${(r.blockers ?? []).join('; ')}. Retry it once that is resolved.`, blockers: r.blockers ?? [], approval },
      409,
    );
  }
  return jsonResponse(
    {
      error: 'signup_removal_failed',
      detail: `The removal did not finish${r?.lastError ? `: ${r.lastError}` : ''}. Nothing after the failed step ran; Retry it here.`,
      approval,
    },
    502,
  );
}

const removeSchema = z.object({ confirm: z.string().trim().min(1).max(64) }).strict();

export async function handleRemoveSignup(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    const body = removeSchema.parse(await readJson(req));
    return removalResponse(await startRemoval(id, body.confirm, actor));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRetrySignupRemoval(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    return removalResponse(await retryRemoval(id, actor));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleResolveSignupRemoval(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
    const body = resolveSchema.parse(await readJson(req));
    return jsonResponse({ approval: signupView(await resolveRemoval(id, actor, body.note, body.acknowledgeLiveAccess === true)) });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- invite (super_admin) ----

const inviteSchema = z
  .object({
    email: z.string().trim().email().max(320),
    name: singleLineText(160),
    company: singleLineText(160).optional(),
    tenantName: z.string().trim().min(2).max(120).optional(),
    // The email's language (the form's picker). Strict: anything else is a client bug → 422.
    locale: z.enum(SIGNUP_LOCALES).optional(),
  })
  .strict();

/**
 * Invite a person straight into early access (no public form). Records a `source: 'invite'` row —
 * or reuses the address's PENDING row (its language overwritten by the picker) — and runs the SAME
 * approve. No new-signup Telegram notice (a super_admin action); the decision notice still goes.
 */
export async function handleInviteSignup(req: Request): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  const actor = await requireSuperAdminActor(req);
  if (actor instanceof Response) return actor;
  try {
    const body = inviteSchema.parse(await readJson(req));
    const [inserted] = await db
      .insert(signupApprovals)
      .values({ email: body.email, name: body.name, company: body.company ?? null, locale: body.locale ?? null, source: 'invite' })
      .onConflictDoNothing()
      .returning({ id: signupApprovals.id });
    let id = inserted?.id;
    if (!id) {
      const [existing] = await db
        .select({ id: signupApprovals.id })
        .from(signupApprovals)
        .where(and(eq(signupApprovals.status, 'pending'), sql`lower(${signupApprovals.email}) = lower(${body.email})`))
        .limit(1);
      if (!existing) return jsonResponse({ error: 'approval_not_pending', detail: 'The pending signup for this address was just decided; retry.' }, 400);
      id = existing.id;
      if (body.locale) await db.update(signupApprovals).set({ locale: body.locale }).where(eq(signupApprovals.id, id));
    }
    console.log(`[signup] invite id=${id} reused_pending=${!inserted} by=${actor.kind === 'super_admin' ? actor.userId : '-'}`);
    return jsonResponse({ ...approveBody(await approveSignup(id, { tenantName: body.tenantName }, actor)), reusedPending: !inserted });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- Telegram decision (chat-bridge service account, contract C3) ----

const decisionSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Plain text, ≤ 200 characters — shown in Telegram by chat-bridge. */
export function summary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function decidedSummary(row: SignupRow): string {
  const rr = row.status === 'rejected' ? (row.reject_repair as RejectRepairState | null) : null;
  return summary(
    `Already ${row.status}: ${row.email}` +
      (row.status === 'approved' && row.tenant_id ? ` (workspace ${row.tenant_slug ?? row.tenant_id})` : '') +
      '.' +
      (rr && rr.state !== 'done' ? ` Cleanup of its aborted approve: ${rr.state}.` : ''),
  );
}

function alreadyDecided(row: SignupRow): Response {
  return jsonResponse({
    status: 'already_decided',
    ...(row.status === 'approved' && row.tenant_id ? { tenantId: row.tenant_id } : {}),
    outcome: row.status,
    summary: decidedSummary(row),
  });
}

export async function handleSignupTelegramDecision(req: Request, id?: string): Promise<Response> {
  if (!signupEnabled()) return notConfigured();
  let caller;
  let body: z.infer<typeof decisionSchema>;
  try {
    caller = await requireSignupDeciderCaller(req);
    // Metering: the web approve's span is attributed to the deciding super_admin's verified token, whose
    // tenant is the internal system tenant; this door's token is chat-bridge's service account (no
    // tenant), so its span billed the nil tenant. Same attribution as the web approve: the internal
    // system tenant (never the requester's new workspace), user = the service account.
    // Published as soon as the caller is VERIFIED — before the body is parsed — so a refused body
    // (422 / 400) is metered to the same tenant instead of the nil tenant, exactly as the intake does.
    attributeRequestTo({ userId: caller.subject, tenantId: INTERNAL_SYSTEM_TENANT_ID });
    body = decisionSchema.parse(await readJson(req));
  } catch (err) {
    return errorResponse(err);
  }
  let row: SignupRow | null;
  try {
    row = id && UUID_RE.test(id) ? await loadSignup(id) : null;
  } catch (err) {
    return errorResponse(err);
  }
  if (!row) return jsonResponse({ error: 'approval_not_found', detail: `No signup approval '${id}'` }, 404);
  // Idempotent: a decided row answers what is true now (a reject's pending cleanup is the tick's).
  if (row.status !== 'pending') return alreadyDecided(row);
  const actor: SignupActor = { kind: 'telegram', telegramUserId: body.telegramUserId, azp: caller.azp, subject: caller.subject };
  try {
    if (body.action === 'reject') {
      const out = await rejectSignup(row.id, actor);
      const rr = out.repair;
      const note = !rr ? '' : rr.state === 'done' ? ' Cleaned up what its aborted approve left behind.' : ` Cleanup: ${rr.state}${rr.lastError ? ` (${rr.lastError})` : ''}.`;
      return jsonResponse({
        status: out.decidedHere ? 'rejected' : 'already_decided',
        ...(out.decidedHere ? {} : { outcome: 'rejected' }),
        ...(rr ? { cleanup: rr.state } : {}),
        summary: summary(`${out.decidedHere ? 'Rejected' : 'Already rejected'}: ${row.email}.${note}`),
      });
    }
    const out = await approveSignup(row.id, {}, actor);
    const mail = out.emailState === 'sent' ? 'set-password email sent' : 'email follows once every step is ok';
    return jsonResponse({
      status: 'approved',
      tenantId: out.tenantId,
      summary: summary(`Approved: ${row.email} -> workspace "${out.tenantName}" (${out.tenantSlug}); ${mail}.`),
    });
  } catch (err) {
    if (err instanceof SignupError && err.code === 'approval_in_progress') {
      return jsonResponse({
        status: 'already_decided',
        outcome: 'in_progress',
        summary: summary(`A decision for ${row.email} is already being carried out.`),
      });
    }
    if (err instanceof SignupError && err.code === 'approval_not_pending') {
      try {
        const now = await loadSignup(row.id);
        if (now && now.status !== 'pending') return alreadyDecided(now);
      } catch (readErr) {
        console.warn(`[signup] re-read after a lost race failed id=${row.id}: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
      }
    }
    const code = err instanceof SignupError ? err.code : 'internal_error';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[signup] telegram decision failed id=${row.id} action=${body.action} code=${code}: ${message}`);
    return jsonResponse({ status: 'failed', code, summary: summary(`Could not ${body.action}: ${code} - ${message}`) }, 502);
  }
}
