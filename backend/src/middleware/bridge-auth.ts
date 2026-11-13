// src/middleware/bridge-auth.ts
//
// Auth gate for the CP→fr bridge intake endpoint (POST /api/project-requests).
// The call is two-token (commonpractice PLAN-PHASE5.D Part 5):
//
//   Authorization: Bearer <commonpractice-bridge SA JWT>   ← caller identity;
//        carries the `project-request-writer` realm role (audit azp).
//   X-Tenant-Id:   <resolved tenant uuid>                  ← the fr edge
//        license-authz introspects the inbound `X-Tenant-Id: Bearer <fr license
//        token>` and REWRITES this header to the resolved tenant before the
//        route sees it (also injecting X-Subject-Id). We trust the post-edge
//        value — mirroring request-context.ts, which never trusts a raw header
//        as a tenant without the verified edge/JWT in front of it.
//
// We deliberately reuse the sanctioned `validateAuth` seam (auth.ts) rather than
// a new deps object: it already honours `AUTH_BYPASS` for dev. The role
// name is env-overridable (`PROJECT_REQUEST_WRITER_ROLE`) so it can be aligned
// with the Keycloak artifact once the `commonpractice-bridge` SA is provisioned.

import { decodeJwt } from 'jose';
import { validateAuth } from './auth';
import { BadRequestError, ForbiddenError, UnauthorizedError } from '../utils/errors';
import { frBridgeIssuers } from '../config';

const DEFAULT_WRITER_ROLE = 'project-request-writer';
/** The ONE Keycloak client the bridge is accepted from (the CP bridge SA). */
const DEFAULT_BRIDGE_AZP = 'commonpractice-bridge';

/**
 * FR_BRIDGE_AZP — the client (`azp`) the bridge SA token must be issued to. Default
 * `commonpractice-bridge`; set to empty it admits NOBODY (fail closed), never everybody.
 */
function frBridgeAzp(): string {
  return (process.env.FR_BRIDGE_AZP ?? DEFAULT_BRIDGE_AZP).trim();
}

/**
 * The `aud` of the bearer token `validateAuth` just VERIFIED (same header bytes; decoding is
 * only a read of an already-verified token). `[]` when there is no bearer or no `aud` claim
 * (`aud` is optional); a bearer that does not decode as a JWT is REFUSED (fail closed).
 */
function bearerAudiences(req: Request): string[] {
  const header = req.headers.get('Authorization') ?? req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return [];
  let aud: unknown;
  try {
    aud = decodeJwt(m[1]!).aud;
  } catch (err) {
    throw new UnauthorizedError(`The bridge bearer is not a JWT: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof aud === 'string') return [aud];
  return Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
}

// Same UUID shape check request-context.ts uses for X-Active-Tenant — keeps a
// malformed (or un-rewritten `Bearer …`) X-Tenant-Id out of the tenant slot.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BridgeContext {
  /** The edge-resolved tenant uuid this request acts on. */
  tenantId: string;
  /** The upstream end-user who triggered the forward (X-Subject-Id), or null. */
  subjectId: string | null;
  /** The bridge service-account's subject id (from the SA JWT). */
  saUserId: string;
}

/**
 * Authenticate + authorize a bridge call. Throws `UnauthorizedError` (401) when
 * the SA token is missing/invalid (via validateAuth), `ForbiddenError` (403)
 * when it lacks the writer role, and `BadRequestError` (400) when the
 * edge-resolved `X-Tenant-Id` is absent or not a uuid (e.g. the edge
 * license-authz isn't wired and the raw `Bearer <token>` reached us).
 */
export async function requireBridgeWriter(req: Request): Promise<BridgeContext> {
  const bypass = process.env.AUTH_BYPASS === 'true';
  // `allowServiceRealms`: this is an S2S door, so a KEYCLOAK_SERVICE_ONLY_REALMS (secure-apps) token
  // may verify here — and is then held to the issuer pin below.
  const user = await validateAuth(req, { allowServiceRealms: true }); // 401 on missing/invalid token
  // Realm-per-app F1/P7: pin the issuer(s) the bridge SA is accepted from (FR_BRIDGE_ISSUER, CSV,
  // default KEYCLOAK_ISSUER), so it can move to secure-apps on its own (both listed while the caller
  // flips) and a same-named client in any other trusted realm can never stand in for it.
  if (!bypass && (user.issuer === undefined || !frBridgeIssuers().includes(user.issuer))) {
    throw new ForbiddenError('The token was not issued by the realm the bridge client is accepted from');
  }
  // ⭐ CLIENT PIN (post-merge audit 2026-10-23). Issuer + role alone admitted ANY account of the
  // bridge realm (secure-apps) that holds the writer role. The door is for ONE client: `azp` must
  // be FR_BRIDGE_AZP, and when the token carries `aud` it must name that client too (the
  // secure-apps audience mapper sets aud = azp). An empty FR_BRIDGE_AZP admits nobody.
  if (!bypass) {
    const expectedAzp = frBridgeAzp();
    if (!expectedAzp || user.azp !== expectedAzp) {
      throw new UnauthorizedError('The token was not issued to the bridge client');
    }
    const audiences = bearerAudiences(req);
    if (audiences.length > 0 && !audiences.includes(expectedAzp)) {
      throw new UnauthorizedError('The token audience does not name the bridge client');
    }
  }
  const role = process.env.PROJECT_REQUEST_WRITER_ROLE || DEFAULT_WRITER_ROLE;
  if (!bypass && !user.roles.includes(role)) {
    throw new ForbiddenError(
      `Role '${role}' required to post a project request via the bridge`,
    );
  }

  const headerTenant =
    req.headers.get('X-Tenant-Id') ?? req.headers.get('x-tenant-id');
  let tenantId: string | null = null;
  if (headerTenant && UUID_RE.test(headerTenant)) {
    tenantId = headerTenant;
  } else if (bypass) {
    // Dev only: no edge in front, fall back to the bypass user's tenant.
    tenantId = user.tenantId;
  }
  if (!tenantId) {
    throw new BadRequestError(
      'missing or invalid X-Tenant-Id (expected the edge-resolved tenant uuid)',
    );
  }

  // X-Subject-Id is the upstream end-user's keycloak subject (a uuid); it lands
  // in `project_requests.created_by` (a uuid column). Only accept a well-formed
  // uuid — a malformed/absent header becomes null rather than 500-ing intake on
  // a telemetry field.
  const rawSubject =
    req.headers.get('X-Subject-Id') ?? req.headers.get('x-subject-id') ?? null;
  const subjectId = rawSubject && UUID_RE.test(rawSubject) ? rawSubject : null;

  return { tenantId, subjectId, saUserId: user.id };
}
