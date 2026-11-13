<script lang="ts">
  // ALERTS STRIP (contract A10.4) — top of /operate/verification. fr's OWN
  // Prometheus read: `ALERTS{alertname=~"Verification.*"}`.
  //
  // ⛔ Unreachable is GREY "alert state unknown" — NEVER "no alerts". Only a
  // read that actually succeeded AND reported zero items says "no
  // Verification alerts firing".
  import { isAvailable } from '$lib/types/read-model';
  import type { VerificationBlock } from '$lib/api/verification';
  import type { VerificationAlertsPayload } from '$lib/types/verification';
  import { TONE_CLASS, boundedLabel, relAge, utc } from './logic';
  import { alertsStripStyle, alertsView } from './logic-a10';

  interface Props {
    block: VerificationBlock<VerificationAlertsPayload>;
  }
  let { block }: Props = $props();

  const view = $derived(isAvailable(block) ? alertsView(block.data) : null);
  const style = $derived(alertsStripStyle(view));
</script>

<section
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
  data-testid="verification-alerts-strip"
  data-reachable={view?.reachable ?? 'unavailable'}
>
  <div class="flex flex-wrap items-center gap-2">
    <h2 class="text-sm font-bold text-[var(--color-text)]">Alerts</h2>
    <span
      class={`rounded-md border px-2 py-0.5 text-xs font-extrabold tracking-wider ${TONE_CLASS[style.tone]}`}
      data-testid="verification-alerts-headline"
    >
      {style.label}
    </span>
  </div>

  {#if !isAvailable(block)}
    <p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="verification-alerts-block-unavailable">
      alert state unknown — the alerts read itself failed ({block.meta.error ?? 'error not reported'})
    </p>
  {:else if !view?.reachable}
    <p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="verification-alerts-unreachable">
      Prometheus unreachable{block.data?.error ? `: ${boundedLabel(block.data.error, 200)}` : ''} — cannot confirm whether any Verification alert is firing.
    </p>
  {:else if view.firing.length > 0 || view.pending.length > 0}
    <ul class="mt-1 flex flex-col gap-1" data-testid="verification-alerts-items">
      {#each view.firing as a, i (i)}
        <li
          class="rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-2 py-1 text-xs text-[var(--color-danger-text)]"
          data-testid="verification-alert-item"
          data-state="firing"
          data-alertname={a.alertname}
          data-concept={a.concept ?? 'board-wide'}
        >
          <span class="font-semibold">FIRING</span> · {boundedLabel(a.alertname, 80)}
          · concept: {a.concept ?? 'board-wide'}
          {#if a.severity}· severity: {boundedLabel(a.severity, 32)}{/if}
          {#if a.active_at}· since {relAge(a.active_at)} ({utc(a.active_at)}){/if}
        </li>
      {/each}
      {#each view.pending as a, i (i)}
        <li
          class="rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-2 py-1 text-xs text-[var(--color-warning-text)]"
          data-testid="verification-alert-item"
          data-state="pending"
          data-alertname={a.alertname}
          data-concept={a.concept ?? 'board-wide'}
        >
          <span class="font-semibold">pending</span> · {boundedLabel(a.alertname, 80)}
          · concept: {a.concept ?? 'board-wide'}
          {#if a.severity}· severity: {boundedLabel(a.severity, 32)}{/if}
          {#if a.active_at}· since {relAge(a.active_at)} ({utc(a.active_at)}){/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
