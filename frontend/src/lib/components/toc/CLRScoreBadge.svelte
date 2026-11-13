<!--
  CLRScoreBadge.svelte — token-based pill for a 0..1 structural-CLR quality
  score (the `/toc/{id}/quality` scorer output, or an asset's quality_score).
  Decoupled from the API: takes the raw score as a prop.

  Props:
   - score: number | null — 0..1; null renders an "unscored" muted pill.
   - label: string — leading label (default "CLR").
   - size: 'sm' | 'md'
-->
<script lang="ts">
  import { qualityScoreColor } from './palette';

  let {
    score = null,
    label = 'CLR',
    size = 'sm',
  }: {
    score?: number | null;
    label?: string;
    size?: 'sm' | 'md';
  } = $props();

  const color = $derived(qualityScoreColor(score));
  const pct = $derived(score == null ? null : Math.round(score * 100));
  const pad = $derived(size === 'md' ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs');
</script>

<span
  class={`inline-flex items-center gap-1.5 rounded-full border font-medium ${pad}`}
  style={`color: ${color}; border-color: ${color};`}
  title={pct == null ? 'Not yet evaluated' : `Structural 8-CLR score: ${pct}%`}
  data-testid="clr-score-badge"
>
  <span class="inline-block w-2 h-2 rounded-full" style={`background-color: ${color}`}></span>
  {label}
  <span class="font-semibold">{pct == null ? '—' : `${pct}%`}</span>
</span>
