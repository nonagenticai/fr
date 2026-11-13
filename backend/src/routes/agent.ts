/**
 * Plan 3 — POST /api/agent/chat
 *
 * Agent loop endpoint. Authed by FR agent session token (HS256, aud=fr-agent;
 * same gate as `routes/agui.ts`). Streams an NDJSON event sequence (see
 * `agent/loop.ts` for the event union) for one user message, with backend
 * persistence to `agent_runtime_sessions` + `agent_runtime_sessions.messages`.
 *
 * Auth + ALS frame mirror `routes/agui.ts` so upstream HTTP calls
 * (worker_management, AG-UI registry handlers) inherit the right
 * `X-Tenant-Id` / `X-User-Id` / `X-Subject-Id` / `X-Correlation-Id` headers
 * via the integrations http-client.
 */

import { randomUUID } from 'node:crypto';
import { clientSafeCaughtErrorText } from '../integrations/_lib/errors';
import { z } from 'zod';

import {
  verifyForwardedEndUserToken,
  verifyForwardedSwitchEndUserToken,
  withRequestContext,
} from '../middleware/request-context';
import { END_USER_TOKEN_HEADER } from '../integrations/_lib/http-client';
import type { ActionContext } from '../agui/types';
import { runAgentLoop, type AgentChatEvent } from '../agent/loop';
import { getOrCreateSession } from '../agent/session-store';
import { ndjsonLine } from '../utils/ndjson';
import { agentCanReadProject, agentReadIdentity, agentTenantRefusal } from '../lib/agent-read-identity';
import { markAgentTokenContext } from '../agui/context-provenance';
import type { AgentCatalogMode } from '../agent/intake-catalog';

/**
 * fr-agui SPEC §13 P1c (OQ-17 = c): the catalog of a chat turn, from the THREAD.
 * A project-bound thread is the project agent; any other is the doorway. There
 * is no tenant rail any more, so nothing maps to the unfiltered catalog.
 */
export function catalogModeForThread(boundProjectId: string | null): AgentCatalogMode {
  return boundProjectId ? 'project' : 'intake';
}
import {
  verifyAgentToken,
  type VerifiedAgentToken,
} from './agui';

const ChatBodySchema = z.object({
  correlationId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  message: z.string().min(1),
  workerName: z.string().min(1).optional(),
  /**
   * IGNORED since P1c (kept so an older client's body still parses). The
   * catalog is decided by the SERVER from the thread: a project-bound thread
   * gets the project agent, an unbound one the doorway (OQ-17 = c; the P1b
   * audit carry: the doorway restriction must not ride on a client field).
   */
  mode: z.enum(['default', 'intake', 'project']).optional(),
});

const FAILSTART_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-ndjson',
};

type LoopErrorCode = Extract<AgentChatEvent, { type: 'error' }>['code'];

function emitFailStart(
  correlationId: string,
  code: LoopErrorCode,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  const ev: AgentChatEvent = { type: 'error', correlationId, code, message };
  return new Response(JSON.stringify(ev) + '\n', {
    status,
    headers: { ...FAILSTART_HEADERS, ...extraHeaders },
  });
}

export async function handleAgentChat(req: Request): Promise<Response> {
  const verified: VerifiedAgentToken | null = await verifyAgentToken(req);
  if (!verified) {
    const cid = req.headers.get('X-Correlation-Id') ?? 'unknown';
    return emitFailStart(cid, 'internal_error', 'Missing or invalid agent access token.', 401, {
      'WWW-Authenticate': 'Bearer realm="fr-agent", audience="fr-agent"',
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    const cid = req.headers.get('X-Correlation-Id') ?? randomUUID();
    return emitFailStart(cid, 'internal_error', 'Request body is not valid JSON.', 400);
  }

  const parsed = ChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    const cid =
      (raw && typeof raw === 'object' && typeof (raw as { correlationId?: unknown }).correlationId === 'string'
        ? (raw as { correlationId: string }).correlationId
        : req.headers.get('X-Correlation-Id')) ?? randomUUID();
    return emitFailStart(cid, 'invalid_tool_call', 'Envelope failed schema validation.', 400);
  }

  const body = parsed.data;
  const correlationId = body.correlationId ?? req.headers.get('X-Correlation-Id') ?? randomUUID();
  const channel = body.channel ?? 'web';
  const threadId = body.threadId ?? '';
  const workerName = body.workerName ?? null;

  // ⛔ P1-TEAM-a: the token's tenant is the session's, frozen at issue, and
  // since P1-TEAM it grants every project of that tenant. EVERY turn — bound
  // or unbound, before the thread row is even touched — first asks Keycloak
  // whether the user is STILL homed there (cached 15 s). Otherwise a member
  // re-homed from A to B keeps tenant-wide agent access to A until the 15-min
  // access token expires. A Keycloak outage refuses the turn (503, retriable):
  // a safety decision, so it fails closed. Same gate as every other agent-token
  // route (lib/agent-read-identity.ts `agentTenantRefusal`).
  const tenantRefusal = await agentTenantRefusal(verified);
  if (tenantRefusal) {
    return emitFailStart(
      correlationId,
      tenantRefusal.code,
      tenantRefusal.message,
      tenantRefusal.status,
      tenantRefusal.headers,
    );
  }

  // Get/create the durable thread row first so the loop's
  // appendMessage(...) calls have a target id.
  const session = await getOrCreateSession(verified.userId, channel, threadId);

  // Tenant from the agent token claim (migration 097). Without it every
  // tenant-scoped action on this route ran unscoped — see the ALS frame below.
  const agentTenantId = verified.tenantId ?? undefined;

  // The user's own portal token, which the browser sends next to the agent
  // token so worker_management can decrypt this tenant's BYO key
  // (worker_management#316). The agent token (HS256, aud=fr-agent) proves
  // nothing to WM, so without this every BYO tenant's assistant answers
  // BYO_KEY_WITHHELD. Verified here (signature, issuer, human, same user as the
  // agent session, tenant_id == the session tenant) and kept ONLY in the ALS
  // frame of this request: never stored on the session, never logged. Absent or
  // failing ⇒ nothing is forwarded and WM decides as before.
  const endUserToken = await verifyForwardedEndUserToken(
    req.headers.get(END_USER_TOKEN_HEADER),
    { tenantId: agentTenantId, userId: verified.userId },
  );
  // George 2026-10-27 / #1647: a SWITCH session's tenant is the active
  // workspace, which the user's portal token (home tenant) never proves, so the
  // check above yields nothing and every run-the-UI-route read was refused
  // `end_user_token_required`. The switch lane re-verifies the same token under
  // the switch rules (same user, signed super_admin, switch target, Keycloak
  // live) and keeps it ONLY for that lane — never as the WM proof.
  const switchToken =
    !endUserToken && verified.superAdminSwitch === true && agentTenantId
      ? await verifyForwardedSwitchEndUserToken(req.headers.get(END_USER_TOKEN_HEADER), {
          tenantId: agentTenantId,
          userId: verified.userId,
          superAdminSwitch: true,
        })
      : undefined;

  // fr-agui SPEC §5.7 rule 2: the project is the THREAD's, read from the DB on
  // EVERY turn (`agent_runtime_sessions.project_id`, immutable once bound) —
  // never from the token (its never-minted `project_id` claim is gone) and never
  // from the request body. Read access is re-checked every turn with the same
  // gate the bind used (`loadProjectForRead`, full identity), so a member who
  // can no longer read the project loses the agent at once — and (P1-TEAM-a) the
  // token's tenant was re-checked against Keycloak above, so a member who LEFT
  // the tenant loses it on the next turn too.
  const boundProjectId = typeof session.project_id === 'string' && session.project_id ? session.project_id : null;
  const identity = await agentReadIdentity(req, {
    userId: verified.userId,
    tenantId: agentTenantId ?? null,
  });
  if (boundProjectId !== null && !(await agentCanReadProject(identity, boundProjectId))) {
    return emitFailStart(
      correlationId,
      'project_not_readable',
      'This conversation is bound to a project you can no longer read.',
      403,
    );
  }

  // ⭐ P1c: the server-side provenance mark that makes this context the AG-UI
  // RAIL (agui/context-provenance.ts): only the project agent's set (bound) or
  // the doorway set (unbound) is usable from it (agui/agent-surface.ts).
  const ctx: ActionContext = markAgentTokenContext({
    userId: verified.userId,
    projectId: boundProjectId,
    correlationId,
    initiator: 'agent',
    channel,
    tenantRoles: verified.tenantRoles,
    tenantId: agentTenantId,
    // Realm roles from the VERIFIED forwarded portal token only (SPEC §5.7):
    // the project READ gate gives the agent the GET's answer for this person.
    ...(identity && identity.roles.length > 0 ? { realmRoles: identity.roles } : {}),
  });
  const catalogMode = catalogModeForThread(boundProjectId);

  // ALS frame so upstream http-client picks up correlation/tenant/user/subject
  // from the same request shape as every other route.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await withRequestContext(
          {
            correlationId,
            initiator: 'agent',
            channel,
            // No bearer token forwarded upstream — the Keycloak JWT is NOT
            // forwarded, and the agent token (HS256, aud=fr-agent) must not be
            // either.
            //
            // `tenantId` was hard-coded `undefined` directly beneath a comment
            // saying the http-client populates X-Tenant-Id from getTenantId() —
            // which reads THIS field. The comment described the mechanism and
            // the next line disabled it, so no tenant header was ever sent and
            // tenant-scoped upstreams fell back to their DEFAULT_TENANT_ID.
            tenantId: agentTenantId,
            userId: verified.userId,
            subjectId: verified.userId,
            ...(endUserToken ? { endUserToken } : {}),
            ...(switchToken && agentTenantId
              ? { superAdminSwitchToken: { token: switchToken, tenantId: agentTenantId } }
              : {}),
            // George 2026-10-27: a switched super_admin's Copilot — every in-process WRITE
            // action of this chat turn is audited by the registry (lib/super-admin-tenant-audit.ts).
            // Distinct from ``superAdminSwitchToken`` above: that is the minted identity for
            // OUTBOUND calls, this is the provenance flag the in-process audit reads.
            ...(verified.superAdminSwitch ? { agentSuperAdminSwitch: true } : {}),
          },
          async () => {
            for await (const ev of runAgentLoop({
              sessionId: session.id,
              threadId: session.thread_id,
              workerName,
              userMessage: body.message,
              ctx,
              catalogMode,
            })) {
              controller.enqueue(ndjsonLine(ev));
            }
          },
        );
      } catch (err) {
        console.error('[agent.chat] stream failed:', err);
        const ev: AgentChatEvent = {
          type: 'error',
          correlationId,
          code: 'internal_error',
          message: clientSafeCaughtErrorText(err, 'The agent hit an internal error — try again'),
        };
        controller.enqueue(ndjsonLine(ev));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Correlation-Id': correlationId,
    },
  });
}
