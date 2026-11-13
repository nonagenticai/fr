<!--
  /projects/[id]/documents/[artifactId] — the document reader (R3 / DOC-3,
  FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.1). The trail (GET /api/projects/:id/outputs) says which
  document and version the id is — a version's read artifact, or its reviewed `.json` whose `.md`
  is read instead — so the page knows the card's other versions, the status and whether a review is
  open. Three states, never collapsed: reading / failed / not in this project's outputs.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { fetchProjectOutputs } from '$lib/api/project-outputs';
  import { findDocument } from '$lib/documents/reader';
  import DocumentReader from '$lib/components/outputs/DocumentReader.svelte';
  import type { ProjectOutputs } from '$lib/types/outputs';

  const projectId = $derived($page.params.id ?? '');
  const artifactId = $derived($page.params.artifactId ?? '');

  type View = { kind: 'reading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; data: ProjectOutputs };
  let view = $state<View>({ kind: 'reading' });

  async function load(id: string): Promise<void> {
    try {
      const data = await fetchProjectOutputs(id);
      if (id === projectId) view = { kind: 'loaded', data };
    } catch (e) {
      if (id === projectId) view = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }
  $effect(() => {
    const id = projectId;
    if (!id) return;
    view = { kind: 'reading' };
    void load(id);
  });

  const found = $derived(view.kind === 'loaded' ? findDocument(view.data, artifactId) : null);
  const phaseLabel = $derived.by(() => {
    if (view.kind !== 'loaded' || !view.data.available || !found?.doc.phase) return null;
    return view.data.phases.find((p) => p.name === found.doc.phase)?.label ?? (found.doc.phase === 'closure' ? 'Closure' : found.doc.phase);
  });
  const finished = $derived(view.kind === 'loaded' && view.data.available ? view.data.finished : false);
  const outputsHref = $derived(`/projects/${encodeURIComponent(projectId)}/artifacts`);
</script>

<div class="px-6 pt-4">
  <a class="text-xs font-semibold text-[var(--color-link)] hover:underline" href={outputsHref} data-testid="reader-back">← All outputs</a>
</div>

{#if view.kind === 'reading'}
  <p class="p-6 text-sm text-[var(--color-text-muted)]" data-testid="reader-page-reading">Reading the document…</p>
{:else if view.kind === 'failed'}
  <p class="p-6 text-sm text-[var(--color-warning-text)]" role="alert" data-testid="reader-page-failed">
    This project's outputs could not be read, so the document cannot be shown. ({view.message})
  </p>
{:else if !found}
  <p class="p-6 text-sm text-[var(--color-text-muted)]" data-testid="reader-page-missing">
    This document is not among this project's outputs{finished ? ' (a finished project lists published documents only)' : ''}.
  </p>
{:else}
  {#key found.version.artifact_id}
    <DocumentReader
      {projectId}
      doc={found.doc}
      version={found.version}
      {phaseLabel}
      {finished}
      onReviewed={() => void load(projectId)}
    />
  {/key}
{/if}
