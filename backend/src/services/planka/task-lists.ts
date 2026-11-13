import { encodePath, type PlankaHttp } from './http';
import type { TaskList, Single, CreateTaskListInput } from './types';

export class TaskListsResource {
  constructor(private readonly http: PlankaHttp) {}

  async create(input: CreateTaskListInput): Promise<TaskList> {
    const res = await this.http.request<Single<TaskList>>(
      'POST',
      `/api/cards/${encodePath(input.cardId)}/task-lists`,
      { body: { name: input.name, position: input.position } },
    );
    return res.item;
  }

  async update(id: string, patch: { name?: string; position?: number }): Promise<TaskList> {
    const res = await this.http.request<Single<TaskList>>(
      'PATCH',
      `/api/task-lists/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/task-lists/${encodePath(id)}`, {});
  }
}
