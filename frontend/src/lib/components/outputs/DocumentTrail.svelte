<!--
  DocumentTrail — the project's Outputs (R3 / DOC-3, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3, §7.1):
  the final report first, then the document trail per phase (current phase first, newest first),
  each row title · kind · status · version · date · one-line summary. No ids, no file names. Only
  what was produced (§8): a phase with nothing is absent, nothing is greyed out. A finished
  project's drafts were already dropped by the read model.
-->
<script lang="ts">
  import type { ProjectOutputs, TrailDocument, TrailPullRequest } from '$lib/types/outputs';
  import { shortTime } from '$lib/components/cockpit/spine';
  import { documentHref, statusLine } from '$lib/documents/reader';

  let { projectId, outputs }: { projectId: string; outputs: Extract<ProjectOutputs, { available: true }> } = $props();

  const empty = $derived(
    !outputs.final_report &&
      outputs.phases.length === 0 &&
      outputs.unassigned.documents.length === 0 &&
      outputs.unassigned.pull_requests.length === 0,
  );

  const PARTIAL_WORD: Record<string, string> = {
    phases: 'the phases could not be read, so documents are not placed in a phase',
    state: "the project's state could not be read",
    pull_requests: 'the pull requests could not be read',
  };

  const STATUS_CLASS: Record<string, string> = {
    published: 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
    in_review: 'border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[var(--color-info-text)]',
    draft: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
  };
  const PR_WORD: Record<string, string> = { merged: 'merged', open: 'open', closed: 'closed' };

  function meta(d: TrailDocument): string {
    return [d.type_label, d.version_count > 1 || d.version > 1 ? `version ${d.version}` : null, shortTime(d.at) || null]
      .filter(Boolean)
      .join(' · ');
  }
  function prMeta(p: TrailPullRequest): string {
    return [p.state ? PR_WORD[p.state] : null, p.card_name, shortTime(p.at) || null].filter(Boolean).join(' · ');
  }
</script>

{#snippet docRow(d: TrailDocument)}
  <li data-testid="trail-document" data-status={d.status ?? 'unknown'}>
    <a
      class="block rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 hover:border-[var(--color-accent-border)]"
      href={documentHref(projectId, d.artifact_id)}
    >
      <span class="flex flex-wrap items-baseline justify-between gap-2">
        <span class="text-sm font-semibold text-[var(--color-text)]" data-testid="trail-title">{d.title}</span>
        {#if d.status}
          <!-- The SAME status line as the reader's banner: release + review in one ("Published · review pending"). -->
          <span class={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[d.status]}`} data-testid="trail-status">{statusLine(d, outputs.finished)}</span>
        {/if}
      </span>
      {#if d.summary}
        <span class="mt-0.5 block truncate text-xs text-[var(--color-text)]" data-testid="trail-summary">{d.summary}</span>
      {/if}
      <span class="mt-0.5 block text-xs text-[var(--color-text-muted)]" data-testid="trail-meta">{meta(d)}</span>
    </a>
  </li>
{/snippet}

{#snippet prRows(prs: TrailPullRequest[])}
  {#if prs.length > 0}
    <ul class="mt-1 space-y-1" data-testid="trail-prs">
      {#each prs as p (p.url)}
        <li class="text-xs" data-testid="trail-pr">
          <a class="font-semibold text-[var(--color-link)] hover:underline" href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a>
          <span class="text-[var(--color-text-muted)]"> · {prMeta(p)}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<div class="space-y-5" data-testid="document-trail" data-finished={outputs.finished}>
  {#if outputs.partial.length > 0}
    <p class="text-xs text-[var(--color-warning-text)]" role="status" data-testid="trail-partial">
      Part of this list may be missing: {outputs.partial.map((p) => PARTIAL_WORD[p] ?? p).join('; ')}.
    </p>
  {/if}

  {#if outputs.final_report}
    <section aria-label="Final report" data-testid="trail-final">
      <h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Final report</h2>
      <ul>{@render docRow(outputs.final_report)}</ul>
    </section>
  {/if}

  {#each outputs.phases as ph (ph.name)}
    <section aria-label={ph.label} data-testid="trail-phase" data-phase={ph.name}>
      <h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        {ph.label}{ph.current && !outputs.finished ? ' · current phase' : ''}
      </h2>
      {#if ph.documents.length > 0}
        <ul class="space-y-1.5">
          {#each ph.documents as d (d.key)}{@render docRow(d)}{/each}
        </ul>
      {/if}
      {@render prRows(ph.pull_requests)}
    </section>
  {/each}

  {#if outputs.unassigned.documents.length > 0 || outputs.unassigned.pull_requests.length > 0}
    <section aria-label="Not tied to a phase" data-testid="trail-unassigned">
      <h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Not tied to a phase</h2>
      {#if outputs.unassigned.documents.length > 0}
        <ul class="space-y-1.5">
          {#each outputs.unassigned.documents as d (d.key)}{@render docRow(d)}{/each}
        </ul>
      {/if}
      {@render prRows(outputs.unassigned.pull_requests)}
    </section>
  {/if}

  {#if empty}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="trail-empty">
      {outputs.finished ? 'This project published no documents.' : 'This project has not produced a document yet.'}
    </p>
  {/if}
</div>
