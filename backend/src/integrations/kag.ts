import {
  getGraphStatsParamsSchema,
  listKagDocumentsParamsSchema,
  listScrapeSessionsParamsSchema,
  queryGraphEdgesParamsSchema,
  queryGraphNodesParamsSchema,
} from './_lib/kag-params';
import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { KAG_ONBEHALF_TOKEN_ENV } from './_lib/service-credential';
import { getUserId } from './_lib/context';
import { attributableUuid } from './_lib/n8n-attribution';
import {
  getAssessTextQualityUrl,
  getCalculateCentralityUrl,
  getComputeAttentionUrl,
  getComputeBatchSimilarityUrl,
  getComputeEntityDensityUrl,
  getComputeMlSimilarityUrl,
  getComputeTextSimilarityUrl,
  getDetectCommunitiesUrl,
  getDetectLanguageUrl,
  getExtractEntitiesUrl,
  getGenerateEmbeddingsUrl,
  getParseTextUrl,
  getSegmentTextUrl,
  getBulkExportGraphUrl,
  getEnrichDocumentUrl,
  getDecomposeDocumentUrl,
  getListDocumentJobsUrl,
  getDeleteDocumentJobUrl,
  getClearDocumentJobsUrl,
  getSubmitKagPipelineUrl,
  getGetKagJobStatusUrl,
  getCancelKagJobUrl,
  getResumeKagJobUrl,
  getDeleteKagJobUrl,
  getExecuteGraphQueryUrl,
  getExecuteOptimizedQueryUrl,
  getFindGraphPathsUrl,
  getFindSimilarNodesUrl,
  getGetBatchStatusUrl,
  getGetDocumentJobStatusUrl,
  getResolveDocumentRunsUrl,
  getGetGraphEdgeUrl,
  getGetGraphNodeUrl,
  getGetGraphNodeTypesUrl,
  getGetGraphStatsUrl,
  getGetScrapeSessionDetailUrl,
  getGetScrapeSessionImagesUrl,
  getGetDocumentJobImagesUrl,
  getDownloadScrapeScreenshotUrl,
  getDownloadScrapeImageUrl,
  getDownloadDocumentImageUrl,
  getHierarchicalRetrievalUrl,
  getListMlModelsUrl,
  getListScrapeSessionsUrl,
  getListSupportedFormatsUrl,
  getDeleteScrapeSessionUrl,
  getPauseScrapeSessionUrl,
  getQueryGraphEdgesUrl,
  getQueryGraphNodesUrl,
  getResumeScrapeSessionUrl,
  getRetryFailedBatchJobsUrl,
  getScrapeSitemapUrl,
  getScrapeUrlUrl,
  getSemanticSearchUrl,
  getUploadDocumentSyncUrl,
  getUploadDocumentUrl,
  type AnswerChunk,
  type AttentionRequest,
  type AttentionResponse,
  type BatchSimilarityRequest,
  type BatchSimilarityResponse,
  type BodyUploadDocument,
  type BulkExportRequest,
  type BulkExportResponse,
  type EnrichRequest,
  type EnrichResponse,
  type DecomposeRequest,
  type DecomposeResponse,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type EntityDensityRequest,
  type EntityDensityResponse,
  type EntityExtractionRequest,
  type EntityExtractionResponse,
  type LanguageDetectRequest,
  type LanguageDetectResponse,
  type MLSimilarityRequest,
  type MLSimilarityResponse,
  type OptimizedQueryRequest,
  type OptimizedQueryResponse,
  type ParseRequest,
  type ParseResponse,
  type SegmentRequest,
  type SegmentResponse,
  type SimilarityRequest,
  type SimilarityResponse,
  type TextQualityRequest,
  type TextQualityResponse,
  type BodyUploadDocumentSync,
  type CentralityRequest,
  type CentralityResponse,
  type CommunityRequest,
  type CommunityResponse,
  type DocumentJobStatusResponse,
  type ResolveDocumentRunsRequest,
  type ResolveDocumentRunsResponse,
  type GetGraphStatsParams,
  type GraphQueryRequest,
  type GraphQueryResponse,
  type PathRequest,
  type PathResponse,
  type HierarchicalRetrievalRequest,
  type HierarchicalRetrievalResponse,
  type KAGIngestRequest,
  type KAGIngestResponse,
  type ImageCollectionResponse,
  type ListScrapeSessionsParams,
  type QueryGraphEdgesParams,
  type QueryGraphNodesParams,
  type ScrapeSitemapRequest,
  type ScrapeURLRequest,
  type SemanticSearchRequest,
  type SemanticSearchResponse,
  type SimilarNodesRequest,
  type SimilarNodesResponse,
} from '@fr/service-client-kag';
export type {
  BodyUploadDocument,
  BodyUploadDocumentSync,
  GetGraphStatsParams,
  ListScrapeSessionsParams,
  QueryGraphEdgesParams,
  QueryGraphNodesParams,
  ScrapeSitemapRequest,
  ScrapeURLRequest,
};


// `/api/documents` is the upstream flat-list endpoint added by KAG to unblock
// fr's `applyEffectiveFilter` wiring (Foundation Plan 2 task 8). The orval-
// generated client doesn't carry this route yet; types + URL builder are
// hand-rolled here and will be replaced when the kag service-client is
// regenerated. Keep the param shape in sync with kag's
// `src/routers/documents.py` (limit + offset + project_id).
interface ListKagDocumentsParams {
  limit?: number;
  offset?: number;
  project_id?: string;
}

export interface KagDocumentItem {
  id: string;
  title?: string | null;
  project_id?: string | null;
  created_at?: string | null;
}

interface ListKagDocumentsResponse {
  items: KagDocumentItem[];
  total?: number | null;
  next_cursor?: string | null;
}


export function parseQueryGraphNodesParams(
  sp: URLSearchParams,
): QueryGraphNodesParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return queryGraphNodesParamsSchema.parse(raw) as QueryGraphNodesParams;
}

export function parseQueryGraphEdgesParams(
  sp: URLSearchParams,
): QueryGraphEdgesParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return queryGraphEdgesParamsSchema.parse(raw) as QueryGraphEdgesParams;
}

export function parseGetGraphStatsParams(
  sp: URLSearchParams,
): GetGraphStatsParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return getGraphStatsParamsSchema.parse(raw) as GetGraphStatsParams;
}

export function parseListScrapeSessionsParams(
  sp: URLSearchParams,
): ListScrapeSessionsParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return listScrapeSessionsParamsSchema.parse(raw) as ListScrapeSessionsParams;
}

export function parseListKagDocumentsParams(
  sp: URLSearchParams,
): ListKagDocumentsParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return listKagDocumentsParamsSchema.parse(raw) as ListKagDocumentsParams;
}

function buildListKagDocumentsUrl(params?: ListKagDocumentsParams): string {
  if (!params) return '/api/documents';
  const sp = new URLSearchParams();
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  if (params.offset !== undefined) sp.set('offset', String(params.offset));
  if (params.project_id !== undefined) sp.set('project_id', params.project_id);
  const qs = sp.toString();
  return qs ? `/api/documents?${qs}` : '/api/documents';
}

// KAG unified API gateway. Predominantly a read surface (query/search/retrieval
// + graph reads + stateless compute). Most writes (ingestion, bulk upload/import,
// embeddings jobs) and admin verbs (cancel/retry jobs, pause/resume sessions)
// stay intentionally off this adapter. EXCEPTION — PR-F (George sign-off
// 2026-07-11) deliberately exposes a curated set of write passthroughs: the
// KARMA-enrich / HiRAG-decompose pipeline demos (`enrichDocument`/
// `decomposeDocument`) and the document-job queue (`listDocumentJobs` read +
// `deleteDocumentJob`/`clearDocumentJobs` admin-gated writes). These crossings
// are carved out route-by-route. Raw cypher,
// graph mutation, bulk graph import, upload/scrape and pipeline job-control
// remain OFF the adapter.
const CRUD_TIMEOUT_MS = 30_000;
// Graph analytics (community/centrality/path) run Louvain/PageRank/shortest-path
// over the whole tenant graph — legitimately slower than a CRUD read. Give them a
// dedicated, larger budget so a large graph doesn't UPSTREAM_TIMEOUT at 30s and
// surface as "… failed" on the Explore-graph buttons. These POSTs are read-style
// (no mutation) but non-idempotent, so the client won't retry them.
const ANALYTICS_TIMEOUT_MS = 90_000;
// `/query/ask` is slower than BOTH of the above and it is not close. It is the
// only fr->kag route that runs an LLM SYNTHESIS: retrieve, rerank, then generate
// a grounded answer on the shared local model. At the 30s CRUD default it
// returned UPSTREAM_TIMEOUT 100% of the time and the Ask panel showed a red
// "kag request timed out after 30000ms" — the flagship feature, dead in
// production, for every user.
//
// MEASURED 2026-08-24, calling the deployed kag directly from inside this pod
// with fr's own on-behalf credential (i.e. the real auth path, not a bypass):
//   HTTP 200 in 75.2s, and HTTP 200 in 86.1s on a repeat — with a real cited
//   answer both times. kag was never the problem; fr gave up at 30s.
//
// Why it got slow: pgx-local was swapped to a DENSE 27B model and decode fell to
// ~10.9 tok/s (measured off vllm's own request_time_per_output_token histogram).
// Synthesis that used to fit inside 30s no longer does. The SAME arithmetic
// broke karma's 720s per-chunk guard on the same day.
//
// 120s, not 90s: the two live measurements were 75s and 86s, so the analytics
// budget would leave ~4s of margin on the slower one. Sized against measurement
// with real headroom rather than reused because it was nearby.
//
// ⚠️ CEILING ABOVE THIS ONE, and it is NOT ours: Cloudflare's proxy read timeout
// (100s on this plan) sits between the browser and istio. Raising fr's budget
// removes fr as the limiter and is a strict improvement, but an Ask that
// genuinely runs past ~100s will still surface as a 5xx at the edge. If that
// starts happening the fix is upstream latency, not another bump here.
const ASK_TIMEOUT_MS = 120_000;
// `/query/chunks` is `/query/ask`'s retrieval half with NO synthesis, so it
// inherits neither budget: 120s covers an LLM generate this route never runs,
// and the 30s CRUD default is definitionally too small.
//
// ⚠️ WHY 30s IS TOO SMALL AS A MATTER OF ARITHMETIC, NOT OF MEASUREMENT. The
// first thing `ask_pipeline.search_chunks` does is `_embed(...)`, and kag's own
// outbound embed call passes `timeout=30.0`. An fr budget OF 30s therefore
// expires at the same instant kag's single embed hop does — before kag has
// given up and reported WHICH hop was slow. fr would convert an upstream
// latency problem into a client timeout that erases its own diagnosis. Any
// budget here must exceed kag's inner 30s with room for the retrieval stages
// (dense + lexical + RRF + near-dup collapse) that follow it.
//
// ⛔ 60s IS A REASONED BOUND, NOT AN OBSERVED p99. No chunk-search latency has
// been measured — the route is new and has served no production traffic — so
// this number is derived, not sampled: kag's 30s embed ceiling, doubled to
// leave the retrieval stages a budget of their own. It is deliberately BELOW
// the ~100s Cloudflare proxy read timeout documented on ASK_TIMEOUT_MS, so fr
// still fails before the edge does and the error is ours to read.
//
// WHAT WOULD REFINE IT: once the search box has real traffic, take the p99 of
// this route's server-side latency (the same way ASK_TIMEOUT_MS was resized
// against two live 75s/86s measurements) and set this to that plus headroom.
// If the p99 lands near 5s, this is 12x too generous and a user waits a minute
// on a hop that was never going to answer; if it lands past 60s, this is the
// thing timing out. Either way the fix is to measure, not to nudge.
const CHUNK_SEARCH_TIMEOUT_MS = 60_000;

/**
 * Does this kag path reach the LICENSE-INTROSPECTING modality-gateway?
 *
 * DERIVED FROM KAG'S OWN ROUTING RULE, not from route names. kag decides this
 * by DESTINATION, in `services/proxy.py::_is_license_introspecting_gateway`:
 * the gateway is whichever downstream URL equals `settings.ML_BACKEND_URL`.
 * Walking back from there, exactly two kag surfaces send a request to that URL:
 *
 *   1. `routers/ml.py` — EVERY route on it. Each handler resolves its
 *      destination with `backend_selector.get_backend_url(backend)`, and
 *      `services/backend_selector.py::_backend_url` returns
 *      `settings.ML_BACKEND_URL` UNCONDITIONALLY — the `pytorch` / `mlx`
 *      argument does not change the URL, it only rides along as a hint header.
 *      So the gateway predicate is true for the whole router, not for some
 *      "ML-ish" subset of it. Today that is `/ml/embeddings`, `/ml/attention`,
 *      `/ml/similarity` and `/ml/models` — hence the PREFIX match below, which
 *      is what keeps the next route added to that router covered.
 *   2. `POST /query/ask` — `services/ask_pipeline.py` hops to
 *      `_ml_backend_base()` (= `ML_BACKEND_URL`) to embed the query, and to
 *      `_rerank_base()` (= `RERANK_BACKEND_URL` falling back to the same) to
 *      rerank.
 *   3. `POST /query/chunks` — for the SAME reason as (2), and it is on this
 *      list because the rule above was applied, not because the path starts
 *      with `/query`. `ask_pipeline.search_chunks` is `/query/ask`'s retrieval
 *      half with no synthesis, and its FIRST call is `_embed(req.query, …)` —
 *      the identical `_ml_backend_base()` hop. Its own docstring says so: "The
 *      embed hop is the FIRST spend on this path… An unvouchable tenant is
 *      refused by the very first call below." Dropping the LLM does NOT drop
 *      the gateway; only dropping the EMBED would. (It has no rerank hop, by
 *      design — irrelevant here, since one gateway hop is enough.)
 *
 * Nothing else does. `routers/query.py`'s OTHER routes (`/query/semantic`,
 * `/query/similar-nodes`,
 * `/query/hierarchical`, `/query/graph`, …), `routers/orchestration.py`
 * (`/kag/ingest`) and `routers/processing.py` (`/process/nlp/*`) all call
 * `backend_selector.select_backend()` too — but only to forward an
 * `X-ML-Backend` HINT header. Their `service_url` is `KAG_GRAPH_SERVICE_URL` /
 * `HIRAG_SERVICE_URL` / `KAG_ORCHESTRATOR_URL` / `NLP_SERVICE_URL`, none of
 * which is the gateway, so they accept a bare `X-Tenant-Id` and must keep
 * receiving the end-user JWT unchanged. Calling `select_backend` is therefore
 * NOT the signal — the destination is.
 *
 * ⚠️ HISTORICAL CORRECTION. The comment that used to sit on `askKag` asserted
 * that `/query/ask` was "the one kag route that reaches the METERED gateway".
 * That was false when written and is why `GET /api/assets/kag/ml/models`
 * answered 403 `TENANT_VOUCH_REQUIRED` in the UI: `listMlModels` reaches the
 * same gateway with a bare, `unvouched-header` tenant and kag refuses to
 * delegate it (`services/proxy.py` — the refusal has been there since kag
 * `04d7885`, 2026-08-02). If you add a kag surface, decide membership here by
 * reading `_is_license_introspecting_gateway` and its callers, not by the name.
 */
function reachesLicenseIntrospectingGateway(path: string): boolean {
  const p = (path.split('?')[0] ?? path).replace(/\/+$/, '') || '/';
  return (
    p === '/ml' ||
    p.startsWith('/ml/') ||
    p === '/query/ask' ||
    // Retrieval-only twin of /query/ask: no LLM, but the SAME embed hop to
    // ML_BACKEND_URL, so kag classifies it a gateway destination identically.
    p === '/query/chunks'
  );
}

// -------- Cost attribution (app + actor) --------
//
// Owner ruling (cost attribution): every cost event carries an app_id and an
// actor_id. kag reads them from `X-App-Id` (the licences-registry key — fr's is
// `fr`) and `X-Actor-Id` (a Keycloak `sub` UUID). The project rides as
// `X-Project-Id`, which `http-client.ts buildHeaders` already adds once a
// route has run the project guard; absent ⇒ kag applies its tenant fallback.

/** fr's key in the licences registry, sent as `X-App-Id` on every kag call. */
const KAG_APP_ID = 'fr';

/** fr's OWN service-account `sub`, the actor for calls no human made. */
const SERVICE_ACTOR_ID_ENV = 'SERVICE_ACTOR_ID';

/**
 * The actor for a kag call, or `undefined` (header omitted).
 *
 * A request frame with a user ⇒ that user's Keycloak `sub` (the request
 * context's `userId` is `claims.sub`, see `middleware/request-context.ts`).
 * No user (cron, background loop, boot) ⇒ `SERVICE_ACTOR_ID`. Either way the
 * value must be a real UUID — never a placeholder/nil sentinel, never a
 * non-UUID. A user whose id is not a UUID sends NOTHING rather than borrowing
 * the service actor: a human acted, and attributing it to fr's service
 * account would be a false record.
 */
function resolveKagActorId(): string | undefined {
  const userId = getUserId();
  if (userId !== undefined && userId.trim() !== '') return attributableUuid(userId.trim());
  return attributableUuid(process.env[SERVICE_ACTOR_ID_ENV]?.trim());
}

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'kag',
      baseUrl: config.services.kag.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // Cost attribution — see `resolveKagActorId` above.
      defaultHeaders: { 'x-app-id': KAG_APP_ID },
      dynamicHeaders: () => ({ 'x-actor-id': resolveKagActorId() }),
      // WS-4 on-behalf-of vouch, attached in the SHARED request path rather
      // than at one call site.
      //
      // kag will not DELEGATE a tenant to the metered modality-gateway — i.e.
      // name it in `X-Effective-Tenant-Id`, which selects that tenant's BYO
      // provider and bills it — unless it can vouch for where the tenant came
      // from. A bare `X-Tenant-Id` is settable by any pod that can reach kag,
      // so kag classifies it `unvouched-header` and refuses with
      // 403 TENANT_VOUCH_REQUIRED. We earn the delegation by presenting fr's
      // OWN licence, which kag introspects and matches against
      // `KAG_ONBEHALF_SUBJECTS`.
      //
      // WHY PATH-SCOPED AND NOT CLIENT-WIDE: kag's generic proxy forwards the
      // inbound `Authorization` on to its 11 downstreams
      // (`services/proxy.py`), so a client-wide `serviceTokenEnvVar` would
      // change what every other kag route hands downstream.
      //
      // WHY HERE AND NOT ON THE CALL SITES: the previous shape set the header
      // by hand inside `askKag` alone, which made coverage a per-function
      // decision — and the 403 on `/ml/models` is what that costs. Wired into
      // the client, every kag call (`json`, `fetch` and `proxy` alike, the
      // 64 existing ones and the next one) is measured against ONE predicate.
      //
      // Absent token ⇒ no header ⇒ byte-identical to the previous behaviour.
      //
      // R43/WS-2 — the SECOND lane. The nine DESTRUCTIVE routes were sending a
      // bare `X-Tenant-Id`, kag's forgeable `unvouched-header` rung, behind an
      // observe-only gate that will eventually 403 them. The same licence
      // upgrades their provenance to `vouched-onbehalf`.
      //
      // ⛔ AND IT IS GATED ON A TENANT BEING PRESENT — read this before
      // "simplifying" the condition. kag's trust ladder has a rung for
      // "Authorization present, X-Tenant-Id ABSENT" that adopts the LICENCE'S
      // OWN tenant. fr's token introspects to fr's tenant, not the customer's.
      // `http-client.ts` only sets `x-tenant-id` when the caller supplied one
      // or an async request frame resolves one, so a background/worker
      // invocation has NEITHER — and attaching the credential there would
      // retarget the call at fr's tenant. Every kag DELETE is tenant-scoped AND
      // idempotent, so a wrong-tenant purge deletes 0 rows and still returns
      // 200: a SILENT no-op that orphans the data it claimed to remove. See
      // the `deleteDocument` docstring, which carries this hazard at the call
      // site, and `ServiceTokenRequest.hasTenantHeader`.
      //
      // With no tenant we therefore send NOTHING and the request stays
      // byte-identical to its pre-R43 form: unvouched, but correct. This
      // closes every request-scoped destructive call — which is all of the
      // real ones.
      //
      // ⛔ THE INVARIANT THAT MAKES THAT SAFE, STATED EXACTLY (this paragraph
      // used to claim the design "cannot introduce a wrong-tenant purge"; that
      // was FALSE as written and is the defect it was meant to prevent):
      //
      //   fr attaches the credential only when a TRIMMED-NON-EMPTY
      //   `X-Tenant-Id` will go on that same request, and fr writes the header
      //   only when the tenant is TRIMMED-NON-EMPTY. Both sides, same rule.
      //
      // It has to be BOTH because kag's own test is trimmed — `auth/tenant.py`
      // does `if not (raw_tenant_header or "").strip():` — so a blank or
      // whitespace-only tenant is ABSENT to kag while being PRESENT to a naive
      // truthiness check. Diverge by one side and you get precisely the
      // wrong-tenant purge: a `'   '` ambient tenant passed a `Boolean()` gate,
      // the credential was attached, `Headers` normalised the value to `""`,
      // kag read the header as absent, took the licence rescue, and ran a
      // DELETE under FR'S OWN tenant. Measured, on `deleteKagJob`, before the
      // 2026-09-02 fix. See `buildHeaders` in `_lib/http-client.ts`, where both
      // sides now read one `effectiveTenantId`.
      //
      // The gateway lane above is deliberately NOT tenant-gated: it works
      // without a tenant today and narrowing it would be an unrelated
      // behaviour change.
      //
      // ⚠️ WIDENED 2026-09-21, AND THE REASON IS A CHANGE IN KAG, NOT A CHANGE
      // OF MIND HERE. gitops #3944 (merged 2026-09-16, `8f1b1c89d`) set
      // `ALLOW_UNVOUCHED_TENANT_HEADER: "false"` on the kag deployment, so kag
      // now refuses a bare `X-Tenant-Id` GLOBALLY, in middleware
      // (`src/auth/tenant.py` -> "A bare X-Tenant-Id is not accepted; present a
      // license token"). The old two-arm predicate sent the credential on the
      // gateway paths and the destructive ones and NOWHERE ELSE, so every other
      // tenant-carrying fr->kag call started 401ing — surfaced as an
      // `UPSTREAM_UNAUTHORIZED` 502 in the browser on
      // `GET /api/assets/kag-documents`.
      //
      // ⛔ IT WAS NEVER ONE ROUTE. Probed from the fr pod against
      // `$KAG_INGESTION_URL`, tenant-header-only: `/api/documents` 401,
      // `/ingest/documents/jobs` 401, `/ingest/scrape/provenance` 401,
      // `/discover` 401; all of them 200 (or a DIFFERENT, pre-existing error)
      // once the licence is presented. The log showed only `/api/documents`
      // because that is the only one a human drove that day. Frequency is
      // traffic, not coverage.
      //
      // The new rule is exactly kag's new requirement: WHENEVER WE NAME A
      // TENANT, WE VOUCH FOR IT. `hasTenantHeader` is kept as the condition
      // precisely because it is the invariant stated above — the credential
      // still goes only where a trimmed-non-empty `X-Tenant-Id` goes, so the
      // wrong-tenant-purge hazard is untouched. `reachesLicenseIntrospectingGateway`
      // stays a SEPARATE arm because it must fire with or without a tenant.
      // Destructive routes are covered by the `hasTenantHeader` arm: a
      // tenant-less DELETE carries no credential.
      serviceTokenForPath: {
        envVar: KAG_ONBEHALF_TOKEN_ENV,
        matches: ({ path, hasTenantHeader }) =>
          reachesLicenseIntrospectingGateway(path) || hasTenantHeader,
      },
      // Never the end user's Keycloak JWT — audited 2026-08-29 against kag
      // origin/main, and unblocked when #880 landed 2026-08-30.
      //
      // The worry was `src/services/proxy.py:697-701`, which forwards the inbound
      // `Authorization` verbatim to kag's downstream fleet. Measured: 11 of 12
      // downstreams IGNORE it — they authenticate on `X-Tenant-Id: Bearer
      // <licence>` — and `proxy.py:715` `_apply_onbehalf_vouch` actively
      // OVERRIDES the end-user header with kag's own service token on SIX of
      // them (graph-adapter, kag-graph, hirag, ingestion, karma,
      // kag-orchestrator), for this lane's own reason: a Keycloak JWT
      // introspects `active=false`.
      //
      // ⚠️ CORRECTED 2026-09-21 — this said FIVE and omitted `kag-orchestrator`,
      // which R34 added on 2026-08-29 (`src/services/proxy.py`, the `phi_urls`
      // tuple in `_apply_onbehalf_vouch`). The count was stale by one for three
      // weeks. Re-read that tuple before relying on this paragraph again: a
      // stale safety measurement is how the 2026-09-16 breakage above got
      // armed in the first place.
      //
      // The twelfth, evidence_review_service, genuinely REQUIRES a Keycloak
      // bearer (`src/api/dependencies.py:246`) — and is not on this client's
      // path. fr reaches `/reviews` from `routes/assets/kag-reviews.ts`, a raw
      // `fetch` with its own FORWARDED_REQUEST_HEADERS allowlist
      // (`authorization`, `x-research-context`). That route never touches this
      // client, which is also why it is absent from the client census.
      //
      // This does NOT weaken the WS-4 vouch above: `serviceTokenForPath` is
      // resolved FIRST in `buildHeaders` and sets `authorization` before the
      // `sendAuthorization` branch is reached, so gateway paths still present
      // fr's licence. Only the non-gateway calls change, and they change from
      // "a header nothing reads" to no header.
      sendAuthorization: false,
    });
  }
  return cachedClient;
}

// -------- Query / retrieval --------

export async function semanticSearch(
  body: SemanticSearchRequest,
): Promise<SemanticSearchResponse> {
  return await http().json<SemanticSearchResponse>(getSemanticSearchUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Passage retrieval — the second half of "search".
 *
 * `semanticSearch` above returns GRAPH ENTITY NODES: a query phrase only
 * matches if it was promoted to an entity during ingestion. A concept that
 * lives in the prose but never became a node answers with an EMPTY search,
 * while `/query/ask` answers the same phrase fine because it retrieves over
 * chunks. `/query/chunks` is that retrieval leg on its own — the ranked
 * passages with NO LLM synthesis on top.
 *
 * Response is `{ query, results: AnswerChunk[], diagnostics }`; `results`
 * carries the SAME `AnswerChunk` shape `/query/ask` puts in `chunks`, which is
 * why the frontend can hand them straight to the existing chunk card.
 *
 * ⚠️ IT IS ON `reachesLicenseIntrospectingGateway` — item 3 in that predicate's
 * list, and the FIRST thing to check if this route ever answers 403
 * `TENANT_VOUCH_REQUIRED`. An earlier draft of this comment claimed the
 * opposite ("does not hop to the metered modality-gateway the way /query/ask
 * does"). That was FALSE and would have shipped exactly the failure the
 * predicate's own HISTORICAL CORRECTION block records for `/ml/models`:
 * `search_chunks`'s first act is `_embed(req.query, …)` → `_ml_backend_base()`
 * → `settings.ML_BACKEND_URL`, which IS the gateway by kag's definition, and
 * kag refuses to delegate an `unvouched-header` tenant there. Membership is
 * decided by DESTINATION, never by "it has no LLM in it".
 *
 * Hand-rolled URL because the orval client does not expose this route yet
 * (same reason as `askKag`).
 */
export interface KagChunkSearchRequest {
  query: string;
  /**
   * ⛔ CAPS AT 20 UPSTREAM — the same ceiling as `/query/ask`, and a containment
   * control rather than tidiness: every chunk is verbatim corpus text from a
   * HIPAA-targeted store. `ChunkSearchRequest.top_k` is `ge=1, le=20`, so a
   * larger value is a 422, not a bigger page. Callers must clamp.
   */
  top_k?: number;
  /** Pre-fusion pool size per arm (upstream `ge=10, le=200`, default 50). */
  candidate_pool?: number;
  /** Run the lexical arm and RRF-fuse it with dense. False = pure dense. */
  lexical?: boolean;
  doc_id?: string;
  /** ⚠️ An EMPTY array scopes to ZERO documents; omit the field for no scoping. */
  doc_ids?: string[];
}

/**
 * ⛔ NOT `RetrievalDiagnostics`. `/query/chunks` returns kag's
 * `ChunkSearchDiagnostics`, a DIFFERENT model: it has no `mode`, `abstained`,
 * `abstain_reason`, `rerank_degraded` or `graph_*` (there is no synthesis and
 * no rerank hop to report on), and it adds two fields that model lacks.
 *
 * ⚠️ `score_kind` NAMES THE UNIT of every `AnswerChunk.score` AND of
 * `top_score`, and upstream makes it REQUIRED so no path can emit a number
 * without saying what it is. The two values are DIFFERENT SCALES and are NOT
 * comparable in either direction:
 *   • `'cosine'` — the retriever's own similarity, ~0..1, meaningful in
 *     absolute terms and comparable across queries. Emitted when only ONE list
 *     was retrieved (lexical off, or it matched nothing), so nothing was fused.
 *   • `'rrf'`    — Reciprocal Rank Fusion, `sum(w / (60 + rank))`. A pure
 *     function of RANK: the top hit is ~0.0164 for EVERY query regardless of
 *     how good it is. Rendering it as a confidence is fabrication.
 * Any UI that shows one of these numbers MUST branch on this field first.
 */
interface KagChunkSearchDiagnostics {
  tenant_id?: string;
  subject_id?: string;
  score_kind?: 'cosine' | 'rrf';
  dense_count?: number;
  lexical_count?: number;
  fused_count?: number;
  near_dup_collapsed?: number;
  returned_count?: number;
  top_score?: number | null;
  /**
   * Raw top cosine of the DENSE arm, captured pre-fusion and emitted ALWAYS —
   * independent of `score_kind`, of whether the lexical arm ran, and of whether
   * `rrf_fuse` rewrote every `score` on the way out.
   *
   * This is the ONLY number on this envelope that means the same thing on every
   * request. `top_score` CHANGES UNIT between requests (a similarity when
   * `score_kind === 'cosine'`, a rank statistic — 1/61 == 0.016393 for a rank-0
   * hit — when it is `'rrf'`), so a caller comparing `top_score` across two
   * queries cannot tell a better match from a different fusion state.
   * `null` means the dense arm returned nothing.
   *
   * ⛔ IT CARRIES NO INTERPRETATION, AND THAT IS A MEASURED DECISION UPSTREAM,
   * NOT AN OMISSION TO FIX HERE. kag designed a relevance floor and then REFUSED
   * it on live corpus data: a real, relevant query scored 0.5979 while gibberish
   * scored 0.6053 — the populations OVERLAP, so no cut-off separates them and
   * any threshold would reject real results while admitting nonsense. Do not add
   * a floor, a "weak match" flag, or a percentage on top of this field.
   */
  dense_top_score?: number | null;
}

interface KagChunkSearchResponse {
  query?: string;
  results?: AnswerChunk[];
  diagnostics?: KagChunkSearchDiagnostics | null;
}

export async function chunkSearch(
  body: KagChunkSearchRequest,
): Promise<KagChunkSearchResponse> {
  return await http().json<KagChunkSearchResponse>('/query/chunks', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: CHUNK_SEARCH_TIMEOUT_MS,
  });
}

export async function findSimilarNodes(
  body: SimilarNodesRequest,
): Promise<SimilarNodesResponse> {
  return await http().json<SimilarNodesResponse>(getFindSimilarNodesUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function hierarchicalRetrieval(
  body: HierarchicalRetrievalRequest,
): Promise<HierarchicalRetrievalResponse> {
  return await http().json<HierarchicalRetrievalResponse>(
    getHierarchicalRetrievalUrl(),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

// executeGraphQuery is a read-style POST (graph-query-language payload, no
// mutation). Cypher write-back lives behind a separate url (getExecuteCypherQueryUrl)
// which we deliberately omit from the read adapter.
export async function executeGraphQuery(
  body: GraphQueryRequest,
): Promise<GraphQueryResponse> {
  return await http().json<GraphQueryResponse>(getExecuteGraphQueryUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// executeOptimizedQuery is the cost-based optimizer twin of executeGraphQuery: an
// ALIAS of /query/graph for the SAME structured query types (raw cypher/dsl are
// rejected upstream with 422), with an optional `use_cache`. It is read-only — no
// mutation — so it belongs on the read adapter exactly like executeGraphQuery.
// (It was historically on the kag-boundary `stillForbidden` list out of caution;
// P2-4 exposes it deliberately as the read alias it actually is.)
export async function executeOptimizedQuery(
  body: OptimizedQueryRequest,
): Promise<OptimizedQueryResponse> {
  return await http().json<OptimizedQueryResponse>(getExecuteOptimizedQueryUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// RAG Q&A — end-to-end "ask the knowledge graph" surface upstream.
// Body: `{ query, mode?, doc_id?, top_k? }` (mode defaults to "hybrid_rerank"
// upstream; `doc_id` scopes the answer to a single ingested document — e.g. a
// paper just pushed from the research workspace; `top_k` caps the chunks shown
// to the LLM). Response shape varies but typically includes `answer`, `chunks`,
// `citations`. Hand-rolled URL because the orval client doesn't expose this yet.
export interface KagAskRequest {
  query: string;
  mode?: 'dense' | 'hybrid' | 'hybrid_rerank' | 'full';
  doc_id?: string;
  top_k?: number;
}

export async function askKag(body: KagAskRequest): Promise<unknown> {
  // `/query/ask` reaches the metered modality-gateway (kag embeds the query,
  // then reranks), so it carries the WS-4 on-behalf-of vouch. That is no longer
  // arranged here: `reachesLicenseIntrospectingGateway` above matches this
  // path and `http()` attaches the credential for it — the SAME way it does for
  // `/ml/*`, which reaches the same gateway and used to 403 because this
  // function was the only place the vouch existed. Nothing about this call is
  // special any more; only its destination is.
  return await http().json<unknown>('/query/ask', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ASK_TIMEOUT_MS,
  });
}

// Delete a document from KAG. The upstream surface deletes the `Document`
// graph node + cascades through graph-adapter (chunks, embeddings, edges).
// Hand-rolled URL — graph-adapter exposes DELETE /graph/nodes/{id}.
export async function deleteKagDocument(nodeId: string): Promise<void> {
  await http().json<unknown>(`/graph/nodes/${encodeURIComponent(nodeId)}`, {
    method: 'DELETE',
  });
}

export async function batchSimilarity(
  body: BatchSimilarityRequest,
): Promise<BatchSimilarityResponse> {
  return await http().json<BatchSimilarityResponse>(
    getComputeBatchSimilarityUrl(),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

// -------- Curated on-demand compute (NLP + ML) --------
//
// Stateless, idempotent transforms exposed as read-style POSTs. Verified at the
// upstream source (2026-07-08): the kag gateway is a pure httpx passthrough and
// every `/process/nlp/*` + `/ml/*` handler computes-and-returns with NO DB /
// graph / queue write in its call chain (nlp_service's only side effect is a
// transparent, failure-tolerant Redis memo-cache — a memoized pure function,
// not observable state; the ml-backend even fabricates safe fallbacks when down,
// proving nothing persists). This is retrieval-shaped analysis, not ingestion.
// The write-side pipeline ops (`enrichDocument`/`decomposeDocument`, which mutate
// Postgres + Neo4j) are now DELIBERATELY exposed as PR-F write passthroughs — see
// the "Write passthroughs (PR-F)" section below and the boundary-test carve-out.

export async function extractEntities(
  body: EntityExtractionRequest,
): Promise<EntityExtractionResponse> {
  return await http().json<EntityExtractionResponse>(getExtractEntitiesUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function bulkExportGraph(
  body: BulkExportRequest,
): Promise<BulkExportResponse> {
  // Whole-graph read (optionally label/type/limit-filtered): heavy but idempotent,
  // so it shares the analytics 90s budget rather than the 30s CRUD default.
  return await http().json<BulkExportResponse>(getBulkExportGraphUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ANALYTICS_TIMEOUT_MS,
  });
}

// -------- Write passthroughs (PR-F; George sign-off 2026-07-11) --------
//
// A deliberate, curated crossing of the historically read-only kag boundary.
// Each op below is registered under an HONEST, fragment-bearing BFF path and
// exempted route-by-route in the boundary invariant test — a euphemistic path
// would let a future genuine leak hide from the fragment scan. enrich/decompose
// run the KARMA (35-agent) / HiRAG pipelines and mutate Postgres + Neo4j; the
// document-job ops read + admin-control the ingestion queue. Raw cypher, graph
// mutation, bulk graph import, upload/scrape and pipeline job-submission stay OFF.

// KARMA document enrichment (35-agent LLM pipeline → entities + triples). Slow +
// non-idempotent, so it shares the analytics 90s budget; POST is not retried.
export async function enrichDocument(
  body: EnrichRequest,
): Promise<EnrichResponse> {
  return await http().json<EnrichResponse>(getEnrichDocumentUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ANALYTICS_TIMEOUT_MS,
  });
}

// HiRAG hierarchical decomposition (4-level hierarchy + bridges). Slow +
// non-idempotent → analytics budget; POST is not retried.
export async function decomposeDocument(
  body: DecomposeRequest,
): Promise<DecomposeResponse> {
  return await http().json<DecomposeResponse>(getDecomposeDocumentUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ANALYTICS_TIMEOUT_MS,
  });
}

// Document-ingestion job queue — list (read). Verbatim passthrough.
export async function listDocumentJobs(): Promise<unknown> {
  return await http().json<unknown>(getListDocumentJobsUrl(), { method: 'GET' });
}

// Document-ingestion job queue — delete one job (admin-gated at the route).
// DELETE is idempotent upstream (re-delete = safe no-op) so a transient 5xx
// retry is fine.
export async function deleteDocumentJob(jobId: string): Promise<unknown> {
  // Encode the id (the generated builder interpolates it raw) so a SLASH in it
  // can't add path segments — defense-in-depth on an admin verb, so the request
  // always targets exactly one job resource.
  // ⚠️ This does NOT stop `..`: `encodeURIComponent('..') === '..'` (dots are
  // unreserved) and `fetch`/`URL` then normalise the segment away — an id of
  // exactly `..` turns `/ingest/documents/jobs/..` into `/ingest/documents/`.
  // Measured 2026-09-02. Ids reaching here are server-derived, so this is not
  // an open hole today; do not restate the old "`..` can't traverse" claim.
  return await http().json<unknown>(
    getDeleteDocumentJobUrl(encodeURIComponent(jobId)),
    { method: 'DELETE' },
  );
}

// Document-ingestion job queue — clear completed jobs (admin-gated at the route).
export async function clearDocumentJobs(): Promise<unknown> {
  return await http().json<unknown>(getClearDocumentJobsUrl(), {
    method: 'POST',
  });
}

// -------- Orchestrated-pipeline job control (P2-5; George default-yes 2026-07-12) --------
// Drive a KAG ingestion as ONE tracked pipeline job: submit content, poll its
// status, and cancel/resume/delete it. State-writing job control — a deliberate
// write-passthrough carve-out and admin-gated at the routes (except the status read).

export async function submitKagPipeline(
  body: KAGIngestRequest,
): Promise<KAGIngestResponse> {
  return await http().json<KAGIngestResponse>(getSubmitKagPipelineUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getKagJobStatus(jobId: string): Promise<unknown> {
  return await http().json<unknown>(
    getGetKagJobStatusUrl(encodeURIComponent(jobId)),
    { method: 'GET' },
  );
}

// cancel/resume are POST mutations; delete is idempotent upstream. Each encodes
// the job id (the generated builder interpolates it raw) so a `..`/slash can't
// add path segments — defense-in-depth on admin verbs, so each request targets
// exactly one job resource. It does NOT neutralise
// `..` (unreserved, and `fetch` normalises it away) — see `deleteDocumentJob`.
export async function cancelKagJob(jobId: string): Promise<unknown> {
  return await http().json<unknown>(
    getCancelKagJobUrl(encodeURIComponent(jobId)),
    { method: 'POST' },
  );
}

export async function resumeKagJob(jobId: string): Promise<unknown> {
  return await http().json<unknown>(
    getResumeKagJobUrl(encodeURIComponent(jobId)),
    { method: 'POST' },
  );
}

export async function deleteKagJob(jobId: string): Promise<unknown> {
  return await http().json<unknown>(
    getDeleteKagJobUrl(encodeURIComponent(jobId)),
    { method: 'DELETE' },
  );
}

export async function parseText(body: ParseRequest): Promise<ParseResponse> {
  return await http().json<ParseResponse>(getParseTextUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function segmentText(
  body: SegmentRequest,
): Promise<SegmentResponse> {
  return await http().json<SegmentResponse>(getSegmentTextUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function computeTextSimilarity(
  body: SimilarityRequest,
): Promise<SimilarityResponse> {
  return await http().json<SimilarityResponse>(getComputeTextSimilarityUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function detectLanguage(
  body: LanguageDetectRequest,
): Promise<LanguageDetectResponse> {
  return await http().json<LanguageDetectResponse>(getDetectLanguageUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function assessTextQuality(
  body: TextQualityRequest,
): Promise<TextQualityResponse> {
  return await http().json<TextQualityResponse>(getAssessTextQualityUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function computeEntityDensity(
  body: EntityDensityRequest,
): Promise<EntityDensityResponse> {
  return await http().json<EntityDensityResponse>(getComputeEntityDensityUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function generateEmbeddings(
  body: EmbeddingsRequest,
): Promise<EmbeddingsResponse> {
  return await http().json<EmbeddingsResponse>(getGenerateEmbeddingsUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function computeAttention(
  body: AttentionRequest,
): Promise<AttentionResponse> {
  return await http().json<AttentionResponse>(getComputeAttentionUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function computeMlSimilarity(
  body: MLSimilarityRequest,
): Promise<MLSimilarityResponse> {
  return await http().json<MLSimilarityResponse>(getComputeMlSimilarityUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// -------- Provenance (chunk -> scrape session) --------

// Resolve a retrieved chunk back to the scrape session it came from. A chunk
// carries only `{ doc_id, url, page, chunk_id }` and no `session_id`; the
// gateway's read-only `/ingest/scrape/provenance` (backed by ingestion_service's
// ScrapedURL join) maps its `doc_id` (then `url` as a fallback) to the owning
// scrape session + screenshot availability, so the UI can offer a "view source
// page" jump to the session's screenshot. `found:false` is the normal answer for
// a non-scraped chunk (e.g. an uploaded document), not an error. Hand-rolled URL
// — the orval client doesn't expose this endpoint.
interface KagSourcePageParams {
  doc_id?: string;
  url?: string;
}
interface KagSourcePageResponse {
  found: boolean;
  session_id: string | null;
  url: string | null;
  has_screenshot: boolean;
  image_count: number;
  has_images: boolean;
}

export async function resolveSourcePage(
  params: KagSourcePageParams,
): Promise<KagSourcePageResponse> {
  const qs = new URLSearchParams();
  if (params.doc_id) qs.set('doc_id', params.doc_id);
  if (params.url) qs.set('url', params.url);
  return await http().json<KagSourcePageResponse>(
    `/ingest/scrape/provenance?${qs.toString()}`,
    { method: 'GET' },
  );
}

// -------- Graph reads --------

export async function queryGraphNodes(
  params?: QueryGraphNodesParams,
): Promise<unknown> {
  return await http().json<unknown>(getQueryGraphNodesUrl(params), {
    method: 'GET',
  });
}

export async function getGraphNode(nodeId: string): Promise<unknown> {
  return await http().json<unknown>(getGetGraphNodeUrl(nodeId), { method: 'GET' });
}

export async function queryGraphEdges(
  params?: QueryGraphEdgesParams,
): Promise<unknown> {
  return await http().json<unknown>(getQueryGraphEdgesUrl(params), {
    method: 'GET',
  });
}

export async function getGraphEdge(edgeId: string): Promise<unknown> {
  return await http().json<unknown>(getGetGraphEdgeUrl(edgeId), { method: 'GET' });
}

export async function getGraphStats(
  params?: GetGraphStatsParams,
): Promise<unknown> {
  return await http().json<unknown>(getGetGraphStatsUrl(params), {
    method: 'GET',
  });
}

// Distinct node labels present in the tenant's graph — powers the Explore-graph
// legend + type filter. graph-adapter serves this list-shaped at
// `GET /graph/nodes/types` (declared before `/nodes/{id}` so FastAPI matches the
// literal first). Read-only.
export async function getGraphNodeTypes(): Promise<unknown> {
  return await http().json<unknown>(getGetGraphNodeTypesUrl(), { method: 'GET' });
}

// -------- Graph analytics (read-style POSTs; no mutation) --------
// These back the Explore-graph "actionable buttons". Each maps to a
// graph-adapter analytics endpoint that bakes tenant_id into the query, so the
// caller never supplies raw Cypher.

// Community detection — colours nodes by cluster ("themes in your knowledge").
export async function detectCommunities(
  body: CommunityRequest,
): Promise<CommunityResponse> {
  return await http().json<CommunityResponse>(getDetectCommunitiesUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ANALYTICS_TIMEOUT_MS,
  });
}

// Centrality — ranks the most important concepts (degree/betweenness/pagerank/…).
export async function calculateCentrality(
  body: CentralityRequest,
): Promise<CentralityResponse> {
  return await http().json<CentralityResponse>(getCalculateCentralityUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ANALYTICS_TIMEOUT_MS,
  });
}

// Path finding — "how are X and Y related?" between two selected entities.
export async function findGraphPaths(body: PathRequest): Promise<PathResponse> {
  return await http().json<PathResponse>(getFindGraphPathsUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: ANALYTICS_TIMEOUT_MS,
  });
}

// -------- Document / scrape metadata reads --------

/**
 * Flat workspace-scoped list of KAG documents.
 *
 * Sourced from KAG's `GET /api/documents` (graph-adapter `Document` nodes
 * filtered by tenant). Required by fr's `applyEffectiveFilter` seam — the
 * existing semanticSearch / queryGraphNodes paths return nodes by query,
 * not a stable list of every document the workspace owns.
 */
export async function listKagDocuments(
  params?: ListKagDocumentsParams,
): Promise<ListKagDocumentsResponse> {
  return await http().json<ListKagDocumentsResponse>(
    buildListKagDocumentsUrl(params),
    { method: 'GET' },
  );
}

export async function listScrapeSessions(
  params?: ListScrapeSessionsParams,
): Promise<unknown> {
  return await http().json<unknown>(getListScrapeSessionsUrl(params), {
    method: 'GET',
  });
}

export async function getScrapeSessionDetail(sessionId: string): Promise<unknown> {
  return await http().json<unknown>(getGetScrapeSessionDetailUrl(sessionId), {
    method: 'GET',
  });
}

/**
 * Per-URL failure record for a scrape session, normalized for the
 * analysis-to-kanban-bridge slice (KagOutputSource arrow).
 */
export interface ScrapeFailure {
  session_id: string;
  url: string;
  error_code?: string;
  error_message?: string;
  occurred_at?: string;
}

/**
 * Return the per-URL failures for a scrape session.
 *
 * KAG does not expose a dedicated failures endpoint in the Orval-generated
 * `@fr/service-client-kag` surface — `ScrapeSessionData` already carries
 * `urls[]` (with per-URL status) plus an `errors` blob. We derive
 * `ScrapeFailure[]` from `getScrapeSessionDetail()` rather than introducing
 * a new HTTP round-trip.
 */
export async function listScrapeFailures(
  _ctx: unknown,
  sessionId: string,
): Promise<ScrapeFailure[]> {
  const detail = (await getScrapeSessionDetail(sessionId)) as
    | {
        session?: {
          session_id?: string;
          urls?: Array<Record<string, unknown>>;
          errors?: unknown;
        };
      }
    | undefined;

  const session = detail?.session;
  if (!session) return [];
  const sid = session.session_id ?? sessionId;
  const failures: ScrapeFailure[] = [];

  // Primary signal: per-URL items whose status indicates failure.
  for (const item of session.urls ?? []) {
    const status =
      typeof item.status === 'string' ? item.status.toLowerCase() : undefined;
    const hasErrorField =
      typeof item.error === 'string' ||
      typeof item.error_message === 'string' ||
      typeof item.error_code === 'string';
    const isFailed =
      (status !== undefined &&
        (status === 'failed' || status === 'error' || status === 'failure')) ||
      hasErrorField;
    if (!isFailed) continue;

    const url =
      typeof item.url === 'string'
        ? item.url
        : typeof item.target_url === 'string'
          ? item.target_url
          : '';
    if (!url) continue;

    failures.push({
      session_id: sid,
      url,
      error_code:
        typeof item.error_code === 'string' ? item.error_code : undefined,
      error_message:
        typeof item.error_message === 'string'
          ? item.error_message
          : typeof item.error === 'string'
            ? item.error
            : undefined,
      occurred_at:
        typeof item.failed_at === 'string'
          ? item.failed_at
          : typeof item.completed_at === 'string'
            ? item.completed_at
            : typeof item.updated_at === 'string'
              ? item.updated_at
              : undefined,
    });
  }

  // Fallback: top-level `errors` array of {url, ...}.
  if (failures.length === 0 && Array.isArray(session.errors)) {
    for (const raw of session.errors) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const url = typeof e.url === 'string' ? e.url : '';
      if (!url) continue;
      failures.push({
        session_id: sid,
        url,
        error_code: typeof e.error_code === 'string' ? e.error_code : undefined,
        error_message:
          typeof e.error_message === 'string'
            ? e.error_message
            : typeof e.message === 'string'
              ? e.message
              : undefined,
        occurred_at:
          typeof e.occurred_at === 'string'
            ? e.occurred_at
            : typeof e.timestamp === 'string'
              ? e.timestamp
              : undefined,
      });
    }
  }

  return failures;
}

export async function listSupportedFormats(): Promise<unknown> {
  return await http().json<unknown>(getListSupportedFormatsUrl(), {
    method: 'GET',
  });
}

export async function listMlModels(): Promise<unknown> {
  return await http().json<unknown>(getListMlModelsUrl(), { method: 'GET' });
}

// -------- Ingestion writes (KAG ingestion slice — Wave 1 slice 1) --------
//
// Multipart upload routes through `http().fetch` so bearer + correlation-id
// propagation + retry policy still apply, but we hand-roll the multipart
// body and JSON parsing because the orval-generated `uploadDocument` /
// `uploadDocumentSync` use raw fetch without those middlewares.

async function postFormData<T>(path: string, fd: FormData): Promise<T> {
  const res = await http().fetch(path, { method: 'POST', body: fd });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const code =
      res.status === 401
        ? 'UPSTREAM_UNAUTHORIZED'
        : res.status === 403
          ? 'UPSTREAM_FORBIDDEN'
          : res.status === 404
            ? 'UPSTREAM_NOT_FOUND'
            : res.status === 409
              ? 'UPSTREAM_CONFLICT'
              : 'UPSTREAM_BAD_STATUS';
    const { IntegrationError } = await import('./_lib/errors');
    throw new IntegrationError({
      code,
      message: `kag POST ${path} returned ${res.status}`,
      service: 'kag',
      path,
      method: 'POST',
      upstreamStatus: res.status,
      upstreamBody: parsed,
    });
  }
  return parsed as T;
}

export async function uploadDocument(body: BodyUploadDocument): Promise<unknown> {
  const fd = new FormData();
  fd.append('file', body.file);
  if (body.send_to_kag !== undefined) {
    fd.append('send_to_kag', String(body.send_to_kag));
  }
  return await postFormData<unknown>(getUploadDocumentUrl(), fd);
}

export async function uploadDocumentSync(
  body: BodyUploadDocumentSync,
): Promise<unknown> {
  const fd = new FormData();
  fd.append('file', body.file);
  if (body.send_to_kag !== undefined) {
    fd.append('send_to_kag', String(body.send_to_kag));
  }
  if (body.extract_images !== undefined) {
    fd.append('extract_images', String(body.extract_images));
  }
  return await postFormData<unknown>(getUploadDocumentSyncUrl(), fd);
}

/**
 * HIPAA right-to-delete: purge a document's full PHI footprint across the KAG
 * fleet. Hits the ingestion coordinator `DELETE /ingest/documents/{id}`, which
 * fans out to kag_graph (chunks + entities + Neo4j) and kag_orchestrator
 * (ingest job + cascade), purges MinIO images, and drops its own job row.
 *
 * `kagIngestionId` is the purge key (`documents.kag_document_id`, or the per-run
 * `documents.kag_ingestion_id`) — the cross-service document key. The coordinator
 * is fail-closed (502 if any store fails) and idempotent (re-purge is a safe
 * no-op), so the caller should treat any thrown error as "not purged — retry" and
 * only remove the local row on success.
 *
 * `tenantId` is REQUIRED and must be the tenant the document was INGESTED under
 * (`documents.tenant_id`, captured in the same request frame that supplied the
 * outbound X-Tenant-Id at upload — migration 083). Record-and-replay: the write
 * tenant is stored, and the delete replays it verbatim. It must NEVER be
 * re-derived from the caller's ambient request context — tenant derivation
 * legitimately varies per request (the `sub` fallback for unprovisioned users, a
 * super-admin switching workspaces via X-Active-Tenant), so the deleter's tenant
 * is not necessarily the uploader's. Every downstream DELETE is tenant-scoped AND
 * idempotent: a wrong-tenant purge deletes 0 rows and still returns HTTP 200
 * `{purged: true, ...zeros}` — indistinguishable from "already purged". Omitting
 * the header (letting the http-client fall back to the request context) therefore
 * produces a SILENT zero-effect purge that orphans the chunks. Hence: no fallback,
 * no silent omission — a caller that cannot name the document's tenant must refuse
 * to delete rather than guess.
 */
export async function deleteDocument(
  kagIngestionId: string,
  opts: { tenantId: string },
): Promise<unknown> {
  const tenantId = opts?.tenantId?.trim();
  if (!tenantId) {
    const { IntegrationError } = await import('./_lib/errors');
    throw new IntegrationError({
      code: 'MISSING_TENANT',
      message:
        'deleteDocument requires the document\'s recorded ingest tenant; refusing to purge under an ambient/derived tenant (a wrong-tenant purge is a silent no-op).',
      service: 'kag',
      path: `/ingest/documents/${kagIngestionId}`,
      method: 'DELETE',
    });
  }
  return await http().json<unknown>(
    `/ingest/documents/${encodeURIComponent(kagIngestionId)}`,
    { method: 'DELETE', headers: { 'x-tenant-id': tenantId } },
  );
}

export async function scrapeUrl(body: ScrapeURLRequest): Promise<unknown> {
  return await http().json<unknown>(getScrapeUrlUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

interface KagRefreshResponse {
  success: boolean;
  changed: boolean;
  reingested: boolean;
  url: string;
  session_id: string;
  document_id: string | null;
  prior_hash: string | null;
  new_hash: string;
  last_scraped_at: string;
  scrape_status: string;
  title: string | null;
  error: string | null;
  // Honest persistence outcome from ingestion: false when the DB write was
  // skipped/failed (freshness baseline not recorded) — see ScrapeRefreshResponse.
  persisted: boolean;
  persist_error: string | null;
}

// Refresh-from-source. Hand-rolled URL (the gateway route is new — not in the
// generated client), mirroring resolveSourcePage. Re-scrapes the URL and lets
// the ingestion service decide via content-hash whether to re-ingest into KAG;
// `send_to_kag` gates that re-ingest (default true).
export async function refreshScrapeSource(
  body: ScrapeURLRequest,
  opts?: { send_to_kag?: boolean },
): Promise<KagRefreshResponse> {
  const suffix =
    opts?.send_to_kag === undefined ? '' : `?send_to_kag=${opts.send_to_kag ? 'true' : 'false'}`;
  return await http().json<KagRefreshResponse>(`/ingest/scrape/refresh${suffix}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function scrapeSitemap(
  body: ScrapeSitemapRequest,
  opts?: { send_to_kag?: boolean },
): Promise<unknown> {
  const suffix =
    opts?.send_to_kag === undefined ? '' : `?send_to_kag=${opts.send_to_kag ? 'true' : 'false'}`;
  return await http().json<unknown>(`${getScrapeSitemapUrl()}${suffix}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Bulk scrape: many URLs as one source. An optional auth_config scrapes the whole
// batch behind ONE login (kag routes an authenticated batch to ingestion, which
// resolves the credential via webscraper server-side and persists it so the source
// is refreshable). send_to_kag ingests each page into the graph.
export async function scrapeBulk(
  body: {
    urls: string[];
    scraper_type?: string;
    delay?: number;
    timeout?: number;
    auth_config?: { credential_id: string } & Record<string, unknown>;
  },
  opts?: { send_to_kag?: boolean },
): Promise<unknown> {
  const suffix =
    opts?.send_to_kag === undefined ? '' : `?send_to_kag=${opts.send_to_kag ? 'true' : 'false'}`;
  return await http().json<unknown>(`/ingest/scrape/bulk${suffix}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Multi-page source refresh. Hand-rolled URL (the gateway route is new — not in the
// generated client), mirroring refreshScrapeSource. Re-enumerates a sitemap (or
// re-scrapes a crawl/bulk source's child set) and re-ingests only changed pages.
export async function refreshSourceMulti(body: {
  base_url: string;
  session_type: 'sitemap' | 'crawl' | 'bulk';
}): Promise<unknown> {
  return await http().json<unknown>('/ingest/scrape/refresh-source', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function pauseScrapeSession(sessionId: string): Promise<unknown> {
  return await http().json<unknown>(getPauseScrapeSessionUrl(sessionId), {
    method: 'POST',
  });
}

export async function resumeScrapeSession(sessionId: string): Promise<unknown> {
  return await http().json<unknown>(getResumeScrapeSessionUrl(sessionId), {
    method: 'POST',
  });
}

export async function deleteScrapeSession(sessionId: string): Promise<unknown> {
  // Encode: the generated builder interpolates raw, and a `/` in the id would
  // add a path segment and send the DELETE to a different route. Matches the
  // sibling destructive callers.
  return await http().json<unknown>(getDeleteScrapeSessionUrl(encodeURIComponent(sessionId)), {
    method: 'DELETE',
  });
}

export async function getDocumentJobStatus(
  jobId: string,
): Promise<DocumentJobStatusResponse> {
  return await http().json<DocumentJobStatusResponse>(
    getGetDocumentJobStatusUrl(jobId),
    { method: 'GET' },
  );
}

/**
 * Bulk-map per-run job ids → the STABLE, content-derived document id.
 *
 * Resolves through ingestion's durable `document_runs` bridge, which is why it exists at
 * all: `ingestion_jobs` rows are swept 7 days after completion, so re-polling
 * `getDocumentJobStatus` per row would 404 on exactly the oldest documents. The bridge is
 * PHI-free, is never swept, and answers for every run it recorded.
 *
 * Keys that resolve to nothing are ABSENT from `resolved` — not an error, and NOT benign:
 * a row with no bridge entry has no recoverable stable id, so its purge can only key on the
 * raw `kag_ingestion_id`. That is only safe when the row also has a recorded `tenant_id`
 * (see deleteDocument); it is never a licence to purge under a derived tenant.
 */
export async function resolveDocumentRuns(
  keys: string[],
): Promise<ResolveDocumentRunsResponse> {
  return await http().json<ResolveDocumentRunsResponse>(getResolveDocumentRunsUrl(), {
    method: 'POST',
    body: JSON.stringify({ keys } satisfies ResolveDocumentRunsRequest),
  });
}

// -------- Scraped visual evidence (read-only) --------
//
// Two response shapes: JSON image manifests (list summaries — served through the
// FR envelope like get_session) and binary image/screenshot bytes (streamed
// straight through so an <img> tag can consume them). All GET reads; no upstream
// write/admin path is reachable from any of these.

/** Slightly higher ceiling than a metadata read — a screenshot can be a few MB. */
const IMAGE_PROXY_TIMEOUT_MS = 60_000;

/** Image-asset manifest for a scrape session (JSON summaries, no bytes). */
export async function listScrapeSessionImages(
  sessionId: string,
): Promise<ImageCollectionResponse> {
  return await http().json<ImageCollectionResponse>(
    getGetScrapeSessionImagesUrl(sessionId),
    { method: 'GET' },
  );
}

/** Image-asset manifest for a document-parse job (JSON summaries, no bytes). */
export async function listDocumentJobImages(
  jobId: string,
): Promise<ImageCollectionResponse> {
  return await http().json<ImageCollectionResponse>(
    getGetDocumentJobImagesUrl(jobId),
    { method: 'GET' },
  );
}

/** Stream the page screenshot captured for a scrape session (image bytes). */
export async function proxyScrapeScreenshot(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return await http().proxy(req, getDownloadScrapeScreenshotUrl(sessionId), {
    timeoutMs: IMAGE_PROXY_TIMEOUT_MS,
  });
}

/** Stream one captured image binary from a scrape session by image id. */
export async function proxyScrapeSessionImage(
  req: Request,
  sessionId: string,
  imageId: string,
): Promise<Response> {
  return await http().proxy(
    req,
    getDownloadScrapeImageUrl(sessionId, imageId),
    { timeoutMs: IMAGE_PROXY_TIMEOUT_MS },
  );
}

/** Stream one extracted image binary from a document-parse job by image id. */
export async function proxyDocumentJobImage(
  req: Request,
  jobId: string,
  imageId: string,
): Promise<Response> {
  return await http().proxy(
    req,
    getDownloadDocumentImageUrl(jobId, imageId),
    { timeoutMs: IMAGE_PROXY_TIMEOUT_MS },
  );
}

/**
 * The subset of a `documents` row that the upstream kag job status can settle.
 * `undefined` fields are left untouched by the caller; `null` is an explicit
 * "known to be absent" (e.g. an entity count the parser never produced).
 */
export interface DocumentRowPatch {
  status?: 'completed' | 'processing' | 'failed';
  pages_detected?: number | null;
  entities_extracted?: number | null;
  error_message?: string | null;
  /** Stable, content-derived document identity (migration 087). Omitted when unknown. */
  kag_document_id?: string;

  // Migration 099 — KAG degradation honesty. Written ONLY on a completed-KAG
  // patch and ONLY when the upstream job actually carried a degradation signal;
  // the keys are OMITTED otherwise so a settled row is never overwritten with a
  // fabricated "clean". Drizzle property names so both writers (the status-route
  // reconcile and the background sweep) pick them up unchanged.
  kag_degraded?: boolean | null;
  kag_degraded_reason?: string | null;
  kag_degraded_stage?: string | null;
  chunks_indexed?: number | null;
  chunks_failed?: number | null;
  chunks_total?: number | null;
}

/**
 * The STABLE, content-derived document identity — read from `result`, deliberately NOT
 * from the top-level `document_id`.
 *
 * The top-level field is PROVISIONAL while a job is in flight: ingestion's async path
 * stores `document_id = job_id` at create time (`job_repository.create_job`:
 * `doc_id = document_id or str(job_id)`) and only re-points it to the content-derived id
 * once the worker has parsed. Harvesting it mid-flight would persist the per-run job id
 * as if it were the stable one — precisely the confusion migration 087 exists to end.
 *
 * `result.document_id` cannot have that problem: `result` carries no `document_id` at all
 * until the parse completes (in flight it is just `{object_key}`), so this self-gates to
 * the post-parse value. Absent/blank ⇒ "not known yet", never an error.
 *
 * (Both fields were invisible here until kag#98: KAG's proxy declares a `response_model`
 * that omitted them, and an undeclared key is silently dropped on the way through. The
 * same omission made `result.text` required and 500'd this endpoint for every async job.)
 */
function pickDocumentId(job: DocumentJobStatusResponse): string | null {
  const id = job.result?.document_id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * The parser's metadata map — present ONLY on the sync shape.
 *
 * `result` is a union: the sync path returns a full parsed document (text + metadata), the
 * ASYNC path — the only one document uploads use — returns a summary that carries no
 * `metadata` at all. So for every document fr actually ingests this is `undefined`, and the
 * page/entity counts derived from it are legitimately null.
 *
 * That is a real (pre-existing) gap, not a bug introduced here: it was previously masked
 * because the whole endpoint 500'd. Narrow rather than cast, so the absence stays visible in
 * the types instead of being asserted away. Populating it needs a `page_count` added to
 * ingestion's async summary — deliberately not the full text, which is PHI on a hot polled
 * endpoint.
 */
function pickMetadata(job: DocumentJobStatusResponse): Record<string, unknown> | undefined {
  const result = job.result;
  if (!result || !('metadata' in result)) return undefined;
  return (result.metadata as Record<string, unknown> | undefined) ?? undefined;
}

/** First finite integer found across the given keys of an open metadata map. */
function pickInt(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number | null {
  if (!source) return null;
  for (const k of keys) {
    const v = source[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return Math.trunc(Number(v));
    }
  }
  return null;
}

/**
 * Decide the KAG-pipeline outcome from the job's `kag_ingest` payload.
 *
 * The upstream top-level `status` flips to "completed" the instant PARSING ends
 * — minutes before KARMA enrichment + HiRAG hierarchy make the document
 * actually queryable. So when KAG indexing was requested we must gate on the
 * KAG outcome, not parse. Two signals, in order of trust:
 *
 *  1. `kag_ingest.status` — set to a terminal value by the orchestrator's
 *     webhook callback. Authoritative when present.
 *  2. `kag_ingest.stage_history` — appended live as each stage finishes, so it
 *     survives a LOST terminal callback (~1-in-5 jobs freeze at "submitted").
 *     The pipeline is done once its terminal stage (HiRAG when enabled — it
 *     produces the queryable sentence chunks — else KARMA) has a
 *     `job.stage.completed` event; any `*failed` event is a terminal failure.
 *
 * Returns `'in_flight'` while indexing is still running (caller keeps the row
 * in `processing` and keeps polling). This is the SINGLE readiness authority —
 * `deriveIngestionProgress` consumes it for the terminal verdict, and so does
 * `services/kag-upload-record.ts`, which decides the BIRTH status of a sync
 * upload's row from the `kag_ingest` the sync response already carries. It is
 * exported for that second caller: the sync ingest submits and returns
 * (`{status:'submitted', terminal:false}`) rather than waiting for karma/hirag,
 * so "is this KAG run finished?" must be answered the same way at insert time
 * as it is on every later poll, or the two disagree about the same job.
 */
export function deriveKagOutcome(
  kagIngest: Record<string, unknown> | undefined,
): 'completed' | 'failed' | 'in_flight' {
  if (!kagIngest) return 'in_flight';

  const flat = typeof kagIngest.status === 'string' ? kagIngest.status.toLowerCase() : '';
  if (flat === 'completed') return 'completed';
  if (flat === 'failed' || flat === 'cancelled' || flat === 'karma_conflict') return 'failed';

  // Flat status stuck non-terminal (lost callback) — fall back to stage history.
  const history = Array.isArray(kagIngest.stage_history)
    ? (kagIngest.stage_history as Array<Record<string, unknown>>)
    : [];
  const profile = (kagIngest.response as Record<string, unknown> | undefined)?.profile as
    | Record<string, unknown>
    | undefined;
  const terminalStage = profile?.enable_hirag === false ? 'karma' : 'hirag';

  let terminalDone = false;
  for (const ev of history) {
    const event = typeof ev.event === 'string' ? ev.event : '';
    const stage = typeof ev.stage === 'string' ? ev.stage : '';
    if (event.endsWith('failed') || stage.endsWith('_failed')) return 'failed';
    if (event === 'job.stage.completed' && stage === terminalStage) terminalDone = true;
  }
  return terminalDone ? 'completed' : 'in_flight';
}

/** The pipeline stage a degradation is attributed to (migration 099). */
export type KagDegradedStage = 'knowledge' | 'hierarchy' | 'index' | 'chunks';

/**
 * A KAG pipeline outcome that terminated, plus whether it terminated HONESTLY.
 *
 * `degraded: false` is a POSITIVE all-clear — the upstream job carried a
 * degradation signal and it said no. It is not the same as `null` (see below).
 */
export interface KagDegradation {
  degraded: boolean;
  /** Upstream `degraded_reason` strings, stage-prefixed, ` | `-joined, ≤500 chars. */
  reason: string | null;
  /** First degraded stage in pipeline order; null when not degraded. */
  stage: KagDegradedStage | null;
  chunksIndexed: number | null;
  chunksFailed: number | null;
  chunksTotal: number | null;
  /**
   * `stage_history[karma].metrics.entities` — the ONLY place the entity count
   * actually lives (see `lastCompletedKagStageMetrics`). KARMA's event only:
   * hirag reports its own `entities: 0` on a perfectly healthy job, so a
   * "first/last stage that has the key" fold writes a 0 that positively asserts
   * "nothing was indexed" — strictly worse than the NULL it replaces.
   */
  entities: number | null;
}

/** Upstream `stage_history` stage name → the degradation stage we attribute to. */
const KAG_DEGRADED_STAGE: Record<string, KagDegradedStage> = {
  karma: 'knowledge',
  hirag: 'hierarchy',
  kag: 'index',
};

/** Pipeline order — the first degraded stage here is the one we report. */
const KAG_DEGRADED_STAGE_ORDER: readonly KagDegradedStage[] = [
  'knowledge',
  'hierarchy',
  'index',
  'chunks',
];

/** Human prefix for a per-stage degraded_reason. */
const KAG_DEGRADED_STAGE_LABEL: Record<KagDegradedStage, string> = {
  knowledge: 'Extracting knowledge',
  hierarchy: 'Building hierarchy',
  index: 'Indexed',
  chunks: 'Chunk store',
};

/** Does this metrics map LITERALLY carry a degradation key? (own key, any value) */
function hasDegradationEvidence(metrics: Record<string, unknown> | null): boolean {
  if (!metrics) return false;
  return (
    Object.prototype.hasOwnProperty.call(metrics, 'degraded') ||
    Object.prototype.hasOwnProperty.call(metrics, 'partial')
  );
}

/** `true` iff the metrics map explicitly flags the stage degraded or partial. */
function metricsSayDegraded(metrics: Record<string, unknown>): boolean {
  return metrics.degraded === true || metrics.partial === true;
}

/**
 * Fold `kag_ingest.stage_history` down to the LAST `job.stage.completed`
 * metrics map per pipeline stage.
 *
 * LAST, not first: a RETRIED stage appends a second completion with fresh
 * metrics, and first-wins would report the superseded numbers — a retry that
 * recovered every chunk would still read as degraded, and vice versa. A
 * `job.stage.failed` event carries no completeness metrics and is skipped
 * outright so it cannot clear the ones we already have.
 *
 * A stage present with a non-object / absent `metrics` maps to `null` — the
 * stage ran, it told us nothing.
 *
 * Shared by `deriveKagDegradation` (degradation flags + chunk counts) and
 * `mapJobStatusToRow` (the entity count), because upstream puts BOTH one level
 * down inside these per-stage metrics and nowhere else. Verified against a live
 * prod job: `kag_ingest`'s own top-level keys are exactly `status, details,
 * attempts, response, terminal, chunks_bulk, stage_history` — no `entity_count`,
 * no `entities`, and `result.metadata` was empty. That is why fr had NEVER
 * rendered an entity count for a KAG-ingested document.
 */
function lastCompletedKagStageMetrics(
  kagIngest: Record<string, unknown> | undefined,
): Map<KagDegradedStage, Record<string, unknown> | null> {
  const out = new Map<KagDegradedStage, Record<string, unknown> | null>();
  const history = Array.isArray(kagIngest?.stage_history)
    ? (kagIngest.stage_history as Array<Record<string, unknown>>)
    : [];
  for (const ev of history) {
    if (ev?.event !== 'job.stage.completed') continue;
    const rawStage = typeof ev.stage === 'string' ? ev.stage : '';
    const key = KAG_DEGRADED_STAGE[rawStage];
    if (!key) continue;
    const metrics =
      ev.metrics && typeof ev.metrics === 'object' && !Array.isArray(ev.metrics)
        ? (ev.metrics as Record<string, unknown>)
        : null;
    out.set(key, metrics);
  }
  return out;
}

/**
 * Decide whether a COMPLETED KAG ingestion silently lost part of the document.
 *
 * The defect this exists for: karma PR #127 gave the extractor a partial-credit
 * mode, and kag_orchestrator #123 folds it into the stage metrics. A chunk that
 * only half-extracted comes back `ok=True` — the orchestrator's own comment
 * (`src/adapters/karma/__init__.py`) spells out the consequence: *"the chunk is
 * ok=True here, so failed_pct is 0.0 and signal 1 alone can never see it"*. So a
 * count-based predicate (`failed_chunks > 0`) MISSES exactly the population this
 * function exists to catch. The primary rule is the explicit flags and nothing
 * else; the counts are reported, never inferred from.
 *
 * Signals, all of which upstream already sends inside `kag_ingest`:
 *   * `stage_history[].metrics.degraded` / `.partial` — karma sets `degraded`
 *     (tolerance OR karma-upstream partial credit) and `partial` (`bool(failed)`)
 *     INDEPENDENTLY, so both must be read; hirag has no separate partial notion
 *     and mirrors its one bit into both keys. The `kag` stage may carry neither.
 *   * `stage_history[].metrics.degraded_reason` — a STRING or `null`.
 *   * `chunks_bulk.status` — ingestion's dual-write to kag_graph_service.
 *     `'failed'` means the parsed chunks never landed in the chunk store, which
 *     the ingestion service itself already treats as degraded
 *     (`routes/job_routes.py derive_overall_status`). `'skipped'` (no chunks / no
 *     base url) and `'succeeded'` are NOT degradation.
 *
 * Returns `null` for "UNKNOWN", and the distinction is the whole point:
 *
 *   * `null`   — no stage carried a degradation key and there was no
 *     `chunks_bulk`. This is the LOST-terminal-callback population (~21% of
 *     jobs settle from a sparse `stage_history`) plus every pre-#123 job. We
 *     have no evidence either way, so we must not persist "clean".
 *   * `{degraded: false}` — upstream told us, explicitly, that it is fine.
 *
 * NOT handled here: `kag_ingest.status === 'failed'`. `deriveKagOutcome` already
 * maps that to a terminal `'failed'`, which is strictly stronger than degraded.
 */
export function deriveKagDegradation(
  kagIngest: Record<string, unknown> | undefined,
): KagDegradation | null {
  if (!kagIngest) return null;

  // LAST `job.stage.completed` per stage — see the helper for why last-wins.
  const lastCompleted = lastCompletedKagStageMetrics(kagIngest);

  let sawEvidence = false;
  const degradedStages: KagDegradedStage[] = [];
  const reasons: string[] = [];

  for (const key of KAG_DEGRADED_STAGE_ORDER) {
    if (key === 'chunks') continue; // handled below, not a stage_history stage
    const metrics = lastCompleted.get(key) ?? null;
    if (!hasDegradationEvidence(metrics)) continue;
    sawEvidence = true;
    if (!metricsSayDegraded(metrics!)) continue;
    degradedStages.push(key);
    // A `null` degraded_reason contributes NOTHING — never the string "null".
    const raw = metrics!.degraded_reason;
    if (typeof raw === 'string' && raw.trim() !== '') {
      reasons.push(`${KAG_DEGRADED_STAGE_LABEL[key]}: ${raw}`);
    }
  }

  // Ingestion's chunk-store dual write. Any object carrying a string `status` is
  // evidence that the hop was attempted and its outcome recorded.
  const bulk = kagIngest.chunks_bulk;
  const bulkObj =
    bulk && typeof bulk === 'object' && !Array.isArray(bulk)
      ? (bulk as Record<string, unknown>)
      : null;
  if (bulkObj && typeof bulkObj.status === 'string') {
    sawEvidence = true;
    if (bulkObj.status === 'failed') {
      degradedStages.push('chunks');
      const detail =
        (typeof bulkObj.error === 'string' && bulkObj.error.trim() !== ''
          ? bulkObj.error
          : null) ??
        (typeof bulkObj.error_type === 'string' && bulkObj.error_type.trim() !== ''
          ? bulkObj.error_type
          : null) ??
        'unknown error';
      reasons.push(`Chunk store write failed: ${detail}`);
    }
  }

  // No evidence at all ⇒ UNKNOWN. Returning `{degraded:false}` here is the bug:
  // it would stamp the entire lost-callback population as verified-clean.
  if (!sawEvidence) return null;

  // Counts come from the KARMA event ONLY, and only from keys upstream actually
  // sent. `metrics.total_chunks` there is `len(results)` — a real denominator.
  // Deliberately NOT `kag_ingest.karma.chunks_total`, which the orchestrator
  // itself documents as "chunks seen so far" off `chunk_states`.
  const karmaMetrics = lastCompleted.get('knowledge') ?? null;

  const stage =
    KAG_DEGRADED_STAGE_ORDER.find((s) => degradedStages.includes(s)) ?? null;
  const reason = reasons.length > 0 ? reasons.join(' | ').slice(0, 500) : null;

  return {
    degraded: degradedStages.length > 0,
    reason,
    stage,
    chunksIndexed: pickInt(karmaMetrics, ['succeeded_chunks']),
    chunksFailed: pickInt(karmaMetrics, ['failed_chunks']),
    chunksTotal: pickInt(karmaMetrics, ['total_chunks']),
    entities: pickInt(karmaMetrics, ['entities']),
  };
}

/**
 * Map an upstream kag document-job status onto a local `documents` row patch.
 *
 * Pure + side-effect-free so it is unit-testable without HTTP. Only an
 * EXPLICIT upstream terminal status flips the row — anything in-flight or
 * unrecognised returns `{}` (no-op) so the caller leaves the row as-is rather
 * than churning it on every poll. Page / entity counts are best-effort probes
 * of the open `result.metadata` map (+ `kag_ingest`); absent → `null`, which
 * still lets the row settle to `completed`.
 *
 * When `send_to_kag`, parse-complete is NOT ready — the document is only
 * queryable once the KAG pipeline finishes (minutes later). Gate the row's
 * `completed` on `deriveKagOutcome` so we never tell the user a half-indexed
 * doc is ready; while it indexes we no-op so the row stays `processing`.
 */
export function mapJobStatusToRow(job: DocumentJobStatusResponse): DocumentRowPatch {
  const state = (job.status ?? '').trim().toLowerCase();

  const metadata = pickMetadata(job);
  const kagIngest =
    (job.kag_ingest as Record<string, unknown> | null | undefined) ?? undefined;

  const pages = pickInt(metadata, ['page_count', 'num_pages', 'pages']);
  // Entity count, three probes deep — the first two MISS on every real KAG job.
  //
  // Verified by driving a live upload through prod: karma extracted 2,191
  // entities / 2,099 relationships and the fr row still settled with
  // `entities_extracted = NULL`, as had every pre-existing prod row. Neither
  // `result.metadata` (empty on this job) nor `kag_ingest`'s top level (keys are
  // exactly status/details/attempts/response/terminal/chunks_bulk/stage_history)
  // carries the number — a literal `%entity_count%` search over the whole blob
  // returns nothing. It lives one level down in
  // `stage_history[karma].metrics.entities`, the same place the migration-099
  // degradation fold already reads.
  //
  // Kept as the LAST fallback so a future payload that does surface a top-level
  // count still wins. Read from the KARMA event ONLY: hirag emits its own
  // `entities: 0` on a perfectly healthy job, so a stage-agnostic fold would
  // write 0 — a positive claim that nothing was indexed, worse than NULL.
  //
  // Deliberately NOT gated on `deriveKagDegradation` returning non-null: the
  // entity count is independent information, and a job whose karma metrics carry
  // `entities` but no `degraded`/`partial` key (pre-orchestrator-#123) must still
  // report its count even though its completeness stays unknown.
  const entities =
    pickInt(metadata, ['entity_count', 'entities', 'num_entities']) ??
    pickInt(kagIngest, ['entity_count', 'entities_extracted', 'entities']) ??
    pickInt(lastCompletedKagStageMetrics(kagIngest).get('knowledge') ?? null, ['entities']);

  // Stable document identity (migration 087), harvested ONLY onto terminal patches.
  // Deliberately not added to the in-flight `{}` no-op: callers write whenever the
  // patch is non-empty, so emitting it mid-flight would rewrite the row (and bump
  // `updated_at`) on EVERY poll — churn that also keeps pushing the row out of the
  // reconcile sweep's staleness window. Spread-only-when-known so a not-yet-parsed
  // job can never null out an id we already stored. A row deleted before it settles
  // still purges correctly: the delete path falls back to `kag_ingestion_id`, which
  // ingestion resolves through its durable `document_runs` job_id → document_id bridge.
  const docId = pickDocumentId(job);
  const idPatch: DocumentRowPatch = docId ? { kag_document_id: docId } : {};

  // A parse-stage failure is terminal regardless of KAG.
  if (state === 'failed' || state === 'error') {
    return {
      ...idPatch,
      status: 'failed',
      error_message: (job.error ?? 'Ingestion failed upstream').slice(0, 500),
    };
  }

  if (job.send_to_kag) {
    const kag = deriveKagOutcome(kagIngest);
    if (kag === 'completed') {
      // Migration 099 — a COMPLETED KAG run is exactly where the degradation
      // flags belong, and the ONLY place they are written:
      //   * the `failed` branch below is strictly stronger (a failed job is not
      //     "completed but incomplete") and its counts would be misleading;
      //   * the parse-only branch never ran KAG, so there is nothing to know;
      //   * the in-flight `{}` no-op must stay empty — callers write whenever the
      //     patch is non-empty, so emitting anything here would rewrite the row
      //     and bump `updated_at` on EVERY poll (see the kag_document_id note).
      // Spread-only-when-known: when `deriveKagDegradation` returns null the keys
      // are OMITTED entirely, leaving the columns NULL = unknown rather than
      // stamping an unverified "clean" over the lost-callback population.
      const degradation = deriveKagDegradation(kagIngest);
      return {
        ...idPatch,
        status: 'completed',
        pages_detected: pages,
        entities_extracted: entities,
        ...(degradation
          ? {
              kag_degraded: degradation.degraded,
              kag_degraded_reason: degradation.reason,
              kag_degraded_stage: degradation.stage,
              chunks_indexed: degradation.chunksIndexed,
              chunks_failed: degradation.chunksFailed,
              chunks_total: degradation.chunksTotal,
            }
          : {}),
      };
    }
    if (kag === 'failed') {
      const kagErr = typeof kagIngest?.error === 'string' ? kagIngest.error : null;
      return {
        ...idPatch,
        status: 'failed',
        error_message: (kagErr ?? job.error ?? 'Knowledge indexing failed upstream').slice(0, 500),
      };
    }
    return {}; // parse may be done, but KAG is still indexing — keep polling.
  }

  // Parse-only (KAG not requested): parse-complete settles the row.
  if (state === 'completed' || state === 'success' || state === 'done') {
    return {
      ...idPatch,
      status: 'completed',
      pages_detected: pages,
      entities_extracted: entities,
    };
  }
  // In-flight (queued/processing/parsing/…) or unknown — do not touch the row.
  return {};
}

// -------- Staged ingestion progress (read-through, for the upload stepper) --------
//
// `deriveIngestionProgress` turns the same upstream job into a structured,
// user-facing view of the async pipeline: Uploaded → Parsed → Extracting
// knowledge (KARMA) → Building hierarchy (HiRAG) → Indexed (KAG graph). It is a
// pure read-through (no DB columns) computed on each status poll, and it
// CONSUMES `deriveKagOutcome` for the terminal verdict so readiness has one
// source of truth.

export type IngestionStageState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export type IngestionStageKey = 'upload' | 'parse' | 'knowledge' | 'hierarchy' | 'index';

export interface IngestionStage {
  key: IngestionStageKey;
  label: string;
  state: IngestionStageState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Short human count, e.g. "4,827 entities", "201 sentences", "12 pages". */
  detail?: string;
  /**
   * Upstream stage metrics, scalars only.
   *
   * BOOLEANS and STRINGS survive here on purpose: the fold used to keep numbers
   * only, which silently ate `degraded` / `partial` (booleans) and
   * `degraded_reason` (a string) — the exact signal migration 099 exists to
   * surface. kag_orchestrator's karma adapter even carries a comment about
   * working around this filter. Objects, arrays (`failed_chunk_indices`), and
   * null/undefined are still dropped: this is a display map, not a dump.
   */
  metrics?: Record<string, string | number | boolean>;
  /**
   * Typed sibling of `metrics.degraded`/`.partial`. `undefined` = the stage
   * carried NO degradation key at all (unknown), matching the column semantics.
   */
  degraded?: boolean;
  /** Upstream `degraded_reason` for this stage; `null` when degraded with no reason given. */
  degradedReason?: string | null;
}

export interface IngestionProgress {
  stages: IngestionStage[];
  currentStageKey: IngestionStageKey | null;
  /**
   * 0–100, done stages / expected stages.
   *
   * A `degraded` pipeline is still 100: it TERMINATED, every stage ran to
   * completion, and the bar counts stages, not content. The incompleteness is
   * reported by `terminal`/`degradation`, never by pretending the pipeline is
   * still moving. (This is also why there is no `'degraded'` IngestionStageState
   * — `percentComplete` counts `state === 'done'`, so a new state would silently
   * drop a finished job to 66%.)
   */
  percentComplete: number;
  terminal: 'ready' | 'degraded' | 'failed' | null;
  failedStageKey: IngestionStageKey | null;
  errorMessage: string | null;
  /** Migration 099 degradation verdict; `null` = upstream gave no evidence either way. */
  degradation: KagDegradation | null;
  /** Diagnostic ids surfaced in the operator details panel (tenant fragmentation). */
  ids: {
    ingestionJobId: string | null;
    orchestratorJobId: string | null;
    tenantId: string | null;
  };
}

const INGESTION_STAGE_LABEL: Record<IngestionStageKey, string> = {
  upload: 'Uploaded',
  parse: 'Parsed',
  knowledge: 'Extracting knowledge',
  hierarchy: 'Building hierarchy',
  index: 'Indexed',
};

// Upstream KAG stage name (in `stage_history`) → our display key.
const KAG_STAGE_KEY: Record<string, IngestionStageKey> = {
  karma: 'knowledge',
  hirag: 'hierarchy',
  kag: 'index',
};

/** First non-empty string found across the given keys of an open map. */
function pickStr(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!source) return null;
  for (const k of keys) {
    const v = source[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function formatCount(n: number, unit: string): string {
  return `${n.toLocaleString()} ${unit}`;
}

export function deriveIngestionProgress(job: DocumentJobStatusResponse): IngestionProgress {
  const state = (job.status ?? '').trim().toLowerCase();
  const metadata = pickMetadata(job);
  const kagIngest =
    (job.kag_ingest as Record<string, unknown> | null | undefined) ?? undefined;
  const sendToKag = !!job.send_to_kag;

  const parseFailed = state === 'failed' || state === 'error';
  const parseDone = state === 'completed' || state === 'success' || state === 'done';
  const pages = pickInt(metadata, ['page_count', 'num_pages', 'pages']);

  const kagResponse = kagIngest?.response as Record<string, unknown> | undefined;
  const ids = {
    ingestionJobId: typeof job.job_id === 'string' ? job.job_id : null,
    orchestratorJobId: pickStr(kagIngest, [
      'job_id',
      'orchestrator_job_id',
      'pipeline_job_id',
    ]),
    tenantId:
      pickStr(kagIngest, ['tenant_id', 'tenantId']) ??
      pickStr(kagResponse, ['tenant_id', 'tenantId']) ??
      pickStr(metadata, ['tenant_id', 'tenantId']),
  };

  const stages: IngestionStage[] = [
    { key: 'upload', label: INGESTION_STAGE_LABEL.upload, state: 'done' },
    {
      key: 'parse',
      label: INGESTION_STAGE_LABEL.parse,
      state: parseFailed ? 'failed' : parseDone ? 'done' : 'active',
      detail:
        pages != null ? `${pages.toLocaleString()} page${pages === 1 ? '' : 's'}` : undefined,
    },
  ];

  // Parse failure is terminal — no KAG stages run.
  if (parseFailed) {
    return {
      stages,
      currentStageKey: 'parse',
      percentComplete: Math.round((1 / 2) * 100),
      terminal: 'failed',
      failedStageKey: 'parse',
      errorMessage: (job.error ?? 'Ingestion failed upstream').slice(0, 500),
      // The parse stage broke before KAG ever ran — there is no ingestion to be
      // partially complete, so degradation is UNKNOWN, not false.
      degradation: null,
      ids,
    };
  }

  // Parse-only (no KAG requested): parse-done is the whole pipeline.
  if (!sendToKag) {
    return {
      stages,
      currentStageKey: parseDone ? null : 'parse',
      percentComplete: parseDone ? 100 : 50,
      terminal: parseDone ? 'ready' : null,
      failedStageKey: null,
      errorMessage: null,
      // KAG was never requested, so there is no KAG completeness claim to make.
      degradation: null,
      ids,
    };
  }

  // --- KAG pipeline stages ---
  const profile = kagResponse?.profile as Record<string, unknown> | undefined;
  const enabled: Record<IngestionStageKey, boolean> = {
    upload: true,
    parse: true,
    knowledge: profile?.enable_karma !== false,
    hierarchy: profile?.enable_hirag !== false,
    index: profile?.enable_kag_ingest !== false,
  };

  // Fold stage_history into per-key completion + metrics + timestamps.
  const history = Array.isArray(kagIngest?.stage_history)
    ? (kagIngest!.stage_history as Array<Record<string, unknown>>)
    : [];
  const seen = new Map<
    IngestionStageKey,
    { done: boolean; failed: boolean; ts?: string; metrics?: Record<string, unknown> }
  >();
  for (const ev of history) {
    const event = typeof ev.event === 'string' ? ev.event : '';
    const rawStage = typeof ev.stage === 'string' ? ev.stage : '';
    const key = KAG_STAGE_KEY[rawStage.replace(/_failed$/, '')];
    if (!key) continue;
    const cur = seen.get(key) ?? { done: false, failed: false };
    if (event.endsWith('failed') || rawStage.endsWith('_failed')) cur.failed = true;
    if (event === 'job.stage.completed') {
      cur.done = true;
      if (typeof ev.timestamp === 'string') cur.ts = ev.timestamp;
      if (ev.metrics && typeof ev.metrics === 'object') {
        cur.metrics = ev.metrics as Record<string, unknown>;
      }
    }
    seen.set(key, cur);
  }

  const outcome = deriveKagOutcome(kagIngest);
  const kagFailed = outcome === 'failed';
  const kagReady = outcome === 'completed';

  // The metric + unit each KAG stage shows once complete.
  const kagDetail: Record<IngestionStageKey, { keys: string[]; unit: string }> = {
    upload: { keys: [], unit: '' },
    parse: { keys: [], unit: '' },
    knowledge: { keys: ['entities', 'entity_count', 'entities_extracted'], unit: 'entities' },
    hierarchy: { keys: ['total_sentences', 'sentences', 'total_chunks'], unit: 'sentences' },
    index: { keys: ['nodes_created', 'nodes', 'relationships_created'], unit: 'nodes' },
  };

  const order: IngestionStageKey[] = ['knowledge', 'hierarchy', 'index'];
  let activeAssigned = false;
  let failedStageKey: IngestionStageKey | null = null;
  for (const key of order) {
    if (!enabled[key]) {
      stages.push({ key, label: INGESTION_STAGE_LABEL[key], state: 'skipped' });
      continue;
    }
    const ev = seen.get(key);
    let stageState: IngestionStageState;
    if (ev?.failed) {
      stageState = 'failed';
      failedStageKey = failedStageKey ?? key;
    } else if (ev?.done) {
      stageState = 'done';
    } else if (kagReady) {
      // Terminal callback said completed but per-stage history may be sparse —
      // treat all enabled KAG stages as done so the bar reflects readiness.
      stageState = 'done';
    } else if (kagFailed) {
      stageState = 'skipped';
    } else if (!activeAssigned) {
      stageState = 'active';
      activeAssigned = true;
    } else {
      stageState = 'pending';
    }

    const metricVal = ev?.metrics ? pickInt(ev.metrics, kagDetail[key].keys) : null;

    // Typed degradation siblings, per stage. `undefined` when the stage carried
    // NO degraded/partial key: unknown is not the same as clean.
    const stageMetrics = ev?.metrics ?? null;
    const stageDegraded = hasDegradationEvidence(stageMetrics)
      ? metricsSayDegraded(stageMetrics!)
      : undefined;
    const rawReason = stageMetrics?.degraded_reason;
    const stageDegradedReason =
      stageDegraded === true
        ? typeof rawReason === 'string' && rawReason.trim() !== ''
          ? rawReason
          : null
        : undefined;

    stages.push({
      key,
      label: INGESTION_STAGE_LABEL[key],
      state: stageState,
      finishedAt: ev?.ts,
      detail:
        stageState === 'done' && metricVal != null
          ? formatCount(metricVal, kagDetail[key].unit)
          : undefined,
      // Scalars only — booleans/strings kept (degraded/partial/degraded_reason),
      // null/undefined/objects/arrays (failed_chunk_indices) dropped.
      metrics:
        ev?.metrics
          ? (Object.fromEntries(
              Object.entries(ev.metrics).filter(
                ([, v]) =>
                  typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string',
              ),
            ) as Record<string, string | number | boolean>)
          : undefined,
      degraded: stageDegraded,
      degradedReason: stageDegradedReason,
    });
  }

  const expected = stages.filter((s) => s.state !== 'skipped').length;
  const done = stages.filter((s) => s.state === 'done').length;
  const percentComplete = expected > 0 ? Math.round((done / expected) * 100) : 0;

  // Migration 099 — a completed run splits into ready vs degraded. `degradation`
  // is null when upstream gave no evidence either way, and a null must NEVER be
  // read as an all-clear, so only an explicit `degraded: true` downgrades.
  const degradation = deriveKagDegradation(kagIngest);
  const terminal: 'ready' | 'degraded' | 'failed' | null = kagFailed
    ? 'failed'
    : kagReady
      ? degradation?.degraded
        ? 'degraded'
        : 'ready'
      : null;
  // Any non-failure terminal has NO active stage. A degraded job is finished —
  // reporting an active stage would render a phantom spinner beside a pipeline
  // that has stopped. `failed` keeps pointing at the stage that broke, mirroring
  // the parse-failure early return above.
  const currentStageKey =
    terminal === 'failed'
      ? failedStageKey
      : terminal !== null
        ? null
        : (stages.find((s) => s.state === 'active')?.key ?? null);
  const errorMessage = kagFailed
    ? ((typeof kagIngest?.error === 'string' ? kagIngest.error : null) ??
        job.error ??
        'Knowledge indexing failed upstream').slice(0, 500)
    : null;

  return {
    stages,
    currentStageKey,
    percentComplete,
    terminal,
    failedStageKey,
    errorMessage,
    degradation,
    ids,
  };
}

export async function getBatchStatus(batchId: string): Promise<unknown> {
  return await http().json<unknown>(getGetBatchStatusUrl(batchId), {
    method: 'GET',
  });
}

export async function retryFailedBatchJobs(batchId: string): Promise<unknown> {
  // Encode — see `deleteScrapeSession`. A raw `/` here would change the segment
  // count and silently un-vouch a destructive POST.
  return await http().json<unknown>(getRetryFailedBatchJobsUrl(encodeURIComponent(batchId)), {
    method: 'POST',
  });
}

// NOTE — intentionally NOT exposed:
//   * uploadDocument / uploadDocumentSync / uploadDocumentsBatch — writes
//   * scrapeUrl / scrapeUrlsBulk / scrapeSitemap / scrapeUrlSync — writes
//   * retryFailedBatchJobs / deleteScrapeSession / pauseScrapeSession /
//     resumeScrapeSession — admin
//   * getBatchStatus / getDocumentJobStatus — job polling
//   * detectDocumentFormat — write-shaped (POST multipart)
//   * createGraphNode / updateGraphNode / deleteGraphNode / createGraphEdge /
//     updateGraphEdge / deleteGraphEdge — graph mutations
//   * bulkImportGraph — bulk graph WRITE (/graph/bulk/import)
//   * executeCypherQuery — raw cypher (mutation-capable)
// EXPOSED as deliberate write-passthrough carve-outs (admin-gated at the routes):
//   * submitKagPipeline / getKagJobStatus / cancelKagJob / resumeKagJob /
//     deleteKagJob — orchestrated single-job pipeline control (P2-5)
//   * executeOptimizedQuery — cost-based structured-query READ alias (P2-4)
//   * forwardTo* — passthrough shims to downstream services
//
// Curated on-demand compute — EXPOSED as read-style POSTs (stateless, idempotent
// transforms; NO persistence in the call chain, verified at source 2026-07-08):
//   * NLP: extractEntities / parseText / segmentText / computeTextSimilarity /
//     detectLanguage / assessTextQuality / computeEntityDensity /
//     computeBatchSimilarity  (/process/nlp/*)
//   * ML:  generateEmbeddings / computeAttention / computeMlSimilarity /
//     listMlModels  (/ml/*; listMlModels is a GET)
//   * Graph: bulkExportGraph  (/graph/bulk/export — read-only snapshot, no persistence)
//
// Write passthroughs — DELIBERATELY EXPOSED (PR-F, George sign-off 2026-07-11):
//   * enrichDocument / decomposeDocument — KARMA / HiRAG pipeline demos
//     (/process/{enrich,decompose}; mutate Postgres + Neo4j, idempotency- +
//     cross-tenant-guarded upstream; analytics 90s budget, POST not retried)
//   * listDocumentJobs (read) / deleteDocumentJob / clearDocumentJobs — the
//     document-ingestion job queue (/ingest/documents/jobs*; delete + clear are
//     admin-gated at the route). These cross the read-only boundary on purpose.
//
// No streaming/SSE read endpoint is exposed by KAG today, so we do not ship a
// `proxyKagRequest` passthrough (unlike workers' chat/completions). Add one if
// a streaming read endpoint lands upstream.
