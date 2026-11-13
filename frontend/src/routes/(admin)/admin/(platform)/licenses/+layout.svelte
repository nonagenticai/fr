<!--
  /admin/licenses — licensing console shell.

  Owns ONE thing for every page in this section:

  1. THE SUPER-ADMIN GATE, done once here rather than copied into each page.
     The parent `/admin` layout gates on workspace-admin OR
     super-admin, which is deliberately wider than this section: these pages
     reach the licenses service as fr's `license-admin` service account, so a
     workspace-admin must not get in. Server-side is the real gate (every route
     403s); this is the visual half.

     Two constraints the provision page learned the hard way, kept here:
       * Probe only AFTER `auth.isLoading === false` — keycloak-js has no token
         before that, so the probe 401s and locks out genuine super-admins.
       * Render a local 404 panel; do NOT `throw kitError(404)` from a runtime
         `$effect` (it bubbles as an unhandled exception and redirects away),
         and do NOT gate in `load()` (it races `auth.initialize()`).

  It used to own a second: a Grants / Catalog / Offerings tab strip — a menu
  inside the page. Nav standard (2026-10-03): Catalog and Offerings are their
  own Administration rows in the sidebar (navConfig `admin-licence-catalog`,
  `admin-licence-offerings`), so the strip is gone.
-->
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { getSuperAdminStatus } from '$lib/api/super-admin';

  let { children } = $props();

  type GateState = 'pending' | 'allowed' | 'denied';
  let gate = $state<GateState>('pending');
  let probeStarted = false;

  $effect(() => {
    if (probeStarted) return;
    if (auth.isLoading) return;
    probeStarted = true;
    void (async () => {
      try {
        const { is_super_admin } = await getSuperAdminStatus();
        gate = is_super_admin ? 'allowed' : 'denied';
      } catch {
        // Fail closed: an unreachable probe is not permission.
        gate = 'denied';
      }
    })();
  });
</script>

{#if gate === 'pending'}
  <section class="p-6">
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  </section>
{:else if gate === 'denied'}
  <section class="p-6" data-testid="licenses-admin-not-found">
    <h1 class="text-3xl font-semibold">404</h1>
    <p class="text-sm text-[var(--color-text-muted)]">Not found</p>
  </section>
{:else}
  <section class="p-6 space-y-6" data-testid="licenses-admin-shell">
    {@render children?.()}
  </section>
{/if}
