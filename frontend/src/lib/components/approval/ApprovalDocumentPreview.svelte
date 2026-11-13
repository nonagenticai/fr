<script lang="ts">
  // Approval-time document preview. For a KAG document-upload approval (a
  // worker-initiated ingest that parked for review), let the approver actually
  // SEE the pending file before approving. The bytes are fetched as a Blob from
  // /api/approvals/:id/document (a Bearer header can't ride an <iframe src>, so
  // we fetch here and render via an object URL) and rendered by MIME:
  //   - application/pdf → sandboxed <iframe> (browser-native PDF viewer)
  //   - image/*         → <img>
  //   - text/json/csv/markdown → decoded text in a <pre> (never rendered as HTML)
  //   - anything else   → filename + size + Download fallback
  // The empty sandbox="" mirrors ImagePreview.svelte: no scripts, no same-origin.
  import { onMount, onDestroy } from 'svelte';
  import { apiClient } from '$lib/api/unified-client';
  import { pickPreviewKey, fmtSize } from '$lib/components/artifacts/preview-loader';

  interface Props {
    approvalId: string;
    document: { filename: string; content_type: string; byte_size: number };
  }
  const { approvalId, document }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let textBody = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const mime = $derived(document.content_type.split(';')[0]!.trim().toLowerCase());
  const isPdf = $derived(mime === 'application/pdf');
  const isImage = $derived(mime.startsWith('image/'));
  // json / csv / markdown / html / plain / xml all map to a text family — we show
  // the decoded text, we do NOT execute it (html-as-text, no XSS surface).
  const isText = $derived(!isPdf && !isImage && pickPreviewKey(mime) !== null && !mime.startsWith('image/'));

  onMount(async () => {
    try {
      const blob = await apiClient.approvals.getDocumentBlob(approvalId);
      blobUrl = URL.createObjectURL(blob);
      if (isText) textBody = await blob.text();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load document';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });
</script>

<div data-testid="approval-document-preview">
  <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-muted)]">
    <span class="font-semibold text-[var(--color-text)]">{document.filename}</span>
    <span>{fmtSize(document.byte_size)}</span>
    <span>{mime}</span>
    {#if blobUrl}
      <a
        href={blobUrl}
        download={document.filename}
        class="ml-auto font-semibold text-[var(--color-accent-strong)] hover:underline"
      >
        Download
      </a>
    {/if}
  </div>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="approval-document-loading">
      Loading document…
    </p>
  {:else if error}
    <p class="text-sm text-[var(--color-danger)]" data-testid="approval-document-error">
      Could not load the document: {error}
    </p>
  {:else if blobUrl}
    {#if isPdf}
      <!--
        sandbox="" deliberately empty: no scripts, no same-origin, no forms, no
        top navigation. The browser's built-in PDF viewer still renders.
      -->
      <iframe
        title="Document preview (sandboxed)"
        sandbox=""
        src={blobUrl}
        class="h-[65vh] w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)]"
        data-testid="approval-document-pdf"
      ></iframe>
    {:else if isImage}
      <img
        src={blobUrl}
        alt="Pending document preview"
        class="max-h-[65vh] max-w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] object-contain"
        data-testid="approval-document-image"
      />
    {:else if isText && textBody !== null}
      <pre
        class="max-h-[65vh] overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text)]"
        data-testid="approval-document-text">{textBody}</pre>
    {:else}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="approval-document-fallback">
        No inline preview for this file type. Use Download to review it.
      </p>
    {/if}
  {/if}
</div>
