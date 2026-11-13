<!--
  An RM / fr refusal, rendered as received: the formatted sentence, the status,
  and the raw error body. fr does not reinterpret it (facilitator, not judge).
-->
<script lang="ts">
  import type { CatalogueFailure } from '$lib/api/conveyor-catalogue';
  import { bodyText } from '$lib/conveyor-catalogue/state';

  let { failure, title = 'The catalogue refused this' }: { failure: CatalogueFailure; title?: string } = $props();
  const raw = $derived(bodyText(failure.body));
</script>

<div
  role="alert"
  data-testid="catalogue-failure"
  class="rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger-text)]"
>
  <p class="font-medium">{title}{failure.status ? ` (HTTP ${failure.status})` : ''}</p>
  <p class="mt-1 break-words">{failure.message}</p>
  {#if raw}
    <details class="mt-2">
      <summary class="cursor-pointer text-xs">Response body</summary>
      <pre class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{raw}</pre>
    </details>
  {/if}
</div>
