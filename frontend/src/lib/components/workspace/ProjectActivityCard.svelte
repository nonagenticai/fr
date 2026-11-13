<script lang="ts">
  import { authFetch } from '$lib/api/auth-fetch';
  import { workspaces } from '$lib/stores/workspaces.svelte';

  // Project-scoped activity feed for the Project Workspace cockpit.
  // Backed by GET /api/projects/:id/activity (approval decisions + comments
  // + n8n reports, scoped to this project). Self-contained like the home
  // dashboard's RecentActivityCard — it fetches on its own mount, so the
  // cockpit page's load() is untouched.
  let { projectId }: { projectId: string } = $props();

  interface ActivityRow {
    id: string;
    actor?: string | null;
    verb?: string;
    target?: string;
    ts?: string;
  }

  type State =
    | { kind: 'loading' }
    | { kind: 'ready'; rows: ActivityRow[] }
    | { kind: 'unavailable' };

  let state = $state<State>({ kind: 'loading' });

  function relativeTime(ts?: string): string {
    if (!ts) return '';
    const then = Date.parse(ts);
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(months / 12)}y ago`;
  }

  // Refetch on mount, on projectId change, and on every tenant switch
  // (read both reactive deps before the await).
  $effect(() => {
    void workspaces.activeId;
    const id = projectId;
    let cancelled = false;
    state = { kind: 'loading' };
    void (async () => {
      try {
        const r = await authFetch(`/api/projects/${id}/activity?limit=20`);
        if (cancelled) return;
        if (!r.ok) {
          state = { kind: 'unavailable' };
          return;
        }
        const body = await r.json();
        if (cancelled) return;
        const rows = (body?.data ?? []) as ActivityRow[];
        state = { kind: 'ready', rows };
      } catch {
        if (!cancelled) state = { kind: 'unavailable' };
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

<section
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
>
  <h3 class="text-sm font-medium">Activity</h3>
  {#if state.kind === 'loading'}
    <div class="mt-3 space-y-2">
      <div class="h-5 animate-pulse rounded bg-[var(--color-surface-strong)]"></div>
      <div class="h-5 animate-pulse rounded bg-[var(--color-surface-strong)]"></div>
      <div class="h-5 animate-pulse rounded bg-[var(--color-surface-strong)]"></div>
    </div>
  {:else if state.kind === 'ready' && state.rows.length === 0}
    <p class="mt-3 text-xs text-[var(--color-text-muted)]">No activity yet for this project.</p>
  {:else if state.kind === 'ready'}
    <ul class="mt-3 space-y-1.5">
      {#each state.rows as a (a.id)}
        <li class="flex items-baseline gap-2 text-xs">
          <span class="font-medium">{a.actor ?? 'system'}</span>
          <span class="text-[var(--color-text-muted)]">{a.verb ?? ''}</span>
          <span class="min-w-0 flex-1 truncate">{a.target ?? ''}</span>
          <span class="shrink-0 text-[var(--color-text-muted)]">{relativeTime(a.ts)}</span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-3 text-xs text-[var(--color-text-muted)]">Activity feed unavailable.</p>
  {/if}
</section>
