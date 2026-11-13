-- backend/migrations/126_repo_access_platform_repo_forbidden.sql
--
-- WIDEN project_request_repositories.access_state BY ONE VALUE:
-- `platform_repo_forbidden`.
--
-- WHY. coding-github gates repos under a PLATFORM owner (`nonagenticai`) to the
-- tenants listed in `CODING_GITHUB_PLATFORM_TENANTS`
-- (`src/services/tenant_binding.py check_platform_repo_tenant`). The refusal
-- arrives on the clone-token route as HTTP 200
-- `{token: null, source: 'none', reason: 'platform_repo_forbidden'}` — not a
-- 403 — so fr's verdict switch fell through its `default:` and reported
-- `private_ungranted`: "repository not found, or the nonagenticai GitHub App is
-- not installed". Every clause of that is false. The repo exists, the App is
-- installed, and no grant the user can make would change the answer.
--
-- `error` is equally wrong in the other direction: nothing failed, and its
-- wording tells the user to re-check, which can never succeed.
--
-- `services/repo-access.ts` states that the RepoAccessState vocabulary matches
-- this CHECK. This migration is what keeps that sentence true; the column is
-- otherwise untouched (still NOT NULL DEFAULT 'unknown', still written by
-- nobody today — measured 0 rows on the prod primary 2026-09-22).
--
-- Idempotent: drops the old constraint by name and recreates it. Nothing is
-- rewritten, no value is migrated — the new member is additive, so every
-- existing row already satisfies the widened constraint.

ALTER TABLE project_request_repositories
  DROP CONSTRAINT IF EXISTS project_request_repositories_access_state_check;

ALTER TABLE project_request_repositories
  ADD CONSTRAINT project_request_repositories_access_state_check
  CHECK (access_state IN (
    'unknown',
    'public',
    'private_granted',
    'private_ungranted',
    'platform_repo_forbidden',
    'error'
  ));

COMMENT ON COLUMN project_request_repositories.access_state IS
  'Verdict from actually attempting to read the repo. `unknown` means NOT YET '
  'CHECKED, which is not the same as not readable. `private_ungranted` means we '
  'have no credential -- a grant would fix it. `platform_repo_forbidden` means '
  'the repo is platform-owned and the asking workspace is not a platform tenant '
  '-- no grant fixes that, only a different workspace. `error` means the check '
  'itself failed and may succeed on a re-check. ⚠️ Migration 123''s comment '
  'called this column advisory; that was superseded 2026-09-22 -- submit and '
  'approve now REFUSE (422 repo_access_denied) unless every repo is public or '
  'private_granted, re-assessed live rather than read from here.';
