<!--
  /settings/licenses — "My licenses & tokens" page.

  Lifted UX from portal-bff/static/index.html (table + regenerate modal),
  scoped to fr's apps (FR_LICENSE_APP_KEYS env on the backend, default
  fr,kanban,n8n). Loads via onMount → GET /api/me/licenses (authFetch);
  the route requires a Bearer token so SSR loading is impossible.

  Logic lives in page-helpers.ts so vitest can verify it without DOM.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchMyLicenses,
    regenerateLicenseToken,
    type LicenseRecord,
    type MyLicensesResponse,
  } from '$lib/api/me-licenses';
  import { authFetch } from '$lib/api/auth-fetch';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    formatDate,
    licensesCostDisplay,
    totalTokens,
    triggerRegenerate,
    type RegenerateModalPayload,
  } from './page-helpers';
  import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';

  // W5 per-tenant breakdown response (mirrors backend
  // routes/me/licenses.ts:PerTenantLicensesResponse).
  interface PerTenantLicensesEntry {
    tenant_id: string;
    tenant_name: string | null;
    licenses: LicenseRecord[];
  }
  interface PerTenantLicensesResponse {
    items: PerTenantLicensesEntry[];
  }

  let page = $state<MyLicensesResponse | null>(null);
  let loading = $state(true);
  let loadError = $state<unknown>(null);

  let perTenant = $state<PerTenantLicensesResponse | null>(null);
  let perTenantError = $state<string | null>(null);
  // ⚠️ The per-tenant block must never render a bare "Loading…" that no request
  // backs. This flag is true ONLY while a fetch is genuinely in flight, so the
  // template's terminal branch (below) can say "not loaded" instead of spinning
  // forever. See `loadPerTenant` for the race this replaced.
  let perTenantLoading = $state(false);
  // Non-reactive latch: the $effect below re-runs whenever `auth.isSuperAdmin`
  // is re-read, and we only ever want ONE request.
  let perTenantRequested = false;

  let modalState = $state<RegenerateModalPayload | null>(null);
  let regenInProgress = $state<string | null>(null);
  let regenError = $state<string | null>(null);

  async function fetchPerTenantLicenses(): Promise<PerTenantLicensesResponse> {
    const r = await authFetch('/api/me/licenses/by-tenant');
    if (!r.ok)
      throw new Error(`fetchPerTenantLicenses: ${r.status} ${await r.text()}`);
    return (await r.json()) as PerTenantLicensesResponse;
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      page = await fetchMyLicenses();
    } catch (err) {
      loadError = err;
    } finally {
      loading = false;
    }
  }

  // Super-admin per-tenant breakdown — additive; failures here don't hide the
  // primary single-tenant view.
  //
  // ⚠️ THE DEFECT THIS FIXES. This fetch used to sit at the tail of `load()`
  // behind `if (auth.isSuperAdmin)`, read ONCE from `onMount`. But
  // `auth.isSuperAdmin` is populated asynchronously — `AuthState.initialize()`
  // only sets `_superAdminProbe` after awaiting `GET /api/me/super-admin`
  // (stores/auth.svelte.ts:394), and `initialize()` is started from the ROOT
  // +layout's `onMount`, which Svelte runs AFTER this child page's `onMount`.
  // So the flag was ALWAYS false when `load()` read it and the request was
  // NEVER ISSUED. Moments later the probe landed, `isSuperAdmin` flipped true,
  // the `{#if auth.isSuperAdmin}` block below mounted — and found
  // `perTenant === null` with no error, i.e. the "Loading per-tenant licenses…"
  // placeholder, permanently. A live production sweep captured exactly that.
  //
  // An `$effect` re-reads `auth.isSuperAdmin` when it changes, so the fetch
  // fires whenever the probe lands — before or after mount.
  //
  // ---------------------------------------------------------------------------
  //
  // SECOND GUARD, same block — and of the three routes in this wave, THIS is
  // the one whose backend is genuinely unbounded.
  //
  // `authFetch` (lib/api/auth-fetch.ts:62) calls `fetch()` with no
  // `AbortSignal` and no timeout. Behind it,
  // `GET /api/me/licenses/by-tenant` (backend/src/routes/me/licenses.ts:447-501)
  // fans out one upstream call PER accessible tenant inside a single
  // `Promise.all` (:460), and that upstream path — `licensesClient.request` →
  // `authenticatedFetch` → the raw `fetch` at backend/src/lib/service-auth.ts:233
  // — has NO timeout, NO AbortController and NO signal anywhere (unlike the
  // shared `integrations/_lib/http-client.ts`, which does). With
  // `Bun.serve({ idleTimeout: 0 })` (backend/src/server.ts:2771), one hung
  // tenant hangs the whole response FOREVER. The handler's `try/catch` at
  // :463-491 cannot help: it catches rejections, and a pending promise never
  // rejects — the same reason a `finally` cannot save the client.
  //
  // The healthy path is a handful of quick calls, so 30 s is generous and only
  // fires on the pathological case. ⚠️ The real repair is a timeout on
  // service-auth.ts:233; that is a backend file and NOT in this lane's scope.
  const PER_TENANT_TIMEOUT_MS = 30_000;

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Per-tenant licenses did not load within ${Math.round(ms / 1000)}s.`,
            ),
          ),
        ms,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async function loadPerTenant(): Promise<void> {
    perTenantLoading = true;
    perTenantError = null;
    try {
      perTenant = await withTimeout(
        fetchPerTenantLicenses(),
        PER_TENANT_TIMEOUT_MS,
      );
    } catch (err) {
      perTenantError =
        err instanceof Error
          ? err.message
          : 'Failed to load per-tenant licenses';
    } finally {
      perTenantLoading = false;
    }
  }

  function retryPerTenant(): void {
    perTenantRequested = true;
    void loadPerTenant();
  }

  $effect(() => {
    if (!auth.isSuperAdmin) return;
    if (perTenantRequested) return;
    perTenantRequested = true;
    void loadPerTenant();
  });

  onMount(load);

  async function regenerate(licenseId: string, moduleName: string): Promise<void> {
    regenInProgress = licenseId;
    regenError = null;
    try {
      const result = await triggerRegenerate(licenseId, moduleName, {
        regen: regenerateLicenseToken,
      });
      if (result) modalState = result;
    } catch (err) {
      regenError =
        err instanceof Error ? err.message : 'Failed to regenerate token';
    } finally {
      regenInProgress = null;
    }
  }

  async function copyToken(): Promise<void> {
    if (!modalState) return;
    await navigator.clipboard.writeText(modalState.token);
  }
</script>

<section class="p-6 space-y-6">
  <header class="flex items-baseline justify-between">
    <h1 class="text-2xl font-semibold">My licenses &amp; tokens</h1>
    {#if page?.usage?.period}
      <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        This workspace · {formatDate(page.usage.period.from)} – {formatDate(page.usage.period.to)}
      </p>
    {/if}
  </header>

  {#if loading}
    <Skeleton variant="text" count={5} height="2.5rem" />
  {:else if loadError}
    <ErrorState error={loadError} title="Couldn't load licenses" onRetry={load} />
  {:else if page}
    <div class="grid grid-cols-3 gap-4">
      <div class="rounded border p-4">
        <p class="text-xs text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">Requests</p>
        <p class="text-2xl font-semibold">{page.usage?.totals?.request_count ?? 0}</p>
        <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{page.usage?.totals?.denied_count ?? 0} denied</p>
      </div>
      <div class="rounded border p-4">
        <p class="text-xs text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">Tokens used</p>
        <p class="text-2xl font-semibold">{totalTokens(page.costs?.totals)}</p>
        <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
          {page.costs?.totals?.input_tokens ?? 0} in / {page.costs?.totals?.output_tokens ?? 0} out
        </p>
      </div>
      <div class="rounded border p-4">
        <p class="text-xs text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">Cost (USD)</p>
        <p class="text-2xl font-semibold" data-testid="licenses-cost-total">
          {licensesCostDisplay(page.costs?.totals?.total_cost_usd)}
        </p>
      </div>
    </div>

    {#if regenError}
      <div class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3">
        Failed to regenerate token: {regenError}
      </div>
    {/if}

    {#if page.licenses.length === 0}
      <EmptyState
        title="No licenses yet"
        body="A license is created automatically the first time you use a feature."
      />
    {:else}
      <table class="w-full border rounded">
        <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:bg-[var(--color-bg)]">
          <tr>
            <th class="p-3">Module</th>
            <th class="p-3">Status</th>
            <th class="p-3">Started</th>
            <th class="p-3">Expires</th>
            <th class="p-3 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {#each page.licenses as lic (lic.id)}
            <tr class="border-t">
              <td class="p-3 font-medium">{lic.app?.name ?? lic.app_id}</td>
              <td class="p-3">
                <span class="text-xs px-2 py-0.5 rounded bg-[var(--color-surface)] dark:bg-[var(--color-surface)]">{lic.status}</span>
              </td>
              <td class="p-3 text-sm">{formatDate(lic.starts_at)}</td>
              <td class="p-3 text-sm">{formatDate(lic.expires_at)}</td>
              <td class="p-3 text-right">
                <button
                  class="px-3 py-1 text-sm rounded border hover:bg-[var(--color-surface)] disabled:opacity-50 dark:hover:bg-[var(--color-surface-strong)]"
                  disabled={regenInProgress === lic.id}
                  onclick={() => regenerate(lic.id, lic.app?.name ?? lic.app_id)}
                >
                  {regenInProgress === lic.id ? 'Regenerating…' : 'Regenerate'}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if auth.isSuperAdmin}
      <!-- W5: per-tenant breakdown — super-admin only -->
      <section
        class="rounded border p-4 space-y-3"
        data-testid="licenses-by-tenant"
      >
        <header>
          <h2 class="text-sm font-medium">Per-tenant licenses</h2>
          <p class="text-xs text-[var(--color-text-muted)]">
            Super-admin view — every workspace you can act in, with the fr-app licenses scoped to that tenant.
          </p>
        </header>
        {#if perTenantError}
          <p
            class="text-xs text-[var(--color-danger)]"
            role="alert"
            data-testid="licenses-by-tenant-error"
          >
            {perTenantError}
            <button
              class="ml-2 underline"
              type="button"
              onclick={retryPerTenant}>Retry</button
            >
          </p>
        {:else if perTenantLoading}
          <!-- Only ever shown while a request is genuinely in flight. -->
          <p class="text-xs text-[var(--color-text-muted)]" role="status">
            Loading per-tenant licenses…
          </p>
        {:else if perTenant === null}
          <!-- Terminal: no request in flight and nothing loaded. Reachable if
               the super-admin probe never resolves; says so instead of
               spinning. -->
          <p
            class="text-xs text-[var(--color-text-muted)]"
            role="alert"
            data-testid="licenses-by-tenant-unloaded"
          >
            Per-tenant licenses haven't been loaded.
            <button
              class="ml-2 underline"
              type="button"
              onclick={retryPerTenant}>Load now</button
            >
          </p>
        {:else if perTenant.items.length === 0}
          <p class="text-xs text-[var(--color-text-muted)]">No tenants accessible.</p>
        {:else}
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)]">
              <tr>
                <th class="p-2">Tenant</th>
                <th class="p-2">Module</th>
                <th class="p-2">Status</th>
                <th class="p-2">Started</th>
                <th class="p-2">Expires</th>
              </tr>
            </thead>
            <tbody>
              {#each perTenant.items as row (row.tenant_id)}
                {#if row.licenses.length === 0}
                  <tr class="border-t">
                    <td class="p-2 font-medium">{row.tenant_name ?? row.tenant_id}</td>
                    <td class="p-2 text-[var(--color-text-muted)]" colspan="4">
                      No fr-app licenses.
                    </td>
                  </tr>
                {:else}
                  {#each row.licenses as lic, i (lic.id)}
                    <tr class="border-t">
                      <td class="p-2 font-medium">
                        {#if i === 0}
                          {row.tenant_name ?? row.tenant_id}
                        {/if}
                      </td>
                      <td class="p-2">{lic.app?.name ?? lic.app_id}</td>
                      <td class="p-2">
                        <span class="text-xs px-2 py-0.5 rounded bg-[var(--color-surface)]">{lic.status}</span>
                      </td>
                      <td class="p-2 text-sm">{formatDate(lic.starts_at)}</td>
                      <td class="p-2 text-sm">{formatDate(lic.expires_at)}</td>
                    </tr>
                  {/each}
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}
      </section>
    {/if}
  {/if}
</section>

{#if modalState}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]/50"
    role="dialog"
    aria-modal="true"
  >
    <div class="bg-[var(--color-bg)] rounded-lg p-6 max-w-lg w-full space-y-4 dark:bg-[var(--color-surface)]">
      <h2 class="text-lg font-semibold">New token for {modalState.moduleName}</h2>
      <pre class="bg-[var(--color-surface)] p-3 rounded text-sm overflow-x-auto break-all dark:bg-[var(--color-surface)]">{modalState.token}</pre>
      <p class="text-sm text-[var(--color-warning)]">Save this token now — it won't be shown again.</p>
      <div class="flex gap-2 justify-end">
        <button class="px-3 py-1 text-sm rounded border" onclick={copyToken}>Copy token</button>
        <button
          class="px-3 py-1 text-sm rounded bg-[var(--color-bg)] text-[var(--color-text)]"
          onclick={() => (modalState = null)}
        >
          Close
        </button>
      </div>
    </div>
  </div>
{/if}
