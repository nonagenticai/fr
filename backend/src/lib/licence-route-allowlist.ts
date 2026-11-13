// src/lib/licence-route-allowlist.ts
//
// ⛔ DENY BY DEFAULT for a LICENCE caller (George 2026-10-10, licence door G3 fix).
//
// A licence token is the tenant's CONVEYOR SEAT: a customer's n8n, through the
// n8n-nodes-fr credential. The G3 licence lane (`licenceProjectScope`) lets it
// reach every project of its tenant regardless of owner, on every route behind
// `loadTenantScopedProject` / `findTenantScopedProject` — which on its own would
// have handed it DELETE /api/projects/:id (archive + PHI purge + Planka teardown
// + voiding pending approvals), provision, set-github-token and every other
// owner/admin route. The intent was never to give the conveyor seat destructive
// or admin powers, and a licence never decides or voids an approval.
//
// So a licence caller may reach ONLY the (method, route pattern) pairs below.
// Everything else is 403 `licence_route_not_allowed` — enforced twice, both
// BEFORE any handler logic:
//   * src/server.ts, right after routing: a licence-shaped bearer on a route not
//     listed here never reaches the handler (covers handlers that read identity
//     from the request context rather than `validateAuth`);
//   * middleware/auth.ts `validateAuth` / `validateAuthWithToken`, the moment a
//     licence identity is established (covers every other entry point).
// Per-route tenant binding (licence-door.ts, licenceProjectScope) is unchanged —
// this is defence in depth, not a replacement.
//
// MATCHING. Entries are the EXACT pattern strings passed to `router.add` (the
// test proves each one is a real registered route). The server records which
// registered pattern the router actually dispatched to (`recordMatchedRoute`)
// and the guard compares THAT — not the raw URL — so a path that the router
// sends to a different, earlier-registered route cannot borrow an allowed
// pattern. The router is exact, `^…$`-anchored and case-sensitive, and the
// method compare is exact, so trailing slashes, case and extra segments cannot
// bypass it. A request with no recorded route (a handler invoked outside the
// router: unit tests, the pre-router WebSocket paths) is matched against these
// entries with the router's own compiler (`compileRoutePattern`) — still
// deny-by-default.
//
// SOURCE OF TRUTH: the routes n8n-nodes-fr calls (nonagenticai/n8n-nodes-fr,
// PR #44 `licence-only-ops` @ 87d21bf: nodes/Fr/operations/index.ts +
// nodes/Fr/_legacy.request.ts). Each entry names the node op(s) that call it.
// Node ops whose route is destructive or admin are NOT here — they are listed in
// `LICENCE_REFUSED_NODE_ROUTES` with the reason, and a licence calling them gets
// 403. ⛔ Never add a DELETE, an approval decide/void, provision, github-token,
// a secrets route or a repository-binding route to the allowlist.

import { ForbiddenError } from '../utils/errors';
import { compileRoutePattern } from '../utils/router';
import { isLicenceBearer } from './licence-introspect';

export const LICENCE_ROUTE_NOT_ALLOWED_CODE = 'licence_route_not_allowed' as const;

export type LicenceRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface LicenceRoute {
  readonly method: LicenceRouteMethod;
  /** The exact `router.add` pattern string. */
  readonly pattern: string;
  /** The n8n-nodes-fr op(s) that call it (`resource.operation`), or why it is here without one. */
  readonly ops: readonly string[];
}

export const LICENCE_ROUTE_ALLOWLIST: readonly LicenceRoute[] = [
  // ── projects (reads + the conveyor's constraint op) ───────────────────────
  // (George 2026-10-13, D15/R16: PATCH /api/projects/:id/phase and PUT
  // /api/projects/:id/brief are RETIRED — the PM writes the phase and every later
  // brief version in requirements_management itself; fr only reads them.)
  { method: 'GET', pattern: '/api/projects', ops: ['projects.listProjects'] },
  { method: 'POST', pattern: '/api/projects', ops: ['projects.createProject'] },
  { method: 'POST', pattern: '/api/projects/constraint-check', ops: ['projects.constraintCheck'] },
  { method: 'GET', pattern: '/api/projects/:id', ops: ['projects.getProject', 'project.get'] },
  { method: 'GET', pattern: '/api/projects/:id/status', ops: ['projects.getProjectStatus'] },
  { method: 'GET', pattern: '/api/projects/:id/brief', ops: ['projects.getProjectBrief'] },
  { method: 'GET', pattern: '/api/projects/:id/repositories', ops: ['projects.listProjectRepositories'] },
  { method: 'GET', pattern: '/api/projects/:id/deliverables', ops: ['decompositions.getProjectDeliverables'] },
  // ── documents ─────────────────────────────────────────────────────────────
  { method: 'GET', pattern: '/api/projects/:id/documents', ops: ['documents.listProjectDocuments'] },
  { method: 'POST', pattern: '/api/documents/upload', ops: ['documents.uploadDocument'] },
  { method: 'GET', pattern: '/api/documents/:id/status', ops: ['documents.getDocumentStatus'] },
  // ── comments (read + add; never edit / delete a human's comment) ──────────
  { method: 'GET', pattern: '/api/projects/:projectId/comments', ops: ['comments.listComments'] },
  { method: 'POST', pattern: '/api/projects/:projectId/comments', ops: ['comments.createComment'] },
  // ── approvals: READ + MINT only (minting ≠ deciding — licence-door.ts) ────
  { method: 'GET', pattern: '/api/projects/:projectId/approvals', ops: ['approvals.listApprovals'] },
  { method: 'POST', pattern: '/api/projects/:projectId/approvals', ops: ['approvals.createApproval'] },
  { method: 'GET', pattern: '/api/approvals', ops: ['approvals.listPendingApprovals'] },
  { method: 'GET', pattern: '/api/approvals/all', ops: ['approvals.listAllApprovals'] },
  { method: 'GET', pattern: '/api/approvals/:approvalId', ops: ['approvals.getApproval'] },
  { method: 'GET', pattern: '/api/approvals/:approvalId/approved-items', ops: ['approvals.getApprovedItems'] },
  { method: 'GET', pattern: '/api/approvals/bug-fix-for-card/:bugCardId', ops: ['approvals.getBugFixForCard'] },
  { method: 'POST', pattern: '/api/approvals/:approvalId/write-set/fence', ops: ['approvals.writeSetFence'] },
  // A licence-ONLY read (approval-write-set.ts `licenceOnly`); the node exposes it as
  // approvals.getApprovalWriteSet since its regen from the served spec (2026-10-14).
  { method: 'GET', pattern: '/api/approvals/:approvalId/write-set', ops: ['approvals.getApprovalWriteSet'] },
  { method: 'POST', pattern: '/api/approvals/:approvalId/mint-design-units', ops: ['approvals.mintDesignUnits'] },
  {
    method: 'POST',
    pattern: '/api/execution/approvals',
    ops: ['approvals.createExecutionApproval', 'approvals.createExecutionApprovalSecret'],
  },
  { method: 'GET', pattern: '/api/execution/approvals/stranded', ops: ['approvals.listStrandedExecutionApprovals'] },
  { method: 'POST', pattern: '/api/webhooks/n8n/card-approval', ops: ['approvals.cardApproval'] },
  // ── metrics / identity ────────────────────────────────────────────────────
  { method: 'GET', pattern: '/api/projects/:projectId/metrics', ops: ['metrics.getProjectMetrics'] },
  { method: 'GET', pattern: '/api/metrics/aggregate', ops: ['metrics.getAggregateMetrics'] },
  { method: 'GET', pattern: '/api/auth/me', ops: ['auth.getCurrentUser'] },
  // ── cards / kanban ────────────────────────────────────────────────────────
  { method: 'GET', pattern: '/api/cards/:cardId', ops: ['cards.getCard', 'cards.getScenarioEvidence'] },
  { method: 'POST', pattern: '/api/cards/:cardId/scenario-evidence', ops: ['cards.addScenarioEvidence'] },
  { method: 'POST', pattern: '/api/cards/:cardId/scenarios/freeze', ops: ['cards.freezeScenarios'] },
  { method: 'POST', pattern: '/api/cards/:cardId/seeker-links', ops: ['cardSeekerLink.write'] },
  { method: 'POST', pattern: '/api/cards/improvement', ops: ['improvementCard.create'] },
  { method: 'POST', pattern: '/api/cards/project', ops: ['card.createFromProject'] },
  { method: 'POST', pattern: '/api/kanban/cards/:cardId/move', ops: ['kanban.moveCard'] },
  { method: 'POST', pattern: '/api/internal/cards/:cardId/computed-checks', ops: ['computedChecks.write'] },
  // ── decompositions / authoring / findings ─────────────────────────────────
  { method: 'POST', pattern: '/api/decompositions/commit', ops: ['decompositions.commitDecomposition'] },
  { method: 'POST', pattern: '/api/decompositions/split', ops: ['decompositions.splitDecomposition'] },
  { method: 'POST', pattern: '/api/asset-authoring/publish', ops: ['assetAuthoring.publish'] },
  { method: 'PUT', pattern: '/api/findings/suppressions', ops: ['findingSuppression.put'] },
  { method: 'GET', pattern: '/api/findings/suppressions', ops: ['findingSuppression.list'] },
  // ── the n8n system routes (licence door, G4/G5) ───────────────────────────
  {
    method: 'POST',
    pattern: '/api/webhooks/n8n/card-phase-lease',
    ops: [
      'cardPhaseLease.claim',
      'cardPhaseLease.verify',
      'cardPhaseLease.renew',
      'cardPhaseLease.release',
      'cardPhaseLease.releaseHolder',
      'cardPhaseLease.unwait',
    ],
  },
  { method: 'POST', pattern: '/api/webhooks/n8n/report', ops: ['report.persistBugReport'] },
  { method: 'POST', pattern: '/api/webhooks/n8n/plan-event', ops: ['planLedger.recordEvent'] },
  { method: 'POST', pattern: '/api/webhooks/n8n/executed-activity', ops: ['planLedger.recordActivity'] },
  // R311 PR 5 (kanban-coach-errors.md §2.5 / §4.1): the conveyor's two failure callbacks. Record-and-show
  // only — tenant-bound in the handler (the project is looked up inside the licence's tenant).
  { method: 'POST', pattern: '/api/webhooks/n8n/project-start-failed', ops: ['project.startFailed'] },
  { method: 'POST', pattern: '/api/webhooks/n8n/project-coach-failed', ops: ['project.coachFailed'] },
  // The project cord's read: the conveyor's andon gate reads it.
  { method: 'GET', pattern: '/api/projects/:id/andon', ops: ['projects.getProjectAndon'] },
  // The kata record (routes/katas.ts, George 2026-11-03): the coach opens a kata, the wf_change
  // flows on kata-n8n read and report it and close it. Only a CONVEYOR tenant's licence passes the
  // route's own caller check; the list, Stop and Rollback stay super-admin only (not listed).
  { method: 'GET', pattern: '/api/katas/:id', ops: ['katas.getKata'] },
  { method: 'POST', pattern: '/api/katas', ops: ['katas.openKata'] },
  { method: 'PATCH', pattern: '/api/katas/:id', ops: ['katas.updateKata'] },
  { method: 'POST', pattern: '/api/katas/:id/close', ops: ['katas.closeKata'] },
  { method: 'GET', pattern: '/api/reports', ops: ['report.listBugReportsForCard'] },
  { method: 'GET', pattern: '/api/reports/:reportId', ops: ['report.getBugReport'] },
  // George 2026-10-11 (R16): an APPEND-ONLY fix record for a bug_report (the bug_report row is
  // insert-once + content-hashed and is never mutated).
  { method: 'POST', pattern: '/api/reports/:reportId/fix', ops: ['report.markBugReportFixed'] },
  // ── notifications (George 2026-10-10) ─────────────────────────────────────
  // TENANT-BOUND in the handler (routes/notifications/dispatch.ts): a licence
  // may notify only a user of its own tenant, via that user's channel prefs.
  // The raw channel + address mode (paging an arbitrary chat id / number) is
  // 403 `licence_raw_address_forbidden` — that stays a SYSTEM power.
  { method: 'POST', pattern: '/api/notifications/dispatch', ops: ['notification.dispatch'] },
];

/**
 * Node ops whose route a licence may NOT call (403 `licence_route_not_allowed`).
 * Kept beside the allowlist so the pair is the node's whole route set (the test
 * asserts the two are disjoint and both resolve to registered routes).
 */
export const LICENCE_REFUSED_NODE_ROUTES: ReadonlyArray<{
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly pattern: string;
  readonly ops: readonly string[];
  readonly why: string;
}> = [
  { method: 'DELETE', pattern: '/api/projects/:id', ops: ['projects.deleteProject'], why: 'destructive: archive + PHI purge + board teardown + voids approvals' },
  { method: 'POST', pattern: '/api/projects/:id/repositories', ops: ['projects.attachProjectRepository'], why: 'repository binding is the MERGE anchor (assertLicencePrOnProjectRepo); owner/admin only' },
  { method: 'DELETE', pattern: '/api/projects/:id/repositories/:repo_id', ops: ['projects.detachProjectRepository'], why: 'destructive; repository binding' },
  { method: 'PUT', pattern: '/api/projects/:id/repositories/:repo_id/primary', ops: ['projects.promoteProjectRepository'], why: 're-points the MERGE anchor; owner/admin only' },
  { method: 'GET', pattern: '/api/secrets', ops: ['secrets.listSecrets'], why: 'credential store: admin surface' },
  { method: 'POST', pattern: '/api/secrets', ops: ['secrets.createSecret'], why: 'credential store: admin surface' },
  { method: 'PUT', pattern: '/api/secrets/:id', ops: ['secrets.updateSecret'], why: 'credential store: admin surface' },
  { method: 'DELETE', pattern: '/api/secrets/:id', ops: ['secrets.deleteSecret'], why: 'credential store: destructive' },
  { method: 'PUT', pattern: '/api/comments/:commentId', ops: ['comments.updateComment'], why: "edits a human's comment" },
  { method: 'DELETE', pattern: '/api/comments/:commentId', ops: ['comments.deleteComment'], why: 'destructive' },
  { method: 'PUT', pattern: '/api/approvals/:approvalId', ops: ['approvals.updateApproval'], why: 'DECIDES an approval: a licence never decides' },
  { method: 'POST', pattern: '/api/approvals/void', ops: ['approvals.voidApprovals'], why: 'VOIDS approvals: a licence never voids' },
  { method: 'DELETE', pattern: '/api/findings/suppressions', ops: ['findingSuppression.delete'], why: 'destructive' },
];

const COMPILED: ReadonlyArray<{ method: string; pattern: string; re: RegExp }> = LICENCE_ROUTE_ALLOWLIST.map((r) => ({
  method: r.method,
  pattern: r.pattern,
  re: compileRoutePattern(r.pattern),
}));
const ALLOWED_KEYS: ReadonlySet<string> = new Set(LICENCE_ROUTE_ALLOWLIST.map((r) => `${r.method} ${r.pattern}`));

/** True iff (method, registered route pattern) is on the allowlist. Exact compare. */
export function isLicenceRouteAllowed(method: string, routePattern: string): boolean {
  return ALLOWED_KEYS.has(`${method} ${routePattern}`);
}

// --- the route the router dispatched to (recorded by src/server.ts) ----------
const matchedRoutes = new WeakMap<Request, { method: string; pattern: string }>();

/** Called by src/server.ts with the pattern the router matched, before the handler runs. */
export function recordMatchedRoute(req: Request, method: string, pattern: string): void {
  matchedRoutes.set(req, { method, pattern });
}

function pathnameOf(req: Request): string | null {
  try {
    return new URL(req.url).pathname;
  } catch {
    return null;
  }
}

/** True iff this request may be served to a licence caller. */
export function isLicenceRequestAllowed(req: Request): boolean {
  const recorded = matchedRoutes.get(req);
  if (recorded) return recorded.method === req.method && isLicenceRouteAllowed(recorded.method, recorded.pattern);
  // Not dispatched by the router (direct handler call / pre-router path): match the
  // pathname with the router's own compiler — still only the listed routes.
  const pathname = pathnameOf(req);
  if (pathname === null) return false;
  return COMPILED.some((r) => r.method === req.method && r.re.test(pathname));
}

/** 403 `licence_route_not_allowed` unless the request's route is on the allowlist. */
export function assertLicenceRouteAllowed(req: Request): void {
  if (isLicenceRequestAllowed(req)) return;
  throw new ForbiddenError(
    `A licence token may not call ${req.method} ${pathnameOf(req) ?? '(unparseable url)'}: ` +
      'the licence (the conveyor seat) is limited to the n8n-nodes-fr route allowlist. Nothing was done',
  ).withCode(LICENCE_ROUTE_NOT_ALLOWED_CODE);
}

/**
 * The server-level check (src/server.ts, after routing, before the handler): a
 * request carrying a licence-SHAPED bearer is held to the allowlist even before
 * any handler authenticates it. Shape only — no introspection — so an invalid
 * licence on a listed route still gets the route's own 401; on an unlisted route
 * it is refused here. Skipped under AUTH_BYPASS (dev/CI only, refused on a
 * production-shaped boot), where `validateAuth` never yields a licence identity.
 */
export function assertLicenceBearerRouteAllowed(req: Request): void {
  if (process.env.AUTH_BYPASS === 'true') return;
  const header = req.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return;
  if (!isLicenceBearer(header.substring(7))) return;
  assertLicenceRouteAllowed(req);
}
