-- Migration: 037_seed_tenant_improvement_projects
-- Date: 2026-04-29
-- Slice: 2026-04-27-continuous-improvement-design (Spec 3 §6.0)
--
-- Records the two umbrella Planka projects created 2026-04-29 against
-- the kanban service. Each row pins one (tenant_id, kind) → planka
-- project id; this is what `services/streams/provisioner.ensureUmbrella
-- Project()` reads to skip re-creation when a stream is added.
--
-- Planka projects (visible via the kanban UI as the agent user):
--   "Continuous Workflow Improvement" → id 1764108879001552894
--   "Continuous Prompt Improvement"   → id 1764108882289886208
--
-- Idempotent on the (tenant_id, kind) primary key.

BEGIN;

INSERT INTO tenant_improvement_projects (tenant_id, kind, planka_project_id)
VALUES
    (
        '00000000-0000-4000-8000-000000000001',
        'workflow',
        '1764108879001552894'
    ),
    (
        '00000000-0000-4000-8000-000000000002',
        'prompt',
        '1764108882289886208'
    )
ON CONFLICT (tenant_id, kind) DO NOTHING;

COMMIT;
