// projectCockpit.svelte.ts — the project + status panels of the cockpit read model, shared by the
// shell header (C1, on every project page) and the overview page, so the overview page makes ONE
// call: it publishes its full read here and the header uses it instead of asking again.
// Elsewhere the header reads `GET /api/projects/:id/cockpit?scope=header` itself.
import { fetchProjectCockpitHeader } from '$lib/api/cockpit-header';
import type { CockpitStatus, ProjectSummary } from '$lib/types/cockpit';
import type { Panel } from '$lib/types/panel';

export interface CockpitHeaderView {
  projectId: string;
  project: Panel<ProjectSummary>;
  status: Panel<CockpitStatus>;
  /** Wall-clock ms of the read. */
  at: number;
}

/** A published read younger than this is used as-is (the overview page polls every 15 s). */
export const HEADER_FRESH_MS = 20_000;

/**
 * R4: the project rail's "Needs you" badge. ONE source — the cockpit's C2 list (`actions`, or its
 * length `needs_you` on the header read) — the same list the Needs you page renders, so the badge
 * and the page cannot disagree. `count` null = not read / unreadable (no badge, never 0).
 */
export interface NeedsYouCount {
  projectId: string;
  count: number | null;
  /** The list behind the count was only partly readable (a source down): the count is a floor. */
  partial: boolean;
}

class ProjectCockpitStore {
  view = $state<CockpitHeaderView | null>(null);
  needsYou = $state<NeedsYouCount | null>(null);
  /** The last header read FAILED (never painted as a state). */
  unreadable = $state(false);
  private seq = 0;

  /** The overview page's full read (or the header's own). */
  publish(projectId: string, project: Panel<ProjectSummary>, status: Panel<CockpitStatus>): void {
    this.view = { projectId, project, status, at: Date.now() };
    this.unreadable = false;
  }

  /** Record the Needs you count from a cockpit read (`actions` / `needs_you`). */
  publishNeedsYou(projectId: string, panel: Panel<number> | undefined | null): void {
    if (!panel) {
      if (this.needsYou?.projectId !== projectId) this.needsYou = null;
      return;
    }
    this.needsYou = {
      projectId,
      count: typeof panel.data === 'number' ? panel.data : null,
      partial: panel.health !== 'ok',
    };
  }

  /** The Needs you count for `projectId` (null = unknown). */
  needsYouFor(projectId: string): NeedsYouCount | null {
    return this.needsYou && this.needsYou.projectId === projectId ? this.needsYou : null;
  }

  /** The current view for `projectId`, or null. */
  for(projectId: string): CockpitHeaderView | null {
    return this.view && this.view.projectId === projectId ? this.view : null;
  }

  /** Read the header panels unless a fresh read for this project is already here. */
  async refresh(projectId: string, opts: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const cur = this.for(projectId);
    if (!opts.force && cur && now - cur.at < HEADER_FRESH_MS) return;
    if (this.view && this.view.projectId !== projectId) this.view = null;
    const mine = ++this.seq;
    try {
      const h = await fetchProjectCockpitHeader(projectId);
      if (mine !== this.seq) return;
      this.publish(projectId, h.project, h.status);
      this.publishNeedsYou(projectId, h.needs_you);
    } catch {
      if (mine === this.seq) this.unreadable = true;
    }
  }
}

export const projectCockpit = new ProjectCockpitStore();

/** The full read's `actions` list as the count panel the badge reads (same health, same rows). */
export function actionsCount<T>(actions: Panel<T[]> | null | undefined): Panel<number> | null {
  if (!actions) return null;
  return { ...actions, data: Array.isArray(actions.data) ? actions.data.length : null } as Panel<number>;
}
