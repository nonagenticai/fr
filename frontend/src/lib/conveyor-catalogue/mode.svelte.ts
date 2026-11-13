// The caller's catalogue mode, read from the same stores every admin-gated
// library control reads. Call inside `$derived` so it follows the role load.
import { auth } from '$lib/stores/auth.svelte';
import { workspaces } from '$lib/stores/workspaces.svelte';
import { workspaceAdminCapability } from '$lib/rbac/assetScopeCapability';
import { catalogueMode, type CatalogueMode } from './state';

export function currentCatalogueMode(): CatalogueMode {
  return catalogueMode(
    workspaceAdminCapability({
      loaded: workspaces.loaded,
      error: workspaces.error,
      activeRole: workspaces.active?.role,
      claimRoles: auth.user?.roles,
    }),
  );
}
