// Owner ruling 2026-10-01: /chat is a tenant-admin tool (workspace-admin or
// super-admin) and lists only what worker_management returns — which can be an
// empty list, explained with a pointer to Settings → LLM provider.
import { describe, expect, it } from 'vitest';
import {
  chatGate,
  providersEmptyState,
  NO_PROVIDERS_MESSAGE,
  CHAT_UNSUPPORTED_WORKSPACE_MESSAGE,
  type ChatWorkspaceView
} from './chat-access';

const view = (o: { isLoading?: boolean; isSuperAdmin?: boolean; admin?: boolean }) => ({
  isLoading: o.isLoading ?? false,
  isSuperAdmin: o.isSuperAdmin ?? false,
  hasTenantRole: (r: 'workspace-admin') => r === 'workspace-admin' && (o.admin ?? false),
});

describe('chatGate', () => {
  it('waits for auth hydration', () => {
    expect(chatGate(view({ isLoading: true, admin: true }))).toBe('pending');
  });
  it('denies a plain member', () => {
    expect(chatGate(view({}))).toBe('denied');
  });
  it('admits a workspace-admin', () => {
    expect(chatGate(view({ admin: true }))).toBe('allowed');
  });
  it('admits a super-admin', () => {
    expect(chatGate(view({ isSuperAdmin: true }))).toBe('allowed');
  });
  it('leaves the one-argument callers (the nav entry) unchanged', () => {
    // navConfig.test.ts pins the /chat nav entry to chatGate over a role
    // matrix, calling it with ONE argument. A workspace-less call must keep
    // answering on role alone.
    expect(chatGate(view({ isSuperAdmin: true }))).toBe('allowed');
    expect(chatGate(view({ admin: true }))).toBe('allowed');
  });
});

describe('chatGate in a workspace that cannot serve chat', () => {
  const ws = (o: Partial<ChatWorkspaceView> & { loaded: boolean }): ChatWorkspaceView => o;

  it('refuses the System union scope, which has no provider keys of its own', () => {
    expect(chatGate(view({ isSuperAdmin: true }), ws({ loaded: true, kind: 'system' }))).toBe(
      'unsupported_workspace'
    );
  });
  it('admits a tenant workspace', () => {
    expect(chatGate(view({ isSuperAdmin: true }), ws({ loaded: true, kind: 'customer' }))).toBe(
      'allowed'
    );
    expect(chatGate(view({ admin: true }), ws({ loaded: true, kind: 'execution' }))).toBe('allowed');
  });
  it('waits for the workspace list before deciding', () => {
    expect(chatGate(view({ isSuperAdmin: true }), ws({ loaded: false }))).toBe('pending');
  });
  it('never strands /chat on Loading when the workspace fetch FAILED', () => {
    // The store leaves `loaded` false on failure so its call sites retry; that
    // must not become a permanent pending gate here.
    expect(
      chatGate(view({ isSuperAdmin: true }), ws({ loaded: false, error: 'workspaces fetch 503' }))
    ).toBe('allowed');
  });
  it('says why chat cannot run in System, without blaming the session', () => {
    expect(CHAT_UNSUPPORTED_WORKSPACE_MESSAGE).toContain('Switch to a workspace');
    expect(CHAT_UNSUPPORTED_WORKSPACE_MESSAGE).not.toContain('Sign out');
  });
});

describe('providersEmptyState', () => {
  it('points at Settings → LLM provider when WM returned no providers', () => {
    const msg = providersEmptyState(true, '', 0);
    expect(msg).toBe(NO_PROVIDERS_MESSAGE);
    expect(msg).toContain('Settings → LLM provider');
  });
  it('says nothing before the list has loaded', () => {
    expect(providersEmptyState(false, '', 0)).toBeNull();
  });
  it('says nothing when the load failed (the error is shown instead)', () => {
    expect(providersEmptyState(true, '502 Bad Gateway', 0)).toBeNull();
  });
  it('says nothing when at least one provider is offered', () => {
    expect(providersEmptyState(true, '', 1)).toBeNull();
  });
});
