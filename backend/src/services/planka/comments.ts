import { encodePath, type PlankaHttp } from './http';
import type { Comment, Single, Many, CreateCommentInput, UpdateCommentInput } from './types';

export class CommentsResource {
  constructor(private readonly http: PlankaHttp) {}

  /**
   * One PAGE of a card's comments, newest first. Planka paginates this
   * endpoint: pass the last id of the previous page as `beforeId` to read the
   * next one. A caller that must see EVERY comment (e.g. an idempotency scan)
   * has to walk the pages — the first page alone is not the whole thread.
   */
  async listForCard(cardId: string, opts: { beforeId?: string } = {}): Promise<Comment[]> {
    const res = await this.http.request<Many<Comment>>(
      'GET',
      `/api/cards/${encodePath(cardId)}/comments`,
      opts.beforeId ? { query: { beforeId: opts.beforeId } } : {},
    );
    return res.items;
  }

  async create(input: CreateCommentInput): Promise<Comment> {
    const res = await this.http.request<Single<Comment>>(
      'POST',
      `/api/cards/${encodePath(input.cardId)}/comments`,
      { body: { text: input.text } },
    );
    return res.item;
  }

  async update(id: string, patch: UpdateCommentInput): Promise<Comment> {
    const res = await this.http.request<Single<Comment>>(
      'PATCH',
      `/api/comments/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/comments/${encodePath(id)}`, {});
  }
}
