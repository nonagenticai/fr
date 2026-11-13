// Theory-of-Constraints (TOC / Dettmer Logical Thinking Process) integration.
//
// TOC trees (io_map / evaporating_cloud / crt / frt / prt / trt), their nodes
// and edges, the 3-level `/toc/config`, the `/toc/{id}/graph` assembly and the
// structural 8-CLR `/toc/{id}/quality` scorer are served by
// requirements_management (Service `requirements`, port 8921), through the
// generated client (`@fr/service-client-requirements`). The pure relays (list /
// get / create / delete) are rows of routes/assets/_lib/rm-passthrough.ts; this
// module keeps what carries fr logic: the read-modify-write updates and the
// cached hot reads.
//
// Tenant scope is automatic: `createHttpClient` injects `X-Tenant-Id` /
// `X-User-Id` from the request context, and the upstream scopes by `tenant_id`.
//
// fr is a *client/proxy* of `/toc`. It does NOT reimplement the TOC data
// model, the CLR scorer, or the LLM authoring — heavy "build" ops (author
// IO-Map / Evaporating-Cloud / lenses) go through the n8n AA builder
// subroutines (see `agui/actions/toc.ts`), which write trees back into RM.
//
// A 60s in-memory TTL caches the hot reads (`/graph`, `/quality`, `/config`)
// keyed on (tenantId, …). Writes are uncached.

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import { getTenantId } from './_lib/context';
import { IntegrationError } from './_lib/errors';
import { bodyKeysOf, mergeReplacingUpdate } from './_lib/merge-update';
import {
  getGetTocConfigUrl,
  getGetTocGraphUrl,
  getGetTocTreeQualityUrl,
  getGetTocTreeUrl,
  getListTocNodesUrl,
  getUpdateTocNodeUrl,
  getUpdateTocTreeUrl,
  getUpsertTocConfigUrl,
  type ArchitectureRelationshipOut,
  type ClrReport,
  type ListTocNodesParams,
  type TocGraph,
  PUT_BODY_PROPERTIES,
  type TocNodeIn,
  type TocNodeOut as TocNode,
  type TocSettingsIn,
  type TocSettingsOut as TocSettings,
  type TocTreeIn,
  type TocTreeOut as TocTree,
} from '@fr/service-client-requirements';

const seg = (v: string) => encodeURIComponent(v);

// TOC CRUD is synchronous upstream; fail fast on a dead upstream so the
// frontend doesn't hang (same budget as requirements / architecture).
const CRUD_TIMEOUT_MS = 30_000;
const TTL_MS = 60_000;

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

interface CacheEntry {
  value: unknown;
  expiresAtMs: number;
}

const readCache = new Map<string, CacheEntry>();

/**
 * The tenant a hot-read cache key is scoped to: the request frame's EXPLICIT
 * tenant, or a refusal. Never a shared `'default'` bucket — a tenantless key
 * would let one frame's cached read answer another's. Same MISSING_TENANT
 * refusal the http client gives (`requireTenant`), raised before the cache is
 * consulted, so a cache hit can never bypass it.
 */
function cacheTenant(method: string, path: string): string {
  const tenantId = getTenantId()?.trim();
  if (tenantId) return tenantId;
  throw new IntegrationError({
    code: 'MISSING_TENANT',
    message:
      'requirements_management: no tenant could be resolved for this TOC read, so it was ' +
      'neither served from cache nor sent (fail closed: fr never substitutes a default tenant)',
    service: 'requirements_management',
    path,
    method,
  });
}

function cacheGet<T>(key: string): T | undefined {
  const hit = readCache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.value as T;
  if (hit) readCache.delete(key);
  return undefined;
}

function cacheSet(key: string, value: unknown): void {
  readCache.set(key, { value, expiresAtMs: Date.now() + TTL_MS });
}

// --- Wire types: the generated client's (RM's openapi.json) ----------------

export type {
  ClrReport,
  TocEdgeIn,
  TocGraph,
  TocNodeIn,
  TocNodeOut as TocNode,
  TocSettingsIn,
  TocSettingsOut as TocSettings,
  TocTreeIn,
  TocTreeOut as TocTree,
} from '@fr/service-client-requirements';

/** RM answers a TOC edge as an architecture relationship row. */
export type TocEdge = ArchitectureRelationshipOut;

// The keys each replacing PUT accepts, from the GENERATED snapshot (merge-update.ts).
const TOC_TREE_IN_KEYS = bodyKeysOf<TocTreeIn>()(PUT_BODY_PROPERTIES.TocTreeIn);
const TOC_NODE_IN_KEYS = bodyKeysOf<TocNodeIn>()(PUT_BODY_PROPERTIES.TocNodeIn);
/** RM's `list_toc_nodes` ceiling (`le=5000`): the single-node read below asks for all of it. */
const TOC_NODE_READ_LIMIT = '5000';

// --- Trees ----------------------------------------------------------------

export async function getTocTree(treeId: string): Promise<TocTree> {
  return await http().json<TocTree>(getGetTocTreeUrl(seg(treeId)), {
    method: 'GET',
  });
}

export async function updateTocTree(
  treeId: string,
  body: TocTreeIn,
): Promise<TocTree> {
  // RM's PUT replaces (entity_service.py `update`): read-modify-write so every
  // field this body omits keeps its stored value (merge-update.ts).
  const merged = await mergeReplacingUpdate(() => getTocTree(treeId), body, TOC_TREE_IN_KEYS);
  return await http().json<TocTree>(getUpdateTocTreeUrl(seg(treeId)), {
    method: 'PUT',
    body: JSON.stringify(merged),
  });
}

// --- Nodes ----------------------------------------------------------------

export async function listTocNodes(
  treeId: string,
  params?: Record<string, string>,
): Promise<TocNode[]> {
  return await http().json<TocNode[]>(
    getListTocNodesUrl(seg(treeId), params as ListTocNodesParams | undefined),
    { method: 'GET' },
  );
}

export async function updateTocNode(
  treeId: string,
  nodeId: string,
  body: TocNodeIn,
): Promise<TocNode> {
  // RM's PUT replaces (entity_service.py `update`); it serves no single-node GET,
  // so the stored row is read from the tree's node list (merge-update.ts).
  const merged = await mergeReplacingUpdate(() => readTocNode(treeId, nodeId), body, TOC_NODE_IN_KEYS);
  return await http().json<TocNode>(
    getUpdateTocNodeUrl(seg(treeId), seg(nodeId)),
    { method: 'PUT', body: JSON.stringify(merged) },
  );
}

/** One node as stored, or UPSTREAM_NOT_FOUND — never a guess, so no write follows a failed read. */
async function readTocNode(treeId: string, nodeId: string): Promise<TocNode> {
  const nodes = await listTocNodes(treeId, { limit: TOC_NODE_READ_LIMIT });
  const node = Array.isArray(nodes) ? nodes.find((n) => n?.id === nodeId) : undefined;
  if (node) return node;
  const path = getUpdateTocNodeUrl(seg(treeId), seg(nodeId));
  throw new IntegrationError({
    code: 'UPSTREAM_NOT_FOUND',
    message: `requirements_management: TOC node ${nodeId} is not among tree ${treeId}'s nodes, so it was not updated`,
    service: 'requirements_management',
    path,
    method: 'GET',
    upstreamStatus: 404,
  });
}

// --- Edges ----------------------------------------------------------------
// Edges are create + list + delete only — the upstream ships NO edge update
// verb (edit = delete + recreate), mirroring architecture *relationships*.

// --- Graph (hot read, cached) ---------------------------------------------

export async function getTocGraph(
  treeId: string,
  opts: { fresh?: boolean } = {},
): Promise<TocGraph> {
  const tenantId = cacheTenant('GET', `/toc/${treeId}/graph`);
  const key = `graph::${tenantId}::${treeId}`;
  if (!opts.fresh) {
    const hit = cacheGet<TocGraph>(key);
    if (hit) return hit;
  }
  const value = await http().json<TocGraph>(
    getGetTocGraphUrl(seg(treeId)),
    { method: 'GET' },
  );
  cacheSet(key, value);
  return value;
}

// --- Quality (8-CLR structural scorer; POST upstream, cached) -------------
// The upstream evaluates on POST (it runs + persists the scorer), but from
// fr's perspective it's a read-shaped hot call, so it's TTL-cached too.

export async function getTocQuality(
  treeId: string,
  opts: { fresh?: boolean } = {},
): Promise<ClrReport> {
  const tenantId = cacheTenant('POST', `/toc/${treeId}/quality`);
  const key = `quality::${tenantId}::${treeId}`;
  if (!opts.fresh) {
    const hit = cacheGet<ClrReport>(key);
    if (hit) return hit;
  }
  const value = await http().json<ClrReport>(
    getGetTocTreeQualityUrl(seg(treeId)),
    { method: 'POST', body: JSON.stringify({}) },
  );
  cacheSet(key, value);
  return value;
}

// --- Config (3-level TOC settings; cached) --------------------------------

export async function getTocConfig(
  opts: { projectId?: string; fresh?: boolean } = {},
): Promise<TocSettings> {
  const tenantId = cacheTenant('GET', '/toc/config');
  const key = `config::${tenantId}::${opts.projectId ?? ''}`;
  if (!opts.fresh) {
    const hit = cacheGet<TocSettings>(key);
    if (hit) return hit;
  }
  const value = await http().json<TocSettings>(getGetTocConfigUrl(opts.projectId ? { project_id: opts.projectId } : undefined), { method: 'GET' });
  cacheSet(key, value);
  return value;
}

export async function updateTocConfig(
  body: TocSettingsIn,
): Promise<TocSettings> {
  const result = await http().json<TocSettings>(getUpsertTocConfigUrl(), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  // Invalidate cached config reads for this tenant on write.
  const tenantId = cacheTenant('PUT', '/toc/config');
  for (const k of readCache.keys()) {
    if (k.startsWith(`config::${tenantId}::`)) readCache.delete(k);
  }
  return result;
}
