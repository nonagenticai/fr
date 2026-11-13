<script lang="ts">
  import Pill from '$lib/components/ui/Pill.svelte';

  // `value` is the validated boolean from WM's `result` SSE frame. We accept
  // `unknown` so the dispatch site in +page.svelte doesn't need to cast — the
  // bubble already gated on `schema.type === 'boolean'`, but we still guard
  // here in case the model returned something off-shape and a hypothetical
  // future caller forgets to narrow.
  let { value }: { value: unknown } = $props();

  const asBool = $derived(typeof value === 'boolean' ? value : null);
</script>

{#if asBool === true}
  <Pill tone="success">✓ true</Pill>
{:else if asBool === false}
  <Pill tone="danger">✗ false</Pill>
{:else}
  <Pill tone="warning">unexpected value: {JSON.stringify(value)}</Pill>
{/if}
