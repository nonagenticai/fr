// src/lib/projects/load-project.ts
//
// One project read, with "absent" and "unreadable" kept apart.
//
// WHY THIS EXISTS. Five project sub-pages each carried the identical line:
//
//     project = await apiClient.projects.get(projectId).catch(() => null);
//
// and then rendered a different confident claim off that null — none of which
// the fetch had earned:
//
//   architecture  "No container is provisioned for this project yet."
//   quality       "No container is provisioned for this project yet — no quality gate to report."
//   governance    "No container is provisioned — no architecture proposals to review yet."
//   settings      "Project not found."
//   board         "This project is not linked to a board yet. Re-create the
//                  project or contact an admin to provision one."
//
// The last one is the reason this is a helper and not five edits: on a backend
// hiccup it instructs the user to RE-CREATE a project that exists and is fine.
// A swallow that produces a destructive instruction is not a display bug.
//
// The distinction the callers need is the same one the backend already draws
// with `isUpstreamStatus(err, 404)`: a 404 is a real answer ("no such project"),
// anything else means we could not read it and must not claim either way.

import { apiClient, ApiError } from '$lib/api/unified-client';
import type { Project } from '$lib/types/api';

export interface ProjectLoad {
  /** The project, or null when it genuinely does not exist (404) or was unreadable. */
  project: Project | null;
  /**
   * true ⇒ the read FAILED. `project` is null because we could not ask, not
   * because the answer was "none". Never render an absence claim when this is
   * true — say the read failed.
   */
  unreadable: boolean;
}

/**
 * Read one project, separating "does not exist" from "could not be read".
 *
 * A 404 is an answer: `{ project: null, unreadable: false }`.
 * Anything else — network, 5xx, auth blip — is `{ project: null, unreadable: true }`.
 */
export async function loadProject(projectId: string): Promise<ProjectLoad> {
  if (!projectId) return { project: null, unreadable: false };
  try {
    return { project: await apiClient.projects.get(projectId), unreadable: false };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { project: null, unreadable: false };
    }
    return { project: null, unreadable: true };
  }
}
