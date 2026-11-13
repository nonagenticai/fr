/**
 * KAG ingestion tool routes — Wave 1 slice 1.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-kag-ingestion-ui.md
 * Plan: docs/superpowers/plans/completed/2026-04-25-kag-ingestion-implementation.md
 *
 * The action surface is "ingestion" — multipart upload, scrape, sitemap,
 * session lifecycle, batch/job polling. Read-only KAG (semantic search,
 * graph reads, scrape session metadata reads) lives in
 * `routes/assets/kag.ts`; this file is the writes + the per-job poll
 * surface specifically tied to ingestion.
 *
 * Per-handler shape (action-shaped — match `tools/activity.ts`):
 *   1. validateAuth + parse input.
 *   2. Build ActionContext from request-context middleware (E-3).
 *   3. invokeAction(<name>, parsedInput, ctx) — the registry (E-2) wraps
 *      it in emitSpan (E-1), runs runIdempotent (E-4), and for writes
 *      delegates to the action-approval bus (E-5). Reads return the
 *      handler output directly; writes return a `PendingAction`.
 *   4. Translate to FR envelope ({ data } | { error }).
 *
 * AG-UI catalog registered at module load. 14 actions; 7 writes
 * (single-approver:initiator), 7 reads (auto). Names per slice §7.
 *
 * Scraped visual evidence (read-only, added post-slice): the two
 * `list_*_images` actions above serve JSON manifests through this action
 * registry; the raw image/screenshot BYTES are streamed by the plain
 * `handleGet*Image*` route handlers below (they bypass the registry/envelope
 * so an <img> tag can consume the binary directly). All are GET reads.
 */

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import {
  recordSyncUploadRow,
  estimateBase64DecodedBytes,
} from '../../services/kag-upload-record';
import { handle } from '../assets/_lib/handler';
import {
  IntegrationError,
  isIntegrationError,
} from '../../integrations/_lib/errors';

/**
 * Spec §11 (kag-ingestion-ui): max 5 concurrent non-terminal ingest jobs per
 * user. Counted by hitting the upstream `listScrapeSessions` filtered to the
 * caller's tenant (via JWT propagation). Over the limit → 429 RATE_LIMITED.
 */
const RATE_LIMIT_MAX_CONCURRENT = 5;
/**
 * Spec §4 (kag-ingestion-ui): the synchronous `/documents/sync` upload path is
 * size-gated to under 2 MB at the FR layer; larger uploads must use the async
 * `/documents` path. 413 PAYLOAD_TOO_LARGE is preserved verbatim to the caller.
 */
const SYNC_UPLOAD_MAX_BYTES = 2_000_000;
/**
 * Async uploads that are worker-initiated (n8n/agent) park their full base64
 * payload inline in the approval row's `action_input_json` until a human
 * approves. Cap the parked blob so a runaway worker can't bloat the approvals
 * JSONB (and the /api/approvals responses that carry it). Human self-service
 * ingest auto-approves and never persists here; the sync path is separately
 * gated at SYNC_UPLOAD_MAX_BYTES in-handler.
 */
const ASYNC_UPLOAD_MAX_BYTES = 50_000_000;
const TERMINAL_SESSION_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
]);

function rateLimitedResponse(currentCount: number): Response {
  return jsonResponse(
    {
      error: {
        code: 'RATE_LIMITED',
        message:
          `Per-user concurrent ingest job limit reached ` +
          `(${currentCount}/${RATE_LIMIT_MAX_CONCURRENT}). Wait for an in-flight ` +
          `session to finish (or pause/cancel one) before starting another.`,
        retry_hint:
          'Poll GET /api/tools/kag/scrape/sessions and retry once a session ' +
          'reaches a terminal status (completed/failed/cancelled).',
      },
    },
    429,
  );
}

function payloadTooLargeResponse(bytes: number): Response {
  return jsonResponse(
    {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message:
          `Synchronous upload limited to ${SYNC_UPLOAD_MAX_BYTES} bytes; ` +
          `received ${bytes}. Use POST /api/tools/kag/documents (async) for ` +
          `larger files and poll GET /api/tools/kag/documents/jobs/:id.`,
      },
    },
    413,
  );
}
import {
  ctxTenantId,
  tryGetRequestContext,
} from '../../middleware/request-context';
import {
  invokeAction,
  registerAction,
} from '../../agui/registry';
import type {
  AgentCallableAction,
  ActionContext,
  PendingAction,
} from '../../agui/types';
import {
  uploadDocument,
  uploadDocumentSync,
  scrapeUrl,
  refreshScrapeSource,
  refreshSourceMulti,
  scrapeBulk,
  scrapeSitemap,
  pauseScrapeSession,
  resumeScrapeSession,
  deleteScrapeSession,
  getDocumentJobStatus,
  getBatchStatus,
  retryFailedBatchJobs,
  listScrapeSessions as integListScrapeSessions,
  getScrapeSessionDetail as integGetScrapeSessionDetail,
  listScrapeSessionImages as integListScrapeSessionImages,
  listDocumentJobImages as integListDocumentJobImages,
  proxyScrapeScreenshot,
  proxyScrapeSessionImage,
  proxyDocumentJobImage,
} from '../../integrations/kag';
import { urlCredentialsApiClient } from '../../services/urlCredentialsApiClient';
import { readJsonBody } from '../_lib';
import { withIntegrationCatch } from '../_lib';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


interface AuthedUser {
  id: string;
  /**
   * Keycloak realm roles off the validated token (`types/api.ts User.roles`).
   * Required, not optional: `buildCtx` feeds it to `ctx.tenantRoles`, and an
   * absent value there reads as "no roles at all" to `agui/rbac.ts`.
   */
  roles: string[];
  tenantId: string;
  tenantName?: string | null;
}

function buildCtx(user: AuthedUser): ActionContext {
  const rc = tryGetRequestContext();
  // Thread the caller's tenant into the action context. Reads on this route
  // already scope via `ctxTenantId(user.tenantId)`; writes route through the
  // approval backend, whose approvals-row insert REQUIRES a tenant_id
  // (migration 042) — omitting it here made EVERY KAG write action
  // (upload/scrape) 500 with TenantContextRequiredError for every user.
  // A missing/anonymous tenant stays `undefined` so a genuinely unaffiliated
  // caller is still refused (not silently mis-scoped), matching the intended
  // "no resolvable tenant" behaviour.
  const tenantId =
    user.tenantId && user.tenantId !== 'anonymous' ? user.tenantId : undefined;
  // Carry the caller's realm roles. `agui/rbac.ts` reads `ctx.tenantRoles ?? []`
  // and `defaultRule()` demands a `tenant-role` whenever projectId is null —
  // which is every action on this route — so leaving it out made any role-gated
  // action here unsatisfiable no matter what the user actually holds. The
  // kag.* actions currently opt into `PUBLIC_RBAC` (see near uploadAction) and
  // so escaped the denial, but the context they hand to the registry was still
  // lying about the caller.
  return {
    userId: user.id,
    projectId: null,
    tenantId,
    tenantRoles: user.roles,
    tenantName: user.tenantName ?? undefined,
    correlationId: rc?.correlationId ?? crypto.randomUUID(),
    initiator: rc?.initiator ?? 'human',
    channel: rc?.channel ?? 'web',
  };
}

function isPending(v: unknown): v is PendingAction {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { status?: unknown }).status === 'pending'
  );
}

function envelope(value: unknown): Response {
  if (isPending(value)) {
    return jsonResponse({ data: value }, 202);
  }
  return jsonResponse({ data: value });
}


async function verifyCredentialOwnership(
  credentialId: string,
  user: AuthedUser,
): Promise<void> {
  if (user.tenantId === 'anonymous') {
    throw new IntegrationError({
      code: 'UPSTREAM_FORBIDDEN',
      message: 'auth_config requires authenticated user (tenantId=anonymous)',
      service: 'kag',
    });
  }
  let cred;
  try {
    cred = await urlCredentialsApiClient.retrieveUrlCredential(
      credentialId,
      ctxTenantId(user.tenantId),
    );
  } catch (err) {
    throw new IntegrationError({
      code: 'UPSTREAM_FORBIDDEN',
      message: `Credential ${credentialId} not retrievable for tenant`,
      service: 'kag',
      cause: err,
    });
  }
  if (cred.user_id !== user.id) {
    throw new IntegrationError({
      code: 'UPSTREAM_FORBIDDEN',
      message: `Credential ${credentialId} not owned by calling user`,
      service: 'kag',
    });
  }
}

/**
 * Count non-terminal scrape sessions for the calling user and reject the
 * request when the per-user concurrency cap is hit. The upstream
 * `listScrapeSessions` is tenant-scoped via the forwarded JWT, so we don't
 * need to filter further here.
 *
 * Returns `null` when the request is within the cap, or a 429 Response
 * when over it. Callers MUST short-circuit on a non-null return.
 */
async function checkConcurrencyLimit(): Promise<Response | null> {
  let sessionsRaw: unknown;
  try {
    // limit:1000 is the upstream max; the cap is 5 so any
    // status-non-terminal pre-filter would still need to count locally.
    sessionsRaw = await integListScrapeSessions({ limit: 1000 });
  } catch (err) {
    // If the upstream sessions read fails, fall open — the alternative is
    // refusing every write when KAG metadata is degraded, which is worse
    // than briefly tolerating > N concurrent jobs. Log so operators see
    // the degraded-rate-limit signal.
    if (isIntegrationError(err)) {
      console.warn('[kag.checkConcurrencyLimit] upstream degraded, failing open:', err.message);
      return null;
    }
    throw err;
  }
  const list = extractSessionsList(sessionsRaw);
  let nonTerminal = 0;
  for (const s of list) {
    const status = typeof s?.status === 'string' ? s.status.toLowerCase() : '';
    if (!TERMINAL_SESSION_STATUSES.has(status)) {
      nonTerminal += 1;
    }
  }
  if (nonTerminal >= RATE_LIMIT_MAX_CONCURRENT) {
    return rateLimitedResponse(nonTerminal);
  }
  return null;
}

/**
 * Defensively extract a `sessions[]`-like array from the upstream payload.
 * KAG returns `{ sessions: [...] }` per slice §6.1; accept either that shape
 * or a bare array so the rate-limit check is robust to upstream evolution.
 */
function extractSessionsList(raw: unknown): { status?: unknown }[] {
  if (Array.isArray(raw)) return raw as { status?: unknown }[];
  if (raw && typeof raw === 'object') {
    const maybe = (raw as { sessions?: unknown }).sessions;
    if (Array.isArray(maybe)) return maybe as { status?: unknown }[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Zod schemas — input/output for each action. They live in ./kag-schemas
// (side-effect free) so the capability declarations derive the route spec
// from the very objects invokeAction validates with.
// ---------------------------------------------------------------------------

import {
  batchIdInput,
  jobIdInput,
  listSessionsInput,
  passthrough,
  refreshSourceInput,
  refreshSourceOutput,
  scrapeBulkInput,
  scrapeRefreshInput,
  scrapeRefreshOutput,
  scrapeSitemapInput,
  scrapeUrlInput,
  sessionIdInput,
  sessionIdOutput,
  uploadInput,
  uploadOutput,
  uploadSyncInput,
} from './kag-schemas';

type UploadInput = z.infer<typeof uploadInput>;
type UploadSyncInput = z.infer<typeof uploadSyncInput>;

// Async upload input, capped so a worker can't park an oversized base64 blob in
// the approval row. Rejected at zod-parse time in invokeAction — BEFORE the row
// is written — so the cap actually bounds what gets persisted. Kept off the base
// `uploadInput` so `uploadSyncInput.extend(...)` stays a plain ZodObject.
const uploadAsyncInput = uploadInput.refine(
  (v) => estimateBase64DecodedBytes(v.file_b64) <= ASYNC_UPLOAD_MAX_BYTES,
  {
    message: `document exceeds the ${ASYNC_UPLOAD_MAX_BYTES}-byte async upload limit`,
    path: ['file_b64'],
  },
);

function decodeBase64(b64: string): Uint8Array {
  // Bun supports Buffer; use atob for portability.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fileFromInput(input: { file_b64: string; filename: string; content_type?: string }): {
  blob: Blob;
  bytes: number;
} {
  const bytes = decodeBase64(input.file_b64);
  const blob = new Blob([bytes], {
    type: input.content_type ?? 'application/octet-stream',
  });
  return { blob, bytes: bytes.byteLength };
}

// Hash for idempotency keys without using node:crypto sync — deterministic.
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  // Convert to unsigned hex.
  return (h >>> 0).toString(16);
}

type ScrapeUrlInput = z.infer<typeof scrapeUrlInput>;
type ScrapeBulkInput = z.infer<typeof scrapeBulkInput>;
type ScrapeRefreshInput = z.infer<typeof scrapeRefreshInput>;
type ScrapeSitemapInput = z.infer<typeof scrapeSitemapInput>;
type RefreshSourceInput = z.infer<typeof refreshSourceInput>;
type ListSessionsInput = z.infer<typeof listSessionsInput>;
type SessionIdInput = z.infer<typeof sessionIdInput>;
type JobIdInput = z.infer<typeof jobIdInput>;
type BatchIdInput = z.infer<typeof batchIdInput>;

// ---------------------------------------------------------------------------
// AG-UI action definitions
// ---------------------------------------------------------------------------

// All kag.* actions are user-scoped (no projectId on the upstream
// ingestion surface). validateAuth at the HTTP layer already gates
// "is this user authenticated?"; auth_config.credential_id ownership
// is enforced explicitly by the route handler before invokeAction.
// We therefore opt into rbac:'public' rather than the default
// `tenant-role: 'user'` which would require a synced realm-roles claim
// not yet wired into AUTH_BYPASS or Keycloak claim extraction here.
const PUBLIC_RBAC = { type: 'public' as const };

const uploadAction: AgentCallableAction<UploadInput, unknown> = {
  name: 'kag.upload_document',
  kind: 'write',
  description:
    'Asynchronously upload a document to KAG for parsing + ingestion. Returns a job_id the caller polls via kag.get_document_job.',
  input: uploadAsyncInput,
  output: uploadOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.upload_document:${shortHash(input.filename + ':' + input.file_b64.length + ':' + (input.content_type ?? ''))}`,
  handler: async (input) => {
    const { blob } = fileFromInput(input);
    return await uploadDocument({
      file: blob,
      send_to_kag: input.send_to_kag,
    });
  },
};

const uploadSyncAction: AgentCallableAction<UploadSyncInput, unknown> = {
  name: 'kag.upload_document_sync',
  kind: 'write',
  description:
    'Synchronously upload a document under 2 MB to KAG and return the parsed structure inline.',
  input: uploadSyncInput,
  output: passthrough,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: false,
  idempotencyKey: (input) =>
    `kag.upload_document_sync:${shortHash(input.filename + ':' + input.file_b64.length + ':' + (input.content_type ?? ''))}`,
  handler: async (input) => {
    const { blob, bytes } = fileFromInput(input);
    if (bytes >= SYNC_UPLOAD_MAX_BYTES) {
      throw new IntegrationError({
        // 413, not 400: the fix is "chunk it", not "correct the body". This is
        // the one site in the sweep whose caller disposition genuinely differs.
        code: 'PAYLOAD_TOO_LARGE',
        message: `sync upload limited to ${SYNC_UPLOAD_MAX_BYTES} bytes; got ${bytes}`,
      });
    }
    return await uploadDocumentSync({
      file: blob,
      send_to_kag: input.send_to_kag,
      extract_images: input.extract_images,
    });
  },
};

const scrapeUrlAction: AgentCallableAction<ScrapeUrlInput, unknown> = {
  name: 'kag.scrape_url',
  kind: 'write',
  description:
    'Scrape a single URL, optionally with stored credentials. Returns a session_id pollable via kag.get_session.',
  input: scrapeUrlInput,
  output: sessionIdOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.scrape_url:${input.url}:${input.auth_config?.credential_id ?? ''}`,
  handler: async (input) => {
    return await scrapeUrl(input as Parameters<typeof scrapeUrl>[0]);
  },
};

const scrapeRefreshAction: AgentCallableAction<ScrapeRefreshInput, unknown> = {
  name: 'kag.scrape_refresh',
  kind: 'write',
  description:
    'Re-scrape a known source URL and re-ingest into KAG only if its content changed since the last scrape. Returns { changed, reingested, prior_hash, new_hash }.',
  input: scrapeRefreshInput,
  output: scrapeRefreshOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: refreshing your own source auto-approves.
  // A non-human initiator (n8n / agent) still parks for human review.
  autoApproveForInitiator: true,
  cronSafe: true,
  // Refresh is intentionally repeatable (re-check freshness on demand). Keep the
  // idempotency key stable on the URL but with a short TTL so it only debounces
  // accidental double-clicks (each refresh is a real scrape + possible re-ingest),
  // not a genuine later re-refresh.
  idempotencyKey: (input) => `kag.scrape_refresh:${input.url}`,
  idempotencyTtlSeconds: 30,
  handler: async (input) => {
    const { send_to_kag, ...body } = input;
    return await refreshScrapeSource(body as Parameters<typeof refreshScrapeSource>[0], {
      send_to_kag,
    });
  },
};

const scrapeSitemapAction: AgentCallableAction<ScrapeSitemapInput, unknown> = {
  name: 'kag.scrape_sitemap',
  kind: 'write',
  description:
    'Scrape a sitemap, capped by max_urls and allowed_domains. Returns a session_id.',
  input: scrapeSitemapInput,
  output: sessionIdOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.scrape_sitemap:${input.sitemap_url}:${input.max_urls ?? ''}`,
  handler: async (input) => {
    const { send_to_kag, ...body } = input;
    return await scrapeSitemap(body as Parameters<typeof scrapeSitemap>[0], { send_to_kag });
  },
};

const scrapeBulkAction: AgentCallableAction<ScrapeBulkInput, unknown> = {
  name: 'kag.scrape_urls_bulk',
  kind: 'write',
  description:
    'Scrape a list of URLs as one source. With auth_config the whole batch is scraped behind one login (persisted + refreshable). Returns a session_id.',
  input: scrapeBulkInput,
  output: sessionIdOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: scraping your own knowledge auto-approves; a
  // non-human initiator (n8n / agent) still parks for human review.
  autoApproveForInitiator: true,
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.scrape_urls_bulk:${shortHash(input.urls.join(',') + ':' + (input.auth_config?.credential_id ?? ''))}`,
  handler: async (input) => {
    const { send_to_kag, ...body } = input;
    return await scrapeBulk(body as Parameters<typeof scrapeBulk>[0], { send_to_kag });
  },
};

const refreshSourceAction: AgentCallableAction<RefreshSourceInput, unknown> = {
  name: 'kag.refresh_source',
  kind: 'write',
  description:
    'Refresh a multi-page (sitemap/crawl/bulk) source: re-enumerate a sitemap (or re-scrape a crawl/bulk source\'s known pages) and re-ingest into KAG only the pages whose content changed. Returns { session_id, urls_queued }.',
  input: refreshSourceInput,
  output: refreshSourceOutput,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: refreshing your own source auto-approves.
  // A non-human initiator (n8n / agent) still parks for human review.
  autoApproveForInitiator: true,
  cronSafe: true,
  // Repeatable like scrape_refresh; short TTL debounces double-clicks only.
  idempotencyKey: (input) => `kag.refresh_source:${input.session_type}:${input.base_url}`,
  idempotencyTtlSeconds: 30,
  handler: async (input) => {
    return await refreshSourceMulti(input);
  },
};

const listSessionsAction: AgentCallableAction<ListSessionsInput, unknown> = {
  name: 'kag.list_sessions',
  kind: 'read',
  description:
    'List the calling user\'s recent KAG scrape sessions, ordered most-recent first.',
  input: listSessionsInput,
  output: passthrough,
  approval: { type: 'auto' },
  cronSafe: true,
  // Minute bucket so polling reads dedupe within a window.
  idempotencyKey: (input) =>
    `kag.list_sessions:${input.status ?? ''}:${input.limit ?? ''}:${Math.floor(Date.now() / 60_000)}`,
  handler: async (input) => {
    return await integListScrapeSessions(input);
  },
};

const getSessionAction: AgentCallableAction<SessionIdInput, unknown> = {
  name: 'kag.get_session',
  kind: 'read',
  description: 'Fetch full detail for one KAG scrape session.',
  input: sessionIdInput,
  output: passthrough,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.get_session:${input.session_id}:${Math.floor(Date.now() / 30_000)}`,
  handler: async (input) => {
    return await integGetScrapeSessionDetail(input.session_id);
  },
};

const listSessionImagesAction: AgentCallableAction<SessionIdInput, unknown> = {
  name: 'kag.list_session_images',
  kind: 'read',
  description:
    'List the captured image assets (screenshots, extracted images) for a KAG scrape session. Manifest only — bytes are streamed by the download routes.',
  input: sessionIdInput,
  output: passthrough,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.list_session_images:${input.session_id}:${Math.floor(Date.now() / 30_000)}`,
  handler: async (input) => await integListScrapeSessionImages(input.session_id),
};

const listDocumentImagesAction: AgentCallableAction<JobIdInput, unknown> = {
  name: 'kag.list_document_images',
  kind: 'read',
  description:
    'List the image assets extracted from a KAG document-parse job. Manifest only — bytes are streamed by the download routes.',
  input: jobIdInput,
  output: passthrough,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.list_document_images:${input.job_id}:${Math.floor(Date.now() / 30_000)}`,
  handler: async (input) => await integListDocumentJobImages(input.job_id),
};

const pauseSessionAction: AgentCallableAction<SessionIdInput, unknown> = {
  name: 'kag.pause_session',
  kind: 'write',
  description: 'Pause an in-flight KAG scrape session.',
  input: sessionIdInput,
  output: passthrough,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: false,
  idempotencyKey: (input) => `kag.pause_session:${input.session_id}`,
  handler: async (input) => await pauseScrapeSession(input.session_id),
};

const resumeSessionAction: AgentCallableAction<SessionIdInput, unknown> = {
  name: 'kag.resume_session',
  kind: 'write',
  description: 'Resume a previously paused KAG scrape session.',
  input: sessionIdInput,
  output: passthrough,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: false,
  idempotencyKey: (input) => `kag.resume_session:${input.session_id}`,
  handler: async (input) => await resumeScrapeSession(input.session_id),
};

const cancelSessionAction: AgentCallableAction<SessionIdInput, unknown> = {
  name: 'kag.cancel_session',
  kind: 'write',
  description: 'Cancel (delete) a KAG scrape session.',
  input: sessionIdInput,
  output: passthrough,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: false,
  idempotencyKey: (input) => `kag.cancel_session:${input.session_id}`,
  handler: async (input) => await deleteScrapeSession(input.session_id),
};

const getDocumentJobAction: AgentCallableAction<JobIdInput, unknown> = {
  name: 'kag.get_document_job',
  kind: 'read',
  description: 'Poll the status of an asynchronous document upload/parsing job.',
  input: jobIdInput,
  output: passthrough,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.get_document_job:${input.job_id}:${Math.floor(Date.now() / 30_000)}`,
  handler: async (input) => await getDocumentJobStatus(input.job_id),
};

const getBatchStatusAction: AgentCallableAction<BatchIdInput, unknown> = {
  name: 'kag.get_batch_status',
  kind: 'read',
  description: 'Poll the status of a batch document-upload job.',
  input: batchIdInput,
  output: passthrough,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `kag.get_batch_status:${input.batch_id}:${Math.floor(Date.now() / 30_000)}`,
  handler: async (input) => await getBatchStatus(input.batch_id),
};

const retryBatchAction: AgentCallableAction<BatchIdInput, unknown> = {
  name: 'kag.retry_failed_batch_jobs',
  kind: 'write',
  description: 'Re-queue the failed jobs of a batch for another attempt.',
  input: batchIdInput,
  output: passthrough,
  approval: { type: 'single-approver', approver: 'initiator' },
  // Human self-service KAG ingest: a person uploading/scraping their own
  // knowledge auto-approves (no one else to gate on). A non-human initiator
  // (n8n / agent) still parks for human review. See autoApproveForInitiator.
  autoApproveForInitiator: true,
  cronSafe: true,
  idempotencyKey: (input) => `kag.retry_failed_batch_jobs:${input.batch_id}`,
  handler: async (input) => await retryFailedBatchJobs(input.batch_id),
};

const ALL_ACTIONS: AgentCallableAction<unknown, unknown>[] = [
  uploadAction as AgentCallableAction<unknown, unknown>,
  uploadSyncAction as AgentCallableAction<unknown, unknown>,
  scrapeUrlAction as AgentCallableAction<unknown, unknown>,
  scrapeRefreshAction as AgentCallableAction<unknown, unknown>,
  scrapeSitemapAction as AgentCallableAction<unknown, unknown>,
  scrapeBulkAction as AgentCallableAction<unknown, unknown>,
  refreshSourceAction as AgentCallableAction<unknown, unknown>,
  listSessionsAction as AgentCallableAction<unknown, unknown>,
  getSessionAction as AgentCallableAction<unknown, unknown>,
  listSessionImagesAction as AgentCallableAction<unknown, unknown>,
  listDocumentImagesAction as AgentCallableAction<unknown, unknown>,
  pauseSessionAction as AgentCallableAction<unknown, unknown>,
  resumeSessionAction as AgentCallableAction<unknown, unknown>,
  cancelSessionAction as AgentCallableAction<unknown, unknown>,
  getDocumentJobAction as AgentCallableAction<unknown, unknown>,
  getBatchStatusAction as AgentCallableAction<unknown, unknown>,
  retryBatchAction as AgentCallableAction<unknown, unknown>,
];

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

// Apply PUBLIC_RBAC uniformly — see comment near uploadAction.
for (const a of ALL_ACTIONS) {
  (a as { rbac?: typeof PUBLIC_RBAC }).rbac = PUBLIC_RBAC;
}

for (const a of ALL_ACTIONS) safeRegister(a);

// ---------------------------------------------------------------------------
// HTTP route handlers
// ---------------------------------------------------------------------------

async function readMultipart(req: Request): Promise<{
  file_b64: string;
  filename: string;
  content_type?: string;
  send_to_kag?: boolean;
  extract_images?: boolean;
  credential_id?: string;
  byte_size: number;
}> {
  let fd: Awaited<ReturnType<Request['formData']>>;
  try {
    fd = await req.formData();
  } catch (err) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'multipart parse failed',
      cause: err,
    });
  }
  const file = fd.get('file');
  if (!(file instanceof Blob)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'multipart "file" field missing',
    });
  }
  const filename =
    typeof (file as { name?: unknown }).name === 'string' &&
    (file as { name: string }).name.length > 0
      ? (file as { name: string }).name
      : (fd.get('filename') as string | null) ?? 'upload.bin';
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const file_b64 = btoa(bin);
  const sendRaw = fd.get('send_to_kag');
  const extractRaw = fd.get('extract_images');
  const credentialRaw = fd.get('credential_id');
  return {
    file_b64,
    filename,
    content_type: file.type || undefined,
    send_to_kag:
      sendRaw === null
        ? undefined
        : String(sendRaw).toLowerCase() === 'true' || sendRaw === '1',
    extract_images:
      extractRaw === null
        ? undefined
        : String(extractRaw).toLowerCase() === 'true' || extractRaw === '1',
    credential_id:
      typeof credentialRaw === 'string' && credentialRaw.length > 0
        ? credentialRaw
        : undefined,
    byte_size: bytes.length,
  };
}

export async function handleUploadDocument(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const parsed = await readMultipart(req);
    // Spec §11 — credential ownership ONLY runs when the request actually
    // carries a credential_id. Most uploads don't (multipart file body is
    // self-contained); the check is here so a future upload that opts into
    // a stored credential cannot bypass tenancy.
    if (parsed.credential_id) {
      await verifyCredentialOwnership(parsed.credential_id, user);
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.upload_document', parsed, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleUploadDocumentSync(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const parsed = await readMultipart(req);
    // Spec §4 — sync uploads are size-gated BEFORE the upstream call so we
    // never push >2 MB at the synchronous parser. 413 is the canonical signal
    // to fall back to POST /api/tools/kag/documents (async).
    if (parsed.byte_size >= SYNC_UPLOAD_MAX_BYTES) {
      return payloadTooLargeResponse(parsed.byte_size);
    }
    if (parsed.credential_id) {
      await verifyCredentialOwnership(parsed.credential_id, user);
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    const result = await invokeAction('kag.upload_document_sync', parsed, ctx);

    // Record an fr `documents` row so the durable PHI this ingest wrote to KAG
    // stays reachable by right-to-delete (the shared writer extracts the purge
    // keys, refuses a NULL-tenant durable row with 422, and mirrors the async
    // upload row). Only when:
    //   - the write executed inline (self-approved human ingest) rather than
    //     parking — a PendingAction means nothing was ingested yet, and the
    //     parked path records its own row in resolvePendingAction; and
    //   - send_to_kag was not explicitly false — a parse-only upload leaves no
    //     durable KAG footprint, so there is nothing to purge.
    // Tenant resolves from the request frame first (the value forwarded as
    // X-Tenant-Id on the upstream ingest), then the authenticated user's tenant
    // as the AUTH_BYPASS fallback — identical to the async upload path.
    if (!isPending(result) && parsed.send_to_kag !== false) {
      await recordSyncUploadRow({
        userId: user.id,
        tenantId: tryGetRequestContext()?.tenantId ?? user.tenantId ?? null,
        filename: parsed.filename,
        fileSize: parsed.byte_size,
        mimeType: parsed.content_type,
        result,
      });
    }
    return envelope(result);
  });
}

export async function handleScrapeUrl(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const body = await readJsonBody<unknown>(req);
    const parsed = scrapeUrlInput.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    if (parsed.data.auth_config?.credential_id) {
      await verifyCredentialOwnership(parsed.data.auth_config.credential_id, user);
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.scrape_url', parsed.data, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleScrapeRefresh(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const body = await readJsonBody<unknown>(req);
    const parsed = scrapeRefreshInput.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.scrape_refresh', parsed.data, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleScrapeSitemap(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const body = await readJsonBody<unknown>(req);
    const parsed = scrapeSitemapInput.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.scrape_sitemap', parsed.data, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleScrapeBulk(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const body = await readJsonBody<unknown>(req);
    const parsed = scrapeBulkInput.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.scrape_urls_bulk', parsed.data, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleRefreshSource(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const body = await readJsonBody<unknown>(req);
    const parsed = refreshSourceInput.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const limited = await checkConcurrencyLimit();
    if (limited) return limited;
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.refresh_source', parsed.data, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleListSessions(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const url = new URL(req.url);
    const raw: Record<string, unknown> = {};
    if (url.searchParams.has('status')) {
      raw.status = url.searchParams.get('status') ?? undefined;
    }
    if (url.searchParams.has('limit')) {
      raw.limit = Number(url.searchParams.get('limit'));
    }
    const parsed = listSessionsInput.safeParse(raw);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.list_sessions', parsed.data, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleGetSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.get_session', { session_id: sessionId }, ctx),
      (data) => envelope(data),
    );
  });
}

// --- Scraped visual evidence (read-only) ---------------------------------
// JSON manifests go through the action registry (like get_session); the image
// BYTES are streamed straight through so an <img> can render them. All GET.

export async function handleListSessionImages(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () =>
        invokeAction('kag.list_session_images', { session_id: sessionId }, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleListDocumentImages(
  req: Request,
  jobId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.list_document_images', { job_id: jobId }, ctx),
      (data) => envelope(data),
    );
  });
}

/**
 * Re-wrap a streamed upstream image response, hardening it with `nosniff` so a
 * browser can't be coaxed into content-type confusion on user-scraped bytes.
 * The upstream content-type (set by the proxy helper) is preserved.
 */
function withNoSniff(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export async function handleGetSessionScreenshot(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    await validateAuth(req);
    return withNoSniff(await proxyScrapeScreenshot(req, sessionId));
  });
}

export async function handleDownloadSessionImage(
  req: Request,
  sessionId: string,
  imageId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    await validateAuth(req);
    return withNoSniff(await proxyScrapeSessionImage(req, sessionId, imageId));
  });
}

export async function handleDownloadDocumentImage(
  req: Request,
  jobId: string,
  imageId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    await validateAuth(req);
    return withNoSniff(await proxyDocumentJobImage(req, jobId, imageId));
  });
}

export async function handlePauseSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.pause_session', { session_id: sessionId }, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleResumeSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.resume_session', { session_id: sessionId }, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleCancelSession(
  req: Request,
  sessionId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.cancel_session', { session_id: sessionId }, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleGetDocumentJob(
  req: Request,
  jobId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.get_document_job', { job_id: jobId }, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleGetBatchStatus(
  req: Request,
  batchId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () => invokeAction('kag.get_batch_status', { batch_id: batchId }, ctx),
      (data) => envelope(data),
    );
  });
}

export async function handleRetryFailedBatch(
  req: Request,
  batchId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const ctx = buildCtx(user);
    return await handle(
      () =>
        invokeAction('kag.retry_failed_batch_jobs', { batch_id: batchId }, ctx),
      (data) => envelope(data),
    );
  });
}
