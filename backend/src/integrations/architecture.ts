// Architecture (ArchiMate) asset integration, plus the modeling lifecycle
// (models, revisions, validation, review, exchange, rendering) at the end.
//
// The enterprise-architecture domain (elements, relationships, views,
// standards) is served by the SAME FastAPI upstream as requirements /
// principles / decisions (`requirements_management`, Service `requirements`,
// port 8921), through the generated client (`@fr/service-client-requirements`).
// The pure relays (routes/assets/_lib/rm-passthrough.ts) go through `rmJson`
// (ArchiMate CRUD, TOC, search) or `rmCall` (modeling); what stays here is
// what carries fr logic: the reads the
// gates and read-modify-write updates need, the updates themselves, the
// entity graph, the conformance tool and the modeling writes.
//
// Tenant scope is automatic: `createHttpClient` injects `X-Tenant-Id` /
// `X-User-Id` from the request context (see integrations/_lib/http-client.ts),
// and the upstream scopes by `tenant_id`.
//
// Architecture *relationships* are immutable upstream — the generated client
// ships no `getUpdateArchitectureRelationshipUrl` (edit = delete + recreate).

import { config } from '../config';
import { IntegrationError, type IntegrationErrorCode } from './_lib/errors';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import { bodyKeysOf, mergeReplacingUpdate } from './_lib/merge-update';
import {
  getGetArchitectureElementUrl,
  getGetArchitectureRelationshipUrl,
  getGetArchitectureStandardUrl,
  getGetArchitectureViewUrl,
  getGetEntityGraphUrl,
  getListArchitectureRelationshipsUrl,
  getUpdateArchitectureElementUrl,
  getUpdateArchitectureStandardUrl,
  getUpdateArchitectureViewUrl,
  PUT_BODY_PROPERTIES,
  type ArchitectureConformanceResult,
  type ArchitectureElementIn,
  type ArchitectureElementOut,
  type ArchitectureRelationshipOut,
  type ArchitectureViewIn,
  type ArchitectureViewOut,
  type ListArchitectureRelationshipsParams,
  type StandardIn,
  type StandardOut,
  type UpdateArchitectureElementHeaders,
  type UpdateArchitectureViewHeaders,
  getAnalyzeArchitectureConformanceUrl,
  getCreateModelUrl,
  getDeleteModelUrl,
  getGetChangeSetUrl,
  getGetModelUrl,
  getGetRulesetUrl,
  getGetValidationRunUrl,
  getImportExchangeAsNewModelUrl,
  getImportModelExchangeUrl,
  getPatchModelUrl,
  getRejectChangeSetUrl,
  getRenderModelRevisionDiagramUrl,
  getRenderUmlDiagramUrl,
  getReviewModelRevisionUrl,
  getRunModelValidationUrl,
  getSealModelRevisionUrl,
  type ArchitectureConformanceRequest,
  type ChangeSetOut,
  type ChangeSetReject,
  type CreateModelHeaders,
  type DeleteModelParams,
  type ExchangeImportOut,
  type ImportExchangeAsNewModelHeaders,
  type ImportModelExchangeHeaders,
  type ModelDetail,
  type ModelIn,
  type ModelOut,
  type ModelPatch,
  type PatchModelHeaders,
  type RenderUmlDiagramParams,
  type ReviewIn,
  type ReviewOut,
  type RevisionIn,
  type RevisionOut,
  type RulesetInfo,
  type SealModelRevisionHeaders,
  type ValidationRunIn,
  type ValidationRunOut,
} from '@fr/service-client-requirements';

// Architecture CRUD is synchronous upstream; fail fast on a dead upstream so
// the frontend doesn't hang (same budget as requirements).
const CRUD_TIMEOUT_MS = 30_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'requirements_management',
      baseUrl: config.services.requirements.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // requirements_management resolves the tenant from `X-Tenant-Id` alone
      // (kag_common/auth/__init__.py:409-414 "Pull the license token out of
      // `X-Tenant-Id: Bearer <token>` only"). It never reads `Authorization`.
      sendAuthorization: false,
      // fr's OWN RM licence in the ONLY header RM introspects, plus
      // `X-Effective-Tenant-Id` naming the customer tenant. Unset ⇒ every call
      // is refused before it is sent (R351 (7), `tenantBearerRequired`): no
      // plain-uuid request. See `REQUIREMENTS_SERVICE_TOKEN_ENV`.
      tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,
      tenantBearerRequired: true,
      // Never call RM without a tenant: a tenantless trusted-network call is
      // served RM's DEFAULT tenant — someone else's data — and fr must not
      // patch the gap with its own or the system tenant. No frame tenant ⇒
      // MISSING_TENANT before anything is sent (callers render 409/unavailable).
      requireTenant: true,
    });
  }
  return cachedClient;
}

// The keys each replacing PUT accepts, from the GENERATED snapshot (merge-update.ts).
const ELEMENT_IN_KEYS = bodyKeysOf<ArchitectureElementIn>()(PUT_BODY_PROPERTIES.ArchitectureElementIn);
const VIEW_IN_KEYS = bodyKeysOf<ArchitectureViewIn>()(PUT_BODY_PROPERTIES.ArchitectureViewIn);
const STANDARD_IN_KEYS = bodyKeysOf<StandardIn>()(PUT_BODY_PROPERTIES.StandardIn);

// --- Pure relays -------------------------------------------------------------

/**
 * The plain JSON transport of the pure relays (ArchiMate CRUD, TOC, asset
 * search and version history; routes/assets/_lib/rm-passthrough.ts): the body
 * only, the http client's error mapping, and its retry policy — GET and DELETE
 * are retried on 502/503/504, a timeout or a dead connection; POST never.
 */
export async function rmJson<T>(url: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
  return await http().json<T>(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

// --- Elements -------------------------------------------------------------

export async function getArchitectureElement(
  eid: string,
): Promise<ArchitectureElementOut> {
  return await http().json<ArchitectureElementOut>(getGetArchitectureElementUrl(eid), {
    method: 'GET',
  });
}

/**
 * RM's PUT replaces the element (`EntityService.update`) and checks `If-Match`
 * against its model's head: a read-modify-write under that precondition
 * (`rmUpdateModelRow`). `opts.ifMatch` is the CALLER's own expected head, when
 * it sent one; it is forwarded instead of the freshly read head.
 */
export async function updateArchitectureElement(
  eid: string,
  body: ArchitectureElementIn,
  opts: { ifMatch?: string } = {},
): Promise<RmResponse<ArchitectureElementOut>> {
  return await rmUpdateModelRow<ArchitectureElementOut, UpdateArchitectureElementHeaders>({
    putUrl: getUpdateArchitectureElementUrl(seg(eid)),
    patch: body as unknown as Record<string, unknown>,
    keys: ELEMENT_IN_KEYS,
    readCurrent: () => getArchitectureElement(eid),
    clientIfMatch: opts.ifMatch,
  });
}

// --- Relationships --------------------------------------------------------

export async function listArchitectureRelationships(
  params?: Record<string, string>,
): Promise<ArchitectureRelationshipOut[]> {
  return await http().json<ArchitectureRelationshipOut[]>(
    getListArchitectureRelationshipsUrl(
      params as ListArchitectureRelationshipsParams | undefined,
    ),
    { method: 'GET' },
  );
}

export async function getArchitectureRelationship(
  rid: string,
): Promise<ArchitectureRelationshipOut> {
  return await http().json<ArchitectureRelationshipOut>(
    getGetArchitectureRelationshipUrl(rid),
    { method: 'GET' },
  );
}

// --- Entity graph (traceability) ------------------------------------------

// One-hop neighbourhood for any 5D entity: every relationship where the
// (entityType, entityId) pair appears as source OR target. `entityType` is the
// upstream table name (`architecture_elements`, `requirements`, `decisions`,
// `principles`, `pm_*`); `entityId` is the entity UUID. The traceability route
// (control-plane roadmap Phase 8) walks this breadth-first to assemble a
// cross-domain `{nodes, links}` graph. Tenant/visibility scope is injected by
// the shared http() client, same as every other call here.
export async function getArchitectureEntityGraph(
  entityType: string,
  entityId: string,
): Promise<ArchitectureRelationshipOut[]> {
  return await http().json<ArchitectureRelationshipOut[]>(
    getGetEntityGraphUrl(entityType, entityId),
    { method: 'GET' },
  );
}

// --- Views ----------------------------------------------------------------

export async function getArchitectureView(vid: string): Promise<ArchitectureViewOut> {
  return await http().json<ArchitectureViewOut>(getGetArchitectureViewUrl(vid), {
    method: 'GET',
  });
}

/** As {@link updateArchitectureElement}: a read-modify-write under the view's model head. */
export async function updateArchitectureView(
  vid: string,
  body: ArchitectureViewIn,
  opts: { ifMatch?: string } = {},
): Promise<RmResponse<ArchitectureViewOut>> {
  return await rmUpdateModelRow<ArchitectureViewOut, UpdateArchitectureViewHeaders>({
    putUrl: getUpdateArchitectureViewUrl(seg(vid)),
    patch: body as unknown as Record<string, unknown>,
    keys: VIEW_IN_KEYS,
    readCurrent: () => getArchitectureView(vid),
    clientIfMatch: opts.ifMatch,
  });
}

// --- Standards ------------------------------------------------------------

export async function getArchitectureStandard(sid: string): Promise<StandardOut> {
  return await http().json<StandardOut>(getGetArchitectureStandardUrl(sid), {
    method: 'GET',
  });
}

export async function updateArchitectureStandard(
  sid: string,
  body: StandardIn,
): Promise<StandardOut> {
  // RM's PUT replaces (`EntityService.update`) and declares no If-Match here:
  // read-modify-write so every field this body omits keeps its stored value
  // (merge-update.ts; the GET→PUT window stays open, as documented there).
  const merged = await mergeReplacingUpdate(() => getArchitectureStandard(sid), body, STANDARD_IN_KEYS);
  return await http().json<StandardOut>(getUpdateArchitectureStandardUrl(sid), {
    method: 'PUT',
    body: JSON.stringify(merged),
  });
}

// --- Governance: conformance tool ----------------------------------------
//
// POST /architecture/tools/conformance (RM PR #31): realization coverage,
// dependency conformance and illegal-dependency detection over the project's
// ArchiMate model and the code-graph facts RM pulls itself.
//
// The response is RM's typed `ArchitectureConformanceResult` (generated client).
export type { ArchitectureConformanceResult };

export async function analyzeArchitectureConformance(body: ArchitectureConformanceRequest): Promise<ArchitectureConformanceResult> {
  return await http().json<ArchitectureConformanceResult>(getAnalyzeArchitectureConformanceUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// --- Modeling: models, revisions, validation, review, exchange, UML, trace links ----
//
// Every path, body and response type below comes from the GENERATED client
// (`@fr/service-client-requirements`, regenerated from RM's live openapi.json).
// fr adds only its own transport behaviour in `rmCall`:
//   * the modeling routes speak in RESPONSE HEADERS (`ETag` = the model's draft
//     head) and some answer XML or PNG, so the call goes through `http().fetch`
//     (tenant headers, the delegated licence and MISSING_TENANT unchanged) and
//     returns the unquoted ETag beside the body;
//   * a write is never replayed behind the caller's back (`noRetry`);
//   * an upstream error becomes an IntegrationError carrying RM's body, which
//     routes/assets/architecture-modeling.ts turns into plain words.
// Header parameters RM declares (If-Match, Idempotency-Key, X-Visibility) are
// passed as the generated `<Operation>Headers` type, never spelled ad hoc.
//
// fr only forwards: it computes no validation verdict and no review decision.

/** Synchronous upstream work (validation, rendering, import/export) gets more room than CRUD. */
const MODELING_SLOW_TIMEOUT_MS = 90_000;

interface RmResponse<T> {
  data: T;
  /** The upstream `ETag`, unquoted (a model's draft head), when RM sent one. */
  etag?: string;
  headers: Headers;
}

function rmErrorCode(status: number): IntegrationErrorCode {
  if (status === 401) return 'UPSTREAM_UNAUTHORIZED';
  if (status === 403) return 'UPSTREAM_FORBIDDEN';
  if (status === 404) return 'UPSTREAM_NOT_FOUND';
  if (status === 409) return 'UPSTREAM_CONFLICT';
  return 'UPSTREAM_BAD_STATUS';
}

/** `"12"` / `W/"12"` / `12` → `12`. */
function unquoteEtag(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return v === '' ? undefined : v;
}

/**
 * One path segment for a generated URL builder (which interpolates raw). Ids an
 * agent supplies are free text, so every segment is encoded: a `?` or `/` in an
 * id can never become a query or another route.
 */
export const seg = (v: string) => encodeURIComponent(v);

/** Header values from a generated `<Operation>Headers` object; unset ones are dropped. */
type HeaderValues = { [name: string]: string | number | null | undefined };

interface RmCallInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  json?: unknown;
  xml?: string;
  headers?: HeaderValues;
  /** The raw bytes (an image, PDF, zip or XML document) asked for with this `Accept`, instead of JSON. */
  bytes?: string;
  /** Validation, rendering, import/export: the longer timeout. */
  slow?: boolean;
}

/**
 * The stored row a replacing PUT is about to overwrite, for `mergeReplacingUpdate`
 * (merge-update.ts). `readUrl` is the generated GET for the row itself.
 */
export async function rmReadRow(readUrl: string): Promise<Record<string, unknown>> {
  return (await rmCall<Record<string, unknown>>(readUrl)).data;
}

/**
 * Same, for a row RM serves no single GET for (a view's / diagram's objects and
 * connections): read the parent's full list (RM returns every one, uncapped) and
 * pick it by id. Absent ⇒ UPSTREAM_NOT_FOUND, so no write follows a failed read.
 */
export async function rmReadListedRow(listUrl: string, id: string): Promise<Record<string, unknown>> {
  const rows = (await rmCall<unknown>(listUrl)).data;
  const row = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>).find((r) => r !== null && typeof r === 'object' && r.id === id)
    : undefined;
  if (row) return row;
  throw new IntegrationError({
    code: 'UPSTREAM_NOT_FOUND',
    message: `requirements_management: ${id} is not in ${listUrl}, so it was not updated`,
    service: 'requirements_management',
    path: listUrl,
    method: 'GET',
    upstreamStatus: 404,
  });
}

/** The draft head of a modeling model (`ModelDetail.head`, also its ETag): the value RM's `If-Match` compares. */
async function rmReadModelHead(modelId: string): Promise<string> {
  const url = getGetModelUrl(seg(modelId));
  const head = (await rmCall<ModelDetail>(url)).data?.head;
  if (typeof head === 'number' && Number.isInteger(head) && head >= 0) return String(head);
  throw new IntegrationError({
    code: 'UPSTREAM_BAD_BODY',
    message: `requirements_management: model ${modelId} carries no head, so nothing was updated`,
    service: 'requirements_management',
    path: url,
    method: 'GET',
  });
}

/**
 * The body and `If-Match` of a read-modify-write of a MODELING row (one whose
 * PUT RM checks against its model's head; merge-update.ts §Concurrent writers).
 *
 * - The caller sent its own `If-Match` ⇒ that value is the precondition: the
 *   merge is onto the row as read now, and if the model moved since the caller's
 *   copy RM refuses the write (412) instead of fr refreshing it behind them.
 * - Otherwise: read the row (for its `model_id`), read the model's head, then
 *   read the row AGAIN and merge onto that. Every write committed before the
 *   head read is in the second read; every write after it moves the head and
 *   RM refuses the PUT. Reading the head after a single row read would leave a
 *   write landing between the two reads silently reverted.
 * - The row belongs to no model (`model_id` null): RM checks nothing, so no
 *   `If-Match` is sent and the window stays open (merge-update.ts).
 */
export async function mergeUnderModelHead(u: {
  patch: Record<string, unknown>;
  keys: readonly string[];
  readCurrent: () => Promise<object>;
  clientIfMatch?: string;
}): Promise<{ body: Record<string, unknown>; ifMatch?: string }> {
  if (u.clientIfMatch !== undefined) {
    return { body: await mergeReplacingUpdate(u.readCurrent, u.patch, u.keys), ifMatch: u.clientIfMatch };
  }
  const first = (await u.readCurrent()) as { model_id?: unknown };
  const modelId = typeof first.model_id === 'string' && first.model_id !== '' ? first.model_id : undefined;
  if (modelId === undefined) {
    return { body: await mergeReplacingUpdate(async () => first, u.patch, u.keys) };
  }
  const ifMatch = await rmReadModelHead(modelId);
  return { body: await mergeReplacingUpdate(u.readCurrent, u.patch, u.keys), ifMatch };
}

/**
 * PUT a modeling row as a read-modify-write under its model's head
 * ({@link mergeUnderModelHead}). `H` is the operation's GENERATED
 * `Update<Row>Headers`, so the precondition travels as the header RM declares.
 * A 412 `stale_head` surfaces as an IntegrationError (never retried: rmCall
 * sends writes with `noRetry`), for the route to relay in plain words.
 */
export async function rmUpdateModelRow<T, H extends { 'If-Match'?: string }>(u: {
  putUrl: string;
  patch: Record<string, unknown>;
  keys: readonly string[];
  readCurrent: () => Promise<object>;
  clientIfMatch?: string;
}): Promise<RmResponse<T>> {
  const { body, ifMatch } = await mergeUnderModelHead(u);
  const headers: Pick<H, 'If-Match'> = (ifMatch !== undefined ? { 'If-Match': ifMatch } : {}) as Pick<H, 'If-Match'>;
  return await rmCall<T>(u.putUrl, { method: 'PUT', json: body, headers });
}

/** The modeling transport: fr's headers, no-retry writes, ETag unquoting and error mapping. */
export async function rmCall<T>(url: string, init: RmCallInit = {}): Promise<RmResponse<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: init.bytes ?? 'application/json' };
  for (const [k, v] of Object.entries(init.headers ?? {})) if (v !== undefined && v !== null && v !== '') headers[k] = String(v);
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.xml !== undefined) {
    headers['content-type'] = 'application/xml';
    body = init.xml;
  }
  const res = await http().fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    timeoutMs: init.slow ? MODELING_SLOW_TIMEOUT_MS : CRUD_TIMEOUT_MS,
    // Never replay a write behind the caller's back (a timed-out seal may have committed).
    ...(method === 'GET' ? {} : { noRetry: true }),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    if (text && (contentType.includes('json') || text.trimStart().startsWith('{'))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    throw new IntegrationError({
      code: rmErrorCode(res.status),
      message: `requirements_management ${method} ${url} returned ${res.status}`,
      service: 'requirements_management',
      path: url,
      method,
      upstreamStatus: res.status,
      upstreamBody: parsed,
    });
  }
  let data: unknown;
  if (res.status === 204) data = undefined;
  else if (init.bytes !== undefined) data = await res.arrayBuffer();
  else if (contentType.includes('json')) {
    const text = await res.text();
    try {
      data = text === '' ? undefined : JSON.parse(text);
    } catch (err) {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: 'requirements_management returned invalid JSON',
        service: 'requirements_management',
        path: url,
        method,
        upstreamStatus: res.status,
        upstreamBody: text.slice(0, 500),
        cause: err,
      });
    }
  } else data = await res.text();
  const etag = unquoteEtag(res.headers.get('etag'));
  return { data: data as T, headers: res.headers, ...(etag !== undefined ? { etag } : {}) };
}

// Models ---------------------------------------------------------------------

export async function createModelingModel(body: ModelIn, headers: CreateModelHeaders = {}): Promise<RmResponse<ModelOut>> {
  return await rmCall<ModelOut>(getCreateModelUrl(), { method: 'POST', json: body, headers });
}

export async function getModelingModel(modelId: string): Promise<RmResponse<ModelDetail>> {
  return await rmCall<ModelDetail>(getGetModelUrl(seg(modelId)));
}

export async function patchModelingModel(modelId: string, body: ModelPatch, headers: PatchModelHeaders = {}): Promise<RmResponse<ModelDetail>> {
  return await rmCall<ModelDetail>(getPatchModelUrl(seg(modelId)), { method: 'PATCH', json: body, headers });
}

export async function deleteModelingModel(modelId: string, params: DeleteModelParams = {}): Promise<void> {
  await rmCall<unknown>(getDeleteModelUrl(seg(modelId), params), { method: 'DELETE' });
}

// Revisions ------------------------------------------------------------------

export async function sealModelingRevision(modelId: string, body: RevisionIn, headers: SealModelRevisionHeaders = {}): Promise<RmResponse<RevisionOut>> {
  return await rmCall<RevisionOut>(getSealModelRevisionUrl(seg(modelId)), { method: 'POST', json: body, headers, slow: true });
}

// Validation -----------------------------------------------------------------

export async function runModelingValidation(modelId: string, body: ValidationRunIn): Promise<ValidationRunOut> {
  return (await rmCall<ValidationRunOut>(getRunModelValidationUrl(seg(modelId)), { method: 'POST', json: body, slow: true })).data;
}

export async function getModelingValidationRun(runId: string): Promise<ValidationRunOut> {
  return (await rmCall<ValidationRunOut>(getGetValidationRunUrl(seg(runId)))).data;
}

/**
 * A ruleset id contains '/' (`archimate-3.2/archi-5.10.0`) and RM's route is
 * `/modeling/rulesets/{ruleset_ref:path}`: the slash is sent LITERALLY, each
 * segment encoded on its own. A ref that arrives percent-encoded (fr's router
 * hands path parameters over raw) is decoded first.
 */
function rulesetRef(ref: string): string {
  let literal = ref;
  try {
    literal = decodeURIComponent(ref);
  } catch {
    // Not valid percent-encoding: it is already literal text.
    literal = ref;
  }
  return literal.split('/').map(seg).join('/');
}

export async function getModelingRuleset(ref: string): Promise<RulesetInfo> {
  return (await rmCall<RulesetInfo>(getGetRulesetUrl(rulesetRef(ref)))).data;
}

// Review and publication -----------------------------------------------------

export async function reviewModelingRevision(modelId: string, revisionId: string, body: ReviewIn): Promise<ReviewOut> {
  return (await rmCall<ReviewOut>(getReviewModelRevisionUrl(seg(modelId), seg(revisionId)), { method: 'POST', json: body })).data;
}

// Change sets ----------------------------------------------------------------

export async function getModelingChangeSet(changeSetId: string): Promise<ChangeSetOut> {
  return (await rmCall<ChangeSetOut>(getGetChangeSetUrl(seg(changeSetId)))).data;
}

export async function rejectModelingChangeSet(changeSetId: string, body: ChangeSetReject): Promise<ChangeSetOut> {
  return (await rmCall<ChangeSetOut>(getRejectChangeSetUrl(seg(changeSetId)), { method: 'POST', json: body })).data;
}

// Exchange (Open Group ArchiMate Model Exchange File Format 3.1) --------------

/**
 * Stage an exchange document as a change set: into `modelId`, or (no
 * `modelId`) into a NEW ArchiMate model RM creates. Nothing is written to the
 * model until the change set is applied.
 */
export async function importModelingExchange(opts: {
  modelId?: string;
  xml: string;
  filename?: string;
  projectId?: string;
  headers?: ImportModelExchangeHeaders & ImportExchangeAsNewModelHeaders;
}): Promise<ExchangeImportOut> {
  const url = opts.modelId
    ? getImportModelExchangeUrl(seg(opts.modelId), { filename: opts.filename })
    : getImportExchangeAsNewModelUrl({ filename: opts.filename, project_id: opts.projectId });
  return (await rmCall<ExchangeImportOut>(url, { method: 'POST', xml: opts.xml, headers: opts.headers, slow: true })).data;
}

// Rendering ------------------------------------------------------------------

/** A UML diagram's render URL: the draft (no revision) or as a sealed revision holds it. */
export function umlDiagramRenderUrl(diagramId: string, params: RenderUmlDiagramParams, revision?: { modelId: string; revisionId: string }): string {
  return revision
    ? getRenderModelRevisionDiagramUrl(seg(revision.modelId), seg(revision.revisionId), seg(diagramId), params)
    : getRenderUmlDiagramUrl(seg(diagramId), params);
}
