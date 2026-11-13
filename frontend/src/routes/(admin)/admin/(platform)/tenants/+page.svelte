<!--
  /admin/tenants — the tenant register.

  Promoted out of `/admin/licenses/tenants`, where it was the third tab of the
  licensing console. A tenant is not a licensing detail: it is the unit every
  other platform screen is scoped BY (users, budgets, metering, pricing), and
  burying it there meant the only way to see the fleet's tenants was to go
  looking for licences.

  Three things live here.

  1. RENAME. A tenant name is an IDENTIFIER: `/tenants/{name_or_id}` resolves by
     name and licence-authz compares tenant names literally. Until now a typo at
     creation time was permanent.

  2. ARCHIVE. Archiving REVOKES NOTHING — licences, tokens and budgets all
     survive and existing tokens keep authenticating. It hides the tenant from
     pick-lists and marks it "do not provision into this". Both misreadings cost
     real money in opposite directions, so the copy states it outright and comes
     from a unit-tested helper rather than an inline string.

  3. BYO posture, carried over intact from the old page. BYO mode decides who
     pays for inference:
       platform_only  — the tenant uses the platform's LLM credentials
       byo_required   — the tenant MUST bring their own key; we refuse otherwise
       local_allowed  — local/self-hosted inference is acceptable
     It resolves per (tenant, app): a per-product override wins where one
     exists, otherwise the tenant-wide value applies. Enforcement is real — WM's
     graph stages hard-fail a byo_required tenant with no configured key — so
     flipping a tenant to byo_required breaks their runs until they configure
     one.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Button,
    Input,
    Select,
    Combobox,
    Pill,
    Skeleton,
    EmptyState,
    ErrorState,
  } from '$lib/components/ui';
  import {
    listTenants,
    createTenant,
    renameTenant,
    setTenantArchived,
    setTenantByoMode,
    setTenantAppByoMode,
    clearTenantAppByoMode,
    getByoMode,
    listApps,
    BYO_MODES,
    type TenantRecord,
    type AppRecord,
    type ByoMode,
  } from '$lib/api/licenses-admin';
  import { usableApps, appLabel, formatDate } from '../licenses/page-helpers';
  import {
    archivedCount,
    describeTenantArchive,
    describeTenantRename,
    isArchived,
    sortTenants,
    tenantDetailHref,
    tenantNameError,
    tenantNameTakenMessage,
    visibleTenants,
  } from './page-helpers';

  let tenants = $state<TenantRecord[]>([]);
  let apps = $state<AppRecord[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state<string | null>(null);

  let showArchived = $state(false);
  let filter = $state('');

  /**
   * Always fetch WITH archived rows; `showArchived` filters client-side.
   *
   * Fetching without them would make the toggle a round trip, and — worse —
   * would leave `archivedCount` reading 0 whenever the toggle is off, so the
   * hint telling an operator archived tenants exist could never appear.
   *
   * Service actors are requested for the same reason. This screen is the
   * REGISTRY, not a pick-list: upstream hides `kind='service'` rows by default
   * and they are 33 of the 59 live tenants, so without this flag the management
   * table would show 26 and quietly claim that is the whole registry.
   */
  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [t, a] = await Promise.all([listTenants(true, true), listApps()]);
      tenants = t;
      apps = a;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const rows = $derived(sortTenants(visibleTenants(tenants, { showArchived, query: filter })));
  const hiddenArchived = $derived(showArchived ? 0 : archivedCount(tenants));

  const byoOptions = BYO_MODES.map((m) => ({ value: m, label: m }));
  const appOpts = $derived(
    usableApps(apps).map((a) => ({ value: a.key, label: appLabel(a), sublabel: a.key })),
  );

  function fail(e: unknown): void {
    actionError = e instanceof Error ? e.message : String(e);
  }

  // ---- rename ------------------------------------------------------------

  /**
   * Prompt → validate → confirm → PATCH. Deliberately native `window.prompt` +
   * `window.confirm`: there is no modal-confirm component anywhere in routes/,
   * and inventing one for this screen would be the only one in the app.
   *
   * The tenant is addressed by `id`, never by `t.name` — after a rename the
   * name in hand is the one that no longer resolves.
   */
  async function rename(t: TenantRecord): Promise<void> {
    const proposed = prompt(`New name for “${t.name}”:`, t.name);
    if (proposed === null) return;
    if (proposed.trim() === t.name) return;

    const invalid = tenantNameError(proposed);
    if (invalid) {
      actionError = `Rename refused: ${invalid}`;
      return;
    }
    if (!confirm(describeTenantRename(t, proposed))) return;

    busy = t.id;
    actionError = null;
    notice = null;
    try {
      await renameTenant(t.id, proposed.trim());
      notice = `Renamed “${t.name}” to “${proposed.trim()}”.`;
      await load();
    } catch (e) {
      fail(e);
    } finally {
      busy = null;
    }
  }

  // ---- archive / restore -------------------------------------------------

  async function toggleArchived(t: TenantRecord): Promise<void> {
    const next = !isArchived(t);
    if (!confirm(describeTenantArchive(t))) return;

    busy = t.id;
    actionError = null;
    notice = null;
    try {
      await setTenantArchived(t.id, next);
      notice = next
        ? `Archived “${t.name}”. Its licences and tokens are untouched.`
        : `Restored “${t.name}”.`;
      await load();
    } catch (e) {
      fail(e);
    } finally {
      busy = null;
    }
  }

  // ---- tenant-wide BYO posture -------------------------------------------

  async function changeTenantByo(t: TenantRecord, mode: ByoMode): Promise<void> {
    if (mode === t.byo_mode) return;
    if (
      !confirm(
        `Set ${t.name} to “${mode}”?\n\n` +
          (mode === 'byo_required'
            ? 'Their runs will FAIL until they configure their own LLM key.'
            : 'This changes who pays for their inference.'),
      )
    ) {
      // Re-read so the <select> snaps back rather than lying about the state.
      await load();
      return;
    }
    busy = t.id;
    actionError = null;
    try {
      await setTenantByoMode(t.id, mode);
      await load();
    } catch (e) {
      fail(e);
      await load();
    } finally {
      busy = null;
    }
  }

  // ---- per-(tenant, app) override ----------------------------------------
  let overrideTenant = $state<string | null>(null);
  let overrideApp = $state<string | null>(null);
  let overrideMode = $state<ByoMode>('platform_only');
  let overrideBusy = $state(false);
  let resolved = $state<string | null>(null);

  /**
   * Live tenants only. An override pinned onto an archived tenant is work
   * aimed at somewhere nobody should be provisioning into.
   */
  const tenantOpts = $derived(
    sortTenants(tenants.filter((t) => !isArchived(t))).map((t) => ({
      value: t.id,
      label: t.name,
      sublabel: t.byo_mode,
    })),
  );

  async function applyOverride(): Promise<void> {
    if (!overrideTenant || !overrideApp) return;
    overrideBusy = true;
    actionError = null;
    try {
      await setTenantAppByoMode(overrideTenant, overrideApp, overrideMode);
      await checkResolved();
    } catch (e) {
      fail(e);
    } finally {
      overrideBusy = false;
    }
  }

  async function dropOverride(): Promise<void> {
    if (!overrideTenant || !overrideApp) return;
    overrideBusy = true;
    actionError = null;
    try {
      await clearTenantAppByoMode(overrideTenant, overrideApp);
      await checkResolved();
    } catch (e) {
      fail(e);
    } finally {
      overrideBusy = false;
    }
  }

  /** Read back the EFFECTIVE posture — the only honest confirmation. */
  async function checkResolved(): Promise<void> {
    resolved = null;
    if (!overrideTenant || !overrideApp) return;
    try {
      const r = await getByoMode(overrideTenant, overrideApp);
      resolved = r.byo_mode;
    } catch (e) {
      fail(e);
    }
  }

  // ---- create ------------------------------------------------------------
  let newTenant = $state('');
  let newRealm = $state('');
  let creating = $state(false);
  /** 409 `tenant_name_taken` — shown under the create form, not as a page banner. */
  let createConflict = $state<string | null>(null);

  /** Same rule the server enforces, shown under the field instead of as a 422. */
  const newTenantError = $derived(newTenant === '' ? null : tenantNameError(newTenant));

  async function submitTenant(e: Event): Promise<void> {
    e.preventDefault();
    if (newTenant === '' || newTenantError) return;
    creating = true;
    actionError = null;
    createConflict = null;
    notice = null;
    try {
      await createTenant({
        name: newTenant.trim(),
        keycloak_realm: newRealm.trim() || null,
      });
      newTenant = newRealm = '';
      await load();
    } catch (err) {
      createConflict = tenantNameTakenMessage(err);
      if (!createConflict) fail(err);
    } finally {
      creating = false;
    }
  }
</script>

<div class="p-6 space-y-8" data-testid="tenants-page">
  <header class="flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-xl font-semibold text-[var(--color-text)]">Tenants</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Every tenant on the platform, their Keycloak realm and their BYO LLM posture.
      </p>
    </div>
    <Button variant="ghost" onclick={load}>Refresh</Button>
  </header>

  {#if actionError}
    <p class="text-sm text-[var(--color-danger-text)]" data-testid="tenants-error">
      {actionError}
    </p>
  {/if}
  {#if notice}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="tenants-notice">{notice}</p>
  {/if}

  <section class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="w-64">
        <Input bind:value={filter} type="search" placeholder="Filter by name, id or realm…" />
      </div>
      <label class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <input type="checkbox" bind:checked={showArchived} data-testid="show-archived" />
        Show archived
      </label>
      {#if hiddenArchived > 0}
        <!-- Without this an operator looking for a tenant they archived last
             month sees an empty result and concludes it was deleted. -->
        <span class="text-sm text-[var(--color-text-muted)]" data-testid="archived-hint">
          {hiddenArchived} archived tenant{hiddenArchived === 1 ? '' : 's'} hidden
        </span>
      {/if}
    </div>

    {#if loading}
      <div class="space-y-2">
        {#each Array(4) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
      </div>
    {:else if loadError}
      <ErrorState error={loadError} onRetry={load} />
    {:else if tenants.length === 0}
      <EmptyState title="No tenants" body="Create the first one below." />
    {:else if rows.length === 0}
      <EmptyState
        title="No matching tenants"
        body="Clear the filter, or tick “Show archived” if the one you want was archived."
      />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[60rem] text-sm">
          <thead class="text-left text-[var(--color-text-muted)]">
            <tr class="border-b border-[var(--color-border)]">
              <th class="py-2 pr-3 font-medium">Name</th>
              <th class="py-2 pr-3 font-medium">State</th>
              <th class="py-2 pr-3 font-medium">Id</th>
              <th class="py-2 pr-3 font-medium">Realm</th>
              <th class="py-2 pr-3 font-medium">BYO mode</th>
              <th class="py-2 pr-3 font-medium">Created</th>
              <th class="py-2 pr-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as t (t.id)}
              <tr
                class="border-b border-[var(--color-border)] {isArchived(t) ? 'opacity-60' : ''}"
                data-testid="tenant-row"
                data-archived={isArchived(t) ? 'true' : 'false'}
              >
                <td class="py-2 pr-3 text-[var(--color-text)]">
                  <!-- The NAME is the link, not the whole row. This row also
                       carries a <select> and two buttons; an anchor wrapping
                       the <tr> would be invalid markup and would navigate on
                       every attempt to change the posture or archive. -->
                  <a
                    class="underline"
                    href={tenantDetailHref(t)}
                    data-testid="tenant-detail-link"
                  >
                    {t.name}
                  </a>
                </td>
                <td class="py-2 pr-3">
                  {#if isArchived(t)}
                    <!-- `neutral`, not `danger`: archiving revokes nothing, and
                         a red pill would tell the operator it did. -->
                    <Pill tone="neutral">Archived</Pill>
                  {:else}
                    <Pill tone="success">Live</Pill>
                  {/if}
                </td>
                <td class="py-2 pr-3 font-mono text-xs">{t.id}</td>
                <td class="py-2 pr-3">{t.keycloak_realm ?? '—'}</td>
                <td class="py-2 pr-3">
                  <Select
                    value={t.byo_mode as ByoMode}
                    options={byoOptions}
                    disabled={busy === t.id}
                    onchange={(e) =>
                      changeTenantByo(t, (e.currentTarget as HTMLSelectElement).value as ByoMode)}
                  />
                </td>
                <td class="py-2 pr-3">{formatDate(t.created_at)}</td>
                <td class="py-2 pr-3">
                  <div class="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === t.id}
                      onclick={() => rename(t)}
                    >
                      Rename
                    </Button>
                    <!-- `secondary`, not `danger`. This is not a destructive
                         action: nothing is revoked and it is reversible. -->
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === t.id}
                      onclick={() => toggleArchived(t)}
                    >
                      {isArchived(t) ? 'Restore' : 'Archive'}
                    </Button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <p class="text-xs text-[var(--color-text-muted)]">
      Archiving revokes nothing — licences, tokens and budgets survive and existing
      tokens keep working. It hides the tenant from pick-lists and marks it “do not
      provision into this”. Restore it at any time.
    </p>
  </section>

  <!-- Create ---------------------------------------------------------------->
  <section class="space-y-2">
    <header>
      <h2 class="text-lg font-semibold">Add a tenant</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Names are unique per owning app: a name fr already holds is refused, while
        a name only another app holds creates a new fr tenant.
      </p>
    </header>
    <form class="grid gap-2 sm:grid-cols-3 max-w-2xl" onsubmit={submitTenant}>
      <Input bind:value={newTenant} placeholder="tenant name (lowercase-hyphen)" />
      <Input bind:value={newRealm} placeholder="keycloak realm (optional)" />
      <Button type="submit" variant="primary" disabled={creating || Boolean(newTenantError)}>
        {creating ? 'Creating…' : 'Add tenant'}
      </Button>
    </form>
    {#if newTenantError}
      <p class="text-sm text-[var(--color-danger-text)]" data-testid="new-tenant-error">
        {newTenantError}
      </p>
    {/if}
    {#if createConflict}
      <p class="text-sm text-[var(--color-danger-text)]" data-testid="new-tenant-conflict">
        {createConflict}
      </p>
    {/if}
  </section>

  <!-- Per-product override -------------------------------------------------->
  <section class="space-y-3">
    <header>
      <h2 class="text-lg font-semibold">Per-app BYO override</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Pin one product's posture for one tenant. Clearing the override falls back
        to the tenant-wide value.
      </p>
    </header>

    <div class="grid gap-2 sm:grid-cols-4 max-w-3xl">
      <Combobox
        bind:value={overrideTenant}
        options={tenantOpts}
        onSelect={checkResolved}
        placeholder="Search tenants…"
        emptyLabel="Select a tenant…"
        data-testid="override-tenant"
      />
      <Combobox
        bind:value={overrideApp}
        options={appOpts}
        onSelect={checkResolved}
        placeholder="Search apps…"
        emptyLabel="Select an app…"
        data-testid="override-app"
      />
      <Select bind:value={overrideMode} options={byoOptions} />
      <div class="flex gap-2">
        <Button
          variant="primary"
          disabled={overrideBusy || !overrideTenant || !overrideApp}
          onclick={applyOverride}
        >
          Set
        </Button>
        <Button
          variant="ghost"
          disabled={overrideBusy || !overrideTenant || !overrideApp}
          onclick={dropOverride}
        >
          Clear
        </Button>
      </div>
    </div>

    {#if resolved}
      <p class="text-sm" data-testid="resolved-byo">
        Effective posture for this pair: <Pill tone="accent">{resolved}</Pill>
        <span class="text-[var(--color-text-muted)]">(read back from the service)</span>
      </p>
    {/if}
  </section>
</div>
