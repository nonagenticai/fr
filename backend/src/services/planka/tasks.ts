import { encodePath, type PlankaHttp } from './http';
import type { Task, Single, CreateTaskInput, UpdateTaskInput } from './types';

export class TasksResource {
  constructor(private readonly http: PlankaHttp) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const res = await this.http.request<Single<Task>>(
      'POST',
      `/api/task-lists/${encodePath(input.taskListId)}/tasks`,
      // Planka 2.1.0 requires `position` on create.
      { body: { name: input.name, position: input.position ?? 65536 } },
    );
    return res.item;
  }

  async update(id: string, patch: UpdateTaskInput): Promise<Task> {
    const res = await this.http.request<Single<Task>>(
      'PATCH',
      `/api/tasks/${encodePath(id)}`,
      { body: patch },
    );
    return res.item;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/api/tasks/${encodePath(id)}`, {});
  }
}
