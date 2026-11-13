// src/utils/webhook-secret.ts
//
// The ONE implementation of the shared-secret check that guards every n8n /
// upstream-service webhook receiver (`X-Webhook-Secret`). It used to be copied
// into four files (routes/webhooks.ts, routes/reports.ts and two since-removed
// rollback receivers) and the copies had already drifted — one compared with a
// plain `!==`, which short-circuits on the first mismatching byte and leaks the
// matching-prefix length to a timing attacker.
//
// FAIL-CLOSED, and why there is no escape hatch
// ---------------------------------------------
// An unset secret means "skip authentication entirely". That is a legitimate
// dev-loop convenience and an unacceptable production posture: blanking or
// rotating the env var would silently open the endpoint to the internet instead
// of breaking loudly. So the skip is gated on `config.env !== 'production'` and
// nothing else — no `ALLOW_INSECURE_WEBHOOKS`-style override, because any such
// flag re-introduces exactly the fail-open we are removing (and the flag, not
// the secret, becomes the thing an operator forgets).
//
// We gate on `config.env` (i.e. NODE_ENV) rather than `process.env.ENVIRONMENT`
// deliberately: `validateProductionConfig` in src/config.ts uses the same
// signal, so the boot-time guard ("N8N_WEBHOOK_SECRET must be set") and this
// request-time guard can never disagree about whether we are in production. A
// prod-shaped deploy that forgets NODE_ENV=production is already diagnosed by
// the PROD-BOOT GUARD INERT warning there; splitting the signal here would give
// us a third, silently-different answer.
//
// In a correctly-configured production deploy the throw below is unreachable —
// `validateProductionConfig` crashes the process at boot before it accepts
// traffic. It exists for the deploys where that guard is inert, which is
// precisely when the endpoint would otherwise be wide open.
import { config } from '../config';
import { UnauthorizedError } from './errors';
import { timingSafeEquals } from './secret-compare';

/**
 * Validate the shared `X-Webhook-Secret` header against N8N_WEBHOOK_SECRET.
 *
 * Throws `UnauthorizedError` (→ 401) when the header is missing or wrong, and
 * ALSO when the secret itself is unconfigured in production. Returns silently
 * outside production when no secret is set (dev mode).
 */
export function validateWebhookSecret(req: Request): void {
  const secret = config.services.n8n.webhookSecret;

  if (!secret) {
    if (config.env === 'production') {
      // Fail closed: an unauthenticated webhook receiver in prod is a bigger
      // incident than a 401'ing one. The message names the missing var so the
      // operator sees the fix in the response/log without a code dive.
      throw new UnauthorizedError(
        'WEBHOOK_AUTH_NOT_CONFIGURED: N8N_WEBHOOK_SECRET is not set',
      );
    }
    return; // dev/test: no secret configured — allow.
  }

  const provided = req.headers.get('X-Webhook-Secret');
  // Constant-time compare (see secret-compare.ts). `provided === null` is
  // checked first because timingSafeEquals takes strings, not null.
  if (provided === null || !timingSafeEquals(provided, secret)) {
    throw new UnauthorizedError('Invalid or missing webhook secret');
  }
}

/**
 * Boolean form of the same rule, for receivers that cannot use
 * `validateWebhookSecret` because they carry their OWN secret and/or must not
 * answer with a 401.
 *
 * The Telegram receiver is the reason this exists: Telegram
 * retries non-2xx and DISABLES a webhook that errors repeatedly, so those
 * endpoints must answer 200 even when they reject. That is a transport
 * constraint, not a security one — the security property is "do not process an
 * unauthenticated payload", which is about the early return, not the status
 * code. Returning `false` here and `200 {received:true}` there satisfies both.
 *
 * Same three-way rule as `validateWebhookSecret`:
 *   - secret set                     → timing-safe compare
 *   - secret unset, production       → false (FAIL CLOSED, logged with the var name)
 *   - secret unset, non-production   → true  (dev-loop convenience)
 *
 * Note these vars are deliberately NOT added to `validateProductionConfig`'s
 * required list: fr's image also runs as `kag-frontend/kag`, whose secret does
 * not carry them, and a boot guard on a var that one deployment lacks
 * CrashLoops that deployment (paid for once already — see the
 * `fr-image-runs-in-two-namespaces` memory). Failing closed at REQUEST time is
 * safe regardless of which deployment is booting, which is exactly why it is
 * the right layer for a per-channel secret.
 */
export function isAuthorizedBySharedSecret(args: {
  /** The configured secret, or empty/undefined when unconfigured. */
  secret: string | null | undefined;
  /** The value the caller presented, or null when the header was absent. */
  provided: string | null;
  /** Env var name, used only in the fail-closed log line. */
  envVarName: string;
  /** Receiver name for the log line. */
  receiver: string;
}): boolean {
  const { secret, provided, envVarName, receiver } = args;

  if (!secret) {
    if (config.env === 'production') {
      console.error(
        `[${receiver}] WEBHOOK_AUTH_NOT_CONFIGURED: ${envVarName} is not set — rejecting unauthenticated delivery`,
      );
      return false;
    }
    return true; // dev/test: no secret configured — allow.
  }

  return provided !== null && timingSafeEquals(provided, secret);
}
