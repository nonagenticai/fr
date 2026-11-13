// tests/unit/capabilities/p4b2-fixtures.ts
//
// Shared fixtures for the fr-agui P4b part-2 suites (schedules-operate-*.test.ts):
// the capabilities, request bodies each handler's own validation accepts, the
// rows fr's own tables answer (as drizzle returns them: Date objects), a drizzle
// builder stand-in answering from a queue, and a fetch stand-in for the upstreams
// (worker_management, n8n, requirements_management). No database is touched and no
// mock.module() is used.
import type { Capability } from '../../../src/capabilities/define';
import { REPORTING_CAPABILITIES } from '../../../src/capabilities/operate/reports';
import { WORKER_CAPABILITIES } from '../../../src/capabilities/operate/workers';
import { N8N_TOOL_WORKFLOW_CAPABILITIES, WORKFLOW_VIEWER_CAPABILITIES } from '../../../src/capabilities/operate/workflows';
import { SCHEDULED_TRIGGER_CAPABILITIES } from '../../../src/capabilities/schedules/scheduled-triggers';
import { SUGGESTED_SCHEDULE_CAPABILITIES } from '../../../src/capabilities/schedules/suggested-schedules';
import { pathParams } from '../../../src/capabilities/derive-openapi';

export const HOME = 'a100000c-0000-4000-8000-00000000000c';
export const OTHER = 'b200000d-0000-4000-8000-00000000000d';
export const UUID = '0195f48b-d000-7000-8000-0000000000b2';
/** An active PLATFORM tenant (lib/production-workflows-gate.ts: it reads the production n8n catalogue). */
export const PLATFORM_TENANT = '019de842-c92a-7e37-8fdd-eb0d8c5396f9';
export const T0 = '2026-10-01T00:00:00.000Z';

type Cap = Capability<unknown, unknown>;
export const TRIGGERS: ReadonlyArray<Cap> = SCHEDULED_TRIGGER_CAPABILITIES;
export const SUGGESTIONS: ReadonlyArray<Cap> = SUGGESTED_SCHEDULE_CAPABILITIES;
export const REPORTING: ReadonlyArray<Cap> = REPORTING_CAPABILITIES;
export const WORKERS: ReadonlyArray<Cap> = WORKER_CAPABILITIES;
export const WORKFLOWS: ReadonlyArray<Cap> = [...WORKFLOW_VIEWER_CAPABILITIES, ...N8N_TOOL_WORKFLOW_CAPABILITIES];
/** The user-authenticated operations. */
export const USER_CAPS: ReadonlyArray<Cap> = [...TRIGGERS, ...SUGGESTIONS, ...REPORTING, ...WORKERS, ...WORKFLOWS];
export const ALL: ReadonlyArray<Cap> = USER_CAPS;

export const byId = (id: string): Cap => {
  const c = ALL.find((x) => x.id === id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
};

/** A concrete value per path parameter name (each handler's own checks pass on these). */
const PARAM: Record<string, string> = { id: UUID, name: 'w1', provider: 'openai', workerId: 'w1', assetType: 'decisions' };
export const paramsOf = (cap: Cap): string[] =>
  pathParams(cap.http.path!).map((p) => (cap.area === 'workflows' && p === 'id' ? 'wf-1' : (PARAM[p] ?? UUID)));
export const hasBody = (cap: Cap): boolean => cap.http.method !== 'GET' && cap.http.method !== 'DELETE';

export const BODIES: Record<string, unknown> = {
  'scheduled_triggers.create': {
    project_id: UUID,
    name: 'n',
    cron: '0 * * * *',
    source_connector: 'rss',
    connector_config: { kind: 'rss', secret_id: null, feed_url: 'https://example.com/feed.xml' },
    payload_mapper: { title: '$.title' },
    card_template: { card_type: 'task' },
  },
  'scheduled_triggers.update': { name: 'n2' },
  'workers.create': { worker_name: 'w1', model_provider: 'openai', model: 'gpt', temperature: 0.2, max_tokens: 100, api_key_override: 'sk-test' },
  'workers.update': { worker_name: 'w1', model: 'gpt' },
  'workers.send_message': { message: 'hi' },
  'workers.chat_completions': { provider: 'openai', model: 'gpt', messages: [{ role: 'user', content: 'hi' }] },
};

const d = new Date(T0);
export const triggerRow = (over: Record<string, unknown> = {}) => ({
  id: UUID, tenant_id: HOME, project_id: UUID, name: 'n', cron: '0 * * * *', timezone: 'UTC', source_connector: 'rss',
  connector_config: { kind: 'rss', secret_id: null, feed_url: 'https://example.com/feed.xml' }, payload_mapper: { title: '$.title' },
  target_list: 'INBOX', card_template: { card_type: 'task' }, enabled: true, last_run_at: null, last_run_status: null,
  last_run_error: null, permanent_failure_count: 0, disabled_reason: null, from_suggestion_id: null, origin_kind: 'project',
  origin_project_id: UUID, origin_workflow_run_id: null, created_by_user_id: 'u-admin', created_at: d, updated_at: d, ...over,
});
export const runRow = () => ({
  id: UUID, trigger_kind: 'scheduled_intake', trigger_id: UUID, tenant_id: HOME, project_id: UUID, fired_at: d, finished_at: d,
  status: 'skipped_no_connector', records_processed: 0, error_message: null, kind: 'manual', triggered_by_user_id: 'u-admin', created_at: d,
});
export const suggestionRow = (over: Record<string, unknown> = {}) => ({
  id: UUID, tenant_id: HOME, project_id: UUID, user_id: null, source: 'manual', ad_hoc_summary: 's',
  payload: {
    suggested_name: 'n', suggested_cron: '0 * * * *', suggested_source_connector: 'rss',
    suggested_connector_config: { kind: 'rss', secret_id: null, feed_url: 'https://example.com/feed.xml' },
    suggested_payload_mapper: { title: '$.title' }, suggested_card_template: { card_type: 'task' },
  },
  status: 'new', promoted_trigger_id: null, created_at: d, updated_at: d, ...over,
});
/** A continuous-flow, department-less project of HOME (the shape loaders' row). */
export const projectShapeRow = { id: UUID, shape: 'continuous_flow', dept_id: null, workspace_id: HOME, project_data: null };
export const DEPT_NULL = [{ dept_id: null }];

/**
 * The store answers each capability's SUCCESS path reads, in order, for a caller that is a
 * workspace-admin by its realm `tenant_admin` claim (no user_roles round trip) in a HOME frame.
 */
export function successAnswers(id: string): unknown[] {
  const row = (r: unknown) => [r];
  switch (id) {
    case 'scheduled_triggers.create': return [row(projectShapeRow), row(triggerRow())];
    case 'scheduled_triggers.list': return [row(triggerRow())];
    case 'scheduled_triggers.get': return [row(triggerRow()), DEPT_NULL];
    case 'scheduled_triggers.update': return [row(triggerRow()), DEPT_NULL, row(triggerRow({ name: 'n2' }))];
    case 'scheduled_triggers.delete': return [row(triggerRow()), DEPT_NULL, [{ id: UUID }]];
    case 'scheduled_triggers.run_now': return [row(triggerRow()), DEPT_NULL, null];
    case 'scheduled_triggers.list_runs': return [row(triggerRow()), DEPT_NULL, [runRow()], [{ n: 1 }]];
    case 'suggested_schedules.accept': return [row(suggestionRow()), DEPT_NULL, row(projectShapeRow), triggerRow({ from_suggestion_id: UUID })];
    case 'suggested_schedules.dismiss': return [row(suggestionRow()), DEPT_NULL, row(suggestionRow({ status: 'dismissed' }))];
    case 'reports.approval_backlog':
      return [[{ id: UUID, project_id: UUID, description: 'd', status: 'pending', created_at: d, expires_at: null, role: 'approver' }]];
    default: return [];
  }
}

/** A drizzle builder stand-in: every query EXECUTES (is awaited) against `next()`. */
export function storeChain(next: () => unknown): unknown {
  const p: unknown = new Proxy(function chain() {}, {
    get(_t, key) {
      if (key === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          try {
            const v = next();
            if (v instanceof Error) reject(v);
            else resolve(v);
          } catch (e) {
            reject(e);
          }
        };
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

/**
 * The worker as worker_management's GET answers an entitled caller (identity AND tenant proven): the three
 * secret-bearing fields carry their values.
 */
export const WORKER = {
  name: 'w1', status: 'idle', is_agent: true, model_provider: 'openai', model: 'gpt', tool_names: [],
  api_key_override: 'sk-test', base_url_override: 'https://u:pw@llm.example/v1', mcp_config: { auth: { token: 'mcp-tok' } },
};
/** The create / update answer: worker_management builds it with `echo_overrides=False`, so all three are null. */
export const WORKER_UPSERT_ECHO = { ...WORKER, api_key_override: null, base_url_override: null, mcp_config: null };
export const N8N_WF = { id: 'wf-1', name: 'AA Pattern - Doing Orchestrate', active: true, tags: [], updatedAt: T0, nodes: [], connections: {}, settings: {} };

/** The upstream's success answer for (method, url), or undefined. */
export function upstreamOk(method: string, url: string): { status: number; body: unknown } | undefined {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/workers/w1/message')) return { status: 200, body: { output: 'hi', output_type: 'string', usage_metrics: {} } };
  if (p.endsWith('/workers/w1/states')) return { status: 200, body: [{ status: 'idle', recorded_at: T0, detail: { a: 1 } }] };
  if (p.endsWith('/workers/w1')) {
    if (method === 'DELETE') return { status: 204, body: null };
    return { status: 200, body: method === 'PUT' ? WORKER_UPSERT_ECHO : WORKER };
  }
  if (p.endsWith('/workers')) return method === 'POST' ? { status: 201, body: WORKER_UPSERT_ECHO } : { status: 200, body: ['w1'] };
  if (p.endsWith('/providers/openai/models')) return { status: 200, body: { object: 'list', provider: 'openai', data: [{ id: 'gpt', object: 'model' }] } };
  if (p.endsWith('/providers')) return { status: 200, body: { object: 'list', data: [{ name: 'openai', label: 'OpenAI', description: 'd', requires_api_key: true }] } };
  if (p.endsWith('/chat/completions')) return { status: 200, body: { output: 'hi', provider: 'openai', model: 'gpt', usage: { total_tokens: 3 } } };
  if (/\/workflows\/wf-1$/.test(p)) return { status: 200, body: N8N_WF };
  if (/\/workflows$/.test(p)) return { status: 200, body: { data: [N8N_WF], nextCursor: null } };
  if (p.endsWith('/versions')) return { status: 200, body: [{ id: UUID, version: 2, updated_at: T0 }] };
  return undefined;
}

export const urlOf = (input: unknown): string => String(input instanceof Request ? input.url : input);
