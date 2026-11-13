// src/routes/email-webhook.ts
// E-10: inbound email webhook (Mailgun-style POST). Hands the request to the
// channel dispatcher; if dispatch is disabled (CHANNEL_DISPATCH_ENABLED=false)
// we still ack 200 so the upstream mail provider doesn't retry forever.
import { jsonResponse } from '../utils/response';
import { config } from '../config';
import { isAuthorizedBySharedSecret } from '../utils/webhook-secret';
import { channelDispatcher } from '../channels';

/**
 * POST /api/webhooks/email/incoming
 * Returns 200 unconditionally — email providers retry aggressively on non-2xx.
 */
export async function handleEmailIncoming(req: Request): Promise<Response> {
  // Authenticate BEFORE the dispatcher reads the body.
  //
  // This receiver had NO authentication of any kind — no shared secret, no
  // HMAC, no provider signature — while the identity it acts as is taken from
  // an unverified `from` form field: channels/email.ts reads the sender out of
  // the POST body, agent-core/identity.ts resolves it with
  // keycloak.findUserByEmail, and channels/index.ts then builds an
  // ActionContext for THAT user, in that user's tenant, with `initiator:
  // 'human'` standing when fr's verb grammar matches. So anyone who could
  // reach the endpoint could act as any user whose address they could guess.
  // The sibling channel receiver (telegram-webhook.ts) already gates on the
  // same shared helper; this one was missed by both prior remediation waves
  // (#756, #766), not exempted from them.
  //
  // Fail-closed comes from the helper, not from here: an UNSET
  // EMAIL_WEBHOOK_SECRET rejects in production (logged with the var name) and
  // is allowed only outside it, so blanking or rotating the var breaks loudly
  // instead of silently reopening the endpoint. There is deliberately no
  // override flag — see the header of utils/webhook-secret.ts.
  //
  // The 200 stays, and that is the deliberate part: mail providers retry
  // aggressively on non-2xx, so answering 401 to an unauthenticated flood
  // converts a rejected delivery into a retry storm against this endpoint.
  // Same trade-off telegram-webhook.ts documents — rejecting means "do not
  // process this payload", NOT "answer 401". The security property is the
  // early return (dispatch is never reached), not the status code, so the
  // caller cannot distinguish a rejected delivery from an accepted one.
  if (
    !isAuthorizedBySharedSecret({
      secret: config.services.email.webhookSecret,
      provided: req.headers.get('X-Email-Webhook-Secret'),
      envVarName: 'EMAIL_WEBHOOK_SECRET',
      receiver: 'email-webhook',
    })
  ) {
    console.warn('[email-webhook] unauthenticated delivery — rejecting');
    return jsonResponse({ received: true });
  }

  const dispatched = await channelDispatcher.handleWebhook('email', req.clone() as unknown as Request);
  if (dispatched) return dispatched;
  return jsonResponse({ received: true });
}
