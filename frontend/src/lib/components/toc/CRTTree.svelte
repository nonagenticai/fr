<!--
  CRTTree.svelte — force-directed render for the cause-effect logic trees
  (Current/Future Reality Tree, and any TOC tree that isn't a tidy hierarchy).
  Reuses the TraceabilityGraph force-simulation scaffold; edges are coloured by
  relationship semantics (necessity/sufficiency/conflict/assumption) and the
  conflict/assumption edges render dashed. Decoupled from the API — takes a
  TocGraph.
-->
<script lang="ts">
  import { fitTransform } from './fit';
  import { onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';
  import type { TocGraph, TocNode } from '$lib/api/toc';
  import { edgeKindColor, edgeKindDashed, treeTypeColor } from './palette';
  import { buildTocTooltipHtml } from '$lib/utils/tocTooltip';

  type SimNode = TocNode & SimulationNodeDatum;
  type SimLink = SimulationLinkDatum<SimNode> & {
    source: string | SimNode;
    target: string | SimNode;
    relationship_type: string;
  };

  let {
    graph,
    onnodeclick,
  }: {
    graph: TocGraph;
    onnodeclick?: (node: TocNode) => void;
  } = $props();

  let container: HTMLDivElement;
  let tooltipEl: HTMLDivElement;
  let simulation: d3.Simulation<SimNode, SimLink> | null = null;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  function showTooltip(event: MouseEvent, n: TocNode) {
    if (!tooltipEl) return;
    tooltipEl.style.display = 'block';
    tooltipEl.style.left = `${event.offsetX + 15}px`;
    tooltipEl.style.top = `${event.offsetY - 10}px`;
    tooltipEl.innerHTML = buildTocTooltipHtml(n);
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
    fitToView(true);
  }

  onDestroy(() => {
    simulation?.stop();
    simulation = null;
  });

  $effect(() => {
    const _n = graph.nodes;
    if (container) render();
    return () => {
      simulation?.stop();
      simulation = null;
    };
  });

  function render() {
    simulation?.stop();
    simulation = null;
    d3.select(container).selectAll('svg').remove();
    if (graph.nodes.length === 0) return;

    const accent = treeTypeColor(graph.tree.tree_type);
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const svg = d3
      .select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    const zc = svg.append('g');
    zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => zc.attr('transform', event.transform));
    svg.call(zoomBehavior);

    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = graph.edges.map((e) => ({
      source: e.source_id,
      target: e.target_id,
      relationship_type: e.relationship_type,
    }));

    simulation = d3
      .forceSimulation(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(140))
      .force('charge', d3.forceManyBody().strength(-460))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<SimNode>().radius(46));

    const linkEls = zc
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', (d) => edgeKindColor(d.relationship_type))
      .attr('stroke-opacity', 0.7)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', (d) => (edgeKindDashed(d.relationship_type) ? '6 4' : null));

    const ng = zc
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

    ng.append('rect')
      .attr('x', -70)
      .attr('y', -24)
      .attr('width', 140)
      .attr('height', 48)
      .attr('rx', 8)
      .attr('fill', 'var(--color-surface)')
      .attr('stroke', accent)
      .attr('stroke-width', 2);

    ng.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', -4)
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('fill', 'var(--color-text)')
      .text((d) => (d.title.length > 20 ? d.title.slice(0, 20) + '…' : d.title));

    ng.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', 12)
      .attr('font-size', '9px')
      .attr('fill', 'var(--color-text-muted)')
      .text((d) => d.node_kind);

    ng.on('mouseenter', (e: MouseEvent, d: SimNode) => showTooltip(e, d))
      .on('mousemove', (e: MouseEvent, d: SimNode) => showTooltip(e, d))
      .on('mouseleave', hideTooltip)
      .on('click', (_e: MouseEvent, d: SimNode) => onnodeclick?.(d));

    simulation.on('tick', () => {
      linkEls
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      ng.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
    // Once the layout settles, show the whole graph (UI review 2026-10-07:
    // it loaded at scale 1 with nodes cut off).
    simulation.on('end', () => fitToView(true));
  }

  function fitToView(animate = false) {
    if (!zoomBehavior || !container) return;
    const svgEl = container.querySelector('svg');
    const content = svgEl?.querySelector('g') as SVGGElement | null;
    if (!svgEl || !content || typeof content.getBBox !== 'function') return;
    const t = fitTransform(content.getBBox(), svgEl.clientWidth || container.clientWidth, svgEl.clientHeight || container.clientHeight);
    if (!t) return;
    const svg = d3.select<SVGSVGElement, unknown>(svgEl);
    const target = d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
    if (animate) svg.transition().duration(500).call(zoomBehavior.transform, target);
    else svg.call(zoomBehavior.transform, target);
  }
</script>

<div bind:this={container} class="relative w-full h-full min-h-[600px] bg-[var(--color-bg)] rounded-lg dark:bg-[var(--color-surface)]">
  <div
    bind:this={tooltipEl}
    class="absolute z-20 hidden bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg px-3 py-2 pointer-events-none max-w-xs dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
    style="display: none;"
  ></div>
  <div class="absolute top-3 left-3 z-10 flex flex-col gap-1">
    <button onclick={() => zoomBy(1.3)} class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-lg font-bold dark:bg-[var(--color-surface)]" title="Zoom in">+</button>
    <button onclick={() => zoomBy(0.7)} class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-lg font-bold dark:bg-[var(--color-surface)]" title="Zoom out">-</button>
    <button onclick={zoomReset} class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-xs font-medium dark:bg-[var(--color-surface)]" title="Reset zoom">1:1</button>
  </div>
</div>
