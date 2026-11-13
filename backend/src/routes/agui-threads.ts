/**
 * Plan 3 — thread CRUD routes.
 *
 * Thin wrappers over `agent_runtime_sessions`, scoped by the agent session
 * token's user. Used by the frontend to populate `ThreadsList.svelte` and
 * the chat surface's history view.
 *
 * Auth: same FR-issued agent access token as `/api/agui/invoke` and
 * `/api/agent/chat` (HS256 JWT, aud=fr-agent).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/client';
import { agentRuntimeSessions } from '../db/schema';
import { verifyAgentToken } from './agui';
import { AGENT_TOKEN_AUDIENCE } from '../services/agent-session';
import type { ConversationMessage } from '../agent/session-store';
import { isUuidShape } from '../lib/uuid-shape';
import { redactThenTruncate } from '../capabilities/redact';
import { projectIdsReadableAsGetProject } from '../lib/project-access';
import {
  agentCanReadProject,
  agentReadIdentity,
  agentTenantRefusal,
  type AgentReadIdentity,
} from '../lib/agent-read-identity';

interface ThreadSummary {
  id: string;
  channel: string;
  threadId: string;
  workerName: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  /**
   * The fr project this thread is bound to (`agent_runtime_sessions.project_id`),
   * or null. fr-agui SPEC §7.5: a project-bound thread opens in the project
   * shell (/projects/P/threads/[id]); the frontend redirects on this value.
   */
  projectId: string | null;
}

interface ThreadDetail extends ThreadSummary {
  messages: ConversationMessage[];
}

const CreateBody = z.object({
  channel: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  workerName: z.string().min(1).optional(),
  projectId: z.string().uuid().optional(),
});

/**
 * The bound project ids (among `rows`) the caller can `GET /api/projects/:id` —
 * the GET's own predicate (`projectIdsReadableAsGetProject`), evaluated for the
 * caller's FULL read identity (lib/agent-read-identity.ts: the agent token's
 * user + tenant plus the realm roles of the verified forwarded portal token),
 * so a super-admin in home view gets the GET's answer, not a stricter one
 * (P1a audit → P1b). A thread is the caller's own, but its project may not be
 * readable any more (ownership moved, a different active tenant), and the
 * frontend redirects INTO `/projects/P/threads/…` on `projectId` — so an
 * unreadable project is answered as `null` (stay), never as the id.
 */
async function readableThreadProjects(
  identity: AgentReadIdentity | null,
  rows: ReadonlyArray<{ project_id?: unknown }>,
): Promise<Set<string>> {
  const ids = rows
    .map((r) => r.project_id)
    .filter((v): v is string => typeof v === 'string' && v !== '');
  if (ids.length === 0 || identity === null) return new Set();
  return projectIdsReadableAsGetProject(identity, ids, { activeTenantId: identity.tenantId });
}

/** Max length of `lastMessagePreview`. */
export const THREAD_PREVIEW_MAX = 120;

/**
 * The list/title preview of a thread's last message. Computed on EVERY read
 * from the stored messages (no preview column), so threads stored before the
 * §10.1 append-time redaction — or a user turn, which is stored as typed — are
 * scrubbed here too: redact the FULL content, THEN cut (P1c-b; cutting first
 * leaked the prefix of a token straddling char 120).
 */
export function threadPreview(last: ConversationMessage | undefined): string | null {
  if (!last) return null;
  if (last.role === 'user' || last.role === 'assistant') {
    return redactThenTruncate(String(last.content ?? ''), THREAD_PREVIEW_MAX);
  }
  return redactThenTruncate(`tool: ${last.action}`, THREAD_PREVIEW_MAX);
}

function rowToSummary(row: any, readableProjects: ReadonlySet<string>): ThreadSummary {
  const messages = (row.messages ?? []) as ConversationMessage[];
  const preview = threadPreview(messages[messages.length - 1]);
  return {
    id: row.id,
    channel: row.channel,
    threadId: row.thread_id,
    workerName: row.worker_name,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    messageCount: messages.length,
    lastMessagePreview: preview,
    projectId:
      typeof row.project_id === 'string' && readableProjects.has(row.project_id) ? row.project_id : null,
  };
}

/**
 * 401 for the AG-UI thread routes.
 *
 * These routes authenticate with the fr-AGENT token (HS256, `aud: fr-agent`,
 * minted by POST /api/agui/session/issue) via `verifyAgentToken` — NOT with
 * `middleware/auth.ts validateAuth`. Two consequences that a bare
 * `{"error":"unauthorized"}` left the caller to discover by reading source:
 *
 *   1. `AUTH_BYPASS=true` does NOT apply here. It is honoured only by
 *      `validateAuth`; `verifyAgentToken` has no bypass branch, so a dev stack
 *      that reaches every other route unauthenticated still gets 401 on these.
 *      That is deliberate — the agent token is a separate trust domain — but it
 *      is surprising, so the body now says which token is expected.
 *   2. A perfectly valid Keycloak USER access token is also rejected: it is
 *      RS256 with the wrong audience.
 *
 * Mirrors the richer 401 that the sibling POST /api/agui/invoke has always
 * returned (routes/agui.ts) — same `code`, same message, same
 * `WWW-Authenticate` challenge. The `error` field keeps its historical
 * `unauthorized` value so existing clients are unaffected.
 */
function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      code: 'unauthorized',
      message: 'Missing or invalid agent access token.',
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="fr-agent", audience="${AGENT_TOKEN_AUDIENCE}"`,
      },
    },
  );
}

/**
 * fr-agui P1-TEAM-a: the token's tenant re-checked against Keycloak (cached
 * 15 s) on EVERY thread verb — list, read, create/bind and delete — exactly as
 * `/api/agui/invoke` and `/api/agent/chat` do. Re-homed ⇒ 403 tenant_changed;
 * Keycloak unreadable ⇒ 503 identity_unavailable (fail closed). `null` ⇒ proceed.
 */
async function tenantRefusalResponse(verified: {
  userId: string;
  tenantId: string | null;
  superAdminSwitch?: boolean;
}): Promise<Response | null> {
  const refusal = await agentTenantRefusal(verified);
  if (!refusal) return null;
  return new Response(
    JSON.stringify({ error: refusal.code, code: refusal.code, message: refusal.message }),
    {
      status: refusal.status,
      headers: { 'Content-Type': 'application/json', ...refusal.headers },
    },
  );
}

/** 400 for a non-uuid `?projectId=` (a uuid column would 22P02 → 500). A
 *  helper, like `unauthorized()`, so the list handler's success envelope stays
 *  the single `{ threads }` shape. */
function invalidProjectFilter(): Response {
  return new Response(
    JSON.stringify({ error: 'validation_failed', message: 'projectId must be a uuid' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function handleListAgentThreads(req: Request): Promise<Response> {
  const verified = await verifyAgentToken(req);
  if (!verified) return unauthorized();
  const tenantRefused = await tenantRefusalResponse(verified);
  if (tenantRefused) return tenantRefused;

  // `?projectId=<uuid>` narrows the caller's OWN threads to one project
  // SERVER-side (the project shell's /projects/P/threads page). Filtering the
  // 100 newest client-side lost every older thread of the project. Still
  // user-scoped; a project the caller cannot GET lists nothing.
  const projectFilter = new URL(req.url).searchParams.get('projectId');
  if (projectFilter !== null && !isUuidShape(projectFilter)) return invalidProjectFilter();
  if (projectFilter !== null) {
    const readable = await readableThreadProjects(await agentReadIdentity(req, verified), [
      { project_id: projectFilter },
    ]);
    if (!readable.has(projectFilter)) {
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const rows = await db
    .select()
    .from(agentRuntimeSessions)
    .where(
      projectFilter !== null
        ? and(
            eq(agentRuntimeSessions.user_id, verified.userId),
            eq(agentRuntimeSessions.project_id, projectFilter),
          )
        : eq(agentRuntimeSessions.user_id, verified.userId),
    )
    .orderBy(desc(agentRuntimeSessions.updated_at))
    .limit(100);

  const readable = await readableThreadProjects(await agentReadIdentity(req, verified), rows);
  const summaries: ThreadSummary[] = rows.map((r) => rowToSummary(r, readable));
  return new Response(JSON.stringify({ threads: summaries }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleGetAgentThread(
  req: Request,
  threadRowId: string,
): Promise<Response> {
  const verified = await verifyAgentToken(req);
  if (!verified) return unauthorized();
  const tenantRefused = await tenantRefusalResponse(verified);
  if (tenantRefused) return tenantRefused;

  // `agent_runtime_sessions.id` is a `uuid` column (schema.ts:799). A `:id`
  // path segment that is not UUID-shaped does not select zero rows — it aborts
  // with 22P02 `invalid input syntax for type uuid` and escapes as a bare 500,
  // a status this route does not promise. The `{ error: 'not_found' }` 404
  // below is this handler's OWN miss value and is byte-identical to the one
  // another user's or an absent thread already gets, so malformed and absent
  // stay indistinguishable (routes/approvals.ts:~408-438).
  //
  // ⚠️ `agentRuntimeSessions.thread_id` (schema.ts:801) is a TEXT column and is
  // deliberately NOT guarded anywhere in this file — a uuid check there would
  // reject legitimate non-UUID thread keys. Only the `uuid` PK is guarded.
  //
  // `isUuidShape`, not `isValidUuid` (utils/tenant), which pins the version
  // nibble to 1-8 and would 404 rows that genuinely exist.
  if (!isUuidShape(threadRowId)) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rows = await db
    .select()
    .from(agentRuntimeSessions)
    .where(
      and(
        eq(agentRuntimeSessions.id, threadRowId),
        eq(agentRuntimeSessions.user_id, verified.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const detail: ThreadDetail = {
    ...rowToSummary(row, await readableThreadProjects(await agentReadIdentity(req, verified), [row])),
    messages: (row.messages ?? []) as ConversationMessage[],
  };
  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleCreateAgentThread(req: Request): Promise<Response> {
  const verified = await verifyAgentToken(req);
  if (!verified) return unauthorized();
  const tenantRefused = await tenantRefusalResponse(verified);
  if (tenantRefused) return tenantRefused;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'validation_failed', issues: parsed.error.issues }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const channel = parsed.data.channel ?? 'web';
  // Per-user, per-channel uniqueness on (user, channel, thread_id) means
  // omitting threadId returns the user's default thread for that channel.
  // To support multiple parallel threads per channel from the UI, we mint
  // a fresh threadId on every POST when the body doesn't supply one.
  const threadId = parsed.data.threadId ?? randomUUID();
  const workerName = parsed.data.workerName ?? 'fr-agent-default';
  const projectId = parsed.data.projectId;

  // fr-agui SPEC §5.7 rule 1: the thread binds to a project the caller can READ —
  // the project READ gate (`loadProjectForRead`), i.e. exactly what `GET /api/projects/:id` admits for
  // the same person (full identity, lib/agent-read-identity.ts). It replaces the
  // owner-only `ownedProjectInTenant` gate: any reader may bind, not only the
  // creator. Binding never widens anything — every turn re-checks the same gate
  // (routes/agent.ts), and the bound id is immutable once written.
  // Unreadable ⇒ 403 with ONE code whether the project is foreign, untagged,
  // missing or malformed, so the answer is no existence oracle.
  const identity = await agentReadIdentity(req, verified);
  if (projectId && !(await agentCanReadProject(identity, projectId))) {
    return new Response(JSON.stringify({ error: 'project_not_readable' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const inserted = await db
    .insert(agentRuntimeSessions)
    .values({
      user_id: verified.userId,
      channel,
      thread_id: threadId,
      worker_name: workerName,
      project_id: projectId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .onConflictDoUpdate({
      target: [
        agentRuntimeSessions.user_id,
        agentRuntimeSessions.channel,
        agentRuntimeSessions.thread_id,
      ],
      set: { updated_at: new Date() },
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    return new Response(JSON.stringify({ error: 'insert_failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(rowToSummary(row, await readableThreadProjects(identity, [row]))), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleDeleteAgentThread(
  req: Request,
  threadRowId: string,
): Promise<Response> {
  const verified = await verifyAgentToken(req);
  if (!verified) return unauthorized();
  const tenantRefused = await tenantRefusalResponse(verified);
  if (tenantRefused) return tenantRefused;

  // Same `uuid` PK (schema.ts:799) and the same 22P02 on DELETE. The
  // `{ error: 'not_found' }` 404 is this handler's OWN miss value — identical
  // to the answer for a thread owned by someone else — so a malformed id
  // reveals nothing an absent one does not. Not `isValidUuid` (utils/tenant):
  // version-pinned, would 404 live rows.
  if (!isUuidShape(threadRowId)) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const deleted = await db
    .delete(agentRuntimeSessions)
    .where(
      and(
        eq(agentRuntimeSessions.id, threadRowId),
        eq(agentRuntimeSessions.user_id, verified.userId),
      ),
    )
    .returning({ id: agentRuntimeSessions.id });
  if (deleted.length === 0) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(null, { status: 204 });
}
