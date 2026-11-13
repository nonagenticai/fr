<!--
  KagGraphExplorer — the interactive knowledge-graph canvas.

  Merges the two graphs the app already had: the rich D3 *interactions* from
  ArchitectureGraph.svelte (zoom/pan, node drag with fx/fy pinning, hover
  tooltip, arrow markers, connection-count sizing) and the defensive neo4j
  *normalisation* from KagGraph.svelte (id/label/relationship-endpoint picking
  that tolerates start|end|from|to and name|title|label|id).

  On top of both it adds what a customer-facing explorer needs: colour-by-type
  with a stable categorical palette, a colour-by-community mode, optional
  centrality-driven sizing, focus-mode dimming of non-neighbours on selection,
  path highlighting, and single-click select / double-click expand callbacks.

  It is purely presentational: the parent owns the working node/edge set, the
  active-type filter, and analytics overlays, and reacts to onselect/onexpand.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';
  import { escapeHtml } from '$lib/utils/escapeHtml';
  import { nodeTypeOf, nodeLabelOf, nodeIdOf, relEndpoints } from './graph-normalise';
  import { colorForType, colorForCommunity } from './graph-colors';
  import type { NodeVerification } from './kag-verification';

  interface SimNode extends SimulationNodeDatum {
    id: string;
    label: string;
    type: string;
    raw: Record<string, unknown>;
  }
  interface SimLink extends SimulationLinkDatum<SimNode> {
    source: string | SimNode;
    target: string | SimNode;
    type: string;
    /** Stable identity for select/highlight: `${source}__${type}__${target}`. */
    key: string;
    /** The original relationship record, so a click can inspect its full payload. */
    raw: Record<string, unknown>;
  }

  interface Props {
    nodes: Array<Record<string, unknown>>;
    relationships: Array<Record<string, unknown>>;
    /** Colour nodes by neo4j label (default) or by detected community. */
    colorMode?: 'type' | 'community';
    /** nodeId → community index, when a community run is active. */
    communityOf?: Record<string, number>;
    /** nodeId → centrality score (0–1); scales node radius when present. */
    centralityOf?: Record<string, number>;
    /** nodeId → verification {score, flags}; draws a badge ring when present. */
    verificationOf?: Record<string, NodeVerification>;
    /** Labels currently toggled on. `null` = show all. */
    activeTypes?: Set<string> | null;
    /** Ordered node ids of a highlighted path (Find-path result). */
    pathIds?: string[];
    /** Currently-selected node id (drives focus mode + highlight). */
    selectedId?: string | null;
    /** Draw convex hulls around communities (only in community colour mode). */
    showHulls?: boolean;
    /** Show the bottom-right minimap HUD. */
    showMinimap?: boolean;
    /** The just-expanded node id: new neighbours spawn from its position. */
    expandOriginId?: string | null;
    /** Currently-selected edge key (`${source}__${type}__${target}`); drives edge highlight. */
    selectedEdgeKey?: string | null;
    height?: number;
    onselect?: (node: Record<string, unknown> | null) => void;
    /** Click an edge: reports its raw relationship record (or null to deselect). */
    onedgeselect?: (edge: Record<string, unknown> | null) => void;
    onexpand?: (node: Record<string, unknown>) => void;
    /** Reports the distinct types present so the parent can build a legend. */
    ontypes?: (types: string[]) => void;
    /** Hover enter/move over a node: parent may fetch + show a source peek. */
    onpeek?: (node: Record<string, unknown>, x: number, y: number) => void;
    /** Hover leave: parent should hide the peek. */
    onpeekhide?: () => void;
  }

  let {
    nodes,
    relationships,
    colorMode = 'type',
    communityOf = {},
    centralityOf = {},
    verificationOf = {},
    activeTypes = null,
    pathIds = [],
    selectedId = null,
    showHulls = false,
    showMinimap = true,
    expandOriginId = null,
    selectedEdgeKey = null,
    height = 560,
    onselect,
    onedgeselect,
    onexpand,
    ontypes,
    onpeek,
    onpeekhide,
  }: Props = $props();

  let container: HTMLDivElement;
  let tooltipEl: HTMLDivElement;
  let simulation: d3.Simulation<SimNode, SimLink> | null = null;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  // ---- Live d3 selections + render bookkeeping -------------------------------
  // Plain `let` (NOT $state): these are imperative handles the effects mutate;
  // making them reactive would loop. `setup()` (topology) rebuilds them;
  // `applyOverlays()` re-attributes the existing ones without a teardown.
  let svgEl: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  let zoomLayer: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let linkSel: d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null = null;
  // A transparent, fat companion line per edge: edges are 1–2px so their own
  // stroke is a near-impossible click target. This widens the hit area (and owns
  // the click/hover handlers) without changing the visible edge.
  let linkHitSel: d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null = null;
  let edgeLabelSel: d3.Selection<SVGTextElement, SimLink, SVGGElement, unknown> | null = null;
  let nodeSel: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null = null;
  let curNs: SimNode[] = []; // the live clones d3 mutates (x/y/fx/fy)
  let curLs: SimLink[] = [];
  let lastTopoKey = ''; // rebuild gate — plain let so it never re-triggers an effect
  // node id → last known position; survives topology rebuilds AND type-filter
  // toggles so nodes don't fly back to the origin on every change.
  const posCache = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  let clickTimer: ReturnType<typeof setTimeout> | null = null; // click vs dblclick disambiguation

  // Deepening overlays (all read-only). Community hulls + a minimap HUD live in
  // their own selections so setup() builds them and the tick/overlay passes
  // refresh them without a teardown.
  let hullG: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let mmSvg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  let mmDots: d3.Selection<SVGCircleElement, SimNode, SVGGElement, unknown> | null = null;
  let mmViewport: d3.Selection<SVGRectElement, unknown, null, undefined> | null = null;
  let mmScale = 1;
  let mmOx = 0;
  let mmOy = 0;
  let applyingProgrammatic = false; // guards the zoom↔minimap feedback loop
  let curWidth = 0;
  let curHeight = 0;
  let tickCount = 0;
  const MM_W = 168;
  const MM_H = 118;

  // ---- Colour ----------------------------------------------------------------
  // Colour comes from the shared `graph-colors` module so the legend swatch
  // (KagGraphExploreTab) and the on-canvas node fill can't drift: both key the
  // same palette by the SORTED type index. Communities use a separate palette.
  function nodeFill(n: SimNode): string {
    if (colorMode === 'community') {
      const c = communityOf[n.id];
      return c === undefined ? 'var(--color-text-muted)' : colorForCommunity(c);
    }
    return colorForType(n.type, allTypes);
  }

  // ---- Derived working set ---------------------------------------------------
  const filteredNodes = $derived(
    nodes
      .map<SimNode>((n, i) => ({
        id: nodeIdOf(n, i),
        label: nodeLabelOf(n),
        type: nodeTypeOf(n),
        raw: n,
      }))
      .filter((n) => !activeTypes || activeTypes.has(n.type)),
  );
  const nodeIds = $derived(new Set(filteredNodes.map((n) => n.id)));
  const filteredLinks = $derived(
    relationships
      .map((raw) => ({ raw, ...relEndpoints(raw) }))
      .filter((r) => r.source && r.target && nodeIds.has(r.source) && nodeIds.has(r.target))
      .map((r) => ({
        source: r.source,
        target: r.target,
        type: r.type,
        key: `${r.source}__${r.type}__${r.target}`,
        raw: r.raw,
      })),
  );

  // The sorted set of distinct types present — the SAME basis the shared
  // `colorForType` keys on, so the legend and the canvas agree.
  const allTypes = $derived(Array.from(new Set(nodes.map((n) => nodeTypeOf(n)))).sort());

  // Report distinct types up to the parent (for the legend) whenever they change.
  let lastTypesKey = '';
  $effect(() => {
    const key = allTypes.join('|');
    if (key !== lastTypesKey) {
      lastTypesKey = key;
      ontypes?.(allTypes);
    }
  });

  // Adjacency for focus-mode + connection sizing (over the *filtered* view).
  const adjacency = $derived.by(() => {
    const map = new Map<string, Set<string>>();
    for (const l of filteredLinks) {
      const s = l.source as string;
      const t = l.target as string;
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  });
  function connectionCount(id: string): number {
    return adjacency.get(id)?.size ?? 0;
  }
  // Spread centrality sizing across the range actually present in the *visible*
  // nodes, not the global 0–1. Otherwise a view whose nodes all sit near the
  // global max (common for structural hierarchy nodes that share a PageRank of
  // 1.0) renders every node at max radius, which reads as "nothing ranked".
  const centralityScale = $derived.by(() => {
    const vals = filteredNodes
      .map((n) => centralityOf[n.id])
      .filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) return null;
    const min = Math.min(...vals);
    return { min, span: Math.max(...vals) - min };
  });
  function nodeRadius(n: SimNode): number {
    const c = centralityOf[n.id];
    if (typeof c === 'number' && centralityScale) {
      // Uniform scores (span ≈ 0) → mid size rather than a misleading max.
      const t = centralityScale.span > 1e-9 ? (c - centralityScale.min) / centralityScale.span : 0.5;
      return 9 + t * 25;
    }
    return Math.max(7, Math.min(28, 7 + connectionCount(n.id) * 2.5));
  }

  // Verification score → traffic-light ring colour (green good → red poor).
  // eslint-disable-next-line design-tokens
  function verificationColor(score: number): string {
    const s = Math.max(0, Math.min(1, score));
    return `hsl(${s * 130} 70% 45%)`; // 0 = red, 130 = green
  }
  function verificationFlagged(v: NodeVerification | undefined): boolean {
    return !!v?.flags?.some((f) => /contradict|anomal|conflict/i.test(f));
  }

  const pathSet = $derived(new Set(pathIds));
  const pathEdgeSet = $derived.by(() => {
    const s = new Set<string>();
    for (let i = 0; i + 1 < pathIds.length; i++) {
      s.add(`${pathIds[i]}__${pathIds[i + 1]}`);
      s.add(`${pathIds[i + 1]}__${pathIds[i]}`);
    }
    return s;
  });

  // Identity of the graph TOPOLOGY (node id set + link endpoint/type set).
  // Built from the string-keyed derived sets (not the d3-mutated `curLs`, whose
  // endpoints become node objects). Overlay-only prop changes (selection, path,
  // colour, community, centrality) leave this stable → no rebuild, no re-sim.
  const topoKey = $derived.by(() => {
    const nk = filteredNodes.map((n) => n.id).slice().sort().join('|');
    const lk = filteredLinks
      .map((l) => `${l.source}>${l.target}:${l.type}`)
      .slice()
      .sort()
      .join('|');
    return `${nk}#${lk}`;
  });

  // ---- Tooltip ---------------------------------------------------------------
  function showTooltip(event: MouseEvent, n: SimNode) {
    if (!tooltipEl) return;
    tooltipEl.style.display = 'block';
    tooltipEl.style.left = `${event.offsetX + 14}px`;
    tooltipEl.style.top = `${event.offsetY - 8}px`;
    let html = `<div class="font-semibold text-sm">${escapeHtml(n.label)}</div>`;
    html += `<div class="text-xs opacity-70 mt-0.5">${escapeHtml(n.type)}</div>`;
    html += `<div class="text-xs opacity-70">${connectionCount(n.id)} connection(s)</div>`;
    const c = centralityOf[n.id];
    if (typeof c === 'number')
      html += `<div class="text-xs opacity-70">centrality ${(c).toFixed(3)}</div>`;
    const v = verificationOf[n.id];
    if (v && typeof v.score === 'number')
      html += `<div class="text-xs opacity-70">verification ${v.score.toFixed(2)}</div>`;
    if (verificationFlagged(v))
      html += `<div class="text-xs mt-0.5" style="color:var(--color-danger-text)">⚠ ${escapeHtml((v!.flags ?? []).join(', '))}</div>`;
    html += `<div class="text-xs opacity-50 mt-1">double-click to expand</div>`;
    tooltipEl.innerHTML = html;
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  // ---- Zoom controls ---------------------------------------------------------
  function svgSel() {
    return d3.select<SVGSVGElement, unknown>(container.querySelector('svg')!);
  }
  function zoomIn() {
    if (zoomBehavior && container) svgSel().transition().duration(250).call(zoomBehavior.scaleBy, 1.3);
  }
  function zoomOut() {
    if (zoomBehavior && container) svgSel().transition().duration(250).call(zoomBehavior.scaleBy, 0.7);
  }
  function zoomReset() {
    if (zoomBehavior && container)
      svgSel().transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
  }

  // ---- Render ----------------------------------------------------------------
  // Two effects: TOPOLOGY (rebuild svg/zoom/sim/joins only when the node/link
  // SET changes, preserving zoom + node positions) and OVERLAYS (re-attribute
  // the existing selections in place for selection/path/colour/centrality —
  // NO teardown, NO re-simulation, so zoom/pan and layout survive a click).
  onDestroy(() => {
    simulation?.stop();
    simulation = null;
    if (clickTimer) clearTimeout(clickTimer);
  });

  // Effect A — topology (defined first so it flushes before overlays on mount).
  $effect(() => {
    const key = topoKey; // the ONLY reactive read → overlay changes don't rebuild
    if (!container) return;
    if (key === lastTopoKey && svgEl) return;
    lastTopoKey = key;
    setup();
  });

  // Effect B — overlays.
  $effect(() => {
    void selectedId;
    // `applyOverlays()` already reads `selectedEdgeKey` (via edgeStroke/edgeWidth),
    // so this effect is transitively reactive to it — but only on runs where
    // `nodeSel` is set. Track it explicitly so an edge (de)selection always
    // re-applies the highlight, even if a run short-circuits before applyOverlays.
    void selectedEdgeKey;
    void pathSet;
    void pathEdgeSet;
    void colorMode;
    void communityOf;
    void centralityOf;
    void centralityScale;
    void adjacency;
    void allTypes;
    void verificationOf;
    void showHulls;
    if (nodeSel) applyOverlays();
  });

  const DIM_OPACITY = 0.12;

  function edgeEnds(d: SimLink): [string, string] {
    const s = typeof d.source === 'string' ? d.source : d.source.id;
    const t = typeof d.target === 'string' ? d.target : d.target.id;
    return [s, t];
  }
  function isPathEdge(d: SimLink): boolean {
    const [s, t] = edgeEnds(d);
    return pathEdgeSet.has(`${s}__${t}`);
  }

  // Transient hover on an edge's fat hit line — plain `let` (imperative, never a
  // reactive dep) so it can't loop the render effects.
  let hoverEdgeKey: string | null = null;

  /** Visible stroke for an edge, with selected > path > hover > default priority. */
  function edgeStroke(d: SimLink): string {
    if (d.key === selectedEdgeKey) return 'var(--color-accent)';
    if (isPathEdge(d)) return 'var(--color-accent)';
    if (d.key === hoverEdgeKey) return 'var(--color-text-muted)';
    return 'var(--color-border-strong)';
  }
  function edgeWidth(d: SimLink): number {
    if (d.key === selectedEdgeKey) return 3;
    if (isPathEdge(d)) return 2.5;
    if (d.key === hoverEdgeKey) return 2;
    return 1.2;
  }

  /** Re-tint the visible edges for a hover change without a full overlay pass. */
  function setEdgeHover(key: string | null) {
    hoverEdgeKey = key;
    linkSel?.attr('stroke', (d) => edgeStroke(d)).attr('stroke-width', (d) => edgeWidth(d));
  }

  function setup() {
    // Snapshot outgoing positions so a rebuild (or a type-filter toggle)
    // re-seeds nodes where they were rather than flinging them from origin.
    for (const n of curNs) {
      if (n.x != null && n.y != null) {
        posCache.set(n.id, { x: n.x, y: n.y, vx: n.vx ?? 0, vy: n.vy ?? 0 });
      }
    }
    // Preserve the current zoom/pan transform across the rebuild.
    const savedTransform = svgEl ? d3.zoomTransform(svgEl.node()!) : null;

    simulation?.stop();
    simulation = null;
    d3.select(container).selectAll('svg').remove();
    linkSel = null;
    linkHitSel = null;
    edgeLabelSel = null;
    nodeSel = null;
    zoomLayer = null;

    const width = container.clientWidth || 800;
    const h = height;
    curWidth = width;
    curHeight = h;

    svgEl = d3
      .select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', h)
      .attr('viewBox', `0 0 ${width} ${h}`)
      .attr('class', 'rounded-lg');

    if (filteredNodes.length === 0) {
      svgEl
        .append('text')
        .attr('x', width / 2)
        .attr('y', h / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', 'var(--color-text-muted)')
        .attr('font-size', '13px')
        .text('No nodes to display.');
      curNs = [];
      curLs = [];
      return;
    }

    zoomLayer = svgEl.append('g');
    zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        zoomLayer!.attr('transform', event.transform);
        if (!applyingProgrammatic) drawMinimapViewport(event.transform);
      });
    svgEl.call(zoomBehavior);

    // Hull layer FIRST so community regions sit behind links/nodes; inherits the
    // zoom transform for free. Populated in applyOverlays/tick when enabled.
    hullG = zoomLayer.append('g').attr('class', 'kag-hulls');

    // Clone so d3 mutation doesn't pollute reactive state; seed positions from
    // posCache so only brand-new nodes start unplaced. Brand-new nodes from an
    // expand grow out of their origin node's position (expand-in-place); others
    // jitter near centre so the centre force gathers them.
    const origin = expandOriginId ? posCache.get(expandOriginId) : undefined;
    curNs = filteredNodes.map((n) => {
      const p = posCache.get(n.id);
      if (p) return { ...n, x: p.x, y: p.y, vx: p.vx, vy: p.vy };
      if (origin)
        return { ...n, x: origin.x + (Math.random() - 0.5) * 40, y: origin.y + (Math.random() - 0.5) * 40 };
      return {
        ...n,
        x: width / 2 + (Math.random() - 0.5) * 40,
        y: h / 2 + (Math.random() - 0.5) * 40,
      };
    });
    curLs = filteredLinks.map((l) => ({ ...l }));

    // Arrow marker (single neutral marker; edges tint via stroke).
    svgEl
      .append('defs')
      .append('marker')
      .attr('id', 'kag-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 22)
      .attr('refY', 0)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('fill', 'var(--color-border-strong)')
      .attr('d', 'M0,-5L10,0L0,5');

    simulation = d3
      .forceSimulation(curNs)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(curLs)
          .id((d) => d.id)
          .distance(90)
          .strength(0.35),
      )
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(width / 2, h / 2))
      .force('collide', d3.forceCollide<SimNode>().radius((d) => nodeRadius(d) + 6))
      // A seeded rebuild only needs to re-settle gently; a first mount lays out
      // from scratch.
      .alpha(posCache.size ? 0.5 : 1);

    // Edges — STATIC attrs only; stroke/width/opacity deferred to applyOverlays.
    linkSel = zoomLayer
      .append('g')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(curLs)
      .join('line')
      .attr('marker-end', 'url(#kag-arrow)')
      .attr('pointer-events', 'none'); // clicks land on the fat hit line below

    // Transparent fat hit lines (on top of the visible edges) — the click/hover
    // affordance. `stroke-linecap: round` + a generous width make thin edges
    // easy to hit; the visible edge stays 1–2px.
    linkHitSel = zoomLayer
      .append('g')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(curLs)
      .join('line')
      .attr('stroke', 'transparent')
      .attr('stroke-width', 12)
      .attr('stroke-linecap', 'round')
      .style('cursor', 'pointer')
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', (d) => `${d.type || 'related'} relationship`)
      .on('mouseenter', (_event: MouseEvent, d: SimLink) => setEdgeHover(d.key))
      .on('mouseleave', () => setEdgeHover(null))
      .on('focus', (_event: FocusEvent, d: SimLink) => setEdgeHover(d.key))
      .on('blur', () => setEdgeHover(null))
      .on('click', (event: MouseEvent, d: SimLink) => {
        event.stopPropagation();
        onedgeselect?.(d.key === selectedEdgeKey ? null : d.raw);
      })
      .on('keydown', (event: KeyboardEvent, d: SimLink) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onedgeselect?.(d.key === selectedEdgeKey ? null : d.raw);
        }
      });

    // Edge type labels (subtle; only when few edges to avoid clutter).
    edgeLabelSel =
      curLs.length <= 60
        ? zoomLayer
            .append('g')
            .selectAll<SVGTextElement, SimLink>('text')
            .data(curLs.filter((l) => l.type))
            .join('text')
            .text((d) => d.type)
            .attr('font-size', '9px')
            .attr('fill', 'var(--color-text-muted)')
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none')
        : null;

    // Node groups — keyed by id; static structure + a11y + interaction handlers.
    nodeSel = zoomLayer
      .append('g')
      .selectAll<SVGGElement, SimNode>('g')
      .data(curNs, (d) => d.id)
      .join('g')
      .style('cursor', 'pointer')
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', (d) => `${d.label} (${d.type})`)
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

    // Circle attrs (r/fill/stroke) are overlay-driven → set in applyOverlays.
    // Class `kag-body` distinguishes the fill circle from the verification ring
    // and flag dot (both added lazily in applyOverlays), so selectors never mix.
    nodeSel.append('circle').attr('class', 'kag-body');

    nodeSel
      .append('text')
      .text((d) => (d.label.length > 18 ? d.label.slice(0, 18) + '…' : d.label))
      .attr('x', 0)
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .attr('font-weight', '500')
      .attr('fill', 'var(--color-text)')
      .attr('pointer-events', 'none')
      .attr('style', 'paint-order:stroke;stroke:var(--color-bg);stroke-width:3px');

    nodeSel
      .on('mouseenter', function (event: MouseEvent, d: SimNode) {
        d3.select(this).select('circle.kag-body').attr('stroke', 'var(--color-accent)').attr('stroke-width', 3);
        showTooltip(event, d);
        onpeek?.(d.raw, event.offsetX, event.offsetY);
      })
      .on('mousemove', function (event: MouseEvent, d: SimNode) {
        showTooltip(event, d);
        onpeek?.(d.raw, event.offsetX, event.offsetY);
      })
      .on('mouseleave', function (_e: MouseEvent, d: SimNode) {
        d3.select(this)
          .select('circle.kag-body')
          .attr('stroke', d.id === selectedId || pathSet.has(d.id) ? 'var(--color-accent)' : 'var(--color-bg)')
          .attr('stroke-width', d.id === selectedId || pathSet.has(d.id) ? 3 : 1.5);
        hideTooltip();
        onpeekhide?.();
      })
      .on('click', (_event: MouseEvent, d: SimNode) => {
        // Disambiguate click from dblclick: a real double-click fires
        // click,click,dblclick — the two bare clicks would toggle selection off
        // and leave an expanded node deselected. First click schedules select;
        // the second click of a pair cancels it; dblclick then expands.
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          return;
        }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          onselect?.(d.id === selectedId ? null : d.raw);
        }, 250);
      })
      .on('dblclick', (event: MouseEvent, d: SimNode) => {
        event.preventDefault();
        event.stopPropagation();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        onexpand?.(d.raw);
      })
      .on('keydown', (event: KeyboardEvent, d: SimNode) => {
        // Enter/Space select (toggle); `e` expands. Keyboard has no dblclick
        // ambiguity so select fires synchronously.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onselect?.(d.id === selectedId ? null : d.raw);
        } else if (event.key === 'e' || event.key === 'E') {
          event.preventDefault();
          onexpand?.(d.raw);
        }
      });

    tickCount = 0;
    simulation.on('tick', () => {
      linkSel!
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      linkHitSel!
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      edgeLabelSel
        ?.attr('x', (d) => (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2)
        .attr('y', (d) => (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2);
      nodeSel!.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      drawHulls();
      if (mmDots && ++tickCount % 4 === 0) fitMinimap();
    });

    // Restore the zoom transform, then paint the overlay-driven attrs.
    if (savedTransform) svgEl.call(zoomBehavior.transform, savedTransform);
    setupMinimap();
    applyOverlays();
  }

  function applyOverlays() {
    if (!nodeSel) return;
    const focus = selectedId && nodeIds.has(selectedId) ? selectedId : null;
    const neighbours = focus ? (adjacency.get(focus) ?? new Set<string>()) : null;
    const nodeOpacity = (id: string): number =>
      !focus ? 1 : id === focus || neighbours!.has(id) ? 1 : DIM_OPACITY;

    nodeSel.attr('opacity', (d) => nodeOpacity(d.id));
    nodeSel
      .select('circle.kag-body')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => nodeFill(d))
      .attr('stroke', (d) =>
        d.id === selectedId || pathSet.has(d.id) ? 'var(--color-accent)' : 'var(--color-bg)',
      )
      .attr('stroke-width', (d) => (d.id === selectedId || pathSet.has(d.id) ? 3 : 1.5));
    nodeSel.select('text').attr('y', (d) => nodeRadius(d) + 12);

    // Verification badges — added lazily per node so the un-verified graph draws
    // exactly one circle per node (score ring inserted BEHIND the body circle;
    // contradiction/anomaly dot on top-right). A data-join on [] removes them
    // when the overlay clears, all without a topology rebuild.
    nodeSel.each(function (d) {
      const g = d3.select<SVGGElement, SimNode>(this);
      const v = verificationOf[d.id];
      const hasScore = typeof v?.score === 'number';
      g.selectAll<SVGCircleElement, SimNode>('circle.kag-verif-ring')
        .data(hasScore ? [d] : [], () => 'ring')
        .join(
          (enter) =>
            enter
              .insert('circle', 'circle.kag-body')
              .attr('class', 'kag-verif-ring')
              .attr('fill', 'none')
              .attr('stroke-width', 2.5)
              .attr('stroke-opacity', 0.9),
          (update) => update,
          (exit) => exit.remove(),
        )
        .attr('r', nodeRadius(d) + 3.5)
        .attr('stroke', hasScore ? verificationColor(v!.score!) : 'none');

      const flagged = verificationFlagged(v);
      g.selectAll<SVGCircleElement, SimNode>('circle.kag-verif-flag')
        .data(flagged ? [d] : [], () => 'flag')
        .join(
          (enter) =>
            enter
              .append('circle')
              .attr('class', 'kag-verif-flag')
              .attr('r', 3.5)
              .attr('fill', 'var(--color-danger-text)')
              .attr('stroke', 'var(--color-bg)')
              .attr('stroke-width', 1),
          (update) => update,
          (exit) => exit.remove(),
        )
        .attr('cx', nodeRadius(d) * 0.72)
        .attr('cy', -nodeRadius(d) * 0.72);
    });

    drawHulls();

    linkSel
      ?.attr('stroke', (d) => edgeStroke(d))
      .attr('stroke-width', (d) => edgeWidth(d))
      .attr('stroke-opacity', (d) => {
        if (d.key === selectedEdgeKey) return 0.95;
        if (!focus) return 0.55;
        const [s, t] = edgeEnds(d);
        return s === focus || t === focus ? 0.8 : DIM_OPACITY;
      });
    edgeLabelSel?.attr('opacity', focus ? 0.4 : 0.7);
  }

  // ---- Community hulls -------------------------------------------------------
  function drawHulls() {
    if (!hullG) return;
    const enabled =
      showHulls && colorMode === 'community' && Object.keys(communityOf).length > 0;
    const groups = new Map<number, [number, number][]>();
    if (enabled) {
      for (const n of curNs) {
        const c = communityOf[n.id];
        if (c === undefined) continue;
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c)!.push([n.x ?? 0, n.y ?? 0]);
      }
    }
    const data: { c: number; hull: [number, number][] }[] = [];
    for (const [c, pts] of groups) {
      if (pts.length < 3) continue; // a hull needs ≥3 points
      const hull = d3.polygonHull(pts);
      if (hull) data.push({ c, hull });
    }
    hullG
      .selectAll<SVGPathElement, { c: number; hull: [number, number][] }>('path')
      .data(data, (d) => d.c)
      .join('path')
      .attr('d', (d) => roundedHullPath(d.hull, 22))
      .attr('fill', (d) => colorForCommunity(d.c))
      .attr('fill-opacity', 0.08)
      .attr('stroke', (d) => colorForCommunity(d.c))
      .attr('stroke-opacity', 0.35)
      .attr('stroke-width', 1.5)
      .attr('stroke-linejoin', 'round')
      .attr('pointer-events', 'none');
  }

  // Expand a hull outward by `pad` and render it as a closed path.
  function roundedHullPath(hull: [number, number][], pad: number): string {
    const cx = d3.mean(hull, (p) => p[0]) ?? 0;
    const cy = d3.mean(hull, (p) => p[1]) ?? 0;
    const expanded = hull.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return [x + (dx / len) * pad, y + (dy / len) * pad] as [number, number];
    });
    return `M${expanded.map((p) => p.join(',')).join('L')}Z`;
  }

  // ---- Minimap HUD -----------------------------------------------------------
  // A separate, fixed SVG appended AFTER the main svg (so `querySelector('svg')`
  // still returns the main canvas). Dots per node + a viewport rect from the
  // inverse of the live zoom transform; click/drag recentres.
  function setupMinimap() {
    mmSvg = null;
    mmDots = null;
    mmViewport = null;
    if (!showMinimap || !svgEl) return;
    mmSvg = d3
      .select(container)
      .append('svg')
      .attr('width', MM_W)
      .attr('height', MM_H)
      .attr('class', 'kag-minimap')
      .attr(
        'style',
        'position:absolute;right:12px;bottom:12px;z-index:10;border-radius:8px;' +
          'background:var(--color-bg);opacity:0.92;cursor:pointer;' +
          'box-shadow:0 1px 4px rgba(0,0,0,0.25);border:1px solid var(--color-border-strong)',
      );
    const layer = mmSvg.append('g');
    mmDots = layer
      .append('g')
      .selectAll<SVGCircleElement, SimNode>('circle')
      .data(curNs)
      .join('circle')
      .attr('r', 1.6)
      .attr('fill', (d) => nodeFill(d));
    mmViewport = mmSvg
      .append('rect')
      .attr('fill', 'var(--color-accent)')
      .attr('fill-opacity', 0.12)
      .attr('stroke', 'var(--color-accent)')
      .attr('stroke-width', 1);

    const navigate = (mx: number, my: number) => {
      if (!zoomBehavior || !svgEl || mmScale === 0) return;
      const wx = (mx - mmOx) / mmScale;
      const wy = (my - mmOy) / mmScale;
      const t = d3.zoomTransform(svgEl.node()!);
      const nt = d3.zoomIdentity
        .translate(curWidth / 2 - wx * t.k, curHeight / 2 - wy * t.k)
        .scale(t.k);
      applyingProgrammatic = true;
      svgEl.call(zoomBehavior.transform, nt);
      applyingProgrammatic = false;
      drawMinimapViewport(nt);
    };
    mmSvg.on('click', (event) => {
      const [mx, my] = d3.pointer(event, mmSvg!.node());
      navigate(mx, my);
    });
    mmSvg.call(
      d3.drag<SVGSVGElement, unknown>().on('start drag', (event) => navigate(event.x, event.y)),
    );
    fitMinimap();
  }

  function fitMinimap() {
    if (!mmDots || !mmSvg || !svgEl) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of curNs) {
      const x = n.x ?? 0, y = n.y ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return;
    const pad = 24;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    mmScale = Math.min((MM_W - pad) / spanX, (MM_H - pad) / spanY);
    mmOx = (MM_W - spanX * mmScale) / 2 - minX * mmScale;
    mmOy = (MM_H - spanY * mmScale) / 2 - minY * mmScale;
    mmDots.attr('cx', (d) => (d.x ?? 0) * mmScale + mmOx).attr('cy', (d) => (d.y ?? 0) * mmScale + mmOy);
    drawMinimapViewport(d3.zoomTransform(svgEl.node()!));
  }

  function drawMinimapViewport(t: d3.ZoomTransform) {
    if (!mmViewport) return;
    const [wx0, wy0] = t.invert([0, 0]);
    const [wx1, wy1] = t.invert([curWidth, curHeight]);
    mmViewport
      .attr('x', wx0 * mmScale + mmOx)
      .attr('y', wy0 * mmScale + mmOy)
      .attr('width', Math.max(2, (wx1 - wx0) * mmScale))
      .attr('height', Math.max(2, (wy1 - wy0) * mmScale));
  }
</script>

<div
  bind:this={container}
  class="relative w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
  style={`min-height:${height}px`}
  data-testid="kag-graph-explorer"
>
  <!-- Tooltip -->
  <div
    bind:this={tooltipEl}
    class="pointer-events-none absolute z-20 hidden max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text)] shadow-lg dark:bg-[var(--color-surface)]"
    style="display:none"
  ></div>

  <!-- Zoom controls -->
  <div class="absolute left-3 top-3 z-10 flex flex-col gap-1">
    <button
      onclick={zoomIn}
      class="flex h-8 w-8 items-center justify-center rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-lg font-bold text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface)] dark:bg-[var(--color-surface)]"
      title="Zoom in"
      aria-label="Zoom in">+</button
    >
    <button
      onclick={zoomOut}
      class="flex h-8 w-8 items-center justify-center rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-lg font-bold text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface)] dark:bg-[var(--color-surface)]"
      title="Zoom out"
      aria-label="Zoom out">−</button
    >
    <button
      onclick={zoomReset}
      class="flex h-8 w-8 items-center justify-center rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-xs font-medium text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface)] dark:bg-[var(--color-surface)]"
      title="Reset view"
      aria-label="Reset view">1:1</button
    >
  </div>
</div>

<style>
  /* Node groups are appended imperatively by d3, so they miss Svelte's scoped
     class — target them with :global. Show the focus ring only for keyboard
     focus (:focus-visible), not on mouse click. */
  :global(svg g[role='button']:focus) {
    outline: none;
  }
  :global(svg g[role='button']:focus-visible circle.kag-body) {
    stroke: var(--color-accent);
    stroke-width: 3px;
  }
</style>
