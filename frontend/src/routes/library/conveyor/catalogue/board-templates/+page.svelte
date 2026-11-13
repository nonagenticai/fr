<!--
  /library/conveyor/catalogue/board-templates — the tenant's kanban board
  templates (RM catalogue, Tier 2), read-only. Lists, labels and custom field
  groups are NULL until set and read "not set"; an empty list was cleared.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import { listCatalogue, type BoardTemplate, type CatalogueFailure, type ProjectType } from '$lib/api/conveyor-catalogue';
  import { NOT_SET, displayValue } from '$lib/conveyor-catalogue/forms';
  import { listView, rowsOr, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<BoardTemplate>>({ kind: 'loading' });
  let typeTitle = $state<Map<string, string>>(new Map());
  let typesFailure = $state<CatalogueFailure | null>(null);

  async function load(): Promise<void> {
    const [b, pt] = await Promise.all([
      listCatalogue<BoardTemplate>('board-templates'),
      listCatalogue<ProjectType>('project-types'),
    ]);
    view = listView(b);
    const t = rowsOr(pt);
    typeTitle = new Map(t.rows.map((r) => [r.id, r.title || r.name]));
    typesFailure = t.failure;
  }

  onMount(load);

  /** null = not set; [] = cleared; else the entries joined. */
  function listOrNotSet<T>(v: T[] | null | undefined, fmt: (x: T) => string): string {
    if (v == null) return NOT_SET;
    if (v.length === 0) return 'none (cleared)';
    return v.map(fmt).join(', ');
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Board templates"
    subtitle="The kanban board a project of a type starts with: its lists, labels and custom fields."
    {mode}
    onImported={load}
  />

  {#if typesFailure}
    <FailureNotice failure={typesFailure} title="Couldn't read project types" />
  {/if}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p class="font-medium text-[var(--color-text)]">{row.title}</p>
          <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[10rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(row.description)}</dd>
            <dt class="text-[var(--color-text-muted)]">Project type</dt>
            <dd>{row.project_type_id == null ? 'any' : (typeTitle.get(row.project_type_id) ?? row.project_type_id)}</dd>
            <dt class="text-[var(--color-text-muted)]">Lists</dt>
            <dd>
              {listOrNotSet(
                row.lists == null ? row.lists : [...row.lists].sort((a, b) => a.position - b.position),
                (l) => (l.closed ? `${l.name} (closed)` : l.name),
              )}
            </dd>
            <dt class="text-[var(--color-text-muted)]">Labels</dt>
            <dd>{listOrNotSet(row.labels, (l) => (l.color ? `${l.name} (${l.color})` : l.name))}</dd>
            <dt class="text-[var(--color-text-muted)]">Custom field groups</dt>
            <dd>{listOrNotSet(row.custom_field_groups, (g) => `${g.name}: ${displayValue(g.fields)}`)}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="board templates" onImported={load} />
  {/if}
</div>
