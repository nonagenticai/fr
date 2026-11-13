/**
 * Bridge routes — analysis-to-kanban promotion surface.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md
 *   §"In scope" (route list)
 *   §"Envelope" — { data, meta? } on success, IntegrationError → integrationErrorResponse
 *   §"ReqCtx / authorization" — every call scoped by (user_id, project_id)
 *
 * Endpoints (capability-derived: src/capabilities/tools/bridge.ts):
 *   GET    /api/tools/bridge/sources
 *   GET    /api/tools/bridge/sources/:producer/outputs
 *   POST   /api/tools/bridge/drafts
 *   GET    /api/tools/bridge/drafts?project_id=&status=&limit=
 *   GET    /api/tools/bridge/drafts/:id
 *   PATCH  /api/tools/bridge/drafts/:id
 *   POST   /api/tools/bridge/drafts/:id/submit
 *   POST   /api/tools/bridge/drafts/:id/reject
 *   POST   /api/tools/bridge/drafts/:id/commit
 *   GET    /api/tools/bridge/links?producer=&stable_id=
 */

import { and, eq, sql } from 'drizzle-orm';

import { validateAuth } from '../../middleware/auth';
import {
  buildRequestContext,
  ctxTenantId,
  withRequestContext,
} from '../../middleware/request-context';
import { pgErrorCode } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { IntegrationError } from '../../integrations/_lib/errors';
import { isUuidShape } from '../../lib/uuid-shape';
import { emitSpan, type SpanAttributes } from '../../telemetry/spans';
import { db as defaultDb } from '../../db/client';
import { cardDrafts, cardBridgeLinks } from '../../db/schema';

import { assertProjectInCallerTenant, scopedFilters } from '../../domain/bridge/caller-scope';
import { bridgeRegistry } from '../../domain/bridge/registry';
import {
  computeContentDigest,
  computeStableId,
  lookupBatch,
  outputIdsKey,
} from '../../domain/bridge/dedup';
import { draftService } from '../../domain/bridge/drafts';
import { submitService } from '../../domain/bridge/submit';
import { commitService } from '../../domain/bridge/commit';
import type {
  BridgeCtx,
  Initiator,
  ProducerId,
  ToolOutput,
} from '../../domain/bridge/types';
import { readJsonBody } from '../_lib';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRODUCER_IDS = ['coding', 'kag', 'artifacts'] as const;

function asProducerId(raw: string): ProducerId {
  if (!(PRODUCER_IDS as readonly string[]).includes(raw)) {
    throw new IntegrationError({
      code: 'unknown_producer',
      message: `Unknown bridge producer: ${raw}`,
      service: 'bridge',
    });
  }
  return raw as ProducerId;
}

function mapInitiator(reqInitiator: 'human' | 'agent' | 'cron'): Initiator {
  return reqInitiator === 'human' ? 'user' : reqInitiator;
}

function requireProjectIdFromQuery(req: Request): string {
  const projectId = new URL(req.url).searchParams.get('project_id');
  if (!projectId) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id query parameter is required',
    });
  }
  // NOTE: shape is deliberately NOT checked here. Both callers of this helper
  // (`handleListOutputs`, `handleLookupLink`) hand the value straight to
  // `buildBridgeCtx`, which does check it — a second guard here was measured to
  // be unkillable by any mutant, i.e. dead code rather than defence in depth.
  return projectId;
}

/**
 * One shape check for every bridge route, at the single point they all funnel
 * through. Presence of `project_id` was validated all along; its SHAPE was not,
 * so a non-UUID reached a `uuid` column and `GET /api/tools/bridge/links`
 * answered a bare 500 in production when handed the `stream:`-prefixed
 * pseudo-project id that fr's own `GET /api/projects` emits.
 */
function assertUuidProjectId(projectId: unknown): asserts projectId is string {
  if (!isUuidShape(projectId)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id must be a UUID',
    });
  }
}

async function buildBridgeCtx(
  req: Request,
  projectId: string,
): Promise<BridgeCtx> {
  // AUTHENTICATE FIRST. The shape check below is cheap and tempting to run
  // early, but doing so answers an UNAUTHENTICATED caller with 400 instead of
  // 401 — telling them their parameter was inspected before their identity was.
  const user = await validateAuth(req);
  // Every bridge route funnels through here, body-supplied ids included, so a
  // single check covers create/patch/submit/reject/commit as well as the two
  // query-param routes — rather than five copies that drift apart.
  assertUuidProjectId(projectId);
  const request = await buildRequestContext(req);
  const tenantId = ctxTenantId(user.tenantId);
  // H5: the named project must be the caller's tenant's — every route
  // (create/list/get/patch/submit/reject/commit/links/outputs) funnels here.
  await assertProjectInCallerTenant(defaultDb, projectId, tenantId);
  return {
    request,
    user_id: user.id,
    project_id: projectId,
    tenant_id: tenantId,
  };
}

// ---------------------------------------------------------------------------
// GET /api/tools/bridge/sources
// ---------------------------------------------------------------------------

async function handleListSources(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const request = await buildRequestContext(req);
  return emitSpan(
    'fr.bridge.sources.listed',
    { 'user.id': user.id, correlation_id: request.correlationId },
    () =>
      handle(
        async () =>
          bridgeRegistry.list().map((s) => ({ id: s.id, label: s.id })),
        (data) => jsonResponse({ data }),
      ),
  );
}

// ---------------------------------------------------------------------------
// GET /api/tools/bridge/sources/:producer/outputs
// ---------------------------------------------------------------------------

async function handleListOutputs(
  req: Request,
  producer: string,
): Promise<Response> {
  const projectId = requireProjectIdFromQuery(req);
  const ctx = await buildBridgeCtx(req, projectId);
  const producerId = asProducerId(producer);
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    // The RAW `project_id` is skipped deliberately — `requireProjectIdFromQuery`
    // above is what validates it, and copying the unvalidated string in beside
    // the validated one would give a producer two sources of truth.
    if (key === 'project_id') continue;
    const v = url.searchParams.get(key);
    if (v !== null) params[key] = v;
  }
  // ...but the VALIDATED value must still be handed to the producer. Skipping
  // the raw key and then never re-adding it meant `artifactsOutputSource`
  // (domain/bridge/sources/artifacts.ts), whose first act is to read
  // `params.project_id`, threw on EVERY REST call: omit `project_id` and
  // `requireProjectIdFromQuery` returns 400, supply it and the source returned
  // 502. No input succeeded. `RequestContext` carries no projectId, so `params`
  // is the only channel the source has.
  //
  // `user_id` is overridden for the same reason, and it is a SECURITY fix rather
  // than a plumbing one: `codingOutputSource` feeds `params.user_id` into
  // `getJob(job_id, user_id)`, a scoping filter that happily matches whatever id
  // it is given. Copying it from the query string let a caller read another
  // user's findings. Both keys now come from the authenticated context via the
  // single owner in domain/bridge/caller-scope.ts — the AG-UI path
  // (agui/actions/bridge.ts) had the same hole and now calls the same helper.
  Object.assign(params, scopedFilters(params, ctx));

  // Same defect and the same fix as `handleListDrafts` — this is where the
  // literals were copied FROM. `count` and `dedup_known_count` were hardcoded
  // zeros while the real numbers went only into the response body's `meta`, so
  // the span reported a dedup rate of 0/0 on every call. Opened as `null` so an
  // unresolved listing carries no count at all rather than a measured zero.
  const spanAttrs: SpanAttributes = {
    project_id: projectId,
    producer: producerId,
    correlation_id: ctx.request.correlationId,
    count: null,
    dedup_known_count: null,
  };

  return emitSpan(
    'fr.bridge.outputs.listed',
    spanAttrs,
    () =>
      handle(
        async () => {
          const source = bridgeRegistry.get(producerId);
          const outputs: ToolOutput[] = await source.listOutputs(
            ctx.request,
            params,
          );

          // Batched dedup: ONE round-trip for the whole listing instead of
          // per-output. Compute (stable_id, content_digest) for each output
          // once, hand the items to lookupBatch, then bucket the per-stable_id
          // results back to a per-output_id meta.dedup map for the response.
          const items = outputs.map((o) => {
            const stableId =
              o.stable_id || computeStableId(canonicalStableInput(o));
            const digest = computeContentDigest(o.title, o.body_md);
            return {
              output_id: o.output_id,
              stable_id: stableId,
              content_digest: digest,
            };
          });
          const batch = await lookupBatch(
            defaultDb,
            projectId,
            producerId,
            items.map(({ stable_id, content_digest }) => ({
              stable_id,
              content_digest,
            })),
          );
          const dedup: Record<string, { card_id: string; match: 'stable_id' | 'digest' }> = {};
          let knownCount = 0;
          for (const item of items) {
            const result = batch.get(item.stable_id);
            if (result?.match && result.card_id) {
              dedup[item.output_id] = {
                card_id: result.card_id,
                match: result.match,
              };
              knownCount += 1;
            }
          }

          return { outputs, dedup, count: outputs.length, knownCount };
        },
        ({ outputs, dedup, count, knownCount }) => {
          spanAttrs.count = count;
          spanAttrs.dedup_known_count = knownCount;
          return jsonResponse({
            data: outputs,
            meta: { dedup, count, dedup_known_count: knownCount },
          });
        },
      ),
  );
}

// Mirrors drafts.ts::stableIdInputFor — kept inline so the route can
// recompute when the producer didn't pre-fill `stable_id`. Prefers
// source_ref.tool / source_ref.rule_id (the canonical carriers) and falls
// back to parsing 'coding:<tool>' / 'rule:<id>' labels for legacy outputs.
function canonicalStableInput(out: ToolOutput) {
  switch (out.producer) {
    case 'coding': {
      const labels = out.suggested_labels ?? [];
      const tool =
        out.source_ref?.tool ??
        labels.find((l) => l.startsWith('coding:'))?.slice('coding:'.length) ??
        '';
      const ruleId =
        out.source_ref?.rule_id ??
        labels.find((l) => l.startsWith('rule:'))?.slice('rule:'.length) ??
        '';
      return {
        producer: 'coding' as const,
        tool,
        rule_id: ruleId,
        file_path: out.source_ref?.file_path ?? '',
        line_number: out.source_ref?.line_number ?? 0,
      };
    }
    case 'kag':
      return {
        producer: 'kag' as const,
        session_id: out.run_id,
        url: out.source_ref?.url ?? '',
      };
    case 'artifacts':
      return {
        producer: 'artifacts' as const,
        artifact_id: out.source_ref?.artifact_id ?? '',
        version: out.run_id,
      };
  }
}

// ---------------------------------------------------------------------------
// POST /api/tools/bridge/drafts
// ---------------------------------------------------------------------------

interface DraftCreateBody {
  project_id: string;
  producer: ProducerId;
  output_ids: string[];
  overrides?: Record<string, unknown>;
  idempotency_key?: string;
  /**
   * For producer='coding': the FR coding_analysis_runs id whose findings
   * encoded these output_ids. Required when the per-process LRU has been
   * evicted (or cleared on a redeploy) so codingOutputSource.getOutput can
   * re-list and resolve. Falls back to X-Coding-Job-Id when omitted.
   */
  coding_job_id?: string;
}

/**
 * POST /api/tools/bridge/drafts — race-safe idempotency contract.
 *
 * Two concurrent identical replays (same project_id, producer, idempotency_key,
 * output_ids set) MUST end up returning a single batch of drafts to BOTH
 * callers — never two batches, never partial overlap. The receiver-side guard:
 *
 *   1. We compute `output_ids_key = outputIdsKey(body.output_ids)` (sorted-
 *      stable JSON of the set) so request-key equality is order-independent.
 *   2. We pass `idempotency_key` + `output_ids_key` straight to
 *      `DraftService.create`, which stamps them onto `metadata` on the INITIAL
 *      INSERT — not via a follow-up UPDATE — so the partial unique index
 *      `card_drafts_idem_uk` (project_id, producer, metadata->>'idempotency_key')
 *      from WT-B's migration 020 is the race arbiter.
 *   3. The losing concurrent insert raises Postgres unique_violation (23505).
 *      We catch it, then SELECT the prior rows by
 *      (project_id, producer, metadata->>'idempotency_key' [+ output_ids_key])
 *      and return them as a replay. `output_ids_key` is also asserted in the
 *      SELECT so a key reuse with a different output_ids set surfaces clearly
 *      instead of returning a mismatched batch.
 *   4. A pre-flight SELECT runs first (cheap fast path for the common case
 *      where the first request has fully landed before a retry).
 */
async function handleCreateDrafts(req: Request): Promise<Response> {
  const body = await readJsonBody<DraftCreateBody>(req);
  if (!body.project_id || !body.producer || !Array.isArray(body.output_ids)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id, producer, output_ids[] are required',
    });
  }
  const ctx = await buildBridgeCtx(req, body.project_id);
  const producerId = asProducerId(body.producer);

  // For producer='coding', force the originating job_id into both the
  // explicit RequestContext we pass into draftService AND a fresh ALS frame
  // wrapping the create call, so codingOutputSource.getOutput sees it from
  // either accessor (`getCodingJobId()` or `ctx.coding?.jobId`). Body field
  // wins over the X-Coding-Job-Id header to make agent callers explicit.
  if (producerId === 'coding') {
    const jobId =
      body.coding_job_id ?? ctx.request.coding?.jobId ?? undefined;
    if (jobId) {
      ctx.request = { ...ctx.request, coding: { jobId } };
    }
  }

  return handle(
    async () => {
      const idemKey = body.idempotency_key;
      const oidsKey = idemKey ? outputIdsKey(body.output_ids) : undefined;

      // Pre-flight replay fast path: if a prior batch is already persisted
      // with the same (idempotency_key, output_ids_key), return it without
      // attempting another insert.
      if (idemKey) {
        const replay = await defaultDb
          .select()
          .from(cardDrafts)
          .where(
            and(
              eq(cardDrafts.project_id, ctx.project_id),
              eq(cardDrafts.producer, producerId),
              sql`${cardDrafts.metadata}->>'idempotency_key' = ${idemKey}`,
              sql`${cardDrafts.metadata}->>'output_ids_key' = ${oidsKey ?? ''}`,
            ),
          );
        if (replay.length > 0) {
          return { rows: replay, replayed: true };
        }
      }

      const overrides = body.overrides as
        | Parameters<typeof draftService.create>[2]['overrides']
        | undefined;
      try {
        // Run create() inside an ALS frame derived from ctx.request so the
        // coding source's `getCodingJobId()` sees the body-supplied job id
        // (if any) on cache miss. For non-coding producers this is a noop
        // re-bind of the same frame.
        const created = await withRequestContext(ctx.request, () =>
          draftService.create(defaultDb, ctx, {
            producer: producerId,
            output_ids: body.output_ids,
            overrides,
            initiator: mapInitiator(ctx.request.initiator),
            idempotency_key: idemKey,
            output_ids_key: oidsKey,
          }),
        );
        return { rows: created, replayed: false };
      } catch (err: unknown) {
        // Unique-violation arms-race: a concurrent identical request beat us
        // through the partial unique index. SELECT the winner's rows and
        // return them as a replay.
        //
        // drizzle wraps driver errors in `DrizzleQueryError` whose `cause`
        // carries the underlying PostgresError (with `.code === '23505'`).
        // The SQLSTATE therefore has to be read off the wrapper OR the cause,
        // depending on whether the throw came from drizzle or from a
        // hand-rolled postgres.js call. That walk used to be a closure right
        // here; it now lives in the shared `pgErrorCode` in utils/errors so
        // there is ONE implementation instead of three (this route, the asset
        // internal-create route, and the shared error->HTTP mapping, which
        // originally had none and was the production defect).
        const code = pgErrorCode(err);
        if (idemKey && code === '23505') {
          const winner = await defaultDb
            .select()
            .from(cardDrafts)
            .where(
              and(
                eq(cardDrafts.project_id, ctx.project_id),
                eq(cardDrafts.producer, producerId),
                sql`${cardDrafts.metadata}->>'idempotency_key' = ${idemKey}`,
                sql`${cardDrafts.metadata}->>'output_ids_key' = ${oidsKey ?? ''}`,
              ),
            );
          if (winner.length > 0) {
            return { rows: winner, replayed: true };
          }
        }
        throw err;
      }
    },
    ({ rows, replayed }) =>
      jsonResponse({ data: rows, meta: { replayed } }, replayed ? 200 : 201),
  );
}

// ---------------------------------------------------------------------------
// GET /api/tools/bridge/drafts?project_id=&status=&limit=
// ---------------------------------------------------------------------------

/** Max rows one call may return, whatever `limit` asks for. */
const DRAFTS_LIST_MAX_LIMIT = 200;
/** Rows returned when the caller does not ask for a size. */
const DRAFTS_LIST_DEFAULT_LIMIT = 100;

function parseListLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DRAFTS_LIST_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'limit must be a positive integer',
    });
  }
  return Math.min(n, DRAFTS_LIST_MAX_LIMIT);
}

/**
 * Truncation signal for the drafts listing — HEADERS, not body fields.
 *
 * ⚠️ WHY HEADERS. fr's response-envelope convention sanctions exactly
 * four body shapes for a NEW route (`data`, `items+total`, `items`, `array`).
 * This route is an unpaginated list, so its body is `{ items }`. The two
 * candidates for keeping the signal in the body are both wrong:
 *   * `{ items, meta }` is the shape the ratchet rejected — a fifth one-off,
 *     which is the sprawl that guard exists to stop.
 *   * `{ items, total }` would make `total` a LIE. There is no COUNT query
 *     here; the only number available is `rows.length`, which under a cap is
 *     the PAGE SIZE, not the match count. Reporting a capped page as
 *     `total: 100` is precisely the defect fr#1231 exists to remove from ~10
 *     routes, and shipping it here would contradict that in the same repo.
 * So the signal goes where `src/routes/assets/_lib/page-cap.ts` already puts
 * it for the asset lists, for the same reason and in the same spelling.
 *
 * ⭐ UNLIKE the asset lists, `truncated` here is EXACT. page-cap.ts compares
 * `rows >= limit` and documents the resulting false positive at the boundary;
 * `draftService.list` reads `limit + 1` rows and returns `limit`, so
 * `truncated` is true iff the database really held one more row. A listing of
 * exactly `limit` drafts reports `false`, and `bridge-list-drafts.integration`
 * pins that boundary in both directions.
 *
 * `X-Count-State` carries the `exact | at_least` half of the branch's
 * `exact | at_least | unknown` vocabulary. The third state is not emitted and
 * cannot be: `unknown` is what a CLIENT must conclude when the header is
 * ABSENT (an older backend, a proxy that strips it). Silence read as `exact`
 * is the absence-as-a-result defect; the client derives `unknown` from a
 * missing header, never from a value this route sends.
 *
 * `Access-Control-Expose-Headers` is required or a cross-origin browser read
 * hides all three from JS — on the wire and invisible, which is the same
 * silence this signal exists to remove.
 */
function draftsPageHeaders(
  appliedLimit: number,
  truncated: boolean,
): Record<string, string> {
  return {
    'X-Applied-Limit': String(appliedLimit),
    'X-Truncated': truncated ? 'true' : 'false',
    'X-Count-State': truncated ? 'at_least' : 'exact',
    'Access-Control-Expose-Headers':
      'X-Applied-Limit, X-Truncated, X-Count-State',
  };
}

/**
 * GET /api/tools/bridge/drafts — the listing `/bridge` rehydrates from.
 *
 * ⚠️ WHY THIS EXISTS. There was no list route, so `/bridge` set `drafts = []`
 * on every load and a page refresh silently destroyed in-progress bulk-review
 * work. The page's own "← All drafts" deep link landed in the same dead end.
 *
 * GATING — copied from `handleListOutputs`, the file's other LIST route, and
 * deliberately not from `handleGetDraft`:
 *   * `requireProjectIdFromQuery` + `buildBridgeCtx` (authenticate FIRST, then
 *     check the project_id shape) — identical to every sibling here.
 *   * identity keys come from the authenticated context, never the query
 *     string, exactly as `scopedFilters` (domain/bridge/caller-scope.ts)
 *     enforces for the outputs listing. `draftService.list` therefore filters
 *     on `(ctx.project_id, ctx.user_id)`.
 * `handleGetDraft` scopes by project alone. That is defensible for a point
 * read of an id the caller already holds; reusing it HERE would turn "knows a
 * project uuid" into "can enumerate that project's drafts", because nothing in
 * `buildBridgeCtx` checks project membership. Narrower than the point read,
 * never wider.
 *
 * TRUNCATION IS PART OF THE ANSWER, and it rides in HEADERS. The body is the
 * sanctioned unpaginated-list shape `{ items }`; `X-Truncated` is measured (a
 * +1 probe row in the service, so the boundary is exact) and `X-Count-State`
 * says `exact` or `at_least`, so a caller cannot render a capped page as the
 * whole set. See `draftsPageHeaders` above for why not the body. A failed read
 * throws and becomes an error envelope — it never degrades to `items: []`.
 */
async function handleListDrafts(req: Request): Promise<Response> {
  const projectId = requireProjectIdFromQuery(req);
  const ctx = await buildBridgeCtx(req, projectId);
  const url = new URL(req.url);
  const limit = parseListLimit(url.searchParams.get('limit'));
  // `status=editing,deduped` — an optional narrowing so a project with a long
  // committed history cannot push the editable rows out of the capped page.
  const statuses = (url.searchParams.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // ⭐ MEASURED, NOT HARDCODED — and the two keys start at `null`, not `0`.
  //
  // ⛔ THE DEFECT THIS REPLACES. These attributes were literals — `count: 0,
  // truncated: false` — copied from `handleListOutputs` below, which had the same
  // ones. `emitSpan` reported them verbatim, so `fr.bridge.drafts.listed` carried
  // `count=0, truncated=false` on EVERY call including a page that was genuinely
  // truncated. In Tempo that is not a missing attribute, it is a MEASURED zero:
  // truncation rate read exactly 0% forever, which is the absence-as-a-result
  // defect the `X-Count-State` comment above spends a paragraph refusing to ship
  // on the wire — shipped one layer over, in telemetry, in the same function.
  //
  // ⚠️ `null` rather than `0` as the opening value, for the same reason
  // `X-Count-State` has no `unknown` value it can send: at span-open time nothing
  // has been counted, and `0` would be a claim. `toOtelAttrs` drops null, so a
  // span that dies before the listing resolves carries NO count attribute — which
  // is what a consumer must see in order to conclude "not measured" instead of
  // "measured zero". `emitSpan`'s completion lines re-read this object, so the
  // real values land on the `ok` line and on the OTel span (see the note beside
  // `cleanAttrs` in telemetry/spans.ts — until that fix the mutation below was
  // inoperative, which is how the literals survived review here and at two
  // sibling sites).
  const spanAttrs: SpanAttributes = {
    project_id: projectId,
    correlation_id: ctx.request.correlationId,
    applied_limit: limit,
    count: null,
    truncated: null,
  };

  return emitSpan('fr.bridge.drafts.listed', spanAttrs, () =>
    handle(
      () =>
        draftService.list(defaultDb, ctx, {
          limit,
          ...(statuses.length > 0 ? { statuses } : {}),
        }),
      ({ rows, truncated }) => {
        // Set from the SAME values the response is built from, on the line that
        // builds it — so a span and the `X-Truncated` header a client reads can
        // never disagree about one request.
        spanAttrs.count = rows.length;
        spanAttrs.truncated = truncated;
        return jsonResponse({ items: rows }, 200, draftsPageHeaders(limit, truncated));
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// GET /api/tools/bridge/drafts/:id
// ---------------------------------------------------------------------------

async function handleGetDraft(req: Request, id: string): Promise<Response> {
  const projectId = requireProjectIdFromQuery(req);
  const ctx = await buildBridgeCtx(req, projectId);
  return handle(
    async () => {
      const row = await draftService.get(defaultDb, ctx.project_id, id);
      if (!row) {
        throw new IntegrationError({
          code: 'draft_not_found',
          message: `Draft ${id} not found`,
          service: 'bridge',
        });
      }
      return row;
    },
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// PATCH /api/tools/bridge/drafts/:id
// ---------------------------------------------------------------------------

interface DraftPatchBody {
  project_id: string;
  patch: Record<string, unknown>;
}

async function handlePatchDraft(req: Request, id: string): Promise<Response> {
  const body = await readJsonBody<DraftPatchBody>(req);
  if (!body.project_id || !body.patch) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id and patch are required',
    });
  }
  const ctx = await buildBridgeCtx(req, body.project_id);
  return handle(
    () =>
      draftService.patch(
        defaultDb,
        ctx,
        id,
        body.patch as Parameters<typeof draftService.patch>[3],
      ),
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// POST /api/tools/bridge/drafts/:id/submit
// ---------------------------------------------------------------------------

interface DraftMutationBody {
  project_id: string;
}

async function handleSubmitDraft(req: Request, id: string): Promise<Response> {
  const body = await readJsonBody<DraftMutationBody>(req);
  if (!body.project_id) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id is required',
    });
  }
  const ctx = await buildBridgeCtx(req, body.project_id);
  return handle(
    () => submitService.submit(defaultDb, ctx, id),
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// POST /api/tools/bridge/drafts/:id/reject
// ---------------------------------------------------------------------------

interface DraftRejectBody {
  project_id: string;
  reason?: string;
}

async function handleRejectDraft(req: Request, id: string): Promise<Response> {
  const body = await readJsonBody<DraftRejectBody>(req);
  if (!body.project_id) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id is required',
    });
  }
  const ctx = await buildBridgeCtx(req, body.project_id);
  return handle(
    () => draftService.reject(defaultDb, ctx, id, ctx.user_id, body.reason),
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// POST /api/tools/bridge/drafts/:id/commit
// ---------------------------------------------------------------------------

async function handleCommitDraft(req: Request, id: string): Promise<Response> {
  const body = await readJsonBody<DraftMutationBody>(req);
  if (!body.project_id) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id is required',
    });
  }
  const ctx = await buildBridgeCtx(req, body.project_id);
  return handle(
    () => commitService.commit(defaultDb, ctx, id),
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// GET /api/tools/bridge/links?producer=&stable_id=&project_id=
// ---------------------------------------------------------------------------

async function handleLookupLink(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const producer = url.searchParams.get('producer');
  const stableId = url.searchParams.get('stable_id');
  const projectId = url.searchParams.get('project_id');
  if (!producer || !stableId || !projectId) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'producer, stable_id, project_id query parameters are required',
    });
  }
  await buildBridgeCtx(req, projectId);
  const producerId = asProducerId(producer);

  return handle(
    async () => {
      const rows = await defaultDb
        .select()
        .from(cardBridgeLinks)
        .where(
          and(
            eq(cardBridgeLinks.project_id, projectId),
            eq(cardBridgeLinks.producer, producerId),
            eq(cardBridgeLinks.stable_id, stableId),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? { match: 'stable_id', card_id: row.card_id } : { match: null };
    },
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// Registration — capability-derived (fr-agui P4b part 3)
// ---------------------------------------------------------------------------

// The ten routes are declared in src/capabilities/tools/bridge.ts and registered
// by deriveRouter. Nine mount only when FR_FEATURE_BRIDGE is on (`http.mountedWhen`);
// `POST /api/tools/bridge/drafts/:id/commit` mounts ALWAYS — pending approvals from
// before a flag flip still call back here. The approval-consensus dispatcher
// persists `callback_path = /tools/bridge/drafts/:id/commit` on each in-flight
// approval; if the route is unmounted at rollback time, the completion handler
// 404s and the card is stuck pending forever.
//
// ⚠️ The stored `callback_path` carries NO `/api` prefix — the route path
// does, the persisted value does not. `domain/bridge/submit.ts` is the
// sole writer, and `services/n8n-callback.ts normalizeCallbackPath` only
// strips leading slashes, so it CANNOT reconcile an `/api` prefix; sibling
// callbacks are bare too (e.g. `kanban/approval-callback`). Do not "fix" the
// emitted value to match the mount path — that breaks live callbacks (fr#1227).

// Re-export so the agui/actions/bridge.ts module can call into the same
// service-level functions from the AG-UI handlers.
export {
  handleListSources,
  handleListOutputs,
  handleCreateDrafts,
  handleListDrafts,
  handleGetDraft,
  handlePatchDraft,
  handleSubmitDraft,
  handleRejectDraft,
  handleCommitDraft,
  handleLookupLink,
};
