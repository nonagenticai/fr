// src/routes/notifications/dispatch.ts
//
// POST /api/notifications/dispatch — the decoupled communication-hub seam.
//
// Why this exists
// ----------------
// The original architecture routes ALL outbound communication through fr: a
// caller asks fr to notify, and fr routes per the recipient's channel prefs
// (telegram / email / websocket / …) and surfaces it in the fr frontend. n8n
// owning a messaging channel of its own was the deviation; with this endpoint
// the n8n notification workflows (and any other service) POST here instead of
// holding a messaging channel themselves.
//
// Two routing modes (exactly one required):
//   - `recipientUserId`  → fan out via the user's enabled channel prefs
//     (the clean per-user path; mirrors how approvals dispatch).
//   - `channel` + `address` → send to one explicit target (e.g. post to the
//     telegram ops/group chat) without a user mapping — the "broadcast to
//     another service" case.
//
// LICENCE callers (George 2026-10-10): admitted, TENANT-BOUND, user-prefs mode
// only — see `assertLicenceDispatchAllowed` below and the route's entry in
// lib/licence-route-allowlist.ts. Everything that follows describes the
// Keycloak-JWT / system-token door, which is unchanged.
//
// Internal-tenant only. Unlike the sibling `POST /api/notifications/inapp`
// (which uses the narrower `requireInternalTenant`), this route admits the
// SYSTEM tenant too — all four reserved workspaces, via
// `requireAnyInternalTenant`. It writes to no per-kind substrate, so it has no
// reason to exclude system. The execution tenant and all customer tenants still
// get 404.
//
// Callers, as measured on the live n8n instance 2026-08-10 (255 workflows
// scanned). Three active workflows drive this endpoint through the fr n8n node,
// all three pinning `tenantIdOverride` to the system tenant:
//   - "AA Maintenance - Router Health Check" (bfk9c8Bp8071j0FM) — 5-min cron,
//     dispatches only when the router probe fails.
//   - "AA Pattern - Send Notification" (RDH1DDr1fB43Gq5Z).
//   - "AA Activity - Action" (dqLCes2bQA0eMXsi).
// The first two authenticate with a `system-workflow-operator` password-grant
// token (realm `portal`, client `portal-bff`) minted by a preceding Mint Token
// node; that token's Keycloak `tenant_id` claim IS the system tenant, which is
// how the system tenant reaches this handler. The third sets NO
// `bearerTokenOverride` and rides the static bearer in the `frApi` credential,
// whose identity is not asserted here.
//
// Only Router Health Check is known to have actually exercised the path: its 2
// non-success executions correspond exactly to the 2 HTTP 500s observed in the
// fr pod. Pattern - Send Notification had zero executions on record; Activity -
// Action had 3 in 30 days. So "every ops alert was lost" is a claim about that
// one workflow's 2 alerts, not about hundreds.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { handle } from '../assets/_lib/handler';
import { validateAuth } from '../../middleware/auth';
import { requireAnyInternalTenant } from '../../middleware/internal-tenant-only';
import { jsonResponse } from '../../utils/response';
import { BadRequestError, ForbiddenError, UnauthorizedError } from '../../utils/errors';
import { userRolesService } from '../../services/user-roles';
import { emitSpan } from '../../telemetry/spans';
import {
  notificationService,
  type ChannelMessage,
} from '../../domain/engagement/notifications';

export const dispatchSchema = z
  .object({
    recipientUserId: z.string().uuid().optional(),
    channel: z.enum(['teams', 'telegram', 'websocket', 'email', 'voice', 'inapp']).optional(),
    address: z.string().min(1).max(512).optional(),
    // Payload — `kind` defaults to a plain text notification.
    kind: z.enum(['text', 'action-result', 'action-error']).optional().default('text'),
    text: z.string().min(1).max(10_000),
    correlationId: z.string().min(1).max(200).optional(),
    actionId: z.string().min(1).max(200).optional(),
    engagementType: z.string().min(1).max(64).optional(),
  })
  .refine(
    (b) => !!b.recipientUserId || (!!b.channel && !!b.address),
    { message: 'Provide recipientUserId, or both channel and address' },
  )
  .refine(
    (b) => b.kind === 'text' || !!b.actionId,
    { message: 'action-result/action-error require actionId' },
  );

type DispatchBody = z.infer<typeof dispatchSchema>;

/** Build a typed ChannelMessage from the validated body. */
export function buildMessage(body: DispatchBody): ChannelMessage {
  const correlationId = body.correlationId ?? '';
  if (body.kind === 'text') {
    return { kind: 'text', correlationId, text: body.text };
  }
  // action-result / action-error — actionId guaranteed by the schema refine.
  return {
    kind: body.kind,
    correlationId,
    text: body.text,
    meta: { actionId: body.actionId as string },
  };
}

/**
 * POST /api/notifications/dispatch
 *
 * Returns 202 { queued: true } once the send has been issued; the endpoint
 * never blocks the caller on the channel outcome.
 *
 * Durability differs by routing mode, and 202 does NOT imply a delivery record:
 *   - `recipientUserId` → `fanOutMessageToUser` writes one engagement_deliveries
 *     row per attempt (success, failure and skipped_disabled alike).
 *   - `channel` + `address` → writes NOTHING. The adapter's SendResult is
 *     dropped on the floor; a transport failure is invisible apart from the
 *     console.error below. This is the mode every current n8n caller uses, so
 *     today a lost telegram alert leaves no durable trace.
 *
 * Authorization:
 *   - validateAuth (Keycloak / licence / AUTH_BYPASS in tests)
 *   - Keycloak JWT / system token: requireAnyInternalTenant — system + the
 *     three improvement workspaces. Anyone else gets 404 (the 404-not-403
 *     convention used across the rest of the improvement-loop surface).
 *   - LICENCE caller (George 2026-10-10, the tenant's conveyor seat): TENANT-
 *     BOUND, user-prefs mode ONLY — see `assertLicenceDispatchAllowed`.
 */
const LICENCE_RAW_ADDRESS_FORBIDDEN_CODE = 'licence_raw_address_forbidden' as const;
const LICENCE_RECIPIENT_NOT_IN_TENANT_CODE = 'licence_recipient_not_in_tenant' as const;
const LICENCE_ENGAGEMENT_TYPE_FORBIDDEN_CODE = 'licence_engagement_type_forbidden' as const;
const LICENCE_CORRELATION_ID_INVALID_CODE = 'licence_correlation_id_invalid' as const;
const LICENCE_REPLY_TAG_FORBIDDEN_CODE = 'licence_reply_tag_forbidden' as const;

/**
 * The ONLY `engagement_deliveries.engagement_type` a licence notification is
 * written under. Deliberately NOT 'notification' (the JWT default) so licence
 * rows stay distinguishable from system rows, and NOT any value a system
 * reader keys on: 'approval' (approval-redelivery NO_CONFIRMED_DELIVERY,
 * telegram reply binder), 'approval-backlog-digest' (digest suppression),
 * 'action', 'execution-event', 'comment_mention', 'scheduled_report', 'runtime'.
 * A licence body may omit `engagementType` or send exactly this value; any
 * other value is refused (403 `licence_engagement_type_forbidden`).
 */
export const LICENCE_NOTIFICATION_ENGAGEMENT_TYPE = 'licence_notification' as const;

/**
 * The caller-chosen part of a licence correlation id. The stored value is
 * always `licence:<tenantId>:<part>` (see `licenceCorrelationId`), so it can
 * never equal an approval UUID (`engagement_id = approvals.id::text` joins in
 * approval-redelivery, approval-routing.confirmPushDelivery, the telegram reply
 * binder and engagements/deliveries) nor a system constant such as
 * 'approval-backlog-digest'. 45 chars of prefix + 128 stays under the 200 the
 * schema allows.
 */
const LICENCE_CORRELATION_PART_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A licence text may carry NO bracketed machine tag — the CLASS `[<word>:`, not a list
 * of today's tags (validator NO on 9a1872db: refusing only `[ApprovalId:` left
 * `[AnswerFor:` open).
 *
 * Why: every inbound reply parser binds a human's reply to an approval by reading a
 * `[<Name>:<uuid>]` tag out of the QUOTED message, i.e. out of text WE sent. Measured on
 * this branch, the accepted forms are:
 *   - `[ApprovalId:<uuid>]` — `domain/engagement/channel-reply.ts` `extractApprovalId`
 *     (via `looksLikeApprovalTraffic`, and the channels/telegram adapter), quoted text →
 *     decides that approval.
 *   - `[AnswerFor:<uuid>]` — NO READER ANY MORE (the Telegram follow-up ask it belonged to
 *     was deleted 2026-10-31), refused anyway so a future reader cannot be fed a
 *     licence-chosen value.
 *   - `[cid:<id>]` — emitted by the telegram/email adapters; no inbound parser reads it
 *     today, refused anyway so a future reader cannot be fed a licence-chosen value.
 * All are ASCII `[` + identifier + `:`; no parser NFKC-normalises or entity-decodes
 * (adapters send plain text, no parse_mode), so a look-alike bracket cannot match a parser
 * and is not a tag. Whitespace and case are tolerated here although the parsers do not, so
 * this set is a strict superset of what any parser accepts.
 *
 * Boundary: the colon right after an identifier is what makes it a key:value tag. Ordinary
 * bracketed prose — `[draft] hello`, `see [1]`, `[WIP]`, `[x]`, `[1: foo]` (identifier
 * must start with a letter) — is accepted. `[note: …]` is refused; a licence has no need
 * for the tag grammar the reply binders consume.
 *
 * NOT covered here, by design: the telegram `#<8+ hex>` short ref is read only from the
 * human's OWN typed message head and only when it is not a reply (`extractShortRef`,
 * `!isReplyToOther`), and the untagged DM binder resolves only approval deliveries — a
 * licence row is always `licence_notification`. Neither reads the quoted licence text.
 */
const REPLY_TAG_RE = /\[\s*[A-Za-z][\w-]*\s*:/i;

/**
 * Attribution (George 2026-10-10): a licence notification is delivered on EVERY channel
 * prefixed with who sent it, so a tenant workflow's text never goes out in fr's own
 * voice. Plain words and a colon after a multi-word phrase — deliberately NOT a
 * `[<word>:` tag (REPLY_TAG_RE), so the prefix itself can never be read by a reply
 * parser. The JWT/system path never adds it.
 */
function licenceAttributionPrefix(tenantId: string): string {
  return `From tenant ${tenantId} workflow: `;
}

function licenceCorrelationId(tenantId: string, callerPart: string | undefined): string {
  return `licence:${tenantId}:${callerPart ?? randomUUID()}`;
}

/**
 * Licence-only constraints on the fields that are PERSISTED or used as a key
 * (George 2026-10-10 validator NO on e8a0f45e). Pure; runs before any read or
 * send. Returns the body the shared `dispatch` sends, with the engagement type
 * forced and the correlation id namespaced. The JWT path never calls this.
 */
function constrainLicenceDispatchBody(body: DispatchBody, tenantId: string): DispatchBody {
  if (body.engagementType !== undefined && body.engagementType !== LICENCE_NOTIFICATION_ENGAGEMENT_TYPE) {
    throw new ForbiddenError(
      `A licence caller may not choose the engagement type; omit engagementType (it is always '${LICENCE_NOTIFICATION_ENGAGEMENT_TYPE}'). Nothing was sent`,
    ).withCode(LICENCE_ENGAGEMENT_TYPE_FORBIDDEN_CODE);
  }
  if (body.correlationId !== undefined && !LICENCE_CORRELATION_PART_RE.test(body.correlationId)) {
    throw new BadRequestError(
      'correlationId for a licence caller must be 1-128 characters of [A-Za-z0-9._-]; it is stored as licence:<tenant>:<correlationId>. Nothing was sent',
    ).withCode(LICENCE_CORRELATION_ID_INVALID_CODE);
  }
  if (REPLY_TAG_RE.test(body.text)) {
    throw new ForbiddenError(
      'A licence notification may not carry a bracketed machine tag such as [ApprovalId:…] or [AnswerFor:…] (any "[<word>:"); ' +
        'replies quoting it would be bound by the reply parsers. Nothing was sent',
    ).withCode(LICENCE_REPLY_TAG_FORBIDDEN_CODE);
  }
  return {
    ...body,
    text: `${licenceAttributionPrefix(tenantId)}${body.text}`,
    engagementType: LICENCE_NOTIFICATION_ENGAGEMENT_TYPE,
    correlationId: licenceCorrelationId(tenantId, body.correlationId),
  };
}

/**
 * The licence door on this route (George 2026-10-10). A licence is a customer
 * tenant's conveyor seat, so it gets exactly ONE of the two routing modes:
 *
 *   - `channel` + `address` (raw mode) ⇒ 403 `licence_raw_address_forbidden`.
 *     Paging an arbitrary chat id / phone number / mailbox is a SYSTEM power;
 *     any `channel` or `address` field on a licence request is refused, even
 *     alongside a `recipientUserId`, so the body cannot be read two ways.
 *   - `recipientUserId` ⇒ the recipient must hold a workspace role
 *     (`workspace-admin` or `workspace-member`) in `user_roles` for the
 *     licence's tenant — the same membership test the tenant-admin lanes use
 *     (routes/project-knowledge-allocation.ts, workspace/knowledge-areas.ts).
 *     Otherwise 403 `licence_recipient_not_in_tenant`, with ONE message for
 *     "member of another tenant" and "no such user": only the licence's own
 *     tenant is queried, so the answer cannot leak another tenant's roster.
 *
 * Both refusals happen before any send or delivery-row write.
 */
async function assertLicenceDispatchAllowed(body: DispatchBody, tenantId: string): Promise<void> {
  if (body.channel !== undefined || body.address !== undefined) {
    throw new ForbiddenError(
      'A licence caller may dispatch only to a user of its own tenant (recipientUserId, routed by that user\'s channel preferences); ' +
        'the raw channel + address mode is not available to a licence. Nothing was sent',
    ).withCode(LICENCE_RAW_ADDRESS_FORBIDDEN_CODE);
  }
  const recipient = body.recipientUserId as string; // schema refine: present when no channel/address
  const roles = await Promise.all(
    ['workspace-admin', 'workspace-member'].map((role) => userRolesService.hasRole(recipient, tenantId, role)),
  );
  if (!roles.some(Boolean)) {
    throw new ForbiddenError(
      "recipientUserId is not a member of the licence's tenant; a licence caller may notify only its own tenant's users. Nothing was sent",
    ).withCode(LICENCE_RECIPIENT_NOT_IN_TENANT_CODE);
  }
}

export async function handleDispatchNotification(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(
      { error: 'Validation error', details: [{ message: 'Invalid JSON body' }] },
      422,
    );
  }
  const parsed = dispatchSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'Validation error', details: parsed.error.errors }, 422);
  }
  const body = parsed.data;

  // Everything below runs inside `handle()` so the internal-tenant gate's
  // IntegrationError is rendered as its intended 404 instead of escaping the
  // handler and being caught by server.ts's generic catch as a 500 — which is
  // exactly what happened to every ops alert before this wrapper existed.
  // Zod validation stays OUTSIDE it (above) so a bad body still returns 422
  // rather than being remapped; same ordering constraint inapp.ts documents.
  if (user.authKind === 'licence') {
    // Licence door: tenant-pinned identity (lib/licence-introspect.ts). No
    // internal-tenant gate — a licence's tenant is a customer tenant by design;
    // the binding is the recipient check below instead.
    if (!user.tenantId) {
      throw new UnauthorizedError('Licence identity carries no tenant');
    }
    const licenceTenant = user.tenantId.toLowerCase();
    const licenceBody = constrainLicenceDispatchBody(body, licenceTenant);
    await assertLicenceDispatchAllowed(licenceBody, licenceTenant);
    return handle(() => dispatch(licenceTenant, licenceBody), (res) => res);
  }

  return handle(
    async () => {
      const tenant = requireAnyInternalTenant('fr-notifications-dispatch');
      return dispatch(tenant, body);
    },
    (res) => res,
  );
}

/** The send itself, shared by both doors. Always returns a Response (see emitSpan note). */
async function dispatch(tenant: string, body: DispatchBody): Promise<Response> {
  const message = buildMessage(body);
  const engagementType = body.engagementType ?? 'notification';

  return emitSpan(
    'notifications.dispatch',
    {
      tenant_id: tenant,
      mode: body.recipientUserId ? 'user' : 'direct',
      channel: body.channel ?? null,
      kind: body.kind,
    },
    // MUST return a Response. `emitSpan` gates everything it knows about
    // failure on `result instanceof Response` (telemetry/spans.ts): the
    // log line's `status` field, and on the OTel span the ERROR status,
    // the `outcome` attribute and `http.status_code`. Hand it a plain
    // value instead and all of that reverts to "success" — a 422 stops
    // being visible as an error on the one endpoint whose whole job is
    // raising ops alerts. `handle()`'s responder (in the caller) is therefore the
    // identity function, not a mapper. Do not "clean up"
    // this Response into a value object.
    async (): Promise<Response> => {
      if (body.recipientUserId) {
        const outcomes = await notificationService.fanOutMessageToUser(
          body.recipientUserId,
          message,
          engagementType,
        );
        // A licence notification is recorded BEFORE it is sent; a channel whose record could
        // not be written sent nothing, and the caller is told which (validator 6).
        const notSent = outcomes
          .filter((o) => o.status === 'not_sent')
          .map((o) => ({ channel: o.channel, error: o.error ?? 'delivery_record_failed' }));
        if (notSent.length > 0) return jsonResponse({ queued: true, notSent }, 202);
      } else {
        // Direct single-channel target.
        const channel = notificationService.getChannel(body.channel as string);
        if (!channel) {
          return jsonResponse(
            { error: `channel '${body.channel}' not registered` },
            422,
          );
        }
        // Fire-and-record: adapters never throw, but guard anyway.
        await channel.sendMessage(body.address as string, message).catch((err) => {
          console.error('[notifications.dispatch] direct send error:', err);
        });
      }
      return jsonResponse({ queued: true }, 202);
    },
  );
}
