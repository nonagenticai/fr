-- Migration: 036_seed_internal_tenant_operator_roles
-- Date: 2026-04-29
-- Slice: 2026-04-27-continuous-improvement-design (Spec 3 §6.0)
--
-- Grants `workspace-admin` to the two Keycloak operator accounts on their
-- matching internal workspace, so streams.policy assertCanCreateStream /
-- assertCanMutateStream pass for stream registry CRUD.
--
-- Keycloak users created 2026-04-29 in the portal realm:
--   system-workflow-operator (sub: c82077b7-08c2-46cd-886d-b0fa6a69f732)
--     → tenant_id 00000000-0000-4000-8000-000000000001 (__system_workflow__)
--   system-prompt-operator   (sub: c0f8fe5e-3ae1-41ce-a471-948e83f2c1d9)
--     → tenant_id 00000000-0000-4000-8000-000000000002 (__system_prompt__)
--
-- Idempotent: ON CONFLICT against the (user_id, tenant_id, role) unique.

BEGIN;

INSERT INTO user_roles (user_id, tenant_id, tenant_name, role, granted_by)
VALUES
    (
        'c82077b7-08c2-46cd-886d-b0fa6a69f732',
        '00000000-0000-4000-8000-000000000001',
        '__system_workflow__',
        'workspace-admin',
        'system'
    ),
    (
        'c0f8fe5e-3ae1-41ce-a471-948e83f2c1d9',
        '00000000-0000-4000-8000-000000000002',
        '__system_prompt__',
        'workspace-admin',
        'system'
    )
ON CONFLICT (user_id, tenant_id, role) DO NOTHING;

COMMIT;
