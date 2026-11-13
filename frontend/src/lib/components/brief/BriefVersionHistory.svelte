<!--
  BriefVersionHistory — every version of the project brief, newest first: who wrote it (your
  request or the conveyor), when, and its note. "View" opens that version in the page above.
  Display only: the brief is read-only here.
-->
<script lang="ts">
  import type { BriefVersionSummary } from '$lib/api/project-brief';
  import { formatLocalDateTime } from '$lib/projects/brief-diff';

  let {
    versions,
    current = null,
    viewing = null,
    onOpen,
  }: {
    versions: BriefVersionSummary[];
    current?: number | null;
    viewing?: number | null;
    onOpen: (version: number) => void;
  } = $props();

  const rows = $derived([...versions].sort((a, b) => b.version - a.version));

  function author(kind: BriefVersionSummary['author_kind']): string {
    return kind === 'user' ? 'Your request' : kind === 'conveyor' ? 'Conveyor' : String(kind);
  }
</script>

<section
  class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  data-testid="brief-history"
>
  <h2 class="text-sm font-semibold">History · {rows.length} {rows.length === 1 ? 'version' : 'versions'}</h2>
  <ol class="mt-2 divide-y divide-[var(--color-border)] text-sm">
    {#each rows as v (v.version)}
      <li class="flex flex-wrap items-baseline gap-2 py-1.5" data-testid="brief-history-row">
        <span class="font-semibold">v{v.version}</span>
        <span data-testid="brief-history-author">{author(v.author_kind)}</span>
        <span class="text-[var(--color-text-muted)]">{formatLocalDateTime(v.created_at)}</span>
        {#if current !== null && v.version === current}
          <span class="text-xs text-[var(--color-text-muted)]">(current)</span>
        {/if}
        {#if v.note}
          <span class="basis-full whitespace-pre-wrap break-words text-[var(--color-text-muted)]" data-testid="brief-history-note">{v.note}</span>
        {/if}
        <span class="ml-auto">
          {#if viewing === v.version}
            <span class="text-xs font-medium" data-testid="brief-history-viewing">Viewing</span>
          {:else}
            <button
              type="button"
              class="text-xs underline"
              onclick={() => onOpen(v.version)}
              data-testid="brief-history-view">View</button
            >
          {/if}
        </span>
      </li>
    {/each}
  </ol>
</section>
