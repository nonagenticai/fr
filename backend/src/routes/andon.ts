// src/routes/andon.ts
//
// Andon-cord engage/disengage for projects, the global cord, and the
// super-admin cord list (which still reads `streams` rows' andon state).
//
// Spec ref: 2026-05-04 user request.

import { db } from '../db/client';
import {
  projects,
  streams,
  andonState,
  andonStateHistory,
} from '../db/schema';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { validateAuth } from '../middleware/auth';
import { UnauthorizedError, ForbiddenError, AppError, NotFoundError, handleError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { canReadProductionWorkflows } from '../lib/production-workflows-gate';
import { isGlobalAndonEngaged, readAndonVerdict, andonPermitsWork } from '../lib/global-andon-gate';
import { reportAndonGateAnswer } from '../lib/andon-gate-metrics';
import {
  publishAndonStateForMetrics,
  reportAndonProbeUnreadable,
  resetAndonProbeStreak,
  recordAndonHalt,
  normaliseAndonCaller,
  ANDON_CALLER_MAX_LENGTH,
} from '../lib/andon-halt-metrics';
import { isUuidShape } from '../lib/uuid-shape';
import { operatorAndonColumns, readProjectAndon } from '../services/project-andon';
import { joinSystemKataAndon, leaveSystemKataAndon, pruneOrphanKataHolders } from '../services/kata-andon';
import { PROJECT_KC_TENANT, loadProjectForRead } from '../lib/project-access';
import { projectIsNotPreApproval } from '../lib/project-live-status';
import { PLATFORM_TENANT_IDS } from './assets/_lib/system-union';
import { countRunningExecutions as n8nCountRunningExecutions } from '../integrations/n8n';
import { readN8nWorkerScale, scaleN8nWorker, type WorkerScaleReading } from '../lib/k8s-scale';

// ---------------------------------------------------------------------------
// THE ACTUATOR: one replica count, one Deployment.
//
// Engaging the global cord scales `n8n/n8n-worker` to 0; releasing it scales the
// worker back to 1 (lib/k8s-scale.ts). `EXECUTIONS_MODE: queue` plus
// `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true` make the worker the ONLY executor —
// production runs and the editor's own test runs alike — so 0 stops every
// execution while the editor, the REST API and n8n-mcp stay up.
//
// ⚠️ Inbound webhooks are still ACCEPTED by main and turned into queued
// executions, not dropped: the caller gets its normal response and nothing runs.
// Those drain on release. Full note at the header of lib/k8s-scale.ts — do not
// restate it here, and do not "fix" it by scaling main.
//
// ⛔ WHAT THIS REPLACED, AND WHY IT MUST NOT COME BACK. The cord used to list every
// active workflow and deactivate them one API call at a time, then reactivate the
// stored set on release. That is a SNAPSHOT: any workflow created or activated
// after the pull still ran, which makes it useless as a stop while flows are being
// rewritten. It also needed n8n healthy to make hundreds of API calls — the one
// moment a stop must not depend on the thing it is stopping. Scaling is one PATCH
// and is CONTENT-AGNOSTIC: it does not care which workflows exist.
//
// ⛔ The replica count is NOT declared in git (see
// clusters/prod/services/n8n/n8n-worker-deployment.yaml): kustomize-controller
// re-applies that file every 5m, so a declared value would reset a cord-pulled 0
// back to 1 and silently un-pull the cord.
//
// ⛔ `n8n` MAIN is never scaled: it terminates inbound webhooks and serves the
// editor/API that the rewrite itself needs.
// ---------------------------------------------------------------------------

/**
 * Wall-clock budget for the LIVE worker probe, in ms.
 *
 * The in-cluster API round trip measured 7 ms (2026-11-01); this budget exists so a
 * broken path cannot hold a page load open. The probe is a VERIFICATION, not a
 * dependency: if it cannot answer in this budget the honest answer is "unmeasured".
 */
const ANDON_LIVE_PROBE_TIMEOUT_MS = 4_000;

function authErrorToResponse(e: unknown): Response {
  if (e instanceof ForbiddenError) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  if (e instanceof UnauthorizedError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const code = (e as { code?: string }).code;
  if (typeof code === 'string' && code.startsWith('ERR_JWT_')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

interface AdminIdentity {
  id: string;
  email: string;
}

/**
 * Super-admin gate via the shared `isSuperAdmin` bridge: the `super_admin`
 * Keycloak realm role OR (legacy) the `SUPER_ADMIN_USER_IDS` env allowlist.
 * Platform-scoped, deliberately out-of-band so super-admin status doesn't
 * follow workspace switches.
 */
async function requireSuperAdmin(req: Request): Promise<AdminIdentity> {
  const user = await validateAuth(req);
  if (!isSuperAdmin(user)) {
    throw new ForbiddenError('super-admin only');
  }
  return { id: user.id, email: user.email };
}

async function setProjectAndon(
  projectId: string,
  engaged: boolean,
  by: string,
): Promise<{ andon_engaged: boolean } | null> {
  // `projects.id` is a `uuid` column (schema.ts:72). A `:projectId` that is not
  // UUID-shaped does not update zero rows — it aborts with 22P02 `invalid
  // input syntax for type uuid`, which escapes both engage and disengage as a
  // bare 500 instead of the 404 this surface promises. `null` is this
  // function's OWN miss value, so both callers keep returning the existing
  // `{ error: 'project_not_found' }` 404 and malformed stays
  // indistinguishable from absent (routes/approvals.ts:~408-438).
  //
  // `isUuidShape`, not `isValidUuid` (utils/tenant) — the latter pins the uuid
  // version nibble to 1-8 and the variant to [89ab] and would 404 real rows.
  if (!isUuidShape(projectId)) return null;

  const [row] = await db
    .update(projects)
    // Migration 206: the super_admin cord is an OPERATOR cord (reason 'operator'); disengaging
    // releases it (services/project-andon.ts operatorAndonColumns).
    .set(operatorAndonColumns(engaged, by))
    // fr row 14c: the by-id mutation carries the same platform predicate as
    // the list (handleListAndonState). A customer-tagged or untagged (NULL
    // tag; `IN (...)` never matches NULL) project updates zero rows and so
    // answers the same 404 an absent id does — the system never acts on
    // customer data, and the 404 does not reveal that the row exists.
    .where(and(eq(projects.id, projectId), inArray(PROJECT_KC_TENANT, [...PLATFORM_TENANT_IDS])))
    .returning({ andon_engaged: projects.andon_engaged });
  if (!row) return null;
  return { andon_engaged: row.andon_engaged };
}

export async function handleEngageProjectAndon(
  req: Request,
  projectId: string,
): Promise<Response> {
  let admin: AdminIdentity;
  try {
    admin = await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  const result = await setProjectAndon(projectId, true, admin.email);
  if (!result) return jsonResponse({ error: 'project_not_found' }, 404);
  return jsonResponse(result);
}

export async function handleDisengageProjectAndon(
  req: Request,
  projectId: string,
): Promise<Response> {
  let admin: AdminIdentity;
  try {
    admin = await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  if (await isGlobalAndonEngaged()) {
    return jsonResponse(
      {
        error: 'global_andon_engaged',
        message:
          'The global andon cord is engaged — disengage it first. Per-project cords cannot resume work while the system is globally frozen.',
      },
      409,
    );
  }
  const result = await setProjectAndon(projectId, false, admin.email);
  if (!result) return jsonResponse({ error: 'project_not_found' }, 404);
  return jsonResponse(result);
}

// ---------------------------------------------------------------------------
// The project cord's read (services/project-andon.ts)
// ---------------------------------------------------------------------------

/**
 * GET /api/projects/:id/andon — is this project halted, and by whom. Any member of the project's
 * tenant (the read lane), and the tenant's licence (`projects.getProjectAndon`). Absent, foreign
 * and malformed ids are one 404.
 */
export async function handleGetProjectAndon(req: Request, projectId: string): Promise<Response> {
  try {
    const user = await validateAuth(req);
    const project = await loadProjectForRead(db, user, projectId);
    const view = await readProjectAndon(project.id);
    if (!view) throw new NotFoundError('Project not found');
    return jsonResponse({ data: view });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Super-admin list endpoint. Returns every PLATFORM project + stream with
 * their current andon state. Used by /admin/andon.
 *
 * fr row 14c: the system never reads customer data — a project is listed only
 * when its own tag (`project_data.keycloak_tenant_id`) is a platform tenant,
 * a stream only when its `tenant_id` is. `IN (...)` never matches NULL, so an
 * untagged project fails closed (excluded).
 */
export async function handleListAndonState(req: Request): Promise<Response> {
  let admin: AdminIdentity;
  try {
    admin = await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const projectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      shape: projects.shape,
      andon_engaged: projects.andon_engaged,
      andon_engaged_at: projects.andon_engaged_at,
      andon_engaged_by: projects.andon_engaged_by,
    })
    .from(projects)
    // A project request's pre-approval row (pending / cancelled) has no board
    // and no work to halt; archived stays listed exactly as before.
    .where(and(inArray(PROJECT_KC_TENANT, [...PLATFORM_TENANT_IDS]), projectIsNotPreApproval()));

  const streamRows = await db
    .select({
      id: streams.id,
      name: streams.name,
      kind: streams.kind,
      tenant_id: streams.tenant_id,
      andon_engaged: streams.andon_engaged,
      andon_engaged_at: streams.andon_engaged_at,
      andon_engaged_by: streams.andon_engaged_by,
    })
    .from(streams)
    .where(inArray(streams.tenant_id, [...PLATFORM_TENANT_IDS]));

  return jsonResponse({
    projects: projectRows,
    streams: streamRows,
    _by: admin.email,
  });
}

// ---------------------------------------------------------------------------
// Global andon — migration 065. One singleton row in `andon_state`. The
// header AndonCord button reflects this state; a single super-admin click
// toggles it. When engaged, every n8n automation workflow consults
// /api/internal/andon and silently halts. Not per-tenant — one switch
// halts everything across all workspaces until released.
// ---------------------------------------------------------------------------

/**
 * The cord's three INDEPENDENT axes, never collapsed into one boolean.
 *
 * `intent` — what a human asked for (fr DB `engaged`).
 * `n8n_pause` — whether the actuator attempt landed (DB evidence).
 * `n8n_live` — what the n8n-worker Deployment says RIGHT NOW (bounded probe).
 *
 * The page previously rendered "halts all new work system-wide" from a single
 * success count. When the call failed that count was 0 — and the page still
 * asserted a system-wide halt. Only all three axes together can support that
 * sentence, and that is why the field names never say "paused" any more.
 */
export type AndonIntent = 'engaged' | 'released' | 'unreadable';

/**
 * What the LAST actuator attempt recorded (migration 226 columns).
 *
 * ⚠️ `worker_scaled_at` IS OVERLOADED: the release path reuses it to mean "the
 * scale-up ran at" (see {@link handleDisengageAndon}). So this block is only a
 * statement about a PULL when `intent === 'engaged'`; consumers must derive
 * `pause_attempt` as `n/a` otherwise. Engage clears the three columns in the same
 * statement that flips the flag ({@link setEngagedFlag}), so while engaged these
 * values always describe the CURRENT pull, never a stale one.
 */
export interface AndonPauseEvidence {
  /** When the actuator attempt ran. `null` = no attempt is recorded at all. */
  attempted_at: Date | null;
  /** Failure summary from that attempt, or `null` if it was clean. */
  error: string | null;
  /**
   * `spec.replicas` of `n8n-worker` as READ BACK after that attempt.
   *
   * ⭐ THREE FACTS, NEVER TWO. `null` = NOT MEASURED (no attempt is recorded, or
   * the call to the API server failed); `0` = the attempt ran and the worker is
   * stopped; `1` = the attempt ran and the worker is up. This used to be the count
   * of deactivated workflows, derived as `paused_workflow_ids?.length ?? 0`, so a
   * NULL id set rendered as `0` — indistinguishable from a real attempt that
   * paused nothing. That collapse is what this struct exists to prevent, and the
   * same rule now applies to the replica count: a failed call is NOT a 0.
   *
   * ⛔ Do not confuse this with the TOP-LEVEL `worker_replicas` on the view/toggle
   * result, which is what `pullFeedback` and the operator's post-pull line read.
   */
  worker_replicas: number | null;
}

/**
 * A bounded, best-effort measurement of what n8n reports right now.
 *
 * ⭐ The two null-ish states are DIFFERENT FACTS and must never be collapsed:
 *   * `n8n_live === null`          → NOT PROBED (no `?live=1`, or not super-admin).
 *   * `n8n_live.active_count === null` → PROBED AND FAILED (timeout / unreachable).
 * Neither may ever be rendered as "quiet". A count of 0 is a MEASUREMENT; a
 * failed probe is the absence of one, and that distinction IS the fix.
 */
export interface AndonLiveProbe {
  measured_at: Date;
  /** `spec.replicas` of `n8n-worker`. `null` = the probe failed. */
  worker_replicas: number | null;
  /** `status.availableReplicas` — Ready pods. `null` = the probe failed. */
  available_replicas: number | null;
  /** Why the probe failed, or `null` when it succeeded. */
  error: string | null;
}

export interface AndonView {
  engaged: boolean;
  engaged_at: Date | null;
  engaged_by: string | null;
  /**
   * `spec.replicas` of `n8n-worker` as fr last MEASURED it. `0` = every automatic
   * execution is stopped; `1` = the line is running; `null` = not measured (never
   * render that as 1 or 0 — see {@link AndonPauseEvidence}).
   */
  worker_replicas: number | null;
  /**
   * What a human asked for. `unreadable` replaces the old silent lie: the
   * `!row` branch used to report `engaged: false` with no way for a caller to
   * tell "released" apart from "the switch itself could not be read".
   */
  intent: AndonIntent;
  n8n_pause: AndonPauseEvidence;
  /** `null` = NOT PROBED. See {@link AndonLiveProbe}. */
  n8n_live: AndonLiveProbe | null;
  /**
   * The kata projects holding the instance (`andon_state.kata_holders`). Non-empty = the worker
   * stays at 0 even with the operator's cord released (see {@link releaseGlobalCord}).
   */
  kata_holders: string[];
}

/**
 * Ask the API server what `n8n/n8n-worker` is doing right now, and NEVER throw.
 *
 * Two independent failure containments, because this sits on a page-load path:
 *   1. `readN8nWorkerScale` catches its own faults (a missing token, a 403, a bad
 *      TLS handshake) and returns `replicas: null` — never 0.
 *   2. an outer WALL-CLOCK race, so a hung connection cannot hold a page open.
 *      On expiry the answer is `unmeasured`.
 *
 * ⛔ On either failure the counts are `null`. Defaulting `replicas` to 0 would
 * make an unreachable API server look like a verified stopped worker — exactly the
 * lie this whole read exists to prevent. That distinction is the same one the old
 * n8n-workflow probe made, and it survives the actuator change untouched.
 */
async function probeWorkerScale(): Promise<AndonLiveProbe> {
  const measured_at = new Date();
  const budgetMs = ANDON_LIVE_PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = await Promise.race([
      readN8nWorkerScale(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
    if (reading === null) {
      return {
        measured_at,
        worker_replicas: null,
        available_replicas: null,
        error: `n8n-worker scale probe exceeded ${budgetMs}ms`,
      };
    }
    return {
      measured_at,
      worker_replicas: reading.replicas,
      available_replicas: reading.available,
      error: reading.error,
    };
  } finally {
    // The losing side of the race must not keep the process awake for its full
    // budget: this runs on the 30 s header poll.
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the singleton cord state.
 *
 * ⛔ `opts.live` MUST stay opt-in. `GET /api/andon` is polled every 30 s by
 * EVERY authenticated user (`AndonCord.svelte` POLL_MS = 30_000) and the same
 * reader backs `GET /api/internal/andon`, which n8n itself calls — probing
 * unconditionally would fan every poll out to n8n and let an n8n→fr→n8n loop
 * form. The probe runs only for a super-admin's `?live=1` and inside the
 * engage/disengage responses.
 */
interface AndonRow {
  engaged: boolean;
  engaged_at: Date | null;
  engaged_by: string | null;
  worker_replicas: number | null;
  worker_scaled_at: Date | null;
  worker_scale_error: string | null;
  kata_holders: string[];
}

async function readAndonRowFromDb(database: AndonDb = db): Promise<AndonRow | undefined> {
  const [row] = await database
    .select({
      engaged: andonState.engaged,
      engaged_at: andonState.engaged_at,
      engaged_by: andonState.engaged_by,
      worker_replicas: andonState.worker_replicas,
      worker_scaled_at: andonState.worker_scaled_at,
      worker_scale_error: andonState.worker_scale_error,
      kata_holders: andonState.kata_holders,
    })
    .from(andonState)
    .where(eq(andonState.id, 1))
    .limit(1);
  return row ? { ...row, kata_holders: (row.kata_holders ?? []).map(String) } : undefined;
}

async function readAndon(opts?: { live?: boolean }, database: AndonDb = db): Promise<AndonView> {
  const row = await readAndonRowFromDb(database);
  // Migration 065 INSERTs the singleton row; this should always exist.
  //
  // ⭐ THE SPLIT HERE IS DISPLAY-vs-GATE, AND THAT IS THE POLICY (fr#1208) — it
  // is NOT a general preference for fail-open, which is how this comment used to
  // read ("the safety-rail bias is 'let production run'"). The single statement
  // lives in `ANDON_GATE_POLICY` / `andonPermitsWork` in lib/global-andon-gate.ts:
  // every GATE — the shared gate, the router-dedupe brake, coding-github — fails
  // CLOSED on an absent or unreadable row, because a broken emergency stop is an
  // engaged one.
  //
  // `readAndon` is a DISPLAY surface. It halts nothing: its consumers are
  // pullFeedback, the post-pull line and the UI tooltip, plus
  // `handleGetAndonInternal`, which supplies gates with the REASON axis they need
  // in order to fail closed. So it keeps `engaged: false` and NAMES the absence in
  // `intent` (`'unreadable'` here, mapped to the interlock's `'uninitialised'`),
  // which is what lets a UI stop presenting a broken switch as a released one and
  // lets a gate tell absence from a read that threw. Display may be honest about
  // not knowing; a gate may not act on not knowing.
  //
  // ⛔ Do NOT "reconcile" this with the gates by making it refuse or 500 — gates
  // READ this endpoint, so starving them of the reason axis would turn every
  // absence into an undiagnosable `andon_check_failed`.
  // No probe here: `unreadable` outranks every live measurement anyway.
  if (!row) {
    return {
      engaged: false,
      engaged_at: null,
      engaged_by: null,
      worker_replicas: null,
      intent: 'unreadable',
      n8n_pause: { attempted_at: null, error: null, worker_replicas: null },
      n8n_live: null,
      kata_holders: [],
    };
  }
  // ⛔ ONE FACT, ONE FIELD — and it does NOT default. `worker_replicas` is a
  // measurement read back from the API server, so NULL means "fr could not
  // measure", which is not the same fact as "the worker is at 0". The top-level
  // view and the nested evidence happen to carry the same value; they are kept as
  // two fields because the evidence block is only a statement about the LAST
  // ATTEMPT (see {@link AndonPauseEvidence}) while the view is the current row.
  return {
    engaged: row.engaged,
    engaged_at: row.engaged_at,
    engaged_by: row.engaged_by,
    worker_replicas: row.worker_replicas,
    intent: row.engaged ? 'engaged' : 'released',
    n8n_pause: {
      attempted_at: row.worker_scaled_at,
      error: row.worker_scale_error,
      worker_replicas: row.worker_replicas,
    },
    n8n_live: opts?.live ? await probeWorkerScale() : null,
    kata_holders: row.kata_holders,
  };
}

/**
 * The cord as a CUSTOMER tenant sees it: a plain released cord. Same shape as
 * {@link readAndon}'s view so every consumer (AndonCord, AndonStatusPanel)
 * renders its normal "no andon" state; no platform field survives.
 */
function customerAndonView(): AndonView {
  return {
    engaged: false,
    engaged_at: null,
    engaged_by: null,
    // ⭐ THE NEUTRAL RELEASED SHAPE, NOT NULL. A customer tenant is shown an
    // ordinary released cord (owner rule 2026-09-30: system data never visible to a
    // customer), and an ordinary released cord has the worker at 1. `null` would
    // render "NOT MEASURED" in the header of every non-platform tenant — a loud
    // unknown where the old neutral view said 0 paused. Same trade as that 0: the
    // customer's view is a shape, and the real cord is metrics-only for them.
    worker_replicas: 1,
    intent: 'released',
    n8n_pause: { attempted_at: null, error: null, worker_replicas: null },
    n8n_live: null,
    kata_holders: [],
  };
}

/** The pool, or the transaction an instance-cord decision runs in ({@link withInstanceCordLock}). */
export type AndonDb = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute' | 'transaction'>;

/**
 * Longest a pull/release/kata join/leave waits for another one to finish. A holder runs at most
 * two live probes and one scale (each bounded by lib/k8s-scale.ts's 4 s per call), so 30 s is a
 * broken holder, not a slow one; the waiter then answers 503 `andon_busy` and changes nothing.
 */
const INSTANCE_CORD_LOCK_TIMEOUT = '30s';

/**
 * Serialise every decision about the instance's replica count: the operator's pull and release
 * and a kata's join and leave. Each reads who holds, then scales; without one order between them
 * a release could read "nobody holds" just before another holder's scale-to-0 and then land its
 * scale-to-1 after it.
 *
 * ⭐ THE WHOLE BODY RUNS ON `tx`, the connection that holds the lock: a body that took a second
 * pooled connection while holding the lock could starve the pool once enough waiters each hold
 * one, and nothing would ever release. The body's writes commit with the lock.
 *
 * ⭐ THE k8s PATCH STAYS INSIDE THE LOCK, deliberately. Deciding under the lock and PATCHing after
 * commit would let two PATCHes land in the opposite order to their decisions (a release decides
 * 1, a kata then joins and decides 0, the kata's 0 lands, then the release's 1 lands: worker up
 * while a kata holds). Holding the lock across a bounded HTTP call is the price of ordering;
 * `lock_timeout` bounds every waiter, so a wedged holder can never hang the others.
 *
 * A TRANSACTION-scoped advisory lock (pgbouncer transaction pooling: never a session lock — see
 * lib/priority-change.ts).
 */
async function withInstanceCordLock<T>(fn: (tx: AndonDb) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${INSTANCE_CORD_LOCK_TIMEOUT}'`));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fr.andon.instance-cord'))`);
      return fn(tx);
    });
  } catch (err) {
    if (pgErrorCode(err) === '55P03') {
      throw new AppError(503, 'Another andon pull or release is still running; nothing changed. Try again.').withCode('andon_busy');
    }
    throw err;
  }
}

/** The SQLSTATE of a postgres.js error, also when drizzle wrapped it. */
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === 'string') return e.code;
  return typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
}

/** Store what a scale attempt measured (migration 226 columns). */
async function recordWorkerScale(scale: WorkerScaleReading, database: AndonDb = db): Promise<void> {
  await database
    .update(andonState)
    .set({ worker_replicas: scale.replicas, worker_scaled_at: new Date(), worker_scale_error: scale.error })
    .where(eq(andonState.id, 1));
}

/** Flip ONLY the engaged flag. (History is app-recorded via recordAndonFlip
 * since migration 085 dropped the DB trigger.)
 *
 * ⚠️ On ENGAGE this also clears the migration-226 actuator evidence, in the SAME
 * statement that flips the flag. Without that there is a window — flag already
 * true, scale not yet issued — in which the row carries the PREVIOUS cycle's
 * `worker_scale_error` (a release that failed to scale the worker back up leaves
 * one behind). A reader in that window would derive "this pull's scale failed"
 * from an error about a release that happened minutes ago. Clearing here makes
 * the invariant simple and checkable: while engaged, these three columns always
 * describe the CURRENT pull or are honestly empty.
 */
async function setEngagedFlag(engaged: boolean, by: string, database: AndonDb = db): Promise<void> {
  if (engaged) {
    // ⭐ UPSERT ON THE PULL, NOT AN UPDATE. Migration 065 inserts the singleton, but
    // if it is ever MISSING (a restored dump, a half-applied migration) a plain
    // UPDATE writes zero rows — and every gate then fails CLOSED on the absence: the
    // whole estate is halted and the one control built for that moment records
    // nothing. The standing ruling is that the cord must always work, so the PULL
    // creates the row it needs. The RELEASE below stays a plain UPDATE: a release
    // with no row has nothing to release, and inventing a released row there would
    // fabricate a state nobody observed.
    await database
      .insert(andonState)
      .values({
        id: 1,
        engaged: true,
        engaged_at: new Date(),
        engaged_by: by,
        worker_replicas: null,
        worker_scaled_at: null,
        worker_scale_error: null,
      })
      .onConflictDoUpdate({
        target: andonState.id,
        set: {
          engaged: true,
          engaged_at: new Date(),
          engaged_by: by,
          worker_replicas: null,
          worker_scaled_at: null,
          worker_scale_error: null,
        },
      });
    return;
  }
  await database
    .update(andonState)
    .set({ engaged: false, engaged_at: null, engaged_by: null })
    .where(eq(andonState.id, 1));
}

/**
 * Append an audit-history row for an actual engage/release TRANSITION.
 * App-recorded since migration 085 (which dropped the AFTER-UPDATE trigger):
 * the trigger copied `engaged_by`, which is nulled on release, so release rows
 * lost their actor. Recording here captures the acting super-admin on BOTH
 * engage and release. Best-effort — a history-write failure must not fail the
 * pull itself (the audit trail is secondary to the freeze landing).
 */
async function recordAndonFlip(engaged: boolean, by: string, database: AndonDb = db): Promise<void> {
  try {
    // Its own (nested = SAVEPOINT) transaction, so a failed history write inside the
    // instance-cord transaction rolls back only itself, never the pull.
    await database.transaction(async (sp) => {
      await sp.insert(andonStateHistory).values({ engaged, changed_by: by });
    });
  } catch (e) {
    console.error('[andon] failed to record history flip:', e);
  }
}

/**
 * GET /api/andon — header polling endpoint. Any authenticated user can
 * read; visibility is the point of an andon (line-of-sight) — but only
 * super-admins and platform active tenants see the REAL cord. A customer
 * tenant gets a neutral released cord in the same shape (owner rule
 * 2026-09-30: system data never visible to a customer tenant).
 *
 * `?live=1` additionally runs the bounded n8n probe, and is gated to
 * SUPER-ADMIN. Two separate reasons, both load-bearing:
 *   * FAN-OUT — this endpoint is polled every 30 s by every authenticated user
 *     (`AndonCord.svelte`), so an ungated probe multiplies fr's n8n traffic by
 *     the headcount of everyone with a browser tab open.
 *   * RECURSION — the same reader backs `GET /api/internal/andon`, which n8n
 *     workflows call to decide whether to halt. fr calling n8n to answer a
 *     question n8n asked fr is a loop waiting for a trigger.
 * A non-super-admin asking for `live=1` is NOT refused — they simply get
 * `n8n_live: null`, which already means "not probed" and is therefore not a
 * lie. Refusing would break the shared poll for ordinary users.
 */
export async function handleGetAndon(req: Request): Promise<Response> {
  let user: Awaited<ReturnType<typeof validateAuth>>;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  // ⚠️ The response-envelope ratchet (since removed) pinned this route by the RAW
  // SOURCE TEXT of the response-helper argument (GRANDFATHERED "GET /api/andon",
  // pinned `expr:view` since the read was lifted into the local below so the
  // metrics publisher could see it — the pin was `expr:readAndon({ live })`
  // before that). Renaming that local, or inlining the read back into the
  // response call, moves the pin again and the guard goes red until it is
  // re-pinned; adding FIELDS to readAndon's return type does not move it, and a
  // second success-status response call in this handler would turn the pin into
  // a `multi:` entry.
  //
  // ⛔ DO NOT write that helper's name followed by `(` anywhere in this comment.
  // The guard scans for that token as SOURCE, not as prose, so a comment
  // mentioning it is counted as an extra response path with an empty argument —
  // measured 2026-09-23: this very comment made the shape read
  // `multi:expr:|expr:readAndon({ live })` and the pin could not be satisfied.
  // A comment must never impersonate the thing it describes.
  const live =
    new URL(req.url).searchParams.get('live') === '1' && isSuperAdmin(user);
  const cord = await readAndon({ live });
  // ⛔ Owner rule (2026-09-30): system data is NEVER visible to a customer
  // tenant. The global cord is the PLATFORM conveyor's stop switch — its
  // `engaged_by`, held-workflow counts and n8n pause errors are platform
  // internals. A customer (neither super-admin nor a platform active tenant)
  // gets the SAME shape with every conveyor field neutralised, i.e. an ordinary
  // released cord — never a 403, which would confirm the data exists and would
  // break the shared 30 s poll. The metrics below still publish the REAL cord.
  const view = canReadProductionWorkflows(user) ? cord : customerAndonView();

  // Warm the STATE gauges (lib/andon-halt-metrics.ts) from the reader that is
  // ACTUALLY POLLED. `AndonCord.svelte` hits THIS route every 30 s for every open
  // operator tab; it never calls `/api/internal/andon`. Without this publisher
  // the only one in production is the router-dedupe brake, i.e. ONE observation
  // per Planka card move — so a quiet board or a freshly restarted pod would sit
  // at "never observed" for hours with nothing able to warm it.
  //
  // ⚠️ Both axes come from the SAME view this handler is about to return. Nothing
  // is re-read, and there is no second interpretation of the cord here: `intent`
  // IS the reason axis, and the known/unknown rule stays that module's single
  // rule. An absent singleton arrives as `unreadable` and is therefore published
  // as UNKNOWN — the same verdict the interlock reaches under the name
  // `uninitialised`.
  //
  // ⛔ Unlike the interlock this handler does NOT consult `isGlobalAndonEngaged`,
  // so it can never publish that gate's fail-closed `true`. A read that throws
  // propagates out of this handler and publishes NOTHING, which is correct: a
  // failed read is not an observation. Changes no answer and cannot throw.
  publishAndonStateForMetrics({ engaged: cord.engaged, reason: cord.intent, kataHolders: cord.kata_holders.length });

  // ⛔ NO ESTATE GAUGE FROM HERE (2026-11-02). `fr_andon_worker_replicas` was
  // DELETED: it was rendered from a module cache fed only by request-driven
  // publishers — this route (a live probe, i.e. only while an operator tab is open)
  // and the card-move interlock (the stored row value). Measured AFTER a DB restore:
  // the row's `worker_replicas` was NULL, so the card-move publisher emitted no
  // sample and the two alerts that read the series could not fire unattended. The
  // actuator signal is now `kube_deployment_spec_replicas` from kube-state-metrics,
  // which needs nothing from this process and is present with fr down.

  return jsonResponse(view);
}

/**
 * POST /api/andon/engage — super-admin pull. No body.
 *
 * Steps, in order (the body is {@link engageGlobalCord}):
 *   0. READ the row and PROBE the worker. A definite engaged cord whose worker is
 *      already measured at 0 is the only state that short-circuits.
 *   1. Flip the global flag — every fr work-initiation chokepoint
 *      (n8n dispatch, phase advance, project intake, scheduled tick) reads it
 *      and freezes immediately, so no tenant-admin action can start new work.
 *   2. Hard-stop n8n's OWN autonomous loops by scaling `n8n/n8n-worker` to 0
 *      (lib/k8s-scale.ts). In queue mode the worker is the only executor of
 *      automatic work, so 0 stops every workflow while the editor, REST API and
 *      n8n-mcp stay up. An in-flight run is left to drain — this cord
 *      deliberately does NOT kill running executions (SIGTERM stops new job
 *      pickup; the worker's `N8N_GRACEFUL_SHUTDOWN_TIMEOUT` finishes the rest).
 *   3. Record what the API server answered, as a MEASUREMENT.
 * A failure to reach the API server still leaves the fr-side freeze in place and
 * surfaces `worker_scale_error` so the operator knows the n8n half did not land.
 */
export async function handleEngageAndon(req: Request): Promise<Response> {
  let admin: AdminIdentity;
  try {
    admin = await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  try {
    return jsonResponse(await engageGlobalCord(admin.email));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Pull the global cord — the whole body of {@link handleEngageAndon} after auth.
 *
 * Exported so the integration suite can drive it against a real Postgres; the HTTP
 * wrapper above contributes nothing but `requireSuperAdmin`.
 *
 * ⭐ THE DECISION IS TAKEN ON THE ROW, NOT ON THE GATE. `isGlobalAndonEngaged()`
 * fails CLOSED: a missing singleton and a read that throws both answer `true`. That
 * is right for a gate that decides whether work may start, and wrong here — it made
 * a cord that could not be read report `already_engaged` and refuse to pull, at the
 * one moment this brake exists for. `readAndon` is the display surface: it reads the
 * same row and says WHICH state it read (`intent`), so it can tell "engaged" apart
 * from "unknown". Only a DEFINITE engaged may short-circuit; everything else pulls.
 */
export async function engageGlobalCord(
  by: string,
): Promise<AndonView & { worker_scale_error: string | null; already_engaged?: boolean }> {
  return withInstanceCordLock((tx) => pullGlobalCord(by, tx));
}

async function pullGlobalCord(
  by: string,
  tx: AndonDb,
): Promise<AndonView & { worker_scale_error: string | null; already_engaged?: boolean }> {
  const before = await readAndon({ live: true }, tx);
  // `null` = NOT MEASURED, which is never 0: an unmeasured worker is a reason to
  // re-issue the scale, never a reason to claim the stop landed.
  const measured = before.n8n_live?.worker_replicas ?? null;
  const definitelyEngaged = before.engaged === true && before.intent === 'engaged';

  if (definitelyEngaged && measured === 0) {
    // Already stopped, and PROVEN stopped. No write: a second PATCH would overwrite
    // the evidence of the attempt that actually pulled the cord with a fresh — and
    // possibly failed — measurement.
    //
    // fr#1206 — THE IDEMPOTENT RE-PULL PUBLISHES TOO. This path performs no write,
    // so it looks like the one that need not publish; that is exactly backwards. A
    // super-admin re-pulling an already-engaged cord does not believe it landed, and
    // a pod restarted after the engage has never observed the cord at all — so this
    // is the only path that can CORRECT a gauge that is already wrong.
    //
    // ⚠️ Published from the ROW's view, NOT from the gate: the gate fail-closes a
    // read ERROR to `true`, which is a safety default and not an observation.
    publishAndonStateForMetrics({ engaged: before.engaged, reason: before.intent, kataHolders: before.kata_holders.length });
    return {
      ...before,
      // Report the MEASUREMENT, not the row's absence: a restored DB has no stored
      // count, and "NOT MEASURED" beside a probe that just read 0 is a lie.
      worker_replicas: measured,
      worker_scale_error: null,
      already_engaged: true,
    };
  }

  // ⭐ A RE-PULL RE-ISSUES THE SCALE. Until this existed, pulling an already-engaged
  // cord whose worker never stopped answered `already_engaged` and did NOTHING —
  // while the admin page told the operator to "pull again to retry the scale". The
  // only working path was release-then-pull, which opens every gate in between: the
  // wrong remedy for a line that is supposed to be stopped.
  //
  // ⛔ It does NOT rewrite `engaged_at`/`engaged_by`. "When did this stop start" is
  // the audit trail and must not move because an operator clicked again; the
  // re-attempt's own evidence goes in the three `worker_*` columns.
  if (!definitelyEngaged) {
    await setEngagedFlag(true, by, tx);
    await recordAndonFlip(true, by, tx);
  }

  // ⭐ ONE PATCH. No enumeration, no per-workflow calls, nothing that needs a
  // healthy n8n — which is the whole reason the actuator moved.
  const scale = await scaleN8nWorker(0);
  if (scale.error) {
    console.error('[andon] scaling n8n-worker to 0 failed:', scale.error);
  }
  await recordWorkerScale(scale, tx);

  // `live: true` — the engage response is the operator's ONLY immediate evidence
  // that the halt landed. `worker_replicas` records what the PATCH answered; the
  // live probe independently re-reads the Deployment, so a PATCH that was accepted
  // while the worker kept running shows up as a contradiction.
  const view = await readAndon({ live: true }, tx);

  // fr#1206 — PUBLISH THE CORD STATE FROM THE TRANSITION ITSELF. Every other
  // publisher of `fr_andon_engaged` is a READ, so without this the gauge reports
  // the last time somebody LOOKED at the cord and never the moment it MOVED.
  // Cannot throw; changes no answer.
  publishAndonStateForMetrics({ engaged: view.engaged, reason: view.intent, kataHolders: view.kata_holders.length });

  return { ...view, worker_scale_error: scale.error };
}
/**
 * The pause facts as they stood BEFORE a release overwrote them.
 *
 * ⭐ The release is the last moment this evidence exists: the UPDATE inside
 * {@link handleDisengageAndon} rewrites `worker_scale_error` with the SCALE-UP
 * outcome (and `worker_scaled_at` with the scale-up time), so reading the row
 * afterwards returns the wrong cycle's facts — or nothing at all on a clean
 * release. Whether the pull being released had ever actually landed is exactly
 * the question an operator asks afterwards.
 *
 * ⭐ READER (named, because a field with none is the defect this lane exists to
 * remove): frontend `clearedPauseNote` in lib/components/andon-cord-helpers.ts,
 * appended by `pullFeedback('disengage', …)` to the post-release line rendered
 * at `data-testid="andon-global-feedback"` on /admin/andon and
 * `data-testid="andon-cord-feedback"` in the header cord. It reports only the
 * facts that CONTRADICT the freeze the operator believed in (`error` set, or no
 * attempt recorded at all) and stays silent on a clean pause.
 *
 * ⛔ `null` UNLESS the cord was actually engaged, and this gate is load-bearing
 * rather than defensive. On a REDUNDANT disengage (the cord is already released)
 * these three columns describe the PREVIOUS RELEASE, not a pull: `worker_scaled_at`
 * holds the scale-up time and `worker_scale_error` holds the scale-up's failure.
 * Returning them unguarded hands a reader a release failure labelled as a pull
 * failure — the same overload {@link AndonPauseEvidence} warns about, one layer
 * out — and on a clean previous release it yields `{null, null, null}`, which a
 * reader must report as "no attempt was ever recorded" for a halt that never
 * existed. Neither is a fact.
 * `null` means "this release describes no pause"; the frontend renders nothing.
 */
export function clearedPauseEvidenceForRelease(
  row:
    | {
        worker_replicas?: number | null;
        worker_scaled_at?: Date | null;
        worker_scale_error?: string | null;
      }
    | undefined,
  wasEngaged: boolean,
): AndonPauseEvidence | null {
  if (!row || !wasEngaged) return null;
  return {
    attempted_at: row.worker_scaled_at ?? null,
    error: row.worker_scale_error ?? null,
    // ⭐ NOT a defaulted 0. `worker_replicas` NULL means "fr could not measure"
    // (no attempt recorded, or the API-server call failed), and laundering that
    // into 0 would read as "an attempt ran and stopped the worker". Those are the
    // two facts this struct exists to keep apart.
    worker_replicas: row.worker_replicas ?? null,
  };
}

/**
 * How the RELEASE went — the third value fr#1202 asks for.
 *
 * ⛔ A SEPARATE union, and NOT a widened {@link AndonIntent} or
 * {@link AndonInterlockReason}. Adding a value to either of those was the obvious
 * move and it is the wrong one, in two ways that both fail silently:
 *
 *   1. `publishAndonStateForMetrics` treats any pair outside
 *      `(false,'released')` / `(true,'engaged')` as UNKNOWN and therefore OMITS
 *      the `fr_andon_engaged` sample. A new `intent` value would make a
 *      released-but-incomplete cord render NO `fr_andon_engaged` at all — which
 *      silently changes the meaning of a series two live rules depend on (one
 *      keyed on `== 1`, one SUPPRESSED while `== 1`).
 *   2. `handleGetAndonInternal` maps every unrecognised `intent` to
 *      `reason: 'unreadable'`, and `andon_unreadable` is a HALT outcome at the
 *      router-dedupe brake. So a RESTORATION failure would brake every card move
 *      in the estate — converting an 11-workflow gap into a full outage, which is
 *      strictly worse than the defect.
 *
 * ⇒ The third value lives on the RELEASE, which is a thing that happened, not on
 * the CORD, which is a state. `engaged` stays `false` and `fr_andon_engaged`
 * stays `0`, because the cord genuinely is released.
 *
 * It is carried on the `POST /api/andon/disengage` response only, at TOP LEVEL
 * deliberately: the fr#1202 window did report the failure, in a nested
 * `n8n_error` string, while every field a human or a rule reads first said
 * `released`. A discriminator nobody reads is the defect, not the fix.
 */
export type AndonReleaseStatus = 'released' | 'released_incomplete' | 'released_kata_holds';

/**
 * POST /api/andon/disengage — super-admin release. No body.
 *
 * Scale `n8n/n8n-worker` back to 1 BEFORE clearing the flag, so the fr-side freeze
 * stays up until n8n has been told to come back. The response carries
 * `release_status` so an unlanded release cannot be read as a plain `released`.
 *
 * ⭐ KATAS HOLD THE SAME INSTANCE (George 2026-11-03). While `andon_state.kata_holders` is
 * non-empty the operator's flag is cleared but the worker is NOT scaled up: the answer is
 * `released_kata_holds` with the holders, and the last kata's release brings the worker back
 * (services/katas/core.ts, through {@link leaveKataCordWith}). The operator's release never
 * removes a LIVE kata's hold.
 *
 * ⭐ ORPHAN HOLDERS ARE PRUNED HERE. A holder id with no `katas` row that holds (running|qa, or failed and unreleased) holds the whole
 * conveyor with nothing that will ever release it (a kata row deleted, a pre-katas holder). The
 * release removes every such id first ({@link pruneOrphanKataHolders}, each logged) and then
 * scales up only if nobody — no live kata — still holds. This is the operator's remedy; there is
 * no separate route.
 *
 * ⚠️ `released` means "the API server accepted the scale-up", NOT "the worker is
 * serving again". The replacement pod still has to start, and the Deployment is
 * `strategy: Recreate` on a ReadWriteOnce volume, so it cannot start until a
 * draining pod is gone — up to ~27 minutes past a pull that caught an execution
 * in flight. `n8n_live.available_replicas` in this same response is the honest
 * measure of whether it is back yet; read that, not the status word.
 */
export async function handleDisengageAndon(req: Request): Promise<Response> {
  let admin: AdminIdentity;
  try {
    admin = await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  try {
    return jsonResponse(await releaseGlobalCord(admin.email));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Release the operator's cord — the whole body of {@link handleDisengageAndon} after auth,
 * exported so the integration suite drives it against a real Postgres. Serialised with every
 * other instance-cord decision ({@link withInstanceCordLock}).
 */
export async function releaseGlobalCord(by: string) {
  return withInstanceCordLock((tx) => releaseGlobalCordLocked(by, tx));
}

async function releaseGlobalCordLocked(by: string, tx: AndonDb) {
  const [row] = await tx
    .select({
      worker_replicas: andonState.worker_replicas,
      engaged: andonState.engaged,
      worker_scaled_at: andonState.worker_scaled_at,
      worker_scale_error: andonState.worker_scale_error,
      kata_holders: andonState.kata_holders,
    })
    .from(andonState)
    .where(eq(andonState.id, 1))
    .limit(1);
  const wasEngaged = row?.engaged ?? false;
  const orphans = await pruneOrphanKataHolders(tx);
  for (const id of orphans) console.warn(`[andon] operator release by ${by}: removed orphan kata holder ${id} (no holding kata; a failed kata is never pruned)`);
  const kataHolders = (row?.kata_holders ?? []).map(String).filter((h) => !orphans.includes(h.toLowerCase()));
  // Captured BEFORE the UPDATE below overwrites it. See
  // {@link clearedPauseEvidenceForRelease}.
  const clearedPauseEvidence = clearedPauseEvidenceForRelease(row, wasEngaged);

  // A kata still holds the instance: clear the operator's flag, leave the worker at 0.
  const scale = kataHolders.length > 0 ? null : await scaleN8nWorker(1);
  if (scale?.error) {
    console.error('[andon] scaling n8n-worker back to 1 failed:', scale.error);
  }

  await setEngagedFlag(false, by, tx);
  // Record the release only on an actual engaged→released transition, so a
  // redundant disengage does not append a spurious row (mirrors the trigger's
  // old "engaged IS DISTINCT FROM" guard).
  if (wasEngaged) await recordAndonFlip(false, by, tx);
  // Keep the failure recorded — clearing it on a FAILED release would erase the only record
  // that the release did not land. On a clean release it is `null`: nothing failed.
  if (scale) await recordWorkerScale(scale, tx);

  // `live: true` — after a release, `worker_replicas === 1` is POSITIVE proof that
  // the scale-up reached n8n, and once the pod is serving,
  // `available_replicas === 1` proves it came back. `worker_scale_error === null`
  // alone only says fr believes the PATCH landed; a worker that never returns
  // after a release is a silent failure, and this is what sees it.
  const view = await readAndon({ live: true }, tx);

  // ⛔ ONE EXPRESSION, ONE SOURCE. `release_status` is derived from the same
  // reading the body reports (`scale`), so the two cannot disagree — a status
  // computed from one field while the evidence comes from another is the
  // composite-from-two-fields defect this file already warns about twice.
  const releaseStatus: AndonReleaseStatus =
    scale === null ? 'released_kata_holds' : scale.error === null ? 'released' : 'released_incomplete';

  // fr#1206 — THE RELEASE PUBLISHES THE CORD, and this is the dangerous
  // direction of the same omission. With no publisher here the gauge stayed at
  // `1` after a release until something happened to READ the cord, so
  // `FrAndonCordStuckEngaged` (gitops #4137) could PAGE FOR A CORD THAT IS
  // RELEASED, and the second alert gated on `== 1` stayed SUPPRESSED for as long
  // as the stale `1` persisted. Both consequences come from the same stale read.
  //
  // Both axes come from the same post-UPDATE view, exactly as the read publishers
  // take them. Cannot throw and changes no answer.
  //
  // ⛔ THE ESTATE GAUGE IS GONE (2026-11-02). `fr_andon_worker_replicas` used to be
  // armed here from the operator's own action; the series was deleted because a
  // module-cached gauge published only by request-driven paths goes dark exactly
  // when nobody is watching. `FrAndonReleasedWorkerStillStopped` reads
  // kube-state-metrics instead, so the release lands in the alert without this
  // process having to publish anything.
  publishAndonStateForMetrics({ engaged: view.engaged, reason: view.intent, kataHolders: view.kata_holders.length });

  return {
    ...view,
    release_status: releaseStatus,
    worker_scale_error: scale?.error ?? null,
    cleared_pause_evidence: clearedPauseEvidence,
  };
}

/**
 * GET /api/andon/inflight — super-admin. After an engage, scaling the worker to 0
 * stops NEW executions but an in-flight one is left to drain: this cord does
 * not call n8n's stop-execution endpoint (2.46.1 HAS one —
 * `POST /executions/{id}/stop`; keeping this cord's drain is deliberate). This reports how many executions are still in the `running`
 * state so the operator can watch the drain finish. Fails OPEN (running_count:null + n8n_error) —
 * a visibility read must never throw.
 */
export async function handleGetAndonInflight(req: Request): Promise<Response> {
  try {
    await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  try {
    const { count, capped } = await n8nCountRunningExecutions();
    return jsonResponse({ running_count: count, capped, n8n_error: null });
  } catch (e) {
    return jsonResponse({
      running_count: null,
      capped: false,
      n8n_error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Why the work-initiation interlock answered as it did.
 *
 * ⛔ A SEPARATE union, not a widened {@link AndonIntent}. `AndonIntent` is the
 * operator-UI vocabulary and three consumers of `GET /api/andon` render it;
 * `uninitialised` is a distinction only an interlock needs, and pushing it into
 * that type would reach into the UI path to serve this one endpoint.
 *
 * `uninitialised` — a DEFINITE read of an absent `andon_state` singleton
 * (migration 065 inserts it, so this is a broken install, not a pulled cord).
 * It answers `engaged:false` on the DISPLAY axis, and every GATE that reads this
 * endpoint HALTS on it (`andonVerdictFromInterlockAnswer` → `missing` →
 * `andonPermitsWork` false). Absence is NAMED, never laundered into `released`
 * and never collapsed into `unreadable`.
 *
 * ⚠️ CORRECTED for fr#1208 — this said `engaged:false` was "exactly as
 * {@link isGlobalAndonEngaged} does". That is NO LONGER TRUE and the direction
 * matters: the shared gate now returns `true` for this state (fail-closed), while
 * this endpoint keeps `false`. The two do not disagree about whether work may
 * start — they disagree about which AXIS carries that, and only because this one
 * surface is read by humans as well as gates. See the body.
 */
export type AndonInterlockReason = AndonIntent | 'uninitialised';

/**
 * GET /api/internal/andon — license-authz-exempt consult endpoint for
 * n8n. NetworkPolicy on the fr namespace + /api/internal/ path prefix
 * gate external traffic; no Bearer here.
 *
 * ⛔ `live: false`, explicitly and permanently. n8n workflows call THIS to ask
 * whether they may run; probing n8n to answer it would make fr's reply depend
 * on the very system that is asking, and an n8n outage would then slow or fail
 * the consult that is supposed to halt it.
 *
 * ⚠️ That rationale is about NOT PROBING n8n. It used to end "the shape stays
 * the bare boolean", which forbade a field it was never about — and the bare
 * boolean was the defect: this is an INTERLOCK, and it was the one
 * work-initiation surface in fr that did not read
 * {@link isGlobalAndonEngaged}. A read that THREW escaped as a 500 instead of
 * failing closed — and the n8n modules retry on `status >= 500`, so a broken
 * cord became an infinite retry rather than a halt — while an absent singleton
 * was rendered as an ordinary `released` with nothing to tell the two apart.
 *
 * ⭐ TWO READS, TWO DIFFERENT JOBS:
 *   * {@link readAndonVerdict} — the SAME read every other chokepoint uses (n8n
 *     dispatch, phase advance, project intake, the scheduled tick), one step
 *     before the policy collapses it to a boolean. A read error is `unreadable`
 *     and answers `engaged:true`, never an open gate and never a 500.
 *   * `readAndon` supplies the `reason` axis, because the verdict alone cannot
 *     say what the row looked like.
 *
 * ⛔ NO `||`. An earlier draft computed `gate || intent !== 'released'`, mixing
 * the two reads into one boolean. Keep them separate: the verdict decides, the
 * intent names.
 *
 * ⚠️ SUPERSEDED BY fr#1208 — the paragraph that stood here argued that an absent
 * singleton must NOT halt, because promoting it would make this interlock
 * "STRICTER than every fr chokepoint — a state its own `assertGlobalAndonReleased`
 * lets straight through". Keep the reasoning, because the shape of the argument is
 * still right; its PREMISE is gone. `assertGlobalAndonReleased` no longer lets an
 * absent singleton through — the operator ruled the cord is an emergency brake
 * that must always work, so every gate fail-closes on absence. Five consumers had
 * five answers; there is now one, in `ANDON_GATE_POLICY`.
 *
 * ⇒ What survives of that argument is the DISPLAY carve-out, and only it: this
 * endpoint keeps `engaged:false` for an absent row so it cannot diverge from
 * `GET /api/andon` on the same row, while `reason:'uninitialised'` is what gates
 * act on — and they refuse. The invariant a test must pin is therefore no longer
 * "`engaged` equals the gate's boolean" (it deliberately does not, in exactly one
 * state) but "a GATE reading BOTH axes of this answer reaches the same verdict as
 * the shared gate, in every state". That is strictly stronger, and it is what
 * `andonVerdictFromInterlockAnswer` exists to make checkable.
 *
 * ⚠️ Absence must be NAMED, not promoted and not laundered. `uninitialised`
 * exists so an absent singleton stops rendering as a plain `released` — the
 * caller may proceed (that IS the gate's answer) while an operator can still
 * see that the switch was never set up.
 *
 * ⚠️ Vocabulary: {@link AndonInterlockReason} extends {@link AndonIntent} with
 * that one value rather than widening it. `AndonIntent` belongs to the operator
 * UI path (`GET /api/andon`), and `uninitialised` is a distinction only an
 * interlock needs.
 *
 * ⚠️ Stated rather than hidden: when the two reads DISAGREE — a cord flipped
 * between them, or a gate read that failed while the singleton read fine — the
 * reason is `unreadable`. `engaged` is still whatever the gate said; only the
 * name for it is withheld.
 */
export async function handleGetAndonInternal(
  _req: Request,
): Promise<Response> {
  // ⛔ THE ONLY INPUT TO THE HALT DECISION. Nothing below may widen or narrow it.
  //
  // ⚠️ REWRITTEN FOR fr#1208, AND READ WHY BEFORE SIMPLIFYING IT BACK. This was
  // `const engaged = await isGlobalAndonEngaged(andonGateDb)`, and the doc-comment
  // above justified it with "a DEFINITE read of an absent row is NOT engaged…
  // `assertGlobalAndonReleased` lets this state straight through". THAT PREMISE IS
  // NOW FALSE: the shared gate fail-closes on an absent singleton, because a
  // broken emergency stop is an engaged one (ANDON_GATE_POLICY).
  //
  // ⭐ So the two axes now divide the work explicitly, which is the display-vs-gate
  // policy applied to the one surface that is BOTH:
  //   * `engaged` is the DISPLAY axis. For a DEFINITE read of an absent row it
  //     stays `false` — literally true (nobody pulled the cord) and the thing a
  //     human needs to see, and it keeps `GET /api/andon` and this endpoint
  //     agreeing on the same row instead of blacking out the page used to fix it.
  //   * `reason` is the axis a GATE acts on, and it says `uninitialised`.
  //     `andonVerdictFromInterlockAnswer` maps that to `missing` and
  //     `andonPermitsWork` HALTS on it — so every consumer of this endpoint
  //     (the router-dedupe brake, coding-github) refuses, exactly as the shared
  //     gate does. The estate is fail-closed on BOTH paths; only the NAME differs.
  //
  // ⛔ Do NOT collapse this to `!andonPermitsWork(verdict)`. That reports
  // `engaged:true, reason:'unreadable'` for an absent row, which halts identically
  // but DESTROYS the diagnosis: `fr_andon_gate_total{reason="uninitialised"}` and
  // `fr_andon_brake_total{outcome="andon_uninitialised"}` go permanently dead, and
  // a broken install becomes indistinguishable from a DB blip.
  const verdict = await readAndonVerdict(db);
  const engaged = verdict === 'missing' ? false : !andonPermitsWork(verdict);

  // `null` = the reason read itself failed. A fact about the switch, not about
  // the cord — hence `unreadable` below, never a 500. `intent === 'unreadable'`
  // means something different and narrower here: `readAndon` reports that for
  // its `!row` branch, i.e. a DEFINITE read of an absent singleton.
  let intent: AndonIntent | null = null;
  let kataHolders: number | undefined;
  let readError: string | null = null;
  try {
    const view = await readAndon({ live: false });
    intent = view.intent;
    kataHolders = view.kata_holders.length;
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
  }

  let reason: AndonInterlockReason;
  if (intent === null) {
    reason = 'unreadable';
  } else if (engaged) {
    reason = intent === 'engaged' ? 'engaged' : 'unreadable';
  } else if (intent === 'released') {
    reason = 'released';
  } else if (intent === 'unreadable') {
    reason = 'uninitialised';
  } else {
    reason = 'unreadable';
  }

  reportAndonGateAnswer({
    answer: engaged ? 'engaged' : 'released',
    reason,
    error: readError,
  });

  // Warm the STATE gauges (lib/andon-halt-metrics.ts).
  //
  // ⛔ THIS IS NOT THE HEADER'S ROUTE, AND IT IS NOT fr's HIGHEST-FREQUENCY READER.
  // An earlier version of this comment claimed both; both were measured false.
  // `AndonCord.svelte` polls `GET /api/andon` (`handleGetAndon`), never
  // `/api/internal/andon`. This endpoint is registered for n8n's interlock and
  // has exactly ONE in-process caller: the router-dedupe brake
  // (`consultAndonForRouterDedupe`, routes/webhooks.ts). So this publisher fires
  // ONCE PER PLANKA CARD MOVE and on no other schedule.
  //
  // ⇒ THE CONSEQUENCE A CONSUMER MUST ACT ON: the cache's freshness is bounded by
  // card-move traffic plus operator UI polling, and by nothing else — there is no
  // background timer, so a quiet board with no browser open, or a pod that just
  // restarted, leaves the series at "never observed". `fr_andon_state_age_seconds`
  // is therefore the field an alert has to bound BEFORE it may believe
  // `fr_andon_engaged`; a rule that reads the state without bounding the age is
  // reading whatever the last card move happened to see, however long ago.
  //
  // (These gauges are a cache at all because `renderPromExporter` is synchronous
  // and cannot `SELECT` — see the module header for that trade.)
  //
  // ⚠️ It is handed BOTH axes and does not pre-judge them. `engaged` here is
  // whatever `isGlobalAndonEngaged` said, which is `true` on a read ERROR by
  // design — so the boolean alone cannot be published as a state, and deciding
  // which reasons are definite is that module's single rule, not a second copy
  // here. Changes no answer and cannot throw.
  publishAndonStateForMetrics({ engaged, reason, kataHolders });

  // ⛔ THE ESTATE GAUGE IS GONE (2026-11-02). This used to be its "card-move
  // publisher" — the one path that could warm it with no browser open — but it
  // published the STORED row value, so a row with no measurement published nothing.
  // The actuator signal is now kube-state-metrics (see rules-d.yaml, ARM 6).

  // ─── fr#1195: the chokepoint brake's two hooks on this one answer ───────────
  //
  // ⭐ WHY HERE AND NOT IN THE BRAKE. The brake is an n8n subworkflow; the only
  // thing it can tell fr about is a read that FAILED (POST .../read-failure).
  // A read that SUCCEEDED is observable only here, which makes this handler the
  // single place that can (a) clear the shared unreadable streak and (b) attribute
  // a `cause="pulled"` halt to the caller that asked. Putting either in the brake
  // would need a second round-trip on the happy path of every card move.
  //
  // ⛔ NEITHER CAN CHANGE THE ANSWER. Both are counters/gauges, both are declared
  // never-throw, and both run AFTER `engaged`/`reason` are decided. The interlock's
  // body is byte-identical with or without them.
  const caller = andonCallerFromRequest(_req);
  if (reason === 'engaged') {
    // A read that said ENGAGED is a halt the caller is about to perform, and the
    // one halt cause an operator chose. `fr_andon_brake_total` cannot carry it:
    // that counter's axis is fr's OWN chokepoints and it has no caller label.
    recordAndonHalt('pulled', caller);
  }
  if (reason === 'engaged' || reason === 'released') {
    // ⭐ ONLY THE TWO DEFINITE ANSWERS CLEAR THE STREAK — the same conjunction
    // `publishAndonStateForMetrics` calls "known", reused rather than restated.
    // `uninitialised` and `unreadable` deliberately do NOT clear it: fr answering
    // "I cannot name my own cord state" does not refute "callers cannot read the
    // cord", and clearing on it would make the gauge go quiet in exactly the
    // regime it exists to report.
    resetAndonProbeStreak();
  }

  return jsonResponse({ engaged, reason });
}

/**
 * Who is asking, for the `caller` label only.
 *
 * ⛔ NOT AUTHENTICATION AND NOT AN IDENTITY. It is a self-asserted label value on
 * an unauthenticated internal endpoint, so it is bounded by
 * {@link normaliseAndonCaller} (charset, length, distinct-value cap) and used for
 * nothing but a metric axis. A header is preferred over a query string so the
 * interlock's URL stays cacheable and its access logs stay identical.
 */
function andonCallerFromRequest(req: Request): string {
  try {
    const raw =
      req.headers.get('x-andon-caller') ??
      new URL(req.url).searchParams.get('caller');
    return normaliseAndonCaller(raw);
  } catch (err) {
    // A malformed URL must not be able to break the interlock. LOGGED rather than
    // swallowed: `unknown` here is a real degrade of the caller axis, and a
    // degrade nobody can see afterwards is a silent swallow.
    console.error(
      '[andon] could not derive the probe caller label; attributing to `unknown`:',
      err instanceof Error ? err.message : err,
    );
    return normaliseAndonCaller(null);
  }
}

// ─────────── POST /api/internal/andon/read-failure (fr#1195) ─────────────────

/** The validated wire body, after clamping. */
interface AndonReadFailureReport {
  caller: string;
  consecutive: number;
  halted: boolean;
}

/**
 * Upper bound on `consecutive`.
 *
 * ⛔ A CLAMP, NOT A REJECTION, AND THE DIRECTION IS DELIBERATE. `consecutive` is
 * a self-asserted integer from an unauthenticated caller and it lands in a GAUGE,
 * so an absurd value would pin `fr_andon_probe_unreadable_streak` at that number
 * until the next definite interlock answer. Clamping keeps the alert usable
 * (anything at or above this ceiling is already far past any sane threshold) while
 * a REJECT would throw away a report that also carries `halted` — and a report fr
 * refuses is a halt fr cannot see.
 */
const ANDON_READ_FAILURE_MAX_CONSECUTIVE = 100_000;

/**
 * Hard ceiling on the RAW `caller` string, before normalisation.
 *
 * Deliberately larger than {@link ANDON_CALLER_MAX_LENGTH}: a name a little over
 * the label budget is a real workflow whose label is truncated, while a value four
 * times over is a malfunctioning or hostile client and is refused outright rather
 * than silently clamped.
 */
const ANDON_READ_FAILURE_MAX_CALLER_LENGTH = 4 * ANDON_CALLER_MAX_LENGTH;

/**
 * POST /api/internal/andon/read-failure — the n8n chokepoint brake reports that
 * it could NOT read the cord.
 *
 * ⭐ WHY fr NEEDS TO BE TOLD. Every other andon series is published by a reader
 * that reached fr; a consult that never arrived (fr rolling, DNS, mesh deny) is
 * invisible to all of them, and the brake fails CLOSED after a grace window, so
 * that invisible regime is the one in which the estate halts with nobody having
 * chosen it. The caller is the only party that can count it, which is why
 * `consecutive` is reported rather than derived.
 *
 * ⛔ AND WHY THIS ENDPOINT MUST EXIST BEFORE THE BRAKE SHIPS. If the brake lands
 * first it POSTs to a 404; a brake that read a failed REPORT as a failed READ
 * would then halt the entire fleet on its own telemetry. Hence also the posture
 * below: this endpoint NEVER refuses for a reason the brake could confuse with an
 * unreadable cord.
 *
 *   * No auth — same gate as `GET /api/internal/andon` it accompanies
 *     (NetworkPolicy on the fr namespace + the `/api/internal/` path prefix). A
 *     Bearer here would make the report fail exactly when Keycloak is the thing
 *     that is down, i.e. in the outage class this series exists to describe.
 *   * UNKNOWN KEYS ARE IGNORED, not rejected. The n8n half ships from another repo
 *     on another schedule; a field added there must not start 400-ing every
 *     report. The three fields it promises today are validated strictly.
 *   * A 400 names ITSELF (`code: 'invalid_read_failure_report'`) so the n8n side
 *     can tell "fr rejected my report" from "fr cannot answer about the cord" —
 *     two facts that must never collapse into one retry loop.
 *
 * ⛔ IT PUBLISHES ONLY NEW SERIES. `fr_andon_engaged` is not reachable from this
 * handler: it keeps meaning exactly "is the cord pulled", 0 or 1, because two live
 * Prometheus rules consume it and one GATES a second alert on `== 1`. See the
 * fr#1195 section header in lib/andon-halt-metrics.ts.
 */
export async function handlePostAndonReadFailure(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return andonReadFailureRejection('body_not_json', {
      parse_error: err instanceof Error ? err.message : String(err),
    });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return andonReadFailureRejection('body_not_an_object', {
      received: Array.isArray(body) ? 'array' : typeof body,
    });
  }
  const raw = body as Record<string, unknown>;

  // `caller` — REQUIRED and must be a string. It is normalised for the label, but
  // a missing or non-string one is rejected rather than silently attributed to
  // `unknown`: an unattributable report cannot answer "which workflow is halting",
  // which is the whole reason the axis exists, and accepting it would make a
  // broken brake look like a working one.
  if (typeof raw.caller !== 'string' || raw.caller.trim().length === 0) {
    return andonReadFailureRejection('caller_missing_or_not_a_string', {
      received: typeof raw.caller,
    });
  }
  if (raw.caller.length > ANDON_READ_FAILURE_MAX_CALLER_LENGTH) {
    return andonReadFailureRejection('caller_too_long', { length: raw.caller.length });
  }

  if (typeof raw.consecutive !== 'number' || !Number.isFinite(raw.consecutive)) {
    return andonReadFailureRejection('consecutive_not_a_finite_number', {
      received: typeof raw.consecutive,
    });
  }
  if (raw.consecutive < 1) {
    // `0` would say "no failed reads in a row", which contradicts the existence of
    // the report. Refusing it keeps the gauge's meaning intact.
    return andonReadFailureRejection('consecutive_below_one', { received: raw.consecutive });
  }

  if (typeof raw.halted !== 'boolean') {
    // ⛔ NO DEFAULT, IN EITHER DIRECTION. Defaulting to `false` would under-report
    // real halts; defaulting to `true` would invent halts that never happened and
    // fire the alert this series exists to make trustworthy. A brake that cannot
    // say whether it halted has a bug, and that is worth a 400.
    return andonReadFailureRejection('halted_not_a_boolean', { received: typeof raw.halted });
  }

  const report: AndonReadFailureReport = {
    caller: normaliseAndonCaller(raw.caller),
    consecutive: Math.min(
      ANDON_READ_FAILURE_MAX_CONSECUTIVE,
      Math.floor(raw.consecutive),
    ),
    halted: raw.halted,
  };

  // Counts `fr_andon_probe_unreadable_total{caller}`, raises
  // `fr_andon_probe_unreadable_streak`, and on `halted` counts
  // `fr_andon_halt_total{cause="unreadable",caller}`. Never throws; logs its own
  // structured line, so a rejected report and an accepted one are both visible.
  reportAndonProbeUnreadable(report);

  // Echo the NORMALISED values back. The n8n side cannot otherwise tell that its
  // caller name was clamped or collapsed into `other`, and a label it thinks it
  // owns but does not is how a dashboard silently stops matching.
  return jsonResponse({ accepted: true, ...report });
}

/**
 * One 400, one shape, one log line.
 *
 * ⛔ THE `console.error` IS NOT DECORATION. A rejection here means the brake and
 * fr disagree about the wire contract of a SAFETY path, and the brake's own logs
 * live in another system; without this line the disagreement is visible to nobody.
 */
function andonReadFailureRejection(
  reason: string,
  detail: Record<string, unknown>,
): Response {
  console.error(
    JSON.stringify({
      telemetry: 'andon_read_failure_report_rejected',
      reason,
      ...detail,
    }),
  );
  return jsonResponse(
    {
      error: `Invalid andon read-failure report: ${reason}`,
      code: 'invalid_read_failure_report',
      details: { reason, ...detail },
    },
    400,
  );
}


/**
 * GET /api/andon/history — super-admin audit view. Returns the last 50
 * flips, newest first.
 */
export async function handleGetAndonHistory(req: Request): Promise<Response> {
  try {
    await requireSuperAdmin(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  const rows = await db
    .select({
      id: andonStateHistory.id,
      engaged: andonStateHistory.engaged,
      changed_at: andonStateHistory.changed_at,
      changed_by: andonStateHistory.changed_by,
    })
    .from(andonStateHistory)
    .orderBy(desc(andonStateHistory.changed_at))
    .limit(50);
  return jsonResponse({ history: rows });
}

// ---------------------------------------------------------------------------
// The kata's hold on the conveyor n8n instance (George 2026-11-03; migration 225's holder set)
// ---------------------------------------------------------------------------
//
// A kata runs entirely on its own n8n (kata-n8n), so while it runs the WHOLE conveyor n8n stops:
// it pulls the operator's actuator (`n8n/n8n-worker` → 0, lib/k8s-scale.ts) as one holder in a
// set. It never touches the operator's flag; the operator's release never empties the set.
//
// The ROUTES are /api/katas (routes/katas.ts, services/katas): a kata holds the cord exactly
// while its record is running or qa — and, once failed, until a super-admin releases it (George 2026-11-04) — through joinKataCordWith / leaveKataCordWith below. A kata
// is a project of THE kata tenant (KATA_TENANT_ID, migration 228).

/**
 * Drive the worker to what the COMMITTED cord says, in its own instance-cord transaction, AFTER
 * the kata's state change committed. 0 while anybody holds (the operator's flag or any kata),
 * 1 when nobody does. A missing singleton reads as held (fail closed: never scale up on a row
 * nobody can read).
 *
 * ⭐ COMMIT FIRST, THEN SCALE. The kata's row + its holder entry commit in one transaction; only
 * then is the replica count decided and PATCHed. Scaling inside that transaction meant a COMMIT
 * failure after a successful PATCH left the worker at 0 with no holder, or — on a leave — back
 * at 1 while the kata still held. Ordering is still one order: this decision and its PATCH run
 * under the same advisory lock as every other instance-cord decision, and each reads the
 * committed holder set, so the LAST PATCH always reflects the latest committed state.
 *
 * `mode`: a join always (re-)issues the decided count; a leave issues only a scale-UP (while
 * others hold, the worker is already at 0 and nothing is touched). A failure — the PATCH, or the
 * lock itself (`andon_busy`) — never undoes the committed change: it is recorded on the row
 * (`worker_scale_error`, migration 226, when the lock was got) and returned, so it is visible.
 */
async function actuateWorkerFromCommittedCord(
  mode: 'join' | 'leave',
): Promise<{ worker_replicas: number | null; worker_scaled_up: boolean; worker_scale_error: string | null }> {
  try {
    return await withInstanceCordLock(async (tx) => {
      const [row] = await tx
        .select({ engaged: andonState.engaged, holders: andonState.kata_holders })
        .from(andonState)
        .where(eq(andonState.id, 1))
        .limit(1);
      const nobodyHolds = row !== undefined && !row.engaged && (row.holders ?? []).length === 0;
      const desired = nobodyHolds ? 1 : 0;
      if (mode === 'leave' && desired === 0) return { worker_replicas: null, worker_scaled_up: false, worker_scale_error: null };
      const scale = await scaleN8nWorker(desired);
      if (scale.error) console.error(`[andon] kata ${mode}: scaling n8n-worker to ${desired} failed:`, scale.error);
      await recordWorkerScale(scale, tx);
      return { worker_replicas: scale.replicas, worker_scaled_up: desired === 1 && scale.error === null, worker_scale_error: scale.error };
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[andon] kata ${mode}: the cord change committed but the worker scale was not attempted:`, reason);
    return { worker_replicas: null, worker_scaled_up: false, worker_scale_error: `scale not attempted: ${reason}` };
  }
}

/**
 * Publish the cord state (incl. `fr_andon_kata_holders`) after a kata changed the holder set, from
 * the committed row — the same publisher every operator transition uses. Never throws: a metrics
 * read must not fail a hold that already landed.
 */
async function publishCordAfterKataChange(): Promise<void> {
  try {
    const view = await readAndon({ live: false });
    publishAndonStateForMetrics({ engaged: view.engaged, reason: view.intent, kataHolders: view.kata_holders.length });
  } catch {
    publishAndonStateForMetrics(null);
  }
}

/** What a kata-cord change did to the instance (the actuator outcome). */
export interface KataCordJoin<T> {
  result: T;
  holders: string[];
  worker_replicas: number | null;
  worker_scale_error: string | null;
}
export interface KataCordLeave<T> {
  result: T;
  released: boolean;
  holders: string[];
  worker_scaled_up: boolean;
  worker_scale_error: string | null;
}

/**
 * The kata JOINS the holder set, with `body` run FIRST on the SAME transaction under
 * {@link withInstanceCordLock}: the caller's own state write (the `katas` row, services/katas)
 * commits with the hold or not at all. A throw from `body` changes nothing and scales nothing.
 * After the commit the conveyor n8n stops (worker → 0, {@link actuateWorkerFromCommittedCord}).
 */
export async function joinKataCordWith<T>(kataId: string, body: (tx: AndonDb) => Promise<T>): Promise<KataCordJoin<T>> {
  const committed = await withInstanceCordLock(async (tx) => {
    const result = await body(tx);
    const holders = await joinSystemKataAndon(kataId, tx);
    return { result, holders };
  });
  const scale = await actuateWorkerFromCommittedCord('join');
  await publishCordAfterKataChange();
  console.log(`[andon] kata ${kataId} holds the conveyor n8n (holders=${committed.holders.length})`);
  return { ...committed, worker_replicas: scale.worker_replicas, worker_scale_error: scale.worker_scale_error };
}

/**
 * The kata LEAVES the holder set (its own entry only), `body` first on the same transaction as
 * {@link joinKataCordWith}; after the commit the worker comes back only when nobody holds.
 */
export async function leaveKataCordWith<T>(kataId: string, body: (tx: AndonDb) => Promise<T>): Promise<KataCordLeave<T>> {
  const committed = await withInstanceCordLock(async (tx) => {
    const result = await body(tx);
    const left = await leaveSystemKataAndon(kataId, tx);
    return { result, ...left };
  });
  const scale = await actuateWorkerFromCommittedCord('leave');
  await publishCordAfterKataChange();
  console.log(`[andon] kata ${kataId} released its hold (released=${committed.released}, holders=${committed.holders.length})`);
  return { ...committed, worker_scaled_up: scale.worker_scaled_up, worker_scale_error: scale.worker_scale_error };
}
