// /channels gate — timing + claim arms. Regression for the 2026-09-30 prod
// defect: a tenant admin was redirected because the guard ran after
// auth.isLoading=false but BEFORE /api/me/workspaces delivered the role.
import { describe, it, expect } from 'vitest';
import { channelsGate, type ChannelsGateInput } from './access';

const base: ChannelsGateInput = {
  authLoading: false,
  workspaceAdmin: false,
  deptAdmin: false,
  realmRoles: [],
  tenantClaim: 't1',
  activeTenantId: 't1',
  workspacesLoaded: false,
  workspacesError: undefined,
};

describe('channelsGate', () => {
  it('is pending while auth is loading', () => {
    expect(channelsGate({ ...base, authLoading: true })).toBe('pending');
  });

  it('does NOT deny after isLoading=false while the workspace role is still in flight', () => {
    expect(channelsGate(base)).toBe('pending');
  });

  it('admits once the workspace-admin role arrives late', () => {
    const before = channelsGate(base);
    const after = channelsGate({ ...base, workspacesLoaded: true, workspaceAdmin: true });
    expect(before).toBe('pending');
    expect(after).toBe('allow');
  });

  it('denies only once roles have settled and are insufficient', () => {
    expect(channelsGate({ ...base, workspacesLoaded: true })).toBe('deny');
    expect(channelsGate({ ...base, workspacesError: 'workspaces fetch 503' })).toBe('deny');
  });

  it('admits dept-admins', () => {
    expect(channelsGate({ ...base, deptAdmin: true })).toBe('allow');
  });

  it('admits realm tenant_admin / admin pinned to the active tenant', () => {
    expect(channelsGate({ ...base, realmRoles: ['tenant_admin'] })).toBe('allow');
    expect(channelsGate({ ...base, realmRoles: ['admin'] })).toBe('allow');
  });

  it('does NOT admit realm tenant_admin for a foreign active tenant (backend pins it)', () => {
    const foreign = { ...base, realmRoles: ['tenant_admin'], activeTenantId: 't2', workspacesLoaded: true };
    expect(channelsGate(foreign)).toBe('deny');
    expect(channelsGate({ ...base, realmRoles: ['tenant_admin'], tenantClaim: '' , workspacesLoaded: true })).toBe('deny');
  });
});
