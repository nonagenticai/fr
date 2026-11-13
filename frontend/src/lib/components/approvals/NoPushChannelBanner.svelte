<!--
  NoPushChannelBanner — fr-agui P1-TEAM-b (George 2026-10-15).

  "all notifications/approvals/questions are sent to all members, each member can
  configure their notification channels." A member with NO enabled push channel
  (Telegram, email, Teams, voice) is told about every approval and question
  only when they open fr — this banner says so and links to where they fix it.

  ⛔ SILENT ON A FAILED READ. If `/api/me/channels` does not answer, nothing renders:
  "you have no push channel" is a claim about the member, and a read that never
  answered cannot support it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { listMyChannelPrefs } from '$lib/api/channel-prefs';
  import { hasEnabledPushChannel } from '$lib/approvals/pushChannels';

  let show = $state(false);

  onMount(async () => {
    try {
      const prefs = await listMyChannelPrefs();
      show = !hasEnabledPushChannel(prefs);
    } catch {
      show = false;
    }
  });
</script>

{#if show}
  <div
    class="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
    role="status"
    data-testid="no-push-channel-banner"
  >
    You have no push channel configured. Approvals and questions for this workspace go to
    every member, but you will only see them while fr is open.
    <a class="underline" href="/settings/communication">Set up Telegram, email or Teams</a>.
  </div>
{/if}
