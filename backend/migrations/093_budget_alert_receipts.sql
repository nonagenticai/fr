-- 093: budget_alert_receipts — idempotency receipts for billing_service's
-- budget threshold-crossing webhooks (POST /api/webhooks/billing/budget-threshold).
--
-- billing already dedupes at source on (budget_id, threshold_pct, period_start),
-- but a network retry or double-delivery could still arrive twice. This table
-- lets the receiver INSERT ... ON CONFLICT DO NOTHING so it fans out at most once
-- per crossing. tenant_id/budget_id are TEXT so a legacy non-uuid billing tenant
-- can never fail the receipt insert. Append-only audit — never read back except
-- via the ON CONFLICT probe.

CREATE TABLE IF NOT EXISTS budget_alert_receipts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     TEXT NOT NULL,
    budget_id     TEXT NOT NULL,
    threshold_pct INTEGER NOT NULL,
    period_start  TIMESTAMPTZ NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Matches billing's budget_overage_alerts dedupe key. budget_id is globally
    -- unique, so tenant_id is not part of the key.
    CONSTRAINT budget_alert_receipts_dedupe UNIQUE (budget_id, threshold_pct, period_start)
);
