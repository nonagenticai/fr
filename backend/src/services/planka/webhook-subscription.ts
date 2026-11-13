// Subscribe a NEW board to the n8n instance that serves it (planka-private#24).
//
// Planka webhook delivery is OPT-IN per board (George 2026-11-04): a webhook
// fires only for events of a board in its `boardIds`, so a board fr creates is
// silent until fr subscribes it. Before this, every board's events went to every
// webhook: kata replay cards fired the live conveyor flows, and conveyor cards
// reached kata-n8n.
//
//   board owned by the kata tenant      → the kata-n8n webhook  (wf_change.*)
//   board owned by another platform tenant → the conveyor n8n webhook
//   any other tenant                    → nothing (the conveyor never serves it,
//                                          same gate as conveyor-membership.ts)
//
// The webhook is found by NAME (config) and subscribed with
// `POST /api/webhooks/:id/boards`, so fr never handles the webhook's access
// token. Idempotent on the Planka side.
//
// ⛔ THROWS a PlankaError on failure (unlike the membership grant): a board
// nothing is subscribed to never runs a single flow, and nothing would notice.
// The intake's compensation tears the half-built project down and the create
// fails 502 `planka_intake_failed`, retryable.
//
// Callers: planka/intake.ts (projects, kata opens) and streams/provisioner.ts
// (asset streams). NOT subscribed: boards from the super-admin
// `kanban_assets.create_board` passthrough — it has no owning tenant, so no
// instance can be chosen; subscribe such a board by hand if a flow must serve it.
// `boardCreate` is never delivered for these boards (the board exists before it
// is subscribed); no flow consumes it.
import { config } from '../../config';
import { isPlatformTenant, KATA_TENANT_ID } from '../../middleware/internal-tenant-only';
import { PlankaError } from './errors';
import type { PlankaWebhook } from './webhooks';

export interface WebhookSubscriptionAgent {
  webhooks: {
    list(): Promise<PlankaWebhook[]>;
    addBoard(webhookId: string, boardId: string): Promise<PlankaWebhook>;
  };
}

export type WebhookSubscriptionResult =
  | { subscribed: string }
  | { skipped: 'not_platform' };

/** The webhook name serving boards of this tenant, or null when none does. */
export function webhookNameFor(tenantId: string | null | undefined): string | null {
  if (tenantId === KATA_TENANT_ID) return config.services.planka.kataWebhookName;
  if (isPlatformTenant(tenantId)) return config.services.planka.conveyorWebhookName;
  return null;
}

export async function ensureWebhookSubscription(
  agent: WebhookSubscriptionAgent,
  params: { boardId: string; tenantId?: string | null },
): Promise<WebhookSubscriptionResult> {
  const { boardId, tenantId } = params;
  const name = webhookNameFor(tenantId);
  if (!name) {
    console.info(
      `[planka.webhook-subscription] skipped board=${boardId} tenant=${tenantId ?? 'none'} reason=not_platform`,
    );
    return { skipped: 'not_platform' };
  }

  const matches = (await agent.webhooks.list()).filter((webhook) => webhook.name === name);
  if (matches.length !== 1) {
    throw new PlankaError(
      `[planka.webhook-subscription] board=${boardId}: expected exactly one Planka webhook named ` +
        `'${name}', found ${matches.length} — the board would receive no events`,
      { status: 502, code: 'webhook_subscription_failed', path: '/api/webhooks' },
    );
  }

  const webhook = matches[0]!;
  const item = await agent.webhooks.addBoard(webhook.id, boardId);
  if (!(item.boardIds ?? []).map(String).includes(String(boardId))) {
    throw new PlankaError(
      `[planka.webhook-subscription] board=${boardId}: webhook '${name}' did not record the subscription`,
      { status: 502, code: 'webhook_subscription_failed', path: `/api/webhooks/${webhook.id}/boards` },
    );
  }
  return { subscribed: name };
}
