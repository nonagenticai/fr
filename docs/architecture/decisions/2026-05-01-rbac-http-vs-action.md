# ADR: HTTP routes use requireDeptRole + projectDeptGate; assertRbac is action-only

**Date:** 2026-05-01
**Status:** Accepted

## Context

PR #83 (Spec 2 Plan 2-C, "channels detail + project streams") landed `requireDeptRole` and `projectDeptGate` as shared helpers across `scheduled-triggers` and `scheduled-reports` HTTP routes. A follow-up "TODO: migrate to `assertRbac()`" note was carried into the close-out, suggesting these routes should be unified under the `assertRbac` API in `backend/src/agui/rbac.ts`.

Investigation showed this would be a regression. Foundation Plan 2 §Task 9 deliberately scoped `assertRbac` to AG-UI action invocation (`AgentCallableAction.rbac` field): rules are statically declared on the action object, with `deptId` known at registration time. HTTP routes need to **resolve `deptId` from the request body's `project_id` at request time**, which `assertRbac`'s rule shape cannot statically express. Reference patterns already exist:

- `backend/src/routes/admin/departments.ts:6-17` — explicitly comments on assertRbac being action-oriented.
- `backend/src/routes/asset-scope/promote.ts:12-13` — same.
- `backend/src/routes/scheduled-triggers.ts` — already uses `requireDeptRole` + `projectDeptGate` correctly.
- `backend/src/routes/scheduled-reports.ts` — same.

The PR #83 TODO was based on a misread of the foundation, not on a mechanism gap.

## Decision

**No migration.** HTTP routes remain on `requireDeptRole` + `projectDeptGate`. AG-UI actions remain on `assertRbac`.

## Consequences

- HTTP and AG-UI rule shapes diverge — intentionally. HTTP rules resolve `deptId` at request time from `project_id`; action rules know `deptId` at registration time.
- The "PR #83 deferred: assertRbac migration" item is closed as **declined** rather than **postponed**.
- If a future need arises for HTTP routes to declare RBAC rules in a registry-like shape, propose a new abstraction `assertHttpRbac()` with a request-time-resolved rule type. Do NOT extend `assertRbac` to span both call patterns; keep the AG-UI action contract narrow and the HTTP contract narrow, and let any future symmetric API live as its own helper.

## References

- Foundation Plan 2 §Task 9 — `docs/superpowers/plans/2026-04-27-foundation-roadmap.md` (parallel `org-and-scoping` plan introduced `DeptRoleRule`)
- PR #83 (close-out memo; the TODO this ADR resolves)
- `backend/src/agui/rbac.ts` — `assertRbac` definition, `RbacRule` discriminated union, `dept-role` variant
- `backend/src/auth/requireDeptRole.ts` — HTTP-side primitive
- `backend/src/auth/projectDeptGate.ts` — composes `requireDeptRole` with project-shape lookup for routes that gate on a request-body `project_id`
