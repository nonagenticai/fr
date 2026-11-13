// src/lib/stores/activeProject.svelte.ts
//
// The ACTIVE PROJECT — the default working scope of the "Copilot-led" redesign.
// Backs the top-bar Project switcher (`[Tenant ▾] › [Project ▾]`) and the
// project-scoped sidebar (Steer/Inspect groups whose hrefs are
// `/projects/<activeId>/<sub>`), plus the sidebar's proj-ctx header (name +
// phase chip).
//
// Orthogonal axes (do not conflate):
//   - TENANT  → `workspaces.svelte.ts` (X-Active-Tenant header). The OUTER scope.
//   - PROJECT → THIS store. The working scope WITHIN the active tenant.
//   - Library within-project scope → `scopeContext.svelte.ts` (?project_id=).
//
// The active id is the user's SELECTED project. A `/projects/[id]/**` route sets
// it (setActive), and so does the header switcher (select) — and it then STAYS
// selected when the user leaves the project subtree (Kanban, Approvals, Home…).
// It used to be cleared on every exit from `/projects/[id]`, which the UI review
// of 2026-10-07 read as "the selection is random". It is persisted per tenant in
// `localStorage('fr.selected_project:<tenant>')`, so a reload and a tenant
// switch both land on the right selection; storage failures (private window,
// blocked site data) degrade to an in-memory selection. The project LIST is
// fetched lazily for the switcher dropdown, and a persisted id that is no
// longer listed (deleted / archived) is dropped when the list arrives.

import { authFetch } from '$lib/api/auth-fetch';
// One-way import (`workspaces` does not import this store), so no cycle.
import { workspaces } from '$lib/stores/workspaces.svelte';

export interface ActiveProjectSummary {
  id: string;
  name: string;
  /**
   * The stored macro phase NAME (a phase of the project's RM project type), or
   * null (a continuous stream has none). Labels: `$lib/projects/phaseTitles`.
   */
  phase: string | null;
  /** 'continuous' for kaizen/stream boards, else a normal project. */
  kind?: string | null;
  status?: string | null;
  /** false when the Planka board was deleted upstream (stale link). */
  board_live?: boolean;
}

interface RawProject {
  id: string;
  name: string;
  project_phase?: string | null;
  kind?: string | null;
  status?: string | null;
  board_live?: boolean;
  /** The workspace that owns the project; `keycloak_tenant_id` is written at creation. */
  project_data?: { keycloak_tenant_id?: string | null } | null;
}

function summarize(p: RawProject): ActiveProjectSummary {
  return {
    id: p.id,
    name: p.name,
    phase: p.project_phase ?? null,
    kind: p.kind ?? null,
    status: p.status ?? null,
    board_live: p.board_live,
  };
}

const STORAGE_PREFIX = 'fr.selected_project:';
const TENANT_KEY = 'fr.active_tenant';

/** Storage key for the current tenant. Read live — the tenant can change. */
function storageKey(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return STORAGE_PREFIX + (localStorage.getItem(TENANT_KEY) ?? '_default');
  } catch {
    return undefined;
  }
}

function readPersisted(): string | undefined {
  const key = storageKey();
  if (!key) return undefined;
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writePersisted(id: string | undefined): void {
  const key = storageKey();
  if (!key) return;
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable — the in-memory selection still holds.
  }
}

class ActiveProjectStore {
  #projects = $state<ActiveProjectSummary[]>([]);
  #activeId = $state<string | undefined>(readPersisted());
  /** A stub for the active project before the list has loaded (route-supplied). */
  #activeStub = $state<ActiveProjectSummary | undefined>(undefined);
  #loaded = $state(false);
  /**
   * The project a mounted route has OPEN (`/projects/[id]/**`, a card page) —
   * distinct from the persisted selection. Never dropped by the list check,
   * and the scope KAG cost attribution keys on (lib/api/kagProjectScope.ts):
   * the owner ruling bills a project only "when the user has a project open".
   */
  #routeId = $state<string | undefined>(undefined);
  #error = $state<string | undefined>(undefined);

  get projects(): ActiveProjectSummary[] {
    return this.#projects;
  }
  get loaded(): boolean {
    return this.#loaded;
  }
  get error(): string | undefined {
    return this.#error;
  }
  get activeId(): string | undefined {
    return this.#activeId;
  }
  /** The project a mounted route has open, else undefined (see #routeId). */
  get openId(): string | undefined {
    return this.#routeId;
  }

  /** The active project — from the loaded list, else the route-supplied stub. */
  get active(): ActiveProjectSummary | undefined {
    const id = this.#activeId;
    if (!id) return undefined;
    return this.#projects.find((p) => p.id === id) ?? this.#activeStub;
  }

  /**
   * A route OPENED project `id` (`/projects/[id]/**`, a card page): select it and resolve its
   * summary BY ID (`GET /api/projects/:id`). ⛔ Never a placeholder name: the list
   * (`GET /api/projects`) leaves closed projects out, so a stub seeded with `'…'` used to stay
   * `'…'` and the switcher read "No project" for every closed project (F9).
   */
  open(id: string): void {
    // The route opens it either way — set before the early return, or a project picked in the
    // header and then opened would never count as open.
    this.#routeId = id;
    if (this.#activeId !== id) {
      this.#activeId = id;
      this.#activeStub = this.#projects.find((p) => p.id === id);
      writePersisted(id);
    }
    if (!this.active) void this.resolve(id);
  }

  /** Mark a project active with a summary the caller already holds (a real one — never a placeholder). */
  setActive(stub: ActiveProjectSummary): void {
    this.#routeId = stub.id;
    this.#activeId = stub.id;
    this.#activeStub = stub;
    writePersisted(stub.id);
  }

  /** Record what a page already read about a project (the cockpit's project panel). */
  note(summary: ActiveProjectSummary): void {
    if (summary.id !== this.#activeId) return;
    const listed = this.#projects.find((p) => p.id === summary.id);
    if (listed) return;
    const cur = this.#activeStub;
    if (cur && cur.id === summary.id && cur.name === summary.name && cur.status === summary.status && cur.phase === summary.phase) return;
    this.#activeStub = { ...cur, ...summary };
  }

  /** Read one project by id (closed / unlisted ones included). Never throws. */
  private async resolve(id: string): Promise<void> {
    try {
      const res = await authFetch(`/api/projects/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const body = (await res.json()) as RawProject & { data?: RawProject };
      const raw = body && typeof body.id === 'string' ? body : body?.data;
      if (!raw || raw.id !== id || this.#activeId !== id) return;
      // The project's OWN workspace wins. A super-admin reaches a foreign project through the
      // backend's read-only home-view lane, but the Copilot's agent session is minted for the
      // ACTIVE workspace — without this switch the agent answers from the wrong workspace and
      // its tool calls 403 as `internal_error`. Before the list check: the switch must happen
      // even when the project is already in the current list.
      void workspaces.ensureActiveFromProject(raw.project_data?.keycloak_tenant_id);
      if (this.#projects.some((p) => p.id === id)) return;
      this.#activeStub = summarize(raw);
    } catch {
      // The switcher keeps showing the id's own option; nothing is invented.
    }
  }

  /** The route that opened `id` unmounted: the selection stays, "open" ends. */
  leaveRoute(id: string): void {
    if (this.#routeId === id) this.#routeId = undefined;
  }

  /** Select a project by id (header switcher), without navigating. */
  select(id: string): void {
    if (id === this.#activeId) return;
    const known = this.#projects.find((p) => p.id === id);
    this.#activeId = id;
    this.#activeStub = known;
    writePersisted(id);
    if (!known) void this.resolve(id);
  }

  /** Explicitly deselect ("No project"), or drop a selection that no longer exists. */
  clear(): void {
    this.#routeId = undefined;
    this.#activeId = undefined;
    this.#activeStub = undefined;
    writePersisted(undefined);
  }

  /** Re-read the persisted selection — call after a tenant switch. */
  rehydrate(): void {
    this.#routeId = undefined;
    this.#activeId = readPersisted();
    this.#activeStub = undefined;
    this.#loaded = false;
    this.#projects = [];
  }

  /** Hydrate the switcher list from /api/projects. Safe to call repeatedly. */
  async load(): Promise<void> {
    this.#error = undefined;
    try {
      const res = await authFetch('/api/projects');
      if (!res.ok) {
        this.#error = `projects fetch ${res.status}`;
        return;
      }
      const body = (await res.json()) as { items?: RawProject[] };
      this.#projects = (body.items ?? []).map(summarize);
      this.#loaded = true;
      // A persisted selection whose project is gone (deleted / archived /
      // other tenant) must not linger as a dead scope.
      const id = this.#activeId;
      // The project a route explicitly opened is kept even if unlisted (an
      // archived project opened by URL).
      if (id && id !== this.#routeId && !this.#projects.some((p) => p.id === id)) this.clear();
    } catch (e) {
      this.#error = e instanceof Error ? e.message : 'projects fetch failed';
    }
  }
}

export const activeProject = new ActiveProjectStore();
