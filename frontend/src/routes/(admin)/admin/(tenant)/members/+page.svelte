<script lang="ts">
  // /admin/members — who is in THIS workspace, and what they can do.
  //
  // The tenant-admin counterpart to /admin/users (super-admin, fleet-wide).
  // Until this page existed, managing your own workspace's members required a
  // super-admin: the only writers of `user_roles` were the provisioning flow
  // and a super-admin-gated route.
  //
  // The tenant is never named here. The backend resolves it from the request
  // context — see lib/api/workspaceMembers.ts for why passing one would be the
  // first half of a cross-tenant escalation.
  import { onMount } from 'svelte';
  import {
    listWorkspaceMembers,
    grantWorkspaceRole,
    revokeWorkspaceRole,
    type WorkspaceMember,
    type UnreachableMember,
  } from '$lib/api/workspaceMembers';
  import {
    memberLabel,
    roleInWorkspace,
    isAdminRow,
    canRevokeAdmin,
    filterMembers,
    toggledRole,
    isRealmManagedAdmin,
    isRealmLockedAdmin,
    REALM_MANAGED_ADMIN_LABEL,
    KEYCLOAK_SYNC_FAILED_WARNING,
    NIL_UUID,
  } from './page-helpers';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';

  let members = $state<WorkspaceMember[]>([]);
  let directoryError = $state<string | null>(null);
  /** The Keycloak realm-admin lookup failed; realm-only admins may be missing. */
  let realmAdminsUnavailable = $state(false);
  /**
   * fr can write the realm `tenant_admin` role (fr#1289 part B), so realm-
   * managed admin rows are manageable here. False until the list says so.
   */
  let realmAdminRevocable = $state(false);
  /** P1-TEAM-b: members fr cannot push approvals/questions to (see the API type). */
  let unreachableMembers = $state<UnreachableMember[]>([]);
  let unreachablePartial = $state(false);
  /**
   * The last grant succeeded in fr but its Keycloak write-through reported
   * 'failed'. A WARNING, not an error: the fr grant stands and the roster is
   * correct — only the identity provider lags. Cleared on the next action.
   */
  let syncWarning = $state<string | null>(null);
  let loading = $state(true);
  /**
   * The member LIST read failed. Exclusive with the empty state: `members` stays
   * at its initial `[]` when the read throws, and the template used to render
   * this banner in its own `{#if}` block ABOVE a separate chain whose
   * `{:else if members.length === 0}` then said "No members yet. People appear
   * here once they are granted access to this workspace." A workspace admin was
   * shown a positive claim that their workspace has nobody in it, sourced from a
   * read that never answered — next to the banner saying it failed.
   */
  let loadError = $state<string | null>(null);
  /**
   * A grant/revoke failed. Kept SEPARATE from `loadError` on purpose: folding
   * these together and then making the chain exclusive would mean one failed
   * "Make admin" click blanked the whole member table, which is the same defect
   * in the other direction. The roster is still valid after a failed mutation.
   */
  let actionError = $state<string | null>(null);
  let query = $state('');
  let busyUser = $state<string | null>(null);
  /**
   * The user_id whose removal is armed, or null.
   *
   * ⛔ Revoking someone's access to the workspace had NO confirmation at all,
   * while the department screen next door confirms the REVERSIBLE archive of a
   * whole department. The destructive action was the less guarded one, and the
   * Remove button sits immediately beside "Make admin" in a table of look-alike
   * rows — one mis-click and the person is out, with an optimistic reload
   * hiding the fact that anything happened.
   *
   * Same two-step inline pattern as `archiveConfirm` on
   * `departments/[id]/+page.svelte`; deliberately NOT a new dialog component
   * and not `window.confirm`, neither of which this app uses here.
   */
  let removeConfirmId = $state<string | null>(null);

  const shown = $derived(filterMembers(members, query));
  const adminCount = $derived(members.filter(isAdminRow).length);
  const revokeAllowed = $derived(canRevokeAdmin(members));

  async function load() {
    loading = true;
    loadError = null;
    actionError = null;
    try {
      const res = await listWorkspaceMembers();
      members = res.members;
      directoryError = res.directory_error;
      realmAdminsUnavailable = res.realm_admins_unavailable;
      realmAdminRevocable = res.realm_admin_revocable === true;
      unreachableMembers = Array.isArray(res.unreachable_members) ? res.unreachable_members : [];
      unreachablePartial = res.unreachable_members_partial === true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function toggleRole(m: WorkspaceMember) {
    const next = toggledRole(m);
    // Demoting the last admin is refused by the server (409). Stop here so the
    // operator is told before the click rather than after.
    if (next === 'workspace-member' && !revokeAllowed) return;
    // A realm-managed admin cannot be demoted while fr cannot write the realm
    // role: the grant would succeed and the revoke 409, leaving BOTH roles.
    // Refuse before the first request.
    if (next === 'workspace-member' && isRealmLockedAdmin(m, realmAdminRevocable)) return;
    busyUser = m.user_id;
    actionError = null;
    syncWarning = null;
    try {
      const current = roleInWorkspace(m);
      const granted = await grantWorkspaceRole(m.user_id, next);
      if (granted?.keycloak_sync === 'failed') syncWarning = KEYCLOAK_SYNC_FAILED_WARNING;
      // Grant-then-revoke, in that order: if the revoke fails the person keeps
      // BOTH roles, which is recoverable. Revoking first would risk leaving
      // them with none — and, for the last admin, no way back in.
      if (current && current !== next && current !== 'admin') {
        await revokeWorkspaceRole(m.user_id, current as 'workspace-admin' | 'workspace-member');
      }
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busyUser = null;
    }
  }

  async function removeMember(m: WorkspaceMember) {
    const role = roleInWorkspace(m);
    if (!role) return;
    if (role === 'workspace-admin' && !revokeAllowed) return;
    if (role === 'workspace-admin' && isRealmLockedAdmin(m, realmAdminRevocable)) return;
    // Arm on the first click, act on the second. Enforced HERE and not only in
    // the template: a guard that lives solely in markup is one refactor away
    // from being gone, and its absence is silent.
    if (removeConfirmId !== m.user_id) {
      removeConfirmId = m.user_id;
      return;
    }
    removeConfirmId = null;
    busyUser = m.user_id;
    actionError = null;
    syncWarning = null;
    try {
      // The legacy 'admin' alias is not in the grantable enum, so it cannot be
      // revoked through this API — say so rather than failing opaquely.
      if (m.workspaces.some((w) => w.role === 'admin')) {
        throw new Error(
          'This grant uses the legacy "admin" role and must be removed by a super-admin.',
        );
      }
      await revokeWorkspaceRole(m.user_id, role as 'workspace-admin' | 'workspace-member');
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busyUser = null;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <header class="flex flex-col gap-1">
    <h1 class="text-xl font-semibold text-[var(--color-text)]">Members</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      People with access to this workspace. Roles here apply to this workspace
      only.
    </p>
  </header>

  {#if directoryError}
    <!-- An outage is NOT the same as a dangling grant. Saying so stops an
         operator reading "everyone was deleted". -->
    <div
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
      data-testid="directory-banner"
    >
      Directory unavailable — member names could not be loaded. Access is
      unaffected and the list below is complete.
    </div>
  {/if}

  {#if realmAdminsUnavailable}
    <!-- Non-blocking: the roster below is the user_roles view and may be
         missing admins who hold the realm tenant_admin role. -->
    <div
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
      data-testid="realm-admins-unavailable"
    >
      Some administrators could not be loaded from the identity provider.
    </div>
  {/if}

  {#if !loading && !loadError && (unreachableMembers.length > 0 || unreachablePartial)}
    <!-- P1-TEAM-b (George 2026-10-15): every approval, question and notification goes
         to ALL members, on the channels each one configured. These members cannot be
         pushed to — they only see requests when they open fr. -->
    <section
      class="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
      data-testid="unreachable-members"
    >
      <p class="font-medium">
        {`${unreachableMembers.length} ${unreachableMembers.length === 1 ? 'member cannot' : 'members cannot'} be reached outside fr`}
      </p>
      <p class="mt-1">
        Approvals, questions and notifications go to every member of this workspace. These
        members have no push channel (Telegram, email, Teams…) enabled, so they only see
        them when they open fr. Each member sets their own channels under Settings → Channels.
      </p>
      {#if unreachableMembers.length > 0}
        <ul class="mt-2 list-disc pl-5" data-testid="unreachable-members-list">
          {#each unreachableMembers as u (u.user_id)}
            <li data-testid="unreachable-member">
              {u.name || u.email || u.user_id}
              <span class="text-xs">
                — {u.verdict === 'passive_only' ? 'only in-app channels enabled' : 'no channels configured'}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if unreachablePartial}
        <p class="mt-1 text-xs" data-testid="unreachable-members-partial">
          Some members could not be loaded from the identity provider; this list may be incomplete.
        </p>
      {/if}
    </section>
  {/if}

  {#if syncWarning}
    <!-- Non-blocking: the fr grant succeeded; only the IdP write-through lagged. -->
    <div
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
      role="status"
      data-testid="members-sync-warning"
    >
      {syncWarning}
    </div>
  {/if}

  {#if actionError}
    <!-- A MUTATION failure. Non-exclusive with the table on purpose: the roster
         below is still the server's truth, so it stays on screen. -->
    <div
      class="rounded-md border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
      role="alert"
      data-testid="members-action-error"
    >
      {actionError}
    </div>
  {/if}

  <div class="flex items-center gap-3">
    <input
      class="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)]"
      placeholder="Filter by name, email or role"
      bind:value={query}
      aria-label="Filter members"
    />
    <span class="text-xs text-[var(--color-text-muted)]">
      {members.length} member{members.length === 1 ? '' : 's'} · {adminCount} admin{adminCount ===
      1
        ? ''
        : 's'}
    </span>
  </div>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading members…</p>
  {:else if loadError}
    <!-- EXCLUSIVE with the empty state below — see `loadError`'s comment. -->
    <div
      class="rounded-md border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
      role="alert"
      data-testid="members-load-error"
    >
      {loadError}
    </div>
  {:else if members.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">
      No members yet. People appear here once they are granted access to this
      workspace.
    </p>
  {:else}
    <table class="w-full text-left text-sm">
      <thead class="text-xs uppercase text-[var(--color-text-muted)]">
        <tr>
          <th class="py-2">Member</th>
          <th class="py-2">Role</th>
          <th class="py-2">Granted</th>
          <th class="py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each shown as m (m.user_id)}
          {@const role = roleInWorkspace(m)}
          {@const admin = isAdminRow(m)}
          {@const realmManaged = admin && isRealmManagedAdmin(m)}
          {@const realmLocked = admin && isRealmLockedAdmin(m, realmAdminRevocable)}
          {@const lockTitle = realmLocked
            ? REALM_MANAGED_ADMIN_LABEL
            : admin && !revokeAllowed
              ? 'This is the only workspace admin — promote someone else first.'
              : ''}
          <tr class="border-t border-[var(--color-border)]">
            <td class="py-2">
              <div class="flex flex-col">
                <span class="text-[var(--color-text)]">{memberLabel(m)}</span>
                {#if !m.resolved}
                  <!--
                    EntityRef's `resolved={false}` state IS this row: a label
                    naming what the row is, plus a reachable id stub. The
                    wording stays ours (`unresolvedLabel`) because "seed data"
                    is not "Deleted account".
                  -->
                  <span class="text-xs text-[var(--color-text-muted)]">
                    <EntityRef
                      id={m.user_id}
                      kind="user"
                      resolved={false}
                      unresolvedLabel={m.user_id === NIL_UUID ? 'seed data' : 'account deleted'}
                    />
                  </span>
                {/if}
              </div>
            </td>
            <td class="py-2">
              {role ?? '—'}
              {#if realmManaged}
                <span
                  class="ml-1 text-xs text-[var(--color-text-muted)]"
                  title={REALM_MANAGED_ADMIN_LABEL}
                  data-testid="member-realm-managed"
                >
                  (identity provider)
                </span>
              {/if}
            </td>
            <td class="py-2 text-[var(--color-text-muted)]">
              {m.workspaces[0]?.granted_at?.slice(0, 10) ?? '—'}
            </td>
            <td class="py-2 text-right">
              <button
                class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50"
                disabled={busyUser === m.user_id || (admin && !revokeAllowed) || realmLocked}
                title={lockTitle}
                onclick={() => toggleRole(m)}
                data-testid="member-role-toggle"
              >
                {admin ? 'Make member' : 'Make admin'}
              </button>
              <!--
                Two-step inline confirm, the shape `departments/[id]` already
                uses for archive. Revoking access is irreversible from here and
                must be at least as guarded as the reversible action next door.
              -->
              {#if removeConfirmId === m.user_id}
                <span class="ml-2 inline-flex items-center gap-2">
                  <span class="text-xs text-[var(--color-text-muted)]"
                    >Remove {memberLabel(m)}?</span
                  >
                  <button
                    class="rounded-md bg-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-on-primary)] disabled:opacity-50"
                    disabled={busyUser === m.user_id}
                    onclick={() => removeMember(m)}
                    data-testid="member-remove-confirm"
                  >
                    {busyUser === m.user_id ? 'Removing…' : 'Yes, remove'}
                  </button>
                  <button
                    class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs"
                    disabled={busyUser === m.user_id}
                    onclick={() => (removeConfirmId = null)}
                    data-testid="member-remove-cancel"
                  >
                    Cancel
                  </button>
                </span>
              {:else}
                <button
                  class="ml-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-danger)] disabled:opacity-50"
                  disabled={busyUser === m.user_id || (admin && !revokeAllowed) || realmLocked}
                  title={lockTitle}
                  onclick={() => removeMember(m)}
                  data-testid="member-remove"
                >
                  Remove
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
