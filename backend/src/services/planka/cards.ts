import { encodePath, type PlankaHttp } from './http';
import { assertPlankaCardBodyCarriesNoEvidence } from './description-guard';
import type {
  Card,
  CardDetail,
  Single,
  CreateCardInput,
  UpdateCardInput,
  MoveCardInput,
} from './types';

export class CardsResource {
  constructor(private readonly http: PlankaHttp) {}

  async create(input: CreateCardInput): Promise<Card> {
    // Chokepoint: repro evidence never reaches Planka (description-guard.ts).
    assertPlankaCardBodyCarriesNoEvidence(input);
    // Planka 2.1.0 requires `position` on create (422 "Position must be
    // present" otherwise). Same default as duplicate — Planka resolves
    // collisions internally.
    const body: Record<string, unknown> = {
      name: input.name,
      type: input.type ?? 'project',
      position: input.position ?? CardsResource.DEFAULT_DUPLICATE_POSITION,
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.dueDate !== undefined) body.dueDate = input.dueDate;
    const res = await this.http.request<Single<Card>>(
      'POST',
      `/api/lists/${encodePath(input.listId)}/cards`,
      { body },
    );
    return res.item;
  }

  async get(id: string): Promise<CardDetail> {
    return this.http.request<CardDetail>('GET', `/api/cards/${encodePath(id)}`, {});
  }

  async update(id: string, patch: UpdateCardInput): Promise<Card> {
    // Chokepoint: repro evidence never reaches Planka (description-guard.ts).
    assertPlankaCardBodyCarriesNoEvidence(patch);
    const res = await this.http.request<Single<Card>>(
      'PATCH',
      `/api/cards/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async move(id: string, to: MoveCardInput): Promise<Card> {
    const res = await this.http.request<Single<Card>>(
      'PATCH',
      `/api/cards/${encodePath(id)}`,
      { body: { listId: to.listId, position: to.position } },
    );
    return res.item;
  }

  // Planka 2.1.0's POST /api/cards/:id/duplicate REQUIRES a `position` field;
  // omitting it returns 422 "Position must be present" (which our error mapper
  // surfaces as a 400 "Validation error" to the frontend). Planka does its own
  // collision-resolution against existing cards in the list, so a fixed
  // default like 65536 is fine — the new card lands at a midpoint slot
  // automatically. Callers may pass an explicit position to override.
  static readonly DEFAULT_DUPLICATE_POSITION = 65536;
  /** Planka's spacing between adjacent card positions (the same 65536 every default here uses). */
  static readonly POSITION_GAP = 65536;
  async duplicate(id: string, name?: string, position?: number): Promise<Card> {
    const body: Record<string, unknown> = {
      position: position ?? CardsResource.DEFAULT_DUPLICATE_POSITION,
    };
    if (name !== undefined) body.name = name;
    const res = await this.http.request<Single<Card>>(
      'POST',
      `/api/cards/${encodePath(id)}/duplicate`,
      { body },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/cards/${encodePath(id)}`, {});
  }
}
