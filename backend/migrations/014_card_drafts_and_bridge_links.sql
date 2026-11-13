-- Migration: E-14 analysis-to-kanban bridge — card drafts + dedup links
-- Date: 2026-04-25
-- Reason: Wave-2 bridge slice introduces a generic "promote a tool output to
--         a kanban card" primitive. `card_drafts` is the pre-approval staging
--         area (editable, not yet written to Planka) — keeping it separate
--         from `approvals` avoids overloading approval status semantics with
--         draft-editing states. `card_bridge_links` is the dedup index keyed
--         on `(project_id, producer, stable_id)` so a re-run of the same
--         producer (coding analysis, KAG ingestion, artifacts flag) does not
--         create duplicate cards. The same tuple is also embedded in the
--         Planka card body as a fenced `fr-bridge` JSON block, so the link
--         survives a DB loss.

CREATE TABLE IF NOT EXISTS card_drafts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         UUID NOT NULL,
    drafter_id         UUID NOT NULL,                 -- user (or agent on behalf of user)
    initiator          TEXT NOT NULL,                 -- 'user' | 'agent' | 'cron'
    producer           TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    output_id          TEXT NOT NULL,
    stable_id          TEXT NOT NULL,                 -- producer canonical key, see Dedup
    content_digest     TEXT NOT NULL,                 -- sha256(normalized title+body)
    title              TEXT NOT NULL,
    body_md            TEXT NOT NULL,
    target_project_id  TEXT,
    target_board_id    TEXT,
    target_list_id     TEXT,
    assignee_user_id   UUID,
    labels             TEXT[] NOT NULL DEFAULT '{}',
    status             TEXT NOT NULL DEFAULT 'editing',
                       -- 'editing' | 'submitted' | 'committed' | 'rejected' | 'deduped'
    approval_id        UUID,                          -- FK to approvals, set on submit
    committed_card_id  TEXT,                          -- Planka card id, set on commit
    dedup_of_card_id   TEXT,                          -- set if dedup'd to an existing card
    metadata           JSONB NOT NULL DEFAULT '{}',   -- correlation_id, idempotency_key, etc.
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS card_drafts_project_status_idx
    ON card_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS card_drafts_approval_idx
    ON card_drafts(approval_id);

CREATE TABLE IF NOT EXISTS card_bridge_links (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     UUID NOT NULL,
    producer       TEXT NOT NULL,
    stable_id      TEXT NOT NULL,
    card_id        TEXT NOT NULL,                     -- Planka card id
    run_id         TEXT NOT NULL,                     -- last run that confirmed it
    content_digest TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, producer, stable_id)
);

CREATE INDEX IF NOT EXISTS card_bridge_links_card_id_idx
    ON card_bridge_links(card_id);
CREATE INDEX IF NOT EXISTS card_bridge_links_digest_idx
    ON card_bridge_links(project_id, producer, content_digest);
