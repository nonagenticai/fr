import { encodePath, type PlankaHttp } from './http';
import type { List, Single, CreateListInput } from './types';

export class ListsResource {
  constructor(private readonly http: PlankaHttp) {}

  // Planka 2.1.0 requires `position` on create. Caller-supplied stays;
  // otherwise we default — Planka resolves collisions internally.
  static readonly DEFAULT_POSITION = 65536;

  async create(input: CreateListInput): Promise<List> {
    const res = await this.http.request<Single<List>>(
      'POST',
      `/api/boards/${encodePath(input.boardId)}/lists`,
      {
        body: {
          name: input.name,
          position: input.position ?? ListsResource.DEFAULT_POSITION,
          type: input.type ?? 'active',
        },
      },
    );
    return res.item;
  }

  async update(id: string, patch: { name?: string; position?: number }): Promise<List> {
    const res = await this.http.request<Single<List>>(
      'PATCH',
      `/api/lists/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/lists/${encodePath(id)}`, {});
  }

  /** Spec 2 §4.5 — fetch a list to resolve its boardId for the
   *  card-create shape gate. Planka returns `{ item: List }` here. */
  async get(id: string): Promise<List> {
    const res = await this.http.request<Single<List>>(
      'GET',
      `/api/lists/${encodePath(id)}`,
      {},
    );
    return res.item;
  }

  async listByBoard(boardId: string): Promise<List[]> {
    const board = await this.http.request<{ included: { lists?: List[] } }>(
      'GET',
      `/api/boards/${encodePath(boardId)}`,
      {},
    );
    return board.included.lists ?? [];
  }
}
