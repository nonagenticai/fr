// The conveyor's flow runs as n8n's execution hook reported them (cockpit A5 / R-CK5,
// GET /api/projects/:id/flow-runs). Replaces the improvement-loop cell-run read (F4: future
// functionality, not a source).
import { authFetch } from './auth-fetch';

export interface FlowRunRow {
  execution_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  card_id: string | null;
  status: string;
  started_at: string | null;
  stopped_at: string | null;
  failed_node: string | null;
  error_class: string | null;
  /** n8n's own final status (migration 214); absent on an older backend. */
  n8n_status?: string | null;
  /** Raw detail — only ever behind "Details". */
  error_message?: string | null;
}

export interface FlowRunsPayload {
  /** false ⇒ the hook has reported nothing for this project yet ("not connected yet"). */
  available: boolean;
  runs: FlowRunRow[];
}

export async function fetchProjectFlowRuns(projectId: string, limit = 200): Promise<FlowRunsPayload> {
  const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/flow-runs?limit=${limit}`);
  if (!r.ok) throw new Error(`The flow runs could not be read (HTTP ${r.status}).`);
  const body = (await r.json()) as { data?: { available?: boolean; runs?: FlowRunRow[] } };
  return { available: body.data?.available === true, runs: Array.isArray(body.data?.runs) ? body.data!.runs! : [] };
}
