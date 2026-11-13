<!--
  ConformanceOverlayGraph.svelte

  Architecture Governance overlay graph (P3.2 of the fr Architecture
  Governance lane). Focused force-directed render of the conformance result
  alone — Artifacts + Application Components + the four conformance edge
  categories (matched / missing / extra / illegal).

  Modelled after `components/traceability/TraceabilityGraph.svelte` (same D3
  force-simulation pattern, same legend split, same design-token CSS escape
  hatches for SVG attributes that don't resolve var()). Kept as a distinct
  component because the data shape (architecture-internal conformance) is
  not the cross-domain 5D Trace{Node,Link} shape — see the design note in
  the lane's plan file (P3.2 deliberately new vs. extending TraceabilityGraph).

  Props:
   - data: { nodes, links } from `deriveConformanceGraph()` (pure, tested).
   - onnodeclick(node) — fires on node click; the page routes to the matching
                        `/library/architecture/elements/{id}` detail page.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';
  import { escapeHtml } from '$lib/utils/escapeHtml';
  import type {
    ConformanceGraphData,
    ConformanceGraphLink,
    ConformanceGraphNode,
  } from './derive';
  import {
    EDGE_COLORS,
    EDGE_DASH,
    EDGE_LABELS,
    EDGE_ORDER,
    NODE_COLORS,
    NODE_LABELS,
    NODE_ORDER,
    nodeColor,
  } from './palette';

  type SimNode = ConformanceGraphNode & SimulationNodeDatum;
  type SimLink = SimulationLinkDatum<SimNode> & ConformanceGraphLink;

  let {
    data,
    onnodeclick,
  }: {
    data: ConformanceGraphData;
    onnodeclick?: (node: ConformanceGraphNode) => void;
  } = $props();

  let container: HTMLDivElement;
  let tooltipEl: HTMLDivElement;
  let simulation: d3.Simulation<SimNode, SimLink> | null = null;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  function connectionCount(nodeId: string): number {
    return data.links.filter((l) => l.source === nodeId || l.target === nodeId).length;
  }

  function nodeRadius(node: ConformanceGraphNode): number {
    const count = connectionCount(node.id);
    return Math.max(9, Math.min(28, 9 + count * 3));
  }

  function showTooltip(event: MouseEvent, node: ConformanceGraphNode) {
    if (!tooltipEl) return;
    tooltipEl.style.display = 'block';
    tooltipEl.style.left = `${event.offsetX + 15}px`;
    tooltipEl.style.top = `${event.offsetY - 10}px`;
    const kindLabel = NODE_LABELS[node.kind] ?? node.kind;
    let html = `<div class="font-semibold text-sm">${escapeHtml(node.label)}</div>`;
    html += `<div class="text-xs text-[var(--color-text-muted)] mt-1">Kind: ${escapeHtml(kindLabel)}</div>`;
    html += `<div class="text-xs text-[var(--color-text-muted)]">Layer: ${escapeHtml(node.layer)}</div>`;
    html += `<div class="text-xs text-[var(--color-text-muted)]">Connections: ${connectionCount(node.id)}</div>`;
    if (node.isFinding) {
      html += `<div class="text-xs mt-1" style="color: ${EDGE_COLORS.missing}">⚠ Conformance finding</div>`;
    }
    html += `<div class="text-xs text-[var(--color-accent)] mt-1">Click to open →</div>`;
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
    // Re-render on data change; track node identity for reactivity.
    const _n = data.nodes;
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
    if (data.nodes.length === 0) return;

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

    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = data.links.map((l) => ({ ...l }));

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

    // One arrow marker per edge kind so the arrow head colour matches the
    // edge stroke (D3 markers are static — pick one per kind, not per edge).
    const defs = svg.append('defs');
    for (const kind of EDGE_ORDER) {
      defs
        .append('marker')
        .attr('id', `conformance-arrow-${kind}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 22)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('fill', EDGE_COLORS[kind])
        .attr('d', 'M0,-5L10,0L0,5');
    }

    const linkElements = zoomContainer
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', (d) => EDGE_COLORS[d.kind])
      .attr('stroke-opacity', 0.7)
      .attr('stroke-width', (d) => (d.kind === 'illegal' ? 2.5 : 1.7))
      .attr('stroke-dasharray', (d) => EDGE_DASH[d.kind] ?? null)
      .attr('marker-end', (d) => `url(#conformance-arrow-${d.kind})`);

    const nodeGroups = zoomContainer
      .append('g')
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
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
      .attr('fill', (d) => nodeColor(d.kind))
      // eslint-disable-next-line design-tokens
      .attr('stroke', (d) => (d.isFinding ? EDGE_COLORS.missing : '#fff'))
      .attr('stroke-width', (d) => (d.isFinding ? 3 : 2))
      .attr('opacity', (d) => (d.isFinding ? 0.95 : 0.85));

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
          .attr('stroke', d.isFinding ? EDGE_COLORS.missing : '#fff')
          .attr('stroke-width', d.isFinding ? 3 : 2);
        hideTooltip();
      })
      .on('click', (_event: MouseEvent, d: SimNode) => onnodeclick?.(d));

    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      nodeGroups.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
  }
</script>

<div class="flex flex-col gap-3 w-full h-full">
  <!-- Legend — two rows: edge kinds + node kinds. Reuses the palette directly
       so canvas and legend never drift. -->
  <div
    class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--color-text-muted)]"
    aria-label="Conformance overlay legend"
  >
    <span class="font-medium text-[var(--color-text)]">Edges:</span>
    {#each EDGE_ORDER as kind (kind)}
      <span class="inline-flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden="true">
          <line
            x1="0"
            y1="3"
            x2="22"
            y2="3"
            stroke={EDGE_COLORS[kind]}
            stroke-width={kind === 'illegal' ? 2.5 : 1.7}
            stroke-dasharray={EDGE_DASH[kind] ?? undefined}
          />
        </svg>
        {EDGE_LABELS[kind]}
      </span>
    {/each}
    <span class="ml-3 font-medium text-[var(--color-text)]">Nodes:</span>
    {#each NODE_ORDER as kind (kind)}
      <span class="inline-flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill={NODE_COLORS[kind]} />
        </svg>
        {NODE_LABELS[kind]}
      </span>
    {/each}
  </div>

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
</div>
