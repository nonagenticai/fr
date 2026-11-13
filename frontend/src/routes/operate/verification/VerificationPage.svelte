<script lang="ts">
  // /operate/verification/determinism — the super-admin verification view.
  //
  // George 2026-11-01: the Computed verification view, the trust board,
  // producers, readiness and evidence drawer were fed by the retired
  // improvement-loop-service and are deleted. The determinism benchmark tab was
  // deleted 2026-11-01 with asset-evaluator; what remains is fr's OWN Prometheus
  // read of the Live Verification* alerts, rendered verbatim.
  //
  // Gate: same as /operate — probe /api/me/super-admin after auth.isLoading and
  // render a private "Not found" for everyone else. The read routes 404 for
  // non-super-admins too (VerificationForbiddenError), which lands on the same
  // panel. A failed fetch becomes an unavailable block (clientErrorBlock), never
  // an empty-looking pass.
  import { onDestroy } from 'svelte';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { auth } from '$lib/stores/auth.svelte';
  import { getSuperAdminStatus } from '$lib/api/super-admin';
  import {
    VerificationForbiddenError,
    fetchAlerts,
    type VerificationBlock,
  } from '$lib/api/verification';
  import { clientErrorBlock } from '$lib/types/read-model';
  import type { VerificationAlertsPayload } from '$lib/types/verification';
  import AlertsStrip from '$lib/components/verification/AlertsStrip.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/ui/Skeleton.svelte';

  // ---- super-admin gate (probe after auth.isLoading; local 404 on denied) ----
  type GateState = 'pending' | 'allowed' | 'denied';
  let gate = $state<GateState>('pending');
  let gateProbeStarted = false;
  let poll: PollHandle | null = null;
  $effect(() => {
    if (gateProbeStarted) return;
    if (auth.isLoading) return;
    gateProbeStarted = true;
    void (async () => {
      try {
        const { is_super_admin } = await getSuperAdminStatus();
        gate = is_super_admin ? 'allowed' : 'denied';
        if (gate === 'allowed') {
          poll = usePoll(refresh, { intervalMs: 60_000, initialDelayMs: 0 });
          poll.start();
        }
      } catch {
        gate = 'denied';
      }
    })();
  });

  // ---- read models ----
  interface Blocks {
    alerts: VerificationBlock<VerificationAlertsPayload>;
  }
  let blocks = $state<Blocks | null>(null);
  let forbidden = $state(false);

  async function settle<T>(p: Promise<VerificationBlock<T>>, source: string): Promise<VerificationBlock<T>> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof VerificationForbiddenError) throw e;
      return clientErrorBlock<T>(source, e instanceof Error ? e.message : String(e));
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [alerts] = await Promise.all([settle(fetchAlerts(), 'prometheus')]);
      blocks = { alerts };
      forbidden = false;
    } catch (e) {
      if (e instanceof VerificationForbiddenError) {
        forbidden = true;
        poll?.stop();
        return;
      }
      throw e;
    }
  }

  onDestroy(() => poll?.stop());
</script>

<div class="flex flex-col gap-4 p-0 sm:p-4">
  {#if gate === 'pending' || (gate === 'allowed' && !blocks && !forbidden)}
    <Skeleton height="4rem" />
    <div class="grid gap-3 lg:grid-cols-4">
      {#each Array(4) as _, i (i)}<Skeleton height="10rem" />{/each}
    </div>
  {:else if gate === 'denied' || forbidden}
    <div class="grid min-h-[50vh] place-items-center text-center">
      <div>
        <h1 class="text-lg font-bold text-[var(--color-text)]">Not found</h1>
        <p class="mt-1 text-sm text-[var(--color-text-muted)]">This page isn't available to your account.</p>
      </div>
    </div>
  {:else if blocks}
    <PageHeader
      title="Verification"
      subtitle="The Live Verification* Prometheus alerts, rendered verbatim."
    />

    <AlertsStrip block={blocks.alerts} />
  {/if}
</div>
