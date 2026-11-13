// src/routes/webhooks/budget-threshold.helpers.ts
//
// Pure logic for the billing budget-alert webhook receiver. Extracted so it can
// be unit-tested without a DB / HTTP — the handler (budget-threshold.ts) wires
// these to signature verification, dedup, recipient resolution and fan-out.
import { z } from 'zod';

import type { ExecutionEvent } from '../../domain/engagement/notifications';
import type { Severity } from '../../domain/engagement/event-types';

/**
 * Payload emitted by billing_service's budget watcher (see
 * billing_service/src/services/budget_watcher.py). `.strict()` so an unexpected
 * shape is rejected rather than silently notifying on garbage.
 */
export const BudgetThresholdPayloadSchema = z
  .object({
    event: z.literal('budget.threshold_crossed'),
    tenant_id: z.string().min(1),
    budget_id: z.string().min(1),
    threshold_pct: z.number().int(),
    // Must be a real datetime, not just a non-empty string: an unparseable value
    // reached `new Date(...)` → Invalid Date → the TIMESTAMPTZ insert threw
    // uncaught → 500. billing reads non-2xx as transient and re-POSTs every 60s,
    // so a permanently-malformed payload became an infinite retry loop. Reject
    // it as a 400 instead. billing sends `datetime.isoformat()`, which parses.
    period_start: z.string().datetime({ offset: true }),
    budget_tokens: z.number(),
    consumed_tokens: z.number(),
    usage_pct: z.number(),
    fired_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type BudgetThresholdPayload = z.infer<typeof BudgetThresholdPayloadSchema>;

/**
 * Only 80%+ crossings are "low-budget" alerts worth pushing. billing also fires
 * a 50% crossing, but 50% is not actionable and would be noise — the receiver
 * accepts it (200) but does not notify below this threshold.
 */
export const NOTIFY_THRESHOLD_PCT = 80;

export function shouldNotify(thresholdPct: number): boolean {
  return thresholdPct >= NOTIFY_THRESHOLD_PCT;
}

/** Exhausted (100%) is an error; an 80/90% warning is a heads-up. */
export function severityForThreshold(thresholdPct: number): Severity {
  return thresholdPct >= 100 ? 'error' : 'warning';
}

/**
 * Stable per-crossing key. Mirrors billing's dedupe tuple
 * (budget_id, threshold_pct, period_start) — set as the notification's
 * correlation_id so an operator can trace an inbox row back to the crossing.
 */
export function budgetAlertCorrelationId(p: BudgetThresholdPayload): string {
  return `budget:${p.budget_id}:${p.threshold_pct}:${p.period_start}`;
}

function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Build the fan-out event from a validated payload. `tenantId` is passed
 * explicitly (the handler may normalise it) — everything else is derived.
 */
export function buildBudgetEvent(p: BudgetThresholdPayload, tenantId: string): ExecutionEvent {
  const remaining = Math.max(0, p.budget_tokens - p.consumed_tokens);
  const exhausted = p.threshold_pct >= 100;
  const title = exhausted
    ? 'Token budget exhausted'
    : `Token budget ${p.threshold_pct}% used`;
  const body = exhausted
    ? `Your token budget is fully consumed (${formatTokens(p.consumed_tokens)} of ` +
      `${formatTokens(p.budget_tokens)} tokens). Contact your account manager to raise your budget.`
    : `You have used ${p.usage_pct.toFixed(1)}% of your token budget ` +
      `(${formatTokens(remaining)} of ${formatTokens(p.budget_tokens)} tokens remaining). ` +
      `Contact your account manager if you need a higher budget.`;

  return {
    event_type: 'budget.threshold',
    tenant_id: tenantId,
    severity: severityForThreshold(p.threshold_pct),
    title,
    body,
    // Deep link into the admin area. Moved with it: this used to point at
    // /settings/admin/budget, which the consolidation turned into a 404 —
    // a dead link in a NOTIFICATION is worse than a dead nav entry, because
    // it arrives exactly when someone needs to act on a budget.
    link: '/admin/budget',
    project_id: null,
    card_id: null,
    execution_id: null,
    source: 'billing',
    correlation_id: budgetAlertCorrelationId(p),
    metadata: {
      budget_id: p.budget_id,
      threshold_pct: p.threshold_pct,
      usage_pct: p.usage_pct,
      budget_tokens: p.budget_tokens,
      consumed_tokens: p.consumed_tokens,
      remaining_tokens: remaining,
      period_start: p.period_start,
    },
  };
}
