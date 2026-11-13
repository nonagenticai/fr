// tests/unit/capabilities/route-order.test.ts
//
// fr-agui SPEC §3.6 / P0b acceptance "route matching unchanged".
//
// `fixtures/route-table.p0b-base.json` is the ORDERED route table of fr
// 6e1021ba7 — before any route was capability-derived — as
// scripts/route-overlap-pairs.ts reconstructs it (server.ts rows in text order,
// delegated `register*(router)` bodies spliced at their call site, the kag
// `/reviews` method loop expanded). The CURRENT table is the same reconstruction
// with capability rows placed by `placeCapabilityRoutes` — the very function
// `deriveRouter` runs at boot.
//
// For EVERY base row, a concrete probe path is resolved first-match-wins against
// both tables; it must land on the same row (method + pattern) with the same
// handler. A capability row's handler is its `legacyHandler`'s export name.
// Then: every pinned overlap pair resolves its probe to `before`, and the live
// table produces exactly the pinned pairs (no new unpinned overlap).

import { describe, expect, test } from 'bun:test';

import { compileRoutePattern } from '../../../src/utils/router';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { ROUTE_OVERLAP_PAIRS, placeCapabilityRoutes, routeRowKey } from '../../../src/capabilities/derive-router';
import {
  computeOverlapPairs,
  legacyOrderedRows,
  orderedRouteTable,
  type OrderedRow,
} from '../../../scripts/route-overlap-pairs';
import base from './fixtures/route-table.p0b-base.json';
import { getCapability, handlerRefOf } from '../../helpers/capabilities';

/** P4d-2a's rows (its declaring modules, parts 1 and 2). */
const P4D2A_FILES = new Set([
  'src/capabilities/approvals/approvals.ts',
  'src/capabilities/projects/collaboration.ts',
  'src/capabilities/projects/project-routes.ts',
  // P4d-2a part 2 (the literal Projects / Cards / Decompositions operations).
  'src/capabilities/projects/project-frozen.ts',
  'src/capabilities/cards/cards.ts',
  'src/capabilities/decompositions/decompositions.ts',
]);
/** P4d-2e's rows (the last 8 LEGACY_UNDECLARED routes, the last literal op, the Evidence Review passthrough). */
const P4D2E_IDS = new Set(['projects.provision_container', 'projects.delete_project']);
const P4D2E_FILES = new Set(['src/capabilities/projects/artifacts.ts', 'src/capabilities/kag/reviews-passthrough.ts']);
const P4D2E_ROUTE_KEYS = new Set(
  CAPABILITIES.filter((e) => P4D2E_FILES.has(e.file) || P4D2E_IDS.has(e.cap.id)).map((e) => `${e.cap.http.method} ${e.cap.http.path}`),
);
const p4d2e = (k: string) => P4D2E_ROUTE_KEYS.has(k);
const P4D2A_ROUTE_KEYS = new Set(
  CAPABILITIES.filter((e) => P4D2A_FILES.has(e.file) && !P4D2E_IDS.has(e.cap.id)).map((e) => `${e.cap.http.method} ${e.cap.http.path}`),
);

/** P4d-2c's rows (the library group). */
const P4D2C_FILES = new Set([
  'src/capabilities/library/governed-assets.ts',
  'src/capabilities/library/asset-surfaces.ts',
  'src/capabilities/library/asset-authoring.ts',
]);
const P4D2C_ROUTE_KEYS = new Set(
  CAPABILITIES.filter((e) => P4D2C_FILES.has(e.file)).map((e) => `${e.cap.http.method} ${e.cap.http.path}`),
);
const p4d2c = (k: string) => P4D2C_ROUTE_KEYS.has(k);

/** P4d-2d's rows (the platform group; the exact set is pinned in p4d2d-capabilities.test.ts). */
const P4D2D_ROUTE_KEYS = new Set(
  CAPABILITIES.filter((e) => e.file.startsWith('src/capabilities/platform/') && e.cap.http.unrouted === undefined).map(
    (e) => `${e.cap.http.method} ${e.cap.http.path}`,
  ),
);
const p4d2d = (k: string) => P4D2D_ROUTE_KEYS.has(k);

const BASE: OrderedRow[] = (base as unknown as { rows: [string, string, string][] }).rows.map(([method, path, handler]) => ({
  method,
  path,
  handler,
  file: '',
}));

/** One concrete path the pattern matches. */
function probe(path: string): string {
  return path.replace(/\(\.\*\)$/, '').replace(/:\w+/g, 'probe-x');
}

function resolve(rows: ReadonlyArray<OrderedRow>, method: string, p: string): OrderedRow | undefined {
  return rows.find((r) => r.method === method && compileRoutePattern(r.path).test(p));
}

/**
 * A base row's handler, by name. fr-agui P4a1: the `/api/tools/kag/*` rows were
 * registered through PURE delegation arrows — `(req: Request, id: string) =>
 * handleGetSession(req, id)` — and are now capability rows bound straight to
 * `handleGetSession`. The router calls `handler(req, ...params)`, so an arrow
 * that forwards exactly its own parameters, in order, IS that function. Only
 * that exact shape is unwrapped; anything else (a reordered, dropped or extra
 * argument, any other expression) is compared verbatim and therefore reds.
 */
export function delegatedName(handler: string): string {
  const m = /^\(req: Request((?:, \w+: string)*)\) => (\w+)\(req((?:, \w+)*)\)$/.exec(handler);
  if (m === null) return handler;
  const params = [...m[1]!.matchAll(/, (\w+): string/g)].map((x) => x[1]);
  const args = [...m[3]!.matchAll(/, (\w+)/g)].map((x) => x[1]);
  return params.join(',') === args.join(',') ? m[2]! : handler;
}

/**
 * fr-agui P4b part 2: server.ts imported the Workflows Viewer handlers UNDER AN ALIAS
 * (`import { handleList as handleListWorkflowsViewer, … } from './routes/workflows'`),
 * so the base table names the alias; the capability row binds the module's own export.
 * Exactly these three, each the alias of exactly that export. P4b part 3: routes/tools/index.ts
 * imported the four analytics handlers the same way (`handleSummary as handleAnalyticsSummary`, …).
 */
const IMPORT_ALIASES: Readonly<Record<string, string>> = {
  handleListWorkflowsViewer: 'handleList',
  handleTagsWorkflowsViewer: 'handleTags',
  handleGetWorkflowViewer: 'handleGet',
  handleAnalyticsSummary: 'handleSummary',
  handleAnalyticsBreakdown: 'handleBreakdown',
  handleAnalyticsPerChannel: 'handlePerChannel',
  handleAnalyticsExportCsv: 'handleExportCsv',
  // P4d-2b: server.ts imported the two kanban comment handlers under an alias (`handleListComments as
  // handleListKanbanComments`, `handleCreateComment as handleCreateKanbanComment`) from routes/kanban.
  handleListKanbanComments: 'handleListComments',
  handleCreateKanbanComment: 'handleCreateComment',
  // P4d-2a part 2: server.ts imported the AA card read as `handleGetCard as handleGetCardAA` from routes/cards/get.
  handleGetCardAA: 'handleGetCard',
};
// P4d-2c: server.ts imported the library list handlers under an alias (`handleListWorkflows as
// handleListWorkflowAssets`, `handleListTriggers as handleListTriggerAssets`).
const P4D2C_IMPORT_ALIASES: Readonly<Record<string, string>> = {
  handleListWorkflowAssets: 'handleListWorkflows',
  handleListTriggerAssets: 'handleListTriggers',
};
const baseName = (handler: string): string => P4D2C_IMPORT_ALIASES[handler] ?? IMPORT_ALIASES[handler] ?? delegatedName(handler);

/** The handler a row serves, by name: a capability row's is its legacyHandler export. */
function handlerName(r: OrderedRow): string {
  if (!r.handler.startsWith('capability:')) return r.handler;
  return handlerRefOf(getCapability(r.handler.slice('capability:'.length))?.legacyHandler)?.exportName ?? '?';
}

/**
 * Routes ADDED after the P0b base, as `METHOD path`. The base fixture is frozen;
 * a new route is listed here in the PR that adds it, so the table can only grow
 * by a recorded row (R271: the read-only capability-selection block).
 */
const ADDED_SINCE_BASE: readonly string[] = [
  'GET /api/projects/:id/capabilities',
  // fr-agui P1c: the confirm-card route for agent-native writes (capabilities.invoke).
  'POST /api/capabilities/:id/invoke',
  // fr-agui P2 (D12): the read-only PM library, three project reads (capabilities/projects/assets.ts).
  'GET /api/projects/:id/pm/projects',
  'GET /api/projects/:id/pm/programmes',
  'GET /api/projects/:id/pm/risks',
  // fr-agui P3: execution observability, six project reads (capabilities/projects/execution.ts).
  'GET /api/projects/:id/executions',
  // Cockpit A5 / R-CK5: the flow-run read and the n8n execution-hook ingest.
  'GET /api/projects/:id/flow-runs',
  'POST /api/internal/conveyor/flow-runs',
  // R2 / REG-3: the project's registers (capabilities/projects/registers.ts).
  'GET /api/projects/:id/registers',
  // R3 / DOC-3: the project's outputs + the document reader's render proxy (capabilities/projects/documents.ts).
  'GET /api/projects/:id/outputs',
  'GET /api/projects/:id/documents/:artifactId/render',
  'GET /api/projects/:id/wip',
  'GET /api/projects/:id/agent-actions',
  'GET /api/projects/:id/blocked-cards',
  'GET /api/projects/:id/cards-by-type',
  'GET /api/projects/:id/conveyor-executions',
  // R311 PR 5: the conveyor's failure notices (execution.ts), the start retry and the two
  // licence-only callbacks (capabilities/conveyor/failures.ts).
  'GET /api/projects/:id/conveyor-notices',
  'POST /api/projects/:id/conveyor-start/retry',
  'POST /api/webhooks/n8n/project-start-failed',
  'POST /api/webhooks/n8n/project-coach-failed',
  // G8 / R313: the asset promotion request, read + raise (capabilities/library/asset-surfaces.ts).
  'GET /api/asset-scope/:assetType/:assetId/promotion-request',
  'POST /api/asset-scope/:assetType/:assetId/promotion-request',
  // Early-access signup v2 (capabilities/admin/signup-approvals.ts): the two service doors and the
  // super_admin onboarding queue.
  'POST /api/signup-approvals/intake',
  'POST /api/signup-approvals/:id/telegram-decision',
  'GET /api/signup-approvals',
  'GET /api/signup-approvals/:id',
  'POST /api/signup-approvals/invite',
  'POST /api/signup-approvals/:id/approve',
  'POST /api/signup-approvals/:id/reject',
  'POST /api/signup-approvals/:id/retry',
  'POST /api/signup-approvals/:id/resolve-repair',
  // Early-access offboarding (services/signup/removal.ts): remove an approved workspace.
  'POST /api/signup-approvals/:id/remove',
  'POST /api/signup-approvals/:id/removal/retry',
  'POST /api/signup-approvals/:id/removal/resolve',
  // The project cord's read (capabilities/projects/assets.ts).
  'GET /api/projects/:id/andon',
  // The kata record (capabilities/admin/katas.ts).
  'GET /api/katas',
  'GET /api/katas/:id',
  'POST /api/katas',
  'PATCH /api/katas/:id',
  'POST /api/katas/:id/close',
  'POST /api/katas/:id/stop',
  'POST /api/katas/:id/rollback',
  'POST /api/katas/:id/release',
  // Realm per app (fr#1634): the super_admin resend of a possibly-undelivered set-password email.
  'POST /api/admin/super-admin/resend-set-password-email',
  // Project page (capabilities/projects/conveyor-history.ts): what the conveyor did on the project.
  'GET /api/projects/:id/conveyor-history',
  // The ArchiMate modeling lifecycle (capabilities/library/architecture-modeling.ts): 40 routes.
  'GET /api/assets/architecture/modeling/models',
  'POST /api/assets/architecture/modeling/models',
  'GET /api/assets/architecture/modeling/models/:mid',
  'PATCH /api/assets/architecture/modeling/models/:mid',
  'DELETE /api/assets/architecture/modeling/models/:mid',
  'GET /api/assets/architecture/modeling/models/:mid/revisions',
  'POST /api/assets/architecture/modeling/models/:mid/revisions',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/reviews',
  'POST /api/assets/architecture/modeling/models/:mid/revisions/:rid/reviews',
  'POST /api/assets/architecture/modeling/models/:mid/revisions/:rid/publish',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/exchange',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/views/:vid/diagram',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/views/:vid/diagram/png',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/views/:vid/diagram/svg',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/views/:vid/diagram/pdf',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/export/pdf',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/export/svg',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/xmi',
  'GET /api/assets/architecture/modeling/models/:mid/publications',
  'GET /api/assets/architecture/modeling/models/:mid/validation-runs',
  'POST /api/assets/architecture/modeling/models/:mid/validation-runs',
  'GET /api/assets/architecture/modeling/models/:mid/change-sets',
  'GET /api/assets/architecture/modeling/models/:mid/exchange',
  'GET /api/assets/architecture/modeling/models/:mid/export/pdf',
  'GET /api/assets/architecture/modeling/models/:mid/export/svg',
  'GET /api/assets/architecture/modeling/models/:mid/xmi',
  'POST /api/assets/architecture/modeling/models/:mid/exchange-imports',
  'POST /api/assets/architecture/modeling/imports',
  'GET /api/assets/architecture/modeling/validation-runs/:runId',
  'GET /api/assets/architecture/modeling/validation-runs/:runId/findings',
  'GET /api/assets/architecture/modeling/change-sets/:csid',
  'POST /api/assets/architecture/modeling/change-sets/:csid/apply',
  'POST /api/assets/architecture/modeling/change-sets/:csid/reject',
  'GET /api/assets/architecture/modeling/rulesets',
  'GET /api/assets/architecture/modeling/rulesets/:ref',
  'GET /api/assets/architecture/views/:vid/diagram',
  'GET /api/assets/architecture/views/:vid/diagram/png',
  'GET /api/assets/architecture/views/:vid/diagram/svg',
  'GET /api/assets/architecture/views/:vid/diagram/pdf',
  // UML (profile uml-2.5.1-p1) and trace links (same file, UML_ROUTES): 41 routes.
  'GET /api/assets/architecture/modeling/uml/elements',
  'POST /api/assets/architecture/modeling/uml/elements',
  'GET /api/assets/architecture/modeling/uml/elements/:id',
  'PUT /api/assets/architecture/modeling/uml/elements/:id',
  'DELETE /api/assets/architecture/modeling/uml/elements/:id',
  'GET /api/assets/architecture/modeling/uml/relationships',
  'POST /api/assets/architecture/modeling/uml/relationships',
  'GET /api/assets/architecture/modeling/uml/relationships/:id',
  'PUT /api/assets/architecture/modeling/uml/relationships/:id',
  'DELETE /api/assets/architecture/modeling/uml/relationships/:id',
  'GET /api/assets/architecture/modeling/uml/interactions',
  'POST /api/assets/architecture/modeling/uml/interactions',
  'GET /api/assets/architecture/modeling/uml/interactions/:id',
  'PUT /api/assets/architecture/modeling/uml/interactions/:id',
  'DELETE /api/assets/architecture/modeling/uml/interactions/:id',
  'GET /api/assets/architecture/modeling/uml/diagrams',
  'POST /api/assets/architecture/modeling/uml/diagrams',
  'GET /api/assets/architecture/modeling/uml/diagrams/:id',
  'PUT /api/assets/architecture/modeling/uml/diagrams/:id',
  'DELETE /api/assets/architecture/modeling/uml/diagrams/:id',
  'GET /api/assets/architecture/modeling/uml/diagrams/:did/objects',
  'POST /api/assets/architecture/modeling/uml/diagrams/:did/objects',
  'PUT /api/assets/architecture/modeling/uml/diagrams/:did/objects/:oid',
  'DELETE /api/assets/architecture/modeling/uml/diagrams/:did/objects/:oid',
  'GET /api/assets/architecture/modeling/uml/diagrams/:did/connections',
  'POST /api/assets/architecture/modeling/uml/diagrams/:did/connections',
  'PUT /api/assets/architecture/modeling/uml/diagrams/:did/connections/:cid',
  'DELETE /api/assets/architecture/modeling/uml/diagrams/:did/connections/:cid',
  'GET /api/assets/architecture/modeling/uml/diagrams/:did/picture',
  'GET /api/assets/architecture/modeling/uml/diagrams/:did/picture/png',
  'GET /api/assets/architecture/modeling/uml/diagrams/:did/picture/svg',
  'GET /api/assets/architecture/modeling/uml/diagrams/:did/picture/pdf',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/uml-diagrams/:did/picture',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/uml-diagrams/:did/picture/png',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/uml-diagrams/:did/picture/svg',
  'GET /api/assets/architecture/modeling/models/:mid/revisions/:rid/uml-diagrams/:did/picture/pdf',
  'GET /api/assets/architecture/modeling/uml/profile',
  'GET /api/assets/architecture/modeling/trace-links',
  'POST /api/assets/architecture/modeling/trace-links',
  'GET /api/assets/architecture/modeling/trace-links/:lid',
  'DELETE /api/assets/architecture/modeling/trace-links/:lid',
  // ArchiMate model contents: a view's shapes and lines, and the metamodel reads.
  'GET /api/assets/architecture/views/:vid/objects',
  'POST /api/assets/architecture/views/:vid/objects',
  'PUT /api/assets/architecture/views/:vid/objects/:oid',
  'DELETE /api/assets/architecture/views/:vid/objects/:oid',
  'GET /api/assets/architecture/views/:vid/connections',
  'POST /api/assets/architecture/views/:vid/connections',
  'PUT /api/assets/architecture/views/:vid/connections/:cid',
  'DELETE /api/assets/architecture/views/:vid/connections/:cid',
  'GET /api/assets/architecture/metamodel/concepts',
  'GET /api/assets/architecture/metamodel/relationships',
  // The mcp channel: its receiver and the Communication settings command list.
  'POST /api/webhooks/mcp/incoming',
  'GET /api/me/channel-commands',
  // fr #1683: a tenant's agent members (workspace-admin).
  'GET /api/workspace/agent-members',
  'POST /api/workspace/agent-members',
  'DELETE /api/workspace/agent-members/:product',
  // Budget reset + per-licence adjust (capabilities/admin/licensing.ts, the super-admin
  // budgets screen). Both have a distinct method from GET /api/admin/licenses/budget/:tenantId,
  // so neither pins an overlap pair.
  'POST /api/admin/licenses/budget/reset/:tenantId',
  'PATCH /api/admin/licenses/budget/line/:licenseId',
];

/**
 * Routes DELETED after the P0b base, as `METHOD path`. The base fixture stays frozen
 * (it is history); a deleted route is listed here in the PR that deletes it, and the
 * table may only shrink by a recorded row.
 * fr-agui P4d-1 (OQ-5): D2 GET /api/tenants/me, D3 POST /api/scrape/url.
 */
// P4d-1: OQ-5 D2 / D3. P4d-2a (George 2026-10-17): three dead routes with zero callers.
const REMOVED_SINCE_BASE: readonly string[] = [
  'GET /api/tenants/me',
  'POST /api/scrape/url',
  'POST /api/cards/relations/link',
  'POST /api/projects/bulk',
  'POST /api/projects/:id/github-token',
  // P4d-2d (George): the campaign kill-switch pair.
  'GET /api/admin/campaigns/kill-switch',
  'POST /api/admin/campaigns/kill-switch',
  // cockpit Slice 1: improvement-loop is future functionality (F4) — its cell-run read is gone.
  'GET /api/projects/:id/conveyor-runs',
  // requirements_management removed its LLM lane (RM #238, 2026-10-26): the four quality-judge
  // proxies and the architecture-governance proposals queue answered 404 upstream.
  'POST /api/assets/principles/:pid/evaluate',
  'POST /api/assets/decisions/:did/evaluate',
  'POST /api/assets/architecture/elements/:eid/evaluate',
  'POST /api/assets/architecture/views/:vid/evaluate',
  'GET /api/governance/architecture/proposals',
  // fr #1649 follow-up: the containers read fed only the removed queue's container picker.
  'GET /api/governance/architecture/containers',
  // George 2026-10-30: procedure and prompt improvement are gone for good (workflow improvement stays).
  'GET /api/admin/improvement/prompts',
  'POST /api/improvement/prompts/canary/promote',
  'POST /api/improvement/prompts/canary/halt',
  'POST /api/improvement/prompts/canary/rollback',
  'GET /api/admin/improvement/procedures',
  'POST /api/admin/improvement/procedures/rollback',
  // George 2026-10-30: recipes are retired; project type config is sufficient.
  'GET /api/conveyor/catalogue/project-types/:id/recipes',
  // George 2026-10-31: Signal is removed as a channel (routes/signal-webhook.ts deleted).
  'POST /api/webhooks/signal/incoming',
  // improvement-loop-service is removed from the cluster: its detector ledger (manual
  // improvement-card trigger) and kaizen low-usage proxy could only fail.
  'POST /api/assets/:assetKind/:assetId/improvement-card',
  'GET /api/assets/kaizen/low-usage',
  // George 2026-11-01: the remaining pages fed by the retired improvement-loop-service are
  // deleted — the /workflows/[id] usage chart, Inference quality, the workflow-improvement
  // tournament drilldown, and the Computed verification page + card verification evidence.
  'GET /api/assets/:kind/:id/rollups',
  'GET /api/inference-quality/summary',
  'GET /api/inference-quality/trends',
  'GET /api/inference-quality/dimensions',
  'GET /api/inference-quality/transcripts',
  'GET /api/inference-quality/governance',
  'GET /api/admin/improvement/workflows/tournaments/:correlationId/candidates',
  'GET /api/admin/verification/trust',
  'GET /api/admin/verification/tier-mix',
  'GET /api/admin/verification/done-by-tier',
  'GET /api/admin/verification/cards/:cardId',
  'GET /api/admin/verification/producers',
  'GET /api/admin/verification/trust/history',
  'GET /api/admin/verification/evidence',
  'GET /api/admin/verification/readiness',
  'GET /api/admin/verification/crosscheck',
  // 2026-11-01: asset-evaluator is retired (archived; its namespace deleted). fr no longer
  // proxies the eval-set / replay substrate or its benchmark reads.
  'GET /api/library/eval-sets',
  'POST /api/library/eval-sets',
  'GET /api/library/eval-sets/:id',
  'PATCH /api/library/eval-sets/:id',
  'DELETE /api/library/eval-sets/:id',
  'GET /api/library/eval-sets/:id/tuples',
  'POST /api/library/eval-sets/:id/tuples',
  'POST /api/library/eval-sets/:id/tuples/:tupleId/clear-redaction-flag',
  'POST /api/library/eval-sets/:id/refresh-from-prod',
  'POST /api/library/eval-sets/:id/sample-from-prod',
  'GET /api/library/replay',
  'POST /api/library/replay/run',
  'GET /api/library/replay/:runId',
  'GET /api/library/replay/:runId/results',
  'GET /api/admin/verification/benchmarks',
  'GET /api/admin/verification/benchmarks/runs',
  'GET /api/admin/verification/benchmarks/runs/:runId/tuples',
  // 2026-11-03 (kata-super-admin §7): the v3 workflow-improvement observatory and its approval gate.
  'GET /api/admin/improvement/workflows',
  'GET /api/admin/improvement/workflows/:projectId',
  'GET /api/admin/improvement/workflows/:projectId/executions',
  'GET /api/admin/improvement/workflows/:projectId/executions/:executionId/trace',
  'GET /api/admin/improvement/workflows/:projectId/candidates',
  'POST /api/improvement/approvals',
  // 2026-11-03 (kata-super-admin §7): the v3 kaizen candidates queue and kaizen log.
  'GET /api/kaizen/candidates',
  'POST /api/kaizen/candidates',
  'PATCH /api/kaizen/candidates/:id',
  'POST /api/kaizen/candidates/:id/promote',
  'GET /api/kaizen/log',
  'POST /api/kaizen/log',
  // 2026-11-03 (kata-super-admin §7, contract amendment 1): the v3 improvement-stream surfaces (the table stays).
  'GET /api/assets/streams',
  'POST /api/assets/streams',
  'GET /api/assets/streams/by-slug/:slug',
  'GET /api/assets/streams/:id',
  'PATCH /api/assets/streams/:id',
  'DELETE /api/assets/streams/:id',
  'GET /api/assets/streams/:id/members',
  'POST /api/assets/streams/:id/members',
  'DELETE /api/assets/streams/:id/members/:assetKind/:assetId',
  'GET /api/assets/streams/:id/notification-channels',
  'GET /api/assets/:assetKind/:assetId/streams',
  'POST /api/library/streams/:id/andon/engage',
  'POST /api/library/streams/:id/andon/disengage',
  'GET /api/internal/streams/:id/status',
  // 2026-11-03 (kata-super-admin §7): the v3 canary / workflow rollback receivers (/api/katas/:id/rollback replaces them).
  'POST /api/webhooks/canary-rollback',
  'POST /api/internal/workflow-rollback',
  // 2026-11-04 (George): procedure_management is retired and the procedures asset type removed
  // from fr, with scheduled reports (a procedure-template renderer).
  'GET /api/assets/procedures/search',
  'GET /api/assets/procedures',
  'POST /api/assets/procedures',
  'GET /api/assets/procedures/:name/versions',
  'GET /api/assets/procedures/:name/steps/:stepNumber',
  'GET /api/assets/procedures/:name',
  'PUT /api/assets/procedures/:name',
  'DELETE /api/assets/procedures/:name',
  'POST /api/internal/assets/procedure',
  'GET /api/admin/assets/procedures',
  'GET /api/admin/assets/procedures/:name',
  'POST /api/admin/assets/procedures',
  'PATCH /api/admin/assets/procedures/:name',
  'DELETE /api/admin/assets/procedures/:name',
  'POST /api/scheduled-reports',
  'GET /api/scheduled-reports',
  'GET /api/scheduled-reports/:id',
  'PATCH /api/scheduled-reports/:id',
  'DELETE /api/scheduled-reports/:id',
  'POST /api/scheduled-reports/:id/run-now',
  'GET /api/scheduled-reports/:id/runs',
  'GET /api/scheduled-reports/:id/effective-template',
  'POST /api/scheduled-reports/:id/dispatch',
];

describe('route matching is unchanged from the P0b base', () => {
  const current = orderedRouteTable();

  test('CONTROL: the current table is the P0b base plus exactly the added rows, minus exactly the removed rows', () => {
    const baseKeys = new Set(BASE.map(routeRowKey));
    expect(current.map(routeRowKey).filter((k) => !baseKeys.has(k)).sort()).toEqual([...ADDED_SINCE_BASE].sort());
    const currentKeys = new Set(current.map(routeRowKey));
    expect([...baseKeys].filter((k) => !currentKeys.has(k)).sort()).toEqual([...REMOVED_SINCE_BASE].sort());
    expect(current.length).toBe(BASE.length + ADDED_SINCE_BASE.length - REMOVED_SINCE_BASE.length);
    const derived = current.filter((r) => r.handler.startsWith('capability:')).map(routeRowKey);
    const p4a3 = (k: string) =>
      /^[A-Z]+ \/api\/(assets\/architecture|assets\/toc|assets\/kaizen|kaizen|library|conveyor\/(taxonomy|catalogue))(\/|$)/.test(k);
    const p4b = (k: string) =>
      /^[A-Z]+ \/api\/(settings\/llm-provider|url-credentials|channels|assets\/secrets|me\/secrets|inapp|notifications\/inapp|tenant\/members|connectors)(\/|$)/.test(k);
    const p4b2 = (k: string) =>
      /^[A-Z]+ \/api\/(scheduled-triggers|scheduled-reports|suggested-schedules|reports\/(approval-backlog|worker-activity|asset-changes)|assets\/workers|workflows|tools\/n8n\/workflows)(\/|$)/.test(k);
    const p4b3 = (k: string) =>
      /^[A-Z]+ \/api\/(me\/(channels|notifications|notification-prefs|licenses|workspaces?|projects\/artifacts|usage\/(summary|series|breakdown|quota|by-tenant)|costs|budget|plan)|tenant\/billing|workspace\/members|repositories|github-app\/callback|tools\/(bridge|analytics))(\/|$)/.test(k);
    const p4c1 = (k: string) =>
      /^[A-Z]+ \/api\/(card-types|assets\/_assignments|traceability\/graph|measure|engagements\/deliveries|admin\/(departments|verification|control-tower)|andon(\/(engage|disengage|history|inflight))?$|improvement\/(approvals|prompts\/canary))(\/|$)/.test(k);
    const p4c2 = (k: string) =>
      /^[A-Z]+ \/api\/(admin\/(assets|improvement|users|andon$|usage\/system)|me\/(super-admin|dept-roles)$|asset-scope\/:assetType\/:assetId\/promote$)(\/|$)/.test(k);
    // P2: 5 PM project reads + 2 governance reads + the project cord.
    const p2 = (k: string) =>
      /^[A-Z]+ \/api\/(projects\/:id\/(pm|andon)\/|governance\/architecture\/)/.test(k);
    // P3 (the exact set is pinned in project-execution-capabilities.test.ts): six execution-observability project reads.
    const p3 = (k: string) =>
      /^GET \/api\/projects\/:id\/(executions|wip|agent-actions|blocked-cards|cards-by-type|conveyor-executions|conveyor-notices)$/.test(k);
    // P2-c1 (the exact set is pinned in project-quality-people-capabilities.test.ts): three project reads (spec drain).
    const p2c1 = (k: string) => /^GET \/api\/projects\/:id\/(quality|quality\/history|knowledge-allocation)$/.test(k);
    // P2-c2 (pinned in project-outputs-capabilities.test.ts): the artifact download-token mint.
    const p2c2 = (k: string) => k === 'POST /api/assets/artifacts/:id/download-token';
    // P4d-2b: the kanban group — /api/kanban/*, /api/assets/kanban/*, the liveness read.
    const p4d2b = (k: string) => /^[A-Z]+ \/api\/(kanban|assets\/kanban|tools\/kanban)\//.test(k);
    // P4d-2a (both parts).
    const p4d2a = (k: string) => P4D2A_ROUTE_KEYS.has(k);
    const p4c3 = (k: string) =>
      /^[A-Z]+ \/api\/admin\/(licenses\/|pricing\/(provider-pricing|markup-rules|markup-config|access-charges|tenant-config\/:tenantId)$|super-admin\/(provision|deprovision)-user$)/.test(k);
    expect(derived.filter((k) => !k.includes('/kag/') && !k.includes('/api/research/') && !p4a3(k) && !p4b(k) && !p4b2(k) && !p4b3(k) && !p4c1(k) && !p4c2(k) && !p4c3(k) && !p2(k) && !p3(k) && !p2c1(k) && !p2c2(k) && !p4d2b(k) && !p4d2a(k) && !p4d2c(k) && !p4d2d(k) && !p4d2e(k) && !k.includes(' /api/workspace/agent-members') && !k.includes(' /api/workspace/agent-decision-policy')).sort()).toEqual([
      'GET /api/conveyor/project-types',
      'GET /api/internal/andon',
      'GET /api/internal/github-app/binding',
      // The kata record (capabilities/admin/katas.ts).
      'GET /api/katas',
      'GET /api/katas/:id',
      'GET /api/me/channel-commands',
      'GET /api/project-requests',
      'GET /api/project-requests/:id',
      'GET /api/project-requests/:id/outlines',
      'GET /api/projects',
      'GET /api/projects/:id',
      // The project cord read.
      'GET /api/projects/:id/andon',
      // Project page: what the conveyor did (capabilities/projects/conveyor-history.ts).
      'GET /api/projects/:id/conveyor-history',
      // R3 / DOC-3 (capabilities/projects/documents.ts).
      'GET /api/projects/:id/documents/:artifactId/render',
      // Cockpit A5 / R-CK5 (capabilities/projects/execution.ts + capabilities/conveyor/flow-runs.ts).
      'GET /api/projects/:id/flow-runs',
      // R3 / DOC-3.
      'GET /api/projects/:id/outputs',
      // R2 / REG-3 (capabilities/projects/registers.ts).
      'GET /api/projects/:id/registers',
      // Early-access signup v2 (capabilities/admin/signup-approvals.ts).
      'GET /api/signup-approvals',
      'GET /api/signup-approvals/:id',
      'PATCH /api/katas/:id',
      'PATCH /api/project-requests/:id',
      // fr#1634 (capabilities/admin/provisioning-recovery.ts).
      'POST /api/admin/super-admin/resend-set-password-email',
      'POST /api/capabilities/:id/invoke',
      'POST /api/internal/assets/channel',
      'POST /api/internal/assets/decision',
      'POST /api/internal/assets/principle',
      'POST /api/internal/assets/requirement',
      'POST /api/internal/assets/trigger',
      'POST /api/internal/conveyor/flow-runs',
      'POST /api/internal/suggested-schedules',
      'POST /api/katas',
      'POST /api/katas/:id/close',
      'POST /api/katas/:id/release',
      'POST /api/katas/:id/rollback',
      'POST /api/katas/:id/stop',
      'POST /api/project-requests',
      'POST /api/project-requests/:id/approve',
      'POST /api/project-requests/:id/reject',
      'POST /api/project-requests/:id/submit',
      'POST /api/project-requests/:id/withdraw',
      'POST /api/project-requests/draft-from-text',
      'POST /api/project-requests/verify-repo-access',
      'POST /api/projects',
      // R311 PR 5 (pinned in conveyor-failures-capabilities.test.ts).
      'POST /api/projects/:id/conveyor-start/retry',
      'POST /api/signup-approvals/:id/approve',
      'POST /api/signup-approvals/:id/reject',
      'POST /api/signup-approvals/:id/removal/resolve',
      'POST /api/signup-approvals/:id/removal/retry',
      'POST /api/signup-approvals/:id/remove',
      'POST /api/signup-approvals/:id/resolve-repair',
      'POST /api/signup-approvals/:id/retry',
      'POST /api/signup-approvals/:id/telegram-decision',
      'POST /api/signup-approvals/intake',
      'POST /api/signup-approvals/invite',
      'POST /api/webhooks/billing/budget-threshold',
      'POST /api/webhooks/email/incoming',
      'POST /api/webhooks/mcp/incoming',
      'POST /api/webhooks/n8n/execution-event',
      'POST /api/webhooks/n8n/project-coach-failed',
      'POST /api/webhooks/n8n/project-request-outline/:id',
      'POST /api/webhooks/n8n/project-start-failed',
      'POST /api/webhooks/n8n/router-dedupe',
      'POST /api/webhooks/teams',
      'POST /api/webhooks/telegram/incoming',
      'PUT /api/approvals/:approvalId',
    ]);
    expect(current.length).toBe(derived.length);
  });

  test('delegatedName unwraps ONLY an arrow that forwards exactly its own parameters', () => {
    expect(delegatedName('(req: Request, id: string) => handleGetSession(req, id)')).toBe('handleGetSession');
    expect(delegatedName('(req: Request, id: string, imageId: string) => handleX(req, id, imageId)')).toBe('handleX');
    expect(delegatedName('handlePlain')).toBe('handlePlain');
    // Reordered, dropped or extra arguments are NOT the same function: kept verbatim, so they would red.
    for (const h of [
      '(req: Request, id: string, imageId: string) => handleX(req, imageId, id)',
      '(req: Request, id: string) => handleX(req)',
      '(req: Request, id: string) => handleX(req, id, extra)',
      '(req: Request, id: string) => handleX(req, id.trim())',
    ]) {
      expect(delegatedName(h)).toBe(h);
    }
  });

  test('every base row resolves to the same row and the same handler in the current table', () => {
    const diffs: string[] = [];
    const removed = new Set(REMOVED_SINCE_BASE);
    for (const row of BASE) {
      const p = probe(row.path);
      if (removed.has(routeRowKey(row))) {
        // A deleted route must not still be served by its old handler under any row.
        const now = resolve(current, row.method, p);
        if (now !== undefined && delegatedName(handlerName(now)) === baseName(row.handler)) {
          diffs.push(`${row.method} ${p}: REMOVED but still served by ${row.handler} via ${routeRowKey(now)}`);
        }
        continue;
      }
      const was = resolve(BASE, row.method, p);
      const now = resolve(current, row.method, p);
      if (was === undefined || now === undefined) {
        diffs.push(`${row.method} ${p}: unresolved (base ${was?.path}, now ${now?.path})`);
        continue;
      }
      if (routeRowKey(was) !== routeRowKey(now) || baseName(was.handler) !== delegatedName(handlerName(now))) {
        diffs.push(`${row.method} ${p}: base ${routeRowKey(was)} → ${was.handler}, now ${routeRowKey(now)} → ${handlerName(now)}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  test('every pinned overlap pair resolves its probe to `before`, in the base AND the current table', () => {
    for (const table of [BASE, current]) {
      for (const pr of ROUTE_OVERLAP_PAIRS) {
        const [method] = pr.before.split(' ');
        expect(`${pr.probe} → ${routeRowKey(resolve(table, method!, pr.probe)!)}`).toBe(`${pr.probe} → ${pr.before}`);
      }
    }
  });

  test('the live table yields exactly the pinned pairs (no new unpinned overlap) and so did the base', () => {
    // Compared as SETS:
    // the list order is only the table order of the rows, and a capability row is
    // placed right after its pinned `before`, so it may enumerate earlier than it
    // did as a legacy row (P4a1: kag/scrape-sessions/:sessionId) without any pair
    // changing. Each pair's ORDER is asserted by the probe test above.
    const fmt = (p: { before: string; after: string }) => `${p.before} < ${p.after}`;
    const pinned = ROUTE_OVERLAP_PAIRS.map(fmt).sort();
    expect(computeOverlapPairs(current).map(fmt).sort()).toEqual(pinned);
    // The base's pairs minus those naming a row removed since the base.
    const removed = new Set(REMOVED_SINCE_BASE);
    const baseLive = computeOverlapPairs(BASE).filter((p) => !removed.has(p.before) && !removed.has(p.after));
    expect(baseLive.map(fmt).sort()).toEqual(pinned);
  });

  test('MUTATION: placing a capability row where a pinned pair forbids it is caught by the same probe', () => {
    // Put GET /api/assets/artifacts/:id/download (a pinned `after`) FIRST: the pinned pair's
    // probe `/api/assets/artifacts/manifest/download` would then resolve to the param row. (Was the
    // approvals pair until P4d-2a, the requirements pair until P4d-2c made those rows capability-derived.)
    // P4d-2e: there are no legacy rows left, so the mutation runs on the full ordered table.
    expect(legacyOrderedRows()).toEqual([]);
    const legacy = orderedRouteTable();
    const victim = legacy.find((r) => routeRowKey(r) === 'GET /api/assets/artifacts/:id/download')!;
    const broken = [victim, ...legacy.filter((r) => r !== victim)];
    expect(routeRowKey(resolve(broken, 'GET', '/api/assets/artifacts/manifest/download')!)).toBe('GET /api/assets/artifacts/:id/download');
    // …and the placement function refuses to produce that order for a capability row.
    const asCap = { ...victim, handler: 'capability:x' };
    const placed = placeCapabilityRoutes(
      legacy.filter((r) => r !== victim),
      [asCap],
    );
    const paths = placed.map(routeRowKey);
    expect(paths.indexOf('GET /api/assets/artifacts/:id/download')).toBeGreaterThan(paths.indexOf('GET /api/assets/artifacts/manifest/:scope'));
  });
});
