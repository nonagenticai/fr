// fr-agui SPEC §13 P4a1 — spec drain, KAG: the `/api/tools/kag/*` ingestion
// routes (routes/tools/kag.ts), re-expressed as capabilities with NO behaviour
// change.
//
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts; the zod
// schemas are the SAME objects `invokeAction` validates the `kag.*` AG-UI
// actions with (routes/tools/kag-schemas.ts), so the derived spec cannot drift
// from what the route accepts.
//
// ⚠️ THESE ROUTES ARE ALREADY AGENT TOOLS, AND STAY EXACTLY WHERE THEY ARE.
// The hand-written `kag.*` actions are still registered by routes/tools/kag.ts
// (`safeRegister`, at module load) and remain in whatever agent catalog they
// are in today. This module does NOT derive or register an agent action
// (`agent.expose:false`), so there is exactly one `kag.*` action per name.
// Retiring them from the agent catalogs is P1c's job (SPEC §13, OQ-17 = (c)),
// and `out-of-agent-scope` is the reason that retirement records; until P1c
// lands, the reason describes the destination, the catalog describes today.
// The capability id deliberately EQUALS the action name, so P1c can flip one
// declaration rather than reconcile two id spaces.
//
// Writes (upload / scrape / pause / resume / retry / cancel) answer `202
// { data: PendingAction }` when the call parks for approval, and `200 { data }`
// when it executes inline (a human initiator self-approves:
// `autoApproveForInitiator`). The declared success status is the inline 200;
// the 202 park and (where the route runs `checkConcurrencyLimit`) the 429 are
// declared in `openapi.responses` with their exact bodies.
import { z } from 'zod';

import {
  batchIdInput,
  jobIdInput,
  listSessionsInput,
  refreshSourceInput,
  scrapeBulkInput,
  scrapeRefreshInput,
  scrapeSitemapInput,
  scrapeUrlInput,
  sessionIdInput,
} from '../../routes/tools/kag-schemas';
import { defaultConfirm, defineCapability, type Capability, type CapabilityHttp, type HttpMethod } from '../define';
import { DOOR_403 } from '../library/_shared';
import { KAG_INVALID_JSON_400, kagReadsJsonBody } from './_body';
import { preHandlerRefusalBody } from '../settings/_shared';
import { lazyHandler } from '../lazy';
import { isAuthenticatedUser, type CapabilityRoute } from '../rbac-rules';

const dataEnvelope = z.object({ data: z.unknown() });

/** validateAuth's bar for ONE route: signed in, and past its licence / conveyor doors (rbac-rules.ts). */
function authenticated(route: CapabilityRoute) {
  return { type: 'custom' as const, check: (ctx: Parameters<typeof isAuthenticatedUser>[0]) => isAuthenticatedUser(ctx, route) };
}

const PARKS = 'A worker / agent initiator parks for approval (202 { data: PendingAction }); a human initiator self-approves and gets 200.';

/** `envelope()` in routes/tools/kag.ts: a parked write answers 202 with the `PendingAction` (agui/types.ts). */
const PARKED = {
  status: 202,
  description: 'Parked for approval (worker / agent initiator): nothing has run yet.',
  schema: z.object({
    data: z.object({
      status: z.literal('pending'),
      actionId: z.string(),
      approvalId: z.string().optional().describe('The approvals row id; PUT /api/approvals/{approvalId} decides it'),
    }),
  }),
};

/** `rateLimitedResponse()` in routes/tools/kag.ts (checkConcurrencyLimit; fails OPEN when KAG is degraded). */
const RATE_LIMITED = {
  status: 429,
  description: '5 or more non-terminal ingest jobs (scrape sessions) for the caller: wait for one to finish, or pause/cancel one.',
  schema: z.object({
    error: z.object({ code: z.literal('RATE_LIMITED'), message: z.string(), retry_hint: z.string() }),
  }),
};
const RATE_LIMIT_TEXT = '429 RATE_LIMITED at 5 concurrent non-terminal ingest jobs per user.';

/**
 * P4d-1 (real-pipeline parity): the 403s fr answers before / at validateAuth — the server's licence route
 * door (a licence-shaped bearer; none of these routes is allowlisted) and validateAuth's conveyor write door.
 */
const KAG_DOORS_403 = {
  status: 403,
  description: 'Forbidden, `{ error, code }`. ' + DOOR_403.replace(/^403: /, ''),
  schema: preHandlerRefusalBody,
};

interface KagToolRoute {
  id: `kag.${string}`;
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  input: z.ZodTypeAny;
  effect: Capability['effect'];
  handler: string;
  http?: Pick<CapabilityHttp, 'requestBody' | 'responseContentType'>;
  /** The AG-UI action's approval policy (writes): mirrored as metadata, and the 202 park response. */
  parks?: boolean;
  /** The route runs `checkConcurrencyLimit` (429 RATE_LIMITED). */
  rateLimited?: boolean;
}

function kagToolCapability(r: KagToolRoute): Capability<unknown, unknown> {
  return defineCapability({
    id: r.id,
    area: 'kag',
    summary: r.summary,
    ...(r.description !== undefined ? { description: r.description } : {}),
    http: { method: r.method, path: r.path, operationId: r.operationId, ...(r.http ?? {}) },
    input: r.input,
    output: dataEnvelope,
    errors: [],
    auth: { principal: 'user', rbac: authenticated({ method: r.method, path: r.path }) },
    tenancy: 'tenant',
    effect: r.effect,
    confirm: defaultConfirm(r.effect),
    ...(r.parks
      ? { approval: { type: 'single-approver' as const, approver: 'initiator' as const }, autoApproveForInitiator: true }
      : {}),
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: {
      tags: ['KAG'],
      responses: [
        ...(r.parks ? [PARKED] : []),
        ...(r.rateLimited ? [RATE_LIMITED] : []),
        KAG_DOORS_403,
        // P4d-1: a multipart upload reads no JSON body.
        ...(r.http?.requestBody === undefined && kagReadsJsonBody(r.method, r.path, r.input) ? [KAG_INVALID_JSON_400] : []),
      ],
    },
    legacyHandler: lazyHandler(() => import('../../routes/tools/kag'), {
      module: 'src/routes/tools/kag.ts',
      exportName: r.handler,
    }),
  });
}

/** Path `:id` that the route hands the action as `session_id` / `job_id` / `batch_id` — same constraint. */
const sessionPath = z.object({ id: sessionIdInput.shape.session_id.describe('Scrape session id (UUID)') });
const jobPath = z.object({ id: jobIdInput.shape.job_id.describe('Document-ingestion job id (UUID)') });
const batchPath = z.object({ id: batchIdInput.shape.batch_id.describe('Batch id (`batch-<hex>`, not a UUID)') });
/** The image-bytes routes proxy the ids without validating them. */
const imagePath = (owner: string) =>
  z.object({ id: z.string().describe(`${owner} id`), imageId: z.string().describe('Image id') });

/**
 * The multipart upload form (routes/tools/kag.ts readMultipart). Booleans arrive
 * as form strings: `'true'` / `'1'` are true, anything else false.
 */
const uploadForm = z.object({
  file: z.unknown().describe('The document (binary part)'),
  filename: z.string().optional().describe("Used when the file part carries no name; default 'upload.bin'"),
  send_to_kag: z.string().optional().describe("'true' or '1' ingests into KAG"),
  credential_id: z.string().optional().describe('A stored URL credential of the caller (ownership is checked)'),
});
const MULTIPART = { requestBody: { contentType: 'multipart/form-data' as const, fileFields: ['file'] } };
const BYTES = { responseContentType: 'application/octet-stream' };

const ROUTES: KagToolRoute[] = [
  // ── Documents ────────────────────────────────────────────────────────────
  {
    id: 'kag.upload_document', method: 'POST', path: '/api/tools/kag/documents', operationId: 'kagUploadDocument',
    summary: 'Upload a document for asynchronous KAG ingestion', effect: 'write', handler: 'handleUploadDocument',
    description: `Poll GET /api/tools/kag/documents/jobs/{id}. ${PARKS} ${RATE_LIMIT_TEXT}`,
    input: uploadForm, http: MULTIPART, parks: true, rateLimited: true,
  },
  {
    id: 'kag.upload_document_sync', method: 'POST', path: '/api/tools/kag/documents/sync',
    operationId: 'kagUploadDocumentSync', summary: 'Upload a small document for synchronous KAG ingestion',
    effect: 'write', handler: 'handleUploadDocumentSync',
    description: `Under 2,000,000 bytes, else 413 PAYLOAD_TOO_LARGE (use the async upload). ${PARKS} ${RATE_LIMIT_TEXT}`,
    input: uploadForm.extend({ extract_images: z.string().optional().describe("'true' or '1' extracts images") }),
    http: MULTIPART, parks: true, rateLimited: true,
  },
  {
    id: 'kag.get_document_job', method: 'GET', path: '/api/tools/kag/documents/jobs/:id', operationId: 'kagGetDocumentJob',
    summary: 'Get a document-ingestion job', effect: 'read', handler: 'handleGetDocumentJob', input: jobPath,
  },
  {
    id: 'kag.list_document_images', method: 'GET', path: '/api/tools/kag/documents/jobs/:id/images',
    operationId: 'kagListDocumentImages', summary: 'List images extracted from an ingested document', effect: 'read',
    handler: 'handleListDocumentImages', input: jobPath,
  },
  {
    id: 'kag.download_document_image', method: 'GET', path: '/api/tools/kag/documents/jobs/:id/images/:imageId/download',
    operationId: 'kagDownloadDocumentImage', summary: 'Download one extracted document image (bytes)', effect: 'read',
    handler: 'handleDownloadDocumentImage', input: imagePath('Document-ingestion job'), http: BYTES,
    description: "Streams the upstream bytes with the upstream Content-Type and 'X-Content-Type-Options: nosniff'.",
  },
  {
    id: 'kag.get_batch_status', method: 'GET', path: '/api/tools/kag/documents/batch/:id/status',
    operationId: 'kagGetBatchStatus', summary: 'Get an ingestion batch status', effect: 'read',
    handler: 'handleGetBatchStatus', input: batchPath,
  },
  {
    id: 'kag.retry_failed_batch_jobs', method: 'POST', path: '/api/tools/kag/documents/batch/:id/retry-failed',
    operationId: 'kagRetryFailedBatchJobs', summary: 'Retry the failed jobs of an ingestion batch', effect: 'write',
    handler: 'handleRetryFailedBatch', input: batchPath, parks: true, description: PARKS,
  },
  // ── Scrape ───────────────────────────────────────────────────────────────
  {
    id: 'kag.scrape_url', method: 'POST', path: '/api/tools/kag/scrape/url', operationId: 'kagScrapeUrl',
    summary: 'Scrape one URL into KAG', effect: 'write', handler: 'handleScrapeUrl', input: scrapeUrlInput, parks: true,
    rateLimited: true, description: `${PARKS} ${RATE_LIMIT_TEXT}`,
  },
  {
    id: 'kag.scrape_refresh', method: 'POST', path: '/api/tools/kag/scrape/refresh', operationId: 'kagScrapeRefresh',
    summary: 'Re-scrape a known source URL; re-ingest only if it changed', effect: 'write', handler: 'handleScrapeRefresh',
    input: scrapeRefreshInput, parks: true, rateLimited: true, description: `${PARKS} ${RATE_LIMIT_TEXT}`,
  },
  {
    id: 'kag.scrape_sitemap', method: 'POST', path: '/api/tools/kag/scrape/sitemap', operationId: 'kagScrapeSitemap',
    summary: 'Scrape every URL of a sitemap into KAG', effect: 'write', handler: 'handleScrapeSitemap',
    input: scrapeSitemapInput, parks: true, rateLimited: true, description: `${PARKS} ${RATE_LIMIT_TEXT}`,
  },
  {
    id: 'kag.scrape_urls_bulk', method: 'POST', path: '/api/tools/kag/scrape/bulk', operationId: 'kagScrapeUrlsBulk',
    summary: 'Scrape many URLs as one source', effect: 'write', handler: 'handleScrapeBulk', input: scrapeBulkInput,
    parks: true, rateLimited: true, description: `${PARKS} ${RATE_LIMIT_TEXT}`,
  },
  {
    id: 'kag.refresh_source', method: 'POST', path: '/api/tools/kag/scrape/refresh-source', operationId: 'kagRefreshSource',
    summary: 'Refresh a multi-page (sitemap / crawl / bulk) source', effect: 'write', handler: 'handleRefreshSource',
    input: refreshSourceInput, parks: true, rateLimited: true, description: `${PARKS} ${RATE_LIMIT_TEXT}`,
  },
  // ── Scrape sessions ──────────────────────────────────────────────────────
  {
    id: 'kag.list_sessions', method: 'GET', path: '/api/tools/kag/scrape/sessions', operationId: 'kagListSessions',
    summary: 'List scrape sessions', effect: 'read', handler: 'handleListSessions', input: listSessionsInput,
  },
  {
    id: 'kag.get_session', method: 'GET', path: '/api/tools/kag/scrape/sessions/:id', operationId: 'kagGetSession',
    summary: 'Get a scrape session', effect: 'read', handler: 'handleGetSession', input: sessionPath,
  },
  {
    id: 'kag.list_session_images', method: 'GET', path: '/api/tools/kag/scrape/sessions/:id/images',
    operationId: 'kagListSessionImages', summary: 'List the images a scrape session captured', effect: 'read',
    handler: 'handleListSessionImages', input: sessionPath,
  },
  {
    id: 'kag.get_session_screenshot', method: 'GET', path: '/api/tools/kag/scrape/sessions/:id/screenshot',
    operationId: 'kagGetSessionScreenshot', summary: "A scrape session's page screenshot (bytes)", effect: 'read',
    handler: 'handleGetSessionScreenshot', input: z.object({ id: z.string().describe('Scrape session id') }), http: BYTES,
    description: "Streams the upstream bytes with the upstream Content-Type and 'X-Content-Type-Options: nosniff'.",
  },
  {
    id: 'kag.download_session_image', method: 'GET', path: '/api/tools/kag/scrape/sessions/:id/images/:imageId/download',
    operationId: 'kagDownloadSessionImage', summary: 'Download one scraped image (bytes)', effect: 'read',
    handler: 'handleDownloadSessionImage', input: imagePath('Scrape session'), http: BYTES,
    description: "Streams the upstream bytes with the upstream Content-Type and 'X-Content-Type-Options: nosniff'.",
  },
  {
    id: 'kag.pause_session', method: 'POST', path: '/api/tools/kag/scrape/sessions/:id/pause', operationId: 'kagPauseSession',
    summary: 'Pause a scrape session', effect: 'write', handler: 'handlePauseSession', input: sessionPath, parks: true,
    description: PARKS,
  },
  {
    id: 'kag.resume_session', method: 'POST', path: '/api/tools/kag/scrape/sessions/:id/resume',
    operationId: 'kagResumeSession', summary: 'Resume a paused scrape session', effect: 'write',
    handler: 'handleResumeSession', input: sessionPath, parks: true, description: PARKS,
  },
  {
    id: 'kag.cancel_session', method: 'DELETE', path: '/api/tools/kag/scrape/sessions/:id', operationId: 'kagCancelSession',
    summary: 'Cancel and delete a scrape session', effect: 'destructive', handler: 'handleCancelSession',
    input: sessionPath, parks: true, description: PARKS,
  },
];

export const KAG_TOOL_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = ROUTES.map(kagToolCapability);
