<!--
  /admin/departments/[id] — edit a department + manage members.

  - Name / description editing (PATCH).
  - default_landing toggle (PATCH).
  - Member list with role select + remove.
  - Archive button.
  - Link to dept-scoped knowledge view.

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 16.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { goto } from '$app/navigation';
  import {
    getDepartment,
    updateDepartment,
    archiveDepartment,
    listDepartmentMembers,
    addDepartmentMember,
    updateDepartmentMember,
    removeDepartmentMember,
    setDepartmentLanding,
    type Department,
    type DepartmentMember,
    type DeptRole,
  } from '$lib/api/tenancy';
  import { toast } from '$lib/stores/toast.svelte';
  import { shortId } from '$lib/utils/shortId';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';

  const ROLES: { value: DeptRole; label: string }[] = [
    { value: 'dept-admin', label: 'Admin' },
    { value: 'dept-manager', label: 'Manager' },
    { value: 'dept-member', label: 'Member' },
    { value: 'dept-viewer', label: 'Viewer' },
  ];

  // SvelteKit's params type is `Record<string, string | undefined>`; the
  // route file lives under [id] so the param is always present at runtime.
  let deptId = $derived(page.params.id as string);

  let dept = $state<Department | null>(null);
  let members = $state<DepartmentMember[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // Set when the backend's Keycloak resolve threw outright. See
  // `directoryDegraded` — this alone does NOT detect every outage.
  let directoryError = $state<string | null>(null);

  // --- Member identity rendering ------------------------------------------
  //
  // `user_id` is a bare Keycloak subject UUID. It stays authoritative for
  // every mutation but must never be the label under the "User" column.

  // Enough of the uuid to tell two rows apart; the full id is the tooltip.
  //
  // ⚠️ This file used to define its own `shortId` as `id.slice(0, 8)`. Retired
  // in fr#1205 — and the replacement is NOT the same string. fr#1203 measured
  // that the LEADING 8 does not tell two rows apart for UUIDv7-shaped ids: 52
  // live apps collapsed onto 27 distinct leading-8 values, 13 of them all
  // rendering `06954722…`, versus 52 distinct trailing-8. The shared helper in
  // `$lib/utils/shortId` takes the TAIL and leads with the ellipsis.

  /**
   * Name first, then email, then the short id.
   *
   * ⚠️ `??` falls through on `null`/`undefined` only, so a member named `''`
   * or `'   '` wins the chain and the label renders BLANK (fr#1192's class);
   * the shared fix is the `displayName(value, fallback)` trim-then-test helper.
   * (This used to cite kanban's MemberPicker, which was removed 2026-10-10.)
   *
   * ⚠️ This chain is itself still `??`, so `email: ''` blanks a row here —
   * the same defect, not yet fixed, and deliberately not smuggled into the
   * change that corrected this comment. The truncated tail below is a SEPARATE,
   * intentional rule ("no code path prints a full raw uuid at a human");
   * fixing the `??` chain is a separate change.
   */
  function memberLabel(m: DepartmentMember): string {
    return m.name ?? m.email ?? shortId(m.user_id);
  }

  /**
   * Did the directory answer at all? If any member in the SAME batch
   * resolved, Keycloak was reachable, so a row that did not resolve is a
   * genuinely deleted account. If none did, we cannot tell a wholesale
   * outage from a wholesale deletion — and accusing every member of being
   * deleted is the worse error, so the degraded label wins.
   */
  let directoryDegraded = $derived(
    directoryError !== null ||
      (members.length > 0 && !members.some((m) => m.resolved)),
  );

  // Edit fields (decoupled from `dept` so PATCH only sends what changed)
  let editName = $state('');
  let editDescription = $state('');
  let savingMeta = $state(false);

  // Landing toggle
  let savingLanding = $state(false);

  // Add-member form
  let newMemberId = $state('');
  let newMemberRole = $state<DeptRole>('dept-member');
  let addingMember = $state(false);
  let addError = $state<string | null>(null);

  // Per-row in-flight set
  let pendingMemberIds = $state<Set<string>>(new Set());

  // Archive confirmation
  let archiveConfirm = $state(false);
  let archiving = $state(false);

  /**
   * Remove-member confirmation — the SAME two-step inline pattern as archive
   * below (`archiveConfirm`), deliberately not a new dialog.
   *
   * ⛔ Why this had to exist: archiving a department — explicitly documented on
   * this page as "preserved for audit … reversible by a workspace admin via the
   * API" — asked for confirmation, while removing a person from the department
   * did not. The IRREVERSIBLE action was the less guarded of the two, and it
   * sits one column away from a role <select> in a table of look-alike rows, so
   * a mis-click removes the wrong person instantly.
   *
   * Holds the user_id under confirmation, or null. One at a time: a second
   * Remove click retargets rather than arming two rows, so the "Yes, remove"
   * button can never be ambiguous about who it means.
   */
  let removeConfirmId = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [d, m] = await Promise.all([
        getDepartment(deptId),
        listDepartmentMembers(deptId),
      ]);
      dept = d;
      members = m.members;
      directoryError = m.directory_error;
      editName = d.name;
      editDescription = d.description ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadError = msg;
      toast.error(`Failed to load department: ${msg}`);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  function markPending(id: string, on: boolean): void {
    const next = new Set(pendingMemberIds);
    if (on) next.add(id);
    else next.delete(id);
    pendingMemberIds = next;
  }

  async function saveMeta(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!dept) return;
    savingMeta = true;
    try {
      const patch: Parameters<typeof updateDepartment>[1] = {};
      if (editName.trim() !== dept.name) patch.name = editName.trim();
      if ((editDescription ?? '') !== (dept.description ?? '')) {
        patch.description = editDescription;
      }
      if (Object.keys(patch).length === 0) {
        toast.info('Nothing to save.');
        return;
      }
      const updated = await updateDepartment(dept.id, patch);
      dept = updated;
      editName = updated.name;
      editDescription = updated.description ?? '';
      toast.success('Department updated.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Update failed: ${msg}`);
    } finally {
      savingMeta = false;
    }
  }

  async function toggleLanding(): Promise<void> {
    if (!dept) return;
    const next = !dept.default_landing;
    savingLanding = true;
    try {
      const updated = await setDepartmentLanding(dept.id, next);
      dept = updated;
      toast.success(
        next
          ? 'This department is now the default landing.'
          : 'Default landing cleared.',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to update landing: ${msg}`);
    } finally {
      savingLanding = false;
    }
  }

  async function addMember(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    addError = null;
    const userId = newMemberId.trim();
    if (userId.length === 0) {
      addError = 'User id is required.';
      return;
    }
    addingMember = true;
    try {
      const role = newMemberRole;
      await addDepartmentMember(deptId, { user_id: userId, role });
      // Refetch the canonical list (response shape is { ok: true })
      const list = await listDepartmentMembers(deptId);
      members = list.members;
      directoryError = list.directory_error;
      newMemberId = '';
      // Name the person the refetch just resolved, not the uuid that was
      // typed in. Falls back to the short id when the directory could not
      // resolve them — the admin still gets a confirmation they can match
      // to the row that just appeared.
      const added = list.members.find((m) => m.user_id === userId);
      toast.success(
        `Added ${added ? memberLabel(added) : shortId(userId)} as ${role}.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addError = msg;
      toast.error(`Failed to add member: ${msg}`);
    } finally {
      addingMember = false;
    }
  }

  async function changeRole(member: DepartmentMember, role: DeptRole): Promise<void> {
    if (member.role === role) return;
    const original = members;
    // optimistic
    members = members.map((m) =>
      m.user_id === member.user_id ? { ...m, role } : m,
    );
    markPending(member.user_id, true);
    try {
      await updateDepartmentMember(deptId, member.user_id, { role });
      toast.success(`${memberLabel(member)} is now ${role}.`);
    } catch (err) {
      members = original;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to change role: ${msg}`);
    } finally {
      markPending(member.user_id, false);
    }
  }

  async function removeMember(member: DepartmentMember): Promise<void> {
    // The gate, not merely the button's state: a handler that trusts the UI to
    // have asked is a handler that removes silently the day a caller changes.
    if (removeConfirmId !== member.user_id) {
      removeConfirmId = member.user_id;
      return;
    }
    removeConfirmId = null;
    const original = members;
    members = members.filter((m) => m.user_id !== member.user_id);
    markPending(member.user_id, true);
    try {
      await removeDepartmentMember(deptId, member.user_id);
      toast.success(`Removed ${memberLabel(member)}.`);
    } catch (err) {
      members = original;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to remove: ${msg}`);
    } finally {
      markPending(member.user_id, false);
    }
  }

  async function archive(): Promise<void> {
    if (!dept) return;
    archiving = true;
    try {
      await archiveDepartment(dept.id);
      toast.success(`Archived "${dept.name}".`);
      void goto('/admin/departments');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Archive failed: ${msg}`);
    } finally {
      archiving = false;
      archiveConfirm = false;
    }
  }

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(page.url.pathname, dept?.name ?? null);
  });
</script>

<section class="p-6 space-y-8 max-w-3xl" data-testid="department-detail-page">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <div class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3">
      {loadError}
    </div>
  {:else if dept}
    <header class="flex items-baseline justify-between">
      <div>
        <h1 class="text-2xl font-semibold">{dept.name}</h1>
        <p class="text-sm text-[var(--color-text-muted)]">
          {#if dept.archived_at}
            Archived {new Date(dept.archived_at).toLocaleDateString()}.
          {:else}
            Active department.
          {/if}
        </p>
      </div>
      <a
        href="/admin/departments"
        class="text-sm text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
      >
        ← All departments
      </a>
    </header>

    <!-- Metadata edit -->
    <form class="space-y-4" onsubmit={saveMeta} data-testid="department-meta-form">
      <h2 class="text-sm font-semibold uppercase text-[var(--color-text-muted)]">Details</h2>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Name</span>
        <input
          type="text"
          bind:value={editName}
          required
          maxlength="100"
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          data-testid="department-edit-name"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Description</span>
        <textarea
          bind:value={editDescription}
          rows="3"
          maxlength="500"
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          data-testid="department-edit-description"
        ></textarea>
      </label>
      <div class="flex justify-end">
        <button
          type="submit"
          disabled={savingMeta}
          class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-accent-strong)] transition-colors disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
          data-testid="department-edit-save"
        >
          {savingMeta ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>

    <!-- Default landing toggle -->
    <section class="rounded border border-[var(--color-border)] p-4 dark:border-[var(--color-border)]" data-testid="department-landing-section">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-sm font-semibold">Default landing</h2>
          <p class="text-xs text-[var(--color-text-muted)]">
            When enabled, members of this department land here after login.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={dept.default_landing}
          aria-label={dept.default_landing
            ? 'Disable default landing'
            : 'Enable default landing'}
          disabled={savingLanding}
          onclick={() => void toggleLanding()}
          class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors {dept.default_landing
            ? 'bg-[var(--color-accent)]'
            : 'bg-[var(--color-surface-strong)]'} disabled:opacity-50"
          data-testid="department-landing-toggle"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-[var(--color-bg)] transition-transform {dept.default_landing
              ? 'translate-x-4'
              : 'translate-x-1'} dark:bg-[var(--color-surface)]"
          ></span>
        </button>
      </div>
    </section>

    <!-- Knowledge link -->
    <section class="rounded border border-[var(--color-border)] p-4 dark:border-[var(--color-border)]">
      <h2 class="text-sm font-semibold mb-1">Knowledge</h2>
      <p class="text-xs text-[var(--color-text-muted)] mb-3">
        See the effective assets visible to this department (workspace assets +
        department-defined + project overrides up the chain).
      </p>
      <a
        href={`/admin/departments/${dept.id}/knowledge`}
        class="inline-block px-3 py-1.5 border border-[var(--color-border-strong)] rounded text-sm hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
        data-testid="department-knowledge-link"
      >
        View department knowledge →
      </a>
    </section>

    <!-- Members -->
    <section class="space-y-4" data-testid="department-members-section">
      <h2 class="text-sm font-semibold uppercase text-[var(--color-text-muted)]">Members</h2>
      {#if directoryDegraded}
        <!--
          A directory outage must not empty this page and must not accuse
          every member of being deleted: membership + roles below are read
          from fr's own DB and stay accurate, only the names are missing.
        -->
        <div
          class="rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 text-xs text-[var(--color-warning-text)]"
          data-testid="department-directory-banner"
        >
          Directory unavailable — member names could not be loaded{directoryError
            ? `: ${directoryError}`
            : ''}. Membership and roles below are still accurate.
        </div>
      {/if}
      {#if members.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No members yet.</p>
      {:else}
        <table class="w-full border rounded text-sm" data-testid="department-members-table">
          <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:bg-[var(--color-bg)]">
            <tr>
              <th class="p-3">User</th>
              <th class="p-3">Role</th>
              <th class="p-3">Joined</th>
              <th class="p-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {#each members as m (m.user_id)}
              {@const busy = pendingMemberIds.has(m.user_id)}
              <tr class="border-t" data-testid="department-member-row" class:opacity-60={busy}>
                <td class="p-3">
                  {#if m.resolved}
                    <div class="font-medium" data-testid="department-member-name">
                      {memberLabel(m)}
                    </div>
                    {#if m.email && m.email !== memberLabel(m)}
                      <div class="text-xs text-[var(--color-text-muted)]">{m.email}</div>
                    {/if}
                  {:else}
                    <!--
                      Never a bare uuid. "Deleted" is only claimed when the
                      directory demonstrably answered for someone else in
                      this same batch (see `directoryDegraded`).
                    -->
                    <div
                      class="font-medium text-[var(--color-text-muted)] italic"
                      data-testid="department-member-name"
                    >
                      {directoryDegraded ? 'Account unavailable' : 'Deleted account'}
                    </div>
                  {/if}
                  <!--
                    EntityRef owns the stub AND the full-id tooltip; the wrapper
                    keeps only the testid so selectors that target this cell
                    still resolve.
                  -->
                  <div data-testid="department-member-id">
                    <EntityRef id={m.user_id} kind="user" />
                  </div>
                </td>
                <td class="p-3">
                  <select
                    bind:value={m.role}
                    onchange={(e) =>
                      void changeRole(m, (e.currentTarget as HTMLSelectElement).value as DeptRole)}
                    disabled={busy}
                    class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-xs bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
                    data-testid="department-member-role"
                  >
                    {#each ROLES as r (r.value)}
                      <option value={r.value}>{r.label}</option>
                    {/each}
                  </select>
                </td>
                <td class="p-3 text-xs text-[var(--color-text-muted)]">
                  {new Date(m.joined_at).toLocaleDateString()}
                </td>
                <td class="p-3 text-right">
                  <!--
                    Two-step inline confirm, the same shape as "Archive
                    department" below. Removing a member is IRREVERSIBLE from
                    this screen (re-adding needs their user id), so it must be
                    at least as guarded as the reversible archive — it used to
                    be less.
                  -->
                  {#if removeConfirmId === m.user_id}
                    <span class="inline-flex items-center gap-2">
                      <span class="text-xs text-[var(--color-text-muted)]">
                        Remove {memberLabel(m)}?
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onclick={() => void removeMember(m)}
                        class="rounded bg-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-on-primary)] hover:opacity-90 disabled:opacity-50"
                        data-testid="department-member-remove-confirm"
                      >
                        {busy ? 'Removing…' : 'Yes, remove'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onclick={() => (removeConfirmId = null)}
                        class="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-surface)] disabled:opacity-50"
                        data-testid="department-member-remove-cancel"
                      >
                        Cancel
                      </button>
                    </span>
                  {:else}
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() => void removeMember(m)}
                      class="text-xs text-[var(--color-danger)] hover:text-[var(--color-danger-text)] hover:underline disabled:opacity-50"
                      data-testid="department-member-remove"
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

      <!-- Add member -->
      <form
        class="border border-[var(--color-border)] rounded p-4 dark:border-[var(--color-border)] flex flex-col sm:flex-row gap-2 sm:items-end"
        onsubmit={addMember}
        data-testid="department-add-member-form"
      >
        <label class="flex flex-col gap-1 text-xs flex-1 min-w-0">
          <span class="font-medium">User id</span>
          <input
            type="text"
            bind:value={newMemberId}
            placeholder="user-uuid or email"
            required
            class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm font-mono dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
            data-testid="department-add-member-id"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="font-medium">Role</span>
          <select
            bind:value={newMemberRole}
            class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
            data-testid="department-add-member-role"
          >
            {#each ROLES as r (r.value)}
              <option value={r.value}>{r.label}</option>
            {/each}
          </select>
        </label>
        <button
          type="submit"
          disabled={addingMember}
          class="px-3 py-1.5 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
          data-testid="department-add-member-submit"
        >
          {addingMember ? 'Adding…' : 'Add member'}
        </button>
      </form>
      {#if addError}
        <p class="text-xs text-[var(--color-danger)] dark:text-[var(--color-danger-text)]" data-testid="department-add-member-error">
          {addError}
        </p>
      {/if}
    </section>

    <!-- Archive -->
    {#if !dept.archived_at}
      <section class="rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-4 dark:border-[var(--color-warning)] dark:bg-[var(--color-warning-bg)]/20">
        <h2 class="text-sm font-semibold text-[var(--color-warning-text)] dark:text-[var(--color-warning-text)]">Archive department</h2>
        <p class="text-xs text-[var(--color-warning-text)] mb-3">
          Archived departments are hidden from pickers but preserved for audit. This is reversible by
          a workspace admin via the API.
        </p>
        {#if archiveConfirm}
          <div class="flex gap-2">
            <button
              type="button"
              disabled={archiving}
              onclick={() => void archive()}
              class="px-3 py-1.5 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded text-sm hover:opacity-90 disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
              data-testid="department-archive-confirm"
            >
              {archiving ? 'Archiving…' : 'Yes, archive'}
            </button>
            <button
              type="button"
              disabled={archiving}
              onclick={() => (archiveConfirm = false)}
              class="px-3 py-1.5 border border-[var(--color-border-strong)] rounded text-sm hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
            >
              Cancel
            </button>
          </div>
        {:else}
          <button
            type="button"
            onclick={() => (archiveConfirm = true)}
            class="px-3 py-1.5 border border-[var(--color-danger-border)] text-[var(--color-danger)] rounded text-sm hover:bg-[var(--color-danger-bg)] dark:border-[var(--color-danger)] dark:text-[var(--color-danger-text)] dark:hover:bg-[var(--color-danger-bg)]/30"
            data-testid="department-archive-button"
          >
            Archive department
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</section>
