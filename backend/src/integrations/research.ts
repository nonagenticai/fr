// Scientific Research integration — thin BFF adapter over the KAG gateway's
// catch-all proxies for the Discovery Engine and Scientific Processor.
//
// The KAG gateway (config.services.kag.baseUrl) reverse-proxies two scientific
// services we surface here:
//   - Discovery Engine   under `/discover/*`  (strips `/discover`, forwards the
//     rest to DISCOVERY_ENGINE_URL; the engine mounts everything at `/api/...`,
//     so the real path through the gateway is `/discover/api/...`).
//   - Scientific Processor under `/scientific/*` (same shape → `/scientific/api/...`).
//
// We reuse the same hardened HttpClient as integrations/kag.ts but with its own
// cached instance + `serviceName:'research'` so timeouts / errors / correlation
// are attributable. URLs are hand-rolled (like `askKag`) — the orval client does
// not carry these catch-all routes and an orval regen has no value for v1.
//
// Tenant is threaded EXPLICITLY (mirrors integrations/kag.ts `scrapeUrl` rather
// than the ALS-only `askKag`): it is set as `X-Tenant-Id` on every call. This is
// (a) testable without an active request-context frame and (b) defense-in-depth
// for `ingestPush`, the one call that mutates the shared tenant KAG graph. The
// HttpClient only fills `X-Tenant-Id` from ALS when the header is absent, so the
// explicit value always wins and stays consistent with the ALS tenant.
//
// Return types are intentionally loose (`unknown` / load-bearing fields only).
// Upstream response shapes are owned by the downstream services and consumed
// defensively by the frontend — we do not re-validate them here.

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { KAG_ONBEHALF_TOKEN_ENV } from './_lib/service-credential';

// Research operations (federated multi-source search, scientific verify,
// formal proofs, sandbox) fan out to many slow, GPU-bound upstream services and
// legitimately run for minutes. Default 15min; override via RESEARCH_TIMEOUT_MS.
// NOTE: the public path also traverses Cloudflare (~100s edge timeout) + the
// istio route — those cap sync requests independently of this value.
const RESEARCH_TIMEOUT_MS = parseInt(
  process.env.RESEARCH_TIMEOUT_MS || '900000',
  10,
);

let cachedClient: HttpClient | undefined;
let cachedScientificClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) cachedClient = buildResearchClient(false);
  return cachedClient;
}

/**
 * The Scientific Processor's client: identical to `http()` (same gateway, same
 * vouch, same `serviceName`) except that an upstream 503 / 429 is relayed as
 * `UPSTREAM_BUSY` — status, `Retry-After` and the body's `error` / `lane` /
 * `retry_after` — instead of collapsing to a 502. The processor answers
 * `503 {"error":"gpu_busy","lane","retry_after"}` + `Retry-After` when a GPU
 * lane (lean4) is full (scientific-processor #71); a 502 told the caller
 * "broken" and dropped the one thing it needed to retry. Scoped to the
 * `/scientific/*` calls only: discover/media keep the old mapping.
 */
function scientificHttp(): HttpClient {
  if (!cachedScientificClient) cachedScientificClient = buildResearchClient(true);
  return cachedScientificClient;
}

function buildResearchClient(passThroughBusy: boolean): HttpClient {
  return createHttpClient({
    serviceName: 'research',
    passThroughBusy,
    baseUrl: config.services.kag.baseUrl,
    defaultTimeoutMs: RESEARCH_TIMEOUT_MS,
    // WHENEVER WE NAME A TENANT, WE VOUCH FOR IT.
    //
    // This client shares `config.services.kag.baseUrl` with
    // integrations/kag.ts, so it is behind the SAME middleware gate. gitops
    // #3944 (merged 2026-09-16, `8f1b1c89d`) set
    // `ALLOW_UNVOUCHED_TENANT_HEADER: "false"` on the kag deployment, and
    // kag now refuses a bare `X-Tenant-Id` GLOBALLY, in middleware
    // (`src/auth/tenant.py` -> "A bare X-Tenant-Id is not accepted; present
    // a license token"). fr #1153 widened kag.ts's predicate to exactly this
    // rule on 2026-09-21 but did not reach the two SIBLING clients that
    // share the base URL — so `/discover/api/*` has 401'd continuously since
    // the flag was armed.
    //
    // Measured 2026-09-23 from the live fr pod against `$KAG_INGESTION_URL`:
    //   /discover/api/search/sources  tenant-only 401 -> tenant+licence 200
    //   /discover/api/sessions        tenant-only 401 -> tenant+licence 200
    //
    // `hasTenantHeader` is the condition, not the path, and that is
    // deliberate: it is kag's own requirement, and it keeps the credential
    // confined to requests that carry a trimmed-non-empty `X-Tenant-Id`.
    // That confinement is what makes the vouch safe — kag's trust ladder has
    // a rung for "Authorization present, X-Tenant-Id ABSENT" that adopts the
    // LICENCE'S OWN tenant, which is not the customer's. Do NOT relax this
    // to an unconditional service token.
    //
    // This does NOT change fr's tenancy posture: `X-Tenant-Id` still names
    // whose data is being asked for, exactly as before. The licence only
    // proves WHO is asking. The separate, still-open question — whether fr
    // should stop threading a plain tenant header at all and move to a
    // delegated-tenant scheme (`tenantBearerEnvVar`, as workers.ts uses) —
    // is untouched here and is an owner decision.
    //
    // ⚠️ I was pointed at "ROADMAP §11 D2" as the home of that decision and
    // deliberately did NOT cite it: there is no ROADMAP.md in this repo (only
    // three archived 2026-04 roadmaps under docs/archive/, none of which
    // contain it). Do not re-add that reference without finding the document.
    serviceTokenForPath: {
      envVar: KAG_ONBEHALF_TOKEN_ENV,
      matches: ({ hasTenantHeader }) => hasTenantHeader,
    },
    // Never the end user's Keycloak JWT. Same kag gateway baseUrl as
    // integrations/kag.ts — see the audit recorded there: 11 of 12 kag
    // downstreams ignore this header, and the twelfth is reached from a
    // different fr code path entirely.
    sendAuthorization: false,
  });
}

function tenantHeaders(tenantId: string): Record<string, string> {
  return { 'X-Tenant-Id': tenantId };
}

// -------- Discovery Engine (`/discover/api/...`) --------

/**
 * Federated academic search across the Discovery Engine's sources.
 * Body matches the engine's `SearchRequest` ({ query, session_id?, sources?,
 * max_results_per_source?, open_access_only?, sort_by? }). Response carries
 * `session_id` (echoed only if supplied) + `results: PaperResult[]` where each
 * result's identifier is `paper_id` (aliased `id`, a UUIDv7).
 */
export async function discoverSearch(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>('/discover/api/search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** Load-bearing fields of the ingest-push response (rest flows through). */
interface IngestPushResult {
  push_id?: string;
  session_id?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Push selected papers into the tenant KAG graph via the orchestrator.
 * Body matches the engine's `IngestPushRequest` ({ session_id, paper_ids[],
 * mode? }). Returns immediately with a `push_id` + per-paper `orchestrator_jobs`;
 * the orchestrator processes each paper asynchronously — poll `ingestPushStatus`.
 *
 * This is the only call that mutates the shared graph; it is additive and
 * reversible (the created Document node can be removed via KAG's delete surface).
 */
export async function ingestPush(
  body: unknown,
  tenantId: string,
): Promise<IngestPushResult> {
  return await http().json<IngestPushResult>('/discover/api/ingest/push', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** Status of an async ingest push. `status` ∈ pushing|completed|partial_failure|failed. */
export async function ingestPushStatus(
  pushId: string,
  tenantId: string,
): Promise<IngestPushResult> {
  return await http().json<IngestPushResult>(
    `/discover/api/ingest/push/${encodeURIComponent(pushId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * List the Discovery Engine's registered search sources and their enabled
 * state (`{ sources: [{ name, enabled }] }`). Feeds the page's "advanced:
 * choose sources" picker with the LIVE set (never a hardcoded list) — only
 * sources that are registered + enabled live can actually be queried.
 */
export async function discoverSources(tenantId: string): Promise<unknown> {
  return await http().json<unknown>('/discover/api/search/sources', {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Compute 7-signal trust scores for a batch of already-discovered papers.
 * Body matches the engine's `ScoreBatchRequest` ({ paper_ids[], session_id? });
 * the papers must already be persisted from a prior search (tenant-scoped).
 * Returns a `TrustScore[]` ({ paper_id, overall_score, components }) sorted by
 * score desc.
 */
export async function scoreBatch(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>('/discover/api/score/batch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Create a discovery session — the durable, tenant-bound workspace backbone.
 * Passing its id into search persists every result into the session (so it
 * survives reload and can be exported) and enables push. Body matches the
 * engine's `SessionCreate` ({ name, description?, mode?, config? }); returns a
 * `SessionDetail` ({ id, name, mode, status, paper_count, ... }).
 */
export async function createSession(
  body: unknown,
  tenantId: string,
): Promise<{ id?: string } & Record<string, unknown>> {
  return await http().json<{ id?: string } & Record<string, unknown>>(
    '/discover/api/sessions',
    { method: 'POST', body: JSON.stringify(body), headers: tenantHeaders(tenantId) },
  );
}

/**
 * Export a session's papers as `json | bibtex | ris`. Returns the engine's
 * `SessionExport` ({ session_id, format, data, paper_count }) where `data` is
 * the serialized export string.
 */
export async function exportSession(
  sessionId: string,
  format: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/export?format=${encodeURIComponent(format)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Take a frozen, digested copy of a session for evidence review.
 *
 * A POST rather than a GET, and that is the whole point of the endpoint: the
 * engine rewrites existing `Paper` rows on every later search, so re-reading a
 * session can answer differently on two days with nothing saying so. This
 * serialises once, stores those exact bytes and returns a receipt
 * (`{ batch_id, session_id, digest, record_count, created_at }`). The bytes
 * themselves come back from `getReviewExport`.
 *
 * `422` from upstream is a refusal worth surfacing verbatim: the session is
 * over the export cap, or it carries a value that cannot enter a sealed
 * artifact (a binary float has no stable decimal form, so a digest over it
 * could not be reproduced by whoever has to check it).
 */
export async function createReviewExport(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/review-export`,
    { method: 'POST', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Replay a frozen review-export batch.
 *
 * ⚠️ **The digest cannot be checked against these bytes.** The engine stores
 * RFC 8785 canonical bytes and serves them verbatim, but this response has
 * crossed two JSON-parsing hops by the time a browser sees it — kag's
 * `_forward` returns a `dict`, and this client only exposes `json<T>()`. Both
 * parse and re-serialise, so what arrives is an equal OBJECT, not equal bytes.
 *
 * A consumer that wants to verify must re-canonicalise (sort keys, no
 * whitespace, `JSON.stringify` number rendering) and hash that. This works
 * because the engine canonicalises under RFC 8785, which renders numbers per
 * ECMAScript — a `json.dumps` recipe emitting `1.0` where `JSON.stringify`
 * emits `1` made exactly this check fail, and that is why the engine no longer
 * uses one. Hashing the received body as-is will not match and is not a
 * tampering signal.
 */
export async function getReviewExport(
  sessionId: string,
  batchId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/review-export/${encodeURIComponent(batchId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Receipts for a session's frozen batches, newest first. Never the documents. */
export async function listReviewExports(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/review-export`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Fetch papers related to a discovered paper via the citation graph:
 *   - `similar`    → semantic neighbours (embedding cosine),
 *   - `citations`  → papers citing this one (forward),
 *   - `references` → papers this one cites (backward).
 * The paper must be persisted from a prior search (tenant-scoped).
 */
export async function getPaperRelated(
  paperId: string,
  kind: 'similar' | 'citations' | 'references',
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/papers/${encodeURIComponent(paperId)}/${kind}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Full metadata for a single paper (`PaperDetail`: title/abstract/year/venue/
 * external_ids/citation_count{,_forward,_backward}/influence_score/authors/…).
 * Read-only. Mirrors `getPaperRelated`.
 */
export async function getPaper(
  paperId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/papers/${encodeURIComponent(paperId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Score a single paper. Body matches the engine's `ScoreRequest`
 * ({ paper_id? } or { paper_ids? }); returns one `TrustScore`
 * ({ paper_id, overall_score, components }). Vs `scoreBatch` (`/score/batch`),
 * which returns an array.
 */
export async function scorePaper(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>('/discover/api/score', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Start an async citation-graph snowball walk from a set of seed papers.
 * Body matches the engine's `SnowballRequest` ({ seed_paper_ids[], session_id,
 * direction?:"forward"|"backward"|"both", max_depth?:1-10, max_papers?:1-5000 }).
 * Returns immediately (201) with a `SnowballStatus` ({ job_id, status:"pending",
 * ... }); the walk runs in the background — poll `snowballStatus`. Discovered
 * papers are persisted into the session, retrievable via the session export.
 * The seeds must already be persisted from a prior search in this session.
 */
export async function startSnowball(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>('/discover/api/snowball', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Status of an async snowball job. `status` ∈ pending|running|completed|failed|
 * cancelled; carries `papers_discovered` / `edges_discovered` / `current_depth`.
 */
export async function snowballStatus(
  jobId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/snowball/${encodeURIComponent(jobId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Cancel an in-flight snowball job. Returns `{ job_id, status }`. */
export async function cancelSnowball(
  jobId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/snowball/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Pause an active discovery session. No body; returns the updated `SessionDetail`
 * (with `status` flipped). Mirrors `cancelSnowball` (session path-param POST).
 */
export async function pauseSession(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/pause`,
    { method: 'POST', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Resume a paused discovery session. No body; returns the updated `SessionDetail`.
 */
export async function resumeSession(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/resume`,
    { method: 'POST', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Fetch a single discovery session's detail/state (`SessionDetail`). Read-only.
 */
export async function getSession(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Update a session's editable fields. Body matches the engine's `SessionUpdate`
 * ({ name?, description?, status? ('active'|'paused'|'completed'|'cancelled'),
 * config? }) — all optional. Returns the updated `SessionDetail`.
 */
export async function updateSession(
  sessionId: string,
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: tenantHeaders(tenantId),
    },
  );
}

/**
 * Delete a discovery session. Upstream returns 204 (→ undefined) or a small
 * confirmation body.
 */
export async function deleteSession(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Research insights for a session — ingest-event health (`SessionInsights`:
 * total_events, pending_events, failed_events). Read-only.
 */
export async function sessionInsights(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/sessions/${encodeURIComponent(sessionId)}/insights`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Session-wide scoring report (`QualityReport`: total_papers, score_distribution,
 * top_papers, recommended_for_ingest, threshold). The trust distribution across
 * the WHOLE session, vs `scoreBatch`'s per-paper scores. Read-only.
 */
export async function scoreReport(
  sessionId: string,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>(
    `/discover/api/score/report/${encodeURIComponent(sessionId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Semantic similarity search over a session's discovered papers. Body matches the
 * engine's `SemanticSearchRequest` ({ query, session_id?, limit? }) → ranked
 * `{ results: [{ paper_id, title, similarity_score }], total }`. Read-only.
 */
export async function semanticSearch(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await http().json<unknown>('/discover/api/search/semantic', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

// -------- Scientific Processor (`/scientific/api/...`) --------

/**
 * Compute a composite integrity score for a graph entity (citation, cross-ref,
 * community, authority and contradiction signals). Body matches the processor's
 * `IntegrityRequest` ({ entity_id, max_hops?, include_topology?, include_cove?,
 * include_ragas?, write_back? }); `entity_id` is a KAG Neo4j node id — exactly
 * the `entity_ids` the discovery push links into the graph. Read-only by default
 * (write_back=false), so this never mutates the graph.
 */
export async function verifyIntegrity(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/verify/integrity', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Chain-of-Verification (CoVe) for a free-text claim. Body matches the
 * processor's `CoveRequest` ({ claim_text, claim_node_id?, ... }); no graph
 * entity is required — the processor decomposes the claim into verification
 * questions and answers them. Read-only.
 */
export async function verifyCove(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/verify/cove', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** RAGAS faithfulness/answer-relevance scoring for a generated answer. Read-only. */
export async function verifyRagas(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/verify/ragas', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Detect contradictions in the subgraph around an entity. Body requires an
 * `entity_id` (a KAG Neo4j node id). Read-only.
 */
export async function topologyContradictions(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/topology/contradictions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** Extract the local subgraph around an entity (`entity_id` required). Read-only. */
export async function topologySubgraph(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/topology/subgraph', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** Authority / centrality scoring for an entity (`entity_id` required). Read-only. */
export async function topologyAuthority(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/topology/authority', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** Graph-wide community detection (no entity required). Read-only. */
export async function topologyCommunities(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/topology/communities', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Kick off an async SubgraphX/GNN explainability job for a node. Body matches the
 * processor's request ({ node_id, ... }) and returns `{ job_id }`; poll
 * `explainJobStatus`. Read-only.
 */
export async function explainSubgraphx(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/explain/subgraphx', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Status of an async explainability job. `status` ∈ pending|running|completed|
 * failed; carries the explanation payload when completed.
 */
export async function explainJobStatus(
  jobId: string,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    `/scientific/api/explain/jobs/${encodeURIComponent(jobId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Statistical trend analysis over a series (pure stats, no entity). Read-only. */
export async function statsTrend(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/stats/trend', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Formal verification (Z3/SymPy/Lean4) of a claim/expression. Body matches the
 * processor's `FormalRequest`. Read-only.
 */
export async function formalVerify(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/formal/verify', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Fixed/random-effects meta-analysis over extracted study results. Body matches
 * the processor's `MetaAnalysisRequest` ({ studies: [{ effect_size,
 * standard_error, sample_size, weight?, label? }], method?='random',
 * confidence_level?=0.95 }) → pooled effect + CI + heterogeneity (Q, I²) +
 * per-study weights. Pure statistics, no graph entity. Read-only.
 */
export async function statsMetaAnalysis(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/stats/meta-analysis', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Confidence interval for an aggregated effect / sample. Body matches the
 * processor's `ConfidenceIntervalRequest` ({ values: number[],
 * confidence_level?=0.95, method?='bootstrap', n_bootstrap?=10000 }) → mean +
 * CI. Pure statistics, no graph entity. Read-only.
 */
export async function statsConfidenceInterval(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    '/scientific/api/stats/confidence-interval',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: tenantHeaders(tenantId),
    },
  );
}

/**
 * Translate a natural-language claim into a formal-logic expression. Body matches
 * the processor's `FormalTranslateRequest` ({ claim_text, target_language?='z3' })
 * → { formal_expression, confidence, ... }. Lets a user feed plain language to
 * `formalVerify` instead of hand-writing Z3/SymPy/Lean syntax. Read-only.
 */
export async function formalTranslate(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/formal/translate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Persist a formal proof for a claim. Body matches the processor's
 * `ProofStoreRequest` ({ expression, language?='z3', is_valid?, proof? }); the
 * claim id is the path segment. Idempotent upsert keyed on the claim id.
 */
export async function formalProofStore(
  claimId: string,
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    `/scientific/api/formal/proofs/${encodeURIComponent(claimId)}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: tenantHeaders(tenantId),
    },
  );
}

/** Retrieve the stored formal proofs for a claim (array). Read-only. */
export async function formalProofGet(
  claimId: string,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    `/scientific/api/formal/proofs/${encodeURIComponent(claimId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

// -------- Verification pipeline (`/scientific/api/pipeline/...`) --------
// The continuous-verification pipeline that (re)scores graph entities. status /
// anomalies / history are pure reads; batch / trigger re-run scoring on the
// processor's own graph (an analysis refresh — not an fr-domain mutation).

/** Pipeline health: running flag, queue depth, throughput, processed/failed totals. */
export async function pipelineStatus(tenantId: string): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/pipeline/status', {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Entities whose verification score dropped beyond `threshold`. `threshold` is
 * forwarded verbatim as the query string (e.g. `threshold=0.1`); pass '' for the
 * processor default. Read-only.
 */
export async function pipelineAnomalies(
  threshold: string,
  tenantId: string,
): Promise<unknown> {
  const qs = threshold ? `?threshold=${encodeURIComponent(threshold)}` : '';
  return await scientificHttp().json<unknown>(`/scientific/api/pipeline/anomalies${qs}`, {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/** Verification score history for one entity (`entity_id` path segment). Read-only. */
export async function pipelineHistory(
  entityId: string,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    `/scientific/api/pipeline/history/${encodeURIComponent(entityId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/**
 * Find and (re)verify unscored/stale entities. Body matches the processor's
 * `PipelineBatchRequest` ({ batch_size?=50, max_hops?=2, write_back?=true }).
 */
export async function pipelineBatch(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/pipeline/batch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Trigger verification for specific entities. Body matches the processor's
 * `PipelineTriggerRequest` ({ entity_ids: string[], write_back?=true,
 * run_cove?=false, run_formal?=false }).
 */
export async function pipelineTrigger(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/pipeline/trigger', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

// -------- Sandboxed execution (`/scientific/api/sandbox/...`) --------
// Run code (Python) in a sandboxed, time-limited environment to reproduce a
// reported statistic. Async: execute → { job_id }; poll the job; fetch results.

/**
 * Submit code for sandboxed execution. Body matches the processor's
 * `SandboxRequest` ({ code, language?='python', timeout_seconds?=60,
 * input_data? }) and returns `{ job_id }`. Poll `sandboxJob`.
 */
export async function sandboxExecute(
  body: unknown,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>('/scientific/api/sandbox/execute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/**
 * Status of a sandboxed-execution job (`SandboxJobStatus`: status, error,
 * execution_time_ms, result_url). `status` ∈ pending|running|completed|failed.
 */
export async function sandboxJob(
  jobId: string,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    `/scientific/api/sandbox/jobs/${encodeURIComponent(jobId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Results of a completed sandboxed-execution job (stdout/stderr/result). Read-only. */
export async function sandboxResult(
  jobId: string,
  tenantId: string,
): Promise<unknown> {
  return await scientificHttp().json<unknown>(
    `/scientific/api/sandbox/results/${encodeURIComponent(jobId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}
