// fr-agui SPEC §13 P4d-2d — spec drain, the platform group: the coding spine
// (`/api/coding/*`, routes/coding/handlers.ts — the BFF over coding-gateway) and the coding analysis
// jobs (`/api/tools/coding/*`, routes/tools/coding.ts), re-expressed with NO behaviour change
// (`legacyHandler`). None had an operation in the served spec (LEGACY_UNDECLARED): every one is a
// NEW operation, operationId = camelCase(id), `out-of-agent-scope` — the agent reaches coding jobs
// through its own `coding.*` AG-UI actions (registered by routes/tools/coding.ts at module load,
// unchanged), and none is on the licence route allowlist.
//
// Gate (all fifteen): validateAuth (its licence / conveyor doors) and nothing else; the spine sends
// the resolved tenant (`ctxTenantId`: the frame tenant, else the JWT one) upstream, the jobs are the
// caller's own (`userId`). `withIntegrationCatch` renders an IntegrationError as
// `{ error: { code, message } }` (a non-JSON / non-object body: 400 BAD_REQUEST before anything is
// sent); the upstream's refusals are relayed in that envelope (its 4xx pass through, a 5xx / no
// answer 502, a timeout 504). An empty body on a spine write is read as `{}`.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { ANALYSIS_TYPES, JOB_STATUSES, SEVERITIES } from '../../integrations/coding/types';
import type { Capability, ResponseSpec } from '../define';
import { isAuthenticatedUser, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, platformCapabilities, routeRule, unauthorizedBody } from './_shared';

const RELAYED =
  " Any other status is coding-gateway's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no " +
  "answer is 502, a timeout 504), or fr's own 500.";

function codingResponses(extra = ''): ResponseSpec[] {
  return [
    { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
    { status: 'default', description: extra + DOOR_403 + RELAYED, schema: frErrorBody },
  ];
}
const BODY_400 = "400: `error.code` 'BAD_REQUEST' — the body is not JSON or not a JSON object (nothing sent). ";

const container = pathId('The code-graph container name');
const data = z.object({ data: z.unknown() });
const forwarded = (type: string) => z.object({}).passthrough().describe(`Forwarded verbatim to coding-gateway (${type}).`);

export const CODING_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...platformCapabilities(
    {
      area: 'coding', tag: 'Coding', tenancy: 'tenant', rule: routeRule(isAuthenticatedUserInResolvedTenant),
      module: 'src/routes/coding/handlers.ts', load: () => import('../../routes/coding/handlers'),
    },
    [
      {
        id: 'coding.list_containers', method: 'GET', path: '/api/coding/containers', handler: 'handleListCodingContainers', effect: 'read',
        summary: "The resolved tenant's code-graph containers (coding-gateway)",
        input: z.object({}), output: data, responses: codingResponses(),
      },
      {
        id: 'coding.get_graph', method: 'GET', path: '/api/coding/graphs/:container/augmented', handler: 'handleGetCodingGraph', effect: 'read',
        summary: "A container's augmented code graph (cached 300 s per tenant + container)",
        input: z.object({ container }), output: data, responses: codingResponses(),
      },
      {
        id: 'coding.get_quality_gate', method: 'GET', path: '/api/coding/quality/:container/gate', handler: 'handleGetCodingQualityGate', effect: 'read',
        summary: "A container's quality-gate result (cached 300 s; a scan busts it)",
        input: z.object({ container }), output: data, responses: codingResponses(),
      },
      {
        id: 'coding.get_dependency_report', method: 'GET', path: '/api/coding/dependencies/:container/report', handler: 'handleGetCodingDependencyReport', effect: 'read',
        summary: "A container's dependency report (a deprovisioned container: the persisted snapshot, `degraded: true`)",
        input: z.object({ container }), output: data, responses: codingResponses(),
      },
      {
        id: 'coding.get_dependency_snapshot', method: 'GET', path: '/api/coding/dependencies/:container/snapshot', handler: 'handleGetCodingDependencySnapshot', effect: 'read',
        summary: "A container's persisted dependency snapshot",
        input: z.object({ container }), output: data, responses: codingResponses(),
      },
      {
        id: 'coding.provision_repository', method: 'POST', path: '/api/coding/repositories/provision', handler: 'handleProvisionRepository', effect: 'write',
        summary: 'Provision (clone) a repository into a coding container',
        description:
          'Platform-repo ownership gate (ruling 2026-09-30): a non-platform active tenant may not have fr clone an ' +
          'internal-owner repository (refused before the upstream hop).',
        input: forwarded('GithubGitHubRepoRequest: repo_url, …'), output: data,
        responses: codingResponses(BODY_400 + 'The platform-repo ownership gate refusing (its own status and body). '),
      },
      {
        id: 'coding.initialize_graph', method: 'POST', path: '/api/coding/graphs/initialize', handler: 'handleInitializeGraph', effect: 'write',
        summary: 'Initialise a code graph for a codebase',
        input: forwarded('CodebaseInitRequest'), output: data, responses: codingResponses(BODY_400),
      },
      {
        id: 'coding.analyze_codebase', method: 'POST', path: '/api/coding/analysis/analyze', handler: 'handleAnalyzeCodebase', effect: 'write',
        summary: 'Run a codebase analysis',
        input: forwarded('AnalysisRequest'), output: data, responses: codingResponses(BODY_400),
      },
      {
        id: 'coding.trigger_scan', method: 'POST', path: '/api/coding/dependencies/:container/scan', handler: 'handleTriggerCodingScan', effect: 'write',
        summary: 'Trigger a dependency + quality scan of a container (busts its cached report and gate)',
        description: 'No body is read.',
        input: z.object({ container }), output: data, responses: codingResponses(),
      },
    ],
  ),
  ...platformCapabilities(
    {
      area: 'tools', tag: 'Coding', tenancy: 'self', rule: routeRule(isAuthenticatedUser),
      module: 'src/routes/tools/coding.ts', load: () => import('../../routes/tools/coding'),
    },
    [
      {
        id: 'tools.list_coding_analysis_types', method: 'GET', path: '/api/tools/coding/analysis-types', handler: 'handleListAnalysisTypes', effect: 'read',
        summary: 'The coding analysis types fr can run (static)',
        input: z.object({}), output: data, responses: codingResponses(),
      },
      {
        id: 'tools.trigger_coding_job', method: 'POST', path: '/api/tools/coding/jobs', handler: 'handleTriggerAnalysis', effect: 'write',
        summary: 'Start a coding analysis job for the caller (idempotent on `client_idempotency_key`)',
        description: 'An empty body is read as `{}` (and fails the schema: 400). `project_id` is accepted and unused on this route.',
        input: z.object({
          project_id: z.string().uuid().optional(),
          repo_id: z.string().min(1),
          type: z.enum(ANALYSIS_TYPES),
          options: z
            .object({
              ref: z.string().optional(),
              paths: z.array(z.string()).optional(),
              severity_floor: z.enum(SEVERITIES).optional(),
              test_selector: z.string().optional(),
            })
            .partial()
            .optional(),
          client_idempotency_key: z.string().min(1),
        }),
        output: z.object({ data: z.unknown(), meta: z.object({ deduped: z.boolean() }) }),
        responses: codingResponses("400: `error.code` 'BAD_REQUEST' — the body is not JSON ('Invalid JSON body: …') or fails the schema ('Invalid body: …'). "),
      },
      {
        id: 'tools.list_coding_jobs', method: 'GET', path: '/api/tools/coding/jobs', handler: 'handleListJobs', effect: 'read',
        summary: "The caller's coding analysis jobs (recent + in flight)",
        input: z.object({
          repo_id: z.string().optional(),
          type: z.enum(ANALYSIS_TYPES).optional(),
          status: z.enum(JOB_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(250).optional(),
          cursor: z.string().optional(),
        }),
        output: z.object({ data: z.array(z.unknown()), meta: z.object({ next_cursor: z.string().nullable().optional() }).passthrough() }),
        responses: codingResponses("400: `error.code` 'BAD_REQUEST' ('Invalid query: …'). "),
      },
      {
        id: 'tools.get_coding_job_findings', method: 'GET', path: '/api/tools/coding/jobs/:id/findings', handler: 'handleGetFindings', effect: 'read',
        summary: "One of the caller's coding jobs' findings (paged)",
        input: z.object({
          id: pathId('The job id'),
          severity_floor: z.enum(SEVERITIES).optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        output: z.object({ data: z.array(z.unknown()), meta: z.object({ next_cursor: z.string().nullable().optional() }).passthrough() }),
        responses: codingResponses("400: `error.code` 'BAD_REQUEST' ('Invalid query: …'). "),
      },
      {
        id: 'tools.cancel_coding_job', method: 'POST', path: '/api/tools/coding/jobs/:id/cancel', handler: 'handleCancelJob', effect: 'write',
        summary: 'Cancel a coding job — NOT supported at this revision (always 501 NOT_SUPPORTED after auth)',
        input: z.object({ id: pathId('The job id') }),
        output: z.object({ error: z.object({ code: z.literal('NOT_SUPPORTED'), message: z.string() }) }),
        responses: codingResponses("501: `error.code` 'NOT_SUPPORTED' (every authenticated call). "),
      },
      {
        id: 'tools.get_coding_job', method: 'GET', path: '/api/tools/coding/jobs/:id', handler: 'handleGetJob', effect: 'read',
        summary: "One of the caller's coding jobs (refreshing async upstream state)",
        input: z.object({ id: pathId('The job id') }),
        output: data,
        responses: codingResponses("404: `error.code` 'UPSTREAM_NOT_FOUND' (not the caller's job). "),
      },
    ],
  ),
];
