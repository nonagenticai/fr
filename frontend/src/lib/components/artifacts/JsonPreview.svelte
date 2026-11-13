<script lang="ts">
  interface Props {
    body: string;
    truncated?: boolean;
  }

  const { body, truncated = false }: Props = $props();

  let parsed = $state<unknown>(null);
  let parseError = $state<string | null>(null);

  $effect(() => {
    try {
      parsed = JSON.parse(body);
      parseError = null;
    } catch (e) {
      parsed = null;
      parseError = e instanceof Error ? e.message : String(e);
    }
  });

  const pretty = $derived(parsed === null ? body : JSON.stringify(parsed, null, 2));
</script>

<div class="json-preview" data-testid="json-preview">
  {#if truncated}
    <div class="text-xs text-[var(--color-warning)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] px-2 py-1 rounded mb-2 dark:text-[var(--color-warning-text)] dark:bg-[var(--color-warning-bg)]/20">
      Preview truncated at 1 MiB. The remainder is not shown.
    </div>
  {/if}
  {#if parseError}
    <div class="text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] px-2 py-1 rounded mb-2 dark:text-[var(--color-danger-text)] dark:bg-[var(--color-danger-bg)]/20">
      JSON parse error: {parseError}
    </div>
  {/if}
  <pre
    class="text-xs font-mono bg-[var(--color-bg)] text-[var(--color-success)] rounded p-3 overflow-auto max-h-[60vh]"
    data-testid="json-preview-body">{pretty}</pre>
</div>
