// G8 / R313 — asking the workspace admins to promote a PROJECT copy of a requirement,
// principle or decision to the whole workspace (backend:
// `GET|POST /api/asset-scope/:assetType/:assetId/promotion-request`).
//
// The backend is the boundary: it refuses a caller outside the copy's project and only a
// workspace admin can decide. This module only decides WHERE the action is offered, from
// the same facts the route checks first: the row is a project copy made in THIS project
// (origin 'project' + origin_project_id + `supersedes`) and has not already been merged.
import { assetFetch } from '$lib/api/assets';

export type PromotableKind = 'requirement' | 'principle' | 'decision';
const PROMOTABLE: readonly string[] = ['requirement', 'principle', 'decision'];

export interface PromotableRow {
  origin_kind?: string;
  origin_project_id?: string | null;
  supersedes?: string | null;
  version_status?: string | null;
}

export interface PromotionState {
  approval_id: string;
  status: string;
  promotion: { outcome?: string } | null;
}

/** True only for a copy of a workspace asset made in `projectId` that is not yet merged. */
export function isPromotableCopy(kind: string, row: PromotableRow, projectId: string): boolean {
  if (!PROMOTABLE.includes(kind)) return false;
  if (row.origin_kind !== 'project' || !row.origin_project_id || !projectId) return false;
  if (row.origin_project_id.toLowerCase() !== projectId.toLowerCase()) return false;
  if (!row.supersedes) return false;
  return (row.version_status ?? '').toUpperCase() !== 'SUPERSEDED';
}

const path = (kind: PromotableKind, id: string) =>
  `/api/asset-scope/${kind}/${encodeURIComponent(id)}/promotion-request`;

export function getPromotion(kind: PromotableKind, id: string): Promise<PromotionState | null> {
  return assetFetch<PromotionState | null>(path(kind, id));
}

export async function requestPromotion(kind: PromotableKind, id: string): Promise<PromotionState> {
  const out = await assetFetch<{ approval_id: string; status: string }>(path(kind, id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return { approval_id: out.approval_id, status: out.status, promotion: null };
}

/** An approved promotion whose workspace update did not happen (the backend stamped `failed`). */
export function promotionFailed(state: PromotionState | null): boolean {
  return state !== null && state.status === 'approved' && state.promotion?.outcome === 'failed';
}

/**
 * Whether the copy may be offered "Ask to promote" again: nothing requested yet, or the last
 * request is closed without a promotion (failed, declined, expired or withdrawn). Only a
 * pending request, or one that actually promoted the copy, hides the action.
 */
export function canRequestPromotion(state: PromotionState | null): boolean {
  if (state === null) return true;
  if (state.status === 'pending') return false;
  if (state.status === 'approved') return promotionFailed(state);
  return true;
}

/** One short, user-facing line for a promotion state (null = nothing requested yet). */
export function promotionLabel(state: PromotionState | null): string | null {
  if (state === null) return null;
  if (state.status === 'pending') return 'Promotion requested — waiting for a workspace admin';
  if (state.status === 'approved') {
    return promotionFailed(state) ? 'Promotion failed — ask again' : 'Promoted to the workspace';
  }
  if (state.status === 'rejected') return 'Promotion declined — this version stays in the project';
  if (state.status === 'expired') return 'Promotion request expired';
  return null;
}

/**
 * The page line for a failed request. Customer copy only: the backend's refusal codes map to
 * plain sentences, and anything else (an upstream `${status} ${statusText}: detail`) becomes a
 * neutral retry line — that detail is for the console, never the page (fr#1407).
 */
export function promotionErrorText(err: unknown): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  switch (code) {
    case 'promotion_requires_project_member':
      return 'Only members of this project can ask for this.';
    case 'promotion_no_approver':
      return 'This workspace has no admin who could approve it.';
    case 'asset_superseded':
      return 'This version was already promoted.';
    case 'not_a_project_copy':
    case 'promotion_original_unknown':
      return "This item isn't a project version of a workspace item.";
    default:
      return "Couldn't ask for promotion. Try again.";
  }
}
