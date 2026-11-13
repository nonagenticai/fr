// src/lib/api/active-tenant-refusal.ts
//
// fr row 14d — the shared constants for a REFUSED super-admin X-Active-Tenant
// switch. A separate module (not auth-fetch.ts) so the workspaces store and
// tests that mock `$lib/api/auth-fetch` can still import them.

import { BRAND } from '$lib/layout/pageTitle';

/**
 * The backend's machine-readable code on the 403. Mirrors
 * `ACTIVE_TENANT_NOT_PERMITTED_CODE` in backend/src/middleware/request-context.ts;
 * the two literals must match.
 */
export const ACTIVE_TENANT_NOT_PERMITTED_CODE = 'active_tenant_not_permitted';

/**
 * Window event fired when a stored workspace was refused and cleared. The
 * workspaces store listens for it (auth-fetch cannot import the store — the
 * store imports auth-fetch) and falls back to the caller's home workspace.
 */
export const ACTIVE_TENANT_REFUSED_EVENT = 'fr:active-tenant-refused';

/** The user-facing reason. Names no tenant: the refused id may be anyone's. */
export const ACTIVE_TENANT_REFUSED_MESSAGE =
  'Your saved workspace is not available to this account, so you are back in your home workspace.';

/**
 * George 2026-10-27: the 403 carries a `reason`. Mirrors `SwitchRefusalReason`
 * in backend/src/lib/super-admin-switch-target.ts; the literals must match.
 */
export type ActiveTenantRefusalReason = 'archived' | 'unknown' | 'service_account' | 'untrusted_session';

const REFUSED_MESSAGE_BY_REASON: Record<ActiveTenantRefusalReason, string> = {
  archived: 'Your saved workspace has been archived, so you are back in your home workspace.',
  unknown: 'Your saved workspace no longer exists, so you are back in your home workspace.',
  service_account:
    'Only a signed-in person can switch into that workspace, so you are back in your home workspace.',
  // The product name the UI shows everywhere else (BrandMark / tab titles: `BRAND`), never an
  // internal service, realm or client name.
  untrusted_session: `Sign in again with your ${BRAND} account to open that workspace. For now you are back in your home workspace.`,
};

/** The user-facing reason for a refusal. Names no tenant. Unknown / absent reason ⇒ the generic copy. */
export function activeTenantRefusedMessage(reason: unknown): string {
  return typeof reason === 'string' && reason in REFUSED_MESSAGE_BY_REASON
    ? REFUSED_MESSAGE_BY_REASON[reason as ActiveTenantRefusalReason]
    : ACTIVE_TENANT_REFUSED_MESSAGE;
}

/**
 * 503 `active_tenant_unverifiable`: fr could not check the workspace right now
 * (a database blip). Mirrors `ACTIVE_TENANT_UNVERIFIABLE_CODE` in
 * backend/src/middleware/request-context.ts. TRANSIENT: the stored workspace is
 * kept (never cleared) and the user is told to retry.
 */
export const ACTIVE_TENANT_UNVERIFIABLE_CODE = 'active_tenant_unverifiable';

/** The user-facing retry message for the 503. */
export const ACTIVE_TENANT_UNVERIFIABLE_MESSAGE =
  'We could not open that workspace just now. Please try again in a moment.';
