// src/routes/webhooks/budget-threshold.ts
//
// Receiver for billing_service's budget threshold-crossing webhook (the budget
// watcher's platform sink, PLATFORM_BUDGET_WEBHOOK_URL). On an 80%+ crossing it
// writes a durable inbox row + fans out to each of the tenant's workspace-admins'
// configured channels (Telegram once they've linked it; email once wired). The
// admins are the actionable audience — they can top the budget up.
//
// Auth: HMAC-SHA256 over the RAW body, X-Metering-Signature header (billing
// signs with a per-webhook secret; the platform sink uses
// PLATFORM_BUDGET_WEBHOOK_SECRET, mirrored here as billing.budgetWebhookSecret).
// Unlike the n8n webhooks (shared-secret X-Webhook-Secret) this one is signed,
// so the body cannot be tampered with in flight. Verification is FAIL-CLOSED:
// an unset secret is a 401 in production (and a boot-time refusal via
// validateProductionConfig), a dev-loop skip everywhere else.
//
// Idempotency: billing dedupes at source, but a network retry / double-delivery
// could still arrive twice — budget_alert_receipts (UNIQUE on the crossing key)
// makes the fan-out fire at most once per crossing.
import { and, eq } from 'drizzle-orm';

import { db, budgetAlertReceipts } from '../../db/client';
import { config } from '../../config';
import { jsonResponse } from '../../utils/response';
import { BadRequestError, UnauthorizedError } from '../../utils/errors';
import { verifyMeteringSignature } from '../../utils/webhook-hmac';
import { listWorkspaceAdminRecipients } from '../../services/workspace-admin-recipients';
import { notificationService } from '../../domain/engagement/notifications';
import {
  BudgetThresholdPayloadSchema,
  buildBudgetEvent,
  shouldNotify,
} from './budget-threshold.helpers';

/**
 * POST /api/webhooks/billing/budget-threshold
 * Verify the signature over the raw bytes, parse, skip sub-80% crossings,
 * dedupe, then fan out to the tenant's workspace-admins. Delivery is fail-safe
 * (never throws), but the inbox rows are awaited so they exist on return.
 */
export async function handleBudgetThresholdAlert(req: Request): Promise<Response> {
  // Read the RAW body FIRST — the signature is over the exact bytes billing
  // sent (canonical JSON); parsing + re-serialising would break verification.
  const raw = await req.text();

  const secret = config.services.billing.budgetWebhookSecret;
  if (!secret) {
    // FAIL CLOSED. An unset secret used to mean "skip verification" in every
    // environment, so blanking or rotating PLATFORM_BUDGET_WEBHOOK_SECRET
    // silently turned this receiver into an unauthenticated endpoint that
    // anyone could use to spam every workspace-admin's inbox — the failure was
    // invisible because the happy path kept returning 200. `config.env` is the
    // same signal validateProductionConfig() uses (which now also hard-requires
    // this var at boot), so the two guards can never disagree. Outside
    // production an unset secret still skips verification: the dev loop needs it
    // and there is nothing to protect.
    if (config.env === 'production') {
      throw new UnauthorizedError(
        'WEBHOOK_AUTH_NOT_CONFIGURED: PLATFORM_BUDGET_WEBHOOK_SECRET is not set',
      );
    }
  } else if (!verifyMeteringSignature(raw, req.headers.get('X-Metering-Signature'), secret)) {
    throw new UnauthorizedError('Invalid or missing budget webhook signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError('Invalid JSON body');
  }
  const p = BudgetThresholdPayloadSchema.parse(parsed);

  // billing fires 50/80/100; only 80%+ is an actionable low-budget alert.
  if (!shouldNotify(p.threshold_pct)) {
    return jsonResponse({ ok: true, skipped: 'below_notify_threshold', threshold_pct: p.threshold_pct });
  }

  // period_start is validated as a real datetime by the schema, but re-check the
  // parsed Date: an unparseable value would otherwise reach the TIMESTAMPTZ
  // insert, throw, and 500 — and billing treats non-2xx as a transient failure,
  // so it would re-POST the same permanently-bad payload every 60s forever.
  const periodStart = new Date(p.period_start);
  if (Number.isNaN(periodStart.getTime())) {
    throw new BadRequestError(`Unparseable period_start: ${p.period_start}`);
  }

  // Resolve recipients BEFORE claiming the receipt. Writing the receipt first
  // was an at-most-once bug: with zero admins we returned 200 with the receipt
  // already committed, and because 2xx also makes billing record ITS dedupe row,
  // the crossing was permanently dead on both sides — assigning an admin later
  // could never recover it. A crash between the two steps lost it the same way.
  //
  // Recipients = `user_roles` workspace-admins ∪ Keycloak realm `tenant_admin`
  // holders whose `tenant_id` attribute is this tenant — the same people every
  // backend gate treats as this workspace's admins. The directory half is
  // fail-soft (falls back to `user_roles` only); `realm_lookup_failed` says so.
  const { userIds: admins, realmError } = await listWorkspaceAdminRecipients(p.tenant_id);
  if (admins.length === 0) {
    // Nothing to route to. Deliberately claim NO receipt so the alert can still
    // be delivered once the tenant has an admin. Still 200: the payload is
    // well-formed, and billing's own dedupe stops it re-POSTing this period.
    console.warn(
      `[webhooks] budget.threshold ${p.threshold_pct}% for tenant ${p.tenant_id}: no workspace-admins to notify` +
        (realmError ? ' (Keycloak tenant_admin lookup FAILED — user_roles only)' : ''),
    );
    return jsonResponse({
      ok: true,
      recipients: 0,
      reason: 'no_recipients',
      ...(realmError ? { realm_lookup_failed: true } : {}),
    });
  }

  // Replay check: a receipt means a previous delivery already fanned out.
  const existing = await db
    .select({ id: budgetAlertReceipts.id })
    .from(budgetAlertReceipts)
    .where(
      and(
        eq(budgetAlertReceipts.budget_id, p.budget_id),
        eq(budgetAlertReceipts.threshold_pct, p.threshold_pct),
        eq(budgetAlertReceipts.period_start, periodStart),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return jsonResponse({ ok: true, deduped: true });
  }

  const event = buildBudgetEvent(p, p.tenant_id);
  // fanOutEventToUser is fail-safe, so allSettled always resolves.
  await Promise.allSettled(admins.map((uid) => notificationService.fanOutEventToUser(event, uid)));

  // Record the receipt only AFTER the fan-out actually happened. Claiming it
  // first would make a crash mid-fan-out permanently swallow the crossing
  // (billing retries, we answer "deduped", nobody is ever told). Recording last
  // makes the failure mode at-least-once — for a budget alert a rare duplicate
  // is strictly better than a silent loss. The UNIQUE constraint still collapses
  // genuine double-deliveries via the replay check above.
  await db
    .insert(budgetAlertReceipts)
    .values({
      tenant_id: p.tenant_id,
      budget_id: p.budget_id,
      threshold_pct: p.threshold_pct,
      period_start: periodStart,
    })
    .onConflictDoNothing();

  console.log(
    `[webhooks] budget.threshold ${p.threshold_pct}% for tenant ${p.tenant_id} → ${admins.length} admin(s)`,
  );
  return jsonResponse({ ok: true, recipients: admins.length });
}
