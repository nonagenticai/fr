<!-- src/lib/components/SchemaBuilder.svelte -->
<script lang="ts">
  import type { SchemaState, ObjectField, FieldType } from '$lib/workers/schema-builder';

  let {
    state = $bindable<SchemaState>({ kind: 'none' })
  }: { state: SchemaState } = $props();

  const primitiveTypes: FieldType[] = ['string', 'number', 'integer', 'boolean'];

  function setKind(kind: SchemaState['kind']) {
    if (kind === 'none') state = { kind: 'none' };
    else if (kind === 'boolean') state = { kind: 'boolean' };
    else if (kind === 'list') state = { kind: 'list', itemType: 'string' };
    else state = { kind: 'object', fields: [] };
  }

  function addField() {
    if (state.kind !== 'object') return;
    state.fields = [
      ...state.fields,
      { name: '', type: 'string', required: false, description: '' }
    ];
  }

  function removeField(idx: number) {
    if (state.kind !== 'object') return;
    state.fields = state.fields.filter((_, i) => i !== idx);
  }
</script>

<div class="space-y-3">
  <div class="flex gap-2 text-sm">
    <span class="font-semibold text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Shape:</span>
    {#each ['none', 'boolean', 'list', 'object'] as kind}
      <label class="flex items-center gap-1">
        <input
          type="radio"
          name="schema-kind"
          checked={state.kind === kind}
          onchange={() => setKind(kind as SchemaState['kind'])}
        />
        {kind}
      </label>
    {/each}
  </div>

  {#if state.kind === 'list'}
    <div class="flex items-center gap-2 text-sm">
      <label>
        Item type:
          <select bind:value={state.itemType} class="border border-[var(--color-border-strong)] rounded px-2 py-1 dark:border-[var(--color-border-strong)]">
          {#each primitiveTypes as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>
    </div>
  {/if}

  {#if state.kind === 'object'}
    <div class="border border-[var(--color-border)] rounded p-3 space-y-2 dark:border-[var(--color-border)]">
      {#each state.fields as field, i (i)}
        <div class="flex gap-2 items-start text-sm">
          <input
            type="text"
            placeholder="field name"
            bind:value={field.name}
            class="flex-1 min-w-0 border border-[var(--color-border-strong)] rounded px-2 py-1 font-mono dark:border-[var(--color-border-strong)]"
          />
          <select bind:value={field.type} class="border border-[var(--color-border-strong)] rounded px-2 py-1 dark:border-[var(--color-border-strong)]">
            {#each primitiveTypes as t}
              <option value={t}>{t}</option>
            {/each}
          </select>
          <label class="flex items-center gap-1">
            <input type="checkbox" bind:checked={field.required} />
            <span>required</span>
          </label>
          <input
            type="text"
            placeholder="description (optional)"
            bind:value={field.description}
            class="flex-1 min-w-0 border border-[var(--color-border-strong)] rounded px-2 py-1 text-xs dark:border-[var(--color-border-strong)]"
          />
          <button
            type="button"
            onclick={() => removeField(i)}
            class="px-2 text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] rounded"
          >
            ✕
          </button>
        </div>
      {/each}
      <button
        type="button"
        onclick={addField}
        class="text-sm text-[var(--color-accent)] hover:underline"
      >
        + Add field
      </button>
    </div>
  {/if}
</div>
