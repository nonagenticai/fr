<!--
  /admin/licenses/offerings — commercial offerings.

  An offering bundles BOTH axes of the commercial model for one product:
    USAGE  — BYO posture + markup_pct + absolute surcharges (mirrors billing's
             markup_rules)
    ACCESS — a fixed access_price_usd on a cadence, optionally carrying an
             included usage allowance

  Provisioning one onto a tenant MATERIALIZES it: the BYO posture row, the
  tenant's billing markup rule, and — when priced or when it bundles an
  allowance — the tenant's billing access charge. That is a billing change, not
  a label, which is why every provision/unprovision here confirms first.
-->
<script lang="ts">
  import { Button, Input, Select, Combobox, Pill, Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
  import {
    listOfferings,
    createOffering,
    deleteOffering,
    provisionTenantOffering,
    unprovisionTenantOffering,
    listApps,
    listTenants,
    listTenantOfferings,
    BYO_MODES,
    type OfferingRecord,
    type AppRecord,
    type TenantRecord,
    type TenantOfferingRecord,
    type ByoMode,
  } from '$lib/api/licenses-admin';
  import { usableApps, appLabel, offeringsReadback } from '../page-helpers';
  // Reused, not re-implemented: the tenant-detail screen already renders these
  // rows, and `offering_code: null` MUST read as "provenance unknown" rather
  // than blank — a blank cell claims "nothing provisioned" about tenants that
  // were. A second rendering here would be a second chance to get that wrong.
  import {
    sortOfferings,
    offeringProvenance,
    describeOfferings,
    productLabel,
  } from '../../tenants/[nameOrId]/page-helpers';

  let offerings = $state<OfferingRecord[]>([]);
  let apps = $state<AppRecord[]>([]);
  let tenants = $state<TenantRecord[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let notice = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      // Name map for offerings AND the provisioning picker — service tenants
      // legitimately hold offerings, so they must remain selectable here.
      const [o, a, t] = await Promise.all([
        listOfferings(),
        listApps(),
        listTenants(false, true),
      ]);
      offerings = o;
      apps = a;
      tenants = t;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  const appOpts = $derived(
    usableApps(apps).map((a) => ({ value: a.key, label: appLabel(a), sublabel: a.key })),
  );
  const tenantOpts = $derived(
    [...tenants]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ value: t.id, label: t.name, sublabel: t.byo_mode })),
  );
  const byoOptions = BYO_MODES.map((m) => ({ value: m, label: m }));

  /** `null` = not set (inherit/none). Never coerce a blank to 0 — 0 is a price. */
  const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
  const money = (v: number | null): string => (v == null ? '—' : `$${v}`);
  const pct = (v: number | null): string => (v == null ? '—' : `${v}%`);

  // ---- create ------------------------------------------------------------
  let appKey = $state<string | null>(null);
  let code = $state('');
  let name = $state('');
  let byoMode = $state<ByoMode>('platform_only');
  let markupPct = $state('');
  let accessPrice = $state('');
  let accessCadence = $state('monthly');
  let allowance = $state('');
  let creating = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!appKey || !code.trim() || !name.trim()) return;
    creating = true;
    actionError = null;
    try {
      await createOffering({
        app_key: appKey,
        code: code.trim(),
        name: name.trim(),
        byo_mode: byoMode,
        markup_pct: numOrNull(markupPct),
        access_price_usd: numOrNull(accessPrice),
        access_cadence: accessPrice.trim() ? accessCadence : null,
        included_allowance_usd: numOrNull(allowance),
      });
      code = name = markupPct = accessPrice = allowance = '';
      await load();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      creating = false;
    }
  }

  /**
   * Why a row can be undeletable, and why the button says so instead of dying.
   *
   * `DELETE` addresses an offering by its `(app_key, code)` PAIR
   * (`deleteOffering(app_key, code)`), so a row whose `app_key` came back null
   * has no address to delete. The row renders `—` for that cell and USED TO
   * still render a live Delete button over `if (!o.app_key) return;` — a bare
   * early return BEFORE the confirm, so the click produced no dialog, no
   * request, no toast and no error. The operator pressed a destructive control
   * and the page said nothing at all, which is indistinguishable from "it
   * worked" until they reload and the row is still there.
   *
   * ⛔ The fix is NOT to make the delete work: there is no id-addressed delete
   * route to fall back to, and inventing one client-side would be guessing at
   * which offering to destroy. So the control is disabled and the reason is on
   * screen — an action that cannot be performed must not be offered.
   */
  // ⚠️ A TYPE PREDICATE, not a `boolean`. `remove()` used to narrow `app_key`
  // to `string` with an inline `if (!o.app_key) return;`; moving that check
  // into a helper that returns `boolean` throws the narrowing away, and
  // `deleteOffering(o.app_key, …)` then fails to compile against its
  // `string` parameter. Returning `o is …& { app_key: string }` keeps the
  // guard and the narrowing in one place, so they cannot drift apart.
  const deletable = (o: OfferingRecord): o is OfferingRecord & { app_key: string } =>
    Boolean(o.app_key);

  const undeletableReason =
    'This offering has no product (app_key), and DELETE addresses an offering ' +
    'by product + code — so it cannot be deleted from here. Fix the row upstream ' +
    'in the licenses service, or delete it there.';

  async function remove(o: OfferingRecord) {
    if (!deletable(o)) {
      // Defence in depth: the button is disabled, so this is unreachable from
      // the UI. If it ever IS reached, say so loudly rather than returning into
      // silence — a no-op that leaves no trace is what this replaces.
      actionError = undeletableReason;
      return;
    }
    if (!confirm(`Delete offering “${o.app_key}/${o.code}”? This cannot be undone.`)) return;
    actionError = null;
    try {
      await deleteOffering(o.app_key, o.code);
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- provision onto a tenant ------------------------------------------
  let provTenant = $state<string | null>(null);
  let provOffering = $state<string | null>(null);
  let provBusy = $state(false);

  const offeringOpts = $derived(
    offerings
      .filter((o) => o.app_key)
      .map((o) => ({
        value: `${o.app_key}::${o.code}`,
        label: `${o.app_key} / ${o.code}`,
        sublabel: o.name,
      })),
  );

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.name ?? id;

  // ---- read-back ---------------------------------------------------------
  //
  // provision()/unprovision() used to set a `notice` and stop. `load()` could
  // not confirm them — it fetches the CATALOGUE (offerings, apps, tenants) and
  // holds no tenant->offering assignments at all, so calling it here would
  // re-render identical data and prove nothing. A success message asserting an
  // outcome nobody read back is the defect this whole effort keeps finding.
  //
  // So read back the thing that was actually written: this tenant's offerings.
  let provOfferings = $state<TenantOfferingRecord[] | null>(null);
  let provReadbackBusy = $state(false);
  let provReadbackError = $state<string | null>(null);

  async function refreshTenantOfferings(tenantId: string): Promise<void> {
    provReadbackBusy = true;
    provReadbackError = null;
    try {
      provOfferings = await listTenantOfferings(tenantId);
    } catch (e) {
      // NOT swallowed into an empty list. `[]` is a legitimate state (a tenant
      // with no per-product overrides), so showing it after a failed read would
      // assert "nothing is provisioned" on no evidence.
      provOfferings = null;
      provReadbackError = e instanceof Error ? e.message : String(e);
    } finally {
      provReadbackBusy = false;
    }
  }

  // Show current state BEFORE acting, not only after: an admin about to
  // provision needs to see what the tenant already has.
  $effect(() => {
    const id = provTenant;
    if (!id) {
      provOfferings = null;
      provReadbackError = null;
      return;
    }
    void refreshTenantOfferings(id);
  });

  const provRows = $derived(provOfferings ? sortOfferings(provOfferings) : []);
  // The render decision lives in `offeringsReadback` so it is testable — the
  // claim "a failed read is not an empty list" is one conditional-ordering
  // mistake away from being wrong and invisible in review. Bound here so the
  // tested function is the one that actually runs.
  const readback = $derived(
    offeringsReadback({
      tenantId: provTenant,
      busy: provReadbackBusy,
      error: provReadbackError,
      offerings: provOfferings,
    }),
  );

  async function provision() {
    if (!provTenant || !provOffering) return;
    const [key, c] = provOffering.split('::');
    const o = offerings.find((x) => x.app_key === key && x.code === c);
    if (
      !confirm(
        `Provision “${key}/${c}” onto ${tenantName(provTenant)}?\n\n` +
          `This sets their BYO posture to “${o?.byo_mode}”, writes their billing markup rule` +
          (o?.access_price_usd != null || o?.included_allowance_usd != null
            ? ' and creates their billing access charge.'
            : '.'),
      )
    )
      return;
    provBusy = true;
    actionError = null;
    notice = null;
    try {
      await provisionTenantOffering(provTenant, key!, c!);
      notice = `Provisioned ${key}/${c} onto ${tenantName(provTenant)}.`;
      await refreshTenantOfferings(provTenant);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      provBusy = false;
    }
  }

  async function unprovision() {
    if (!provTenant || !provOffering) return;
    const [key, c] = provOffering.split('::');
    if (
      !confirm(
        `Unprovision “${key}/${c}” from ${tenantName(provTenant)}?\n\n` +
          `Removes their posture override and the billing rules this offering created.`,
      )
    )
      return;
    provBusy = true;
    actionError = null;
    notice = null;
    try {
      await unprovisionTenantOffering(provTenant, key!, c!);
      notice = `Unprovisioned ${key}/${c} from ${tenantName(provTenant)}.`;
      await refreshTenantOfferings(provTenant);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      provBusy = false;
    }
  }
</script>

<div class="space-y-8" data-testid="licenses-offerings-page">
  {#if actionError}
    <p class="text-sm text-[var(--color-danger-text)]" data-testid="offerings-error">{actionError}</p>
  {/if}
  {#if notice}
    <p class="text-sm text-[var(--color-success-text)]" data-testid="offerings-notice">{notice}</p>
  {/if}

  <section class="space-y-4">
    <header>
      <h2 class="text-lg font-semibold">Offerings</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Commercial policy per product. Defining one changes nothing on its own —
        it takes effect when provisioned onto a tenant.
      </p>
    </header>

    {#if loading}
      <div class="space-y-2">
        {#each Array(3) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
      </div>
    {:else if loadError}
      <ErrorState error={loadError} onRetry={load} />
    {:else if offerings.length === 0}
      <EmptyState title="No offerings" body="Define one below to price a product." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-[var(--color-text-muted)]">
            <tr class="border-b border-[var(--color-border)]">
              <th class="py-2 pr-3 font-medium">Product</th>
              <th class="py-2 pr-3 font-medium">Code</th>
              <th class="py-2 pr-3 font-medium">Name</th>
              <th class="py-2 pr-3 font-medium">BYO</th>
              <th class="py-2 pr-3 font-medium">Markup</th>
              <th class="py-2 pr-3 font-medium">Access</th>
              <th class="py-2 pr-3 font-medium">Allowance</th>
              <th class="py-2 font-medium"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each offerings as o (o.id)}
              {@const canDelete = deletable(o)}
              <tr class="border-b border-[var(--color-border)]" data-testid="offering-row">
                <td
                  class="py-2 pr-3 font-mono text-xs"
                  title={canDelete ? undefined : undeletableReason}
                >{o.app_key ?? '—'}</td>
                <td class="py-2 pr-3">{o.code}</td>
                <td class="py-2 pr-3">{o.name}</td>
                <td class="py-2 pr-3"><Pill tone="neutral">{o.byo_mode}</Pill></td>
                <td class="py-2 pr-3">{pct(o.markup_pct)}</td>
                <td class="py-2 pr-3">
                  {money(o.access_price_usd)}{o.access_cadence ? ` / ${o.access_cadence}` : ''}
                </td>
                <td class="py-2 pr-3">{money(o.included_allowance_usd)}</td>
                <td class="py-2 text-right">
                  <!--
                    `title` lives on the wrapper: `Button` exposes no title prop,
                    and a disabled <button> does not fire hover events in every
                    browser, so the tooltip must come from an enabled ancestor.
                  -->
                  <span title={canDelete ? undefined : undeletableReason}>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!canDelete}
                      onclick={() => remove(o)}
                    >Delete</Button>
                  </span>
                  {#if !canDelete}
                    <!--
                      The tooltip alone is not the answer — it is invisible on
                      touch and to a keyboard user. The reason is also on screen.
                    -->
                    <p
                      class="mt-1 text-right text-[11px] text-[var(--color-text-muted)]"
                      data-testid="offering-undeletable"
                    >
                      No product on this row — delete it in the licenses service.
                    </p>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <form class="grid gap-2 sm:grid-cols-4 max-w-4xl" onsubmit={submit}>
      <Combobox bind:value={appKey} options={appOpts} placeholder="Search apps…" emptyLabel="Select an app…" data-testid="offering-app" />
      <Input bind:value={code} placeholder="code (e.g. free-high-markup)" />
      <Input bind:value={name} placeholder="display name" />
      <Select bind:value={byoMode} options={byoOptions} />
      <Input bind:value={markupPct} placeholder="markup % (blank = none)" />
      <Input bind:value={accessPrice} placeholder="access price USD (blank = free)" />
      <Input bind:value={accessCadence} placeholder="cadence (e.g. monthly)" />
      <Input bind:value={allowance} placeholder="included allowance USD" />
      <div class="sm:col-span-4">
        <Button type="submit" variant="primary" disabled={creating}>
          {creating ? 'Creating…' : 'Add offering'}
        </Button>
      </div>
    </form>
  </section>

  <!-- Provision ------------------------------------------------------------ -->
  <section class="space-y-3">
    <header>
      <h2 class="text-lg font-semibold">Provision onto a tenant</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Materializes the offering: BYO posture + billing markup rule + (when priced
        or allowance-bearing) the access charge.
      </p>
    </header>

    <div class="grid gap-2 sm:grid-cols-3 max-w-3xl">
      <Combobox bind:value={provTenant} options={tenantOpts} placeholder="Search tenants…" emptyLabel="Select a tenant…" data-testid="prov-tenant" />
      <Combobox bind:value={provOffering} options={offeringOpts} placeholder="Search offerings…" emptyLabel="Select an offering…" data-testid="prov-offering" />
      <div class="flex gap-2">
        <Button
          variant="primary"
          disabled={provBusy || !provTenant || !provOffering}
          onclick={provision}
        >
          {provBusy ? '…' : 'Provision'}
        </Button>
        <Button
          variant="ghost"
          disabled={provBusy || !provTenant || !provOffering}
          onclick={unprovision}
        >
          Unprovision
        </Button>
      </div>
    </div>

    {#if provTenant}
      <!--
        The read-back. Without it this form wrote and reported success with
        nothing confirming it: `load()` refetches only the CATALOGUE, so the
        page could not show whether a provision landed and the admin had to
        navigate to the tenant-detail screen to find out.
      -->
      <div class="max-w-3xl space-y-2" data-testid="prov-readback">
        <h3 class="text-sm font-semibold">
          Currently provisioned to {tenantName(provTenant)}
        </h3>

        {#if readback.kind === 'loading'}
          <Skeleton />
        {:else if readback.kind === 'error'}
          <!--
            An explicit failure, NOT an empty table. `[]` is a legitimate state,
            so rendering one after a failed read would assert "nothing is
            provisioned" on no evidence.
          -->
          <p class="text-sm text-[var(--color-danger-text)]" data-testid="prov-readback-error">
            Could not read back this tenant's offerings: {readback.message}
          </p>
        {:else if readback.kind === 'empty'}
          <!--
            NOT "no offerings" as a fault. Zero per-product overrides is a
            working configuration — the tenant simply inherits its tenant-wide
            posture.
          -->
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="prov-readback-empty">
            No per-product overrides — this tenant inherits its tenant-wide BYO posture.
          </p>
        {:else if readback.kind === 'rows'}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="prov-readback-summary">
            {describeOfferings(provRows)}
          </p>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--color-border)] text-left">
                <th class="py-1">Product</th>
                <th class="py-1">BYO mode</th>
                <th class="py-1">Offering</th>
              </tr>
            </thead>
            <tbody>
              {#each provRows as row (row.app_key)}
                <tr class="border-b border-[var(--color-border)]" data-testid="prov-readback-row">
                  <td class="py-1">{productLabel(row)}</td>
                  <td class="py-1"><Pill>{row.byo_mode}</Pill></td>
                  <td class="py-1" data-testid="prov-readback-provenance">
                    {offeringProvenance(row).label}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}
  </section>
</div>
