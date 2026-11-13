-- backend/migrations/226_andon_worker_scale.sql
--
-- The global andon cord's actuator changed: it no longer deactivates every n8n
-- workflow, it scales `n8n/n8n-worker` to 0 and back to 1 (lib/k8s-scale.ts).
--
-- WHY THE COLUMNS MOVE WITH IT. `paused_workflow_ids` held the exact set of
-- workflows the pull had deactivated, so disengage could reactivate precisely
-- those. That set has no meaning under the new actuator — there is nothing to
-- restore, the replica count IS the state — so keeping the column would leave a
-- second, silently-stale source of truth next to the real one. The two evidence
-- columns keep their meaning exactly ("when the last actuator attempt ran", "what
-- it said") and are renamed to describe the thing they now record.
--
-- `worker_replicas` is the MEASUREMENT, not the intention: the value read back
-- from the API server after the attempt. NULL means "not measured" and must never
-- be rendered as 0 — a failed call is not evidence that the worker stopped.
--
-- Drift-tolerant: every statement is a no-op when the database already carries the
-- post-migration shape, which is how a `drizzle-kit push`-bootstrapped database
-- (CI builds its schema from schema.ts) arrives here.
--
-- No BEGIN/COMMIT — the migration runner wraps every file in a SAVEPOINT inside an
-- outer transaction (see src/db/migration-runner.ts).

-- 1. n8n_paused_at -> worker_scaled_at
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'andon_state' AND column_name = 'n8n_paused_at'
      )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'andon_state' AND column_name = 'worker_scaled_at'
      )
  THEN
    ALTER TABLE andon_state RENAME COLUMN n8n_paused_at TO worker_scaled_at;
  END IF;
END $$;

-- 2. n8n_pause_error -> worker_scale_error
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'andon_state' AND column_name = 'n8n_pause_error'
      )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'andon_state' AND column_name = 'worker_scale_error'
      )
  THEN
    ALTER TABLE andon_state RENAME COLUMN n8n_pause_error TO worker_scale_error;
  END IF;
END $$;

-- 3. The deactivated-workflow snapshot is gone with its actuator.
ALTER TABLE andon_state DROP COLUMN IF EXISTS paused_workflow_ids;

-- 4. What the last attempt measured: spec.replicas of `n8n-worker`.
ALTER TABLE andon_state ADD COLUMN IF NOT EXISTS worker_replicas INTEGER;
