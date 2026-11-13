<!--
  CardTocSection.svelte — the TOC / Reasoning summary inside the kanban
  CardModal. A card belongs to a board → project; given the project id, this
  lists the project's TOC reasoning trees (IO-Maps, evaporating clouds, logic
  trees), shows each tree's CLR score badge, and deep-links into the full
  reasoning view scoped to the project.

  Self-contained + best-effort: a fetch failure renders a quiet inline note
  rather than breaking the modal. Renders nothing when no project id is known.
-->
<script lang="ts">
  import { fetchTocTrees, type TocTree } from '$lib/api/toc';
  import { treeTypeColor, treeTypeLabel } from './palette';
  import CLRScoreBadge from './CLRScoreBadge.svelte';

  let {
    projectId,
  }: {
    projectId: string | null | undefined;
  } = $props();

  let trees = $state<TocTree[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    const pid = projectId;
    if (!pid) {
      trees = [];
      return;
    }
    loading = true;
    error = null;
    fetchTocTrees({ projectId: pid, limit: 50 })
      .then((t) => {
        trees = t;
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : 'Failed to load reasoning trees';
        trees = [];
      })
      .finally(() => {
        loading = false;
      });
  });

  const reasoningHref = $derived(
    projectId
      ? `/knowledge/toc?project_id=${encodeURIComponent(projectId)}`
      : '/knowledge/toc',
  );
</script>

{#if projectId}
  <div data-testid="card-toc-section">
    <div class="flex items-center justify-between mb-2">
      <h3
        class="text-xs font-semibold text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]"
      >
        TOC / Reasoning
      </h3>
      <a
        href={reasoningHref}
        class="text-xs text-[var(--color-accent)] hover:underline"
        data-testid="card-toc-open-reasoning"
      >
        Open reasoning view →
      </a>
    </div>

    {#if loading}
      <p class="text-xs text-[var(--color-text-muted)]">Loading reasoning trees…</p>
    {:else if error}
      <p class="text-xs text-[var(--color-text-muted)]">{error}</p>
    {:else if trees.length === 0}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="card-toc-empty">
        No reasoning trees for this project yet.
      </p>
    {:else}
      <ul class="space-y-1.5" data-testid="card-toc-trees">
        {#each trees as tree (tree.id)}
          <li class="flex items-center gap-2 text-xs">
            <span
              class="inline-block w-2 h-2 rounded-full shrink-0"
              style={`background-color: ${treeTypeColor(tree.tree_type)}`}
            ></span>
            <span class="text-[10px] uppercase text-[var(--color-text-muted)] w-28 shrink-0 truncate">
              {treeTypeLabel(tree.tree_type)}
            </span>
            <a
              href={`/knowledge/toc?tree_id=${encodeURIComponent(tree.id)}`}
              class="text-[var(--color-text)] hover:underline truncate flex-1"
              title={tree.title}
            >
              {tree.title}
            </a>
            <CLRScoreBadge score={tree.quality_score ?? null} />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
