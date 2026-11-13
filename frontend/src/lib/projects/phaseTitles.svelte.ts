// Phase LABELS for the UI = the tenant's requirements_management phase titles
// (design: fr consumes RM vocabulary). There is no frontend list: the old
// `$lib/cards/projectPhase.ts` mirror is gone. Loaded once per session from
// GET /api/conveyor/project-types (every type's phases, name → title).
//
// A phase with no RM title (the tenant has no catalogue, the read failed, or a
// stored name RM does not define) is shown by its stored NAME — the value as it
// is, never an invented label.

import { listTenantProjectTypes } from '$lib/api/conveyor-catalogue';

class PhaseTitles {
  private titles = $state<ReadonlyMap<string, string>>(new Map());
  private typeTitles = $state<ReadonlyMap<string, string>>(new Map());
  private started = false;

  /** Load once (idempotent). Never throws. */
  async ensureLoaded(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const r = await listTenantProjectTypes();
    if (!r.ok || !Array.isArray(r.data)) return;
    const m = new Map<string, string>();
    const types = new Map<string, string>();
    for (const t of r.data) {
      if (t.title) types.set(t.name, t.title);
      for (const p of t.phases ?? []) if (p.title) m.set(p.name, p.title);
    }
    this.titles = m;
    this.typeTitles = types;
  }

  /** The RM title of `name`, else the name itself; '' for no phase. */
  label(name: string | null | undefined): string {
    if (!name) return '';
    return this.titles.get(name) ?? name;
  }

  /** The RM title of a project TYPE (`it` → its catalogue title), else the name; '' for none. */
  typeLabel(name: string | null | undefined): string {
    if (!name) return '';
    return this.typeTitles.get(name) ?? name;
  }
}

export const phaseTitles = new PhaseTitles();
