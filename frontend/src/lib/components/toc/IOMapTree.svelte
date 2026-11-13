<!--
  IOMapTree.svelte — tidy-tree render of an Intermediate-Objectives map (and
  any necessity/sufficiency logic tree: prt/trt). Uses d3.stratify → d3.tree
  and reuses the TraceabilityGraph zoom/tooltip/onnodeclick scaffold. Decoupled
  from the API — takes a TocGraph.

  Parent assignment comes from `stratifyTree` (TARGET of the first non-conflict
  OUTGOING edge — edges point prerequisite → objective). Multiple roots are joined under a hidden synthetic root.
-->
<script lang="ts">
  import { fitTransform } from './fit';
  import { onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { TocGraph, TocNode } from '$lib/api/toc';
  import { stratifyTree } from '$lib/api/toc';
  import { treeTypeColor } from './palette';
  import { buildTocTooltipHtml } from '$lib/utils/tocTooltip';

  let {
    graph,
    onnodeclick,
  }: {
    graph: TocGraph;
    onnodeclick?: (node: TocNode) => void;
  } = $props();

  let container: HTMLDivElement;
  let tooltipEl: HTMLDivElement;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  const ROOT_ID = '__io_map_root__';

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
    // "Reset" returns to the fitted view, not to an origin that cuts the tree off.
    fitToView(true);
  }

  onDestroy(() => hideTooltip());

  $effect(() => {
    const _n = graph.nodes;
    if (container) render();
  });

  function render() {
    d3.select(container).selectAll('svg').remove();
    if (graph.nodes.length === 0) return;

    const accent = treeTypeColor(graph.tree.tree_type);
    const rows = stratifyTree(graph.nodes, graph.edges);
    // Join multiple roots under a hidden synthetic root so d3.stratify gets one.
    const stratRows = [
      { id: ROOT_ID, parentId: '' as string | null, node: null as TocNode | null },
      ...rows.map((r) => ({
        id: r.id,
        parentId: r.parentId ?? ROOT_ID,
        node: r.node as TocNode | null,
      })),
    ];

    let root: d3.HierarchyNode<(typeof stratRows)[number]>;
    try {
      root = d3
        .stratify<(typeof stratRows)[number]>()
        .id((d) => d.id)
        .parentId((d) => (d.id === ROOT_ID ? null : d.parentId))(stratRows);
    } catch {
      // Cyclic / malformed parentage — bail to an empty canvas rather than throw.
      return;
    }

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    const layout = d3.tree<(typeof stratRows)[number]>().nodeSize([180, 110]);
    layout(root);

    const svg = d3
      .select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g').attr('transform', `translate(${width / 2}, 60)`);
    zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(width / 2, 60));

    const visibleLinks = root
      .links()
      .filter((l) => l.source.data.id !== ROOT_ID);

    g.append('g')
      .selectAll('path')
      .data(visibleLinks)
      .join('path')
      .attr('fill', 'none')
      .attr('stroke', '#9ca3af')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5)
      .attr('d', (d) => {
        const sx = d.source.x ?? 0;
        const sy = d.source.y ?? 0;
        const tx = d.target.x ?? 0;
        const ty = d.target.y ?? 0;
        const my = (sy + ty) / 2;
        return `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`;
      });

    const nodes = root.descendants().filter((d) => d.data.id !== ROOT_ID);
    const ng = g
      .append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
      .style('cursor', 'pointer')
      .on('mouseenter', (e: MouseEvent, d) => d.data.node && showTooltip(e, d.data.node))
      .on('mousemove', (e: MouseEvent, d) => d.data.node && showTooltip(e, d.data.node))
      .on('mouseleave', hideTooltip)
      .on('click', (_e: MouseEvent, d) => d.data.node && onnodeclick?.(d.data.node));

    ng.append('rect')
      .attr('x', -78)
      .attr('y', -26)
      .attr('width', 156)
      .attr('height', 52)
      .attr('rx', 8)
      .attr('fill', 'var(--color-surface)')
      .attr('stroke', accent)
      .attr('stroke-width', 2);

    ng.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', -6)
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('fill', 'var(--color-text)')
      .text((d) => {
        const t = d.data.node?.title ?? '';
        return t.length > 22 ? t.slice(0, 22) + '…' : t;
      });

    ng.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', 12)
      .attr('font-size', '9px')
      .attr('fill', 'var(--color-text-muted)')
      .text((d) => d.data.node?.node_kind ?? '');

    // Show the whole tree on load instead of a fixed offset at scale 1.
    fitToView();
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
