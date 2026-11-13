<!--
  /secrets/[secret_id] — detail view, manifest-driven AssetWorkspace shell.

  No edit route exists for secrets — the backend exposes only list/get/create
  (see backend/src/routes/assets/secrets.ts). The detail view's Edit button
  is suppressed automatically because `manifest.api.update` is undefined.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { secretsManifest } from '$lib/manifests/secrets';

  const id = $derived(decodeURIComponent($page.params.secret_id ?? ''));
</script>

<AssetWorkspace manifest={secretsManifest} mode="detail" {id} />
