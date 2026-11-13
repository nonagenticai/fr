import { encodePath, type PlankaHttp } from './http';
import type { Board, BoardDetail, Single, Many, CreateBoardInput } from './types';

export class BoardsResource {
  constructor(private readonly http: PlankaHttp) {}

  async create(input: CreateBoardInput): Promise<Board> {
    const res = await this.http.request<Single<Board>>(
      'POST',
      `/api/projects/${encodePath(input.projectId)}/boards`,
      { body: { name: input.name, position: input.position ?? 0 } },
    );
    return res.item;
  }

  async get(id: string): Promise<BoardDetail> {
    return this.http.request<BoardDetail>('GET', `/api/boards/${encodePath(id)}`, {});
  }

  async listByProject(projectId: string): Promise<Board[]> {
    // Planka 2.1.0 does not expose GET /api/projects/:id/boards — the server
    // returns the SPA HTML for any unknown /api/ path. Boards are returned
    // inside the `included` bag of GET /api/projects, so we filter that by
    // the caller's projectId.
    const res = await this.http.request<{
      items: unknown[];
      included?: { boards?: Board[] };
    }>('GET', '/api/projects', {});
    const boards = res.included?.boards ?? [];
    return boards.filter((b) => b.projectId === projectId);
  }

  async update(id: string, patch: { name?: string; position?: number }): Promise<Board> {
    const res = await this.http.request<Single<Board>>(
      'PATCH',
      `/api/boards/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/boards/${encodePath(id)}`, {});
  }
}
