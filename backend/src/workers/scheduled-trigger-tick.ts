// src/workers/scheduled-trigger-tick.ts
//
// Spec 2 §7 — fr-backend cron loop for scheduled_triggers.
//
// Runs inside the Bun process every 60s, alongside the approvals reaper
// (server.ts) and the analytics rollup. Multi-replica safety via
// `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction: replica B
// sees rows replica A is processing as locked and skips them. The
// transaction-bound lock is released on COMMIT/ROLLBACK.
//
// Plan 2-B wires connector fetch + idempotency dedup + dispatcher dispatch.
//
// Opt-out: SCHEDULED_TRIGGER_TICK_DISABLED=true keeps the periodic loop off
// (CI/test runs set it so the loop does not race their fixtures).

import { queryClient } from '../db/client';
import { evaluateDue } from '../lib/cron-due';
import { compileMapper } from '../lib/payload-mapper';
import { deriveIdempotencyKey } from '../types/intake-envelope';
import { ConnectorConfig } from '../types/connectors';
import { getConnector, REFUSED_CONNECTOR_KIND_PREFIX } from '../connectors';
import {
  selectDispatcher,
  isPermanentDispatchError,
} from '../connectors/dispatcher';
import { encryption } from '../services/encryption';
import { db, userSecrets } from '../db/client';
import { eq, gte } from 'drizzle-orm';
import { isGlobalAndonEngaged } from '../lib/global-andon-gate';
import { NON_LIVE_PROJECT_STATUSES } from '../lib/project-live-status';
import type { IntakeEnvelope } from '../types/intake-envelope';
import { scheduledTriggerRuns, suggestedSchedules, projects } from '../db/schema';
import {
  detectCandidates,
  type RunRow,
} from '../services/suggestion-heuristic';
import {
  claimIdempotencyKey,
  releaseIdempotencyKeyQuietly,
} from '../domain/engagement/dedup-claim';
import { publishScheduledTriggerHealth } from './scheduled-trigger-health';
import {
  CONNECTOR_CONFIG_INVALID_PREFIX,
  TriggerConfigError,
  storedRunErrorText,
} from '../lib/run-error-text';

const TICK_INTERVAL_MS = 60_000;

// Spec 2 §13.2 — suggestion-detection heuristic cadence. The detector is
// cheap but not free; running it every tick is wasteful. Every 5 ticks
// (5 × 60s = 5 min) is a comfortable trade-off — candidate emergence is
// not time-critical (the inbox surface is browsed by hand).
let _ticksSinceHeuristic = 0;
const HEURISTIC_EVERY_N_TICKS = 5;
const HEURISTIC_LOOKBACK_DAYS = 21;

/**
 * How many CONSECUTIVE permanent dispatch failures auto-disable a trigger.
 *
 * Not 1. n8n answers `404 Received request for unknown webhook` for a workflow
 * that is merely DEACTIVATED, which is an ordinary transient state while
 * somebody edits or redeploys it — so a single-strike rule would permanently
 * switch off a healthy customer trigger for the length of a colleague's save,
 * with no notification. Three strikes means the deactivation has to outlast
 * three whole cron slots (6 minutes on the production every-2-minutes row)
 * before the worker touches the tenant's configuration.
 *
 * The counter lives on the row (`scheduled_triggers.permanent_failure_count`,
 * migration 094) rather than in process memory: the worker runs in every
 * replica and the streak has to survive a restart, a rollout, and a tick landing
 * on a different pod. It is reset to 0 by any successful dispatch, so only a
 * genuinely unbroken run of failures ever reaches this number.
 *
 * Still bounded work in the meantime: each sub-threshold slot `break`s out of
 * the batch after ONE failed POST, so the cost of the grace period is 3 dead
 * requests, not 3 × batch-size.
 */
export const PERMANENT_FAILURE_DISABLE_THRESHOLD = 3;

/**
 * Value written to `scheduled_triggers.disabled_reason` when the WORKER — not a
 * person — switches a trigger off.
 *
 * Stable machine-readable prefix + the status that caused it. An operator (or a
 * future alerting query) can select every worker-disabled row with
 * `disabled_reason LIKE 'auto:permanent_dispatch_failure%'`; a human disable via
 * PATCH leaves the column NULL, so the two are distinguishable with a plain
 * `IS NULL` and never by guessing from `last_run_error` prose.
 */
export function autoDisableReason(status: number): string {
  return `auto:permanent_dispatch_failure:http_${status}`;
}

export interface TickResult {
  claimedTriggers: number;
  errors: string[];
}

interface DueRow {
  id: string;
  tenant_id: string;
  project_id: string;
  cron: string;
  timezone: string;
  last_run_at: Date | null;
  /**
   * Previous terminal status. Used to transition-gate the audit row on the
   * `config_invalid` path — a permanently misconfigured `* * * * *` row is
   * re-evaluated every tick (it never advances last_run_at), and writing an
   * audit row each time would add 1,440 scheduled_trigger_runs rows/day
   * forever.
   */
  last_run_status: string | null;
  /**
   * Consecutive permanent dispatch failures so far (migration 094). Read here
   * and written back by every arm below; the row is disabled once incrementing
   * it reaches PERMANENT_FAILURE_DISABLE_THRESHOLD.
   */
  permanent_failure_count: number;
  source_connector: string;
  connector_config: unknown;
  payload_mapper: unknown;
  /**
   * Migration 068. The trigger's author, and — with `tenant_id` — the identity
   * `resolveSecret` checks a `user_secrets` row against. Selected here rather
   * than looked up later because the ownership decision must be made from the
   * SAME row the tick is executing, not from ambient request context (there is
   * none: this is a cron path).
   */
  created_by_user_id: string | null;
}

interface DecryptedSecret {
  value: string;
}

/**
 * The identity a trigger row carries, used to decide which `user_secrets` rows
 * that row is allowed to decrypt.
 *
 * Both fields come straight off `scheduled_triggers`:
 *   - `created_by_user_id` (migration 068, nullable `text`) — the author. BOTH
 *     insert paths set it to `user.id` (routes/scheduled-triggers.ts:137 and
 *     routes/suggested-schedules.ts:392, via `scheduledTriggerInsertValues`),
 *     and `routes/secrets.ts` stores every secret under that same `user.id`.
 *     It is NULL only on rows predating migration 068, whose backfill left it
 *     NULL by design ("we cannot recover the historical author from the row
 *     alone").
 *   - `tenant_id` (NOT NULL) — the workspace. Accepted as a second identity for
 *     the same reason `routes/connectors.ts` accepts it: workspace-scope
 *     secrets are stored under the tenant UUID, which in fr equals the
 *     workspace owner_id for the standard case.
 */
interface TriggerSecretOwner {
  created_by_user_id: string | null;
  tenant_id: string;
}

/**
 * Resolve a trigger's `connector_config.secret_id` to its decrypted value,
 * refusing any `user_secrets` row the trigger does not own.
 *
 * ⚠️ The ownership predicate is NOT optional garnish. `secret_id` is a
 * user-supplied field: `POST/PATCH /api/scheduled-triggers` persists
 * `connector_config` after `validateConnectorConfig`
 * (routes/scheduled-triggers-shared.ts:65), a shape-only `safeParse` that
 * contains zero occurrences of `secret_id` and therefore never checks who owns
 * the UUID inside it. Without the guard below, a user could name ANOTHER user's
 * secret and this worker would decrypt it on the next tick and hand it to
 * `connector.fetch()` — credential USE crossing an ownership boundary. The
 * value is never returned to the caller, which makes that quieter, not smaller.
 *
 * Returns `null` for "no id", "no such row", "not yours" and "could not
 * decrypt" ALIKE, deliberately: distinguishing them would turn this into a
 * row-existence oracle. Same property `routes/connectors.ts` holds.
 *
 * ⚠️ TWO KNOWN NARROWINGS, both fail-closed, both zero-rows today, both arming
 * on adoption — recorded here rather than discovered later:
 *
 *   1. A trigger created by A and later PATCHed by B (PATCH is tenant-scoped and
 *      does NOT rewrite `created_by_user_id`) still carries A's identity, so
 *      pointing it at B's OWN secret is refused. Correct per this predicate and
 *      identical to the dry-run route's behaviour, but it is a real functional
 *      narrowing, not a pure no-op.
 *   2. A pre-migration-068 row (`created_by_user_id` NULL) whose secret is owned
 *      by an ordinary user rather than stored under the tenant uuid falls to the
 *      `tenant_id` arm, misses, and is refused permanently.
 *
 * In both cases the connector raises `MISSING_SECRET` on every 60s tick and is
 * NOT on the permanent-failure path (that keys on HTTP dispatch status), so it
 * retries forever without auto-disabling, naming a secret that exists and is
 * correct. That is the right direction — a credential you may not use must not
 * be used — but it is a confusing failure, and anyone seeing MISSING_SECRET on a
 * secret they can see in the UI should look here first.
 *
 * ⚠️ `routes/connectors.ts` compares against `ctxTenantId(user.tenantId)`; this
 * compares the trigger row's raw `tenant_id`. Not a divergence: `ctxTenantId`
 * resolves from the REQUEST CONTEXT, and a cron tick has no request frame — the
 * trigger row is the only identity available, which is the point.
 */
export async function resolveSecret(
  secretId: string | null,
  owner: TriggerSecretOwner,
): Promise<DecryptedSecret | null> {
  if (!secretId) return null;
  const [row] = await db.select().from(userSecrets).where(eq(userSecrets.id, secretId));
  if (!row) return null;
  // `user_secrets` has no tenant_id column — `user_id` IS the owner. A secret
  // owned by user A must not be loadable by a trigger authored by user B.
  if (row.user_id !== owner.created_by_user_id && row.user_id !== owner.tenant_id) {
    return null;
  }
  try {
    const value = await encryption.decrypt(row.encrypted_value.buffer as ArrayBuffer, row.iv);
    return { value };
  } catch {
    return null;
  }
}

// Claim/release live in domain/engagement/dedup-claim.ts so the cron tick and
// the inbound webhook route (routes/intake-webhook.ts) share ONE implementation
// — they used to carry byte-identical private copies, and both copies carried
// the same `ON CONFLICT DO NOTHING` bug that made the 7-day TTL fiction.
// Re-exported here because this module is the historical import site.
export {
  claimIdempotencyKey,
  releaseIdempotencyKey,
  DEDUP_TTL_SECS,
} from '../domain/engagement/dedup-claim';

/**
 * Run one tick.
 *
 * Two independent transactions — one per source table. SKIP LOCKED is
 * scoped to the duration of each transaction; a row claimed in tx1
 * stays locked until tx1 commits, which is what we want because we
 * want the audit insert + parent-row update to be atomic together.
 */
export async function tickOnce(): Promise<TickResult> {
  const now = new Date();
  const result: TickResult = {
    claimedTriggers: 0,
    errors: [],
  };

  // Global andon: skip the entire tick while the cord is engaged. The
  // per-row `p.andon_engaged = false` filters below only cover PER-PROJECT
  // cords; the global singleton must freeze every project's scheduled work.
  if (await isGlobalAndonEngaged()) {
    return result;
  }

  const dispatcher = selectDispatcher(process.env);

  // Auto-disable notices, buffered until the transaction below COMMITS.
  //
  // Logging from inside the tx would make the log lie: a later row in the same
  // candidate loop can throw on its audit INSERT / parent UPDATE (those writes
  // are deliberately outside the per-row isolation boundary), which rolls the
  // WHOLE transaction back — including the `enabled = false` this line claims
  // landed. An operator reading "auto-disabled trigger X" would then go looking
  // for a disabled row that is still enabled and still firing. Emit only what
  // actually committed.
  const pendingAutoDisableLogs: string[] = [];

  // ----- scheduled_triggers ----------------------------------------------
  try {
    await queryClient.begin(async (tx) => {
      // Andon-cord (migration 050): join projects to skip andon-engaged ones.
      const candidates = await tx<DueRow[]>`
        SELECT t.id, t.tenant_id, t.project_id, t.cron, t.timezone, t.last_run_at,
               t.last_run_status, t.permanent_failure_count, t.source_connector,
               t.connector_config, t.payload_mapper, t.created_by_user_id
          FROM scheduled_triggers t
          JOIN projects p ON p.id = t.project_id
         WHERE t.enabled = true
           AND p.andon_engaged = false
           -- A project that is not live work (archived / pending / cancelled /
           -- delivered) must not keep firing its triggers: archive is one-way,
           -- so without this the row fires forever into a project nobody sees.
           AND p.status NOT IN ${tx([...NON_LIVE_PROJECT_STATUSES])}
         FOR UPDATE OF t SKIP LOCKED
      `;

      for (const c of candidates) {
        // Non-throwing due check. `isDue` throws CronValidationError on an
        // unparseable cron / unknown IANA timezone; from inside this loop that
        // throw escapes `queryClient.begin(...)` and rolls the WHOLE tick back.
        const due = evaluateDue(c.cron, c.timezone, c.last_run_at, now);
        if (due.ok && !due.due) continue;

        const connectorKind = c.source_connector;
        let status: string = 'ok';
        let errorMsg: string | null = null;
        let recordsProcessed = 0;
        // Set when a permanent dispatch failure took the row's consecutive
        // -failure streak all the way to PERMANENT_FAILURE_DISABLE_THRESHOLD.
        // Drives `enabled = false` on the parent row below — the only mechanism
        // in this file that actually stops a trigger from firing again, because
        // the candidate query is `WHERE t.enabled = true`.
        let autoDisable: { status: number; message: string } | null = null;
        // The streak itself, seeded from the row and written back by EVERY arm
        // below so the three UPDATE branches can never disagree about it. A
        // permanent failure bumps it; a successful dispatch zeroes it; a tick
        // that dispatched nothing at all leaves it untouched (an empty fetch is
        // not evidence either way about the destination).
        let permanentFailureCount = c.permanent_failure_count;

        // ---- per-row isolation boundary ---------------------------------
        // Everything that interprets THIS row's own configuration runs inside
        // this try. The enclosing transaction spans every enabled trigger of
        // every tenant, so an escaping throw (unknown `source_connector`,
        // unparseable cron, unknown timezone, a connector constructor blowing
        // up) does not just fail one row — it rolls back the work already
        // committed for the healthy rows in this tick, and because the bad
        // row's `last_run_at` never advances it stays due forever. One bad
        // row therefore wedges the GLOBAL scheduler permanently, with a single
        // console.error per tick as the only symptom.
        //
        // The audit INSERT + parent UPDATE below stay OUTSIDE this catch: a
        // write failure there is a real tx-level failure and must still abort.
        try {
          if (!due.ok) {
            // e.g. a row written by a migration/backfill/manual SQL that
            // bypassed the route-layer `validateCron`, or a timezone the
            // runtime's ICU build no longer carries.
            throw new TriggerConfigError(`invalid cron/timezone: ${due.error}`);
          }

          // Parse connector_config with ConnectorConfig discriminated union
          const configParse = ConnectorConfig.safeParse(c.connector_config);
          if (!configParse.success) {
            status = 'config_invalid';
            errorMsg =
              CONNECTOR_CONFIG_INVALID_PREFIX +
              configParse.error.issues.map((i) => i.message).join('; ');
          } else {
            const config = configParse.data;

            // Compile payload_mapper
            let compiledMapper: ReturnType<typeof compileMapper> | null = null;
            try {
              const mapperObj =
                typeof c.payload_mapper === 'object' && c.payload_mapper !== null
                  ? (c.payload_mapper as Record<string, string>)
                  : {};
              compiledMapper = compileMapper(mapperObj);
            } catch (err) {
              status = 'config_invalid';
              errorMsg = `payload_mapper error: ${err instanceof Error ? err.message : String(err)}`;
            }

            if (compiledMapper && status !== 'config_invalid') {
              // Resolve secret if present — secret_id lives inside connector_config JSONB,
              // not as a top-level column on scheduled_triggers.
              const secretId =
                'secret_id' in config ? (config.secret_id as string | null) : null;
              const secret = await resolveSecret(secretId, {
                created_by_user_id: c.created_by_user_id,
                tenant_id: c.tenant_id,
              });

              // Fetch records from the connector.
              //
              // `source_connector` is validated against a WIDER set than the
              // connector registry implements: the route enum and the
              // migration-045 CHECK both accept 'imap', which has no registry
              // entry and no ConnectorConfig variant — and nothing cross-checks
              // `source_connector` against `connector_config.kind`. So this
              // throws `Unknown connector kind: …` on rows the API happily
              // persisted. It is inside the isolation boundary for exactly
              // that reason.
              let connector: ReturnType<typeof getConnector>;
              try {
                connector = getConnector(
                  connectorKind as Parameters<typeof getConnector>[0],
                );
              } catch (kindErr) {
                // The registry's own sentence names the customer's configured
                // kind — fr-authored, so it is stored verbatim.
                const m = kindErr instanceof Error ? kindErr.message : '';
                if (
                  m.startsWith('Unknown connector kind: ') ||
                  m.startsWith(REFUSED_CONNECTOR_KIND_PREFIX)
                ) {
                  throw new TriggerConfigError(m);
                }
                throw kindErr;
              }

              // Resolve the destination ONCE, before consuming any records.
              // Read from the raw connector_config (before zod strips unknown
              // fields): rss/file/github_query/s3 configs may carry a
              // webhook_url out-of-band for dispatch purposes.
              const rawCfg =
                typeof c.connector_config === 'object' && c.connector_config !== null
                  ? (c.connector_config as Record<string, unknown>)
                  : {};
              const webhookUrl =
                typeof rawCfg['webhook_url'] === 'string'
                  ? rawCfg['webhook_url']
                  : typeof (config as { webhook_url?: string }).webhook_url === 'string'
                    ? (config as { webhook_url: string }).webhook_url
                    : undefined;
              const dispatchTarget = {
                kind: connectorKind as Parameters<typeof dispatcher.dispatch>[1]['kind'],
                webhook_url: webhookUrl,
              };

              // A trigger with no reachable destination is MISCONFIGURED, not
              // transiently failing. Treat it as config_invalid and skip the
              // fetch entirely.
              //
              // Doing this per-record instead (the obvious shape) is a real,
              // measured load bug: every record gets claimed and released again
              // on every tick forever — 200 INSERTs + 200 DELETEs per tick on
              // action_idempotency for a 200-record file trigger — inside the
              // transaction holding FOR UPDATE SKIP LOCKED, pushing tick
              // duration past the 60s interval so scheduled slots get dropped.
              // It also grew one audit row per tick without bound, because the
              // transition gate only suppresses repeats for config_invalid.
              //
              // Thrown rather than assigned so the per-row catch below records
              // it exactly like any other config defect — a `continue` here
              // would skip the audit INSERT and the parent UPDATE.
              const deliverability = dispatcher.canDeliver(dispatchTarget);
              if (!deliverability.delivered) {
                throw new TriggerConfigError(
                  `no destination configured: ${deliverability.reason ?? 'unknown'}`,
                );
              }

              let fetchErr: Error | null = null;

              try {
                for await (const record of connector.fetch(config, secret)) {
                  const idempKey = deriveIdempotencyKey({
                    trigger_id: c.id,
                    connector_kind: connectorKind,
                    stable_record_id: record.stable_id,
                  });

                  // The claim is a CROSS-ACTOR MUTEX, deliberately taken BEFORE
                  // dispatch and on the module-level `queryClient` (not `tx`) so
                  // it autocommits and is immediately visible to a second replica
                  // or to a manual run-now. Dispatch-then-claim would let two
                  // actors double-POST the same record to a non-idempotent
                  // operator webhook — strictly worse.
                  //
                  // The price of that choice: EVERY non-delivery path below must
                  // release the key again. An unreleased key stays burned for
                  // DEDUP_TTL_SECS (7 days), during which the record is silently
                  // lost while later ticks keep reporting status='ok',
                  // records_processed=0.
                  //
                  // Residual crash-window: if the process dies between the claim
                  // and the release, the key stays claimed until the TTL expires.
                  // That is the accepted trade-off — one lost record beats a
                  // duplicate POST to a non-idempotent endpoint — and it cannot
                  // be closed without making the claim and the HTTP dispatch a
                  // single atomic unit, which is not possible across the network
                  // boundary.
                  const inserted = await claimIdempotencyKey(c.tenant_id, idempKey);
                  if (!inserted) {
                    // Already dispatched — skip (idempotency)
                    continue;
                  }

                  try {
                    // Mapper compilation succeeded but a per-record mapper
                    // evaluation can still throw — build the envelope INSIDE
                    // the try so that path releases the key too.
                    const mapped = compiledMapper(record.raw);
                    const envelope: IntakeEnvelope = {
                      idempotency_key: idempKey,
                      source: {
                        kind: connectorKind,
                        trigger_id: c.id,
                        fetched_at: now.toISOString(),
                      },
                      mapped,
                      raw_record_id: record.stable_id,
                    };

                    // Target resolved once above the fetch loop.
                    const outcome = await dispatcher.dispatch(envelope, dispatchTarget);

                    if (outcome.delivered) {
                      recordsProcessed++;
                      // A 2xx from the destination is positive proof it is
                      // alive and accepting us, which retires whatever streak
                      // preceded it — that is what makes the threshold
                      // CONSECUTIVE rather than cumulative. Without this reset
                      // the counter is a lifetime tally, so a trigger that
                      // catches one 404 a month during unrelated n8n redeploys
                      // is disabled on the third one, months apart, having
                      // delivered perfectly in between.
                      permanentFailureCount = 0;
                    } else {
                      // Nothing was delivered anywhere. Counting this as a
                      // processed record is what let a valid rss/file trigger
                      // report status='ok', records_processed=N while dropping
                      // every record on the floor.
                      status = 'partial_failure';
                      const suffix = await releaseIdempotencyKeyQuietly(
                        c.tenant_id,
                        idempKey,
                      );
                      const msg =
                        `record ${record.stable_id} not delivered: ` +
                        `${outcome.reason ?? 'unknown'}${suffix}`;
                      if (!errorMsg) errorMsg = msg;
                    }
                  } catch (dispErr) {
                    // The key must be released on EVERY failure path, permanent
                    // or not. On the permanent path that looks pointless — the
                    // trigger is about to be disabled — but it is what makes the
                    // fix reversible: when an operator repairs the webhook_url
                    // and re-enables the trigger, these records are still
                    // deliverable instead of being suppressed for the 7-day
                    // DEDUP_TTL_SECS by keys claimed for a POST that 404'd.
                    const suffix = await releaseIdempotencyKeyQuietly(
                      c.tenant_id,
                      idempKey,
                    );
                    // ⛔ Never the raw text: `msg` is STORED on the run's
                    // `error_message` and the parent's `last_run_error`, both of
                    // which the customer's executions table renders. A
                    // DispatchHttpError (the customer's own URL + status) and an
                    // AppError keep their sentence; a raw fetch/Postgres throw
                    // is logged and stored as 'dispatch failed'.
                    const msg =
                      storedRunErrorText(dispErr, 'dispatch failed', 'scheduled-trigger-tick') +
                      suffix;

                    if (isPermanentDispatchError(dispErr)) {
                      // A permanent status (404 gone, 401/403 rejected, 400/422
                      // malformed) will fail identically for every record in
                      // this batch. Before this branch existed the catch below
                      // folded it into 'partial_failure' and kept POSTing — the
                      // measured production shape was 3 records × 720 slots =
                      // 2,160 dead POSTs/day, indefinitely.
                      //
                      // `break` (not `continue`) because the remaining records
                      // are headed for the same endpoint that just told us it
                      // will not take them: one probe per slot, not one per
                      // record. This happens on EVERY permanent slot, threshold
                      // reached or not, so the grace period below costs 3 dead
                      // requests in total rather than 3 × batch-size.
                      permanentFailureCount += 1;

                      if (
                        permanentFailureCount >= PERMANENT_FAILURE_DISABLE_THRESHOLD
                      ) {
                        // Streak complete — stop the trigger. See the
                        // `if (autoDisable)` arm below for why `enabled` and
                        // not `last_run_status` is the brake.
                        autoDisable = { status: dispErr.status, message: msg };
                        status = 'config_invalid';
                        errorMsg =
                          `auto-disabled after ${permanentFailureCount} consecutive ` +
                          `permanent HTTP ${dispErr.status} responses from the ` +
                          `dispatch target — this trigger will not run again until ` +
                          `it is fixed and re-enabled: ${msg}`;
                        break;
                      }

                      // Under the threshold: this is a strike, not a verdict.
                      //
                      // 'partial_failure' (not 'config_invalid') is load-bearing
                      // here. config_invalid means `ran === false`, so
                      // `last_run_at` is never advanced, so the row comes back
                      // due on EVERY 60s tick instead of on its own cadence —
                      // which would make the grace period BURN through its three
                      // strikes in three minutes flat on an every-2-minutes row,
                      // defeating the point of having one, and would meanwhile
                      // double the dead-request rate it is supposed to bound.
                      status = 'partial_failure';
                      errorMsg =
                        `permanent HTTP ${dispErr.status} from the dispatch target ` +
                        `(${permanentFailureCount} of ` +
                        `${PERMANENT_FAILURE_DISABLE_THRESHOLD} consecutive before ` +
                        `this trigger is auto-disabled): ${msg}`;
                      break;
                    }

                    // Transient (5xx, 408, 425, 429): leave the trigger enabled
                    // and let the next cron slot try again. This is the branch
                    // that must keep working — a fix that disables on 429 turns
                    // ordinary back-pressure into silent data loss.
                    status = 'partial_failure';
                    if (!errorMsg) errorMsg = msg;
                  }
                }
              } catch (err) {
                fetchErr = err instanceof Error ? err : new Error(String(err));
                status = 'partial_failure';
                // A connector's fetch error is the source's raw response
                // (GitHub/S3/RSS body, DNS, TLS text): logged, not stored.
                errorMsg = storedRunErrorText(err, 'source fetch failed', 'scheduled-trigger-tick');
              }

              if (status === 'ok' && fetchErr) {
                status = 'partial_failure';
              }
            }
          }
        } catch (rowErr) {
          status = 'config_invalid';
          // fr's own config sentences (TriggerConfigError) keep their text;
          // e.g. a secret-store or connector-constructor throw does not.
          errorMsg = storedRunErrorText(rowErr, 'trigger run failed', 'scheduled-trigger-tick');
        }

        // A `config_invalid` row never actually ran: the connector was never
        // reached, so advancing `last_run_at` would record a run that did not
        // happen (and would hide the row from the next tick's evaluation).
        const ran = status !== 'config_invalid';

        // Audit row + parent update inside the same tx so concurrent
        // crashes never leave the parent advanced past an unrecorded run.
        // Note: postgres.js 3.x in Bun does not serialize JS Date objects inside
        // transaction template literals — pass ISO strings explicitly.
        const finishedAt = new Date().toISOString();
        const nowIso = now.toISOString();

        // Because a config_invalid row keeps its old `last_run_at` it is
        // re-evaluated on EVERY tick. Writing an audit row each time would
        // add 1,440 rows/day forever for a single misconfigured
        // `* * * * *` trigger — so on that path record only the TRANSITION
        // into config_invalid. The parent's status/error is always refreshed.
        // `autoDisable` forces the audit row even when the previous status was
        // already 'config_invalid'. Without that term, a trigger sitting in
        // config_invalid for an unrelated reason (bad connector_config) that an
        // operator then "fixes" and re-enables into a 404 would be silently
        // disabled a second time with NO run row — and the run row's
        // `error_message` is the only field the operator UI actually renders
        // (frontend ExecutionsTable.svelte). Auto-disable happens at most once
        // per enable, so this cannot reintroduce unbounded row growth.
        if (ran || autoDisable || c.last_run_status !== 'config_invalid') {
          await tx`
            INSERT INTO scheduled_trigger_runs
              (trigger_kind, trigger_id, tenant_id, project_id,
               fired_at, finished_at, status, kind, records_processed, error_message)
            VALUES
              ('scheduled_intake', ${c.id}, ${c.tenant_id}, ${c.project_id},
               ${nowIso}, ${finishedAt}, ${status}, 'cron',
               ${recordsProcessed}, ${errorMsg})
          `;
        }

        // `autoDisable` is tested FIRST, ahead of `ran`. The two are not
        // mutually exclusive and the ordering decides which wins.
        //
        // `break`ing out of `for await (const record of connector.fetch(...))`
        // calls the generator's `return()`; a connector that throws during that
        // cleanup lands in the `catch (err)` above, which sets
        // status='partial_failure' — and 'partial_failure' means `ran === true`.
        // With `if (ran)` first, that arm would win and the row would be
        // UPDATEd without `enabled = false`: the disable is silently swallowed
        // by a cleanup error on the very path that requested it, and the
        // trigger keeps firing forever. Auto-disable is the strictly more
        // conservative outcome and therefore always takes precedence.
        if (autoDisable) {
          // THE stop. `enabled = false` removes the row from this worker's
          // candidate query (`WHERE t.enabled = true`, above) — it is the only
          // existing mechanism that ends dispatch, and it is already read by
          // the operator UI, which renders the row as "Disabled"
          // (frontend ChannelsList.svelte).
          //
          // NB setting only `last_run_status = 'config_invalid'` — the shape
          // this fix was first sketched as — would have made the defect WORSE,
          // not better: config_invalid means `ran === false`, so `last_run_at`
          // is never advanced, so the row is re-evaluated on EVERY 60s tick
          // instead of every 2nd minute. 720 dispatch slots/day would have
          // become 1,440. The status is the label; `enabled` is the brake.
          //
          // `disabled_reason` is the durable marker that tells an operator this
          // was the WORKER's doing and not a colleague's: `enabled = false`
          // alone is ambiguous, and the difference decides whether the right
          // response is "switch it back on" or "fix the webhook first".
          await tx`
            UPDATE scheduled_triggers
               SET enabled = false,
                   disabled_reason = ${autoDisableReason(autoDisable.status)},
                   permanent_failure_count = ${permanentFailureCount},
                   last_run_status = ${status},
                   last_run_error = ${errorMsg},
                   updated_at = ${nowIso}
             WHERE id = ${c.id}
          `;
          // Queued, NOT logged here. See the drain below the transaction.
          pendingAutoDisableLogs.push(
            `[scheduled-trigger-tick] auto-disabled trigger ${c.id} ` +
              `(tenant ${c.tenant_id}, project ${c.project_id}) after ` +
              `${permanentFailureCount} consecutive permanent HTTP ` +
              `${autoDisable.status}: ${autoDisable.message}`,
          );
        } else if (ran) {
          await tx`
            UPDATE scheduled_triggers
               SET last_run_at = ${nowIso},
                   last_run_status = ${status},
                   last_run_error = ${errorMsg},
                   permanent_failure_count = ${permanentFailureCount},
                   updated_at = ${nowIso}
             WHERE id = ${c.id}
          `;
        } else {
          await tx`
            UPDATE scheduled_triggers
               SET last_run_status = ${status},
                   last_run_error = ${errorMsg},
                   permanent_failure_count = ${permanentFailureCount},
                   updated_at = ${nowIso}
             WHERE id = ${c.id}
          `;
        }
        result.claimedTriggers += 1;
      }
    });
    // COMMITTED — only now is the disable a fact. Operator-facing signal at
    // error level: an auto-disable is an action taken ON the tenant's
    // configuration, not a routine failure.
    //
    // Inside the `try`, deliberately: if `begin()` threw, the tx rolled back and
    // NOTHING was disabled, so the queued lines must never be printed. They are
    // dropped with the exception, and the catch below records the real failure.
    for (const line of pendingAutoDisableLogs) console.error(line);
  } catch (err) {
    result.errors.push(
      `triggers: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ----- Spec 2 §13.2 — suggestion-detection heuristic -------------------
  // Runs every Nth tick to keep the cost contained. Failure is non-fatal:
  // the tick continues and the heuristic retries on the next opportunity.
  _ticksSinceHeuristic += 1;
  if (_ticksSinceHeuristic >= HEURISTIC_EVERY_N_TICKS) {
    _ticksSinceHeuristic = 0;
    try {
      const since = new Date(
        now.getTime() - HEURISTIC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      );
      const rows = (await db
        .select({
          tenant_id: scheduledTriggerRuns.tenant_id,
          project_id: scheduledTriggerRuns.project_id,
          triggered_by_user_id: scheduledTriggerRuns.triggered_by_user_id,
          kind: scheduledTriggerRuns.kind,
          fired_at: scheduledTriggerRuns.fired_at,
        })
        .from(scheduledTriggerRuns)
        .where(gte(scheduledTriggerRuns.fired_at, since))) as RunRow[];

      // Andon-cord (migration 050): pull engaged project ids and pass them
      // to the detector so emit-blocked projects don't surface candidates.
      const engagedRows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.andon_engaged, true));
      const andonedProjectIds = new Set(engagedRows.map((r) => r.id));

      const candidates = detectCandidates(rows, andonedProjectIds);
      for (const c of candidates) {
        await db
          .insert(suggestedSchedules)
          .values({
            tenant_id: c.tenant_id,
            project_id: c.project_id,
            user_id: c.user_id,
            source: 'heuristic',
            ad_hoc_summary: c.hint_summary,
            payload: { hour_utc: c.hour_utc, example_run_count: c.example_run_count },
          })
          .onConflictDoNothing();
      }
    } catch (err) {
      result.errors.push(
        `suggestion-heuristic: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/**
 * One scheduler cycle: run the tick, then publish health.
 *
 * Health is published AFTER the tick and OUTSIDE the `inFlight` guard's reset,
 * so the snapshot reflects the run that just finished and a slow push can never
 * make the next scheduled slot look "still in flight" and get dropped.
 *
 * The publish is deliberately NOT inside `tickOnce()`: its return value is a
 * per-tick delta while this is a whole-table snapshot.
 *
 * It is also OUTSIDE the tick's try/catch, so a tick that throws still
 * publishes — a wedged tick is precisely when the signal matters most. It has
 * its OWN try/catch: `publishScheduledTriggerHealth` documents that it never
 * throws, but a contract is not a proof (two of its own steps sit outside its
 * try blocks), and this function is invoked as `void runScheduledTriggerTickCycle()`
 * with no `.catch`, so an escaping rejection would surface as an unhandled
 * rejection — under Bun's default that is a process-level event, i.e. an
 * observability call able to take down the very intake it observes.
 *
 * WHY IT EXISTS: the log line below reported `errors=0` for a trigger whose
 * every dispatch 404'd, because `tickOnce` folds a per-row dispatch failure
 * into that row's `status` column, not into `TickResult.errors`. That is how
 * the `spec2-2b-smoke` trigger failed 8,956 consecutive times against a
 * deleted n8n workflow and produced no signal at all. This publish is the
 * signal.
 */
export async function runScheduledTriggerTickCycle(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await tickOnce();
    if (r.claimedTriggers > 0 || r.errors.length > 0) {
      console.log(
        `[scheduled-trigger-tick] claimed triggers=${r.claimedTriggers} ` +
          `errors=${r.errors.length}`,
      );
    }
    for (const e of r.errors) {
      console.error('[scheduled-trigger-tick]', e);
    }
  } catch (err) {
    console.error('[scheduled-trigger-tick] fatal:', err);
  } finally {
    inFlight = false;
  }

  try {
    await publishScheduledTriggerHealth();
  } catch (err) {
    console.error('[scheduled-trigger-tick] health publish threw:', err);
  }
}

/**
 * Start the periodic loop. Idempotent — calling twice is a no-op.
 * The first tick fires after one interval (no immediate kick-off — the
 * `last_run_at IS NULL` rows already cover the "fresh deploy" case).
 */
export function startScheduledTriggerTickWorker(): void {
  if (timer !== null) return;

  timer = setInterval(() => {
    void runScheduledTriggerTickCycle();
  }, TICK_INTERVAL_MS);
  console.log(
    `[scheduled-trigger-tick] scheduler started, interval=${TICK_INTERVAL_MS}ms`,
  );
}

export function stopScheduledTriggerTickWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
