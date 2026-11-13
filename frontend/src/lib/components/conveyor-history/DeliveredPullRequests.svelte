<!--
  DeliveredPullRequests — the pull requests the conveyor named in its card comments, with
  repository, branch and (when GitHub answered) their state.
-->
<script lang="ts">
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { DeliveredPr } from '$lib/types/conveyor-history';
  import { prStateLabel, when } from './view';

  let { block }: { block: Panel<{ pull_requests: DeliveredPr[] }> } = $props();

  const prs = $derived(hasData(block) ? (block.data?.pull_requests ?? []) : []);
</script>

<section data-testid="conveyor-delivered">
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
    Delivered{hasData(block) ? ` · ${prs.length}` : ''}
  </h3>
  {#if !hasData(block)}
    <PanelNote panel={block} title="Delivered" />
  {:else}
    {#if block.health !== 'ok'}
      <div class="mb-1"><PanelNote panel={block} title="Delivered" /></div>
    {/if}
    {#if prs.length === 0}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="conveyor-delivered-empty">
        No pull request has been named on this project's cards.
      </p>
    {:else}
      <ul class="space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
        {#each prs as pr (pr.url)}
          <li class="text-xs" data-testid="conveyor-delivered-pr">
            <div class="flex flex-wrap items-baseline gap-2">
              <a class="font-semibold text-[var(--color-accent-strong)] underline" href={pr.url} target="_blank" rel="noopener noreferrer">
                {pr.repo} #{pr.number}
              </a>
              {#if pr.state}
                <span class="rounded-full bg-[var(--color-accent-bg)] px-1.5 text-[10px] font-semibold uppercase text-[var(--color-accent-strong)]" data-testid="conveyor-delivered-state">{prStateLabel(pr)}</span>
              {/if}
              {#if pr.branch}<span class="font-mono text-[11px] text-[var(--color-text-muted)]">{pr.branch}</span>{/if}
            </div>
            {#if pr.title}<p class="text-[var(--color-text)]">{pr.title}</p>{/if}
            <p class="text-[11px] text-[var(--color-text-muted)]">
              from “{pr.card_name}” · {when(pr.first_seen_at)}
              {#if !pr.state && pr.state_unavailable}
                <!-- "state not checked: …" (not a project repository) already says what it is. -->
                <span data-testid="conveyor-delivered-state-unavailable"> · {pr.state_unavailable.startsWith('state not checked') ? pr.state_unavailable : `state unavailable: ${pr.state_unavailable}`}</span>
              {/if}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
