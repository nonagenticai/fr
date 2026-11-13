// cockpit-header.ts — `GET /api/projects/:id/cockpit?scope=header`: the project + status panels
// only, for the shell header (C1) on every project page. Kept out of ./cockpit so each module has
// exactly one fetcher.
import { authFetch } from './auth-fetch';
import { CockpitNotFoundError } from './cockpit';
import type { ProjectCockpitHeader } from '$lib/types/cockpit';

export async function fetchProjectCockpitHeader(projectId: string): Promise<ProjectCockpitHeader> {
  const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/cockpit?scope=header`);
  if (r.status === 404) throw new CockpitNotFoundError(projectId);
  if (!r.ok) throw new Error(`fetchProjectCockpitHeader: ${r.status}`);
  return (await r.json()) as ProjectCockpitHeader;
}
