// src/routes/admin/super-admin-resend.ts
//
// POST /api/admin/super-admin/resend-set-password-email — the EXPLICIT recovery for a
// set-password email that was recorded as sent but may never have been delivered (a crash between
// the at-most-once record and the send, or a send that timed out / answered 5xx). Nothing resends
// automatically (George 2026-10-23: one email per onboarding, never two); a super_admin decides.
//
// Allowed for ONE fr-realm account only when ALL hold:
//   * the account is ENABLED (a disabled one is a failed onboarding or an operator decision);
//   * the person never set a password: no stored credential, or only the console's TEMPORARY
//     password with UPDATE_PASSWORD still pending (console onboarding always sets one);
//   * fr created it: this console's identity ledger says `minted`, or an APPROVED early-access
//     signup recorded it (its kc_user_id);
//   * no other resend attempt for it in the last 5 minutes (rate limit, from the audit trail).
// AUDIT: every attempt by an AUTHENTICATED caller writes a provisioning_audit row with its own
// action kind `resend_set_password_email` (migration 209) — refusals included (403 not a
// super_admin, 422 bad body, every 4xx/5xx below) — and carries the account's email as Keycloak
// reports it. ⚠️ A 401 (no or invalid token) is NOT audited: there is no verified identity to
// attribute it to, and writing a row per unauthenticated request would let anyone grow the table.

import { and, eq, gt, ne, sql } from 'drizzle-orm';

import { db, provisioningAudit, signupApprovals } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { jsonResponse } from '../../utils/response';
import { AppError } from '../../utils/errors';
import { isIntegrationError, integrationErrorResponse } from '../../integrations/_lib/errors';
import { getCredentialTypes, getUserState, sendUpdatePasswordEmail } from '../../services/keycloak-admin';
import { auditIdentityLedger } from '../../services/provisioning-identity-ledger';
import { keycloakIdentityOps } from '../../services/signup/identity';
import { signupProvisioningConfig, signupPublicUrl } from '../../services/signup/config';
import { ResendSetPasswordEmailBody } from './super-admin-schemas';

export const RESEND_OPERATION = 'resend_set_password_email';
/** Minimum spacing between two resends for one account. */
export const RESEND_MIN_INTERVAL_MS = 5 * 60 * 1000;


export interface ResendSetPasswordEmailResult {
  user_id: string;
  origin: 'console' | 'signup';
  sent: true;
}

function refuse(error: string, detail: string, status: number): Response {
  return jsonResponse({ error, detail }, status);
}

type AuditStatus = 'success' | 'error';

/** Open the attempt's audit row (pending). */
async function openAudit(actorId: string, targetUserId: string | null, payload: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(provisioningAudit)
    .values({
      actor_user_id: actorId,
      action: RESEND_OPERATION,
      target_email: '',
      target_user_id: targetUserId,
      payload: { operation: RESEND_OPERATION, ...payload },
      result: {},
      status: 'pending',
    })
    .returning({ id: provisioningAudit.id });
  if (!row) throw new AppError(500, 'failed to open provisioning_audit row');
  return row.id;
}

async function closeAudit(
  auditId: string,
  status: AuditStatus,
  result: Record<string, unknown>,
  error: string | null,
  targetEmail?: string,
): Promise<void> {
  await db
    .update(provisioningAudit)
    .set({ status, result, error, updated_at: new Date(), ...(targetEmail !== undefined ? { target_email: targetEmail } : {}) })
    .where(eq(provisioningAudit.id, auditId));
}

export async function handleResendSetPasswordEmail(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    // NOT audited (see the header): no verified identity.
    const status = (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status ?? 401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  let raw: unknown;
  let parseError: Response | null = null;
  try {
    raw = await req.json();
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    parseError = jsonResponse({ error: 'invalid JSON body' }, 400);
  }
  const rawUserId =
    raw && typeof raw === 'object' && typeof (raw as { user_id?: unknown }).user_id === 'string'
      ? ((raw as { user_id: string }).user_id)
      : null;

  if (!isSuperAdmin(user)) {
    const auditId = await openAudit(user.id, null, { requested_user_id: rawUserId });
    await closeAudit(auditId, 'error', { refused: 'not_super_admin' }, 'not_super_admin: caller lacks super_admin');
    return jsonResponse({ error: 'super-admin only' }, 403);
  }
  if (parseError) {
    const auditId = await openAudit(user.id, null, {});
    await closeAudit(auditId, 'error', { refused: 'invalid_json' }, 'invalid JSON body');
    return parseError;
  }
  const parsed = ResendSetPasswordEmailBody.safeParse(raw);
  if (!parsed.success) {
    const auditId = await openAudit(user.id, null, { requested_user_id: rawUserId });
    await closeAudit(auditId, 'error', { refused: 'invalid_body' }, 'invalid request body');
    return jsonResponse({ error: 'invalid request body', details: parsed.error.errors }, 422);
  }
  const userId: string = parsed.data.user_id;

  // The audit row FIRST (pending), so every attempt leaves a trail and a concurrent second attempt
  // sees this one in the rate-limit window.
  const auditId = await openAudit(user.id, userId, { user_id: userId });
  let targetEmail: string | undefined;
  const refuseAudited = async (error: string, detail: string, status: number) => {
    await closeAudit(auditId, 'error', { user_id: userId, refused: error }, `${error}: ${detail}`, targetEmail);
    return refuse(error, detail, status);
  };

  try {
    // 1. Rate limit: any other attempt for this account that got past the checks (sent, in
    //    flight, or failed AT the send — a timed-out send may have been delivered) in the window
    //    refuses this one. Two truly concurrent attempts see each other and BOTH refuse.
    const recent = await db
      .select({ id: provisioningAudit.id })
      .from(provisioningAudit)
      .where(
        and(
          eq(provisioningAudit.action, RESEND_OPERATION),
          eq(provisioningAudit.target_user_id, userId),
          sql`(${provisioningAudit.result} ->> 'refused') IS NULL`,
          ne(provisioningAudit.id, auditId),
          gt(provisioningAudit.created_at, new Date(Date.now() - RESEND_MIN_INTERVAL_MS)),
        ),
      );
    if (recent.length > 0) {
      return await refuseAudited(
        'resend_rate_limited',
        `a set-password email was (re)sent for ${userId} less than 5 minutes ago; wait before resending.`,
        429,
      );
    }

    // 2. The account as Keycloak has it (its email goes on the audit row).
    const state = await getUserState(userId);
    targetEmail = state.email ?? '';

    // 3. Created by fr: this console's ledger, or an APPROVED early-access signup.
    const consoleMinted = (await auditIdentityLedger(auditId).prior(userId, '')).minted;
    const signupRows = await db
      .select({ id: signupApprovals.id })
      .from(signupApprovals)
      .where(and(eq(signupApprovals.kc_user_id, userId), eq(signupApprovals.status, 'approved')));
    const origin: 'console' | 'signup' | null = consoleMinted ? 'console' : signupRows.length > 0 ? 'signup' : null;
    if (!origin) {
      return await refuseAudited(
        'not_created_by_fr',
        `${userId} was not created by this console or an approved early-access signup; fr never mails it.`,
        403,
      );
    }

    // 4. Enabled, and the person never set a password.
    if (!state.enabled) {
      return await refuseAudited(
        'account_disabled',
        `${userId} is disabled (a failed onboarding or an operator decision); nothing is sent to it.`,
        409,
      );
    }
    const credentials = await getCredentialTypes(userId);
    const pendingSetPassword = (state.requiredActions ?? []).includes('UPDATE_PASSWORD');
    const neverActivated =
      credentials.length === 0 || (pendingSetPassword && credentials.every((t) => t === 'password'));
    if (!neverActivated) {
      return await refuseAudited(
        'already_activated',
        `${userId} already holds its own credential; it signs in normally (password reset is the login page's).`,
        409,
      );
    }

    // 5. The SAME email the original flow sends.
    if (origin === 'signup') {
      const cfg = signupProvisioningConfig();
      const publicUrl = signupPublicUrl();
      if (!publicUrl) return await refuseAudited('public_url_unset', 'FR_PUBLIC_URL is not set.', 503);
      await keycloakIdentityOps.executeActionsEmail(userId, ['UPDATE_PASSWORD', 'VERIFY_EMAIL'], {
        clientId: cfg.frontendClientId,
        redirectUri: `${publicUrl}/`,
        lifespanSeconds: cfg.emailLifespanSeconds,
      });
    } else {
      await sendUpdatePasswordEmail(userId);
    }
    const result: ResendSetPasswordEmailResult = { user_id: userId, origin, sent: true };
    await closeAudit(auditId, 'success', { ...result }, null, targetEmail);
    return jsonResponse(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await closeAudit(auditId, 'error', { user_id: userId }, message, targetEmail);
    } catch (logErr) {
      console.error('[super-admin] failed to close resend audit row', auditId, logErr);
    }
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    console.error('[super-admin] resend set-password email failed:', err);
    return jsonResponse({ error: 'resend failed', detail: message }, 500);
  }
}
