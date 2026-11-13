<!--
  /admin/assets/workflows — read-only list view for n8n workflows.

  Workflows are NOT editable from the fr asset console — n8n owns
  workflow editing. Each row carries an "Open in n8n" link out to the
  configured n8n UI (PUBLIC_N8N_UI_URL) so super-admins can jump to the
  editor in one click. No create / edit / delete affordances on the page.

  Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { listAdminWorkflows, type AdminWorkflow } from '$lib/api/admin-assets';

  let rows = $state<AdminWorkflow[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);

  // n8n UI URL — surfaced via env at build time. Default is the prod alias
  // recorded in MEMORY.md; override via VITE_N8N_UI_URL if you point at a
  // staging n8n.
  const N8N_UI = import.meta.env.VITE_N8N_UI_URL ?? 'https://n8n.nonagentic.ai';

  // ⚠️ WHY A TIMEOUT, WHEN `refresh()` ALREADY HAD try/catch/finally.
  //
  // A live production sweep captured this route showing nothing but "Loading…"
  // after reaching a stable painted state. The `finally { loading = false }`
  // below looks like it makes that impossible — and it does not. A `finally`
  // runs when the awaited promise SETTLES; it does nothing at all for a promise
  // that stays pending forever.
  //
  // And the wait here is effectively unbounded from the browser's side.
  // `authFetch` (lib/api/auth-fetch.ts:62) calls `fetch()` with no
  // `AbortSignal` and no timeout, and `Bun.serve` runs with `idleTimeout: 0`
  // (backend/src/server.ts:2771), so nothing between this page and n8n caps the
  // connection.
  //
  // ⚠️ MEASURED, and NOT the reason I first wrote here. My first guess was
  // "workflows proxies to an upstream, the siblings are served from fr's own
  // Postgres". That is FALSE: principles, requirements and decisions all proxy
  // to an upstream too, and only `projects` is Postgres-backed. "Talks to an
  // upstream" is not the differentiator.
  //
  // The real one is that this route awaits a MULTI-REQUEST CRAWL on the user
  // request path. `listWorkflows` (backend/src/integrations/n8n.ts:247-291)
  // walks n8n's cursor 20 workflows at a time, each page budgeted 15 s × 2
  // attempts ≈ 30 s (n8n.ts:70), and the ONLY ceiling is 625 pages
  // (n8n.ts:230-231) — a worst case measured in HOURS. That integration's own
  // docblock (n8n.ts:245-246) says outright: "never run it on a user request",
  // and the customer-facing `/api/workflows` obeys it by serving from the
  // background cache (backend/src/routes/workflows.ts:19-45). The admin handler
  // (backend/src/routes/admin/assets/workflows.ts:90-114) awaits the live crawl
  // instead. `limit: 250` below = 13 pages ≈ 36–166 s even when n8n is HEALTHY,
  // which alone exceeds any reasonable paint gate.
  //
  // ⚠️ The real repair is to put this route behind the same background cache —
  // that is a backend change and is NOT in this lane's scope. Filed as a
  // follow-up. Bounding the spinner here does not make the route fast; it only
  // stops it lying about what it is doing.
  //
  // We cannot fix n8n from here, and `$lib/api/admin-assets.ts` takes no
  // signal — so the server-side crawl keeps running after we stop waiting.
  // What this page CAN guarantee is that it never renders a spinner that
  // outlives its own request: bound the wait, then say so.
  //
  // ⚠️ The bound must sit ABOVE the HEALTHY path or it manufactures a defect.
  // Measured healthy cost of `limit: 250` is ~36–166 s (13 pages), so a short
  // bound would report a working n8n as an error — worse than a slow page.
  // 180 s clears the healthy ceiling; past that the crawl is pathological and
  // erroring is the honest answer.
  const LOAD_TIMEOUT_MS = 180_000;

  // `/api/me/workspaces` is a cheap fr-local lookup, not an upstream proxy, so
  // it gets a much tighter bound. It only decorates the header; the list below
  // is the point of the page and must not wait 180 s on it.
  const WORKSPACES_TIMEOUT_MS = 15_000;

  // ⚠️ THE CAP IS NOW A NAMED CONSTANT BECAUSE THE PAGE HAS TO COMPARE AGAINST IT.
  //
  // `listAdminWorkflows({ limit: 250 })` was called with the literal inline and
  // `rows.length` was never checked against it, so a list cut off at 250 painted
  // exactly the same pixels as a complete one — no banner, no count, nothing.
  // On an admin console whose entire job is "what workflows exist", silently
  // showing a prefix is the defect.
  //
  // ⛔ There is NO honest "N of M" available here. `GET /api/admin/assets/workflows`
  // returns `{ workflows }` and nothing else (backend/src/routes/admin/assets/
  // workflows.ts:112) — no total, no cursor, no `has_more` — because the
  // integration below it walks n8n's cursor and stops at the requested limit.
  // So the only claim this page can make is the one a full page licenses:
  // "the source returned a full page, which is indistinguishable from more
  // existing". That is also why the banner says "at least", not "exactly".
  //
  // ⚠️ A full page is NOT proof of truncation. A tenant with exactly 250
  // workflows trips this too, and the wording must survive that case — saying
  // "some are hidden" would then be its own false claim. Naming only what is
  // certain is the point, the same rule `asset-list-truncated` states.
  const WORKFLOW_LIMIT = 250;

  // True when the response filled the page. See above for why this is the
  // strongest statement available, not a measurement of truncation.
  const pageFull = $derived(rows.length >= WORKFLOW_LIMIT);

  function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `${what} did not respond within ${Math.round(ms / 1000)}s.`,
            ),
          ),
        ms,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  function messageOf(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return 'Unknown error';
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      rows = await withTimeout(
        listAdminWorkflows({ limit: WORKFLOW_LIMIT }),
        LOAD_TIMEOUT_MS,
        'n8n',
      );
    } catch (e) {
      error = messageOf(e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    // ⚠️ `refresh()` must not be reachable ONLY through this await. If
    // `/api/me/workspaces` hangs, `workspaces.load()` hangs with it (it awaits
    // the same unbounded `authFetch`), and the list below would never even be
    // requested — same stuck "Loading…", one call earlier. Bound it and fall
    // through regardless; the workspace name in the header degrades to "—",
    // which is honest, and `authFetch` still scopes the request from the
    // persisted `fr.active_tenant` in localStorage.
    if (!workspaces.loaded) {
      try {
        await withTimeout(workspaces.load(), WORKSPACES_TIMEOUT_MS, 'Workspaces');
      } catch {
        /* fall through to refresh() — the list is the point of this page */
      }
    }
    await refresh();
  });

  let lastActiveId = $state<string | undefined>(undefined);
  $effect(() => {
    const cur = workspaces.activeId;
    if (cur && cur !== lastActiveId) {
      lastActiveId = cur;
      void refresh();
    }
  });

  function pickField(w: AdminWorkflow, ...keys: string[]): string {
    for (const k of keys) {
      const v = w[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }
  function rowKey(w: AdminWorkflow): string {
    return pickField(w, 'id');
  }
  function isActive(w: AdminWorkflow): boolean {
    return w.active === true;
  }
  function workflowTags(w: AdminWorkflow): string {
    const t = w.tags;
    if (!Array.isArray(t)) return '';
    return t
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && 'name' in x && typeof x.name === 'string') return x.name;
        return '';
      })
      .filter(Boolean)
      .join(', ');
  }
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4 flex items-start justify-between gap-4">
    <div>
      <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
        <span>Administration</span>
        <span class="mx-1">/</span>
        <span>Platform workflows</span>
      </nav>
      <h1 class="mt-1 text-2xl font-semibold text-[var(--color-text)]">Platform workflows</h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Active workspace:
        <span class="font-medium text-[var(--color-text)]">{workspaces.active?.name ?? '—'}</span>
        <span
          class="ml-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--color-text-muted)]"
          >{workspaces.active?.kind ?? '—'}</span
        >
        <span class="ml-2 text-xs italic">Read-only — edit in n8n.</span>
      </p>
    </div>
    <button
      type="button"
      onclick={() => void refresh()}
      class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
    >
      Refresh
    </button>
  </header>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]" role="status" data-testid="workflows-loading">
      Loading…
      <span class="block text-xs">
        fr is crawling the n8n workflow catalogue 20 at a time; this can take a
        minute or two.
      </span>
    </p>
  {:else if error}
    <p class="text-sm text-[var(--color-danger)]" role="alert" data-testid="workflows-error">
      Error: {error}
      <button type="button" class="ml-2 underline" onclick={() => void refresh()}>Retry</button>
    </p>
  {:else if rows.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="workflows-empty">
      No workflows visible to this tenant.
    </p>
  {:else}
    <!--
      The count is always shown, not only when capped: a bare table states no
      size at all, so "250 rows" and "250 rows and that is all of them" look the
      same until someone counts by hand.
    -->
    <p class="mb-2 text-xs text-[var(--color-text-muted)]" data-testid="workflows-count">
      {rows.length} workflow{rows.length === 1 ? '' : 's'}{pageFull ? ' — at least' : ''} shown
    </p>
    {#if pageFull}
      <div
        class="mb-3 rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
        data-testid="workflows-truncated"
        title={`fr requested ${WORKFLOW_LIMIT} workflows and n8n returned ${WORKFLOW_LIMIT}. The endpoint reports no total and no cursor, so whether more exist cannot be read from this response.`}
      >
        This list is capped at {WORKFLOW_LIMIT}, and the source returned a full
        page — so it may be a prefix of the catalogue rather than all of it. Open
        n8n to see the complete list.
      </div>
    {/if}
    <table class="w-full table-auto border-collapse text-sm">
      <thead>
        <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <th class="py-2 pr-4">Scope</th>
          <th class="py-2 pr-4">Name</th>
          <th class="py-2 pr-4">Active</th>
          <th class="py-2 pr-4">Tags</th>
          <th class="py-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as w (rowKey(w))}
          <tr class="border-b border-[var(--color-border)] align-top">
            <td class="py-2 pr-4">
              {#if w.is_system}
                <span
                  class="rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
                  >SYSTEM</span
                >
              {:else}
                <span class="text-xs text-[var(--color-text-muted)]">local</span>
              {/if}
            </td>
            <td class="py-2 pr-4 font-medium text-[var(--color-text)]">
              {pickField(w, 'name')}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">
              {isActive(w) ? 'yes' : 'no'}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">{workflowTags(w)}</td>
            <td class="py-2 pr-4">
              <a
                href={`${N8N_UI}/workflow/${encodeURIComponent(pickField(w, 'id'))}`}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-[var(--color-accent)] hover:underline"
              >
                Open in n8n ↗
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
