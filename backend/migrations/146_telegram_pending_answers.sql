-- Migration: 146_telegram_pending_answers
-- Date: 2026-10-01
--
-- A Telegram approver who sends a BARE approve ("1", "Approve", "1 - Approve") on a row
-- that owes an answer and states no reviewer recommendation is now ASKED for the answer,
-- and their next message in the same chat + forum topic is recorded as it.
--
-- One row per (sender, chat, topic): the approval the next message answers. Lives in the
-- DB, not process memory, because fr restarts and may run more than one replica. Rows
-- are short-lived (expires_at = ask + 30 min) and are deleted when consumed; an expired
-- row is simply ignored and overwritten by the next ask.
--
-- `thread_key` is the topic id as TEXT, '' for "no topic", so the unique key also holds
-- for DMs (a NULL would never collide). Not a FK to approvals: the row must never block
-- an approval delete, and a stale row whose approval is gone is refused at read time.

CREATE TABLE IF NOT EXISTS telegram_pending_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_telegram_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_key TEXT NOT NULL DEFAULT '',
  approval_id UUID NOT NULL,
  -- Telegram's own `date` (unix seconds) of the bot's question, from the send response.
  -- Every ordering decision uses Telegram's clock (inbound message `date`, deliveries'
  -- `metadata_json->>'date'`), never the DB's, so the session timezone cannot move it.
  ask_date BIGINT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT telegram_pending_answers_sender_chat_thread_unique
    UNIQUE (sender_telegram_id, chat_id, thread_key)
);
