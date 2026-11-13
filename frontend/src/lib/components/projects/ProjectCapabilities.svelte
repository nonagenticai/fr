<!--
  ProjectCapabilities — R271: which capabilities the PM selected for this
  project (R260, stored in requirements_management) and WHY, plus the
  selection history. DISPLAY ONLY: fr is a facilitator, never a judge — only
  the PM / n8n changes the selection, so there is no control here that could.

  Four states, and "could not be read" is never collapsed into "none".
-->
<script lang="ts">
  import {
    getProjectCapabilities,
    normalizeProjectCapabilities,
    type ProjectCapabilities,
  } from '$lib/api/project-capabilities';
  import type { Panel } from '$lib/types/panel';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import { withoutRuleRefs } from '$lib/utils/planCopy';

  let {
    projectId,
    /** The cockpit's `capabilities` panel: when given, nothing is fetched (one call for the page). */
    panel = undefined,
  }: {
    projectId: string;
    panel?: Panel<unknown>;
  } = $props();

  type View =
    | { kind: 'reading' }
    | { kind: 'failed'; message: string }
    | { kind: 'read'; caps: ProjectCapabilities };
  let view = $state<View>({ kind: 'reading' });

  $effect(() => {
    if (panel) {
      const caps = panel.data == null ? null : normalizeProjectCapabilities(panel.data);
      view = caps ? { kind: 'read', caps } : { kind: 'failed', message: '' };
      return;
    }
    const id = projectId;
    if (!id) return;
    view = { kind: 'reading' };
    let cancelled = false;
    void (async () => {
      try {
        const caps = await getProjectCapabilities(id);
        if (!cancelled) view = { kind: 'read', caps };
      } catch (e) {
        if (!cancelled) view = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function when(iso: string): string {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso || '—';
  }

  /** Short form of an approval id for display; the full id is in the title. */
  function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  /** Every string inside the consult answer with rule references removed; the shape is kept. */
  function stripRuleRefs(value: unknown): unknown {
    if (typeof value === 'string') return withoutRuleRefs(value);
    if (Array.isArray(value)) return value.map(stripRuleRefs);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripRuleRefs(v)]));
    }
    return value;
  }

  /** R302: the consult answer as readable JSON (it is free-form in RM), without rule references. */
  function consultText(consult: Record<string, unknown>): string {
    try {
      return JSON.stringify(stripRuleRefs(consult), null, 2);
    } catch {
      return String(consult);
    }
  }
</script>

<section data-testid="project-capabilities">
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
    Capabilities{view.kind === 'read' && view.caps.selected.length > 0 ? ` · ${view.caps.selected.length}` : ''}
  </h3>
  {#if view.kind === 'reading'}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="project-capabilities-reading">
      Reading the capability selection…
    </p>
  {:else if view.kind === 'failed'}
    <div class="text-xs text-[var(--color-warning-text)]" data-testid="project-capabilities-failed">
      {#if panel}
        <PanelNote panel={panel} title="The capability selection" />
      {:else}
        The capability selection could not be read — this is not "none selected". It is retried on the next refresh.
      {/if}
    </div>
  {:else}
    {#if view.caps.selected.length === 0}
      <p
        class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-muted)]"
        data-testid="project-capabilities-none"
      >
        No capability selection yet
      </p>
    {:else}
      <ul
        class="space-y-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
        data-testid="project-capabilities-selected"
      >
        {#each view.caps.selected as cap (cap.capability_id || cap.name)}
          <li class="text-xs text-[var(--color-text)]" data-testid="project-capability-row">
            <span class="font-mono font-semibold" data-testid="project-capability-name">{cap.name}</span>
            {#if cap.involvement || cap.rigor || cap.complexity}
              <span class="ml-1 inline-flex flex-wrap gap-1 align-middle" data-testid="project-capability-badges">
                {#if cap.involvement}
                  <span
                    class="rounded border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-muted)]"
                    data-testid="project-capability-involvement">involvement {cap.involvement}</span
                  >
                {/if}
                {#if cap.rigor}
                  <span
                    class="rounded border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-muted)]"
                    data-testid="project-capability-rigor">rigor {cap.rigor}</span
                  >
                {/if}
                {#if cap.complexity}
                  <span
                    class="rounded border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-muted)]"
                    data-testid="project-capability-complexity">complexity {cap.complexity}</span
                  >
                {/if}
              </span>
            {/if}
            {#if cap.purpose}
              <!-- The VISIBLE line is the capability's purpose. The PM's selection
                   rationale (`reason`) and the consult answer are agent-internal
                   (rule numbers, "consult" vocabulary), so they sit behind "Why". -->
              <p class="mt-0.5 text-[11px] text-[var(--color-text)]" data-testid="project-capability-purpose">
                {withoutRuleRefs(cap.purpose)}
              </p>
            {/if}
            {#if cap.order_after.length > 0}
              <p class="mt-0.5 text-[11px] text-[var(--color-text-muted)]" data-testid="project-capability-order-after">
                after: <span class="font-mono">{cap.order_after.join(', ')}</span>
              </p>
            {/if}
            {#if cap.reason || cap.consult}
              <details class="mt-0.5" data-testid="project-capability-why">
                <summary class="cursor-pointer text-[11px] text-[var(--color-text-muted)]">Why</summary>
                {#if cap.reason}
                  <p class="mt-1 text-[11px] text-[var(--color-text-muted)]" data-testid="project-capability-reason">
                    {withoutRuleRefs(cap.reason)}
                  </p>
                {/if}
                {#if cap.consult}
                  <pre
                    class="mt-1 max-h-48 overflow-auto rounded bg-[var(--color-surface-strong)] p-1.5 text-[10px] whitespace-pre-wrap break-words text-[var(--color-text)]"
                    data-testid="project-capability-consult">{consultText(cap.consult)}</pre>
                {/if}
              </details>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if view.caps.implicit.length > 0}
      <p class="mt-1 text-[11px] text-[var(--color-text-muted)]" data-testid="project-capabilities-implicit">
        Always on: {view.caps.implicit.join(', ')}
      </p>
    {/if}
    {#if view.caps.events.length > 0}
      <details class="mt-2" data-testid="project-capabilities-history">
        <summary class="cursor-pointer text-[11px] text-[var(--color-text-muted)]">
          Selection history · {view.caps.total_events}
        </summary>
        <ol class="mt-1 space-y-1">
          {#each view.caps.events as ev (ev.id)}
            <li class="text-[11px] text-[var(--color-text)]" data-testid="project-capability-event">
              <span class="text-[var(--color-text-muted)]">{when(ev.created_at)}</span>
              <span class="font-mono">{ev.subject_id}</span>
              {#if ev.added.length > 0}
                <span data-testid="project-capability-event-added">added {ev.added.join(', ')}</span>
              {/if}
              {#if ev.removed.length > 0}
                <span data-testid="project-capability-event-removed">removed {ev.removed.join(', ')}</span>
              {/if}
              {#if ev.approval_id}
                <span
                  class="font-mono text-[var(--color-text-muted)]"
                  title={ev.approval_id}
                  data-testid="project-capability-event-approval">approval {shortId(ev.approval_id)}</span
                >
              {/if}
            </li>
          {/each}
        </ol>
      </details>
    {/if}
  {/if}
</section>
