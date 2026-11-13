<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import * as d3 from 'd3';
	import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';
	import { escapeHtml } from '$lib/utils/escapeHtml';
	import { typeColor, connectivityScore, connectivityColor } from './architecture/graph-colors';

	interface GraphNode extends SimulationNodeDatum {
		id: string;
		label: string;
		layer: string;
		metrics?: Record<string, any>;
	}

	interface GraphLink extends SimulationLinkDatum<GraphNode> {
		source: string | GraphNode;
		target: string | GraphNode;
		type?: string;
	}

	interface GraphData {
		nodes: GraphNode[];
		links: GraphLink[];
	}

	let {
		data = { nodes: [], links: [] },
		hotspotMode = false,
		onnodeclick
	}: {
		data: GraphData;
		hotspotMode?: boolean;
		onnodeclick?: (node: GraphNode) => void;
	} = $props();

	let container: HTMLDivElement;
	let tooltipEl: HTMLDivElement;
	let simulation: d3.Simulation<GraphNode, GraphLink> | null = null;
	let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

	// Count connections per node for sizing
	function getConnectionCount(nodeId: string): number {
		return data.links.filter((l) => {
			const sid = typeof l.source === 'string' ? l.source : l.source.id;
			const tid = typeof l.target === 'string' ? l.target : l.target.id;
			return sid === nodeId || tid === nodeId;
		}).length;
	}

	// Node radius: scale by connection count, min 8, max 30
	function getNodeRadius(node: GraphNode): number {
		const count = getConnectionCount(node.id);
		return Math.max(8, Math.min(30, 8 + count * 3));
	}

	// The busiest node's degree, used to scale connectivity heat relative to the
	// graph. Recomputed per render from the live edge set.
	let maxConnections = 0;

	// Node fill:
	//   • layer mode → a categorical colour keyed on the node's REAL `type`
	//     (module/class/function/…); the legend is built from the same types.
	//     (Was: a five-layer map whose keys never matched `type`, so every node
	//      fell to grey — coding D2.)
	//   • hotspot mode → connectivity heat driven by node DEGREE, the only risk
	//     proxy the code-graph data carries. There is no complexity/issue data
	//     upstream (coding D1), so nothing else feeds the score.
	function getNodeFill(node: GraphNode): string {
		if (hotspotMode) {
			return connectivityColor(
				connectivityScore(getConnectionCount(node.id), maxConnections),
			);
		}
		return typeColor(node.layer);
	}

	// Edge styling by type
	function getEdgeDash(type?: string): string {
		switch (type) {
			case 'runtime':
				return '6,3';
			case 'import':
				return '2,2';
			case 'call':
				return '8,4,2,4';
			default:
				return '0';
		}
	}

	function getEdgeColor(type?: string): string {
		switch (type) {
			case 'dependency':
				return '#6b7280';
			case 'import':
				return '#3b82f6';
			case 'call':
				return '#10b981';
			case 'runtime':
				return '#8b5cf6';
			default:
				return '#9ca3af';
		}
	}

	// Tooltip helpers
	function showTooltip(event: MouseEvent, node: GraphNode) {
		if (!tooltipEl) return;
		tooltipEl.style.display = 'block';
		tooltipEl.style.left = `${event.offsetX + 15}px`;
		tooltipEl.style.top = `${event.offsetY - 10}px`;

		let html = `<div class="font-semibold text-sm">${escapeHtml(node.label)}</div>`;
		html += `<div class="text-xs text-[var(--color-text-muted)] mt-1 dark:text-[var(--color-text-muted)]">Type: ${escapeHtml(node.layer)}</div>`;
		html += `<div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Connections: ${getConnectionCount(node.id)}</div>`;
		if (node.metrics) {
			for (const [key, value] of Object.entries(node.metrics)) {
				const display = typeof value === 'number' ? value.toFixed(2) : String(value);
				html += `<div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">${escapeHtml(key)}: ${escapeHtml(display)}</div>`;
			}
		}
		tooltipEl.innerHTML = html;
	}

	function hideTooltip() {
		if (!tooltipEl) return;
		tooltipEl.style.display = 'none';
	}

	// Zoom control functions
	function zoomIn() {
		if (!zoomBehavior || !container) return;
		const svg = d3.select<SVGSVGElement, unknown>(container.querySelector('svg')!);
		svg.transition().duration(300).call(zoomBehavior.scaleBy, 1.3);
	}

	function zoomOut() {
		if (!zoomBehavior || !container) return;
		const svg = d3.select<SVGSVGElement, unknown>(container.querySelector('svg')!);
		svg.transition().duration(300).call(zoomBehavior.scaleBy, 0.7);
	}

	function zoomReset() {
		if (!zoomBehavior || !container) return;
		const svg = d3.select<SVGSVGElement, unknown>(container.querySelector('svg')!);
		svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
	}

	onMount(() => {
		if (data.nodes.length > 0) {
			renderGraph();
		}
	});

	onDestroy(() => {
		if (simulation) {
			simulation.stop();
			simulation = null;
		}
	});

	$effect(() => {
		// Re-render when data or hotspotMode changes
		// Access them to track reactivity
		const _nodes = data.nodes;
		const _hotspot = hotspotMode;
		if (_nodes.length > 0 && container) {
			renderGraph();
		}
	});

	function renderGraph() {
		// Stop any previous simulation
		if (simulation) {
			simulation.stop();
			simulation = null;
		}

		// Clear previous graph content
		d3.select(container).selectAll('svg').remove();

		const width = container.clientWidth;
		const height = container.clientHeight || 600;

		const svg = d3
			.select(container)
			.append('svg')
			.attr('width', width)
			.attr('height', height)
			.attr('viewBox', `0 0 ${width} ${height}`)
			.attr('class', 'bg-white dark:bg-[var(--color-surface)]');

		// Set up zoom
		const zoomContainer = svg.append('g');

		zoomBehavior = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.1, 4])
			.on('zoom', (event) => {
				zoomContainer.attr('transform', event.transform);
			});

		svg.call(zoomBehavior);

		// Deep copy data to avoid D3 mutation issues on re-render
		const nodes: GraphNode[] = data.nodes.map((n) => ({ ...n }));
		const links: GraphLink[] = data.links.map((l) => ({ ...l }));

		// Busiest node's degree — the denominator for connectivity heat. Computed
		// once per render so hotspot mode scales relative to THIS graph.
		maxConnections = nodes.reduce((mx, n) => Math.max(mx, getConnectionCount(n.id)), 0);

		// Create simulation
		simulation = d3
			.forceSimulation(nodes)
			.force(
				'link',
				d3
					.forceLink<GraphNode, GraphLink>(links)
					.id((d) => d.id)
					.distance(120)
			)
			.force('charge', d3.forceManyBody().strength(-400))
			.force('center', d3.forceCenter(width / 2, height / 2))
			.force(
				'collision',
				d3.forceCollide<GraphNode>().radius((d) => getNodeRadius(d) + 5)
			);

		// Arrow markers for directed edges
		svg
			.append('defs')
			.selectAll('marker')
			.data(['dependency', 'import', 'call', 'runtime', 'default'])
			.join('marker')
			.attr('id', (d) => `arrow-${d}`)
			.attr('viewBox', '0 -5 10 10')
			.attr('refX', 20)
			.attr('refY', 0)
			.attr('markerWidth', 6)
			.attr('markerHeight', 6)
			.attr('orient', 'auto')
			.append('path')
			.attr('fill', (d) => getEdgeColor(d === 'default' ? undefined : d))
			.attr('d', 'M0,-5L10,0L0,5');

		// Create edges
		const linkElements = zoomContainer
			.append('g')
			.attr('class', 'links')
			.selectAll('line')
			.data(links)
			.join('line')
			.attr('stroke', (d) => getEdgeColor(d.type))
			.attr('stroke-opacity', 0.5)
			.attr('stroke-width', 1.5)
			.attr('stroke-dasharray', (d) => getEdgeDash(d.type))
			.attr('marker-end', (d) => `url(#arrow-${d.type || 'default'})`);

		// Create node groups
		const nodeGroups = zoomContainer
			.append('g')
			.attr('class', 'nodes')
			.selectAll<SVGGElement, GraphNode>('g')
			.data(nodes)
			.join('g')
			.attr('class', 'node-group')
			.style('cursor', 'pointer')
			.call(
				d3
					.drag<SVGGElement, GraphNode>()
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
					})
			);

		// Node circles — sized by connection count
		nodeGroups
			.append('circle')
			.attr('r', (d) => getNodeRadius(d))
			.attr('fill', (d) => getNodeFill(d))
			.attr('stroke', '#fff')
			.attr('stroke-width', 2)
			.attr('opacity', 0.9);

		// Node labels
		nodeGroups
			.append('text')
			.text((d) => (d.label.length > 14 ? d.label.substring(0, 14) + '...' : d.label))
			.attr('x', 0)
			.attr('y', (d) => getNodeRadius(d) + 14)
			.attr('text-anchor', 'middle')
			.attr('font-size', '11px')
			.attr('font-weight', '500')
			.attr('fill', '#374151')
			.attr('pointer-events', 'none');

		// Hover: show tooltip
		nodeGroups
			.on('mouseenter', function (event: MouseEvent, d: GraphNode) {
				d3.select(this).select('circle').attr('stroke', '#1f2937').attr('stroke-width', 3);
				showTooltip(event, d);
			})
			.on('mousemove', function (event: MouseEvent, d: GraphNode) {
				showTooltip(event, d);
			})
			.on('mouseleave', function () {
				d3.select(this).select('circle').attr('stroke', '#fff').attr('stroke-width', 2);
				hideTooltip();
			});

		// Click handler — dispatch event
		nodeGroups.on('click', (_event: MouseEvent, d: GraphNode) => {
			if (onnodeclick) {
				onnodeclick(d);
			}
		});

		// Tick updates
		simulation.on('tick', () => {
			linkElements
				.attr('x1', (d) => (d.source as GraphNode).x ?? 0)
				.attr('y1', (d) => (d.source as GraphNode).y ?? 0)
				.attr('x2', (d) => (d.target as GraphNode).x ?? 0)
				.attr('y2', (d) => (d.target as GraphNode).y ?? 0);

			nodeGroups.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
		});
	}
</script>

<div bind:this={container} class="relative w-full h-full min-h-[600px] bg-[var(--color-bg)] rounded-lg dark:bg-[var(--color-surface)]">
	<!-- Tooltip -->
	<div
		bind:this={tooltipEl}
		class="absolute z-20 hidden bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg px-3 py-2 pointer-events-none max-w-xs dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
		style="display: none;"
	></div>

	<!-- Zoom controls -->
	<div class="absolute top-3 left-3 z-10 flex flex-col gap-1">
		<button
			onclick={zoomIn}
			class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-lg font-bold dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
			title="Zoom in"
		>
			+
		</button>
		<button
			onclick={zoomOut}
			class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-lg font-bold dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
			title="Zoom out"
		>
			-
		</button>
		<button
			onclick={zoomReset}
			class="w-8 h-8 flex items-center justify-center bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded shadow-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] text-xs font-medium dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
			title="Reset zoom"
		>
			1:1
		</button>
	</div>
</div>
