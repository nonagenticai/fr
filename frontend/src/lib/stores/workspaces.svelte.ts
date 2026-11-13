// src/lib/stores/workspaces.svelte.ts
//
// Multi-workspace state for the super-admin top-bar switcher. Backs:
//   - `<WorkspaceSwitcher />`     (dropdown UI)
//   - `authFetch`                 (sends X-Active-Tenant on every request)
//   - asset-console pages         (read `activeWorkspace.id` for inheritance UI)
//
// Lifecycle: hydrated after the auth store reports `isAuthenticated`. The
// `active` workspace id is persisted in `localStorage('fr.active_tenant')`
// so a page reload preserves the switcher's selection. If the persisted
// id is no longer in the user's `/api/me/workspaces` response (e.g.
// they were removed from it), we fall back to the caller's OWN workspace
// row when the server returned one, and otherwise to the first workspace
// returned (see `#pickActive`).
//
// Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend

import { authFetch } from '$lib/api/auth-fetch';
import { ACTIVE_TENANT_REFUSED_EVENT } from '$lib/api/active-tenant-refusal';
// One-way import: the auth store does NOT import this one, so there is no
// cycle. The active workspace's role is PUSHED into auth (same shape as
// `_deptRoles`) because the UI's workspace-admin gate must reflect the row
// the backend gates on, not a Keycloak claim that never carries it.
import { auth } from '$lib/stores/auth.svelte';

const STORAGE_KEY = 'fr.active_tenant';

/**
 * The synthetic `role` the backend stamps on the caller's OWN workspace — the
 * row built from their verified JWT `tenant_id` claim rather than from a
 * `user_roles` grant. Mirrors `OWN_WORKSPACE_ROLE` in
 * `backend/src/routes/me/workspaces.ts`; the two literals must stay equal.
 */
export const OWN_WORKSPACE_ROLE = 'own_workspace';

/** The persisted active tenant, or undefined when storage is unavailable. */
function readPersistedActiveId(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export type WorkspaceKind =
  | 'system'
  /** The kata tenant (migration 228): every kata project. */
  | 'kata'
  | 'execution'
  /** A customer (non-platform) workspace — backend `kindFor`. */
  | 'customer';

// Short labels for the switcher + command palette. MUST cover every
// WorkspaceKind the backend can return (`/api/me/workspaces` → `kindFor`),
// or the UI renders `undefined · <name>`. Single source so the switcher + CmdK never drift apart.
export const WORKSPACE_KIND_LABEL: Record<WorkspaceKind, string> = {
  system: 'SYS',
  kata: 'KATA',
  execution: 'EXEC',
  customer: 'TENANT',
};

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: string;
  /**
   * Which backend enumeration source produced the row. `'own_workspace'`
   * marks the caller's own JWT tenant even when `role` was raised to
   * `'workspace-admin'` by the realm `tenant_admin` arm. Optional: an older
   * backend does not send it, and the `role` check below still covers that.
   */
  source?: 'membership' | 'super_admin_scope' | 'own_workspace';
  archived_at: string | null;
}

class WorkspacesStore {
  #workspaces = $state<Workspace[]>([]);
  #activeId = $state<string | undefined>(undefined);
  #loaded = $state(false);
  #error = $state<string | undefined>(undefined);

  get workspaces(): Workspace[] {
    return this.#workspaces;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  get error(): string | undefined {
    return this.#error;
  }

  /** The currently-active workspace, or `undefined` before hydration. */
  get active(): Workspace | undefined {
    const id = this.#activeId;
    if (!id) return undefined;
    return this.#workspaces.find((w) => w.id === id);
  }

  /** Raw active workspace id — used by `authFetch` without a $-effect. */
  get activeId(): string | undefined {
    return this.#activeId;
  }

  /**
   * The tenant id the NEXT request will actually carry in `X-Active-Tenant`.
   *
   * `activeId` is `undefined` until `load()` resolves, but `auth-fetch` reads
   * `localStorage('fr.active_tenant')` live on every request — so on a cold
   * load the header is already correct while this store is still empty. A page
   * that re-fetches when its scope changes must key off THIS, not `activeId`:
   * keying off `activeId` sees a spurious `undefined -> id` transition on every
   * cold load and fires a second, identical request for a scope that never
   * changed. Reading `#activeId` first keeps the getter reactive to
   * `setActive()`, which is the transition that genuinely must re-fetch.
   */
  get scopeKey(): string | undefined {
    return this.#activeId ?? readPersistedActiveId();
  }

  /**
   * Hydrate the list from `/api/me/workspaces` and pick the active workspace.
   * Safe to call multiple times; second invocation refetches.
   */
  async load(): Promise<void> {
    this.#error = undefined;
    try {
      const res = await authFetch('/api/me/workspaces');
      if (!res.ok) {
        this.#error = `workspaces fetch ${res.status}`;
        // A failed load was ATTEMPTED, not "never tried" — WorkspaceSwitcher
        // gates on `loaded` to decide whether to render at all, so leaving
        // this false made a failure identical to "hasn't loaded yet" (and,
        // once workspaces.length stayed 0, identical to "you belong to one
        // workspace" too — see the switcher's own `#error` branch).
        //
        // ⛔ DO NOT set `#loaded = true` here. It reads as "we attempted", and
        // that is the wrong contract: EIGHT call sites treat `!loaded` as
        // "load/retry now" — (admin)/admin/+layout.ts:34, settings/account,
        // WorkspaceSwitcher, and five assets/*/+page.svelte onMounts. This
        // store is a module-level singleton, so a sticky `loaded = true` on a
        // failed load stops every one of them RETRYING for the life of the SPA
        // session. Concretely: a workspace-admin loads /admin/* while
        // /api/me/workspaces is 503, the role never syncs, the guard redirects
        // to /, and every later attempt short-circuits on `loaded` and
        // redirects again — until a hard reload. Leaving it FALSE is what makes
        // the app self-heal when the backend comes back.
        //
        // `#error` is the "it broke" signal; the switcher branches on that
        // alone, with no `loaded` in its condition.
        return;
      }
      const body = (await res.json()) as { workspaces?: Workspace[] };
      const list = Array.isArray(body.workspaces) ? body.workspaces : [];
      this.#workspaces = list;
      // PERSIST the pick, don't just hold it.
      //
      // ⛔ `auth-fetch` reads `localStorage('fr.active_tenant')` live on every
      // request — it deliberately does not import this store (that would be an
      // import cycle). So an `#activeId` held only in memory sends NO
      // `X-Active-Tenant` header at all, and the switcher then shows a
      // workspace the requests are not scoped to.
      //
      // For a super-admin that is not a cosmetic gap. With no header,
      // `isSuperAdminHomeView` (backend/src/lib/project-access.ts) is true, so
      // `GET /api/approvals/all` drops its tenant predicate and returns EVERY
      // workspace's rows. Measured live on fr.nonagentic.ai 2026-08-26 as
      // fr-test: a fresh login showed 549 approvals spanning system,
      // workflow-/prompt-/procedure-improvement and nonagentic-exec, under a
      // header reading "in system"; after one manual switch — the only path
      // that used to reach `setActive` and therefore localStorage — the same
      // endpoint returned 332, system only. The sibling badge count went the
      // other way and read 0, because `handleListMyApprovals` scoped its roster
      // lookup to the user's OWN tenant instead of the shown workspace.
      //
      // This does NOT undo the deliberate super-admin cross-workspace read
      // (approvals.ts, the `superAdminHome` note): that fires when the active
      // tenant EQUALS the super-admin's own, which a persisted auto-pick still
      // produces for a super-admin whose home workspace is the one picked. It
      // only stops the accidental version, where the header is missing because
      // nobody wrote it down.
      const picked = this.#pickActive(list);
      this.#activeId = picked;
      if (picked) this.#persistActive(picked);
      this.#loaded = true;
      this.#syncAuthRole();
    } catch (e) {
      this.#error = (e as Error).message;
      // Deliberately NOT setting `#loaded` — see the !res.ok branch above for
      // why a sticky loaded-on-failure locks eight retry sites out for the
      // whole session.
    }
  }

  setActive(id: string): void {
    const target = this.#workspaces.find((w) => w.id === id);
    if (!target) return;
    this.#activeId = id;
    this.#persistActive(id);
    // A workspace switch can change the caller's role — an admin in one
    // workspace is often a plain member in the next.
    this.#syncAuthRole();
  }

  /**
   * Open `tenantId` — the workspace a project the user just opened belongs to — so the
   * page AND the Copilot act where the project lives.
   *
   * ⛔ WHY THIS EXISTS: a super-admin reaches a foreign project through the backend's
   * read-only home-view lane, but the Copilot's agent session is minted for the ACTIVE
   * workspace (`routes/agui-session.ts`). Opening the project without switching left the
   * agent scoped to the old workspace, so its first tool call 403'd upstream and surfaced
   * as `internal_error: You do not have access to this`. Only a super-admin can be looking
   * at a foreign project at all — a member of the tenant is already in it — so this is a
   * no-op for every ordinary user.
   *
   * Silent when the workspace is not in the caller's list: `setActive` no-ops and the
   * backend's `active_tenant_not_permitted` stays the authority on a switch attempt.
   */
  async ensureActiveFromProject(tenantId: string | null | undefined): Promise<void> {
    if (!tenantId || this.activeId === tenantId) return;
    // `activeId` is undefined until the list resolves, so a cold deep link must load first.
    if (!this.#loaded) await this.load();
    if (this.activeId === tenantId) return;
    this.setActive(tenantId);
  }

  /** Publish the active workspace's role to the auth store's tenant gates. */
  #syncAuthRole(): void {
    auth.setActiveWorkspaceRole(this.active?.role);
  }

  /**
   * Write the active tenant where `auth-fetch` will find it. Shared by
   * `setActive` and `load`'s auto-pick so the two cannot drift — the drift is
   * exactly what left a super-admin's first page load unscoped.
   */
  #persistActive(id: string): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, id);
      }
    } catch {
      // localStorage may be unavailable (privacy mode); silently ignore —
      // the in-memory state still tracks the switch for this session.
    }
  }

  /**
   * fr row 14d: the backend refused the stored workspace (`authFetch` saw a 403
   * `active_tenant_not_permitted`, cleared `fr.active_tenant` and toasted why).
   * Fall back to the caller's HOME workspace — never to the refused one — so
   * the switcher and every page keyed on `scopeKey` move with the requests.
   * A no-op when the active workspace is already something else.
   */
  handleRefusedActiveTenant(refusedId: string | undefined): void {
    if (this.#activeId !== undefined && refusedId !== undefined && this.#activeId !== refusedId) {
      return;
    }
    const picked = this.#pickActive(this.#workspaces.filter((w) => w.id !== refusedId));
    this.#activeId = picked;
    if (picked) this.#persistActive(picked);
    this.#syncAuthRole();
  }

  reset(): void {
    this.#workspaces = [];
    this.#activeId = undefined;
    this.#loaded = false;
    this.#error = undefined;
    // Fail closed — never leave a stale admin role behind after a sign-out.
    auth.setActiveWorkspaceRole(undefined);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* noop */
    }
  }

  #pickActive(list: Workspace[]): string | undefined {
    // Precedence: persisted → the caller's OWN workspace row → the server's
    // first list entry (already sorted system → wf → prompt → proc → exec).
    let persisted: string | null = null;
    try {
      if (typeof localStorage !== 'undefined') {
        persisted = localStorage.getItem(STORAGE_KEY);
      }
    } catch {
      /* noop */
    }
    if (persisted && list.some((w) => w.id === persisted)) {
      return persisted;
    }
    // ⛔ `list[0]` is NOT a neutral default. The server sorts `system` first
    // (`kindOrder` in backend/src/routes/me/workspaces.ts) and that sort is
    // also the switcher's render order, so it cannot be changed to fix this.
    // Measured in the production fr Postgres 2026-08-28/30: the super-admin
    // `fr-test` (32969c16-6ecd-49fe-a106-ba13e6640dc8) holds ZERO `user_roles`
    // rows (positive control: the table has 13 rows and other users do have
    // them) and their JWT `tenant_id` is `0195f48b-…-0099`, which is NOT one of
    // the five `SUPER_ADMIN_SWITCHABLE_IDS`. Cold storage therefore landed them
    // in `system`, `load()` PERSISTED it, and `X-Active-Tenant: <system>` then
    // overrode their JWT tenant on every request — KAG Ask answered from
    // system's 711 documents instead of their own 11,325 chunks.
    //
    // Preferring the `execution` row (the first attempt at this fix) was a
    // GUESS, and a measurably wrong one: the execution tenant …0003 has no
    // `kag_graph.chunks` rows at all, so it moved the user from the wrong
    // corpus to an empty one. It also only ever worked for a caller whose own
    // workspace happened to be the execution tenant.
    //
    // The general answer is the row the backend now always returns: the
    // caller's OWN workspace, built from their verified JWT `tenant_id` claim
    // and stamped `OWN_WORKSPACE_ROLE`. Preferring it is safe for EVERY caller,
    // not just a super-admin, because `middleware/request-context.ts:255-262`
    // accepts an `X-Active-Tenant` header for INTERNAL_TENANT_SET,
    // EXECUTION_TENANT_ID, or `activeTenantHeader === jwtTenantId` — the
    // caller's own tenant is unconditionally in that set, so the switcher can
    // never show a workspace the requests are not scoped to. (For a
    // non-super-admin the gate ignores the header entirely and the context
    // tenant is the JWT tenant anyway — the same id.)
    //
    // The backend emits at most one `own_workspace` row, and only when neither
    // a real `user_roles` membership nor the super-admin allowlist already
    // produced that id — so a genuine member of their own workspace keeps the
    // old `list[0]` behaviour, byte for byte. An empty list likewise keeps it
    // via the `?? list[0]?.id` tail.
    //
    // Keyed on `source` as well as `role`: a realm `tenant_admin` of their own
    // tenant gets that row's role raised to `workspace-admin` by the backend,
    // but it is still THEIR row. Without the `source` arm a super-admin (whose
    // token carries `tenant_admin` via the realm composite) would lose the own
    // pick and land on `list[0]` — the exact regression described above.
    const own = list.find(
      (w) => w.source === 'own_workspace' || w.role === OWN_WORKSPACE_ROLE,
    );
    return own?.id ?? list[0]?.id;
  }
}

export const workspaces = new WorkspacesStore();

// fr row 14d: `authFetch` cannot import this store (the store imports it), so a
// refused stored workspace is announced as a window event and handled here.
if (typeof window !== 'undefined') {
  window.addEventListener(ACTIVE_TENANT_REFUSED_EVENT, (e) => {
    const detail = (e as CustomEvent<{ tenantId?: string }>).detail;
    workspaces.handleRefusedActiveTenant(detail?.tenantId);
  });
}
