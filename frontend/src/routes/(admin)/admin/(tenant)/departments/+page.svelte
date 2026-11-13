<!--
  /admin/departments — list of departments.

  - Lists active + archived departments via tenancy.listDepartments.
  - "+ New department" links to /admin/departments/new.
  - Each row links to /admin/departments/[id].

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 16.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { listDepartments, type Department } from '$lib/api/tenancy';
  import { toast } from '$lib/stores/toast.svelte';

  let departments = $state<Department[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      departments = await listDepartments();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadError = msg;
      toast.error(`Failed to load departments: ${msg}`);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section class="p-6 space-y-6" data-testid="departments-page">
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold">Departments</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Group people by team. Members inherit assets via the department scope.
      </p>
    </div>
    <a
      href="/admin/departments/new"
      class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors text-sm"
      data-testid="departments-new-link"
    >
      + New department
    </a>
  </header>

  <!--
    ONE EXCLUSIVE CHAIN, deliberately. `{#if loadError}` used to be its own
    block, so a failed `listDepartments()` left `departments` at its initial `[]`
    and the page rendered the error banner AND, right under it, "No departments
    yet." with a "Create the first department" call to action. A tenant admin was
    being told their workspace is empty by a read that never answered — and
    invited to create a duplicate of a department that may well exist. An absence
    and a failure are now mutually exclusive branches.
  -->
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <div
      class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3"
      data-testid="departments-error"
    >
      {loadError}
    </div>
  {:else if departments.length === 0}
    <div class="rounded border border-dashed p-8 text-center text-[var(--color-text-muted)]">
      <p class="mb-3">No departments yet.</p>
      <a
        href="/admin/departments/new"
        class="px-3 py-1.5 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] transition-colors text-sm"
      >
        Create the first department
      </a>
    </div>
  {:else}
    <table class="w-full border rounded text-sm" data-testid="departments-table">
      <thead class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:bg-[var(--color-bg)]">
        <tr>
          <th class="p-3">Name</th>
          <th class="p-3">Description</th>
          <th class="p-3">Default landing</th>
          <th class="p-3">Status</th>
          <th class="p-3 text-right"></th>
        </tr>
      </thead>
      <tbody>
        {#each departments as dept (dept.id)}
          <tr class="border-t" data-testid="department-row">
            <td class="p-3 font-medium">
              <a
                href={`/admin/departments/${dept.id}`}
                class="text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
              >
                {dept.name}
              </a>
              {#if dept.is_default}
                <span class="ml-2 text-xs px-2 py-0.5 rounded bg-[var(--color-surface)] dark:bg-[var(--color-surface)]">default</span>
              {/if}
            </td>
            <td class="p-3 text-[var(--color-text-muted)]">{dept.description || '—'}</td>
            <td class="p-3">
              {dept.default_landing ? 'Yes' : 'No'}
            </td>
            <td class="p-3">
              {#if dept.archived_at}
                <span class="text-xs px-2 py-0.5 rounded bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border border-[var(--color-warning-bg)]">
                  archived
                </span>
              {:else}
                <span class="text-xs px-2 py-0.5 rounded bg-[var(--color-success-bg)] text-[var(--color-success-text)] border border-[var(--color-success)]">
                  active
                </span>
              {/if}
            </td>
            <td class="p-3 text-right">
              <a
                href={`/admin/departments/${dept.id}`}
                class="text-xs text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
              >
                Manage →
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
