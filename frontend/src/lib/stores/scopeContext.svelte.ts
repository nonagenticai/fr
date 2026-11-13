// scopeContext.svelte.ts
// =======================
// Tiny Svelte 5 runes store holding the current Library scope context
// (workspace / department / project). Drives:
//   - which list endpoint Library views call (Task 14 onward — passes
//     `?project_id=` when scope is project, etc.);
//   - what the ScopeFilter / InheritanceBreadcrumb components render;
//   - which can* flags PromoteOverrideBlockMenu surfaces.
//
// Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 13.
// Spec: docs/archive/2026-04-27-foundation-design.md §6.
//
// NOTE — orthogonal to the tenant axis. This is the WITHIN-tenant Library
// scope (`?project_id=` / `?dept_id=`). The active TENANT is a separate axis,
// lives in `workspaces.svelte.ts` (persisted to `localStorage('fr.active_tenant')`,
// injected as the `X-Active-Tenant` header by `auth-fetch.ts`), and is changed
// via `actions/switchTenant.ts`. Do not conflate the two: switching tenant does
// NOT touch this scope, and changing scope does NOT change the tenant header.

export type ScopeContext =
  | { kind: 'workspace' }
  | { kind: 'department'; dept_id: string }
  | { kind: 'project'; project_id: string };

let _scope = $state<ScopeContext>({ kind: 'workspace' });

export const scopeContext = {
  get current(): ScopeContext {
    return _scope;
  },
  set(next: ScopeContext): void {
    _scope = next;
  },
  isProject(): boolean {
    return _scope.kind === 'project';
  },
  projectId(): string | undefined {
    return _scope.kind === 'project' ? _scope.project_id : undefined;
  },
  deptId(): string | undefined {
    return _scope.kind === 'department' ? _scope.dept_id : undefined;
  },
};
