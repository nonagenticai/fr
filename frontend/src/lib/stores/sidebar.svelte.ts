// sidebar.svelte.ts
// =================
// Persisted UI state for the left navigation rail: a collapse-to-icons toggle
// and a small set of pinned destinations (NavItem ids hoisted to a "Pinned"
// pseudo-zone at the top of the rail). Owning this in a store — rather than
// local to SidebarNav.svelte — lets it survive a reload and lets any surface
// (e.g. the command palette's "Toggle sidebar" action) drive it.
//
// Mirrors the persistence shape of commandPalette.svelte.ts: module-level
// load/persist helpers guarded against a missing localStorage (SSR / private
// mode), plus a $state class. The runnable nav ITEMS live in the nav registry
// (navConfig.ts) — this store only holds collapse state + the pinned id list.

import type { NavZone } from '$lib/layout/navConfig';

const STORAGE_KEY = 'fr.sidebar';
const MAX_PINNED = 8;

export interface SidebarPersisted {
  collapsed: boolean;
  pinned: string[];
  /** Zones the user has collapsed in the rail. Empty = all zones open. */
  collapsedZones: NavZone[];
  /**
   * Sub-groups (NAV_SUB_GROUPS ids, or `project:<group>`) the user has OPENED.
   * Sub-groups are collapsed by default; one that holds the active route opens
   * on its own without being listed here. Best-effort, never required.
   */
  openGroups: string[];
}

const EMPTY: SidebarPersisted = { collapsed: false, pinned: [], collapsedZones: [], openGroups: [] };
const MAX_OPEN_GROUPS = 32;

const VALID_ZONES: readonly NavZone[] = ['work', 'knowledge', 'engine', 'govern'];

export function loadSidebar(): SidebarPersisted {
  if (typeof localStorage === 'undefined') return { ...EMPTY };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const p = parsed as Partial<SidebarPersisted>;
    const pinned = Array.isArray(p.pinned)
      ? p.pinned.filter((x): x is string => typeof x === 'string').slice(0, MAX_PINNED)
      : [];
    const collapsedZones = Array.isArray(p.collapsedZones)
      ? p.collapsedZones.filter((x): x is NavZone => VALID_ZONES.includes(x as NavZone))
      : [];
    const openGroups = Array.isArray(p.openGroups)
      ? p.openGroups.filter((x): x is string => typeof x === 'string').slice(0, MAX_OPEN_GROUPS)
      : [];
    return { collapsed: p.collapsed === true, pinned, collapsedZones, openGroups };
  } catch {
    return { ...EMPTY };
  }
}

export function persistSidebar(state: SidebarPersisted): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode / quota exceeded — sidebar prefs are best-effort.
  }
}

class SidebarStore {
  collapsed = $state(loadSidebar().collapsed);
  pinned = $state<string[]>(loadSidebar().pinned);
  collapsedZones = $state<NavZone[]>(loadSidebar().collapsedZones);
  openGroups = $state<string[]>(loadSidebar().openGroups);
  /**
   * Groups the user CLOSED while the active route was inside them. Session-only
   * on purpose: persisting it would stop a group from ever auto-expanding again.
   */
  closedActiveGroups = $state<string[]>([]);

  #persist(): void {
    persistSidebar({
      collapsed: this.collapsed,
      pinned: this.pinned,
      collapsedZones: this.collapsedZones,
      openGroups: this.openGroups,
    });
  }

  /**
   * Is sub-group `id` expanded? Collapsed by default; auto-expanded when it
   * contains the active route (`containsActive`) unless the user closed it.
   */
  isGroupOpen(id: string, containsActive: boolean): boolean {
    return containsActive
      ? !this.closedActiveGroups.includes(id)
      : this.openGroups.includes(id);
  }

  toggleGroup(id: string, containsActive: boolean): void {
    if (containsActive) {
      this.closedActiveGroups = this.closedActiveGroups.includes(id)
        ? this.closedActiveGroups.filter((g) => g !== id)
        : [...this.closedActiveGroups, id];
      return;
    }
    this.openGroups = this.openGroups.includes(id)
      ? this.openGroups.filter((g) => g !== id)
      : [...this.openGroups, id].slice(-MAX_OPEN_GROUPS);
    this.#persist();
  }

  /** Open a group unconditionally (collapsed-rail header click). */
  openGroup(id: string): void {
    this.closedActiveGroups = this.closedActiveGroups.filter((g) => g !== id);
    if (!this.openGroups.includes(id)) {
      this.openGroups = [...this.openGroups, id].slice(-MAX_OPEN_GROUPS);
      this.#persist();
    }
  }

  isZoneCollapsed(zone: NavZone): boolean {
    return this.collapsedZones.includes(zone);
  }

  toggleZone(zone: NavZone): void {
    this.collapsedZones = this.isZoneCollapsed(zone)
      ? this.collapsedZones.filter((z) => z !== zone)
      : [...this.collapsedZones, zone];
    this.#persist();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.#persist();
  }

  setCollapsed(value: boolean): void {
    this.collapsed = value;
    this.#persist();
  }

  isPinned(id: string): boolean {
    return this.pinned.includes(id);
  }

  /** Pin a destination by NavItem id (dedup, capped at MAX_PINNED, append). */
  pin(id: string): void {
    if (this.pinned.includes(id)) return;
    this.pinned = [...this.pinned, id].slice(0, MAX_PINNED);
    this.#persist();
  }

  unpin(id: string): void {
    if (!this.pinned.includes(id)) return;
    this.pinned = this.pinned.filter((p) => p !== id);
    this.#persist();
  }

  togglePin(id: string): void {
    if (this.isPinned(id)) this.unpin(id);
    else this.pin(id);
  }
}

export const sidebar = new SidebarStore();
