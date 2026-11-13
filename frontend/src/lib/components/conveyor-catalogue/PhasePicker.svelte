<!--
  Ordered phase picker for a project type: the selected phases in order (move
  up / down / remove) and the remaining phases to add. Order is what RM stores.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui';
  import type { ProjectPhase } from '$lib/api/conveyor-catalogue';
  import { moveEntry } from '$lib/conveyor-catalogue/forms';

  let { phases, phaseIds = $bindable([]) }: { phases: ProjectPhase[]; phaseIds?: string[] } = $props();

  const byId = $derived(new Map(phases.map((p) => [p.id, p])));
  const remaining = $derived(phases.filter((p) => !phaseIds.includes(p.id)));

  function label(id: string): string {
    const p = byId.get(id);
    return p ? p.title || p.name : `Unknown phase ${id}`;
  }
</script>

<fieldset class="flex flex-col gap-2" data-testid="phase-picker">
  <legend class="text-sm font-medium">Phases, in order</legend>
  <ol class="flex flex-col gap-1">
    {#each phaseIds as id, i (id)}
      <li class="flex flex-wrap items-center gap-2 text-sm">
        <span class="w-6 text-right text-[var(--color-text-muted)]">{i + 1}.</span>
        <span class="min-w-0 flex-1">{label(id)}</span>
        <Button size="sm" variant="ghost" disabled={i === 0} onclick={() => (phaseIds = moveEntry(phaseIds, i, -1))}>Up</Button>
        <Button size="sm" variant="ghost" disabled={i === phaseIds.length - 1} onclick={() => (phaseIds = moveEntry(phaseIds, i, 1))}>Down</Button>
        <Button size="sm" variant="ghost" onclick={() => (phaseIds = phaseIds.filter((x) => x !== id))}>Remove</Button>
      </li>
    {:else}
      <li class="text-xs text-[var(--color-text-muted)]">No phases selected.</li>
    {/each}
  </ol>
  {#if remaining.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each remaining as p (p.id)}
        <Button size="sm" variant="secondary" onclick={() => (phaseIds = [...phaseIds, p.id])}>+ {p.title || p.name}</Button>
      {/each}
    </div>
  {/if}
</fieldset>
