// Media Discovery route handlers — read + compute proxy over the KAG gateway's
// `/media/*` surface. Same shape as routes/research/discover.ts: `validateAuth`
// → (read body) → `handle(() => integration.fn(...), data => jsonResponse({data}))`.
// Tenant resolved from the authenticated user (ctxTenantId) and threaded
// explicitly to the integration.
//
// ONLY customer-safe reads/compute are mounted here — media writes (collection
// mutate, download create, ingest push) are deliberately absent.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import {
  mediaSearch,
  mediaSources,
  mediaItem,
  mediaItemRelated,
  mediaItemTranscript,
  mediaItemScore,
  mediaCollections,
  mediaCollection,
  mediaScoreBatch,
  mediaScoreReport,
} from '../../integrations/media';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { readJsonBody } from '../_lib';


/** POST /api/research/media/search — federated media search. */
export async function handleMediaSearch(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaSearch(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/sources — list live media search sources. */
export async function handleMediaSources(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaSources(tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/items/:itemId — media item detail. */
export async function handleMediaItem(req: Request, itemId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaItem(itemId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/items/:itemId/related — related media items. */
export async function handleMediaItemRelated(req: Request, itemId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaItemRelated(itemId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/items/:itemId/transcript — media transcript. */
export async function handleMediaItemTranscript(req: Request, itemId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaItemTranscript(itemId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/items/:itemId/score — media item relevance score. */
export async function handleMediaItemScore(req: Request, itemId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaItemScore(itemId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/collections — browse collections. */
export async function handleMediaCollections(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaCollections(tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/collections/:collectionId — collection detail. */
export async function handleMediaCollection(req: Request, collectionId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaCollection(collectionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/media/score/batch — score a batch of media items (compute). */
export async function handleMediaScoreBatch(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaScoreBatch(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/media/score/report/:sessionId — a prior scoring run's report. */
export async function handleMediaScoreReport(req: Request, sessionId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => mediaScoreReport(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}
