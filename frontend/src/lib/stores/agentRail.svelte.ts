/**
 * agentRail — single source of truth for the right-rail Agent UI.
 *
 * Replaces the always-visible center thread pane. The rail is summoned
 * (⌘⇧A or CmdK), carries the chat surface in the [Agent] tab, and the
 * existing ContextualPane in the [Detail] tab. Project routes pin a
 * projectId so a fresh thread is automatically project-scoped.
 *
 * URL <-> store sync (`?thread=<id>`) lives in the root +layout.
 */

type Tab = 'agent' | 'detail';

class AgentRailState {
  isOpen = $state(false);
  activeThreadId = $state<string | null>(null);
  projectId = $state<string | null>(null);
  tab = $state<Tab>('agent');

  open(): void {
    this.isOpen = true;
  }
  close(): void {
    this.isOpen = false;
  }
  toggle(): void {
    this.isOpen = !this.isOpen;
  }

  openThread(id: string): void {
    this.activeThreadId = id;
    this.tab = 'agent';
    this.isOpen = true;
  }

  /** Summon the rail on the [Agent] tab (no thread) — on a tenant page that is the project gate. */
  openAgentTab(): void {
    this.tab = 'agent';
    this.isOpen = true;
  }

  /** Summon the rail on the [Detail] tab — the ContextualPane's only door. */
  openDetail(): void {
    this.tab = 'detail';
    this.isOpen = true;
  }

  /**
   * Is a THREAD what the rail is currently showing? Not the same as `isOpen`.
   *
   * `close()` deliberately keeps `activeThreadId` (only `reset()` clears it), so
   * "the rail is open" and "a thread is on screen" diverge the moment the rail
   * can be opened on [Detail] — which openDetail() now does. Anything that
   * describes the visible thread (the ?thread= URL param, the thread fetch) must
   * ask this, or it will speak for a thread the user cannot see.
   */
  get showsThread(): boolean {
    return this.isOpen && this.tab === 'agent';
  }

  /**
   * fr-agui §5.7 / P1c-b: threads the rail refused on THIS surface because they
   * are bound elsewhere (another project, or unbound inside a project shell). A
   * stale `?thread=` link must not re-open one; cleared when the surface changes.
   */
  #refused = new Set<string>();

  /** Drop the active thread as bound elsewhere; it is not re-opened on this surface. */
  refuseThread(id: string | null): void {
    if (id) this.#refused.add(id);
    this.activeThreadId = null;
  }
  isRefusedThread(id: string): boolean {
    return this.#refused.has(id);
  }

  setProjectContext(id: string): void {
    if (this.projectId !== id) this.#refused.clear();
    this.projectId = id;
  }
  clearProjectContext(): void {
    if (this.projectId !== null) this.#refused.clear();
    this.projectId = null;
  }

  switchTab(tab: Tab): void {
    this.tab = tab;
  }

  reset(): void {
    this.#refused.clear();
    this.isOpen = false;
    this.activeThreadId = null;
    this.projectId = null;
    this.tab = 'agent';
  }
}

export const agentRail = new AgentRailState();
