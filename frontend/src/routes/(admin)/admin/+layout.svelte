<script lang="ts">
  // Admin shell: a content column only. There is NO second sidebar here.
  //
  // Admin used to render its own `AdminSidebar` INSIDE the app, so an admin
  // page showed two rails at once — the main one and a nested one. Navigation
  // now lives in the main sidebar as two top-level zones, `workspace` and
  // `administration` (lib/layout/navConfig.ts), which is where someone looks
  // for it and which keeps one consistent rail across the whole product.
  //
  // The page title for this area used to be derived here from ADMIN_NAV_ITEMS.
  // It now comes from the single title element in the root +layout.svelte,
  // by $lib/layout/pageTitle — the same nav-table lookup, applied to every
  // route rather than just this subtree.
  let { children } = $props();
</script>

<div class="flex h-full min-h-0 w-full" data-testid="admin-shell">
  <main class="min-w-0 flex-1 overflow-y-auto px-6 py-6">
    {@render children()}
  </main>
</div>
