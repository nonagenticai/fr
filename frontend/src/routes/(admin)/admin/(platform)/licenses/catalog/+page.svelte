<!--
  /admin/licenses/catalog — apps, plans and regions.

  The catalog is what "grant a license" can even offer: an app_key enforced at
  the edge but absent here is unlicensable — no license can be minted for it, so
  the route is reachable by nobody. 13 keys sat in exactly that state on prod
  until 2026-07-17.

  Keys are the load-bearing field. license-authz compares `app_key` literally
  against gitops route-registry.yaml, so `skill_builder` vs `skill-builder`
  silently fails closed against a license that looks valid here (licenses
  migration 015). The backend rejects underscores for that reason.
-->
<script lang="ts">
  import { Button, Input, Select, Pill, Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
  import {
    listApps,
    listAppPlans,
    listAppLicenses,
    createApp,
    deleteApp,
    createPlan,
    deletePlan,
    listRegions,
    createRegion,
    type AppRecord,
    type PlanRecord,
    type RegionRecord,
  } from '$lib/api/licenses-admin';
  import { appLabel, planLabel, isTestApp, describeAppDeletion, formatDate } from '../page-helpers';
  import {
    isMalformedRegion,
    offerableRegions,
    regionPickerState,
  } from './page-helpers';
  // ⛔ 2026-09-26 (fr#1046): the rpm input below writes a field nothing reads.
  // The placeholder used to say "blank = default", which asserts enforcement
  // semantics for an inert value. Evidence: $lib/admin/rate-limit-enforcement.
  import {
    RATE_LIMIT_ENFORCED,
    RATE_LIMIT_INPUT_PLACEHOLDER,
    RATE_LIMIT_NOT_ENFORCED_NOTE,
    RATE_LIMIT_NOTICE_TESTID,
  } from '$lib/admin/rate-limit-enforcement';

  let apps = $state<AppRecord[]>([]);
  let regions = $state<RegionRecord[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let includeTest = $state(false);

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [a, r] = await Promise.all([listApps(includeTest), listRegions()]);
      apps = a;
      regions = r;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  // ---- expand an app to see / manage its plans ---------------------------
  let openAppId = $state<string | null>(null);
  let plans = $state<PlanRecord[]>([]);
  let plansLoading = $state(false);

  async function toggleApp(app: AppRecord) {
    if (openAppId === app.id) {
      openAppId = null;
      plans = [];
      return;
    }
    openAppId = app.id;
    plans = [];
    plansLoading = true;
    actionError = null;
    try {
      plans = await listAppPlans(app.id);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      plansLoading = false;
    }
  }

  // ---- create app --------------------------------------------------------
  let newKey = $state('');
  let newName = $state('');
  let newDesc = $state('');
  let creatingApp = $state(false);

  async function submitApp(e: Event) {
    e.preventDefault();
    if (!newKey.trim() || !newName.trim()) return;
    creatingApp = true;
    actionError = null;
    try {
      await createApp({
        key: newKey.trim(),
        name: newName.trim(),
        description: newDesc.trim() || null,
      });
      newKey = newName = newDesc = '';
      await load();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingApp = false;
    }
  }

  /**
   * Deleting an app is a hard cascade (plans -> licenses -> tokens) with no
   * upstream guard. Fetch the real license count first so the confirm states
   * what will actually be destroyed instead of a generic "are you sure?".
   */
  async function removeApp(app: AppRecord) {
    actionError = null;
    let licenses: Awaited<ReturnType<typeof listAppLicenses>> = [];
    try {
      licenses = await listAppLicenses(app.id);
    } catch (e) {
      actionError = `Could not count licenses for ${app.key} — refusing to delete blind: ${
        e instanceof Error ? e.message : String(e)
      }`;
      return;
    }
    if (!confirm(describeAppDeletion(app, licenses))) return;
    try {
      const report = await deleteApp(app.id);
      // The app IS deleted, but the cascade can leave billing quota orphaned (a row
      // billing's re-seeder keeps alive forever). Never let that pass silently — the
      // backend derives this flag from real outcomes, so surface it.
      if (report.billing_quota_retained) {
        actionError =
          `${app.key} was deleted, but ${report.retained_quota_licenses.length} of ` +
          `${report.licenses_found} billing quota config(s) could NOT be deregistered ` +
          `and are now orphaned. Retry the delete (it is idempotent) or clean them up: ` +
          report.retained_quota_licenses.map((r) => r.license_id).join(', ');
      }
      if (openAppId === app.id) {
        openAppId = null;
        plans = [];
      }
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- create plan -------------------------------------------------------
  let planCode = $state('');
  let planName = $state('');
  let planRpm = $state('');
  let planQuota = $state('');
  let planDuration = $state('');
  let planRegion = $state('');
  let creatingPlan = $state(false);

  /**
   * The regions this form may OFFER — see `./page-helpers.ts` (fr#1240) for why the
   * dropdown filters while the Regions list below keeps showing everything.
   *
   * ⛔ GOVERNED BY THE SAME `Show test/demo residue` TOGGLE AS THE APPS TABLE, which is
   * the point: one control, one meaning, both tables. It was already wired to
   * `listApps(includeTest)` and did nothing at all for regions, so a junk region code
   * was offered to a customer as a choice however the operator set it.
   */
  const offeredRegions = $derived(offerableRegions(regions, includeTest));

  const regionOptions = $derived([
    { value: '', label: 'Global (no region)' },
    ...offeredRegions.map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` })),
  ]);

  /**
   * ⛔ WHY THE DROPDOWN NEEDS A SENTENCE BESIDE IT AT ALL. When every stored region row
   * is test/demo-shaped — which was true of all 97 rows measured 2026-09-26/27 — the
   * filter hides ALL of them with the toggle off and the `<Select>` falls to its single
   * `Global (no region)` option. A control with nothing in it and no explanation reads as
   * loading, or as broken; and the one explanation that must NOT be given then is "no
   * regions configured", because rows DO exist and the operator's own filter is hiding
   * them. `regionPickerState` keeps those two apart; see its docblock.
   *
   * ⚠️ THAT STATE IS ARMED, NOT LIVE. The operator purged the catalog (`DELETE 94`);
   * re-measured 2026-09-27, `licenses.region` is **0 rows** (control: `app` 52,
   * `plan` 89), so production takes the `empty` arm and "No regions configured" is now
   * the TRUE sentence. `all-residue-hidden` has zero production subjects until the
   * unfixed seeder reseeds. An earlier revision of this comment said 94 rows survived
   * and the hidden-all state was the page's default — it is not.
   *
   * ⚠️ `loadError` IS PASSED AND CANNOT REACH THE TEMPLATE. `load()` shares one
   * `loadError` across `Promise.all([listApps, listRegions])`, and a non-null `loadError`
   * replaces the whole card with `<ErrorState>` above — so `regionState === 'unreadable'`
   * renders nothing by construction. It is still passed rather than hard-coded `null`
   * because `null` would be a claim the read succeeded. See the comment beside the plan
   * form's region notes.
   */
  const regionState = $derived(
    regionPickerState(!loading, regions.length, offeredRegions.length, loadError),
  );

  /** How many stored rows the filter is currently withholding from the offer. */
  const hiddenRegionCount = $derived(regions.length - offeredRegions.length);

  /** '' means "unset" → null upstream (unlimited/perpetual), never 0. */
  const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

  async function submitPlan(e: Event) {
    e.preventDefault();
    if (!openAppId || !planCode.trim() || !planName.trim()) return;
    creatingPlan = true;
    actionError = null;
    try {
      await createPlan({
        app_id: openAppId,
        code: planCode.trim(),
        name: planName.trim(),
        region_id: planRegion || null,
        rate_limit_rpm: numOrNull(planRpm),
        quota_monthly: numOrNull(planQuota),
        duration_days: numOrNull(planDuration),
      });
      planCode = planName = planRpm = planQuota = planDuration = '';
      plans = await listAppPlans(openAppId);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingPlan = false;
    }
  }

  async function removePlan(plan: PlanRecord) {
    if (!confirm(`Delete plan “${plan.code}”? Licenses referencing it will block this.`)) return;
    actionError = null;
    try {
      await deletePlan(plan.id);
      if (openAppId) plans = await listAppPlans(openAppId);
    } catch (e) {
      // Upstream 409s while licenses still reference the plan — that is a
      // correct refusal, not a fault. Translate it into something actionable.
      const msg = e instanceof Error ? e.message : String(e);
      actionError = /409|CONFLICT/i.test(msg)
        ? `Cannot delete “${plan.code}” — licenses still reference it. Revoke or move them first.`
        : msg;
    }
  }

  // ---- create region -----------------------------------------------------
  let regionCode = $state('');
  let regionName = $state('');
  let creatingRegion = $state(false);

  async function submitRegion(e: Event) {
    e.preventDefault();
    if (!regionCode.trim() || !regionName.trim()) return;
    creatingRegion = true;
    actionError = null;
    try {
      await createRegion({ code: regionCode.trim(), name: regionName.trim() });
      regionCode = regionName = '';
      await load();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingRegion = false;
    }
  }
</script>

<div class="space-y-8" data-testid="licenses-catalog-page">
  {#if actionError}
    <p class="text-sm text-[var(--color-danger-text)]" data-testid="catalog-error">{actionError}</p>
  {/if}

  <!-- Apps ---------------------------------------------------------------- -->
  <section class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">Apps</h2>
        <p class="text-sm text-[var(--color-text-muted)]">
          The key must match <code class="font-mono">app_key</code> in the cluster's
          route registry exactly — the edge compares it literally.
        </p>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          bind:checked={includeTest}
          onchange={load}
          data-testid="include-test-toggle"
        />
        Show test/demo residue
      </label>
    </header>

    {#if loading}
      <div class="space-y-2">
        {#each Array(4) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
      </div>
    {:else if loadError}
      <ErrorState error={loadError} onRetry={load} />
    {:else if apps.length === 0}
      <EmptyState title="No apps in the catalog" body="Nothing can be licensed until an app exists." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-[var(--color-text-muted)]">
            <tr class="border-b border-[var(--color-border)]">
              <th class="py-2 pr-3 font-medium">Key</th>
              <th class="py-2 pr-3 font-medium">Name</th>
              <th class="py-2 pr-3 font-medium">Created</th>
              <th class="py-2 font-medium"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each apps as app (app.id)}
              <tr class="border-b border-[var(--color-border)]" data-testid="app-row">
                <td class="py-2 pr-3 font-mono text-xs">
                  {app.key}
                  {#if isTestApp(app.key)}<Pill tone="warning">test residue</Pill>{/if}
                  {#if app.revoked}<Pill tone="danger">revoked</Pill>{/if}
                </td>
                <td class="py-2 pr-3">{app.name}</td>
                <td class="py-2 pr-3">{formatDate(app.created_at)}</td>
                <td class="py-2">
                  <div class="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onclick={() => toggleApp(app)}>
                      {openAppId === app.id ? 'Hide plans' : 'Plans'}
                    </Button>
                    <Button size="sm" variant="danger" onclick={() => removeApp(app)}>Delete</Button>
                  </div>
                </td>
              </tr>
              {#if openAppId === app.id}
                <tr data-testid="plans-panel">
                  <td colspan="4" class="bg-[var(--color-surface)] p-4">
                    <h3 class="mb-2 text-sm font-semibold">Plans for {appLabel(app)}</h3>
                    {#if plansLoading}
                      <Skeleton class="h-8 w-full" />
                    {:else if plans.length === 0}
                      <p class="mb-3 text-sm text-[var(--color-text-muted)]">
                        No plans — a license cannot be granted for this app until one exists.
                      </p>
                    {:else}
                      <ul class="mb-3 space-y-1">
                        {#each plans as plan (plan.id)}
                          <li class="flex items-center justify-between gap-3 text-sm">
                            <span>
                              {planLabel(plan)}
                              {#if plan.revoked}<Pill tone="danger">revoked</Pill>{/if}
                            </span>
                            <Button size="sm" variant="ghost" onclick={() => removePlan(plan)}>
                              Delete
                            </Button>
                          </li>
                        {/each}
                      </ul>
                    {/if}

                    <form class="grid gap-2 sm:grid-cols-6" onsubmit={submitPlan}>
                      <Input bind:value={planCode} placeholder="code (e.g. standard)" />
                      <Input bind:value={planName} placeholder="name" />
                      <Input bind:value={planRpm} placeholder="rpm — {RATE_LIMIT_INPUT_PLACEHOLDER}" />
                      <Input bind:value={planQuota} placeholder="quota/mo (blank = ∞)" />
                      <Input bind:value={planDuration} placeholder="days (blank = perpetual)" />
                      <Select bind:value={planRegion} options={regionOptions} />
                      <!-- ⚠️ THE NOTE IS A SIBLING OF THE SELECT, NOT A REPLACEMENT FOR
                           IT. `Global (no region)` is always a legitimate choice (a plan
                           with no region IS global, per this section's own subtitle), so
                           the control stays usable in every state below; what changes is
                           whether the page explains why it is offering nothing else. -->
                      <!-- ⛔ THERE IS DELIBERATELY NO `unreadable` BRANCH HERE, AND ONE
                           WAS REMOVED (fr#1240 audit F3). This whole block sits inside
                           the `{:else}` of `{#if loading} … {:else if loadError} …`, so
                           it can only render when `loadError == null` — while
                           `regionPickerState` returns `'unreadable'` only when
                           `loadError` is NON-null. The two conditions are mutually
                           exclusive: a read failure replaces the entire card with
                           `<ErrorState>` and this form does not exist to explain itself.
                           The branch that used to be here could never paint, and the test
                           asserting its ABSENCE passed for the wrong reason — it would
                           have passed against any implementation. `load()` shares ONE
                           `loadError` between the apps read and the regions read; if that
                           is ever split so regions have their own error channel, add the
                           branch back AND a test that renders it. -->
                      {#if regionState === 'empty'}
                        <p
                          class="sm:col-span-6 text-xs text-[var(--color-text-muted)]"
                          data-testid="region-picker-empty"
                        >
                          No regions configured — every plan is global. Add one below if this
                          plan needs to be region-specific.
                        </p>
                      {:else if regionState === 'all-residue-hidden'}
                        <p
                          class="sm:col-span-6 text-xs text-[var(--color-text-muted)]"
                          data-testid="region-picker-all-hidden"
                        >
                          No regions are offered because all {hiddenRegionCount} stored
                          {hiddenRegionCount === 1 ? 'region is' : 'regions are'} test/demo
                          residue — tick <strong>Show test/demo residue</strong> above to pick
                          one anyway. They are listed, and marked, under Regions below.
                        </p>
                      {/if}
                      {#if !RATE_LIMIT_ENFORCED}
                        <p
                          class="sm:col-span-6 text-xs text-[var(--color-text-muted)]"
                          data-testid={RATE_LIMIT_NOTICE_TESTID}
                        >
                          {RATE_LIMIT_NOT_ENFORCED_NOTE}
                        </p>
                      {/if}
                      <div class="sm:col-span-6">
                        <Button type="submit" size="sm" variant="primary" disabled={creatingPlan}>
                          {creatingPlan ? 'Adding…' : 'Add plan'}
                        </Button>
                      </div>
                    </form>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <form class="grid gap-2 sm:grid-cols-4 max-w-3xl" onsubmit={submitApp}>
      <Input bind:value={newKey} placeholder="app key (lowercase-hyphen)" />
      <Input bind:value={newName} placeholder="display name" />
      <Input bind:value={newDesc} placeholder="description (optional)" />
      <Button type="submit" variant="primary" disabled={creatingApp}>
        {creatingApp ? 'Creating…' : 'Add app'}
      </Button>
    </form>
  </section>

  <!-- Regions -------------------------------------------------------------- -->
  <section class="space-y-3">
    <header>
      <h2 class="text-lg font-semibold">Regions</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Optional. A plan with no region is global.
      </p>
    </header>

    {#if regions.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">No regions — all plans are global.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each regions as r (r.id)}
          <!--
            The raw stored value is ALWAYS shown, malformed or not. Rows whose
            code/name still carry an un-interpolated f-string fragment
            (`test-{uuid}`, `test-…​.hex[:8]}`) are junk written by a seeding
            script, not a render failure — see ./page-helpers.ts for the
            evidence. Marking them is the honest response; filtering them out
            would delete the only visible proof the licensing DB holds them.
          -->
          <li class="flex items-center gap-2" data-testid="region-row">
            <code class="font-mono text-xs">{r.code}</code>
            <span>{r.name}</span>
            {#if !r.active}<Pill tone="neutral">inactive</Pill>{/if}
            {#if isMalformedRegion(r)}
              <Pill tone="danger">
                <span
                  title="This value was stored with an un-interpolated template fragment (e.g. an f-string that was never substituted). It is bad data in the licensing DB, not a display problem — purge it upstream."
                  data-testid="region-malformed">malformed value</span
                >
              </Pill>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <form class="grid gap-2 sm:grid-cols-3 max-w-xl" onsubmit={submitRegion}>
      <Input bind:value={regionCode} placeholder="code (e.g. eu)" />
      <Input bind:value={regionName} placeholder="name (e.g. Europe)" />
      <Button type="submit" disabled={creatingRegion}>
        {creatingRegion ? 'Adding…' : 'Add region'}
      </Button>
    </form>
  </section>
</div>
