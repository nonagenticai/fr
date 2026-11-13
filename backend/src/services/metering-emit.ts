// src/services/metering-emit.ts
//
// fr-backend's per-request metering emit path. Pushes one span per
// inbound HTTP request onto the Redis stream `billing:events`, where
// billing_service's `consumer` (services/consumer.py) picks it up and
// `services/event_flusher.py` folds it into `billing_metering_events`.
//
// ⛔ NOT `metering:events` and NOT `metering_service` — an earlier revision
// of this docblock named both wrong. `streamName()` below has always
// defaulted to `billing:events`; billing_service's own settings default
// (`src/settings.py events_stream`) agrees. `metering_service` is a
// different, unrelated repo.
//
// WHY REDIS STREAMS (NOT AN HTTP POST):
//   billing_service's HTTP API is read-only for span ingest — every span
//   goes through `XADD billing:events`. The other existing producer is
//   license-authz (see license-authz/src/main.py:447), which pushes the
//   same flat-string key/value shape we mirror here.
//
// WIRE SHAPE (mirrors license-authz emit + billing_service's consumer):
//   stream: billing:events  (env-overridable via METERING_EVENTS_STREAM)
//   fields (flat strings — Redis Streams are not JSON):
//     tenant_id    — required for tenant-scoped rollups
//     subject_id   — Keycloak `sub` for per-user attribution
//     license_id   — empty here (fr-backend isn't behind license-authz)
//     app_id       — empty here (no per-license app row)
//     plan_id      — empty here
//     plan_code    — empty here
//     method       — HTTP verb (GET/POST/...)
//     path         — request pathname (no query string)
//     status       — HTTP status as a string
//     service_key  — THIS service's own name (OTEL_SERVICE_NAME, default
//                    'fr-backend'). Without it metering_service falls back to
//                    `unmapped:<first path segment>`, and because fr's whole
//                    surface is /api/... every span was filed under the
//                    fabricated identity `unmapped:api`.
//     source_ip    — set to 'fr-backend' (best-effort; the real client
//                    IP isn't trustworthy through cloudflared+istio).
//                    ⛔ NOT the service identity — see service_key.
//     timestamp    — ISO-8601 UTC
//
// SEMANTICS:
//   * Fire-and-forget from the caller's perspective. NEVER throws.
//   * No-op when METERING_STREAM_DISABLED=true OR when the Redis client
//     surface is unreachable — usage telemetry must not break a user
//     request.

import { config } from '../config';
import { REDIS_CONNECTION_OPTIONS } from './redis-connection-options';
import { SupervisedRedisClient } from './redis-supervisor';

// Dedicated Redis client pointed at the metering namespace's stream Redis,
// NOT the fr-namespace cache redis from `./redis`. The two clusters are
// disjoint: metering_service's span consumer only reads `metering:events`
// on the stream Redis pointed to by METERING_REDIS_URL. An earlier revision
// shared `services/redis.ts` and XADDed to the cache Redis, where nothing
// consumed the entries → /settings/usage stayed at zero.
// Lazy init so the client is only allocated when we have a URL — keeps
// unit tests + local dev runs (no URL set) cleanly no-op.
let meteringRedis: SupervisedRedisClient | undefined;
function getMeteringRedis(): SupervisedRedisClient | undefined {
  if (meteringRedis) return meteringRedis;
  const url = config.services.billing.redisUrl;
  if (!url) return undefined;
  // Same hardened options as the cache client, and now the same SUPERVISION.
  // This client died in the SAME SECOND as that one during fr#947 — a single
  // Redis going away cannot explain two disjoint clusters, which is what
  // identified the shared transport (ztunnel/control-plane) as the cause. It
  // reached the same terminal state again on 2026-09-06 with unbounded
  // `maxRetries` already in the image; a retry budget cannot restart a loop
  // that has stopped. See services/redis-supervisor.ts.
  meteringRedis = new SupervisedRedisClient({
    name: 'billing-redis',
    factory: () => new Bun.RedisClient(url, REDIS_CONNECTION_OPTIONS),
    onClose: () => {
      console.warn('[metering-emit] metering-redis client disconnected — reconnecting (see fr#947)');
    },
  });
  return meteringRedis;
}

interface RecordSpanInput {
  tenantId?: string;
  /**
   * George 2026-10-27 decision: a super_admin switched into another tenant is
   * OPERATOR activity, billed to the system tenant — never to the customer. The
   * span's `tenantId` is then INTERNAL_SYSTEM_TENANT_ID and this names the tenant
   * the operator was acting in (field `operator_target_tenant_id`), so the usage
   * stays attributable without being billed to it.
   */
  operatorTargetTenantId?: string;
  userId?: string;
  /** Pathname only — no querystring. */
  route: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  /**
   * Reserved for future pricing rules. metering_service today derives
   * cost from upstream LLM events on `metering:costs`; we don't compute
   * cost units inside fr-backend. Left in the API so the call sites are
   * forward-compatible.
   */
  costUnits?: number;
  /**
   * The fr project this span's request operated on, when
   * `lib/project-owner-guard.ts guardProjectId()` validated one (see
   * `middleware/request-context.ts` `projectId`).
   *
   * ⛔ NOT an inert additive field the consumer ignores — an earlier revision
   * of this docblock claimed that. billing_service's `event_flusher.py`
   * (`_parse_uuid(e.get('project_id', ''))` at :349, stored at :414) DOES
   * read this field and persists it onto `billing_metering_events.project_id`
   * (nullable, never defaulted — see that file's own docblock). Before this
   * change NOTHING on the usage stream ever sent `project_id`, so that column
   * was NULL on every row; fr-backend is the first `billing:events` producer
   * to populate it. Still safe for a consumer that predates this field
   * (it would simply not read the extra key), but the field is very much
   * consumed once read, not discarded.
   */
  projectId?: string;
}

function streamName(): string {
  return process.env.METERING_EVENTS_STREAM || 'billing:events';
}

function emitEnabled(): boolean {
  return process.env.METERING_STREAM_DISABLED !== 'true';
}

/**
 * The service identity billing files this span under.
 *
 * ⛔ NOT a new env var. This is the SAME `OTEL_SERVICE_NAME` (same default,
 * `fr-backend`) that `telemetry/otel.ts` reads for `service.name` — read here
 * directly rather than imported, because `telemetry/otel.ts` imports
 * `@opentelemetry/api` at module scope and `recordSpan` must never depend on
 * an optional-dep graph it can't be sure is installed.
 *
 * WHY IT HAS TO BE ON THE WIRE: metering_service's `extract_service_key`
 * resolves (a) a prefix match in its hardcoded SERVICE_KEY_MAP, then (b) an
 * explicit `service_key` FIELD on the event, then (c) `unmapped:<first path
 * segment>`. fr's whole surface is `/api/...`, so without this field every one
 * of fr's spans was filed as the fabricated identity `unmapped:api` — 60,731
 * requests measured on the production primary. Branch (b) exists precisely so
 * that an emitter naming itself is believed rather than re-guessed.
 */
function serviceKey(): string {
  return process.env.OTEL_SERVICE_NAME || 'fr-backend';
}

/**
 * Push one span onto the metering:events Redis stream.
 *
 * Never throws. Failures are logged with the `[metering-emit]` prefix
 * and swallowed — the inbound user request that triggered this emit
 * has already been handled and must not be retroactively failed by a
 * telemetry hiccup.
 */
export async function recordSpan(input: RecordSpanInput): Promise<void> {
  if (!emitEnabled()) return;

  // We allow tenantless emit (anonymous / pre-auth health-style routes
  // shouldn't be here, but defence in depth) — `metering:events` consumer
  // tolerates empty tenant_id (it just produces no per-tenant rollup row).
  const fields: Record<string, string> = {
    tenant_id: input.tenantId ?? '',
    subject_id: input.userId ?? '',
    license_id: '',
    app_id: '',
    plan_id: '',
    plan_code: '',
    method: input.method,
    path: input.route,
    status: String(input.statusCode),
    // The emitter naming ITSELF. ⚠️ Deliberately a field of its own and NOT a
    // re-read of `source_ip` below: billing refuses source_ip as a fallback
    // because it names the CALLER, not the service consumed.
    service_key: serviceKey(),
    source_ip: 'fr-backend',
    timestamp: new Date().toISOString(),
    // Additive fields fr-backend cares about; consumer ignores unknown keys.
    latency_ms: String(input.latencyMs),
  };
  if (input.costUnits !== undefined) {
    fields.cost_units = String(input.costUnits);
  }
  if (input.projectId) {
    fields.project_id = input.projectId;
  }
  if (input.operatorTargetTenantId) {
    fields.operator_target_tenant_id = input.operatorTargetTenantId;
  }

  // XADD <stream> MAXLEN ~ 100000 * <field> <value> ...
  // Approximate trimming keeps the stream bounded without the (expensive)
  // exact-trim path — matches license-authz's emit knobs.
  const args: string[] = [
    streamName(),
    'MAXLEN',
    '~',
    '100000',
    '*',
  ];
  for (const [k, v] of Object.entries(fields)) {
    args.push(k, v);
  }

  const client = getMeteringRedis();
  if (!client) {
    // No METERING_REDIS_URL configured — silent no-op. Logged once via
    // emitEnabled()'s sibling; here we stay quiet to avoid one-warning-per-
    // request log spam.
    return;
  }
  try {
    await client.run((c) => (c as any).send('XADD', args));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[metering-emit] XADD ${streamName()} failed: ${msg}`,
    );
  }
}
