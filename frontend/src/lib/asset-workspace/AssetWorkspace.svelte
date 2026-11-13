<!--
  AssetWorkspace.svelte

  Mode-switch shell: routes to AssetList / AssetDetail / AssetEditor based on
  the `mode` prop. Route files (`+page.svelte`) mount this with the relevant
  manifest and the mode pulled from the URL.

  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Task 6.1 Step 5.
-->
<script lang="ts" generics="T">
  import type { AssetManifest } from './manifest';
  import AssetList from './AssetList.svelte';
  import AssetDetail from './AssetDetail.svelte';
  import AssetEditor from './AssetEditor.svelte';

  let {
    manifest,
    mode,
    id,
    query,
  }: {
    manifest: AssetManifest<T>;
    mode: 'list' | 'detail' | 'new' | 'edit';
    id?: string;
    query?: Record<string, string>;
  } = $props();
</script>

{#if mode === 'list'}
  <AssetList {manifest} {query} />
{:else if mode === 'detail'}
  {#if id == null}
    <div class="px-6 py-4 text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]">
      AssetWorkspace: <code>id</code> required for mode="detail"
    </div>
  {:else}
    <AssetDetail {manifest} {id} />
  {/if}
{:else if mode === 'new'}
  <AssetEditor {manifest} />
{:else if mode === 'edit'}
  {#if id == null}
    <div class="px-6 py-4 text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]">
      AssetWorkspace: <code>id</code> required for mode="edit"
    </div>
  {:else}
    <AssetEditor {manifest} {id} />
  {/if}
{/if}
