<script lang="ts">
  import DOMPurify from 'dompurify';
  import { browser } from '$app/env';

  // The backend preview endpoint returns the RAW decoded artifact bytes — it
  // does NOT sanitize. So for html-shaped bodies we sanitize client-side with
  // DOMPurify before rendering as HTML; everything else renders as escaped text
  // inside a <pre> (Svelte's `{...}` interpolation HTML-escapes for us). A prior
  // version trusted the backend to strip unsafe nodes — it never did, which made
  // the `{@html}` branch a stored-XSS sink.

  interface Props {
    body: string;
    mime: string;
    truncated?: boolean;
  }

  const { body, mime, truncated = false }: Props = $props();

  // Render rich HTML only when the upstream MIME is html-shaped AND we are in the
  // browser (DOMPurify needs a DOM — during SSR it would pass content through
  // unsanitized, so we fall back to the escaped <pre> until hydration).
  const isHtml = $derived(mime.includes('html'));
  const safeHtml = $derived(isHtml && browser ? DOMPurify.sanitize(body) : '');
</script>

<div class="markdown-preview" data-testid="markdown-preview">
  {#if truncated}
    <div class="text-xs text-[var(--color-warning)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] px-2 py-1 rounded mb-2 dark:text-[var(--color-warning-text)] dark:bg-[var(--color-warning-bg)]/20">
      Preview truncated at 1 MiB. Download the file for the full content.
    </div>
  {/if}
  {#if isHtml && browser}
    <!-- DOMPurify-sanitized client-side; backend does not sanitize. -->
    <div class="prose prose-sm max-w-none">{@html safeHtml}</div>
  {:else}
    <pre class="text-xs whitespace-pre-wrap font-mono bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3 dark:bg-[var(--color-bg)] dark:border-[var(--color-border)]">{body}</pre>
  {/if}
</div>
