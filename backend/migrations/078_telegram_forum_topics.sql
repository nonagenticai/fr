-- Migration 078: telegram_forum_topics
-- Caches the (chat_id, project_key) -> Telegram forum message_thread_id mapping
-- so the TelegramAdapter creates ONE forum topic per project (named after the
-- project) and reuses it across approvals/notifications instead of recreating
-- it (Telegram's createForumTopic always makes a new topic). Gated behind
-- TELEGRAM_USE_TOPICS; only populated when posting to a forum supergroup.
CREATE TABLE IF NOT EXISTS telegram_forum_topics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id           text NOT NULL,
  project_key       text NOT NULL,         -- the fr project_id (stable cache key)
  message_thread_id integer NOT NULL,      -- Telegram forum topic id
  topic_name        text,                  -- the project name used to create it (for audit)
  created_at        timestamp NOT NULL DEFAULT now(),
  CONSTRAINT telegram_forum_topics_chat_project_unique UNIQUE (chat_id, project_key)
);
