// src/lib/api/bindings.ts
//
// Plan: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase D)
//
// Typed client for the asset_bindings endpoints in fr-backend (PR #289).
//
//   POST   /api/assets/:kind/:id/bindings          { project_ids } → { added, already_bound }
//   GET    /api/assets/:kind/:id/bindings          → [{ project_id, bound_at, bound_by_user_id }]
//   DELETE /api/assets/:kind/:id/bindings/:project_id → 204
//   GET    /api/projects/:id/asset-bindings        → grouped by kind

import { assetFetch } from './assets';

export type AssetKind =
  | 'requirement'
  | 'principle'
  | 'decision'
  | 'kag_document'
  | 'workflow'
  | 'trigger'
  | 'channel'
  | 'artifact';

export interface AssetBinding {
  project_id: string;
  bound_at: string;
  bound_by_user_id: string;
}

export interface BindResult {
  added: string[];
  already_bound: string[];
}

export type ProjectAssetBindings = Record<AssetKind, string[]>;

export async function listAssetBindings(
  kind: AssetKind,
  assetId: string,
): Promise<AssetBinding[]> {
  return assetFetch<AssetBinding[]>(
    `/api/assets/${kind}/${encodeURIComponent(assetId)}/bindings`,
  );
}

export async function bindAsset(
  kind: AssetKind,
  assetId: string,
  projectIds: string[],
): Promise<BindResult> {
  return assetFetch<BindResult>(
    `/api/assets/${kind}/${encodeURIComponent(assetId)}/bindings`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_ids: projectIds }),
    },
  );
}

export async function unbindAsset(
  kind: AssetKind,
  assetId: string,
  projectId: string,
): Promise<void> {
  await assetFetch<void>(
    `/api/assets/${kind}/${encodeURIComponent(assetId)}/bindings/${projectId}`,
    { method: 'DELETE' },
  );
}

export async function listProjectAssetBindings(
  projectId: string,
): Promise<ProjectAssetBindings> {
  return assetFetch<ProjectAssetBindings>(
    `/api/projects/${projectId}/asset-bindings`,
  );
}
