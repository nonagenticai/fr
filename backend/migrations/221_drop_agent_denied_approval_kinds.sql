-- Migration: 221_drop_agent_denied_approval_kinds
-- Date: 2026-10-31
--
-- Owner ruling 2026-10-31: all channels are equivalent and a responder is a responder; fr
-- never decides what a human vs an agent may answer. The per-tenant agent deny-list
-- (workspaces.agent_denied_approval_kinds, migration 220) refused a responder for being an
-- agent, so it is removed with its routes. 220's widened decided_by_kind CHECK ('agent',
-- an audit label) stays.
-- Pure idempotent DDL. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE workspaces DROP COLUMN IF EXISTS agent_denied_approval_kinds;
