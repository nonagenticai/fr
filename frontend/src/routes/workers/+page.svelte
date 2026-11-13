<!-- src/routes/workers/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import { goto } from '$app/navigation';
  import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';

  let workers = $state<string[]>([]);
  let error = $state<unknown>(null);
  let loading = $state(true);

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await authFetch('/api/assets/workers');
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      // fr backend wraps every list endpoint in `{data: …}` (see
      // backend/src/routes/assets/workers.ts:33 `jsonResponse({ data })`).
      // worker_management upstream itself returns `string[]`. Accept both
      // the wrapped envelope and the legacy `{workers: […]}` shape. Use
      // `unknown` + structural runtime checks so svelte-check doesn't fall
      // over the three-way discriminated union when narrowing `inner`.
      const body: unknown = await res.json();
      const inner: unknown =
        body && typeof body === 'object' && !Array.isArray(body) && 'data' in body
          ? ((body as { data?: unknown }).data ?? [])
          : body;
      const rawList: unknown[] = Array.isArray(inner)
        ? inner
        : inner &&
            typeof inner === 'object' &&
            Array.isArray((inner as { workers?: unknown }).workers)
          ? (inner as { workers: unknown[] }).workers
          : [];
      // Upstream `/api/assets/workers` has been observed to emit the literal
      // strings `"undefined"` and `"null"` alongside real worker names
      // (verified 2026-05-13: response was `{"data":["schema_test","undefined"]}`).
      // Reject those alongside non-strings/empty so we never render
      // `/workers/undefined` links.
      workers = rawList.filter(
        (w): w is string =>
          typeof w === 'string' &&
          w.length > 0 &&
          w !== 'undefined' &&
          w !== 'null'
      );
    } catch (err) {
      error = err;
      workers = [];
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<div class="px-6 py-4">
  <div class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-semibold">Workers</h1>
    <a
      href="/workers/new"
      class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-primary-hover)]"
    >
      + New worker
    </a>
  </div>

  {#if loading}
    <Skeleton variant="text" count={6} height="1.5rem" />
  {:else if error}
    <ErrorState {error} title="Couldn't load workers" onRetry={load} />
  {:else if workers.length === 0}
    <EmptyState
      title="No workers yet"
      body="Workers process improvement cards, run analyses, and write back results. Create one to get started."
      actionLabel="+ New worker"
      onAction={() => goto('/workers/new')}
    />
  {:else}
    <ul class="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded">
      {#each workers as name (name)}
        <li class="px-4 py-2 hover:bg-[var(--color-surface)]">
          <a href="/workers/{encodeURIComponent(name)}" class="font-mono text-sm">{name}</a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
