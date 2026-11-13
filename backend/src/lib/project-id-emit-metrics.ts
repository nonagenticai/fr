// src/lib/project-id-emit-metrics.ts
//
// One counter: what happened when fr tried to attach a project identity to an
// outbound billing-relevant call (X-Project-Id header + the per-request
// metering span's project_id field), split by OUTCOME and by LANE — 3 × 2 = 6
// series, bounded, no request-path cardinality risk (two-label shape copied
// from lib/andon-gate-metrics.ts / lib/board-tenant-gate-metrics.ts, which use
// the same `key(a, b)` Map idiom).
//
// ── THE `lane` LABEL (fr#1214) ───────────────────────────────────────────
//
// `FrProjectOwnerGuardForeign` fired 2026-09-25 07:57Z on CORRECT behaviour,
// and the counter as first shipped could not say so. fr#1193 (merged
// `cd5da66b`, deployed 21:31Z 2026-09-24) added `findProjectForRead` /
// `crossTenantRead`: for a super-admin in HOME view `tenantScopedProjectFilter`
// returns `sql\`true\`` (project-access.ts:216), i.e. any project by id. The
// guard then classifies such a project `foreign` — correctly, its tag really
// is not the caller's active tenant — so a super-admin who owns zero projects
// emits `foreign` for EVERY project they open, permanently and by design
// (measured: 5 events 07:57:02–07:57:37Z, `GET /api/projects/:id/cockpit` ×4
// plus `/approvals` ×1; refuted alternatives: 0 projects created on 09-24 or
// 09-25, `max(updated_at)` 09-24 03:05Z = 4h52m BEFORE onset, the target
// project's tag unmoved for 3 days, `projects` grew 258→263 so nothing was
// wiped).
//
// ⛔ THE FIX IS NOT TO SUPPRESS `foreign`, AND NOT TO RAISE A THRESHOLD. Both
// would delete the alert's reason to exist — the case it is FOR is a mis-tagged
// row or a wrong-tenant caller, which is indistinguishable from the deliberate
// lane in a series labelled by outcome alone. `lane` makes them distinguishable
// at the query layer while every outcome keeps being emitted for both lanes:
//
//   lane="cross_tenant_read" — the deliberate super-admin/home-view read lane
//                              (`crossTenantReadOnly === true` in
//                              `project-access.ts resolveProject`, which is
//                              `opts.crossTenantRead && isSuperAdminHomeView`).
//                              `foreign` here is EXPECTED.
//   lane="own_tenant"        — everything else, i.e. every mutating caller and
//                              every ordinary identity. `foreign` here is the
//                              real defect the alert exists for.
//
// ⛔ NO CALLER OR PROJECT LABEL, EVER. Those are unbounded on a metering
// metric. The mis-tagged row's identity belongs in the log line
// `telemetry: "project_id_emit_refused"` (project-owner-guard.ts), not in a
// label. `scripts/…` has no guard for this.
//
// ⛔ NO `absent` LABEL. An earlier revision pre-seeded a fourth outcome for
// "no project row, or no caller tenant" — but `guardProjectId`'s ONE caller
// (`lib/project-access.ts resolveProject`) only ever invokes it inside
// `if (project) { … }`, with `activeTenantId` derived from `ctxTenantId`,
// which either returns a real string or throws. Neither argument can be
// missing at the only call site that exists, so a label that can never
// increment was removed rather than kept as a permanently-zero row a reader
// would mistake for "measured, and nothing happened".
//
// WHY IT EXISTS. `lib/project-owner-guard.ts` validates a resolved project's
// `project_data.keycloak_tenant_id` tag against the caller's active tenant
// before that project id is allowed onto the wire. Coverage of that tag is
// NOT total (measured 2026-09-16 on worker4 fr db: 240/258 = 93.02% —
// `select count(*) total, count(*) filter (where project_data->>
// 'keycloak_tenant_id' is not null and project_data->>'keycloak_tenant_id' <>
// '') tagged from projects;`), so a silent pass-through of an untagged or
// mismatched project row would repeat the unsigned-`x-app-key` defect class —
// this counter is what makes that failure visible instead of invisible.
//
// This lives in `lib/` (not a route file) so it can be imported from both the
// guard (which counts) and `routes/metrics.ts` (which renders) without either
// pulling in the other's dependency graph.
//
// ── RETENTION ────────────────────────────────────────────────────────────
//
// ⚠️ CORRECTED 2026-09-25 — this block used to state, as present-tense fact,
// that "fr-backend:8888 is NEVER scraped and must not be made scrapable — it is
// ambient-meshed and serves fr's whole authenticated API, so opening a scrape
// means `portLevelMtls: PERMISSIVE` on that port". **THE FIRST HALF IS FALSE.**
// gitops shipped the scrape anyway — `clusters/prod/services/fr/service.yaml`
// :43-45, live since ~2026-09-23 13:23Z. The claim is kept here, quoted and
// retracted rather than deleted, because it was READ AND REASONED FROM: it is
// what made the `exported_job` contract below look like a house style rather
// than the thing that stops a consumer double-counting.
//
// Measured live 2026-09-25, twice independently:
//
//   count by (exported_job, job)(fr_project_id_emit_total)
//     {exported_job="fr-project-id-emit", job="kubernetes-pods"} = 48
//     {job="kubernetes-service-endpoints"}                       = 3
//   up{kubernetes_namespace="fr",kubernetes_name="fr-backend"}   = 1
//                                    at instance="10.42.0.65:8888"
//
// ⇒ THIS FAMILY ARRIVES ON TWO RAILS: the pushgateway (carrying
// `exported_job`, pushed by the code at the bottom of this file) AND the
// service-endpoint scrape of fr-backend:8888 (`routes/metrics.ts ::
// handlePromMetrics`, no `exported_job`). Both are fed by the ONE
// `renderProjectIdEmitMetrics()` below, so the label set cannot diverge between
// them — but the SAMPLES are duplicated, which is a query-layer hazard, not a
// rendering one.
//
// ⛔ THE "select on `exported_job`, never on plain `job`" CONTRACT BELOW IS
// THEREFORE LOAD-BEARING, NOT STYLISTIC. Measured on the fr#1214 burst:
// `increase(…{outcome="foreign"}[3h])` = **5.007** WITH the `exported_job`
// selector and **10.009** WITHOUT it — exactly 2×, because both rails carry the
// same counter. A consumer that omits it reports double every count, which is
// precisely the class of defect fr#1214's alert had.
//
// ⛔ NOT A LICENCE TO CHANGE SCRAPABILITY EITHER WAY. Whether :8888 should be
// scraped is gitops' decision and is already made; this file's job is to render
// a label set that reads the same on both rails. The `portLevelMtls` argument
// quoted above is the reason the pushgateway rail exists and is why it stays —
// it is not evidence about what the cluster does today.
//
// Every retained `fr_*` family rides the pushgateway, carrying `exported_job`.
// This counter — the one that makes `keycloak_tenant_id` tag-coverage drift and
// `foreign`-outcome attempts visible at all — rides the same rail, for the same
// reason. The full design argument (POST-only and why DELETE is the
// alarm-erasure vector of deployment#3490; `{job, instance}` grouping;
// `exported_job` at the query layer vs `job` at the push layer) is written out
// once, at length, in `lib/deblock-action-metrics.ts` and is not restated here.
// ⚠️ THAT FILE CARRIES THE SAME RETRACTED CLAIM, in three places —
// `deblock-action-metrics.ts:209` and `:225` ("fr's API port is deliberately
// unscraped") and `:309` ("records as NEVER SCRAPED"). They are out of scope for
// fr#1214 and are NOT edited here, so do not read that file's agreement as a
// second measurement: it is the same stale sentence, not corroboration.
//
// JOB NAME: `fr-project-id-emit`, named for the counter family (matching
// `fr-approval-horizon`, `fr-deblock-actions`, `fr-roster-discharge`), not
// for the guard file that calls it.
//
// CONSUMER CONTRACT — select on `exported_job`, never on plain `job`
// (`{job="fr-project-id-emit"}` matches zero series through the pushgateway
// scrape and raises nothing; PromQL has no unknown-label error, so a rule
// written that way is permanently green). Always `increase()`/`rate()`, never
// a raw `sum()` — the in-process Map this file counts into resets to
// all-zero on every process start, so a pod restart is a genuine counter reset, not
// an anomaly. The alert this counter exists to support:
//
//   sum(increase(fr_project_id_emit_total{exported_job="fr-project-id-emit",outcome="foreign",lane="own_tenant"}[1h])) > 0
//   absent(fr_project_id_emit_push_timestamp_seconds{exported_job="fr-project-id-emit"})
//
// ⚠️ `lane="own_tenant"` IS LOAD-BEARING IN THAT SELECTOR, and its absence is
// what made the rule fire on correct behaviour (see "THE `lane` LABEL" above).
// A rule that omits it re-creates fr#1214 exactly. A rule that instead selects
// `lane="cross_tenant_read"` is measuring how much the deliberate lane is used,
// which is a dashboard, not an alarm.
//
// ⚠️ ONE RENDERER, BOTH RAILS — and `exported_job` is what keeps the two apart.
// `renderProjectIdEmitMetrics()` is the single source for BOTH the pushgateway
// body (`renderProjectIdEmitPushBody` below) and the `routes/metrics.ts ::
// renderPromExporter` scrape rail, so the LABEL SET cannot diverge between them.
// The SAMPLES are duplicated, though: measured live 2026-09-25 this family
// appears under `{exported_job="fr-project-id-emit", job="kubernetes-pods"}` (48
// series) AND `{job="kubernetes-service-endpoints"}` (3 series), because
// fr-backend:8888 IS scraped — see the CORRECTED note under RETENTION below, and
// `clusters/prod/services/fr/service.yaml:43-45`. On the fr#1214 burst,
// `increase(…{outcome="foreign"}[3h])` measured **5.007** with the
// `exported_job` selector and **10.009** without: exactly 2×. Omitting it
// doubles every count. Anything added to only one of the two render paths would
// additionally make a rule's answer depend on which rail it selected.
//
// All 3 outcomes × 2 lanes = 6 series ride every push, zeros included — the
// same "push the zeros" rule the siblings use, for the same reason: a series
// that appears only once it is non-zero cannot be alerted on before it matters.
// There is no fourth outcome (see "NO `absent` LABEL") and no third lane
// (`crossTenantReadOnly` is a boolean).

import { hostname } from 'node:os';

const PROJECT_ID_EMIT_OUTCOMES = ['owned', 'foreign', 'untagged'] as const;
export type ProjectIdEmitOutcome = (typeof PROJECT_ID_EMIT_OUTCOMES)[number];

/**
 * The two read lanes, and there can be no third: the sole input is
 * `project-access.ts resolveProject`'s `crossTenantReadOnly`, a boolean
 * (`opts.crossTenantRead && isSuperAdminHomeView(user)`). Exported so the
 * bounded-cardinality test can assert the product rather than a literal count.
 */
export const PROJECT_ID_EMIT_LANES = ['own_tenant', 'cross_tenant_read'] as const;
export type ProjectIdEmitLane = (typeof PROJECT_ID_EMIT_LANES)[number];

/** Map key for the (outcome, lane) pair — same `${a}|${b}` idiom as
 * `andon-gate-metrics.ts` and `board-tenant-gate-metrics.ts`. */
const key = (o: ProjectIdEmitOutcome, l: ProjectIdEmitLane): string => `${o}|${l}`;

/** Pre-seeded with all 6 pairs so a never-fired one renders 0 rather than
 * vanishing — see "push the zeros" in the header. */
const projectIdEmitTotal = new Map<string, number>();
for (const o of PROJECT_ID_EMIT_OUTCOMES) {
  for (const l of PROJECT_ID_EMIT_LANES) projectIdEmitTotal.set(key(o, l), 0);
}

/**
 * Count one project-ownership decision. Called from
 * `lib/project-owner-guard.ts guardProjectId()` on every invocation,
 * independently of the (unconditional) emission decision — this counter is
 * how `keycloak_tenant_id` tag coverage gets re-measured live.
 *
 * `lane` is REQUIRED, deliberately with no default. A default would let a new
 * call site inherit `own_tenant` silently, which is exactly the mislabelling
 * fr#1214 is about — a missing argument must be a compile error, not a
 * plausible-looking series.
 */
export function recordProjectIdEmitOutcome(
  outcome: ProjectIdEmitOutcome,
  lane: ProjectIdEmitLane,
): void {
  const k = key(outcome, lane);
  projectIdEmitTotal.set(k, (projectIdEmitTotal.get(k) ?? 0) + 1);
}

/** Prometheus text-exposition lines for the counter. Rendered by
 * routes/metrics.ts AND wrapped by renderProjectIdEmitPushBody — one renderer,
 * both rails (see the header). */
export function renderProjectIdEmitMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_project_id_emit_total Outcome of validating a project id before it rides an outbound billing-relevant call, split by outcome and by read lane. lane="cross_tenant_read" is the deliberate super-admin home-view lane where outcome="foreign" is EXPECTED; alert on lane="own_tenant".',
    '# TYPE fr_project_id_emit_total counter',
  ];
  for (const o of PROJECT_ID_EMIT_OUTCOMES) {
    for (const l of PROJECT_ID_EMIT_LANES) {
      lines.push(
        `fr_project_id_emit_total{outcome="${o}",lane="${l}"} ${projectIdEmitTotal.get(key(o, l)) ?? 0}`,
      );
    }
  }
  return lines;
}

// ── PUSHGATEWAY RETENTION ───────────────────────────────────────────────────
// Mirrors `lib/deblock-action-metrics.ts`'s push half line for line (job name,
// timeout, instance resolution, POST-only, heartbeat) — see that file for the
// full rationale. Kept as its own copy rather than a shared helper because
// none of the three existing push-capable metric files (`deblock-action-metrics.ts`,
// `roster-discharge-metrics.ts`, `workers/approval-expiry.ts`'s horizon emitter)
// factor one out either; each owns its job name, timeout constant and instance
// resolver so that no two families can accidentally share a pushgateway group.

/**
 * Pushgateway grouping key, JOB half. NEW name — collides with none of the
 * job values enumerated live against the pushgateway registry by the sibling
 * files' own tests; re-verify live before merge if that registry may have
 * grown since.
 */
export const PROJECT_ID_EMIT_PUSHGATEWAY_JOB = 'fr-project-id-emit';

/**
 * Wall-clock bound on the pushgateway POST. Same value and reasoning as
 * `DEBLOCK_PUSH_TIMEOUT_MS` — kept local to avoid a cross-file cycle (this
 * file has no dependents that would import it back).
 */
export const PROJECT_ID_EMIT_PUSH_TIMEOUT_MS = 10_000;

/** Heartbeat family — the `absent()`/staleness partner. Without it a dead
 * emitter and a genuinely-zero counter are byte-identical. */
export const PROJECT_ID_EMIT_PUSH_TIMESTAMP_METRIC = 'fr_project_id_emit_push_timestamp_seconds';

/**
 * Grouping key, INSTANCE half. Refuses rather than guesses — see
 * `resolveDeblockPushInstance`'s docblock: a shared constant fallback would
 * merge every pod into one group and let two processes silently overwrite
 * each other's push.
 */
export function resolveProjectIdEmitPushInstance(
  env: Record<string, string | undefined>,
  fallbackHostname: string,
): string | null {
  const candidate = (env.POD_NAME ?? env.HOSTNAME ?? fallbackHostname ?? '').trim();
  if (candidate === '') return null;
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
}

/** The pushgateway body: every series (including the zeros) plus the heartbeat. */
export function renderProjectIdEmitPushBody(nowSeconds: number): string {
  const lines = [...renderProjectIdEmitMetrics()];
  lines.push(
    `# HELP ${PROJECT_ID_EMIT_PUSH_TIMESTAMP_METRIC} Unix time this fr-backend process last published project-id-emit counters.`,
  );
  lines.push(`# TYPE ${PROJECT_ID_EMIT_PUSH_TIMESTAMP_METRIC} gauge`);
  lines.push(`${PROJECT_ID_EMIT_PUSH_TIMESTAMP_METRIC} ${Math.floor(nowSeconds)}`);
  return lines.join('\n') + '\n';
}

/**
 * Publish the project-id-emit counters to the pushgateway.
 *
 * NEVER throws — this hangs off the `approval-expiry` worker tick and a
 * pushgateway outage must not stop that tick. NEVER silent either: every
 * failure path logs `[project-id-emit-metrics]` with the reason.
 *
 * NEVER HANGS: the catch below is after the await, so an untimed `fetch`
 * onto a silently-dropped connection is not a caught failure but a promise
 * that never settles, and it would take its awaiting tick with it.
 * `PROJECT_ID_EMIT_PUSH_TIMEOUT_MS` makes the catch reachable.
 *
 * POST only — see the #3490 note in `lib/deblock-action-metrics.ts`: DELETE
 * is the alarm-erasure vector, and PUT would replace families in the group
 * that this body does not carry.
 */
export async function publishProjectIdEmitMetrics(): Promise<void> {
  const env = process.env;
  const logger = console;
  const nowSeconds = Date.now() / 1000;

  const pushgatewayUrl = (env.PUSHGATEWAY_URL ?? '').trim();
  if (pushgatewayUrl === '') {
    // No hardcoded fallback, per config-externalization-policy.md — same as
    // every sibling emitter. The `absent()` half of the alert pair catches
    // this where the push was expected.
    return;
  }

  const instance = resolveProjectIdEmitPushInstance(env, hostname());
  if (instance === null) {
    logger.error(
      '[project-id-emit-metrics] no usable pushgateway instance identity ' +
        '(POD_NAME/HOSTNAME/os.hostname all empty or not [A-Za-z0-9._-]); ' +
        'NOT pushing, because a shared fallback group would let two processes ' +
        'overwrite each other',
    );
    return;
  }

  const url =
    `${pushgatewayUrl.replace(/\/+$/, '')}` +
    `/metrics/job/${encodeURIComponent(PROJECT_ID_EMIT_PUSHGATEWAY_JOB)}` +
    `/instance/${encodeURIComponent(instance)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: renderProjectIdEmitPushBody(nowSeconds),
      // See the docblock: without this the catch below is unreachable on a
      // silent drop, and this call is awaited by a worker tick.
      signal: AbortSignal.timeout(PROJECT_ID_EMIT_PUSH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.error(
        `[project-id-emit-metrics] pushgateway returned ${resp.status}; project-id-emit ` +
          `counters NOT updated (job=${PROJECT_ID_EMIT_PUSHGATEWAY_JOB} instance=${instance})`,
      );
    }
  } catch (err) {
    logger.error(
      `[project-id-emit-metrics] push failed, project-id-emit counters NOT updated ` +
        `(job=${PROJECT_ID_EMIT_PUSHGATEWAY_JOB} instance=${instance}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
