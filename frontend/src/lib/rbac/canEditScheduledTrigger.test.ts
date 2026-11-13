// canEditScheduledTrigger.test.ts
//
// Plan 2-C Phase 4 §4.1 — vitest matrix for the pure RBAC helper.
// Mirrors the Spec §13 access-control table so a regression in the helper
// surfaces here before it ships to the UI.

import { describe, it, expect } from 'vitest';
import {
  canEditScheduledTrigger,
  type User,
  type Project,
} from './canEditScheduledTrigger';

const wsAdmin: User = { roles: ['workspace-admin'], depts: {} };
const wsMember: User = { roles: ['workspace-member'], depts: {} };
const dAdmin: User = { roles: ['workspace-member'], depts: { d1: 'dept-admin' } };
const dMgr: User = { roles: ['workspace-member'], depts: { d1: 'dept-manager' } };
const dMember: User = { roles: ['workspace-member'], depts: { d1: 'dept-member' } };
const dViewer: User = { roles: ['workspace-member'], depts: { d1: 'dept-viewer' } };
const otherDept: User = { roles: ['workspace-member'], depts: { d2: 'dept-admin' } };
const anonymous: User = { roles: [], depts: {} };

const proj: Project = { id: 'p1', dept_id: 'd1' };
const workspaceProj: Project = { id: 'p2', dept_id: null };

describe('canEditScheduledTrigger', () => {
  it('workspace-admin always yes', () => {
    expect(canEditScheduledTrigger(wsAdmin, proj)).toBe(true);
  });
  it('workspace-admin yes on workspace-scope project', () => {
    expect(canEditScheduledTrigger(wsAdmin, workspaceProj)).toBe(true);
  });
  it('dept-admin of right dept yes', () => {
    expect(canEditScheduledTrigger(dAdmin, proj)).toBe(true);
  });
  it('dept-manager of right dept yes', () => {
    expect(canEditScheduledTrigger(dMgr, proj)).toBe(true);
  });
  it('dept-member no', () => {
    expect(canEditScheduledTrigger(dMember, proj)).toBe(false);
  });
  it('dept-viewer no', () => {
    expect(canEditScheduledTrigger(dViewer, proj)).toBe(false);
  });
  it('admin of other dept no', () => {
    expect(canEditScheduledTrigger(otherDept, proj)).toBe(false);
  });
  it('workspace-member no on dept project', () => {
    expect(canEditScheduledTrigger(wsMember, proj)).toBe(false);
  });
  it('workspace-member no on workspace-scope project', () => {
    // Workspace-scope projects: only workspace-admin edits.
    expect(canEditScheduledTrigger(wsMember, workspaceProj)).toBe(false);
  });
  it('dept-manager no on workspace-scope project', () => {
    expect(canEditScheduledTrigger(dMgr, workspaceProj)).toBe(false);
  });
  it('anonymous no', () => {
    expect(canEditScheduledTrigger(anonymous, proj)).toBe(false);
  });
});
