<!--
  /channels/[id] — channel detail page (multi-mode).

  Two-mode page driven by the `?kind=` query param, mirroring /channels/new
  (Plan 2-C Phase 2):
    ?kind=schedule-intake   → ScheduleIntakeEditor + ExecutionsTable, PATCH /api/scheduled-triggers/:id
    (no kind / unknown)     → existing notification-channel registry editor.

  The kebab-case URL kinds map to snake_case wire kinds via
  `kindFromUrl`/`urlKindToWire` from $lib/api/unifiedChannels.

  PATCH-body shaping: the loaded entity row carries fields the strict
  PatchBodySchema rejects (id, tenant_id, project_id, created_at,
  updated_at, last_run_*, plus source_connector for triggers). We strip
  those before sending the PATCH so the editor's bind:value=row Edit ergonomics
  don't bleed into the wire body.

  Plan: docs/superpowers/plans/2026-04-29-spec-2-plan-c-ui-surfaces.md §3.2.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { goto } from '$app/navigation';
  import {
    listChannels,
    updateChannel,
    deleteChannel,
    type Channel,
    type ChannelKind,
  } from '$lib/api/channels';
  import { apiClient } from '$lib/api/unified-client';
  import { kindFromUrl } from '$lib/api/unifiedChannels';
  import type {
    ScheduledTrigger,
    ScheduledTriggerCreate,
    ScheduledTriggerUpdate,
  } from '$lib/types/api';
  import ScheduleIntakeEditor from '$lib/components/channels/ScheduleIntakeEditor.svelte';
  import ExecutionsTable from '$lib/components/channels/ExecutionsTable.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    canEditScheduledTrigger,
    type User as RbacUser,
    type Project as RbacProject,
  } from '$lib/rbac/canEditScheduledTrigger';
  import { Skeleton, ErrorState } from '$lib/components/ui';
  import { readFailureReason } from '$lib/asset-workspace/scopeRefs';
  import { scheduleActionsState } from './page-helpers';

  // ---------------------------------------------------------------------------
  // URL dispatch
  // ---------------------------------------------------------------------------
  const channelId = $derived(page.params.id as string);
  const urlKind = $derived(kindFromUrl(page.url.searchParams));

  // ===========================================================================
  // Branch A: scheduled intake
  // ===========================================================================

  let intakeRow = $state<ScheduledTrigger | null>(null);
  let intakeValue = $state<Partial<ScheduledTriggerCreate>>({});
  let intakeRef: { validate: () => boolean } | undefined = $state();

  let scheduleLoading = $state(false);
  let scheduleSaving = $state(false);
  let scheduleRunning = $state(false);
  let scheduleDeleting = $state(false);
  let scheduleError = $state<string | null>(null);
  let scheduleLoadError = $state<unknown>(null);
  let scheduleDeleteConfirm = $state(false);

  // RBAC (Plan 2-C Phase 4.2). UX-only — backend (Phase 0.5) is the
  // security boundary. We resolve the project's dept_id once after loading
  // the trigger row so canEditScheduledTrigger() can answer
  // dept-manager-of-this-dept reliably. Workspace-scope projects
  // (dept_id IS NULL) only pass for workspace-admin, mirroring the
  // backend `requireDeptRole(null, 'dept-manager')` behavior.
  let scheduleProjectDeptId = $state<string | null>(null);
  /**
   * The project read that supplies `dept_id` FAILED.
   *
   * ⚠️ Failing closed here is right — the backend is the security boundary and a
   * null dept_id must not widen access. What was wrong is that it failed closed
   * SILENTLY: `canEditSchedule` went false, every action button (Run now, Save,
   * Delete) disappeared, and the page rendered as a perfectly ordinary
   * read-only view. The user is left to conclude they lack permission, when in
   * fact nothing about their permission was ever determined. Keep the deny;
   * name the input that was lost.
   *
   * ⚠️ Carries the REASON, not a boolean: "retry" is the whole remediation this
   * page offers, and whether it can work is exactly what the reason says.
   * null ⇒ the project read succeeded.
   */
  let scheduleDeptUnreadable = $state<string | null>(null);

  function rbacUser(): RbacUser {
    return {
      roles: auth.tenantRoles,
      depts: auth.deptRoles,
    };
  }

  function rbacProject(): RbacProject | null {
    const projectId = urlKind === 'schedule-intake' ? intakeRow?.project_id : null;
    if (!projectId) return null;
    return { id: projectId, dept_id: scheduleProjectDeptId };
  }

  const canEditSchedule = $derived.by(() => {
    const p = rbacProject();
    if (!p) return false;
    return canEditScheduledTrigger(rbacUser(), p);
  });

  // Three states, not two: a hidden action must say whether it is hidden
  // because the answer was no, or because the question was never answered.
  const actionsState = $derived(
    scheduleActionsState({
      canEdit: canEditSchedule,
      deptUnreadable: scheduleDeptUnreadable,
    }),
  );

  async function loadSchedule(): Promise<void> {
    scheduleLoading = true;
    scheduleLoadError = null;
    scheduleProjectDeptId = null;
    scheduleDeptUnreadable = null;
    try {
      let projectId: string | null = null;
      if (urlKind === 'schedule-intake') {
        const row = await apiClient.scheduledTriggers.get(channelId);
        intakeRow = row;
        // Editor expects Partial<ScheduledTriggerCreate>; the loaded row is
        // a superset (carries id/tenant_id/created_at/etc). Editor mutates
        // bound fields in place, so we shallow-copy to avoid leaking edits
        // into the original `row` reference (kept around for project_id
        // lookup + delete-back navigation).
        intakeValue = { ...row };
        projectId = row.project_id;
      }
      // Resolve project dept_id for RBAC button gating. Non-fatal — if
      // this fails the button stays hidden (safer default; the user can
      // refresh). The backend remains the security boundary.
      if (projectId) {
        try {
          const proj = await apiClient.projects.get(projectId);
          scheduleProjectDeptId = proj?.dept_id ?? null;
        } catch (err) {
          // Fail closed (see scheduleDeptUnreadable) — but not silently, and
          // not without the reason: a hidden button plus "retry" is unactionable
          // unless the user is told whether retrying can possibly help.
          scheduleProjectDeptId = null;
          scheduleDeptUnreadable = readFailureReason(
            err,
            'owning-project read failed',
          );
        }
      }
    } catch (err) {
      scheduleLoadError = err;
    } finally {
      scheduleLoading = false;
    }
  }

  /**
   * Drop fields the strict PatchBodySchema rejects. Kept here (not in the
   * api client) because the source-of-truth is "what the editor mutates,
   * minus what backend strict-rejects" — a per-page concern, not a wire-
   * client one.
   */
  function buildIntakePatch(
    v: Partial<ScheduledTriggerCreate>,
  ): ScheduledTriggerUpdate {
    return {
      name: v.name,
      cron: v.cron,
      timezone: v.timezone,
      connector_config: v.connector_config,
      payload_mapper: v.payload_mapper,
      target_list: v.target_list,
      card_template: v.card_template,
      enabled: v.enabled,
    };
  }

  async function saveSchedule(): Promise<void> {
    scheduleError = null;
    scheduleSaving = true;
    try {
      if (urlKind === 'schedule-intake') {
        if (!intakeRef?.validate()) {
          scheduleError = 'Form is incomplete or invalid.';
          return;
        }
        const updated = await apiClient.scheduledTriggers.update(
          channelId,
          buildIntakePatch(intakeValue),
        );
        intakeRow = updated;
        toast.success('Saved.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      scheduleError = msg;
      toast.error(`Save failed: ${msg}`);
    } finally {
      scheduleSaving = false;
    }
  }

  async function runScheduleNow(): Promise<void> {
    scheduleRunning = true;
    try {
      if (urlKind === 'schedule-intake') {
        await apiClient.scheduledTriggers.runNow(channelId);
      }
      toast.success('Run dispatched.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Run failed: ${msg}`);
    } finally {
      scheduleRunning = false;
    }
  }

  async function deleteSchedule(): Promise<void> {
    scheduleDeleting = true;
    try {
      if (urlKind === 'schedule-intake') {
        await apiClient.scheduledTriggers.remove(channelId);
      }
      toast.success('Deleted.');
      void goto('/channels');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
    } finally {
      scheduleDeleting = false;
      scheduleDeleteConfirm = false;
    }
  }

  // ===========================================================================
  // Branch B: legacy notification-channel editor (preserved verbatim)
  // ===========================================================================

  const KINDS: { value: ChannelKind; label: string }[] = [
    { value: 'teams', label: 'Microsoft Teams' },
    { value: 'email', label: 'Email' },
    { value: 'web', label: 'Web (browser push)' },
    { value: 'inapp', label: 'In-app' },
    { value: 'voice', label: 'Voice' },
  ];

  let channel = $state<Channel | null>(null);
  let loading = $state(true);
  let backendUnavailable = $state(false);
  let loadError = $state<unknown>(null);

  let editName = $state('');
  let editKind = $state<ChannelKind>('email');

  let credTeamsSecret = $state('');
  let credEmailSmtpPassword = $state('');
  let credVoiceApiKey = $state('');

  let saving = $state(false);
  let deleting = $state(false);
  let deleteConfirm = $state(false);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    backendUnavailable = false;
    try {
      const all = await listChannels();
      const found = all.find((c) => c.id === channelId);
      if (!found) {
        loadError = new Error(`Channel ${channelId} not found.`);
        return;
      }
      channel = found;
      editName = found.name;
      editKind = found.kind;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A 404/405/501 from GET /api/channels means the registry was
      // UNREADABLE, not unbuilt — all five verbs are registered in
      // backend/src/server.ts. The banner below says so.
      if (/\b(404|405|501)\b/.test(msg)) {
        backendUnavailable = true;
      } else {
        loadError = err;
        toast.error(`Failed to load channel: ${msg}`);
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (urlKind === 'schedule-intake') {
      void loadSchedule();
    } else {
      void load();
    }
  });

  function collectCredentials(): Record<string, string> {
    const payload: Record<string, string> = {};
    if (editKind === 'teams' && credTeamsSecret) {
      payload.teams_secret = credTeamsSecret;
    }
    if (editKind === 'email' && credEmailSmtpPassword) {
      payload.email_smtp_password = credEmailSmtpPassword;
    }
    if (editKind === 'voice' && credVoiceApiKey) {
      payload.voice_api_key = credVoiceApiKey;
    }
    return payload;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!channel) return;
    saving = true;
    try {
      const patch: Parameters<typeof updateChannel>[1] = {};
      if (editName.trim() !== channel.name) patch.name = editName.trim();
      if (editKind !== channel.kind) patch.kind = editKind;

      const creds = collectCredentials();
      if (Object.keys(creds).length === 0 && Object.keys(patch).length === 0) {
        toast.info('Nothing to save.');
        return;
      }
      const updated = await updateChannel(channel.id, {
        ...patch,
        ...(creds as unknown as Partial<{ name: string }>),
      });
      channel = updated;
      editName = updated.name;
      editKind = updated.kind;
      credTeamsSecret = '';
      credEmailSmtpPassword = '';
      credVoiceApiKey = '';
      toast.success('Channel saved.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      saving = false;
    }
  }

  async function remove(): Promise<void> {
    if (!channel) return;
    deleting = true;
    try {
      await deleteChannel(channel.id);
      toast.success(`Deleted ${channel.name}.`);
      void goto('/channels');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
    } finally {
      deleting = false;
      deleteConfirm = false;
    }
  }

  const scheduleTitle = $derived(
    urlKind === 'schedule-intake'
      ? (intakeRow?.name ?? 'Scheduled intake')
      : '',
  );

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(page.url.pathname, urlKind ? (scheduleTitle || null) : (channel?.name ?? null));
  });
</script>

{#if urlKind === 'schedule-intake'}
  <section
    class="p-6 max-w-2xl space-y-6"
    data-testid="channel-edit-page"
    data-mode="schedule-intake"
  >
    <header class="flex items-baseline justify-between">
      <div>
        <h1 class="text-2xl font-semibold">{intakeRow?.name ?? 'Scheduled intake'}</h1>
        {#if intakeRow}
          <p class="text-sm text-[var(--color-text-muted)]">
            Project <code>{intakeRow.project_id}</code> ·
            Connector <code>{intakeRow.source_connector}</code>
          </p>
        {/if}
      </div>
      <a href="/channels" class="text-sm text-[var(--color-accent)] hover:underline">
        ← All channels
      </a>
    </header>

    {#if scheduleLoading}
      <Skeleton variant="text" count={4} height="2rem" />
    {:else if scheduleLoadError}
      <ErrorState
        error={scheduleLoadError}
        title="Failed to load scheduled intake"
        onRetry={loadSchedule}
      />
    {:else if intakeRow}
      <ScheduleIntakeEditor
        bind:this={intakeRef}
        bind:value={intakeValue}
        projectId={intakeRow.project_id}
        mode="edit"
        disabled={scheduleSaving}
      />

      {#if scheduleError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="schedule-error">
          {scheduleError}
        </p>
      {/if}

      {#if actionsState === 'permission-unknown'}
        <p
          class="text-sm text-[var(--color-warning-text)]"
          data-testid="schedule-rbac-unreadable"
          title={`Owning-project read failed — ${scheduleDeptUnreadable}`}
        >
          The owning project could not be read, so your permissions on this
          schedule are UNKNOWN — the actions are hidden as a precaution, not
          because you lack them. Retry before concluding anything.
          <span class="font-mono text-xs text-[var(--color-text-muted)]"
            >({scheduleDeptUnreadable})</span
          >
        </p>
      {/if}
      {#if actionsState === 'actions'}
        <div class="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onclick={() => void runScheduleNow()}
            disabled={scheduleRunning || scheduleSaving}
            class="px-3 py-2 border border-[var(--color-accent)] text-[var(--color-accent)] rounded text-sm hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
            data-testid="trigger-run-now"
          >
            {scheduleRunning ? 'Running…' : 'Run now'}
          </button>
          <button
            type="button"
            onclick={() => void saveSchedule()}
            disabled={scheduleSaving}
            class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            data-testid="trigger-save"
          >
            {scheduleSaving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      {:else}
        <p
          class="text-sm text-[var(--color-text-muted)] italic text-right"
          data-testid="schedule-readonly-notice"
        >
          Read-only — your role doesn't permit edits to this project.
        </p>
      {/if}

      <ExecutionsTable
        entityId={channelId}
        entityKind="schedule-intake"
      />

      {#if actionsState === 'permission-unknown'}
        <p
          class="text-sm text-[var(--color-warning-text)]"
          data-testid="schedule-rbac-unreadable"
          title={`Owning-project read failed — ${scheduleDeptUnreadable}`}
        >
          The owning project could not be read, so your permissions on this
          schedule are UNKNOWN — the actions are hidden as a precaution, not
          because you lack them. Retry before concluding anything.
          <span class="font-mono text-xs text-[var(--color-text-muted)]"
            >({scheduleDeptUnreadable})</span
          >
        </p>
      {/if}
      {#if actionsState === 'actions'}
        <section class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4">
          <h2 class="text-sm font-semibold text-[var(--color-danger-text)]">Delete scheduled intake</h2>
          <p class="text-xs text-[var(--color-danger-text)] mb-3">
            Removes this trigger and its run history. Cards already created in the
            target project remain.
          </p>
          {#if scheduleDeleteConfirm}
            <div class="flex gap-2">
              <button
                type="button"
                disabled={scheduleDeleting}
                onclick={() => void deleteSchedule()}
                class="px-3 py-1.5 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded text-sm hover:opacity-90 disabled:opacity-50"
                data-testid="trigger-delete-confirm"
              >
                {scheduleDeleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                type="button"
                disabled={scheduleDeleting}
                onclick={() => (scheduleDeleteConfirm = false)}
                class="px-3 py-1.5 border border-[var(--color-border)] rounded text-sm hover:bg-[var(--color-surface-strong)]"
              >
                Cancel
              </button>
            </div>
          {:else}
            <button
              type="button"
              onclick={() => (scheduleDeleteConfirm = true)}
              class="px-3 py-1.5 border border-[var(--color-danger-border)] text-[var(--color-danger)] rounded text-sm hover:bg-[var(--color-danger-bg)]"
              data-testid="trigger-delete-button"
            >
              Delete
            </button>
          {/if}
        </section>
      {/if}
    {/if}
  </section>
{:else}
  <section class="p-6 max-w-2xl space-y-6" data-testid="channel-edit-page">
    {#if backendUnavailable}
      <div
        class="rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-sm text-[var(--color-warning-text)] p-4"
        data-testid="channel-edit-backend-unavailable"
      >
        This channel could not be read — the channels registry came back
        not-found / not-allowed. The /api/channels routes are live, so this is
        a routing or connectivity failure, not a missing feature.
        <a href="/channels" class="underline ml-2">Back to list</a>
      </div>
    {:else if loading}
      <Skeleton variant="text" count={4} height="2rem" />
    {:else if loadError}
      <ErrorState error={loadError} title="Failed to load channel" onRetry={load} />
    {:else if channel}
      <header class="flex items-baseline justify-between">
        <div>
          <h1 class="text-2xl font-semibold">{channel.name}</h1>
          <p class="text-sm text-[var(--color-text-muted)]">
            {channel.dept_id ? `Department channel · dept:${channel.dept_id}` : 'Workspace channel'}
          </p>
        </div>
        <a href="/channels" class="text-sm text-[var(--color-accent)] hover:underline">
          ← All channels
        </a>
      </header>

      <form class="space-y-4" onsubmit={save}>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Name</span>
          <input
            type="text"
            bind:value={editName}
            required
            maxlength="100"
            class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm"
            data-testid="channel-edit-name"
          />
        </label>

        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Kind</span>
          <select
            bind:value={editKind}
            class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm"
            data-testid="channel-edit-kind"
          >
            {#each KINDS as k (k.value)}
              <option value={k.value}>{k.label}</option>
            {/each}
          </select>
        </label>

        <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-3">
          <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
            Credentials
          </legend>
          <p class="text-xs text-[var(--color-text-muted)]">
            Stored credentials are write-only. Type to replace; leave blank to keep the existing value.
          </p>
          {#if editKind === 'teams'}
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium">Teams shared secret</span>
              <input
                type="password"
                autocomplete="new-password"
                bind:value={credTeamsSecret}
                placeholder="••••••••"
                class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
                data-testid="channel-edit-teams-secret"
              />
            </label>
          {:else if editKind === 'email'}
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium">SMTP password</span>
              <input
                type="password"
                autocomplete="new-password"
                bind:value={credEmailSmtpPassword}
                placeholder="••••••••"
                class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
                data-testid="channel-edit-email-smtp"
              />
            </label>
          {:else if editKind === 'voice'}
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium">Voice provider API key</span>
              <input
                type="password"
                autocomplete="new-password"
                bind:value={credVoiceApiKey}
                placeholder="••••••••"
                class="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-3 py-2 text-sm font-mono"
                data-testid="channel-edit-voice-key"
              />
            </label>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">
              No credentials required for this channel kind.
            </p>
          {/if}
        </fieldset>

        <div class="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            data-testid="channel-edit-save"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <section class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4">
        <h2 class="text-sm font-semibold text-[var(--color-danger-text)]">Delete channel</h2>
        <p class="text-xs text-[var(--color-danger-text)] mb-3">
          Removes this channel from the registry. Any user routing rules pointing
          at this channel will need to be re-pointed.
        </p>
        {#if deleteConfirm}
          <div class="flex gap-2">
            <button
              type="button"
              disabled={deleting}
              onclick={() => void remove()}
              class="px-3 py-1.5 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded text-sm hover:opacity-90 disabled:opacity-50"
              data-testid="channel-delete-confirm"
            >
              {deleting ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button
              type="button"
              disabled={deleting}
              onclick={() => (deleteConfirm = false)}
              class="px-3 py-1.5 border border-[var(--color-border)] rounded text-sm hover:bg-[var(--color-surface-strong)]"
            >
              Cancel
            </button>
          </div>
        {:else}
          <button
            type="button"
            onclick={() => (deleteConfirm = true)}
            class="px-3 py-1.5 border border-[var(--color-danger-border)] text-[var(--color-danger)] rounded text-sm hover:bg-[var(--color-danger-bg)]"
            data-testid="channel-delete-button"
          >
            Delete channel
          </button>
        {/if}
      </section>
    {/if}
  </section>
{/if}
