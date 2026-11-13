<!--
  /admin/departments/[id]/knowledge — department-scoped effective view.

  Mirrors the project knowledge tab pattern but scoped to a department: sets the
  Library scopeContext to `{ kind: 'department', dept_id }` and renders the
  scope-affordance components (ScopeFilter + InheritanceBreadcrumb). The actual
  asset listing is still unbuilt — it belongs to the FE-pages lane that owns
  /library.

  ⚠️ CORRECTED — this said the page surfaces "a deep-link to /library?dept_id=…
  so admins can drill in once those pages exist". That link existed and was
  DEAD: /library is a static index of asset-type cards and reads no query
  string, so `dept_id` and `filter` were both ignored and the link opened the
  workspace-wide Library while promising a department-scoped view. The link now
  says what it is. See the placeholder below for why honouring `dept_id` would
  have meant building the missing feature, not fixing a link.

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 16.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { getDepartment, type Department } from '$lib/api/tenancy';
  import { scopeContext } from '$lib/stores/scopeContext.svelte';
  import { ScopeFilter, InheritanceBreadcrumb } from '$lib/components/library';
  import { toast } from '$lib/stores/toast.svelte';

  // SvelteKit's params type is `Record<string, string | undefined>`; the
  // route file lives under [id] so the param is always present at runtime.
  let deptId = $derived(page.params.id as string);

  let dept = $state<Department | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  type FilterKind = 'all_inherited' | 'defined_here' | 'overrides' | 'blocked';
  let filter = $state<FilterKind>('all_inherited');

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      dept = await getDepartment(deptId);
      // Push the scope into the global store so any embedded scope-aware
      // component picks up the right kind.
      scopeContext.set({ kind: 'department', dept_id: deptId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadError = msg;
      toast.error(`Failed to load department: ${msg}`);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(page.url.pathname, dept?.name ?? null);
  });
</script>

<section class="p-6 space-y-6 max-w-4xl" data-testid="department-knowledge-page">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <div class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3">
      {loadError}
    </div>
  {:else if dept}
    <header class="flex items-baseline justify-between">
      <div>
        <h1 class="text-2xl font-semibold">{dept.name} · knowledge</h1>
        <p class="text-sm text-[var(--color-text-muted)]">
          Effective assets visible to this department, with inheritance from
          workspace.
        </p>
      </div>
      <a
        href={`/admin/departments/${dept.id}`}
        class="text-sm text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
      >
        ← Back to department
      </a>
    </header>

    <!-- Wired to a placeholder since we don't load asset stats here yet; the
         full breadcrumb populates once Wave-2 Library deep-link returns counts. -->
    <InheritanceBreadcrumb defined_at="department" />

    <ScopeFilter selected={filter} onChange={(v) => (filter = v)} />

    <div
      class="rounded border border-dashed p-8 text-sm text-[var(--color-text-muted)]"
      data-testid="department-knowledge-placeholder"
    >
      <!--
        ⚠️ CORRECTED — this offered `/library?dept_id=<id>&filter=<f>` as a
        "deep link to inspect the effective view". BOTH params are dead:
        `/library/+page.svelte` is a static index of asset-type cards that reads
        no query string at all (grep over routes/library for `dept_id` returns
        zero), and the `filter` value is local to the ScopeFilter above. The
        link therefore opened the plain, workspace-wide Library while promising
        a department-scoped one.

        ⛔ Not fixed by making `/library` honour `dept_id`: that IS the
        department-scoped asset listing this placeholder says has not been
        built, so "add the param" would mean building the feature, and a param
        that filtered nothing would be the same lie one layer down. The smaller
        correct change is to stop claiming the scope and say what the link
        actually does.

        `scopeContext` IS set to `{ kind: 'department', dept_id }` on load, and
        components that read it honour it — but `/library`'s index does not read
        it either, so it changes nothing about where this link lands.

        2026-10-03: `/library` is now a 308 to `/principles` (nav standard — no
        launcher pages), so the link targets `/principles` directly.
      -->
      <p class="mb-2">
        Asset list rendering for the department scope has not been built yet, so
        there is nothing department-scoped to open. The filter above changes what
        this page WOULD show; it does not travel with the link below.
      </p>
      <a
        href="/principles"
        class="text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
        data-testid="department-knowledge-library-link"
      >
        Open the Library (workspace-wide, not filtered to {dept.name}) →
      </a>
    </div>
  {/if}
</section>
