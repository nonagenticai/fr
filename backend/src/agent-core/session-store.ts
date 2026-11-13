// src/agent-core/session-store.ts
//
// E-13 — drizzle-typed CRUD over `agent_sessions` (migration 013). Companion
// to `services/agent-session.ts`, which keeps its raw-SQL atomic rotation
// path. This store backs the `agent-core` session-refresh wrapper exposed to
// callers that want the simpler issue/refresh/revoke API surface (admin UI,
// per-user revoke panel, agent-core boot path).
//
// Refresh tokens are stored as sha256 hex of the raw 256-bit random value.
// Pre-image resistance comes from token entropy, not hash slowness — see the
// migration header for the rationale.

import { eq, and, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/client';
import { agentSessions } from '../db/schema';

export type AgentSessionRow = typeof agentSessions.$inferSelect;

/** sha256 hex of the raw token. Fast, unsalted — pre-image resistance comes
 *  from the 256-bit random token, not hash slowness. */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 256-bit random refresh token, hex-encoded (64 chars). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export async function insertSession(args: {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
}): Promise<AgentSessionRow> {
  const [row] = await db
    .insert(agentSessions)
    .values({
      user_id: args.userId,
      refresh_token_hash: args.refreshTokenHash,
      expires_at: args.expiresAt,
    })
    .returning();
  if (!row) {
    throw new Error('agent_sessions insert returned no row');
  }
  return row;
}

export async function findByRefreshHash(
  hash: string,
): Promise<AgentSessionRow | null> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.refresh_token_hash, hash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findById(id: string): Promise<AgentSessionRow | null> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function markReplaced(
  oldId: string,
  newId: string,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ replaced_by: newId })
    .where(eq(agentSessions.id, oldId));
}

export async function markRevoked(id: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(agentSessions.id, id), isNull(agentSessions.revoked_at)));
}
