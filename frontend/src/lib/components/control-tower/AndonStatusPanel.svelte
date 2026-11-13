<script lang="ts">
  // Global andon panel from the `andon` block + THE one wired mutation. Reads
  // state from the read model (AndonSnapshot); the Pull/Release button POSTs to
  // the existing super-admin routes (POST /api/andon/{engage,disengage}, no
  // body) behind a confirm dialog, then asks the page to re-read server truth
  // (onToggled → refresh) — never client-only engaged state.
  import { isAvailable, type Block } from '$lib/types/read-model';
  import type { AndonSnapshot } from '$lib/types/control-tower';
  import { engageGlobalAndon, disengageGlobalAndon } from '$lib/api/control-tower';
  import {
    andonReleaseVerdict,
    confirmEngageMessage,
    confirmDisengageMessage,
    pullFeedback,
    workerReplicasLabel,
    type AndonFeedback,
    type AndonReleaseVerdict,
  } from '$lib/components/andon-cord-helpers';
  import { formatAndonDuration } from './andon-duration';
  import BlockUnavailable from '$lib/components/blocks/BlockUnavailable.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';

  interface Props {
    block: Block<AndonSnapshot>;
    /** Re-read the read model after a successful toggle. */
    onToggled: () => Promise<void> | void;
  }
  let { block, onToggled }: Props = $props();

  const snapshot = $derived(isAvailable(block) ? block.data : null);
  const engaged = $derived(snapshot?.global_engaged ?? false);

  let confirmOpen = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let feedback = $state<AndonFeedback | null>(null);

  // ⭐ HOW THE LAST RELEASE WENT, from the backend's AUTHORITATIVE
  // `release_status` — not re-derived from counts here or in the helper.
  //
  // ⚠️ It must be its own field rather than folded into `engaged`. A
  // `released_incomplete` cord IS released (`engaged: false`,
  // `fr_andon_engaged: 0`), so the header tag flips to RELEASED the instant the
  // POST returns — which is precisely the moment the operator needs to be told
  // that the worker scale-up was NOT confirmed. The brake being off and the
  // estate being back are two propositions; this renders the second one.
  //
  // `null` = no release has happened on this page view, so nothing is claimed.
  let releaseVerdict = $state<AndonReleaseVerdict | null>(null);
  let releaseDetail = $state<string | null>(null);
  const releaseAlarm = $derived(releaseVerdict === 'incomplete' || releaseVerdict === 'unknown');

  const confirmText = $derived(
    engaged ? confirmDisengageMessage() : confirmEngageMessage(),
  );

  function askConfirm(): void {
    error = null;
    confirmOpen = true;
  }

  async function apply(): Promise<void> {
    busy = true;
    error = null;
    // Captured BEFORE the await: `engaged` is $derived from the snapshot, and
    // `onToggled()` re-reads it, so reading it afterwards describes the state we
    // moved TO rather than the action we took.
    const releasing = engaged;
    try {
      const result = releasing ? await disengageGlobalAndon() : await engageGlobalAndon();
      feedback = pullFeedback(releasing ? 'disengage' : 'engage', result);
      // An ENGAGE says nothing about a release, so it clears the banner rather
      // than leaving the previous release's verdict pinned beside a pulled cord.
      releaseVerdict = releasing ? andonReleaseVerdict(result) : null;
      // The error the release scale reported, so the banner below can name WHY
      // the scale-up was not confirmed instead of a bare "incomplete".
      releaseDetail = releasing ? (result.worker_scale_error ?? null) : null;
      confirmOpen = false;
      await onToggled();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="rounded-lg border {engaged ? 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]' : 'border-[var(--color-border)] bg-[var(--color-surface)]'}"
  data-testid="andon-panel"
>
  <header class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
    <div>
      <h2 class="text-sm font-semibold text-[var(--color-text)]">Global andon</h2>
      <p class="text-xs text-[var(--color-text-muted)]">Fleet-wide emergency stop for all automation.</p>
    </div>
    <!--
      ⛔ The tag stays a statement about THE CORD only — 'STOPPED' / 'RELEASED' —
      and must NOT be repainted by a failed scale-up. backend andon.ts is
      explicit that "is the cord pulled" and "is the worker back" are two
      propositions with two publishers and neither may be folded into the other;
      a `released_incomplete` cord genuinely IS released (`engaged:false`,
      `fr_andon_engaged:0`). The worker proposition gets its own line below.

      ⚠️ 'RELEASED', not 'Running': the card no longer claims a running line,
      because a released cord can still have n8n-worker at 0 (the body below
      says so explicitly).
    -->
    {#if snapshot}
      <Tag tone={engaged ? 'danger' : 'success'} dot>{engaged ? 'STOPPED' : 'RELEASED'}</Tag>
    {/if}
  </header>

  {#if isAvailable(block) && snapshot}
    <div class="flex flex-col gap-3 p-4">
      {#if engaged}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-[var(--color-text-muted)]">Engaged by</dt>
          <dd class="text-[var(--color-text)]">{snapshot.engaged_by ?? 'unknown'}</dd>
          <dt class="text-[var(--color-text-muted)]">Duration</dt>
          <dd class="text-[var(--color-text)]">{formatAndonDuration(snapshot.engaged_at)}</dd>
          <dt class="text-[var(--color-text-muted)]">n8n-worker</dt>
          <dd class="text-[var(--color-text)]" data-testid="andon-worker-replicas">
            {workerReplicasLabel(snapshot.worker_replicas)}
          </dd>
        </dl>
      {:else if snapshot.worker_replicas === 0}
        <!-- ⛔ A RELEASED CORD IS NOT A RUNNING LINE: the release scale-up may
             never have landed, leaving the worker at 0 while the cord is off. -->
        <p class="text-xs font-semibold text-[var(--color-danger-text)]">
          Cord released, but execution is STOPPED (n8n-worker scaled to 0).
        </p>
      {:else if snapshot.worker_replicas === null}
        <p class="text-xs text-[var(--color-warning-text)]">
          Cord released — n8n-worker replica count NOT MEASURED, so the execution
          state is unknown. This is NOT a statement that work is running.
        </p>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]">
          Line running — no global stop engaged (n8n-worker at
          {snapshot.worker_replicas} replica{snapshot.worker_replicas === 1 ? '' : 's'}).
        </p>
      {/if}

      <div class="flex flex-wrap gap-3 text-xs text-[var(--color-text-muted)]">
        <span>Project stops: <span class="font-semibold text-[var(--color-text)]">{snapshot.project_stops}</span></span>
        <span>Stream stops: <span class="font-semibold text-[var(--color-text)]">{snapshot.stream_stops}</span></span>
      </div>

      {#if releaseAlarm}
        <!--
          The AUTHORITATIVE release outcome, rendered as its own row rather than
          folded into the feedback line below. `release_status` was computed,
          returned and read by NOTHING on this side until 2026-09-25: an operator
          released the brake, was told "released", and could not see that the
          worker had not come back.

          ⭐ SINCE THE ACTUATOR CHANGE the failure mode is the WORKER: an
          incomplete release means the scale-up was not confirmed, so automatic
          execution may still be stopped even though the cord is released.

          Warning vocabulary is the component's own (`Tag tone="warning"` /
          `--color-warning-*`), not a new one, and `role="alert"` so a release
          that did not land is ANNOUNCED rather than merely drawn.
        -->
        <p
          class="text-xs font-semibold text-[var(--color-warning-text)]"
          data-testid="andon-release-incomplete"
          data-release-verdict={releaseVerdict}
          role="alert"
        >
          {releaseVerdict === 'incomplete'
            ? `⚠ Brake is OFF, but the n8n-worker scale-up was NOT confirmed — automatic execution may still be stopped${releaseDetail ? ` (${releaseDetail})` : ''}. Release again to retry.`
            : '⚠ Brake is OFF, but the backend reported a release status this page does not recognise — treat the n8n-worker state as UNKNOWN and verify it before trusting it.'}
        </p>
      {/if}

      {#if feedback}
        <p class="text-xs {feedback.tone === 'warn' ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-success-text)]'}">
          {feedback.text}
        </p>
      {/if}
      {#if error}
        <p class="text-xs text-[var(--color-danger-text)]" data-testid="andon-error">{error}</p>
      {/if}

      <button
        type="button"
        onclick={askConfirm}
        disabled={busy}
        class="w-fit rounded-md px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] transition-colors disabled:opacity-60 {engaged
          ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-strong)]'
          : 'bg-[var(--color-danger)] hover:opacity-90'}"
        data-testid="andon-toggle"
      >
        {engaged ? 'Release global andon' : 'Pull global andon'}
      </button>
    </div>
  {:else}
    <div class="p-4"><BlockUnavailable meta={block.meta} title="Andon" /></div>
  {/if}
</section>

<Dialog bind:open={confirmOpen} title={engaged ? 'Release global andon?' : 'Pull global andon?'}>
  <p class="whitespace-pre-line text-sm text-[var(--color-text-muted)]">{confirmText}</p>
  {#if error}
    <p class="text-xs text-[var(--color-danger-text)]">{error}</p>
  {/if}
  <div class="flex justify-end gap-2">
    <button
      type="button"
      onclick={() => (confirmOpen = false)}
      disabled={busy}
      class="rounded border border-[var(--color-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface)] disabled:opacity-60"
    >
      Cancel
    </button>
    <button
      type="button"
      onclick={apply}
      disabled={busy}
      class="rounded px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-60 {engaged
        ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-strong)]'
        : 'bg-[var(--color-danger)] hover:opacity-90'}"
      data-testid="andon-confirm"
    >
      {busy ? 'Working…' : engaged ? 'Release' : 'Pull the cord'}
    </button>
  </div>
</Dialog>
