<!--
  LicenseExpiringBanner — non-blocking top banner shown when the license is
  valid but expiring within the warning window. Dismissible for the session;
  the app stays fully usable. Rendered by the root +layout above the shell.
-->
<script lang="ts">
  import { licenseGate, navigateToRenew } from '$lib/stores/licenseGate.svelte';

  let dismissed = $state(false);

  const show = $derived(licenseGate.isExpiringSoon && !dismissed);

  const message = $derived(
    licenseGate.daysRemaining != null
      ? `Your license expires in ${licenseGate.daysRemaining} day${licenseGate.daysRemaining === 1 ? '' : 's'}.`
      : 'Your license is expiring soon.',
  );
</script>

{#if show}
  <div
    class="flex items-center justify-between gap-4 border-b border-[var(--color-warning-border,transparent)] bg-[var(--color-warning-bg)] px-4 py-2 text-sm text-[var(--color-warning-text)]"
    role="status"
  >
    <span>
      ⚠ {message} Renew to avoid interruption.
    </span>
    <span class="flex items-center gap-3">
      <button type="button" onclick={navigateToRenew} class="font-semibold underline hover:opacity-80">
        Renew
      </button>
      <button
        type="button"
        onclick={() => (dismissed = true)}
        class="opacity-70 hover:opacity-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </span>
  </div>
{/if}
