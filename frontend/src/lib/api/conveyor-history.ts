// The project page's conveyor history (asks + answers, card timelines, pull requests).
// Kept out of ./cockpit so each module has exactly one fetcher.

import { authFetch } from './auth-fetch';
import { CockpitNotFoundError } from './cockpit';
import type { ConveyorHistoryResponse } from '$lib/types/conveyor-history';

/**
 * Each part is a read-model Block: an upstream outage arrives as `available:false` with a
 * reason; only HTTP-level failures throw.
 */
export async function fetchProjectConveyorHistory(projectId: string): Promise<ConveyorHistoryResponse> {
  const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/conveyor-history`);
  if (r.status === 404) throw new CockpitNotFoundError(projectId);
  if (!r.ok) throw new Error(`The conveyor history could not be read (HTTP ${r.status}).`);
  return ((await r.json()) as { data: ConveyorHistoryResponse }).data;
}
