-- Migration: 202_signup_approvals
-- Date: 2026-10-20
--
-- Early-access signup v2 for fr (the CommonPractice flow; ~/.claude/plans/early-access-v2.md):
-- a visitor asks on nonagentic.ai/early-access/fr, the early-access-intake handler relays it with a
-- service-account token (POST /api/signup-approvals/intake), George approves with one Telegram tap
-- (chat-bridge → POST /api/signup-approvals/:id/telegram-decision) or on /admin/onboarding, and the
-- person gets ONE email that lands them in fr signed in.
--
-- signup_approvals — one row per request (and per super_admin invite, source 'invite').
--   * One PENDING row per address: partial unique index on lower(email) WHERE status = 'pending'
--     (a re-submit is a silent no-op; a decided row does not block a new request).
--   * `locale` — the email's language (C6), CHECKed to the eight theme locales; NULL = English.
--   * `approving_until` + `approving_claim` — the approve claim: one approver at a time across
--     replicas (the screen, a Telegram tap, a redelivered tap). The claim's RETURNING row is what
--     the approve works from, a heartbeat renews it, and the final write requires the token.
--   * `tenant_slug` — RESERVED here before anything is created (partial UNIQUE index): the engine
--     keys its tenant on (owner fr, external_ref = slug) and would provision a second signup INTO an
--     existing tenant of the same slug. Released on reject once nothing is left to undo.
--   * `tenant_id` — THE "founded by this signup" record: written only when fr's own licences
--     `POST /tenants` answered 201 for this row's slug. A resume accepts the slug's tenant only when
--     it is this id; the provision step, every later step and reject work from it alone.
--   * `tenant_attempts` — {slug: {state, at, tenantId?}}, written BEFORE each licences
--     `POST /tenants`: `attempted` (sent, outcome not recorded — a crash or timeout may have founded
--     it), `founded` (201 recorded as `tenant_id`), `suspected_orphan` (a later attempt found a
--     tenant on a slug THIS row attempted but never recorded), `foreign`, `orphan`. An operator
--     record only: fr never joins a tenant because of it.
--   * `kc_user_id` / `identity_minted` — the realm identity fr minted for the requester (no
--     credential until the emailed link is used), stamped `fr_signup_id = [id]`. Adopted, written
--     to or deleted only on an exact match of that attribute (approve refuses `identity_exists`).
--   * `steps` — per provisioning step {status, at, code, error, detail}; `steps_lease_*` is the ONE
--     lease approve, the 5-minute tick and the super_admin Retry all take before running a step, so
--     two of them can never send the email twice. `steps_next_attempt_at` / `steps_attempts` are the
--     tick's bounded backoff.
--   * `reject_repair` — a REJECTED signup whose earlier, aborted approve left something behind (a
--     minted identity, a provisioned tenant): state pending|done|failed|blocked|resolved_manually,
--     finished by the tick, closable by a super_admin with a note.
--
-- No RLS: fr has no row-level-security tables; this is a platform table read by super_admin
-- surfaces and service doors only.
--
-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime): PROTECTED — a signup record has no
-- regeneration path. Listed in 142's `protected_tables` AND attached below (142 never re-runs in
-- production).
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (a push-built database satisfies
-- the probe). Idempotent — safe under `reapplyIfProbeFails`. No BEGIN/COMMIT.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS signup_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  company text NULL,
  message text NULL CHECK (message IS NULL OR char_length(message) <= 2000),
  locale text NULL CHECK (locale IS NULL OR locale IN ('ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl')),
  source text NOT NULL CHECK (source IN ('web', 'chat', 'invite')),
  intake_client text NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL,
  decided_by text NULL,
  decided_via text NULL CHECK (decided_via IS NULL OR decided_via IN ('onboarding', 'telegram')),
  decider_actor text NULL,
  approving_until timestamptz NULL,
  approving_claim uuid NULL,
  tenant_name text NULL,
  tenant_slug text NULL CHECK (tenant_slug IS NULL OR tenant_slug ~ '^[a-z0-9-]{2,40}$'),
  tenant_id uuid NULL,
  tenant_attempts jsonb NOT NULL DEFAULT '{}'::jsonb,
  kc_user_id uuid NULL,
  identity_minted boolean NOT NULL DEFAULT false,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps_lease_until timestamptz NULL,
  steps_lease_token uuid NULL,
  steps_next_attempt_at timestamptz NULL,
  steps_attempts integer NOT NULL DEFAULT 0 CHECK (steps_attempts >= 0),
  reject_repair jsonb NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS signup_approvals_pending_email
  ON signup_approvals (lower(email)) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS signup_approvals_tenant_slug_key
  ON signup_approvals (tenant_slug) WHERE tenant_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_approvals_status_created_idx
  ON signup_approvals (status, created_at);
CREATE INDEX IF NOT EXISTS signup_approvals_steps_due_idx
  ON signup_approvals (steps_next_attempt_at) WHERE steps_next_attempt_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_approvals_reject_repair_state_idx
  ON signup_approvals ((reject_repair->>'state')) WHERE reject_repair IS NOT NULL;

CREATE OR REPLACE TRIGGER fr_guard_truncate_signup_approvals
  BEFORE TRUNCATE ON public.signup_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.signup_approvals
  ENABLE ALWAYS TRIGGER fr_guard_truncate_signup_approvals;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_signup_approvals
  AFTER DELETE ON public.signup_approvals
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.signup_approvals
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_signup_approvals;
