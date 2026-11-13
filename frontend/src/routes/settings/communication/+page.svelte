<!--
  /settings/communication — Communication settings: where fr reaches you
  (per-user routing rules + the event × channel alert matrix) AND how you
  operate fr from other channels (Telegram, email, Teams, an MCP client),
  read from GET /api/me/channel-commands.

  This is the home for the user-prefs surface that used to live at
  /settings/channels (which now redirects here). It lists the caller's
  per-channel preferences from /api/me/channels and lets them add / toggle
  / set-default / delete rows.

  ⚠️ CORRECTED — this said an "associated channel" picker could be added "once
  the channels-registry routes ship (Wave 3)". They SHIPPED: full CRUD is
  registered in `backend/src/server.ts` — GET/POST `/api/channels`,
  GET/PATCH/DELETE `/api/channels/:id` — and the admin /channels page consumes
  them via `$lib/api/channels.ts`. So the picker is not blocked on a backend
  dependency; it is simply unbuilt UI on this page, and nothing here waits for
  anything. Read the absence as work not done, not as work not yet possible —
  the distinction is what decides whether someone picks it up.

  ⚠️ These are TWO different things and the picker must not conflate them:
  `/api/me/channels` is the caller's own per-user routing preferences (what
  this page edits), while `/api/channels` is the workspace-/dept-scoped channel
  REGISTRY (what a picker would offer). server.ts says so at the registry's
  route block.

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 17.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listMyChannelPrefs,
    addPref,
    updatePref,
    deletePref,
    maskAddress,
    getChannelCommands,
    type ChannelCommandsGuide,
    type ChannelKind,
    type UserChannelPref,
  } from '$lib/api/channel-prefs';
  import { toast } from '$lib/stores/toast.svelte';
  import { registerUnsaved } from '$lib/stores/unsavedWork';
  import {
    getNotificationPrefs,
    replaceNotificationPrefs,
    EVENT_TYPE_LABELS,
    NOTIFICATION_CHANNELS,
    type PrefMatrixCell,
  } from '$lib/api/notifications';

  const CHANNEL_KINDS: { value: ChannelKind; label: string }[] = [
    { value: 'email', label: 'Email' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'teams', label: 'Microsoft Teams' },
    { value: 'websocket', label: 'fr web app (WebSocket)' },
    { value: 'mcp', label: 'MCP client' },
  ];

  const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
    CHANNEL_KINDS.map((k) => [k.value, k.label]),
  );

  function channelLabel(channel: string): string {
    return CHANNEL_LABELS[channel] ?? channel;
  }

  const MATRIX_CHANNEL_LABELS: Record<string, string> = {
    email: 'Email',
    telegram: 'Telegram',
    teams: 'Teams',
    websocket: 'Web app',
    mcp: 'MCP client',
  };

  // ── Event-type × channel preference matrix (WS1) ──────────────────────────
  // The inbox itself is always written; this matrix governs which event types
  // are ALSO delivered on which external channels. Loaded merged-over-defaults
  // from /api/me/notification-prefs; saved replace-all (every cell explicit).
  let matrix = $state<PrefMatrixCell[]>([]);
  let matrixLoading = $state(false);
  let matrixSaving = $state(false);
  let matrixError = $state<string | null>(null);

  function matrixSnapshot(cells: PrefMatrixCell[]): string {
    return JSON.stringify(cells.map((c) => [c.event_type, c.channel, c.enabled]));
  }

  // What the SERVER last told us the matrix is. The toggles below are local
  // until "Save" is pressed, so this is the only way to tell an edited matrix
  // from an untouched one — a plain `dirty = true` in toggleCell would also
  // report dirty after a toggle and its undo, and prompt over nothing.
  // ⚠️ Seeded from the EMPTY matrix, not `''`: before `loadMatrix()` resolves
  // (and after it fails) `matrix` is `[]`, and any other seed would read as an
  // edit and prompt on a page the user has not touched.
  let matrixBaseline = $state(matrixSnapshot([]));

  const eventTypes = $derived(
    [...new Set(matrix.map((c) => c.event_type))],
  );

  function cellEnabled(eventType: string, channel: string): boolean {
    return matrix.find((c) => c.event_type === eventType && c.channel === channel)?.enabled ?? false;
  }

  function toggleCell(eventType: string, channel: string): void {
    matrix = matrix.map((c) =>
      c.event_type === eventType && c.channel === channel
        ? { ...c, enabled: !c.enabled, is_default: false }
        : c,
    );
  }

  async function loadMatrix(): Promise<void> {
    matrixLoading = true;
    try {
      matrix = await getNotificationPrefs();
      matrixBaseline = matrixSnapshot(matrix);
      matrixError = null;
    } catch (err) {
      matrixError = err instanceof Error ? err.message : String(err);
    } finally {
      matrixLoading = false;
    }
  }

  async function saveMatrix(): Promise<void> {
    matrixSaving = true;
    try {
      // Send every cell explicitly so the saved state matches what is shown
      // (replace-all reverts any omitted cell to its code default).
      matrix = await replaceNotificationPrefs(
        matrix.map((c) => ({ event_type: c.event_type, channel: c.channel, enabled: c.enabled })),
      );
      matrixBaseline = matrixSnapshot(matrix);
      toast.success('Communication settings saved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      matrixError = msg;
      toast.error(`Save failed: ${msg}`);
    } finally {
      matrixSaving = false;
    }
  }

  let prefs = $state<UserChannelPref[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let formChannel = $state<ChannelKind>('email');
  let formAddress = $state('');
  // The workspace the new link acts in ('' = unpinned; only asked when you belong to several).
  let formTenant = $state('');
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  let pendingIds = $state<Set<string>>(new Set());

  function addressInputType(channel: ChannelKind): 'tel' | 'email' | 'text' {
    if (channel === 'email' || channel === 'teams') return 'email';
    return 'text';
  }

  function addressPlaceholder(channel: ChannelKind): string {
    switch (channel) {
      case 'email':
        return 'you@example.com';
      case 'telegram':
        return 'Telegram chat id (e.g. 123456789)';
      case 'teams':
        return 'you@tenant.onmicrosoft.com';
      case 'websocket':
        return 'session id (e.g. ws-abc123)';
      case 'mcp':
        return 'Address your MCP client shows, e.g. care-bus:<workspace>:<your id>';
    }
  }

  function channelBadgeClass(channel: ChannelKind): string {
    const base = 'inline-block px-2 py-0.5 rounded text-xs font-medium border';
    switch (channel) {
      case 'teams':
        return `${base} bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]`;
      case 'telegram':
        return `${base} bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success-bg)]`;
      case 'websocket':
        return `${base} bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-bg)]`;
      case 'email':
        return `${base} bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]`;
      case 'mcp':
        return `${base} bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)]`;
    }
  }

  // ── Control fr from your channels ─────────────────────────────────────────
  // Read-only guide from GET /api/me/channel-commands — the same source the
  // chat `help` reply reads, so this list cannot drift from what fr accepts.
  let guide = $state<ChannelCommandsGuide>({ channels: [], commands: [], workspaces: [] });
  let guideLoading = $state(false);
  let guideError = $state<string | null>(null);

  const commandChannels = $derived(guide.channels.filter((c) => c.commands));

  function workspaceName(tenantId: string | null): string {
    if (!tenantId) return guide.workspaces.length > 1 ? 'Any (unpinned)' : '';
    return guide.workspaces.find((w) => w.id === tenantId)?.name ?? tenantId;
  }

  function hasEnabledAddress(channel: string): boolean {
    return prefs.some((p) => p.channel === channel && p.enabled);
  }

  async function loadGuide(): Promise<void> {
    guideLoading = true;
    try {
      guide = await getChannelCommands();
      guideError = null;
    } catch (err) {
      guideError = err instanceof Error ? err.message : String(err);
    } finally {
      guideLoading = false;
    }
  }

  function markPending(id: string, on: boolean): void {
    const next = new Set(pendingIds);
    if (on) next.add(id);
    else next.delete(id);
    pendingIds = next;
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      prefs = await listMyChannelPrefs();
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    void loadMatrix();
    void loadGuide();
    // A workspace switch rebuilds this document (no [param] in the route, so it
    // stays put), which discards both an unsaved matrix and a half-typed
    // address. The per-row toggles are NOT listed: they write through to the
    // server immediately, so they are never unsaved.
    return registerUnsaved(
      'settings/communication',
      () => formAddress.trim().length > 0 || matrixSnapshot(matrix) !== matrixBaseline,
    );
  });

  async function handleAdd(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    formError = null;
    const address = formAddress.trim();
    if (address.length === 0) {
      formError = 'Address is required.';
      return;
    }
    submitting = true;
    try {
      const created = await addPref({ channel: formChannel, address, tenant_id: formTenant || null });
      prefs = [...prefs, created];
      formAddress = '';
      toast.success(`Added ${channelLabel(formChannel)} address`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      formError = msg;
      toast.error(`Failed to add: ${msg}`);
    } finally {
      submitting = false;
    }
  }

  async function handleToggleEnabled(row: UserChannelPref): Promise<void> {
    const original = prefs;
    const nextEnabled = !row.enabled;
    prefs = prefs.map((p) => (p.id === row.id ? { ...p, enabled: nextEnabled } : p));
    markPending(row.id, true);
    try {
      const updated = await updatePref(row.id, { enabled: nextEnabled }, original);
      prefs = updated;
    } catch (err) {
      prefs = original;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Toggle failed: ${msg}`);
    } finally {
      markPending(row.id, false);
    }
  }

  async function handleSetDefault(row: UserChannelPref): Promise<void> {
    if (row.is_default) return;
    const original = prefs;
    prefs = prefs.map((p) => ({ ...p, is_default: p.id === row.id }));
    markPending(row.id, true);
    try {
      const updated = await updatePref(row.id, { is_default: true }, original);
      prefs = updated;
      toast.success(`Default channel set to ${channelLabel(row.channel)}`);
    } catch (err) {
      prefs = original;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Set-default failed: ${msg}`);
    } finally {
      markPending(row.id, false);
    }
  }

  async function handleDelete(row: UserChannelPref): Promise<void> {
    const original = prefs;
    prefs = prefs.filter((p) => p.id !== row.id);
    markPending(row.id, true);
    try {
      await deletePref(row.id);
      toast.success('Channel removed');
    } catch (err) {
      prefs = original;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
    } finally {
      markPending(row.id, false);
    }
  }
</script>

<div class="flex flex-col gap-6 p-6 max-w-3xl" data-testid="communication-page">
  <header>
    <h1 class="text-2xl font-semibold">Communication settings</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Pick where fr reaches you, and link the channels you want to operate fr
      from. The default channel is used when an action doesn't specify one.
    </p>
  </header>

  {#if loadError}
    <div class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3">
      {loadError}
    </div>
  {/if}

  <section data-testid="notifications-list">
    {#if loading && prefs.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
    {:else if prefs.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">
        No routing rules configured yet. Add one below.
      </p>
    {:else}
      <div class="border rounded overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
            <tr>
              <th class="text-left px-3 py-2 font-medium">Channel</th>
              <th class="text-left px-3 py-2 font-medium">Address</th>
              {#if guide.workspaces.length > 1}
                <th class="text-left px-3 py-2 font-medium">Workspace</th>
              {/if}
              <th class="text-left px-3 py-2 font-medium">Enabled</th>
              <th class="text-left px-3 py-2 font-medium">Default</th>
              <th class="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each prefs as row (row.id)}
              {@const busy = pendingIds.has(row.id)}
              <tr class="border-t" data-testid="notification-row" class:opacity-60={busy}>
                <td class="px-3 py-2">
                  <span class={channelBadgeClass(row.channel)}>{channelLabel(row.channel)}</span>
                </td>
                <td
                  class="px-3 py-2 font-mono text-xs"
                  title={row.address}
                  data-testid="notification-address"
                >
                  {maskAddress(row.channel, row.address)}
                </td>
                {#if guide.workspaces.length > 1}
                  <td class="px-3 py-2 text-xs" data-testid="notification-workspace">{workspaceName(row.tenant_id)}</td>
                {/if}
                <td class="px-3 py-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.enabled}
                    aria-label={row.enabled
                      ? `Disable ${channelLabel(row.channel)}`
                      : `Enable ${channelLabel(row.channel)}`}
                    disabled={busy}
                    onclick={() => void handleToggleEnabled(row)}
                    class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors {row.enabled
                      ? 'bg-[var(--color-accent)]'
                      : 'bg-[var(--color-surface-strong)]'} disabled:opacity-50"
                    data-testid="notification-toggle"
                  >
                    <span
                      class="inline-block h-4 w-4 transform rounded-full bg-[var(--color-bg)] transition-transform {row.enabled
                        ? 'translate-x-4'
                        : 'translate-x-1'} dark:bg-[var(--color-surface)]"
                    ></span>
                  </button>
                </td>
                <td class="px-3 py-2">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={row.is_default}
                    disabled={busy || row.is_default}
                    onclick={() => void handleSetDefault(row)}
                    class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors {row.is_default
                      ? 'bg-[var(--color-accent-bg)] border-[var(--color-accent-border)] text-[var(--color-accent-text)] font-semibold cursor-default'
                      : 'border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]'} disabled:cursor-not-allowed"
                    data-testid="notification-default"
                  >
                    <span
                      class="inline-block h-2 w-2 rounded-full {row.is_default
                        ? 'bg-[var(--color-accent)]'
                        : 'bg-[var(--color-surface-strong)]'}"
                    ></span>
                    {row.is_default ? 'Default' : 'Set default'}
                  </button>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => void handleDelete(row)}
                    class="text-xs text-[var(--color-danger)] hover:text-[var(--color-danger-text)] hover:underline disabled:opacity-50"
                    data-testid="notification-delete"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section
    class="border border-[var(--color-border)] rounded p-4 bg-[var(--color-bg)] dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]"
    data-testid="notifications-add"
  >
    <h2 class="text-sm font-medium mb-3">+ Add address</h2>
    <form class="flex flex-col sm:flex-row gap-2 sm:items-end" onsubmit={handleAdd}>
      <label class="flex flex-col gap-1 text-xs">
        Type
        <select
          bind:value={formChannel}
          class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          data-testid="add-notification-type"
        >
          {#each CHANNEL_KINDS as kind (kind.value)}
            <option value={kind.value}>{kind.label}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs flex-1 min-w-0">
        Address
        <input
          type={addressInputType(formChannel)}
          bind:value={formAddress}
          placeholder={addressPlaceholder(formChannel)}
          class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm font-mono dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          required
          data-testid="add-notification-address"
        />
      </label>
      {#if guide.workspaces.length > 1}
        <label class="flex flex-col gap-1 text-xs">
          Acts in workspace
          <select
            bind:value={formTenant}
            class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
            data-testid="add-notification-workspace"
          >
            <option value="">Any (unpinned)</option>
            {#each guide.workspaces as ws (ws.id)}
              <option value={ws.id}>{ws.name ?? ws.id}</option>
            {/each}
          </select>
        </label>
      {/if}
      <button
        type="submit"
        disabled={submitting}
        class="px-3 py-1.5 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        data-testid="add-notification-submit"
      >
        {submitting ? 'Adding…' : 'Add'}
      </button>
    </form>
    {#if formError}
      <p class="mt-2 text-xs text-[var(--color-danger)] dark:text-[var(--color-danger-text)]" data-testid="add-notification-error">
        {formError}
      </p>
    {/if}
  </section>

  <section data-testid="channel-commands">
    <header class="mb-3">
      <h2 class="text-lg font-semibold">Control fr from your channels</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Send these commands from a linked channel and fr runs them as you. Link
        a channel by adding its address above.
      </p>
    </header>

    {#if guideError}
      <div class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3 mb-3">
        {guideError}
      </div>
    {/if}

    {#if guideLoading && guide.channels.length === 0 && guide.commands.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
    {:else if !guideError}
      {#if commandChannels.length > 0}
        <ul class="flex flex-col gap-2 mb-4">
          {#each commandChannels as ch (ch.channel)}
            {@const linked = hasEnabledAddress(ch.channel)}
            <li
              class="border border-[var(--color-border)] rounded p-3 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
              data-testid="channel-command-channel"
              data-channel={ch.channel}
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-medium">{ch.label}</span>
                <span
                  class="inline-block px-2 py-0.5 rounded text-xs font-medium border {linked
                    ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success-bg)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border-strong)]'}"
                  data-testid="channel-command-linked"
                >
                  {linked ? 'Linked' : 'Not linked'}
                </span>
              </div>
              <p class="mt-1 text-xs text-[var(--color-text-muted)]">{ch.link}</p>
            </li>
          {/each}
        </ul>
      {/if}

      {#if guide.commands.length > 0}
        <div class="border rounded overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
              <tr>
                <th class="text-left px-3 py-2 font-medium">Command</th>
                <th class="text-left px-3 py-2 font-medium">What it does</th>
              </tr>
            </thead>
            <tbody>
              {#each guide.commands as cmd (cmd.usage)}
                <tr class="border-t" data-testid="channel-command-row">
                  <td class="px-3 py-2 align-top whitespace-nowrap"><code class="font-mono text-xs">{cmd.usage}</code></td>
                  <td class="px-3 py-2">
                    {cmd.description}
                    {#if cmd.confirms}
                      <span class="block text-xs text-[var(--color-text-muted)]">Asks you to confirm before it runs.</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">No commands available.</p>
      {/if}
    {/if}
  </section>

  <section data-testid="notification-types">
    <header class="mb-3">
      <h2 class="text-lg font-semibold">Project-execution alerts</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Choose which execution events also reach you on each channel. Everything
        always appears in your in-app
        <a href="/notifications" class="underline">Notifications</a> inbox — these
        toggles only control the extra channels above.
      </p>
    </header>

    {#if matrixError}
      <div class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3 mb-3">
        {matrixError}
      </div>
    {/if}

    {#if matrixLoading && matrix.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
    {:else if matrix.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">No event types available.</p>
    {:else}
      <div class="border rounded overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
            <tr>
              <th class="text-left px-3 py-2 font-medium">Event</th>
              {#each NOTIFICATION_CHANNELS as ch (ch)}
                <th class="text-center px-3 py-2 font-medium">{MATRIX_CHANNEL_LABELS[ch] ?? ch}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each eventTypes as et (et)}
              <tr class="border-t" data-testid="matrix-row" data-event-type={et}>
                <td class="px-3 py-2">{EVENT_TYPE_LABELS[et] ?? et}</td>
                {#each NOTIFICATION_CHANNELS as ch (ch)}
                  <td class="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={cellEnabled(et, ch)}
                      onchange={() => toggleCell(et, ch)}
                      aria-label={`${EVENT_TYPE_LABELS[et] ?? et} via ${MATRIX_CHANNEL_LABELS[ch] ?? ch}`}
                      data-testid={`matrix-cell-${et}-${ch}`}
                    />
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="mt-3">
        <button
          type="button"
          disabled={matrixSaving}
          onclick={() => void saveMatrix()}
          class="px-3 py-1.5 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
          data-testid="matrix-save"
        >
          {matrixSaving ? 'Saving…' : 'Save alert preferences'}
        </button>
      </div>
    {/if}
  </section>
</div>
