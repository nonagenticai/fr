<script lang="ts">
  // Bridge review-table: bulk-edit and submit drafts created from the
  // selection store (or pre-existing editing-status drafts).
  // Spec: 2026-04-24-analysis-to-kanban-bridge.md §Frontend bullet 3.
  //
  // Re-homed from /tools/bridge to /bridge during the /tools dissolution
  // (control-plane roadmap Phase 3); reached via PromoteButton + deep links,
  // not a sidebar nav item. /tools/bridge 308-redirects here.
  //
  // project_id sourcing: the bridge backend requires every call to be
  // `(user_id, project_id)`-scoped (see backend/src/routes/tools/bridge.ts).
  // The deep-link contract is `/bridge?project=<uuid>`. We read the
  // search param via $page; if missing, we render an empty-state pointing
  // the user back to a tool output list (the place that knows which project
  // they're working in).
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { apiClient } from '$lib/api/unified-client';
  import { bridgeSelection } from '$lib/bridge/selection.svelte';
  import { openDetailPane } from '$lib/stores/rightPane.svelte';
  import { shortId } from '$lib/utils/shortId';
  import type {
    KanbanCardDraft,
    PatchDraftBody,
    Severity,
  } from '$lib/bridge/types';

  const projectId = $derived($page.url.searchParams.get('project') ?? '');

  let drafts = $state<KanbanCardDraft[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // ⚠️ A FAILED READ IS NOT AN EMPTY LIST. These two used to be the same
  // thing here — `drafts` stayed `[]` whatever happened, so the page rendered
  // "No drafts to review" over a dead backend and over work it had simply
  // never asked for. `loadFailed` is set ONLY when the listing call rejected,
  // and the template renders it INSTEAD of the empty state.
  let loadFailed = $state<string | null>(null);
  // Truncation is reported by the server (`X-Truncated`, measured with a +1
  // probe row — see backend draftService.list), never inferred from
  // `rows.length === limit`, which cannot tell a full page from a last page.
  // ⚠️ It arrives in RESPONSE HEADERS, not the body: the route is pinned to
  // the sanctioned `{ items }` envelope by
  // fr's response-envelope convention, and the one body field
  // that would fit (`total`) could only carry `items.length` — the page size
  // dressed up as a match count.
  let listMeta = $state<{
    limit: number | null;
    truncated: boolean;
    count_state: 'exact' | 'at_least' | 'unknown';
  } | null>(null);
  // The cap to NAME in the truncation banner. `appliedLimit` is the server's
  // own number and is preferred; it can be null when `X-Applied-Limit` did not
  // survive to the browser while `X-Truncated` did, and `drafts.length` is
  // then the honest substitute — literally the number of rows on screen, not a
  // guess at the cap. Computed here rather than inline so the banner's wording
  // stays one unbroken sentence for the test that reads it.
  const shownPageSize = $derived(listMeta?.limit ?? drafts.length);
  // Drafts the page tried to CREATE from the selection and could not. These
  // were `console.error`-only, i.e. invisible: the user's selection silently
  // shrank. Counted here and surfaced in the banner.
  let createFailures = $state<string[]>([]);

  // Bulk-apply controls
  let bulkProjectId = $state('');
  let bulkBoardId = $state('');
  let bulkListId = $state('');
  let bulkAssignee = $state('');
  let bulkLabels = $state('');

  // Submit progress
  let submitting = $state(false);
  type RowStatus =
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; approval_id: string }
    | { state: 'fail'; error: string };

  let perRowStatus = $state<Record<string, RowStatus>>({});

  const editableDrafts = $derived(
    drafts.filter(
      (d) => d.status === 'editing' || d.status === 'deduped',
    ),
  );

  const submitSummary = $derived.by(() => {
    const states = Object.values(perRowStatus);
    return {
      total: states.length,
      done: states.filter((s) => s.state === 'ok').length,
      failed: states.filter((s) => s.state === 'fail').length,
    };
  });

  /**
   * Fetch the drafts that already exist for this project + user.
   *
   * THIS IS THE REHYDRATION. `/bridge` is a bulk-review surface and the only
   * thing that ever put rows on it was the in-memory selection store, so a
   * refresh (or following the detail page's "← All drafts" link cold)
   * discarded every in-progress edit with no warning. `GET
   * /api/tools/bridge/drafts` is the missing read.
   *
   * Only `editing` + `deduped` are requested: they are the two statuses the
   * table can act on, and asking for them keeps a project with a long
   * committed history from pushing the editable rows out of the capped page.
   * Throws on failure — the caller must NOT turn that into an empty list.
   */
  async function fetchExistingDrafts(): Promise<KanbanCardDraft[]> {
    // ⚠️ NOT named `page`: this module auto-subscribes to the `$page` store,
    // and a local binding of that name shadows it inside this function.
    const listing = await apiClient.bridge.listDrafts(projectId, {
      status: ['editing', 'deduped'],
    });
    listMeta = {
      limit: listing.appliedLimit,
      truncated: listing.truncated,
      // A backend that sends no `X-Count-State` is 'unknown', NOT 'exact'.
      // The client already refuses to invent the claim; the page must not
      // re-invent it either.
      count_state: listing.countState,
    };
    return listing.items;
  }

  async function bootstrap() {
    loading = true;
    error = null;
    loadFailed = null;
    listMeta = null;
    createFailures = [];
    if (!projectId) {
      // No project scope → cannot call any bridge endpoint. Render the
      // empty-state below instead of erroring.
      drafts = [];
      loading = false;
      return;
    }
    try {
      const selected = bridgeSelection.selected;
      if (selected.length > 0) {
        // Create drafts for everything in the selection store, grouped by
        // producer. For coding, also bucket by run_id so each batch can
        // carry an unambiguous coding_job_id — a mixed-job selection lands
        // as multiple POSTs (one per run), each with its own header/body.
        const byProducer = new Map<
          string,
          Map<string | null, string[]>
        >();
        for (const o of selected) {
          const runKey = o.producer === 'coding' ? (o.run_id ?? null) : null;
          let perProducer = byProducer.get(o.producer);
          if (!perProducer) {
            perProducer = new Map();
            byProducer.set(o.producer, perProducer);
          }
          const list = perProducer.get(runKey) ?? [];
          list.push(o.output_id);
          perProducer.set(runKey, list);
        }
        const all: KanbanCardDraft[] = [];
        for (const [producer, byRun] of byProducer) {
          for (const [runKey, ids] of byRun) {
            try {
              const resp = await apiClient.bridge.createDrafts(projectId, {
                producer: producer as KanbanCardDraft['producer'],
                output_ids: ids,
                ...(producer === 'coding' && runKey
                  ? { coding_job_id: runKey }
                  : {}),
              });
              all.push(...(resp.drafts ?? []));
            } catch (err) {
              console.error(`createDrafts(${producer}) failed`, err);
              // Visible, not just logged: this batch is missing from the
              // table and the user has no other way to know.
              createFailures = [
                ...createFailures,
                `${producer}${runKey ? ` (run ${runKey})` : ''}: ` +
                  `${ids.length} output(s) — ` +
                  (err instanceof Error ? err.message : String(err)),
              ];
            }
          }
        }
        bridgeSelection.clear();
        // Merge the freshly-created rows with whatever was already persisted,
        // newest-server-state wins on id collision (the create response and
        // the listing can both carry the same row).
        const existing = await fetchExistingDrafts();
        const byId = new Map<string, KanbanCardDraft>();
        for (const d of all) byId.set(d.id, d);
        for (const d of existing) byId.set(d.id, d);
        drafts = [...byId.values()];
      } else {
        // The refresh path: nothing selected, so everything on screen has to
        // come from the server.
        drafts = await fetchExistingDrafts();
      }
    } catch (err) {
      console.error('bridge bootstrap failed', err);
      // ⚠️ Deliberately does NOT clear `drafts` and does NOT leave the page in
      // a state that renders "No drafts to review" — see `loadFailed`.
      loadFailed = err instanceof Error ? err.message : 'Failed to load drafts';
    } finally {
      loading = false;
    }
  }

  async function persistRowEdit(draftId: string, patch: PatchDraftBody) {
    if (!projectId) return;
    try {
      const updated = await apiClient.bridge.patchDraft(
        projectId,
        draftId,
        patch,
      );
      drafts = drafts.map((d) => (d.id === draftId ? updated : d));
    } catch (err) {
      console.error('patchDraft failed', err);
      error = err instanceof Error ? err.message : 'Failed to update draft';
    }
  }

  function debounce<T extends (...args: never[]) => unknown>(
    fn: T,
    ms: number,
  ): T & { cancel: () => void } {
    let t: ReturnType<typeof setTimeout> | undefined;
    const wrapper = ((...args: Parameters<T>) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    }) as T & { cancel: () => void };
    wrapper.cancel = () => {
      if (t) clearTimeout(t);
    };
    return wrapper;
  }

  const debouncedPersist = debounce(persistRowEdit, 400);

  function applyBulkToAll() {
    const patch: PatchDraftBody = {};
    if (bulkProjectId) patch.target_project_id = bulkProjectId;
    if (bulkBoardId) patch.target_board_id = bulkBoardId;
    if (bulkListId) patch.target_list_id = bulkListId;
    if (bulkAssignee) patch.assignee_user_id = bulkAssignee;
    if (bulkLabels) {
      patch.labels = bulkLabels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Object.keys(patch).length === 0) return;
    for (const d of editableDrafts) {
      persistRowEdit(d.id, patch);
    }
  }

  async function submitAll() {
    if (submitting) return;
    if (!projectId) {
      error = 'Missing project scope (?project=<uuid>); cannot submit drafts';
      return;
    }
    submitting = true;
    perRowStatus = Object.fromEntries(
      editableDrafts.map((d) => [d.id, { state: 'pending' as const }]),
    );

    const results = await Promise.allSettled(
      editableDrafts.map(async (draft) => {
        try {
          const r = await apiClient.bridge.submitDraft(projectId, draft.id);
          perRowStatus = {
            ...perRowStatus,
            [draft.id]: { state: 'ok', approval_id: r.approval_id },
          };
          return { id: draft.id, ok: true as const };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          perRowStatus = {
            ...perRowStatus,
            [draft.id]: { state: 'fail', error: msg },
          };
          throw err;
        }
      }),
    );

    // Refresh all drafts in parallel (replaces serial loop)
    const refreshed = await Promise.allSettled(
      drafts.map((d) => apiClient.bridge.getDraft(projectId, d.id)),
    );
    drafts = refreshed
      .map((r, i) => (r.status === 'fulfilled' ? r.value : drafts[i]))
      .filter((d): d is KanbanCardDraft => Boolean(d));

    submitting = false;
    void results;
  }

  function severityClass(sev?: Severity | null): string {
    switch (sev) {
      case 'critical':
        return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
      case 'high':
        return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
      case 'moderate':
        return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
      case 'low':
        return 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]';
      default:
        return 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]';
    }
  }

  onMount(() => {
    bootstrap();
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-3xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">Promote to kanban</h1>
    <p class="mt-2 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
      Review and edit draft cards before submitting them for approval. Each row
      becomes a kanban card on approval.
    </p>
  </div>

  {#if error}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 text-sm text-[var(--color-danger-text)]">
      {error}
    </div>
  {/if}

  {#if createFailures.length > 0}
    <div
      data-testid="bridge-create-failures"
      class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-4 text-sm text-[var(--color-warning-text)]"
    >
      <p class="font-medium">
        {createFailures.length} selected batch(es) could not be turned into drafts — they are NOT in the table below.
      </p>
      <ul class="mt-1 list-disc pl-5">
        {#each createFailures as f (f)}
          <li>{f}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if !projectId}
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-12 text-center dark:bg-[var(--color-surface)]">
      <h3 class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Missing project scope</h3>
      <p class="mt-1 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Bridge drafts are project-scoped. Open this page from a tool output
        list (coding analysis, KAG session, artifacts) — the
        <code class="px-1 py-0.5 bg-[var(--color-surface)] rounded dark:bg-[var(--color-surface)]">?project=&lt;uuid&gt;</code>
        deep-link parameter is required.
      </p>
    </div>
  {:else if loading}
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-12 flex justify-center dark:bg-[var(--color-surface)]">
      <svg class="animate-spin h-10 w-10 text-[var(--color-accent)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
    </div>
  {:else if loadFailed}
    <!--
      ⛔ THE ABSENCE-AS-A-RESULT GUARD. This arm MUST stay ABOVE the
      empty-state arm. When the listing call fails we know nothing about how
      many drafts exist, and "No drafts to review" would be a claim we cannot
      make — the exact defect class this repo keeps shipping.
    -->
    <div
      data-testid="drafts-load-error"
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-6 dark:bg-[var(--color-surface)]"
    >
      <h3 class="text-sm font-medium text-[var(--color-danger-text)]">
        Could not load your drafts
      </h3>
      <p class="mt-1 text-sm text-[var(--color-danger-text)]">
        The list of existing drafts could not be read, so this page cannot say
        whether you have any. It is NOT showing an empty list.
      </p>
      <p class="mt-1 text-xs text-[var(--color-danger-text)]">{loadFailed}</p>
      <button
        type="button"
        onclick={() => bootstrap()}
        class="mt-3 px-3 py-1.5 text-sm bg-[var(--color-surface)] text-[var(--color-text)] rounded-md hover:bg-[var(--color-bg)]"
      >
        Retry
      </button>
    </div>
  {:else if editableDrafts.length === 0}
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-12 text-center dark:bg-[var(--color-surface)]">
      <h3 class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">No drafts to review</h3>
      <p class="mt-1 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Select tool outputs from a coding analysis, KAG session, or artifacts
        list to start a draft.
      </p>
    </div>
  {:else}
    {#if listMeta?.truncated}
      <!--
        ⚠️ SAY IT ON SCREEN. `Apply to all` and `Submit N drafts` below act on
        the rows that are LOADED. If the server capped the page, "all" is not
        all, and the user has to know that before pressing either button.
      -->
      <div
        data-testid="drafts-truncated"
        class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-4 text-sm text-[var(--color-warning-text)]"
      >
        Showing the first {shownPageSize} drafts — there are more than this in
        the project. "Apply to all" and "Submit" act only on the rows loaded
        here. Narrow the selection or submit these first.
      </div>
    {:else if listMeta?.count_state === 'unknown'}
      <div
        data-testid="drafts-count-unknown"
        class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-4 text-sm text-[var(--color-warning-text)]"
      >
        The server did not report whether this list is complete, so it may be
        truncated.
      </div>
    {/if}

    <!-- Bulk-apply header -->
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-4 dark:bg-[var(--color-surface)]">
      <h2 class="text-sm font-semibold text-[var(--color-text)] mb-3 dark:text-[var(--color-text-muted)]">
        Apply to all {editableDrafts.length} drafts
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-5 gap-3">
        <input
          type="text"
          bind:value={bulkProjectId}
          placeholder="project id"
          class="px-2 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-md dark:border-[var(--color-border-strong)]"
        />
        <input
          type="text"
          bind:value={bulkBoardId}
          placeholder="board id"
          class="px-2 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-md dark:border-[var(--color-border-strong)]"
        />
        <input
          type="text"
          bind:value={bulkListId}
          placeholder="list id"
          class="px-2 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-md dark:border-[var(--color-border-strong)]"
        />
        <input
          type="text"
          bind:value={bulkAssignee}
          placeholder="assignee user id"
          class="px-2 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-md dark:border-[var(--color-border-strong)]"
        />
        <input
          type="text"
          bind:value={bulkLabels}
          placeholder="labels (comma-separated)"
          class="px-2 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-md dark:border-[var(--color-border-strong)]"
        />
      </div>
      <button
        type="button"
        onclick={applyBulkToAll}
        class="mt-3 px-3 py-1.5 text-sm bg-[var(--color-surface)] text-[var(--color-text)] rounded-md hover:bg-[var(--color-bg)]"
      >
        Apply to all
      </button>
    </div>

    <!-- Review table -->
    <div class="bg-[var(--color-bg)] rounded-lg shadow overflow-x-auto dark:bg-[var(--color-surface)]">
      <table class="min-w-full divide-y divide-[var(--color-border)] text-sm dark:divide-[var(--color-border-strong)]">
        <caption class="sr-only">Card drafts pending review and submission. {drafts.length} drafts; {editableDrafts.length} editable.</caption>
        <thead class="bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
          <tr>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Sev</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Title</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Source</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Project</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Board</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">List</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Assignee</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Labels</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Dedup</th>
            <th class="px-3 py-2 text-left font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Status</th>
            <th class="px-2 py-1 text-left">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
          {#each editableDrafts as draft (draft.id)}
            {@const sev = (draft.metadata?.severity as Severity | undefined) ?? null}
            {@const rs = perRowStatus[draft.id]}
            <tr>
              <td class="px-3 py-2">
                <span class={'inline-flex px-2 py-0.5 rounded-full text-xs font-medium ' + severityClass(sev)}>
                  {sev ?? '—'}
                </span>
              </td>
              <td class="px-3 py-2">
                <input
                  type="text"
                  bind:value={draft.title}
                  oninput={() => debouncedPersist(draft.id, { title: draft.title })}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      debouncedPersist.cancel();
                      persistRowEdit(draft.id, { title: draft.title });
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  aria-label={`Title for draft ${draft.id}`}
                  class="w-full px-2 py-1 border border-transparent hover:border-[var(--color-border-strong)] focus:border-[var(--color-accent)] rounded dark:hover:border-[var(--color-border-strong)]"
                />
              </td>
              <td class="px-3 py-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
                <div class="font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{draft.producer}</div>
                <!-- Mid-sentence ("run" then the stub), so `shortId`, not EntityRef. -->
                <div>run {shortId(draft.run_id)}</div>
              </td>
              <td class="px-3 py-2">
                <input
                  type="text"
                  bind:value={draft.target_project_id}
                  oninput={() =>
                    debouncedPersist(draft.id, {
                      target_project_id: draft.target_project_id ?? '',
                    })}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      debouncedPersist.cancel();
                      persistRowEdit(draft.id, {
                        target_project_id: draft.target_project_id ?? '',
                      });
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  aria-label={`Target project for draft ${draft.id}`}
                  class="w-32 px-2 py-1 border border-[var(--color-border)] rounded text-xs dark:border-[var(--color-border)]"
                />
              </td>
              <td class="px-3 py-2">
                <input
                  type="text"
                  bind:value={draft.target_board_id}
                  oninput={() =>
                    debouncedPersist(draft.id, {
                      target_board_id: draft.target_board_id ?? '',
                    })}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      debouncedPersist.cancel();
                      persistRowEdit(draft.id, {
                        target_board_id: draft.target_board_id ?? '',
                      });
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  aria-label={`Target board for draft ${draft.id}`}
                  class="w-32 px-2 py-1 border border-[var(--color-border)] rounded text-xs dark:border-[var(--color-border)]"
                />
              </td>
              <td class="px-3 py-2">
                <input
                  type="text"
                  bind:value={draft.target_list_id}
                  oninput={() =>
                    debouncedPersist(draft.id, {
                      target_list_id: draft.target_list_id ?? '',
                    })}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      debouncedPersist.cancel();
                      persistRowEdit(draft.id, {
                        target_list_id: draft.target_list_id ?? '',
                      });
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  aria-label={`Target list for draft ${draft.id}`}
                  class="w-32 px-2 py-1 border border-[var(--color-border)] rounded text-xs dark:border-[var(--color-border)]"
                />
              </td>
              <td class="px-3 py-2">
                <input
                  type="text"
                  bind:value={draft.assignee_user_id}
                  oninput={() =>
                    debouncedPersist(draft.id, {
                      assignee_user_id: draft.assignee_user_id || null,
                    })}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      debouncedPersist.cancel();
                      persistRowEdit(draft.id, {
                        assignee_user_id: draft.assignee_user_id || null,
                      });
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  aria-label={`Assignee for draft ${draft.id}`}
                  class="w-32 px-2 py-1 border border-[var(--color-border)] rounded text-xs dark:border-[var(--color-border)]"
                />
              </td>
              <td class="px-3 py-2">
                <input
                  type="text"
                  value={draft.labels.join(', ')}
                  oninput={(e) =>
                    debouncedPersist(draft.id, {
                      labels: (e.currentTarget as HTMLInputElement).value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      debouncedPersist.cancel();
                      persistRowEdit(draft.id, {
                        labels: (e.currentTarget as HTMLInputElement).value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      });
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  aria-label={`Labels for draft ${draft.id}`}
                  class="w-40 px-2 py-1 border border-[var(--color-border)] rounded text-xs dark:border-[var(--color-border)]"
                />
              </td>
              <td class="px-3 py-2">
                {#if draft.dedup_of_card_id}
                  <a
                    href={`/kanban/cards/${draft.dedup_of_card_id}`}
                    class="text-xs px-2 py-0.5 rounded bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] hover:bg-[var(--color-warning-bg)] dark:bg-[var(--color-warning-bg)]/30"
                    aria-label={`Duplicate of existing card ${draft.dedup_of_card_id}`}
                    title={`Existing card: ${draft.dedup_of_card_id}`}
                  >
                    <!--
                      `shortId`, not the EntityRef component: this badge is the visible
                      half of an aria-labelled link, and EntityRef's muted stub
                      would strip the badge's own colour. TAIL 8 (fr#1203/#1205).
                    -->
                    <span aria-hidden="true">dup → {shortId(draft.dedup_of_card_id)}</span>
                  </a>
                {:else}
                  <span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">—</span>
                {/if}
              </td>
              <td class="px-3 py-2 text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{draft.status}</td>
              <td class="px-2 py-1 text-sm">
                <div class="flex items-center gap-2">
                  {#if rs?.state === 'pending'}
                    <span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">submitting…</span>
                  {:else if rs?.state === 'ok'}
                    <span class="text-[var(--color-success)]">✓ approval pending</span>
                  {:else if rs?.state === 'fail'}
                    <span class="text-[var(--color-danger)]" title={rs.error}>
                      ✗ {rs.error}
                    </span>
                  {:else}
                    <span class="text-[var(--color-text-muted)]">—</span>
                  {/if}
                  <button
                    type="button"
                    class="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    onclick={() =>
                      openDetailPane({
                        kind: 'bridge-draft',
                        id: draft.id,
                        meta: { project_id: projectId },
                      })}
                    aria-label={`Open draft ${draft.id} in right pane`}
                  >
                    Open
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Submit footer -->
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-4 flex items-center justify-between dark:bg-[var(--color-surface)]">
      <div class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
        {#if submitting || submitSummary.total > 0}
          <span>
            Submitted {submitSummary.done}/{submitSummary.total}
            {#if submitSummary.failed > 0}
              <span class="text-[var(--color-danger)]">({submitSummary.failed} failed)</span>
            {/if}
          </span>
        {:else}
          <span>{editableDrafts.length} draft(s) ready to submit</span>
        {/if}
      </div>
      <button
        type="button"
        onclick={submitAll}
        disabled={submitting || editableDrafts.length === 0}
        class="px-4 py-2 bg-[var(--color-success)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-success)] text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Submitting…' : `Submit ${editableDrafts.length} drafts`}
      </button>
    </div>

  {/if}
</div>
