<!--
  KagGraph — force-directed visualisation of KAG semantic-search results.

  Inputs are the loosely-typed `nodes` and `relationships` arrays returned by
  /api/assets/kag/search. Both shapes vary across upstream call sites, so we
  normalise them defensively here rather than in the page. Node selection is
  surfaced through `onSelect` so the host can show details; the graph itself
  stays purely visual.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';

  interface Props {
    nodes: Array<Record<string, unknown>>;
    relationships: Array<Record<string, unknown>>;
    height?: number;
    onSelect?: (node: Record<string, unknown> | null) => void;
    /** Optional per-node fill (e.g. colour-by-trust). Falsy → the default fill. */
    nodeColor?: (raw: Record<string, unknown>) => string | undefined;
  }

  const { nodes, relationships, height = 480, onSelect, nodeColor }: Props = $props();

  interface SimNode extends d3.SimulationNodeDatum {
    id: string;
    label: string;
    raw: Record<string, unknown>;
  }
  interface SimLink extends d3.SimulationLinkDatum<SimNode> {
    type: string;
  }

  function pickLabel(n: Record<string, unknown>): string {
    for (const k of ['name', 'title', 'label', 'id']) {
      const v = n[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '(unnamed)';
  }

  function pickId(n: Record<string, unknown>, fallback: number): string {
    const v = n.id;
    return typeof v === 'string' && v.length > 0 ? v : `idx-${fallback}`;
  }

  function pickRel(r: Record<string, unknown>): { source: string; target: string; type: string } {
    const source =
      (typeof r.source === 'string' && r.source) ||
      (typeof r.start === 'string' && r.start) ||
      (typeof r.from === 'string' && r.from) ||
      '';
    const target =
      (typeof r.target === 'string' && r.target) ||
      (typeof r.end === 'string' && r.end) ||
      (typeof r.to === 'string' && r.to) ||
      '';
    const type = typeof r.type === 'string' ? r.type : '';
    return { source, target, type };
  }

  let container: HTMLDivElement | undefined = $state();
  let width = $state(640);
  let selectedId = $state<string | null>(null);

  // Reactive view-model derived from props.
  const simNodes = $derived(
    nodes.map<SimNode>((n, i) => ({
      id: pickId(n, i),
      label: pickLabel(n),
      raw: n,
    })),
  );
  const simLinks = $derived(
    relationships
      .map(pickRel)
      .filter((r) => r.source && r.target)
      .map<SimLink>((r) => ({ source: r.source, target: r.target, type: r.type })),
  );

  let simulation: d3.Simulation<SimNode, SimLink> | undefined;
  let resizeObs: ResizeObserver | undefined;

  onMount(() => {
    if (!container) return;
    const apply = () => {
      width = container!.clientWidth || 640;
    };
    apply();
    resizeObs = new ResizeObserver(apply);
    resizeObs.observe(container);
  });

  onDestroy(() => {
    resizeObs?.disconnect();
    simulation?.stop();
  });

  // Position state for nodes — populated by the simulation tick.
  let positions = $state<Record<string, { x: number; y: number }>>({});
  let linkLines = $state<Array<{ x1: number; y1: number; x2: number; y2: number; type: string }>>([]);

  // (Re)build the simulation whenever inputs change.
  $effect(() => {
    simulation?.stop();
    if (simNodes.length === 0) {
      positions = {};
      linkLines = [];
      return;
    }
    // Clone so d3 can mutate x/y without polluting reactive state.
    const ns: SimNode[] = simNodes.map((n) => ({ ...n }));
    const ls: SimLink[] = simLinks.map((l) => ({ ...l }));

    const sim = d3
      .forceSimulation<SimNode, SimLink>(ns)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(ls)
          .id((d) => d.id)
          .distance(80)
          .strength(0.4),
      )
      .force('charge', d3.forceManyBody().strength(-160))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(28));

    sim.on('tick', () => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const n of ns) {
        next[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
      }
      positions = next;
      linkLines = ls.map((l) => {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        return { x1: s.x ?? 0, y1: s.y ?? 0, x2: t.x ?? 0, y2: t.y ?? 0, type: l.type };
      });
    });
    simulation = sim;
  });

  function handleNodeClick(n: SimNode) {
    selectedId = selectedId === n.id ? null : n.id;
    onSelect?.(selectedId ? n.raw : null);
  }
</script>

<div bind:this={container} class="w-full" data-testid="kag-graph">
  {#if simNodes.length === 0}
    <p class="text-sm text-[var(--color-text-muted)] py-8 text-center">No graph nodes to display.</p>
  {:else}
    <svg
      role="img"
      aria-label="Knowledge graph visualisation"
      {width}
      {height}
      viewBox={`0 0 ${width} ${height}`}
      class="border border-[var(--color-border)] rounded bg-[var(--color-surface)]"
    >
      <g stroke="var(--color-border)" stroke-opacity="0.7">
        {#each linkLines as l, i (i)}
          <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke-width="1" />
        {/each}
      </g>
      <g>
        {#each simNodes as n (n.id)}
          {@const p = positions[n.id] ?? { x: width / 2, y: height / 2 }}
          {@const isSelected = selectedId === n.id}
          <g
            transform={`translate(${p.x},${p.y})`}
            class="cursor-pointer"
            role="button"
            tabindex="0"
            onclick={() => handleNodeClick(n)}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleNodeClick(n);
              }
            }}
            data-testid="kag-graph-node"
          >
            <circle
              r={isSelected ? 9 : 6}
              fill={isSelected
                ? 'var(--color-accent)'
                : (nodeColor?.(n.raw) ?? 'var(--color-primary)')}
              stroke="var(--color-bg)"
              stroke-width="1.5"
            />
            <text
              x="10"
              y="4"
              font-size="11"
              fill="var(--color-text)"
              style="paint-order: stroke; stroke: var(--color-bg); stroke-width: 3px;"
            >{n.label}</text>
          </g>
        {/each}
      </g>
    </svg>
  {/if}
</div>
