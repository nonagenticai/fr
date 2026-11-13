<script lang="ts">
  // Bulleted-list renderer for array-typed structured output. Item rendering
  // is driven off the JSON-schema `items.type` so numbers right-align and
  // booleans render as small chips, matching the bubble's typed feel.
  let {
    items,
    schema
  }: {
    items: unknown[];
    schema: Record<string, unknown>;
  } = $props();

  type Prim = 'string' | 'number' | 'integer' | 'boolean';
  const itemType = $derived.by<Prim | null>(() => {
    const inner = schema.items;
    if (!inner || typeof inner !== 'object') return null;
    const t = (inner as { type?: unknown }).type;
    return t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' ? t : null;
  });

  function renderPrimitive(v: unknown): string {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  }
</script>

{#if items.length === 0}
  <span class="text-xs italic text-[var(--color-text-muted)]">empty list</span>
{:else}
  <ul class="list-disc pl-5 space-y-0.5">
    {#each items as item, i (i)}
      <li
        class={itemType === 'number' || itemType === 'integer' ? 'font-mono tabular-nums' : ''}
      >
        {#if itemType === 'boolean' && typeof item === 'boolean'}
          <span
            class="inline-flex items-center rounded-full px-1.5 text-[10px] font-medium {item
              ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]'
              : 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'}"
          >
            {item ? 'true' : 'false'}
          </span>
        {:else}
          {renderPrimitive(item)}
        {/if}
      </li>
    {/each}
  </ul>
{/if}
