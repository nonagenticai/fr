<!--
  KAG "Discover" tab — literature discovery over the Discovery Engine.

  A curated surface for the separately-licensed KAG product: search the federated
  academic sources, then explore each result's citation graph (cited-by /
  references / similar) and open PDFs/DOIs — all handled inside the reused
  PaperCard. On top of the flat search this tab exposes two curated-compute
  controls that make discovery durable:

    Sessions   create a named discovery session, select among the ones created
               here, pause/resume/rename/delete + inspect quality (via the reused
               SessionQualityPanel), and export the working set (json/bibtex/ris).
               Threading a session into search persists every result server-side.
    Snowball   walk the citation graph outward from the selected seed papers
               (forward/backward/both, bounded depth + count), poll to terminal,
               cancel in-flight, and merge the discovered papers back into the
               list flagged "via snowball".

  Ingestion of papers into the tenant graph stays OUT of this browse surface
  (that is a write path via the approval bus, surfaced elsewhere) — this tab
  never calls ingestPush.

  Backed by the already-mounted `/api/research/discover/*` proxy + `researchApi`;
  no new backend. Reuses the research route's PaperCard + SessionQualityPanel
  verbatim.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { AssetError } from '$lib/api/assets';
  import {
    loadSessions,
    saveSessions,
    loadActiveId,
    saveActiveId,
  } from '$lib/kag/sessionPersistence';
  import {
    researchApi,
    paperIdOf,
    isSnowballTerminal,
    type PaperResult,
    type SnowballDirection,
    type ExportFormat,
  } from '$lib/api/research';
  import PaperCard from '../research/components/PaperCard.svelte';
  import SessionQualityPanel from '../research/components/SessionQualityPanel.svelte';
  import KagCitationGraph from '$lib/components/kag/KagCitationGraph.svelte';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  // ---- Search state ----
  let query = $state('');
  let sortBy = $state<'relevance' | 'citation_count' | 'year'>('relevance');
  let openAccessOnly = $state(false);
  let maxPerSource = $state(10);

  let searching = $state(false);
  let error = $state('');
  let results = $state<PaperResult[]>([]);
  let totalResults = $state<number | null>(null);
  let sourcesQueried = $state<string[]>([]);
  let sourcesFailed = $state<string[]>([]);
  let ran = $state(false);

  // Selection drives both PaperCard's checkbox and the snowball seed set.
  let selected = $state<Set<string>>(new Set());
  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  // ---- Session state ----
  // The Discovery Engine stores sessions server-side, but the client has no
  // list endpoint (createSession / getSession only). So we track the sessions
  // created in THIS tab in-memory — an honest working set, not a faked server
  // list — and let the user select which one search + snowball persist into.
  interface LocalSession {
    id: string;
    name: string;
  }
  let sessions = $state<LocalSession[]>([]);
  let activeSessionId = $state<string | null>(null);
  let newSessionName = $state('');
  let creatingSession = $state(false);
  let sessionError = $state('');
  // Honest "the engine handed us a different session than the one we were
  // persisting into" line — never silently repoint the active workspace.
  let sessionSwitchNotice = $state('');

  const activeSession = $derived(
    sessions.find((s) => s.id === activeSessionId) ?? null,
  );

  // Persist the working set + active pointer to localStorage so it survives a
  // reload. SSR-safe (no-op when localStorage is absent).
  function persistSessions(): void {
    saveSessions(sessions);
    saveActiveId(activeSessionId);
  }

  // Rehydrate the working set on mount. There is no session-list endpoint, so
  // each persisted id is verified with getSession; any that 404 / reject
  // (server-expired) are dropped so the UI never shows a dead session.
  onMount(() => {
    const persisted = loadSessions();
    const savedActive = loadActiveId();
    if (persisted.length === 0) {
      if (savedActive !== null) saveActiveId(null);
      return;
    }
    void (async () => {
      const alive: LocalSession[] = [];
      for (const s of persisted) {
        try {
          const detail = await researchApi.getSession(s.id);
          alive.push({ id: s.id, name: detail.name ?? s.name });
        } catch (err) {
          // ⛔ ONLY a definitive "this is gone" may drop the entry, and the drop is
          //    PERMANENT: `persistSessions()` below rewrites localStorage to the
          //    survivors, so anything not kept here is unrecoverable.
          //
          //    This catch used to be blanket (`catch {}`), with a comment claiming
          //    "server-expired / 404". It was not: a 500, a network blip, an expired
          //    token (401), or the 403 `kag_license_required` a tenant without the KAG
          //    add-on gets on EVERY call all landed here — so a transient backend
          //    failure silently emptied the user's saved-session list, with no message
          //    and no way back. Verifying a list must never be able to DESTROY it.
          //
          //    Anything that is not 404/410 is treated as UNVERIFIED and KEPT: a stale
          //    name is a trivially self-correcting cost, and the alternative is data loss.
          const status = err instanceof AssetError ? err.status : undefined;
          const definitivelyGone = status === 404 || status === 410;
          if (!definitivelyGone) alive.push(s);
        }
      }
      sessions = alive;
      activeSessionId =
        savedActive !== null && alive.some((x) => x.id === savedActive)
          ? savedActive
          : null;
      // Prune any dead ids from storage.
      persistSessions();
    })();
  });

  async function createSession(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    const name = newSessionName.trim();
    if (!name || creatingSession) return;
    creatingSession = true;
    sessionError = '';
    try {
      const s = await researchApi.createSession(name);
      const id = s.id;
      if (!id) {
        sessionError = 'Session created but no id was returned.';
        return;
      }
      const local: LocalSession = { id, name: s.name ?? name };
      // De-dupe on id in case the engine returns an existing one.
      sessions = [...sessions.filter((x) => x.id !== id), local];
      activeSessionId = id;
      newSessionName = '';
      persistSessions();
    } catch (err) {
      sessionError = errMsg(err);
    } finally {
      creatingSession = false;
    }
  }

  function selectSession(id: string): void {
    activeSessionId = activeSessionId === id ? null : id;
    persistSessions();
  }

  // The host of SessionQualityPanel is told when its session is deleted; drop it
  // from the local list and clear the active pointer.
  function onSessionDeleted(): void {
    if (activeSessionId === null) return;
    const gone = activeSessionId;
    sessions = sessions.filter((s) => s.id !== gone);
    activeSessionId = null;
    persistSessions();
  }

  // ---- Export ----
  let exporting = $state<ExportFormat | null>(null);
  let exportError = $state('');
  // True when the last export came back with no papers — surface an honest
  // "nothing to export" line instead of downloading a 0-byte file that looks valid.
  let exportEmpty = $state(false);

  async function exportActive(format: ExportFormat): Promise<void> {
    if (activeSessionId === null || exporting) return;
    exporting = format;
    exportError = '';
    exportEmpty = false;
    try {
      const res = await researchApi.exportSession(activeSessionId, format);
      const data = res.data ?? '';
      // Guard the empty session: a 0-paper export produces an empty string that
      // would download as a valid-looking but useless .bib/.ris/.json.
      if (typeof data !== 'string' || data.trim() === '') {
        exportEmpty = true;
        return;
      }
      // Trigger a download when the browser supports it (skipped in jsdom).
      if (
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        const ext = format === 'bibtex' ? 'bib' : format === 'ris' ? 'ris' : 'json';
        const blob = new Blob([data], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kag-discovery-${activeSessionId}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      exportError = errMsg(err);
    } finally {
      exporting = null;
    }
  }

  // ---- Snowball state (citation-graph walk from selected seeds) ----
  let snowballing = $state(false);
  let snowballError = $state('');
  let snowballJobId = $state<string | null>(null);
  let snowballStatus = $state<string | null>(null);
  let snowballDiscovered = $state(0);
  let snowballEdges = $state(0);
  let snowballDepth = $state(0);
  // Scope controls for the walk (engine defaults: both / depth 2 / 200 papers).
  let sbDirection = $state<SnowballDirection>('both');
  let sbDepth = $state(1);
  let sbMaxPapers = $state(200);
  // paper_ids merged into `results` from a completed walk → render a badge.
  let snowballIds = $state<string[]>([]);
  // How many discovered papers were actually merged into the list — surfaced when
  // it's below the engine's discovered count (anonymous papers can't be rendered).
  let snowballAdded = $state<number | null>(null);
  // The seed papers a walk started from (for auto-expanding the citation graph)
  // and whether the graph panel is open.
  let snowballSeedIds = $state<string[]>([]);
  let showCitationGraph = $state(false);

  const pollHandles = new Map<string, PollHandle>();
  function clearPoll(key: string): void {
    const h = pollHandles.get(key);
    if (h) {
      h.stop();
      pollHandles.delete(key);
    }
  }

  const canSnowball = $derived(
    activeSessionId !== null && selected.size > 0 && !snowballing,
  );
  // True while a snowball job is in flight (so the Cancel button is shown).
  const snowballActive = $derived(
    snowballStatus === 'pending' || snowballStatus === 'running',
  );

  async function runSearch(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!query.trim()) {
      error = 'Enter a search query.';
      return;
    }
    searching = true;
    error = '';
    ran = true;
    sessionSwitchNotice = '';
    // A new search invalidates the previous result set: drop the stale seed
    // selection and any in-flight snowball so we never walk citations from
    // papers that are no longer on screen.
    selected = new Set();
    resetSnowball();
    try {
      const res = await researchApi.search({
        query: query.trim(),
        // Threading the active session persists results server-side (survives
        // reload, exportable, and gives snowball a durable seed set).
        session_id: activeSessionId ?? undefined,
        sort_by: sortBy,
        open_access_only: openAccessOnly,
        max_results_per_source: maxPerSource,
      });
      results = res.results ?? [];
      totalResults = typeof res.total_results === 'number' ? res.total_results : results.length;
      sourcesQueried = res.sources_queried ?? [];
      sourcesFailed = res.sources_failed ?? [];
      // Adopt an engine-assigned session id (if the search created one) so the
      // sessions panel + snowball light up.
      const sid = res.session_id;
      if (typeof sid === 'string' && sid) {
        const prior = activeSessionId;
        // Only adopt a *changed* id, and never silently repoint: if the engine
        // returns a different session than the one we were persisting into, the
        // prior workspace expired server-side — say so instead of orphaning it.
        if (prior !== null && prior !== sid) {
          sessionSwitchNotice = 'Started a new session (the previous one expired).';
        }
        if (!sessions.some((s) => s.id === sid)) {
          sessions = [...sessions, { id: sid, name: query.trim().slice(0, 60) }];
        }
        activeSessionId = sid;
        persistSessions();
      }
    } catch (err) {
      error = errMsg(err);
      results = [];
      totalResults = null;
      sourcesQueried = [];
      sourcesFailed = [];
    } finally {
      searching = false;
    }
  }

  async function snowballSelected(): Promise<void> {
    if (!canSnowball || activeSessionId === null) return;
    snowballing = true;
    snowballError = '';
    snowballStatus = null;
    snowballDiscovered = 0;
    snowballEdges = 0;
    snowballDepth = 0;
    snowballAdded = null;
    snowballSeedIds = Array.from(selected);
    showCitationGraph = false;
    try {
      const res = await researchApi.startSnowball({
        seed_paper_ids: Array.from(selected),
        session_id: activeSessionId,
        direction: sbDirection,
        max_depth: sbDepth,
        max_papers: sbMaxPapers,
      });
      snowballJobId = res.job_id ?? null;
      snowballStatus = res.status ?? 'pending';
      snowballDiscovered = res.papers_discovered ?? 0;
      snowballEdges = res.edges_discovered ?? 0;
      snowballDepth = res.current_depth ?? 0;
      if (snowballJobId && !isSnowballTerminal(snowballStatus)) {
        startSnowballPoll(snowballJobId);
      } else if (isSnowballTerminal(snowballStatus)) {
        await onSnowballTerminal();
      }
    } catch (err) {
      snowballError = errMsg(err);
    } finally {
      snowballing = false;
    }
  }

  function startSnowballPoll(id: string): void {
    clearPoll(`snowball:${id}`);
    const handle = usePoll(
      async () => {
        try {
          const detail = await researchApi.getSnowballStatus(id);
          snowballStatus = detail.status ?? 'unknown';
          snowballDiscovered = detail.papers_discovered ?? snowballDiscovered;
          snowballEdges = detail.edges_discovered ?? snowballEdges;
          snowballDepth = detail.current_depth ?? snowballDepth;
          if (detail.error) snowballError = detail.error;
          if (isSnowballTerminal(snowballStatus)) {
            clearPoll(`snowball:${id}`);
            await onSnowballTerminal();
          }
        } catch (e) {
          snowballError = `poll error: ${errMsg(e)}`;
          clearPoll(`snowball:${id}`);
        }
      },
      { intervalMs: 3000 },
    );
    pollHandles.set(`snowball:${id}`, handle);
    handle.start();
  }

  // Stable dedup key: paper id when present, else a normalised title. Empty when
  // the paper is truly anonymous (neither) and therefore cannot be rendered.
  function paperKey(p: PaperResult): string {
    const id = paperIdOf(p);
    if (id) return `id:${id}`;
    const title = typeof p.title === 'string' ? p.title.trim().toLowerCase() : '';
    return title ? `t:${title}` : '';
  }

  // On a completed walk with new papers, pull them out of the session (the
  // discovered set is persisted there, not in the job response) and merge any
  // not already shown into the results list, flagged "via snowball".
  async function onSnowballTerminal(): Promise<void> {
    if (
      snowballStatus !== 'completed' ||
      snowballDiscovered <= 0 ||
      activeSessionId === null
    ) {
      return;
    }
    try {
      const res = await researchApi.exportSession(activeSessionId, 'json');
      const parsed = JSON.parse(res.data ?? '{}') as { papers?: PaperResult[] };
      // Dedup on a stable key: the paper id when present, otherwise a normalised
      // title. This recovers id-less-but-titled papers that were previously counted
      // by the engine yet silently dropped from the list. Truly anonymous papers
      // (no id and no title) have no key → still can't be rendered.
      const known = new Set(results.map(paperKey).filter(Boolean));
      const seen = new Set<string>();
      const fresh = (parsed.papers ?? []).filter((p) => {
        const key = paperKey(p);
        if (key === '' || known.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      snowballAdded = fresh.length;
      if (fresh.length > 0) {
        snowballIds = [
          ...snowballIds,
          ...(fresh.map((p) => paperIdOf(p)).filter(Boolean) as string[]),
        ];
        results = [...results, ...fresh];
      }
    } catch (e) {
      snowballError = `could not load discovered papers: ${errMsg(e)}`;
    }
  }

  async function cancelSnowball(): Promise<void> {
    if (snowballJobId === null) return;
    clearPoll(`snowball:${snowballJobId}`);
    try {
      const res = await researchApi.cancelSnowball(snowballJobId);
      snowballStatus = res.status ?? 'cancelled';
    } catch (err) {
      snowballError = errMsg(err);
    }
  }

  // Drop any in-flight snowball's local state + poll so a stale walk can't merge
  // its results into a new search. (Local reset only — we don't round-trip a
  // server cancel here; the poll is cleared, so nothing from the old job lands.)
  function resetSnowball(): void {
    if (snowballJobId !== null) clearPoll(`snowball:${snowballJobId}`);
    snowballing = false;
    snowballError = '';
    snowballJobId = null;
    snowballStatus = null;
    snowballDiscovered = 0;
    snowballEdges = 0;
    snowballDepth = 0;
    snowballIds = [];
    snowballAdded = null;
  }

  onDestroy(() => {
    for (const key of Array.from(pollHandles.keys())) clearPoll(key);
  });
</script>

<div class="max-w-4xl" data-testid="kag-discover-tab">
  <section
    class="mb-6 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
  >
    <h2 class="text-lg font-semibold mb-2">Discover literature</h2>
    <p class="text-sm text-[var(--color-text-muted)] mb-3 dark:text-[var(--color-text-muted)]">
      Search across federated academic sources, then explore each paper's citations, references and
      similar work — or open the PDF/DOI directly.
    </p>
    <form class="space-y-3" onsubmit={runSearch}>
      <div>
        <label
          for="discover-q"
          class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
          >Query</label
        >
        <input
          id="discover-q"
          data-testid="kag-discover-q"
          bind:value={query}
          placeholder="retrieval-augmented generation for knowledge graphs"
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          required
        />
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label
            for="discover-sort"
            class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
            >Sort by</label
          >
          <select
            id="discover-sort"
            bind:value={sortBy}
            class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
          >
            <option value="relevance">relevance</option>
            <option value="citation_count">citation count</option>
            <option value="year">year</option>
          </select>
        </div>
        <div>
          <label
            for="discover-max"
            class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
            >Per source</label
          >
          <input
            id="discover-max"
            type="number"
            min="1"
            max="50"
            bind:value={maxPerSource}
            class="w-20 border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
          />
        </div>
        <label class="flex items-center gap-1.5 pb-1 text-sm text-[var(--color-text)]">
          <input
            type="checkbox"
            bind:checked={openAccessOnly}
            data-testid="kag-discover-oa"
            class="accent-[var(--color-accent)]"
          />
          Open access only
        </label>
        <button
          type="submit"
          data-testid="kag-discover-submit"
          disabled={searching}
          class="ml-auto px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
    </form>

    {#if activeSession}
      <p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="kag-discover-active-note">
        Results are persisted into session <strong class="text-[var(--color-text)]"
          >{activeSession.name}</strong
        >.
      </p>
    {/if}

    {#if sessionSwitchNotice}
      <p class="mt-2 text-xs text-[var(--color-warning-text)]" data-testid="kag-session-switched">
        {sessionSwitchNotice}
      </p>
    {/if}

    {#if error}
      <div
        data-testid="kag-discover-error"
        class="mt-3 bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm"
      >
        {error}
      </div>
    {/if}
  </section>

  <!-- ─────────────────────── Saved discovery sessions ─────────────────────── -->
  <section
    class="mb-6 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
    data-testid="kag-discover-sessions-panel"
  >
    <h2 class="text-sm font-semibold mb-1">Discovery sessions</h2>
    <p class="text-xs text-[var(--color-text-muted)] mb-3">
      Create a named session to persist your working set, then select it before
      searching or snowballing. Export it as JSON/BibTeX/RIS.
    </p>

    <form class="flex flex-wrap items-end gap-2" onsubmit={createSession}>
      <div class="flex-1 min-w-48">
        <label
          for="discover-session-name"
          class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
          >New session name</label
        >
        <input
          id="discover-session-name"
          data-testid="kag-discover-session-name"
          bind:value={newSessionName}
          placeholder="e.g. RAG over knowledge graphs — 2026 survey"
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </div>
      <button
        type="submit"
        data-testid="kag-discover-session-create"
        disabled={creatingSession || !newSessionName.trim()}
        class="px-3 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded text-sm disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      >
        {creatingSession ? 'Creating…' : 'Create session'}
      </button>
    </form>

    {#if sessionError}
      <p class="mt-2 text-xs text-[var(--color-danger-text)]" data-testid="kag-discover-session-error">
        {sessionError}
      </p>
    {/if}

    {#if sessions.length > 0}
      <ul class="flex flex-wrap gap-2 mt-3" data-testid="kag-discover-sessions">
        {#each sessions as s (s.id)}
          <li>
            <button
              type="button"
              data-testid="kag-discover-session"
              aria-pressed={activeSessionId === s.id}
              onclick={() => selectSession(s.id)}
              class={`rounded-full border px-3 py-1 text-sm ${
                activeSessionId === s.id
                  ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)] border-[var(--color-accent)]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)]'
              }`}
            >
              {s.name}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-3 text-xs text-[var(--color-text-muted)]" data-testid="kag-discover-sessions-empty">
        No sessions yet — create one to persist results (searching also creates one
        automatically).
      </p>
    {/if}

    {#if activeSessionId}
      <div class="flex flex-wrap items-center gap-2 mt-3" data-testid="kag-discover-export">
        <span class="text-xs text-[var(--color-text-muted)]">Export</span>
        {#each ['json', 'bibtex', 'ris'] as const as fmt (fmt)}
          <button
            type="button"
            data-testid={`kag-discover-export-${fmt}`}
            disabled={exporting !== null}
            onclick={() => void exportActive(fmt)}
            class="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs disabled:opacity-50"
          >
            {exporting === fmt ? 'Exporting…' : fmt.toUpperCase()}
          </button>
        {/each}
      </div>
      {#if exportError}
        <p class="mt-1 text-xs text-[var(--color-danger-text)]" data-testid="kag-discover-export-error">
          {exportError}
        </p>
      {/if}
      {#if exportEmpty}
        <p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="kag-export-empty">
          Nothing to export (0 papers). Search or snowball into this session first.
        </p>
      {/if}

      <div class="mt-3 border-t border-[var(--color-border)] pt-3">
        <SessionQualityPanel sessionId={activeSessionId} ondelete={onSessionDeleted} />
      </div>
    {/if}
  </section>

  {#if searching}
    <div
      class="flex items-center gap-2 text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]"
    >
      <span
        class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-accent)]"
      ></span>
      Searching federated sources…
    </div>
  {:else if ran && !error}
    <div class="space-y-3">
      <p
        data-testid="kag-discover-summary"
        class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
      >
        {#if results.length > 0}
          {totalResults ?? results.length} result{(totalResults ?? results.length) === 1 ? '' : 's'}
          {#if sourcesQueried.length > 0}· {sourcesQueried.length} source{sourcesQueried.length === 1 ? '' : 's'} queried{/if}
          {#if sourcesFailed.length > 0}· <span class="text-[var(--color-warning-text)]"
              >{sourcesFailed.length} source{sourcesFailed.length === 1 ? '' : 's'} unavailable</span
            >{/if}
          {#if selected.size > 0}· {selected.size} selected{/if}
        {:else}
          No papers matched. Try broader terms or turn off "open access only".
        {/if}
      </p>

      {#if results.length > 0}
        {@render snowballBar()}
      {/if}

      {#each results as paper (paperIdOf(paper) ?? paper)}
        {@const id = paperIdOf(paper)}
        <div class="relative">
          {#if id && snowballIds.includes(id)}
            <span
              class="absolute right-2 top-2 z-10 rounded bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-on-primary)]"
              data-testid="kag-discover-snowball-badge"
              title="Discovered by walking the citation graph">via snowball</span
            >
          {/if}
          <PaperCard {paper} selected={id ? selected.has(id) : false} onToggle={toggle} />
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet snowballBar()}
  <div
    class="flex flex-wrap items-center gap-2 text-sm border border-[var(--color-border)] rounded p-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
    data-testid="kag-discover-snowball-bar"
  >
    <span class="text-[var(--color-text-muted)]">Snowball from {selected.size} selected</span>
    <label class="flex items-center gap-1">
      <span class="text-[var(--color-text-muted)]">Direction</span>
      <select
        data-testid="kag-discover-snowball-direction"
        bind:value={sbDirection}
        class="rounded border border-[var(--color-border-strong)] px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      >
        <option value="both">Both</option>
        <option value="forward">Forward (citing)</option>
        <option value="backward">Backward (cited)</option>
      </select>
    </label>
    <label class="flex items-center gap-1">
      <span class="text-[var(--color-text-muted)]">Depth</span>
      <input
        type="number"
        min="1"
        max="10"
        data-testid="kag-discover-snowball-depth"
        bind:value={sbDepth}
        class="w-16 rounded border border-[var(--color-border-strong)] px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
    </label>
    <label class="flex items-center gap-1">
      <span class="text-[var(--color-text-muted)]">Max papers</span>
      <input
        type="number"
        min="1"
        max="5000"
        data-testid="kag-discover-snowball-max"
        bind:value={sbMaxPapers}
        class="w-20 rounded border border-[var(--color-border-strong)] px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
    </label>
    <button
      type="button"
      data-testid="kag-discover-snowball-btn"
      disabled={!canSnowball}
      onclick={() => void snowballSelected()}
      title={activeSessionId === null
        ? 'Create or select a session first, then select seed papers'
        : selected.size === 0
          ? 'Select one or more papers to seed the walk'
          : 'Walk citations/references from the selected papers into your working set'}
      class="rounded border border-[var(--color-border-strong)] px-3 py-1 disabled:opacity-50"
    >
      {snowballing ? 'Walking…' : 'Snowball'}
    </button>
    {#if snowballActive}
      <button
        type="button"
        data-testid="kag-discover-snowball-cancel"
        onclick={() => void cancelSnowball()}
        class="rounded border border-[var(--color-border-strong)] px-3 py-1"
      >
        Cancel
      </button>
    {/if}
  </div>
  {#if snowballStatus}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-discover-snowball-state">
      Snowball {snowballStatus} · {snowballDiscovered} papers{#if snowballAdded !== null && snowballAdded < snowballDiscovered}<span
          data-testid="kag-discover-snowball-added"> ({snowballAdded} added to list)</span
        >{/if} · {snowballEdges}
      edges · depth {snowballDepth}
      {#if snowballStatus === 'completed' && snowballDiscovered === 0}
        — no new papers. Citation edges come from Semantic Scholar, so
        DOI-bearing journal/medical seeds expand best; preprints often have no
        resolvable citations.
      {/if}
    </p>
  {/if}
  {#if snowballStatus === 'completed' && results.length > 0}
    <div class="mt-2">
      <button
        type="button"
        data-testid="kag-discover-graph-toggle"
        onclick={() => (showCitationGraph = !showCitationGraph)}
        class="text-xs text-[var(--color-accent)] hover:underline"
        >{showCitationGraph ? 'Hide citation graph' : 'Show citation graph'}</button
      >
      {#if showCitationGraph}
        <div class="mt-2">
          <KagCitationGraph papers={results} seedIds={snowballSeedIds} />
        </div>
      {/if}
    </div>
  {/if}
  {#if snowballError}
    <p class="text-xs text-[var(--color-danger-text)]" data-testid="kag-discover-snowball-error">
      Snowball failed: {snowballError}
    </p>
  {/if}
{/snippet}
