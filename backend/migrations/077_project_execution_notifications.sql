-- Migration: 073_project_execution_notifications
-- Date: 2026-06-07
-- Plan ref: ~/.claude/plans/steady-inventing-tome.md (WS1 Phase 1A)
--
-- fr becomes the hub for NON-APPROVAL project-execution notifications. The
-- approval path (approvals + required_approvers + fanOutToUser) already exists
-- and is untouched. This migration adds the two tables that back the new
-- lifecycle/outcome notification surface:
--
--   * `notifications` — the durable per-user inbox. One row per (user, event)
--     written by NotificationService.fanOutEventToUser regardless of whether
--     any external channel delivery succeeds. This row IS the in-app inbox
--     (the existing `inapp_messages` table is a chat transcript with no
--     read-state and is deliberately left for chat — conflating the two
--     breaks its contract and the unread-badge query). The partial index on
--     (user_id, created_at DESC) WHERE read_at IS NULL backs the cheap
--     unread-count query that drives the sidebar badge.
--
--   * `notification_prefs` — the WHAT layer. `user_channel_prefs` already
--     answers WHERE a user is reachable (channel -> address); this answers
--     WHICH event types go to WHICH channels. Composed at dispatch time by
--     domain/engagement/notification-prefs.ts#resolveRecipientsForEvent.
--     Missing rows fall back to code defaults (event-types.ts): external
--     channels default-on only for error/warning severity events. The inbox
--     row is always written and is not governed by these prefs.
--
-- Pre-prod, forward-only. `gen_random_uuid()` is available (pgcrypto / PG13+,
-- already used by every prior migration).

BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text        NOT NULL,
  user_id        text        NOT NULL,
  event_type     text        NOT NULL,
  severity       text        NOT NULL DEFAULT 'info',  -- info|success|warning|error
  title          text        NOT NULL,
  body           text,
  link           text,
  project_id     text,
  card_id        text,
  execution_id   text,
  source         text        NOT NULL DEFAULT 'n8n',
  correlation_id text,
  metadata       jsonb,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Badge query: count/list a user's UNREAD notifications, newest first.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- Full inbox listing (read + unread) for a user, newest first.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_prefs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  event_type  text        NOT NULL,
  channel     text        NOT NULL,   -- 'email'|'signal'|'teams'|'websocket'
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- One row per (user, event_type, channel) — the replace-all upsert target.
  UNIQUE (user_id, event_type, channel)
);

COMMIT;
