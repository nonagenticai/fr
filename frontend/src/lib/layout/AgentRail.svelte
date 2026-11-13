<script lang="ts">
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import AgentRailHeader from './AgentRailHeader.svelte';
  import ContextualPane from './ContextualPane.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { isDoorwayPath } from '$lib/agent/doorway';
  import { onInvalidate } from '$lib/agent/invalidation';
  import { navCounts } from '$lib/stores/navCounts.svelte';
  import { activeProject } from '$lib/stores/activeProject.svelte';

  // fr-agui SPEC §13 P1c (OQ-17 = c): this rail mounts ONLY in the project shell
  // (bound to that project) and on the doorway pages (request intake). Every
  // other tenant page gets TenantSidePane instead — "Open a project to use the
  // agent" plus a project picker (ShellLayout decides; retirement test 1 sweeps it).

  // SPEC §5.1 / §5.7: the chat is bound to the surface it is on. The next thread
  // is created bound to this project (or unbound at the doorway), and a thread
  // KNOWN to be bound elsewhere is dropped rather than continued here — the
  // server would act on ITS project, not on the one this shell shows.
  $effect(() => {
    const surfaceProject = agentRail.projectId;
    // Read so a freshly loaded thread's binding re-runs this check.
    void threads.activeThreadProjectId;
    const active = threads.activeThreadId;
    if (threads.bindToSurface(surfaceProject)) agentRail.refuseThread(active);
  });

  // SPEC §5.4: a checked `ui-intent` navigates with SvelteKit's router.
  $effect(() => {
    threads.navigator = (route: string) => void goto(route);
    return () => {
      threads.navigator = null;
    };
  });

  // SPEC §5.3: the global views a write can change. Page-level views (board,
  // cockpit, sign-offs) subscribe themselves.
  $effect(() => {
    const id = agentRail.projectId;
    const offMe = onInvalidate('approvals:me', () => void navCounts.refresh());
    const offProject = id ? onInvalidate(`project:${id}`, () => void activeProject.load()) : () => {};
    return () => {
      offMe();
      offProject();
    };
  });

  // fr-agui SPEC §6.0: on the create/request doorway pages the agent runs in
  // request-intake mode (create, the request lifecycle, type listing only).
  $effect(() => {
    threads.mode = isDoorwayPath($page.url.pathname) ? 'intake' : 'default';
  });

  // Sync the threads store's active thread with the rail's chosen thread.
  // ChatInput + MessageList read directly from the threads store, so loading
  // here is what populates them. Skipped when the rail is closed to avoid
  // unnecessary fetches.
  // Gated on the [Agent] tab too: activeThreadId survives close(), so opening
  // the rail on [Detail] via an "open in pane" affordance would otherwise fire
  // a thread fetch nothing is about to render. `tab` is reactive, so switching
  // to [Agent] later re-runs this and loads the thread then.
  $effect(() => {
    const id = agentRail.activeThreadId;
    if (id && agentRail.showsThread && threads.activeThreadId !== id) {
      void threads.select(id);
    }
  });

  // Skip an Escape another window-level handler already consumed (e.g. a modal
  // such as ProjectBindMore closing itself) so one keypress closes one layer.
  function onKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && agentRail.isOpen) {
      agentRail.close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if agentRail.isOpen}
  <aside
    class="flex h-full w-[380px] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]"
    aria-label="Agent rail"
    data-agent-surface="rail"
    data-testid="agent-rail"
  >
    <AgentRailHeader />
    <div class="flex min-h-0 flex-1 flex-col">
      {#if agentRail.tab === 'agent'}
        <div class="min-h-0 flex-1 overflow-y-auto">
          <MessageList />
        </div>
        <ChatInput />
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto">
          <ContextualPane />
        </div>
      {/if}
    </div>
  </aside>
{/if}
