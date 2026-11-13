<!--
  G8 / R313 — "Ask to promote" on a project copy of a requirement / principle / decision.
  Shows the latest promotion state for the copy; offers the request when none is open and the
  copy was not promoted (a failed, declined or expired request may be asked again).
  Only rendered by callers for rows where `isPromotableCopy` holds.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    canRequestPromotion,
    getPromotion,
    promotionErrorText,
    promotionLabel,
    requestPromotion,
    type PromotableKind,
    type PromotionState,
  } from './promotionRequest';

  interface Props {
    kind: PromotableKind;
    assetId: string;
  }
  let { kind, assetId }: Props = $props();

  let current = $state<PromotionState | null>(null);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let label = $derived(promotionLabel(current));
  // A failed, declined or expired request can be asked again (canRequestPromotion).
  let canRequest = $derived(loaded && !busy && canRequestPromotion(current));

  onMount(async () => {
    try {
      current = await getPromotion(kind, assetId);
    } catch (err) {
      console.error('[promotion] could not read the promotion state', err);
      error = "Couldn't load the promotion state.";
    } finally {
      loaded = true;
    }
  });

  async function ask(): Promise<void> {
    busy = true;
    error = null;
    try {
      current = await requestPromotion(kind, assetId);
    } catch (err) {
      console.error('[promotion] request failed', err);
      error = promotionErrorText(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col items-end gap-1 text-xs" data-testid="promotion-request">
  {#if label}
    <span class="text-[var(--color-text-muted)]" data-testid="promotion-state">{label}</span>
  {/if}
  {#if canRequest}
    <button
      type="button"
      class="underline hover:text-[var(--color-accent)]"
      title="Ask a workspace admin to make this project version the version every project uses"
      onclick={ask}
      data-testid="promotion-request-button"
    >Ask to promote to workspace</button>
  {/if}
  {#if busy}
    <span class="text-[var(--color-text-muted)]">Sending…</span>
  {/if}
  {#if error}
    <span class="text-[var(--color-danger-text)]" data-testid="promotion-error">{error}</span>
  {/if}
</div>
