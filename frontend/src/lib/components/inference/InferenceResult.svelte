<!--
  InferenceResult — what provisioning's inference apply actually did (PLAN
  tenant-inference-provisioning §2.6): every step with its status, and per tier
  the smoke call's ledger read-back.

  ⛔ "verified" is shown ONLY when provisioning reported the IR ledger row
  matched (served provider, setup, key owner, policy version). An HTTP 200, a
  `success` status or a served_provider value alone is never rendered as
  verified — that is the whole point of the read-back.

  "Re-run checks" re-applies with a fresh idempotency key: the same doc is an
  IR no-op (same version, no second budget) and the smoke runs again.
-->
<script lang="ts">
  import { Pill } from '$lib/components/ui';
  import type { InferenceOutcome } from '$lib/api/inference-admin';

  let {
    outcome,
    onRerun,
    rerunning = false,
    rerunError = null,
  }: {
    outcome: InferenceOutcome;
    onRerun?: () => void;
    rerunning?: boolean;
    rerunError?: string | null;
  } = $props();

  const statusTone = (s: string): 'success' | 'warning' | 'danger' | 'neutral' =>
    s === 'ok' || s === 'success' ? 'success' : s === 'skipped' ? 'neutral' : s === 'partial' ? 'warning' : 'danger';

  function failureCause(detail: Record<string, unknown>): string {
    for (const k of ['reason', 'error', 'refused', 'status_code']) {
      const v = detail[k];
      if (typeof v === 'string' || typeof v === 'number') return `${k}: ${v}`;
    }
    if (detail.diff && typeof detail.diff === 'object') return `diff: ${JSON.stringify(detail.diff)}`;
    if (Array.isArray(detail.violations)) return `violations: ${JSON.stringify(detail.violations)}`;
    return '';
  }
</script>

<div class="rounded border border-[var(--color-border-strong)] p-3 space-y-3 text-sm" data-testid="inference-result">
  <div class="flex items-center justify-between gap-2">
    <p class="font-medium">
      Inference
      <span data-testid="inference-result-status"><Pill tone={statusTone(outcome.status)}>{outcome.status}</Pill></span>
      {#if outcome.policy_version !== null}
        <span class="text-xs text-[var(--color-text-muted)]">policy v{outcome.policy_version}</span>
      {/if}
    </p>
    {#if onRerun}
      <button
        type="button"
        class="px-3 py-1 border border-[var(--color-border-strong)] rounded text-xs"
        disabled={rerunning}
        onclick={onRerun}
        data-testid="inference-rerun"
      >
        {rerunning ? 'Re-running…' : 'Re-run checks'}
      </button>
    {/if}
  </div>

  {#if outcome.error}
    <p class="text-[var(--color-danger-text)]" data-testid="inference-result-error">
      The apply did not complete: {outcome.error}. The people above were provisioned;
      re-run from this panel or the tenant’s Inference section.
    </p>
  {/if}
  {#if rerunError}
    <p class="text-[var(--color-danger-text)]" data-testid="inference-rerun-error">{rerunError}</p>
  {/if}

  {#if outcome.steps.length > 0}
    <ol class="space-y-1" data-testid="inference-steps">
      {#each outcome.steps as step, i (i)}
        <li class="flex flex-wrap items-center gap-2" data-testid="inference-step">
          <Pill tone={statusTone(step.status)}>{step.status}</Pill>
          <span class="font-mono text-xs">{step.name}</span>
          {#if step.status === 'failed'}
            <span class="text-xs text-[var(--color-danger-text)]">{failureCause(step.detail)}</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  <div class="space-y-1" data-testid="inference-smoke">
    <p class="text-xs uppercase text-[var(--color-text-muted)]">Smoke per tier (ledger read-back)</p>
    {#if outcome.smoke.length === 0}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="inference-smoke-none">
        No smoke result — nothing has been verified.
      </p>
    {:else}
      {#each outcome.smoke as s (s.tier)}
        <p class="flex flex-wrap items-center gap-2" data-testid="inference-smoke-tier" data-verified={s.verified ? 'true' : 'false'}>
          <span class="font-mono text-xs">tier-{s.tier}</span>
          {#if s.verified}
            <Pill tone="success">verified</Pill>
          {:else}
            <Pill tone="danger">not verified</Pill>
          {/if}
          <span class="text-xs text-[var(--color-text-muted)]">
            {s.served_provider ?? 'no ledger row'}{s.policy_version !== null ? ` · v${s.policy_version}` : ''}{s.key_owner ? ` · ${s.key_owner}` : ''}
          </span>
        </p>
      {/each}
    {/if}
  </div>
</div>
