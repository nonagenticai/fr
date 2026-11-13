<!--
  /admin/departments/new — create a department.

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 16.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { createDepartment } from '$lib/api/tenancy';
  import { toast } from '$lib/stores/toast.svelte';

  let name = $state('');
  let description = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = null;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      error = 'Name is required.';
      return;
    }
    submitting = true;
    try {
      const created = await createDepartment({
        name: trimmedName,
        description: description.trim() || undefined,
      });
      toast.success(`Created department "${created.name}"`);
      void goto(`/admin/departments/${created.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
      toast.error(`Failed to create department: ${msg}`);
    } finally {
      submitting = false;
    }
  }
</script>

<section class="p-6 max-w-xl space-y-6" data-testid="department-new-page">
  <header>
    <h1 class="text-2xl font-semibold">New department</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Create a department and add members in the next step.
    </p>
  </header>

  <form class="space-y-4" onsubmit={handleSubmit}>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Name</span>
      <input
        type="text"
        bind:value={name}
        required
        maxlength="100"
        class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
        placeholder="Engineering"
        data-testid="department-new-name"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Description (optional)</span>
      <textarea
        bind:value={description}
        rows="3"
        maxlength="500"
        class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
        placeholder="What this department is responsible for."
        data-testid="department-new-description"
      ></textarea>
    </label>

    {#if error}
      <p class="text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]" data-testid="department-new-error">
        {error}
      </p>
    {/if}

    <div class="flex gap-2 justify-end">
      <a
        href="/admin/departments"
        class="px-4 py-2 border border-[var(--color-border-strong)] rounded text-sm hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
      >
        Cancel
      </a>
      <button
        type="submit"
        disabled={submitting}
        class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-accent-strong)] transition-colors disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        data-testid="department-new-submit"
      >
        {submitting ? 'Creating…' : 'Create department'}
      </button>
    </div>
  </form>
</section>
