<!--
  /channels — unified channel list (Plan 2-C Phase 1.3).

  Lists rows from two sources behind a single table:
    - notification channels (/api/channels)
    - scheduled intake triggers (/api/scheduled-triggers)

  Backend RBAC filters visibility per caller; we do NOT pass project_id
  here (the global list shows everything the user can see).

  Plan: docs/superpowers/plans/2026-04-29-spec-2-plan-c-ui-surfaces.md §1.3.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listUnifiedChannels,
    type WireUnifiedChannel,
  } from '$lib/api/unifiedChannels';
  import ChannelsList from '$lib/components/channels/ChannelsList.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { Skeleton, ErrorState } from '$lib/components/ui';

  let rows = $state<WireUnifiedChannel[]>([]);
  let loading = $state(true);
  let backendUnavailable = $state(false);
  let loadError = $state<unknown>(null);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    backendUnavailable = false;
    try {
      rows = await listUnifiedChannels({});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // listUnifiedChannels uses Promise.allSettled internally and tolerates
      // per-endpoint failure, so the only way to reach this catch is a
      // synchronous setup error. A 404/405/501-shaped message here therefore
      // means the list could not be READ (bad routing / unreachable API host),
      // NOT that the routes are unbuilt — all five /api/channels verbs are
      // registered in backend/src/server.ts. See the banner copy below.
      if (/\b(404|405|501)\b/.test(msg)) {
        backendUnavailable = true;
      } else {
        loadError = err;
        toast.error(`Failed to load channels: ${msg}`);
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section class="p-6 space-y-6" data-testid="channels-page">
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold">Channels</h1>
      <p
        class="text-sm text-[var(--color-text-muted)]"
        data-testid="channels-page-description"
      >
        Workspace-wide channels and scheduled intakes. For your
        personal notification and channel settings, go to
        <a
          href="/settings/communication"
          class="text-[var(--color-primary)] hover:underline"
          data-testid="channels-personal-prefs-link">Communication settings</a
        >.
      </p>
    </div>
    <!--
      Only the legacy notification "+ New channel" CTA renders here. The
      scheduled-trigger create flow requires a
      project_id and live on per-project pages.
    -->
    <a
      href="/channels/new"
      class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-primary-hover)] transition-colors text-sm"
      data-testid="channels-new-link"
    >
      + New channel
    </a>
  </header>

  {#if backendUnavailable}
    <div
      class="rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-sm text-[var(--color-warning-text)] p-4"
      data-testid="channels-backend-unavailable"
    >
      <p class="font-semibold">Channel list could not be read.</p>
      <p class="text-xs mt-1">
        The request for the channels registry came back not-found /
        not-allowed. The /api/channels routes are live, so this is a routing or
        connectivity failure rather than a missing feature — reload the page,
        and if it persists the API host is not reachable from this session.
      </p>
    </div>
  {/if}

  {#if loadError}
    <ErrorState
      error={loadError}
      title="Failed to load channels"
      onRetry={load}
    />
  {:else if loading}
    <Skeleton variant="text" count={5} height="2.5rem" />
  {:else if !backendUnavailable}
    <ChannelsList {rows} />
  {/if}
</section>
