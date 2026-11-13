<!--
  The one status line under a model picker (fr#1407): blocked / provider state /
  load failure / loading / saved model not offered / empty. It carries `id` so a
  disabled Send or Save button can point at it with aria-describedby. Every line
  is neutral copy — never a raw status, statusText or upstream detail.
-->
<script lang="ts">
  import type { ProviderModelPicker } from './provider-models.svelte';
  import { providerModelsErrorText } from './providers';

  let {
    picker,
    provider,
    label,
    id
  }: { picker: ProviderModelPicker; provider: string; label: string; id: string } = $props();
</script>

{#if picker.blockedReason}
  <p {id} class="text-xs text-[var(--color-danger)] mt-1" data-testid="model-blocked">{picker.blockedReason}</p>
{:else if picker.notice}
  <p {id} class="text-xs text-[var(--color-text-muted)] mt-1" data-testid="model-provider-state">{picker.notice}</p>
{:else if picker.failed}
  <p {id} class="text-xs text-[var(--color-danger)] mt-1" data-testid="model-error">
    {providerModelsErrorText(label)}
    <button type="button" class="underline ml-1" onclick={() => picker.retry()}>Retry</button>
  </p>
{:else if picker.loading}
  <p {id} class="text-xs text-[var(--color-text-muted)] mt-1" data-testid="model-loading">Loading models…</p>
{:else if picker.missingKept}
  <p {id} class="text-xs text-[var(--color-text-muted)] mt-1" data-testid="model-missing-saved">
    The saved model <span class="font-mono">{picker.missingKept}</span> is not offered by {label} right now. Choose a model to save.
  </p>
{:else if provider && picker.empty(provider)}
  <p {id} class="text-xs text-[var(--color-text-muted)] mt-1" data-testid="model-empty">{label} offers no models right now.</p>
{:else if provider && !picker.sendable(provider)}
  <p {id} class="text-xs text-[var(--color-text-muted)] mt-1" data-testid="model-choose">Choose a model.</p>
{/if}
