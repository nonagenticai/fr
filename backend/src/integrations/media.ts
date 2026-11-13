// Media Discovery integration — thin BFF adapter over the KAG gateway's
// catch-all proxy for the Media Discovery service.
//
// The KAG gateway (config.services.kag.baseUrl) reverse-proxies the Media
// Discovery service under `/media/*` (strips `/media`, forwards the rest; the
// service mounts everything at `/api/...`, so the real path through the gateway
// is `/media/api/...`) — byte-identical in shape to integrations/research.ts's
// `/discover/*` handling.
//
// This adapter exposes ONLY the customer-safe READ + COMPUTE surface (search,
// item detail/related/transcript, collection browse, scoring). Media writes
// (collection create/delete/add/remove/import, download create, ingest push)
// are intentionally NOT surfaced — they stay in the n8n node / admin tooling.
//
// Same hardened HttpClient family as integrations/research.ts, its own cached
// instance + `serviceName:'media'` for attributable timeouts/correlation.
// Tenant threaded EXPLICITLY as `X-Tenant-Id` (mirrors research.ts) — testable
// without a request-context frame; the HttpClient only fills it from ALS when
// the header is absent, so the explicit value always wins.
//
// Return types are intentionally loose — upstream response shapes are owned by
// the downstream service and consumed defensively by the frontend.

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { KAG_ONBEHALF_TOKEN_ENV } from './_lib/service-credential';

// Media search fans out to external providers + transcript/embedding work; give
// it a generous but bounded default. The public path is still capped by
// Cloudflare (~100s) + istio independently of this value.
const MEDIA_TIMEOUT_MS = parseInt(process.env.MEDIA_TIMEOUT_MS || '120000', 10);

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'media',
      baseUrl: config.services.kag.baseUrl,
      defaultTimeoutMs: MEDIA_TIMEOUT_MS,
      // WHENEVER WE NAME A TENANT, WE VOUCH FOR IT.
      //
      // Identical reasoning to integrations/research.ts — read the long
      // version there. In short: this client shares
      // `config.services.kag.baseUrl` with integrations/kag.ts and is behind
      // the same middleware gate, which gitops #3944 armed on 2026-09-16
      // (`ALLOW_UNVOUCHED_TENANT_HEADER: "false"`). fr #1153 widened kag.ts on
      // 2026-09-21 but not its two siblings, so `/media/api/*` has 401'd
      // continuously since the flag was armed.
      //
      // Measured 2026-09-23 from the live fr pod against `$KAG_INGESTION_URL`:
      //   /media/api/search/sources  tenant-only 401 -> tenant+licence 200
      //   /media/api/collections     tenant-only 401 -> tenant+licence 200
      //
      // `hasTenantHeader` — not a path list — is the condition, because that
      // is kag's own requirement AND it is what keeps the credential off any
      // request with no tenant to name. Attaching it there would put fr on the
      // rung that adopts the LICENCE'S own tenant instead of the customer's.
      // Tenancy posture is unchanged, and the separate open question — whether
      // fr should stop threading a plain tenant header at all — is untouched.
      // See the note in integrations/research.ts on why that decision is NOT
      // cited as "ROADMAP §11 D2" here: no such document exists in this repo.
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
  return cachedClient;
}

function tenantHeaders(tenantId: string): Record<string, string> {
  return { 'X-Tenant-Id': tenantId };
}

// -------- Media Discovery (`/media/api/...`) --------

/** Federated media search across the Media Discovery service's sources. */
export async function mediaSearch(body: unknown, tenantId: string): Promise<unknown> {
  return await http().json<unknown>('/media/api/search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** List the live registered media search sources (+ enabled state). */
export async function mediaSources(tenantId: string): Promise<unknown> {
  return await http().json<unknown>('/media/api/search/sources', {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/** A single media item's full detail. */
export async function mediaItem(itemId: string, tenantId: string): Promise<unknown> {
  return await http().json<unknown>(
    `/media/api/items/${encodeURIComponent(itemId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Media items related to a given item (semantic / same-collection neighbours). */
export async function mediaItemRelated(itemId: string, tenantId: string): Promise<unknown> {
  return await http().json<unknown>(
    `/media/api/items/${encodeURIComponent(itemId)}/related`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** A media item's transcript (the trust surface — what was actually said). */
export async function mediaItemTranscript(itemId: string, tenantId: string): Promise<unknown> {
  return await http().json<unknown>(
    `/media/api/items/${encodeURIComponent(itemId)}/transcript`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** A media item's relevance/quality score (compute; no mutation). */
export async function mediaItemScore(itemId: string, tenantId: string): Promise<unknown> {
  return await http().json<unknown>(
    `/media/api/items/${encodeURIComponent(itemId)}/score`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Browse the tenant's media collections. */
export async function mediaCollections(tenantId: string): Promise<unknown> {
  return await http().json<unknown>('/media/api/collections', {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/** A single collection's detail (its items). */
export async function mediaCollection(collectionId: string, tenantId: string): Promise<unknown> {
  return await http().json<unknown>(
    `/media/api/collections/${encodeURIComponent(collectionId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}

/** Score a batch of media items (compute; no mutation). */
export async function mediaScoreBatch(body: unknown, tenantId: string): Promise<unknown> {
  return await http().json<unknown>('/media/api/score/batch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: tenantHeaders(tenantId),
  });
}

/** Fetch a prior scoring run's report by session id. */
export async function mediaScoreReport(sessionId: string, tenantId: string): Promise<unknown> {
  return await http().json<unknown>(
    `/media/api/score/report/${encodeURIComponent(sessionId)}`,
    { method: 'GET', headers: tenantHeaders(tenantId) },
  );
}
