<!--
  Tenant home (`/`) — the landing page of the Tenant section. Plain-language overview:
  who you are here, what is waiting for you, the projects, what the workspace knows, and
  what it is spending. Every card loads on its own and says when it could not.

  Reads (all existing endpoints):
    GET /api/me/workspaces        workspace name + your role   (workspaces store)
    GET /api/license/status       licence state                (licenseGate store)
    GET /api/approvals?mine=1     what is waiting for you      (NeedsYouCard)
    GET /api/projects             the portfolio (ProjectPortfolio, which also hands NeedsYouCard the names)
    GET /api/assets/{principles,requirements,decisions}, GET /api/documents
                                  knowledge counts             (TenantAssetsCard)
    GET /api/me/usage/summary, GET /api/me/budget/status       (SpendCard)
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { licenseGate } from '$lib/stores/licenseGate.svelte';
  import { phaseTitles } from '$lib/projects/phaseTitles.svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import { Pill } from '$lib/components/ui';
  import type { Approval } from '$lib/types/api';
  import NeedsYouCard from './NeedsYouCard.svelte';
  import ProjectPortfolio from '$lib/components/projects/ProjectPortfolio.svelte';
  import TenantAssetsCard from './TenantAssetsCard.svelte';
  import SpendCard from './SpendCard.svelte';
  import { failed, roleWords, type Load } from './home';

  /** The backend caps a page at its own maximum; `total` is always the full count. */
  const ASKS_PAGE = 100;

  /** Real-project names, filled by ProjectPortfolio from the one projects read on this page. */
  let projectNames = $state<ReadonlyMap<string, string>>(new Map());
  let asks = $state<Load<{ items: Approval[]; total: number }>>({ kind: 'loading' });
  let now = $state(Date.now());

  async function readAsks(): Promise<{ items: Approval[]; total: number }> {
    const r = await authFetch(`/api/approvals?mine=1&limit=${ASKS_PAGE}`);
    if (!r.ok) throw new Error(`approvals list failed: ${r.status}`);
    const body = (await r.json()) as { items?: Approval[]; total?: unknown };
    const items = body.items ?? [];
    if (typeof body.total !== 'number') throw new Error('the response did not say how many there are');
    return { items, total: body.total };
  }

  $effect(() => {
    void workspaces.scopeKey;
    let cancelled = false;
    // Only the workspace drives a re-read; nothing the loaders touch may re-trigger it.
    untrack(() => {
      asks = { kind: 'loading' };
      now = Date.now();
      void phaseTitles.ensureLoaded();
      readAsks().then(
        (value) => {
          if (!cancelled) asks = { kind: 'ready', value };
        },
        (err) => {
          if (!cancelled) asks = failed('asks', err);
        },
      );
    });
    return () => {
      cancelled = true;
    };
  });

  /** Per-project counts only when every open ask was read — a partial page would undercount. */
  const asksPerProject = $derived.by((): ReadonlyMap<string, number> | null => {
    if (asks.kind !== 'ready' || asks.value.items.length < asks.value.total) return null;
    const m = new Map<string, number>();
    for (const a of asks.value.items) {
      if (a.project_id) m.set(a.project_id, (m.get(a.project_id) ?? 0) + 1);
    }
    return m;
  });

  const role = $derived(roleWords(workspaces.active?.role, auth.isSuperAdmin));

  const licence = $derived.by((): { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string } => {
    const s = licenseGate.status;
    if (!s) {
      return { tone: 'neutral', text: licenseGate.isLoading ? 'Checking licence…' : 'Licence status unknown' };
    }
    if (!s.gateEnabled) return { tone: 'neutral', text: 'No licence required' };
    switch (s.state) {
      case 'active':
        return { tone: 'success', text: 'Licence active' };
      case 'expiring_soon':
        return { tone: 'warning', text: licenseGate.statusMessage };
      case 'expired':
      case 'revoked':
      case 'none':
        return { tone: 'danger', text: licenseGate.statusMessage };
      default:
        return { tone: 'neutral', text: 'Licence status unknown' };
    }
  });
</script>

<div class="mx-auto max-w-6xl space-y-6" data-testid="tenant-home">
  <header class="space-y-2">
    <h1 class="text-2xl font-semibold text-[var(--color-text)]" data-testid="tenant-home-name">
      {workspaces.active?.name ?? (workspaces.loaded ? 'Your workspace' : 'Loading workspace…')}
    </h1>
    <div class="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
      {#if role}
        <span data-testid="tenant-home-role">You are: <strong class="text-[var(--color-text)]">{role}</strong></span>
      {/if}
      <span data-testid="tenant-home-licence"><Pill tone={licence.tone}>{licence.text}</Pill></span>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      This is your workspace overview: what is waiting for you, your projects, what the workspace knows, and
      what it is spending.
    </p>
  </header>

  <ProjectPortfolio {asksPerProject} bind:projectNames />
  <NeedsYouCard {asks} {projectNames} {now} />
  <TenantAssetsCard />
  <SpendCard />
</div>
