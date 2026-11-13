-- Migration: 192_approval_artifact_ref
-- Date: 2026-10-13
--
-- D13 (George 2026-10-13: ONE ref per approval): an approval minted by n8n
-- (POST /api/execution/approvals, POST /api/webhooks/n8n/card-approval) may name
-- the artifact it asks a human to approve, as `artifact_ref`
-- `{artifact_id: uuid, version?: integer >= 1}`. Validated at create against the
-- approval's own project through the artifact service (lib/approval-artifact-ref.ts:
-- 422 artifact_ref_invalid / artifact_ref_not_found), returned on every approval
-- read, echoed on the decision callback (services/n8n-callback.ts
-- buildCallbackPayload) and linked from the approval detail page.
--
-- ONE nullable jsonb column, not two: the ref is a unit (an id plus an optional
-- version that means nothing without it), it is written once at create and never
-- queried by its parts, and a jsonb value keeps "no version" (the ref names the
-- artifact, not a pinned version) distinct from any version number. NULL = no
-- artifact. Not a capability (unlike 191's callback_url), so it rides the row.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (so a
-- push-built database satisfies the probe). Idempotent (ADD COLUMN IF NOT
-- EXISTS) — safe under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps
-- each file in a SAVEPOINT. Adding a nullable column with no default is a
-- metadata-only change (no table rewrite).

SET LOCAL lock_timeout = '10s';

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS artifact_ref jsonb NULL;
