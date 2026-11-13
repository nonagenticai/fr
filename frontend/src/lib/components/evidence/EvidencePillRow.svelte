<script lang="ts">
  // A row of evidence pills (e.g. `router ok`, `quality: 0.91`) rendered via the
  // ui/Tag primitive. Backend tone (`success|warn|danger|neutral`) is mapped to
  // the Tag tone vocabulary by the pure `pillTone` helper.
  import Tag from '$lib/components/ui/Tag.svelte';
  import { pillTone } from './pillTone';
  import type { TimelinePill } from '$lib/types/cockpit';

  interface Props {
    pills: TimelinePill[];
    class?: string;
  }
  let { pills, class: className = '' }: Props = $props();
</script>

{#if pills.length > 0}
  <div class={`flex flex-wrap items-center gap-1.5 ${className}`} data-testid="evidence-pill-row">
    {#each pills as pill, i (i)}
      <Tag tone={pillTone(pill.tone)}>{pill.label}</Tag>
    {/each}
  </div>
{/if}
