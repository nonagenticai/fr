// rightPane.svelte.ts
// =====================
// Plan 3 follow-up — single source of truth for what the ContextualPane
// renders in the three-pane layout's right rail. Set by:
//   - the agent loop (when a tool result wants to surface its detail UI),
//   - explicit clicks in the chat ("open in pane"),
//   - the Cmd-K palette deep-links.
//
// Discriminated union — the consumer (ContextualPane.svelte) switches on
// `kind` to decide which sub-component to render. `null` means "show
// the placeholder slot" so the grid keeps reserving the rail width.
//
// Plan: docs/superpowers/plans/2026-04-29-plan-3-followups.md Tasks 9-12.

import { agentRail } from './agentRail.svelte';

export type RightPaneContent =
  | { kind: 'kanban-card'; id: string; meta?: Record<string, unknown> }
  | { kind: 'project'; id: string; meta?: Record<string, unknown> }
  | { kind: 'kag-session'; id: string; meta?: Record<string, unknown> }
  | { kind: 'coding-job'; id: string; meta?: Record<string, unknown> }
  | { kind: 'bridge-draft'; id: string; meta?: Record<string, unknown> }
  | { kind: 'n8n-execution'; id: string; meta?: Record<string, unknown> }
  | { kind: 'artifact'; id: string; meta?: Record<string, unknown> };

export type RightPaneKind = RightPaneContent['kind'];

interface RightPaneState {
  kind: RightPaneKind | null;
  id: string | null;
  meta: Record<string, unknown> | null;
}

let _state = $state<RightPaneState>({ kind: null, id: null, meta: null });

export const rightPane = {
  get kind(): RightPaneKind | null {
    return _state.kind;
  },
  get id(): string | null {
    return _state.id;
  },
  get meta(): Record<string, unknown> | null {
    return _state.meta;
  },
  isOpen(): boolean {
    return _state.kind !== null && _state.id !== null;
  },
  setContent(c: RightPaneContent): void {
    _state = { kind: c.kind, id: c.id, meta: c.meta ?? null };
  },
  clear(): void {
    _state = { kind: null, id: null, meta: null };
  },
};

/**
 * Set the pane content AND show it. `setContent` alone only fills a surface
 * that is hidden twice over — the rail defaults closed and defaults to the
 * [Agent] tab — so every "open in pane" affordance must go through here.
 * Callers cannot do half the job.
 */
/**
 * The identity of what the pane is showing — kind, id AND meta.
 *
 * ContextualPane keys its view on this. `meta` belongs in the key because a view
 * may READ it: BridgeDraftView resolves `meta.project_id` in onMount, so the same
 * (kind, id) reopened under different meta would keep the first meta's data while
 * claiming to show the second. No current caller does that (bridge draft ids are
 * uuids and project_id is derived from the URL), so this closes a trap rather
 * than a live bug — but the next caller should not have to know that.
 */
export function paneKey(
  kind: RightPaneKind | null,
  id: string | null,
  meta: Record<string, unknown> | null,
): string {
  let m = '';
  if (meta) {
    try {
      m = JSON.stringify(meta);
    } catch (err) {
      // A cyclic or unserialisable meta must not break the pane. Degrade to a
      // key that still changes with the key set, and say why.
      m = `unserialisable(${Object.keys(meta).join(',')}):${String(err)}`;
    }
  }
  return `${kind}:${id}:${m}`;
}

export function openDetailPane(c: RightPaneContent): void {
  rightPane.setContent(c);
  agentRail.openDetail();
}
