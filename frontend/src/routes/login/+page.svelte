<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import BrandMark from '$lib/components/ui/BrandMark.svelte';
  // The `next` guard lives in $lib/utils so it is testable: inline here it was a
  // non-exported function, and its two off-origin branches are a security
  // control with no regression guard. See utils/safeNext.test.ts.
  import { safeNext } from '$lib/utils/safeNext';

  let error = $state<string | null>(null);

  onMount(async () => {
    // Wait for auth initialization to complete
    // (the layout is calling auth.initialize() asynchronously)
    const checkAuth = async () => {
      // A logout is in flight: the end-session redirect is a pending top-level
      // navigation. Calling auth.login() here would supersede it, leave the SSO
      // cookie intact, and silently re-authenticate the user we just logged
      // out. Stop polling entirely — this document is about to be replaced.
      if (auth.isLoggingOut) return;

      if (auth.isLoading) {
        // Still initializing, check again in 100ms
        setTimeout(checkAuth, 100);
        return;
      }

      if (auth.isAuthenticated) {
        // Already authenticated — go where they were HEADED, not to a fixed
        // landing page. Guards send people here as `/login?next=<path>`; this
        // used to hardcode `/dashboard` and throw `next` away, so every deep
        // link in the product — bookmark, refresh, pasted URL — silently
        // resolved to the dashboard. License enforcement (block / expiring
        // banner) is handled globally by the root +layout's licenseGate, so no
        // license-based redirect is needed here.
        //
        // Only same-origin RELATIVE paths are honoured: `next` arrives from the
        // query string, so an attacker-supplied `//evil.example` or
        // `https://evil.example` would otherwise turn this into an open
        // redirect. Anything that is not a single-slash-prefixed path falls
        // back to `/` (the home dashboard). The old `/dashboard` route was a
        // thinner duplicate of `/` and has been deleted.
        goto(safeNext(new URLSearchParams(location.search).get('next')));
      } else {
        // Not authenticated, redirect to Keycloak login
        console.log('Not authenticated, redirecting to Keycloak');
        auth.login().catch((err) => {
          console.error('Login failed:', err);
          error = 'Failed to login. Please try again.';
        });
      }
    };

    checkAuth();
  });
</script>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
  <div class="max-w-md w-full space-y-8 p-8">
    <div class="text-center">
      <div class="mb-3 flex justify-center">
        <BrandMark size={44} />
      </div>
      <h1 class="text-3xl font-semibold text-[var(--color-text)] mb-1" style="font-family: var(--font-display)">
        Non-Agentic AI
      </h1>
      <h2 class="text-base font-medium text-[var(--color-text-muted)] mb-4">
        The Control Plane
      </h2>

      {#if auth.isLoading || !error}
        <div class="flex flex-col items-center space-y-4 py-8">
          <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--color-accent)]"></div>
          <p class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
            {#if auth.isLoading}
              Checking authentication...
            {:else}
              Redirecting to login...
            {/if}
          </p>
        </div>
      {/if}

      {#if error}
        <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 mb-4 dark:bg-[var(--color-danger-bg)]/20">
          <p class="text-[var(--color-danger-text)] text-sm dark:text-[var(--color-danger-text)]">{error}</p>
        </div>
        <button
          onclick={() => auth.login()}
          class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-[var(--color-on-primary)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-strong)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)]"
        >
          Try Again
        </button>
      {/if}
    </div>
  </div>
</div>
