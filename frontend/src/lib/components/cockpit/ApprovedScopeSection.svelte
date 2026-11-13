<script lang="ts">
  // The APPROVED SCOPE (migration 127) — the deliverables, milestones and effort
  // figure a human signed off on an outline, which promotion used to drop on the
  // floor. This component is the NAMED READER those columns needed: the rule
  // this estate earned is that no field ships without one.
  //
  // ⛔ ACCEPTANCE CRITERIA ARE APPROVED INTENT, NOT EVIDENCE OF COMPLETION, and
  // this component is exactly where that gets forgotten. Nothing in fr validates
  // a criterion against an artefact — measured 2026-09-23, `artifacts.card_id`
  // was NULL on all 58,573 rows and 0 of 15 upload sites set it. So: NO
  // checkmarks, NO ticked boxes, NO "done" styling, NO "3 of 7 met" count. Each
  // criterion is rendered as a plain listed sentence under a heading that says
  // what it is. `ApprovedScopeSection.test.ts` pins the absence of the tick.
  //
  // ⛔ The effort figure carries the warning idiom copied verbatim from
  // `project-request/OutlinePanel.svelte` (the `cost-estimate-label` span) rather
  // than a new one — one idiom for "this is an estimate, not a measurement".
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { ApprovedScope, ProjectDeliverable } from '$lib/types/cockpit';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  interface Props {
    scope: Panel<ApprovedScope>;
    /** Optional lead-in explaining WHY this is on screen (the TOC substitution). */
    note?: string;
  }
  let { scope, note }: Props = $props();

  const data = $derived(hasData(scope) ? scope.data : null);

  const KIND_LABEL: Record<ProjectDeliverable['kind'], string> = {
    deliverable: 'Deliverable',
    intermediate: 'Intermediate',
  };

  function fmtDate(d: string | null): string {
    if (!d) return 'no target date';
    const t = Date.parse(d);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : d;
  }
</script>

<section
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
  data-testid="approved-scope"
>
  <h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
    Approved scope
  </h2>
  {#if note}
    <p class="mt-1 text-sm text-[var(--color-text-muted)]" data-testid="approved-scope-note">
      {note}
    </p>
  {/if}

  {#if !data}
    <div class="mt-3">
      <PanelNote panel={scope} title="Approved scope" />
    </div>
  {:else}
    {#if data.approved_effort_estimate}
      <dl class="mt-3 text-sm" data-testid="approved-effort">
        <dt class="text-[var(--color-text-muted)]">
          Effort
          <span
            class="ml-1 rounded bg-[var(--color-warning-bg)] px-1.5 py-0.5 text-xs text-[var(--color-warning-text)]"
            data-testid="approved-effort-label">Approved estimate — not tracked effort</span
          >
        </dt>
        <dd class="text-[var(--color-text)]">
          {data.approved_effort_estimate.value}
          {data.approved_effort_estimate.unit}
          {#if data.approved_effort_estimate.note}<span class="text-[var(--color-text-muted)]">
              — {data.approved_effort_estimate.note}</span
            >{/if}
        </dd>
      </dl>
    {/if}

    {#if data.deliverables.length === 0}
      <!-- An HONEST empty state, not a spinner: the read SUCCEEDED and returned
           nothing. A failed read takes the unavailable branch above. -->
      <p class="mt-3 text-sm text-[var(--color-text-muted)]" data-testid="approved-scope-empty">
        No approved scope is recorded for this project. Deliverables are written here when an
        outline is approved and promoted — nothing has been agreed yet.
      </p>
    {:else}
      <ol class="mt-3 space-y-3" data-testid="approved-deliverables">
        {#each data.deliverables as d (d.id)}
          <li
            class="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
            data-testid="approved-deliverable"
            data-position={d.position}
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <span
                class="rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]"
                >{KIND_LABEL[d.kind] ?? d.kind}</span
              >
              <span class="text-sm font-semibold text-[var(--color-text)]">{d.title}</span>
            </div>
            {#if d.description}
              <p class="mt-1 text-sm text-[var(--color-text-muted)]">{d.description}</p>
            {/if}
            {#if d.acceptance_criteria.length > 0}
              <p
                class="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
                data-testid="acceptance-criteria-label"
              >
                Acceptance criteria — approved intent, not evidence of completion
              </p>
              <ul
                class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--color-text)]"
                data-testid="acceptance-criteria"
              >
                {#each d.acceptance_criteria as c, i (i)}
                  <li>{c}</li>
                {/each}
              </ul>
            {:else}
              <p class="mt-2 text-sm text-[var(--color-text-muted)]">
                No acceptance criteria were recorded for this deliverable.
              </p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}

    {#if data.milestones.length > 0}
      <h3
        class="mt-4 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
      >
        Approved milestones
      </h3>
      <ul class="mt-1 space-y-1 text-sm" data-testid="approved-milestones">
        {#each data.milestones as m (m.position)}
          <li class="flex justify-between gap-4" data-position={m.position}>
            <span class="text-[var(--color-text)]">{m.name}</span>
            <span class="text-[var(--color-text-muted)]">{fmtDate(m.target_date)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
