import { encodePath, type PlankaHttp } from './http';
import type { Project, Single, Many, CreateProjectInput, ProjectsListResponse } from './types';

/** Subset of planka-private projects/show.js's response that fr reads. */
export interface ProjectDetailResponse {
  item: Project;
  included: {
    /** ProjectManager rows ({ id, projectId, userId, ... }) — ALL of the project's managers. */
    projectManagers?: Array<{ userId?: string; projectId?: string }>;
    /** For a project manager: every board in the project (Board.qm.getByProjectId). */
    boards?: Array<{ id?: string }>;
  };
}

export class ProjectsResource {
  constructor(private readonly http: PlankaHttp) {}

  async create(input: CreateProjectInput): Promise<Project> {
    // Planka 2.1.0 requires `type` — default to 'private' when the caller
    // doesn't specify (matches FR's intake flow, which doesn't currently
    // expose a public/shared knob on its HTTP API).
    const body = { type: input.type ?? 'private', ...input };
    const res = await this.http.request<Single<Project>>('POST', '/api/projects', { body });
    return res.item;
  }

  async list(): Promise<Project[]> {
    const res = await this.http.request<Many<Project>>('GET', '/api/projects', {});
    return res.items;
  }

  async listWithIncluded(): Promise<ProjectsListResponse> {
    return this.http.request<ProjectsListResponse>('GET', '/api/projects', {});
  }

  async get(id: string): Promise<Project> {
    const res = await this.http.request<Single<Project>>('GET', `/api/projects/${encodePath(id)}`, {});
    return res.item;
  }

  /**
   * The full `GET /api/projects/:id` response, `included` block and all
   * (planka-private `server/api/controllers/projects/show.js`). `get()` drops
   * `included`; this keeps `included.projectManagers` and `included.boards`,
   * which `confirmBoardMissing` needs to decide whether a board 404 is proof.
   */
  async getDetail(id: string): Promise<ProjectDetailResponse> {
    return this.http.request<ProjectDetailResponse>('GET', `/api/projects/${encodePath(id)}`, {});
  }

  async update(id: string, patch: Partial<CreateProjectInput>): Promise<Project> {
    const res = await this.http.request<Single<Project>>('PATCH', `/api/projects/${encodePath(id)}`, { body: patch });
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/projects/${encodePath(id)}`, {});
  }
}
