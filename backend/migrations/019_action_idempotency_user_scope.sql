-- Migration: User-scope the action_idempotency cache
-- Date: 2026-04-25
-- Reason: Code review (Wave 1 Slice 2) flagged that two users with the same
--         client_idempotency_key could collide on the registry-wide cache.
--         The cache is a TTL store with no foreign-key dependents — wiping
--         it before adding the NOT NULL column is safe; in the worst case
--         in-flight retries within the TTL window get re-executed once.
--
--         user_id is TEXT (not UUID) because ActionContext.userId is
--         declared `string` and unit tests use opaque ids like 'u1'. Other
--         tables in this codebase split between TEXT (user_channel_prefs,
--         engagement_deliveries) and UUID (repositories, documents); we
--         follow the looser shape because action_idempotency stores no
--         join keys to user-scoped rows — it is purely a dedup namespace.

TRUNCATE TABLE action_idempotency;

ALTER TABLE action_idempotency
    DROP CONSTRAINT action_idempotency_pkey;

ALTER TABLE action_idempotency
    ADD COLUMN user_id TEXT NOT NULL;

ALTER TABLE action_idempotency
    ADD CONSTRAINT action_idempotency_pkey PRIMARY KEY (user_id, key);
