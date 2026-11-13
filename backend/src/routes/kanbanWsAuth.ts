// src/routes/kanbanWsAuth.ts
//
// ⛔ fr row 14d-0b — authenticate the `/api/kanban/ws` upgrade AND resolve the
// connection's ACTIVE tenant, the same way HTTP does.
//
// Before 14d-0b the upgrade validated the token and kept only `user.id`; the
// socket carried no tenant at all and was auto-subscribed to `kanban:all`, so
// every tenant's live card events reached every connected client.
//
// Tenant resolution, matching `middleware/request-context.ts`:
//   * home tenant = the verified token's tenant (`User.tenantId`, from
//     `deriveTenantId` in `keycloak.validateToken`), or the AUTH_BYPASS user's.
//   * a browser WebSocket cannot send `X-Active-Tenant`, so the switch hint
//     travels as the `activeTenant` query parameter and is accepted under the
//     SAME decision (`acceptsActiveTenantSwitch`): well-formed UUID + SIGNED
//     `super_admin` realm role + target ∈ {platform tenants (isPlatformTenant,
//     incl. the AA conveyor tenant since fr row 14d), own home, and — George
//     2026-10-27 — any existing non-archived workspace for an fr super-admin
//     session — `User.superAdminSessionTrust`, stamped by keycloak.validateToken
//     with the SAME classifier the REST gate uses}.
//     Anything else (or a workspace lookup failure) falls back to the home
//     tenant. (HTTP differs since fr row 14d: a refused super_admin switch there
//     is a 403; the upgrade keeps its fallback-or-refuse handling below.)
//   * George 2026-10-27 — an upgrade a super_admin switches into a tenant other
//     than their own emits the same `[super-admin-switch]` audit line as HTTP
//     (via `ws-upgrade`). Nothing inbound on these sockets writes: the only
//     client frames are `ping` / `subscribe` / `unsubscribe` (and the kanban
//     `heartbeat_ack`), so there is no WS write to persist; every write the
//     page makes goes over HTTP and is audited there.
//   * no resolvable tenant ⇒ the upgrade is REFUSED (403). Fail-closed.
//
// The resolved tenant rides on `ws.data.tenantId`; `WebSocketManager` admits
// kanban topics only when it is a PLATFORM tenant.

import { acceptsActiveTenantSwitch } from '../middleware/request-context';

import { recordSuperAdminSwitchRequest } from '../lib/super-admin-tenant-audit';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { reportKanbanWsRefusal } from '../lib/kanban-ws-refusal-metrics';
import { wsAuthRejectionResponse } from '../utils/wsAuth';

/** The slice of `User` this gate reads. */
export interface KanbanWsUser {
  id: string;
  roles?: readonly string[];
  tenantId?: string | null;
  /**
   * `User.superAdminSessionTrust` — the ONE classifier's answer on the signed claims
   * (`keycloak.validateToken`); absent ⇒ untrusted.
   */
  superAdminSessionTrust?: 'fr' | 'service_account' | 'untrusted_session';
}

export interface KanbanWsAuthDeps {
  /** `kcService.validateToken` in production. Throws on a bad token. */
  validateToken: (token: string) => Promise<KanbanWsUser>;
  /** `process.env.AUTH_BYPASS === 'true'`. */
  authBypass: boolean;
  /** `bypassUser` from middleware/auth.ts — used only when `authBypass`. */
  bypassUser: () => KanbanWsUser;
  /**
   * The upgrade path, for `wsAuthRejectionResponse` logging. Defaults to
   * `/api/kanban/ws`. `/api/approvals/ws` reuses this helper so both sockets
   * derive their tenant identically (fr row 14d-0b).
   */
  route?: string;
  /**
   * Counts an upgrade refused for an unresolvable tenant. Defaults to the
   * kanban counter; the approvals upgrade passes its own.
   */
  onTenantUnresolved?: (userId: string) => void;
}

export type KanbanWsAuthResult =
  | { ok: true; userId: string; tenantId: string; via: 'jwt' | 'active-tenant-param' }
  | { ok: false; response: Response };

/** Name of the upgrade query parameter carrying the active-tenant switch. */
export const KANBAN_WS_ACTIVE_TENANT_PARAM = 'activeTenant';

/**
 * Pure tenant resolution for an authenticated kanban socket. Returns null when
 * no tenant can be resolved.
 */
export async function resolveKanbanWsTenant(
  user: KanbanWsUser,
  requested: string | null | undefined,
): Promise<{ tenantId: string; via: 'jwt' | 'active-tenant-param' } | null> {
  const home =
    typeof user.tenantId === 'string' && user.tenantId.length > 0 ? user.tenantId : undefined;
  let accepted = false;
  try {
    accepted = await acceptsActiveTenantSwitch(requested, {
      roles: user.roles ?? [],
      homeTenantId: home,
      session: user.superAdminSessionTrust ?? 'untrusted_session',
    });
  } catch (err) {
    // Workspace lookup failed: never switch on an unverified target.
    console.warn('[kanban-ws] active-tenant switch target lookup failed; using home tenant', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (accepted && typeof requested === 'string') {
    return { tenantId: requested, via: 'active-tenant-param' };
  }
  if (home === undefined) return null;
  return { tenantId: home, via: 'jwt' };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function authorizeKanbanWsUpgrade(
  req: Request,
  token: string | null,
  deps: KanbanWsAuthDeps,
): Promise<KanbanWsAuthResult> {
  if (!token) {
    return { ok: false, response: json(401, { error: 'Token required' }) };
  }
  let user: KanbanWsUser;
  if (deps.authBypass) {
    // Mirrors middleware/auth.ts: bypass yields the dev user (dev/CI only —
    // config.ts refuses AUTH_BYPASS on a production-shaped deploy).
    user = deps.bypassUser();
  } else {
    try {
      user = await deps.validateToken(token);
    } catch (err) {
      return {
        ok: false,
        response: wsAuthRejectionResponse(err, deps.route ?? '/api/kanban/ws'),
      };
    }
  }
  const requested = new URL(req.url).searchParams.get(KANBAN_WS_ACTIVE_TENANT_PARAM);
  const resolved = await resolveKanbanWsTenant(user, requested);
  if (!resolved) {
    if (deps.onTenantUnresolved) {
      deps.onTenantUnresolved(user.id);
    } else {
      reportKanbanWsRefusal({ surface: 'upgrade', reason: 'tenant_unresolved', userId: user.id });
    }
    return { ok: false, response: json(403, { error: 'Tenant could not be resolved' }) };
  }
  if (resolved.via === 'active-tenant-param' && resolved.tenantId !== user.tenantId && isSuperAdmin({ roles: user.roles ?? [] })) {
    recordSuperAdminSwitchRequest({
      actor: user.id,
      tenantId: resolved.tenantId,
      homeTenantId: user.tenantId ?? undefined,
      via: 'ws-upgrade',
      method: req.method,
      url: req.url,
    });
  }
  return { ok: true, userId: user.id, tenantId: resolved.tenantId, via: resolved.via };
}
