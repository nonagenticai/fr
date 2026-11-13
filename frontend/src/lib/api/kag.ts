/**
 * KAG ingestion frontend client.
 *
 * Wraps `assetFetch` for read paths (returns `T`) and the raw `authFetch`
 * for the write paths because writes go through the E-5 approval bus and
 * return 202 + a pending-action descriptor — we want the page code to be
 * able to distinguish "scrape kicked off" from "scrape pending approval".
 */

import { authFetch } from './auth-fetch';
import { assetFetch } from './assets';
import { withOpenProject } from './kagProjectScope';
import { errorDetailFrom } from './error-detail';
import { readListCount, withClientCap, type ListCount } from './list-count';
import { nodeIdOf, relEndpoints } from '$lib/components/kag/graph-normalise';

/**
 * A binary image/screenshot route refused.
 *
 * ## Why a status has to survive the throw
 *
 * `imageObjectUrl` threw a bare `Error("404 Not Found")`, so every caller could
 * only do one thing with a failure: nothing. `KagSessionView` therefore treated
 * ALL of them as "no screenshot for this session" and rendered no screenshot
 * section at all — on the surface whose stated job is "follow provenance to the
 * exact page that was scraped". A 500 from the object store and a page that was
 * genuinely never captured produced identical pixels, and the pixels asserted
 * the second.
 *
 * 404 is the one status the route uses to mean ABSENT (it proxies the upstream
 * status verbatim; see backend `handleGetSessionScreenshot`). Everything else —
 * and a network throw, which never becomes one of these at all — means
 * UNREADABLE.
 */
export class KagImageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'KagImageError';
    this.status = status;
  }
}

export interface PendingAction {
  status: 'pending';
  actionId: string;
}

export interface ScrapeSession {
  session_id: string;
  base_url?: string;
  // The upstream (ingestion → gateway) field is `session_type`
  // (single_url / bulk / sitemap). `type` is kept as a defensive fallback for
  // any legacy shape, but real rows carry `session_type`.
  session_type?: string;
  type?: string;
  status?: string;
  created_at?: string;
  // True when the source was scraped with a stored credential (ingestion sets it
  // from auth_config presence). The UI badges these — refresh re-authenticates.
  has_auth?: boolean;
}

export interface ListSessionsResponse {
  sessions?: ScrapeSession[];
  // upstream may use other top-level shapes; keep loose.
  [key: string]: unknown;
}

/** One captured image asset (manifest summary — no bytes). */
export interface KagImageAsset {
  image_id: string;
  source_kind?: string;
  source_ref?: string | null;
  page_number?: number | null;
  order_index?: number;
  mime_type?: string | null;
  width?: number | null;
  height?: number | null;
  byte_size?: number | null;
  sha256?: string | null;
  caption?: string | null;
  alt_text?: string | null;
  title?: string | null;
}

/** Image manifest for a scrape session or a document-parse job. */
export interface KagImageManifest {
  success?: boolean | null;
  session_id?: string | null;
  job_id?: string | null;
  count?: number | null;
  total_count?: number | null;
  images?: KagImageAsset[];
  [key: string]: unknown;
}

interface Envelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function postWriteAction<TPending extends PendingAction>(
  path: string,
  body: unknown | FormData,
): Promise<TPending | unknown> {
  const init: RequestInit = { method: 'POST' };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await authFetch(path, init);
  const text = await res.text();
  let parsed: Envelope<TPending | unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Envelope<TPending | unknown>) : null;
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    // `parsed?.error?.message` alone reads exactly ONE level of the envelope,
    // so the two bodies these routes actually return both collapsed to the
    // transport line — `"401 Unauthorized"`, the string that names the hop and
    // not the problem:
    //
    //  * kag's own auth refusal, a bare `{"detail":"<reason>"}` with no
    //    `error` key at all;
    //  * a kag-proxied 422 or coded refusal, whose sentence sits at
    //    `error.upstream.body.detail` — the shape `error-detail.ts` exists to
    //    unwrap.
    //
    // `errorDetailFrom`, not `errorDetailOf`: the body was already drained to
    // `text` above, so the Response cannot be re-read. The status line stays as
    // the fallback for a body that carries nothing legible (an ingress 502
    // serving text/plain), which is the one case it is the honest answer.
    const detail = errorDetailFrom(parsed);
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return parsed?.data ?? null;
}

export interface KagRefreshResult {
  success: boolean;
  changed: boolean;
  reingested: boolean;
  url: string;
  session_id: string;
  prior_hash: string | null;
  new_hash: string;
  scrape_status: string;
  title: string | null;
  error: string | null;
  // Honest persistence outcome (ingestion #78): false when the re-scrape's DB
  // write was skipped/failed, so the freshness baseline was NOT recorded even
  // though the fetch succeeded. Optional for backward-compat with older responses.
  persisted?: boolean;
  persist_error?: string | null;
}

// Image types safe to render/open from a same-origin blob URL: raster only.
// SVG is excluded on purpose — it is a script-capable document.
const RASTER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export const kagApi = {
  // Reads
  async listSessions(params?: { status?: string; limit?: number }): Promise<ListSessionsResponse> {
    const sp = new URLSearchParams();
    if (params?.status) sp.set('status', params.status);
    if (params?.limit !== undefined) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return await assetFetch<ListSessionsResponse>(
      `/api/tools/kag/scrape/sessions${qs ? `?${qs}` : ''}`,
    );
  },
  async getSession(sessionId: string): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}`,
    );
  },
  async getDocumentJob(jobId: string): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/tools/kag/documents/jobs/${encodeURIComponent(jobId)}`,
    );
  },
  async getBatchStatus(batchId: string): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/tools/kag/documents/batch/${encodeURIComponent(batchId)}/status`,
    );
  },

  // Scraped visual evidence (read-only). Manifests unwrap through assetFetch;
  // the image/screenshot BYTES are fetched via `imageObjectUrl` below.
  async sessionImages(sessionId: string): Promise<KagImageManifest> {
    return await assetFetch<KagImageManifest>(
      `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}/images`,
    );
  },
  async documentImages(jobId: string): Promise<KagImageManifest> {
    return await assetFetch<KagImageManifest>(
      `/api/tools/kag/documents/jobs/${encodeURIComponent(jobId)}/images`,
    );
  },
  // Same-origin paths for the binary routes. NOT usable as a raw <img src>:
  // validateAuth is Authorization-header only, so a cookie-only browser image
  // request would 401. Fetch bytes with `imageObjectUrl` (routes through
  // authFetch → Bearer) and render the returned object URL instead.
  sessionScreenshotPath(sessionId: string): string {
    return `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}/screenshot`;
  },
  sessionImagePath(sessionId: string, imageId: string): string {
    return `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}/download`;
  },
  documentImagePath(jobId: string, imageId: string): string {
    return `/api/tools/kag/documents/jobs/${encodeURIComponent(jobId)}/images/${encodeURIComponent(imageId)}/download`;
  },
  /**
   * Fetch a binary image through authFetch (carries the Bearer token) and
   * return an object URL. The caller MUST revoke it via URL.revokeObjectURL
   * once the <img> no longer needs it, or the blob leaks for the tab's life.
   *
   * Throws `KagImageError` on a non-2xx so the caller can tell 404 (the byte
   * route says this capture does not exist — the common, honest case) from
   * every other failure (it exists as far as anyone knows; we could not read
   * it). A thrown fetch is a plain `TypeError` and is likewise NOT a 404.
   */
  async imageObjectUrl(path: string): Promise<string> {
    const res = await authFetch(path);
    if (!res.ok) {
      throw new KagImageError(res.status, `${res.status} ${res.statusText}`);
    }
    // Re-wrap the bytes under a type WE choose. A blob URL keeps the type it
    // was minted with and is same-origin, so an upstream `image/svg+xml` (or
    // `text/html`) capture opened via <a target=_blank> would run its script
    // in fr's origin. Only inert raster types pass through.
    const upstream = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const type = RASTER_IMAGE_TYPES.has(upstream) ? upstream : 'application/octet-stream';
    const buf = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type }));
  },

  // Writes — return PendingAction descriptors (E-5).
  async uploadDocument(file: File, sendToKag = true): Promise<PendingAction | unknown> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('send_to_kag', String(sendToKag));
    return await postWriteAction<PendingAction>('/api/tools/kag/documents', fd);
  },
  async uploadDocumentSync(
    file: File,
    sendToKag = true,
    extractImages = false,
  ): Promise<PendingAction | unknown> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('send_to_kag', String(sendToKag));
    fd.append('extract_images', String(extractImages));
    return await postWriteAction<PendingAction>(
      '/api/tools/kag/documents/sync',
      fd,
    );
  },
  async scrapeUrl(body: {
    url: string;
    scraper_type?: string;
    delay?: number;
    timeout?: number;
    auth_config?: { credential_id: string } & Record<string, unknown>;
  }): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>('/api/tools/kag/scrape/url', body);
  },
  // Refresh-from-source: re-scrape a known source URL. Auto-approves for a human
  // initiator, so this executes inline and returns a KagRefreshResult (only a
  // non-human initiator would get a PendingAction).
  async refreshSource(body: {
    url: string;
    send_to_kag?: boolean;
  }): Promise<KagRefreshResult | PendingAction | unknown> {
    return await postWriteAction<PendingAction>('/api/tools/kag/scrape/refresh', body);
  },
  async scrapeSitemap(body: {
    sitemap_url: string;
    max_urls?: number;
    send_to_kag?: boolean;
    delay?: number;
    timeout?: number;
    allowed_domains?: string[];
  }): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      '/api/tools/kag/scrape/sitemap',
      body,
    );
  },
  // Scrape a list of URLs as one source. auth_config scrapes the whole batch behind
  // one login (persisted + refreshable); send_to_kag ingests each page into the graph.
  async scrapeBulk(body: {
    urls: string[];
    scraper_type?: string;
    send_to_kag?: boolean;
    delay?: number;
    timeout?: number;
    auth_config?: { credential_id: string } & Record<string, unknown>;
  }): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>('/api/tools/kag/scrape/bulk', body);
  },
  // Refresh a multi-page (sitemap/crawl/bulk) source: re-enumerate a sitemap (or
  // re-scrape a crawl/bulk source's known pages) and re-ingest only changed pages.
  async refreshSourceMulti(body: {
    base_url: string;
    session_type: 'sitemap' | 'crawl' | 'bulk';
  }): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      '/api/tools/kag/scrape/refresh-source',
      body,
    );
  },
  async pauseSession(sessionId: string): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}/pause`,
      undefined,
    );
  },
  async resumeSession(sessionId: string): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}/resume`,
      undefined,
    );
  },
  async cancelSession(sessionId: string): Promise<PendingAction | unknown> {
    const res = await authFetch(
      `/api/tools/kag/scrape/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Envelope<unknown>) : null;
    if (!res.ok) {
      throw new Error(parsed?.error?.message ?? `${res.status} ${res.statusText}`);
    }
    return parsed?.data ?? null;
  },
  async retryFailedBatch(batchId: string): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      `/api/tools/kag/documents/batch/${encodeURIComponent(batchId)}/retry-failed`,
      undefined,
    );
  },

  // --- Document-ingestion job queue (PR-F P2-2) -----------------------------
  // Distinct from `getDocumentJob` above (which hits `/api/tools/kag/...`): the
  // queue list/delete/clear go through the `/api/assets/kag/ingest/documents/jobs`
  // BFF write passthroughs. List is a read; delete/clear are admin-gated upstream.
  async listDocumentJobs(): Promise<KagRecord[]> {
    const raw = await assetFetch<unknown>(
      '/api/assets/kag/ingest/documents/jobs',
    );
    return extractArray(raw, ['jobs', 'items', 'data', 'results']);
  },
  async deleteDocumentJob(jobId: string): Promise<unknown> {
    const res = await authFetch(
      `/api/assets/kag/ingest/documents/jobs/${encodeURIComponent(jobId)}`,
      { method: 'DELETE' },
    );
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Envelope<unknown>) : null;
    if (!res.ok) {
      throw new Error(parsed?.error?.message ?? `${res.status} ${res.statusText}`);
    }
    return parsed?.data ?? null;
  },
  async clearDocumentJobs(): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      '/api/assets/kag/ingest/documents/jobs/clear',
      undefined,
    );
  },

  // --- Orchestrated-pipeline job control (P2-5) -----------------------------
  // Drive one KAG ingestion as a tracked pipeline job through the
  // `/api/assets/kag/pipeline/jobs*` BFF write passthroughs. Submit + status are
  // the read/poll surface; cancel/resume/delete are admin-gated upstream.
  async submitPipeline(body: Record<string, unknown>): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>('/api/assets/kag/pipeline/jobs', body);
  },
  async getJobStatus(jobId: string): Promise<KagRecord> {
    const raw = await assetFetch<unknown>(
      `/api/assets/kag/pipeline/jobs/${encodeURIComponent(jobId)}`,
    );
    return (raw && typeof raw === 'object' ? raw : {}) as KagRecord;
  },
  async cancelJob(jobId: string): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      `/api/assets/kag/pipeline/jobs/${encodeURIComponent(jobId)}/cancel`,
      undefined,
    );
  },
  async resumeJob(jobId: string): Promise<PendingAction | unknown> {
    return await postWriteAction<PendingAction>(
      `/api/assets/kag/pipeline/jobs/${encodeURIComponent(jobId)}/resume`,
      undefined,
    );
  },
  async deleteJob(jobId: string): Promise<unknown> {
    const res = await authFetch(
      `/api/assets/kag/pipeline/jobs/${encodeURIComponent(jobId)}`,
      { method: 'DELETE' },
    );
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Envelope<unknown>) : null;
    if (!res.ok) {
      throw new Error(parsed?.error?.message ?? `${res.status} ${res.statusText}`);
    }
    return parsed?.data ?? null;
  },
};

export function isPending(v: unknown): v is PendingAction {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { status?: unknown }).status === 'pending'
  );
}

// ---------------------------------------------------------------------------
// Graph-explorer read client
//
// Read-only surface backing the "Explore graph" tab. Everything here goes
// through `assetFetch` (unwraps `{ data }`, throws `AssetError` on failure) and
// the tenant-scoped `/api/assets/kag/*` proxies. Shapes are kept loose on
// purpose — upstream node/relationship payloads vary across call sites and are
// normalised in the graph components (`pickId`/`pickRel`), so we thread the raw
// records through rather than over-typing them here.
// ---------------------------------------------------------------------------

export type KagRecord = Record<string, unknown>;

/**
 * One page of KAG entities, plus what is known about the set it came from.
 *
 * The count is deliberately a discriminated `ListCount` rather than a
 * `total: number` — "we do not know how many there are" is a distinct answer
 * from "there are N", and collapsing the two into a number is what lets a
 * truncated directory render as a complete one.
 */
export interface KagEntitiesPage {
  items: KagRecord[];
  /** What the source claims about the FULL set, narrowed by any local cap. */
  count: ListCount;
  /** True when THIS client dropped rows to honour `limit`. */
  clientCapped: boolean;
}

export interface KagGraphSlice {
  nodes: KagRecord[];
  relationships: KagRecord[];
  total_results?: number;
  query_text?: string;
}

export interface KagGraphStats {
  // Upstream field names vary by graph-adapter version; read defensively.
  [key: string]: unknown;
}

// Distinct labels + counts for the legend/filter. Upstream returns either a
// bare list of label strings or a list of `{ label|type, count }` objects; the
// component normalises, so we surface it untyped.
export type KagNodeTypes = unknown;

function toSlice(raw: unknown): KagGraphSlice {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as KagRecord;
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as KagRecord[]) : [];
  const relationships = Array.isArray(obj.relationships)
    ? (obj.relationships as KagRecord[])
    : [];
  return {
    nodes,
    relationships,
    total_results:
      typeof obj.total_results === 'number' ? obj.total_results : undefined,
    query_text: typeof obj.query_text === 'string' ? obj.query_text : undefined,
  };
}

// A graph-traversal envelope (`/graph-query`) wraps its result as
//   { results: [ { path: { nodes: [...], relationships: [...] } }, ... ] }
// (verified live against graph-adapter). Older/alternate shapes return a bare
// {nodes, relationships} or a flat mixed `results` list. Handle all three, and
// de-dupe across the (often overlapping) paths.
function sliceFromTraversal(raw: unknown): KagGraphSlice {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as KagRecord;
  // Alternate shape: already split.
  if (Array.isArray(obj.nodes) || Array.isArray(obj.relationships)) {
    return toSlice(obj);
  }
  const results = Array.isArray(obj.results)
    ? (obj.results as KagRecord[])
    : Array.isArray(raw)
      ? (raw as KagRecord[])
      : [];

  const nodesById = new Map<string, KagRecord>();
  const relsByKey = new Map<string, KagRecord>();
  const hasEndpoints = (r: KagRecord) =>
    ('source' in r || 'start' in r || 'source_id' in r || 'start_node_id' in r) &&
    ('target' in r || 'end' in r || 'target_id' in r || 'end_node_id' in r);
  const idOf = (r: KagRecord) => {
    for (const k of ['id', 'entity_id', 'node_id', 'element_id']) {
      if (typeof r[k] === 'string' && (r[k] as string).length > 0) return r[k] as string;
    }
    return '';
  };
  const takeNode = (n: unknown) => {
    if (n && typeof n === 'object') {
      const id = idOf(n as KagRecord);
      if (id && !nodesById.has(id)) nodesById.set(id, n as KagRecord);
    }
  };
  const takeRel = (r: unknown) => {
    if (r && typeof r === 'object') {
      const rr = r as KagRecord;
      const key = `${rr.start_node_id ?? rr.source ?? rr.start}__${rr.type ?? ''}__${rr.end_node_id ?? rr.target ?? rr.end}`;
      if (!relsByKey.has(key)) relsByKey.set(key, rr);
    }
  };

  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const path = (item as KagRecord).path;
    if (path && typeof path === 'object') {
      const p = path as KagRecord;
      if (Array.isArray(p.nodes)) p.nodes.forEach(takeNode);
      const rels = (p.relationships ?? p.edges) as unknown;
      if (Array.isArray(rels)) rels.forEach(takeRel);
      continue;
    }
    // Flat mixed-list fallback.
    if (hasEndpoints(item as KagRecord)) takeRel(item);
    else if (idOf(item as KagRecord)) takeNode(item);
  }
  return {
    nodes: Array.from(nodesById.values()),
    relationships: Array.from(relsByKey.values()),
  };
}

function extractArray(raw: unknown, keys: string[]): KagRecord[] {
  if (Array.isArray(raw)) return raw as KagRecord[];
  if (raw && typeof raw === 'object') {
    const obj = raw as KagRecord;
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k] as KagRecord[];
    }
  }
  return [];
}

export interface HierarchicalResult {
  query?: string;
  results: KagRecord[];
  total_results?: number;
  processing_time_ms?: number;
}

/** A document-centric view: the document's subgraph + its precise passages. */
export interface DocumentSubgraph extends KagGraphSlice {
  /** Chunk-level hierarchical-retrieval hits for this document (source-located). */
  chunks: KagRecord[];
  /**
   * false ⇒ the hierarchical-retrieval read FAILED and `chunks` is an
   * artefact of that failure, not a measurement.
   *
   * Without this the caller cannot tell "this document has no passages" from
   * "the retriever is down", and `chunks.length === 0` renders the second as
   * the first — an indexing/serving outage presented as "this document
   * contains nothing". Mirrors the per-input availability flags the read-model
   * envelope uses (`available` in `$lib/types/read-model`); a boolean rather
   * than a Block because this fetch is client-owned and has one input.
   */
  chunks_available: boolean;
}

/** The "never blank" overview seeded from a handful of DOCUMENT nodes and expanded. */
export interface KagOverviewSlice extends KagGraphSlice {
  /**
   * false ⇒ at least one seed's neighbourhood expand FAILED and the merged
   * slice is missing that seed's edges — it is not a measurement that those
   * documents have no connections.
   *
   * Without this the caller cannot tell "these documents have few/no
   * relationships" from "the traversal upstream is degraded for some seeds",
   * and a partial or total outage renders as a thinner-than-expected (or
   * empty) graph instead of a reported degrade. Mirrors `chunks_available`
   * above and the per-input availability flags the read-model envelope uses
   * (`available` in `$lib/types/read-model`).
   */
  expansions_available: boolean;
  /** How many of the seed expands rejected. 0 on a fully healthy overview. */
  expansions_failed: number;
  /** How many seed expands were attempted (0 when there were no DOCUMENT seeds at all). */
  expansions_attempted: number;
}

/**
 * Bulk graph export snapshot — the read-only Graph-Adapter `POST /graph/bulk/export`
 * response (nodes + relationships, plus counts/timing). Persists nothing upstream.
 */
export interface KagBulkExport {
  nodes: KagRecord[];
  relationships: KagRecord[];
  node_count: number;
  relationship_count: number;
  execution_time_ms?: number;
  metadata?: KagRecord;
}

/** Resolved scrape-session provenance for a chunk (see `kagGraphApi.sourcePage`). */
export interface KagSourcePage {
  found: boolean;
  session_id: string | null;
  url: string | null;
  has_screenshot: boolean;
  image_count: number;
  has_images: boolean;
}

export const kagGraphApi = {
  /** Graph-wide counts for the stat tiles. */
  async stats(): Promise<KagGraphStats> {
    return await assetFetch<KagGraphStats>('/api/assets/kag/graph/stats');
  },

  /**
   * The tenant's DOCUMENT nodes, for the document-centric picker. Bounded to the
   * DOCUMENT label (the proxy strips other params — do NOT rely on limit/offset;
   * cap the list client-side). Returns the raw normalised node records.
   */
  async documents(): Promise<KagRecord[]> {
    const raw = await assetFetch<unknown>(
      '/api/assets/kag/graph/nodes?label=DOCUMENT&limit=500',
    );
    return extractArray(raw, ['items', 'nodes', 'data', 'results']);
  },

  /** Resolve a single node by id (full record). */
  async node(nodeId: string): Promise<KagRecord> {
    return await assetFetch<KagRecord>(
      `/api/assets/kag/graph/nodes/${encodeURIComponent(nodeId)}`,
    );
  },

  /**
   * Resolve a single relationship (edge) by id — the authoritative
   * `EdgeResponse { id, relationship_type, source_id, target_id, properties }`.
   * Used to enrich an edge whose canvas record was too thin to carry its props.
   */
  async edge(edgeId: string): Promise<KagRecord> {
    return await assetFetch<KagRecord>(
      `/api/assets/kag/graph/edges/${encodeURIComponent(edgeId)}`,
    );
  },

  /**
   * List relationships, optionally filtered by endpoint/type — the upstream
   * `GET /graph/edges?source_id=&target_id=&edge_type=`. Used to recover an
   * edge's full properties when the loaded record lacked a stable id. Returns
   * the normalised edge records (never throws on shape — empty array on miss).
   */
  async edges(filter: {
    sourceId?: string;
    targetId?: string;
    edgeType?: string;
    limit?: number;
  } = {}): Promise<KagRecord[]> {
    const q = new URLSearchParams();
    if (filter.sourceId) q.set('source_id', filter.sourceId);
    if (filter.targetId) q.set('target_id', filter.targetId);
    if (filter.edgeType) q.set('edge_type', filter.edgeType);
    q.set('limit', String(filter.limit ?? 50));
    const raw = await assetFetch<unknown>(`/api/assets/kag/graph/edges?${q.toString()}`);
    return extractArray(raw, ['edges', 'items', 'data', 'results']);
  },

  /**
   * Hierarchical (sentence/paragraph-level) retrieval — more precise passages
   * than the document-level `/ask`. Optionally scoped to one `documentId`.
   */
  async hierarchicalRetrieval(body: {
    query: string;
    documentId?: string;
    levels?: string[];
    topK?: number;
  }): Promise<HierarchicalResult> {
    const raw = await assetFetch<KagRecord>('/api/assets/kag/hierarchical-retrieval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: body.query,
        document_id: body.documentId,
        levels: body.levels ?? ['sentence', 'paragraph'],
        top_k: body.topK ?? 10,
      }),
    });
    return {
      query: typeof raw?.query === 'string' ? raw.query : body.query,
      results: extractArray(raw, ['results', 'chunks', 'passages']),
      total_results: typeof raw?.total_results === 'number' ? raw.total_results : undefined,
      processing_time_ms:
        typeof raw?.processing_time_ms === 'number' ? raw.processing_time_ms : undefined,
    };
  },

  /**
   * Document-centric subgraph: the document's chunks + linked entities (via the
   * bounded traversal already used by `overview`/`expand`) plus its precise
   * passages (hierarchical retrieval scoped to the document). The passages are
   * returned as a side channel so the peek/detail can trace a concept to its
   * exact source location without re-hitting `/ask`.
   */
  async documentSubgraph(
    docId: string,
    query?: string,
  ): Promise<DocumentSubgraph> {
    // The retrieval is deliberately non-fatal — a retriever outage must not
    // blank the document's graph slice, which is read from a different upstream
    // and is still good. But it must not be SILENT either: swallowing to
    // `results: []` made a failed read return the same value as a document with
    // genuinely no passages, so the caller rendered an outage as "this document
    // contains nothing". Keep degrading; carry the fact that it degraded.
    const [slice, hier] = await Promise.all([
      this.expand(docId, { maxHops: 1, maxNodes: 40 }),
      this.hierarchicalRetrieval({
        query: query && query.trim().length > 0 ? query : 'summary of this document',
        documentId: docId,
        topK: 20,
      }).then(
        (r) => ({ results: r.results, available: true }),
        () => ({ results: [] as KagRecord[], available: false }),
      ),
    ]);
    return { ...slice, chunks: hier.results, chunks_available: hier.available };
  },

  /**
   * A "never blank" starting view. Unbounded `/graph/nodes` returns every node
   * WITH its embedding vector (megabytes) and times out, so instead seed from
   * the bounded DOCUMENT set and expand a few docs for real connectivity — a
   * "start from your sources" overview. Falls back to the bare document nodes if
   * traversal yields nothing.
   */
  async overview(maxNodes = 60): Promise<KagOverviewSlice> {
    // Bounded: cap the DOCUMENT seed fetch (the proxy honours `limit`) so a large
    // library can't return an oversized payload (DOCUMENT nodes can carry embedding
    // vectors). Do NOT swallow a fetch FAILURE into an empty slice — let assetFetch
    // throw so the tab renders an error state instead of the misleading "Nothing to
    // show yet" empty CTA. A genuine empty graph still returns [] (200 → no throw).
    //
    // The seed expands are a DIFFERENT failure shape: with 4 seeds, one bad
    // traversal must not blank the other three's real connectivity — that was
    // tried (a blanket `Promise.all` rejection) and is itself the regression an
    // adversarial audit caught, because it turns ONE degraded seed into a total
    // outage for the tab. So: `Promise.allSettled`, keep every seed that
    // resolved, and COUNT what failed rather than either swallowing it (silent
    // degrade — the original defect this file's history is about) or
    // propagating it (availability regression). `expansions_available` +
    // `expansions_failed`/`expansions_attempted` let the consumer tell "these
    // documents have few edges" from "the traversal upstream is degraded",
    // whether that degrade is partial or total.
    const rawDocs = await assetFetch<unknown>(
      '/api/assets/kag/graph/nodes?label=DOCUMENT&limit=200',
    );
    const docs = extractArray(rawDocs, ['items', 'nodes', 'data', 'results']);
    if (docs.length === 0) {
      return {
        nodes: [],
        relationships: [],
        expansions_available: true,
        expansions_failed: 0,
        expansions_attempted: 0,
      };
    }

    const seeds = docs
      .slice(0, 4)
      .map((d, i) => nodeIdOf(d, i))
      .filter(Boolean);
    const settled = await Promise.allSettled(
      seeds.map((id) => this.expand(id, { maxHops: 2, maxNodes: 18 })),
    );
    const slices = settled.filter(
      (s): s is PromiseFulfilledResult<KagGraphSlice> => s.status === 'fulfilled',
    ).map((s) => s.value);
    const expansionsFailed = settled.length - slices.length;
    const expansionsAvailable = expansionsFailed === 0;

    const nodesById = new Map<string, KagRecord>();
    const relsByKey = new Map<string, KagRecord>();
    for (const s of slices) {
      for (const n of s.nodes) {
        const id = nodeIdOf(n);
        if (id && !nodesById.has(id) && nodesById.size < maxNodes) nodesById.set(id, n);
      }
      for (const r of s.relationships) {
        const { source, target, type } = relEndpoints(r);
        relsByKey.set(`${source}__${type}__${target}`, r);
      }
    }
    if (nodesById.size === 0) {
      return {
        nodes: docs.slice(0, maxNodes),
        relationships: [],
        expansions_available: expansionsAvailable,
        expansions_failed: expansionsFailed,
        expansions_attempted: seeds.length,
      };
    }
    return {
      nodes: Array.from(nodesById.values()),
      relationships: Array.from(relsByKey.values()),
      expansions_available: expansionsAvailable,
      expansions_failed: expansionsFailed,
      expansions_attempted: seeds.length,
    };
  },

  /** Distinct node labels for the legend + type filter. */
  async nodeTypes(): Promise<KagNodeTypes> {
    return await assetFetch<KagNodeTypes>('/api/assets/kag/graph/node-types');
  },

  /**
   * The tenant's KAG entities, for the read-only Entities directory tab. Backs
   * the already-proxied `GET /api/assets/kag/entities` (`handleKagListEntities`,
   * a manifest wrapper over `queryGraphNodes`) which envelopes as
   * `{ data: { items, total } }` — `assetFetch` unwraps `data`, so we read
   * `items` here (with defensive fallbacks).
   *
   * Accepted server-side params: the proxy's schema forwards ONLY `label`
   * (and `properties`) upstream and strips everything else — so a `node_type`
   * facet maps to `label`. Free-text `query` filtering and `limit` are NOT
   * honoured server-side; the tab applies those client-side. We still accept
   * them on the signature: `limit` caps the returned list here (guards the DOM
   * against an unbounded graph), and `query` is threaded through for the caller
   * to filter on the normalised name/type/id.
   *
   * ⛔ RETURNS A PAGE, NOT A BARE ARRAY — and that is the point. This used to
   * end `return items.slice(0, params.limit)`, silently dropping rows with no
   * signal of any kind, so a truncated directory was indistinguishable from a
   * complete one. A caller handed only an array has NOTHING to render the
   * difference with, so the honest shape has to reach the caller.
   *
   * `count` is what the SOURCE claims about the whole set (see
   * `$lib/api/list-count` for why a bare `total` is not believed), narrowed by
   * the client-side cap applied here. `clientCapped` says whether THIS function
   * dropped rows, which is a different fact from the server having more.
   */
  async entities(
    params?: { query?: string; node_type?: string; limit?: number },
  ): Promise<KagEntitiesPage> {
    const sp = new URLSearchParams();
    if (params?.node_type) sp.set('label', params.node_type);
    const qs = sp.toString();
    const raw = await assetFetch<unknown>(
      `/api/assets/kag/entities${qs ? `?${qs}` : ''}`,
    );
    const all = extractArray(raw, ['items', 'nodes', 'data', 'results']);
    const cap = typeof params?.limit === 'number' ? params.limit : null;
    const clientCapped = cap !== null && all.length > cap;
    const items = cap !== null ? all.slice(0, cap) : all;
    return {
      items,
      clientCapped,
      count: withClientCap(readListCount(raw, all.length), all.length, clientCapped),
    };
  },

  /** Seed the graph from a natural-language query (returns nodes + rels). */
  async search(queryText: string, limit = 25): Promise<KagGraphSlice> {
    const raw = await assetFetch<unknown>('/api/assets/kag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withOpenProject({ query_text: queryText, limit })),
    });
    return toSlice(raw);
  },

  /** Expand a node's k-hop neighbourhood (progressive disclosure). */
  async expand(
    nodeId: string,
    opts: { maxHops?: number; maxNodes?: number } = {},
  ): Promise<KagGraphSlice> {
    const raw = await assetFetch<unknown>('/api/assets/kag/graph-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: nodeId,
        query_type: 'graph_traversal',
        parameters: {
          max_hops: opts.maxHops ?? 1,
          max_nodes: opts.maxNodes ?? 25,
        },
        limit: opts.maxNodes ?? 25,
      }),
    });
    return sliceFromTraversal(raw);
  },

  /** Nodes semantically similar to a given node. */
  async similar(nodeId: string, topK = 10): Promise<KagRecord[]> {
    const raw = await assetFetch<KagRecord>('/api/assets/kag/similar-nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, top_k: topK }),
    });
    const arr = (raw?.similar_nodes ?? raw?.nodes ?? raw?.results) as unknown;
    return Array.isArray(arr) ? (arr as KagRecord[]) : [];
  },

  /** Community detection — colour nodes by cluster ("themes"). */
  async communities(
    algorithm = 'louvain',
  ): Promise<KagRecord> {
    return await assetFetch<KagRecord>(
      '/api/assets/kag/graph/analytics/community',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm }),
      },
    );
  },

  /** Centrality — rank the most important concepts. */
  async centrality(algorithm = 'pagerank'): Promise<KagRecord> {
    return await assetFetch<KagRecord>(
      '/api/assets/kag/graph/analytics/centrality',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm }),
      },
    );
  },

  /**
   * Source provenance for a concept: the passages that mention it, plus a
   * one-line synthesis. Routed through the RAG /ask endpoint because that is
   * the path whose chunks carry full source metadata (doc_id/title/url/page/
   * score). We template the entity label into a question so upstream retrieval
   * fires; the answer is a bonus summary, the chunks are the point.
   */
  async provenance(
    label: string,
  ): Promise<{ answer?: string; chunks: KagRecord[] }> {
    const raw = await assetFetch<KagRecord>('/api/assets/kag/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        withOpenProject({
          query: `What do the sources say about "${label}"?`,
          mode: 'hybrid_rerank',
        }),
      ),
    });
    const answer = typeof raw?.answer === 'string' ? raw.answer : undefined;
    const raw3 = raw?.chunks ?? raw?.citations ?? raw?.sources;
    const chunks = Array.isArray(raw3) ? (raw3 as KagRecord[]) : [];
    return { answer, chunks };
  },

  /**
   * Resolve a chunk's source page: given the chunk's `doc_id` and/or `url`, ask
   * the read-only resolver which scrape session it came from (+ whether a
   * screenshot exists). Powers the "view source page" jump from a `KagChunkCard`
   * to the scraped-page screenshot (`KagSessionView`). `found:false` is the
   * normal answer for a non-scraped chunk (e.g. an uploaded document) — the
   * caller simply hides the affordance.
   */
  async sourcePage(params: { docId?: string; url?: string }): Promise<KagSourcePage> {
    const q = new URLSearchParams();
    if (params.docId) q.set('doc_id', params.docId);
    if (params.url) q.set('url', params.url);
    return await assetFetch<KagSourcePage>(
      `/api/assets/kag/provenance/source-page?${q.toString()}`,
    );
  },

  /** Path finding — "how are X and Y related?" */
  async path(
    sourceId: string,
    targetId: string,
    pathType = 'shortest',
  ): Promise<KagRecord> {
    return await assetFetch<KagRecord>('/api/assets/kag/graph/analytics/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: sourceId,
        target_id: targetId,
        path_type: pathType,
      }),
    });
  },

  /**
   * Bulk graph export — the read-only Graph-Adapter `POST /graph/bulk/export`.
   * Returns the whole tenant graph snapshot (nodes + relationships) for a
   * backend-mediated JSON download. Mutates nothing upstream.
   */
  async bulkExport(
    body: { include_relationships?: boolean } = {},
  ): Promise<KagBulkExport> {
    return await assetFetch<KagBulkExport>('/api/assets/kag/graph/bulk/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
};

// ---------------------------------------------------------------------------
// Capability info reads
//
// Read-only "what can this platform do" surface backing the "Formats & models"
// tab. Both hit already-registered GET proxies under `/api/assets/kag/*` and go
// through `assetFetch` (unwraps `{ data }`, throws `AssetError`). Upstream list
// items are loose bags (`{ [k]: unknown }`), so we surface them as `KagRecord[]`
// and let the component render defensively (probe common keys, key/value fall
// back). No writes here — strictly listing.
// ---------------------------------------------------------------------------

export interface KagFormatsResult {
  formats: KagRecord[];
  total_count?: number;
}

export interface KagModelsResult {
  models: KagRecord[];
  loaded_models?: string[];
  available_models?: string[] | null;
  current_model?: string | null;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? (v.filter((x) => typeof x === 'string') as string[])
    : undefined;
}

export const kagInfoApi = {
  /** Supported ingestion/document formats (+ a total count). */
  async formats(): Promise<KagFormatsResult> {
    const raw = await assetFetch<KagRecord>('/api/assets/kag/formats');
    return {
      formats: extractArray(raw, ['formats', 'items', 'data', 'results']),
      total_count:
        typeof raw?.total_count === 'number' ? (raw.total_count as number) : undefined,
    };
  },

  /** Available ML/embedding models, surfacing which are loaded/active. */
  async mlModels(): Promise<KagModelsResult> {
    const raw = await assetFetch<KagRecord>('/api/assets/kag/ml/models');
    return {
      models: extractArray(raw, ['models', 'items', 'data', 'results']),
      loaded_models: stringArray(raw?.loaded_models),
      available_models: stringArray(raw?.available_models) ?? null,
      current_model:
        typeof raw?.current_model === 'string' ? (raw.current_model as string) : null,
    };
  },
};

// ---------------------------------------------------------------------------
// Curated-compute client — the "Text analysis" tab (NLP) + "ML tools" (raw
// primitives). Every op is a POST read through `assetFetch` (unwraps `{ data }`,
// throws `AssetError`) against the already-proxied `/api/assets/kag/nlp/*` and
// `/api/assets/kag/ml/*` gateway routes. The KAG gateway forwards the JSON body
// verbatim, so the request FIELD NAMES here mirror the generated request models
// (`packages/service-clients/kag/src/generated/models/*Request.ts`) exactly —
// snake_case, canonical names (+ `text1/text2` similarity aliases the upstream
// also accepts). Analysis results are untyped loose bags (`unknown`); the tab
// renders them defensively rather than us over-typing shapes that vary by
// backend (PyTorch vs MLX ML-backend, spaCy NLP model, …). No writes.
// ---------------------------------------------------------------------------

/** POST a JSON body and return the unwrapped (`{ data }`) payload as `unknown`. */
async function postCompute(path: string, body: unknown): Promise<unknown> {
  return await assetFetch<unknown>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const kagComputeApi = {
  // --- Section A — Text analysis (NLP) --------------------------------------

  /** Named-entity extraction (EntityExtractionRequest: `text`). */
  async entities(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/entities', { text });
  },

  /** Full NLP parse — entities + relationships (ParseRequest: `text`). */
  async parse(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/parse', { text });
  },

  /** Split into sentences/paragraphs (SegmentRequest: `text`, `mode`). */
  async segment(text: string, mode = 'sentences'): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/segment', { text, mode });
  },

  /** Language identification (LanguageDetectRequest: `text`). */
  async detectLanguage(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/detect-language', { text });
  },

  /** Text-quality assessment (TextQualityRequest: `text`). */
  async textQuality(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/text-quality', { text });
  },

  /** Entity-density metric (EntityDensityRequest: `text`). */
  async entityDensity(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/entity-density', { text });
  },

  /**
   * Semantic similarity of two texts (SimilarityRequest). Sends the canonical
   * `text_a`/`text_b` AND the `text1`/`text2` aliases the upstream also accepts,
   * for maximum compatibility across gateway versions.
   */
  async similarity(textA: string, textB: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/nlp/similarity', {
      text_a: textA,
      text_b: textB,
      text1: textA,
      text2: textB,
    });
  },

  /**
   * Rank candidate texts against a query (BatchSimilarityRequest:
   * `query_text`, `candidate_texts`). Backs the already-proxied
   * `/api/assets/kag/batch-similarity` route.
   */
  async batchSimilarity(queryText: string, candidateTexts: string[]): Promise<unknown> {
    return await postCompute('/api/assets/kag/batch-similarity', {
      query_text: queryText,
      candidate_texts: candidateTexts,
    });
  },

  // --- Section C — Pipeline stages (PR-F write passthroughs) ----------------
  // KARMA enrichment + HiRAG decomposition. Unlike the NLP/ML ops above these
  // mutate upstream (Postgres + Neo4j), but the BFF still returns the pipeline
  // result wrapped in `{ data }`, so `postCompute` unwraps it the same way. The
  // result bag is untyped (varies by pipeline) → rendered defensively in the tab.

  /** KARMA document enrichment → entities + triples (EnrichRequest: `text`). */
  async enrich(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/process/enrich', { text });
  },

  /** HiRAG hierarchical decomposition (DecomposeRequest: `text`). */
  async decompose(text: string): Promise<unknown> {
    return await postCompute('/api/assets/kag/process/decompose', { text });
  },

  // --- Section B — ML tools (raw primitives) --------------------------------

  /** List ML-backend models (GET, already proxied). Returns the raw payload. */
  async listMlModels(): Promise<unknown> {
    return await assetFetch<unknown>('/api/assets/kag/ml/models');
  },

  /** Generate embeddings (EmbeddingsRequest: `texts`, `model?`, `normalize?`). */
  async embeddings(
    texts: string[],
    opts: { model?: string; normalize?: boolean } = {},
  ): Promise<unknown> {
    const body: Record<string, unknown> = { texts };
    if (opts.model) body.model = opts.model;
    if (opts.normalize !== undefined) body.normalize = opts.normalize;
    return await postCompute('/api/assets/kag/ml/embeddings', body);
  },

  /**
   * Cosine/euclidean/dot similarity of two raw vectors (MLSimilarityRequest:
   * `embedding_a`, `embedding_b`, `metric?`).
   */
  async mlSimilarity(
    embeddingA: number[],
    embeddingB: number[],
    metric?: string,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      embedding_a: embeddingA,
      embedding_b: embeddingB,
    };
    if (metric) body.metric = metric;
    return await postCompute('/api/assets/kag/ml/similarity', body);
  },

  /**
   * Scaled dot-product attention (AttentionRequest: `query_embedding`,
   * `key_embeddings`, `num_heads?`, `temperature?`).
   */
  async attention(
    queryEmbedding: number[],
    keyEmbeddings: number[][],
    opts: { numHeads?: number; temperature?: number } = {},
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      query_embedding: queryEmbedding,
      key_embeddings: keyEmbeddings,
    };
    if (opts.numHeads !== undefined) body.num_heads = opts.numHeads;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    return await postCompute('/api/assets/kag/ml/attention', body);
  },
};
