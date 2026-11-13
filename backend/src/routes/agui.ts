// src/routes/agui.ts
//
// E-9 — AG-UI wire protocol.
//
// POST /api/agui/invoke — NDJSON streaming response that mirrors the
// in-process `invokeAction` contract (E-2) onto an HTTP boundary.
//
// Auth is the FR-issued agent access token (E-13), HS256 JWT with
// `aud=fr-agent`. The same secret resolution is mirrored here so this
// module does not need to edit E-13's source. If the token is missing or
// invalid, a 401 is returned BEFORE any NDJSON is written. After the first
// byte, all errors must surface as `error` events on the stream.
//
// Spec: docs/superpowers/specs/completed/2026-04-25-e9-agui-wire-protocol.md.
//
// Scope: agent → FR only. `initiator` is forced to 'agent'; the human and
// cron paths use other routes.

import { markAgentTokenContext } from '../agui/context-provenance';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import {
  invokeAction,
  listActions,
  UnknownActionError,
  ActionInputValidationError,
  NotCronSafeError,
} from '../agui/registry';
import { RbacDeniedError } from '../agui/rbac';
import { isIntegrationError } from '../integrations/_lib/errors';
import type { ActionContext, PendingAction } from '../agui/types';
import { db, approvals, requiredApprovers } from '../db/client';
import { withRequestContext } from '../middleware/request-context';
import { AGENT_TOKEN_AUDIENCE, agentTokenSecret, superAdminSwitchFromClaims } from '../lib/agent-token';
import { getUserTenant } from '../services/user-tenant';
import { ndjsonLine as encodeNdjson } from '../utils/ndjson';
import { AppError } from '../utils/errors';
import { PROJECT_ARCHIVED } from '../lib/project-live-status';
import { agentTenantRefusal } from '../lib/agent-read-identity';

// ---------- Event union (mirrors the spec exactly) ----------

export type AguiErrorCode =
  | 'rbac_denied'
  | 'not_cron_safe'
  | 'validation_failed'
  | 'upstream_timeout'
  | 'internal_error'
  | 'unauthorized'
  // P1-TEAM-a: the token's tenant is no longer the user's Keycloak home (403),
  // or Keycloak could not say (503, retriable) — lib/agent-read-identity.ts.
  | 'tenant_changed'
  | 'identity_unavailable';

export type AguiEvent =
  | {
      type: 'start';
      correlationId: string;
      action: string;
      actionInvocationId: string;
      startedAt: string;
    }
  | {
      type: 'progress';
      correlationId: string;
      message: string;
      fraction?: number;
      meta?: Record<string, unknown>;
    }
  | {
      type: 'pending-approval';
      correlationId: string;
      actionId: string;
      approvalId: string;
      requiredApprovers: string[];
      channel: string;
      callbackUrl?: string;
      /**
       * OPTIONAL because it is sometimes genuinely unknown. It used to be
       * required, and the failure path filled it with `now + 24h` — a deadline
       * with no basis whatsoever, indistinguishable from a real one to every
       * consumer. Absent-and-flagged beats plausible-and-false: a consumer that
       * computes on it now gets an obvious blank instead of acting on fiction.
       */
      expiresAt?: string;
      /**
       * Set when the approval metadata lookup FAILED. The action really is
       * pending — that part is true and must still be reported — but nothing
       * else in this event is known. Without this flag, `requiredApprovers: []`
       * reads as "nobody needs to approve", which is the most dangerous thing
       * this event could say.
       */
      metaUnavailable?: true;
    }
  | {
      type: 'result';
      correlationId: string;
      output: unknown;
    }
  | {
      type: 'error';
      correlationId: string;
      code: AguiErrorCode;
      message: string;
      retriable: boolean;
      meta?: Record<string, unknown>;
    }
  | {
      type: 'done';
      correlationId: string;
      terminal: 'result' | 'pending-approval' | 'error';
    };

// ---------- Helpers ----------

// Secret + audience now come from `lib/agent-token`, which the request-context
// layer also uses. They lived here AND in services/agent-session.ts, so the
// module that MINTS a token and the module that VERIFIES it agreed only by
// care. They agree by construction now.
const getJwtSecret = agentTokenSecret;

/** `meta.reason` of the 401 for an agent token without a `tenant_id` claim (P1-TEAM-a). */
export const AGENT_TOKEN_TENANT_MISSING = 'agent_token_tenant_missing';

export interface VerifiedAgentToken {
  userId: string;
  tenantRoles: string[];
  /**
   * Tenant carried on the agent token (migration 097). `null` for tokens
   * minted before 097 — the invoke path REFUSES those (P1-TEAM-a; the old
   * `getUserTenant` LIMIT-1 fallback is no longer authority).
   */
  tenantId: string | null;
  /**
   * The token was minted from a super-admin workspace switch (George
   * 2026-10-27, `SUPER_ADMIN_SWITCH_CLAIM`): `tenantId` is the ACTIVE workspace,
   * and `agentTenantRefusal` re-checks super_admin instead of the home tenant.
   */
  superAdminSwitch: boolean;
}

// No `project_id` claim (fr-agui SPEC §5.7 rule 2, P1b): never minted, and the
// agent's project is the THREAD's binding, never a token claim.
interface AgentTokenClaims extends JWTPayload {
  tenant_roles?: unknown;
  tenant_id?: unknown;
}

export async function verifyAgentToken(req: Request): Promise<VerifiedAgentToken | null> {
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      audience: AGENT_TOKEN_AUDIENCE,
    });
    const claims = payload as AgentTokenClaims;
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    if (!sub) return null;
    const tenantRoles = Array.isArray(claims.tenant_roles)
      ? claims.tenant_roles.filter((r): r is string => typeof r === 'string')
      : [];
    const tenantId =
      typeof claims.tenant_id === 'string' && claims.tenant_id
        ? claims.tenant_id
        : null;
    return {
      userId: sub,
      tenantRoles,
      tenantId,
      superAdminSwitch: superAdminSwitchFromClaims(claims as Record<string, unknown>),
    };
  } catch {
    return null;
  }
}

const InvokeBodySchema = z.object({
  correlationId: z.string().min(1).optional(),
  // Body MAY include initiator/channel; we coerce both to canonical values.
  initiator: z.literal('agent').optional(),
  channel: z.string().min(1).optional(),
  action: z.string().min(1),
  input: z.unknown(),
});

// Typed thin wrapper over the shared encoder so existing call sites still
// see AguiEvent at the call type level. Keep this — removing the alias
// would force every controller.enqueue site to import from utils/ndjson.
function ndjsonLine(ev: AguiEvent): Uint8Array {
  return encodeNdjson(ev);
}

function isPendingAction(v: unknown): v is PendingAction {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { status?: unknown }).status === 'pending' &&
    typeof (v as { actionId?: unknown }).actionId === 'string'
  );
}

interface PendingMeta {
  approvalId: string;
  requiredApprovers: string[];
  channel: string;
  expiresAt: string;
}

/**
 * Build the `pending-approval` event WITHOUT inventing anything.
 *
 * A pure function, not inline in the SSE handler, because the thing that was
 * wrong here is a decision and decisions need to be testable. The old inline
 * version filled every unknown with a plausible default:
 *
 *   approvalId:        meta?.approvalId ?? ''
 *   requiredApprovers: meta?.requiredApprovers ?? []       <- "nobody need approve"
 *   expiresAt:         meta?.expiresAt ?? now + 24h        <- a deadline with no basis
 *
 * so a failed metadata lookup emitted an event indistinguishable from a real
 * one. An agent reading `requiredApprovers: []` concludes the action needs no
 * approval; anything computing on `expiresAt` acts on fiction.
 *
 * The action IS pending — that half is true and must still be reported, since
 * dropping the event would leave the caller waiting forever. Only the unknown
 * half is marked unknown.
 */
export function buildPendingApprovalEvent(args: {
  correlationId: string;
  actionId: string;
  channel: string;
  meta: PendingMeta | null;
}): Extract<AguiEvent, { type: 'pending-approval' }> {
  const { correlationId, actionId, channel, meta } = args;
  if (!meta) {
    return {
      type: 'pending-approval',
      correlationId,
      actionId,
      approvalId: '',
      requiredApprovers: [],
      channel,
      metaUnavailable: true,
    };
  }
  return {
    type: 'pending-approval',
    correlationId,
    actionId,
    approvalId: meta.approvalId,
    requiredApprovers: meta.requiredApprovers,
    channel: meta.channel ?? channel,
    // Omitted rather than invented when the row carries none.
    ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
  };
}

async function lookupPendingMeta(
  actionId: string,
  fallbackChannel: string,
): Promise<PendingMeta | null> {
  // E-5 stores `action_id` on the approvals row. Required approvers live
  // in their own table keyed by approval_id.
  const rows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.action_id, actionId));
  const row = rows[0];
  if (!row) return null;
  const approverRows = await db
    .select()
    .from(requiredApprovers)
    .where(eq(requiredApprovers.approval_id, row.id));
  const expiresAt =
    row.expires_at instanceof Date
      ? row.expires_at.toISOString()
      : new Date(row.expires_at as unknown as string).toISOString();
  return {
    approvalId: row.id,
    requiredApprovers: approverRows.map((r) => r.user_id),
    channel: row.action_channel ?? row.source ?? fallbackChannel,
    expiresAt,
  };
}

function classifyError(err: unknown): {
  code: AguiErrorCode;
  message: string;
  retriable: boolean;
  meta?: Record<string, unknown>;
} {
  if (err instanceof RbacDeniedError) {
    return {
      code: 'rbac_denied',
      message: 'Caller is not authorized to invoke this action.',
      retriable: false,
    };
  }
  if (err instanceof NotCronSafeError) {
    return {
      code: 'not_cron_safe',
      message: 'Action is not safe to invoke from cron.',
      retriable: false,
    };
  }
  if (err instanceof ActionInputValidationError) {
    return {
      code: 'validation_failed',
      message: 'Action input failed validation.',
      retriable: false,
      meta: err.issues ? { issues: err.issues } : undefined,
    };
  }
  if (err instanceof UnknownActionError) {
    return {
      code: 'validation_failed',
      message: 'Unknown action.',
      retriable: false,
    };
  }
  // fr#1500: a write-action approval on an ARCHIVED project is refused with a
  // 409 `project_archived` (domain/engagement/action-approvals.ts). Without
  // this branch it fell to the default below — `internal_error` +
  // `retriable: true` — so an agent holding a pre-archive token would retry a
  // refusal that can never succeed. Narrow on purpose: only this code.
  if (err instanceof AppError && err.code === PROJECT_ARCHIVED) {
    return {
      code: 'validation_failed',
      message: 'The project is archived; actions on an archived project are refused.',
      retriable: false,
      meta: { code: PROJECT_ARCHIVED },
    };
  }
  // An upstream that answered. `classifyError` previously had no branch for
  // this at all, so every IntegrationError fell to the default below and was
  // reported as `internal_error` + `retriable: true` — including a 404 or a
  // 422, which cannot ever succeed on retry. An agent that honours the flag
  // retries those forever, and one that reads the message is told
  // "Internal error while invoking action" when the real answer was "that id
  // does not exist". Measured 2026-08-26: a 107-action sweep produced 44
  // indistinguishable `internal_error`s, every one of them a 404/422 caused by
  // a bad input id, none of them an fr fault.
  //
  // `upstream_timeout` is in the AguiErrorCode union (E-9) but was NEVER
  // emitted — a protocol code no caller could ever observe. Timeouts arrived
  // as `internal_error` like everything else. It is emitted now.
  //
  // Disclosure: still no upstream body and no upstream message — the existing
  // non-disclosure rule stands. `meta.upstream` carries fr's OWN error
  // taxonomy (`UPSTREAM_NOT_FOUND`, …) and the service name, which the action
  // name already reveals. That is enough for an agent to self-correct without
  // echoing anything the upstream said.
  if (isIntegrationError(err)) {
    // A caller-side refusal: fr never reached an upstream, because the action's
    // OWN input was rejected. Permanence is not a guess here — retrying the
    // same input cannot change the answer.
    //
    // This is the half of #856 that #856 could not fix. Its `permanent` test
    // below reads `err.upstreamStatus`, and a client-input error has none, so
    // every one of these was advertised as `retriable: true` with the message
    // "Internal error while invoking action." An agent that honours the flag
    // retries forever; one that reads the message is told fr broke when the
    // real answer was "your input is malformed". Both halves shared one code
    // (`UPSTREAM_BAD_BODY`) until the caller-side codes existed.
    //
    // `validation_failed` is already in AguiErrorCode and is already emitted
    // for ActionInputValidationError and UnknownActionError, so this is a
    // vocabulary reuse, not a protocol change.
    //
    // Disclosure rule below still holds: no `err.message`, no `upstreamBody`,
    // and no `meta.service` — there is no service to name.
    if (err.code === 'BAD_REQUEST' || err.code === 'BAD_PATH' || err.code === 'PAYLOAD_TOO_LARGE') {
      return {
        code: 'validation_failed',
        message: 'The action input was rejected as invalid; correct the input.',
        retriable: false,
        // `required_params` when the throw site named them. "Correct the input"
        // without saying WHAT is not actionable: an agent cannot self-correct,
        // so it repeats the same call. Disclosing these is consistent with the
        // rule above rather than an exception to it — a caller-side refusal
        // contacted no upstream, so the names are fr's OWN contract and there is
        // nothing external to leak. Still no `err.message` and no `upstreamBody`.
        meta: {
          upstream: err.code,
          ...(err.requiredParams?.length ? { required_params: err.requiredParams } : {}),
        },
      };
    }
    // fr's own invariant, not the caller's input and not an upstream. The
    // fall-through below reads `err.upstreamStatus` to decide permanence, and
    // this code carries none, so without this branch it would be advertised
    // `retriable: true` -- telling an agent to retry a request that will keep
    // failing until somebody sets an env var or fixes a route's validation.
    //
    // `internal_error` (not `validation_failed`): the caller's input was fine,
    // so instructing them to correct it would be a lie. Both codes are already
    // in AguiErrorCode, so this is vocabulary reuse, not a protocol change.
    // The disclosure rule holds -- no `err.message`, no `upstreamBody`, and no
    // `meta.service`, because no service was contacted.
    if (err.code === 'INTERNAL_PRECONDITION') {
      return {
        code: 'internal_error',
        message: 'The action could not be performed due to a server-side fault.',
        retriable: false,
        meta: { upstream: err.code },
      };
    }
    // An optional upstream is not configured on this deployment (feature
    // disabled). No retry can change that, so it is NOT retriable.
    if (err.code === 'SERVICE_NOT_CONFIGURED') {
      return {
        code: 'internal_error',
        message: 'This feature is not available on this deployment.',
        retriable: false,
        meta: { upstream: err.code },
      };
    }
    if (err.code === 'UPSTREAM_TIMEOUT') {
      return {
        code: 'upstream_timeout',
        message: 'Upstream service timed out.',
        retriable: true,
        meta: { upstream: err.code, service: err.service },
      };
    }
    // A 4xx is the upstream saying "this request is wrong", not "try later".
    // Anything else (5xx, unreachable, no status at all) stays retriable —
    // that is the pre-existing assumption and the safe direction to be wrong in.
    const status = err.upstreamStatus;
    const permanent = typeof status === 'number' && status >= 400 && status < 500;
    return {
      code: 'internal_error',
      message: permanent
        ? 'Upstream rejected the request; the input is unlikely to succeed unchanged.'
        : 'Internal error while invoking action.',
      retriable: !permanent,
      meta: { upstream: err.code, service: err.service },
    };
  }

  // Default mapping. Real cause is logged server-side; never echoed to caller.
  return {
    code: 'internal_error',
    message: 'Internal error while invoking action.',
    retriable: true,
  };
}

// ---------- Route handler ----------

export async function handleAguiInvoke(req: Request): Promise<Response> {
  // 1. Auth — must run before any NDJSON byte is written. A 401 here is
  //    a single NDJSON line (per spec §Auth: token revoked → 401 with body).
  const verified = await verifyAgentToken(req);
  if (!verified) {
    const ev: AguiEvent = {
      type: 'error',
      correlationId: req.headers.get('X-Correlation-Id') ?? 'unknown',
      code: 'unauthorized',
      message: 'Missing or invalid agent access token.',
      retriable: false,
    };
    return new Response(JSON.stringify(ev) + '\n', {
      status: 401,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'WWW-Authenticate': `Bearer realm="fr-agent", audience="${AGENT_TOKEN_AUDIENCE}"`,
      },
    });
  }

  // 2. Parse + validate envelope. Pre-stream parse failures map to 400 with
  //    a single NDJSON line; the spec allows this since the body has not
  //    started.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    const cid = req.headers.get('X-Correlation-Id') ?? randomUUID();
    const ev: AguiEvent = {
      type: 'error',
      correlationId: cid,
      code: 'validation_failed',
      message: 'Request body is not valid JSON.',
      retriable: false,
    };
    return new Response(JSON.stringify(ev) + '\n', {
      status: 400,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  }

  const parsedBody = InvokeBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const cid =
      (raw && typeof raw === 'object' && typeof (raw as { correlationId?: unknown }).correlationId === 'string'
        ? (raw as { correlationId: string }).correlationId
        : null) ??
      req.headers.get('X-Correlation-Id') ??
      randomUUID();
    const ev: AguiEvent = {
      type: 'error',
      correlationId: cid,
      code: 'validation_failed',
      message: 'Envelope failed schema validation.',
      retriable: false,
      meta: { issues: parsedBody.error.issues },
    };
    return new Response(JSON.stringify(ev) + '\n', {
      status: 400,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  }

  const body = parsedBody.data;
  const headerCid = req.headers.get('X-Correlation-Id');
  const correlationId = body.correlationId ?? headerCid ?? randomUUID();
  if (body.correlationId && headerCid && body.correlationId !== headerCid) {
    console.warn(
      `[agui/invoke] correlationId mismatch — body=${body.correlationId} header=${headerCid}; body wins.`,
    );
  }
  const channel = body.channel ?? 'agent';

  // Plan 3 follow-up — resolve user → tenant so handlers that scope upstream
  // results via `applyEffectiveFilter` (foundation Plan 2) can run. A miss
  // (`null`) is fine: handlers fall back to unfiltered upstream output. The
  // workspace name (when present) gets threaded through so the lazy
  // `ensureWorkspace` insert seeds a legible name (mirrors PR #239 on the
  // Keycloak-User path).
  // Tenant precedence: the token claim first (migration 097 — sourced from the
  // Keycloak token at session issue), then `user_roles` as the legacy fallback.
  //
  // The fallback ALONE was the bug: measured on prod 2026-08-07, only 13 users
  // in the entire system have a `user_roles` row, so for everyone else
  // `ctx.tenantId` was undefined and every tenant-scoped action
  // (`media.*`, `research.*`) died with `internal_error`,
  // while the SPA worked because it reads `tenant_id` off the Keycloak JWT.
  //
  // ⛔ P1-TEAM-a: THE `getUserTenant` FALLBACK IS NO LONGER AUTHORITY. Since
  // P1-TEAM every member of a tenant may act on every project of that tenant, so
  // the tenant IS the access decision — and `getUserTenant` is a `LIMIT 1` with no
  // `ORDER BY` over `user_roles`, an arbitrary pick for a multi-workspace user.
  // A token minted before migration 097 (no `tenant_id` claim) is therefore
  // REFUSED (401, re-issue the session), never resolved by that pick. The lookup
  // survives only as the source of a DISPLAY name, and only when it names the
  // token's own tenant.
  if (!verified.tenantId) {
    const ev: AguiEvent = {
      type: 'error',
      correlationId,
      code: 'unauthorized',
      message: 'Agent access token carries no tenant (minted before migration 097). Re-issue the agent session.',
      retriable: false,
      meta: { reason: AGENT_TOKEN_TENANT_MISSING },
    };
    return new Response(JSON.stringify(ev) + '\n', {
      status: 401,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'WWW-Authenticate': `Bearer realm="fr-agent", audience="${AGENT_TOKEN_AUDIENCE}"`,
      },
    });
  }
  // ⛔ P1-TEAM-a: the token's tenant was frozen at session issue and grants
  // every project of that tenant. Before ANY action runs, ask Keycloak whether
  // the user is STILL homed there (cached 15 s) — the same gate as the chat
  // turn and the thread routes. Re-homed ⇒ 403 tenant_changed; Keycloak
  // unreadable ⇒ 503 identity_unavailable (fail closed).
  const tenantRefusal = await agentTenantRefusal(verified);
  if (tenantRefusal) {
    const ev: AguiEvent = {
      type: 'error',
      correlationId,
      code: tenantRefusal.code,
      message: tenantRefusal.message,
      retriable: tenantRefusal.status === 503,
    };
    return new Response(JSON.stringify(ev) + '\n', {
      status: tenantRefusal.status,
      headers: { 'Content-Type': 'application/x-ndjson', ...tenantRefusal.headers },
    });
  }
  const tenantId: string = verified.tenantId;
  const tenant = await getUserTenant(verified.userId);
  const tenantName = (tenant?.id === tenantId ? tenant.name?.trim() : undefined) || undefined;

  // ⭐ P1c: marked server-side as the AG-UI rail (agui/context-provenance.ts).
  // Unbound, so only the doorway set is invokable here (agui/agent-surface.ts):
  // the retired tenant rail cannot come back through the direct-invoke door.
  const ctx: ActionContext = markAgentTokenContext({
    userId: verified.userId,
    // `/api/agui/invoke` carries no thread, so it has no bound project (SPEC §5.7):
    // the token's `project_id` claim was never minted and is gone (P1b).
    projectId: null,
    correlationId,
    initiator: 'agent',
    channel,
    tenantRoles: verified.tenantRoles,
    tenantId,
    tenantName,
  });

  const actionInvocationId = `inv_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const action = body.action;

  // Idempotency-Key header is captured for telemetry/log breadcrumb here;
  // the registry's per-action idempotencyKey() always provides the storage
  // key. Surfacing the explicit header onto the cache layer is reserved
  // for a follow-up — not in the E-9 freeze.
  const idemHeader =
    req.headers.get('Idempotency-Key') ??
    req.headers.get('idempotency-key') ??
    null;

  // 3. Build the NDJSON stream. Always emits start + (terminal) + done.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: AguiEvent): void => {
        controller.enqueue(ndjsonLine(ev));
      };

      emit({
        type: 'start',
        correlationId,
        action,
        actionInvocationId,
        startedAt,
      });

      let terminal: 'result' | 'pending-approval' | 'error' = 'error';
      try {
        // Wrap in withRequestContext so spans (E-1) emitted via
        // emitSpan -> getCorrelationId() see the active correlation id from
        // AsyncLocalStorage instead of falling back to undefined.
        // The ALS frame is what `integrations/_lib/http-client` reads to set
        // `X-Tenant-Id` / `X-User-Id` / `X-Subject-Id` on every outbound call.
        // It used to carry only the correlation id (added for spans), so every
        // agui-invoked action reached tenant-scoped upstreams with NO tenant
        // header — and http-client's own comment says what those upstreams then
        // do: "fall back to DEFAULT_TENANT_ID and serve the wrong tenant's
        // data."
        //
        // That is not hypothetical. Measured 2026-08-27: `kag.list_sessions`
        // invoked by a user in tenant …0099 returned FIVE rows — exactly the
        // row count of kag's `DEFAULT_TENANT_ID` (…0001) — while that user's own
        // tenant has two. A cross-tenant read, returned as a clean 200.
        //
        // Handlers that read `ctx.tenantId` were unaffected, which is why this
        // hid: actions like `requirements.list` return identical rows on both
        // paths. Only header-dependent upstreams diverge.
        //
        // `bearerToken` stays absent ON PURPOSE — the agent token is an HS256
        // `aud=fr-agent` credential, not a Keycloak JWT, and must never be
        // forwarded upstream.
        const out = await withRequestContext(
          {
            correlationId,
            initiator: 'agent',
            channel,
            tenantId,
            userId: verified.userId,
            subjectId: verified.userId,
            // George 2026-10-27: a switched super_admin's Copilot — the registry audits each
            // WRITE action (lib/super-admin-tenant-audit.ts).
            ...(verified.superAdminSwitch ? { agentSuperAdminSwitch: true } : {}),
          },
          () => invokeAction(action, body.input, ctx),
        );
        if (isPendingAction(out)) {
          let meta: PendingMeta | null = null;
          try {
            meta = await lookupPendingMeta(out.actionId, channel);
          } catch (err) {
            console.error(
              `[agui/invoke] failed to look up pending approval meta for actionId=${out.actionId}:`,
              err,
            );
          }
          emit(
            buildPendingApprovalEvent({
              correlationId,
              actionId: out.actionId,
              channel,
              meta,
            }),
          );
          terminal = 'pending-approval';
        } else {
          emit({ type: 'result', correlationId, output: out });
          terminal = 'result';
        }
      } catch (err) {
        const classified = classifyError(err);
        if (classified.code === 'internal_error') {
          // Log full cause server-side; don't echo to agent.
          console.error(
            `[agui/invoke] internal_error for action=${action} cid=${correlationId} idem=${idemHeader ?? '<none>'}:`,
            err,
          );
        }
        emit({
          type: 'error',
          correlationId,
          code: classified.code,
          message: classified.message,
          retriable: classified.retriable,
          ...(classified.meta ? { meta: classified.meta } : {}),
        });
        terminal = 'error';
      }

      emit({ type: 'done', correlationId, terminal });
      controller.close();
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

// ---------- GET /api/agui/actions ----------
//
// Spec: docs/superpowers/specs/completed/2026-04-24-kag-ingestion-ui.md §8.4
//   "Mount GET /api/agui/actions returning the catalog for operator debugging."
//
// Public read of the AG-UI registry catalog. Used by humans and tooling to
// discover what actions are registered, their kind, approval policy, whether
// they're cronSafe, and a brief description. Does NOT include zod schemas
// because the in-process schema objects are not JSON-serializable; consumers
// that need a JSON schema should derive one client-side from the action name.
export async function handleListAguiActions(_req: Request): Promise<Response> {
  const all = listActions();
  const data = all.map((a) => ({
    name: a.name,
    kind: a.kind,
    description: a.description,
    approval: a.approval,
    cronSafe: a.cronSafe,
  }));
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
