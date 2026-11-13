// src/lib/api/n8n.ts
//
// Typed wrappers for the backend's `/api/tools/n8n/*` surface (Wave 2).
// All calls go through `authFetch` so the bearer token is attached.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 2 Task 2.1 Step 8.

import { authFetch } from './auth-fetch';

export interface N8nWorkflow {
  id?: string;
  name?: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface ScopedExecution {
  id: string;
  workflow_id: string | null | undefined;
  status: string | undefined;
  mode: string | undefined;
  started_at: string | undefined;
  stopped_at: string | undefined;
  duration_ms: number | undefined;
  project_id: string;
  initiated_via: string;
  correlation_id: string;
  /**
   * `null` for a customer (non-production-visible caller): the backend redacts
   * the platform Grafana/Tempo deep-link, as it does `workflow_id`.
   */
  trace_url: string | null;
}

export interface ListWorkflowsParams {
  active?: boolean;
  limit?: number;
}

export interface ListExecutionsParams {
  status?: 'canceled' | 'error' | 'running' | 'success' | 'waiting';
  workflowId?: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
}

interface ListResponse<T> {
  data: T[];
  meta?: { cursor: string | null; hasMore: boolean };
}

interface GetExecutionResponse {
  data: { execution: ScopedExecution; trace_url: string | null };
}

async function ensureOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `${label} failed: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

export async function listWorkflows(
  params: ListWorkflowsParams = {},
): Promise<{ workflows: N8nWorkflow[] }> {
  const q = new URLSearchParams();
  if (params.active !== undefined) q.set('active', String(params.active));
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  const qs = q.toString();
  const url = `/api/tools/n8n/workflows${qs ? `?${qs}` : ''}`;
  const resp = await authFetch(url);
  await ensureOk(resp, 'n8n.list_workflows');
  const json = (await resp.json()) as ListResponse<N8nWorkflow>;
  return { workflows: Array.isArray(json?.data) ? json.data : [] };
}

export async function listExecutions(
  params: ListExecutionsParams = {},
): Promise<ListResponse<ScopedExecution>> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.workflowId) q.set('workflowId', params.workflowId);
  if (params.projectId) q.set('projectId', params.projectId);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const qs = q.toString();
  const url = `/api/tools/n8n/executions${qs ? `?${qs}` : ''}`;
  const resp = await authFetch(url);
  await ensureOk(resp, 'n8n.list_executions');
  const json = (await resp.json()) as ListResponse<ScopedExecution>;
  return {
    data: Array.isArray(json?.data) ? json.data : [],
    meta: json?.meta ?? { cursor: null, hasMore: false },
  };
}

export async function getExecution(executionId: string): Promise<GetExecutionResponse['data']> {
  const url = `/api/tools/n8n/executions/${encodeURIComponent(executionId)}`;
  const resp = await authFetch(url);
  await ensureOk(resp, 'n8n.get_execution');
  const json = (await resp.json()) as GetExecutionResponse;
  return json.data;
}
