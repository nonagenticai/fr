<script lang="ts">
  // Two-column key/value renderer for object-typed structured output. Keys
  // come from the schema's `properties` (preserving field order); each
  // property's `description` surfaces as muted helper text under the key so
  // the user sees the same hint they configured in SchemaBuilder.
  // No reusable Table primitive exists today; markup is inline.
  let {
    value,
    schema
  }: {
    value: Record<string, unknown>;
    schema: Record<string, unknown>;
  } = $props();

  type FieldSpec = {
    name: string;
    description?: string;
    type?: string;
    required: boolean;
  };

  const fields = $derived.by<FieldSpec[]>(() => {
    const props = schema.properties;
    if (!props || typeof props !== 'object') {
      // No schema metadata — render every key in insertion order.
      return Object.keys(value).map((name) => ({ name, required: false }));
    }
    const required = Array.isArray(schema.required)
      ? new Set(schema.required.filter((x): x is string => typeof x === 'string'))
      : new Set<string>();
    return Object.entries(props as Record<string, unknown>).map(([name, raw]) => {
      const f = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      return {
        name,
        description: typeof f.description === 'string' ? f.description : undefined,
        type: typeof f.type === 'string' ? f.type : undefined,
        required: required.has(name)
      };
    });
  });

  function renderValue(v: unknown, t: string | undefined): string {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return t === 'integer' ? String(Math.trunc(v)) : String(v);
    return JSON.stringify(v);
  }
</script>

<table class="text-xs border-collapse w-full">
  <tbody>
    {#each fields as f (f.name)}
      <tr class="border-b border-[var(--color-border)]/60 align-top">
        <th
          class="text-left font-medium px-2 py-1 whitespace-nowrap text-[var(--color-text)]"
          scope="row"
        >
          {f.name}{#if f.required}<span class="text-[var(--color-danger)]">*</span>{/if}
          {#if f.description}
            <div class="text-[10px] font-normal text-[var(--color-text-muted)]">
              {f.description}
            </div>
          {/if}
        </th>
        <td
          class="px-2 py-1 font-mono {f.type === 'number' || f.type === 'integer'
            ? 'tabular-nums'
            : ''}"
        >
          {renderValue(value[f.name], f.type)}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
