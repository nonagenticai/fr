<!--
  /admin/andon — Super-admin andon-cord control.

  Engage / disengage the cord on every project. Super-admin only.
  Backend enforces via requireSuperAdmin (returns 403); the FE also hides
  the link from non-super-admins.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { authFetch } from '$lib/api/auth-fetch';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    summary,
    totalEngaged,
    formatEngagedAt,
    globalCordStatus,
    andonHistoryLabel,
    inflightLabel,
    ANDON_TONE_SURFACE,
    ANDON_TONE_TEXT,
    type AndonState,
    type AndonGlobalState,
    type AndonHistoryEntry,
    type AndonInflight,
  } from './page-helpers';
  import {
    confirmEngageMessage,
    confirmDisengageMessage,
    pullFeedback,
    andonTitle,
    type AndonToggleResult,
    type AndonFeedback,
  } from '$lib/components/andon-cord-helpers';

  let andonState = $state<AndonState | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<string | null>(null);

  // GLOBAL cord (the hard system-wide stop) — loaded + toggled independently of
  // the per-scope tables so a failure of one never takes down the other.
  let globalAndon = $state<AndonGlobalState | null>(null);
  let globalBusy = $state(false);
  let globalError = $state<string | null>(null);
  let globalFeedback = $state<AndonFeedback | null>(null);

  // GLOBAL cord audit trail (last 50 flips). Loaded independently of the panel
  // above and the per-scope tables — a read-only accountability view of who
  // pulled the system-wide stop and when.
  let history = $state<AndonHistoryEntry[] | null>(null);
  let historyError = $state<string | null>(null);

  // In-flight n8n execution drain (only meaningful while engaged). Loaded
  // independently; refreshable so an operator can watch the drain finish.
  let inflight = $state<AndonInflight | null>(null);
  let inflightBusy = $state(false);

  // The released global panel must not say "All automation active" while the
  // per-surface tables below report engaged cords — pass the measured count so
  // it states both facts. `null` while the per-scope read is missing/failed.
  const gStatus = $derived(
    globalCordStatus(globalAndon, andonState ? totalEngaged(andonState) : null),
  );
  const inflightStatus = $derived(inflightLabel(inflight));

  async function loadInflight(): Promise<void> {
    inflightBusy = true;
    try {
      const r = await authFetch('/api/andon/inflight');
      if (!r.ok) throw new Error(`status ${r.status}`);
      const body = (await r.json()) as AndonInflight & { n8n_error?: string | null };
      // A reachable endpoint that could not reach n8n returns running_count:null
      // — inflightLabel renders that as "unavailable", so just store the shape.
      inflight = { running_count: body.running_count, capped: body.capped };
    } catch {
      inflight = { running_count: null, capped: false };
    } finally {
      inflightBusy = false;
    }
  }

  // `?live=1` asks the backend to additionally run its bounded n8n probe, which
  // is what lets this panel say "verified" rather than merely "fr thinks so".
  // It is deliberately requested HERE and not in the header cord
  // (`AndonCord.svelte`): that component polls every 30 s for every signed-in
  // user, and the probe is gated to super-admin server-side precisely so a
  // shared poll can never fan out to n8n. This page is super-admin-only (see
  // the onMount redirect) and loads on demand.
  async function loadGlobal(): Promise<void> {
    globalError = null;
    try {
      const r = await authFetch('/api/andon?live=1');
      if (!r.ok) throw new Error(`status ${r.status}`);
      globalAndon = (await r.json()) as AndonGlobalState;
    } catch (err) {
      globalError = err instanceof Error ? err.message : 'load failed';
    }
  }

  async function loadHistory(): Promise<void> {
    historyError = null;
    try {
      const r = await authFetch('/api/andon/history');
      if (!r.ok) throw new Error(`status ${r.status}`);
      history = ((await r.json()) as { history: AndonHistoryEntry[] }).history;
    } catch (err) {
      historyError = err instanceof Error ? err.message : 'load failed';
    }
  }

  async function loadScopes(): Promise<void> {
    loadError = null;
    try {
      const r = await authFetch('/api/admin/andon');
      if (!r.ok) throw new Error(`status ${r.status}`);
      andonState = (await r.json()) as AndonState;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'load failed';
    }
  }

  async function load(): Promise<void> {
    loading = true;
    // Independent reads in parallel — neither blocks the other.
    await Promise.all([loadScopes(), loadGlobal(), loadHistory(), loadInflight()]);
    loading = false;
  }

  async function toggleGlobal(): Promise<void> {
    if (!auth.isSuperAdmin || !globalAndon || globalBusy) return;
    const engaging = !globalAndon.engaged;
    const proceed = confirm(
      engaging ? confirmEngageMessage() : confirmDisengageMessage(),
    );
    if (!proceed) return;

    globalBusy = true;
    const path = engaging ? '/api/andon/engage' : '/api/andon/disengage';
    try {
      const r = await authFetch(path, { method: 'POST' });
      if (!r.ok) {
        globalError = `toggle failed: status ${r.status}`;
        return;
      }
      const result = (await r.json()) as AndonToggleResult;
      globalAndon = result;
      globalFeedback = pullFeedback(engaging ? 'engage' : 'disengage', result);
      globalError = null;
      // Refresh the in-flight drain: an engage just stopped NEW runs, so show
      // how many executions are still draining; a disengage clears it.
      void loadInflight();
    } catch (err) {
      globalError = err instanceof Error ? err.message : 'request failed';
    } finally {
      globalBusy = false;
    }
  }

  async function toggle(
    kind: 'project',
    id: string,
    name: string,
    currentlyEngaged: boolean,
  ): Promise<void> {
    const action = currentlyEngaged ? 'DISENGAGE' : 'ENGAGE';
    const verb = currentlyEngaged ? 'disengage' : 'engage';
    if (
      !confirm(
        `Are you sure? This will ${action} the andon cord on ${kind} "${name}".`,
      )
    )
      return;
    busy = `${kind}:${id}`;
    try {
      const path = `/api/projects/${id}/andon/${verb}`;
      const r = await authFetch(path, { method: 'POST' });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`status ${r.status}: ${body.slice(0, 120)}`);
      }
      await load();
    } catch (err) {
      alert(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      busy = null;
    }
  }

  onMount(() => {
    if (!auth.isSuperAdmin) {
      void goto('/');
      return;
    }
    void load();
  });
</script>

<section class="p-6 space-y-6" data-testid="settings-admin-andon">
  <header class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold">🛑 Andon cord — emergency halt</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Stop every automated loop on a project.
      </p>
    </div>
    {#if andonState}
      <p class="text-sm text-[var(--color-text-muted)]">{summary(andonState)}</p>
    {/if}
  </header>

  <!--
    GLOBAL cord — the hard system-wide stop (scales the n8n-worker Deployment
    to 0 + freezes all new work). It is the most powerful switch, so it sits
    at the top, above the per-scope tables. Loaded + toggled independently of the
    per-project view. Reuses the header cord's confirm/feedback helpers.
  -->
  <!--
    ⚠️ The three tone-driven class attributes in this panel — the section
    surface, the headline label, and the verification line — used to be written
    as two-armed ternaries testing for 'ok' and falling through to the danger
    classes. `globalCordStatus` returns THREE tones, so `warn` landed in that
    fall-through: an "⚠ UNKNOWN" cord (state never read) rendered
    pixel-identical to CONTRADICTED, a MEASURED live contradiction. Three states
    the code computes, two states an operator could see.
    ⛔ All three now index ANDON_TONE_SURFACE / ANDON_TONE_TEXT (page-helpers.ts),
    which are keyed on the tone union itself, so a tone with no class is a type
    error rather than a silent red. To check that this still holds, grep this
    file for ANDON_TONE_ — exactly three class attributes in this panel use it
    (plus the two imports), and no class attribute in this panel may branch on a
    tone any other way. (The ternaries further down — inflight, pull feedback,
    history row — are over types with exactly TWO members, so nothing can hide
    in their fall-through arm; re-read `inflightLabel`, `FeedbackTone` and
    `andonHistoryLabel` before assuming a third value is safe there.)
  -->
  <section
    data-testid="andon-global"
    class="rounded-[var(--radius-md)] border p-4 {ANDON_TONE_SURFACE[gStatus.tone]}"
  >
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">
          Global andon cord — system-wide hard stop
        </h2>
        <p
          class="mt-1 font-semibold {ANDON_TONE_TEXT[gStatus.tone]}"
          title={globalAndon ? andonTitle(globalAndon) : ''}
          data-testid="andon-global-status"
        >
          {gStatus.label}
        </p>
        <p class="mt-1 text-sm text-[var(--color-text-muted)]">{gStatus.detail}</p>
        <!--
          VERIFICATION — the second, independent line. `detail` says what fr
          INTENDED; this says what actually checked it. It renders for every
          engaged variant (and for an unreadable cord), not only when the page
          believes the cord is down, because the dangerous case is precisely the
          one where fr is confident and n8n disagrees. It also renders when the
          cord state was never read at all (`globalAndon === null` — the ⚠ UNKNOWN
          branch), where it says that nothing has been checked rather than
          nothing needed checking. `null` only for a released cord, where there
          is no halt to verify.
        -->
        {#if gStatus.verification}
          <p
            class="mt-1 text-sm {ANDON_TONE_TEXT[gStatus.verification.tone]}"
            data-testid="andon-global-verification"
          >
            {gStatus.verification.text}
          </p>
        {/if}
        {#if (globalAndon?.kata_holders ?? []).length > 0}
          <p class="mt-1 text-sm text-[var(--color-warning-text)]" data-testid="andon-global-kata-holders">
            Held by {globalAndon?.kata_holders?.length} kata{globalAndon?.kata_holders?.length === 1 ? '' : 's'} — n8n-worker
            stays at 0 until the last one releases:
            {#each globalAndon?.kata_holders ?? [] as kataId, i (kataId)}{i > 0 ? ', ' : ' '}<a
                class="underline"
                href={`/admin/kata/${encodeURIComponent(kataId)}`}>{kataId}</a
              >{/each}
          </p>
        {/if}
        {#if globalAndon?.engaged}
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">
            Engaged by {globalAndon.engaged_by ?? '—'} · {formatEngagedAt(
              globalAndon.engaged_at,
            )}
          </p>
          <!--
            In-flight drain: scaling the worker to 0 stops NEW runs immediately
            (SIGTERM stops job pickup), but an already-running execution is left
            to finish on its own (this cord does not stop executions; n8n 2.46.1
            HAS a stop-execution endpoint, deliberately unused). Show how
            many are still draining so the operator knows when the system is
            fully quiet.
          -->
          <p
            class="mt-2 text-sm {inflightStatus.tone === 'warn'
              ? 'text-[var(--color-danger)] dark:text-[var(--color-danger-text)]'
              : 'text-[var(--color-success)]'}"
            data-testid="andon-inflight"
          >
            {inflightStatus.text}
            <button
              class="ml-2 text-xs underline hover:no-underline disabled:opacity-50"
              disabled={inflightBusy}
              onclick={loadInflight}
              data-testid="andon-inflight-refresh"
            >
              {inflightBusy ? 'refreshing…' : 'refresh'}
            </button>
          </p>
        {/if}
      </div>
      <button
        class="shrink-0 px-3 py-1 text-sm rounded border hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        disabled={!auth.isSuperAdmin || globalBusy || !globalAndon}
        onclick={toggleGlobal}
        data-testid="andon-global-toggle"
      >
        {globalBusy
          ? '…'
          : globalAndon?.engaged
            ? 'Disengage'
            : 'Engage'}
      </button>
    </div>

    {#if globalFeedback}
      <p
        class="mt-3 text-sm {globalFeedback.tone === 'warn'
          ? 'text-[var(--color-danger)]'
          : 'text-[var(--color-success)]'}"
        role="status"
        data-testid="andon-global-feedback"
      >
        {globalFeedback.text}
      </p>
    {/if}
    {#if globalError}
      <p class="mt-3 text-sm text-[var(--color-danger)]" role="alert">
        {globalError}
      </p>
    {/if}
  </section>

  <!--
    GLOBAL cord audit history — who pulled / released the system-wide stop and
    when (last 50 flips, newest first). Read-only accountability view. Loaded
    independently; a failure here never affects the cord controls above.
    NOTE: release rows have no actor (the backend nulls engaged_by on release),
    so "By" shows an em-dash for releases.
  -->
  <section data-testid="andon-global-history" class="space-y-2">
    <h2 class="text-lg font-semibold">Global cord — audit history</h2>
    {#if historyError}
      <p class="text-sm text-[var(--color-danger)]" role="alert">
        Failed to load history: {historyError}
      </p>
    {:else if !history || history.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">
        No global cord activity yet.
      </p>
    {:else}
      <table class="w-full border rounded text-sm">
        <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)]">
          <tr>
            <th class="p-3">Event</th>
            <th class="p-3">By</th>
            <th class="p-3">When</th>
          </tr>
        </thead>
        <tbody>
          {#each history as h (h.id)}
            {@const hl = andonHistoryLabel(h)}
            <tr class="border-t" data-testid="andon-history-row">
              <td class="p-3 font-medium">
                <span
                  class={hl.tone === 'danger'
                    ? 'text-[var(--color-danger)] dark:text-[var(--color-danger-text)]'
                    : 'text-[var(--color-success)]'}
                >
                  {hl.label}
                </span>
              </td>
              <td class="p-3 text-xs text-[var(--color-text-muted)]">{h.changed_by ?? '—'}</td>
              <td class="p-3 text-xs text-[var(--color-text-muted)]">{formatEngagedAt(h.changed_at)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <p
    class="rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 text-sm text-[var(--color-warning-text)] dark:bg-[var(--color-warning-bg-deep)]/30 dark:border-[var(--color-warning-text)] dark:text-[var(--color-warning-text)]"
  >
    Engaging a per-project cord halts the scheduled-trigger
    tick, scheduled-report dispatch, and the suggestion-detection heuristic
    on that target — an fr-side stop scoped to that surface. For a hard
    system-wide halt that also <strong>scales the n8n-worker Deployment to 0
    replicas</strong> (stopping all automatic execution) and freezes all new
    work everywhere, use the global andon cord at the top of this page (also
    in the header). Use either only when something is misbehaving and a human
    needs to stop it.
  </p>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]" role="status">Loading…</p>
  {:else if loadError}
    <div
      class="rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4 text-sm text-[var(--color-danger)]"
      role="alert"
    >
      Failed to load: {loadError}
    </div>
  {:else if andonState}
    {@const numEngaged = totalEngaged(andonState)}
    {#if numEngaged > 0}
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4 dark:bg-[var(--color-danger-bg-deep)]/30"
        role="alert"
      >
        <p class="font-semibold text-[var(--color-danger-text)] dark:text-[var(--color-danger-text)]">
          🛑 {numEngaged} surface{numEngaged === 1 ? '' : 's'} currently halted
        </p>
      </div>
    {/if}

    <section data-testid="andon-projects">
      <h2 class="text-lg font-semibold mb-2">Projects ({andonState.projects.length})</h2>
      {#if andonState.projects.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No projects yet.</p>
      {:else}
        <table class="w-full border rounded text-sm">
          <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)]">
            <tr>
              <th class="p-3">Name</th>
              <th class="p-3">Shape</th>
              <th class="p-3">State</th>
              <th class="p-3">Engaged at</th>
              <th class="p-3">By</th>
              <th class="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each andonState.projects as p (p.id)}
              <tr
                class="border-t"
                class:bg-[var(--color-danger-bg)]={p.andon_engaged}
                class:dark:bg-[var(--color-danger-bg-deep)]={p.andon_engaged}
                data-testid="andon-project-row"
              >
                <td class="p-3 font-medium">{p.name}</td>
                <td class="p-3 text-xs">{p.shape}</td>
                <td class="p-3">
                  {#if p.andon_engaged}
                    <span class="text-[var(--color-danger)] dark:text-[var(--color-danger-text)] font-semibold">🛑 ENGAGED</span>
                  {:else}
                    <span class="text-[var(--color-success)] dark:text-[var(--color-success)]">✓ running</span>
                  {/if}
                </td>
                <td class="p-3 text-xs text-[var(--color-text-muted)]">{formatEngagedAt(p.andon_engaged_at)}</td>
                <td class="p-3 text-xs text-[var(--color-text-muted)]">{p.andon_engaged_by ?? '—'}</td>
                <td class="p-3 text-right">
                  <button
                    class="px-3 py-1 text-sm rounded border hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
                    disabled={busy === `project:${p.id}`}
                    onclick={() => toggle('project', p.id, p.name, p.andon_engaged)}
                    data-testid="andon-project-toggle"
                  >
                    {busy === `project:${p.id}`
                      ? '…'
                      : p.andon_engaged
                        ? 'Disengage'
                        : 'Engage'}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}
</section>
