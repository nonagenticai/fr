<!--
  /settings/notifications — renamed to /settings/communication (2026-10-30).
  Redirects so existing links don't 404. The +page.server.ts sibling does the same on SSR.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    void goto('/settings/communication', { replaceState: true });
  });
</script>

<section class="p-6 text-sm text-[var(--color-text-muted)]" data-testid="settings-notifications-redirect">
  <p>Redirecting to <a class="underline" href="/settings/communication">Communication settings</a>…</p>
</section>
