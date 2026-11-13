<!--
  LicenseBlocked — full-screen hard block shown when the workspace has no usable
  license (expired / revoked / none, or a live 403 fr_license_required). Only
  two actions: Renew (→ LICENSE_RENEW_URL) and Log out. Rendered by the root
  +layout in place of the app shell, so no licensed surface is reachable.
-->
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { licenseGate, navigateToRenew } from '$lib/stores/licenseGate.svelte';
  import { supportEmail } from '$lib/contact';

  const contact = supportEmail();

  const heading = $derived(
    licenseGate.state === 'revoked'
      ? 'License revoked'
      : licenseGate.state === 'none'
        ? 'No active license'
        : 'License expired',
  );
</script>

<div
  class="flex min-h-screen items-center justify-center bg-[var(--color-surface)] p-6 dark:bg-[var(--color-bg)]"
>
  <div
    class="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-8 text-center shadow-lg dark:bg-[var(--color-surface)]"
  >
    <div
      class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-danger-bg)]"
      aria-hidden="true"
    >
      <svg class="h-6 w-6 text-[var(--color-danger-text)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      </svg>
    </div>

    <h1 class="mb-2 text-2xl font-semibold text-[var(--color-text)]">{heading}</h1>
    <p class="mb-6 text-[var(--color-text-muted)]">
      {licenseGate.statusMessage}
      Renew to restore access for your workspace.
    </p>

    <div class="flex flex-col gap-3">
      <button
        type="button"
        onclick={navigateToRenew}
        class="w-full rounded-md bg-[var(--color-accent)] px-4 py-2.5 font-semibold text-[var(--color-on-primary)] transition-colors hover:bg-[var(--color-accent-strong)]"
      >
        Renew license
      </button>
      <button
        type="button"
        onclick={() => auth.logout()}
        class="w-full rounded-md border border-[var(--color-border)] px-4 py-2.5 font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)]"
      >
        Log out
      </button>
    </div>

    <p class="mt-6 text-xs text-[var(--color-text-muted)]">
      Need help? Contact
      <a class="text-[var(--color-accent)] underline" href={`mailto:${contact}`} data-testid="license-support-email">{contact}</a>.
    </p>
  </div>
</div>
