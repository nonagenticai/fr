<script lang="ts">
  // One agent thread in focus mode, shared by the tenant route `/threads/[id]`
  // and the project-shell route `/projects/[id]/threads/[threadId]` (fr-agui
  // SPEC §7.3 "Agent"). Once the server has returned the thread, the view moves
  // to where the thread's bound project says it lives (§7.5). The chat itself
  // renders only once that binding matches this surface (see `surface`).
  import { page } from '$app/stores';
  import { threadPreviewText } from '$lib/api/agent-redact';
  import { goto } from '$app/navigation';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { threadViewRedirect } from '$lib/projects/projectShellRedirects';

  let { threadId, routeProjectId }: { threadId: string; routeProjectId: string | null } = $props();

  // Sync the threads store with this route's id, and close the rail in
  // focus mode so we don't render the chat surface twice.
  $effect(() => {
    if (threads.activeThreadId !== threadId) {
      void threads.select(threadId);
    }
    if (agentRail.isOpen) agentRail.close();
  });

  // §7.5: act only on the project the server returned for THIS thread.
  const redirectTo = $derived(
    threads.activeThreadId === threadId
      ? threadViewRedirect(threadId, routeProjectId, threads.activeThreadProjectId)
      : null,
  );
  $effect(() => {
    const to = redirectTo;
    if (to) void goto(to, { replaceState: true });
  });

  // ⛔ fr-agui SPEC §5.1 / §13 P1c, OQ-17 = (c): the chat surface mounts ONLY where
  // the agent may run — in the project shell for a thread bound to THAT project,
  // and, on the tenant route, for an UNBOUND thread, as the doorway (request-
  // intake) view. Until the server has stated the thread's binding, and while a
  // bound thread is being redirected into its project shell, nothing chat-capable
  // renders (fail closed: no message can be sent into a thread whose binding is
  // not this surface's).
  const surface = $derived<'chat' | 'intake' | 'pending'>(
    threads.activeThreadId !== threadId || redirectTo !== null
      ? 'pending'
      : routeProjectId === null
        ? threads.activeThreadProjectId === null
          ? 'intake'
          : 'pending'
        : threads.activeThreadProjectId === routeProjectId
          ? 'chat'
          : 'pending',
  );

  // The unbound thread on the tenant route is a doorway thread: the agent runs in
  // request-intake mode there (§6.0), exactly as the doorway rail sets it.
  $effect(() => {
    if (surface !== 'intake') return;
    threads.mode = 'intake';
    return () => {
      threads.mode = 'default';
    };
  });

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(
      $page.url.pathname,
      threads.activeThread?.lastMessagePreview ? threadPreviewText(threads.activeThread.lastMessagePreview, '') : null,
    );
  });
</script>

<div class="mx-auto flex h-full max-w-3xl flex-col">
  <header class="border-b border-[var(--color-border)] px-2 py-3">
    <h1 class="truncate text-base font-medium">
      {threadPreviewText(threads.activeThread?.lastMessagePreview, 'Thread')}
    </h1>
  </header>
  {#if surface === 'pending'}
    <p class="px-2 py-4 text-sm text-[var(--color-text-muted)]" data-testid="thread-focus-pending">
      Opening the thread…
    </p>
  {:else}
    <div
      class="flex min-h-0 flex-1 flex-col"
      data-agent-surface="thread"
      data-agent-mode={surface === 'intake' ? 'intake' : 'project'}
      data-testid="thread-focus-chat"
    >
      <div class="min-h-0 flex-1 overflow-y-auto">
        <MessageList />
      </div>
      <ChatInput />
    </div>
  {/if}
</div>
