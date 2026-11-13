<!--
  ArchitectureView — ONE view of a container's code graph, chosen by the
  `view` prop. NAV STANDARD (validator A2, 2026-10-03): this component used to
  own a <nav> of three tab buttons (Architecture Graph / Dependency Report /
  Quality Gate) — a menu inside a page. Each view is its own route now
  (/projects/[id]/architecture/{graph,dependencies,quality-gate}), so the
  component renders what it is told and fetches only that view's data.
-->
<script lang="ts" module>
	export type ArchitectureViewKind = 'architecture' | 'dependencies' | 'quality';
</script>

<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import ArchitectureGraph from '$lib/components/ArchitectureGraph.svelte';
	import { computeNeighbours } from './neighbours';
	import { typeColor, distinctTypes, CONNECTIVITY_LEGEND } from './graph-colors';
	import type {
		ArchitectureGraph as ArchitectureGraphType,
		DependencyReport,
		QualityGate
	} from '$lib/types/api';

	type Props = { containerName: string; view?: ArchitectureViewKind };
	let { containerName, view = 'architecture' }: Props = $props();

	const shown = $derived<ArchitectureViewKind>(view);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let hotspotMode = $state(false);
	let selectedNode = $state<{
		id: string;
		label: string;
		layer: string;
		metrics?: Record<string, unknown>;
	} | null>(null);

	let architectureData = $state<ArchitectureGraphType | null>(null);
	let dependencyData = $state<DependencyReport | null>(null);
	let qualityData = $state<QualityGate | null>(null);

	let lastLoadedKey = '';

	let graphData = $derived.by(() => {
		if (!architectureData) return { nodes: [], links: [] };
		return {
			nodes: architectureData.nodes.map((node) => ({
				id: node.id,
				label: node.label,
				layer: node.type || 'default',
				metrics: node.metadata
			})),
			links: architectureData.edges.map((edge) => ({
				source: edge.source,
				target: edge.target,
				type: edge.type
			}))
		};
	});

	// One fetch per (container, view). The route decides the view, so a view
	// change is a navigation and a fresh mount in practice; keying on both keeps
	// the component honest if it is ever re-used with a changing prop.
	$effect(() => {
		const c = containerName.trim();
		const key = `${c}|${shown}`;
		if (c && key !== lastLoadedKey) {
			lastLoadedKey = key;
			architectureData = null;
			dependencyData = null;
			qualityData = null;
			selectedNode = null;
			void fetchData();
		}
	});

	async function fetchData() {
		const c = containerName.trim();
		if (!c) {
			error = 'Please select a container';
			return;
		}
		loading = true;
		error = null;
		try {
			if (shown === 'architecture') {
				architectureData = await apiClient.architecture.getGraph(c);
			} else if (shown === 'dependencies') {
				dependencyData = await apiClient.dependencies.getReport(c);
			} else {
				qualityData = await apiClient.quality.getQualityGate(c);
			}
		} catch (err) {
			const e = err as { status?: number; message?: unknown };
			if (e?.status === 502) {
				error = 'Code Graph Helper service is currently unavailable.';
			} else if (e?.status === 404) {
				error = `No analysis found for container "${c}". Add the repository to code-graph-helper first.`;
			} else {
				error = typeof e?.message === 'string' ? e.message : `Failed to load ${shown} data`;
			}
		} finally {
			loading = false;
		}
	}

	function handleNodeClick(node: {
		id: string;
		label: string;
		layer: string;
		metrics?: Record<string, unknown>;
	}) {
		selectedNode = {
			id: node.id,
			label: node.label,
			layer: node.layer,
			metrics: node.metrics
		};
	}

	function closeSidebar() {
		selectedNode = null;
	}

	// Select a node by id so the sidebar's connection list can navigate the graph
	// (the as-built graph has 100s of nodes — clicking a neighbour beats hunting
	// for it on the canvas). Mirrors handleNodeClick's selectedNode shape.
	function selectNodeById(id: string) {
		const n = architectureData?.nodes.find((x) => x.id === id);
		if (!n) return;
		selectedNode = { id: n.id, label: n.label, layer: n.type || 'default', metrics: n.metadata };
	}

	// Distinct node types actually present in this graph — the source for the
	// honest "Node types" legend. Keys are exactly the data's `type` values, so
	// the legend can never advertise a category the data doesn't contain.
	const nodeTypes = $derived(distinctTypes(architectureData?.nodes ?? []));

	// Inbound/outbound neighbours of the selected node, resolved to labels.
	const neighbours = $derived(
		computeNeighbours(
			architectureData?.nodes ?? [],
			architectureData?.edges ?? [],
			selectedNode?.id
		)
	);

	function getStatusColor(status: string): string {
		switch (status) {
			case 'passed':
				return 'text-[var(--color-success)]';
			case 'warning':
				return 'text-[var(--color-warning)]';
			case 'failed':
				return 'text-[var(--color-danger)]';
			default:
				return 'text-[var(--color-text)] dark:text-[var(--color-text-muted)]';
		}
	}

	function getSeverityColor(severity: string): string {
		switch (severity) {
			case 'critical':
				return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
			case 'high':
				return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
			case 'medium':
				return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
			case 'low':
				return 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]';
			default:
				return 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]';
		}
	}
</script>

<div class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]" data-testid="architecture-view" data-view={shown}>
	{#if shown === 'architecture'}
		<div class="border-b border-[var(--color-border)] flex items-center justify-end px-4 py-2 dark:border-[var(--color-border)]">
			<button
				onclick={() => (hotspotMode = !hotspotMode)}
				title="Colour nodes by connection degree (how many edges touch each node)"
				class="px-3 py-1.5 text-sm rounded-lg transition-colors {hotspotMode
					? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border border-[var(--color-danger-border)] hover:bg-[var(--color-danger-bg)]'
					: 'bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]'} dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)]"
			>
				{hotspotMode ? 'Connectivity ON' : 'Connectivity OFF'}
			</button>
		</div>
	{/if}

	<div class="p-6">
		{#if !containerName.trim()}
			<div class="text-center py-12">
				<p class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
					This project isn't linked to a container yet. Provision a repository from
					<span class="font-semibold">Project settings</span> first.
				</p>
			</div>
		{:else if error}
			<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 dark:bg-[var(--color-danger-bg)]/20">
				<p class="text-[var(--color-danger-text)]">{error}</p>
			</div>
		{:else if loading}
			<div class="flex flex-col items-center justify-center py-12">
				<div
					class="w-12 h-12 border-4 border-[var(--color-accent)] border-t-blue-600 rounded-full animate-spin"
				></div>
				<p class="mt-4 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Loading {shown} data…</p>
			</div>
		{:else if shown === 'architecture'}
			{#if architectureData}
				<div class="flex gap-4">
					<div class="flex-1 space-y-6">
						<div class="bg-[var(--color-surface)] rounded-lg p-4 dark:bg-[var(--color-bg)]">
							<ArchitectureGraph data={graphData} {hotspotMode} onnodeclick={handleNodeClick} />
						</div>
						<div class="grid grid-cols-3 gap-4">
							<div class="bg-[var(--color-accent-bg)] rounded-lg p-4">
								<p class="text-sm text-[var(--color-accent-text)] font-medium">Total Nodes</p>
								<p class="text-2xl font-bold text-[var(--color-accent-text)]">{architectureData.nodes.length}</p>
							</div>
							<div class="bg-[var(--color-success-bg)] rounded-lg p-4">
								<p class="text-sm text-[var(--color-success-text)] font-medium">Connections</p>
								<p class="text-2xl font-bold text-[var(--color-success-text)]">{architectureData.edges.length}</p>
							</div>
							<div class="bg-[var(--color-info-bg)] rounded-lg p-4">
								<p class="text-sm text-[var(--color-info)] font-medium">Last Updated</p>
								<p class="text-sm font-medium text-[var(--color-info-text)]">
									{new Date(architectureData.timestamp).toLocaleString()}
								</p>
							</div>
						</div>
						<div class="bg-[var(--color-surface)] rounded-lg p-4 dark:bg-[var(--color-bg)]">
							<h3 class="text-sm font-semibold text-[var(--color-text)] mb-3 dark:text-[var(--color-text)]">
								{hotspotMode ? 'Connectivity Legend' : 'Node Types'}
							</h3>
							{#if hotspotMode}
								<!-- Connectivity heat encodes node DEGREE (edges touching a node),
								     the only risk proxy the code-graph carries. This is NOT
								     complexity/issue data — none exists upstream (coding D1). -->
								<div class="grid grid-cols-3 gap-3">
									{#each CONNECTIVITY_LEGEND as bucket}
										<div class="flex items-center gap-2">
											<div class="w-4 h-4 rounded-full" style="background-color: {bucket.color}"></div>
											<span class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{bucket.label}</span>
										</div>
									{/each}
								</div>
							{:else if nodeTypes.length > 0}
								<!-- One swatch per node `type` actually present (module/class/…),
								     coloured by the SAME typeColor() the graph uses. The legend
								     keys are the data's real types, never a fixed layer taxonomy
								     the data can't match (coding D2). -->
								<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
									{#each nodeTypes as t}
										<div class="flex items-center gap-2">
											<div class="w-4 h-4 rounded-full" style="background-color: {typeColor(t)}"></div>
											<span class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)] capitalize">{t}</span>
										</div>
									{/each}
								</div>
							{:else}
								<p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No typed nodes to legend.</p>
							{/if}
						</div>
					</div>
					{#if selectedNode}
						<div class="w-80 shrink-0">
							<div class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-sm sticky top-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
								<div
									class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] dark:border-[var(--color-border)]"
								>
									<h3 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Node Details</h3>
									<button
										onclick={closeSidebar}
										class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors dark:text-[var(--color-text-muted)]"
										title="Close"
										aria-label="Close node details"
									>
										<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								</div>
								<div class="p-4 space-y-3">
									<div>
										<p class="text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">Label</p>
										<p class="text-sm font-semibold text-[var(--color-text)] mt-0.5 dark:text-[var(--color-text)]">
											{selectedNode.label}
										</p>
									</div>
									<div>
										<p class="text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">ID</p>
										<p class="text-sm text-[var(--color-text)] mt-0.5 font-mono break-all dark:text-[var(--color-text-muted)]">
											{selectedNode.id}
										</p>
									</div>
									<div>
										<p class="text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">Type</p>
										<!-- Node "Type" (module/class/function/…), NOT an architectural "Layer" —
										     the code-graph carries no layer signal. The dot uses the same
										     typeColor() as the graph + legend so all three agree. -->
										<span
											class="inline-flex items-center gap-1.5 mt-0.5 px-2 py-0.5 text-xs font-medium rounded-full bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]"
										>
											<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {typeColor(selectedNode.layer)}"></span>
											{selectedNode.layer}
										</span>
									</div>
									{#if selectedNode.metrics && Object.keys(selectedNode.metrics).length > 0}
										<div>
											<p class="text-xs font-medium text-[var(--color-text-muted)] uppercase mb-1 dark:text-[var(--color-text-muted)]">Metrics</p>
											<div class="bg-[var(--color-surface)] rounded p-3 space-y-2 dark:bg-[var(--color-bg)]">
												{#each Object.entries(selectedNode.metrics) as [key, value]}
													<div class="flex justify-between text-sm">
														<span class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{key}</span>
														<span class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">
															{typeof value === 'number' ? value.toFixed(2) : String(value)}
														</span>
													</div>
												{/each}
											</div>
										</div>
									{/if}
									{#if neighbours.outgoing.length > 0 || neighbours.incoming.length > 0}
										<div data-testid="node-connections">
											<p class="text-xs font-medium text-[var(--color-text-muted)] uppercase mb-1 dark:text-[var(--color-text-muted)]">
												Connections ({neighbours.outgoing.length + neighbours.incoming.length})
											</p>
											{#if neighbours.outgoing.length > 0}
												<p class="text-xs text-[var(--color-text-muted)] mt-1">Depends on ({neighbours.outgoing.length})</p>
												<div class="space-y-1 mt-0.5">
													{#each neighbours.outgoing as n}
														<button type="button" data-testid="neighbour-out" onclick={() => selectNodeById(n.id)} class="block w-full text-left text-sm text-[var(--color-accent-strong)] hover:underline truncate" title="{n.label} ({n.type})">→ {n.label}</button>
													{/each}
												</div>
											{/if}
											{#if neighbours.incoming.length > 0}
												<p class="text-xs text-[var(--color-text-muted)] mt-2">Used by ({neighbours.incoming.length})</p>
												<div class="space-y-1 mt-0.5">
													{#each neighbours.incoming as n}
														<button type="button" data-testid="neighbour-in" onclick={() => selectNodeById(n.id)} class="block w-full text-left text-sm text-[var(--color-accent-strong)] hover:underline truncate" title="{n.label} ({n.type})">← {n.label}</button>
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div class="text-center py-12">
					<p class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No data yet for container "{containerName}".</p>
				</div>
			{/if}
		{:else if shown === 'dependencies'}
			{#if dependencyData}
				<div class="space-y-6">
					{#if dependencyData.degraded}
						<div
							class="flex items-center gap-2 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-bg)]/40 px-4 py-2 text-sm text-[var(--color-warning)]"
							role="status"
						>
							<span aria-hidden="true">⚠️</span>
							<span>
								Showing the last stored report{dependencyData.stale_as_of
									? ` (as of ${new Date(dependencyData.stale_as_of).toLocaleString()})`
									: ''} — the analysis container is no longer running, so live data isn't
								available. Re-provision to refresh.
							</span>
						</div>
					{/if}
					<div class="grid grid-cols-4 gap-4">
						<div class="bg-[var(--color-accent-bg)] rounded-lg p-4">
							<p class="text-sm text-[var(--color-accent-text)] font-medium">Total Dependencies</p>
							<p class="text-2xl font-bold text-[var(--color-accent-text)]">{dependencyData.total_count}</p>
						</div>
						<div class="bg-[var(--color-warning-bg)] rounded-lg p-4 dark:bg-[var(--color-warning-bg)]/20">
							<p class="text-sm text-[var(--color-warning-text)] font-medium">Vulnerable</p>
							<p class="text-2xl font-bold text-[var(--color-warning-text)]">{dependencyData.vulnerable_count}</p>
						</div>
						<div class="bg-[var(--color-danger-bg)] rounded-lg p-4 dark:bg-[var(--color-danger-bg)]/20">
							<p class="text-sm text-[var(--color-danger-text)] font-medium">Critical</p>
							<p class="text-2xl font-bold text-[var(--color-danger-text)]">{dependencyData.critical_count}</p>
						</div>
						<div class="bg-[var(--color-surface)] rounded-lg p-4 dark:bg-[var(--color-bg)]">
							<p class="text-sm text-[var(--color-text)] font-medium dark:text-[var(--color-text-muted)]">Last Scan</p>
							<p class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">
								{new Date(dependencyData.timestamp).toLocaleString()}
							</p>
						</div>
					</div>
					<div class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg overflow-hidden dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
						<table class="min-w-full divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
							<thead class="bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
								<tr>
									<th class="px-6 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]"
										>Package</th
									>
									<th class="px-6 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]"
										>Version</th
									>
									<th class="px-6 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]"
										>Type</th
									>
									<th class="px-6 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]"
										>License</th
									>
									<th class="px-6 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]"
										>Vulnerabilities</th
									>
								</tr>
							</thead>
							<tbody class="bg-[var(--color-bg)] divide-y divide-[var(--color-border)] dark:bg-[var(--color-surface)] dark:divide-[var(--color-border-strong)]">
								{#each dependencyData.dependencies as dep}
									<tr class="hover:bg-[var(--color-surface)] dark:hover:bg-[var(--color-surface-strong)]">
										<td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text)]"
											>{dep.name}</td
										>
										<td class="px-6 py-4 whitespace-nowrap text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]"
											>{dep.version}</td
										>
										<td class="px-6 py-4 whitespace-nowrap text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
											<span
												class="px-2 py-1 text-xs font-medium rounded-full {dep.type === 'direct'
													? 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]'
													: 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]'}"
											>
												{dep.type || 'unknown'}
											</span>
										</td>
										<td class="px-6 py-4 whitespace-nowrap text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]"
											>{dep.license || 'N/A'}</td
										>
										<td class="px-6 py-4 whitespace-nowrap text-sm">
											{#if dep.vulnerabilities && dep.vulnerabilities.length > 0}
												<div class="flex gap-1">
													{#each dep.vulnerabilities as vuln}
														<span
															class="px-2 py-1 text-xs font-medium rounded {getSeverityColor(
																vuln.severity
															)}"
														>
															{vuln.severity}
														</span>
													{/each}
												</div>
											{:else}
												<span class="text-[var(--color-success)]">None</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{:else}
				<div class="text-center py-12">
					<p class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No data yet for container "{containerName}".</p>
				</div>
			{/if}
		{:else if shown === 'quality'}
			{#if qualityData && qualityData.status === 'not_analyzed'}
				<!-- coding-analysis #107: nothing stored and nothing measured. The
				     upstream abstaining gate carries a 0.0 score and a synthetic 0.0
				     check; neither is a measurement, so no score and no metrics. -->
				<div
					class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
					data-testid="quality-gate-not-analyzed"
				>
					Not analysed yet — there is no stored quality result for container "{qualityData.container_name}".
					Run an analysis from <span class="font-semibold">Project code quality</span> in the project sidebar.
				</div>
			{:else if qualityData}
				<div class="space-y-6">
					<div
						class="bg-[var(--color-bg)] border-2 rounded-lg p-6 {qualityData.status === 'passed'
							? 'border-[var(--color-success)]'
							: qualityData.status === 'warning'
								? 'border-[var(--color-warning)]'
								: 'border-[var(--color-danger)]'} dark:bg-[var(--color-surface)]"
					>
						<div class="flex items-center justify-between">
							<div>
								<h3 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Quality Gate Status</h3>
								<p class="text-sm text-[var(--color-text)] mt-1 dark:text-[var(--color-text-muted)]">
									Container: {qualityData.container_name}
								</p>
							</div>
							<div class="text-right">
								<p class="text-3xl font-bold {getStatusColor(qualityData.status)} uppercase">
									{qualityData.status}
								</p>
								<p class="text-sm text-[var(--color-text)] mt-1 dark:text-[var(--color-text-muted)]">
									{new Date(qualityData.timestamp).toLocaleString()}
								</p>
							</div>
						</div>
					</div>
					<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
						{#each qualityData.metrics as metric}
							<div class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
								<div class="flex items-center justify-between mb-2">
									<h4 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">{metric.name}</h4>
									<span
										class="px-2 py-1 text-xs font-medium rounded {metric.status === 'passed'
											? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]'
											: metric.status === 'warning'
												? 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'
												: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'}"
									>
										{metric.status}
									</span>
								</div>
								<div class="flex items-baseline gap-2">
									<p class="text-2xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">{metric.value}</p>
									{#if metric.threshold}
										<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">/ {metric.threshold} threshold</p>
									{/if}
								</div>
								{#if metric.description}
									<p class="text-sm text-[var(--color-text)] mt-2 dark:text-[var(--color-text-muted)]">{metric.description}</p>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div class="text-center py-12">
					<p class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No data yet for container "{containerName}".</p>
				</div>
			{/if}
		{/if}
	</div>
</div>
