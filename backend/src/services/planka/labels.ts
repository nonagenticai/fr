import { encodePath, type PlankaHttp } from './http';
import type { Label, Single, CreateLabelInput } from './types';

export class LabelsResource {
  constructor(private readonly http: PlankaHttp) {}

  async create(input: CreateLabelInput): Promise<Label> {
    const res = await this.http.request<Single<Label>>(
      'POST',
      `/api/boards/${encodePath(input.boardId)}/labels`,
      // Planka 2.1.0 requires `position` on create.
      { body: { name: input.name, color: input.color, position: input.position ?? 65536 } },
    );
    return res.item;
  }

  async update(
    id: string,
    patch: { name?: string | null; color?: string; position?: number },
  ): Promise<Label> {
    const res = await this.http.request<Single<Label>>(
      'PATCH',
      `/api/labels/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/labels/${encodePath(id)}`, {});
  }

  async attach(cardId: string, labelId: string): Promise<void> {
    await this.http.request(
      'POST',
      `/api/cards/${encodePath(cardId)}/card-labels`,
      { body: { labelId } },
    );
  }

  async detach(cardId: string, labelId: string): Promise<void> {
    // Matrix-param shape: `/card-labels/labelId:<id>`. Encode only the id
    // portion — the literal `labelId:` prefix must stay untouched.
    await this.http.request(
      'DELETE',
      `/api/cards/${encodePath(cardId)}/card-labels/labelId:${encodePath(labelId)}`,
      {},
    );
  }
}
