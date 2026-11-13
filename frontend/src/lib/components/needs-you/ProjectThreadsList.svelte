<!--
  ProjectThreadsList — the caller's OWN agent conversations bound to this project (fr-agui SPEC §7.3
  "Agent"), shown inside Needs you since R4 (the old /projects/[id]/threads page 308s there).

  Other members' chats are never listed: GET /api/agui/threads is scoped to the agent token's user,
  narrowed to this project SERVER-side (`?projectId=`) — a client-side filter of the 100 newest lost
  every older thread of the project.

  A thread carries no "waiting for you" state in the data model (ThreadSummary: channel, counts,
  preview, timestamps), so conversations are LISTED here, never counted as asks.
-->
<script lang="ts">
  import { threadPreviewText } from '$lib/api/agent-redact';
  import { threads, type ThreadSummary } from '$lib/stores/threads.svelte';
  import { shortTime } from '$lib/components/cockpit/spine';

  let { projectId }: { projectId: string } = $props();

  let list = $state<ThreadSummary[] | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const id = projectId;
    if (!id) return;
    let live = true;
    list = null;
    loadError = null;
    threads
      .listForProject(id)
      .then((l) => {
        if (live) list = l;
      })
      .catch((err) => {
        if (live) loadError = err instanceof Error ? err.message : 'Failed to load conversations';
      });
    return () => {
      live = false;
    };
  });

  function threadHref(id: string): string {
    return `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(id)}`;
  }

  async function newThread(): Promise<void> {
    loadError = null;
    try {
      const t = await threads.create({ channel: 'web', projectId });
      window.location.href = threadHref(t.id);
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to create conversation';
    }
  }
</script>

<section aria-labelledby="needs-you-threads" data-testid="needs-you-threads">
  <div class="mb-2 flex items-center justify-between gap-2">
    <h2 id="needs-you-threads" class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
      Your conversations about this project
    </h2>
    <button type="button" class="text-xs font-semibold text-[var(--color-link)] hover:underline" onclick={newThread}>
      + New conversation
    </button>
  </div>
  {#if loadError}
    <p class="text-xs text-[var(--color-warning-text)]" data-testid="project-threads-error">Couldn't load conversations: {loadError}</p>
  {:else if list === null}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="project-threads-loading">Loading conversations…</p>
  {:else if list.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="project-threads-empty">No conversations about this project yet.</p>
  {:else}
    <ul
      class="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface)]"
      data-testid="project-threads-list"
    >
      {#each list as t (t.id)}
        <li class="flex items-baseline gap-2 px-3 py-2 text-sm">
          <a class="min-w-0 flex-1 truncate text-[var(--color-text)] hover:underline" href={threadHref(t.id)}
            >{threadPreviewText(t.lastMessagePreview, 'New conversation')}</a
          >
          <span class="shrink-0 text-[11px] text-[var(--color-text-muted)]"
            >{t.messageCount} message{t.messageCount === 1 ? '' : 's'}{t.updatedAt ? ` · ${shortTime(t.updatedAt)}` : ''}</span
          >
        </li>
      {/each}
    </ul>
  {/if}
</section>
