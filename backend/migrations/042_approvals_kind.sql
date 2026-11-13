-- Plan 5 Stage 1.1 — approvals.kind discriminator.
--
-- The continuous-improvement loops (Plan 5 workflow loop, Plan 6 prompt
-- loop) emit two new approval gates: GATE 1 (kind='improvement.design',
-- DOING→QA) and GATE 2 (kind='improvement.release', QA→DONE). Existing
-- approvals get default 'generic'. The render layer dispatches on this
-- column to pick a per-kind notification template.

CREATE TYPE approval_kind AS ENUM (
    'generic',
    'improvement.design',
    'improvement.release'
);

ALTER TABLE approvals
    ADD COLUMN kind approval_kind NOT NULL DEFAULT 'generic';

CREATE INDEX approvals_kind_status_idx
    ON approvals (kind, status)
    WHERE status = 'pending';

COMMENT ON COLUMN approvals.kind IS
    'Plan 5/6 discriminator. ''generic'' = pre-improvement approvals; '
    '''improvement.design'' = GATE 1 (DOING→QA) carrying the proposal '
    'and predicted deltas; ''improvement.release'' = GATE 2 (QA→DONE) '
    'carrying the proposal + replay results + measured canary deltas.';
