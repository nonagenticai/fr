/**
 * fr-agui SPEC §3.3 — THE capability registry: every declared capability, with
 * the file that declares it (for guard messages and site keys).
 *
 * ⛔ Side-effect free, like every declaration (define.ts): the served spec
 * (`capabilities/served-spec.ts`) and the CI guards import this with no environment.
 *
 * Adding a capability is one line here plus its module. Everything else — the
 * route, the spec operation, the agent action, the MCP descriptor — is derived.
 */
import { APPROVAL_CAPABILITIES } from './approvals/approvals';
import { approvalsDecideCapability } from './approvals/decide';
import { capabilitiesInvokeCapability } from './agent/invoke';
import { conveyorListProjectTypesCapability } from './conveyor/list-project-types';
import type { Capability } from './define';
import { KAG_ASSET_CAPABILITIES } from './kag/assets';
import { KANBAN_ASSET_CAPABILITIES } from './kanban/assets';
import { KANBAN_CAPABILITIES, KANBAN_FROZEN_CAPABILITIES } from './kanban/board';
import { KAG_TOOL_CAPABILITIES } from './kag/tools';
import { KAG_REVIEWS_PASSTHROUGH_CAPABILITIES } from './kag/reviews-passthrough';
import { ARTIFACT_CAPABILITIES } from './projects/artifacts';
import { projectsCreateCapability } from './projects/create';
import { projectsGetCapability } from './projects/get';
import { projectsListCapability } from './projects/list';
import { GOVERNANCE_ARCHITECTURE_CAPABILITIES, PROJECT_ANDON_CAPABILITIES, PROJECT_ANDON_READ_CAPABILITIES, PROJECT_PM_CAPABILITIES } from './projects/assets';
import { PROJECT_EXECUTION_CAPABILITIES } from './projects/execution';
import { PROJECT_QUALITY_PEOPLE_CAPABILITIES } from './projects/quality-people';
import { ARTIFACT_DOWNLOAD_TOKEN_CAPABILITIES } from './projects/outputs';
import { PROJECT_COLLABORATION_CAPABILITIES } from './projects/collaboration';
import { PROJECT_ROUTE_CAPABILITIES } from './projects/project-routes';
import { PROJECT_CONVEYOR_HISTORY_CAPABILITIES } from './projects/conveyor-history';
import { PROJECT_FROZEN_CAPABILITIES } from './projects/project-frozen';
import { CARD_CAPABILITIES } from './cards/cards';
import { DECOMPOSITION_CAPABILITIES } from './decompositions/decompositions';
import { GOVERNED_ASSET_CAPABILITIES } from './library/governed-assets';
import { ASSET_SURFACE_CAPABILITIES } from './library/asset-surfaces';
import { ASSET_AUTHORING_CAPABILITIES } from './library/asset-authoring';
import { SERVICE_FROZEN_CAPABILITIES } from './platform/service-frozen';
import { ADMIN_FROZEN_CAPABILITIES } from './platform/admin-frozen';
import { ACCOUNT_FROZEN_CAPABILITIES } from './platform/account-frozen';
import { SYSTEM_CAPABILITIES } from './platform/system';
import { AGUI_CAPABILITIES } from './platform/agui';
import { CODING_CAPABILITIES } from './platform/coding';
import { INBOUND_CAPABILITIES } from './platform/inbound';
import { PROJECT_REQUEST_CAPABILITIES } from './project-requests/requests';
import { SERVICE_ROUTE_CAPABILITIES } from './service/service-routes';
import { RESEARCH_DISCOVER_CAPABILITIES } from './research/discover';
import { RESEARCH_MEDIA_CAPABILITIES } from './research/media';
import { RESEARCH_SCIENTIFIC_CAPABILITIES } from './research/scientific';
import { CONVEYOR_CATALOGUE_CAPABILITIES } from './conveyor/catalogue';
import { CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES, PROJECT_CONVEYOR_RETRY_CAPABILITIES } from './conveyor/failures';
import { CONVEYOR_FLOW_RUN_CAPABILITIES } from './conveyor/flow-runs';
import { PROJECT_REGISTER_CAPABILITIES } from './projects/registers';
import { PROJECT_DOCUMENT_CAPABILITIES } from './projects/documents';
import { ARCHITECTURE_CAPABILITIES } from './library/architecture';
import { ARCHITECTURE_MODELING_CAPABILITIES, ARCHITECTURE_OCCURRENCE_CAPABILITIES, ARCHITECTURE_UML_CAPABILITIES } from './library/architecture-modeling';
import { TOC_CAPABILITIES } from './library/toc';
import { CHANNEL_CAPABILITIES } from './settings/channels';
import { LLM_PROVIDER_CAPABILITIES } from './settings/llm-provider';
import { INAPP_MESSAGE_CAPABILITIES, INAPP_NOTIFICATION_CAPABILITIES } from './settings/messaging';
import { MY_SECRET_CAPABILITIES, SECRET_ASSET_CAPABILITIES } from './settings/secrets';
import { CONNECTOR_CAPABILITIES, TENANT_MEMBER_CAPABILITIES } from './settings/tenant';
import { URL_CREDENTIAL_CAPABILITIES } from './settings/url-credentials';
import { REPORTING_CAPABILITIES } from './operate/reports';
import { WORKER_CAPABILITIES } from './operate/workers';
import { N8N_TOOL_WORKFLOW_CAPABILITIES, WORKFLOW_VIEWER_CAPABILITIES } from './operate/workflows';
import { SCHEDULED_TRIGGER_CAPABILITIES } from './schedules/scheduled-triggers';
import { SUGGESTED_SCHEDULE_CAPABILITIES } from './schedules/suggested-schedules';
import { TENANT_BILLING_CAPABILITIES } from './account/billing';
import { GITHUB_APP_CALLBACK_CAPABILITIES } from './account/github-app';
import {
  MY_ARTIFACT_CAPABILITIES,
  MY_CHANNEL_PREF_CAPABILITIES,
  MY_DEPT_ROLE_CAPABILITIES,
  MY_LICENCE_CAPABILITIES,
  MY_SUPER_ADMIN_CAPABILITIES,
  MY_WORKSPACE_CAPABILITIES,
  MY_WORKSPACES_CAPABILITIES,
} from './account/me';
import { MY_NOTIFICATION_CAPABILITIES, MY_NOTIFICATION_PREF_CAPABILITIES } from './account/notifications';
import { REPOSITORY_CAPABILITIES } from './account/repositories';
import { MY_BUDGET_STATUS_CAPABILITIES, MY_TOPUP_CAPABILITIES, MY_USAGE_CAPABILITIES } from './account/usage';
import { WORKSPACE_MEMBER_CAPABILITIES } from './account/workspace-members';
import { AGENT_MEMBER_CAPABILITIES } from './agent-members/members';
import { ANALYTICS_CAPABILITIES } from './tools/analytics';
import { BRIDGE_CAPABILITIES } from './tools/bridge';
import { ANDON_CAPABILITIES, ANDON_STATE_CAPABILITIES } from './admin/andon';
import { KATA_CAPABILITIES } from './admin/katas';
import { ASSET_SCOPE_PROMOTE_CAPABILITIES } from './admin/asset-scope';
import { ASSET_CONSOLE_CAPABILITIES } from './admin/assets';
import { ADMIN_USER_CAPABILITIES, SYSTEM_USAGE_CAPABILITIES } from './admin/platform';
import { LICENSING_CAPABILITIES } from './admin/licensing';
import { PRICING_CAPABILITIES } from './admin/pricing';
import { PROVISIONING_CAPABILITIES } from './admin/provisioning';
import { SIGNUP_ADMIN_CAPABILITIES, SIGNUP_SERVICE_CAPABILITIES } from './admin/signup-approvals';
import { PROVISIONING_RECOVERY_CAPABILITIES } from './admin/provisioning-recovery';
import { DEPARTMENT_CAPABILITIES } from './admin/departments';
import { CONTROL_TOWER_CAPABILITIES, VERIFICATION_CAPABILITIES } from './admin/verification';
import { ASSET_ASSIGNMENT_CAPABILITIES } from './observe/asset-assignments';
import { CARD_TYPE_CAPABILITIES } from './observe/card-types';
import { ENGAGEMENT_CAPABILITIES } from './observe/engagements';
import { MEASURE_CAPABILITIES } from './observe/measure';
import { TRACEABILITY_CAPABILITIES } from './observe/traceability';

export interface RegisteredCapability {
  cap: Capability<any, any>;
  /** Backend-relative path of the declaring module. */
  file: string;
}

export const REGISTERED_CAPABILITIES: ReadonlyArray<RegisteredCapability> = [
  { cap: projectsCreateCapability, file: 'src/capabilities/projects/create.ts' },
  { cap: projectsListCapability, file: 'src/capabilities/projects/list.ts' },
  { cap: projectsGetCapability, file: 'src/capabilities/projects/get.ts' },
  { cap: conveyorListProjectTypesCapability, file: 'src/capabilities/conveyor/list-project-types.ts' },
  { cap: approvalsDecideCapability, file: 'src/capabilities/approvals/decide.ts' },
  { cap: capabilitiesInvokeCapability, file: 'src/capabilities/agent/invoke.ts' },
  // P4a1 — spec drain, KAG (out-of-agent-scope; the project-documents pair stays legacy for P2).
  ...KAG_ASSET_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/kag/assets.ts' })),
  ...KAG_TOOL_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/kag/tools.ts' })),
  // P1b (SPEC §13): the doorway request lifecycle, then internal/* + webhooks/*.
  ...PROJECT_REQUEST_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/project-requests/requests.ts' })),
  ...SERVICE_ROUTE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/service/service-routes.ts' })),
  // P4a2 — spec drain, research (out-of-agent-scope; tenant-scoped, no project-scoped route in these groups).
  ...RESEARCH_DISCOVER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/research/discover.ts' })),
  ...RESEARCH_SCIENTIFIC_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/research/scientific.ts' })),
  ...RESEARCH_MEDIA_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/research/media.ts' })),
  // P4a3 — spec drain, the rest of the tenant library (out-of-agent-scope; no route in these groups is project-scoped).
  // The conveyor catalogue was already in the spec: FROZEN operations.
  ...CONVEYOR_CATALOGUE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/conveyor/catalogue.ts' })),
  ...ARCHITECTURE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/architecture.ts' })),
  // The ArchiMate modeling lifecycle (30 routes behind the Models pages).
  ...ARCHITECTURE_MODELING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/architecture-modeling.ts' })),
  // UML (profile uml-2.5.1-p1) and trace links.
  ...ARCHITECTURE_UML_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/architecture-modeling.ts' })),
  ...ARCHITECTURE_OCCURRENCE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/architecture-modeling.ts' })),
  ...TOC_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/toc.ts' })),
  // P4b — spec drain, tenant settings and services (out-of-agent-scope; no route in these groups is project-scoped).
  ...LLM_PROVIDER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/llm-provider.ts' })),
  ...URL_CREDENTIAL_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/url-credentials.ts' })),
  ...CHANNEL_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/channels.ts' })),
  ...SECRET_ASSET_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/secrets.ts' })),
  ...MY_SECRET_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/secrets.ts' })),
  ...INAPP_MESSAGE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/messaging.ts' })),
  ...INAPP_NOTIFICATION_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/messaging.ts' })),
  ...TENANT_MEMBER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/tenant.ts' })),
  ...CONNECTOR_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/settings/tenant.ts' })),
  // P4b part 2 — schedules, reporting, workers and the n8n workflow browsers (no route in these groups is project-scoped).
  ...SCHEDULED_TRIGGER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/schedules/scheduled-triggers.ts' })),
  ...SUGGESTED_SCHEDULE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/schedules/suggested-schedules.ts' })),
  ...REPORTING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/operate/reports.ts' })),
  ...WORKER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/operate/workers.ts' })),
  ...WORKFLOW_VIEWER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/operate/workflows.ts' })),
  ...N8N_TOOL_WORKFLOW_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/operate/workflows.ts' })),
  // P4b part 3 — the caller's account (/api/me tenant parts), tenant billing, workspace members, the repositories
  // catalogue and the GitHub App callback (no route here is project-scoped; the callback is a browser redirect).
  ...MY_CHANNEL_PREF_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...MY_NOTIFICATION_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/notifications.ts' })),
  ...MY_NOTIFICATION_PREF_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/notifications.ts' })),
  ...MY_LICENCE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...MY_WORKSPACE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...MY_WORKSPACES_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...MY_ARTIFACT_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...MY_USAGE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/usage.ts' })),
  ...MY_BUDGET_STATUS_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/usage.ts' })),
  ...MY_TOPUP_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/usage.ts' })),
  ...TENANT_BILLING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/billing.ts' })),
  ...WORKSPACE_MEMBER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/workspace-members.ts' })),
  ...AGENT_MEMBER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/agent-members/members.ts' })),
  ...REPOSITORY_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/repositories.ts' })),
  ...GITHUB_APP_CALLBACK_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/github-app.ts' })),
  // P4b part 3 — the analysis-to-kanban bridge (nine rows mounted only with FR_FEATURE_BRIDGE: `http.mountedWhen`) and
  // the analytics rollup reads.
  ...BRIDGE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/tools/bridge.ts' })),
  ...ANALYTICS_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/tools/analytics.ts' })),
  // P4c part 1 — tenant-level oversight reads (card types, asset scope edges, traceability, measure, the delivery
  // audit, inference quality) and the tenant / platform admin surfaces (departments, the global andon, the
  // improvement gate + prompt canary, verification, the control tower). No route here is project-scoped.
  ...CARD_TYPE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/observe/card-types.ts' })),
  ...ASSET_ASSIGNMENT_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/observe/asset-assignments.ts' })),
  ...TRACEABILITY_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/observe/traceability.ts' })),
  ...MEASURE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/observe/measure.ts' })),
  ...ENGAGEMENT_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/observe/engagements.ts' })),
  ...DEPARTMENT_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/departments.ts' })),
  ...ANDON_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/andon.ts' })),
  ...KATA_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/katas.ts' })),
  ...VERIFICATION_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/verification.ts' })),
  ...CONTROL_TOWER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/verification.ts' })),
  // P4c part 2 — the super_admin row (minus licences / pricing / provisioning: part 3): the asset console, the
  // improvement observatories + procedure rollback, the platform access console, the system usage rollup, the
  // platform cord list, the caller's own role bits, and asset-scope promote. No route here is project-scoped.
  ...ASSET_CONSOLE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/assets.ts' })),
  ...ADMIN_USER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/platform.ts' })),
  ...SYSTEM_USAGE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/platform.ts' })),
  ...ANDON_STATE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/andon.ts' })),
  ...MY_SUPER_ADMIN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...MY_DEPT_ROLE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/account/me.ts' })),
  ...ASSET_SCOPE_PROMOTE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/asset-scope.ts' })),
  // P4c part 3 — the last of the super_admin row: the licensing console (licences admin API proxy + the cross-tenant
  // budget view / top-up), pricing (billing config proxy), and user provisioning. Platform-scoped; none is a project route.
  ...LICENSING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/licensing.ts' })),
  ...PRICING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/pricing.ts' })),
  ...PROVISIONING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/provisioning.ts' })),
  // P2 — project assets: the D12 read-only PM library (five PROJECT reads, agent-exposed to the project agent), and
  // the two groups P4c left pinned for this unit — the governance architecture reads and the project andon cord.
  ...PROJECT_PM_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/assets.ts' })),
  ...GOVERNANCE_ARCHITECTURE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/assets.ts' })),
  ...PROJECT_ANDON_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/assets.ts' })),
  // The project cord's read (members + the conveyor's gate).
  ...PROJECT_ANDON_READ_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/assets.ts' })),
  // P3 — execution observability: six PROJECT reads (the Execution hub's data), agent-exposed to the project agent.
  ...PROJECT_EXECUTION_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/execution.ts' })),
  // P2-c1 — the project's quality and knowledge-allocation READS (spec drain of three openapi literal operations,
  // same operationIds), agent-exposed to the project agent. The P2-c1 writes are agent actions over existing routes.
  ...PROJECT_QUALITY_PEOPLE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/quality-people.ts' })),
  // P2-c2 — the artifact FileCard's mint route, declared so its url + token are secrets.output (F15); never agent-exposed.
  ...ARTIFACT_DOWNLOAD_TOKEN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/outputs.ts' })),
  // P4d-2b — spec drain of the kanban group (out-of-agent-scope): the move + break-glass literal operations FROZEN,
  // the rest of /api/kanban/*, the kanban-WS liveness read, and the super_admin /api/assets/kanban/* passthrough.
  ...KANBAN_FROZEN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/kanban/board.ts' })),
  ...KANBAN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/kanban/board.ts' })),
  ...KANBAN_ASSET_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/kanban/assets.ts' })),
  // P4d-2a — spec drain of the projects / cards / approvals group (out-of-agent-scope; literal operations frozen).
  ...APPROVAL_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/approvals/approvals.ts' })),
  ...PROJECT_COLLABORATION_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/collaboration.ts' })),
  ...PROJECT_ROUTE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/project-routes.ts' })),
  // The project page's conveyor history (asks + answers, card timelines, pull requests).
  ...PROJECT_CONVEYOR_HISTORY_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/conveyor-history.ts' })),
  // P4d-2a part 2 — the literal Projects / Cards / Decompositions operations (frozen, out-of-agent-scope).
  ...PROJECT_FROZEN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/project-frozen.ts' })),
  ...CARD_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/cards/cards.ts' })),
  ...DECOMPOSITION_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/decompositions/decompositions.ts' })),
  // P4d-2c — the library group (governed asset kinds, library surfaces, bindings, asset scope, KAG documents, streams).
  ...GOVERNED_ASSET_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/governed-assets.ts' })),
  ...ASSET_SURFACE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/asset-surfaces.ts' })),
  ...ASSET_AUTHORING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/library/asset-authoring.ts' })),
  // P4d-2d — the platform group (webhooks, internal, notifications, reports fix, LLM provider, pricing,
  // inference, conveyor admin, secrets, GitHub App, usage, health; AG-UI + agent chat, coding, tools, intake, client errors).
  ...SERVICE_FROZEN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/service-frozen.ts' })),
  ...ADMIN_FROZEN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/admin-frozen.ts' })),
  ...ACCOUNT_FROZEN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/account-frozen.ts' })),
  ...SYSTEM_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/system.ts' })),
  ...AGUI_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/agui.ts' })),
  ...CODING_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/coding.ts' })),
  ...INBOUND_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/platform/inbound.ts' })),
  // P4d-2e — the last router.add rows: the artifact browser (7 NEW operations, out-of-agent-scope) and the
  // Evidence Review byte passthrough (5 routed rows, `http.specExempt`: no spec operation).
  ...ARTIFACT_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/artifacts.ts' })),
  ...KAG_REVIEWS_PASSTHROUGH_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/kag/reviews-passthrough.ts' })),
  // R311 PR 5 — the conveyor's project.start_failed / project.coach_failed callbacks (licence-only) and the start retry.
  ...CONVEYOR_FAILURE_WEBHOOK_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/conveyor/failures.ts' })),
  ...PROJECT_CONVEYOR_RETRY_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/conveyor/failures.ts' })),
  // Cockpit A5 / R-CK5 — the n8n execution hook's flow-run ingest (service account only).
  ...CONVEYOR_FLOW_RUN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/conveyor/flow-runs.ts' })),
  // R2 / REG-3 — the project's registers (RM #240 proxy).
  ...PROJECT_REGISTER_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/registers.ts' })),
  // R3 / DOC-3 — the project's Outputs (document trail) and the document reader's render proxy.
  ...PROJECT_DOCUMENT_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/projects/documents.ts' })),
  // Early-access signup v2 — the two service doors (intake, Telegram decision) and the super_admin onboarding screen.
  ...SIGNUP_SERVICE_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/signup-approvals.ts' })),
  ...SIGNUP_ADMIN_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/signup-approvals.ts' })),
  // Realm per app (2026-10-23): the explicit super_admin resend of a possibly-undelivered set-password email.
  ...PROVISIONING_RECOVERY_CAPABILITIES.map((cap) => ({ cap, file: 'src/capabilities/admin/provisioning-recovery.ts' })),
];

export const CAPABILITIES: ReadonlyArray<RegisteredCapability> = REGISTERED_CAPABILITIES;

export class DuplicateCapabilityError extends Error {
  constructor(what: string) {
    super(`capability registry: duplicate ${what}`);
    this.name = 'DuplicateCapabilityError';
  }
}

/**
 * Structural invariants across declarations: ids, operationIds and routes are
 * unique. Returns the reasons rather than throwing so the guard can print all
 * of them; `assertRegistryConsistent` throws for boot.
 */
export function registryErrors(entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES): string[] {
  const errors: string[] = [];
  const seen = (label: string, key: string, set: Set<string>) => {
    if (set.has(key)) errors.push(`duplicate ${label}: ${key}`);
    set.add(key);
  };
  const ids = new Set<string>();
  const opIds = new Set<string>();
  const routes = new Set<string>();
  for (const { cap } of entries) {
    seen('id', cap.id, ids);
    seen('operationId', cap.http.operationId, opIds);
    if (cap.http.path !== null) seen('route', `${cap.http.method} ${cap.http.path}`, routes);
  }
  return errors;
}

export function assertRegistryConsistent(entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES): void {
  const errors = registryErrors(entries);
  if (errors.length > 0) throw new DuplicateCapabilityError(errors.join('; '));
}
