<script lang="ts">
  // Telemetry quality from the `observability` block — the 3 ground-truth meters
  // (correlation coverage, KAG compression lag, approval-callback health). A meter with a value renders a token-coloured
  // bar; a meter that was read but has no denominator says "nothing to measure";
  // a meter with available:false (e.g. KAG lag — a data-gap) says "not
  // reported". Neither null case gets a bar — a 0%-wide bar is a claim of zero.
  import { isAvailable, type Block } from '$lib/types/read-model';
  import type { Meter } from '$lib/types/control-tower';
  import BlockUnavailable from '$lib/components/blocks/BlockUnavailable.svelte';
  import { fmtMeterValue, meterPct } from './logic';

  interface Props {
    block: Block<Meter[]>;
  }
  let { block }: Props = $props();

  const BAR: Record<Meter['status'], string> = {
    ok: 'bg-[var(--color-success)]',
    warn: 'bg-[var(--color-warning)]',
    danger: 'bg-[var(--color-danger)]',
    unknown: 'bg-[var(--color-border-strong)]',
  };
</script>

<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="telemetry-panel">
  <header class="border-b border-[var(--color-border)] px-4 py-3">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">Telemetry quality</h2>
    <p class="text-xs text-[var(--color-text-muted)]">Ground-truth completeness for observation and scoring.</p>
  </header>

  {#if isAvailable(block)}
    <div class="flex flex-col gap-3 p-4">
      {#each block.data as m (m.key)}
        <!--
          `detail` is rendered below ONLY on the unavailable branch, so an
          available meter had no way to qualify its own number. Correlation
          coverage is a ratio over a capped page of worker sessions; when that
          page comes back full the figure is a SAMPLE, and this panel is
          subtitled "Ground-truth completeness". The title carries that
          disclosure on every meter, available or not.
        -->
        <!--
          THREE states, three distinct strings (see fmtMeterValue): a percentage,
          "nothing to measure" for a meter that WAS read but had an empty
          denominator, and "not reported" for one that could not be read at all.
          They used to collapse onto "—", so an idle-but-healthy meter looked
          exactly like a dead upstream.
        -->
        <div data-testid="telemetry-meter" title={m.detail}>
          <div class="flex items-baseline justify-between text-xs">
            <span class="font-medium text-[var(--color-text)]">{m.label}</span>
            <span class="tabular-nums {m.available && m.value != null ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}">
              {fmtMeterValue(m)}
            </span>
          </div>
          {#if m.available && m.value != null}
            <div class="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-surface-strong)]">
              <div class="h-full rounded-full {BAR[m.status]}" style="width: {meterPct(m.value)}%"></div>
            </div>
          {:else}
            <!-- No bar for a null value: a 0%-wide bar IS a claim of zero. -->
            <p class="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{m.detail}</p>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="p-4"><BlockUnavailable meta={block.meta} title="Telemetry" /></div>
  {/if}
</section>
