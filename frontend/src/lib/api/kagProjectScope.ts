// lib/api/kagProjectScope.ts
//
// Cost attribution for kag search/ask (owner ruling): when the user has a
// project open, the request names it as `project_id` and fr's backend — after
// checking the project belongs to the caller's tenant — forwards it to kag as
// `X-Project-Id`. With no project open nothing is sent and kag bills the
// tenant-level fallback.
//
// "Has a project open" = `activeProject.openId`: set while a `/projects/[id]/**`
// route (or a card page of that project) is mounted, dropped when it unmounts.
// ⛔ NOT `activeProject.activeId`: since 2026-10-07 that is the PERSISTED header
// selection and survives leaving the project, so keying on it would bill every
// Library ask to whatever project was last picked. Only a real fr project uuid is sent: stream pseudo-projects
// (`stream:<uuid>`) are not projects the backend can resolve, and sending one
// would turn a working ask into a 404.

import { activeProject } from '$lib/stores/activeProject.svelte';
import { isUuid } from '$lib/coding/uuid';

/** The open project's id, when there is one and it is a real project uuid. */
export function openKagProjectId(): string | undefined {
  const id = activeProject.openId;
  return id && isUuid(id) ? id : undefined;
}

/** `body` plus `project_id` when the user has a project open; else `body` unchanged. */
export function withOpenProject<T extends Record<string, unknown>>(
  body: T,
): T & { project_id?: string } {
  const projectId = openKagProjectId();
  return projectId ? { ...body, project_id: projectId } : body;
}
