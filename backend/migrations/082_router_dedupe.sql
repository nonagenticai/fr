-- backend/migrations/082_router_dedupe.sql
--
-- Durable ATOMIC dedupe for the AA router's Planka card-move cascade.
--
-- Planka emits N cardUpdate webhooks per single card move (one per customField
-- PATCH that follows the list change). The n8n router's `Cascade Dedupe` Code
-- node collapses them via a $getWorkflowStaticData('global') cache, but that is
-- a best-effort guard: under truly concurrent router executions a read-before-
-- write TOCTOU lets N simultaneous events all pass (each loads the cache before
-- any writes it back). This table is the ATOMIC backstop the staticData guard
-- can't be: the router calls POST /api/webhooks/n8n/router-dedupe (only for
-- events that already passed staticData), which does an
--   INSERT ... ON CONFLICT (tenant_id, card_id, list_id, updated_at_sec) DO NOTHING RETURNING
-- Exactly one concurrent caller gets a row back (= first → proceed routing); the
-- rest get none (= duplicate → suppress). The unique PK IS the atomicity — no
-- advisory lock needed. The router calls with onError:continue, so fr being down
-- degrades to the staticData guard rather than breaking routing.
--
-- No BEGIN/COMMIT — the migration runner wraps every file in a SAVEPOINT inside
-- an outer transaction (see src/db/migration-runner.ts); an explicit COMMIT here
-- would break the next file's SAVEPOINT.

CREATE TABLE IF NOT EXISTS router_dedupe (
  tenant_id      TEXT        NOT NULL,
  card_id        TEXT        NOT NULL,
  list_id        TEXT        NOT NULL,
  updated_at_sec BIGINT      NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, card_id, list_id, updated_at_sec)
);

-- The dedupe claim is only meaningful for the ~60s cascade window; an
-- opportunistic DELETE in the handler reaps rows past the window via this index
-- so the table stays small.
CREATE INDEX IF NOT EXISTS router_dedupe_created_at_idx ON router_dedupe (created_at);
