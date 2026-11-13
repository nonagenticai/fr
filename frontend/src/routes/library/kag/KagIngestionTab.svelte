<!--
  KAG "Web sources" tab — scrape URL, scrape sitemap + recent sessions.

  Lifted from /tools/kag during the /tools dissolution (control-plane roadmap
  Phase 2). File upload lives on the Documents tab (the richer DocumentUploadPanel
  surface); this tab owns the web-scraping sources so the two are no longer
  redundant. Mounted as the page body of /library/kag/web-sources (nav standard
  2026-10-03 — formerly a keepAlive hub tab), so its 3s usePoll handles stop
  when you navigate away and restart on return; sessions live server-side.

  Spec: docs/superpowers/specs/completed/2026-04-24-kag-ingestion-ui.md
  Scrape is a human self-service action (autoApproveForInitiator), so a person
  running it here self-approves and gets a live session immediately — no
  approval step, on fr or kag. The pending-approval branch below is a fallback
  for the non-human-initiator path (an n8n/agent scrape still parks for review).
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    kagApi,
    isPending,
    type PendingAction,
    type ScrapeSession,
    type KagRefreshResult,
  } from '$lib/api/kag';
  import { apiClient } from '$lib/api/unified-client';
  import type { URLCredential } from '$lib/types/api';
  import KagSessionView from '$lib/components/contextual/KagSessionView.svelte';
  import KagPipelineJobs from '$lib/components/kag/KagPipelineJobs.svelte';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';
  import { usePoll, type PollHandle } from '$lib/net/poll';

  // Scrape URL state
  let scrapeUrlValue = $state('');
  let scrapeType = $state<'auto' | 'playwright' | 'scrapy'>('auto');
  let scrapeDelay = $state<number | null>(null);
  let scrapeTimeout = $state<number | null>(null);
  let scrapeCredentialId = $state<string>('');
  // Optional login page for form-auth scrapes (upstream AuthConfig.login_url).
  let scrapeLoginUrl = $state<string>('');
  // The user's saved URL credentials, for the picker (elevated from the old raw
  // credential_id text field). Resolved server-side by the webscraper service.
  let credentials = $state<URLCredential[]>([]);
  let credentialsError = $state('');
  let scrapeUrlStatus = $state('');
  let scrapeUrlError = $state('');
  let scrapeUrlPending = $state<PendingAction | null>(null);
  let scrapeUrlSessionId = $state<string | null>(null);

  // Sitemap state
  let sitemapUrl = $state('');
  let sitemapMaxUrls = $state<number | null>(20);
  let sitemapAllowedDomains = $state('');
  let sitemapStatus = $state('');
  let sitemapError = $state('');
  let sitemapPending = $state<PendingAction | null>(null);
  let sitemapSessionId = $state<string | null>(null);

  // Bulk-scrape form state (many URLs as one source; optional credential = login once)
  let bulkUrlsText = $state('');
  let bulkCredentialId = $state<string>('');
  let bulkLoginUrl = $state<string>('');
  let bulkStatus = $state('');
  let bulkError = $state('');
  let bulkPending = $state<PendingAction | null>(null);
  let bulkSessionId = $state<string | null>(null);

  // Sessions list state
  let sessions: ScrapeSession[] = $state([]);
  let sessionsLoading = $state(false);
  let sessionsError = $state('');
  // Per-session refresh-from-source state: which row is in flight, and a short
  // per-row result message ("Updated" / "No change" / an error).
  let refreshingId = $state('');
  let refreshMsg: Record<string, string> = $state({});
  let expandedSessionId = $state<string | null>(null);

  // Per-session/job poll handles — keyed so we can stop individually. Each
  // uses usePoll for single-flight + exponential-backoff + visibility-pause.
  const pollHandles = new Map<string, PollHandle>();

  function setPoll(key: string, fn: () => Promise<void>): void {
    clearPoll(key);
    const handle = usePoll(fn, { intervalMs: 3000 });
    pollHandles.set(key, handle);
    handle.start();
  }

  function clearPoll(key: string): void {
    const h = pollHandles.get(key);
    if (h) {
      h.stop();
      pollHandles.delete(key);
    }
  }

  function isTerminal(status: string | undefined): boolean {
    if (!status) return false;
    const s = status.toLowerCase();
    return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'canceled';
  }

  async function refreshSessions(): Promise<void> {
    sessionsLoading = true;
    sessionsError = '';
    try {
      const out = await kagApi.listSessions({ limit: 50 });
      // Upstream shape varies — try common keys.
      const arr =
        (out as { sessions?: ScrapeSession[] }).sessions ??
        (out as { data?: ScrapeSession[] }).data ??
        [];
      sessions = Array.isArray(arr) ? arr : [];
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : String(e);
    } finally {
      sessionsLoading = false;
    }
  }

  function expandSession(sessionId: string): void {
    expandedSessionId = expandedSessionId === sessionId ? null : sessionId;
  }

  async function submitScrapeUrl(e: Event): Promise<void> {
    e.preventDefault();
    if (!scrapeUrlValue) {
      scrapeUrlError = 'url required';
      return;
    }
    scrapeUrlError = '';
    scrapeUrlStatus = 'submitting…';
    scrapeUrlPending = null;
    scrapeUrlSessionId = null;
    try {
      const body: Parameters<typeof kagApi.scrapeUrl>[0] = {
        url: scrapeUrlValue,
        scraper_type: scrapeType,
      };
      if (scrapeDelay !== null) body.delay = scrapeDelay;
      if (scrapeTimeout !== null) body.timeout = scrapeTimeout;
      if (scrapeCredentialId) {
        body.auth_config = { credential_id: scrapeCredentialId };
        if (scrapeLoginUrl.trim()) body.auth_config.login_url = scrapeLoginUrl.trim();
      }
      const out = await kagApi.scrapeUrl(body);
      if (isPending(out)) {
        scrapeUrlPending = out;
        scrapeUrlStatus = 'pending approval';
      } else {
        const sid = (out as { session_id?: string } | null)?.session_id ?? null;
        scrapeUrlSessionId = sid;
        scrapeUrlStatus = sid ? `session ${sid}` : 'submitted';
        if (sid) startSessionPoll(sid, 'url');
      }
    } catch (err) {
      scrapeUrlError = err instanceof Error ? err.message : String(err);
      scrapeUrlStatus = '';
    }
  }

  async function submitSitemap(e: Event): Promise<void> {
    e.preventDefault();
    if (!sitemapUrl) {
      sitemapError = 'sitemap url required';
      return;
    }
    sitemapError = '';
    sitemapStatus = 'submitting…';
    sitemapPending = null;
    sitemapSessionId = null;
    try {
      const body: Parameters<typeof kagApi.scrapeSitemap>[0] = {
        sitemap_url: sitemapUrl,
        // KAG product: a sitemap scrape ingests every page into the graph, so the
        // source becomes searchable/refreshable — not just stored bytes.
        send_to_kag: true,
      };
      if (sitemapMaxUrls !== null) body.max_urls = sitemapMaxUrls;
      const allowed = sitemapAllowedDomains
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.length > 0) body.allowed_domains = allowed;
      const out = await kagApi.scrapeSitemap(body);
      if (isPending(out)) {
        sitemapPending = out;
        sitemapStatus = 'pending approval';
      } else {
        const sid = (out as { session_id?: string } | null)?.session_id ?? null;
        sitemapSessionId = sid;
        sitemapStatus = sid ? `session ${sid}` : 'submitted';
        if (sid) startSessionPoll(sid, 'sitemap');
      }
    } catch (err) {
      sitemapError = err instanceof Error ? err.message : String(err);
      sitemapStatus = '';
    }
  }

  async function submitBulk(e: Event): Promise<void> {
    e.preventDefault();
    const urls = bulkUrlsText
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      bulkError = 'at least one url required';
      return;
    }
    bulkError = '';
    bulkStatus = 'submitting…';
    bulkPending = null;
    bulkSessionId = null;
    try {
      const body: Parameters<typeof kagApi.scrapeBulk>[0] = {
        urls,
        // KAG product: ingest each page into the graph so the bulk source is
        // searchable/refreshable, not just stored bytes.
        send_to_kag: true,
      };
      if (bulkCredentialId) {
        body.auth_config = { credential_id: bulkCredentialId };
        if (bulkLoginUrl.trim()) body.auth_config.login_url = bulkLoginUrl.trim();
      }
      const out = await kagApi.scrapeBulk(body);
      if (isPending(out)) {
        bulkPending = out;
        bulkStatus = 'pending approval';
      } else {
        const sid = (out as { session_id?: string } | null)?.session_id ?? null;
        bulkSessionId = sid;
        bulkStatus = sid ? `session ${sid}` : 'submitted';
        if (sid) startSessionPoll(sid, 'bulk');
      }
    } catch (err) {
      bulkError = err instanceof Error ? err.message : String(err);
      bulkStatus = '';
    }
  }

  function startSessionPoll(sessionId: string, source: 'url' | 'sitemap' | 'bulk'): void {
    setPoll(`session:${sessionId}`, async () => {
      try {
        const detail = (await kagApi.getSession(sessionId)) as { session?: { status?: string } };
        const status = detail.session?.status ?? 'unknown';
        if (source === 'url') scrapeUrlStatus = `session ${sessionId} — ${status}`;
        else if (source === 'bulk') bulkStatus = `session ${sessionId} — ${status}`;
        else sitemapStatus = `session ${sessionId} — ${status}`;
        if (isTerminal(status)) {
          clearPoll(`session:${sessionId}`);
          await refreshSessions();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (source === 'url') scrapeUrlStatus = `session ${sessionId} — poll error: ${msg}`;
        else if (source === 'bulk') bulkStatus = `session ${sessionId} — poll error: ${msg}`;
        else sitemapStatus = `session ${sessionId} — poll error: ${msg}`;
        clearPoll(`session:${sessionId}`);
      }
    });
  }

  async function pauseSession(sid: string): Promise<void> {
    try {
      await kagApi.pauseSession(sid);
      await refreshSessions();
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function resumeSession(sid: string): Promise<void> {
    try {
      await kagApi.resumeSession(sid);
      await refreshSessions();
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function cancelSession(sid: string): Promise<void> {
    // Cancelling an in-flight scrape is destructive (loses queued pages) — confirm
    // first, mirroring the delete-confirm idiom in DocumentUploadPanel.
    if (!confirm('Cancel this scrape? In-progress pages will stop and cannot be resumed.')) {
      return;
    }
    try {
      await kagApi.cancelSession(sid);
      await refreshSessions();
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : String(e);
    }
  }

  // Re-scrape a single-URL source. The backend re-ingests to KAG only if the
  // page content changed, so we surface "Updated" vs "No change".
  async function refreshSource(s: ScrapeSession): Promise<void> {
    if (!s.base_url) return;
    refreshingId = s.session_id;
    refreshMsg = { ...refreshMsg, [s.session_id]: '' };
    try {
      const out = await kagApi.refreshSource({ url: s.base_url });
      if (isPending(out)) {
        // Non-human initiator path — parked for review (not expected in-UI).
        refreshMsg = { ...refreshMsg, [s.session_id]: 'Queued for review' };
      } else {
        const r = out as KagRefreshResult;
        // The fetch can succeed while the DB write is skipped/failed (ingestion
        // returns persisted:false + persist_error). Don't claim "Updated" then —
        // the freshness baseline wasn't recorded, so a retry is warranted.
        const msg =
          r.persisted === false
            ? 'Refreshed but not saved — retry'
            : r.changed
              ? 'Updated'
              : 'No change';
        refreshMsg = { ...refreshMsg, [s.session_id]: msg };
      }
      await refreshSessions();
    } catch (e) {
      refreshMsg = {
        ...refreshMsg,
        [s.session_id]: e instanceof Error ? e.message : String(e),
      };
    } finally {
      refreshingId = '';
    }
  }

  // Multi-page source types whose refresh re-enumerates / re-scrapes the whole
  // source (not a single URL). Matches the ingestion refresh-source grains.
  const MULTIPAGE_TYPES = new Set(['sitemap', 'crawl', 'bulk']);
  function sourceType(s: ScrapeSession): string {
    return (s.session_type ?? s.type ?? '') as string;
  }

  // Refresh a multi-page (sitemap/crawl/bulk) source: re-enumerate a sitemap (or
  // re-scrape a crawl/bulk source's known pages) and re-ingest only changed pages.
  async function refreshSourceMulti(s: ScrapeSession): Promise<void> {
    if (!s.base_url) return;
    const st = sourceType(s);
    if (!MULTIPAGE_TYPES.has(st)) return;
    refreshingId = s.session_id;
    refreshMsg = { ...refreshMsg, [s.session_id]: '' };
    try {
      const out = await kagApi.refreshSourceMulti({
        base_url: s.base_url,
        session_type: st as 'sitemap' | 'crawl' | 'bulk',
      });
      if (isPending(out)) {
        refreshMsg = { ...refreshMsg, [s.session_id]: 'Queued for review' };
      } else {
        // Like the single-URL path: the enumerate can succeed while the DB write
        // is skipped/failed (persisted:false + persist_error). Report that honestly
        // instead of claiming an optimistic "Refreshing N pages…".
        const r = out as { urls_queued?: number; persisted?: boolean; persist_error?: string };
        const n = r.urls_queued ?? 0;
        const msg =
          r.persisted === false
            ? `Refreshed but not saved — retry${r.persist_error ? ` (${r.persist_error})` : ''}`
            : `Refreshing ${n} page${n === 1 ? '' : 's'}…`;
        refreshMsg = { ...refreshMsg, [s.session_id]: msg };
      }
      await refreshSessions();
    } catch (e) {
      refreshMsg = {
        ...refreshMsg,
        [s.session_id]: e instanceof Error ? e.message : String(e),
      };
    } finally {
      refreshingId = '';
    }
  }

  async function loadCredentials(): Promise<void> {
    credentialsError = '';
    try {
      const res = await apiClient.urlCredentials.list();
      credentials = res.items ?? [];
    } catch (err) {
      credentialsError = err instanceof Error ? err.message : String(err);
      credentials = [];
    }
  }

  // Keep the session table live for sessions that were already `running` before
  // this visit (started in another tab/session). `startSessionPoll` only covers
  // sessions started in *this* visit's forms, so on mount we attach a single
  // self-stopping poll that refreshes the table until nothing is in flight.
  function pollRunningSessions(): void {
    if (!sessions.some((s) => !isTerminal(s.status))) return;
    setPoll('sessions:live', async () => {
      await refreshSessions();
      if (!sessions.some((s) => !isTerminal(s.status))) clearPoll('sessions:live');
    });
  }

  onMount(() => {
    void (async () => {
      await refreshSessions();
      pollRunningSessions();
    })();
    void loadCredentials();
  });

  onDestroy(() => {
    for (const key of Array.from(pollHandles.keys())) clearPoll(key);
  });
</script>

<div class="max-w-4xl space-y-6">
  <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
    Scrape a URL or sitemap and manage scrape sessions. To add a file, use
    <a href="/library/kag/documents" class="font-medium text-[var(--color-accent)] hover:underline">KAG documents</a>.
  </p>

  <!-- Scrape URL -->
  <section class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)]">
    <h2 class="text-lg font-semibold mb-3">Scrape URL</h2>
    <form onsubmit={submitScrapeUrl} class="space-y-3">
      <input
        type="url"
        data-testid="kag-scrape-url"
        bind:value={scrapeUrlValue}
        placeholder="https://example.com/article"
        required
        class="w-full rounded border px-3 py-2 text-sm"
      />
      <div class="flex flex-wrap gap-3 items-center text-sm">
        <label class="flex items-center gap-2">
          <span>scraper</span>
          <select bind:value={scrapeType} class="rounded border px-2 py-1">
            <option value="auto">auto</option>
            <option value="playwright">playwright</option>
            <option value="scrapy">scrapy</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span>delay (s)</span>
          <input type="number" bind:value={scrapeDelay} class="w-20 rounded border px-2 py-1" />
        </label>
        <label class="flex items-center gap-2">
          <span>timeout (s)</span>
          <input type="number" bind:value={scrapeTimeout} class="w-20 rounded border px-2 py-1" />
        </label>
      </div>
      <!-- Web authentication pass-through: pick a saved URL credential (resolved
           server-side by the webscraper service — the secret never touches the
           browser) instead of pasting a raw id. Optional login_url for form auth. -->
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Authentication (optional)</span>
          <select
            data-testid="kag-scrape-credential"
            bind:value={scrapeCredentialId}
            class="min-w-56 rounded border border-[var(--color-border-strong)] px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          >
            <option value="">No authentication (public)</option>
            {#each credentials as c (c.credential_id)}
              <option value={c.credential_id}>{c.identifier}{c.url ? ` — ${c.url}` : ''}</option>
            {/each}
          </select>
        </label>
        {#if scrapeCredentialId}
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Login URL (optional)</span>
            <input
              type="url"
              bind:value={scrapeLoginUrl}
              placeholder="https://site.example/login"
              class="w-64 rounded border border-[var(--color-border-strong)] px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
            />
          </label>
        {/if}
        <a
          href="/byoc"
          class="pb-1 text-xs text-[var(--color-accent)] hover:underline"
          title="Add or manage saved URL credentials"
        >Manage credentials →</a>
      </div>
      {#if credentialsError}
        <p class="text-xs text-[var(--color-text-muted)]">Couldn't load saved credentials: {credentialsError}</p>
      {/if}
      <button type="submit" class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] text-sm hover:bg-[var(--color-accent-strong)]">
        Scrape
      </button>
    </form>
    {#if scrapeUrlStatus}
      <p class="mt-2 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{scrapeUrlStatus}</p>
    {/if}
    {#if scrapeUrlPending}
      <p class="mt-1 text-xs text-[var(--color-warning)]">
        Pending approval — actionId: <code>{scrapeUrlPending.actionId}</code>
      </p>
    {/if}
    {#if scrapeUrlError}
      <p class="mt-2 rounded bg-[var(--color-danger-bg)] p-2 text-sm text-[var(--color-danger-text)]">{scrapeUrlError}</p>
    {/if}
  </section>

  <!-- Sitemap -->
  <section class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)]">
    <h2 class="text-lg font-semibold mb-3">Scrape sitemap</h2>
    <form onsubmit={submitSitemap} class="space-y-3">
      <input
        type="url"
        data-testid="kag-sitemap-url"
        bind:value={sitemapUrl}
        placeholder="https://example.com/sitemap.xml"
        required
        class="w-full rounded border px-3 py-2 text-sm"
      />
      <div class="flex flex-wrap gap-3 items-center text-sm">
        <label class="flex items-center gap-2">
          <span>max urls</span>
          <input
            type="number"
            data-testid="kag-sitemap-max-urls"
            bind:value={sitemapMaxUrls}
            class="w-20 rounded border px-2 py-1"
          />
        </label>
        <input
          type="text"
          data-testid="kag-sitemap-allowed-domains"
          bind:value={sitemapAllowedDomains}
          placeholder="allowed_domains, comma-separated"
          class="flex-1 rounded border px-3 py-2"
        />
      </div>
      <button
        type="submit"
        data-testid="kag-sitemap-submit"
        class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] text-sm hover:bg-[var(--color-accent-strong)]"
      >
        Scrape sitemap
      </button>
    </form>
    {#if sitemapStatus}
      <p
        class="mt-2 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]"
        data-testid="kag-sitemap-status"
      >
        {sitemapStatus}
      </p>
    {/if}
    {#if sitemapPending}
      <p class="mt-1 text-xs text-[var(--color-warning)]">
        Pending approval — actionId: <code>{sitemapPending.actionId}</code>
      </p>
    {/if}
    {#if sitemapError}
      <p
        class="mt-2 rounded bg-[var(--color-danger-bg)] p-2 text-sm text-[var(--color-danger-text)]"
        data-testid="kag-sitemap-error"
      >
        {sitemapError}
      </p>
    {/if}
  </section>

  <!-- Bulk: many URLs as one source (optional credential = one login for the whole batch) -->
  <section class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)]">
    <h2 class="text-lg font-semibold mb-3">Scrape multiple URLs</h2>
    <form onsubmit={submitBulk} class="space-y-3">
      <textarea
        data-testid="kag-bulk-urls"
        bind:value={bulkUrlsText}
        placeholder="One URL per line (or comma-separated). All scraped as one source."
        rows="4"
        class="w-full rounded border px-3 py-2 text-sm font-mono"
      ></textarea>
      <!-- Web authentication pass-through: pick a saved URL credential (resolved
           server-side by the webscraper service — the secret never touches the
           browser). With a credential the whole batch scrapes behind ONE login. -->
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Authentication (optional)</span>
          <select
            data-testid="kag-bulk-credential"
            bind:value={bulkCredentialId}
            class="min-w-56 rounded border border-[var(--color-border-strong)] px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          >
            <option value="">No authentication (public)</option>
            {#each credentials as c (c.credential_id)}
              <option value={c.credential_id}>{c.identifier}{c.url ? ` — ${c.url}` : ''}</option>
            {/each}
          </select>
        </label>
        {#if bulkCredentialId}
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Login URL (optional)</span>
            <input
              type="url"
              bind:value={bulkLoginUrl}
              placeholder="https://site.example/login"
              class="w-64 rounded border border-[var(--color-border-strong)] px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
            />
          </label>
        {/if}
        <a
          href="/byoc"
          class="pb-1 text-xs text-[var(--color-accent)] hover:underline"
          title="Add or manage saved URL credentials"
        >Manage credentials →</a>
      </div>
      <button type="submit" class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] text-sm hover:bg-[var(--color-accent-strong)]">
        Scrape URLs
      </button>
    </form>
    {#if bulkStatus}
      <p class="mt-2 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{bulkStatus}</p>
    {/if}
    {#if bulkPending}
      <p class="mt-1 text-xs text-[var(--color-warning)]">
        Pending approval — actionId: <code>{bulkPending.actionId}</code>
      </p>
    {/if}
    {#if bulkError}
      <p class="mt-2 rounded bg-[var(--color-danger-bg)] p-2 text-sm text-[var(--color-danger-text)]">{bulkError}</p>
    {/if}
  </section>

  <!-- Sessions -->
  <section class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)]">
    <div class="flex items-baseline justify-between mb-3">
      <h2 class="text-lg font-semibold">Recent sessions</h2>
      <button
        type="button"
        onclick={() => refreshSessions()}
        class="text-sm text-[var(--color-accent-strong)] underline dark:text-[var(--color-accent)]"
        disabled={sessionsLoading}
      >
        {sessionsLoading ? 'refreshing…' : 'refresh'}
      </button>
    </div>
    {#if sessionsError}
      <p class="rounded bg-[var(--color-danger-bg)] p-2 text-sm text-[var(--color-danger-text)]">{sessionsError}</p>
    {/if}
    {#if sessions.length === 0 && !sessionsLoading}
      <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No sessions yet.</p>
    {/if}
    {#if sessions.length > 0}
      <table class="w-full text-sm">
        <thead class="text-left border-b">
          <tr>
            <th class="py-2 pr-3">session</th>
            <th class="py-2 pr-3">base_url</th>
            <th class="py-2 pr-3">type</th>
            <th class="py-2 pr-3">status</th>
            <th class="py-2 pr-3">created</th>
            <th class="py-2 pr-3">actions</th>
          </tr>
        </thead>
        <tbody>
          {#each sessions as s (s.session_id)}
            <tr class="border-b align-top">
              <td class="py-2 pr-3">
                <!--
                  `kind="session"`: `session` was ADDED to `ENTITY_KINDS` (with its
                  own `KIND_NOUN` entry) rather than left off. An unrecognised kind
                  renders the generic 'record' noun, so omitting it here would have
                  claimed less than we know. `underline` keeps the button's
                  affordance, since EntityRef's stub paints muted rather than accent.
                -->
                <button
                  type="button"
                  onclick={() => expandSession(s.session_id)}
                  class="text-xs underline"
                >
                  <EntityRef id={s.session_id} kind="session" />
                </button>
              </td>
              <td class="py-2 pr-3 break-all">
                {s.base_url ?? '—'}
                {#if s.has_auth}
                  <span
                    data-testid="kag-session-auth-badge"
                    class="ml-1 inline-flex items-center rounded bg-[var(--color-surface)] px-1 text-xs text-[var(--color-text-muted)] dark:bg-[var(--color-bg)]"
                    title="Authenticated source — refresh re-authenticates with the stored credential"
                  >🔒 auth</span>
                {/if}
              </td>
              <td class="py-2 pr-3">{s.session_type ?? s.type ?? '—'}</td>
              <td class="py-2 pr-3">{s.status ?? '—'}</td>
              <td class="py-2 pr-3">{s.created_at ?? '—'}</td>
              <td class="py-2 pr-3 space-x-2" data-testid="kag-session-actions">
                {#if !isTerminal(s.status)}
                  <button type="button" data-testid="kag-session-pause" onclick={() => pauseSession(s.session_id)} class="text-[var(--color-warning)] underline">pause</button>
                  <button type="button" data-testid="kag-session-resume" onclick={() => resumeSession(s.session_id)} class="text-[var(--color-accent-strong)] underline dark:text-[var(--color-accent)]">resume</button>
                  <button type="button" data-testid="kag-session-cancel" onclick={() => cancelSession(s.session_id)} class="text-[var(--color-danger)] underline dark:text-[var(--color-danger-text)]">cancel</button>
                {/if}
                {#if (s.session_type ?? s.type) === 'single_url' && s.base_url}
                  <button
                    type="button"
                    data-testid="kag-session-refresh"
                    onclick={() => refreshSource(s)}
                    disabled={refreshingId === s.session_id}
                    class="text-[var(--color-accent-strong)] underline disabled:opacity-50 dark:text-[var(--color-accent)]"
                    title="Re-scrape this source; re-ingests only if the page changed"
                  >
                    {refreshingId === s.session_id ? 'refreshing…' : 'refresh source'}
                  </button>
                  {#if refreshMsg[s.session_id]}
                    <span class="text-xs text-[var(--color-text-muted)]">{refreshMsg[s.session_id]}</span>
                  {/if}
                {:else if MULTIPAGE_TYPES.has(sourceType(s)) && s.base_url}
                  <button
                    type="button"
                    data-testid="kag-session-refresh-source"
                    onclick={() => refreshSourceMulti(s)}
                    disabled={refreshingId === s.session_id}
                    class="text-[var(--color-accent-strong)] underline disabled:opacity-50 dark:text-[var(--color-accent)]"
                    title="Re-scrape every page of this source; re-ingests only changed pages"
                  >
                    {refreshingId === s.session_id ? 'refreshing…' : 'refresh source'}
                  </button>
                  {#if refreshMsg[s.session_id]}
                    <span class="text-xs text-[var(--color-text-muted)]">{refreshMsg[s.session_id]}</span>
                  {/if}
                {/if}
              </td>
            </tr>
            {#if expandedSessionId === s.session_id}
              <tr>
                <td colspan="6" class="bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]">
                  <KagSessionView id={s.session_id} />
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <!-- P2-5: orchestrated single-job pipeline control (submit → track → cancel/resume/delete) -->
  <KagPipelineJobs />
</div>
