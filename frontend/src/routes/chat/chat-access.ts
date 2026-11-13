// src/routes/chat/chat-access.ts
//
// Pure logic for the /chat page (vitest runs in `environment: 'node'`, so the
// page's decisions live here where they can be tested).
//
// Owner ruling 2026-10-01: /chat is a TENANT-ADMIN tool for testing the
// workspace's own provider keys — workspace-admin or super-admin only — and it
// lists ONLY what worker_management returns. For a customer tenant WM now
// returns just the tenant's configured rows whose key tests OK, which can be an
// empty list; that is a state to explain, not an error.
//
// The real gate is the backend (`POST /api/assets/workers/chat/completions`
// answers 403 to a plain member); this is the defense-in-depth client check.

import type { WorkspaceKind } from '$lib/stores/workspaces.svelte';

export type ChatGate = 'pending' | 'allowed' | 'denied' | 'unsupported_workspace';

export interface ChatAuthView {
  isLoading: boolean;
  isSuperAdmin: boolean;
  hasTenantRole(role: 'workspace-admin'): boolean;
}

/**
 * The ACTIVE workspace, as `$lib/stores/workspaces.svelte` reports it.
 *
 * Passed as a plain view (not the store) so this module stays runnable under
 * vitest's `environment: 'node'`. `error` matters: that store deliberately
 * leaves `loaded` false on a FAILED fetch so its call sites keep retrying, and
 * treating that as "still hydrating" would strand /chat on "Loading…" for the
 * life of the session.
 */
export interface ChatWorkspaceView {
  loaded: boolean;
  error?: string;
  kind?: WorkspaceKind;
}

/** Same pair `routes/settings/llm-provider` admits. */
export function chatGate(auth: ChatAuthView, workspace?: ChatWorkspaceView): ChatGate {
  if (auth.isLoading) return 'pending';
  if (!(auth.isSuperAdmin || auth.hasTenantRole('workspace-admin'))) return 'denied';
  // Decide the workspace BEFORE the first providers request: under `system`
  // that request is a guaranteed 403, and the failure it renders reads as a
  // broken provider rather than "this view cannot chat".
  if (workspace && !workspace.loaded && !workspace.error) return 'pending';
  if (workspace?.kind === 'system') return 'unsupported_workspace';
  return 'allowed';
}

export const CHAT_DENIED_MESSAGE =
  'Chat is a workspace-administrator tool for testing your LLM provider keys.';

/**
 * The System view is a cross-tenant UNION scope, not a tenant: it has no
 * provider keys of its own and worker_management can never prove a tenant for
 * it, so a chat request there is refused upstream. Asking the admin to sign in
 * again — what this page used to imply — could not help.
 */
export const CHAT_UNSUPPORTED_WORKSPACE_MESSAGE =
  "Chat spends one workspace's own provider keys, and the System view spans every workspace — there is nothing here to spend. Switch to a workspace to chat.";

export const LLM_PROVIDER_SETTINGS_HREF = '/settings/llm-provider';

export const NO_PROVIDERS_MESSAGE =
  'No LLM provider is ready to chat with in this workspace. Add a provider key in Settings → LLM provider.';

/**
 * The empty state to show, or null. Only once the provider list has loaded
 * without error — a failed load is shown as the error, never as "add a key".
 */
export function providersEmptyState(
  loaded: boolean,
  providerError: string,
  providerCount: number,
): string | null {
  if (!loaded || providerError) return null;
  return providerCount === 0 ? NO_PROVIDERS_MESSAGE : null;
}
