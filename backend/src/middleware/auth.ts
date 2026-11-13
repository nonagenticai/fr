// src/middleware/auth.ts
import { keycloak, type ValidateTokenOptions } from '../services/keycloak';
import { assertConveyorRouteAllowed } from '../lib/conveyor-identity';
import {
  introspectLicenceForRequest,
  isLicenceBearer,
  licenceUser,
  resolveDelegatedTenant,
} from '../lib/licence-introspect';
import { assertLicenceRouteAllowed } from '../lib/licence-route-allowlist';
import type { User } from '../types/api';

// AUTH_BYPASS synthetic user. AUTH_BYPASS_USER_ID and AUTH_BYPASS_TENANT_ID
// let dev / seeders / Playwright scope the bypass user to a non-default
// tenant (e.g. the AA trilogy demo tenant) without touching real Keycloak.
// Defaults preserve the historical 00000000-… contract that ci-seed.ts +
// System Bootstrap workspace are wired to.
export function bypassUser(): User {
  const bypassTenant =
    process.env.AUTH_BYPASS_TENANT_ID ?? '00000000-0000-0000-0000-000000000000';
  return {
    id:
      process.env.AUTH_BYPASS_USER_ID ??
      '00000000-0000-0000-0000-000000000000',
    email: 'dev@localhost',
    name: 'Dev User',
    // `super_admin` and `workspace-admin` are HERE ON PURPOSE.
    //
    // Without them the bypass identity cannot reach the Administration zone or
    // any workspace-admin surface — roughly a third of the product — so the one
    // mechanism fr provides for driving its own UI was blind to the third of it
    // carrying the most destructive actions. Both Playwright lanes run under
    // this identity (frontend/playwright.config.ts).
    //
    // Safe to widen ONLY because `validateProductionConfig` (config.ts) now
    // refuses to boot when AUTH_BYPASS=true on a production-shaped deploy.
    // Until that guard existed nothing stopped this env var reaching prod,
    // where it already disabled the fr + kag licence gates and board tenant
    // isolation. Widening without the guard would have deepened a hole; with
    // it, the blast radius is dev and CI only.
    //
    // ⛔ Do NOT add roles here without confirming that guard is still in place.
    roles: ['admin', 'power-user', 'super_admin', 'workspace-admin'],
    tenantId: bypassTenant,
    // fr#1289: the admin arm of `isWorkspaceAdminVia` is now PINNED to the raw
    // `tenant_id` claim (legacy `admin` = pinned alias of `tenant_admin`), so
    // the bypass identity carries the claim for its own tenant — otherwise
    // both Playwright lanes lose every workspace-admin surface.
    tenantClaim: bypassTenant,
    // The bypass identity stands in for a signed-in user; these two fields
    // are what the priority audit records for it (lib/priority-change.ts).
    isServiceAccount: false,
    username: 'dev',
  };
}

export async function validateAuth(
  req: Request,
  opts: ValidateTokenOptions = {},
): Promise<User> {
  if (process.env.AUTH_BYPASS === 'true') {
    return bypassUser();
  }

  const authHeader = req.headers.get('Authorization');
  const token = keycloak.extractToken(authHeader);
  const user = await verifyBearer(req, token, opts);
  // The conveyor priority identity may write ONLY priority (two routes);
  // every other write route is refused 403 here, before any handler logic.
  assertConveyorRouteAllowed(req, user);
  return user;
}

/**
 * The ONE token-shape fork (George 2026-10-10, licences reference
 * `auth/middleware.py`): a NON-JWT-shaped bearer, with the licence path
 * configured, is a licence token and is verified by the licences service
 * (`lib/licence-introspect.ts` — tenant pinned, no realm roles, fail closed).
 * Every JWT-shaped bearer goes to the Keycloak verifier and a failure there is
 * a hard 401 — it is NEVER retried as a licence token. With the licence path
 * unconfigured a non-JWT bearer reaches the Keycloak verifier and 401s, exactly
 * as before.
 */
async function verifyBearer(
  req: Request,
  token: string,
  opts: ValidateTokenOptions = {},
): Promise<User> {
  if (isLicenceBearer(token)) {
    const identity = await introspectLicenceForRequest(req, token);
    // A licence normally acts ONLY in its own tenant. An allowlisted conveyor
    // subject may name a different one — the tenant that owns the card it is
    // driving (lib/licence-introspect.ts `resolveDelegatedTenant`). Unset,
    // unknown or malformed ⇒ undefined ⇒ byte-identical behaviour to before.
    const user = licenceUser(identity, resolveDelegatedTenant(req, identity));
    // ⛔ DENY BY DEFAULT: a licence (the tenant's conveyor seat) reaches ONLY the
    // n8n-nodes-fr route allowlist — 403 `licence_route_not_allowed` otherwise,
    // before any handler logic (lib/licence-route-allowlist.ts).
    assertLicenceRouteAllowed(req);
    return user;
  }
  return keycloak.validateToken(token, opts);
}

// `requireRole` was DELETED here (2026-08-29). It tested only the raw Keycloak
// claim `user.roles.includes(role)` — never `workspace-admin`, never the
// `user_roles` table — so as an authorization gate it matched no real grant.
// Its six callers in routes/assets/kag.ts now use a workspace-admin check built
// on services/user-roles.ts. For an authorization decision use
// `isWorkspaceAdminOf` / `isWorkspaceAdminVia`, or lib/super-admin-gate.ts;
// scripts/check-admin-claim-only.ts fails CI if a claim-only check reappears.

export async function validateAuthWithToken(req: Request): Promise<{ user: User; accessToken: string }> {
  const authHeader = req.headers.get('Authorization');
  if (process.env.AUTH_BYPASS === 'true') {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : 'bypass';
    return {
      user: bypassUser(),
      accessToken: token,
    };
  }
  const token = keycloak.extractToken(authHeader);
  const user = await verifyBearer(req, token);
  assertConveyorRouteAllowed(req, user);
  return { user, accessToken: token };
}
