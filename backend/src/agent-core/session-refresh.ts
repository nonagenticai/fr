// src/agent-core/session-refresh.ts
//
// E-13 — agent-core session-refresh wrapper. Exposes the four-verb API the
// agent-core boot path and admin UI both want:
//
//   issueSession({ userId, ttlSeconds? })  -> raw refresh + access JWT
//   refreshSession(presentedRawToken)      -> rotates, returns new pair
//   revokeSession(sessionId)               -> idempotent
//   validateAccessToken(jwt)               -> returns { userId, sessionId }
//
// Builds on `session-store.ts` (drizzle-typed CRUD over migration 013). The
// raw-SQL rotation in `services/agent-session.ts` remains the canonical
// production path — this layer is the simpler API surface for new callers
// and the integration tests asserting end-to-end rotation semantics.
//
// Access token is a self-contained HS256 JWT signed with
// AGENT_SESSION_SIGNING_KEY (>=32 chars). 15-minute TTL. Refresh-token
// validation hits the DB; access-token validation is signature + exp only.

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  generateRefreshToken,
  hashRefreshToken,
  insertSession,
  findByRefreshHash,
  findById,
  markReplaced,
  markRevoked,
} from './session-store';

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_S_DEFAULT = 30 * 24 * 60 * 60;

function signingKey(): Buffer {
  const k = process.env.AGENT_SESSION_SIGNING_KEY;
  if (!k || k.length < 32) {
    throw new Error('AGENT_SESSION_SIGNING_KEY must be set (>=32 chars)');
  }
  return Buffer.from(k, 'utf8');
}

export interface AccessClaims {
  userId: string;
  sessionId: string;
  /** ms since epoch */
  exp: number;
}

function signAccessToken(claims: AccessClaims): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', signingKey())
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export async function validateAccessToken(token: string): Promise<AccessClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed access token');
  }
  const [header, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', signingKey())
    .update(`${header}.${payload}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('bad signature');
  }
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as AccessClaims;
  if (claims.exp < Date.now()) {
    throw new Error('access token expired');
  }
  return claims;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: Date;
}

export async function issueSession(args: {
  userId: string;
  ttlSeconds?: number;
}): Promise<IssuedSession> {
  const ttl = args.ttlSeconds ?? REFRESH_TOKEN_TTL_S_DEFAULT;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const raw = generateRefreshToken();
  const row = await insertSession({
    userId: args.userId,
    refreshTokenHash: hashRefreshToken(raw),
    expiresAt,
  });
  const accessToken = signAccessToken({
    userId: row.user_id,
    sessionId: row.id,
    exp: Date.now() + ACCESS_TOKEN_TTL_MS,
  });
  return {
    sessionId: row.id,
    refreshToken: raw,
    accessToken,
    expiresAt: row.expires_at,
  };
}

export async function refreshSession(presented: string): Promise<IssuedSession> {
  const row = await findByRefreshHash(hashRefreshToken(presented));
  if (!row) {
    throw new Error('unknown refresh token');
  }
  if (row.replaced_by) {
    throw new Error('refresh token already used (replayed)');
  }
  if (row.revoked_at) {
    throw new Error('session revoked');
  }
  if (row.expires_at.getTime() < Date.now()) {
    throw new Error('session expired');
  }
  // Rotate: new row, link old.replaced_by = new.id
  const fresh = await issueSession({ userId: row.user_id });
  await markReplaced(row.id, fresh.sessionId);
  return fresh;
}

export async function revokeSession(sessionId: string): Promise<void> {
  const row = await findById(sessionId);
  if (!row) return; // idempotent
  await markRevoked(sessionId);
}
