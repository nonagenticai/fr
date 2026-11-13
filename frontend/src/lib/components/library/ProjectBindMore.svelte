<!--
  ProjectBindMore.svelte

  Modal that lets the user bind additional library assets (of one kind)
  to the current project. The inverse of AssetBindingsList (which binds
  ONE asset to many projects).

  Behaviour:
    - Renders a header + body modal with AssetMultiPicker filtered to
      "not already bound" (via excludeIds).
    - On "Bind selected": calls bindAsset() for each selected id, then
      onClose(true).
    - On dismiss: onClose(false).
-->
<script lang="ts">
  import { AssetMultiPicker } from '$lib/components/library';
  import { bindAsset } from '$lib/api/bindings';
  import type { AssetKind } from '$lib/api/bindings';

  interface Props {
    kind: AssetKind;
    projectId: string;
    pluralLabel: string;
    excludeIds: string[];
    onClose: (didBind: boolean) => void;
  }

  let { kind, projectId, pluralLabel, excludeIds, onClose }: Props = $props();

  let selectedIds = $state<string[]>([]);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function submit(): Promise<void> {
    if (selectedIds.length === 0) {
      onClose(false);
      return;
    }
    submitting = true;
    error = null;
    try {
      // bindAsset accepts an array of project_ids per call. We're binding
      // one project at a time but multiple assets, so loop.
      for (const assetId of selectedIds) {
        await bindAsset(kind, assetId, [projectId]);
      }
      onClose(true);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }

  // Escape is a window listener, and other window-level Escape handlers exist
  // (e.g. AgentRail). Honour an Escape something else already consumed, and
  // mark ours consumed so the modal closes without also closing what is under it.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || submitting) return;
    e.preventDefault();
    onClose(false);
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

<!-- Modal overlay -->
<div
  class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
  role="dialog"
  aria-modal="true"
  aria-labelledby="bind-more-title"
  data-testid="bind-more-modal"
>
  <div
    class="bg-[var(--color-bg)] rounded-lg shadow-xl max-w-lg w-full p-5 dark:bg-[var(--color-surface)]"
  >
    <header class="mb-3 flex items-center justify-between">
      <h2 id="bind-more-title" class="text-lg font-semibold">
        Bind {pluralLabel.toLowerCase()} to this project
      </h2>
      <button
        type="button"
        onclick={() => onClose(false)}
        class="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        aria-label="Close"
      >×</button>
    </header>

    <p class="text-xs text-[var(--color-text-muted)] mb-3">
      Pick items from the tenant library to bring into this project's scope.
    </p>

    <AssetMultiPicker
      kind={kind}
      bind:selectedIds
      excludeIds={excludeIds}
      compact={true}
    />

    {#if error}
      <p class="mt-3 text-sm text-[var(--color-danger-text)]" data-testid="bind-more-error">
        {error}
      </p>
    {/if}

    <footer class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onclick={() => onClose(false)}
        class="px-3 py-1.5 text-sm border border-[var(--color-border-strong)] rounded hover:bg-[var(--color-surface)]"
      >Cancel</button>
      <button
        type="button"
        onclick={submit}
        disabled={submitting || selectedIds.length === 0}
        class="px-3 py-1.5 text-sm bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Binding…' : `Bind ${selectedIds.length || 0}`}
      </button>
    </footer>
  </div>
</div>
