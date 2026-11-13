// src/db/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { configuredDatabaseUrl, DATABASE_URL_UNSET_MESSAGE } from '../config';
// Named imports rather than `import * as schema from './schema'` — Bun's
// parallel module linker resolves star imports lazily, and the `schema`
// namespace passed to drizzle was occasionally partial when `db` was
// constructed. Result: `db.select().from(workspaces).limit(...)` chain
// methods missing on tables that hadn't yet been bound (observed as
// "TypeError: db.insert is not a function" / ".limit is not a function"
// on parallel test loads). Naming every table here pins binding at parse
// time before drizzle() is called.
import {
  projects,
  projectRequests,
  documents,
  repositories,
  projectRepositories,
  userSecrets,
  approvals,
  approvalDecisions,
  requiredApprovers,
  approvalCallbackUrls,
  projectStakeholders,
  memberKnowledgeAreas,
  executionSignoffBlocks,
  comments,
  projectMetrics,
  projectReports,
  userChannelPrefs,
  engagementDeliveries,
  telegramForumTopics,
  notificationLog,
  notifications,
  notificationPrefs,
  actionIdempotency,
  n8nExecutionMapping,
  inappMessages,
  codingAnalysisRuns,
  agentSessions,
  agentRuntimeSessions,
  analyticsRollups,
  analyticsRollupMeta,
  userRoles,
  agentMembers,
  workspaces,
  departments,
  departmentMembers,
  assetAssignments,
  assetBindings,
  projectAssetCopyIntents,
  projectConveyorStartAttempts,
  projectConveyorFailures,
  conveyorFlowRuns,
  signupApprovals,
  assetType,
  assignmentScope,
  linkKind,
  channels,
  channelKind,
  streams,
  assetStreamMembership,
  tenantImprovementProjects,
  capabilityAudit,
  scheduledTriggers,
  scheduledTriggerRuns,
  suggestedSchedules,
  provisioningAudit,
  superAdminTenantActions,
  budgetTopups,
  budgetAlertReceipts,
  cardSeekerLinks,
  streamKindEnum,
  assetKindEnum,
  approvalKindEnum,
  githubAppInstallations,
} from './schema';

const schema = {
  projects,
  projectRequests,
  documents,
  repositories,
  projectRepositories,
  userSecrets,
  approvals,
  approvalDecisions,
  requiredApprovers,
  approvalCallbackUrls,
  projectStakeholders,
  memberKnowledgeAreas,
  executionSignoffBlocks,
  comments,
  projectMetrics,
  projectReports,
  userChannelPrefs,
  engagementDeliveries,
  telegramForumTopics,
  notificationLog,
  notifications,
  notificationPrefs,
  actionIdempotency,
  n8nExecutionMapping,
  inappMessages,
  codingAnalysisRuns,
  agentSessions,
  agentRuntimeSessions,
  analyticsRollups,
  analyticsRollupMeta,
  userRoles,
  agentMembers,
  workspaces,
  departments,
  departmentMembers,
  assetAssignments,
  assetBindings,
  projectAssetCopyIntents,
  projectConveyorStartAttempts,
  projectConveyorFailures,
  conveyorFlowRuns,
  signupApprovals,
  assetType,
  assignmentScope,
  linkKind,
  channels,
  channelKind,
  streams,
  assetStreamMembership,
  tenantImprovementProjects,
  capabilityAudit,
  scheduledTriggers,
  scheduledTriggerRuns,
  suggestedSchedules,
  provisioningAudit,
  superAdminTenantActions,
  budgetTopups,
  budgetAlertReceipts,
  cardSeekerLinks,
  streamKindEnum,
  assetKindEnum,
  approvalKindEnum,
  githubAppInstallations,
} as const;

/**
 * fr-agui P4d-2e — the test-only refusal (tests/setup-env.ts): a `bun test` run with NO
 * DATABASE_URL outside CI must never reach a developer machine's real database. (config.ts has
 * had no localhost fallback since 2026-10-21 — an unset DATABASE_URL throws on first use — but
 * the preload's sentinel + this socket hook stay as the test-run backstop.) The preload sets
 * FR_TEST_DATABASE_URL_REFUSED=1 and this socket hook makes every connection attempt throw this
 * message instead. Never set in a deployment.
 */
export const TEST_DATABASE_URL_REFUSED_MESSAGE =
  '[fr tests] DATABASE_URL is unset and CI is not true: refusing to connect to any database. ' +
  'Start a throwaway postgres:18 and export DATABASE_URL to it.';

// postgres.js honours a `socket` factory (src/connection.js); its .d.ts does not list it.
// A factory that throws replaces the TCP dial entirely: the query rejects with this error and
// NO socket is ever opened.
function refusingSocket(message: string): postgres.Options<{}> {
  return {
    socket: () => {
      throw new Error(message);
    },
  } as postgres.Options<{}>;
}

// ⛔ NO DEFAULT DSN (George ruling 2026-10-21). Importing this module never throws — CI guard
// steps import it with no DATABASE_URL and must stay green — and never touches the throwing
// `config.database.url` getter at import. With DATABASE_URL unset/blank the pool is built with a
// refusing socket and a non-resolvable host, so the FIRST query rejects with
// DATABASE_URL_UNSET_MESSAGE and nothing is dialled. Do NOT "simplify" this to
// `postgres(process.env.DATABASE_URL ?? '')`: postgres-js treats an empty URL as "use
// PGHOST/PGPORT defaults", i.e. localhost:5432 — the very fallback that was removed.
function buildQueryClient(): postgres.Sql<{}> {
  const url = configuredDatabaseUrl();
  if (url === undefined) {
    return postgres({ host: 'database-url-unset.invalid', ...refusingSocket(DATABASE_URL_UNSET_MESSAGE) });
  }
  return postgres(
    url,
    process.env.FR_TEST_DATABASE_URL_REFUSED === '1' ? refusingSocket(TEST_DATABASE_URL_REFUSED_MESSAGE) : undefined,
  );
}

export const queryClient = buildQueryClient();

export const db = drizzle(queryClient, { schema });

/** Run a simple query to verify the database is reachable */
export async function validateConnection(): Promise<void> {
  await queryClient`SELECT 1`;
}

export interface ValidateConnectionRetryOptions {
  /** Total probes, including the first. Default 5. */
  attempts?: number;
  /** Delay before the first retry; doubles thereafter. Default 1000ms. */
  delayMs?: number;
  /** Called once per *retry* (never for the attempt that succeeds). */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Boot-time reachability probe with a bounded exponential backoff.
 *
 * Boot used to call `validateConnection()` exactly once and `process.exit(1)`
 * on any throw, which made startup a hard dependency on pgbouncer answering at
 * that instant. During the 2026-08-12 rollout it did not: the container died
 * with `CONNECT_TIMEOUT pgbouncer.example.com:6432` and
 * restarted. Kubernetes recovers from that, so this is availability rather
 * than correctness — it turns a pgbouncer roll or a cold DNS lookup into a few
 * seconds of in-process waiting instead of a restart that, from outside, looks
 * like the app being down.
 *
 * Bounded on purpose: an unreachable database must still fail boot. The last
 * attempt's error is rethrown **verbatim** so the operator reads the driver's
 * own error, with its code and severity, and not a wrapper.
 *
 * NOT used by `GET /health` — that probe must report the state right now, so a
 * 15s retry there would turn an outage into a hung health check.
 */
export async function validateConnectionWithRetry(
  opts: ValidateConnectionRetryOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 1_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await validateConnection();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      opts.onRetry?.(attempt, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/** Close the database connection pool */
export async function closeConnection(): Promise<void> {
  await queryClient.end();
}

// Re-export every table for downstream consumers (services + tests). Same
// list as the schema object above — kept aligned by the eyeball; if you
// add a table to schema.ts, add it to BOTH the import + this re-export so
// drizzle's known-schema list and consumers' direct table imports stay in
// sync.
export {
  projects,
  projectRequests,
  documents,
  repositories,
  projectRepositories,
  userSecrets,
  approvals,
  approvalDecisions,
  requiredApprovers,
  approvalCallbackUrls,
  projectStakeholders,
  memberKnowledgeAreas,
  executionSignoffBlocks,
  comments,
  projectMetrics,
  projectReports,
  userChannelPrefs,
  engagementDeliveries,
  telegramForumTopics,
  notificationLog,
  notifications,
  notificationPrefs,
  actionIdempotency,
  n8nExecutionMapping,
  inappMessages,
  codingAnalysisRuns,
  agentSessions,
  agentRuntimeSessions,
  analyticsRollups,
  analyticsRollupMeta,
  userRoles,
  agentMembers,
  workspaces,
  departments,
  departmentMembers,
  assetAssignments,
  assetBindings,
  projectAssetCopyIntents,
  projectConveyorStartAttempts,
  projectConveyorFailures,
  conveyorFlowRuns,
  signupApprovals,
  assetType,
  assignmentScope,
  linkKind,
  channels,
  channelKind,
  streams,
  assetStreamMembership,
  tenantImprovementProjects,
  capabilityAudit,
  scheduledTriggers,
  scheduledTriggerRuns,
  suggestedSchedules,
  provisioningAudit,
  superAdminTenantActions,
  budgetTopups,
  budgetAlertReceipts,
  cardSeekerLinks,
  streamKindEnum,
  assetKindEnum,
  approvalKindEnum,
  githubAppInstallations,
};
export type * from './schema';
