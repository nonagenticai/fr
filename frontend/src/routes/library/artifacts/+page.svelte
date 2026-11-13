<script lang="ts">
  import CockpitBackLink from '$lib/components/library/CockpitBackLink.svelte';
  import { onMount } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import { assetFetch, AssetError } from '$lib/api/assets';
  import { toast } from '$lib/stores/toast.svelte';
  import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';

  /**
   * Download is a TWO-STEP flow and was only ever wired for step two.
   *
   * `GET /api/assets/artifacts/:id/download` authenticates by a single-use
   * `?t=` token, NOT by a bearer — so the plain `<a href>` this replaces sent
   * no token and no Authorization, and answered 401 DOWNLOAD_TOKEN_INVALID
   * ("Missing token query parameter") every time. The button never worked.
   *
   * Minting first also fixes the tenant: the mint route runs under a real
   * request context, so it captures the ambient tenant into the token, which
   * the token-authenticated resolve route has no other way to know.
   */
  /**
   * ⛔ NEVER NAVIGATE TO THE TOKEN URL (FR-5). This used to end with
   * `window.location.href = url`: on success the attachment downloaded, but a
   * failed resolve (expired/consumed token, missing object, upstream 5xx)
   * replaced the whole tab with a raw JSON error document. The resolve is now
   * FETCHED: a non-2xx becomes an inline, per-row error under the button; a
   * 2xx is handed to the browser as a blob download. The token route
   * authenticates by its `?t=`, so this is a plain `fetch`, not `authFetch`.
   */
  let downloadErrorById = $state<Record<string, string>>({});
  let downloadingById = $state<Record<string, boolean>>({});

  function downloadFailureText(status: number): string {
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      return 'The download link expired or the file is no longer available. Try again.';
    }
    return 'The download failed. Try again in a moment.';
  }

  async function downloadArtifact(artifactId: string, projectId: string, filename: string): Promise<void> {
    downloadErrorById = { ...downloadErrorById, [artifactId]: '' };
    downloadingById = { ...downloadingById, [artifactId]: true };
    try {
      const r = await authFetch(
        `/api/assets/artifacts/${encodeURIComponent(artifactId)}/download-token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project_id: projectId }),
        },
      );
      if (!r.ok) {
        downloadErrorById = { ...downloadErrorById, [artifactId]: downloadFailureText(r.status) };
        return;
      }
      const body = (await r.json()) as { data?: { url?: string } };
      const url = body.data?.url;
      if (!url) {
        downloadErrorById = { ...downloadErrorById, [artifactId]: downloadFailureText(0) };
        return;
      }
      const file = await fetch(url);
      if (!file.ok) {
        downloadErrorById = { ...downloadErrorById, [artifactId]: downloadFailureText(file.status) };
        return;
      }
      const blob = await file.blob();
      const href = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = href;
        a.download = filename || 'artifact';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(href);
      }
    } catch {
      downloadErrorById = { ...downloadErrorById, [artifactId]: downloadFailureText(0) };
    } finally {
      downloadingById = { ...downloadingById, [artifactId]: false };
    }
  }

  type ArtifactStatus = 'pending' | 'approved' | 'rejected' | 'needs_revision';
  type ReviewDecision = 'approve' | 'reject' | 'revise';

  interface ArtifactRow {
    id: string;
    version: string;
    filename: string;
    content_type: string;
    kind: string;
    project_id: string;
    created_at: string;
    size: number;
    status?: ArtifactStatus;
    review_callback_url?: string | null;
  }

  interface ReviewOut {
    id: string;
    artifact_id: string;
    decision: ReviewDecision;
    comment: string | null;
    reviewer_id: string;
    reviewer_tenant_id: string;
    reviewed_at: string;
  }

  interface ReviewResponse {
    artifact: ArtifactRow;
    review: ReviewOut;
  }

  let items = $state<ArtifactRow[] | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Offset paging — the endpoint returns `next_offset` when more results
  // exist. Without consuming it the list silently capped at the first page,
  // hiding artifacts from any tenant with more than `PAGE_SIZE` of them.
  const PAGE_SIZE = 50;
  let nextOffset = $state<number | null>(null);
  let loadingMore = $state(false);

  // Per-row expansion + review state. Keyed by artifact id so multiple rows
  // can be open at once without their state cross-contaminating.
  let expanded = $state<Set<string>>(new Set());
  let reviewsById = $state<Record<string, ReviewOut[]>>({});
  let reviewsLoadingById = $state<Record<string, boolean>>({});
  let reviewsErrorById = $state<Record<string, string>>({});
  let commentById = $state<Record<string, string>>({});
  let submittingById = $state<Record<string, boolean>>({});
  let submitErrorById = $state<Record<string, string>>({});

  async function fetchPage(offset: number): Promise<{ rows: ArtifactRow[]; next: number | null }> {
    const res = await authFetch(
      `/api/me/projects/artifacts?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    return { rows: (body.items ?? []) as ArtifactRow[], next: body.next_offset ?? null };
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const { rows, next } = await fetchPage(0);
      items = rows;
      nextOffset = next;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load artifacts';
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (nextOffset === null || loadingMore) return;
    loadingMore = true;
    try {
      const { rows, next } = await fetchPage(nextOffset);
      items = [...(items ?? []), ...rows];
      nextOffset = next;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load more artifacts';
    } finally {
      loadingMore = false;
    }
  }

  // ── Deep link ──────────────────────────────────────────────────────────────
  //
  // Two project pages link here as `/library/artifacts#artifact-<id>`. The
  // fragment now matches a real `<li id=…>`, but this list is PAGED (50 per
  // request, `next_offset`) and takes no filter, so a linked artifact can
  // legitimately not be among the rows loaded yet.
  //
  // ⛔ Silently landing at the top in that case is the original defect wearing
  // a different hat: the reader followed a link to a specific artifact and is
  // shown an unfiltered list with no indication the target is missing. So the
  // absence is stated, and it CLEARS as soon as a later page contains the row —
  // `$derived` over `items`, not a snapshot taken on mount.
  let deepLinkId = $state<string | null>(null);

  const deepLinkMissing = $derived.by(() => {
    if (deepLinkId === null || items === null) return false;
    return !items.some((i) => i.id === deepLinkId);
  });

  function readHash(): void {
    const raw = typeof window === 'undefined' ? '' : window.location.hash;
    const m = /^#artifact-(.+)$/.exec(raw);
    deepLinkId = m ? decodeURIComponent(m[1]!) : null;
  }

  onMount(() => {
    readHash();
    window.addEventListener('hashchange', readHash);
    void load();
    return () => window.removeEventListener('hashchange', readHash);
  });

  // Scroll the linked row into view once it renders. The browser's own
  // fragment jump happens before the fetch resolves, so it finds nothing;
  // this is the same jump, retried when the row actually exists.
  $effect(() => {
    if (deepLinkId === null || items === null || deepLinkMissing) return;
    const el = document.getElementById(`artifact-${deepLinkId}`);
    el?.scrollIntoView({ block: 'center' });
  });

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusLabel(s: ArtifactStatus | undefined): string {
    switch (s) {
      case 'approved':
        return 'Approved';
      case 'rejected':
        return 'Rejected';
      case 'needs_revision':
        return 'Needs revision';
      case 'pending':
      default:
        return 'Pending';
    }
  }

  function statusClass(s: ArtifactStatus | undefined): string {
    const base =
      'inline-block text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap';
    switch (s) {
      case 'approved':
        return `${base} bg-[var(--color-success-bg)] text-[var(--color-success-text)]`;
      case 'rejected':
        return `${base} bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]`;
      case 'needs_revision':
        return `${base} bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]`;
      case 'pending':
      default:
        return `${base} bg-[var(--color-surface-strong)] text-[var(--color-text)]`;
    }
  }

  async function toggle(item: ArtifactRow) {
    if (expanded.has(item.id)) {
      expanded.delete(item.id);
      expanded = new Set(expanded);
      return;
    }
    expanded.add(item.id);
    expanded = new Set(expanded);
    if (!reviewsById[item.id]) {
      await loadReviews(item);
    }
  }

  async function loadReviews(item: ArtifactRow) {
    reviewsLoadingById = { ...reviewsLoadingById, [item.id]: true };
    reviewsErrorById = { ...reviewsErrorById, [item.id]: '' };
    try {
      const got = await assetFetch<ReviewOut[]>(
        `/api/assets/artifacts/${encodeURIComponent(item.id)}/reviews?project_id=${encodeURIComponent(item.project_id)}`,
      );
      reviewsById = { ...reviewsById, [item.id]: got ?? [] };
    } catch (e) {
      const msg =
        e instanceof AssetError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      reviewsErrorById = { ...reviewsErrorById, [item.id]: msg };
    } finally {
      reviewsLoadingById = { ...reviewsLoadingById, [item.id]: false };
    }
  }

  async function submitReview(item: ArtifactRow, decision: ReviewDecision) {
    submittingById = { ...submittingById, [item.id]: true };
    submitErrorById = { ...submitErrorById, [item.id]: '' };
    try {
      const comment = (commentById[item.id] ?? '').trim();
      const body: { decision: ReviewDecision; comment?: string } = { decision };
      if (comment.length > 0) body.comment = comment;
      const res = await assetFetch<ReviewResponse>(
        `/api/assets/artifacts/${encodeURIComponent(item.id)}/review?project_id=${encodeURIComponent(item.project_id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      // Reflect the new status in-place and prepend the new review row.
      if (items) {
        const idx = items.findIndex((a) => a.id === item.id);
        if (idx >= 0) {
          items[idx] = { ...items[idx], status: res.artifact.status };
          items = items;
        }
      }
      reviewsById = {
        ...reviewsById,
        [item.id]: [...(reviewsById[item.id] ?? []), res.review],
      };
      commentById = { ...commentById, [item.id]: '' };
      toast.show(`Marked ${statusLabel(res.artifact.status).toLowerCase()}.`, 'success');
    } catch (e) {
      const msg =
        e instanceof AssetError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      submitErrorById = { ...submitErrorById, [item.id]: msg };
    } finally {
      submittingById = { ...submittingById, [item.id]: false };
    }
  }
</script>

<section class="p-6 max-w-4xl mx-auto">
  <header class="mb-6">
    <nav aria-label="Breadcrumb" class="text-sm text-[var(--color-text-muted)] mb-1">
      Knowledge / Artifacts
    </nav>
    <CockpitBackLink />
    <h1 class="text-2xl font-semibold">Artifacts</h1>
    <p class="text-sm text-[var(--color-text-muted)] mt-1 max-w-2xl">
      Files produced by agent runs, kanban cards, and reports across your
      projects. Expand a row to review and approve, request revision, or reject
      — the producing workflow receives your decision when it set a callback.
    </p>
  </header>

  {#if loading}
    <div data-testid="artifacts-loading" role="status" aria-label="Loading artifacts">
      <Skeleton variant="text" count={6} height="2.25rem" />
    </div>
  {:else if error}
    <div data-testid="artifacts-error">
      <ErrorState {error} title="Couldn't load artifacts" onRetry={load} />
    </div>
  {:else if !items || items.length === 0}
    <div data-testid="artifacts-empty">
      <EmptyState
        title="No artifacts yet"
        body="Artifacts appear here as agent runs, kanban cards, and reports produce them in your projects."
      />
    </div>
  {:else}
    {#if deepLinkMissing}
      <!--
        A link arrived naming an artifact that is not among the rows loaded so
        far. Saying nothing would drop the reader at the top of an unfiltered
        tenant list with no sign their target is absent — which is what this
        page did for every deep link before the row ids existed.
      -->
      <div
        class="mb-3 rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
        data-testid="artifact-deep-link-missing"
      >
        The linked artifact <code class="font-mono text-xs">{deepLinkId}</code> is not on
        the page loaded so far. This list is tenant-wide and paged ({PAGE_SIZE} at a
        time) with no per-project filter, so load more to reach it.
        {#if nextOffset === null}
          Every page has been loaded, so it is not in this workspace's artifacts.
        {/if}
      </div>
    {/if}
    <ul class="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]" data-testid="artifacts-list">
      {#each items as item (item.id)}
        {@const isOpen = expanded.has(item.id)}
        {@const rowReviews = reviewsById[item.id] ?? []}
        {@const rowLoading = reviewsLoadingById[item.id] === true}
        {@const rowReviewsErr = reviewsErrorById[item.id] ?? ''}
        {@const comment = commentById[item.id] ?? ''}
        {@const submitting = submittingById[item.id] === true}
        {@const submitErr = submitErrorById[item.id] ?? ''}
        <!--
          `id` is the DEEP-LINK TARGET. `/projects/[id]/artifacts` (and its
          308 alias `/projects/[id]/library/artifacts`) builds
          `/library/artifacts#artifact-<id>`, and until this attribute existed
          the fragment matched NOTHING on this page — the nearest ids were the
          per-row `comment-<id>` textarea and a `data-testid`, neither of which
          a fragment can address. Every one of those links landed silently at
          the top of an unfiltered list. Renaming or removing this id breaks
          both callers with no error anywhere.
        -->
        <li class="py-3" id={`artifact-${item.id}`} data-testid="artifact-row">
          <div class="flex items-baseline justify-between gap-4">
            <div class="min-w-0 flex-1">
              <button
                type="button"
                class="font-medium hover:underline truncate text-left flex items-baseline gap-2"
                onclick={() => toggle(item)}
                data-testid="artifact-toggle"
                aria-expanded={isOpen}
              >
                <span aria-hidden="true" class="text-xs text-[var(--color-text-muted)]">{isOpen ? '▾' : '▸'}</span>
                <span class="truncate">{item.filename}</span>
                <span class={statusClass(item.status)}>{statusLabel(item.status)}</span>
              </button>
              <div class="text-xs text-[var(--color-text-muted)] mt-1 ml-4">
                <a href={`/projects/${item.project_id}`} class="hover:underline font-mono">
                  {item.project_id}
                </a>
                <span class="mx-1">·</span>
                <span>{item.kind}</span>
                <span class="mx-1">·</span>
                <span>{fmtSize(item.size)}</span>
              </div>
            </div>
            <time class="text-xs text-[var(--color-text-muted)] whitespace-nowrap" datetime={item.created_at}>
              {fmtDate(item.created_at)}
            </time>
          </div>

          {#if isOpen}
            <div class="mt-3 ml-6 p-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="artifact-review-panel">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-semibold">Review</h3>
                <button
                  type="button"
                  class="text-xs text-[var(--color-accent-strong)] underline disabled:opacity-50"
                  disabled={downloadingById[item.id] === true}
                  onclick={() => downloadArtifact(item.id, item.project_id, item.filename)}
                  data-testid="artifact-download"
                >
                  {downloadingById[item.id] === true ? 'Downloading…' : 'Download'}
                </button>
              </div>
              {#if downloadErrorById[item.id]}
                <p class="text-xs text-[var(--color-danger)] mb-2" role="alert" data-testid="artifact-download-error">
                  {downloadErrorById[item.id]}
                </p>
              {/if}

              <label for={`comment-${item.id}`} class="block text-xs font-semibold uppercase text-[var(--color-text-muted)] mb-1">Comment (optional)</label>
              <textarea
                id={`comment-${item.id}`}
                rows="2"
                maxlength="4000"
                bind:value={commentById[item.id]}
                placeholder="Optional reviewer comment (≤ 4000 chars)…"
                class="w-full text-sm border border-[var(--color-border-strong)] rounded px-2 py-1 mb-2"
              ></textarea>

              <div class="flex flex-wrap gap-2 mb-2" data-testid="review-actions">
                <button
                  type="button"
                  disabled={submitting}
                  onclick={() => submitReview(item, 'approve')}
                  class="px-3 py-1 text-sm rounded bg-[var(--color-success)] text-[var(--color-on-primary)] disabled:opacity-50"
                  data-testid="approve"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onclick={() => submitReview(item, 'revise')}
                  class="px-3 py-1 text-sm rounded bg-[var(--color-warning)] text-[var(--color-on-primary)] disabled:opacity-50"
                  data-testid="revise"
                >
                  Request revision
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onclick={() => submitReview(item, 'reject')}
                  class="px-3 py-1 text-sm rounded bg-[var(--color-danger)] text-[var(--color-on-primary)] disabled:opacity-50"
                  data-testid="reject"
                >
                  Reject
                </button>
                {#if submitting}
                  <span class="text-xs text-[var(--color-text-muted)] self-center">Submitting…</span>
                {/if}
              </div>

              {#if submitErr}
                <div class="text-xs text-[var(--color-danger-text)] bg-[var(--color-danger-bg)] rounded px-2 py-1 mb-2">{submitErr}</div>
              {/if}

              <h4 class="text-xs font-semibold uppercase text-[var(--color-text-muted)] mt-3 mb-1">History</h4>
              {#if rowLoading}
                <div class="text-xs text-[var(--color-text-muted)]">Loading history…</div>
              {:else if rowReviewsErr}
                <div class="text-xs text-[var(--color-danger-text)] bg-[var(--color-danger-bg)] rounded px-2 py-1">{rowReviewsErr}</div>
              {:else if rowReviews.length === 0}
                <div class="text-xs text-[var(--color-text-muted)]">No reviews yet.</div>
              {:else}
                <ul class="text-xs space-y-1" data-testid="review-history">
                  {#each rowReviews as r (r.id)}
                    <li class="flex flex-wrap items-baseline gap-2">
                      <span class={statusClass(
                        r.decision === 'approve'
                          ? 'approved'
                          : r.decision === 'reject'
                            ? 'rejected'
                            : 'needs_revision',
                      )}>
                        {r.decision}
                      </span>
                      <span class="text-[var(--color-text-muted)] font-mono">{r.reviewer_id}</span>
                      <time class="text-[var(--color-text-muted)]" datetime={r.reviewed_at}>{fmtDate(r.reviewed_at)}</time>
                      {#if r.comment}
                        <div class="basis-full text-[var(--color-text)] ml-1">“{r.comment}”</div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if nextOffset !== null}
      <div class="mt-4 flex justify-center">
        <button
          type="button"
          onclick={loadMore}
          disabled={loadingMore}
          data-testid="artifacts-load-more"
          class="px-4 py-2 text-sm rounded border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      </div>
    {/if}
  {/if}
</section>
