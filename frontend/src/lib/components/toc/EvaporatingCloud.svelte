<!--
  EvaporatingCloud.svelte — the Dettmer Evaporating Cloud (conflict-resolution
  diagram) as a fixed 5-box SVG:

      [B requirement] ─── [D prerequisite]
     /                            ‖ (conflict, dashed red)
  [A objective]                   ‖
     \                            ‖
      [C requirement] ─── [D′ prerequisite]

  A = common objective; B,C = requirements; D,D′ = conflicting prerequisites.
  Assumptions surface as pills under each necessity arrow; resolutions
  ("injections") list below. Decoupled from the API — takes a TocGraph.

  Box assignment: by node_kind (objective/requirement/prerequisite) + the
  node's `layout.box` hint ('A'|'B'|'C'|'D'|'Dprime') when present; falls back
  to first-seen order within each kind.
-->
<script lang="ts">
  import type { TocGraph, TocNode, TocEdge } from '$lib/api/toc';
  import { edgeKindColor } from './palette';

  let { graph }: { graph: TocGraph } = $props();

  type Slot = 'A' | 'B' | 'C' | 'D' | 'Dprime';

  function boxHint(n: TocNode): Slot | null {
    const raw = (n.layout?.box ?? '') as string;
    const v = String(raw).toUpperCase().replace(/['′]/g, 'PRIME');
    if (v === 'A' || v === 'B' || v === 'C' || v === 'D') return v as Slot;
    if (v === 'DPRIME' || v === "D'") return 'Dprime';
    return null;
  }

  const slots = $derived.by(() => {
    const out: Record<Slot, TocNode | null> = {
      A: null,
      B: null,
      C: null,
      D: null,
      Dprime: null,
    };
    const reqs: TocNode[] = [];
    const prereqs: TocNode[] = [];
    for (const n of graph.nodes) {
      const hint = boxHint(n);
      if (hint && !out[hint]) {
        out[hint] = n;
        continue;
      }
      const kind = n.node_kind.toLowerCase();
      if (kind.includes('object')) out.A ??= n;
      else if (kind.includes('require')) reqs.push(n);
      else if (kind.includes('prereq')) prereqs.push(n);
      else reqs.push(n);
    }
    out.B ??= reqs[0] ?? null;
    out.C ??= reqs[1] ?? null;
    out.D ??= prereqs[0] ?? null;
    out.Dprime ??= prereqs[1] ?? null;
    return out;
  });

  const assumptions = $derived(
    graph.edges.filter((e) => e.relationship_type === 'assumption'),
  );
  const resolutions = $derived(
    graph.nodes.filter((n) =>
      n.node_kind.toLowerCase().includes('injection') ||
      n.node_kind.toLowerCase().includes('resolution'),
    ),
  );

  // Box geometry (viewBox 0 0 640 320).
  const BOX = { w: 150, h: 64 } as const;
  const POS: Record<Slot, { x: number; y: number; label: string }> = {
    A: { x: 20, y: 128, label: 'A · Objective' },
    B: { x: 245, y: 30, label: 'B · Requirement' },
    C: { x: 245, y: 226, label: 'C · Requirement' },
    D: { x: 470, y: 30, label: 'D · Prerequisite' },
    Dprime: { x: 470, y: 226, label: "D′ · Prerequisite" },
  };
  const cx = (s: Slot) => POS[s].x + BOX.w / 2;
  const cy = (s: Slot) => POS[s].y + BOX.h / 2;

  function clamp(text: string | undefined, n = 60): string {
    if (!text) return '';
    return text.length > n ? text.slice(0, n) + '…' : text;
  }

  const conflictColor = edgeKindColor('conflict');
  const necColor = edgeKindColor('necessity');
</script>

<div class="w-full" data-testid="evaporating-cloud">
  <svg viewBox="0 0 640 320" class="w-full h-auto" role="img" aria-label="Evaporating Cloud">
    <!-- necessity arrows A→B, A→C, B→D, C→D′ -->
    {#each [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'Dprime']] as pair (pair.join())}
      <line
        x1={cx(pair[0] as Slot)} y1={cy(pair[0] as Slot)}
        x2={cx(pair[1] as Slot)} y2={cy(pair[1] as Slot)}
        stroke={necColor} stroke-width="2" stroke-opacity="0.7"
      />
    {/each}

    <!-- conflict D ↔ D′ (dashed red) -->
    <line
      x1={cx('D')} y1={POS.D.y + BOX.h}
      x2={cx('Dprime')} y2={POS.Dprime.y}
      stroke={conflictColor} stroke-width="2.5" stroke-dasharray="7 5"
    />
    <text
      x={cx('D') + 8} y={(cy('D') + cy('Dprime')) / 2}
      font-size="11" font-weight="600" fill={conflictColor}
    >conflict</text>

    {#each Object.keys(POS) as key (key)}
      {@const s = key as Slot}
      {@const n = slots[s]}
      <g>
        <rect
          x={POS[s].x} y={POS[s].y} width={BOX.w} height={BOX.h} rx="8"
          fill="var(--color-surface)" stroke="var(--color-border-strong)" stroke-width="1.5"
        />
        <text x={POS[s].x + 10} y={POS[s].y + 18} font-size="10" font-weight="700" fill="var(--color-text-muted)">
          {POS[s].label}
        </text>
        <text x={POS[s].x + 10} y={POS[s].y + 38} font-size="11" fill="var(--color-text)">
          {clamp(n?.title, 22)}
        </text>
        <text x={POS[s].x + 10} y={POS[s].y + 54} font-size="9" fill="var(--color-text-muted)">
          {clamp(n?.statement, 26)}
        </text>
      </g>
    {/each}
  </svg>

  {#if assumptions.length > 0}
    <div class="mt-3" data-testid="cloud-assumptions">
      <h4 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-1.5">Assumptions</h4>
      <div class="flex flex-wrap gap-1.5">
        {#each assumptions as a (a.id)}
          <span class="px-2 py-0.5 rounded-full text-xs border border-[var(--color-border)] text-[var(--color-text-muted)]">
            {clamp(a.description ?? a.name ?? 'assumption', 50)}
          </span>
        {/each}
      </div>
    </div>
  {/if}

  {#if resolutions.length > 0}
    <div class="mt-3" data-testid="cloud-resolutions">
      <h4 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-1.5">Resolutions (injections)</h4>
      <ul class="space-y-1 text-sm list-disc list-inside text-[var(--color-text)]">
        {#each resolutions as r (r.id)}
          <li>{clamp(r.statement || r.title, 80)}</li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
