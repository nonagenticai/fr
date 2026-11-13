<!--
  JsonObjectInput.svelte

  Minimal "edit a JSON object as raw text" widget. Used by the schedule
  intake editor for `card_template.custom_fields`.

  Two-way binds `value` (a Record<string, unknown> | undefined). On
  every keystroke, parses the text. Invalid JSON freezes the parent's
  bound value at its last good state and surfaces an error message;
  empty text resolves to undefined (the API treats undefined and {} as
  the same "no overrides" state, but undefined is closer to the
  storage-layer NULL).
-->
<script lang="ts">
  type Props = {
    value?: Record<string, unknown>;
    disabled?: boolean;
    placeholder?: string;
    label?: string;
    rows?: number;
    /** Optional hint shown beneath the textarea. */
    hint?: string;
  };

  let {
    value = $bindable<Record<string, unknown> | undefined>(undefined),
    disabled = false,
    placeholder = '{}',
    label,
    rows = 4,
    hint,
  }: Props = $props();

  // Initialize raw text from incoming value.
  let raw = $state<string>(value === undefined ? '' : JSON.stringify(value, null, 2));
  let err = $state<string | null>(null);

  function onInput(e: Event): void {
    const text = (e.target as HTMLTextAreaElement).value;
    raw = text;
    if (text.trim().length === 0) {
      err = null;
      value = undefined;
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        err = 'Must be a JSON object (e.g. {"key": "value"}).';
        return;
      }
      err = null;
      value = parsed as Record<string, unknown>;
    } catch (e) {
      err = e instanceof Error ? e.message : 'Invalid JSON';
    }
  }
</script>

<label class="flex flex-col gap-1 text-sm">
  {#if label}<span class="font-medium">{label}</span>{/if}
  <textarea
    {disabled}
    {rows}
    {placeholder}
    value={raw}
    oninput={onInput}
    spellcheck="false"
    data-testid="json-object-input"
    class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm font-mono dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
  ></textarea>
  {#if err}
    <p class="text-xs text-[var(--color-danger)] dark:text-[var(--color-danger-text)]" role="alert" data-testid="json-object-error">
      {err}
    </p>
  {:else if hint}
    <p class="text-xs text-[var(--color-text-muted)]">{hint}</p>
  {/if}
</label>
