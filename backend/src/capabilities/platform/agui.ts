// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: the AG-UI wire protocol and the agent
// loop (routes/{agui,agui-session,agui-threads,agent}.ts), re-expressed with NO behaviour change
// (`legacyHandler`). None had an operation in the served spec (LEGACY_UNDECLARED): every one is a
// NEW operation, operationId = camelCase(id). They ARE the agent's transport, so none is itself an
// agent action (`transport`), and none is on the licence route allowlist.
//
// Auth (the handlers', unchanged):
//   * `POST /api/agui/invoke`, `POST /api/agent/chat` and the four `/api/agui/threads` routes take
//     the FR-issued AGENT access token (HS256 JWT, aud `fr-agent`, `verifyAgentToken`) — NOT a
//     Keycloak bearer and NOT `validateAuth` (no AUTH_BYPASS branch): missing / invalid ⇒ 401 with
//     a `WWW-Authenticate: Bearer realm="fr-agent"` challenge. A token with no `tenant_id` claim is
//     401 (invoke) / refused; then the token's tenant is re-checked against Keycloak on every call
//     (`agentTenantRefusal`): re-homed ⇒ 403 `tenant_changed`, Keycloak unreadable ⇒ 503
//     `identity_unavailable`. invoke and chat answer NDJSON (one AG-UI event per line), their
//     refusals a single NDJSON error line.
//   * `POST /api/agui/session/issue` and `/:id/revoke`: a Keycloak bearer (`validateAuth`).
//   * `POST /api/agui/session/refresh`: NO bearer needed — the refresh token in the body is the
//     credential (a bearer, when sent, must be the session's owner: 401 `session_user_mismatch`).
//   * `GET /api/agui/actions`: public, unauthenticated (the registry catalogue, no schemas).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUser } from '../rbac-rules';
import { DOOR_403, LICENCE_DOOR_403_TEXT, VALIDATE_AUTH_401, doorBody, frErrorBody, neverThroughRegistry, pathId, platformCapabilities, routeRule, unauthorizedBody } from './_shared';

const mod = (m: string, load: () => Promise<Record<string, unknown>>) => ({ module: `src/routes/${m}.ts`, load });

/** One AG-UI / agent-loop NDJSON event (agui/protocol.types.ts, agent-loop events): `type` + its fields. */
const ndjsonEvent = z.object({ type: z.string(), correlationId: z.string().optional() }).passthrough();
const ndjsonError = z.object({ type: z.literal('error'), correlationId: z.string(), code: z.string(), message: z.string(), retriable: z.boolean().optional() }).passthrough();

const AGENT_TOKEN_401 =
  'Missing or invalid FR agent access token (aud `fr-agent`), with a `WWW-Authenticate: Bearer realm="fr-agent"` challenge.';
const TENANT_RECHECK =
  " 403: `code` 'tenant_changed' (the user was re-homed in Keycloak since the session was issued — or, for a session " +
  "minted from a super-admin workspace switch, no longer holds `super_admin` / may no longer switch there). 503: `code` " +
  "'identity_unavailable' (Keycloak could not be asked; retriable).";

/** The thread routes' JSON refusals (`{ error, code, message }` for auth / tenant). */
const threadError = z.object({ error: z.string(), code: z.string().optional(), message: z.string().optional() }).passthrough();
const threadSummary = z
  .object({
    id: z.string(),
    channel: z.string(),
    threadId: z.string(),
    workerName: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    expiresAt: z.string(),
    messageCount: z.number().int(),
    lastMessagePreview: z.string().nullable(),
    projectId: z.string().nullable().describe('The bound project, or null (also null when the caller can no longer read it).'),
  })
  .passthrough();

const threadResponses = (extra: string) => [
  { status: 401, description: AGENT_TOKEN_401 + " Body `{ error: 'unauthorized', code: 'unauthorized', message }`.", schema: threadError },
  {
    status: 'default' as const,
    description: LICENCE_DOOR_403_TEXT + TENANT_RECHECK + extra + " 500: fr's own (`error`), e.g. the database is unreachable.",
    schema: threadError,
  },
];

const ndjsonResponses = (extra: string) => [
  { status: 401, description: AGENT_TOKEN_401 + ' One NDJSON error line (`code` unauthorized), or the token carries no tenant.', schema: ndjsonError },
  {
    status: 'default' as const,
    description:
      LICENCE_DOOR_403_TEXT + ' (JSON `{ error, code }`, not NDJSON.)' + TENANT_RECHECK + ' (one NDJSON error line).' + extra,
    schema: z.union([ndjsonError, doorBody]),
  },
];

export const AGUI_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...platformCapabilities(
    { area: 'agui', tag: 'AG-UI', tenancy: 'self', principal: 'user', agentReason: 'transport', rule: neverThroughRegistry, ...mod('agui', () => import('../../routes/agui')) },
    [
      {
        id: 'agui.invoke', method: 'POST', path: '/api/agui/invoke', handler: 'handleAguiInvoke', effect: 'write', stream: 'ndjson',
        summary: 'Invoke one registered AG-UI action as the agent (NDJSON event stream)',
        description:
          'Auth: the FR agent access token. The action runs through the AG-UI registry (its RBAC, approval policy and ' +
          'idempotency); a write that needs approval answers a pending-approval event. Header `X-Correlation-Id` (optional; ' +
          'the body `correlationId` wins) and `Idempotency-Key` (optional) are read.',
        input: z
          .object({
            correlationId: z.string().min(1).optional(),
            initiator: z.literal('agent').optional(),
            channel: z.string().min(1).optional().describe("Default 'agent'."),
            action: z.string().min(1).describe('The registered AG-UI action name (`<area>.<verb_noun>`).'),
            input: z.unknown().describe("The action's own input."),
          })
          .passthrough(),
        output: ndjsonEvent.describe('200: NDJSON — one AG-UI event per line (tool-call / result / approval-pending / error / done).'),
        responses: ndjsonResponses(
          " 400: one NDJSON error line, `code` 'validation_failed' (the body is not JSON, or the envelope fails its schema).",
        ),
      },
      {
        id: 'agui.list_actions', method: 'GET', path: '/api/agui/actions', handler: 'handleListAguiActions', effect: 'read',
        summary: 'The AG-UI registry catalogue (public: name, kind, description, approval, cronSafe)',
        description: 'Unauthenticated by design (operator debugging, tool discovery). No input schemas (not JSON-serialisable).',
        security: [],
        input: z.object({}),
        output: z.object({
          data: z.array(z.object({ name: z.string(), kind: z.string(), description: z.string(), approval: z.unknown(), cronSafe: z.boolean() }).passthrough()),
        }),
        responses: [{ status: 403, description: LICENCE_DOOR_403_TEXT, schema: doorBody }],
      },
    ],
  ),
  ...platformCapabilities(
    { area: 'agui', tag: 'AG-UI', tenancy: 'self', agentReason: 'transport', rule: routeRule(isAuthenticatedUser), ...mod('agui-session', () => import('../../routes/agui-session')) },
    [
      {
        id: 'agui.issue_session', method: 'POST', path: '/api/agui/session/issue', handler: 'handleIssueAgentSession', effect: 'write', successStatus: 201,
        summary: "Mint an agent session for the caller (the raw refresh token, returned ONCE)",
        description:
          'Auth: a Keycloak bearer (`validateAuth`). The session acts in the caller\'s Keycloak home tenant — or, for a ' +
          'super-admin whose `X-Active-Tenant` switch the request context accepted, in that ACTIVE workspace (a refused ' +
          "switch is 403 `active_tenant_not_permitted` before this handler). No body is read.",
        input: z.object({}),
        output: z.object({ sessionId: z.string(), refreshToken: z.string().describe('🔐 SECRET: the refresh token (returned once).') }),
        secrets: { output: ['/refreshToken'] },
        responses: [
          { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
          { status: 'default', description: `${DOOR_403} 500: fr's own (\`error\`), e.g. the database is unreachable.`, schema: frErrorBody },
        ],
      },
      {
        id: 'agui.refresh_session', method: 'POST', path: '/api/agui/session/refresh', handler: 'handleRefreshAgentSession', effect: 'write',
        summary: 'Exchange an agent refresh token for a short-lived FR agent access token (rotates the refresh token)',
        description:
          'No bearer needed: the body `refreshToken` IS the credential. When a valid Keycloak bearer IS sent it must be the ' +
          "session's owner (else 401 `session_user_mismatch`, nothing rotated). A replayed token revokes the whole chain.",
        security: [],
        input: z.object({ refreshToken: z.string().min(1).describe('🔐 SECRET: the agent refresh token.') }),
        output: z.object({
          accessToken: z.string().describe('🔐 SECRET: the FR agent access token.'),
          expiresIn: z.number(),
          refreshToken: z.string().describe('🔐 SECRET: the rotated refresh token.'),
        }),
        secrets: { input: ['/refreshToken'], output: ['/accessToken', '/refreshToken'] },
        responses: [
          { status: 400, description: "`error` 'refresh_token_invalid': the body is not JSON or has no `refreshToken`.", schema: unauthorizedBody },
          {
            status: 401,
            description:
              "`error`: 'session_user_mismatch', 'refresh_token_replayed' (the chain is revoked), 'refresh_token_expired', " +
              "'refresh_token_invalid', 'session_user_inactive' or 'session_tenant_changed' (the session is revoked).",
            schema: unauthorizedBody,
          },
          { status: 403, description: LICENCE_DOOR_403_TEXT, schema: doorBody },
          { status: 503, description: "`error` 'identity_unavailable': Keycloak could not be asked; nothing rotated, retry.", schema: unauthorizedBody },
        ],
      },
      {
        id: 'agui.revoke_session', method: 'POST', path: '/api/agui/session/:id/revoke', handler: 'handleRevokeAgentSession', effect: 'write', successStatus: 204,
        summary: "Revoke one of the caller's own agent sessions",
        description: 'Auth: a Keycloak bearer. Scoped to the caller: a session that is not theirs is the same 404 as a missing one.',
        input: z.object({ id: pathId('The agent session id') }),
        output: z.null(),
        responses: [
          { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
          { status: 404, description: "`error` 'not_found': no session with that id belongs to the caller.", schema: unauthorizedBody },
          { status: 'default', description: `${DOOR_403} 500: fr's own (\`error\`).`, schema: frErrorBody },
        ],
      },
    ],
  ),
  ...platformCapabilities(
    { area: 'agui', tag: 'AG-UI', tenancy: 'self', agentReason: 'transport', rule: neverThroughRegistry, ...mod('agui-threads', () => import('../../routes/agui-threads')) },
    [
      {
        id: 'agui.list_threads', method: 'GET', path: '/api/agui/threads', handler: 'handleListAgentThreads', effect: 'read',
        summary: "The caller's agent threads (newest first, at most 100)",
        description: 'Auth: the FR agent access token. `projectId` filters to one project the caller can read (one they cannot: an empty list).',
        input: z.object({ projectId: z.string().uuid().optional().describe('A uuid (else 400).') }),
        output: z.object({ threads: z.array(threadSummary) }),
        responses: threadResponses(" 400: `error` 'validation_failed' (`projectId` is not a uuid)."),
      },
      {
        id: 'agui.create_thread', method: 'POST', path: '/api/agui/threads', handler: 'handleCreateAgentThread', effect: 'write', successStatus: 201,
        summary: 'Open (or re-open) an agent thread, optionally bound to a project the caller can read',
        description:
          'A body that is not JSON is read as `{}` (no 400). Without `threadId` a fresh one is minted. `projectId` must be a ' +
          'project the caller can GET (else 403 `project_not_readable`, the same answer for foreign / missing / malformed); ' +
          'the binding is immutable once written.',
        input: z.object({
          channel: z.string().min(1).optional().describe("Default 'web'."),
          threadId: z.string().min(1).optional(),
          workerName: z.string().min(1).optional().describe("Default 'fr-agent-default'."),
          projectId: z.string().uuid().optional(),
        }),
        output: threadSummary,
        responses: threadResponses(
          " 400: `error` 'validation_failed' (`issues`). 403: `error` 'project_not_readable'. 500: `error` 'insert_failed'.",
        ),
      },
      {
        id: 'agui.get_thread', method: 'GET', path: '/api/agui/threads/:id', handler: 'handleGetAgentThread', effect: 'read',
        summary: "One of the caller's agent threads, with its messages",
        input: z.object({ id: pathId('The thread row id') }),
        output: threadSummary.extend({ messages: z.array(z.object({ role: z.string() }).passthrough()) }),
        responses: threadResponses(" 404: `error` 'not_found' (not the caller's, or not a uuid)."),
      },
      {
        id: 'agui.delete_thread', method: 'DELETE', path: '/api/agui/threads/:id', handler: 'handleDeleteAgentThread', effect: 'destructive', successStatus: 204,
        summary: "Delete one of the caller's agent threads",
        input: z.object({ id: pathId('The thread row id') }),
        output: z.null(),
        responses: threadResponses(" 404: `error` 'not_found' (not the caller's, or not a uuid)."),
      },
    ],
  ),
  ...platformCapabilities(
    { area: 'agent', tag: 'AG-UI', tenancy: 'self', agentReason: 'transport', rule: neverThroughRegistry, ...mod('agent', () => import('../../routes/agent')) },
    [
      {
        id: 'agent.chat', method: 'POST', path: '/api/agent/chat', handler: 'handleAgentChat', effect: 'write', stream: 'ndjson',
        summary: 'One agent chat turn (NDJSON event stream): the agent loop over the AG-UI registry',
        description:
          'Auth: the FR agent access token. The catalogue is decided by the SERVER from the thread (a project-bound thread: ' +
          'the project agent; an unbound one: the doorway); `mode` is ignored. worker_management is the sole LLM gateway.',
        input: z.object({
          correlationId: z.string().min(1).optional(),
          threadId: z.string().min(1).optional(),
          channel: z.string().min(1).optional().describe("Default 'web'."),
          message: z.string().min(1),
          workerName: z.string().min(1).optional(),
          mode: z.enum(['default', 'intake', 'project']).optional().describe('IGNORED (P1c): the server decides from the thread.'),
        }),
        output: ndjsonEvent.describe('200: NDJSON — the turn as agent-loop events (deltas, tool calls / results, approvals, error, done).'),
        responses: ndjsonResponses(
          " 400: one NDJSON error line — `code` 'internal_error' (the body is not JSON) or 'invalid_tool_call' (the envelope fails its schema).",
        ),
      },
    ],
  ),
];
