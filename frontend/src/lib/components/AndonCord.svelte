<!--
  AndonCord.svelte — header-level global andon-cord control + indicator.

  ONE button. ONE click. The cord is a global safety switch: pulling it
  scales the `n8n/n8n-worker` Deployment to 0, which stops every automatic
  n8n execution across every workspace until a super-admin disengages it.

  Backend: migration 065 + 226, GET /api/andon, POST /api/andon/{engage,disengage}.

  Visible to everyone (visibility is the point of an andon).
  Clickable only for super-admin — single click toggles, no modal, no
  reason field. Click logs the actor on the server side; that's the
  audit trail.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    andonStateLabel,
    andonTitle,
    pullFeedback,
    type AndonFeedback,
    type AndonGlobalState,
    type AndonToggleResult,
  } from './andon-cord-helpers';

  let andon = $state<AndonGlobalState | null>(null);
  // The 30 s GET poll failed. Owned entirely by load(): cleared at the top of
  // every attempt, so it always describes the MOST RECENT read.
  let loadError = $state<string | null>(null);
  // The operator's own engage/disengage was refused (403/500/transport).
  // Deliberately a SEPARATE field from loadError rather than sharing one:
  // load() blanks its error at the top of every poll, so a shared field would
  // erase the refusal within 30 s — the GET stays 200 for everyone while only
  // the POST is forbidden, so nothing would remain to say the stop never
  // happened. This clears only when a later toggle succeeds.
  let toggleError = $state<string | null>(null);
  // What the inline alert renders. A refused operator action outranks a failed
  // background read — the operator is waiting on the former.
  const refusal = $derived(toggleError ?? loadError);
  let busy = $state(false);
  // Result of the last pull, surfaced inline (e.g. "execution STOPPED
  // (n8n-worker scaled to 0)" or a partial-failure warning). Cleared when the
  // polled engaged-state changes out from under it (e.g. another super-admin
  // toggled in another tab), and whenever a toggle FAILS — a refused toggle
  // leaves the server state unchanged, so the previous pull's line would
  // otherwise stay pinned beside a button that now contradicts it.
  let lastFeedback = $state<AndonFeedback | null>(null);

  const POLL_MS = 30_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<void> {
    if (!auth.isAuthenticated) return;
    loadError = null;
    try {
      const r = await authFetch('/api/andon');
      if (!r.ok) {
        loadError = `status ${r.status}`;
        return;
      }
      const next = (await r.json()) as AndonGlobalState;
      // Drop stale pull feedback if the cord flipped elsewhere.
      if (andon && andon.engaged !== next.engaged) lastFeedback = null;
      andon = next;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'load failed';
    }
  }

  // Hydrate on auth, then poll so a pull from another tab/session
  // reflects within POLL_MS.
  $effect(() => {
    if (auth.isAuthenticated) {
      void load();
    } else {
      andon = null;
    }
  });

  onMount(() => {
    pollTimer = setInterval(() => {
      if (auth.isAuthenticated) void load();
    }, POLL_MS);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  async function toggle(): Promise<void> {
    if (!auth.isSuperAdmin || !andon || busy) return;
    const engaging = !andon.engaged;
    // ⛔ ONE CLICK, NO MODAL (owner ruling 2026-05-18, re-confirmed 2026-11-02).
    // An andon is a safety control: friction is the wrong default because it slows
    // the pull. There was a `confirm()` here — it contradicted both that ruling and
    // the header comment on this file. The actor is recorded server-side; the
    // consequence of a pull (every n8n execution stops, manual test runs included)
    // is stated in the button tooltip and on /admin/andon, not in a dialog.
    busy = true;
    const path = engaging ? '/api/andon/engage' : '/api/andon/disengage';
    try {
      const r = await authFetch(path, { method: 'POST' });
      if (!r.ok) {
        // The server refused. `andon` is deliberately NOT touched, so the
        // button keeps its pre-toggle state — but the stale feedback line from
        // the LAST successful pull must go, or it describes a state we did not
        // reach. (The poll's own clearing condition compares engaged-flags and
        // cannot fire here: nothing changed server-side.)
        toggleError = `toggle failed: status ${r.status}`;
        lastFeedback = null;
        return;
      }
      const result = (await r.json()) as AndonToggleResult;
      andon = result;
      lastFeedback = pullFeedback(engaging ? 'engage' : 'disengage', result);
      toggleError = null;
      loadError = null;
    } catch (err) {
      toggleError = err instanceof Error ? err.message : 'request failed';
      lastFeedback = null;
    } finally {
      busy = false;
    }
  }

  function formatDuration(fromIso: string | null): string {
    if (!fromIso) return '';
    const since = new Date(fromIso).getTime();
    if (Number.isNaN(since)) return '';
    const mins = Math.max(0, Math.round((Date.now() - since) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
  }
</script>

{#if andon}
  <!-- `andon?.` on purpose: `andon` is set to null on sign-out (the $effect
       above) and Svelte 5 can re-evaluate these @consts / attributes with the
       null value before this `{#if}` tears down. -->
  <!-- ⚠️ `?? null` (not `|| 0`): an unmeasured replica count stays null and the
       label then claims nothing about the worker. -->
  {@const engaged = andon?.engaged === true}
  {@const workerReplicas = andon?.worker_replicas ?? null}
  {@const clickable = auth.isSuperAdmin}
  <button
    type="button"
    onclick={clickable ? toggle : undefined}
    disabled={!clickable || busy}
    data-testid="andon-cord-button"
    data-engaged={engaged ? 'true' : 'false'}
    aria-label={engaged
      ? `${andonStateLabel(true, workerReplicas)} — andon engaged`
      : `${andonStateLabel(false, workerReplicas)} — pull to stop`}
    title={andon ? andonTitle(andon, formatDuration(andon.engaged_at)) : ''}
    class="inline-flex h-10 max-w-[12rem] shrink-0 items-center gap-2 truncate rounded-[var(--radius-md)] border px-3 text-sm font-semibold text-[var(--color-on-primary)] transition-colors disabled:cursor-default"
    class:bg-[var(--color-success)]={!engaged}
    class:border-[var(--color-success)]={!engaged}
    class:hover:bg-[var(--color-success-text)]={!engaged && clickable}
    class:animate-pulse={engaged}
    class:bg-[var(--color-danger)]={engaged}
    class:border-[var(--color-danger-border)]={engaged}
    class:ring-2={engaged}
    class:ring-[var(--color-danger-border)]={engaged}
    class:hover:bg-[var(--color-danger-text)]={engaged && clickable}
  >
    <span aria-hidden="true">{engaged ? '🛑' : '▶'}</span>
    <!-- D2: says what it covers — every project, never just the one on screen.
         The worker fact rides along only when it contradicts the cord word, so a
         released cord whose worker is still at 0 never reads as "running". -->
    <span data-testid="andon-cord-label">{andonStateLabel(engaged, workerReplicas)}</span>
  </button>
  {#if refusal}
    <!--
      The refusal path. Until this existed the `{:else if loadError}` arm below
      was the ONLY renderer of an error, and it is reachable only while `andon`
      is null — i.e. signed out. So once the cord had loaded, a 403/500 on
      engage/disengage (and every failed 30 s poll) rendered NOTHING: the button
      stayed green after the operator confirmed a system-wide stop.
      role="alert" so the refusal is announced, not just drawn.
    -->
    <span
      class="inline-flex h-10 max-w-xs items-center truncate rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-2 text-xs font-semibold text-[var(--color-danger-text)]"
      title={refusal}
      data-testid="andon-cord-toggle-error"
      role="alert"
    >
      ⚠ Andon: {refusal}
    </span>
  {/if}
  {#if lastFeedback}
    <!-- SHORT chip, full sentence in the tooltip. This used to render the whole
         sentence with `max-w-xs truncate`, which both ate the navigation and cut
         it mid-word — the worst of both. The detail lives on /admin/andon. -->
    <span
      class="inline-flex h-10 max-w-[8.5rem] items-center truncate rounded-[var(--radius-md)] border px-2 text-xs"
      class:border-[var(--color-success)]={lastFeedback.tone === 'ok'}
      class:text-[var(--color-success)]={lastFeedback.tone === 'ok'}
      class:border-[var(--color-danger-border)]={lastFeedback.tone === 'warn'}
      class:text-[var(--color-danger)]={lastFeedback.tone === 'warn'}
      title={lastFeedback.text}
      data-testid="andon-cord-feedback"
      data-tone={lastFeedback.tone}
      role={lastFeedback.tone === 'warn' ? 'alert' : 'status'}
    >
      {lastFeedback.tone === 'ok' ? (andon?.engaged ? '🛑 Stopped' : '✓ Released') : '⚠ Check /admin/andon'}
    </span>
  {/if}
{:else if refusal}
  <!-- Signed-out / never-loaded fallback: there is no button to sit beside, so
       the whole control collapses to this placeholder. -->
  <span
    class="inline-flex h-10 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-text-muted)]"
    title={refusal}
    data-testid="andon-cord-error"
  >
    cord: ?
  </span>
{/if}
