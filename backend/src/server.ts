// src/server.ts

// Global error handlers — MUST be first, before any imports that might throw
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

import {
  config,
  requireDatabaseUrl,
  validateConveyorStartWebhookConfig,
  validateN8nCallbackOriginsConfig,
  validateProductionConfig,
  superAdminSwitchConfigWarning,
} from './config';
import { assertPackInstructionsPresent } from './agent/packs';

// Fail fast in production if required secrets aren't wired through.
validateProductionConfig();
// The conveyor start webhook: inert (one log line) when its URL is unset; refuses
// to boot when the URL is set without its HMAC secret.
validateConveyorStartWebhookConfig();
validateN8nCallbackOriginsConfig();
assertPackInstructionsPresent();
import { Router } from './utils/router';
import { deriveRouter } from './capabilities/derive-router';
import { proposalIdOf, recordProposalExecution } from './services/capability-audit';
import { dispatchRouted } from './utils/routed-dispatch';
import { corsHeaders, handleCorsOptions } from './middleware/cors';
import { withUsageSpans } from './middleware/usage-spans';
import {
  buildRequestContext,
  withRequestContext,
  InvalidInitiatorError,
  requestContextRefusalResponse,
} from './middleware/request-context';
import { encryption } from './services/encryption';
import { openapiSpec } from './capabilities/served-spec';

// Import route handlers
// The last two routes/projects handlers the table named (DELETE + provision) are capability-derived
// (P4d-2e); the module stays loaded at boot, as before.
import './routes/projects';



import {
} from './routes/documents';

// The TOC and architecture route handlers (routes/assets/{toc,architecture}.ts)
// are bound by their capability declarations (P4a3, src/capabilities/library/*).



// The other nine /api/admin/pricing routes are capability-derived (P4c part 3,
// capabilities/admin/pricing.ts): deriveRouter below.

// The artifact routes are capability-derived (P4d-2e, capabilities/projects/artifacts.ts). The import
// STAYS for its side effect: the module registers the five AG-UI artifacts actions at load time.
import './routes/assets/artifacts';

// The Evidence Review passthrough rows are capability-derived (P4d-2e, capabilities/kag/reviews-passthrough.ts).
import './routes/assets/kag-reviews';

import {
  validateBroadcastWebSocketAuth,
  handleBroadcastMessage,
  handleBroadcastOpen,
  handleBroadcastClose,
  CODING_BROADCAST_WS_PATTERN,
} from './routes/coding/broadcastWebSocket';
import { extractWsBearerToken } from './utils/wsAuth';

import {
  registerKanbanSocket,
  unregisterKanbanSocket,
  handleKanbanInbound,
} from './routes/kanbanWebSocket';
import { authorizeKanbanWsUpgrade } from './routes/kanbanWsAuth';
import { bypassUser } from './middleware/auth';
import { reportApprovalsWsRefusal } from './lib/approvals-ws-refusal-metrics';
import { lookupApprovalsWsProject } from './lib/approvals-ws-project-tenant';
import { createKanbanWsTenantResolver } from './lib/kanban-ws-tenant-resolver';

// fr-agui P4d-2d: every /api/tools/* and /api/coding/* route is capability-derived; this import stays
// for its module-load order (the tools modules register AG-UI actions at load). See routes/tools/index.ts.
import './routes/tools/index';
import { handlePromMetrics } from './routes/metrics';
import { refreshAndonStateInitialisedGauge } from './lib/global-andon-gate';
import { startAnalyticsRollupWorker } from './workers/analytics-rollup';
import { startDocumentReconcileWorker } from './services/document-reconcile';
import { startScheduledTriggerTickWorker } from './workers/scheduled-trigger-tick';
import { startIdempotencySweepWorker } from './workers/idempotency-sweep';
import { startScheduledTriggerRunPruneWorker } from './workers/scheduled-trigger-run-prune';
import { startApprovalExpiryWorker } from './workers/approval-expiry';
import { startProjectRequestAnalysisTimeoutWorker } from './workers/project-request-analysis-timeout';
import { startProjectDeliveredReconcileWorker } from './workers/project-delivered-reconcile';
import { startMcpApprovalClosedWorker } from './workers/mcp-approval-closed';
import { startApprovalRedeliveryWorker } from './workers/approval-redelivery';
import { startSignupOnboardingTick } from './workers/signup-onboarding-tick';
import { logSignupTelegramStatus } from './services/signup/telegram';
import { logSignupAppsStatus } from './services/signup/config';
import { startDeblockRedeliveryWorker } from './workers/deblock-callback-redelivery';
import { startAcCoverageRedeliveryWorker } from './workers/ac-coverage-redelivery';
import { startWorkflowsCacheWorker } from './workers/workflows-cache';
import { FR_FEATURE_BRIDGE } from './config/feature-flags';
import { registerBridgeSources } from './domain/bridge/sources';




// scheduled triggers / reports and the suggestion-inbox actions are
// capability-derived (P4b part 2, capabilities/schedules/*).


// Plan 2 Wave 3 — asset-scope mutations (Task 11).


// Notification services
import { notificationService } from './domain/engagement/notifications';
import { telegramAdapter } from './domain/engagement/adapters/telegram';
import { mcpAdapter } from './domain/engagement/adapters/mcp';
import { teamsAdapter } from './domain/engagement/adapters/teams';
import { wsManager, type WsData } from './domain/engagement/adapters/websocket';
import { registerChannel as registerInboundChannel, listChannels as listInboundChannels } from './channels';
import { telegramChannel } from './channels/telegram';
import { webChannel } from './channels/web';
import { teamsChannel } from './channels/teams';
import { emailChannel } from './channels/email';
import { voiceChannel } from './channels/voice';
import { inappChannel } from './channels/inapp';
import { mcpChannel } from './channels/mcp';

// Static imports for services used in WS handlers and health checks
import { keycloak as kcService } from './services/keycloak';
import { redis } from './services/redis';
import { readinessVerdict, type DependencyStatus } from './lib/readiness';
import { requireFrLicense } from './lib/require-fr-license';
import { withSuperAdminWriteAudit } from './lib/super-admin-tenant-audit';
import {
  packageGateDecision,
  packageRequestView,
  servingAppKey,
  type AppKey,
  type PackageRequestView,
} from './lib/package-license-gate';
import { requireKagLicense } from './lib/require-kag-license';
import { getLicenseStatus } from './lib/license-status';
import { validateConnection, validateConnectionWithRetry, closeConnection } from './db/client';
import { applyMigrations } from './db/migration-runner';
import { logRegistrySummary } from './agui/registry';
import { reapStaleExecutingActions } from './domain/engagement/action-approvals';
import { runCoverageCheck } from './agui/coverage-check';
// AG-UI action registration is centralised in ./agui/register-all-actions
// (called once below, after the bridge commit route) — fr#1383.
import { registerAllActions } from './agui/register-all-actions';
import { setProjectMembershipProvider } from './agui/rbac';
import { tenantMemberProjectMembershipProvider } from './agui/tenant-member-provider';

// Fail fast if required Planka credentials are missing outside AUTH_BYPASS dev mode.
if (process.env.AUTH_BYPASS !== 'true') {
  if (!config.services.planka.password) {
    throw new Error('PLANKA_AGENT_PASSWORD is not set. Refusing to start.');
  }
  // Artifacts download tokens are HMAC-signed; without a key the mint/resolve
  // path cannot operate. Required outside AUTH_BYPASS so dev/CI smoke runs
  // don't trip on a missing secret.
  if (!config.services.artifacts.downloadSigningKey) {
    throw new Error('ARTIFACTS_DOWNLOAD_SIGNING_KEY is not set. Refusing to start.');
  }
  // n8n observability slice — the Public API requires X-N8N-API-KEY. Without
  // it the n8n routes can't list workflows/executions; fail fast at boot.
  // Reject placeholder values too — a non-empty placeholder satisfied the bare
  // truthy check and let the pod boot half-broken (see fr/api/auth/me 401 loop
  // root cause, gitops 33ac5f8a). Webhook secret is also rejected because
  // a placeholder there silently breaks every n8n→fr callback.
  if (!config.services.n8n.apiKey || config.services.n8n.apiKey.startsWith('placeholder-')) {
    throw new Error('N8N_API_KEY is not set (or still a placeholder). Refusing to start.');
  }
  if (config.services.n8n.webhookSecret.startsWith('placeholder-')) {
    throw new Error('N8N_WEBHOOK_SECRET is still a placeholder. Refusing to start.');
  }
}

// Initialize encryption service
try {
  await encryption.initialize();
  console.log('Encryption service initialized');
} catch (err) {
  console.error('[FATAL] Encryption initialization failed:', err);
  process.exit(1);
}

// ⛔ No default DSN (George ruling 2026-10-21). Fail fast, before the retry loop below would
// spend ~15s retrying a configuration error that no retry can fix.
try {
  requireDatabaseUrl();
} catch (err) {
  console.error('[FATAL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Validate database connectivity. Bounded retry (~15s total) because pgbouncer
// is not guaranteed to be answering the instant this container starts — see
// validateConnectionWithRetry. An unreachable database still fails boot.
try {
  await validateConnectionWithRetry({
    onRetry: (attempt, err) =>
      console.warn(
        `[boot] database not reachable (attempt ${attempt}), retrying:`,
        err instanceof Error ? err.message : String(err),
      ),
  });
  console.log('Database connection validated');
} catch (err) {
  console.error('[FATAL] Database connection failed:', err);
  process.exit(1);
}

// Apply pending SQL migrations from backend/migrations/*.sql.
// See src/db/migration-runner.ts for semantics (advisory lock, backfill, etc.).
try {
  await applyMigrations(config.database.url);
} catch (err) {
  console.error('[FATAL] Schema migration failed:', err);
  process.exit(1);
}

// ⛔ NOTHING SEEDS AN ASSET AT BOOT HERE, AND NOTHING MAY BE ADDED THAT DOES.
// `void seedPromptProceduresOnBoot()` used to sit on this line. It wrote three
// `prompt_*.doing.action` procedure bodies from a spec HARDCODED in this repo
// (`scripts/seed-prompt-procedures.ts :: PROMPT_PROCEDURES`) on every boot.
//
// WHY IT IS GONE (#1246). Procedures and prompts are ASSETS with a current
// version, continuously improved by dedicated improvement projects; execution
// projects read whatever the current version is AT DISPATCH TIME. There is no
// "base" or "default" procedure for a boot path to restore. So a boot seeder is
// a SECOND AUTHOR competing with the improvement loop, asserting a snapshot that
// is older than the current version BY CONSTRUCTION. Measured 2026-09-04: it reverted converged bodies on every
// boot, versions climbing 794 -> 803, re-blocking every card of those types on
// `procedure_body_missing`.
//
// The WORK-STEP FLOOR that followed made the revert less likely, not impossible,
// and an env gate would not have helped either: the production pod carries no
// `SEED_PROMPT_PROCEDURES_ON_BOOT` key among its 85 env vars, so a
// default-on flag leaves it ON. Removal is the fix.
//
// (`scripts/seed-prompt-procedures.ts` itself was deleted 2026-11-03 with the
// prompt-improvement tenant it seeded.) A human choosing to write a body is
// legitimate; a server doing it unbidden on every restart is not.
// Guarded by `tests/unit/server-no-boot-seeding.test.ts`, which reads THIS file.

// Register notification channels
notificationService.registerChannel(wsManager);
if (config.services.teams.enabled) {
  notificationService.registerChannel(teamsAdapter);
}
// Telegram self-gates on enabled + a bot token.
if (config.services.telegram.enabled && config.services.telegram.botToken) {
  notificationService.registerChannel(telegramAdapter);
}
// The MCP server is one more channel (channels/mcp.ts), on by default like the web app.
notificationService.registerChannel(mcpAdapter);

// Register inbound channel adapters (E-7). The dispatcher is gated by env
// `CHANNEL_DISPATCH_ENABLED` (default false), read ONCE at module load in
// src/channels/index.ts — changing it takes a restart. Registration is
// unconditional; with the flag off, the registered adapters are not dispatched.
// Telegram inbound: registered unconditionally; outbound replies
// self-gate on the bot token inside telegramAdapter.sendMessage.
registerInboundChannel(telegramChannel);
registerInboundChannel(webChannel);
if (config.services.teams.enabled) {
  registerInboundChannel(teamsChannel);
}
// E-10: email + voice (stub) + in-app channel adapters. Voice/inapp register
// unconditionally (voice yields voice-not-implemented; inapp uses the always-
// required DB pool). Email gates on FR_EMAIL_API_URL+FR_EMAIL_API_KEY in its
// own adapter — registration is harmless when disabled.
registerInboundChannel(emailChannel);
registerInboundChannel(voiceChannel);
registerInboundChannel(inappChannel);
registerInboundChannel(mcpChannel);
{
  const names = listInboundChannels().map((c) => c.name).join(', ');
  console.log(`[channels] registered: ${names} (count=${listInboundChannels().length})`);
}

// Three-layer intent resolver chain (CommandGrammar → LLM → Heuristic):
//   1. CommandGrammarIntentResolver — deterministic verb fast-path
//      (APPROVE/REJECT/STATUS/HELP/START/CARD/COMMENT). Free / fast. Replies to an
//      approval (`1`, `yes`, `approve: …`) never get here: the shared reply flow
//      (channel-reply.ts runChannelTurn) reads them first on every channel.
//   2. LLMIntentResolver — free-text routing via the worker_management
//      `signal-intent-resolver` worker. Falls back on LLM error / low
//      confidence / unregistered action picked by the LLM.
//   3. HeuristicIntentResolver — last-resort regex direct invocation
//      `<tool>.<verb_noun> {...json}` for power users; otherwise emits
//      a friendly "I didn't recognize that as an action" reply.
{
  const { setIntentResolver, HeuristicIntentResolver } = await import('./agent-core');
  const { CommandGrammarIntentResolver } = await import(
    './domain/engagement/command-grammar'
  );
  const { LLMIntentResolver, makeProductionLLMClient } = await import(
    './agent-core/llm-resolver'
  );
  const { sendWorkerMessage } = await import('./integrations/workers');
  const llmClient = makeProductionLLMClient(sendWorkerMessage);
  const heuristic = new HeuristicIntentResolver();
  const llm = new LLMIntentResolver(heuristic, llmClient);
  setIntentResolver(new CommandGrammarIntentResolver(llm));
  console.log(
    '[agent-core] CommandGrammarIntentResolver(LLMIntentResolver(HeuristicIntentResolver)) installed',
  );
}

// Create router
const router = new Router();

// Projects routes
// POST /api/projects (projects.create), GET /api/projects (projects.list) and
// GET /api/projects/:id (projects.get) are capability-derived: see deriveRouter below.
// POST /api/projects/constraint-check is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// The campaign governance kill-switch (GET / POST /api/admin/campaigns/kill-switch) is DELETED
// (fr-agui P4d-2d, George): its only reader, POST /api/projects/bulk, went in P4d-2a.
// PATCH /api/projects/:id is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// DELETE /api/projects/:id is capability-derived (P4d-2e, capabilities/projects/project-frozen.ts): deriveRouter below.
// GET /api/projects/:id/cockpit is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// GET /api/projects/:id/status is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// GET /api/projects/:id/phase is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// P0..P3 card priority edit, audited (lib/priority-change.ts).
// PATCH /api/projects/:projectId/cards/:cardId/priority is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// GET /api/projects/:id/brief is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// The brief's RM versions (rm#213): newest-first list + one snapshot.
// GET /api/projects/:id/brief/versions is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// GET /api/projects/:id/brief/versions/:version is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// R271: the PM's capability selection (rm#225) + its history — READ-ONLY, fr never writes it.
// GET /api/projects/:id/capabilities is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// POST /api/projects/:id/provision is capability-derived (P4d-2e, capabilities/projects/project-routes.ts): deriveRouter below.

// Project Quality tab (fr#1305) — stored quality result + CI per repo, and an
// explicit analyze that ensures a workspace first. routes/project-quality.ts.
// Router patterns are ^…$-anchored, so the order of these three is irrelevant.
// GET /api/projects/:id/quality[/history] are capability-derived (P2-c1,
// capabilities/projects/quality-people.ts): deriveRouter below.
// POST /api/projects/:id/quality/analyze is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.

// Multi-repo per project — task #25 scope B PR 2 (migration 072).
// GET /api/projects/:id/repositories is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// POST /api/projects/:id/repositories is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// DELETE /api/projects/:id/repositories/:repo_id is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// PUT /api/projects/:id/repositories/:repo_id/primary is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.

// Project requests — the CP→fr bridge RECEIVING half (migration 073). POST is
// the SA-authed bridge intake (draft only, no Planka/n8n); the rest are the
// user-authed, tenant-scoped human review/approve surface (approve runs the
// shared createProjectCore → a real project + n8n). See routes/project-requests.ts.
// POST /api/project-requests is capability-derived (P1b): deriveRouter below.
// POST /api/project-requests/draft-from-text is capability-derived (P1b): deriveRouter below.
// ADVISORY repo-readability check for the request form — never gates submit
// (routes/project-request-repo-access.ts). A literal path, registered before
// the :id routes so it cannot be captured as an id.
// POST /api/project-requests/verify-repo-access is capability-derived (P1b): deriveRouter below.
// GET /api/project-requests is capability-derived (P1b): deriveRouter below.
// GET /api/project-requests/:id is capability-derived (P1b): deriveRouter below.
// PATCH /api/project-requests/:id is capability-derived (P1b): deriveRouter below.
// POST /api/project-requests/:id/approve is capability-derived (P1b): deriveRouter below.
// POST /api/project-requests/:id/reject is capability-derived (P1b): deriveRouter below.
// Two-stage lifecycle (migration 123): submit -> agent outline -> human decides
// the outline through the ORDINARY approvals queue -> project.
// POST /api/project-requests/:id/submit is capability-derived (P1b): deriveRouter below.
// The requester takes their own request back (migration 123's `withdrawn`,
// which until now nothing could reach). Requester-only, terminal, and it
// supersedes + voids any outline approval still in flight.
// POST /api/project-requests/:id/withdraw is capability-derived (P1b): deriveRouter below.
// GET /api/project-requests/:id/outlines is capability-derived (P1b): deriveRouter below.
// Inbound from n8n. X-Webhook-Secret only, like every /api/webhooks/n8n/* route.
// POST /api/webhooks/n8n/project-request-outline/:id is capability-derived (P1b): deriveRouter below.

// Secrets routes (local FR database)
// GET /api/secrets is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// POST /api/secrets is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// PUT /api/secrets/:id is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// DELETE /api/secrets/:id is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.

// The repositories catalogue (/api/repositories, 5 routes) is capability-derived
// (P4b part 3, capabilities/account/repositories.ts): deriveRouter below.

// Requirement assets routes
// GET /api/assets/_assignments is capability-derived (P4c part 1, capabilities/observe/asset-assignments.ts): deriveRouter below.
// GET /api/assets/requirements/search is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/requirements is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// POST /api/assets/requirements is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/requirements/:rid is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// PUT /api/assets/requirements/:rid is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// DELETE /api/assets/requirements/:rid is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.

// Architecture assets (Phase 4 read + Phase 5 CRUD). NOT to be confused with
// the code-graph route /api/architecture/graph/:container registered later.
// Relationships are immutable upstream → create + delete only, no PUT.
// The 19 /api/assets/architecture rows are capability-derived (P4a3,
// src/capabilities/library/architecture.ts): deriveRouter below.

// Project-management assets (Phase 4 read + Phase 5 CRUD). Core set:
// programmes / projects / activities / risks (full CRUD on all four).

// Principle assets routes
// GET /api/assets/principles/search is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/principles is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// POST /api/assets/principles is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/principles/:pid/versions is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/principles/:pid is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// PUT /api/assets/principles/:pid is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// DELETE /api/assets/principles/:pid is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.

// Library — asset authoring and the shared library reads.

// AA ready-prefetch policy gate — the approve→resume half. n8n POSTs here
// (X-Webhook-Secret auth) when a card is parked in BLOCKED awaiting a human
// execution sign-off. fr resolves the project's execution_signoff approvers
// from project_stakeholders, creates an `execution.ready_signoff` approval,
// and fans out per-channel. The standard PUT /api/approvals/:id handles the
// decision → execution-ready-signoff-callback receiver moves the card back.
import {
} from './routes/execution-approvals';
// POST /api/execution/approvals is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// Operator view: cards blocked on a sign-off that can never be granted, plus
// approvals that timed out. Super-admin only (cross-tenant diagnostics; an
// unresolvable project has no tenant to scope by). Distinct method+path from
// the POST above, so no route-ordering hazard.
// GET /api/execution/approvals/stranded is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.

// AA Card Substrate Phase 6 — POST /api/cards/improvement validation gate.
// Accepts a fully-qualified card_generation_request body, maps it to the 8
// AA-spec customFieldGroups, and creates the Planka card via the unified
// helper. Internal-tenant only.
// POST /api/cards/improvement is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// EXEC `it` pipeline — POST /api/cards/project spawns the next card in a
// project's card-type chain (project_start_request_analysis → project_setup →
// development_chore → project_closure). Called by every DONE-phase workflow.
// POST /api/cards/project is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// Finding suppression ledger (migration 130) — a fingerprint a human/QA marked
// false-positive; POST /api/cards/project refuses to re-create it. Same auth +
// tenant scope as POST /api/cards/project. DELETE (migration 132) and a
// security-category PUT additionally need the project owner or a super_admin.
// PUT /api/findings/suppressions is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.
// GET /api/findings/suppressions is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.
// DELETE /api/findings/suppressions is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// Plan 6 Wave D — n8n ActionWriteSeekerLinks step writes the KAG
// entity-list discovered during READYING into card_seeker_links so
// GET /api/cards/:id can surface the Seeker half of the compounding-
// memory loop. Idempotent on (card_id, kag_entity_id).
// POST /api/cards/:cardId/seeker-links is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// G-26 gap A — bug_analysis appends its repro tests (gherkin_scenarios entries +
// test_file_content) to an EXISTING card: write-once per (card, scenario_id) in
// card_scenario_evidence (migration 154), the evidence-stripped pointer appended
// to the card document. Tenant from the principal only; same principals as POST
// /api/cards/project. n8n node op: fr:cards.addScenarioEvidence.
// POST /api/cards/:cardId/scenario-evidence is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// READY's freeze (r.ready.scenarios): author gherkin onto the card's stored
// skeleton and stamp scenarios_check.scenario_hash (recomputed, never trusted).
// READY list only; same tenancy/card gate and the SAME per-card lease as
// scenario-evidence (both rewrite the description).
// POST /api/cards/:cardId/scenarios/freeze is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// Plan 6 W-1 — read-only proxy over the AA card_type_descriptions catalog.
// Used by the /cards/[id] page to render the card-type protocol expander
// (readying/doing/qa/done protocol arrays + blocked_conditions). Universal
// catalog, no tenant scope.
// GET /api/card-types[/:cardType] are capability-derived (P4c part 1, capabilities/observe/card-types.ts): deriveRouter below.

// fr#1477 — read-only conveyor taxonomy catalogue (phases, capabilities,
// concerns, card-type placement) for the /library/conveyor map. Same guard as
// the card-type catalogue; `?template=` is platform-tenant only.
// GET /api/conveyor/taxonomy is capability-derived (P4a3): deriveRouter below.

// Tenant PM catalogue — a facilitator proxy over requirements_management
// (`integrations/pm-catalogue.ts`). Reads: any authenticated caller in their
// tenant; writes + import-defaults: tenant admin. RM validates; its 4xx passes
// through. ⚠️ ORDER MATTERS (first match wins): the fixed-segment routes are
// registered BEFORE the generic `:resource` ones they would otherwise collide
// with (`import-defaults` vs POST `:resource`, `wip-limits/resolve` vs GET
// `:resource/:id`).
// GET /api/conveyor/project-types is capability-derived (conveyor.list_project_types).
// GET /api/conveyor/priority-levels stays here: `conveyor.list_priority_levels` is a doorway
// agent action (agui/actions/projects-create.ts); re-expressing it is the doorway's change.
// GET /api/conveyor/priority-levels is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// The 11 /api/conveyor/catalogue/* rows are capability-derived (P4a3,
// src/capabilities/conveyor/catalogue.ts): deriveRouter below. Their order (import-defaults /
// enums / wip-limits/resolve before the generic `:resource` rows) is the pinned
// overlap pairs (src/capabilities/route-overlap-pairs.json).

// GET /api/tenants/me was removed in fr-agui P4d-1 (OQ-5 D2): superseded by the
// /api/me/* workspace reads; no frontend or n8n caller.

// Plan 6 W-1 — single-round-trip card detail for the /cards/[id] page.
// Returns the Planka card + its 8 AA customFieldGroups normalised. See routes/cards/get.ts for the response shape.
// GET /api/cards/:cardId is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// fr#1138 — which repository does this card's work belong to, computed from the
// card, its board, and (last, as an inference) its `parent_card` ancestry. A
// card that genuinely cannot resolve one answers 200 with `resolved: false` and
// a named reason rather than a blank. Deliberately NOT folded into the card
// detail above: the walk is up to 40 upstream hops. See routes/cards/repository.ts.
// GET /api/cards/:cardId/repository is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// U11 — the plan pinned at mint (migration 148, card_plan_pins) and the D2
// conformance read model over pin + plan events + executed activities. Both are
// tenant-predicated in the query: a card pinned under another tenant is a 404 /
// `unproven`, never a 403. See routes/cards/plan-pin.ts.
// GET /api/cards/:cardId/plan-pin is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.
// GET /api/cards/:cardId/plan-conformance is capability-derived (P4d-2a part 2, capabilities/cards/cards.ts): deriveRouter below.

// Roadmap B1 — split-family contract substrate (migration 128;
// split-coherence-design.md §3.2/§5/§6). Tenant-scoped by
// decompositions.tenant_id; a family in another tenant is a 404. The decision
// claim is atomic (partial unique index) — see
// services/decomposition/family-decisions.ts.
// POST /api/decompositions/:familyId/decisions is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// GET /api/decompositions/:familyId/decisions is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// PUT /api/decompositions/:familyId/bundle is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// GET /api/decompositions/:familyId/bundle is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.

// C1-58 — the PM execution-card minter. Same auth + tenant scope as
// POST /api/cards/project (NOT the family-writer gate above): the machine read of
// a project's approved deliverables, and the commit that records one family and
// mints one TODO card per deliverable. See routes/decomposition-commit.ts.
// GET /api/projects/:id/deliverables is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// POST /api/decompositions/commit is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// U-PS-COMMIT — a deferred deliverable's minter reports its last create (once,
// idempotent). Same front door as the commit. See routes/deliverable-minted.ts.
// POST /api/projects/:id/deliverables/:did/minted is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// fr#1482 (U-TX-API-PLAN): the per-project plan read model (computed phase exit facts).
// GET /api/projects/:id/plan is capability-derived (P4d-2a part 2, capabilities/projects/project-frozen.ts): deriveRouter below.
// ncn#1960 — the Readying split: one family per parent card, 2..5 child cards
// minted through the same path as the commit above (never Planka-direct).
// Same auth + tenant scope. See routes/decomposition-split.ts.
// POST /api/decompositions/split is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.
// GET /api/cards/:cardId/contract is capability-derived (P4d-2a part 2, capabilities/decompositions/decompositions.ts): deriveRouter below.

// Plan 7 Stage 2.2 — POST /api/asset-authoring/publish dispatcher.
// LLM workers for principle/requirement/decision development streams emit a
// card_type-tagged envelope; this route validates the payload against the
// matching zod patch schema and dispatches to createPrinciple /
// createRequirement / createDecision in src/integrations/.
// POST /api/asset-authoring/publish is capability-derived (P4d-2c, capabilities/library/asset-authoring.ts): deriveRouter below.

// Library asset list aliases — Phase B (Foundation Plan 2 Tasks 14-15).
// Frontend `/library/[type]` + `/projects/[id]/knowledge` hit these for
// the 4 asset types whose canonical surface lives elsewhere (n8n,
// /api/scheduled-triggers, /api/channels, KAG service).
// GET /api/assets/workflows is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// GET /api/assets/triggers is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.

// Workflows Viewer (read-only n8n browser surface) — distinct from
// /api/assets/workflows (Library asset list, projected to {id,title} +
// scoped via asset_assignments). The viewer carries the full workflow
// JSON for the Svelte Flow renderer and a tag-tree for navigation.
// Spec: docs/superpowers/plans/2026-05-09-workflows-viewer.md.
// Note the route order: `/tags` MUST precede `/:id` so the static path
// wins over the parameterised one.
// GET /api/workflows, /api/workflows/tags and /api/workflows/:id are
// capability-derived (P4b part 2, capabilities/operate/workflows.ts): deriveRouter below.
// GET /api/assets/channels is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// GET /api/assets/kag-documents is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.

// Asset quality history — requirements_management's append-only evaluation log
// (`:kind` = principle|decision|architectureElement|architectureView|risk).
// Tenant surface (authenticated user, request tenant); see routes/assets/quality-history.ts.
// GET /api/assets/:kind/:id/quality/history is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.

// Decision assets routes
// GET /api/assets/decisions/search is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/decisions is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// POST /api/assets/decisions is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/decisions/:did/versions is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// GET /api/assets/decisions/:did is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// PUT /api/assets/decisions/:did is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.
// DELETE /api/assets/decisions/:did is capability-derived (P4d-2c, capabilities/library/governed-assets.ts): deriveRouter below.

// Theory-of-Constraints (TOC) asset routes. Order matters: `config` and the
// collection paths are registered BEFORE the `:treeId` wildcard so a literal
// `/toc/config` is never swallowed by the `([^/]+)` tree-id capture. The
// `/:treeId/{graph,quality,nodes,edges}` subpaths are `$`-anchored so they
// never collide with the bare `/:treeId` detail routes regardless of order.
// The 16 /api/assets/toc rows are capability-derived (P4a3, src/capabilities/library/toc.ts):
// deriveRouter below. `config` before `:treeId` is a pinned overlap pair.

// Kanban asset routes (/api/assets/kanban/*, the super_admin Planka passthrough) are
// capability-derived (P4d-2b, capabilities/kanban/assets.ts): deriveRouter below.

// Secrets asset routes — thin adapter over secrets-service (@fr/service-client-secrets).
// Scope: list/get/create only. No delete verb (per Phase 3 plan — too destructive
// without a dedicated workflow). Update/rotate/cleanup intentionally omitted.
// GET/POST /api/assets/secrets and GET /api/assets/secrets/:secretId are
// capability-derived (P4b, capabilities/settings/secrets.ts): deriveRouter below.

// Workers asset surface — the bespoke /workers UI calls these directly.
// ORDER MATTERS: '/providers' literal must precede '/:name' so the param
// route doesn't shadow the providers endpoint.
// The nine /api/assets/workers routes are capability-derived (P4b part 2,
// capabilities/operate/workers.ts): deriveRouter below; the order between them
// (and against the legacy /api/assets/* rows) is kept by the pinned overlap pairs.
// /chat/completions is the only workers route that does NOT key by
// worker name — the handler routes on `provider` + `model` in the body
// (see handleWorkerChatCompletions). The previous `:name/chat/completions`
// registration meant every send from /chat 404'd because the frontend
// has always sent /api/assets/workers/chat/completions (no name).

// Per-tenant BYO LLM provider settings (workspace-admin | super-admin gated at
// the handler). Proxies worker_management /tenant-config/llm via the workers
// integration. GET .../all, GET .../catalog and GET/PUT/DELETE the bare path are
// capability-derived (P4b, capabilities/settings/llm-provider.ts): deriveRouter below.
// None is in a pinned overlap pair (no `:param`, so no pattern overlaps another).
// POST /api/settings/llm-provider/test is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// GET /api/settings/llm-provider/audit is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.

// Owner (super-admin) sets a CUSTOMER tenant's BYO LLM provider — same proxy
// bodies, target tenant named in the path. Gate + 404 at the handler
// (routes/admin/tenant-llm-provider.ts). Specific sub-paths before the bare one.
// Super-admin: seed a NAMED tenant's PM catalogue from RM defaults — the remedy
// for `catalogue_not_initialised` (services/catalogue/tenant-catalogue.ts).
// POST /api/admin/tenants/:tenantId/catalogue/import-defaults is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// GET /api/admin/tenants/:tenantId/llm-provider/all is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// GET /api/admin/tenants/:tenantId/llm-provider/catalog is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// POST /api/admin/tenants/:tenantId/llm-provider/test is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// GET /api/admin/tenants/:tenantId/llm-provider/audit is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// GET /api/admin/tenants/:tenantId/llm-provider is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// PUT /api/admin/tenants/:tenantId/llm-provider is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// DELETE /api/admin/tenants/:tenantId/llm-provider is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.

// Owner (super-admin) per-tenant INFERENCE (PLAN tenant-inference-provisioning
// §2.6): flags probe, IR policy read, edit via provisioning apply, version
// activate. Gate + 404 (flag off / unknown tenant) at the handler
// (routes/admin/tenant-inference.ts).
// GET /api/admin/inference/config is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// GET /api/admin/tenants/:tenantId/inference-policy is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// POST /api/admin/tenants/:tenantId/inference-policy/activate is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// POST /api/admin/tenants/:tenantId/inference/apply is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.

// Super-admin pricing management (proxies billing provider_pricing + markup_rules).
// provider-pricing, markup-rules, markup-config, access-charges and tenant-config/:tenantId
// are capability-derived (P4c part 3, capabilities/admin/pricing.ts): deriveRouter below.
// GET /api/admin/pricing/fx-rates is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.
// PUT /api/admin/pricing/fx-rates is capability-derived (P4d-2d, capabilities/platform/admin-frozen.ts): deriveRouter below.

// Artifacts asset routes (list, manifest, download, preview, review, reviews, get) are capability-derived
// (P4d-2e, capabilities/projects/artifacts.ts; the download-token mint since P2-c2): deriveRouter below.
// Their order against the bare :id row is the pinned overlap pairs'.

// Asset bindings (cross-kind project scope). Bindings are the authoritative
// project-scope source for n8n; tenant-wide assets without bindings are
// out of scope for any specific project. See
// ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase A).
// POST /api/assets/:kind/:id/bindings is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// GET /api/assets/:kind/:id/bindings is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// DELETE /api/assets/:kind/:id/bindings/:project_id is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// GET /api/projects/:project_id/asset-bindings is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.

// Internal asset-authoring endpoint hit by n8n custom nodes. Creates
// the upstream asset with workflow provenance + auto-binds to the
// project. Gated by the `workflow-runner` Keycloak role (Phase F of
// the asset-bindings plan).
// POST /api/internal/assets/requirement is capability-derived (P1b): deriveRouter below.
// POST /api/internal/assets/principle is capability-derived (P1b): deriveRouter below.
// POST /api/internal/assets/decision is capability-derived (P1b): deriveRouter below.
// POST /api/internal/assets/trigger is capability-derived (P1b): deriveRouter below.
// POST /api/internal/assets/channel is capability-derived (P1b): deriveRouter below.

// The /api/tools/* routes (n8n executions, coding jobs, kanban liveness, KAG ingestion, analytics)
// and the /api/coding/* spine are capability-derived (fr-agui P4d-2d: capabilities/platform/{coding,inbound}.ts;
// earlier units the rest): deriveRouter below. capabilities/platform/coding.ts is the SOLE
// declarer of /api/coding/*.

// Bridge slice (analysis-to-kanban). Source descriptors register
// unconditionally (harmless map inserts); HTTP routes mount only when
// FR_FEATURE_BRIDGE is on. AG-UI action registration is UNCONDITIONAL so the
// agent + GET /api/agui/actions catalog can discover bridge.* actions even
// while the HTTP routes are flagged off — actions invoked through the AG-UI
// surface still go through the same approval pipeline, so flag-gating action
// registration would silently break agent-driven flows. Spec:
//   docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md
//     §"Agent-callable actions" — table of bridge.* actions to register.
registerBridgeSources();
// The ten /api/tools/bridge/* routes are capability-derived (fr-agui P4b part 3,
// capabilities/tools/bridge.ts): deriveRouter below. Rollback safety: the commit
// route mounts unconditionally so in-flight approvals
// (callback_path = /tools/bridge/drafts/:id/commit) still resolve after
// FR_FEATURE_BRIDGE flips off; otherwise pending cards 404 forever. The other
// nine mount only with the flag on (`http.mountedWhen`).
// EVERY AG-UI action module — the agui/actions/* files AND the route modules
// that register actions at import time (routes/tools/{kag,coding,analytics,
// kanban}, routes/assets/artifacts) — is registered through this ONE call.
// The keep-out test (tests/unit/agent/tool-catalog-schema.test.ts) calls the
// same function, so it sees exactly the registry production builds (fr#1383).
// Bridge actions register here UNCONDITIONALLY, independent of
// FR_FEATURE_BRIDGE (see register-all-actions.ts).
await registerAllActions();
// fr-agui P1-TEAM-a (George 2026-10-15): the production project-membership
// provider — every member of a tenant is a member (editor) of every project
// tagged for that tenant. Without it agui/rbac.ts denies EVERY `project-member`
// / `project-role` action `rbac_provider_not_registered`, the owner included.
setProjectMembershipProvider(tenantMemberProjectMembershipProvider);
if (FR_FEATURE_BRIDGE) {
  console.log('[bridge] FR_FEATURE_BRIDGE=true — routes mounted; AG-UI actions registered');
} else {
  console.log('[bridge] FR_FEATURE_BRIDGE off — only commit route + AG-UI actions registered');
}

// KAG asset routes (`/api/assets/kag/*`). fr-agui P4a1: every route of this
// surface except the two below is capability-derived — declared in
// src/capabilities/kag/assets.ts and registered by deriveRouter at the end of
// this table.

// Evidence Review 8810 (ER-001..005) through the kag `/reviews` gateway prefix — a byte-level
// passthrough (routes/assets/kag-reviews.ts), five methods over `/api/assets/kag/reviews(.*)`: registry
// rows since P4d-2e (capabilities/kag/reviews-passthrough.ts, `http.specExempt`: routed, no spec
// operation), placed by deriveRouter below.
// Project KAG documents — reserved for fr-agui P2 (project documents), so still
// legacy rows: the list honours `project_id` (effective-query + project-scope
// headers); the delete is by graph-node id, tenant-scoped upstream.
// GET /api/assets/kag/documents is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// DELETE /api/assets/kag/documents/:nodeId is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.

// Research workspace (`/api/research/discover/*`, `/api/research/scientific/*`)
// and Media Discovery (`/api/research/media/*`) — fr-agui P4a2: every route is
// capability-derived, declared in src/capabilities/research/{discover,scientific,media}.ts
// (each keeps its handler from routes/research/*) and registered by deriveRouter
// at the end of this table. None of these rows is in a pinned overlap pair.

// URL Credentials routes (external Secrets API) — /api/url-credentials[/:id] are
// capability-derived (P4b, capabilities/settings/url-credentials.ts): deriveRouter below.

// POST /api/scrape/url was removed in fr-agui P4d-1 (OQ-5 D3): it duplicated
// POST /api/tools/kag/scrape/url (kag.scrape_url, capability-derived).

// Documents routes
// GET /api/documents is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// POST /api/documents/upload is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// GET /api/documents/:id/status is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// DELETE /api/documents/:id is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// GET /api/projects/:id/documents is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.

// Auth routes
// GET /api/auth/me is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// NOTE: GET /api/licenses/user/:userId is deliberately NOT registered. It was a
// proxy whose upstream URL was derived by string-replacing 'secrets' in the
// SECRETS_API_URL, which resolved to a host that does not exist — so its bare
// `catch` fabricated an active 'free' licence on every production request. The
// SPA reads GET /api/license/status (lib/license-status.ts) instead. Absence is
// asserted by tests/integration/prod-boot-shape.integration.test.ts.

// Approvals routes
// GET /api/projects/:projectId/approvals is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// POST /api/projects/:projectId/approvals is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// Top-level GET /api/approvals (and ?mine=1) MUST be registered before
// the parameterized /api/approvals/:approvalId so the static path wins.
// See routes/approvals.ts handleListMyApprovals for the mine=1 contract.
// GET /api/approvals is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// Static /all before the parameterized :approvalId so it isn't captured as an id.
// GET /api/approvals/all is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// U3 — the one bug-fix authorization for a BUG card (ncn). X-Webhook-Secret ONLY, `tenant_id`
// query param required; static segment registered before the parameterized :approvalId.
// GET /api/approvals/bug-fix-for-card/:bugCardId is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// GET /api/approvals/:approvalId is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// GET /api/approvals/:approvalId/document is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// U3 — resolved APPROVED items of a decided bug_fix / feature_design approval (movies-db consumers).
// GET /api/approvals/:approvalId/approved-items is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// U4 — the approved, sealed write set of a PR-bearing proof card (ncn fence + landing gate).
// X-Webhook-Secret ONLY, `tenant_id` query param required.
// GET /api/approvals/:approvalId/write-set is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// U4 — PR-LESS fence: the caller's change set vs that sealed write set (evaluateWriteSetFence).
// Same door + tenant rule as the GET; `tenant_id` in the JSON body. Read-only.
// POST /api/approvals/:approvalId/write-set/fence is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// P2.3 step 3 (C1-59) — mint one dev card per unit of a decided A3's handoff.v2 contract.
// Bearer, EXEC tenant only; idempotent on a3:<approval id>:<unit_key>. Computed, never a hook.
// POST /api/approvals/:approvalId/mint-design-units is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.
// PUT /api/approvals/:approvalId is capability-derived (approvals.decide): deriveRouter below.
// POST /api/approvals/void is capability-derived (P4d-2a, capabilities/approvals/approvals.ts): deriveRouter below.

// Comments routes
// GET /api/projects/:projectId/comments is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// POST /api/projects/:projectId/comments is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// PUT /api/comments/:commentId is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// DELETE /api/comments/:commentId is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.

// Metrics routes
// GET /api/projects/:projectId/metrics is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// GET /api/metrics/aggregate is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.

// Operator-dashboard fallback endpoints. Cross-project listings used by
// the home page (`/`) cards. See routes/dashboard.ts.
import {
} from './routes/dashboard';
// GET /api/cards is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// GET /api/activity is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.
// GET /api/projects/:projectId/activity is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.

// T/I/OE measurement lens (control-plane roadmap Phase 7). One compose-endpoint
// joining existing reads — no new upstream service, no schema change. See
// routes/measure.ts.
// GET /api/measure is capability-derived (P4c part 1, capabilities/observe/measure.ts): deriveRouter below.

// Architecture Governance — conformance dashboard BFF (P3.1 of the fr
// Architecture Governance lane). Thin wrapper over requirements_management's
// POST /architecture/tools/conformance with a 60s in-memory TTL cache. See
// routes/governance/architecture/conformance.ts.
// GET /api/governance/architecture/conformance is capability-derived (P2, capabilities/projects/assets.ts): deriveRouter below.

// Cross-domain traceability graph (control-plane roadmap Phase 8). Assembles
// requirements_management's polymorphic architecture_relationships into a
// renderable {nodes, links} graph — no new upstream service, no schema change.
// See routes/traceability.ts.
// GET /api/traceability/graph is capability-derived (P4c part 1, capabilities/observe/traceability.ts): deriveRouter below.


// n8n webhook receiver routes (no auth - called by n8n service)
// POST /api/webhooks/n8n/approval-request is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.
// POST /api/webhooks/n8n/card-approval is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.
// WS1 — non-approval project-execution events (X-Webhook-Secret, no user auth).
// POST /api/webhooks/n8n/execution-event is capability-derived (P1b): deriveRouter below.
// Durable atomic dedupe for the AA router's card-move cascade (X-Webhook-Secret).
// POST /api/webhooks/n8n/router-dedupe is capability-derived (P1b): deriveRouter below.
// The ATOMIC CARD CLAIM (X-Webhook-Secret) — one path, three ops
// (claim / verify / release) over migration 100's `card_phase_lease`. Closes the
// 2026-08-10 phase-writer race that no read-then-guard can close. Unlike
// router-dedupe this receiver degrades CLOSED: it never answers `granted` it did not
// prove. See routes/webhooks/card-phase-lease.ts.
// POST /api/webhooks/n8n/card-phase-lease is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.
// POST /api/webhooks/n8n/wip-slot is RETIRED (v4 ruling, 2026-10-13): n8n enforces
// WIP itself and RM stores the limit per project. Migration 138's `wip_slot` table
// is kept (data stays); an unmatched route is a 404.

// billing_service budget threshold-crossing webhook (the watcher's platform
// sink). Auth: HMAC-SHA256 X-Metering-Signature over the raw body
// (PLATFORM_BUDGET_WEBHOOK_SECRET). Fans a low-budget alert out to the tenant's
// workspace-admins (in-app + Telegram).
// POST /api/webhooks/billing/budget-threshold is capability-derived (P1b): deriveRouter below.

// n8n report webhook (no auth - called by n8n service)
// POST /api/webhooks/n8n/report is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// U11 — append-only plan ledger writers (migration 148). Same X-Webhook-Secret
// and tenant resolution as the report webhook above, plus the card's pin tenant;
// tenant_id is NOT NULL so an unresolvable tenant is a 400, never a NULL row.
// Record-only: neither moves, gates nor halts a card. See routes/webhooks/plan-ledger.ts.
// POST /api/webhooks/n8n/plan-event is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.
// POST /api/webhooks/n8n/executed-activity is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// Reporting surface (Phase 6) — MUST be registered before /api/reports/:reportId
// since the router is first-match and :reportId would otherwise swallow
// /api/reports/approval-backlog.
// approval-backlog, worker-activity/:workerId and asset-changes/:assetType are
// capability-derived (P4b part 2, capabilities/operate/reports.ts): deriveRouter
// below, placed before /api/reports/:reportId by the pinned overlap pairs.
// GET /api/reports/project-status/:projectId is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.

// Reports routes (auth required)
// GET /api/reports is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// GET /api/reports/:reportId is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// POST /api/reports/:reportId/fix is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// User channel preferences (/api/me/channels), the notification inbox
// (/api/me/notifications) and its per-type prefs (/api/me/notification-prefs) are
// capability-derived (P4b part 3, capabilities/account/{me,notifications}.ts): deriveRouter below.

// Channels registry (Foundation Plan 2 follow-up) — workspace-/dept-scoped
// channel definitions consumed by the FE admin /channels page. Distinct from
// /api/me/channels above (which is per-user routing prefs). /api/channels[/:id] are
// capability-derived (P4b, capabilities/settings/channels.ts): deriveRouter below.

// Spec 2 Plan 2-B — /api/me/secrets alias (same handler as /api/secrets):
// capability-derived (P4b, capabilities/settings/secrets.ts): deriveRouter below.

// Spec 2 Plan 2-B — inbound n8n_webhook intake endpoint.
// No auth — trigger_id UUID is the shared token.
// POST /api/intake/webhook/:id is capability-derived (P4d-2d, capabilities/platform/inbound.ts): deriveRouter below.

// Spec 2 Plan 2-A — scheduled_triggers (cron-driven inbound work pulls).
// Tick worker in workers/scheduled-trigger-tick.ts claims due rows.
// The seven /api/scheduled-triggers routes are capability-derived (P4b part 2,
// capabilities/schedules/scheduled-triggers.ts): deriveRouter below.

// Spec 2 Plan 2-C Phase 3 — connector dry-run / "Test connection".
// Exercises the same Connector.dryRun(config, secret) path used by
// the create-trigger form's "Test connection" button. Capability-derived (P4b,
// capabilities/settings/tenant.ts): deriveRouter below.

// Spec 2 §9 / Plan 2-D Phase 5 — Suggestion Inbox.
// list is project-keyed; internal-create is admin-only stub (heuristic
// auto-detector lands later); accept/dismiss are id-keyed.
// GET /api/projects/:projectId/suggested-schedules is capability-derived (P4d-2a,
// capabilities/schedules/suggested-schedules.ts): deriveRouter below.
// POST /api/internal/suggested-schedules is capability-derived (P1b): deriveRouter below.
// POST /api/suggested-schedules/:id/{accept,dismiss} are capability-derived
// (P4b part 2, capabilities/schedules/suggested-schedules.ts): deriveRouter below.

// User licenses & tokens (/api/me/licenses[/by-tenant|/:id/regenerate-token]) are
// capability-derived (P4b part 3, capabilities/account/me.ts): deriveRouter below.

// Spec 2 Task 4 — super-admin user provisioning. GET is the role-bit probe
// the frontend uses to gate super-admin nav; POST is the orchestrator.
// GET /api/me/workspace and GET /api/me/workspaces (the top-bar switcher) are
// capability-derived (P4b part 3, capabilities/account/me.ts): deriveRouter below.
// fr row 14b — the projects page's empty-state hint: PLATFORM workspaces (only)
// where the caller has projects. Never names or counts a customer workspace.
// GET /api/me/project-workspaces is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// GET /api/me/approval-workspaces is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// GET /api/me/projects/artifacts is capability-derived (P4b part 3): deriveRouter below.
// GET /api/me/super-admin is capability-derived (P4c part 2, capabilities/account/me.ts): deriveRouter below.
// POST /api/admin/super-admin/provision-user and its offboard counterpart
// POST /api/admin/super-admin/deprovision-user (reverses the provisioning run for
// (email, tenant_slug); the shared registry tenant and every fr-local artefact are
// retained) are capability-derived (P4c part 3, capabilities/admin/provisioning.ts):
// deriveRouter below.

// Super-admin licensing console — proxies the licenses service's admin API
// (which was complete but had no UI). Backs /admin/licenses.
// Every handler is super-admin gated in `routes/admin/licenses-admin.ts`.
//
// ORDERING MATTERS. `utils/router.ts` compiles `:param` to `([^/]+)` and
// returns the FIRST matching route in insertion order, so a literal segment
// must be registered before any param pattern that could swallow it —
// `/grants/revoke` before `/grants/:licenseId/...`, and `/grants/user/:id`
// before them both. Reordering these is a behaviour change, not a tidy-up.
//
// Grants are namespaced under `/grants` rather than hanging licence ids
// directly off `/api/admin/licenses/:id`, which would collide with the
// `/apps`, `/plans`, `/tenants` and `/offerings` sub-resources.

// catalog: apps
// people — Keycloak user resolution so the console never shows/asks for a sub
// UUID (the typeahead only; the batch `/users/resolve` route was removed with
// the licenses table's Person column — see routes/admin/licenses-admin.ts).
// Who has access to fr, and where. `user_roles` is the authority: Keycloak
// cannot enumerate, and it is the table the backend gates on.
// GET /api/admin/users is capability-derived (P4c part 2, capabilities/admin/platform.ts): deriveRouter below.
// ...and what makes that list editable. Before these two, the only writer of
// `user_roles` was the provisioning flow, so a second workspace for an existing
// person meant re-provisioning and a revoke meant hand-editing postgres.
// The revoke target rides in the query string — DELETE-with-body does not
// survive every proxy between cloudflared and the pod.
// POST / DELETE /api/admin/users/:userId/roles are capability-derived (P4c part 2, capabilities/admin/platform.ts): deriveRouter below.
// Tenant-admin members management. Distinct from the super-admin routes above:
// the tenant comes from the REQUEST CONTEXT, never the body, so a workspace
// admin can only ever act inside the workspace they administer.
// The member-level directory. Separate file from workspace/members because
// THAT file's whole surface (list + grant + revoke) is admin-gated; this is
// read-only and deliberately cannot grow a write. GET /api/tenant/members is
// capability-derived (P4b, capabilities/settings/tenant.ts): deriveRouter below.
// The knowledge-area VOCABULARY — the caller tenant's requirements_management
// capabilities (with their card types), served so no client holds a second copy
// of the names. Any authenticated caller, reading its OWN tenant's catalogue;
// 409 `catalogue_not_initialised` for a tenant with none. No member data.
// GET /api/tenant/knowledge-areas is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// GET /api/tenant/billing (per-project / per-member spend) is capability-derived
// (P4b part 3, capabilities/account/billing.ts): deriveRouter below.
// Usage split by funding (local GPU / platform-paid / tenant BYO), per project × member.
// GET /api/tenant/usage/breakdown is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// /api/workspace/members (list, grant, revoke) is capability-derived (P4b part 3,
// capabilities/account/workspace-members.ts): deriveRouter below.
// A member's KNOWLEDGE areas — who to ask, granting nothing. A separate file from
// the role grant/revoke above precisely so an edit to one axis cannot reach the
// other; same `requireWorkspaceAdmin` gate, reused rather than copied. PUT because
// the body is the member's COMPLETE set, which is what makes it idempotent.
// PUT /api/workspace/members/:userId/knowledge-areas is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// Per-project ALLOCATION of those same areas — the operator's "just an update to
// the allocation", maintainable after the project has started. workspace-admin,
// scoped to projects whose own `keycloak_tenant_id` tag is the admin's tenant.
// ⛔ Cannot read or write `project_stakeholders` rows with role
// `execution_signoff`: the sign-off roster is out of scope by construction.
// GET /api/projects/:id/knowledge-allocation is capability-derived (P2-c1,
// capabilities/projects/quality-people.ts): deriveRouter below.
// PUT /api/projects/:id/knowledge-allocation/:userId is capability-derived (P4d-2a, capabilities/projects/collaboration.ts): deriveRouter below.
// The 40 /api/admin/licenses routes (people, apps, plans, regions, grants, tenants +
// BYO posture, budget, offerings) are capability-derived (P4c part 3,
// capabilities/admin/licensing.ts): deriveRouter below. The literal-before-param
// pairs above (`/grants/user/:id` before `/grants/:licenseId/...`) are pinned in
// capabilities/route-overlap-pairs.json, which deriveRouter honours.

// Plan in-fr-there-are-jazzy-pine — super-admin asset console proxy routes.
// Each endpoint is scoped by request-context's tenantId (post X-Active-Tenant
// override). On non-system tenants, list endpoints UNION with system rows
// (tagged `is_system: true`) for inheritance.
// The five /api/admin/assets/principles routes are capability-derived (P4c part 2, capabilities/admin/assets.ts): deriveRouter below.

// The five /api/admin/assets/requirements routes are capability-derived (P4c part 2, capabilities/admin/assets.ts): deriveRouter below.

// The five /api/admin/assets/decisions routes are capability-derived (P4c part 2, capabilities/admin/assets.ts): deriveRouter below.


// Workflows are read-only — n8n owns workflow create/update/delete via its
// own UI + Public API. The admin console links out for edits.
// GET /api/admin/assets/workflows[/:id] are capability-derived (P4c part 2, capabilities/admin/assets.ts): deriveRouter below.

// Control tower (AA cockpit B5, the last cockpit) — super-admin fleet read
// model composing the workflow improvement lane summary + fleet-wide fr-DB and
// read-only upstream probes. See routes/admin/control-tower.ts +
// docs/cockpit-super-admin-control-tower-proposal.html. Single endpoint.
// GET /api/admin/control-tower is capability-derived (P4c part 1, capabilities/admin/verification.ts): deriveRouter below.

// Verification read models (judge-oracle tournament review, fr-routes.md) —
// super-admin only (404 otherwise, like every admin read model). Each returns
// ONE Block<T> whose `data` is the upstream payload verbatim: the
// inference-router served-model timeline and Prometheus alerts. See
// routes/admin/verification.ts.
// The two /api/admin/verification/* reads are capability-derived (P4c part 1,
// capabilities/admin/verification.ts): deriveRouter below.

// A10.4 (2026-09-26): alerts is fr's OWN Prometheus read (a second upstream
// block) — an exception to "fr never derives", the contract names it as such.

// Projects has no tenant_id; scope is owner_id (or fleet view on system tenant
// for super-admins). Create stays at POST /api/projects because it triggers
// repo/planka/container provisioning.
// The four /api/admin/assets/projects routes are capability-derived (P4c part 2, capabilities/admin/assets.ts): deriveRouter below.

// ----- Plan 2 Wave 3 — Department CRUD + members (Task 10) ----------------
// workspace-admin gates the parent CRUD; the member sub-resource (POST /
// PATCH / DELETE) is dept-admin gated with a workspace-admin backstop so
// a freshly-created dept can have its first dept-admin promoted.
// The nine /api/admin/departments routes are capability-derived (P4c part 1,
// capabilities/admin/departments.ts): deriveRouter below.

// ----- Plan 2 Wave 3 — Asset scope mutations (Task 11) --------------------
// Each handler enforces its own RBAC matrix per Spec 1 §11:
//   * promote → workspace: workspace-admin
//   * promote → dept X:    dept-manager of X (workspace-admin backstop)
//   * override / block at project P: project-member of P
//   * override / block at dept D:    dept-manager of D (workspace-admin backstop)
// POST /api/asset-scope/:assetType/:assetId/promote is capability-derived (P4c part 2, capabilities/admin/asset-scope.ts): deriveRouter below.
// POST /api/asset-scope/:assetType/:assetId/override is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.
// POST /api/asset-scope/:assetType/:assetId/block is capability-derived (P4d-2c, capabilities/library/asset-surfaces.ts): deriveRouter below.

// /api/me/dept-roles — feeds the frontend auth-store typed-roles cache
// (Plan 2 / Z2 lane). 200 with `{}` is valid for users with no dept
// memberships; 401 bubbles from validateAuth on unauthenticated calls.
// GET /api/me/dept-roles is capability-derived (P4c part 2, capabilities/account/me.ts): deriveRouter below.

// /api/me/usage/* — Foundation Plan 4 Lane A backs /settings/usage.
// Series endpoint currently returns _stub:true buckets[] until upstream
// metering_service exposes per-bucket time-series.
// /api/me/usage/{summary,series,breakdown,quota,by-tenant}, /api/me/costs/by-correlation,
// /api/me/budget/{status,packages,topup,topups} and /api/me/plan are capability-derived
// (P4b part 3, capabilities/account/usage.ts): deriveRouter below.
// GET /api/me/usage/funding is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// Super-admin system-wide rollup — drives /admin/metering. Local gate
// (super_admin realm role) + upstream license-admin role gate (defence in depth).
// GET /api/admin/usage/system is capability-derived (P4c part 2, capabilities/admin/platform.ts): deriveRouter below.
// --------------------------------------------------------------------------

// Engagement delivery audit log (Wave 4 / Task 4.1) — read-only.
// GET /api/engagements/deliveries[/:id] are capability-derived (P4c part 1, capabilities/observe/engagements.ts): deriveRouter below.

// AG-UI wire protocol (E-9). Auth: FR-issued agent access token (HS256 JWT,
// aud=fr-agent). NDJSON streaming response.
// POST /api/agui/invoke is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.

// AG-UI registry catalog — public, unauthenticated read for operator
// debugging and tool discovery. See routes/agui.ts::handleListAguiActions.
// Spec: docs/superpowers/specs/completed/2026-04-24-kag-ingestion-ui.md §8.4.
// GET /api/agui/actions is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.

// AG-UI agent-session lifecycle (E-13). /issue + /:id/revoke require a
// Keycloak bearer; /refresh accepts a refresh token in the body and is
// unauthenticated at the bearer layer.
// POST /api/agui/session/issue is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.
// POST /api/agui/session/refresh is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.
// POST /api/agui/session/:id/revoke is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.

// Plan 3: agent loop endpoint. Auth: same FR-issued agent access token as
// /api/agui/invoke. NDJSON streaming response. Iterates worker_management
// (sole LLM gateway) against the AG-UI registry.
// POST /api/agent/chat is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.

// Plan 3: thread CRUD over agent_runtime_sessions, scoped by token user.
// GET /api/agui/threads is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.
// POST /api/agui/threads is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.
// GET /api/agui/threads/:id is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.
// DELETE /api/agui/threads/:id is capability-derived (P4d-2d, capabilities/platform/agui.ts): deriveRouter below.

// Telegram inbound webhook (no SSO - called by Telegram, or by the n8n
// telegram-incoming forwarder). Authenticated by the bot's secret token
// echoed in X-Telegram-Bot-Api-Secret-Token, validated inside the handler.
// POST /api/webhooks/telegram/incoming is capability-derived (P1b): deriveRouter below.

// Teams inbound action-callback webhook (no auth - called by Teams Action.Http)
// POST /api/webhooks/teams is capability-derived (P1b): deriveRouter below.

// E-10: email + in-app channels.
// POST /api/webhooks/email/incoming is capability-derived (P1b): deriveRouter below.
// GET/POST /api/inapp/messages (D9) are capability-derived (P4b, capabilities/settings/messaging.ts).

// Outbound admin in-app notifications — internal-tenant only. The eight
// improvement-loop done.json subflows post {recipientUserId, subject, body,
// level, link_url} here to deliver a notification to the card owner. Strict
// authz lives inside the handler (requireInternalTenant → 404 for anyone
// else); persists to inapp_messages with direction='outbound'. Capability-derived
// (P4b, capabilities/settings/messaging.ts): deriveRouter below.

// Decoupled communication hub — internal-tenant only. External callers (n8n
// notification workflows, other services) POST {recipientUserId|channel+address,
// text, kind} here and fr routes per the recipient's channel prefs (telegram /
// email / websocket / …) instead of the caller owning a messaging channel.
// POST /api/notifications/dispatch is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// Kanban routes (Planka proxy — auth required). /api/kanban/* — reads, comments, card
// writes incl. the move and the super_admin break-glass DONE, label attach/detach — are
// capability-derived (P4d-2b, capabilities/kanban/board.ts): deriveRouter below.
// GET /api/projects/:id/kanban is capability-derived (P4d-2a, capabilities/projects/project-routes.ts): deriveRouter below.

// ===== Andon-cord (super-admin) ============================================

// GET /api/admin/andon is capability-derived (P4c part 2, capabilities/admin/andon.ts): deriveRouter below.
// POST /api/projects/:id/andon/{engage,disengage} are capability-derived (P2, capabilities/projects/assets.ts): deriveRouter below.

// Global andon — migration 065. Header AndonCord.svelte polls GET and
// toggles via POST; n8n consults the /internal/ variant. One click halts
// every automation across every workspace until released.
// The five global /api/andon routes are capability-derived (P4c part 1, capabilities/admin/andon.ts): deriveRouter below.
// GET /api/internal/andon is capability-derived (P1b): deriveRouter below.
// fr#1195 — the n8n chokepoint brake reports a cord it could NOT read. It fails
// CLOSED after a grace window, so this is the only way fr learns about the one
// halt regime nobody chose; a read that never arrived leaves no trace in any
// series fr publishes. ⛔ Must be LIVE BEFORE the brake ships: the brake POSTing
// to a 404 and treating a failed REPORT as a failed READ would halt the fleet on
// its own telemetry. Unauthenticated, same posture as the GET above.
// POST /api/internal/andon/read-failure is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// Public GitHub App (`nonagenticai`) — tenant-bound installs. See
// routes/github-app.ts. The callback is UNAUTHENTICATED by design: GitHub's
// browser redirect carries no bearer, so the signed single-use `state` minted
// by install-url is its identity. The internal binding lookup is gated by
// X-Internal-Token == FR_GITHUB_BINDING_TOKEN (coding-github's caller token).
// POST /api/github-app/install-url is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// GET /api/github-app/callback is capability-derived (P4b part 3, capabilities/account/github-app.ts): deriveRouter below.
// POST /api/github-app/claims/:handle/confirm is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// GET /api/github-app/installations is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// DELETE /api/github-app/installations/:id is capability-derived (P4d-2d, capabilities/platform/account-frozen.ts): deriveRouter below.
// GET /api/internal/github-app/binding is capability-derived (P1b): deriveRouter below.

// billing-service's project-ownership check: the whole project -> tenant map in
// one read. X-Internal-Token == FR_BILLING_INTERNAL_TOKEN (billing's own caller
// token, never shared); unset env -> 503. See routes/internal-projects-tenant-map.ts.
// GET /api/internal/projects/tenant-map is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// worker_management#336: WM verifies a prompt release's actor_card_id is a
// PLATFORM-owned card. X-Internal-Token == FR_WM_CARD_LOOKUP_TOKEN (WM's own
// caller token); unset env -> 503, bad token / missing / customer card -> one
// identical 404. See routes/internal-card-platform-owner.ts.
// GET /api/internal/cards/:cardId/platform-owner is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// Computed-pass store writer (migration 162): ONLY computed evaluators, by a per-caller service
// token or the fr licence door; a user JWT is 403. Read by the DONE-move guard. See
// routes/internal-computed-checks.ts.
// POST /api/internal/cards/:cardId/computed-checks is capability-derived (P4d-2d, capabilities/platform/service-frozen.ts): deriveRouter below.

// Frontend error sink. UNAUTHENTICATED by design — an error during login or
// first paint is the one you most need and the one an authed-only sink cannot
// see. Abuse control is the route's own body cap + per-client rate limit, not a
// token; it touches no database. See routes/client-errors.ts.
// POST /api/client-errors is capability-derived (P4d-2d, capabilities/platform/inbound.ts): deriveRouter below.

// fr-agui SPEC §3.4 (a) / §3.6 — THE route table. Since P4d-2e every route is a capability row
// (src/capabilities/registry.ts): there is no `router.add` left, and deriveRouter refuses a router
// that already holds a row. Rows are ordered by the pinned overlap pairs
// (src/capabilities/route-overlap-pairs.json) — order between two rows matters ONLY for those pairs.
// `/health`, `/health/live`, `/openapi.json` and `/` are answered in the fetch handler, before routing.
deriveRouter(router);

// Start server
// Server hosts both approval and quality monitoring WebSocket flows;
// the websocket handlers below discriminate on `ws.data.kind`.
// Package-license gate decision logic (route + tenant exemptions, app-key
// selection) lives in lib/package-license-gate.ts so both exemption axes are
// unit-tested. enforcePackageLicense below keeps the side-effecting check.

// Which package gates are enabled on THIS deployment, and therefore which
// product it serves. Both are deployment-scoped facts, resolved once at module
// scope — never per-request from a client header, and never from an env
// override (see servingAppKey for why `PACKAGE_APP_KEY` was deleted). A client
// `X-App-Key` may only CONFIRM the serving key, never change it; on the fr
// deployment a client-supplied `X-App-Key: kag` used to land on the kag branch,
// whose flag is off here, and skip the licence check entirely.
const PACKAGE_GATES = {
  fr: config.frLicense.gateEnabled,
  kag: config.kagLicense.gateEnabled,
} as const;
const SERVING_APP_KEY = servingAppKey(PACKAGE_GATES);

/**
 * The single per-request derivation of `(appKey, gateEnabled)` — used by BOTH
 * the `/api/license/status` probe and the enforcing gate, so the probe can never
 * report a posture the enforcer does not hold.
 *
 * Also logs (once) any client-supplied `X-App-Key` that was ignored. That header
 * is recorded nowhere else, so this warn is the only signal that someone is
 * probing for the sibling product's gate. The value is pre-sanitised by
 * `resolveAppKey` (JSON-quoted + truncated): this path is reachable
 * unauthenticated, so the raw header must never reach stdout → Loki.
 */
function packageViewFor(
  req: Request,
  pathname: string,
  correlationId: string,
): PackageRequestView {
  const view = packageRequestView(req, PACKAGE_GATES, SERVING_APP_KEY);
  if (view.rejectedHeaderForLog !== undefined) {
    console.warn(
      `[package-gate] ignored client X-App-Key=${view.rejectedHeaderForLog} (it does not name the served product); ` +
        `serving=${SERVING_APP_KEY} path=${pathname} cid=${correlationId}`,
    );
  }
  return view;
}

/**
 * Apply the package license gate for the request's app-key. No-op when that
 * app's gate flag is off, the request is exempt (platform-global route OR
 * internal platform tenant — see isPackageLicenseExempt), AUTH_BYPASS is on, or
 * there is no user tenant. Throws ForbiddenError('<app>_license_required')
 * otherwise.
 */
async function enforcePackageLicense(
  appKey: AppKey,
  pathname: string,
  tenantId: string | null | undefined,
): Promise<void> {
  switch (packageGateDecision(appKey, pathname, tenantId, PACKAGE_GATES)) {
    case 'require-kag':
      await requireKagLicense(tenantId);
      return;
    case 'require-fr':
      await requireFrLicense(tenantId);
      return;
    case 'skip':
      return;
  }
}

const server: Bun.Server<WsData> = Bun.serve({
  port: config.port,
  hostname: config.host,
  // /api/agent/chat streams NDJSON for the duration of the agent loop, which
  // commonly runs longer than Bun's default 10s idle timeout. Without this,
  // Bun kills the stream mid-body and the browser surfaces it as
  // ERR_HTTP2_PROTOCOL_ERROR 200 (OK). 0 disables the timeout entirely.
  idleTimeout: 0,

  async fetch(req: Request) {
    const url = new URL(req.url);
    const method = req.method;
    const origin = req.headers.get('Origin');
    const startTime = performance.now();

    // CORS preflight
    if (method === 'OPTIONS') {
      return handleCorsOptions(req);
    }

    // Request context (E-3): parse X-Correlation-Id / X-Initiator / X-Channel
    // and make them available via AsyncLocalStorage for the entire handler
    // tree, including upstream HTTP calls.
    let ctx;
    try {
      ctx = await buildRequestContext(req);
    } catch (err) {
      if (err instanceof InvalidInitiatorError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin),
          },
        });
      }
      // fr row 14d: a super-admin's refused X-Active-Tenant switch (403
      // active_tenant_not_permitted + reason — explicit, never a silent
      // fallback to home; the frontend clears its stored workspace on this
      // code), or a switch target fr could not check (503
      // active_tenant_unverifiable) — refused here, before any handler runs.
      const refusal = requestContextRefusalResponse(err, corsHeaders(origin));
      if (refusal) return refusal;
      throw err;
    }

    // George 2026-10-27: every WRITE a super_admin (or their switched Copilot
    // session) sends into a tenant other than their own lands in
    // `super_admin_tenant_actions` with the status the handler answered — in a
    // `finally`, so a handler error that escapes is audited (500) before it
    // propagates (lib/super-admin-tenant-audit.ts; never throws itself).
    const response = await withSuperAdminWriteAudit(ctx, req, () => withRequestContext(ctx, async () => {

    // WebSocket upgrade for the container-lifecycle broadcast surface
    // (/api/coding/broadcast/ws/:container). Sets kind:'broadcast' so the shared
    // `websocket` dispatch drives the proxy handlers. See
    // routes/coding/broadcastWebSocket.ts.
    if (CODING_BROADCAST_WS_PATTERN.test(url.pathname)) {
      const containerName = url.pathname.split('/').pop()!;
      const auth = extractWsBearerToken(req);
      let broadcastUser;
      try {
        broadcastUser = await validateBroadcastWebSocketAuth(req, auth.token);
      } catch (err) {
        console.warn('[ws-auth] coding-broadcast validation rejected', { err: String(err) });
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const upgraded = server.upgrade(req, {
        data: {
          kind: 'broadcast',
          containerName,
          userId: broadcastUser.id,
          tenantId: broadcastUser.tenantId,
          userName: broadcastUser.name,
          userEmail: broadcastUser.email,
        } satisfies WsData,
        headers: auth.protocolHeader ? { 'Sec-WebSocket-Protocol': auth.protocolHeader } : undefined,
      });
      if (upgraded) {
        return undefined as any;
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // WebSocket upgrade for approval notifications. fr row 14d-0b: the
    // upgrade resolves the connection's ACTIVE tenant with the SAME helper as
    // /api/kanban/ws and refuses when it cannot; nothing is auto-subscribed.
    // `approvalsAll` then subscribes the socket to its OWN tenant channel
    // (`approvals:tenant:<id>`, fr row 14d-2) and `approvals:project:<id>`
    // only for the project's own tenant.
    if (url.pathname === '/api/approvals/ws') {
      const auth = extractWsBearerToken(req);
      const approvalsAuth = await authorizeKanbanWsUpgrade(req, auth.token, {
        validateToken: (t) => kcService.validateToken(t),
        // Unchanged from before 14d-0b: this upgrade never honoured
        // AUTH_BYPASS — it always validated the token.
        authBypass: false,
        bypassUser,
        route: '/api/approvals/ws',
        onTenantUnresolved: (uid) =>
          reportApprovalsWsRefusal({ surface: 'upgrade', reason: 'tenant_unresolved', userId: uid }),
      });
      if (!approvalsAuth.ok) return approvalsAuth.response;
      const upgraded = wsManager.upgrade(
        req,
        server,
        approvalsAuth.userId,
        approvalsAuth.tenantId,
        auth.protocolHeader,
      );
      if (upgraded) {
        return undefined as any; // Bun handles the response after upgrade
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // WebSocket upgrade for kanban events. fr row 14d-0b: the upgrade also
    // resolves the connection's ACTIVE tenant (same rules as HTTP) and refuses
    // when it cannot; kanban topics are then admitted only for platform-tenant
    // sessions. See routes/kanbanWsAuth.ts.
    if (url.pathname === '/api/kanban/ws') {
      const auth = extractWsBearerToken(req);
      const kanbanAuth = await authorizeKanbanWsUpgrade(req, auth.token, {
        validateToken: (t) => kcService.validateToken(t),
        authBypass: process.env.AUTH_BYPASS === 'true',
        bypassUser,
      });
      if (!kanbanAuth.ok) return kanbanAuth.response;
      const { userId, tenantId: kanbanTenantId } = kanbanAuth;
      const upgraded = wsManager.upgradeKanban(
        req,
        server,
        userId,
        kanbanTenantId,
        auth.protocolHeader,
      );
      if (upgraded) {
        return undefined as any;
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // LIVENESS. Answers one question: is this process still serving HTTP?
    //
    // Deliberately touches no dependency, and that is the whole point. `/health`
    // below returns 503 when Postgres or Redis is unreachable, and that same
    // endpoint was wired as the LIVENESS probe — so a dependency outage did not
    // merely take fr out of service, it got fr KILLED.
    //
    // Measured on 2026-08-14, not hypothesised: `fr-redis` was replaced at
    // 18:00:10, `[health] redis error` repeated in the log, and kubelet SIGTERMed
    // fr-backend at 18:01:02 — three failures at a 20s period, to the second.
    // The pod came back ~60s later having lost every in-flight request, and
    // restarting fr does nothing whatsoever to fix Redis.
    //
    // Liveness means "wedged, and only a restart can help". Readiness means
    // "cannot serve right now". A dependency being down is the second one, and
    // conflating them turns every blip in a dependency into an outage of this
    // service plus a restart that cannot possibly repair it.
    if (url.pathname === '/health/live') {
      return Response.json({ status: 'live' }, { status: 200 });
    }

    // READINESS / dependency health — validates actual dependency connectivity.
    // WHICH failures are fatal is argued in `lib/readiness.ts`: Postgres yes,
    // Redis no. A CACHE took fr AND kag to zero endpoints for 2h45m on
    // 2026-09-06 while Postgres and the app were fine (fr#947/#955).
    if (url.pathname === '/health') {
      let dbStatus: DependencyStatus = 'ok';
      let redisStatus: DependencyStatus = 'ok';

      try {
        await validateConnection();
      } catch (err) {
        console.warn('[health] db error', { err: String(err) });
        dbStatus = 'error';
      }

      try {
        await redis.ping();
      } catch (err) {
        console.warn('[health] redis error', { err: String(err) });
        redisStatus = 'error';
      }

      const verdict = readinessVerdict({ db: dbStatus, redis: redisStatus });

      return new Response(JSON.stringify({
        status: verdict.status,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        db: dbStatus,
        redis: redisStatus,
        degraded: verdict.degraded,
      }), {
        status: verdict.ready ? 200 : 503,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin),
        },
      });
    }

    // Prometheus text-format metrics — additive endpoint owned by the n8n
    // observability slice. Does NOT replace the canonical JSON metrics at
    // /api/projects/:projectId/metrics; this exporter only carries the
    // gauges/counters this slice needs in Grafana for alerting.
    // Unauthenticated by design: prom-internal scrape target.
    if (url.pathname === '/api/metrics/prom') {
      // fr#1208: refresh the STANDING andon gauge before rendering. Every other
      // andon series is traffic-driven, and a missing `andon_state` singleton now
      // HALTS the conveyor — so the condition removes the card moves that would
      // otherwise have published it. The scrape is the only traffic guaranteed to
      // exist while the estate is frozen, which is why the probe hangs off it and
      // not off a cord consult. It never throws and never gates anything; a
      // failed probe renders as the alarm value.
      await refreshAndonStateInitialisedGauge();
      const promResponse = handlePromMetrics();
      const headers = new Headers(promResponse.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
      return new Response(promResponse.body, {
        status: promResponse.status,
        headers,
      });
    }

    // OpenAPI spec
    if (url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(openapiSpec, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin),
        },
      });
    }

    // fr package license status — lets the SPA decide whether to render the
    // "no fr license" state instead of a broken shell. Exempt from the gate
    // itself. Reports the gate flag + whether THIS request's tenant holds an
    // active fr license (gate OFF ⇒ everyone is effectively entitled).
    if (url.pathname === '/api/license/status') {
      // ⛔ The SAME derivation the enforcing gate uses — one call, not a
      // re-implementation. Reading `x-app-key` here, or recomputing gateEnabled
      // from PACKAGE_GATES, lets this probe report a posture the enforcer does
      // not hold; the post-merge live proof drives exactly this endpoint, so a
      // divergence would certify a fix that is not in the enforcer.
      // `tests/unit/lib/package-license-gate.test.ts` pins this wiring.
      const { appKey, gateEnabled } = packageViewFor(req, url.pathname, ctx.correlationId);
      // ⛔ `ctx.tenantId`, the SAME value `enforcePackageLicense` is handed at
      // :3130 — the header-overridden EFFECTIVE tenant, not `user.tenantId`.
      // Passing the JWT tenant here would make the probe describe a workspace
      // the data path is not serving. (`gateEnabled` is only the deployment
      // flag; the enforcer's per-TENANT exemption axis lives inside
      // `getLicenseStatus` — see its `isInternalTenant` branch and the
      // 2026-09-14 note in lib/license-status.ts for why it must.)
      // Rich, app-scoped status so the SPA can render an accurate experience
      // (active / expiring-soon / expired / revoked / none) instead of a broken
      // shell. `getLicenseStatus` fails soft to state:'unknown' on upstream
      // error — the per-request 403 gate is the real enforcer.
      const status = await getLicenseStatus({
        appKey,
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        gateEnabled,
      });
      // `hasLicense` is the generic boolean; the legacy per-app aliases keep
      // both the fr SPA (`hasFrLicense`) and the kag SPA (`hasKagLicense`)
      // working. `state`/`expiresAt`/`daysRemaining`/`planCode` are additive.
      return new Response(
        JSON.stringify({
          appKey,
          gateEnabled,
          hasLicense: status.hasLicense,
          state: status.state,
          expiresAt: status.expiresAt,
          daysRemaining: status.daysRemaining,
          planCode: status.planCode,
          ...(appKey === 'kag'
            ? { hasKagLicense: status.hasLicense }
            : { hasFrLicense: status.hasLicense }),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin),
          },
        },
      );
    }

    // Swagger UI at root
    if (url.pathname === '/') {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FR Backend API - Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`;
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html',
          ...corsHeaders(origin),
        },
      });
    }

    // Route matching
    const match = router.match(method, url.pathname);

    if (!match) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin),
        },
      });
    }

    // The routed pipeline (utils/routed-dispatch.ts): tag a malformed inbound
    // body as the caller's (400, not 500), record the matched pattern for the
    // licence route allowlist, then — inside its try — refuse a licence-shaped
    // bearer on a route not on the n8n-nodes-fr allowlist (403
    // `licence_route_not_allowed`) BEFORE the handler, run `run`, and render
    // anything thrown through the central catch (renderRouteError).
    const outcome = await dispatchRouted(req, method, match.path, async () => {
      // Package license gate (per-tenant) for the product THIS deployment
      // serves; a client X-App-Key may only CONFIRM that product, never change
      // it. Runs INSIDE the try so a thrown
      // ForbiddenError('<app>_license_required') is rendered as 403 by the
      // central catch. No-op when that app's flag is off, AUTH_BYPASS
      // is on, the route is exempt, or the request carries no user tenant.
      await enforcePackageLicense(
        packageViewFor(req, url.pathname, ctx.correlationId).appKey,
        url.pathname,
        ctx.tenantId,
      );

      // Per-request metering emit (W5: per-tenant usage capture).
      // Runs INSIDE the withRequestContext frame above so ctx.tenantId /
      // ctx.userId are visible to recordSpan. Skips /health, /api/me/usage/*
      // and /api/me/licenses/* so the metering UI doesn't feed itself.
      const response = await withUsageSpans(match.handler)(req, ...match.params);

      // Add CORS headers to response
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders(origin)).forEach(([key, value]) => {
        headers.set(key, value);
      });
      if (!headers.has('X-Correlation-Id')) {
        headers.set('X-Correlation-Id', ctx.correlationId);
      }
      // Per-user data: never cache it. Without this Chrome treats identical GETs
      // as cacheable and serializes them behind its cache lock — three
      // concurrent GET /api/projects took 4-12s in the browser against ~1s on
      // the server (measured 2026-10-30).
      if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');

      const elapsed = (performance.now() - startTime).toFixed(1);
      console.log(`[http] ${method} ${url.pathname} ${response.status} ${elapsed}ms cid=${ctx.correlationId}`);
      // fr-agui SPEC §10.5: a request confirming an agent proposal is audited.
      if (proposalIdOf(req)) void recordProposalExecution(req, response.status, ctx);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
    if (outcome.ok) return outcome.response;

    const { status, body } = outcome;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    Object.entries(corsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value);
    });
    headers.set('X-Correlation-Id', ctx.correlationId);
    headers.set('Cache-Control', 'no-store');

    const elapsed = (performance.now() - startTime).toFixed(1);
    console.error(`[http] ${method} ${url.pathname} ${status} ${elapsed}ms cid=${ctx.correlationId}`);
    if (proposalIdOf(req)) void recordProposalExecution(req, status, ctx);

    return new Response(body, { status, headers });
    })); // end withRequestContext / withSuperAdminWriteAudit

    // WebSocket upgrade paths return undefined; Bun handles the upgraded
    // response itself, so don't wrap it.
    if (response === undefined) {
      return response as any;
    }

    // Echo correlation ID on every response (router-dispatched paths also set
    // it already; this covers /health, /openapi.json, / and any future direct
    // return).
    const outHeaders = new Headers(response.headers);
    if (!outHeaders.has('X-Correlation-Id')) {
      outHeaders.set('X-Correlation-Id', ctx.correlationId);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  },

  websocket: {
    message(ws, message) {
      if (ws.data.kind === 'broadcast') {
        handleBroadcastMessage(ws, message);
        return;
      }
      // Kanban liveness slice intercepts `kanban:heartbeat_ack` frames so
      // the lag tracker can update without going through the wsManager
      // subscribe/unsubscribe path. Returns true when the frame was
      // consumed; false to fall through to the existing message handler.
      if (ws.data.kind === 'kanban' && handleKanbanInbound(ws, message)) {
        return;
      }
      wsManager.handleMessage(ws, message);
    },
    open(ws) {
      if (ws.data.kind === 'broadcast') {
        handleBroadcastOpen(ws);
        return;
      }
      wsManager.handleOpen(ws);
      if (ws.data.kind === 'kanban') {
        // Spec §"Kanban liveness" — start tracking + heartbeat broadcast
        // for this socket. The first heartbeat goes out on the next 15s
        // tick of the shared timer (registered lazily on first sub).
        registerKanbanSocket(ws);
      }
    },
    close(ws) {
      if (ws.data.kind === 'broadcast') {
        handleBroadcastClose(ws);
        return;
      }
      if (ws.data.kind === 'kanban') {
        unregisterKanbanSocket(ws);
      }
      wsManager.handleClose(ws);
    },
  },
});

// Give WebSocket manager access to the server for pub/sub
wsManager.setServer(server);
// fr row 14d-0b: `approvals:project:<id>` subscribes are pinned to the
// project's keycloak_tenant_id tag; the lookup lives outside the DB-free manager.
wsManager.setProjectLookup(lookupApprovalsWsProject);
// fr row 14d-2: per-tenant kanban channels — every kanban publish and every
// board/card subscribe is keyed on the board's tenant (lib/board-tenant-access).
wsManager.setKanbanTenantResolver(createKanbanWsTenantResolver());

// Graceful shutdown
const shutdown = async () => {
  console.log('[server] Shutting down...');
  server.stop();
  await redis.close();
  await closeConnection();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// E-2: emit AG-UI action registry summary once all route modules have
// imported and registered. Any slice that fails to import its actions will
// surface here as a too-low count.
logRegistrySummary();

// E-5: reap stale `executing` approvals every minute. Recovers wedged rows
// from process kills mid-handler — see domain/engagement/action-approvals.
setInterval(() => {
  reapStaleExecutingActions().catch((err) =>
    console.error('[action-approvals] reaper failed:', err),
  );
}, 60_000);

// Wave-3 analytics rollup worker. Idempotent start; multi-replica safety via
// pg advisory lock inside the worker. Disable via ANALYTICS_ROLLUP_DISABLED=true.
if (process.env.ANALYTICS_ROLLUP_DISABLED !== 'true') {
  startAnalyticsRollupWorker();
}

// Background document-status settle — reconciles in-flight uploads even with no
// Documents page open (and catches the ~21% lost-callback jobs). Single-flight;
// each row reconciled under its stored tenant. Disable via DOC_RECONCILE_ENABLED=false.
startDocumentReconcileWorker();

// Spec 2 §7 — scheduled-trigger tick worker (60s loop, SKIP LOCKED claim
// per replica). Opt-out: SCHEDULED_TRIGGER_TICK_DISABLED=true.
if (process.env.SCHEDULED_TRIGGER_TICK_DISABLED !== 'true') {
  startScheduledTriggerTickWorker();
}

// action_idempotency TTL reaper (hourly). Multi-replica safety via a pg
// transaction-scoped advisory lock inside the worker — one replica sweeps per
// tick, the rest no-op. This is garbage collection only: the claim path takes
// over expired rows atomically, so a missed sweep costs disk, never records.
// Disable via IDEMPOTENCY_SWEEP_DISABLED=true.
if (process.env.IDEMPOTENCY_SWEEP_DISABLED !== 'true') {
  startIdempotencySweepWorker();
}

// scheduled_trigger_runs retention reaper (daily, 90-day horizon). Same
// multi-replica advisory-lock discipline as the sweep above, and likewise pure
// garbage collection: the table is an append-only audit log, so a missed tick
// costs disk, never behaviour. Bounds a table that had NO retention of any kind
// — 65,822 rows on prod when this landed. Disable via
// SCHEDULED_TRIGGER_RUN_PRUNE_DISABLED=true; horizon via
// SCHEDULED_TRIGGER_RUN_RETENTION_DAYS.
if (process.env.SCHEDULED_TRIGGER_RUN_PRUNE_DISABLED !== 'true') {
  startScheduledTriggerRunPruneWorker();
}

// Approval expiry reaper (15-min). Unlike the two garbage collectors above this
// one is NOT optional bookkeeping — it is the only thing that can move an
// approval out of `pending` once `expires_at` has passed. routes/approvals.ts
// refuses to decide an expired row AND refuses to decide a non-pending row, so
// a pending-past-expiry approval is undecidable by construction and stays
// outstanding forever. 116 of 116 pending approvals on prod were in that state
// when this landed. Same multi-replica advisory-lock discipline as the workers
// above. Disable via APPROVAL_EXPIRY_DISABLED=true; interval via
// APPROVAL_EXPIRY_INTERVAL_MS.
if (process.env.APPROVAL_EXPIRY_DISABLED !== 'true') {
  startApprovalExpiryWorker();
}

// Project-request analysis timeout (5-min tick, 2h TTL). The only exit from
// `analysing` is the n8n agent's outline callback; with no outbox in fr, a run
// that dies leaves the request there forever. This moves it to `failed`
// (re-submittable) with error `analysis_timeout`. One conditional UPDATE, so no
// advisory lock is needed. Disable via PROJECT_REQUEST_ANALYSIS_TIMEOUT_DISABLED=true;
// TTL via PROJECT_REQUEST_ANALYSIS_TTL_MS.
if (process.env.PROJECT_REQUEST_ANALYSIS_TIMEOUT_DISABLED !== 'true') {
  startProjectRequestAnalysisTimeoutWorker();
}

// Project delivery reconcile (5-min tick, 25-project batch). Reads DERIVE
// delivery; this worker is the ONLY thing that stores it, and only so the
// bug-hunt partial unique index can free a repository's slot — an index cannot
// see a derived value, so an unstored closure means every later bug_hunt on
// that repo is a permanent 409 (services/project-delivered.ts explains).
// Deliberately no advisory lock: the stamp is one self-guarded UPDATE, so two
// replicas stamp a project at most once. Disable via
// PROJECT_DELIVERED_RECONCILE_DISABLED=true; interval via
// PROJECT_DELIVERED_RECONCILE_INTERVAL_MS; batch via
// PROJECT_DELIVERED_RECONCILE_BATCH_SIZE.
if (process.env.PROJECT_DELIVERED_RECONCILE_DISABLED !== 'true') {
  startProjectDeliveredReconcileWorker();
}

// mcp approval.closed (30s, fr #1684). Approvals leave `pending` from many writers and none
// re-sends to the mcp channel, so this tick tells every mcp address that received a request
// that it closed, once. Disable via MCP_APPROVAL_CLOSED_DISABLED=true; interval via
// MCP_APPROVAL_CLOSED_INTERVAL_MS.
if (process.env.MCP_APPROVAL_CLOSED_DISABLED !== 'true') {
  startMcpApprovalClosedWorker();
}

// ----------------------------------------------------------------------------
// TWO DIFFERENT RE-DELIVERY WORKERS ARE REGISTERED BELOW. Do not collapse them.
//
//   * APPROVAL NOTIFICATION re-delivery (`approvals.notified_at`) — outbound to
//     a HUMAN. It never writes `status`, never touches `callback_delivered_at`,
//     and cannot move a card. Its population is approvals nobody was ever TOLD
//     about.
//   * DE-BLOCK CALLBACK re-delivery (`approvals.callback_delivered_at`) —
//     outbound to n8n, and it MOVES A PLANKA CARD. Its population is approvals
//     that were answered but whose answer never reached the board.
//
// They are adjacent because both belong next to the expiry reaper, and a rebase
// once presented them as a single conflict. They are not one decision: the
// safety argument below applies to the second and not at all to the first.
//
// ⚠️ An earlier revision of THIS comment said the de-block worker "is still
// deliberately NOT registered". That was true when it was written and is now
// false — see the block immediately below for what changed and what did not.
// ----------------------------------------------------------------------------
// De-block callback re-delivery (15-min). Re-sends the n8n callback for
// approvals that were DECIDED but whose callback never landed, so the Planka
// card stayed in BLOCKED. Measured 2026-09-05: 282 cards blocked behind an
// already-approved approval with no pending approval coming to release them,
// all 282 with callback_delivered_at NULL on every approved row.
//
// ⚠️ THIS SLOT PREVIOUSLY HELD A REFUSAL, AND THE REFUSAL WAS CORRECT. It read
// "NO DE-BLOCK CALLBACK RE-DELIVERY WORKER IS REGISTERED HERE, DELIBERATELY"
// and gave two measurements. Both still stand as facts; what changed is that
// the worker no longer depends on either being false:
//
//  1. THE RECEIVER IS STILL NOT IDEMPOTENT. "AA Pattern - Approval Callback"
//     (n8n id yG1N9K2hTswEZNTq) computes shouldMoveCard without consulting the
//     card's current list, and `Move Card` is an unconditional
//     card.update{listId}; only the MERGE path has an `already_merged` branch.
//     Nothing about that has been fixed and this comment does not claim it has.
//  2. NULL STILL DOES NOT MEAN "FAILED" for the historical rows. They are NULL
//     because migration 109's column did not exist. Joining those card_ids
//     against live Planka found 424 BLOCKED but also 110 DONE, 45 TODO and 8
//     deleted — and a naive re-delivery would drag those 110 DONE cards back
//     into DOING.
//
// The refusal named its own exit condition: "it will still need either an
// idempotent receiver or a LIVE CARD-STATE JOIN before it may send anything."
// workers/deblock-callback-redelivery.ts takes the second option, and that gate
// is the whole licence for this registration:
//
//   ⭐ IT SENDS ONLY FOR A CARD THAT IS CURRENTLY IN THE BLOCKED LIST.
//
// That does not make objection (2) unlikely, it makes it INAPPLICABLE — a DONE
// card is not in BLOCKED, so it is never a candidate however ambiguous its NULL
// is. And it makes objection (1) harmless in the only direction we act: moving
// a card that IS in BLOCKED to DOING is the repair being asked for. The worker
// asks Planka rather than trusting the column, so it did not need the column to
// "record for long enough" first.
//
// ⚠️ The residual is one card, stated rather than hidden: a card can leave
// BLOCKED between the read and the POST. Planka has no compare-and-set on
// listId, so this cannot be made atomic. It is bounded to one row per tick and
// needs a human moving that exact card inside a ~5s window.
//
// Rate limits are safety properties here, not tuning: MAX_PER_RUN 10 and a
// 500 ms pace, because 20 of the original failures were Planka 504s under load.
// It does NOT fire on boot — the opposite of the expiry reaper above — because
// on a fresh deploy the backlog is 282 cards and every pod roll would start an
// outbound burst at the service whose overload caused this.
//
// Disable via DEBLOCK_REDELIVERY_DISABLED=true.
if (process.env.DEBLOCK_REDELIVERY_DISABLED !== 'true') {
  startDeblockRedeliveryWorker();
}

// U3 R5 ac_coverage re-delivery (5-min). Re-sends the per-AC coverage rows of decided
// qa.coverage_signoff approvals whose decide-path delivery did not complete (sink 5xx /
// 401 / 403 / network, pod roll, or fr#1333's decided_trace_id not yet present). Safe to
// re-send where the de-block callback above is not: the ILS sink replays an identical
// body (200 replayed). Two replicas never deliver the same approval because each delivery
// first CLAIMS a short LEASE on the row (`ac_coverage_delivery.lease_until/lease_owner`,
// stamped in one committed statement — the FOR UPDATE SKIP LOCKED is only inside that
// statement, never held across the HTTP), POSTs with no lock, and records only while the
// lease is still its own. Inert without AA_TRACE_SINK_URL/AA_TRACE_SINK_SECRET.
// See workers/ac-coverage-redelivery.ts. Disable via AC_COVERAGE_REDELIVERY_DISABLED=true.
if (process.env.AC_COVERAGE_REDELIVERY_DISABLED !== 'true') {
  startAcCoverageRedeliveryWorker();
}

// Approval re-delivery (15-min). The counterpart to the reaper above: expiry
// decides what to do with an approval nobody ANSWERED, this one re-sends an
// approval nobody was ever TOLD about. Notification is one-shot at mint, so a
// row whose mint-time routing resolved no reachable human kept notified_at NULL
// and was never retried by anything — 190 such rows on prod 2026-09-01, created
// 07-06..08-18, all before APPROVAL_FALLBACK_APPROVER_USER_ID existed. Migrations
// 105/106 then removed the expiry that used to sweep them out of `pending`, so
// they are now outstanding forever AND invisible.
//
// Two arms: rows within APPROVAL_REDELIVERY_MAX_AGE_DAYS (7) are re-delivered
// individually, capped at APPROVAL_REDELIVERY_MAX_PER_RUN (20) per tick; anything
// older is reported as ONE digest at most once per
// APPROVAL_REDELIVERY_DIGEST_INTERVAL_HOURS (24), because re-paging a human
// row-by-row about a 2-6 week old backlog is not a fix.
//
// It decides nothing and never touches `status`, `expires_at` or the approver
// roster. Disable via APPROVAL_REDELIVERY_DISABLED=true.
if (process.env.APPROVAL_REDELIVERY_DISABLED !== 'true') {
  startApprovalRedeliveryWorker();
}

// Early-access signup v2 (services/signup/*): finishes an approved signup's unfinished provisioning
// steps (the set-password email waits for them) and a rejected signup's cleanup. Inert unless
// FR_SIGNUP_ENABLED=true (only the main fr Deployment takes signups).
startSignupOnboardingTick();
logSignupTelegramStatus();
logSignupAppsStatus();

// n8n workflow catalogue refresher (10-min). Unlike the reapers above this one
// is on the READ path's critical line: `routes/workflows.ts` no longer crawls
// n8n on a user request at all, so this worker is the ONLY thing that ever
// populates that cache. If it does not run, GET /api/workflows serves 504
// forever.
//
// The crawl it performs is expensive and the cost is upstream: ~110 ms per
// workflow × 255 = ~36 s typical and up to ~166 s pessimistic at the 20-item
// page size (28 s / 82,635 ms were the measurements at the old 250-item page),
// measured 2026-08-10 from
// inside this pod (n8n eager-joins `activeVersion` and fans a tags query out
// per row). At a 10-min cadence that is a ~6.0% typical / ~27.7% pessimistic
// duty cycle on n8n's DB — marginally MORE than the 5.2% the old 30 s TTL was
// already burning, not less. What changes is WHERE it is spent: on this tick
// instead of on user requests, which 504'd 10 of 27 times.
//
// Disable via WORKFLOWS_CACHE_REFRESH_DISABLED=true (the boot-shape integration
// test does, since it points at no real n8n); interval via
// WORKFLOWS_CACHE_REFRESH_INTERVAL_MS.
if (process.env.WORKFLOWS_CACHE_REFRESH_DISABLED !== 'true') {
  startWorkflowsCacheWorker();
}

// E-14: integration coverage check. WARNs (or in strict mode, throws) when
// an integration module exists in src/integrations/ but has no read action
// registered under its `<basename>.` namespace. Default mode is `warn` so
// boot is never blocked while slices are still landing their action catalogs.
// Flip FR_ENFORCE_ACTION_COVERAGE=strict to fail boot once coverage is full.
// The rejection is HANDLED here. It used to be a bare `void runCoverageCheck()`
// — a floating promise — so in strict mode the throw landed on the
// process-level `unhandledRejection` handler at the top of this file, which
// only logs. Live result on the kag deployment: a `[FATAL] Unhandled rejection`
// with a stack into coverage-check.ts on EVERY boot, while the pod went on to
// serve traffic 2/2 Ready. That is the worst of both worlds — it reads like a
// crash, acts like a warning, and is attributed to nothing.
//
// Deliberately NOT process.exit(1) on strict: this same image runs as both
// `fr/fr` and `kag-frontend/kag`, and turning a boot-time check into a hard
// exit would CrashLoop whichever deployment happens to be behind. Making the
// failure loud, attributed, and non-fatal is the change; whether strict should
// additionally refuse to boot is a deployment decision, not a drive-by one.
void runCoverageCheck().catch((err: unknown) => {
  console.error(
    '[agui/coverage] coverage check failed:',
    err instanceof Error ? err.message : err,
  );
});

console.log(`FR Backend listening on http://${config.host}:${config.port}`);
// George 2026-10-27: the super_admin tenant-admin arm fails CLOSED without explicit config — say so.
{
  const warning = superAdminSwitchConfigWarning();
  if (warning) console.warn(warning);
}
console.log(`Environment: ${config.env}`);
console.log(`Health check: http://${config.host}:${config.port}/health`);
// Both gates DEFAULT TO FALSE and a disabled gate is silent by design — it is a
// rollout lever, never a DENY (see lib/package-license-gate.ts). That is the
// right semantic and stays, but silence means an env/manifest regression that
// drops one of these flags disables licence enforcement for a whole product
// with nothing in the logs to say so, and no test can see a Deployment's env.
// One line at boot makes the deployed answer readable directly from the pod.
console.log(
  `[license] package gates: fr=${config.frLicense.gateEnabled} kag=${config.kagLicense.gateEnabled}`,
);
