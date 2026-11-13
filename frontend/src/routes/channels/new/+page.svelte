<!--
  /channels/new — create a channel.

  Two-mode page driven by the `?kind=` query param:
    ?kind=schedule-intake   → ScheduleIntakeEditor → /api/scheduled-triggers
    (no kind / other value) → existing notification-channel registry form

  The kebab-case URL kind maps to the snake_case wire kind (`scheduled_intake`)
  on the unified channels list — see
  frontend/src/lib/components/channels/ChannelsList.svelte.

  Notification-channel kinds drive which credential / config fields are shown.
  Credentials are POST-only: the form sends them once on submit; subsequent
  edits in /channels/[id] use the masked-write-only pattern.

  NOTE: /api/channels CRUD is LIVE — POST /api/channels is registered in
  backend/src/server.ts (alongside GET, and GET/PATCH/DELETE on :id), so
  submits here reach a real handler. A 404 from this form is a routing or
  connectivity failure, not a missing backend lane.

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 17,
        docs/superpowers/plans/2026-04-29-spec-2-plan-c-ui-surfaces.md Phase 2.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { displayName } from '$lib/utils/displayName';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    createChannel,
    type ChannelKind,
  } from '$lib/api/channels';
  import { kindFromUrl } from '$lib/api/unifiedChannels';
  import {
    listDepartments,
    type Department,
  } from '$lib/api/tenancy';
  import { apiClient } from '$lib/api/unified-client';
  import type { ScheduledTriggerCreate } from '$lib/types/api';
  import ScheduleIntakeEditor from '$lib/components/channels/ScheduleIntakeEditor.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { canEditScheduledTrigger } from '$lib/rbac/canEditScheduledTrigger';

  // ?kind= dispatch. URL-side kinds use kebab-case (schedule-intake)
  // for human-readability; the wire/DB columns are
  // snake_case. `kindFromUrl` is the single source of truth for the
  // url-kind parsing convention (used by /channels/[id] too).
  const scheduleKind = $derived(kindFromUrl(page.url.searchParams));
  const projectId = $derived(page.url.searchParams.get('project_id') ?? '');

  // Editor state for the scheduled-* branches.
  let intakeValue = $state<Partial<ScheduledTriggerCreate>>({});
  let intakeRef: { validate: () => boolean } | undefined = $state();
  let scheduleSaving = $state(false);
  let scheduleError = $state<string | null>(null);

  // RBAC (Plan 2-C Phase 4.2). UX-only — backend (Phase 0.5) is the
  // security boundary. We resolve the project's dept_id from
  // /api/projects/:id and gate the create button on
  // canEditScheduledTrigger().
  let projectDeptId = $state<string | null>(null);
  let projectLoaded = $state(false);
  let projectLoadError = $state<string | null>(null);

  $effect(() => {
    // Re-fetch when the project_id query param changes.
    const pid = projectId;
    if (!pid) {
      projectDeptId = null;
      projectLoaded = false;
      projectLoadError = null;
      return;
    }
    projectLoaded = false;
    projectLoadError = null;
    void apiClient.projects
      .get(pid)
      .then((proj) => {
        projectDeptId = proj?.dept_id ?? null;
      })
      .catch((err) => {
        // Backend will 403/404 the create attempt anyway, but the user
        // needs to know the dept couldn't be resolved — schedule create
        // is hard-blocked below to avoid sending an unscoped request.
        projectDeptId = null;
        projectLoadError =
          err instanceof Error ? err.message : 'Failed to load project';
      })
      .finally(() => {
        projectLoaded = true;
      });
  });

  const canCreateSchedule = $derived.by(() => {
    if (!projectId || !projectLoaded) return false;
    return canEditScheduledTrigger(
      { roles: auth.tenantRoles, depts: auth.deptRoles },
      { id: projectId, dept_id: projectDeptId },
    );
  });

  async function saveIntake(): Promise<void> {
    scheduleError = null;
    if (projectLoadError) {
      scheduleError = `Project department couldn't be resolved (${projectLoadError}). Refresh and retry.`;
      return;
    }
    if (!intakeRef?.validate()) {
      scheduleError = 'Form is incomplete or invalid.';
      return;
    }
    scheduleSaving = true;
    try {
      const created = await apiClient.scheduledTriggers.create(
        intakeValue as ScheduledTriggerCreate,
      );
      toast.success(`Created scheduled intake "${created.name}".`);
      await goto(`/channels/${created.id}?kind=schedule-intake`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      scheduleError = msg;
      toast.error(`Create failed: ${msg}`);
    } finally {
      scheduleSaving = false;
    }
  }

  // (Telegram is intentionally absent here: the channels-registry `channel_kind`
  // pgEnum does not yet include it, so a telegram row would fail to insert.)
  const KINDS: { value: ChannelKind; label: string }[] = [
    { value: 'teams', label: 'Microsoft Teams' },
    { value: 'email', label: 'Email' },
    { value: 'web', label: 'Web (browser push)' },
    { value: 'inapp', label: 'In-app' },
    { value: 'voice', label: 'Voice' },
  ];

  let kind = $state<ChannelKind>('email');
  let name = $state('');
  let scopeKind = $state<'workspace' | 'department'>('workspace');
  let deptId = $state('');

  // Kind-specific config (POST-only, sent verbatim alongside the create body
  // when the backend grows fields for them; today the wrapper only persists
  // {kind, name, dept_id?} but we keep the form ready).
  let teamsWebhook = $state('');
  let emailFrom = $state('');
  let webOrigin = $state('');
  let voiceProvider = $state('');

  let departments = $state<Department[]>([]);
  let depsLoadError = $state<string | null>(null);
  let depsOverride = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  // Submit shows a soft-block label while departments is empty AND
  // depsLoadError is set — but the user can override (the workspace path
  // doesn't need departments at all). The first click flips override and
  // is intercepted in handleSubmit; subsequent clicks submit normally.
  const submitSoftBlockedByDeps = $derived(
    depsLoadError !== null && departments.length === 0 && !depsOverride,
  );

  onMount(() => {
    void listDepartments()
      .then((d) => (departments = d))
      .catch((err) => {
        depsLoadError = err instanceof Error ? err.message : String(err);
        // Non-fatal — workspace-scoped create still works, but flag it.
      });
  });

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // First click while departments are missing: flip override, don't
    // actually submit. User clicks again to confirm.
    if (depsLoadError && departments.length === 0 && !depsOverride) {
      depsOverride = true;
      return;
    }
    error = null;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      error = 'Name is required.';
      return;
    }
    if (scopeKind === 'department' && !deptId) {
      error = 'Pick a department or switch to workspace scope.';
      return;
    }
    submitting = true;
    try {
      const created = await createChannel({
        kind,
        name: trimmedName,
        ...(scopeKind === 'department' ? { dept_id: deptId } : {}),
      });
      toast.success(`Created channel "${created.name}".`);
      void goto(`/channels/${created.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
      toast.error(`Create failed: ${msg}`);
    } finally {
      submitting = false;
    }
  }
</script>

{#if scheduleKind === 'schedule-intake'}
  <section
    class="p-6 max-w-2xl space-y-6"
    data-testid="channel-new-page"
    data-mode="schedule-intake"
  >
    <header>
      <h1 class="text-2xl font-semibold">New scheduled intake</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Schedule a recurring data pull from a connector into a project's
        intake queue.
      </p>
    </header>

    {#if !projectId}
      <p class="text-sm text-[var(--color-danger)]" data-testid="schedule-missing-project">
        Missing <code>project_id</code> query parameter.
      </p>
    {:else}
      {#if projectLoadError}
        <p
          class="text-sm text-[var(--color-danger)]"
          data-testid="schedule-project-load-error"
        >
          Couldn't resolve project department: {projectLoadError}. Refresh to retry.
        </p>
      {/if}
      <ScheduleIntakeEditor
        bind:this={intakeRef}
        bind:value={intakeValue}
        {projectId}
        mode="create"
        disabled={scheduleSaving}
      />
      {#if scheduleError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="schedule-error">
          {scheduleError}
        </p>
      {/if}
      <div class="flex gap-2 justify-end items-center">
        <a
          href="/channels"
          class="px-4 py-2 border border-[var(--color-border)] rounded text-sm hover:bg-[var(--color-surface-strong)]"
        >
          Cancel
        </a>
        {#if canCreateSchedule}
          <button
            type="button"
            disabled={scheduleSaving}
            onclick={saveIntake}
            class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            data-testid="trigger-save"
          >
            {scheduleSaving ? 'Creating…' : 'Create scheduled intake'}
          </button>
        {:else if projectLoaded}
          <span
            class="text-sm text-[var(--color-text-muted)] italic"
            data-testid="schedule-readonly-notice"
          >
            Read-only — your role doesn't permit edits to this project.
          </span>
        {/if}
      </div>
    {/if}
  </section>
{:else}
<section class="p-6 max-w-2xl space-y-6" data-testid="channel-new-page">
  <header>
    <h1 class="text-2xl font-semibold">New channel</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Choose the channel kind and where it lives in the workspace.
    </p>
  </header>

  {#if depsLoadError && departments.length === 0}
    <div
      class="rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 text-sm text-[var(--color-warning-text)]"
      data-testid="channel-new-deps-warning"
    >
      <p class="font-medium">Could not load departments — refresh to try again.</p>
      <p class="text-xs mt-1 opacity-80">
        {depsLoadError}
      </p>
      <p class="text-xs mt-1 opacity-80">
        Workspace-scoped channels can still be created without department data.
      </p>
    </div>
  {/if}

  <form class="space-y-4" onsubmit={handleSubmit}>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Kind</span>
      <select
        bind:value={kind}
        class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm"
        data-testid="channel-new-kind"
      >
        {#each KINDS as k (k.value)}
          <option value={k.value}>{k.label}</option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Name</span>
      <input
        type="text"
        bind:value={name}
        required
        maxlength="100"
        placeholder="e.g. Teams — engineering"
        class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm"
        data-testid="channel-new-name"
      />
    </label>

    <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-2">
      <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
        Scope
      </legend>
      <label class="flex items-center gap-2 text-sm">
        <input
          type="radio"
          bind:group={scopeKind}
          value="workspace"
          data-testid="channel-new-scope-workspace"
        />
        Workspace (visible to all departments)
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input
          type="radio"
          bind:group={scopeKind}
          value="department"
          data-testid="channel-new-scope-department"
        />
        Department
      </label>
      {#if scopeKind === 'department'}
        <select
          bind:value={deptId}
          class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-2 py-1 text-sm"
          data-testid="channel-new-dept"
        >
          <option value="">— pick a department —</option>
          {#each departments as d (d.id)}
            <option value={d.id}>{displayName(d.name, d.id)}</option>
          {/each}
        </select>
        {#if depsLoadError}
          <p class="text-xs text-[var(--color-warning-text)]">
            Couldn't load departments: {depsLoadError}
          </p>
        {/if}
      {/if}
    </fieldset>

    <!-- Kind-specific config -->
    <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-3">
      <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
        Configuration
      </legend>
      {#if kind === 'teams'}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Incoming webhook URL</span>
          <input
            type="url"
            bind:value={teamsWebhook}
            placeholder="https://outlook.office.com/webhook/…"
            class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
            data-testid="channel-new-teams-webhook"
          />
        </label>
      {:else if kind === 'email'}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">From address</span>
          <input
            type="email"
            bind:value={emailFrom}
            placeholder="notifications@example.com"
            class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
            data-testid="channel-new-email-from"
          />
        </label>
      {:else if kind === 'web'}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Origin</span>
          <input
            type="url"
            bind:value={webOrigin}
            placeholder="https://app.example.com"
            class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
            data-testid="channel-new-web-origin"
          />
        </label>
      {:else if kind === 'voice'}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Provider</span>
          <input
            type="text"
            bind:value={voiceProvider}
            placeholder="twilio / signalwire / …"
            class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
            data-testid="channel-new-voice-provider"
          />
        </label>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]">
          In-app channels need no extra configuration.
        </p>
      {/if}
    </fieldset>

    {#if error}
      <p class="text-sm text-[var(--color-danger)]" data-testid="channel-new-error">
        {error}
      </p>
    {/if}

    <div class="flex gap-2 justify-end">
      <a
        href="/channels"
        class="px-4 py-2 border border-[var(--color-border)] rounded text-sm hover:bg-[var(--color-surface-strong)]"
      >
        Cancel
      </a>
      <button
        type="submit"
        disabled={submitting}
        class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
        data-testid="channel-new-submit"
      >
        {submitting
          ? 'Creating…'
          : submitSoftBlockedByDeps
            ? 'Click again to create without departments'
            : 'Create channel'}
      </button>
    </div>
  </form>
</section>
{/if}
