// inspector.svelte.ts
// ==================
// Shared selection for the right-hand InspectorDrawer. A surface opens the
// drawer by setting a `{ kind, id, payload }` selection; the drawer host reads
// it reactively and renders the right hydrator. One selection at a time.

export interface InspectorSelection<T = unknown> {
  /** Discriminator the host uses to pick a hydrator, e.g. 'cockpit-card'. */
  kind: string;
  /** Stable id of the selected entity (drives reset-on-change in the drawer). */
  id: string;
  /** The already-loaded entity, so the drawer needs no extra fetch to open. */
  payload?: T;
}

class InspectorState {
  selection = $state<InspectorSelection | null>(null);

  open<T>(sel: InspectorSelection<T>): void {
    this.selection = sel as InspectorSelection;
  }

  close(): void {
    this.selection = null;
  }

  isOpen(kind?: string): boolean {
    if (!this.selection) return false;
    return kind ? this.selection.kind === kind : true;
  }
}

export const inspector = new InspectorState();
