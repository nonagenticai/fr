<!--
  DocumentReader — one of the project's documents, read in the app (R3 / DOC-3,
  FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.1): kind · phase, title, status banner, version switcher
  (the card's other versions), Download PDF, the summary, a table of contents and the rendered
  sections.

  ⛔ The HTML comes from artifact_service through fr's tenant-checked proxy and is sanitised there —
  and AGAIN here (`sanitizeDocumentHtml`, DOMPurify) before {@html}. During SSR nothing is
  inserted (DOMPurify needs a DOM); the page shows "Reading…" until hydration.

  Review: when a review is open on the shown (newest) version and the project still runs, Approve /
  Request changes are offered inline through the EXISTING artifact review seam
  (POST /api/assets/artifacts/:id/review?project_id=…) — the same call and the same rights as the
  Needs-you queue's artifact review. No new decision path.
-->
<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { assetFetch, AssetError } from '$lib/api/assets';
  import { downloadDocumentPdf, fetchDocumentHtml } from '$lib/api/project-outputs';
  import { toast } from '$lib/stores/toast.svelte';
  import { shortTime } from '$lib/components/cockpit/spine';
  import { documentHref, reviewOpen, sanitizeDocumentHtml, statusBanner, statusLine, type SanitizedDocument } from '$lib/documents/reader';
  import type { TrailDocument, TrailVersion } from '$lib/types/outputs';

  let {
    projectId,
    doc,
    version,
    phaseLabel,
    finished,
    onReviewed,
  }: {
    projectId: string;
    doc: TrailDocument;
    version: TrailVersion;
    phaseLabel: string | null;
    finished: boolean;
    onReviewed?: () => void;
  } = $props();

  type Body = { kind: 'reading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; doc: SanitizedDocument };
  let body = $state<Body>({ kind: 'reading' });

  $effect(() => {
    const id = version.artifact_id;
    if (!browser) return;
    body = { kind: 'reading' };
    fetchDocumentHtml(projectId, id)
      .then((raw) => {
        if (id === version.artifact_id) body = { kind: 'loaded', doc: sanitizeDocumentHtml(raw) };
      })
      .catch((e: unknown) => {
        if (id === version.artifact_id) body = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
      });
  });

  const isHead = $derived(doc.versions[0]?.artifact_id === version.artifact_id);
  // Review actions only when a review is REALLY open on THIS version (its own review status), on the
  // newest version of a running project — the banner above says the same thing in words.
  const canReview = $derived(isHead && doc.reviewable && reviewOpen(version, finished));

  let pdfBusy = $state(false);
  async function downloadPdf(): Promise<void> {
    if (pdfBusy) return;
    pdfBusy = true;
    try {
      await downloadDocumentPdf(projectId, version.artifact_id, version.title);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The PDF could not be made.');
    } finally {
      pdfBusy = false;
    }
  }

  let comment = $state('');
  let asking = $state(false);
  let reviewBusy = $state(false);
  async function review(decision: 'approve' | 'revise'): Promise<void> {
    if (reviewBusy) return;
    const text = comment.trim();
    if (decision === 'revise' && !text) {
      asking = true;
      toast.error('Say what should change.');
      return;
    }
    reviewBusy = true;
    try {
      const payload: { decision: 'approve' | 'revise'; comment?: string } = { decision };
      if (text) payload.comment = text;
      await assetFetch(
        `/api/assets/artifacts/${encodeURIComponent(version.review_artifact_id)}/review?project_id=${encodeURIComponent(projectId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      );
      toast.success(decision === 'approve' ? 'Approved.' : 'Changes requested.');
      comment = '';
      asking = false;
      onReviewed?.();
    } catch (e) {
      toast.error(e instanceof AssetError || e instanceof Error ? e.message : String(e));
    } finally {
      reviewBusy = false;
    }
  }

  function versionLabel(v: TrailVersion): string {
    return [`Version ${v.number}`, statusLine(v, finished), shortTime(v.at) || null].filter(Boolean).join(' · ');
  }
</script>

<article class="mx-auto max-w-5xl space-y-4 p-6" data-testid="document-reader" data-artifact={version.artifact_id}>
  <header class="space-y-1">
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="reader-kind">
      {doc.type_label}{phaseLabel ? ` · ${phaseLabel}` : ''}{doc.card_name ? ` · ${doc.card_name}` : ''}
    </p>
    <h1 class="text-xl font-bold text-[var(--color-text)]" data-testid="reader-title">{version.title}</h1>
    <div class="flex flex-wrap items-center gap-2 pt-1">
      {#if doc.versions.length > 1}
        <label class="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          Version
          <select
            class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)]"
            data-testid="reader-version"
            value={version.artifact_id}
            onchange={(e) => goto(documentHref(projectId, (e.currentTarget as HTMLSelectElement).value))}
          >
            {#each doc.versions as v (v.artifact_id)}
              <option value={v.artifact_id}>{versionLabel(v)}</option>
            {/each}
          </select>
        </label>
      {:else}
        <span class="text-xs text-[var(--color-text-muted)]" data-testid="reader-version-single">{versionLabel(version)}</span>
      {/if}
      <button
        type="button"
        class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs font-semibold text-[var(--color-text)] hover:border-[var(--color-accent-border)] disabled:opacity-60"
        data-testid="reader-pdf"
        disabled={pdfBusy}
        onclick={downloadPdf}
      >
        {pdfBusy ? 'Making the PDF…' : 'Download PDF'}
      </button>
    </div>
  </header>

  <p
    class={`rounded-[var(--radius-sm)] border px-3 py-2 text-sm ${version.status === 'published' ? 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]' : 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'}`}
    role="status"
    data-testid="reader-banner"
    data-status={version.status ?? 'unknown'}
    data-review={version.review_status ?? 'none'}
  >
    {statusBanner(version, finished)}{!isHead ? ' A newer version exists.' : ''}
  </p>

  {#if canReview}
    <section class="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] p-3" data-testid="reader-review" aria-label="Review this document">
      <h2 class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Your review</h2>
      {#if asking}
        <textarea
          class="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text)]"
          rows="3"
          maxlength="4000"
          placeholder="What should change?"
          data-testid="reader-review-comment"
          bind:value={comment}
        ></textarea>
      {/if}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-60"
          data-testid="reader-approve"
          disabled={reviewBusy}
          onclick={() => review('approve')}>Approve</button
        >
        <button
          type="button"
          class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] disabled:opacity-60"
          data-testid="reader-request-changes"
          disabled={reviewBusy}
          onclick={() => (asking ? review('revise') : (asking = true))}>{asking ? 'Send the request' : 'Request changes…'}</button
        >
      </div>
    </section>
  {/if}

  {#if version.summary}
    <section aria-label="Summary" data-testid="reader-summary">
      <h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Summary</h2>
      <p class="text-sm text-[var(--color-text)]">{version.summary}</p>
    </section>
  {/if}

  {#if body.kind === 'reading'}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="reader-reading">Reading the document…</p>
  {:else if body.kind === 'failed'}
    <p class="text-sm text-[var(--color-warning-text)]" role="alert" data-testid="reader-failed">
      The document could not be shown. {body.message} You can still try Download PDF.
    </p>
  {:else}
    <div class="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      {#if body.doc.toc.length > 1}
        <nav class="md:sticky md:top-4 md:self-start" aria-label="Contents" data-testid="reader-toc">
          <h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Contents</h2>
          <ol class="space-y-0.5 text-xs">
            {#each body.doc.toc as t (t.id)}
              <li class={t.level === 3 ? 'pl-3' : ''}>
                <a class="text-[var(--color-link)] hover:underline" href={`#${t.id}`}>{t.text}</a>
              </li>
            {/each}
          </ol>
        </nav>
      {:else}
        <div class="hidden md:block"></div>
      {/if}
      <!-- DOMPurify-sanitised client-side (sanitizeDocumentHtml), after artifact_service's own pass. -->
      <div class="doc-body min-w-0 overflow-x-auto text-sm text-[var(--color-text)]" data-testid="reader-body">
        {@html body.doc.html}
      </div>
    </div>
  {/if}
</article>

<style>
  .doc-body :global(h2) {
    margin: 1.4em 0 0.4em;
    font-size: 1.1rem;
    font-weight: 700;
  }
  .doc-body :global(h3) {
    margin: 1.1em 0 0.3em;
    font-size: 1rem;
    font-weight: 600;
  }
  .doc-body :global(p),
  .doc-body :global(ul),
  .doc-body :global(ol),
  .doc-body :global(dl),
  .doc-body :global(table),
  .doc-body :global(pre),
  .doc-body :global(blockquote) {
    margin: 0 0 0.8em;
  }
  .doc-body :global(ul) {
    list-style: disc;
    padding-left: 1.4em;
  }
  .doc-body :global(ol) {
    list-style: decimal;
    padding-left: 1.4em;
  }
  .doc-body :global(dt) {
    font-weight: 600;
  }
  .doc-body :global(dd) {
    margin: 0 0 0.4em 1em;
  }
  .doc-body :global(a) {
    color: var(--color-link);
    text-decoration: underline;
  }
  .doc-body :global(code),
  .doc-body :global(pre) {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.9em;
  }
  .doc-body :global(pre) {
    overflow-x: auto;
    padding: 0.6em;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  .doc-body :global(table) {
    border-collapse: collapse;
  }
  .doc-body :global(th),
  .doc-body :global(td) {
    border: 1px solid var(--color-border);
    padding: 0.25em 0.5em;
    text-align: left;
    vertical-align: top;
  }
  .doc-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    padding-left: 0.8em;
    color: var(--color-text-muted);
  }
  .doc-body :global(section.footnotes) {
    border-top: 1px solid var(--color-border);
    margin-top: 1.6em;
    font-size: 0.85em;
  }
</style>
