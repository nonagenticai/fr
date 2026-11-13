// Research workspace — Discovery Engine route handlers (Slice 0 vertical proof).
//
// Read-style proxy handlers over the KAG gateway's `/discover/*` surface,
// copying the shape of routes/assets/kag.ts: `validateAuth` → read body →
// `handle(() => integration.fn(...), data => jsonResponse({ data }))`. The
// `handle` helper maps IntegrationError → the right HTTP status and re-throws
// everything else (auth/validation errors bubble to the server's top-level
// handler, exactly like the KAG routes).
//
// Tenant is resolved from the authenticated user (ctxTenantId, ALS-first with
// the user's tenantId as fallback) and threaded explicitly to the integration —
// see integrations/research.ts for why.
//
// `ingest/push` mutates the shared tenant graph but is routed read-style for v1
// (explicit, user-driven, reversible; a single-approver-as-initiator E-5 gate
// would be self-approval theater). Documented as the open decision in the plan.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { IntegrationError } from '../../integrations/_lib/errors';
import {
  discoverSearch,
  ingestPush,
  ingestPushStatus,
  discoverSources,
  scoreBatch,
  getPaperRelated,
  getPaper,
  scorePaper,
  createSession,
  exportSession,
  createReviewExport,
  getReviewExport,
  listReviewExports,
  startSnowball,
  snowballStatus,
  cancelSnowball,
  pauseSession,
  resumeSession,
  getSession,
  updateSession,
  deleteSession,
  sessionInsights,
  scoreReport,
  semanticSearch,
} from '../../integrations/research';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { readJsonBody, requireStringField } from '../_lib';


/** Throw a 400-style UPSTREAM_BAD_BODY when a required string field is missing. */

/** POST /api/research/discover/search — federated academic search. */
export async function handleResearchSearch(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => discoverSearch(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/sources — list live search sources for the picker. */
export async function handleResearchSources(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => discoverSources(tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/score/batch — 7-signal trust scores for papers. */
export async function handleResearchScoreBatch(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => scoreBatch(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/sessions — create the workspace session. */
export async function handleResearchCreateSession(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => createSession(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

const EXPORT_FORMATS = new Set(['json', 'bibtex', 'ris']);

/** GET /api/research/discover/sessions/:sessionId/export?format= — export papers. */
export async function handleResearchExportSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const format = new URL(req.url).searchParams.get('format') ?? 'json';
  if (!EXPORT_FORMATS.has(format)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: '`format` must be one of json|bibtex|ris',
    });
  }
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => exportSession(sessionId, format, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/**
 * POST /api/research/discover/sessions/:sessionId/review-export — freeze it.
 *
 * Separate from `handleResearchExportSession` because they are different acts.
 * `/export` reads the session as it is right now and is a download; this takes
 * a copy that will not move, digests it, and returns a receipt a review can
 * cite. The engine rewrites `Paper` rows on every later search, so only the
 * frozen one is reproducible.
 */
export async function handleResearchCreateReviewExport(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => createReviewExport(sessionId, tenantId),
    (data) => jsonResponse({ data }, 201),
  );
}

/** GET /api/research/discover/sessions/:sessionId/review-export — the receipts. */
export async function handleResearchListReviewExports(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => listReviewExports(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/sessions/:sessionId/review-export/:batchId — the document. */
export async function handleResearchGetReviewExport(
  req: Request,
  sessionId: string,
  batchId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => getReviewExport(sessionId, batchId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

const RELATED_KINDS = new Set(['similar', 'citations', 'references']);

/** GET /api/research/discover/papers/:paperId/:kind — citation-graph neighbours. */
export async function handleResearchPaperRelated(
  req: Request,
  paperId: string,
  kind: string,
): Promise<Response> {
  const user = await validateAuth(req);
  if (!RELATED_KINDS.has(kind)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: '`kind` must be one of similar|citations|references',
    });
  }
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () =>
      getPaperRelated(
        paperId,
        kind as 'similar' | 'citations' | 'references',
        tenantId,
      ),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/papers/:paperId — full single-paper metadata. */
export async function handleResearchGetPaper(
  req: Request,
  paperId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => getPaper(paperId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/score — score a single paper ({ paper_id }). */
export async function handleResearchScorePaper(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  const body = await readJsonBody(req);
  return handle(
    () => scorePaper(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/ingest/push — push selected papers into KAG. */
export async function handleResearchIngestPush(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => ingestPush(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/ingest/push/:pushId — poll push status. */
export async function handleResearchIngestPushStatus(
  req: Request,
  pushId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => ingestPushStatus(pushId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/snowball — start an async citation-walk job. */
export async function handleResearchSnowballStart(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => startSnowball(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/snowball/:jobId — poll a snowball job. */
export async function handleResearchSnowballStatus(
  req: Request,
  jobId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => snowballStatus(jobId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/snowball/:jobId/cancel — cancel an in-flight job. */
export async function handleResearchSnowballCancel(
  req: Request,
  jobId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => cancelSnowball(jobId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/sessions/:sessionId/pause — pause an active session. */
export async function handleResearchPauseSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => pauseSession(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/sessions/:sessionId/resume — resume a paused session. */
export async function handleResearchResumeSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => resumeSession(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/sessions/:sessionId — single-session detail/state. */
export async function handleResearchGetSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => getSession(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** PATCH /api/research/discover/sessions/:sessionId — edit name/description/status/config. */
export async function handleResearchUpdateSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  const body = await readJsonBody(req);
  return handle(
    () => updateSession(sessionId, body, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** DELETE /api/research/discover/sessions/:sessionId — delete a session. */
export async function handleResearchDeleteSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => deleteSession(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/sessions/:sessionId/insights — ingest-event health. */
export async function handleResearchSessionInsights(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => sessionInsights(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/research/discover/score/report/:sessionId — session-wide trust distribution. */
export async function handleResearchScoreReport(
  req: Request,
  sessionId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => scoreReport(sessionId, tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/research/discover/search/semantic — semantic search over a session's papers. */
export async function handleResearchSemanticSearch(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const body = await readJsonBody<Record<string, unknown>>(req);
  requireStringField(body, 'query');
  const tenantId = ctxTenantId(user.tenantId);
  return handle(
    () => semanticSearch(body, tenantId),
    (data) => jsonResponse({ data }),
  );
}
