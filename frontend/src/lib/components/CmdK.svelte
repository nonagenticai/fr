<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { threadPreviewText } from '$lib/api/agent-redact';
  import { goto } from '$app/navigation';
  import { Dialog } from '$lib/components/ui';
  import { threads } from '$lib/stores/threads.svelte';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { commandPalette } from '$lib/stores/commandPalette.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces, WORKSPACE_KIND_LABEL } from '$lib/stores/workspaces.svelte';
  import { switchTenant } from '$lib/actions/switchTenant';
  import {
    ALL_ROUTES,
    isItemVisible,
    ZONE_LABELS,
    toNavRoles,
    type NavRole,
  } from '$lib/layout/navConfig';
  import { searchEntities, type EntityKind, type EntityResult } from '$lib/api/search';

  // Operator command palette. Destinations are derived from the single nav
  // registry (ALL_ROUTES) and gated by the SAME predicate the sidebar uses
  // (isItemVisible) so the palette can never drift from what a user can see.
  // Sections: Recents · Go to · Create · Actions · Tenants · Conversations · Entities.
  // Entity search streams in async (jump-to-asset/workflow); the rest stay instant.
  type Group =
    | 'Recents'
    | 'Go to'
    | 'Create'
    | 'Actions'
    | 'Tenants'
    | 'Conversations'
    | 'Entities';
  interface Command {
    id: string;
    label: string;
    hint: string;
    group: Group;
    run: () => void | Promise<void>;
    /** Stateful toggles aren't worth remembering; default true. */
    remember?: boolean;
  }

  let cheatSheetOpen = $state(false);
  let highlightedIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  const SHORTCUTS: Array<{ keys: string; label: string }> = [
    { keys: '⌘ K', label: 'Open command palette' },
    { keys: '⌘ J', label: 'Toggle agent rail' },
    { keys: '?', label: 'Show this cheat sheet' },
    { keys: 'Esc', label: 'Close any open palette / sheet' },
    { keys: '↑ ↓', label: 'Navigate command list' },
    { keys: 'Enter', label: 'Run highlighted command' },
  ];

  $effect(() => {
    if (commandPalette.open) {
      // Focus the input when the dialog opens. Replaces the autofocus
      // attribute (a11y rule disallows static autofocus on inputs).
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  // fr#1221: RUNTIME narrowing, not an assertion — the palette and the rail must apply
  // the SAME predicate to the SAME normalised roles, or they drift.
  const roles = $derived<NavRole[]>(toNavRoles(auth.tenantRoles));
  const isSuper = $derived(auth.isSuperAdmin);

  // Routes: every sidebar-visible destination, gated identically to the rail.
  const routeCommands = $derived<Command[]>(
    ALL_ROUTES.filter((item) =>
      isItemVisible(item, roles, { isSuperAdmin: isSuper }),
    ).map(
      (item) => ({
        id: `route:${item.id}`,
        label: item.label,
        hint: ZONE_LABELS[item.zone],
        group: 'Go to' as const,
        run: () => goto(item.href),
      }),
    ),
  );

  const CREATE_DEFS: Array<{ id: string; label: string; href: string; adminOnly?: boolean }> = [
    { id: 'create:requirement', label: 'New Requirement', href: '/requirements/new' },
    { id: 'create:decision', label: 'New Decision', href: '/decisions/new' },
    { id: 'create:principle', label: 'New Principle', href: '/principles/new' },
    { id: 'create:worker', label: 'New Worker', href: '/workers/new' },
    // Channel registry is admin-only, mirroring the sidebar gate.
    { id: 'create:channel', label: 'New Channel', href: '/channels/new', adminOnly: true },
  ];

  const createCommands = $derived<Command[]>(
    CREATE_DEFS.filter((d) => !d.adminOnly || roles.includes('workspace-admin')).map((d) => ({
      id: d.id,
      label: d.label,
      hint: 'Create',
      group: 'Create' as const,
      run: () => goto(d.href),
    })),
  );

  const actionCommands = $derived<Command[]>([
    {
      id: 'action:toggle-rail',
      label: agentRail.isOpen ? 'Close Agent rail' : 'Open Agent rail',
      hint: '⌘ ⇧ A',
      group: 'Actions',
      run: () => agentRail.toggle(),
      remember: false,
    },
  ]);

  // Tenants: keyboard path for the WorkspaceSwitcher. Only when the user has
  // more than one workspace (members with a single tenant get nothing to
  // switch to — mirrors the switcher rendering a static span at length 1).
  // Super-admins see the internal tenants for free (already in the list).
  const tenantCommands = $derived<Command[]>(
    workspaces.workspaces.length > 1
      ? workspaces.workspaces.map((w) => ({
          id: `tenant:${w.id}`,
          label: `${WORKSPACE_KIND_LABEL[w.kind]} · ${w.name}`,
          hint: w.id === workspaces.activeId ? 'Current tenant' : 'Switch tenant',
          group: 'Tenants' as const,
          run: () => switchTenant(w.id),
          remember: false,
        }))
      : [],
  );

  const threadCommands = $derived<Command[]>(
    threads.threads.slice(0, 10).map((t) => ({
      id: `thread:${t.id}`,
      label: threadPreviewText(t.lastMessagePreview, 'New conversation'),
      hint: `Conversation · ${t.channel}`,
      group: 'Conversations' as const,
      run: () => goto(`/threads/${t.id}`),
    })),
  );

  // Entity search (requirements / principles / decisions / workflows).
  // Streamed in async on the typed query so the synchronous sections never block.
  const KIND_LABEL: Record<EntityKind, string> = {
    requirement: 'Requirement',
    principle: 'Principle',
    decision: 'Decision',
    workflow: 'Workflow',
  };

  function entityToCommand(e: EntityResult): Command {
    return {
      id: `entity:${e.kind}:${e.id}`,
      label: e.label,
      hint: e.sublabel ? `${KIND_LABEL[e.kind]} · ${e.sublabel}` : KIND_LABEL[e.kind],
      group: 'Entities',
      run: () => goto(e.href),
      // Transient: recents re-resolve against allCommands (which excludes
      // entities), so a remembered entity id would silently drop. Keep clean.
      remember: false,
    };
  }

  let entityResults = $state<Command[]>([]);
  let entitiesLoading = $state(false);
  // Distinct from "no matches" — the search call itself failed, so we have
  // NO information about whether a match exists. Rendering this the same as
  // an empty entityResults[] told the user their query had no hits when it
  // may well have; there was no error field on this path at all before.
  let entityError = $state<string | null>(null);
  // Latest-wins guard: the typed `.search()` wrappers don't forward an
  // AbortSignal, so we discard any resolve that isn't from the newest query.
  let searchSeq = 0;

  $effect(() => {
    const q = commandPalette.query.trim();
    if (!commandPalette.open || q.length < 2) {
      entityResults = [];
      entitiesLoading = false;
      entityError = null;
      return;
    }
    const seq = ++searchSeq;
    entitiesLoading = true;
    entityError = null;
    const t = setTimeout(() => {
      searchEntities(q)
        .then((items) => {
          if (seq !== searchSeq) return; // stale
          entityResults = items.map(entityToCommand);
          entitiesLoading = false;
        })
        .catch((err) => {
          if (seq !== searchSeq) return;
          entityResults = [];
          entitiesLoading = false;
          entityError = err instanceof Error ? err.message : String(err);
        });
    }, 200);
    return () => clearTimeout(t); // cleanup re-runs on each query change → debounce
  });

  const allCommands = $derived<Command[]>([
    ...routeCommands,
    ...createCommands,
    ...actionCommands,
    ...tenantCommands,
    ...threadCommands,
  ]);

  // Recents re-resolve against the live command list so a stale id (e.g. a
  // deleted thread) silently drops, and the run fn is always current.
  const recentCommands = $derived<Command[]>(
    commandPalette.recents
      .map((r) => allCommands.find((c) => c.id === r.id))
      .filter((c): c is Command => Boolean(c))
      .map((c) => ({ ...c, group: 'Recents' as const })),
  );

  const results = $derived.by<Command[]>(() => {
    const q = commandPalette.query.trim().toLowerCase();
    if (!q) {
      return [
        ...recentCommands,
        ...routeCommands,
        ...createCommands,
        ...actionCommands,
        ...tenantCommands,
        ...threadCommands,
      ];
    }
    return [
      ...allCommands.filter(
        (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
      ),
      // Entities are already server-matched on the query — append after the
      // instant local matches so late async arrivals don't reflow the cursor.
      ...entityResults,
    ];
  });

  function runCommand(cmd: Command): void {
    commandPalette.hide();
    if (cmd.remember !== false) {
      commandPalette.remember({ id: cmd.id, label: cmd.label, hint: cmd.hint });
    }
    void cmd.run();
  }

  function isInTextInput(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function handleKeyDown(e: KeyboardEvent): void {
    // ⌘⇧A and ⌘J both toggle the agent rail. ⌘⇧A retained for muscle memory;
    // ⌘J is the new canonical (advertised in the ? cheat sheet).
    const cmdShiftA = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a';
    const cmdJ = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'j';
    if (cmdShiftA || cmdJ) {
      e.preventDefault();
      agentRail.toggle();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      cheatSheetOpen = false;
      highlightedIdx = 0;
      commandPalette.toggle();
      return;
    }
    // ? (Shift+/) — keybinding cheat sheet. Suppress when typing in inputs
    // or when CmdK is already open (its own ? is just a literal char).
    if (e.key === '?' && !commandPalette.open && !isInTextInput(e.target)) {
      e.preventDefault();
      cheatSheetOpen = !cheatSheetOpen;
      return;
    }
    if (cheatSheetOpen && e.key === 'Escape') {
      cheatSheetOpen = false;
      return;
    }
    if (!commandPalette.open) return;
    if (e.key === 'Escape') {
      commandPalette.hide();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightedIdx = Math.min(highlightedIdx + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightedIdx = Math.max(highlightedIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[highlightedIdx];
      if (cmd) runCommand(cmd);
    }
  }

  onMount(() => window.addEventListener('keydown', handleKeyDown));
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeyDown);
  });
</script>

<Dialog bind:open={commandPalette.open}>
  <div class="flex flex-col gap-1 w-[480px] max-h-[440px]">
    <input
      type="text"
      class="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
      placeholder="Go to, create, search conversations…"
      bind:this={inputEl}
      bind:value={commandPalette.query}
      oninput={() => (highlightedIdx = 0)}
    />
    <ul class="mt-2 flex flex-col gap-0.5 overflow-auto">
      {#each results as cmd, i (cmd.group + ':' + cmd.id)}
        {#if i === 0 || results[i - 1]?.group !== cmd.group}
          <li
            class="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
            aria-hidden="true"
          >
            {cmd.group}
          </li>
        {/if}
        <li>
          <button
            type="button"
            class={`flex w-full items-baseline justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-strong)] ${i === highlightedIdx ? 'bg-[var(--color-surface-strong)]' : ''}`}
            onclick={() => runCommand(cmd)}
            onmouseenter={() => (highlightedIdx = i)}
          >
            <span class="truncate">{cmd.label}</span>
            <span class="shrink-0 text-xs text-[var(--color-text-muted)]">{cmd.hint}</span>
          </button>
        </li>
      {/each}
      {#if entitiesLoading}
        <li class="px-3 py-1.5 text-xs text-[var(--color-text-muted)]" aria-hidden="true">
          Searching…
        </li>
      {:else if entityError}
        <!-- Distinct from "No matches." below — the entity search FAILED, so
             absence of entity results here is unknown, not confirmed zero. -->
        <li class="px-3 py-1.5 text-xs text-[var(--color-danger)]" role="alert" data-testid="cmdk-entity-search-error">
          Couldn't search: {entityError}
        </li>
      {/if}
      <!-- `!entityError` is load-bearing: `results` includes entityResults, which
           a FAILED search leaves empty, so without this a failed search renders
           "Couldn't search: …" AND "No matches." together — reinstating the exact
           ambiguity the error line exists to remove. -->
      {#if results.length === 0 && !entitiesLoading && !entityError}
        <p class="px-3 py-2 text-xs text-[var(--color-text-muted)]">No matches.</p>
      {/if}
    </ul>
    <div class="mt-2 flex justify-end">
      <button
        type="button"
        class="text-[10px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        onclick={() => { commandPalette.hide(); cheatSheetOpen = true; }}
      >
        Press ? for shortcuts
      </button>
    </div>
  </div>
</Dialog>

<Dialog bind:open={cheatSheetOpen}>
  <div class="flex flex-col gap-3 w-[420px]">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
      Keyboard shortcuts
    </h2>
    <ul class="flex flex-col gap-1.5">
      {#each SHORTCUTS as s (s.keys)}
        <li class="flex items-center justify-between gap-3 px-1 py-1 text-sm">
          <span class="text-[var(--color-text)]">{s.label}</span>
          <kbd class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-2 py-0.5 font-mono text-xs text-[var(--color-text-muted)]">
            {s.keys}
          </kbd>
        </li>
      {/each}
    </ul>
    <p class="text-[11px] text-[var(--color-text-muted)]">Press Esc to close.</p>
  </div>
</Dialog>
