<!--
  SchemaForm.svelte — schema-driven sub-form replacement for free-form
  JsonObjectInput. Caller provides a CustomFieldSchema; component renders
  one input per field with the appropriate native control. value is
  bindable (two-way) — caller stores the resulting Record<string, unknown>
  on whichever object the schema-driven values belong to (e.g.
  card_template.custom_fields).
-->
<script lang="ts">
  import type { CustomFieldSchema, CustomFieldSpec } from '$lib/types/custom-fields';

  type Props = {
    schema: CustomFieldSchema;
    value?: Record<string, unknown>;
    disabled?: boolean;
  };

  let {
    schema,
    value = $bindable<Record<string, unknown>>({}),
    disabled = false,
  }: Props = $props();

  function setField(name: string, v: unknown): void {
    // Replace, don't mutate — keeps Svelte's reactivity tracking happy
    // and ensures the bound parent observes the change.
    value = { ...value, [name]: v };
  }

  function deleteField(name: string): void {
    const next = { ...value };
    delete next[name];
    value = next;
  }

  function asString(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function asNumberOrEmpty(v: unknown): string {
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  }

  function asBoolean(v: unknown): boolean {
    return typeof v === 'boolean' ? v : false;
  }

  function inputId(field: CustomFieldSpec): string {
    return `sf-${field.name}`;
  }
</script>

<div class="schema-form flex flex-col gap-3" data-testid="schema-form">
  {#each schema.fields as field (field.name)}
    <label class="flex flex-col gap-1 text-sm" for={inputId(field)}>
      <span class="font-medium">
        {field.label ?? field.name}{field.required ? ' *' : ''}
      </span>
      {#if field.type === 'string'}
        <input
          id={inputId(field)}
          type="text"
          placeholder={field.placeholder ?? ''}
          value={asString(value[field.name])}
          oninput={(e) => setField(field.name, (e.target as HTMLInputElement).value)}
          {disabled}
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
          data-testid={`schema-field-${field.name}`}
        />
      {:else if field.type === 'number'}
        <input
          id={inputId(field)}
          type="number"
          value={asNumberOrEmpty(value[field.name])}
          oninput={(e) => {
            const raw = (e.target as HTMLInputElement).value;
            if (raw === '') {
              deleteField(field.name);
            } else {
              const n = Number(raw);
              if (Number.isFinite(n)) setField(field.name, n);
            }
          }}
          {disabled}
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
          data-testid={`schema-field-${field.name}`}
        />
      {:else if field.type === 'boolean'}
        <input
          id={inputId(field)}
          type="checkbox"
          checked={asBoolean(value[field.name])}
          onchange={(e) => setField(field.name, (e.target as HTMLInputElement).checked)}
          {disabled}
          data-testid={`schema-field-${field.name}`}
        />
      {:else if field.type === 'enum'}
        <select
          id={inputId(field)}
          value={asString(value[field.name])}
          onchange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === '') {
              deleteField(field.name);
            } else {
              setField(field.name, v);
            }
          }}
          {disabled}
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
          data-testid={`schema-field-${field.name}`}
        >
          <option value="">{field.placeholder ?? '—'}</option>
          {#each field.options as opt (opt)}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
      {/if}
      {#if field.hint}
        <span class="text-xs text-[var(--color-text-muted)]">{field.hint}</span>
      {/if}
    </label>
  {/each}
</div>
