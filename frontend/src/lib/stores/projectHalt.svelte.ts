// The shared state of "is this project halted?" for the banner and the shell badge (one read of
// GET /api/projects/:id/andon, one store, so they never disagree).
import { authFetch } from '$lib/api/auth-fetch';
import { parseHaltView, type ProjectHaltView } from '$lib/projects/project-halt';

export class ProjectHaltStore {
	projectId = $state<string | null>(null);
	view = $state<ProjectHaltView | null>(null);
	/** True when the last read failed (never painted as "not halted"). */
	unreadable = $state(false);
	private seq = 0;

	get halted(): boolean {
		return this.view?.engaged === true;
	}

	/** Read the hold of `projectId`. A read for another project drops a stale answer. */
	async load(projectId: string): Promise<void> {
		if (!projectId) return;
		if (this.projectId !== projectId) {
			this.projectId = projectId;
			this.view = null;
		}
		const mine = ++this.seq;
		try {
			const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/andon`);
			if (mine !== this.seq) return;
			if (!res.ok) {
				// Unknown, not "released": the banner says so.
				this.view = null;
				this.unreadable = true;
				return;
			}
			const view = parseHaltView(await res.json());
			if (mine !== this.seq) return;
			this.view = view;
			this.unreadable = view === null;
		} catch (err) {
			// Recorded, and shown as "could not check" (unreadable), never as "not halted".
			console.warn('[project-halt] the hold could not be read:', err instanceof Error ? err.message : String(err));
			if (mine === this.seq) {
				this.view = null;
				this.unreadable = true;
			}
		}
	}

	/** Forget the project (a board that belongs to no project is shown). */
	clear(): void {
		this.seq += 1;
		this.projectId = null;
		this.view = null;
		this.unreadable = false;
	}

	/** Re-read the current project. */
	async refresh(): Promise<void> {
		if (this.projectId) await this.load(this.projectId);
	}
}

export const projectHalt = new ProjectHaltStore();
