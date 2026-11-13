<!--
  What this workspace knows: one count per kind, each linking to its page. Each count
  is read with the SAME list adapter its page uses (so the number matches what the page
  shows, including shared platform entries), and loads/fails on its own.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Skeleton } from '$lib/components/ui';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { principlesManifest } from '$lib/manifests/principles';
  import { requirementsManifest } from '$lib/manifests/requirements';
  import { decisionsManifest } from '$lib/manifests/decisions';
  import { apiClient } from '$lib/api/unified-client';
  import HomeCard from './HomeCard.svelte';
  import { countText, failed, type Load } from './home';

  interface Kind {
    id: string;
    label: string;
    explain: string;
    href: string;
    read: () => Promise<{ n: number; capped: boolean }>;
  }

  const fromManifest =
    (list: (q?: Record<string, string>) => Promise<{ items: unknown[]; truncated?: boolean }>) =>
    async () => {
      const r = await list();
      return { n: r.items.length, capped: r.truncated === true };
    };

  const KINDS: Kind[] = [
    {
      id: 'principles',
      label: 'Principles',
      explain: 'Rules your work should follow',
      href: '/principles',
      read: fromManifest(principlesManifest.api.list),
    },
    {
      id: 'requirements',
      label: 'Requirements',
      explain: 'What has to be built or be true',
      href: '/requirements',
      read: fromManifest(requirementsManifest.api.list),
    },
    {
      id: 'decisions',
      label: 'Decisions',
      explain: 'Choices made, and why',
      href: '/decisions',
      read: fromManifest(decisionsManifest.api.list),
    },
    {
      id: 'documents',
      label: 'Documents',
      explain: 'Files added to your knowledge base',
      href: '/library/kag/documents',
      read: async () => {
        const r = await apiClient.documents.list();
        return { n: (r.items ?? []).length, capped: false };
      },
    },
  ];

  let counts = $state<Record<string, Load<{ n: number; capped: boolean }>>>({});

  // Re-read on mount and on every workspace switch.
  $effect(() => {
    void workspaces.scopeKey;
    let cancelled = false;
    // Only the workspace drives a re-read; nothing the loaders touch may re-trigger it.
    untrack(() => {
      counts = Object.fromEntries(KINDS.map((k) => [k.id, { kind: 'loading' }]));
      for (const k of KINDS) {
        k.read().then(
          (value) => {
            if (!cancelled) counts[k.id] = { kind: 'ready', value };
          },
          (err) => {
            if (!cancelled) counts[k.id] = failed(k.id, err);
          },
        );
      }
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<HomeCard
  title="Workspace knowledge"
  explain="What this workspace has written down. Projects use it to plan and check their work."
  testid="home-assets"
>
  <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
    {#each KINDS as k (k.id)}
      {@const c = counts[k.id] ?? { kind: 'loading' }}
      <li>
        <a
          href={k.href}
          class="block rounded-md border border-[var(--color-border)] p-3 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-strong)]"
          data-testid={`home-assets-${k.id}`}
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm font-medium text-[var(--color-text)]">{k.label}</span>
            {#if c.kind === 'loading'}
              <Skeleton variant="text" class="w-8" />
            {:else if c.kind === 'ready'}
              <span class="text-lg font-semibold text-[var(--color-text)]">{countText(c.value.n, c.value.capped)}</span>
            {/if}
          </div>
          <p class="text-xs text-[var(--color-text-muted)]">{k.explain}</p>
          {#if c.kind === 'error'}
            <p class="mt-1 text-xs text-[var(--color-danger)]">
              Couldn't load {k.label.toLowerCase()}.
            </p>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
</HomeCard>
