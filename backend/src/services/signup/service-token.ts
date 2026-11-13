// src/services/signup/service-token.ts — the two service-account doors of early-access v2.
//
//   intake   POST /api/signup-approvals/intake                 the early-access-intake handler's SA
//                                                               (client `fr-signup-intake`, role `fr-signup-intake`)
//   decider  POST /api/signup-approvals/:id/telegram-decision  chat-bridge's SA (client
//                                                               `chat-bridge-signup-decider`, role `fr-signup-decide`)
//
// Same four conditions as commonpractice middleware/signup-{intake,decider}-auth.ts:
//   1. `azp` is one of the configured clients — a realm role can be mapped onto the wrong client by
//      mistake; these doors write rows / create workspaces, so the client is pinned too;
//   1b. `aud` contains that same `azp` (gitops gives each client an `<id>-audience` mapper);
//   2. the configured realm role;
//   3. a token carrying `super_admin` is REFUSED — an operator acts on /admin/onboarding, never
//      through a service door, and a service account "upgraded" to super_admin stops working here.
//
// ⛔ VERIFIED HERE, NOT THROUGH `validateAuth`. Lesson from CP: "require `exp` on every service token
// you verify" — a signed token without `exp` never expires. fr's general verifier
// (services/keycloak.ts) does not require it and does not expose `aud`, so these doors verify the
// signature themselves against the realm JWKS with `requiredClaims: ['exp', 'iss', 'sub']`, the
// pinned issuer(s) (FR_SIGNUP_INTAKE_ISSUER / FR_SIGNUP_DECIDER_ISSUER, CSV, realm-per-app F1/P7) and
// RS256-family algorithms only. No licence gate: a service account has no tenant.
//
// Errors: missing / malformed / unverifiable / expired token → 401 `unauthorized`; a verified token
// that fails any condition → 403 `signup_intake_forbidden` / `signup_decider_forbidden`.
import { decodeJwt, jwtVerify, type JWTPayload } from 'jose';

import { jwksForIssuer } from '../keycloak';
import { keycloakTrustedIssuers } from '../../config';
import { AppError } from '../../utils/errors';
import {
  signupDeciderConfig,
  signupDeciderIssuers,
  signupIntakeConfig,
  signupIntakeIssuers,
} from './config';

/** 401 (no / bad token) or 403 (a verified token this door does not admit), with a stable `code`. */
export class SignupAuthError extends AppError {
  declare code: string;
  constructor(status: 401 | 403, code: string, message: string) {
    super(status, message);
    this.name = 'SignupAuthError';
    this.code = code;
  }
}

interface SignupServiceCaller {
  /** The service account's subject — audit metadata only. */
  subject: string;
  azp: string;
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m) throw new SignupAuthError(401, 'unauthorized', 'A bearer token is required.');
  return m[1]!;
}

async function verify(req: Request, doorIssuers: () => string[]): Promise<JWTPayload & Record<string, unknown>> {
  const token = bearer(req);
  // Realm-per-app F1/P7: each door accepts its client from a SHORT LIST of issuers (default
  // [KEYCLOAK_ISSUER], as before; two only while a client moves realm), each verified against that
  // realm's own keys with `iss` pinned to it. Every pin must be a trusted issuer — production boot
  // refuses otherwise (config.ts keycloakRealmConfigProblems); refused here too, so a non-prod
  // misconfiguration fails closed instead of fetching an untrusted realm's keys.
  const pins = doorIssuers().filter((p) => p.length > 0);
  if (pins.length === 0) throw new SignupAuthError(401, 'unauthorized', 'Token issuer is not configured.');
  // The UNVERIFIED `iss` only SELECTS which pinned realm's keys to use; jwtVerify then pins it.
  let claimed: unknown;
  try {
    claimed = decodeJwt(token).iss;
  } catch {
    throw new SignupAuthError(401, 'unauthorized', 'Invalid or expired token.');
  }
  const issuer = typeof claimed === 'string' && pins.includes(claimed) ? claimed : pins.length === 1 ? pins[0]! : '';
  if (!issuer) throw new SignupAuthError(401, 'unauthorized', 'Invalid or expired token.');
  const trusted = keycloakTrustedIssuers();
  if (trusted.length > 0 && !trusted.includes(issuer)) {
    throw new SignupAuthError(401, 'unauthorized', 'Token issuer is not trusted.');
  }
  try {
    const { payload } = await jwtVerify(token, jwksForIssuer(issuer), {
      issuer,
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'],
      requiredClaims: ['exp', 'iss', 'sub'],
    });
    return payload as JWTPayload & Record<string, unknown>;
  } catch {
    throw new SignupAuthError(401, 'unauthorized', 'Invalid or expired token.');
  }
}

function realmRoles(claims: Record<string, unknown>): string[] {
  const ra = claims.realm_access;
  if (!ra || typeof ra !== 'object') return [];
  const roles = (ra as { roles?: unknown }).roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

function audiences(claims: Record<string, unknown>): string[] {
  const aud = claims.aud;
  if (typeof aud === 'string') return [aud];
  return Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
}

async function requireCaller(
  req: Request,
  cfg: { allowedAzp: string[]; role: string },
  doorIssuers: () => string[],
  code: string,
  what: string,
): Promise<SignupServiceCaller> {
  const claims = await verify(req, doorIssuers);
  const roles = realmRoles(claims);
  if (roles.includes('super_admin')) {
    throw new SignupAuthError(403, code, `The ${what} accepts only its dedicated service-account token, never an operator session.`);
  }
  const azp = typeof claims.azp === 'string' ? claims.azp : '';
  if (!azp || !cfg.allowedAzp.includes(azp)) {
    throw new SignupAuthError(403, code, `This client is not allowed to use the ${what}.`);
  }
  if (!audiences(claims).includes(azp)) {
    throw new SignupAuthError(403, code, `The token is not addressed to the ${what}.`);
  }
  if (!cfg.role || !roles.includes(cfg.role)) {
    throw new SignupAuthError(403, code, `Role '${cfg.role}' is required for the ${what}.`);
  }
  return { subject: String(claims.sub), azp };
}

export function requireSignupIntakeCaller(req: Request): Promise<SignupServiceCaller> {
  return requireCaller(req, signupIntakeConfig(), signupIntakeIssuers, 'signup_intake_forbidden', 'signup intake');
}

export function requireSignupDeciderCaller(req: Request): Promise<SignupServiceCaller> {
  return requireCaller(req, signupDeciderConfig(), signupDeciderIssuers, 'signup_decider_forbidden', 'signup decision door');
}
