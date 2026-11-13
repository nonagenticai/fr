<!--
  UmlDeletePanel — delete a UML element, relationship, interaction or diagram.
  requirements_management removes what depends on it with it (owned elements,
  relationships with an end on it, diagram shapes); the person types the item's
  name to confirm, and afterwards is told what went with it. A refusal (another
  item still refers to it) is shown in plain words, nothing removed.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { deleteUml, type UmlResource } from '$lib/api/modeling';

  let { resource, itemId, name, noun, backHref, head }: { resource: UmlResource; itemId: string; name: string; noun: string; backHref: string; head?: number } = $props();

  let open = $state(false);
  let typed = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let removed = $state<string | null>(null);
  const matches = $derived(name.trim() !== '' && typed.trim() === name.trim());

  const WORD: Record<string, string> = {
    elements: 'elements',
    relationships: 'relationships',
    interactions: 'interactions',
    diagrams: 'diagrams',
    diagram_objects: 'diagram shapes',
    diagram_connections: 'diagram lines',
    trace_links: 'trace links',
  };

  async function remove(): Promise<void> {
    if (!matches) return;
    busy = true;
    error = null;
    try {
      const out = await deleteUml(resource, itemId, head);
      const parts = Object.entries(out.cascaded ?? {})
        .filter(([, ids]) => ids.length > 0)
        .map(([k, ids]) => `${ids.length} ${WORD[k] ?? k.replace(/_/g, ' ')}`);
      removed = parts.length ? `Deleted, together with ${parts.join(', ')}.` : 'Deleted.';
      setTimeout(() => goto(backHref), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex flex-col gap-2 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-surface)] p-4" data-testid="uml-delete">
  <h2 class="text-base font-semibold text-[var(--color-text)]">Delete this {noun}</h2>
  {#if removed}
    <p class="text-sm text-[var(--color-text)]" data-testid="uml-delete-done">{removed} Returning to the model…</p>
  {:else if !open}
    <button type="button" class="self-start rounded-md border border-[var(--color-danger-border)] px-3 py-1.5 text-sm font-semibold text-[var(--color-danger)]" onclick={() => (open = true)} data-testid="uml-delete-start">Delete…</button>
  {:else}
    <p class="text-sm text-[var(--color-text)]">What depends on it is deleted with it. Type <strong>{name}</strong> to confirm.</p>
    <input class="max-w-md rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" bind:value={typed} autocomplete="off" aria-label={`The ${noun}'s name`} data-testid="uml-delete-typed" />
    {#if error}<p class="text-sm text-[var(--color-danger)]" data-testid="uml-delete-error">{error}</p>{/if}
    <div class="flex gap-2">
      <button type="button" class="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={!matches || busy} onclick={remove} data-testid="uml-delete-confirm">{busy ? 'Deleting…' : `Delete the ${noun}`}</button>
      <button type="button" class="px-3 py-1.5 text-sm text-[var(--color-text-muted)]" onclick={() => { open = false; typed = ''; error = null; }}>Cancel</button>
    </div>
  {/if}
</section>
