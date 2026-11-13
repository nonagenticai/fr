<!--
  "Waiting for you" — the open asks you may decide in this workspace, oldest first.
  Source: GET /api/approvals?mine=1 (pending, tenant-pinned, rows the caller is entitled
  to decide; `total` is a count(*) over the same filter). Each row opens the project's
  decide page.
-->
<script lang="ts">
  import { Skeleton } from '$lib/components/ui';
  import { headlineGist } from '$lib/approvals/plan-text';
  import { decideHref } from '$lib/components/conveyor-history/view';
  import type { Approval } from '$lib/types/api';
  import HomeCard from './HomeCard.svelte';
  import { agoWords, type Load } from './home';

  let {
    asks,
    projectNames,
    now,
  }: {
    asks: Load<{ items: Approval[]; total: number }>;
    projectNames: ReadonlyMap<string, string>;
    now: number;
  } = $props();

  const SHOWN = 5;

  function titleOf(a: Approval): string {
    const text = (a.change_summary || a.description || '').trim();
    return text ? headlineGist(text) : 'Approval request';
  }

  function hrefOf(a: Approval): string {
    return a.project_id ? decideHref(a.project_id, a.id) : `/approvals/${encodeURIComponent(a.id)}`;
  }
</script>

<HomeCard
  title="Waiting for you"
  explain="Questions and sign-offs you can answer, oldest first."
  linkLabel="All approvals"
  linkHref="/approvals"
  testid="home-needs-you"
>
  {#if asks.kind === 'loading'}
    <Skeleton variant="text" count={3} />
  {:else if asks.kind === 'error'}
    <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="home-needs-you-error">
      Couldn't load what is waiting for you. Open the approvals page to check.
    </p>
  {:else if asks.value.total === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="home-needs-you-empty">
      Nothing is waiting for you right now.
    </p>
  {:else}
    <p class="text-sm text-[var(--color-text)]" data-testid="home-needs-you-count">
      <strong>{asks.value.total}</strong>
      {asks.value.total === 1 ? 'item needs' : 'items need'} your answer.
    </p>
    <ul class="mt-2 divide-y divide-[var(--color-border)]">
      {#each asks.value.items.slice(0, SHOWN) as a (a.id)}
        {@const age = agoWords(a.created_at, now)}
        <li class="py-2">
          <a href={hrefOf(a)} class="block text-sm text-[var(--color-text)] hover:underline">{titleOf(a)}</a>
          <p class="text-xs text-[var(--color-text-muted)]">
            {projectNames.get(a.project_id) ?? 'Project'}{age ? ` · asked ${age}` : ''}
          </p>
        </li>
      {/each}
    </ul>
    {#if asks.value.total > SHOWN}
      <a href="/approvals" class="mt-1 inline-block text-xs text-[var(--color-accent)] hover:underline">
        See all {asks.value.total}
      </a>
    {/if}
  {/if}
</HomeCard>
