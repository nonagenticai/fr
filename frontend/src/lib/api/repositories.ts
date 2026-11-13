// Frontend client for `/api/repositories`.
//
// Wave-3 / T7 — added so /tools/coding can populate a `<select>` from the
// user's onboarded repositories.

import { assetFetch } from './assets';

export interface Repository {
  id: string;
  user_id: string;
  name: string | null;
  url: string;
  branch: string | null;
  path: string | null;
  description: string | null;
  secret_id: string | null;
  /** Non-null when the repo is provisioned to coding-gateway. */
  container_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListRepositoriesOpts {
  /**
   * Filter by onboarding target. `'coding'` returns only rows where
   * `container_name IS NOT NULL` — i.e. provisioned to the coding-gateway.
   */
  onboardedTo?: 'coding';
}

/**
 * GET /api/repositories — list the signed-in user's repos. The list endpoint
 * is unwrapped (no `{data}` envelope), so assetFetch passes `{items, total}`
 * straight through; we return just `items` for ergonomics.
 */
export async function listRepositories(
  opts: ListRepositoriesOpts = {},
): Promise<Repository[]> {
  const sp = new URLSearchParams();
  if (opts.onboardedTo) sp.set('onboarded_to', opts.onboardedTo);
  const q = sp.toString();
  const out = await assetFetch<{ items: Repository[]; total: number }>(
    `/api/repositories${q ? `?${q}` : ''}`,
  );
  return out.items;
}
