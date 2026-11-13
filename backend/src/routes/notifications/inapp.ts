// src/routes/notifications/inapp.ts
//
// POST /api/notifications/inapp — outbound admin notification entry point
// for the n8n improvement-loop done.json workflows. Internal-tenant only
// (one of the three reserved improvement workspaces — workflow, prompt and,
// since migration 066, procedure; see `middleware/internal-tenant-only.ts`).
// The system tenant is NOT admitted here; the sibling
// `POST /api/notifications/dispatch` uses the wider `requireAnyInternalTenant`
// because it has no per-kind substrate to write to.
//
// Why this exists
// ----------------
// The pre-existing `POST /api/inapp/messages` is an *inbound* chat-message
// receiver: it persists with `direction='inbound'`, hard-rejects any
// `userId` that isn't the authenticated caller's, and dispatches to the
// channel router. It cannot be used by an admin/system identity to deliver
// a notification *to* an arbitrary recipient (e.g. a card owner).
//
// The internal `inappAdapter.sendMessage` path in `src/channels/inapp.ts`
// already does the right durable-write (`direction='outbound'`) but is
// only callable from inside the channel dispatcher. This route exposes
// that capability over HTTP behind strict authz, so an improvement-loop
// subflow can post `{subject, body, level, link_url}` to the card owner
// without being able to talk to any other surface.
//
// ⚠️ This route currently has NO caller. A scan of all 255 workflows on the
// live n8n instance (2026-08-10) found zero references to
// `notifications/inapp`, and the `@nonagentic/n8n-nodes-fr` node exposes
// exactly one notification operation — `notifications/dispatch` — so no
// workflow can even address this endpoint through the fr node today. The
// header previously claimed "the eight improvement-loop done.json subflows"
// post here; that was never true. Treat this as an unwired capability, not
// as a live path, until a caller actually exists.
//
// The persisted shape mirrors `InAppAdapter.persistOutbound`: the public
// scalars (`subject`, `level`, `link_url`) land in `meta_json` so the
// in-app inbox UI can render them; `text` carries the body. This keeps a
// single column shape across all outbound writes.

import type { z } from 'zod';

import { handle } from '../assets/_lib/handler';
import { validateAuth } from '../../middleware/auth';
import { requireAnyInternalTenant } from '../../middleware/internal-tenant-only';
import { IntegrationError } from '../../integrations/_lib/errors';
import { jsonResponse } from '../../utils/response';
import { emitSpan } from '../../telemetry/spans';
import { db, inappMessages } from '../../db/client';
import { sendInappNotificationSchema } from './inapp-schemas';

// The body schema lives in `./inapp-schemas` (shared with the fr-agui P4b
// capability declaration, so the declared input IS the route's).

type SendInappNotificationBody = z.infer<typeof sendInappNotificationSchema>;

/**
 * POST /api/notifications/inapp
 *
 * Body:
 *   {
 *     recipientUserId: uuid,         // required — recipient (card owner)
 *     subject: string,               // required — short title (<=200)
 *     body: string,                  // required — message body (<=10k)
 *     level?: 'info'|'warn'|'error', // optional, default 'info'
 *     linkUrl?: string,              // optional, deep link (<=1000)
 *     correlationId?: string,        // optional, for tracing
 *     streamId?: uuid,               // optional, kaizen stream id
 *   }
 *
 * Returns 202 { id, queued: true } on success. Persists one row with
 * `direction='outbound'` to `inapp_messages`.
 *
 * Authorization:
 *   - validateAuth (Keycloak / AUTH_BYPASS in tests)
 *   - requireAnyInternalTenant — only an internal tenant (system) may
 *     post here (the three improvement tenants that used to were deleted
 *     2026-11-03); every other tenant gets 404 (the 404-not-403
 *     convention used across the internal surfaces).
 */
export async function handleSendInappNotification(req: Request): Promise<Response> {
  await validateAuth(req);

  // Schema validation runs OUTSIDE the IntegrationError-mapped `handle()`
  // wrapper because the test contract for this surface is 422-on-bad-body
  // (instead of the UPSTREAM_BAD_BODY → 502 mapping the rest of the
  // library/improvement routes happen to use). Keeping validation here
  // also lets us emit a structured `details` array directly from Zod.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(
      { error: 'Validation error', details: [{ message: 'Invalid JSON body' }] },
      422,
    );
  }
  const parsed = sendInappNotificationSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'Validation error', details: parsed.error.errors },
      422,
    );
  }
  const body: SendInappNotificationBody = parsed.data;

  return handle(
    async () => {
      const tenant = requireAnyInternalTenant('fr-notifications-inapp');

      return emitSpan(
        'notifications.inapp.send',
        {
          tenant_id: tenant,
          recipient_user_id: body.recipientUserId,
          level: body.level,
          stream_id: body.streamId ?? null,
        },
        async () => {
          // Persist a single outbound row. Mirrors the column shape used
          // by `InAppAdapter.persistOutbound` so the inbox UI doesn't
          // need a second branch to render admin notifications:
          //   - `text` carries the body
          //   - `meta_json` carries kind + subject + level + link + ids
          const meta: Record<string, unknown> = {
            kind: 'admin-notification',
            subject: body.subject,
            level: body.level,
          };
          if (body.linkUrl) meta['link_url'] = body.linkUrl;
          if (body.streamId) meta['stream_id'] = body.streamId;
          if (body.correlationId) meta['correlation_id'] = body.correlationId;
          // Tenant is recorded for audit (which improvement loop posted
          // this) — useful when the in-app inbox surfaces a "from" badge.
          meta['posted_by_tenant'] = tenant;

          const inserted = await db
            .insert(inappMessages)
            .values({
              user_id: body.recipientUserId,
              direction: 'outbound',
              text: body.body,
              correlation_id: body.correlationId ?? null,
              meta_json: meta,
            })
            .returning({ id: inappMessages.id });

          const row = inserted[0];
          if (!row) {
            throw new IntegrationError({
              code: 'UPSTREAM_BAD_STATUS',
              message: 'inapp_messages insert returned no rows',
              service: 'fr-notifications-inapp',
            });
          }
          return row;
        },
      );
    },
    (row) => jsonResponse({ id: row.id, queued: true }, 202),
  );
}
