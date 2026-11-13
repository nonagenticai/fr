<!--
  TraceabilityGraph.svelte

  Force-directed render of the cross-domain traceability graph (control-plane
  roadmap Phase 8). Reuses the D3 force-simulation pattern of
  components/ArchitectureGraph.svelte (the code-graph surface) but is a distinct
  component because its colouring axis is the 5D *dimension* (not ArchiMate
  layer), it has no hotspot mode, and nodes click through to their asset detail
  page. Kept separate so the code-graph component stays untouched.

  Props:
   - data: { nodes, links } — nodes coloured by `dimension`, links by relationship type.
   - onnodeclick(node) — fired on node click; the page routes via node.route.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';
  import type { TraceNode, TraceLink } from '$lib/api/traceability';
  import { dimensionColor, DIMENSION_LABELS } from './palette';
  import type { TraceDimension } from '$lib/api/traceability';
  import { escapeHtml } from '$lib/utils/escapeHtml';

  type SimNode = TraceNode & SimulationNodeDatum;
  type SimLink = SimulationLinkDatum<SimNode> & {
    source: string | SimNode;
    target: string | SimNode;
    type: string;
    label: string | null;
  };

  let {
    data,
    onnodeclick,
    visibleDimensions,
  }: {
    data: { nodes: TraceNode[]; links: TraceLink[] };
    onnodeclick?: (node: TraceNode) => void;
    // When provided, only nodes whose dimension is in the set (and links whose
    // both endpoints survive) are rendered. Undefined = show everything. The
    // page reassigns a new Set on each toggle so this prop changes by reference.
    visibleDimensions?: Set<TraceDimension>;
  } = $props();

  let container: HTMLDivElement;
  let tooltipEl: HTMLDivElement;
  let simulation: d3.Simulation<SimNode, SimLink> | null = null;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  // Dimension-filtered view: hide nodes whose dimension is toggled off, then
  // drop any link that would dangle. Everything below renders from `visible`.
  const visible = $derived.by(() => {
    if (!visibleDimensions) return data;
    const nodes = data.nodes.filter((n) => visibleDimensions.has(n.dimension as TraceDimension));
    const keep = new Set(nodes.map((n) => n.id));
    const links = data.links.filter(
      (l) => keep.has(l.source as string) && keep.has(l.target as string),
    );
    return { nodes, links };
  });

  function connectionCount(nodeId: string): number {
    return visible.links.filter((l) => l.source === nodeId || l.target === nodeId).length;
  }

  // Inbound/outbound breakdown by relationship type for the hovered node,
  // grouped client-side (links arrive one row per (source,target,type)).
  function connectionBreakdown(nodeId: string): {
    out: [string, number][];
    inc: [string, number][];
  } {
    const out = new Map<string, number>();
    const inc = new Map<string, number>();
    for (const l of visible.links) {
      if (l.source === nodeId) out.set(l.type, (out.get(l.type) ?? 0) + 1);
      else if (l.target === nodeId) inc.set(l.type, (inc.get(l.type) ?? 0) + 1);
    }
    return { out: [...out.entries()], inc: [...inc.entries()] };
  }

  function nodeRadius(node: TraceNode): number {
    const count = connectionCount(node.id);
    return Math.max(9, Math.min(28, 9 + count * 3));
  }

  function showTooltip(event: MouseEvent, node: TraceNode) {
    if (!tooltipEl) return;
    tooltipEl.style.display = 'block';
    tooltipEl.style.left = `${event.offsetX + 15}px`;
    tooltipEl.style.top = `${event.offsetY - 10}px`;
    const dim = DIMENSION_LABELS[node.dimension as TraceDimension] ?? node.dimension;
    const { out, inc } = connectionBreakdown(node.id);
    const total = out.reduce((s, [, n]) => s + n, 0) + inc.reduce((s, [, n]) => s + n, 0);
    let html = `<div class="font-semibold text-sm">${escapeHtml(node.label)}</div>`;
    html += `<div class="text-xs text-[var(--color-text-muted)] mt-1">Dimension: ${escapeHtml(dim)}</div>`;
    html += `<div class="text-xs text-[var(--color-text-muted)]">Type: ${escapeHtml(node.entity_type)}</div>`;
    html += `<div class="text-xs text-[var(--color-text-muted)]">Connections: ${total}</div>`;
    if (out.length || inc.length) {
      const parts = [
        ...out.map(([t, n]) => `${escapeHtml(t)}: ${n} out`),
        ...inc.map(([t, n]) => `${escapeHtml(t)}: ${n} in`),
      ];
      html += `<div class="text-xs text-[var(--color-text-muted)] mt-1">${parts.join(' · ')}</div>`;
    }
    html += node.route
      ? `<div class="text-xs text-[var(--color-accent)] mt-1">Click to open →</div>`
      : '';
    tooltipEl.innerHTML = html;
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function zoomBy(factor: number) {
    if (!zoomBehavior || !container) return;
    const svg = d3.select<SVGSVGElement, unknown>(container.querySelector('svg')!);
    svg.transition().duration(300).call(zoomBehavior.scaleBy, factor);
  }
  function zoomReset() {
    if (!zoomBehavior || !container) return;
    const svg = d3.select<SVGSVGElement, unknown>(container.querySelector('svg')!);
    svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
  }

  onDestroy(() => {
    simulation?.stop();
    simulation = null;
  });

  $effect(() => {
    // Re-render when the filtered view changes (data load or dimension toggle).
    const _n = visible.nodes;
    if (container) renderGraph();
    return () => {
      simulation?.stop();
      simulation = null;
    };
  });

  function renderGraph() {
    simulation?.stop();
    simulation = null;
    d3.select(container).selectAll('svg').remove();
    if (visible.nodes.length === 0) return;

    const width = container.clientWidth;
    const height = container.clientHeight || 600;

    const svg = d3
      .select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('class', 'bg-white dark:bg-[var(--color-surface)]');

    const zoomContainer = svg.append('g');
    zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => zoomContainer.attr('transform', event.transform));
    svg.call(zoomBehavior);

    const nodes: SimNode[] = visible.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = visible.links.map((l) => ({ ...l }));

    simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(130),
      )
      .force('charge', d3.forceManyBody().strength(-420))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force(
        'collision',
        d3.forceCollide<SimNode>().radius((d) => nodeRadius(d) + 6),
      );

    // Arrow marker for directed edges. Categorical edge colour is muted; the
    // dimension colour lives on the nodes.
    // eslint-disable-next-line design-tokens
    const edgeColor = '#9ca3af';
    svg
      .append('defs')
      .append('marker')
      .attr('id', 'trace-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 22)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('fill', edgeColor)
      .attr('d', 'M0,-5L10,0L0,5');

    const linkElements = zoomContainer
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', edgeColor)
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#trace-arrow)');

    // Edge labels (relationship type).
    const linkLabels = zoomContainer
      .append('g')
      .selectAll('text')
      .data(links)
      .join('text')
      .text((d) => d.type)
      .attr('font-size', '9px')
      // eslint-disable-next-line design-tokens
      .attr('fill', '#9ca3af')
      .attr('text-anchor', 'middle')
      .attr('pointer-events', 'none');

    const nodeGroups = zoomContainer
      .append('g')
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .style('cursor', (d) => (d.route ? 'pointer' : 'default'))
      .call(
        d3
          .drag<SVGGElement, SimNode>()
          .on('start', (event, d) => {
            if (!event.active) simulation!.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation!.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );

    nodeGroups
      .append('circle')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => dimensionColor(d.dimension))
      // Root node gets a heavier ring so it stands out in a rooted view.
      // eslint-disable-next-line design-tokens
      .attr('stroke', (d) => (d.is_root ? '#111827' : '#fff'))
      .attr('stroke-width', (d) => (d.is_root ? 3.5 : 2))
      .attr('opacity', 0.9);

    nodeGroups
      .append('text')
      .text((d) => (d.label.length > 16 ? d.label.slice(0, 16) + '…' : d.label))
      .attr('x', 0)
      .attr('y', (d) => nodeRadius(d) + 14)
      .attr('text-anchor', 'middle')
      .attr('font-size', '11px')
      .attr('font-weight', '500')
      // eslint-disable-next-line design-tokens
      .attr('fill', '#374151')
      .attr('pointer-events', 'none');

    nodeGroups
      .on('mouseenter', function (event: MouseEvent, d: SimNode) {
        // eslint-disable-next-line design-tokens
        d3.select(this).select('circle').attr('stroke', '#1f2937').attr('stroke-width', 3.5);
        showTooltip(event, d);
      })
      .on('mousemove', (event: MouseEvent, d: SimNode) => showTooltip(event, d))
      .on('mouseleave', function (_event: MouseEvent, d: SimNode) {
        d3.select(this)
          .select('circle')
          // eslint-disable-next-line design-tokens
          .attr('stroke', d.is_root ? '#111827' : '#fff')
          .attr('stroke-width', d.is_root ? 3.5 : 2);
        hideTooltip();
      })
      .on('click', (_event: MouseEvent, d: SimNode) => onnodeclick?.(d));

    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      linkLabels
        .attr('x', (d) => (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2)
        .attr('y', (d) => (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2);
      nodeGroups.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
  }
</script>

<div
  bind:this={container}
  class="relative w-full h-full min-h-[600px] bg-[var(--color-bg)] rounded-lg dark:bg-[var(--color-surface)]"
>
  <div
    bind:this={tooltipEl}
    class="absolute z-20 hidden bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg px-3 py-2 pointer-events-none max-w-xs dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
    style="display: none;"
  ></div>

  <div class="absolute top-3 left-3 z-10 flex flex-col gap-1">
    <button
      onclick={() => zoomBy(1.3)}
      class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-lg font-bold dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)]"
      title="Zoom in">+</button
    >
    <button
      onclick={() => zoomBy(0.7)}
      class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-lg font-bold dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)]"
      title="Zoom out">-</button
    >
    <button
      onclick={zoomReset}
      class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-xs font-medium dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)]"
      title="Reset zoom">1:1</button
    >
  </div>
</div>
