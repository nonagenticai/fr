<!--
  ChangeSetPanel — one change set (e.g. an imported exchange file) as
  requirements_management stored it: its status in plain words, what it would
  change, the problems RM found in it, and — while it is `proposed` — Apply /
  Reject.

  fr decides nothing here: Apply is offered because RM's status is `proposed`;
  an `invalid` set shows RM's blocking problems and no Apply. If the model
  changed after the set was prepared, RM refuses the apply (412 stale_head): the
  panel says so and offers `onReimport` (prepare a fresh set from the same file),
  the way out for the user.
-->
<script lang="ts">
  import { Pill } from '$lib/components/ui';
  import { ModelingError, applyChangeSet, rejectChangeSet, type ChangeSet, type ExchangeLoss } from '$lib/api/modeling';
  import { SEVERITY_LABEL, SEVERITY_TONE, changeSetStatus, lossText, opLabel, opName, opsSummary, visibleFindings, when } from '$lib/modeling/explain';
  import { personLabel } from '$lib/modeling/people';

  let {
    changeSet,
    losses = [],
    onChange,
    onReimport,
  }: {
    changeSet: ChangeSet;
    losses?: ExchangeLoss[];
    onChange?: (cs: ChangeSet) => void;
    /** Offered when the model moved on since the set was prepared. */
    onReimport?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let cs = $state<ChangeSet>(changeSet);
  let busy = $state<'apply' | 'reject' | null>(null);
  let error = $state<string | null>(null);
  let stale = $state(false);
  // A new set from the parent (e.g. after "Import again") starts clean.
  $effect(() => {
    cs = changeSet;
    stale = false;
    error = null;
  });

  const verdict = $derived(changeSetStatus(cs.status));
  const findings = $derived(visibleFindings(cs));
  const blockingIds = $derived(new Set((cs.blocking_findings ?? []).map((f) => `${f.rule_id}|${f.message}`)));

  let rejecting = $state(false);
  let reason = $state('');
  let showAllOps = $state(false);
  const OPS_SHOWN = 25;

  async function apply(): Promise<void> {
    busy = 'apply';
    error = null;
    stale = false;
    try {
      cs = await applyChangeSet(cs.id);
      onChange?.(cs);
    } catch (e) {
      if (e instanceof ModelingError && e.code === 'stale_head') stale = true;
      else error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  async function reject(): Promise<void> {
    if (!reason.trim()) return;
    busy = 'reject';
    error = null;
    try {
      cs = await rejectChangeSet(cs.id, reason.trim());
      rejecting = false;
      onChange?.(cs);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }
</script>

<section class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="change-set-panel" data-status={cs.status}>
  <div class="flex flex-wrap items-center gap-2">
    <Pill tone={verdict.tone}>{verdict.label}</Pill>
    <span class="text-sm text-[var(--color-text)]" data-testid="change-set-summary">{opsSummary(cs.ops)}</span>
  </div>
  <p class="text-sm text-[var(--color-text-muted)]">{verdict.explanation}</p>
  {#if cs.rationale}<p class="text-xs text-[var(--color-text-muted)]">{cs.rationale}</p>{/if}

  {#if cs.status === 'applied' && cs.applied_at}
    <p class="text-xs text-[var(--color-text-muted)]">Applied {when(cs.applied_at)} by {personLabel(cs.applied_by)}.</p>
  {:else if cs.status === 'rejected'}
    <p class="text-xs text-[var(--color-text-muted)]">Rejected {when(cs.rejected_at)} by {personLabel(cs.rejected_by)}{cs.reject_reason ? `: “${cs.reject_reason}”` : '.'}</p>
  {/if}

  {#if losses.length > 0}
    <div class="rounded-md border border-[var(--color-info-border)] bg-[var(--color-info-bg)] p-3" data-testid="change-set-losses">
      <p class="text-sm font-medium text-[var(--color-info-text)]">Some details in the file are not kept:</p>
      <ul class="mt-1 list-disc pl-5 text-sm text-[var(--color-info-text)]">
        {#each losses as l, i (i)}<li>{lossText(l)}</li>{/each}
      </ul>
    </div>
  {/if}

  {#if findings.length > 0}
    <div data-testid="change-set-findings">
      <h3 class="text-sm font-semibold text-[var(--color-text)]">Problems found in these changes</h3>
      <ul class="mt-1 flex flex-col gap-1">
        {#each findings as f, i (i)}
          <li class="flex items-start gap-2 text-sm" data-blocking={blockingIds.has(`${f.rule_id}|${f.message}`)}>
            <Pill tone={SEVERITY_TONE[f.severity] ?? 'neutral'}>{SEVERITY_LABEL[f.severity] ?? f.severity}</Pill>
            <span class="text-[var(--color-text)]">
              {f.message}
              {#if blockingIds.has(`${f.rule_id}|${f.message}`)}<span class="text-xs font-semibold text-[var(--color-danger-text)]"> — blocks applying</span>{/if}
              <span class="block text-xs text-[var(--color-text-muted)]">{f.rule_id}</span>
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if cs.ops.length > 0}
    <details class="text-sm" data-testid="change-set-ops">
      <summary class="cursor-pointer text-[var(--color-text)]">See every change ({cs.ops.length})</summary>
      <ul class="mt-2 flex flex-col gap-1">
        {#each showAllOps ? cs.ops : cs.ops.slice(0, OPS_SHOWN) as op, i (i)}
          <li class="text-[var(--color-text)]">{opLabel(op)}{opName(op) ? `: ${opName(op)}` : ''}</li>
        {/each}
      </ul>
      {#if cs.ops.length > OPS_SHOWN && !showAllOps}
        <button type="button" class="mt-1 text-xs font-medium text-[var(--color-link)] underline" onclick={() => (showAllOps = true)}>Show all {cs.ops.length}</button>
      {/if}
    </details>
  {/if}

  {#if stale}
    <div class="rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3" data-testid="change-set-stale">
      <p class="text-sm text-[var(--color-warning-text)]">
        The model was changed after these changes were prepared, so they can no longer be applied as they are. Import the file again to prepare an up-to-date set of changes.
      </p>
      {#if onReimport}
        <button type="button" class="mt-2 rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]" onclick={onReimport} data-testid="change-set-reimport">
          Import again
        </button>
      {/if}
    </div>
  {/if}
  {#if error}
    <p class="text-sm text-[var(--color-danger)]" data-testid="change-set-error">{error}</p>
  {/if}

  {#if cs.status === 'proposed' || cs.status === 'invalid'}
    <div class="flex flex-wrap items-center gap-2">
      {#if cs.status === 'proposed'}
        <button
          type="button"
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
          onclick={apply}
          disabled={busy !== null || stale}
          data-testid="change-set-apply"
        >
          {busy === 'apply' ? 'Applying…' : 'Apply changes'}
        </button>
      {/if}
      {#if !rejecting}
        <button type="button" class="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]" onclick={() => (rejecting = true)} disabled={busy !== null} data-testid="change-set-reject">
          Reject changes
        </button>
      {/if}
    </div>
    {#if rejecting}
      <div class="flex flex-col gap-2">
        <label class="text-xs text-[var(--color-text-muted)]" for={`reject-${cs.id}`}>Why are you rejecting these changes?</label>
        <textarea id={`reject-${cs.id}`} bind:value={reason} rows="2" class="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" data-testid="change-set-reject-reason"></textarea>
        <div class="flex gap-2">
          <button type="button" class="rounded-md border border-[var(--color-danger-border)] px-3 py-1 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-50" onclick={reject} disabled={busy !== null || !reason.trim()} data-testid="change-set-reject-confirm">
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <button type="button" class="px-3 py-1 text-sm text-[var(--color-text-muted)]" onclick={() => (rejecting = false)}>Cancel</button>
        </div>
      </div>
    {/if}
  {/if}
</section>
