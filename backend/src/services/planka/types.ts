// Curated Planka types on top of the generated openapi-types.
// We re-export a small, stable surface used across resources.
// When adding new types, prefer extracting from `components["schemas"]` in openapi-types.ts.

import type { components } from './openapi-types';

// Entities
export type Project = components['schemas']['Project'];
export type Board = components['schemas']['Board'];
export type List = components['schemas']['List'];
export type Card = components['schemas']['Card'];
// note: plan assumed `CommentAction`, but the Planka 2.0.0 spec exposes the comment entity as `Comment`.
// If a future spec bump renames this to `CommentAction`, update the alias here — callers import `Comment`.
export type Comment = components['schemas']['Comment'];
export type Action = components['schemas']['Action'];
export type Label = components['schemas']['Label'];
export type Task = components['schemas']['Task'];
export type TaskList = components['schemas']['TaskList'];
export type User = components['schemas']['User'];
export type BoardMembership = components['schemas']['BoardMembership'];
export type CardMembership = components['schemas']['CardMembership'];
export type CardLabel = components['schemas']['CardLabel'];

// Planka responses wrap entities in { item, included } or { items, included }
export interface Single<T, I = Record<string, unknown>> {
  item: T;
  included?: I;
}
export interface Many<T, I = Record<string, unknown>> {
  items: T[];
  included?: I;
}

// Board detail — returned by GET /api/boards/:id
export interface BoardDetail {
  item: Board;
  included: {
    projects?: Project[];
    users?: User[];
    lists?: List[];
    cards?: Card[];
    labels?: Label[];
    cardLabels?: CardLabel[];
    cardMemberships?: CardMembership[];
    boardMemberships?: BoardMembership[];
    tasks?: Task[];
  };
}

// Card detail — returned by GET /api/cards/:id
export interface CardDetail {
  item: Card;
  included: {
    users?: User[];
    cardMemberships?: CardMembership[];
    cardLabels?: CardLabel[];
    tasks?: Task[];
  };
}

// Projects list response — includes nested boards alongside project items.
export interface ProjectsListResponse {
  items: Project[];
  included: {
    users?: User[];
    projectManagers?: unknown[];
    boards?: Board[];
    boardMemberships?: BoardMembership[];
  };
}

// DTOs — inputs for mutating endpoints.
// Keep these narrow and separate from the OpenAPI schemas so callers
// don't have to supply server-managed fields (id, createdAt, etc.).

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  // Planka 2.1.0 requires `type` on POST /api/projects — omitting it yields
  // 400 E_MISSING_OR_INVALID_PARAMS. Callers may omit this; the resource
  // layer defaults to 'private'.
  type?: 'private' | 'shared';
}
export interface CreateBoardInput {
  projectId: string;
  name: string;
  position?: number;
}
export interface CreateListInput {
  boardId: string;
  name: string;
  // ListsResource defaults to 65536 when omitted (Planka 2.1.0 422 fix).
  position?: number;
  type?: 'active' | 'closed';
}
export interface CreateCardInput {
  listId: string;
  name: string;
  description?: string;
  position?: number;
  dueDate?: string | null;
  type?: 'project' | 'story';
}
export interface UpdateCardInput {
  name?: string;
  description?: string | null;
  dueDate?: string | null;
  isClosed?: boolean;
}
export interface MoveCardInput {
  listId: string;
  position: number;
}
export interface CreateCommentInput {
  cardId: string;
  text: string;
}
export interface UpdateCommentInput {
  text: string;
}
export interface CreateLabelInput {
  boardId: string;
  name?: string | null;
  color: string;
  // LabelsResource defaults to 65536 when omitted.
  position?: number;
}
export interface CreateTaskListInput {
  cardId: string;
  name: string;
  position: number;
}
export interface CreateTaskInput {
  taskListId: string;
  name: string;
  // TasksResource defaults to 65536 when omitted.
  position?: number;
}
export interface UpdateTaskInput {
  name?: string;
  isCompleted?: boolean;
  position?: number;
}
