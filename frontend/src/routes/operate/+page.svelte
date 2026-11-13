<script lang="ts">
  // THE SUPER-ADMIN CONTROL TOWER — /operate. One flat read model
  // (GET /api/admin/control-tower) drives everything: the 15s poll refreshes all
  // 9 blocks at once, and the inspector hydrates from the already-fetched blocks
  // (no drilldown / sub-fetch). Every block
  // degrades on its own via the Session-1 envelope; honest data-gaps (KAG lag, asset-inheritance/stale-body meters) render muted, never
  // faked. The one wired mutation is the global andon cord.
  import { onDestroy } from 'svelte';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { inspector } from '$lib/stores/inspector.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { getSuperAdminStatus } from '$lib/api/super-admin';
  import { fetchControlTower, ControlTowerForbiddenError } from '$lib/api/control-tower';
  import type {
    ControlTower,
    InspectKind,
    TenantHealthRow,
    ControlAlert,
  } from '$lib/types/control-tower';
  import { isAvailable } from '$lib/types/read-model';
  import { parseAlertLink } from '$lib/components/control-tower/logic';

  import FleetKpiBand from '$lib/components/control-tower/FleetKpiBand.svelte';
  import ControlAlertStrip from '$lib/components/control-tower/ControlAlertStrip.svelte';
  import TenantHealthTable from '$lib/components/control-tower/TenantHealthTable.svelte';
  import LiveWorkflowsPanel from '$lib/components/control-tower/LiveWorkflowsPanel.svelte';
  import TelemetryQualityPanel from '$lib/components/control-tower/TelemetryQualityPanel.svelte';
  import ActiveExecutionsPanel from '$lib/components/control-tower/ActiveExecutionsPanel.svelte';
  import AndonStatusPanel from '$lib/components/control-tower/AndonStatusPanel.svelte';
  import ControlTowerInspector from '$lib/components/control-tower/ControlTowerInspector.svelte';
  import BlockUnavailable from '$lib/components/blocks/BlockUnavailable.svelte';
  import Skeleton from '$lib/components/ui/Skeleton.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';

  // ---- super-admin gate (probe after auth.isLoading; local 404 on denied) ----
  type GateState = 'pending' | 'allowed' | 'denied';
  let gate = $state<GateState>('pending');
  let gateProbeStarted = false;
  $effect(() => {
    if (gateProbeStarted) return;
    if (auth.isLoading) return;
    gateProbeStarted = true;
    void (async () => {
      try {
        const { is_super_admin } = await getSuperAdminStatus();
        gate = is_super_admin ? 'allowed' : 'denied';
        if (gate === 'allowed') {
          poll = usePoll(refresh, { intervalMs: 15_000, initialDelayMs: 0 });
          poll.start();
        }
      } catch {
        gate = 'denied';
      }
    })();
  });

  // ---- read model ----
  let tower = $state<ControlTower | null>(null);
  let loaded = $state(false);
  let forbidden = $state(false);
  let poll: PollHandle | null = null;

  async function refresh(): Promise<void> {
    try {
      tower = await fetchControlTower();
      forbidden = false;
    } catch (e) {
      if (e instanceof ControlTowerForbiddenError) {
        forbidden = true;
        poll?.stop();
        return;
      }
      throw e; // transient — usePoll backs off, last-good tower stays on screen
    } finally {
      loaded = true;
    }
  }

  // ---- inspector selection (hydrated from already-fetched blocks) ----
  const inspectKind = $derived<InspectKind | null>(
    inspector.selection && ['tenant', 'alert'].includes(inspector.selection.kind)
      ? (inspector.selection.kind as InspectKind)
      : null,
  );

  function selectTenant(row: TenantHealthRow): void {
    inspector.open({ kind: 'tenant', id: row.tenant_id, payload: row });
  }
  function closeInspector(): void {
    inspector.close();
  }

  // Alert deep-links: open the alert in the inspector and, for a block:<name>
  // link, scroll to that section's anchor.
  function onAlert(alert: ControlAlert): void {
    inspector.open({ kind: 'alert', id: alert.key, payload: alert });
    const parsed = parseAlertLink(alert.link);
    if (parsed?.kind === 'block') {
      document.getElementById(`ct-${parsed.ref}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const alerts = $derived(tower && isAvailable(tower.alerts) ? tower.alerts.data : []);

  onDestroy(() => {
    poll?.stop();
    inspector.close();
  });
</script>

<div class="flex flex-col gap-4 p-0 sm:p-4">
  {#if gate === 'pending' || (gate === 'allowed' && !loaded && !forbidden)}
    <Skeleton height="4rem" />
    <div class="grid gap-3 lg:grid-cols-7">
      {#each Array(7) as _, i (i)}<Skeleton height="5rem" />{/each}
    </div>
    <Skeleton height="24rem" />
  {:else if gate === 'denied' || forbidden}
    <div class="grid min-h-[50vh] place-items-center text-center">
      <div>
        <h1 class="text-lg font-bold text-[var(--color-text)]">Not found</h1>
        <p class="mt-1 text-sm text-[var(--color-text-muted)]">This page isn't available to your account.</p>
      </div>
    </div>
  {:else if !tower}
    <div class="grid min-h-[40vh] place-items-center text-center">
      <p class="text-sm text-[var(--color-text-muted)]">Couldn't load the control tower. Retrying…</p>
    </div>
  {:else}
    <PageHeader
      title="Control tower"
      subtitle="Fleet-wide operator lens. Every block names its source and degrades on its own."
    />

    <ControlAlertStrip {alerts} onselect={onAlert} />

    {#if isAvailable(tower.fleet)}
      <FleetKpiBand fleet={tower.fleet.data} />
    {:else}
      <BlockUnavailable meta={tower.fleet.meta} title="Fleet" />
    {/if}

    <div class="grid gap-4 {inspectKind ? 'xl:grid-cols-[minmax(0,1fr)_386px]' : 'grid-cols-1'}">
      <div class="flex min-w-0 flex-col gap-4">
        <TenantHealthTable
          block={tower.tenants}
          selectedId={inspectKind === 'tenant' ? (inspector.selection?.id ?? null) : null}
          onselect={selectTenant}
        />

        <div id="ct-n8n_workflows">
          <LiveWorkflowsPanel block={tower.n8n_workflows} />
        </div>

        <div id="ct-observability">
          <TelemetryQualityPanel block={tower.observability} />
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <ActiveExecutionsPanel block={tower.active_executions} />
          <div id="ct-andon">
            <AndonStatusPanel block={tower.andon} onToggled={refresh} />
          </div>
        </div>
      </div>

      {#if inspectKind && inspector.selection}
        <div class="min-h-0 xl:max-h-[calc(100vh-12rem)]">
          <ControlTowerInspector
            kind={inspectKind}
            payload={inspector.selection.payload as TenantHealthRow | ControlAlert}
            onclose={closeInspector}
          />
        </div>
      {/if}
    </div>
  {/if}
</div>
