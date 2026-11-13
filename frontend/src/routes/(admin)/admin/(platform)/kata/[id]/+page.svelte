<!--
  /admin/kata/[id] — one kata (docs/design/kata-super-admin.md §6 "Detail").

  Stop (running/qa), Release (failed and still holding the cord) and Rollback
  (published/closed), each behind an in-page confirm; a failure shows the API's
  own error verbatim. George 2026-11-04: a failed kata KEEPS the cord — Stop
  fails it and archives its project but the conveyor stays paused until a
  super-admin presses Release. Rollback is
  202 "requested": kata-n8n restores the base version and moves the kata to
  rolled_back — the page says so instead of claiming it is done.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { KATA_TENANT_ID, getKata, releaseKata, rollbackKata, stopKata, type KataView } from '$lib/api/katas';
  import {
    KATA_STATE_LABEL,
    KATA_STATE_TONE,
    KATA_TONE_CHIP,
    boardHref,
    canRelease,
    canRollback,
    canStop,
    cardHref,
    cordHeldSeconds,
    evidenceRows,
    evidenceWorkflowId,
    formatSeconds,
    kataTimeline,
    linkedCardRerun,
    n8nUiBase,
    n8nVersionLink,
    prettyJson,
    projectHref,
    replaysLabel,
    rollbackRefusedLabel,
  } from '$lib/katas/helpers';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { workspaces } from '$lib/stores/workspaces.svelte';

  const POLL_MS = 15_000;
  const N8N = n8nUiBase();

  const id = $derived(page.params.id ?? '');
  let kata = $state<KataView | null>(null);
  let loadError = $state<string | null>(null);
  let now = $state(Date.now());

  async function load(): Promise<void> {
    try {
      kata = await getKata(id);
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  let poll: PollHandle | null = null;
  $effect(() => {
    if (!id) return;
    poll?.stop();
    const handle = usePoll(load, { intervalMs: POLL_MS, initialDelayMs: 0 });
    poll = handle;
    handle.start();
    return () => handle.stop();
  });

  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(tick);
  });

  // ── actions ────────────────────────────────────────────────────────────────
  type KataAction = 'stop' | 'release' | 'rollback';
  let confirming = $state<KataAction | null>(null);
  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let actionNote = $state<string | null>(null);

  async function run(action: KataAction): Promise<void> {
    if (!kata) return;
    busy = true;
    actionError = null;
    actionNote = null;
    try {
      if (action === 'stop') {
        const out = await stopKata(kata.id);
        kata = out.kata;
        actionNote = 'Stopped — the kata is failed and its project archived. It still holds the cord: press Release to let the conveyor resume.';
      } else if (action === 'release') {
        const out = await releaseKata(kata.id);
        kata = out.kata;
        actionNote = 'Released — this kata no longer holds the cord. The conveyor resumes once nobody else holds it.';
      } else {
        const out = await rollbackKata(kata.id);
        kata = out.kata;
        actionNote =
          'Rollback requested — kata-n8n restores the base version and then marks the kata rolled back. This page updates when it does.';
      }
      confirming = null;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // ── links into another tenant (switch first, like the workspace switcher) ──
  // The kata board lives in the kata tenant; the source project and card live in
  // the source tenant. Both go through this one helper.
  let boardError = $state<string | null>(null);
  let sourceError = $state<string | null>(null);
  async function openInTenant(tenantId: string, href: string, label: string): Promise<string | null> {
    if (!workspaces.workspaces.some((w) => w.id === tenantId)) {
      return `The ${label} workspace is not in your workspace list, so fr cannot switch into it.`;
    }
    if (workspaces.activeId !== tenantId) {
      const { switchTenant } = await import('$lib/actions/switchTenant');
      await switchTenant(tenantId);
      if (workspaces.activeId !== tenantId) return `The switch into the ${label} workspace did not happen.`;
    }
    await goto(href);
    return null;
  }
  async function openKataBoard(boardId: string): Promise<void> {
    boardError = await openInTenant(KATA_TENANT_ID, boardHref(boardId), 'kata');
  }
  async function openSource(href: string): Promise<void> {
    sourceError = kata?.source_tenant_id ? await openInTenant(kata.source_tenant_id, href, 'source') : 'The kata recorded no source workspace.';
  }

  const versionLink = $derived(
    kata ? n8nVersionLink(N8N, (kata.target_flow_id ?? evidenceWorkflowId(kata.evidence)), kata.published_version_id ?? kata.base_version_id, kata.target_flow) : null,
  );
  const baseLink = $derived(
    kata?.base_version_id ? n8nVersionLink(N8N, (kata.target_flow_id ?? evidenceWorkflowId(kata.evidence)), kata.base_version_id, kata.target_flow) : null,
  );
</script>

<section class="p-6 space-y-6" data-testid="admin-kata-detail">
  <a href="/admin/kata" class="text-sm text-[var(--color-accent)] hover:underline">← All katas</a>

  {#if loadError}
    <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="kata-detail-error">
      {kata ? 'Refresh failed — showing the last good read: ' : 'Failed to load: '}{loadError}
    </p>
  {/if}

  {#if !kata && !loadError}
    <p class="text-sm text-[var(--color-text-muted)]" role="status">Loading…</p>
  {:else if kata}
    <header class="space-y-2">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-semibold">Kata {kata.id.slice(0, 8)}</h1>
        <span class="rounded border px-2 py-0.5 text-xs font-semibold {KATA_TONE_CHIP[KATA_STATE_TONE[kata.state]]}" data-testid="kata-state">
          {KATA_STATE_LABEL[kata.state]}
        </span>
        {#if kata.cord.held && kata.state === 'failed'}
          <span class="text-sm font-semibold text-[var(--color-danger)]" data-testid="kata-cord-held-failed">
            failed — still holding the cord ({formatSeconds(cordHeldSeconds(kata, now))}); super-admin release required
          </span>
        {:else if kata.cord.held}
          <span class="text-sm text-[var(--color-warning-text)]" data-testid="kata-cord-held">
            holding the cord — {formatSeconds(cordHeldSeconds(kata, now))}
          </span>
        {:else}
          <span class="text-sm text-[var(--color-text-muted)]">cord held {formatSeconds(cordHeldSeconds(kata, now))} in total</span>
        {/if}
      </div>
      {#if kata.state_detail}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="kata-state-detail">{kata.state_detail}</p>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        {#if canStop(kata.state) || canRelease(kata) || canRollback(kata.state)}
          {@const action = (canStop(kata.state) ? 'stop' : canRelease(kata) ? 'release' : 'rollback') as KataAction}
          {#if confirming === action}
            <span class="text-sm">
              {action === 'stop'
                ? 'Stop this kata? It becomes failed and its project is archived. It KEEPS the cord: the conveyor stays paused until you press Release.'
                : action === 'release'
                  ? 'Release this failed kata\'s cord? The conveyor resumes once nobody else (the operator, another kata) holds it.'
                  : 'Roll this kata back? kata-n8n restores the nodes it changed to the base version.'}
            </span>
            <button
              type="button"
              class="px-3 py-1 text-sm rounded border border-[var(--color-danger-border)] text-[var(--color-danger)] disabled:opacity-50"
              disabled={busy}
              onclick={() => run(action)}
              data-testid="kata-action-confirm"
              >{busy ? '…' : action === 'stop' ? 'Yes, stop' : action === 'release' ? 'Yes, release' : 'Yes, roll back'}</button
            >
            <button type="button" class="px-3 py-1 text-sm rounded border" disabled={busy} onclick={() => (confirming = null)}>Cancel</button>
          {:else}
            <button
              type="button"
              class="px-3 py-1 text-sm rounded border border-[var(--color-danger-border)] text-[var(--color-danger)]"
              onclick={() => {
                confirming = action;
                actionError = null;
              }}
              data-testid={`kata-${action}`}>{action === 'stop' ? 'Stop' : action === 'release' ? 'Release' : 'Rollback'}</button
            >
          {/if}
        {/if}
        {#if kata.cord_released_at}
          <span class="text-sm text-[var(--color-text-muted)]" data-testid="kata-cord-released">
            Cord released by {kata.cord_released_by ?? '—'} at {new Date(kata.cord_released_at).toLocaleString()}
          </span>
        {/if}
        {#if rollbackRefusedLabel(kata) && kata.rollback_refused_at}
          <span class="text-sm text-[var(--color-danger)]" data-testid="kata-rollback-refused">
            A repeat of this signature at {new Date(kata.rollback_refused_at).toLocaleString()}: {rollbackRefusedLabel(kata)} — nothing was rolled back.
          </span>
        {/if}
        {#if kata.rollback_requested_at && !kata.rolled_back_at}
          <span class="text-sm text-[var(--color-warning-text)]" data-testid="kata-rollback-pending">
            Rollback requested {new Date(kata.rollback_requested_at).toLocaleString()} — waiting for kata-n8n.
          </span>
        {/if}
      </div>
      {#if actionError}
        <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="kata-action-error">{actionError}</p>
      {/if}
      {#if actionNote}
        <p class="text-sm text-[var(--color-success)]" role="status" data-testid="kata-action-note">{actionNote}</p>
      {/if}
    </header>

    <section class="space-y-1" data-testid="kata-symptom">
      <h2 class="text-lg font-semibold">Symptom</h2>
      <p class="whitespace-pre-wrap text-sm">{kata.symptom}</p>
      <p class="text-xs text-[var(--color-text-muted)]">
        Source:
        <button type="button" class="underline" onclick={() => openSource(projectHref(kata!.source_project_id))} data-testid="kata-source-project"
          >project {kata.source_project_id}</button
        >
        {#if kata.source_card_id}·
          <button type="button" class="underline" onclick={() => openSource(cardHref(kata!.source_card_id!))} data-testid="kata-source-card"
            >card {kata.source_card_id}</button
          >{/if}
        {#if kata.source_execution_id}· execution {kata.source_execution_id}{/if}
        {#if kata.source_phase}· phase {kata.source_phase}{/if}
        · opened by {kata.opened_by}
      </p>
      {#if sourceError}<p class="text-sm text-[var(--color-danger)]" role="alert">{sourceError}</p>{/if}
      {#if kata.signature}<p class="text-xs text-[var(--color-text-muted)]">Signature: <code>{kata.signature}</code></p>{/if}
    </section>

    <section data-testid="kata-timeline">
      <h2 class="text-lg font-semibold mb-2">Timeline</h2>
      <ol class="space-y-1 text-sm">
        {#each kataTimeline(kata) as ev (ev.key)}
          <li class="flex gap-3">
            <span class="w-44 shrink-0 text-xs text-[var(--color-text-muted)]">{new Date(ev.at).toLocaleString()}</span>
            <span class="rounded border px-2 text-xs {KATA_TONE_CHIP[ev.tone]}">{ev.label}</span>
          </li>
        {/each}
      </ol>
    </section>

    <section class="space-y-1" data-testid="kata-versions">
      <h2 class="text-lg font-semibold">Fix</h2>
      <p class="text-sm">Target flow: <strong>{kata.target_flow ?? '—'}</strong> · root cause: {kata.root_cause_class ?? '—'}</p>
      <p class="text-sm">
        Version: <code>{kata.base_version_id ?? '—'}</code> → <code>{kata.published_version_id ?? '—'}</code>
        {#if baseLink?.exact}· <a class="underline" href={baseLink.href} target="_blank" rel="noopener">base in n8n ↗</a>{/if}
        {#if versionLink}
          · <a class="underline" href={versionLink.href} target="_blank" rel="noopener" data-testid="kata-n8n-link">
            {versionLink.exact ? (kata.published_version_id ? 'published version in n8n ↗' : 'version in n8n ↗') : 'find the flow in n8n ↗'}
          </a>
        {/if}
      </p>
      {#if versionLink && !versionLink.exact}
        <p class="text-xs text-[var(--color-text-muted)]">
          The kata records the flow by name, not by n8n workflow id, so this opens a search rather than the version itself.
        </p>
      {/if}
    </section>

    <section data-testid="kata-evidence">
      <h2 class="text-lg font-semibold mb-2">Evidence</h2>
      {#if evidenceRows(kata.evidence).length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No evidence recorded.</p>
      {:else}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {#each evidenceRows(kata.evidence) as row (row.key)}
            <dt class="font-medium">{row.key}</dt>
            <dd>
              {#if row.block}
                <pre class="whitespace-pre-wrap rounded bg-[var(--color-surface)] p-2 text-xs">{row.value}</pre>
              {:else}{row.value}{/if}
            </dd>
          {/each}
        </dl>
      {/if}
    </section>

    <section data-testid="kata-ops">
      <h2 class="text-lg font-semibold mb-2">Ops</h2>
      {#if prettyJson(kata.ops)}
        <pre class="whitespace-pre-wrap rounded bg-[var(--color-surface)] p-2 text-xs">{prettyJson(kata.ops)}</pre>
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">READY has not reported an op list yet.</p>
      {/if}
    </section>

    <section data-testid="kata-replays">
      <h2 class="text-lg font-semibold mb-2">QA replays — {replaysLabel(kata)}</h2>
      {#if prettyJson(kata.replays)}
        <pre class="whitespace-pre-wrap rounded bg-[var(--color-surface)] p-2 text-xs">{prettyJson(kata.replays)}</pre>
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">QA has not reported replay results yet.</p>
      {/if}
    </section>

    <section data-testid="kata-linked-cards">
      <h2 class="text-lg font-semibold mb-2">Linked cards ({kata.linked_cards.length})</h2>
      {#if kata.linked_cards.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No card is linked to this kata.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each kata.linked_cards as c (c.card_id)}
            {@const rr = linkedCardRerun(c)}
            <li>
              <a class="underline" href={cardHref(c.card_id)}>card {c.card_id}</a>
              {#if c.phase}<span class="text-xs text-[var(--color-text-muted)]">· {c.phase}</span>{/if}
              <span class="ml-2 rounded border px-2 text-xs {KATA_TONE_CHIP[rr.tone]}">{rr.label}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section data-testid="kata-board">
      <h2 class="text-lg font-semibold mb-2">Kata board</h2>
      {#if kata.kata_board_id}
        <button type="button" class="text-sm underline" onclick={() => openKataBoard(kata!.kata_board_id!)} data-testid="kata-board-link">
          Open the kata board (switches into the kata workspace)
        </button>
        {#if kata.kata_card_id}<span class="text-xs text-[var(--color-text-muted)]"> · kata card {kata.kata_card_id}</span>{/if}
        {#if boardError}<p class="text-sm text-[var(--color-danger)]" role="alert">{boardError}</p>{/if}
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">No kata board recorded.</p>
      {/if}
    </section>
  {/if}
</section>
