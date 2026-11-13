<script lang="ts">
  // Funding split chips: who paid — Local GPU / Platform-paid / Own key (BYO).
  // Display only. A withheld amount (markup unknown) renders "—", never $0.
  import { Pill } from '$lib/components/ui';
  import { fundingLabel, fundingShare, formatUsd, sortFundings, type FundingTotal } from '$lib/usage/funding';

  interface Props {
    byFunding: FundingTotal[];
    /** Optional caption, e.g. the window the split covers. */
    caption?: string | null;
    testid?: string;
  }
  let { byFunding, caption = null, testid = 'funding-split' }: Props = $props();

  const ordered = $derived(
    sortFundings(byFunding.map((f) => f.funding)).map((f) => byFunding.find((x) => x.funding === f)!),
  );
  const total = $derived(
    ordered.some((f) => f.cost_usd === null)
      ? null
      : ordered.reduce((s, f) => s + Math.round((f.cost_usd ?? 0) * 1e6), 0) / 1e6,
  );
  const tone = (f: string) => (f === 'tenant_byo' ? 'accent' : f === 'local_gpu' ? 'success' : f === 'unknown' ? 'warning' : 'neutral');
</script>

<div class="flex flex-wrap items-center gap-1.5" data-testid={testid}>
  {#if ordered.length === 0}
    <span class="text-[11px] text-[var(--color-text-muted)]" data-testid={`${testid}-empty`}>
      No settled usage in this window (complete UTC days; today is provisional).
    </span>
  {:else}
    {#each ordered as f (f.funding)}
      {@const share = fundingShare(f.cost_usd, total)}
      <Pill tone={tone(f.funding)}>
        <span data-testid={`${testid}-chip`} data-funding={f.funding}>
          {fundingLabel(f.funding)} · <span class="tabular-nums">{formatUsd(f.cost_usd)}</span>{#if share !== null}{' '}<span class="text-[var(--color-text-muted)]">({Math.round(share)}%)</span>{/if}
        </span>
      </Pill>
    {/each}
  {/if}
  {#if caption}
    <span class="text-[11px] text-[var(--color-text-muted)]">{caption}</span>
  {/if}
</div>
