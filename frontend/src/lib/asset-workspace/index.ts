// asset-workspace barrel
//
// Public API of the resource-manifest-driven workspace. Route files import
// from here; per-asset manifests live under `lib/manifests/`.

export { default as AssetWorkspace } from './AssetWorkspace.svelte';
export { default as AssetList } from './AssetList.svelte';
export { default as AssetDetail } from './AssetDetail.svelte';
export { default as AssetEditor } from './AssetEditor.svelte';
export type { AssetManifest, FieldDef, ColumnDef } from './manifest';
