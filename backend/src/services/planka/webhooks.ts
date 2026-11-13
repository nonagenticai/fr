import { encodePath, type PlankaHttp } from './http';
import type { Single, Many } from './types';

/** A Planka webhook row as the admin API presents it (the access token never leaves Planka). */
export interface PlankaWebhook {
  id: string;
  name: string;
  /** Boards the webhook is subscribed to (planka-private#24: delivery is opt-in per board). */
  boardIds?: string[];
}

export class WebhooksResource {
  constructor(private readonly http: PlankaHttp) {}

  // Admin only.
  async list(): Promise<PlankaWebhook[]> {
    const res = await this.http.request<Many<PlankaWebhook>>('GET', '/api/webhooks', {});
    return res.items ?? [];
  }

  // Subscribe the webhook to a board. Atomic and idempotent on the Planka side. Admin only.
  async addBoard(webhookId: string, boardId: string): Promise<PlankaWebhook> {
    const res = await this.http.request<Single<PlankaWebhook>>(
      'POST',
      `/api/webhooks/${encodePath(webhookId)}/boards`,
      { body: { boardId } },
    );
    return res.item;
  }
}
