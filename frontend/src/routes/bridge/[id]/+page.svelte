<script lang="ts">
  // Single-draft edit page. Deep-link target from approval notifications
  // (Telegram/Teams "review" link). Spec: 2026-04-24-analysis-to-kanban-bridge.md
  // §Frontend bullet 4.
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { goto } from '$app/navigation';
  import { apiClient } from '$lib/api/unified-client';
  import type { KanbanCardDraft, PatchDraftBody } from '$lib/bridge/types';
  import { parseBridgeError, type BridgeError } from '$lib/bridge/errors';

  const draftId = $derived($page.params.id);
  // Bridge backend requires `(user_id, project_id)` scope on every call
  // (see backend/src/routes/tools/bridge.ts). Deep-link contract is
  // `/bridge/[id]?project=<uuid>` (re-homed from /tools/bridge/[id], roadmap
  // Phase 3). Without it, calls 400; we render a clear error and short-circuit
  // load/save/submit/reject.
  const projectId = $derived($page.url.searchParams.get('project') ?? '');

  // Structured load-time error so the UI can render distinct states for
  // bad URL (no :id), broken deep-link (no ?project), and backend fetch
  // failures. The `fetch_failed` arm carries the parsed `BridgeError` so the
  // page can switch on the backend `code` (e.g. `draft_not_found` vs
  // `UPSTREAM_FORBIDDEN`) instead of stringifying the envelope.
  type LoadError =
    | { code: 'missing_draft_id'; message: string }
    | { code: 'missing_project_scope'; message: string }
    | { code: 'fetch_failed'; bridgeError: BridgeError }
    | null;

  let draft = $state<KanbanCardDraft | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let busy = $state(false);
  let loadError = $state<LoadError>(null);
  // Mutation errors (save/submit/reject) carry the same structured envelope
  // so the UI renders by code, not by `err.message` (which collapses the
  // `{error: {...}}` envelope to `[object Object]` via ApiError.super(msg)).
  let mutationError = $state<BridgeError | null>(null);
  let info = $state<string | null>(null);

  /**
   * Project scope for the "← All drafts" back-link.
   *
   * Prefer the URL's `?project=`; fall back to the loaded draft's own
   * `project_id`. `/bridge` can only list drafts when it has a project scope,
   * so dropping to a bare `/bridge` turns the back-link into the
   * "Missing project scope" dead end for a user who is demonstrably inside a
   * project — the draft on screen names it.
   */
  const allDraftsProjectId = $derived(projectId || (draft?.project_id ?? ''));

  // Edit buffers
  let title = $state('');
  let bodyMd = $state('');
  let targetProjectId = $state('');
  let targetBoardId = $state('');
  let targetListId = $state('');
  let assigneeUserId = $state('');
  let labelsCsv = $state('');

  // Reject modal
  let showReject = $state(false);
  let rejectReason = $state('');

  function hydrateBuffers(d: KanbanCardDraft) {
    title = d.title;
    bodyMd = d.body_md;
    targetProjectId = d.target_project_id ?? '';
    targetBoardId = d.target_board_id ?? '';
    targetListId = d.target_list_id ?? '';
    assigneeUserId = d.assignee_user_id ?? '';
    labelsCsv = d.labels.join(', ');
  }

  async function load() {
    loading = true;
    loadError = null;
    mutationError = null;
    if (!draftId) {
      loadError = {
        code: 'missing_draft_id',
        message: 'No draft id in route — bridge expects /bridge/:id.',
      };
      loading = false;
      return;
    }
    if (!projectId) {
      loadError = {
        code: 'missing_project_scope',
        message:
          'Missing project scope. This page must be opened with ?project=<uuid> ' +
          '(deep-link contract). Re-open from the bridge review table or a ' +
          'tool output list.',
      };
      loading = false;
      return;
    }
    try {
      const fetched = await apiClient.bridge.getDraft(projectId, draftId);
      draft = fetched;
      hydrateBuffers(fetched);
    } catch (err) {
      const bridgeError = parseBridgeError(err);
      console.error('getDraft failed', bridgeError);
      loadError = { code: 'fetch_failed', bridgeError };
    } finally {
      loading = false;
    }
  }

  /**
   * Synthesize a `BridgeError` for client-side guard failures (e.g. missing
   * ?project= deep-link param) so the mutation error display always renders
   * a `code` + friendly message — not a raw string. We reuse the
   * `UPSTREAM_BAD_BODY` code because that's exactly what the backend would
   * return if the call reached it without a project_id.
   */
  function localBadBody(message: string): BridgeError {
    return {
      code: 'UPSTREAM_BAD_BODY',
      message,
      status: 400,
      friendly: message,
    };
  }

  async function save() {
    if (!draft || saving) return;
    if (!projectId) {
      mutationError = localBadBody(
        'Missing project scope (?project=<uuid>); cannot save',
      );
      return;
    }
    saving = true;
    mutationError = null;
    info = null;
    const patch: PatchDraftBody = {
      title,
      body_md: bodyMd,
      target_project_id: targetProjectId || undefined,
      target_board_id: targetBoardId || undefined,
      target_list_id: targetListId || undefined,
      assignee_user_id: assigneeUserId || null,
      labels: labelsCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      const updated = await apiClient.bridge.patchDraft(
        projectId,
        draft.id,
        patch,
      );
      draft = updated;
      hydrateBuffers(updated);
      info = 'Saved';
    } catch (err) {
      mutationError = parseBridgeError(err);
    } finally {
      saving = false;
    }
  }

  async function submit() {
    if (!draft || busy) return;
    if (!projectId) {
      mutationError = localBadBody(
        'Missing project scope (?project=<uuid>); cannot submit',
      );
      return;
    }
    busy = true;
    mutationError = null;
    try {
      await save();
      // `save()` may have set a mutationError; abort submit so we don't
      // overwrite a save failure with a submit timeout.
      if (mutationError) return;
      const result = await apiClient.bridge.submitDraft(projectId, draft.id);
      info = `Submitted — broadcast to ${result.broadcasted_to?.length ?? 0} channels`;
      await load();
    } catch (err) {
      mutationError = parseBridgeError(err);
    } finally {
      busy = false;
    }
  }

  async function reject() {
    if (!draft || busy) return;
    if (!projectId) {
      mutationError = localBadBody(
        'Missing project scope (?project=<uuid>); cannot reject',
      );
      return;
    }
    busy = true;
    mutationError = null;
    try {
      await apiClient.bridge.rejectDraft(projectId, draft.id, {
        reason: rejectReason || undefined,
      });
      showReject = false;
      info = 'Draft rejected';
      await load();
    } catch (err) {
      mutationError = parseBridgeError(err);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    load();
  });

  const editable = $derived(
    draft?.status === 'editing' || draft?.status === 'deduped',
  );

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, draft?.title ?? null);
  });
</script>

<div class="space-y-6 max-w-4xl">
  <div class="flex items-start justify-between gap-4">
    <div>
      <button
        type="button"
        onclick={() =>
          goto(
            // Fall back to the LOADED draft's own project_id. Until
            // `GET /api/tools/bridge/drafts` existed this link went to a page
            // that could not list anything; now it must at least always carry
            // the scope that makes the listing possible, and the draft in hand
            // knows it even when the URL lost `?project=`.
            allDraftsProjectId
              ? `/bridge?project=${encodeURIComponent(allDraftsProjectId)}`
              : '/bridge',
          )}
        class="text-sm text-[var(--color-accent)] hover:underline"
      >
        ← All drafts
      </button>
      <h1 class="text-3xl font-bold text-[var(--color-text)] mt-2 dark:text-[var(--color-text)]">Draft card</h1>
      {#if draft}
        <p class="mt-1 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
          {draft.producer} · run {draft.run_id} · status
          <span class="font-medium">{draft.status}</span>
        </p>
      {/if}
    </div>
  </div>

  {#if loadError?.code === 'missing_draft_id'}
    <div
      data-testid="load-error-missing-draft-id"
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-3 text-sm text-[var(--color-danger-text)]"
    >
      Bad URL — no draft id. {loadError.message}
    </div>
  {:else if loadError?.code === 'missing_project_scope'}
    <div
      data-testid="load-error-missing-project-scope"
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-3 text-sm text-[var(--color-danger-text)]"
    >
      {loadError.message}
    </div>
  {:else if loadError?.code === 'fetch_failed'}
    <div
      data-testid="load-error-fetch-failed"
      data-error-code={loadError.bridgeError.code}
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-3 text-sm text-[var(--color-danger-text)]"
    >
      <p class="font-medium">{loadError.bridgeError.friendly}</p>
      <p class="mt-1 text-xs text-[var(--color-danger)] dark:text-[var(--color-danger-text)]">
        <span class="font-mono">{loadError.bridgeError.code}</span>
        {#if loadError.bridgeError.message && loadError.bridgeError.message !== loadError.bridgeError.friendly}
          · {loadError.bridgeError.message}
        {/if}
      </p>
    </div>
  {/if}
  {#if mutationError}
    <div
      data-testid="mutation-error"
      data-error-code={mutationError.code}
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-3 text-sm text-[var(--color-danger-text)]"
    >
      <p class="font-medium">{mutationError.friendly}</p>
      <p class="mt-1 text-xs text-[var(--color-danger)] dark:text-[var(--color-danger-text)]">
        <span class="font-mono">{mutationError.code}</span>
        {#if mutationError.message && mutationError.message !== mutationError.friendly}
          · {mutationError.message}
        {/if}
      </p>
    </div>
  {/if}
  {#if info}
    <div class="bg-[var(--color-success-bg)] border border-[var(--color-success-border)] rounded-lg p-3 text-sm text-[var(--color-success-text)]">
      {info}
    </div>
  {/if}

  {#if loading}
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-12 flex justify-center dark:bg-[var(--color-surface)]">
      <svg class="animate-spin h-10 w-10 text-[var(--color-accent)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
    </div>
  {:else if !draft}
    <div class="bg-[var(--color-bg)] rounded-lg shadow p-12 text-center text-sm text-[var(--color-text-muted)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]">
      Draft not found.
    </div>
  {:else}
    {#if draft.dedup_of_card_id}
      <div class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-3 text-sm text-[var(--color-warning-text)]">
        This finding is already promoted as card
        <a class="underline" href={`/kanban#card-${draft.dedup_of_card_id}`}>
          {draft.dedup_of_card_id}
        </a>. Submitting will create a new card; choose reject to skip.
      </div>
    {/if}

    <div class="bg-[var(--color-bg)] rounded-lg shadow p-6 space-y-4 dark:bg-[var(--color-surface)]">
      <div>
        <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-title">Title</label>
        <input
          id="d-title"
          type="text"
          bind:value={title}
          disabled={!editable}
          class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-body">Body (markdown)</label>
        <textarea
          id="d-body"
          bind:value={bodyMd}
          disabled={!editable}
          rows="10"
          class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md font-mono text-sm disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
        ></textarea>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-proj">Project</label>
          <input id="d-proj" type="text" bind:value={targetProjectId} disabled={!editable}
            class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]" />
        </div>
        <div>
          <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-board">Board</label>
          <input id="d-board" type="text" bind:value={targetBoardId} disabled={!editable}
            class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]" />
        </div>
        <div>
          <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-list">List (column)</label>
          <input id="d-list" type="text" bind:value={targetListId} disabled={!editable}
            class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]" />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-assignee">Assignee user id</label>
          <input id="d-assignee" type="text" bind:value={assigneeUserId} disabled={!editable}
            class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]" />
        </div>
        <div>
          <label class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]" for="d-labels">Labels (comma-separated)</label>
          <input id="d-labels" type="text" bind:value={labelsCsv} disabled={!editable}
            class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]" />
        </div>
      </div>
    </div>

    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={save}
        disabled={!editable || saving}
        class="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-bg)] text-sm font-medium disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onclick={submit}
        disabled={!editable || busy}
        class="px-4 py-2 bg-[var(--color-success)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-success)] text-sm font-medium disabled:opacity-50"
      >
        Submit for approval
      </button>
      <button
        type="button"
        onclick={() => (showReject = true)}
        disabled={!editable || busy}
        class="px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg hover:opacity-90 text-sm font-medium disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  {/if}
</div>

{#if showReject}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-surface-strong)]/75">
    <div class="bg-[var(--color-bg)] rounded-lg shadow-xl max-w-md w-full p-6 dark:bg-[var(--color-surface)]">
      <h3 class="text-lg font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Reject draft</h3>
      <textarea
        bind:value={rejectReason}
        rows="4"
        placeholder="Reason (optional)"
        class="mt-3 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md text-sm dark:border-[var(--color-border-strong)]"
      ></textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onclick={() => (showReject = false)}
          class="px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded-md hover:bg-[var(--color-surface)] dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={reject}
          disabled={busy}
          class="px-3 py-1.5 text-sm bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-md hover:opacity-90 disabled:opacity-50"
        >
          Confirm reject
        </button>
      </div>
    </div>
  </div>
{/if}
