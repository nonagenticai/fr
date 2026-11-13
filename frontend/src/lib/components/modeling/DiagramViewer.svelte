<!--
  DiagramViewer — an ArchiMate view (`viewId`) or a UML diagram (`umlDiagramId`)
  as requirements_management drew it, for the current draft or as it was in a
  saved version (`modelId` + `revisionId`).

  ⛔ The SVG is UNTRUSTED markup from another service. It is NEVER inlined into
  this document: it is shown from a base64 data: URI (as
  components/artifacts/ImagePreview.svelte does) — but as an `<img>`, not an
  iframe. An SVG loaded as an image runs no script and fetches nothing external,
  by the browser's own rules, which is stricter than a sandboxed frame; and a
  sandboxed frame makes Chrome log a "Blocked script execution" console error on
  every draw even for a script-free SVG.

  Drawing notes (RM's render diagnostics: things it could not draw as stored)
  are listed under the picture. The PNG, SVG and PDF downloads go through fr's
  download routes (RM's bytes, relayed unchanged). A failure shows why and offers to try again.
-->
<script lang="ts">
  import { downloadDiagram, fileNameOf, getDiagram, saveFile, type DiagramFormat, type DiagramReport, type DiagramRef } from '$lib/api/modeling';
  import { diagnosticText, svgDataUri } from '$lib/modeling/explain';

  let {
    viewId,
    umlDiagramId,
    modelId,
    revisionId,
    title = 'Diagram',
  }: { viewId?: string; umlDiagramId?: string; modelId?: string; revisionId?: string; title?: string } = $props();

  const ref = $derived<DiagramRef>({
    ...(umlDiagramId ? { umlDiagramId } : { viewId: viewId ?? '' }),
    ...(modelId && revisionId ? { modelId, revisionId } : {}),
  });

  let report = $state<DiagramReport | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let downloading = $state<DiagramFormat | null>(null);
  let downloadError = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      report = await getDiagram(ref);
    } catch (e) {
      report = null;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const FORMATS: ReadonlyArray<{ format: DiagramFormat; label: string }> = [
    { format: 'png', label: 'Download as PNG' },
    { format: 'svg', label: 'Download SVG' },
    { format: 'pdf', label: 'Download PDF' },
  ];

  async function download(format: DiagramFormat): Promise<void> {
    downloading = format;
    downloadError = null;
    try {
      const blob = await downloadDiagram(ref, format);
      saveFile(blob, fileNameOf(title, `.${format}`));
    } catch (e) {
      downloadError = e instanceof Error ? e.message : String(e);
    } finally {
      downloading = null;
    }
  }

  $effect(() => {
    void ref.viewId;
    void ref.umlDiagramId;
    void ref.revisionId;
    load();
  });
</script>

<section class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="diagram-viewer">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-base font-semibold text-[var(--color-text)]">{title}</h2>
    <div class="flex flex-wrap items-center gap-2">
      {#each FORMATS as f (f.format)}
        <button
          type="button"
          class="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          onclick={() => download(f.format)}
          disabled={downloading !== null || loading || !!error}
          data-testid={`diagram-download-${f.format}`}
        >
          {downloading === f.format ? 'Preparing…' : f.label}
        </button>
      {/each}
    </div>
  </div>
  {#if downloadError}
    <p class="text-sm text-[var(--color-danger)]" data-testid="diagram-download-error">{downloadError}</p>
  {/if}
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="diagram-loading">Drawing the diagram…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="diagram-error">
      <p class="text-sm text-[var(--color-danger)]">The diagram could not be drawn: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if report}
    <!-- Never {@html}: RM's SVG reaches the page only as an image (no script, no external fetch). -->
    <div class="max-h-[70vh] overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <img src={svgDataUri(report.svg)} alt={`${title} (picture)`} class="max-w-none" data-testid="diagram-picture" />
    </div>
    {#if report.diagnostics.length > 0}
      <div class="rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3" data-testid="diagram-notes">
        <p class="text-sm font-medium text-[var(--color-warning-text)]">
          Some parts could not be drawn exactly as stored:
        </p>
        <ul class="mt-1 list-disc pl-5 text-sm text-[var(--color-warning-text)]">
          {#each report.diagnostics as d, i (i)}
            <li>{diagnosticText(d)}</li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</section>
