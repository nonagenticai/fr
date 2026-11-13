// src/services/streams/repository.ts
//
// Repository layer for the improvement-stream registry (migration 026).
// Every function here is tenant-scoped — `tenant_id` is part of every
// query, never derived implicitly from a connection or a session. Routes
// pull `tenantId` from the validated request context (E-3) and pass it
// through; callers that fail to do so will fail closed (rows belong to
// some other tenant and won't match).
//
// No HTTP, no Planka, no policy. Those layers compose this one.

import { and, eq } from 'drizzle-orm';

import { db as defaultDb } from '../../db/client';
import {
  assetStreamMembership,
  streams,
  tenantImprovementProjects,
  type StreamNotificationChannel,
  type StreamNotificationEvent,
} from '../../db/schema';
import { isUuidShape } from '../../lib/uuid-shape';
import { PlankaClient } from '../planka';
import { provisionBoardFieldGroups } from '../planka/custom-fields';
import { boardSpecFor } from '../catalogue/board-template';

/**
 * Sentinel value used when a stream is created before its Planka project +
 * board exist (e.g. the `__system_workflow__` baseline). The auto-provision hook in
 * `createStream` skips Planka calls for placeholder boards.
 */
const PLANKA_BOARD_PLACEHOLDER = 'planka-tbd';

// ----- Types ---------------------------------------------------------------

export type StreamKind = (typeof streams.kind.enumValues)[number];
// 'card' (migration 144) is in the column's enum but is a kaizen_log
// attribution only — a CHECK forbids it as a stream member.
export type AssetKind = Exclude<
  (typeof assetStreamMembership.asset_kind.enumValues)[number],
  'card'
>;

export type StreamRow = typeof streams.$inferSelect;
type AssetMembershipRow = typeof assetStreamMembership.$inferSelect;
type TenantImprovementProjectRow =
  typeof tenantImprovementProjects.$inferSelect;

export type StreamsDb = typeof defaultDb;

interface ListStreamsFilter {
  kind?: StreamKind;
  ownerDeptId?: string;
  /** Default true — soft-deleted streams are excluded unless explicitly asked for. */
  includeInactive?: boolean;
}

interface CreateStreamInput {
  tenantId: string;
  kind: StreamKind;
  name: string;
  slug: string;
  plankaProjectId: string;
  plankaBoardId: string;
  thresholdRules: Record<string, unknown>;
  evalSetId?: string | null;
  ownerDeptId?: string | null;
  minSignificanceN?: number;
}

interface UpdateStreamPatch {
  name?: string;
  /**
   * Migration 120 — the fr project whose repository this stream's improvement
   * work targets. `null` un-points the stream. Undefined leaves it alone (the
   * set-builder below is presence-keyed, so a PATCH that omits it cannot
   * accidentally clear it).
   */
  projectId?: string | null;
  thresholdRules?: Record<string, unknown>;
  minSignificanceN?: number;
  ownerDeptId?: string | null;
  evalSetId?: string | null;
  /**
   * Plan 4 Lane F — opt-out of canary observation window. fr stores;
   * Plan 5/6 n8n subflow reads + decides what to pass downstream
   * (workflow-routing observation_window_minutes=0 / inference-router
   * canary_percent=0). Default TRUE (canary enabled).
   */
  canaryEnabled?: boolean;
  /**
   * Plan 5 Stage 1.4 — per-stream notification channel config (migration
   * 040). When set, replaces the entire channel list for the stream.
   */
  notificationChannels?: StreamNotificationChannel[];
}

/**
 * Plan 5 Stage 1.4 — resolve the channels that should fan out for a given
 * stream + event. Returns only the channels whose `on` array includes the
 * event. Caller is responsible for tenant scoping; this helper takes a
 * pre-fetched StreamRow so it's cheap to call from a hot route.
 */
export function resolveStreamChannels(
  stream: Pick<StreamRow, 'notification_channels'>,
  event: StreamNotificationEvent,
): StreamNotificationChannel[] {
  const channels = stream.notification_channels ?? [];
  return channels.filter((c) => c.on.includes(event));
}

// ----- Streams CRUD --------------------------------------------------------

export async function listStreams(
  tenantId: string,
  filter: ListStreamsFilter = {},
  db: StreamsDb = defaultDb,
): Promise<StreamRow[]> {
  const includeInactive = filter.includeInactive ?? false;
  const conditions = [eq(streams.tenant_id, tenantId)];
  if (!includeInactive) conditions.push(eq(streams.is_active, true));
  if (filter.kind) conditions.push(eq(streams.kind, filter.kind));
  if (filter.ownerDeptId)
    conditions.push(eq(streams.owner_dept_id, filter.ownerDeptId));

  return db
    .select()
    .from(streams)
    .where(and(...conditions))
    .orderBy(streams.created_at);
}

export async function getStream(
  id: string,
  tenantId: string,
  db: StreamsDb = defaultDb,
): Promise<StreamRow | null> {
  // `streams.id` is a `uuid` column (schema.ts:1304) and the `:id` path param on
  // routes/assets/streams.ts is NOT shape-validated there (its zod `uuid()` only
  // covers BODY fields), so a malformed id reached Postgres and raised 22P02
  // `invalid input syntax for type uuid`. `null` is the SAME miss value an
  // absent / other-tenant id yields, so every stream route keeps its existing
  // 404: a distinct status for "malformed" would hand a prober a free oracle,
  // defeating the don't-leak-existence contract (routes/approvals.ts:408).
  //
  // `isUuidShape`, not `isValidUuid` (utils/tenant) — the latter pins the
  // version nibble to 1-8 and the variant to [89ab] and would 404 a live row.
  // Note `getStreamBySlug` below takes `streams.slug`, a TEXT column, and is
  // deliberately NOT guarded: a uuid check there would reject every real slug.
  if (!isUuidShape(id)) return null;

  const rows = await db
    .select()
    .from(streams)
    .where(and(eq(streams.id, id), eq(streams.tenant_id, tenantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a stream by its (tenant_id, slug) tuple. Used by the n8n
 * aggregator credentials in the streams-removal plan to look up the
 * system-tenant baseline streams (`__system_workflow__` /
 * `__system_prompt__`) by slug instead of by UUID. Tenant-scoped — a
 * slug that exists under a different tenant returns null.
 */
export async function getStreamBySlug(
  tenantId: string,
  slug: string,
  db: StreamsDb = defaultDb,
): Promise<StreamRow | null> {
  const rows = await db
    .select()
    .from(streams)
    .where(and(eq(streams.tenant_id, tenantId), eq(streams.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every ACTIVE stream a tenant owns for one kind, OLDEST FIRST.
 *
 * There is normally exactly one, and both callers treat `[0]` as the incumbent:
 *
 *   * `getOrCreateAssetStream` adopts it instead of minting a second row when
 *     the slug it computes no longer matches the row's slug;
 *   * `deriveMembershipForStream` grows only the incumbent, so a duplicate pair
 *     cannot double every membership row.
 *
 * Measured 2026-09-11: tenant 0195f48b-…0002 owns TWO active streams for each of
 * decision / principle / requirement (migration 062 re-keyed `tenant_id` without
 * rewriting the tenant-uuid embedded in `slug`). `created_at ASC` makes the
 * winner the pre-existing row rather than whichever the planner returned first.
 */
export async function listStreamsByKind(
  tenantId: string,
  kind: StreamKind,
  db: StreamsDb = defaultDb,
): Promise<StreamRow[]> {
  return db
    .select()
    .from(streams)
    .where(
      and(
        eq(streams.tenant_id, tenantId),
        eq(streams.kind, kind),
        eq(streams.is_active, true),
      ),
    )
    .orderBy(streams.created_at);
}

export async function createStream(
  input: CreateStreamInput,
  db: StreamsDb = defaultDb,
): Promise<StreamRow> {
  const rows = await db
    .insert(streams)
    .values({
      tenant_id: input.tenantId,
      kind: input.kind,
      name: input.name,
      slug: input.slug,
      planka_project_id: input.plankaProjectId,
      planka_board_id: input.plankaBoardId,
      threshold_rules: input.thresholdRules,
      eval_set_id: input.evalSetId ?? null,
      owner_dept_id: input.ownerDeptId ?? null,
      min_significance_n: input.minSignificanceN ?? 30,
    })
    .returning();
  if (!rows[0]) throw new Error('createStream: insert returned no rows');
  const newStream = rows[0];

  // AA Card Substrate Phase 2/3 — auto-provision all 8 AA-spec
  // customFieldGroups on the stream's Planka board so card-create paths can
  // immediately PATCH metadata + later phases (4–10) can write the other
  // group fields without an operator running the provision script first.
  //
  // Failure mode = let it throw. The DB INSERT has already committed by the
  // time we hit this hook (`.returning()` returns from a single executed
  // INSERT). A thrown error here surfaces as a 500 to the caller, but the
  // row exists in the DB. The provision script's heal pass + the next
  // create attempt's idempotent re-run will both close the gap; an
  // unprovisioned-but-exists stream is a worse footgun (silent card-create
  // failure later).
  if (
    newStream.planka_board_id &&
    newStream.planka_board_id !== PLANKA_BOARD_PLACEHOLDER
  ) {
    const planka = PlankaClient.fromConfig().asAgent();
    // Exactly the owning tenant's RM `default` board template's field groups
    // (v4 ruling 12; board-template.ts). Board creation is the only place fr
    // creates fields — card writers skip a field the board lacks.
    const spec = await boardSpecFor(input.tenantId, null);
    await provisionBoardFieldGroups(planka, newStream.planka_board_id, spec.fieldGroups);
  }

  return newStream;
}

export async function updateStream(
  id: string,
  tenantId: string,
  patch: UpdateStreamPatch,
  db: StreamsDb = defaultDb,
): Promise<StreamRow | null> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.thresholdRules !== undefined) set.threshold_rules = patch.thresholdRules;
  if (patch.minSignificanceN !== undefined)
    set.min_significance_n = patch.minSignificanceN;
  if (patch.ownerDeptId !== undefined) set.owner_dept_id = patch.ownerDeptId;
  if (patch.evalSetId !== undefined) set.eval_set_id = patch.evalSetId;
  if (patch.projectId !== undefined) set.project_id = patch.projectId;
  if (patch.canaryEnabled !== undefined) set.canary_enabled = patch.canaryEnabled;
  if (patch.notificationChannels !== undefined)
    set.notification_channels = patch.notificationChannels;

  // Same 22P02-into-a-`uuid`-column guard as `getStream`; `null` is this
  // function's own miss value, so the route's 404 is unchanged.
  if (!isUuidShape(id)) return null;

  const rows = await db
    .update(streams)
    .set(set)
    .where(and(eq(streams.id, id), eq(streams.tenant_id, tenantId)))
    .returning();
  return rows[0] ?? null;
}

export async function softDeleteStream(
  id: string,
  tenantId: string,
  db: StreamsDb = defaultDb,
): Promise<boolean> {
  // Same guard as `getStream`; `false` is this function's own miss value, so a
  // malformed id 404s exactly like an already-absent one.
  if (!isUuidShape(id)) return false;

  const rows = await db
    .update(streams)
    .set({ is_active: false, updated_at: new Date() })
    .where(and(eq(streams.id, id), eq(streams.tenant_id, tenantId)))
    .returning({ id: streams.id });
  return rows.length > 0;
}

// ----- Membership ----------------------------------------------------------
//
// Membership queries always go through the streams table to enforce tenant
// scoping — the membership table itself has no tenant column (the FK
// guarantees a stream_id only resolves within one tenant's stream).

export async function addMember(
  streamId: string,
  assetKind: AssetKind,
  assetId: string,
  tenantId: string,
  db: StreamsDb = defaultDb,
): Promise<AssetMembershipRow | null> {
  // Tenant-scope guard: the stream_id must belong to this tenant.
  const stream = await getStream(streamId, tenantId, db);
  if (!stream) return null;

  // ON CONFLICT DO NOTHING + RETURNING returns no rows when the row already
  // exists; do a follow-up SELECT in that case so callers always get a row.
  const inserted = await db
    .insert(assetStreamMembership)
    .values({ stream_id: streamId, asset_kind: assetKind, asset_id: assetId })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const existing = await db
    .select()
    .from(assetStreamMembership)
    .where(
      and(
        eq(assetStreamMembership.stream_id, streamId),
        eq(assetStreamMembership.asset_kind, assetKind),
        eq(assetStreamMembership.asset_id, assetId),
      ),
    )
    .limit(1);
  return existing[0] ?? null;
}

export async function removeMember(
  streamId: string,
  assetKind: AssetKind,
  assetId: string,
  tenantId: string,
  db: StreamsDb = defaultDb,
): Promise<boolean> {
  const stream = await getStream(streamId, tenantId, db);
  if (!stream) return false;

  // `asset_stream_membership.asset_id` is `uuid NOT NULL` (migration 017), and
  // until 2026-09-11 NOTHING guarded this argument: fr's own asset surfaces
  // carry non-UUID ids (n8n workflow ids like `grB1xwiFmdFdHoGa`, numeric
  // procedure ids like `886`), so
  //   DELETE /api/assets/streams/:id/members/workflow/grB1xwiFmdFdHoGa
  // reached Postgres and raised 22P02 `invalid input syntax for type uuid`,
  // which escaped as a bare 500 (reproduced live 2026-09-11). `false` is this
  // function's own miss value, so the route's existing 404 "Membership not
  // found" is what the caller sees — a malformed id is unfindable for exactly
  // the same reason an absent one is. Same `isUuidShape` helper the stream_id
  // guards above use; deliberately not a second local regex.
  if (!isUuidShape(assetId)) return false;

  const rows = await db
    .delete(assetStreamMembership)
    .where(
      and(
        eq(assetStreamMembership.stream_id, streamId),
        eq(assetStreamMembership.asset_kind, assetKind),
        eq(assetStreamMembership.asset_id, assetId),
      ),
    )
    .returning({ stream_id: assetStreamMembership.stream_id });
  return rows.length > 0;
}

export async function listMembers(
  streamId: string,
  tenantId: string,
  db: StreamsDb = defaultDb,
): Promise<AssetMembershipRow[]> {
  const stream = await getStream(streamId, tenantId, db);
  if (!stream) return [];
  return db
    .select()
    .from(assetStreamMembership)
    .where(eq(assetStreamMembership.stream_id, streamId))
    .orderBy(assetStreamMembership.added_at);
}

/**
 * "Which streams does this asset belong to?" — drives the membership-pills
 * component in the asset detail surfaces. Joined against `streams` to filter
 * by tenant + active flag without leaking soft-deleted streams.
 */
export async function listAssetMemberships(
  assetKind: AssetKind,
  assetId: string,
  tenantId: string,
  db: StreamsDb = defaultDb,
): Promise<StreamRow[]> {
  // Same 22P02 guard as `removeMember` above — this function is reached by TWO
  // unguarded routes (`GET /api/assets/:kind/:id/streams` and the membership
  // pre-check in `POST /api/assets/:kind/:id/improvement-card`) plus the agui
  // action, so the guard lives here rather than only at one call site. `[]` is
  // this function's own miss value; the members route additionally answers 404
  // rather than an empty 200, because an id that cannot enter a `uuid` column
  // is not "a real asset in zero streams" and must not read as one.
  if (!isUuidShape(assetId)) return [];

  return db
    .select({
      id: streams.id,
      tenant_id: streams.tenant_id,
      kind: streams.kind,
      name: streams.name,
      slug: streams.slug,
      planka_project_id: streams.planka_project_id,
      planka_board_id: streams.planka_board_id,
      threshold_rules: streams.threshold_rules,
      eval_set_id: streams.eval_set_id,
      owner_dept_id: streams.owner_dept_id,
      project_id: streams.project_id,
      min_significance_n: streams.min_significance_n,
      is_active: streams.is_active,
      canary_enabled: streams.canary_enabled,
      notification_channels: streams.notification_channels,
      andon_engaged: streams.andon_engaged,
      andon_engaged_at: streams.andon_engaged_at,
      andon_engaged_by: streams.andon_engaged_by,
      created_at: streams.created_at,
      updated_at: streams.updated_at,
    })
    .from(assetStreamMembership)
    .innerJoin(streams, eq(streams.id, assetStreamMembership.stream_id))
    .where(
      and(
        eq(assetStreamMembership.asset_kind, assetKind),
        eq(assetStreamMembership.asset_id, assetId),
        eq(streams.tenant_id, tenantId),
        eq(streams.is_active, true),
      ),
    )
    .orderBy(streams.created_at);
}

// ----- Tenant umbrella projects -------------------------------------------

export async function getTenantImprovementProject(
  tenantId: string,
  kind: StreamKind,
  db: StreamsDb = defaultDb,
): Promise<TenantImprovementProjectRow | null> {
  const rows = await db
    .select()
    .from(tenantImprovementProjects)
    .where(
      and(
        eq(tenantImprovementProjects.tenant_id, tenantId),
        eq(tenantImprovementProjects.kind, kind),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertTenantImprovementProject(
  tenantId: string,
  kind: StreamKind,
  plankaProjectId: string,
  db: StreamsDb = defaultDb,
): Promise<TenantImprovementProjectRow> {
  // Concurrent first-create: an INSERT with ON CONFLICT DO NOTHING + a
  // post-fetch handles the race where two requests both miss the cache and
  // both try to create. The PK (tenant_id, kind) ensures only one wins;
  // the loser's existing row is what we return.
  const inserted = await db
    .insert(tenantImprovementProjects)
    .values({ tenant_id: tenantId, kind, planka_project_id: plankaProjectId })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const existing = await getTenantImprovementProject(tenantId, kind, db);
  if (!existing) {
    // Only possible if a concurrent transaction inserted then immediately
    // deleted — not a real flow in production. Surface as a hard error so
    // callers don't silently swallow it.
    throw new Error(
      `upsertTenantImprovementProject: no row found after upsert for tenant=${tenantId} kind=${kind}`,
    );
  }
  return existing;
}

// ----- Misc helpers --------------------------------------------------------

/**
 * Default threshold-rule template for new streams. Kept here (not in the
 * DB default) so adjusting the rule set doesn't require a schema migration.
 * See spec §3 "Default threshold rules".
 */
export const DEFAULT_THRESHOLD_RULES = {
  p95_latency: { rule: 'ratio_to_baseline', threshold: 2.0 },
  failure_rate: { rule: 'absolute', threshold: 0.1 },
  fallback_rate: { rule: 'absolute', threshold: 0.3 },
  cost_per_exec: { rule: 'ratio_to_baseline', threshold: 1.5 },
  bounce_rate: { rule: 'absolute', threshold: 0.2 },
} as const;
