<!--
  /admin/tenants/[nameOrId] — one tenant.

  The list page next door can already rename, archive and re-post a tenant's BYO
  mode; the licensing half of this page mutates NOTHING. It answers a different
  question: "what has this tenant actually been provisioned?" — which the list,
  one row per tenant, has no room to show.

  The ONE writable section is "LLM provider" (owner requirement 2026-10-02):
  every customer tenant runs on local-llm, and the owner switches it to BYO by
  entering the tenant's own key per tier, tests it, and removes it to switch
  back. It reuses the tenant_admin's `/settings/llm-provider` cards, pointed at
  `/api/admin/tenants/:tenantId/llm-provider` (super-admin only, backend-gated).
  Not offered for an archived tenant — the backend 404s it.

  Two things it must not be misread as.

  1. The provisioning table is LICENCES' HALF ONLY. Provisioning also writes a
     markup rule and an access charge into billing_service over S2S; none of
     that is fetched here. The caption says so, because a table of products
     under a tenant is exactly what somebody would forward as "their billing".

  2. `offering_code: null` is UNKNOWN PROVENANCE, not "no offering". Every cell
     goes through `offeringProvenance()` so there is no code path that can print
     an empty cell for one — see the comment on `OFFERING_UNKNOWN_LABEL`.

  The route param is `nameOrId` because the licences endpoint resolves either,
  but links are built from the id (`tenantDetailHref`) so a rename cannot break
  a bookmark.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { Button, Pill, Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
  import {
    getTenant,
    listTenantOfferings,
    type TenantRecord,
    type TenantOfferingRecord,
    setTenantByoMode,
  } from '$lib/api/licenses-admin';
  import { formatDate } from '../../licenses/page-helpers';
  import { auth } from '$lib/stores/auth.svelte';
  import { adminTenantLlmProviderApi, llmModeNote } from '$lib/api/llm-provider';
  import LlmProviderTiers from '$lib/components/llm-provider/LlmProviderTiers.svelte';
  import TenantInferenceSection from '$lib/components/inference/TenantInferenceSection.svelte';
  import { getInferenceConfig, type InferenceConfig } from '$lib/api/inference-admin';
  import { isArchived } from '../page-helpers';
  import {
    OFFERINGS_SCOPE_NOTE,
    OFFERING_UNKNOWN_NOTE,
    byoTone,
    describeNoOfferings,
    describeOfferings,
    offeringProvenance,
    overridesTenantDefault,
    productLabel,
    sortOfferings,
    tenantHeading,
    unknownProvenanceCount,
  } from './page-helpers';

  // SvelteKit types params as `Record<string, string | undefined>`; this file
  // lives under [nameOrId] so it is always present at runtime.
  const nameOrId = $derived(page.params.nameOrId as string);

  let tenant = $state<TenantRecord | null>(null);
  let offerings = $state<TenantOfferingRecord[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  /**
   * Both calls, together.
   *
   * Not `Promise.all`-and-swallow: if the offerings call fails we must NOT fall
   * through to rendering an empty table, because an empty table here has a
   * specific and reassuring meaning ("no per-product overrides") that a failed
   * fetch does not have. A failure is an error state, full stop.
   */
  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [t, o] = await Promise.all([
        getTenant(nameOrId),
        listTenantOfferings(nameOrId),
      ]);
      tenant = t;
      offerings = o;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // Inference section (PLAN tenant-inference-provisioning §2.6): owner-only and
  // only while the backend has FR_INFERENCE_PROVISIONING on. A failed probe
  // is SAID (not silently hidden): an unreadable config is not "flag off".
  let inferenceConfig = $state<InferenceConfig | null>(null);
  let inferenceConfigError = $state<string | null>(null);
  let inferenceProbeStarted = false;
  $effect(() => {
    if (inferenceProbeStarted || !auth.isSuperAdmin) return;
    inferenceProbeStarted = true;
    void (async () => {
      try {
        inferenceConfig = await getInferenceConfig();
      } catch (e) {
        inferenceConfigError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  const rows = $derived(sortOfferings(offerings));
  const unknownRows = $derived(unknownProvenanceCount(offerings));

  /**
   * The tenant-wide posture, hoisted out of the template.
   *
   * Every read of it below sits inside an `{#each}`, where TypeScript's
   * narrowing of `tenant` from the surrounding `{#if}` is not reliably carried
   * through by svelte2tsx. Reading it once here keeps the template free of
   * non-null assertions. The `''` fallback is unreachable — the table only
   * renders in the branch where `tenant` is loaded.
   */
  const tenantByo = $derived(tenant?.byo_mode ?? '');

  // One api object per tenant id, so the tier cards load once per tenant.
  const llmApi = $derived(tenant ? adminTenantLlmProviderApi(tenant.id) : null);

  /**
   * "Easily": the one BYO-mode change this section offers inline. Any mode
   * other than local_allowed either fails keyless tiers (byo_required) or
   * refuses BYO keys (platform_only); local_allowed is the mode in which this
   * section's cards mean "BYO per tier, local-llm otherwise". The full mode
   * control stays on the Tenants list — this is deliberately one button, using
   * the same endpoint and the same confirm() as that list. `load()` re-reads
   * the tenant and, by swapping in the skeleton, remounts the tier cards —
   * but that does NOT make them see the new mode yet: worker_management
   * caches each tenant's byo_mode for 300s per pod (auth_middleware.py
   * `_tenant_byo_cache`), so for up to ~5 minutes the catalog can still be the
   * old mode's and a BYO PUT can still be refused. The success line says so.
   */
  let byoBusy = $state(false);
  let byoError = $state<string | null>(null);
  let byoSwitched = $state(false);
  async function allowLocalAndByo(): Promise<void> {
    if (!tenant || tenant.byo_mode === 'local_allowed') return;
    if (!confirm(`Set ${tenant.name} to “local_allowed”?\n\nThis changes who pays for their inference.`)) {
      return;
    }
    byoBusy = true;
    byoError = null;
    try {
      await setTenantByoMode(tenant.id, 'local_allowed');
      byoSwitched = true;
      await load();
    } catch (e) {
      byoError = e instanceof Error ? e.message : String(e);
    } finally {
      byoBusy = false;
    }
  }

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(page.url.pathname, tenant ? tenantHeading(tenant) : null);
  });
</script>

<div class="p-6 space-y-8" data-testid="tenant-detail-page">
  <header class="flex items-baseline justify-between gap-4">
    <div>
      <p class="text-sm text-[var(--color-text-muted)]">
        <a class="underline" href="/admin/tenants">← Tenants</a>
      </p>
      <h1 class="text-xl font-semibold text-[var(--color-text)]" data-testid="tenant-heading">
        {tenant ? tenantHeading(tenant) : nameOrId}
      </h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        This tenant's licensing record: its identity, its BYO posture, and what it
        has been provisioned.
      </p>
    </div>
    <Button variant="ghost" onclick={load}>Refresh</Button>
  </header>

  {#if loading}
    <div class="space-y-2">
      {#each Array(4) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
    </div>
  {:else if loadError}
    <ErrorState error={loadError} onRetry={load} />
  {:else if !tenant}
    <EmptyState
      title="Tenant not found"
      body="No tenant resolves to “{nameOrId}”. It may have been renamed — the register lists every tenant, archived ones included."
    />
  {:else}
    <!-- Overview ---------------------------------------------------------->
    <section class="space-y-3" data-testid="tenant-overview">
      <h2 class="text-lg font-semibold">Overview</h2>
      <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 max-w-3xl text-sm">
        <div>
          <dt class="text-[var(--color-text-muted)]">Name</dt>
          <dd class="text-[var(--color-text)]" data-testid="tenant-name">{tenant.name}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-text-muted)]">Id</dt>
          <dd class="font-mono text-xs" data-testid="tenant-id">{tenant.id}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-text-muted)]">Keycloak realm</dt>
          <dd data-testid="tenant-realm">{tenant.keycloak_realm ?? 'none'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-text-muted)]">Tenant-wide BYO mode</dt>
          <dd data-testid="tenant-byo">
            <Pill tone={byoTone(tenant.byo_mode)}>{tenant.byo_mode}</Pill>
          </dd>
        </div>
        <div>
          <dt class="text-[var(--color-text-muted)]">State</dt>
          <dd data-testid="tenant-state">
            {#if isArchived(tenant)}
              <!-- `neutral`, not `danger`: archiving revokes nothing, and a red
                   pill would tell the operator it did. Same reasoning as the
                   list page. -->
              <Pill tone="neutral">Archived</Pill>
            {:else}
              <Pill tone="success">Live</Pill>
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-[var(--color-text-muted)]">Created</dt>
          <dd>{formatDate(tenant.created_at)}</dd>
        </div>
      </dl>
      {#if isArchived(tenant)}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="archived-note">
          Archived revokes nothing — its licences, tokens and budgets survive and
          existing tokens keep working. It is hidden from pick-lists and marked
          “do not provision into this”.
        </p>
      {/if}
    </section>

    <!-- LLM provider (owner-only, the one writable section) ------------------>
    {#if auth.isSuperAdmin}
      <section class="space-y-3 max-w-2xl" data-testid="tenant-llm-provider">
        <header class="space-y-1">
          <h2 class="text-lg font-semibold">LLM provider</h2>
          <p class="text-sm text-[var(--color-text-muted)]">
            BYO mode
            <span data-testid="tenant-llm-byo"><Pill tone={byoTone(tenant.byo_mode)}>{tenant.byo_mode}</Pill></span>
            — enter this tenant’s own commercial key per tier, then Test it.
          </p>
          <!-- Per mode: only local_allowed falls back to local-llm; WM's
               llm_config_resolver hard-fails a keyless byo_required tier. -->
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="tenant-llm-note">
            {llmModeNote(tenant.byo_mode)}
          </p>
        </header>
        {#if tenant.byo_mode === 'platform_only'}
          <!-- worker_management enforces byo_mode: a platform_only tenant's
               catalog hides external providers and a PUT of one is a 403
               ("locked to platform inference"). Say so before the owner tries. -->
          <p class="text-sm text-[var(--color-warning-text)]" data-testid="tenant-llm-platform-only">
            This tenant is platform_only, so external providers are hidden and refused. Switch it to
            local_allowed first.
          </p>
        {/if}
        {#if !isArchived(tenant) && tenant.byo_mode !== 'local_allowed'}
          <div class="flex items-center gap-3" data-testid="tenant-llm-allow-local">
            <Button variant="secondary" disabled={byoBusy} onclick={allowLocalAndByo}>
              {byoBusy ? 'Switching…' : 'Allow local-llm + BYO (local_allowed)'}
            </Button>
            <span class="text-xs text-[var(--color-text-muted)]">Takes effect within ~5 minutes.</span>
          </div>
          {#if byoError}
            <p class="text-sm text-[var(--color-danger-text)]" data-testid="tenant-llm-byo-error">{byoError}</p>
          {/if}
        {/if}
        {#if byoSwitched && tenant.byo_mode === 'local_allowed'}
          <p class="text-sm text-[var(--color-success-text)]" data-testid="tenant-llm-byo-switched">
            Switched to local_allowed. Takes effect within ~5 minutes.
          </p>
        {/if}
        {#if isArchived(tenant)}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="tenant-llm-archived">
            Archived tenants cannot be given a provider. Restore the tenant first.
          </p>
        {:else if llmApi}
          <LlmProviderTiers api={llmApi} byoMode={tenant.byo_mode} />
        {/if}
      </section>
    {/if}

    <!-- Inference (owner-only, flag-gated) --------------------------------->
    {#if auth.isSuperAdmin && inferenceConfig?.enabled}
      <TenantInferenceSection
        tenantId={tenant.id}
        config={inferenceConfig}
        archived={isArchived(tenant)}
        currentCurrency={tenant.budget_currency ?? null}
      />
    {:else if auth.isSuperAdmin && inferenceConfigError}
      <p class="text-xs text-[var(--color-warning-text)]" data-testid="tenant-inference-config-error">
        Inference configuration unreadable ({inferenceConfigError}) — the Inference section is not shown.
      </p>
    {/if}

    <!-- Provisioning ------------------------------------------------------->
    <section class="space-y-3" data-testid="tenant-offerings">
      <header>
        <h2 class="text-lg font-semibold">Provisioning</h2>
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="offerings-scope">
          {OFFERINGS_SCOPE_NOTE}
        </p>
      </header>

      {#if rows.length === 0}
        <!-- NOT "No offerings". An empty list is a working configuration: no
             per-product overrides exist, so every product resolves to the
             tenant-wide posture. The copy is a tested helper because a bare
             "none" here reads as "this tenant has nothing". -->
        <EmptyState
          title="No per-product overrides"
          body={describeNoOfferings(tenantByo)}
        />
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="offerings-summary">
          {describeOfferings(offerings)}
        </p>

        <div class="overflow-x-auto">
          <table class="w-full min-w-[48rem] text-sm">
            <thead class="text-left text-[var(--color-text-muted)]">
              <tr class="border-b border-[var(--color-border)]">
                <th class="py-2 pr-3 font-medium">Product</th>
                <th class="py-2 pr-3 font-medium">BYO mode</th>
                <th class="py-2 pr-3 font-medium">Offering</th>
                <th class="py-2 pr-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as row (row.app_key)}
                {@const prov = offeringProvenance(row)}
                <tr class="border-b border-[var(--color-border)]" data-testid="offering-row">
                  <td class="py-2 pr-3">
                    <div class="text-[var(--color-text)]">{productLabel(row)}</div>
                    <div class="font-mono text-xs text-[var(--color-text-muted)]">
                      {row.app_key}
                    </div>
                  </td>
                  <td class="py-2 pr-3">
                    <Pill tone={byoTone(row.byo_mode)}>{row.byo_mode}</Pill>
                    {#if !overridesTenantDefault(row, tenantByo)}
                      <span class="text-xs text-[var(--color-text-muted)]">
                        same as tenant-wide
                      </span>
                    {/if}
                  </td>
                  <td class="py-2 pr-3" data-testid="offering-code">
                    {#if prov.known}
                      <span class="font-mono text-xs">{prov.label}</span>
                    {:else}
                      <!-- ⛔ Do NOT "clean this up" to `{row.offering_code ?? '—'}`.
                           A dash or a blank cell asserts that nothing was
                           provisioned for this product. Null means we do not
                           KNOW what provisioned it — the row may well have been
                           provisioned by an offering whose code was never
                           recorded. See OFFERING_UNKNOWN_NOTE below the table. -->
                      <span
                        class="italic text-[var(--color-text-muted)]"
                        data-testid="offering-unknown"
                      >
                        {prov.label}
                      </span>
                    {/if}
                  </td>
                  <td class="py-2 pr-3">{formatDate(row.updated_at ?? row.created_at)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#if unknownRows > 0}
          <p class="text-xs text-[var(--color-text-muted)]" data-testid="unknown-note">
            {OFFERING_UNKNOWN_NOTE}
          </p>
        {/if}
      {/if}
    </section>
  {/if}
</div>
