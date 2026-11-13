// The requirements_management routes fr only RELAYS — one table, one handler.
//
// Each row is an RM operation (keyed by its GENERATED name: `get<Name>Url` is its
// URL builder, `OPERATIONS[name]` its method / path / query / body as RM's
// openapi.json declares them) plus what fr adds around the relay. Everything
// else — method, which query keys exist, path parameters — is RM's declaration,
// read from the generated client; nothing about RM's operations is hand-kept.
//
// The fr path, the capability contract (summary, declared input) and the
// handler export stay where they were (capabilities/library/*, the route
// module's `export const handleX = rmPassthrough('…')`), so the served spec and
// every route are unchanged.
//
// What fr adds, per row:
//   * `family` — the conventions of the module the route belongs to:
//       'proxy'    (architecture CRUD, TOC, asset search/versions): every query
//                  key the caller sent forwarded verbatim, a body is any JSON
//                  value (an empty or unparseable one is a 400), the plain JSON
//                  transport (`rmJson`: GET / DELETE retried on 502/503/504 or a
//                  timeout, POST never), refusals through the generic converter
//                  (`handle`), a delete is an empty 204;
//       'modeling' (models, UML, view contents, trace links): query values
//                  trimmed and empty ones dropped, RM refusals in plain words
//                  (`modelingHandle` / `modelingRefusal`).
//   * `ok`         — fr's success status (default 200; 204 = empty body).
//   * `pageCap`    — a list: fr's page cap is sent as `limit` and reported in
//                    `X-Applied-Limit` / `X-Truncated` (page-cap.ts).
//   * `query`      — fr's own parse of the caller's query, replacing the family's
//                    (the asset searches forward only `q` and an integer `k`).
//   * `rawIds`     — path ids go to RM as the route received them, not encoded.
//   * `body`       — the JSON body is forwarded (a modeling body must be an
//                    object; minus fr's `expected_head` when `ifMatch`).
//   * `ifMatch`    — the caller's `If-Match` (or body `expected_head`) is forwarded.
//   * `idempotencyKey` — the caller's `Idempotency-Key` is forwarded.
//   * `etag`       — RM's `ETag` (a model head) is relayed.
//   * `fixedQuery` — query values fr always sends (e.g. `report=true`).
//   * `slow`       — the longer timeout (render, export, apply).
//   * `empty`      — what an empty RM answer renders as inside `{ data }`.
//
// Downloads (`RM_DOWNLOADS` / `rmDownload`): a rendered diagram (SVG, PNG, PDF),
// a model's diagrams in one file (a PDF, or a zip of SVGs) and a UML model's
// XMI. RM's bytes are relayed as RM sent them, with RM's `Content-Type` and
// `Content-Disposition`; the format is the fr route's, fixed per route (each fr
// route serves exactly one media type).
//
// Anything with fr logic of its own (system-tenant unions, write gates,
// read-modify-write updates, validators, caches, the model delete's `force`)
// is NOT here; its route module keeps a hand-written handler.

import { z } from 'zod';
import { validateAuth } from '../../../middleware/auth';
import { rmCall, rmJson, seg } from '../../../integrations/architecture';
import {
  OPERATIONS,
  getApplyChangeSetUrl,
  getCreateArchitectureStandardUrl,
  getCreateArchitectureViewConnectionUrl,
  getCreateArchitectureViewObjectUrl,
  getCreateTocEdgeUrl,
  getCreateTocNodeUrl,
  getCreateTocTreeUrl,
  getCreateUmlDiagramConnectionUrl,
  getCreateUmlDiagramObjectUrl,
  getCreateUmlDiagramUrl,
  getCreateUmlElementUrl,
  getCreateUmlInteractionUrl,
  getCreateUmlRelationshipUrl,
  getDeleteArchitectureElementUrl,
  getDeleteArchitectureRelationshipUrl,
  getDeleteArchitectureStandardUrl,
  getDeleteArchitectureViewConnectionUrl,
  getDeleteArchitectureViewObjectUrl,
  getDeleteArchitectureViewUrl,
  getDeleteTocEdgeUrl,
  getDeleteTocNodeUrl,
  getDeleteTocTreeUrl,
  getDeleteTraceLinkUrl,
  getDeleteUmlDiagramConnectionUrl,
  getDeleteUmlDiagramObjectUrl,
  getDeleteUmlDiagramUrl,
  getDeleteUmlElementUrl,
  getDeleteUmlInteractionUrl,
  getDeleteUmlRelationshipUrl,
  getExportModelExchangeUrl,
  getExportModelDiagramsUrl,
  getExportModelRevisionDiagramsUrl,
  getExportModelRevisionExchangeUrl,
  getExportModelRevisionXmiUrl,
  getExportModelXmiUrl,
  getGetArchitectureElementUrl,
  getGetArchitectureRelationshipUrl,
  getGetArchitectureStandardUrl,
  getGetArchitectureViewUrl,
  getGetChangeSetUrl,
  getGetModelRevisionUrl,
  getGetModelUrl,
  getGetTocTreeUrl,
  getGetTraceLinkUrl,
  getGetUmlDiagramUrl,
  getGetUmlElementUrl,
  getGetUmlInteractionUrl,
  getGetUmlProfileUrl,
  getGetUmlRelationshipUrl,
  getGetValidationRunUrl,
  getListArchimateConceptsUrl,
  getListArchitectureElementsUrl,
  getListArchitectureRelationshipsUrl,
  getListArchitectureStandardsUrl,
  getListArchitectureViewConnectionsUrl,
  getListArchitectureViewObjectsUrl,
  getListArchitectureViewsUrl,
  getListChangeSetsUrl,
  getListDecisionVersionsUrl,
  getListModelPublicationsUrl,
  getListModelRevisionReviewsUrl,
  getListModelRevisionsUrl,
  getListModelValidationRunsUrl,
  getListModelsUrl,
  getListPrincipleVersionsUrl,
  getListRulesetsUrl,
  getListTocEdgesUrl,
  getListTocNodesUrl,
  getListTocTreesUrl,
  getListTraceLinksUrl,
  getListUmlDiagramConnectionsUrl,
  getListUmlDiagramObjectsUrl,
  getListUmlDiagramsUrl,
  getListUmlElementsUrl,
  getListUmlInteractionsUrl,
  getListUmlRelationshipsUrl,
  getListValidationFindingsUrl,
  getPublishModelRevisionUrl,
  getQueryArchimateRelationshipMatrixUrl,
  getRenderArchitectureViewUrl,
  getRenderModelRevisionDiagramUrl,
  getRenderModelRevisionViewUrl,
  getRenderUmlDiagramUrl,
  getSearchDecisionsUrl,
  getSearchPrinciplesUrl,
  getSearchRequirementsUrl,
  type OperationName,
} from '@fr/service-client-requirements';
import { jsonResponse, noContentResponse } from '../../../utils/response';
import { readJsonBody } from '../../_lib';
import { handle } from './handler';
import { frameProbe, pageCapHeaders, resolveListLimit } from './page-cap';
import {
  bodyObject,
  etagHeaders,
  expectedHeadOf,
  idempotencyKeyOf,
  modelingHandle,
  pickQuery,
  withoutExpectedHead,
} from './modeling-http';

export interface Passthrough {
  /** The generated URL builder of the operation this row is keyed by. */
  url: (...args: never[]) => string;
  family: 'proxy' | 'modeling';
  ok?: 200 | 201 | 204;
  pageCap?: true;
  body?: true;
  ifMatch?: true;
  idempotencyKey?: true;
  etag?: true;
  fixedQuery?: Record<string, string | boolean>;
  query?: (sp: URLSearchParams) => Record<string, unknown> | undefined;
  rawIds?: true;
  slow?: true;
  empty?: 'list' | 'object';
}

const proxy = (url: Passthrough['url'], extra: Omit<Passthrough, 'url' | 'family'> = {}): Passthrough => ({ url, family: 'proxy', ...extra });
const modeling = (url: Passthrough['url'], extra: Omit<Passthrough, 'url' | 'family'> = {}): Passthrough => ({ url, family: 'modeling', ...extra });

/** RM's create of a modeling row: `If-Match` + `Idempotency-Key` forwarded, `ETag` relayed, 201. */
const modelingCreate = (url: Passthrough['url']) => modeling(url, { ok: 201, body: true, ifMatch: true, idempotencyKey: true, etag: true });
/** RM's delete of a modeling row: `If-Match` forwarded; RM's answer (what it removed) relayed, 200. */
const modelingDelete = (url: Passthrough['url']) => modeling(url, { ifMatch: true, etag: true, empty: 'object' });
const SVG_REPORT = { format: 'svg', report: true } as const;

// An asset search forwards `q` and `k` only (`.strip()`); a non-integer `k` is
// fr's 400. Every other key — `project_id` above all, which is fr's project
// scope and must never reach RM's provenance filter — stays in fr.
const searchParamsSchema = z
  .object({
    q: z.string().optional(),
    k: z.coerce.number().int().optional(),
  })
  .strip();
function searchQuery(sp: URLSearchParams): Record<string, unknown> | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return searchParamsSchema.parse(raw);
}
const SEARCH = { query: searchQuery } as const;
/** ArchiMate CRUD and version history send their ids to RM as received. */
const RAW = { rawIds: true } as const;

export const RM_PASSTHROUGH = {
  // --- TOC (routes/assets/toc.ts) ---------------------------------------------
  listTocTrees: proxy(getListTocTreesUrl),
  createTocTree: proxy(getCreateTocTreeUrl, { ok: 201, body: true }),
  getTocTree: proxy(getGetTocTreeUrl),
  deleteTocTree: proxy(getDeleteTocTreeUrl, { ok: 204 }),
  listTocNodes: proxy(getListTocNodesUrl),
  createTocNode: proxy(getCreateTocNodeUrl, { ok: 201, body: true }),
  deleteTocNode: proxy(getDeleteTocNodeUrl, { ok: 204 }),
  listTocEdges: proxy(getListTocEdgesUrl),
  createTocEdge: proxy(getCreateTocEdgeUrl, { ok: 201, body: true }),
  deleteTocEdge: proxy(getDeleteTocEdgeUrl, { ok: 204 }),

  // --- Search and version history (routes/assets/{requirements,decisions,principles}.ts)
  searchRequirements: proxy(getSearchRequirementsUrl, SEARCH),
  searchDecisions: proxy(getSearchDecisionsUrl, SEARCH),
  listDecisionVersions: proxy(getListDecisionVersionsUrl, RAW),
  searchPrinciples: proxy(getSearchPrinciplesUrl, SEARCH),
  listPrincipleVersions: proxy(getListPrincipleVersionsUrl, RAW),

  // --- ArchiMate CRUD (routes/assets/architecture.ts) ---------------------------
  listArchitectureElements: proxy(getListArchitectureElementsUrl, { pageCap: true }),
  getArchitectureElement: proxy(getGetArchitectureElementUrl, RAW),
  deleteArchitectureElement: proxy(getDeleteArchitectureElementUrl, { ok: 204, ...RAW }),
  listArchitectureRelationships: proxy(getListArchitectureRelationshipsUrl, { pageCap: true }),
  getArchitectureRelationship: proxy(getGetArchitectureRelationshipUrl, RAW),
  deleteArchitectureRelationship: proxy(getDeleteArchitectureRelationshipUrl, { ok: 204, ...RAW }),
  listArchitectureViews: proxy(getListArchitectureViewsUrl, { pageCap: true }),
  getArchitectureView: proxy(getGetArchitectureViewUrl, RAW),
  deleteArchitectureView: proxy(getDeleteArchitectureViewUrl, { ok: 204, ...RAW }),
  listArchitectureStandards: proxy(getListArchitectureStandardsUrl, { pageCap: true }),
  createArchitectureStandard: proxy(getCreateArchitectureStandardUrl, { ok: 201, body: true }),
  getArchitectureStandard: proxy(getGetArchitectureStandardUrl, RAW),
  deleteArchitectureStandard: proxy(getDeleteArchitectureStandardUrl, { ok: 204, ...RAW }),

  // --- ArchiMate view contents + metamodel (routes/assets/architecture-occurrences.ts)
  // RM declares no Idempotency-Key on a view's objects or connections.
  listArchitectureViewObjects: modeling(getListArchitectureViewObjectsUrl, { empty: 'list' }),
  createArchitectureViewObject: modeling(getCreateArchitectureViewObjectUrl, { ok: 201, body: true, ifMatch: true, etag: true }),
  deleteArchitectureViewObject: modelingDelete(getDeleteArchitectureViewObjectUrl),
  listArchitectureViewConnections: modeling(getListArchitectureViewConnectionsUrl, { empty: 'list' }),
  createArchitectureViewConnection: modeling(getCreateArchitectureViewConnectionUrl, { ok: 201, body: true, ifMatch: true, etag: true }),
  deleteArchitectureViewConnection: modelingDelete(getDeleteArchitectureViewConnectionUrl),
  listArchimateConcepts: modeling(getListArchimateConceptsUrl),
  queryArchimateRelationshipMatrix: modeling(getQueryArchimateRelationshipMatrixUrl, { empty: 'list' }),

  // --- Modeling lifecycle (routes/assets/architecture-modeling.ts) ---------------
  listModels: modeling(getListModelsUrl, { pageCap: true }),
  getModel: modeling(getGetModelUrl, { etag: true }),
  listModelRevisions: modeling(getListModelRevisionsUrl, { pageCap: true }),
  getModelRevision: modeling(getGetModelRevisionUrl),
  listModelRevisionReviews: modeling(getListModelRevisionReviewsUrl),
  publishModelRevision: modeling(getPublishModelRevisionUrl, { ok: 201 }),
  listModelPublications: modeling(getListModelPublicationsUrl),
  listModelValidationRuns: modeling(getListModelValidationRunsUrl, { pageCap: true }),
  getValidationRun: modeling(getGetValidationRunUrl),
  listValidationFindings: modeling(getListValidationFindingsUrl, { pageCap: true }),
  listRulesets: modeling(getListRulesetsUrl),
  listChangeSets: modeling(getListChangeSetsUrl, { pageCap: true }),
  getChangeSet: modeling(getGetChangeSetUrl),
  applyChangeSet: modeling(getApplyChangeSetUrl, { etag: true, slow: true }),
  exportModelExchange: modeling(getExportModelExchangeUrl, { etag: true, slow: true, fixedQuery: { report: true } }),
  exportModelRevisionExchange: modeling(getExportModelRevisionExchangeUrl, { slow: true, fixedQuery: { report: true } }),
  renderArchitectureView: modeling(getRenderArchitectureViewUrl, { slow: true, fixedQuery: SVG_REPORT }),
  renderModelRevisionView: modeling(getRenderModelRevisionViewUrl, { slow: true, fixedQuery: SVG_REPORT }),

  // --- UML + trace links (routes/assets/architecture-uml.ts) ---------------------
  listUmlElements: modeling(getListUmlElementsUrl, { pageCap: true }),
  createUmlElement: modelingCreate(getCreateUmlElementUrl),
  getUmlElement: modeling(getGetUmlElementUrl),
  deleteUmlElement: modelingDelete(getDeleteUmlElementUrl),
  listUmlRelationships: modeling(getListUmlRelationshipsUrl, { pageCap: true }),
  createUmlRelationship: modelingCreate(getCreateUmlRelationshipUrl),
  getUmlRelationship: modeling(getGetUmlRelationshipUrl),
  deleteUmlRelationship: modelingDelete(getDeleteUmlRelationshipUrl),
  listUmlInteractions: modeling(getListUmlInteractionsUrl, { pageCap: true }),
  createUmlInteraction: modelingCreate(getCreateUmlInteractionUrl),
  getUmlInteraction: modeling(getGetUmlInteractionUrl),
  deleteUmlInteraction: modelingDelete(getDeleteUmlInteractionUrl),
  listUmlDiagrams: modeling(getListUmlDiagramsUrl, { pageCap: true }),
  createUmlDiagram: modelingCreate(getCreateUmlDiagramUrl),
  getUmlDiagram: modeling(getGetUmlDiagramUrl),
  deleteUmlDiagram: modelingDelete(getDeleteUmlDiagramUrl),
  listUmlDiagramObjects: modeling(getListUmlDiagramObjectsUrl),
  createUmlDiagramObject: modelingCreate(getCreateUmlDiagramObjectUrl),
  deleteUmlDiagramObject: modelingDelete(getDeleteUmlDiagramObjectUrl),
  listUmlDiagramConnections: modeling(getListUmlDiagramConnectionsUrl),
  createUmlDiagramConnection: modelingCreate(getCreateUmlDiagramConnectionUrl),
  deleteUmlDiagramConnection: modelingDelete(getDeleteUmlDiagramConnectionUrl),
  renderUmlDiagram: modeling(getRenderUmlDiagramUrl, { slow: true, fixedQuery: SVG_REPORT }),
  renderModelRevisionDiagram: modeling(getRenderModelRevisionDiagramUrl, { slow: true, fixedQuery: SVG_REPORT }),
  getUmlProfile: modeling(getGetUmlProfileUrl),
  listTraceLinks: modeling(getListTraceLinksUrl, { pageCap: true }),
  getTraceLink: modeling(getGetTraceLinkUrl),
  deleteTraceLink: modeling(getDeleteTraceLinkUrl, { etag: true, empty: 'object' }),
} satisfies Partial<Record<OperationName, Passthrough>>;

type PassthroughName = keyof typeof RM_PASSTHROUGH;

/** The number of `{param}` segments in an RM path — the builder's leading arguments. */
const pathParamCount = (path: string): number => (path.match(/\{[^}]+\}/g) ?? []).length;

/**
 * The query object for the generated builder. A row's own `query` parse wins;
 * otherwise a proxy forwards every key the caller sent, verbatim, and a modeling
 * route RM's declared keys, trimmed, empty ones dropped. fr's page cap replaces
 * the caller's `limit`; `fixedQuery` is set last.
 */
function queryOf(name: PassthroughName, sp: URLSearchParams, limit: number | undefined): Record<string, unknown> | undefined {
  const row: Passthrough = RM_PASSTHROUGH[name];
  const out: Record<string, unknown> = row.query
    ? { ...(row.query(sp) ?? {}) }
    : row.family === 'modeling'
      ? pickQuery(sp, (OPERATIONS[name].query as readonly string[]).filter((k) => k !== 'limit'))
      : Object.fromEntries(sp.entries());
  if (limit !== undefined) out.limit = limit;
  Object.assign(out, row.fixedQuery ?? {});
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The route handler of one table row: `(req, ...pathIds)` — the ids in the
 * order of RM's path parameters, which is the order of the fr route's.
 */
export function rmPassthrough(name: PassthroughName): (req: Request, ...ids: string[]) => Promise<Response> {
  const row: Passthrough = RM_PASSTHROUGH[name];
  const op = OPERATIONS[name];
  const idCount = pathParamCount(op.path);
  return async (req: Request, ...ids: string[]): Promise<Response> => {
    await validateAuth(req);
    const sp = new URL(req.url).searchParams;
    const limit = row.pageCap ? resolveListLimit(sp) : undefined;
    const probe = row.pageCap ? frameProbe() : undefined;
    const args: unknown[] = ids.slice(0, idCount).map((id) => (row.rawIds ? id : seg(id)));
    if (op.query.length > 0) args.push(queryOf(name, sp, limit));
    const url = (row.url as (...a: unknown[]) => string)(...args);
    const respond = (data: unknown, etag: string | undefined): Response => {
      if (row.ok === 204) return noContentResponse();
      const extra = {
        ...(row.etag ? etagHeaders(etag) : {}),
        ...(limit !== undefined && probe ? pageCapHeaders(limit, probe) : {}),
      };
      return jsonResponse({ data }, row.ok ?? 200, Object.keys(extra).length > 0 ? extra : undefined);
    };

    if (row.family === 'proxy') {
      // Any JSON value, as RM receives it; an empty or unparseable body is a 400.
      const json = row.body ? await readJsonBody<unknown>(req) : undefined;
      return handle(
        async () => {
          const data = await rmJson<unknown>(url, op.method as 'GET' | 'POST' | 'DELETE', json);
          if (probe) probe.record(Array.isArray(data) ? data.length : 0);
          return data;
        },
        (data) => respond(data, undefined),
      );
    }

    const body = row.body ? await bodyObject(req) : undefined;
    const headers = {
      ...(row.ifMatch ? { 'If-Match': expectedHeadOf(req, body) } : {}),
      ...(row.idempotencyKey ? { 'Idempotency-Key': idempotencyKeyOf(req) } : {}),
    };
    const json = body === undefined ? undefined : row.ifMatch ? withoutExpectedHead(body) : body;
    return modelingHandle(
      async () => {
        const r = await rmCall<unknown>(url, {
          method: op.method,
          ...(json !== undefined ? { json } : {}),
          headers,
          ...(row.slow ? { slow: true } : {}),
        });
        if (probe) probe.record(Array.isArray(r.data) ? r.data.length : 0);
        return r;
      },
      (r) => respond(r.data ?? (row.empty === 'list' ? [] : row.empty === 'object' ? {} : undefined), r.etag),
    );
  };
}

// ---------------------------------------------------------------------------
// Downloads: RM's bytes, relayed unchanged
// ---------------------------------------------------------------------------

export const RM_DOWNLOADS = {
  renderArchitectureView: getRenderArchitectureViewUrl,
  renderModelRevisionView: getRenderModelRevisionViewUrl,
  renderUmlDiagram: getRenderUmlDiagramUrl,
  renderModelRevisionDiagram: getRenderModelRevisionDiagramUrl,
  exportModelDiagrams: getExportModelDiagramsUrl,
  exportModelRevisionDiagrams: getExportModelRevisionDiagramsUrl,
  exportModelXmi: getExportModelXmiUrl,
  exportModelRevisionXmi: getExportModelRevisionXmiUrl,
} satisfies Partial<Record<OperationName, Passthrough['url']>>;

type DownloadName = keyof typeof RM_DOWNLOADS;
/** The GENERATED query params of a download's builder: a format RM does not declare does not compile. */
type DownloadQuery<N extends DownloadName> = Exclude<Extract<Parameters<(typeof RM_DOWNLOADS)[N]>[number], object>, undefined>;

/**
 * The headers of a relayed download: RM's type and RM's disposition. Always an
 * ATTACHMENT, never sniffed and sandboxed: an SVG opened inline from fr's origin
 * would be a document in fr's origin, so anything but RM's `attachment…` (with
 * its file name) becomes a bare `attachment`.
 */
export function downloadHeaders(upstream: Headers): Record<string, string> {
  const disposition = upstream.get('content-disposition')?.trim() ?? '';
  return {
    'Content-Type': upstream.get('content-type') ?? 'application/octet-stream',
    'Content-Disposition': /^attachment\b/i.test(disposition) ? disposition : 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  };
}

/**
 * The route handler of one download: `(req, ...pathIds)` in RM's path order,
 * `query` the fixed format of this fr route (none for XMI). A refusal is the
 * modeling family's (RM's status and code, in plain words).
 */
export function rmDownload<N extends DownloadName>(name: N, query?: DownloadQuery<N>): (req: Request, ...ids: string[]) => Promise<Response> {
  const op = OPERATIONS[name];
  const idCount = pathParamCount(op.path);
  return async (req: Request, ...ids: string[]): Promise<Response> => {
    await validateAuth(req);
    const args: unknown[] = ids.slice(0, idCount).map(seg);
    if (op.query.length > 0) args.push(query);
    const url = (RM_DOWNLOADS[name] as (...a: unknown[]) => string)(...args);
    return modelingHandle(
      () => rmCall<ArrayBuffer>(url, { bytes: '*/*', slow: true }),
      (r) => new Response(r.data, { status: 200, headers: downloadHeaders(r.headers) }),
    );
  };
}
