-- 092: budget_topups — tenant budget top-up audit + PAYMENT record.
--
-- fr owns the top-up intent + payment record; billing_service owns the token
-- budget (its token_budgets table has no metadata column, so there is nowhere
-- there to hang a payment reference). `budget_id` links this row to the
-- allocated billing budget.
--
-- The payment_* columns are the SEAM for a future Stripe/other integration: no
-- payment processor exists in the fleet today, so a top-up settles for free
-- (payment_status='free', payment_ref a 'free-…' sentinel). When a provider is
-- wired, these hold the real PaymentIntent id + status with NO schema change.
-- Actor + tenant + tokens give a full audit even before money is involved.

CREATE TABLE IF NOT EXISTS budget_topups (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL,
    actor_user_id  TEXT NOT NULL,
    package_id     TEXT NOT NULL,
    tokens         BIGINT NOT NULL,
    price_usd      NUMERIC NOT NULL DEFAULT 0,
    budget_id      UUID,                                   -- billing token_budgets.id once allocated
    payment_ref    TEXT,
    payment_status TEXT NOT NULL DEFAULT 'free',
    status         TEXT NOT NULL DEFAULT 'pending',
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT budget_topups_payment_status_check
        CHECK (payment_status IN ('free','paid','pending','failed')),
    CONSTRAINT budget_topups_status_check
        CHECK (status IN ('pending','allocated','failed'))
);

-- Tenant-admin "my top-ups" history + super-admin per-tenant view.
CREATE INDEX IF NOT EXISTS ix_budget_topups_tenant_created
    ON budget_topups (tenant_id, created_at DESC);
