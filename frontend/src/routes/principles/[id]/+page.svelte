<!--
  /principles/[id] — detail view, driven by the principlesManifest +
  AssetWorkspace. Edit lives at /principles/[id]/edit.
  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Tasks 6.3–6.9.
-->
<script lang="ts">
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { principlesManifest } from '$lib/manifests/principles';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
</script>

<AssetWorkspace manifest={principlesManifest} mode="detail" {id} />

{#if id}
  <div class="px-6 pb-6">
    {#key id}<TraceLinksPanel kind="principle" itemId={id} />{/key}
  </div>
{/if}
