<!--
  /threads index — list of the user's agent threads.

  The sidebar Workspace > Threads link and the agent rail's "View all
  threads →" link both target /threads. Until this page existed they
  both 404'd. The page reuses the existing `threads` store so navigating
  to a thread keeps the agent rail and focus-mode in sync.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { threadPreviewText } from '$lib/api/agent-redact';
  import { threads } from '$lib/stores/threads.svelte';

  let loading = $state(true);
  let loadError = $state<string | null>(null);

  onMount(async () => {
    loading = true;
    loadError = null;
    try {
      await threads.list();
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load conversations';
    } finally {
      loading = false;
    }
  });

  async function newThread() {
    loadError = null;
    try {
      const t = await threads.create({ channel: 'web' });
      window.location.href = `/threads/${t.id}`;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to create conversation';
    }
  }

  function relativeUpdated(iso: string): string {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return '';
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
</script>

<section class="threads-page">
  <header class="page-head">
    <div>
      <h1>Assistant</h1>
      <p class="lede">Your agent conversations across channels and projects.</p>
    </div>
    <button type="button" class="new-thread" onclick={newThread}>+ New conversation</button>
  </header>

  {#if loading}
    <p class="empty" data-testid="threads-loading">Loading conversations…</p>
  {:else if loadError}
    <p class="empty error" data-testid="threads-error">Couldn't load conversations: {loadError}</p>
  {:else if threads.threads.length === 0}
    <p class="empty" data-testid="threads-empty">No conversations yet — start one from the agent rail or with the button above.</p>
  {:else}
    <ul class="thread-list" data-testid="threads-list">
      {#each threads.threads as t (t.id)}
        <li>
          <a
            class="thread"
            href={t.projectId
              ? `/projects/${encodeURIComponent(t.projectId)}/threads/${encodeURIComponent(t.id)}`
              : `/threads/${t.id}`}
          >
            <div class="row">
              <span class="title">{threadPreviewText(t.lastMessagePreview, 'New conversation')}</span>
              <span class="when" title={t.updatedAt}>{relativeUpdated(t.updatedAt)}</span>
            </div>
            <div class="meta">
              <span>{t.channel}</span>
              <span>•</span>
              <span>{t.messageCount} message{t.messageCount === 1 ? '' : 's'}</span>
              {#if t.workerName}<span>•</span><span class="worker">{t.workerName}</span>{/if}
            </div>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .threads-page {
    padding: 24px 32px;
    max-width: 880px;
    margin: 0 auto;
  }
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  .page-head h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
  }
  .lede {
    margin: 4px 0 0;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .new-thread {
    padding: 7px 14px;
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-on-primary);
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .new-thread:hover {
    filter: brightness(1.08);
  }
  .empty {
    color: var(--color-text-muted);
    padding: 16px 0;
  }
  .empty.error {
    color: var(--color-danger, #dc2626);
  }
  .thread-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .thread {
    display: block;
    padding: 12px 14px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
    transition: border-color 120ms ease;
  }
  .thread:hover {
    border-color: var(--color-accent);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .meta {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .worker {
    font-family: ui-monospace, SFMono-Regular, monospace;
  }
</style>
