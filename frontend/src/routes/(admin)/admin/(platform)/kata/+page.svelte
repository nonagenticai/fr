<!--
  /admin/kata — super-admin kata observability (docs/design/kata-super-admin.md §6,
  amended by the kata build contract: no Start button; Stop + Rollback only;
  a hand-open returns 202 "requested" and the kata appears once the coach opens it).
  George 2026-11-04: a failed kata KEEPS the cord; the strip lists every failed
  holder ("failed — super-admin release required") and links to its Release.

  Gate: the (platform) layout redirects a non-super-admin; every /api/katas route
  re-gates on the server (403 kata_caller_not_allowed).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { authFetch } from '$lib/api/auth-fetch';
  import {
    KATA_STATES,
    KataApiError,
    listKatas,
    openKataByHand,
    stopKata,
    type KataListResponse,
    type KataWindowStats,
  } from '$lib/api/katas';
  import {
    KATA_STATE_LABEL,
    KATA_STATE_TONE,
    KATA_TONE_CHIP,
    canStop,
    cardHref,
    cordHeldSeconds,
    formatSeconds,
    holdingSentence,
    kataDetailHref,
    oneLine,
    projectHref,
    readNewKataPrefill,
    replaysLabel,
    rollbackPending,
    rollbackRefusedLabel,
    validateNewKata,
  } from '$lib/katas/helpers';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { Combobox, type ComboOption } from '$lib/components/ui';

  const POLL_MS = 15_000;

  let data = $state<KataListResponse | null>(null);
  let loadError = $state<string | null>(null);
  let stateFilter = $state('');
  let projectFilter = $state('');
  let now = $state(Date.now());

  // Project names, keyed by id — filled from each source tenant's project list.
  let projectNames = $state<Record<string, string>>({});
  const namedTenants = new Set<string>();

  async function projectsOf(tenantId: string): Promise<{ id: string; name: string }[]> {
    const r = await authFetch('/api/projects', { headers: { 'X-Active-Tenant': tenantId } });
    if (!r.ok) throw new KataApiError(r.status, null, `HTTP ${r.status}: could not list that workspace's projects`);
    const body = (await r.json()) as { items?: { id: string; name: string }[] };
    return (body.items ?? []).map((p) => ({ id: p.id, name: p.name }));
  }

  async function nameProjects(res: KataListResponse): Promise<void> {
    const tenants = [...new Set(res.items.map((k) => k.source_tenant_id).filter((t): t is string => !!t))];
    for (const t of tenants) {
      if (namedTenants.has(t)) continue;
      namedTenants.add(t);
      try {
        const ps = await projectsOf(t);
        projectNames = { ...projectNames, ...Object.fromEntries(ps.map((p) => [p.id, p.name])) };
      } catch {
        // Names are a convenience; the row still links by id.
      }
    }
  }

  async function load(): Promise<void> {
    try {
      const res = await listKatas({ state: stateFilter || null, project: projectFilter || null });
      data = res;
      loadError = null;
      void nameProjects(res);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      throw err; // let the poll back off
    }
  }

  let poll: PollHandle | null = null;
  function restartPoll(): void {
    poll?.stop();
    poll = usePoll(load, { intervalMs: POLL_MS, initialDelayMs: 0 });
    poll.start();
  }

  // Distinct projects seen across every list read, for the filter.
  let seenProjects = $state<Record<string, true>>({});
  $effect(() => {
    if (!data) return;
    const next = { ...seenProjects };
    let changed = false;
    for (const k of data.items) {
      if (!next[k.source_project_id]) {
        next[k.source_project_id] = true;
        changed = true;
      }
    }
    if (changed) seenProjects = next;
  });
  const projectFilterOptions = $derived(
    Object.keys(seenProjects)
      .map((id) => ({ id, name: projectNames[id] ?? id.slice(0, 8) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  function projectLabel(id: string): string {
    return projectNames[id] ?? `${id.slice(0, 8)}…`;
  }

  // ── Stop from the header strip ─────────────────────────────────────────────
  let stopConfirm = $state(false);
  let stopBusy = $state(false);
  let stopError = $state<string | null>(null);

  async function doStop(id: string): Promise<void> {
    stopBusy = true;
    stopError = null;
    try {
      await stopKata(id);
      stopConfirm = false;
      await load().catch(() => {});
    } catch (err) {
      stopError = err instanceof Error ? err.message : String(err);
    } finally {
      stopBusy = false;
    }
  }

  const holdingKata = $derived(data?.holding ? (data.items.find((k) => k.id === data!.holding!.kata_id) ?? null) : null);
  // Stop is offered only when the list confirms the holder is in a stoppable
  // state. A holder outside the current filter (or a pre-katas holder) links to
  // its detail page instead, where its state is read.
  const holdingStoppable = $derived(holdingKata ? canStop(holdingKata.state) : false);

  // ── New kata (hand-open → the conveyor coach) ──────────────────────────────
  let showNew = $state(false);
  let fTenant = $state<string | null>(null);
  let fProject = $state<string | null>(null);
  let fCard = $state('');
  let fExecution = $state('');
  let fSymptom = $state('');
  let fProjects = $state<ComboOption[]>([]);
  let fProjectsError = $state<string | null>(null);
  let fErrors = $state<string[]>([]);
  let fBusy = $state(false);
  let fRequested = $state<{ project: string; card: string; at: number } | null>(null);
  let fError = $state<string | null>(null);

  const tenantOptions = $derived<ComboOption[]>(
    workspaces.workspaces
      .filter((w) => !w.archived_at)
      .map((w) => ({ value: w.id, label: w.name, sublabel: w.kind })),
  );

  async function loadFormProjects(tenantId: string | null): Promise<void> {
    fProjects = [];
    fProjectsError = null;
    if (!tenantId) return;
    try {
      const ps = await projectsOf(tenantId);
      fProjects = ps.map((p) => ({ value: p.id, label: p.name, sublabel: p.id }));
      projectNames = { ...projectNames, ...Object.fromEntries(ps.map((p) => [p.id, p.name])) };
    } catch (err) {
      fProjectsError = err instanceof Error ? err.message : String(err);
    }
  }

  async function submitNew(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    fError = null;
    fErrors = validateNewKata({ project: fProject ?? '', card: fCard, execution: fExecution, symptom: fSymptom });
    if (fErrors.length) return;
    fBusy = true;
    try {
      await openKataByHand({
        source_project_id: fProject!,
        source_card_id: fCard.trim(),
        ...(fExecution.trim() ? { source_execution_id: fExecution.trim() } : {}),
        symptom: fSymptom.trim(),
      });
      fRequested = { project: fProject!, card: fCard.trim(), at: Date.now() };
      fSymptom = '';
      fExecution = '';
    } catch (err) {
      fError = err instanceof Error ? err.message : String(err);
    } finally {
      fBusy = false;
    }
  }

  onMount(() => {
    const pre = readNewKataPrefill($page.url.searchParams);
    if (pre.open) {
      showNew = true;
      fTenant = pre.tenant || workspaces.activeId || null;
      fProject = pre.project || null;
      fCard = pre.card;
      fExecution = pre.execution;
      void loadFormProjects(fTenant);
    }
    restartPoll();
    const tick = setInterval(() => (now = Date.now()), 15_000);
    return () => {
      poll?.stop();
      clearInterval(tick);
    };
  });

  function onFilterChange(): void {
    restartPoll();
  }

  const statRows = $derived(
    data ? [{ label: 'Today', s: data.stats.today }, { label: 'Last 7 days', s: data.stats.last7d }] : [],
  );

  const statCols: { key: keyof KataWindowStats; label: string }[] = [
    { key: 'opened', label: 'Opened' },
    { key: 'published', label: 'Published' },
    { key: 'failed', label: 'Failed' },
    { key: 'rolled_back', label: 'Rolled back' },
  ];
</script>

<section class="p-6 space-y-6" data-testid="admin-kata">
  <header class="flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">Kata — fixing the conveyor</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Every kata the coach opened: what blocked, what was changed, and whether it held.
      </p>
    </div>
    <button
      type="button"
      class="shrink-0 px-3 py-1 text-sm rounded border hover:bg-[var(--color-surface-strong)]"
      onclick={() => {
        showNew = !showNew;
        if (showNew && !fTenant) {
          fTenant = workspaces.activeId ?? null;
          void loadFormProjects(fTenant);
        }
      }}
      data-testid="kata-new-toggle"
    >
      {showNew ? 'Close' : 'New kata'}
    </button>
  </header>

  <!-- Header strip: who holds the cord, and the totals. -->
  <section class="rounded-[var(--radius-md)] border p-4 space-y-3" data-testid="kata-strip">
    {#if data?.holding}
      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 text-[var(--color-warning-text)]"
        role="status"
        data-testid="kata-holding"
      >
        <a class="font-semibold underline" href={kataDetailHref(data.holding.kata_id)}>
          {holdingSentence(data.holding, now)}
        </a>
        {#if holdingStoppable}
          {#if stopConfirm}
            <span class="flex items-center gap-2 text-sm">
              Stop this kata? It fails the kata and archives its project; it KEEPS the cord until you press Release on its page.
              <button
                type="button"
                class="px-3 py-1 rounded border border-[var(--color-danger-border)] text-[var(--color-danger)] disabled:opacity-50"
                disabled={stopBusy}
                onclick={() => doStop(data!.holding!.kata_id)}
                data-testid="kata-holding-stop-confirm">{stopBusy ? '…' : 'Yes, stop'}</button
              >
              <button type="button" class="px-3 py-1 rounded border" disabled={stopBusy} onclick={() => (stopConfirm = false)}
                >Cancel</button
              >
            </span>
          {:else}
            <button
              type="button"
              class="px-3 py-1 text-sm rounded border border-[var(--color-danger-border)] text-[var(--color-danger)]"
              onclick={() => (stopConfirm = true)}
              data-testid="kata-holding-stop">Stop</button
            >
          {/if}
        {/if}
      </div>
      {#if stopError}
        <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="kata-holding-stop-error">{stopError}</p>
      {/if}
    {:else if data}
      <p class="text-sm text-[var(--color-success)]" data-testid="kata-not-holding">No kata holds the cord.</p>
    {/if}
    {#if data && data.failed_holders.length > 0}
      <ul
        class="space-y-1 rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger)]"
        role="alert"
        data-testid="kata-failed-holders"
      >
        {#each data.failed_holders as fid (fid)}
          <li>
            <a class="font-semibold underline" href={kataDetailHref(fid)}>Kata {fid.slice(0, 8)}</a>
            — failed — super-admin release required (the conveyor stays paused until you press Release on its page)
          </li>
        {/each}
      </ul>
    {/if}

    {#if data}
      <table class="text-sm" data-testid="kata-stats">
        <thead class="text-left text-xs uppercase text-[var(--color-text-muted)]">
          <tr>
            <th class="pr-6"></th>
            {#each statCols as c (c.key)}<th class="pr-6">{c.label}</th>{/each}
            <th class="pr-6">Conveyor paused</th>
          </tr>
        </thead>
        <tbody>
          {#each statRows as row (row.label)}
            {@const s = row.s}
            {@const label = row.label}
            <tr>
              <td class="pr-6 font-medium">{label}</td>
              {#each statCols as c (c.key)}<td class="pr-6">{s[c.key]}</td>{/each}
              <td class="pr-6">{formatSeconds(s.paused_seconds)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if showNew}
    <form class="rounded-[var(--radius-md)] border p-4 space-y-3" onsubmit={submitNew} data-testid="kata-new-form">
      <h2 class="text-lg font-semibold">Open a kata by hand</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        This sends the symptom to the conveyor coach, which gathers the evidence and opens the kata the same way
        it does for an automatic block. The kata appears in the list once the coach has opened it.
      </p>
      <div class="grid gap-3 md:grid-cols-2">
        <label class="block text-sm">
          <span class="block mb-1">Workspace</span>
          <Combobox
            options={tenantOptions}
            bind:value={fTenant}
            emptyLabel="Pick a workspace…"
            onSelect={(v) => {
              fProject = null;
              void loadFormProjects(v);
            }}
            data-testid="kata-new-tenant"
          />
        </label>
        <label class="block text-sm">
          <span class="block mb-1">Project</span>
          <Combobox
            options={fProjects}
            bind:value={fProject}
            emptyLabel={fTenant ? 'Pick a project…' : 'Pick a workspace first'}
            disabled={!fTenant}
            data-testid="kata-new-project"
          />
          {#if fProjectsError}<span class="text-xs text-[var(--color-danger)]">{fProjectsError}</span>{/if}
        </label>
        <label class="block text-sm">
          <span class="block mb-1">Card id</span>
          <input class="w-full rounded border px-2 py-1 bg-[var(--color-surface)]" bind:value={fCard} data-testid="kata-new-card" />
        </label>
        <label class="block text-sm">
          <span class="block mb-1">Execution id <span class="text-[var(--color-text-muted)]">(optional — else the card's latest)</span></span>
          <input class="w-full rounded border px-2 py-1 bg-[var(--color-surface)]" bind:value={fExecution} data-testid="kata-new-execution" />
        </label>
      </div>
      <label class="block text-sm">
        <span class="block mb-1">Symptom</span>
        <textarea
          class="w-full rounded border px-2 py-1 bg-[var(--color-surface)]"
          rows="4"
          bind:value={fSymptom}
          data-testid="kata-new-symptom"
        ></textarea>
      </label>
      {#if fErrors.length}
        <ul class="text-sm text-[var(--color-danger)] list-disc pl-5" role="alert">
          {#each fErrors as e (e)}<li>{e}</li>{/each}
        </ul>
      {/if}
      {#if fError}
        <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="kata-new-error">{fError}</p>
      {/if}
      {#if fRequested}
        <p class="text-sm text-[var(--color-warning-text)]" role="status" data-testid="kata-new-requested">
          Requested — sent to the conveyor coach at {new Date(fRequested.at).toLocaleTimeString()} (project
          {projectLabel(fRequested.project)}, card {fRequested.card}). No kata exists yet: it appears in the list
          below once the coach opens it.
        </p>
      {/if}
      <button
        type="submit"
        class="px-3 py-1 text-sm rounded border hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        disabled={fBusy}
        data-testid="kata-new-submit">{fBusy ? 'Sending…' : 'Send to the coach'}</button
      >
    </form>
  {/if}

  <section class="space-y-3">
    <div class="flex flex-wrap items-end gap-4">
      <label class="text-sm">
        <span class="block mb-1">State</span>
        <select class="rounded border px-2 py-1 bg-[var(--color-surface)]" bind:value={stateFilter} onchange={onFilterChange} data-testid="kata-filter-state">
          <option value="">All</option>
          {#each KATA_STATES as s (s)}<option value={s}>{KATA_STATE_LABEL[s]}</option>{/each}
        </select>
      </label>
      <label class="text-sm">
        <span class="block mb-1">Project</span>
        <select class="rounded border px-2 py-1 bg-[var(--color-surface)]" bind:value={projectFilter} onchange={onFilterChange} data-testid="kata-filter-project">
          <option value="">All</option>
          {#each projectFilterOptions as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </select>
      </label>
    </div>

    {#if loadError}
      <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="kata-load-error">
        {data ? 'Refresh failed — showing the last good read: ' : 'Failed to load: '}{loadError}
      </p>
    {/if}

    {#if !data && !loadError}
      <p class="text-sm text-[var(--color-text-muted)]" role="status">Loading…</p>
    {:else if data && data.items.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="kata-empty">
        {stateFilter || projectFilter ? 'No kata matches these filters.' : 'No kata has been opened yet.'}
      </p>
    {:else if data}
      <table class="w-full border rounded text-sm" data-testid="kata-list">
        <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)]">
          <tr>
            <th class="p-3">State</th>
            <th class="p-3">Source</th>
            <th class="p-3">Symptom</th>
            <th class="p-3">Target flow · root cause</th>
            <th class="p-3">Replays</th>
            <th class="p-3">Cord held</th>
            <th class="p-3">Opened</th>
          </tr>
        </thead>
        <tbody>
          {#each data.items as k (k.id)}
            <tr class="border-t align-top" data-testid="kata-row">
              <td class="p-3">
                <a href={kataDetailHref(k.id)} class="inline-block rounded border px-2 py-0.5 text-xs font-semibold {KATA_TONE_CHIP[KATA_STATE_TONE[k.state]]}">
                  {KATA_STATE_LABEL[k.state]}
                </a>
                {#if k.state === 'failed' && k.cord.held}
                  <span class="mt-1 block rounded border px-2 py-0.5 text-xs {KATA_TONE_CHIP.danger}" data-testid="kata-row-failed-holding"
                    >holding — release required</span
                  >
                {/if}
                {#if rollbackPending(k)}
                  <span class="mt-1 block rounded border px-2 py-0.5 text-xs {KATA_TONE_CHIP.warn}" data-testid="kata-row-rollback-pending"
                    >rollback pending</span
                  >
                {/if}
                {#if rollbackRefusedLabel(k)}
                  <span class="mt-1 block rounded border px-2 py-0.5 text-xs {KATA_TONE_CHIP.danger}" data-testid="kata-row-rollback-refused"
                    >{rollbackRefusedLabel(k)}</span
                  >
                {/if}
              </td>
              <td class="p-3 text-xs">
                <a class="underline" href={projectHref(k.source_project_id)}>{projectLabel(k.source_project_id)}</a>
                {#if k.source_card_id}
                  <br /><a class="underline" href={cardHref(k.source_card_id)}>card {k.source_card_id}</a>
                {/if}
              </td>
              <td class="p-3"><a class="hover:underline" href={kataDetailHref(k.id)}>{oneLine(k.symptom)}</a></td>
              <td class="p-3 text-xs">
                {k.target_flow ?? '—'}<br /><span class="text-[var(--color-text-muted)]">{k.root_cause_class ?? '—'}</span>
              </td>
              <td class="p-3 text-xs">{replaysLabel(k)}</td>
              <td class="p-3 text-xs">
                {formatSeconds(cordHeldSeconds(k, now))}{k.cord.held ? ' (holding)' : ''}
              </td>
              <td class="p-3 text-xs text-[var(--color-text-muted)]">
                {k.opened_by}<br />{new Date(k.opened_at).toLocaleString()}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</section>
