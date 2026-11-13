// E-11 — agent runtime session store.
//
// CRUD for `agent_runtime_sessions` (migration 025). One row per
// (user_id, channel, thread_id); `state_json` is opaque to this layer
// (BY DESIGN: extension point — policies may serialize tool-call
// history / pending plans here without schema changes; current echo
// policy stores `{}`).
//
// Distinct from `services/agent-session.ts` (E-13) which manages
// refresh-token rotation. Different table, different concern.

import { and, eq, sql } from 'drizzle-orm';

import { db, agentRuntimeSessions } from '../db/client';

/**
 * Stored conversation turn. The agent loop appends one of these per LLM
 * round-trip and per tool result; the LLM sees the rolling list as its
 * prior context. Plan 3 (`028_agent_runtime_sessions_messages.sql`).
 */
export type ConversationMessage =
  | { role: 'user'; content: string; ts: string }
  | { role: 'assistant'; content: string; ts: string }
  | {
      role: 'tool';
      action: string;
      callId: string;
      output: unknown;
      status: 'success' | 'failed' | 'pending' | 'proposal';
      ts: string;
    };

export interface AgentRuntimeSessionRow {
  id: string;
  user_id: string;
  channel: string;
  thread_id: string;
  /**
   * fr-agui SPEC §5.7: the fr project this thread is bound to (immutable once
   * bound), or null for a tenant-level (doorway) thread. The agent chat reads
   * its `ctx.projectId` from HERE on every turn.
   */
  project_id: string | null;
  state_json: Record<string, unknown>;
  messages: ConversationMessage[];
  worker_name: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

/**
 * TTL applied on create. Renewed on every `touch()` call.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function expiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

/**
 * Look up an existing runtime session by (user, channel, thread). Returns
 * `null` if no row exists OR the row is past its `expires_at`. Expired
 * rows are NOT auto-deleted here — that's the reaper's job.
 */
export async function getSession(
  userId: string,
  channel: string,
  threadId: string = '',
): Promise<AgentRuntimeSessionRow | null> {
  const rows = await db
    .select()
    .from(agentRuntimeSessions)
    .where(
      and(
        eq(agentRuntimeSessions.user_id, userId),
        eq(agentRuntimeSessions.channel, channel),
        eq(agentRuntimeSessions.thread_id, threadId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= Date.now()) return null;
  return row as unknown as AgentRuntimeSessionRow;
}

/**
 * Idempotent upsert — returns the existing row if present, otherwise
 * inserts a fresh one. Concurrent calls with the same key resolve to the
 * same row via the `(user_id, channel, thread_id)` unique index +
 * `ON CONFLICT DO UPDATE` no-op that returns the row regardless.
 */
export async function getOrCreateSession(
  userId: string,
  channel: string,
  threadId: string = '',
  projectId?: string,
): Promise<AgentRuntimeSessionRow> {
  const existing = await getSession(userId, channel, threadId);
  if (existing) return existing;
  // ON CONFLICT DO UPDATE so RETURNING fires for the existing row when
  // two concurrent callers race the insert. Bumping `updated_at` is also
  // useful to track "saw activity here" without a separate touch().
  //
  // WHY the conditional expires_at/messages/state_json: `getSession` (read
  // path, above) already promises that an expired row reads as gone —
  // `row.expires_at.getTime() <= Date.now()` returns null. That promise
  // used to be broken HERE. When the existing row is expired, `getSession`
  // just returned null, so this INSERT runs, collides on the unique index,
  // and `DO UPDATE` bumped only `updated_at` — RETURNING then handed back
  // the OLD row, months-old `messages`/`state_json` intact, laundering
  // stale conversation back in as "current", AND leaving `expires_at` in
  // the past so the very same race repeats on every subsequent call.
  //
  // The CASE below closes that gap without reopening the concurrent-insert
  // race the ON CONFLICT exists for: it stays ONE atomic statement (no
  // read-then-write), and it changes nothing for the race it's meant to
  // handle. Inside a Postgres `ON CONFLICT DO UPDATE SET` expression, a
  // bare column reference (`agentRuntimeSessions.expires_at` here) reads
  // the row ALREADY in the table — i.e. the existing row's own value, not
  // the proposed insert — so this is genuinely "is the row I collided with
  // expired", not a comparison against the fresh values we tried to insert.
  // Expired existing row -> reset expires_at/messages/state_json to fresh
  // empty defaults (closes the read/write gap). Live existing row -> keep
  // today's behaviour exactly: just bump updated_at, values unchanged
  // (that's the legitimate two-concurrent-callers race this ON CONFLICT
  // was written to resolve, and it must not change).
  const freshExpiry = expiry();
  const inserted = await db
    .insert(agentRuntimeSessions)
    .values({
      user_id: userId,
      channel,
      thread_id: threadId,
      project_id: projectId,
      expires_at: freshExpiry,
    })
    .onConflictDoUpdate({
      target: [
        agentRuntimeSessions.user_id,
        agentRuntimeSessions.channel,
        agentRuntimeSessions.thread_id,
      ],
      set: {
        updated_at: sql`NOW()`,
        // ⚠️ `.toISOString()` + an explicit `::timestamptz`, NOT the bare Date.
        // Inside a raw `sql` fragment there is no column type-mapper, so drizzle
        // hands the value to postgres.js untouched and its Bind step calls
        // `Buffer.byteLength(value)` — which throws
        //   TypeError: The "string" argument must be ... Received an instance of Date
        // The `values()` binding above works precisely BECAUSE it goes through
        // the column mapper, which serialises the Date first. Same variable,
        // two different paths, only one of them safe.
        expires_at: sql`CASE WHEN ${agentRuntimeSessions.expires_at} <= NOW() THEN ${freshExpiry.toISOString()}::timestamptz ELSE ${agentRuntimeSessions.expires_at} END`,
        messages: sql`CASE WHEN ${agentRuntimeSessions.expires_at} <= NOW() THEN '[]'::jsonb ELSE ${agentRuntimeSessions.messages} END`,
        state_json: sql`CASE WHEN ${agentRuntimeSessions.expires_at} <= NOW() THEN '{}'::jsonb ELSE ${agentRuntimeSessions.state_json} END`,
      },
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error('agent-runtime-session: insert returned no row');
  }
  return row as unknown as AgentRuntimeSessionRow;
}

/**
 * Replace `state_json` and bump `updated_at` + `expires_at`. Throws if no
 * row exists for the given id (caller bug — get/create first).
 */
export async function updateSessionState(
  id: string,
  state: Record<string, unknown>,
): Promise<void> {
  const updated = await db
    .update(agentRuntimeSessions)
    .set({
      state_json: state,
      updated_at: new Date(),
      expires_at: expiry(),
    })
    .where(eq(agentRuntimeSessions.id, id))
    .returning({ id: agentRuntimeSessions.id });
  if (updated.length === 0) {
    throw new Error(`agent-runtime-session: no row for id=${id}`);
  }
}

/**
 * Bump `updated_at` + `expires_at` without changing state. Cheap "I'm
 * still here" ping for inbound messages that don't mutate state.
 */
export async function touchSession(id: string): Promise<void> {
  await db
    .update(agentRuntimeSessions)
    .set({
      updated_at: new Date(),
      expires_at: expiry(),
    })
    .where(eq(agentRuntimeSessions.id, id));
}

/**
 * Append a single message to the rolling conversation ledger. Used by the
 * agent loop after every `assistant-end` event (one batched write per turn,
 * not per tool call — keeps write rate low without losing durability).
 *
 * Implemented with `jsonb_set` + a Postgres-side array concat so concurrent
 * appends from sibling threads don't race-overwrite each other's history.
 */
export async function appendMessage(
  sessionId: string,
  message: ConversationMessage,
): Promise<void> {
  const updated = await db
    .update(agentRuntimeSessions)
    .set({
      messages: sql`${agentRuntimeSessions.messages} || ${JSON.stringify([message])}::jsonb`,
      updated_at: new Date(),
      expires_at: expiry(),
    })
    .where(eq(agentRuntimeSessions.id, sessionId))
    .returning({ id: agentRuntimeSessions.id });
  if (updated.length === 0) {
    throw new Error(`agent-runtime-session: no row for id=${sessionId}`);
  }
}

/**
 * Read back the rolling ledger. The agent loop uses this to assemble the
 * prompt context for each WM call.
 */
export async function loadMessages(
  sessionId: string,
): Promise<ConversationMessage[]> {
  const rows = await db
    .select({ messages: agentRuntimeSessions.messages })
    .from(agentRuntimeSessions)
    .where(eq(agentRuntimeSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return [];
  return (row.messages as ConversationMessage[] | null) ?? [];
}

/**
 * Override the worker driving this thread. Currently called only from
 * `getOrCreateSession` flow when a caller wants a non-default worker;
 * per-project worker overrides land in a follow-up plan.
 */
export async function setWorkerName(
  sessionId: string,
  workerName: string,
): Promise<void> {
  await db
    .update(agentRuntimeSessions)
    .set({ worker_name: workerName, updated_at: new Date() })
    .where(eq(agentRuntimeSessions.id, sessionId));
}
