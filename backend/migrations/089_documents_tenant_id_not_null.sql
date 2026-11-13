-- 089: documents.tenant_id SET NOT NULL — enforce record-and-replay at the schema level.
--
-- migration 083 added documents.tenant_id (nullable) to record the tenant a document's
-- KAG data was ingested under, so the delete path can REPLAY that tenant instead of
-- re-deriving one from whoever happens to be pressing Delete. fr #693 made the runtime
-- honour it: upload refuses (422) rather than inserting a NULL-tenant row, and delete
-- refuses (409) on any legacy NULL-tenant row rather than purging under the wrong tenant
-- (which silently deletes nothing downstream and orphans the document's PHI).
--
-- With the runtime hole closed and the four legacy prod rows repaired
-- (scripts/repair-document-tenant.ts), NULL is no longer a reachable state. Making the
-- column NOT NULL turns the invariant into a schema guarantee: no future code path — a new
-- ingest route, a bulk import, a careless INSERT — can ever again create a document whose
-- tenant was not recorded, which is the single precondition for the whole purge chain to be
-- correct.
--
-- ORDERING: this migration FAILS LOUDLY if any NULL row remains (that is the point — it
-- must not be applied before the legacy rows are repaired). It is deployed only after the
-- repair has been run and `SELECT count(*) FROM documents WHERE tenant_id IS NULL` is 0.
--
-- Idempotent: SET NOT NULL on an already-NOT-NULL column is a no-op. Wrapped in
-- BEGIN/COMMIT (the runner supplies its own transaction).

BEGIN;

ALTER TABLE documents ALTER COLUMN tenant_id SET NOT NULL;

COMMIT;
