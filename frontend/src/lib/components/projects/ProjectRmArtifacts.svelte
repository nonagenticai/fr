<!--
  The requirements_management assets this project produced — requirements,
  decisions, principles, architecture — as stacked read-only sections (no tab
  strip: nav standard 2026-10-03). Each list is narrowed SERVER-SIDE by
  the route's project parameter; nothing is filtered in the browser.
  Principles are RM's provenance read: the principles this project MINTED.
-->
<script lang="ts">
  import { Skeleton } from '$lib/components/ui';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import {
    PROJECT_ARTIFACT_PAGE,
    artifactLabel,
    listProjectArtifacts,
    relationshipLabel,
    type ArtifactRow,
    type ProjectArtifactKind,
    type ProjectArtifactResult,
  } from '$lib/api/project-artifacts';

  let { projectId }: { projectId: string } = $props();

  interface Section {
    kind: ProjectArtifactKind;
    heading: string;
    noun: string;
    label: (row: ArtifactRow) => string;
  }

  const SECTIONS: Section[] = [
    { kind: 'requirements', heading: 'Requirements', noun: 'requirements', label: artifactLabel },
    { kind: 'decisions', heading: 'Decisions', noun: 'decisions', label: artifactLabel },
    { kind: 'principles', heading: 'Principles minted by this project', noun: 'principles minted by this project', label: principleLabel },
    { kind: 'architecture-elements', heading: 'Architecture elements', noun: 'architecture elements', label: artifactLabel },
    { kind: 'architecture-relationships', heading: 'Architecture relationships', noun: 'architecture relationships', label: relationshipLabel },
  ];

  /** A principle's text lives in `statement`; fall back to title / name / id. */
  function principleLabel(row: ArtifactRow): string {
    const st = typeof row.statement === 'string' && row.statement.trim() ? row.statement : null;
    return st ?? artifactLabel(row);
  }

  let results = $state<Partial<Record<ProjectArtifactKind, ProjectArtifactResult>>>({});

  // Re-read when the project changes (client navigation between projects);
  // a late answer for a previous project is dropped.
  $effect(() => {
    const pid = projectId;
    results = {};
    if (!pid) return;
    for (const s of SECTIONS) {
      void listProjectArtifacts(s.kind, pid).then((r) => {
        if (pid === projectId) results[s.kind] = r;
      });
    }
  });
</script>

{#snippet list(s: Section)}
  {@const r = results[s.kind]}
  <section class="space-y-2" data-testid={`rm-artifacts-${s.kind}`}>
    <h3 class="text-sm font-semibold text-[var(--color-text)]">{s.heading}</h3>
    {#if !r}
      <Skeleton height="3rem" />
    {:else if !r.ok}
      <FailureNotice failure={r} title={r.unavailable ? `${s.heading} unavailable — not none` : `Couldn't read ${s.noun}`} />
    {:else if r.data.projectUnknown}
      <p class="text-sm text-[var(--color-warning-text)]">fr does not know this project, so it has no {s.noun} to list.</p>
    {:else if r.data.rows.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">No {s.noun} recorded for this project.</p>
    {:else}
      <ul class="space-y-1">
        {#each r.data.rows as row (row.id)}
          <li class="flex flex-wrap items-baseline gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-3 py-2 text-sm">
            <span class="min-w-0 break-words text-[var(--color-text)]">{s.label(row)}</span>
            {#if typeof row.status === 'string' && row.status}
              <span class="text-xs text-[var(--color-text-muted)]">{row.status}</span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if r.data.truncated}
        <p class="text-xs text-[var(--color-warning-text)]">The first {PROJECT_ARTIFACT_PAGE} only — more exist.</p>
      {/if}
    {/if}
  </section>
{/snippet}

<div class="space-y-4" data-testid="rm-artifacts">
  {@render list(SECTIONS[0]!)}
  {@render list(SECTIONS[1]!)}
  {@render list(SECTIONS[2]!)}
  {@render list(SECTIONS[3]!)}
  {@render list(SECTIONS[4]!)}
</div>
