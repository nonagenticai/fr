// Svelte 5 rune-based selection store for the analysis-to-kanban bridge.
// Keeps user-selected ToolOutputs across page navigation within a session.
// Ephemeral — no persistence (matches spec §Frontend bullet 2).
//
// Scoped by project_id: every bridge route is `(user_id, project_id)`-scoped
// at the backend (see backend/src/routes/tools/bridge.ts), so the selection
// store is single-project per session. If the active project changes (the
// user navigates to a different project's tool list), the store resets to
// avoid silently mixing outputs across project scopes.

import type { ToolOutput } from './types';

class BridgeSelectionState {
  /** The project_id this selection belongs to; null until first add. */
  project_id = $state<string | null>(null);
  selected = $state<ToolOutput[]>([]);

  count = $derived(this.selected.length);
  isEmpty = $derived(this.selected.length === 0);

  /**
   * Pin the store to a project. If the project changes, drop existing
   * selections — we never silently mix scopes.
   */
  ensureProject(project_id: string): void {
    if (!project_id) return;
    if (this.project_id !== null && this.project_id !== project_id) {
      this.selected = [];
    }
    this.project_id = project_id;
  }

  has(stableId: string): boolean {
    return this.selected.some((o) => o.stable_id === stableId);
  }

  add(output: ToolOutput): void {
    if (this.has(output.stable_id)) return;
    this.selected = [...this.selected, output];
  }

  remove(stableId: string): void {
    this.selected = this.selected.filter((o) => o.stable_id !== stableId);
  }

  toggle(output: ToolOutput): void {
    if (this.has(output.stable_id)) {
      this.remove(output.stable_id);
    } else {
      this.add(output);
    }
  }

  clear(): void {
    this.selected = [];
    this.project_id = null;
  }
}

export const bridgeSelection = new BridgeSelectionState();
