// scopeContext.test.ts
//
// Plain runes-store tests — no DOM needed. The store reads/writes a single
// `$state` cell so we can drive it directly from a vitest node environment.
//
// We `beforeEach` reset by calling `set({ kind: 'workspace' })` so test
// order doesn't matter. (Module state is shared across tests; re-importing
// won't give us a fresh instance.)

import { describe, it, expect, beforeEach } from 'vitest';
import { scopeContext, type ScopeContext } from './scopeContext.svelte';

beforeEach(() => {
  scopeContext.set({ kind: 'workspace' });
});

describe('scopeContext', () => {
  it('defaults to workspace scope', () => {
    expect(scopeContext.current).toEqual<ScopeContext>({ kind: 'workspace' });
    expect(scopeContext.isProject()).toBe(false);
    expect(scopeContext.projectId()).toBeUndefined();
    expect(scopeContext.deptId()).toBeUndefined();
  });

  it('set() updates current to a department scope', () => {
    scopeContext.set({ kind: 'department', dept_id: 'dept-eng' });

    expect(scopeContext.current).toEqual<ScopeContext>({
      kind: 'department',
      dept_id: 'dept-eng',
    });
    expect(scopeContext.isProject()).toBe(false);
    expect(scopeContext.deptId()).toBe('dept-eng');
    expect(scopeContext.projectId()).toBeUndefined();
  });

  it('set() updates current to a project scope', () => {
    scopeContext.set({ kind: 'project', project_id: 'proj-auth' });

    expect(scopeContext.current).toEqual<ScopeContext>({
      kind: 'project',
      project_id: 'proj-auth',
    });
    expect(scopeContext.isProject()).toBe(true);
    expect(scopeContext.projectId()).toBe('proj-auth');
    expect(scopeContext.deptId()).toBeUndefined();
  });

  it('returns to workspace when re-set after a project scope', () => {
    scopeContext.set({ kind: 'project', project_id: 'proj-x' });
    expect(scopeContext.isProject()).toBe(true);

    scopeContext.set({ kind: 'workspace' });
    expect(scopeContext.current).toEqual<ScopeContext>({ kind: 'workspace' });
    expect(scopeContext.isProject()).toBe(false);
    expect(scopeContext.projectId()).toBeUndefined();
  });
});
