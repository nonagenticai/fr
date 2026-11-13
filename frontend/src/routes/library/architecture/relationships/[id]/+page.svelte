<!--
  library/architecture/relationships/[id] — read-only asset detail (control-plane roadmap Phase 4).
  Manifest-driven AssetWorkspace; the back-link returns to the
  /library/architecture/relationships list route.
-->
<script lang="ts">
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureRelationshipsManifest } from '$lib/manifests/architecture/relationships';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
</script>

<AssetWorkspace manifest={architectureRelationshipsManifest} mode="detail" {id} />

{#if id}
  <div class="mt-4">{#key id}<TraceLinksPanel kind="relationship" itemId={id} />{/key}</div>
{/if}
