<script lang="ts">
  // Platform budget — the cross-tenant view.
  //
  // `GET /budget/:tenantId`, `GET /budget-packages`,
  // `POST /budget/topup/:tenantId`, `POST /budget/reset/:tenantId` and
  // `PATCH /budget/line/:licenseId` back this screen. The first three had ZERO
  // frontend callers until this page existed; reset and the per-licence adjust
  // were added with it (2026-10-31) after an operator could see that conveyor
  // held 306.8M consumed tokens but had no way to read the figure, no way to
  // see WHICH of its 23 budget rows were burning, and no way to act.
  //
  // THE TABLE IS GROUPED, not filtered. Five real customers used to sit
  // indistinguishable among 33 service actors and 3 test tenants; grouping is
  // the fix, and it is deliberately the only fix — fr#936 was a filter that
  // deleted 33 rows while the page still returned 200. Every tenant fetched is
  // rendered by exactly one group, and a collapsed group still states its
  // count, so nothing here can go missing without saying so.
  //
  // THREE RULES THE NUMBERS OBEY:
  //   1. A number we do not have is `—`, never 0.
  //   2. A tenant's figure is a SUM over stacked budget rows, and the screen
  //      says so (`sum of N budget rows`) instead of presenting it as one
  //      budget. Each row is listed, with its licence.
  //   3. A failed read says "Could not read"; it is never "no budget configured".
  import { onMount } from 'svelte';
  import {
    listTenants,
    fetchTenantBudget,
    fetchAdminBudgetPackages,
    topUpTenantBudget,
    resetTenantBudget,
    setLicenseBudgetOverride,
    type TenantRecord,
  } from '$lib/api/licenses-admin';
  import type { TopUpPackage } from '$lib/api/budget';
  import { formatTokens } from '../../(tenant)/budget/page-helpers';
  import {
    buildTenantBudgetView,
    budgetLineViews,
    budgetRowsLabel,
    budgetStateLabel,
    budgetSumLabel,
    formatTokensOrDash,
    parseBudgetOverride,
    partitionByKind,
    resetResultNotice,
    sortByUrgency,
    summariseGroup,
    topUpCellState,
    usedPercentLabel,
    usedTokens,
    type TenantBudgetView,
  } from './page-helpers';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let packages = $state<TopUpPackage[]>([]);
  let views = $state<TenantBudgetView[]>([]);
  let nameById = $state<Record<string, string>>({});
  /** Tenant classification, keyed the same way as `nameById`. Absent → unclassified. */
  let kindById = $state<Record<string, string | null | undefined>>({});
  let costCentreById = $state<Record<string, string | null | undefined>>({});
  /** Tenants whose budget read FAILED — never silently shown as unconfigured. */
  let unreadable = $state<Set<string>>(new Set());
  /** The package CATALOGUE read failed — never silently shown as "no packages". */
  let packagesUnreadable = $state(false);
  // BUDGET_TOPUP_ENABLED (backend kill switch, off until a payment gateway
  // exists — no free top-up, not even operator-granted). False hides the
  // Top up controls. An UNREADABLE catalogue keeps them so the failure is
  // still named rather than looking like a deliberate "disabled".
  let topupEnabled = $state(false);
  const showTopUp = $derived(topupEnabled || packagesUnreadable);
  // Tenant | Kind | Cost centre | State | Budget | Remaining | Used | Actions
  const colCount = 8;
  let busyTenant = $state<string | null>(null);
  let busyLine = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** Tenants whose breakdown is open. Reassigned, never mutated, so Svelte sees it. */
  let expanded = $state<Set<string>>(new Set());
  /** Adjust inputs, keyed by `BudgetLineView.key`. '' means "clear the override". */
  let drafts = $state<Record<string, string>>({});
  /** Failure text for the action that produced it, keyed by tenant or line key. */
  let actionErrors = $state<Record<string, string>>({});

  // Machine principals and test residue are noise for the operator MOST of the
  // time, which is why they start collapsed — but only collapsed. Their headers
  // carry the counts unconditionally.
  let showServices = $state(false);
  let showTests = $state(false);

  // Sort FIRST, then partition: urgency ordering is what the operator scans by,
  // and it has to survive inside each group, not just across the flat list.
  const groups = $derived(partitionByKind(sortByUrgency(views), kindById));
  const workspacesSummary = $derived(summariseGroup(groups.workspaces));
  const serviceSummary = $derived(summariseGroup(groups.services));
  const testSummary = $derived(summariseGroup(groups.tests));
  const groupedCount = $derived(
    groups.workspaces.length + groups.services.length + groups.tests.length,
  );
  // The fr#936 tripwire. Grouping must be a partition of everything fetched; if
  // a row ever fails to land in a group it must be LOUD, not absent. This is
  // rendered, not console-logged, because a dropped row is exactly the failure
  // nobody goes looking in the console for.
  const dropped = $derived(views.length - groupedCount);
  const topUpCell = $derived(topUpCellState(packages.length, packagesUnreadable));

  async function load(): Promise<void> {
    loading = true;
    error = null;
    packagesUnreadable = false;
    try {
      const [tenants, pkgs] = await Promise.all([
        // Service actors accrue on-behalf spend and have budgets, and this
        // list is the ROW SOURCE for the table — not a pick-list. Filtering
        // them out does not rename 33 rows, it deletes them from the page.
        listTenants(false, true),
        // Non-fatal — a missing catalogue must not blank the budget table —
        // but recorded: an empty catalogue and an unreadable one paint the
        // same em-dash in every Top up cell, and demand opposite actions.
        fetchAdminBudgetPackages().catch((e) => {
          // The boolean says THAT the catalogue is unreadable; it cannot say
          // WHY, and why is the half that tells an admin whether retrying can
          // help. `topUpCellState` needs only the boolean, so the reason goes
          // to the console beside it rather than being dropped on the floor.
          console.warn('[tenant-budgets] top-up catalogue unreadable', e);
          packagesUnreadable = true;
          return { packages: [] as TopUpPackage[], topupEnabled: false };
        }),
      ]);
      packages = pkgs.packages;
      topupEnabled = pkgs.topupEnabled;
      nameById = Object.fromEntries(tenants.map((t: TenantRecord) => [t.id, t.name]));
      // Built from the SAME array as `nameById`, in the same pass, so grouping
      // can never disagree with naming about which tenants exist.
      kindById = Object.fromEntries(tenants.map((t: TenantRecord) => [t.id, t.kind]));
      costCentreById = Object.fromEntries(
        tenants.map((t: TenantRecord) => [t.id, t.cost_centre]),
      );

      // One read per tenant, all in flight together. A single tenant's failure
      // must not blank the whole table — settle, then mark that row unreadable
      // so it is never confused with "no budget configured".
      const settled = await Promise.allSettled(
        tenants.map((t: TenantRecord) => fetchTenantBudget(t.id)),
      );
      const failed = new Set<string>();
      views = settled.map((res, i) => {
        const id = tenants[i]!.id;
        if (res.status === 'fulfilled') return buildTenantBudgetView(id, res.value);
        failed.add(id);
        return buildTenantBudgetView(id, null);
      });
      unreadable = failed;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function failureText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function topUp(tenantId: string, packageId: string): Promise<void> {
    busyTenant = tenantId;
    notice = null;
    try {
      await topUpTenantBudget(tenantId, packageId, crypto.randomUUID());
      notice = `Topped up ${nameById[tenantId] ?? tenantId}.`;
      await load();
    } catch (e) {
      error = failureText(e);
    } finally {
      busyTenant = null;
    }
  }

  /**
   * Zero every consumed counter the tenant holds.
   *
   * Confirm-gated (window.confirm — this repo's level of ceremony) because it
   * rewrites the meter for every budget row at once. The result is reported
   * from billing's own numbers and the table is RELOADED: nothing here claims
   * success from the absence of a thrown error.
   */
  async function resetBudget(tenantId: string): Promise<void> {
    const name = nameById[tenantId] ?? tenantId;
    const ok = window.confirm(
      `Reset every consumed token counter for ${name}?\n\n` +
        'The budget allowances stay as they are — only the consumed totals are zeroed, ' +
        'so the full allowance becomes available again. This cannot be undone.',
    );
    if (!ok) return;

    busyTenant = tenantId;
    notice = null;
    delete actionErrors[tenantId];
    try {
      const result = await resetTenantBudget(tenantId, null);
      notice = resetResultNotice(name, result);
      await load();
    } catch (e) {
      actionErrors[tenantId] = failureText(e);
    } finally {
      busyTenant = null;
    }
  }

  /**
   * Save one licence's budget override (or clear it, when the input is empty).
   *
   * Refused locally when the input is not a non-negative whole number, so a
   * typo never reaches the write. On success the table is reloaded and the
   * RESULT is what the page shows — never an optimistic edit.
   */
  async function saveOverride(tenantId: string, lineKey: string, licenseId: string): Promise<void> {
    const parsed = parseBudgetOverride(drafts[lineKey] ?? '');
    if (!parsed.ok) {
      actionErrors[lineKey] = parsed.error;
      return;
    }
    busyLine = lineKey;
    notice = null;
    delete actionErrors[lineKey];
    try {
      await setLicenseBudgetOverride(licenseId, parsed.value, null);
      notice =
        parsed.value === null
          ? `Cleared the budget override on licence ${licenseId}; the plan allowance applies again.`
          : `Set the budget override on licence ${licenseId} to ${formatTokens(parsed.value)} tokens.`;
      drafts[lineKey] = '';
      await load();
    } catch (e) {
      actionErrors[lineKey] = failureText(e);
    } finally {
      busyLine = null;
    }
  }

  function toggleExpanded(tenantId: string): void {
    const next = new Set(expanded);
    if (next.has(tenantId)) next.delete(tenantId);
    else next.add(tenantId);
    expanded = next;
  }

  function setDraft(key: string, value: string): void {
    drafts[key] = value;
  }

  onMount(load);
</script>

<!-- Declared at the top level, outside every element: the rows are `<tr>`, and
     only here is there no enclosing element for them to be invalid inside. The
     three groups render identical rows, and a copy per group is how the
     "Could not read" and Top-up states drift apart between them. -->
{#snippet tenantRows(rows: TenantBudgetView[])}
  {#each rows as row (row.tenantId)}
    <tr data-testid="tenant-row" class="border-t border-[var(--color-border)]">
      <td class="py-2 pr-3 text-[var(--color-text)]">
        {nameById[row.tenantId] ?? row.tenantId}
      </td>
      <td class="py-2 pr-3 text-[var(--color-text-muted)]">
        <!-- A licences deployment older than migration 027 omits `kind`
             entirely. That reads as "unclassified" and still shows the row —
             it must never become a reason to leave the row out. -->
        {kindById[row.tenantId] ?? 'unclassified'}
      </td>
      <td class="py-2 pr-3 text-[var(--color-text-muted)]">
        <!-- A null cost centre means the apportionment is UNDECIDED, not that
             the tenant costs nothing. Rendering 0, or "none", would invite
             someone to stop chasing an unassigned bill. -->
        {costCentreById[row.tenantId] ?? '—'}
      </td>
      <td class="py-2 pr-3 text-[var(--color-text-muted)]">
        {#if unreadable.has(row.tenantId)}
          <!-- A failed read is NOT "no budget configured". Saying so
               would invite an operator to create a budget that already
               exists. -->
          <span class="text-[var(--color-danger)]">Could not read</span>
        {:else}
          {budgetStateLabel(row)}
        {/if}
      </td>
      <td class="py-2 pr-3 text-[var(--color-text-muted)]" data-testid="budget-total">
        <!-- THE TOTAL IS SHOWN, and when it is a SUM of several rows the row
             count is stated. A bare aggregate reads as one budget, which is a
             different claim and sends the operator looking for a row that does
             not exist. -->
        {#if unreadable.has(row.tenantId)}
          <span class="text-[var(--color-danger)]">Could not read</span>
        {:else}
          {formatTokensOrDash(row.totalTokens)}
          {#if budgetSumLabel(row)}
            <span class="ml-2 text-xs text-[var(--color-text-muted)]" data-testid="budget-sum-label">
              {budgetSumLabel(row)}
            </span>
          {/if}
        {/if}
      </td>
      <td class="py-2 pr-3 text-[var(--color-text-muted)]">
        {formatTokensOrDash(row.remainingTokens)}
      </td>
      <td class="py-2 pr-3" data-testid="budget-used">
        <!-- The figure first, then the percent, then the bar. The bar alone was
             the defect: at 0% it is a 0-width invisible div, and no admin could
             read used tokens anywhere on this page. -->
        {#if unreadable.has(row.tenantId)}
          <span class="text-[var(--color-danger)]">Could not read</span>
        {:else if usedTokens(row) === null || row.consumedFraction === null}
          <span class="text-[var(--color-text-muted)]">—</span>
        {:else}
          <div class="flex items-baseline gap-2">
            <span class="text-[var(--color-text)]">{formatTokens(usedTokens(row)!)}</span>
            <span class="text-xs text-[var(--color-text-muted)]">{usedPercentLabel(row.consumedFraction)}</span>
          </div>
          <div
            class="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-[var(--color-surface-strong)]"
            role="img"
            aria-label={usedPercentLabel(row.consumedFraction)}
          >
            <div
              class="h-full rounded-full bg-[var(--color-accent)]"
              style={`width:${Math.round(row.consumedFraction * 100)}%`}
            ></div>
          </div>
        {/if}
      </td>
      <td class="py-2 pr-3">
        <div class="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-testid="toggle-breakdown"
            aria-expanded={expanded.has(row.tenantId)}
            disabled={row.entries.length === 0}
            onclick={() => toggleExpanded(row.tenantId)}
            class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            {expanded.has(row.tenantId) ? 'Hide rows' : `Rows (${row.entries.length})`}
          </button>
          <button
            type="button"
            data-testid="reset-budget"
            disabled={busyTenant === row.tenantId || unreadable.has(row.tenantId) || row.entries.length === 0}
            onclick={() => resetBudget(row.tenantId)}
            class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Reset
          </button>
          {#if showTopUp}
            {#if topUpCell === 'unreadable'}
              <!-- Same reasoning as the State column: an em-dash here reads
                   as "no top-up packages exist", which would send an
                   operator off to create packages that are already there. -->
              <span class="text-[var(--color-danger)]" data-testid="topup-packages-unreadable">
                Packages unreadable
              </span>
            {:else if topUpCell === 'packages'}
              {#each packages as pkg (pkg.id)}
                <button
                  type="button"
                  disabled={busyTenant === row.tenantId}
                  onclick={() => topUp(row.tenantId, pkg.id)}
                  class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
                >
                  {pkg.label}
                </button>
              {/each}
            {/if}
          {/if}
        </div>
        {#if actionErrors[row.tenantId]}
          <p data-testid="tenant-action-error" class="mt-1 text-xs text-[var(--color-danger)]">
            {actionErrors[row.tenantId]}
          </p>
        {/if}
      </td>
    </tr>

    {#if expanded.has(row.tenantId)}
      <tr data-testid="tenant-breakdown" class="border-t border-[var(--color-border)]">
        <td colspan={colCount} class="bg-[var(--color-surface)] px-3 py-3">
          {#if row.entries.length === 0}
            <p class="text-xs text-[var(--color-text-muted)]">No budget rows to break down.</p>
          {:else}
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  <th class="py-1 pr-3 font-normal">Licence</th>
                  <th class="py-1 pr-3 font-normal">Source</th>
                  <th class="py-1 pr-3 font-normal">Budget</th>
                  <th class="py-1 pr-3 font-normal">Used</th>
                  <th class="py-1 pr-3 font-normal">Remaining</th>
                  <th class="py-1 pr-3 font-normal">Period</th>
                  <th class="py-1 pr-3 font-normal">Expires</th>
                  <th class="py-1 pr-3 font-normal">Priority</th>
                  <th class="py-1 pr-3 font-normal">Adjust</th>
                </tr>
              </thead>
              <tbody>
                {#each budgetLineViews(row.entries) as line (line.key)}
                  <tr class="border-t border-[var(--color-border)]" data-testid="budget-line">
                    <td class="py-1 pr-3 text-[var(--color-text)]">{line.licenseId ?? '—'}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{line.source ?? '—'}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{formatTokensOrDash(line.budgetTokens)}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{formatTokensOrDash(line.usedTokens)}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{formatTokensOrDash(line.remainingTokens)}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{line.period ?? '—'}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{line.expiresAt ?? '—'}</td>
                    <td class="py-1 pr-3 text-[var(--color-text-muted)]">{line.priority ?? '—'}</td>
                    <td class="py-1 pr-3">
                      {#if line.licenseId}
                        <div class="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            data-testid="budget-override-input"
                            placeholder="tokens (empty clears)"
                            value={drafts[line.key] ?? ''}
                            oninput={(e) => setDraft(line.key, e.currentTarget.value)}
                            class="w-40 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)]"
                          />
                          <button
                            type="button"
                            data-testid="budget-override-save"
                            disabled={busyLine === line.key}
                            onclick={() => saveOverride(row.tenantId, line.key, line.licenseId!)}
                            class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
                          >
                            Save
                          </button>
                        </div>
                        {#if actionErrors[line.key]}
                          <p data-testid="line-action-error" class="mt-1 text-xs text-[var(--color-danger)]">
                            {actionErrors[line.key]}
                          </p>
                        {/if}
                      {:else}
                        <!-- Say WHY there is no control, rather than hiding it:
                             a missing control looks like a UI gap, and an
                             operator would report it as one. -->
                        <span class="text-[var(--color-text-muted)]" data-testid="line-not-adjustable">
                          Cannot be adjusted — no licence backs this row{line.source ? ` (source: ${line.source})` : ''}.
                        </span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </td>
      </tr>
    {/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-4">
  <header class="flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-xl font-semibold text-[var(--color-text)]">Budgets</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Token budgets across every tenant, grouped by kind. Ordered by what needs attention.
      </p>
    </div>
    <button
      type="button"
      onclick={load}
      class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)]"
    >
      Refresh
    </button>
  </header>

  {#if error}
    <p
      data-testid="admin-budget-error"
      class="rounded-[var(--radius-sm)] border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {error}
    </p>
  {/if}
  {#if notice}
    <p data-testid="admin-budget-notice" class="text-sm text-[var(--color-text-muted)]">{notice}</p>
  {/if}
  {#if dropped > 0}
    <p
      data-testid="admin-budget-dropped"
      class="rounded-[var(--radius-sm)] border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {dropped} tenant(s) were read but landed in no group and are not shown below. This is a bug —
      do not treat the table as complete.
    </p>
  {/if}

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if groupedCount === 0}
    <p class="text-sm text-[var(--color-text-muted)]">No tenants.</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full min-w-[70rem] text-sm">
        <thead>
          <tr class="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <th class="py-2 pr-3 font-normal">Tenant</th>
            <th class="py-2 pr-3 font-normal">Kind</th>
            <th class="py-2 pr-3 font-normal">Cost centre</th>
            <th class="py-2 pr-3 font-normal">State</th>
            <th class="py-2 pr-3 font-normal">Budget</th>
            <th class="py-2 pr-3 font-normal">Remaining</th>
            <th class="py-2 pr-3 font-normal">Used</th>
            <th class="py-2 pr-3 font-normal">Actions</th>
          </tr>
        </thead>

        <!-- Workspaces: customer, internal and unclassified. The rows an
             operator came here for, always expanded. The header states the
             tenant count AND the number of budget rows the aggregate covers —
             the aggregate is a sum, and saying so is the point. -->
        <tbody>
          <tr
            data-testid="group-workspaces"
            class="border-t border-[var(--color-border)] bg-[var(--color-surface-strong)]"
          >
            <th colspan={colCount} class="py-2 pr-3 text-left text-sm font-semibold text-[var(--color-text)]">
              Workspaces ({workspacesSummary.count} tenants · {budgetRowsLabel(workspacesSummary.budgetRowCount)})
            </th>
          </tr>
          {@render tenantRows(groups.workspaces)}
        </tbody>

        <!-- Service actors: machine principals that hold real budgets and spend
             real tokens on behalf of workspaces. Collapsed, never removed — the
             header states the count and the aggregate so an operator can see
             that the spend exists without unfolding 33 rows. -->
        {#if serviceSummary.count > 0}
        <tbody>
          <tr
            data-testid="group-services"
            class="border-t border-[var(--color-border)] bg-[var(--color-surface-strong)]"
          >
            <th colspan={colCount} class="py-2 pr-3 text-left font-normal">
              <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <button
                  type="button"
                  data-testid="toggle-services"
                  aria-expanded={showServices}
                  onclick={() => (showServices = !showServices)}
                  class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-sm font-semibold text-[var(--color-text)] transition hover:bg-[var(--color-surface)]"
                >
                  {showServices ? 'Hide' : 'Show'} service actors ({serviceSummary.count})
                </button>
                <span class="text-sm text-[var(--color-text-muted)]" data-testid="group-services-summary">
                  {formatTokensOrDash(serviceSummary.remainingTokens)} remaining · {usedPercentLabel(
                    serviceSummary.consumedFraction,
                  )} · {budgetRowsLabel(serviceSummary.budgetRowCount)}
                </span>
                {#if serviceSummary.unconfigured > 0}
                  <!-- Surfaced in the collapsed header on purpose: an
                       unconfigured budget is an action, and folding the group
                       away must not fold the action away with it. -->
                  <span class="text-sm text-[var(--color-text-muted)]">
                    {serviceSummary.unconfigured} with no budget configured
                  </span>
                {/if}
              </div>
            </th>
          </tr>
          {#if showServices}
            {@render tenantRows(groups.services)}
          {/if}
        </tbody>

        <!-- Test tenants: residue, but residue that still holds budgets. Same
             rule as above — collapsed by default, counted always. -->
        {/if}

        {#if testSummary.count > 0}
        <tbody>
          <tr
            data-testid="group-tests"
            class="border-t border-[var(--color-border)] bg-[var(--color-surface-strong)]"
          >
            <th colspan={colCount} class="py-2 pr-3 text-left font-normal">
              <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <button
                  type="button"
                  data-testid="toggle-tests"
                  aria-expanded={showTests}
                  onclick={() => (showTests = !showTests)}
                  class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-sm font-semibold text-[var(--color-text)] transition hover:bg-[var(--color-surface)]"
                >
                  {showTests ? 'Hide' : 'Show'} test tenants ({testSummary.count})
                </button>
                <span class="text-sm text-[var(--color-text-muted)]">
                  {budgetRowsLabel(testSummary.budgetRowCount)}
                </span>
              </div>
            </th>
          </tr>
          {#if showTests}
            {@render tenantRows(groups.tests)}
          {/if}
        </tbody>
        {/if}
      </table>
    </div>
  {/if}
</div>
