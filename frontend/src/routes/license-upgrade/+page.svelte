<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { licenseGate } from '$lib/stores/licenseGate.svelte';
  import { supportEmail } from '$lib/contact';

  const contact = supportEmail();

  // In-app renewal landing. This is the DEFAULT VITE_LICENSE_RENEW_URL target;
  // when the customer portal e-commerce ships, point VITE_LICENSE_RENEW_URL at
  // it and this page is bypassed. There is no self-serve purchase yet, so the
  // primary action is to contact sales — shown honestly (no fictional tiers).
  onMount(() => {
    if (auth.isAuthenticated) void licenseGate.load();
  });

  const blocked = $derived(licenseGate.isBlocked);

  const heading = $derived(
    licenseGate.state === 'revoked'
      ? 'License revoked'
      : licenseGate.state === 'expired'
        ? 'License expired'
        : licenseGate.state === 'none'
          ? 'No active license'
          : licenseGate.state === 'expiring_soon'
            ? 'License expiring soon'
            : 'License',
  );

  // ⚠️ The card below used to render ONE sentence unconditionally — "To
  // restore access for your workspace…" — while the paragraph above it
  // renders `licenseGate.statusMessage`. On an entitled workspace the page
  // therefore asserted BOTH "Your license is active." and that access had to
  // be restored. `restore` is only true for a blocked gate; the copy now
  // follows the state the gate actually measured. Nothing new is fetched —
  // this is the same `licenseGate.state` the heading already branches on.
  const contactCopy = $derived(
    blocked
      ? "To restore access for your workspace, contact our team and we'll get you set up."
      : licenseGate.state === 'expiring_soon'
        ? "To renew your license before it expires, contact our team and we'll get you set up."
        : licenseGate.state === 'unknown'
          ? "We couldn't confirm your license status just now. If access is blocked, contact our team and we'll sort it out."
          : 'Your license is active — there is nothing to restore or renew right now. Contact our team if you need to change it.',
  );
</script>

<div class="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 py-12">
  <div class="w-full max-w-lg text-center">
    <h1 class="mb-3 text-3xl font-bold text-[var(--color-text)]">{heading}</h1>

    <p class="mb-2 text-[var(--color-text-muted)]">{licenseGate.statusMessage}</p>

    {#if licenseGate.expiresAt}
      <p class="mb-1 text-sm text-[var(--color-text-muted)]">
        Expiry date: <span class="font-medium text-[var(--color-text)]"
          >{new Date(licenseGate.expiresAt).toLocaleDateString()}</span
        >
      </p>
    {/if}
    {#if licenseGate.planCode}
      <p class="mb-6 text-sm text-[var(--color-text-muted)]">
        Plan: <span class="font-medium text-[var(--color-text)]">{licenseGate.planCode}</span>
      </p>
    {/if}

    <div
      class="mb-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-left"
    >
      <p class="text-[var(--color-text)]" data-testid="license-contact-copy">
        {contactCopy}
      </p>
      <a
        href={`mailto:${contact}?subject=License%20renewal`}
        data-testid="license-contact-email"
        class="mt-4 inline-block rounded-md bg-[var(--color-accent)] px-5 py-2.5 font-semibold text-[var(--color-on-primary)] transition-colors hover:bg-[var(--color-accent-strong)]"
      >
        Contact {contact}
      </a>
    </div>

    <div class="flex items-center justify-center gap-4 text-sm">
      {#if blocked}
        <button
          type="button"
          onclick={() => auth.logout()}
          class="font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Log out
        </button>
      {:else}
        <button
          type="button"
          onclick={() => goto('/')}
          class="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-strong)]"
        >
          Return to dashboard
        </button>
      {/if}
    </div>
  </div>
</div>
