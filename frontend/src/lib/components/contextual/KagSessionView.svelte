<!--
  KagSessionView — shared embed for a single KAG scrape session.
  Used by:
    - the right-pane (rightPane store kind: 'kag-session')
    - /tools/kag/+page.svelte expanded-row detail
    - the KAG product hub Web-sources tab (KagIngestionTab)

  Renders the session metadata as fields plus the SCRAPED VISUAL EVIDENCE:
  the page screenshot and any captured/extracted images. This is the
  "follow provenance to the exact page that was scraped" trust surface —
  the image bytes are fetched through authFetch (Bearer) and rendered as
  object URLs, since the binary routes are Authorization-header gated and a
  raw <img src> (cookie-only) would 401. A collapsible raw-JSON panel is
  kept so nothing that was here before is lost.
-->
<script lang="ts" module>
  import { KagImageError } from '$lib/api/kag';

  /**
   * What the screenshot section may claim. Three states, not two.
   *
   * ## The defect
   *
   * `catch { screenshotUrl = null }` with the comment "No screenshot for this
   * session is the common case — stay silent" collapsed two different facts:
   * the capture does not exist, and the capture could not be READ. The section
   * is gated on `screenshotUrl`, so both rendered as no section at all — no
   * heading, no marker, nothing. On a surface whose stated purpose is "follow
   * provenance to the exact page that was scraped", that is the strongest
   * possible claim (the evidence isn't there) made from the weakest possible
   * information (we never got an answer).
   *
   * The original intent is kept: a genuinely absent screenshot stays silent,
   * because it IS the common case and it is not a failure. Only 404 earns that
   * silence — the byte route proxies the upstream status verbatim — and every
   * other status, plus a thrown fetch (which never becomes a `KagImageError`
   * at all), gets its own pixels.
   */
  export type ScreenshotState = 'shown' | 'absent' | 'unreadable';

  export function screenshotState(
    url: string | null,
    unreadable: string | null,
  ): ScreenshotState {
    if (url !== null) return 'shown';
    return unreadable !== null ? 'unreadable' : 'absent';
  }

  /**
   * Classify a screenshot-fetch rejection. Returns null when the capture is
   * genuinely absent (404), otherwise the reason it was unreadable.
   *
   * ⚠️ A non-`KagImageError` throw is UNREADABLE, not absent. That is the whole
   * point: a `TypeError: Failed to fetch` never reached the server, so it has
   * said nothing whatsoever about whether a screenshot exists.
   */
  export function screenshotFailureReason(err: unknown): string | null {
    if (err instanceof KagImageError) {
      if (err.status === 404) return null;
      return err.message.trim() || `HTTP ${err.status}`;
    }
    const raw = err instanceof Error ? err.message : String(err ?? '');
    return raw.trim() || 'screenshot read failed';
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { kagApi, type KagImageAsset } from '$lib/api/kag';
  import { Pill } from '$lib/components/ui';

  type Props = { id: string };
  let { id }: Props = $props();

  // Cap how many image bytes we eagerly fetch, so a huge crawl can't spawn
  // hundreds of concurrent blob requests. Anything beyond is reported.
  const MAX_IMAGES = 60;

  let rawDetail = $state<unknown>(null);
  let session = $state<Record<string, unknown> | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let screenshotUrl = $state<string | null>(null);
  // null ⇒ either the screenshot loaded or it is genuinely absent (404). A
  // reason ⇒ we could not ask; see `screenshotState`.
  let screenshotUnreadable = $state<string | null>(null);
  let imageAssets = $state<KagImageAsset[]>([]);
  let imageUrls = $state<Record<string, string>>({});
  let imagesError = $state<string | null>(null);
  let truncated = $state(0);

  // Object URLs we minted and must revoke on teardown to avoid leaking blobs.
  const objectUrls: string[] = [];
  let destroyed = false;

  // The screenshot/image fetches outlive teardown: ContextualPane now remounts
  // this view per (kind, id), so switching sessions destroys us with blob
  // requests still in flight. A URL minted after `onDestroy` would be pushed
  // onto an array nobody reads again — revoke it on arrival instead. Returns
  // false when the URL was thrown away, so the caller does not render it.
  function track(url: string): boolean {
    if (destroyed) {
      URL.revokeObjectURL(url);
      return false;
    }
    objectUrls.push(url);
    return true;
  }

  type Field = { label: string; value: string };

  function str(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.length ? v : null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  }

  const fields = $derived.by<Field[]>(() => {
    const s = session;
    if (!s) return [];
    const out: Field[] = [];
    const push = (label: string, keys: string[]) => {
      for (const k of keys) {
        const v = str(s[k]);
        if (v !== null) {
          out.push({ label, value: v });
          return;
        }
      }
    };
    push('Source', ['base_url', 'url', 'source_url']);
    push('Type', ['session_type', 'type']);
    push('Pages scraped', ['pages_scraped']);
    push('Pages failed', ['pages_failed']);
    push('Pages queued', ['pages_queued']);
    push('Max pages', ['max_pages']);
    push('Max depth', ['max_depth']);
    push('Created', ['created_at']);
    push('Started', ['started_at']);
    push('Completed', ['completed_at']);
    return out;
  });

  const shotState = $derived(screenshotState(screenshotUrl, screenshotUnreadable));

  const statusText = $derived(str(session?.['status']) ?? 'unknown');
  const statusTone = $derived.by<'neutral' | 'success' | 'warning' | 'danger'>(() => {
    const s = statusText.toLowerCase();
    if (s === 'completed') return 'success';
    if (s === 'failed' || s === 'error') return 'danger';
    if (s === 'cancelled' || s === 'canceled' || s === 'paused') return 'warning';
    return 'neutral';
  });

  function shortHash(h: unknown): string | null {
    return typeof h === 'string' && h.length > 10 ? `${h.slice(0, 10)}…` : str(h);
  }

  async function loadScreenshot() {
    try {
      const url = await kagApi.imageObjectUrl(kagApi.sessionScreenshotPath(id));
      if (!track(url)) return;
      screenshotUrl = url;
      screenshotUnreadable = null;
    } catch (err) {
      // A 404 IS "no screenshot for this session" — the common case, and still
      // silent. Anything else is a read we could not complete, and this surface
      // must not present that as absent evidence.
      screenshotUrl = null;
      screenshotUnreadable = screenshotFailureReason(err);
    }
  }

  async function loadImages() {
    let manifest;
    try {
      manifest = await kagApi.sessionImages(id);
    } catch (err) {
      imagesError = err instanceof Error ? err.message : String(err);
      return;
    }
    const all = manifest.images ?? [];
    truncated = Math.max(0, all.length - MAX_IMAGES);
    imageAssets = all.slice(0, MAX_IMAGES);
    await Promise.all(
      imageAssets.map(async (asset) => {
        try {
          const url = await kagApi.imageObjectUrl(
            kagApi.sessionImagePath(id, asset.image_id),
          );
          if (!track(url)) return;
          imageUrls = { ...imageUrls, [asset.image_id]: url };
        } catch {
          // Leave this one without a URL → renders a caption-only placeholder.
        }
      }),
    );
  }

  async function load() {
    loading = true;
    try {
      const d = await kagApi.getSession(id);
      rawDetail = d;
      const rec = d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
      const nested =
        rec && rec.session && typeof rec.session === 'object'
          ? (rec.session as Record<string, unknown>)
          : rec;
      session = nested;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
    // Images load independently of session-detail success.
    void loadScreenshot();
    void loadImages();
  }

  onMount(load);
  onDestroy(() => {
    destroyed = true;
    for (const u of objectUrls) URL.revokeObjectURL(u);
  });
</script>

<div class="flex flex-col gap-4 p-4" data-testid="kag-session-view">
  <header class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold text-[var(--color-text)]">KAG session</h2>
      <Pill tone={statusTone}>{statusText}</Pill>
    </div>
    <code class="truncate text-xs text-[var(--color-text-muted)]" title={id}>{id}</code>
  </header>

  {#if error}
    <div data-testid="kag-session-error"><Pill tone="warning">load failed: {error}</Pill></div>
  {:else if loading}
    <div class="text-xs italic text-[var(--color-text-muted)]">Loading…</div>
  {:else if session}
    <!-- Metadata fields -->
    {#if fields.length}
      <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        {#each fields as f (f.label)}
          <div class="flex flex-col gap-0.5">
            <dt class="text-[var(--color-text-muted)]">{f.label}</dt>
            <dd class="break-words text-[var(--color-text)]" title={f.value}>{f.value}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    <!-- Screenshot -->
    {#if shotState === 'unreadable'}
      <section class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold text-[var(--color-text)]">Page screenshot</h3>
        <p
          class="text-xs text-[var(--color-warning-text)]"
          data-testid="kag-session-screenshot-unreadable"
          role="alert"
        >
          The page screenshot could not be read, so this session is NOT known to
          be without one — the provenance evidence is missing because the read
          failed. Retry.
          <span class="font-mono text-[var(--color-text-muted)]">({screenshotUnreadable})</span>
        </p>
      </section>
    {:else if shotState === 'shown'}
      <section class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold text-[var(--color-text)]">Page screenshot</h3>
        <a href={screenshotUrl} target="_blank" rel="noopener noreferrer" class="block">
          <img
            src={screenshotUrl}
            alt="Scraped page screenshot"
            data-testid="kag-session-screenshot"
            class="max-h-96 w-full rounded border border-[var(--color-border)] object-contain"
            loading="lazy"
          />
        </a>
      </section>
    {/if}

    <!-- Captured images -->
    <section class="flex flex-col gap-2">
      <h3 class="text-xs font-semibold text-[var(--color-text)]">
        Captured images{imageAssets.length ? ` (${imageAssets.length})` : ''}
      </h3>
      {#if imagesError}
        <Pill tone="warning">images unavailable: {imagesError}</Pill>
      {:else if imageAssets.length === 0}
        <div
          data-testid="kag-session-images-empty"
          class="text-xs italic text-[var(--color-text-muted)]"
        >
          No captured images for this session.
        </div>
      {:else}
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {#each imageAssets as asset (asset.image_id)}
            <figure
              class="flex flex-col gap-1 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]"
            >
              {#if imageUrls[asset.image_id]}
                <a
                  href={imageUrls[asset.image_id]}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="block"
                >
                  <img
                    src={imageUrls[asset.image_id]}
                    alt={asset.alt_text ?? asset.caption ?? asset.title ?? 'Scraped image'}
                    data-testid="kag-session-image"
                    class="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </a>
              {:else}
                <div
                  class="flex aspect-square w-full items-center justify-center text-[10px] text-[var(--color-text-muted)]"
                >
                  unavailable
                </div>
              {/if}
              <figcaption class="flex flex-col gap-0.5 px-1.5 pb-1.5 text-[10px] text-[var(--color-text-muted)]">
                {#if asset.title ?? asset.caption}
                  <span class="truncate text-[var(--color-text)]" title={asset.title ?? asset.caption ?? ''}>
                    {asset.title ?? asset.caption}
                  </span>
                {/if}
                {#if asset.source_ref}
                  <span class="truncate" title={asset.source_ref}>{asset.source_ref}</span>
                {/if}
                <span class="flex flex-wrap gap-x-2">
                  {#if asset.width && asset.height}<span>{asset.width}×{asset.height}</span>{/if}
                  {#if shortHash(asset.sha256)}<span class="font-mono">{shortHash(asset.sha256)}</span>{/if}
                </span>
              </figcaption>
            </figure>
          {/each}
        </div>
        {#if truncated > 0}
          <div class="text-[10px] italic text-[var(--color-text-muted)]">
            +{truncated} more image{truncated === 1 ? '' : 's'} not shown.
          </div>
        {/if}
      {/if}
    </section>

    <!-- Raw JSON (power users) -->
    <details class="text-xs">
      <summary class="cursor-pointer text-[var(--color-text-muted)]">Raw session JSON</summary>
      <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(rawDetail, null, 2)}</pre>
    </details>
  {:else}
    <div class="text-xs italic text-[var(--color-text-muted)]">No session detail.</div>
  {/if}
</div>
