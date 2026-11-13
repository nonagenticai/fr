<!--
  KagShell — the chrome-free shell for the KAG product (kag.nonagentic.ai).

  Used by routes/+layout.svelte INSTEAD of ShellLayout when the product mode is
  'kag' (host-resolved). A thin top bar (brand + license badge + user + sign-out)
  over the KAG pages, with a left list of the KAG routes (the former /library/kag
  tabs) — no fr sidebar / CmdK / agent rail. The backend
  enforces the `kag` license via the `X-App-Key: kag` header; this also probes
  `/api/license/status` so an org with no kag license sees a graceful screen
  instead of KAG pages whose data calls would 403 anyway.

  Ported from the kag-frontend fork's +layout.svelte (now retired onto this image).
-->
<script lang="ts">
  import favicon from '$lib/assets/favicon.svg';
  import { page } from '$app/state';
  import { auth } from '$lib/stores/auth.svelte';
  import { licenseGate } from '$lib/stores/licenseGate.svelte';
  import { NAV_ITEMS, navHrefMatches } from './navConfig';

  // THE KAG PRODUCT'S RAIL. kag.nonagentic.ai has no fr sidebar, and its pages
  // used to be tabs inside /library/kag. Nav standard (owner ruling
  // 2026-10-03): those tabs are routes now, so this shell lists them — read
  // from the SAME registry rows fr's sidebar renders under its "KAG" sub-group
  // (NAV_ITEMS `group: 'kag'`), plus Research, the other KAG-product surface
  // (isKagAllowedPath). Derived, so a KAG row added to fr appears here too.
  const kagRows = [
    ...NAV_ITEMS.filter((i) => i.group === 'kag'),
    ...NAV_ITEMS.filter((i) => i.id === 'research'),
  ];
  const currentPath = $derived(page.url.pathname);

  let { children } = $props();

  // KAG has no fr sidebar, so its settings links live in this top bar. They
  // used to exist only as tabs inside /settings — which nothing in this shell
  // linked to, so a KAG user could reach them by typed URL alone. Same three
  // pages and the same gate the old in-page menu used for this product.
  const canManageProvider = $derived(
    auth.hasTenantRole('workspace-admin') || auth.isSuperAdmin,
  );
  const settingsLinks = $derived([
    { label: 'Account', href: '/settings/account' },
    { label: 'Licenses & tokens', href: '/settings/licenses' },
    ...(canManageProvider ? [{ label: 'LLM provider', href: '/settings/llm-provider' }] : []),
  ]);

  // The authoritative license gate (loaded by the root +layout, app-scoped to
  // `kag` here) drives the badge. Hard-blocking for expired/revoked/none is
  // handled GLOBALLY by the root +layout's <LicenseBlocked> branch (which
  // renders in place of this shell), so KagShell no longer probes/blocks itself.
</script>

<div class="flex flex-col h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
  <header
    class="flex items-center justify-between gap-4 border-b border-[var(--color-border)] px-6 py-3"
  >
    <a href="/library/kag/documents" class="flex items-center gap-2 transition hover:opacity-80">
      <img src={favicon} alt="" class="h-6 w-6" />
      <span class="text-lg font-semibold">KAG Knowledge &amp; Research</span>
    </a>
    <div class="flex items-center gap-4 text-sm">
      <nav aria-label="Account" class="flex items-center gap-3">
        {#each settingsLinks as link (link.href)}
          <a
            href={link.href}
            class="text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
            data-testid="kag-settings-link">{link.label}</a
          >
        {/each}
      </nav>
      {#if licenseGate.status}
        <span
          class="rounded-full px-2.5 py-0.5 text-xs font-medium"
          class:bg-[var(--color-success-bg)]={licenseGate.isValid}
          class:text-[var(--color-success-text)]={licenseGate.isValid}
          class:bg-[var(--color-warning-bg)]={!licenseGate.isValid}
          class:text-[var(--color-warning-text)]={!licenseGate.isValid}
          title={`License: ${licenseGate.isValid ? 'valid' : 'invalid'}${
            licenseGate.isExpiringSoon
              ? ` · ${licenseGate.daysRemaining}d left`
              : ''
          }`}
        >
          {licenseGate.isValid ? 'Licensed' : 'License invalid'}
          {#if licenseGate.isExpiringSoon}· {licenseGate.daysRemaining}d left{/if}
        </span>
      {/if}
      {#if auth.user}
        <span class="text-[var(--color-text-muted)]">{auth.user?.email ?? ''}</span>
      {/if}
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface)]"
        onclick={() => auth.logout()}
      >
        Sign out
      </button>
    </div>
  </header>
  <div class="flex min-h-0 flex-1">
    <nav
      aria-label="KAG"
      class="w-52 shrink-0 overflow-y-auto border-r border-[var(--color-border)] px-2 py-4"
      data-testid="kag-shell-nav"
    >
      {#each kagRows as row (row.id)}
        <a
          href={row.href}
          aria-current={navHrefMatches(row.href, currentPath) ? 'page' : undefined}
          class={`block truncate rounded-[var(--radius-md)] px-3 py-1.5 text-sm transition ${
            navHrefMatches(row.href, currentPath)
              ? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
          }`}
          title={row.label}>{row.label}</a
        >
      {/each}
    </nav>
    <main class="flex-1 overflow-y-auto p-6">
      {@render children()}
    </main>
  </div>
</div>
