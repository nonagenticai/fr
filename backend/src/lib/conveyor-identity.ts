// src/lib/conveyor-identity.ts
//
// The dedicated CONVEYOR priority identity and the only routes it may write.
// Design: ~/.claude/plans/program/20-designs/keycloak-conveyor-priority-identity.md
// ("fr access path for the conveyor"). Dependency-free on purpose:
// middleware/auth.ts imports it, and every route imports auth.

import { ForbiddenError } from '../utils/errors';
import type { User } from '../types/api';
import { frConveyorIssuers } from '../config';

// ── The dedicated conveyor priority identity (Keycloak, LIVE) ──────────────
// Design 20-designs/keycloak-conveyor-priority-identity.md. Measured token:
// azp='conveyor-priority', preferred_username='service-account-conveyor-priority',
// realm_access.roles == ['conveyor-priority-writer'], sub present, NO tenant_id.
// ⛔ ALL THREE are required. Never `client_id` (not guaranteed on the token).
export const CONVEYOR_AZP = 'conveyor-priority';
export const CONVEYOR_USERNAME = 'service-account-conveyor-priority';
export const CONVEYOR_ROLE = 'conveyor-priority-writer';

/**
 * True ONLY for the dedicated conveyor priority identity: verified `azp`
 * === CONVEYOR_AZP AND `preferred_username` === CONVEYOR_USERNAME AND the realm
 * roles include CONVEYOR_ROLE. All three come from the SIGNED token
 * (keycloak.validateToken); a `User` built anywhere else lacks `azp` and is
 * never the conveyor.
 */
export function isConveyorActor(
  user: Pick<User, 'azp' | 'username' | 'roles'> & Pick<Partial<User>, 'issuer'>,
): boolean {
  return (
    // Realm-per-app F1/P7: when the verified issuer is known it must be in FR_CONVEYOR_ISSUER (CSV, default
    // KEYCLOAK_ISSUER). `keycloak.verifyKeycloakJwt` already refuses a conveyor-shaped token from any
    // other issuer; this is the same pin, held where the predicate is read.
    (user.issuer === undefined || frConveyorIssuers().includes(user.issuer)) &&
    user.azp === CONVEYOR_AZP &&
    user.username === CONVEYOR_USERNAME &&
    Array.isArray(user.roles) &&
    user.roles.includes(CONVEYOR_ROLE)
  );
}

/**
 * The conveyor's rule ids — a CLOSED SET (design: A1/A2 aging, B1/B2 blocker
 * escalate/revert). A new rule is a deliberate edit here, never a pattern match.
 */
export const CONVEYOR_RULES = ['A1', 'A2', 'B1', 'B2'] as const;
export type ConveyorRule = (typeof CONVEYOR_RULES)[number];

// ── The conveyor's route allowlist (enforced in middleware/auth.ts) ────────

export const CONVEYOR_ROUTE_FORBIDDEN = 'conveyor_route_forbidden';

/**
 * The ONLY write routes the conveyor identity may call. Everything else that
 * is not a read (GET/HEAD) is refused 403 `conveyor_route_forbidden` inside
 * validateAuth, before any handler logic runs.
 */
const CONVEYOR_WRITE_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  // PATCH /api/projects/:projectId/cards/:cardId/priority
  { method: 'PATCH', pattern: /^\/api\/projects\/[^/]+\/cards\/[^/]+\/priority$/ },
  // (PATCH /api/projects/:id is NOT here any more — George 2026-10-13, D15/R16:
  // a project's priority is RM's and only the PM writes it, in RM.)
];

export function isConveyorAllowedRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  return CONVEYOR_WRITE_ROUTES.some((r) => r.method === m && r.pattern.test(pathname));
}

/** 403 `conveyor_route_forbidden` for the conveyor identity on any other write route. */
export function assertConveyorRouteAllowed(req: Request, user: Pick<User, 'azp' | 'username' | 'roles'>): void {
  if (!isConveyorActor(user)) return;
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    pathname = '';
  }
  if (!isConveyorAllowedRequest(req.method, pathname)) {
    throw new ForbiddenError('the conveyor priority identity may only write priority').withCode(
      CONVEYOR_ROUTE_FORBIDDEN,
    );
  }
}
