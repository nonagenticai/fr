<script lang="ts">
  // Who has access to fr, and where — and the two actions that change it.
  //
  // Before this, fr could not answer that question at all: Keycloak's search
  // needs >=2 characters and cannot enumerate, so the only route to a person
  // was a typeahead inside the grants form — you could look someone up if you
  // already knew their name, and could not ask "who are the admins?".
  //
  // Grant/revoke live here rather than on a separate screen because the list is
  // the only place that shows what a person already holds, and both actions are
  // only safe to take against that.
  import { onMount } from 'svelte';
  import {
    listAdminUsers,
    grantUserRole,
    revokeUserRole,
    type AdminUser,
    type AdminUserWorkspace,
    type WorkspaceRoleName,
  } from '$lib/api/super-admin';
  import {
    listTenants,
    searchUsers,
    type TenantRecord,
    type PersonRecord,
  } from '$lib/api/licenses-admin';
  import {
    Button,
    Select,
    Combobox,
    Skeleton,
    EmptyState,
    ErrorState,
    type ComboOption,
  } from '$lib/components/ui';
  import {
    asWorkspaceRole,
    describeGrantOutcome,
    describeRevokeOutcome,
    describeRoleRevoke,
    danglingCount,
    filterAdminUsers,
    holdsGrant,
    personLabel,
    roleOptions,
    seedArtifactCount,
    unresolvedBadge,
    workspaceLabel,
  } from './page-helpers';

  let loading = $state(true);
  let error = $state<unknown>(null);
  let users = $state<AdminUser[]>([]);
  let grantCount = $state(0);
  let directoryError = $state<string | null>(null);
  let filter = $state('');

  const shown = $derived(filterAdminUsers(users, filter));
  const dangling = $derived(danglingCount(users));
  const seeded = $derived(seedArtifactCount(users));

  // Action feedback is kept separate from `error`: a failed revoke must not
  // blank the list the operator is reading to decide what to do next.
  let actionError = $state<string | null>(null);
  let actionNote = $state<string | null>(null);
  /** `${user_id}:${tenant_id}:${role}` of the row currently in flight. */
  let busyRow = $state<string | null>(null);

  const rowKey = (userId: string, w: { tenant_id: string; role: string }): string =>
    `${userId}:${w.tenant_id}:${w.role}`;

  // Grant form ---------------------------------------------------------------
  // The person picker searches Keycloak rather than the list above: someone
  // with zero grants does not appear in `/api/admin/users` at all, and they are
  // exactly who a first grant is for.
  let tenants = $state<TenantRecord[]>([]);
  let tenantsError = $state<string | null>(null);
  let personPick = $state<string | null>(null);
  let selectedPerson = $state<PersonRecord | null>(null);
  let knownPeople: Record<string, PersonRecord> = {};
  let grantTenant = $state<string | null>(null);
  let grantRole = $state<WorkspaceRoleName>('workspace-member');
  let granting = $state(false);

  const tenantOptions = $derived(
    [...tenants]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ value: t.id, label: t.name, sublabel: t.id })),
  );

  const selectedTenant = $derived(tenants.find((t) => t.id === grantTenant) ?? null);

  // Warn before spending a request that would come back 200 and change nothing.
  const alreadyHeld = $derived.by(() => {
    const person = selectedPerson;
    const tenantId = grantTenant;
    if (!person || !tenantId) return false;
    const listed = users.find((u) => u.user_id === person.id);
    return listed ? holdsGrant(listed, tenantId, grantRole) : false;
  });

  async function loadPersonOptions(q: string): Promise<ComboOption[]> {
    const results = await searchUsers(q);
    // Remember each hit so onSelect can recover the full record; the Combobox
    // hands back only the value.
    for (const p of results) knownPeople[p.id] = p;
    return results.map((p) => ({
      value: p.id,
      label: p.name || (p.email ?? p.id),
      sublabel: p.email ?? p.id,
    }));
  }

  function onPersonSelect(value: string | null): void {
    selectedPerson = value ? (knownPeople[value] ?? null) : null;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await listAdminUsers();
      users = res.users;
      grantCount = res.grant_count;
      directoryError = res.directory_error;
    } catch (e) {
      error = e;
    } finally {
      loading = false;
    }
  }

  async function loadTenants(): Promise<void> {
    tenantsError = null;
    try {
      // Deliberately FILTERED (no include_service_actors). This is a genuine
      // human pick-list: it grants a PERSON a role on a workspace. Service
      // actors are machine principals with no human members, so listing them
      // here offers a grant that should never be made. The other admin pages
      // pass `true` because their lists are name maps or row sources over
      // unfiltered data; this one is not. See licenses#177.
      tenants = await listTenants();
    } catch (e) {
      // Degrade, do not blank the list: the access list is readable without a
      // tenant catalogue. Only the grant form needs one, and it says why it is
      // disabled instead of offering an empty picker.
      tenantsError = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void load();
    void loadTenants();
  });

  async function submitGrant(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    actionError = null;
    actionNote = null;
    const person = selectedPerson;
    const tenantId = grantTenant;
    if (!person || !tenantId) {
      actionError = 'Pick a person and a workspace first.';
      return;
    }
    const who = person.email ?? (person.name || person.id);
    const where = selectedTenant?.name ?? tenantId;
    granting = true;
    try {
      const res = await grantUserRole(person.id, {
        tenant_id: tenantId,
        role: grantRole,
      });
      actionNote = describeGrantOutcome(res, who, where);
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      granting = false;
    }
  }

  async function revoke(u: AdminUser, w: AdminUserWorkspace): Promise<void> {
    actionError = null;
    actionNote = null;
    // Send the role EXACTLY as stored. This used to coerce through
    // `asWorkspaceRole` and bail when the value fell outside the two-value
    // GRANT enum, which made such a row permanently unrevokable from the UI:
    // listed, with a Revoke button that refused it, and no remedy but SQL
    // against prod. Revoke now accepts any stored value while grant stays
    // strict — you must be able to undo a state you can no longer create.
    // Revoking a role that is not there deletes nothing and reports as much,
    // so a permissive value here cannot destroy anything.
    const role = w.role;
    if (!confirm(describeRoleRevoke(u, w))) return;

    const key = rowKey(u.user_id, w);
    busyRow = key;
    try {
      const res = await revokeUserRole(u.user_id, { tenant_id: w.tenant_id, role });
      actionNote = describeRevokeOutcome(res, personLabel(u), workspaceLabel(w), w.role);
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busyRow = null;
    }
  }
</script>

<section class="flex flex-col gap-3" data-testid="admin-access-list">
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <div>
      <h2 class="text-base font-semibold text-[var(--color-text)]">Access</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        {#if loading}
          Loading…
        {:else}
          {users.length} people · {grantCount} grants
        {/if}
      </p>
    </div>
    <input
      type="search"
      bind:value={filter}
      placeholder="Filter by person or workspace"
      aria-label="Filter access list"
      class="w-64 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
    />
  </header>

  {#if actionError}
    <p class="text-sm text-[var(--color-danger)]" data-testid="access-action-error">
      {actionError}
    </p>
  {/if}
  {#if actionNote}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="access-action-note">
      {actionNote}
    </p>
  {/if}

  {#if directoryError}
    <!-- Names missing is NOT the same as access missing. Saying so stops every
         row reading as a dangling grant during a Keycloak outage. -->
    <p class="text-sm text-[var(--color-text-muted)]">
      Directory unavailable — names could not be loaded, but the grants below are
      complete.
    </p>
  {:else if dangling > 0}
    <p class="text-sm text-[var(--color-text-muted)]">
      {dangling} grant{dangling === 1 ? '' : 's'} reference a user the directory does not
      know. They still pass the backend gate — revoke them if the account is gone.
      {#if seeded > 0}
        <!-- Revoke clears these now. Their role sits outside the GRANT enum, which
             used to make the button refuse; revoke accepts any stored role. -->
        {seeded} of them {seeded === 1 ? 'is' : 'are'} the AUTH_BYPASS placeholder id
        left by a demo seeder, not a person — safe to revoke.
      {/if}
    </p>
  {/if}

  {#if loading}
    <div class="flex flex-col gap-2">
      {#each Array(3) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
    </div>
  {:else if error}
    <ErrorState {error} onRetry={load} title="Could not load the access list" />
  {:else if users.length === 0}
    <EmptyState
      title="No role grants exist"
      body="Nobody has access to any workspace yet. Grant one below, or provision a new user."
    />
  {:else if shown.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">Nothing matches that filter.</p>
  {:else}
    <ul class="flex flex-col divide-y divide-[var(--color-border)]">
      {#each shown as u (u.user_id)}
        <li
          class="flex flex-wrap items-start justify-between gap-3 py-2.5"
          data-testid="access-list-row"
        >
          <div class="min-w-0">
            <p class="truncate text-sm text-[var(--color-text)]">
              {personLabel(u)}
              {#if !u.resolved}
                <!-- Names the row's KIND. "unknown to directory" described our
                     lookup, not the grant, and left the operator with nothing
                     to do about it. -->
                <span
                  class="ml-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]"
                >
                  {unresolvedBadge(u.user_id)}
                </span>
              {/if}
            </p>
            {#if u.name && u.email}
              <p class="truncate text-xs text-[var(--color-text-muted)]">{u.name}</p>
            {:else if !u.resolved}
              <!-- The full id, once, as small print: an operator fixing this in
                   the database needs it, but it is not this row's NAME. -->
              <p class="truncate font-mono text-xs text-[var(--color-text-muted)]">
                {u.user_id}
              </p>
            {/if}
          </div>
          <ul class="flex flex-wrap justify-end gap-1">
            {#each u.workspaces as w (w.tenant_id + w.role)}
              <li
                class="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
                title={`Granted ${new Date(w.granted_at).toLocaleDateString()}${w.granted_by ? ` by ${w.granted_by}` : ''}`}
                data-testid="access-grant"
              >
                {workspaceLabel(w)}
                <span class="text-[var(--color-text)]">· {w.role}</span>
                <button
                  type="button"
                  onclick={() => revoke(u, w)}
                  disabled={busyRow !== null}
                  class="text-[var(--color-danger)] underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
                  aria-label={`Revoke ${w.role} from ${personLabel(u)} in ${workspaceLabel(w)}`}
                  data-testid="access-revoke"
                >
                  {busyRow === rowKey(u.user_id, w) ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Grant. Separate from the provision form above: this attaches a role to an
       account that already exists, and mints nothing. -->
  <form
    class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3"
    onsubmit={submitGrant}
    data-testid="access-grant-form"
  >
    <p class="text-sm font-medium text-[var(--color-text)]">Grant a role</p>

    {#if tenantsError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="access-tenants-error">
        Workspaces could not be loaded ({tenantsError}) — granting is disabled until
        they are. The list above is unaffected.
      </p>
    {/if}

    <div class="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_auto]">
      <Combobox
        bind:value={personPick}
        loadOptions={loadPersonOptions}
        onSelect={onPersonSelect}
        placeholder="Search by email or name…"
        emptyLabel="Select a person…"
        data-testid="access-grant-person"
      />
      <Combobox
        bind:value={grantTenant}
        options={tenantOptions}
        disabled={tenants.length === 0}
        placeholder="Search workspaces…"
        emptyLabel="Select a workspace…"
        data-testid="access-grant-tenant"
      />
      <Select bind:value={grantRole} options={roleOptions} />
      <Button
        type="submit"
        variant="primary"
        disabled={granting || !selectedPerson || !grantTenant}
      >
        {granting ? 'Granting…' : 'Grant'}
      </Button>
    </div>

    {#if alreadyHeld}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="access-grant-already">
        They already hold {grantRole} there — granting again changes nothing.
      </p>
    {/if}
    <p class="text-xs text-[var(--color-text-muted)]">
      The person search reads Keycloak, so someone with no grant yet can still be
      found. If they have no account at all, provision one below.
    </p>
  </form>
</section>
