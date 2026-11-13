<!--
  /settings/channels — legacy user-prefs URL.

  Plan 2 Task 17 split the old "channels" surface into:
    - /channels              → workspace / dept channel registry
    - /settings/communication → Communication settings (notification routing + channel commands)

  This page used to host the user-prefs UI. It now redirects to
  /settings/communication so existing links (sidebar, deep-links, bookmarks)
  don't 404. The +page.server.ts sibling does the same on SSR.

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 17.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    void goto('/settings/communication', { replaceState: true });
  });
</script>

<section class="p-6 text-sm text-[var(--color-text-muted)]" data-testid="settings-channels-redirect">
  <p>Redirecting to <a class="underline" href="/settings/communication">Communication settings</a>…</p>
</section>
