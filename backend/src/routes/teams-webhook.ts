// src/routes/teams-webhook.ts
// Inbound Teams action-callback webhook. When an approver clicks an
// Action.Http button on the adaptive card sent by teamsAdapter, Teams posts
// the action payload to this endpoint. We record the per-approver decision,
// run shared consensus, and on terminal status we broadcast + fire the n8n
// callback (the same follow-up shape the Telegram seat uses).
//
// UNAUTHENTICATED — Teams posts without Bearer tokens. If TEAMS_WEBHOOK_SECRET
// is set we validate an HMAC header; otherwise rely on NetworkPolicy. This is
// acceptable for the MVP because the Action.Http URL is embedded in the card
// we ourselves emit — not a publicly-advertised endpoint.
import { db, approvals } from '../db/client';
import { AppError } from '../utils/errors';
import { approvalWebPath, decideAsChannelSender } from '../agui/actions/approvals-decide';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jsonResponse } from '../utils/response';
import { config } from '../config';
import { DEFAULT_FR_PUBLIC_URL } from '../services/github-app-config';
import { ACTION_DECISION_UNVERIFIED_CODE, isVerifiedActionDecisionSeat } from '../lib/action-decision-identity';
import { hasPassedDeadline } from '../lib/approval-deadline';
import { verifyTeamsJwt, mapTeamsIdentityToUserId } from '../services/teams-jwt';
import { timingSafeEquals } from '../utils/secret-compare';
import { channelDispatcher } from '../channels';

export const TeamsActionSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected', 'abstain', 'approve', 'reject']),
  comment: z.string().optional(),
});

/**
 * POST /api/webhooks/teams
 */
export async function handleTeamsIncoming(req: Request): Promise<Response> {
  // Shared-secret signature check. Read live from the environment (like the
  // TEAMS_JWT_VERIFY check below) so the auth posture is evaluated per request
  // rather than frozen at module-load — config.services.teams.webhookSecret is
  // just `process.env.TEAMS_WEBHOOK_SECRET || ''` captured at boot.
  const expectedSecret = process.env.TEAMS_WEBHOOK_SECRET || '';
  if (expectedSecret) {
    const provided = req.headers.get('x-teams-signature') || '';
    // Constant-time compare. This was a plain `!==`, the last surviving copy of
    // the timing leak PR #756 removed from its five siblings: `!==` bails on the
    // first mismatching byte, so response time reveals how long a guessed prefix
    // was and the secret can be recovered byte-by-byte.
    if (!timingSafeEquals(provided, expectedSecret)) {
      return jsonResponse({ error: 'invalid signature' }, 401);
    }
  }

  // Fail-closed: refuse to process when NO authentication mechanism is
  // configured at all. With TEAMS_WEBHOOK_SECRET unset AND TEAMS_JWT_VERIFY
  // off, this endpoint was effectively unauthenticated — any in-cluster caller
  // who knew an approval UUID could drive approve/reject for ANY tenant. We now
  // require either the shared secret or Bot Framework JWT verification to be
  // configured before accepting an approval-mutating callback.
  if (!expectedSecret && process.env.TEAMS_JWT_VERIFY !== 'true') {
    return jsonResponse(
      {
        error: {
          code: 'WEBHOOK_AUTH_NOT_CONFIGURED',
          message:
            'Teams webhook is disabled until TEAMS_WEBHOOK_SECRET or TEAMS_JWT_VERIFY is configured',
          service: 'teams-webhook',
        },
      },
      401,
    );
  }

  // E-7: dispatcher gets first crack at free-text Teams messages. When
  // CHANNEL_DISPATCH_ENABLED=false or parseWebhook returns null (legacy
  // TeamsActionSchema approval-callback shape), fall through to the legacy
  // handler unchanged. Clone because `Request.json()` consumes the body.
  const dispatched = await channelDispatcher.handleWebhook('teams', req.clone() as unknown as Request);
  if (dispatched) return dispatched;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const parsed = TeamsActionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid payload', details: parsed.error.message }, 400);
  }

  const { approvalId, comment } = parsed.data;
  const decisionRaw = parsed.data.decision;

  // Env-gated Bot Framework JWT verification. When enabled, the caller MUST
  // present a valid signed JWT; the approver identity is derived from it and
  // takes priority over any payload-provided approverId.
  //
  // mapTeamsIdentityToUserId returns a typed result so we can distinguish:
  //   - 'mapped'         → use the resolved user id verbatim
  //   - 'not-found'      → Keycloak responded but this Teams user is NOT
  //                        federated under our realm. Fail-closed: a Teams
  //                        user we can't identify must NOT be allowed to
  //                        spoof an approver via a payload approverId.
  //   - 'not-configured' → bot federation not provisioned yet. Soft fall
  //                        back to the existing required-approver /
  //                        requester / payload chain so production keeps
  //                        moving while ops stand up the federation.
  let verifiedApproverId: string | null = null;
  let teamsMappingNotConfigured = false;
  if (process.env.TEAMS_JWT_VERIFY === 'true') {
    const auth = req.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) {
      return new Response('unauthorized', { status: 401 });
    }
    let claims: { oid: string; tid: string };
    try {
      claims = await verifyTeamsJwt(auth.slice(7));
    } catch {
      return new Response('invalid token', { status: 401 });
    }
    const mapping = await mapTeamsIdentityToUserId(claims);
    if (mapping.kind === 'mapped') {
      verifiedApproverId = mapping.userId;
    } else if (mapping.kind === 'not-found') {
      // Hard fail — we verified the JWT, the user is real on Microsoft's
      // side, but they are not federated to a Keycloak user. Recording
      // the decision under the payload-provided approverId here would let
      // any signed Teams user impersonate any approver.
      return jsonResponse(
        {
          error: {
            code: 'TEAMS_IDENTITY_UNMAPPED',
            message:
              'Teams identity is not federated to a Keycloak user; cannot authorise approval',
            service: 'teams-webhook',
          },
        },
        403,
      );
    } else {
      // 'not-configured' — Keycloak admin / IdP alias not wired yet.
      // Soft fallback to the legacy resolution chain below; tag the
      // metadata so we can audit how often we're hitting this path.
      teamsMappingNotConfigured = true;
      console.warn(
        `[teams-webhook] mapTeamsIdentityToUserId not configured (code=${mapping.code}): ${mapping.reason}`,
      );
    }
  }
  // Suppress "unused variable" while we plumb the audit field through.
  void teamsMappingNotConfigured;

  // Abstain is acknowledged but recorded as neither approve nor reject — 200.
  if (decisionRaw === 'abstain') {
    return jsonResponse({ received: true, abstained: true });
  }

  const decision: 'approved' | 'rejected' =
    decisionRaw === 'approve' || decisionRaw === 'approved' ? 'approved' : 'rejected';

  // Look up the approval.
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) {
    return jsonResponse(
      {
        error: {
          code: 'UPSTREAM_NOT_FOUND',
          message: 'approval not found',
          service: 'teams-webhook',
        },
      },
      404,
    );
  }

  if (approval.status !== 'pending') {
    return jsonResponse({ received: true, alreadyDecided: true, status: approval.status });
  }

  // ── AN EXPIRED APPROVAL MAY NOT BE DECIDED HERE EITHER (parity with the HTTP seat) ──
  // `hasPassedDeadline` (lib/approval-deadline.ts) was enforced only in
  // `routes/approvals.ts` — a row past `expires_at` but not yet reaped (the reaper sweeps
  // at most every 15 minutes, BATCH_SIZE 500) was decidable by a Teams click while the HTTP
  // seat refused it. Answered the same way `alreadyDecided` is above: 200, so Teams never
  // retries a dead Action.Http button, with the fact in the body rather than a thrown error.
  if (hasPassedDeadline(approval.expires_at)) {
    return jsonResponse({ received: true, expired: true });
  }

  // ⛔ ONLY A VERIFIED SENDER DECIDES (identity, not channel — the allowlist every seat asks,
  // lib/action-decision-identity.ts). Teams is verified only by a Bot Framework JWT identity
  // federated to an fr account. In shared-secret mode (or the `not-configured` federation
  // fallback) the payload `approverId` is an unauthenticated body string, so it never
  // reaches the decide path as that user: the button answers with the fr web link only.
  const link = `${(config.publicBaseUrl || DEFAULT_FR_PUBLIC_URL).replace(/\/+$/, '')}${approvalWebPath(approvalId)}`;
  const seatEvidence = { teamsJwt: verifiedApproverId !== null };
  if (verifiedApproverId === null || !isVerifiedActionDecisionSeat({ channel: 'teams', evidence: seatEvidence })) {
    return jsonResponse(
      {
        error: {
          code: ACTION_DECISION_UNVERIFIED_CODE,
          message: `Nothing was recorded: this Teams request carries no verified identity. Decide it in fr: ${link}`,
          service: 'teams-webhook',
        },
        link,
      },
      403,
    );
  }

  // ⭐ THE SHARED DECIDE PATH (owner ruling 2026-10-31: every channel is equivalent). The
  // same function the web PUT, the `approvals.decide` action and Telegram use —
  // same rules (already decided, requester, finished card, rate limit, answer owed, broken
  // gate, the structured fields a kind needs), same atomic row lock. A Teams card carries
  // only decision + comment, so a kind that needs structured fields is refused BY THAT
  // PATH, and this button answers with the fr web link to decide it there — no Teams rule.
  // ⚠️ TEAMS HAS NO CHAT REPLY, SO THE JSON BODY *IS* THE OPERATOR MESSAGE: `callback`
  // (from the shared path) is the only field that says the hand-off to n8n was observed.
  try {
    const { response } = await decideAsChannelSender(
      {
        channel: 'teams',
        userId: verifiedApproverId,
        tenantId: approval.tenant_id,
        evidence: seatEvidence,
      },
      {
        approvalId,
        decision: decision === 'approved' ? 'approve' : 'reject',
        ...(comment ? { comment } : {}),
      },
    );
    return jsonResponse({ received: true, status: response.status, callback: response.callback });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'already_decided') {
      return jsonResponse({ received: true, already_decided: true, message: err.message });
    }
    return jsonResponse(
      { error: { code: err.code ?? 'DECISION_REFUSED', message: err.message, service: 'teams-webhook' }, link },
      err.statusCode ?? 422,
    );
  }
}
