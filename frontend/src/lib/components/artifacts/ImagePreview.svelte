<script lang="ts">
  // Image preview. Raster MIMEs are rendered with a plain <img>. SVG is
  // ALWAYS rendered inside an <iframe sandbox=""> with NO `allow-scripts`
  // and NO `allow-same-origin`, per spec §10. Untrusted SVGs may contain
  // <script> tags, foreignObject HTML, or external references — the
  // sandboxed iframe blocks all of that.

  interface Props {
    body: string; // base64-encoded bytes from the preview endpoint
    mime: string;
    truncated?: boolean;
  }

  const { body, mime, truncated = false }: Props = $props();

  const isSvg = $derived(mime === 'image/svg+xml');

  // Build a data: URL. The backend returns bytes base64-encoded for binary MIMEs;
  // for SVG it may return either base64 or raw text. Treat both safely.
  const dataUrl = $derived.by(() => {
    if (isSvg) {
      // Re-encode as base64 if we got raw text; either way the iframe sandbox
      // strips script / same-origin so we are not relying on encoding for safety.
      const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(body) && body.length % 4 === 0;
      const b64 = looksBase64 ? body.replace(/\s+/g, '') : btoa(unescape(encodeURIComponent(body)));
      return `data:image/svg+xml;base64,${b64}`;
    }
    return `data:${mime};base64,${body}`;
  });
</script>

<div class="image-preview" data-testid="image-preview">
  {#if truncated}
    <div class="text-xs text-[var(--color-warning)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] px-2 py-1 rounded mb-2 dark:text-[var(--color-warning-text)] dark:bg-[var(--color-warning-bg)]/20">
      Preview truncated at 1 MiB. Download for the full image.
    </div>
  {/if}
  {#if isSvg}
    <!--
      sandbox="" deliberately empty: blocks scripts, blocks same-origin,
      blocks form submission, blocks top navigation. Do NOT add tokens.
    -->
    <iframe
      title="SVG preview (sandboxed)"
      sandbox=""
      src={dataUrl}
      class="w-full h-[60vh] border border-[var(--color-border)] rounded bg-[var(--color-bg)] dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]"
      data-testid="svg-sandbox"
    ></iframe>
  {:else}
    <img
      src={dataUrl}
      alt="Artifact preview"
      class="max-w-full max-h-[60vh] object-contain border border-[var(--color-border)] rounded bg-[var(--color-bg)] dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]"
      data-testid="raster-image"
    />
  {/if}
</div>
