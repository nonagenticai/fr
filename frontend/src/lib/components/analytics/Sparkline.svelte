<!--
  Sparkline.svelte — tiny d3-scale + d3-shape SVG sparkline.

  Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §6.4
        ("hand-rolled small Svelte 5 components ... no `d3-selection`").

  Renders a single-line trend over the supplied numeric series. The SVG path
  is computed reactively in $derived so Svelte owns DOM mutations.
-->
<script lang="ts">
  import { scaleLinear } from 'd3-scale';
  import { line } from 'd3-shape';

  interface Props {
    values: number[];
    width?: number;
    height?: number;
    color?: string;
  }

  // Default color resolves to --color-accent at render time; consumers can pass
  // any CSS color string (including var(--color-…)) via the `color` prop.
  const { values, width = 80, height = 24, color = 'var(--color-accent)' }: Props = $props();

  const path = $derived.by(() => {
    if (!values || values.length === 0) return '';
    const maxV = Math.max(...values, 1);
    const minV = Math.min(...values, 0);
    const x = scaleLinear()
      .domain([0, Math.max(1, values.length - 1)])
      .range([1, width - 1]);
    const y = scaleLinear().domain([minV, maxV === minV ? maxV + 1 : maxV]).range([height - 1, 1]);
    const builder = line<number>()
      .x((_, i) => x(i))
      .y((v) => y(v));
    return builder(values) ?? '';
  });
</script>

{#if values && values.length > 0}
  <svg {width} {height} role="img" aria-label="Sparkline" class="overflow-visible">
    <path d={path} fill="none" stroke={color} stroke-width="1.5" />
  </svg>
{:else}
  <span class="text-xs text-[var(--color-text-muted)]">—</span>
{/if}
