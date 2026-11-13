// src/routes/documents.ts
import { randomUUID } from 'node:crypto';
import { db, documents } from '../db/client';
import { eq, and, or, sql } from 'drizzle-orm';
import { loadTenantScopedProject, loadProjectForRead } from '../lib/project-access';
import { validateAuth } from '../middleware/auth';
import {
  uploadDocument,
  deleteDocument,
  getDocumentJobStatus,
  mapJobStatusToRow,
  deriveIngestionProgress,
  type IngestionProgress,
} from '../integrations/kag';
import {
  IntegrationError,
  clientSafeCaughtErrorText,
  shouldRedactUpstreamDetailForCaller,
} from '../integrations/_lib/errors';
import {
  tryGetRequestContext,
  withRequestContext,
  type RequestContext,
} from '../integrations/_lib/context';
import { tryCtxTenantId } from '../middleware/request-context';
import { isUuidShape } from '../lib/uuid-shape';
import { AppError, BadRequestError, NotFoundError, ValidationError } from '../utils/errors';
import { jsonResponse, createdResponse } from '../utils/response';
import { config } from '../config';

/**
 * SQL predicate for what the Documents tab may list: the caller's ACTIVE
 * WORKSPACE **union** the caller's OWN uploads.
 *
 * WHY A UNION AND NOT A SWAP. This filter used to be `eq(user_id, caller)`
 * alone — a USER scope with no tenant filter at all — while KAG Ask is
 * WORKSPACE-scoped (by X-Tenant-Id). The two halves of the same page therefore
 * disagreed about what this workspace contains: a colleague's upload was
 * answerable by Ask but absent from the list, so a tester sees an answer citing
 * a document the Documents tab says does not exist.
 *
 * Swapping to a plain tenant scope would be STRICTLY WORSE than the bug. Tenant
 * fragmentation is real and still present in prod data — see the migration-083
 * note in `handleUploadDocument` — so some rows carry a Keycloak USER id in
 * `tenant_id`, and a single user legitimately owns rows under more than one
 * tenant. Measured on prod 2026-08-31: over every (user, candidate tenant) pair
 * a tenant-only filter removed 18 row-visibilities that exist today, while the
 * union removed 0. The union's whole contract is that it is a SUPERSET — the
 * workspace's other documents become visible, and nothing a user can already
 * see disappears.
 *
 * NULL tenant: the owner arm stays decisive by SQL three-valued logic
 * (`NULL = <tenant> OR user_id = <caller>` ⇒ TRUE). Migration 089 made the
 * column NOT NULL so no live path can mint such a row any more, but the OR must
 * not be rewritten as a COALESCE/AND that would drop it.
 *
 * `activeTenantId` may be null: with neither a request frame nor a JWT tenant
 * claim there is no workspace to widen to, and the filter degrades to exactly
 * today's owner-only behaviour rather than throwing on a read path.
 */
function userVisibleDocumentsFilter(userId: string, activeTenantId: string | null) {
  const ownedByCaller = eq(documents.user_id, userId);
  if (!activeTenantId) return ownedByCaller;
  return or(eq(documents.tenant_id, activeTenantId), ownedByCaller);
}

// GET /api/documents - List documents visible to the caller: everything in
// their active workspace, plus everything they own (see
// userVisibleDocumentsFilter). Optionally filtered by project_id.
export async function handleListUserDocuments(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');

  // Same tenant resolution every other tenant-scoped route uses — the request
  // frame first (so the super-admin X-Active-Tenant workspace switcher actually
  // re-scopes this list), falling back to the JWT tenant claim. Deliberately the
  // SOFT variant: `ctxTenantId()` throws when neither is available, and a list
  // read must not 500 where it previously returned the caller's own documents.
  const activeTenantId = tryCtxTenantId() ?? user.tenantId ?? null;
  const scope = userVisibleDocumentsFilter(user.id, activeTenantId);

  const userDocuments = await db.select()
    .from(documents)
    .where(projectId ? and(scope, eq(documents.project_id, projectId)) : scope);

  return jsonResponse({
    items: userDocuments.map((d) => ({
      ...d,
      error_message: clientSafeDocumentErrorMessage(d.error_message),
    })),
    total: userDocuments.length,
  });
}

// POST /api/documents/upload - Upload document
export async function handleUploadDocument(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  // A body that is not multipart/form-data (no / wrong content-type, or an
  // unparsable multipart body) makes `req.formData()` throw — that is the
  // CALLER's fault, so it is a 400, not fr's 500. Only the inbound parse is
  // caught here; anything else keeps its own status.
  let formData: Awaited<ReturnType<Request["formData"]>>;
  try {
    formData = await req.formData();
  } catch (err) {
    if (err instanceof TypeError || err instanceof SyntaxError) {
      throw new BadRequestError('multipart/form-data body required');
    }
    throw err;
  }
  const file = formData.get('file') as File;
  // `project_id` is OPTIONAL. Absent → workspace-scoped knowledge: the document
  // is ingested into the tenant KAG graph (scoped by X-Tenant-Id, not by
  // project) and is usable by every workflow in the workspace. When present it
  // additionally pins the fr-side `documents` row to that project (and the
  // owner is verified). An empty-string form field counts as absent.
  const projectIdRaw = formData.get('project_id');
  const projectId =
    typeof projectIdRaw === 'string' && projectIdRaw.trim() !== ''
      ? projectIdRaw
      : null;
  // "Send to KAG" opt-out: when explicitly "false", the upstream parses but
  // skips graph ingestion — content stays available via /api/documents but
  // does not become tenant/project knowledge. Default ON: anything other
  // than the literal string "false" is treated as true.
  const sendToKagRaw = formData.get('send_to_kag');
  const sendToKag = !(typeof sendToKagRaw === 'string' && sendToKagRaw.toLowerCase() === 'false');

  if (!file) {
    throw new ValidationError('No file provided');
  }

  // Verify file type. Browsers append parameters to the upload's MIME type
  // (e.g. a .txt comes through as `text/plain;charset=utf-8`), so compare the
  // BASE media type — not the raw header — against the allow-list. Without
  // this, every plain-text upload 422s with "File type ... not allowed".
  const baseMimeType = ((file.type || '').split(';')[0] ?? '').trim().toLowerCase();
  if (!(config.upload.allowedTypes as readonly string[]).includes(baseMimeType)) {
    throw new ValidationError(`File type ${file.type || 'unknown'} not allowed`);
  }

  // Verify file size
  const maxSize = config.upload.maxSizeMB * 1024 * 1024;
  if (file.size > maxSize) {
    throw new ValidationError(`File size exceeds ${config.upload.maxSizeMB}MB limit`);
  }

  // Only verify project existence + ownership when one was supplied. A
  // workspace-scoped upload (no project_id) skips this — the tenant boundary is
  // still enforced upstream via X-Tenant-Id.
  if (projectId) {
    await loadTenantScopedProject(db, user, projectId);
  }

  // Capture the upload's tenant NOW (inside the live request frame) so the
  // background reconcile can rebuild a context and fetch the correct tenant's
  // kag job — the `documents` row otherwise has no tenant. Also the
  // tenant-fragmentation diagnostic surface (migration 083).
  //
  // REFUSE rather than store NULL. This is the write half of the
  // record-and-replay invariant the purge depends on: the delete replays
  // `documents.tenant_id` verbatim (never re-derives it — derivation legitimately
  // varies per request). A NULL-tenant row is un-purgeable: nothing records which
  // tenant's graph holds its chunks, and a purge under the deleter's tenant is a
  // 200-with-zeros no-op that orphans PHI. A row we cannot delete must not be
  // created. (The pre-083 rows that already exist are why there is still no NOT
  // NULL constraint on the column.)
  //
  // Resolve the tenant from the request frame, falling back to the authenticated
  // user's own tenant. The fallback is load-bearing, not cosmetic:
  // `buildRequestContext` populates `tenantId` ONLY from a cryptographically
  // verified bearer JWT, and it knows nothing about AUTH_BYPASS — so under
  // AUTH_BYPASS (a local e2e stack) the frame carries NO tenant while
  // `validateAuth` still returns a synthetic user with one
  // (AUTH_BYPASS_TENANT_ID, default all-zeros). Refusing on the frame
  // alone would 422 every dev upload. In prod the two agree: both derive from the
  // same verified token (`X-Active-Tenant` can move the frame's tenant, and the
  // frame WINS here — it is the tenant the ingest is actually written under).
  const uploadCtx = tryGetRequestContext();
  const uploadTenantId = uploadCtx?.tenantId ?? user.tenantId ?? null;
  if (!uploadTenantId) {
    throw new AppError(
      422,
      'Upload refused: no tenant could be resolved for this request. The document ' +
        'could not be purged later (its tenant would be unrecorded), so it is not ingested.',
    );
  }

  // Create document record. The upload is NOT persisted to local disk — the
  // file BYTES stream straight to kag below (the local copy was orphaned the
  // moment #307 switched the transport to multipart-bytes), so there is no
  // ephemeral pod-fs artifact to lose on restart and no `file_path` to store.
  const [document] = await db.insert(documents).values({
    project_id: projectId ?? null,
    user_id: user.id,
    filename: file.name,
    file_size: file.size,
    mime_type: baseMimeType,
    status: 'pending',
    tenant_id: uploadTenantId,
  }).returning();

  if (!document) {
    throw new Error('Failed to create document');
  }

  // Submit to KAG asynchronously (don't wait). The upload streams the file
  // BYTES to the kag gateway (`POST /ingest/documents`), which forwards to the
  // ingestion service where every upload is virus-scanned by ClamAV
  // (fail-closed) before it is parsed or indexed — an infected file is
  // rejected with HTTP 400 and never enters the knowledge graph. See
  // ARCHITECTURE.md §"Document upload & virus scanning".
  //
  // `send_to_kag=false` still scans + parses but skips graph ingestion — the
  // document stays browseable via /api/documents but does NOT become
  // tenant/project KAG knowledge.
  //
  // Capture the request context NOW (synchronously, inside the active
  // `withRequestContext` frame) and re-bind it inside the detached task so the
  // upstream call still carries `X-Tenant-Id` — otherwise kag would fall back
  // to the default tenant and scope the document to the wrong tenant.
  //
  // Pin `uploadTenantId` onto that frame: it is the value we just RECORDED on the
  // row, so the ingest MUST be written under exactly it or the delete's replay
  // would purge a tenant the chunks were never in. This closes the AUTH_BYPASS
  // hole where the frame had no tenant, the outbound call therefore sent no
  // X-Tenant-Id, and kag silently wrote the chunks under ITS default tenant.
  const ctx: RequestContext = {
    ...(uploadCtx ?? { correlationId: randomUUID(), initiator: 'human', channel: 'web' }),
    tenantId: uploadTenantId,
  };
  submitToKAG(document.id, file, file.name, sendToKag, ctx).catch(error => {
    console.error('KAG submission failed:', error);
  });

  return createdResponse({
    id: document.id,
    project_id: document.project_id,
    filename: document.filename,
    file_size: document.file_size,
    file_type: document.mime_type,
    status: document.status,
    send_to_kag: sendToKag,
    created_at: document.created_at,
  });
}

// kag's async upload response (DocumentUploadResponse). The gateway forwards
// the file bytes to the ingestion service, which scans then queues parsing;
// `pages_detected` is not known yet and arrives via the status-poll callback.
interface KagUploadResponse {
  job_id?: string;
  status?: string;
  message?: string;
}

/** How a failed KAG upload maps onto the local `documents` row. */
export type KagFailure = { status: 'rejected' | 'failed'; message: string };

/**
 * Classify a KAG upload error.
 *
 * - ClamAV-rejected (HTTP 400 whose body names a virus / "upload rejected") →
 *   `'rejected'`. Uploads stream straight to kag (no local persistence), so the
 *   infected bytes never touched fr's disk — there is nothing to evict.
 * - Scanner unavailable while fail-closed (HTTP 503) → `'failed'` (transient,
 *   retriable).
 * - Anything else → `'failed'` with a client-safe sentence (never the
 *   upstream detail; it is logged by the caller).
 */
export function classifyKagFailure(error: unknown): KagFailure {
  if (error instanceof IntegrationError) {
    const body =
      typeof error.upstreamBody === 'string'
        ? error.upstreamBody
        : JSON.stringify(error.upstreamBody ?? '');
    if (error.upstreamStatus === 400 && /infect|virus|upload rejected/i.test(body)) {
      // ⛔ Never the body: it is kag's proxy wrapper around the ingestion
      // service's own response ("Backend service error (400): {...}"), stored
      // on the row and shown to the customer. The verdict is what they need;
      // the signature name is on the caller's log line.
      return { status: 'rejected', message: VIRUS_SCAN_REJECTED_MESSAGE };
    }
    if (error.upstreamStatus === 503) {
      return {
        status: 'failed',
        message: 'Virus scan unavailable (scanner offline) — document not ingested',
      };
    }
    // ⛔ Never the upstream body/status here: this string is stored on the row
    // and shown to the customer, and kag's body names internal services and
    // paths. The caller's catch already logged the full error.
    if (error.upstreamStatus !== undefined && KAG_CALLER_INPUT_STATUSES.has(error.upstreamStatus)) {
      return { status: 'failed', message: INGESTION_REJECTED_MESSAGE };
    }
    return { status: 'failed', message: INGESTION_FAILED_MESSAGE };
  }
  return { status: 'failed', message: INGESTION_FAILED_MESSAGE };
}

/** Stored + shown when the upstream virus scan refused the file. */
export const VIRUS_SCAN_REJECTED_MESSAGE =
  'Rejected by virus scan — the file was not ingested';
/**
 * Rows written before the body was dropped read `Rejected by virus scan: <kag
 * body>`. The column keeps them (operator triage); a non-super-admin reader
 * gets the verdict sentence instead.
 */
const LEGACY_VIRUS_SCAN_PREFIX = 'Rejected by virus scan: ';
export function clientSafeDocumentErrorMessage(raw: string | null): string | null {
  if (raw === null || !raw.startsWith(LEGACY_VIRUS_SCAN_PREFIX)) return raw;
  return shouldRedactUpstreamDetailForCaller() ? VIRUS_SCAN_REJECTED_MESSAGE : raw;
}

/** Client-safe text for a non-virus, non-scanner-offline ingestion failure. */
export const INGESTION_FAILED_MESSAGE = 'Ingestion failed — try again';
/** The upstream refused the FILE itself (format/size): retrying will not help. */
export const INGESTION_REJECTED_MESSAGE =
  'The file could not be ingested — check its format and size';
const KAG_CALLER_INPUT_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

async function submitToKAG(
  documentId: string,
  file: File,
  filename: string,
  sendToKag: boolean,
  ctx: RequestContext | undefined,
): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      // Update status to processing
      await db.update(documents)
        .set({ status: 'processing', updated_at: new Date() })
        .where(eq(documents.id, documentId));

      // Stream the file BYTES to kag `/ingest/documents` via the shared client
      // (injects X-Tenant-Id from the bound request context). The downstream
      // ingestion service virus-scans the bytes (fail-closed) BEFORE queueing
      // parse/graph work; an infected file raises HTTP 400 here. send_to_kag
      // plumbed through so the opt-out ("parse only, do not index") is a toggle.
      const result = (await uploadDocument({
        file,
        send_to_kag: sendToKag,
      })) as KagUploadResponse;

      // Record the KAG job reference. `pages_detected` is not in the async
      // response — it is filled later by the status poll / orchestrator
      // callback. When sendToKag=false the upstream parses but produces no
      // graph node, so we mark the row 'parsed' to distinguish opt-out
      // documents; otherwise leave 'processing' for the callback to complete.
      const update: Record<string, unknown> = {
        kag_ingestion_id: result?.job_id,
        updated_at: new Date(),
      };
      if (!sendToKag) {
        update.status = 'parsed';
      }
      await db.update(documents).set(update).where(eq(documents.id, documentId));
    } catch (error) {
      console.error('KAG submission failed:', error);

      const failure = classifyKagFailure(error);
      await db.update(documents)
        .set({
          status: failure.status,
          error_message: failure.message,
          updated_at: new Date(),
        })
        .where(eq(documents.id, documentId));
    }
  };

  // Re-bind the captured request frame so the detached task's upstream call
  // carries the per-user tenant; fall back to a bare run if there is none.
  return ctx ? withRequestContext(ctx, run) : run();
}

// GET /api/documents/:id/status - Get document status
export async function handleGetDocumentStatus(req: Request, documentId: string): Promise<Response> {
  const user = await validateAuth(req);

  // `documents.id` is a `uuid` column (schema.ts:235). A `:id` segment that is
  // not UUID-shaped does not miss the row — it aborts the query with 22P02
  // `invalid input syntax for type uuid`, which escapes as a bare 500 on a path
  // the Documents tab POLLS. Answer the SAME 404 the visibility-filter miss
  // gets below, so malformed is indistinguishable from out-of-scope/absent.
  // `isUuidShape` rather than `isValidUuid` (utils/tenant): shape only, so a
  // legal `uuid` literal with a non-RFC version nibble still resolves its row.
  if (!isUuidShape(documentId)) {
    throw new NotFoundError('Document not found');
  }

  const [doc] = await db.select()
    .from(documents)
    // READ scope must match the LIST scope, or a document the Documents tab
    // just rendered 404s the moment it is clicked. Same union as
    // handleListUserDocuments — workspace OR owner. Deliberately NOT applied to
    // handleDeleteDocument below: seeing a colleague's document and destroying
    // it are different authorities, and delete stays owner-only.
    .where(and(
      eq(documents.id, documentId),
      userVisibleDocumentsFilter(user.id, tryCtxTenantId() ?? user.tenantId ?? null)
    ));

  if (!doc) {
    throw new NotFoundError('Document not found');
  }

  // Lazy reconcile: while a doc is still in-flight, `submitToKAG` has only
  // recorded the upstream `kag_ingestion_id` — nothing else flips it out of
  // `processing`. The frontend polls this endpoint every few seconds, so we
  // settle the row here by reading the kag job once and mapping its terminal
  // state onto the row. This runs inside the live request frame, so the kag
  // client inherits X-Tenant-Id for the correct tenant graph (no ctx re-bind).
  //
  // Strictly non-fatal: a flaky/absent upstream must not break the status read,
  // and a transient poll error must NOT mark the row failed — only an explicit
  // upstream terminal status (via mapJobStatusToRow) ever does.
  let row = doc;
  // Staged progress for the upload stepper — a read-through view of the live
  // upstream job (no DB columns). Only populated while in-flight, when we
  // already fetch the job for the reconcile below; once the row is terminal the
  // frontend renders the final state from `status` alone (no extra upstream hop).
  let progress: IngestionProgress | null = null;
  const isInFlight = doc.status === 'pending' || doc.status === 'processing';
  if (isInFlight && doc.kag_ingestion_id) {
    try {
      const job = await getDocumentJobStatus(doc.kag_ingestion_id);
      progress = deriveIngestionProgress(job);
      const patch = mapJobStatusToRow(job);
      if (Object.keys(patch).length > 0) {
        // Same scope as the SELECT that fetched `doc` a few lines up. Left at
        // owner-only, this reconcile silently no-ops for a colleague viewing a
        // shared in-flight document: `updated` is undefined, `row` keeps the
        // stale terminal status, and the row only settles when the OWNER next
        // polls or the background sweep runs. A read that is allowed to fetch
        // the row must be allowed to write back what it just learned about it.
        const [updated] = await db.update(documents)
          .set({ ...patch, updated_at: new Date() })
          .where(and(
            eq(documents.id, doc.id),
            userVisibleDocumentsFilter(user.id, tryCtxTenantId() ?? user.tenantId ?? null),
          ))
          .returning();
        if (updated) row = updated;
      }
    } catch (error) {
      console.error(
        `Document status reconcile failed for ${doc.id} (job ${doc.kag_ingestion_id}):`,
        error,
      );
    }
  }

  return jsonResponse({
    id: row.id,
    project_id: row.project_id,
    filename: row.filename,
    status: row.status,
    pages_detected: row.pages_detected,
    entities_extracted: row.entities_extracted,
    error_message: clientSafeDocumentErrorMessage(row.error_message),
    // Migration 099 — KAG degradation, read from the PERSISTED row and returned
    // UNCONDITIONALLY. Unlike `progress` (in-flight only, a live upstream
    // read-through), these must survive on every poll of a SETTLED document:
    // the whole defect is that a finished, silently-incomplete ingestion renders
    // green forever after the last in-flight poll. NULL = unknown; a consumer
    // must not treat `false` and `null` alike.
    kag_degraded: row.kag_degraded,
    kag_degraded_reason: row.kag_degraded_reason,
    kag_degraded_stage: row.kag_degraded_stage,
    chunks_indexed: row.chunks_indexed,
    chunks_failed: row.chunks_failed,
    chunks_total: row.chunks_total,
    created_at: row.created_at,
    updated_at: row.updated_at,
    progress,
  });
}

// GET /api/projects/:id/documents - List project documents
export async function handleListProjectDocuments(req: Request, projectId: string): Promise<Response> {
  const user = await validateAuth(req);

  // Verify project ownership in the requester's active tenant.
  // READ lane: cross-tenant for a super-admin in HOME view only.
  // ⛔ The mutating handlers in this file stay on `loadTenantScopedProject`.
  await loadProjectForRead(db, user, projectId);

  const projectDocuments = await db.select()
    .from(documents)
    .where(eq(documents.project_id, projectId));

  return jsonResponse({
    items: projectDocuments,
    total: projectDocuments.length,
  });
}

// The subset of a `documents` row the fail-closed purge needs. Both the
// single-document delete and the project-wide purge feed rows through the SAME
// helper (`purgeDocumentDownstreamPhi`) so the HIPAA right-to-delete guardrail
// has exactly one code path and cannot drift between callers.
interface PurgeableDocument {
  id: string;
  kag_document_id: string | null;
  kag_ingestion_id: string | null;
  tenant_id: string | null;
}

/**
 * Purge ONE document's downstream PHI via the ingestion coordinator. Fail-closed
 * and idempotent: it THROWS on any problem so the caller keeps the fr row(s) and
 * the delete stays retryable — it never returns having failed to destroy PHI.
 *
 * Fail-closed cascade: this purges the document's downstream PHI (kag_graph
 * chunks + entities + Neo4j, orchestrator job state, MinIO images, ingestion_jobs)
 * via the ingestion coordinator. Callers MUST invoke this BEFORE removing the fr
 * row, so a purge failure leaves the fr row intact and the delete is retryable
 * rather than leaving an fr row deleted while PHI lingers downstream. The
 * coordinator is idempotent, so a retry safely completes a partially-applied
 * purge. Documents with no purge key (parse-only / never forwarded) have no
 * downstream footprint and are a safe no-op.
 *
 * Purge KEY: prefer the stable, content-derived `kag_document_id` (migration 087) —
 * it is the identity chunks/graph nodes are actually written under, so it purges a
 * re-ingested document whole (every run), whereas the per-run `kag_ingestion_id`
 * names only ONE run. Fall back to `kag_ingestion_id` for rows that have not settled
 * yet (id not known until the worker parses) and for pre-087 rows. Ingestion's purge
 * resolves EITHER key — its durable `document_runs` bridge maps job_id → document_id
 * and fans back out to every run — so both are safe; the stable id is just complete.
 *
 * Purge TENANT: record-and-replay. Every downstream DELETE is tenant-scoped and
 * idempotent, so a purge issued under the WRONG tenant deletes 0 rows and still
 * returns HTTP 200 — indistinguishable from "already purged". We therefore replay
 * the tenant the document was INGESTED under (`documents.tenant_id`, captured in the
 * same request frame that supplied the ingest's X-Tenant-Id — migration 083) and never
 * re-derive it from the deleter's context: derivation legitimately varies per request
 * (the `sub` fallback for unprovisioned users; a super-admin switching workspaces via
 * X-Active-Tenant), so the deleter's tenant is not necessarily the uploader's.
 *
 * Pre-083 rows recorded no tenant. For those fr cannot name the graph that holds the
 * chunks, and guessing produces a silent zero-effect purge that deletes the fr row and
 * orphans the PHI forever. So we REFUSE (409) and keep the row: an operator must purge
 * with the document's real tenant. NOTE this is deliberately NOT a check on the purge's
 * returned counts — an all-zero purge on a row that HAS a recorded tenant is genuinely
 * "already purged / never had chunks", and failing on that would make such a document
 * permanently undeletable.
 */
async function purgeDocumentDownstreamPhi(doc: PurgeableDocument): Promise<void> {
  const purgeKey = doc.kag_document_id ?? doc.kag_ingestion_id;
  if (!purgeKey) return;

  const purgeTenantId = doc.tenant_id?.trim();
  // REACHABILITY (checked 2026-07-29): migration 089 made `documents.tenant_id`
  // NOT NULL, after scripts/repair-document-tenant.ts fixed the four legacy prod
  // rows. So the NULL case this branch was written for is now IMPOSSIBLE for any
  // real row — the schema forbids it, and the TS type only still admits null
  // because the drizzle model predates 089.
  //
  // The branch is kept, and is NOT dead code, because NOT NULL does not imply
  // non-empty: `''` and `'   '` are both schema-legal and both produce exactly the
  // silent wrong-tenant purge (0 rows deleted, HTTP 200, PHI orphaned) that this
  // guard exists to refuse. It is now a defence-in-depth check on emptiness rather
  // than the live legacy-row path it originally was.
  if (!purgeTenantId) {
    throw new AppError(
      409,
      'Document cannot be deleted: it predates tenant capture (migration 083), so the ' +
        'tenant its KAG data was ingested under was never recorded. Purging under your ' +
        'tenant would delete nothing and orphan the data, so the delete is refused. ' +
        'An operator must restore the original tenant first — see ' +
        'scripts/repair-document-tenant.ts — after which this delete purges normally.',
      { document_id: doc.id, purge_key: purgeKey, reason: 'tenant_not_recorded' },
    );
  }

  try {
    await deleteDocument(purgeKey, { tenantId: purgeTenantId });
  } catch (err) {
    // `detail` rides out as AppError.details (handleError renders it), so it is
    // the client-safe text; the raw KAG sentence goes to the log.
    console.warn('[documents.purge] KAG purge failed:', err);
    const detail = clientSafeCaughtErrorText(err, 'KAG purge failed');
    // A MISSING_TENANT refusal is the adapter's own fail-closed guard (defence in
    // depth behind the pre-check above) — nothing was sent, and retrying the same
    // request cannot succeed. Reporting it as a retryable 502 would be a lie; it is
    // the same 409 the pre-check raises.
    if (err instanceof IntegrationError && err.code === 'MISSING_TENANT') {
      throw new AppError(409, err.message, {
        document_id: doc.id,
        purge_key: purgeKey,
        reason: 'tenant_not_recorded',
      });
    }
    // IDEMPOTENCY: a purge whose target is ALREADY GONE has succeeded.
    //
    // purgeAndDeleteProjectDocuments purges doc-by-doc and can throw mid-loop,
    // leaving earlier documents purged UPSTREAM while their fr rows survive
    // (the fr rows are only dropped after every purge succeeds). On the retry
    // those documents are purged again and KAG answers 404 — because we already
    // destroyed them. The http client raises IntegrationError on ANY non-2xx,
    // 404 included, which landed here as a retryable-looking 502 that could
    // never actually succeed: the project became PERMANENTLY UNDELETABLE, and
    // the remaining documents' PHI could never be purged either.
    //
    // Applies to THIS call only — the document purge/delete. Reads elsewhere in
    // the codebase keep their 404 semantics; nothing about this branch is
    // reachable from a GET.
    if (err instanceof IntegrationError && err.upstreamStatus === 404) {
      if (isRouteMissing404(err)) {
        // NOT "already purged" — this is fr's path having drifted from the
        // gateway's route table. Swallowing it would make EVERY purge in the
        // fleet report success while destroying nothing: silent PHI orphaning,
        // the exact failure the purge chain exists to prevent. Stays a 502.
        throw new AppError(
          502,
          'Failed to purge document data from KAG: the purge endpoint itself returned ' +
            '"Not Found", which means the KAG route is missing or fr is calling the wrong ' +
            'path — NOT that the document was already purged. Document not deleted.',
          detail,
        );
      }
      console.warn(
        `[documents.purge] KAG returned 404 for purge key ${purgeKey} ` +
          `(document ${doc.id}, tenant ${purgeTenantId}) — treating as ALREADY PURGED. ` +
          'This is the expected outcome when retrying a project delete whose earlier ' +
          'documents were purged before a mid-loop failure.',
      );
      return;
    }
    throw new AppError(
      502,
      'Failed to purge document data from KAG; document not deleted. Please retry.',
      detail,
    );
  }
}

/**
 * Distinguish "the ROUTE is missing" from "the DOCUMENT is gone" on a 404.
 *
 * Ground truth is kag's proxy (`kag/src/services/proxy.py`): an upstream 404 from
 * the ingestion coordinator is re-raised as
 * `HTTPException(404, f"Backend service error ({status}): {body_preview}")`, so a
 * genuine already-purged document arrives with a descriptive `detail`. An
 * UNROUTED path, by contrast, is answered by FastAPI's own default handler with
 * the bare sentinel body `{"detail":"Not Found"}`.
 *
 * A 404 with no body at all is ambiguous, so it is treated as route-missing and
 * fails closed — a wrongly-retained document is recoverable; a wrongly-discarded
 * one orphans PHI forever.
 */
function isRouteMissing404(err: IntegrationError): boolean {
  const body = err.upstreamBody;
  const detail =
    typeof body === 'string'
      ? body
      : typeof (body as { detail?: unknown } | null | undefined)?.detail === 'string'
        ? ((body as { detail: string }).detail)
        : undefined;
  if (detail === undefined) return true; // no usable body → cannot tell → fail closed
  return detail.trim().toLowerCase() === 'not found';
}

/**
 * Project-wide right-to-delete: purge every one of a project's documents'
 * downstream PHI, THEN delete the fr document rows. Used by project delete /
 * archive so that tearing a project down honours the same HIPAA guarantee the
 * single-document delete does — the `documents.project_id → projects` FK is
 * ON DELETE RESTRICT (migration 090) precisely so a project can no longer be
 * removed while its PHI-pointer rows still exist and reference live downstream
 * PHI.
 *
 * Fail-closed & atomic-ish: we purge ALL documents first; if ANY purge throws we
 * propagate BEFORE deleting a single fr row, so a partial purge leaves every
 * pointer row in place and the whole operation is retryable — never a silent
 * "some rows dropped, some PHI orphaned" split.
 *
 * Selection is by `project_id` only. Each document is purged under ITS OWN
 * recorded `tenant_id` (record-and-replay, see purgeDocumentDownstreamPhi) — NOT
 * the caller's / project's active tenant. `opts.tenantId` is accepted for the
 * caller's context but is deliberately NOT used to filter the document set: a
 * project_id is globally unique to one project in one tenant, so every row under
 * it is this project's; filtering by the caller's tenant instead could STRAND a
 * document that was ingested under a different tenant than the caller's active
 * one (tenant fragmentation is real — see migration 083 header) and re-orphan its
 * PHI, which is the exact failure this fix exists to prevent.
 */
export async function purgeAndDeleteProjectDocuments(
  projectId: string,
  _opts?: { tenantId?: string },
): Promise<{ purged: number }> {
  const docs = await db.select()
    .from(documents)
    .where(eq(documents.project_id, projectId));

  // Purge EVERY document's downstream PHI first; throw before deleting any row.
  for (const doc of docs) {
    await purgeDocumentDownstreamPhi(doc);
  }

  // All purges succeeded → the downstream PHI is gone, so drop the pointer rows.
  //
  // ⭐ THE DELETE IS WRAPPED IN AN EXPLICIT TRANSACTION THAT ARMS migration
  // 142's destructive-statement hatch, and BOTH halves of that are load-bearing.
  //
  // `documents` is a PROTECTED table in migrations/142_destructive_statement_guard.sql,
  // whose AFTER-DELETE statement trigger refuses a DELETE that either EMPTIES the
  // table having removed >= 50 rows, or removes > 2000 rows. This statement is
  // scoped to one project, but a project with >2000 documents hits the second
  // threshold, and on an install where this project's rows are the only ones left
  // (a single-project tenant, a fresh deployment) 50 documents hit the first.
  //
  // Without the hatch, that refusal lands AFTER the purge loop above has already
  // destroyed every document's downstream PHI — the pointer rows survive while the
  // PHI they point at is gone, which is the EXACT INVERSE of the fail-closed split
  // this function's contract promises, and it is permanently non-retryable: the
  // retry re-purges (harmless, idempotent) and is refused again, forever.
  //
  // `SET LOCAL`, and therefore an explicit transaction, is the ONLY correct way to
  // arm it. fr reaches postgres through PgBouncer in TRANSACTION pooling, so a
  // session-level `SET fr.allow_destructive` would outlive this statement on that
  // server backend and be handed to the NEXT client — the mistake that cost this
  // estate 15 procedure writes and ~300 inserts on 2026-09-22. `SET LOCAL` is
  // reverted at the COMMIT, so it cannot leak. The value must be the lowercase
  // string `'on'`: the trigger compares `current_setting(...) = 'on'` exactly, so
  // `'ON'` / `'true'` / `'1'` all read as disarmed and the refusal still fires.
  //
  // ⛔ ONLY the DELETE is inside the transaction. `purgeDocumentDownstreamPhi` above
  // is an outbound HTTP DELETE per document to the ingestion coordinator (kag_graph
  // chunks + entities + Neo4j, orchestrator job state, MinIO images, ingestion_jobs),
  // issued sequentially and retried; holding a DB transaction open across that
  // network fan-out — unbounded in wall-clock and in document count — would pin a
  // pooled server backend and hold row locks for the whole purge, which is a worse
  // defect than the one this fixes. The purge is already idempotent and fail-closed,
  // so it needs no DB atomicity.
  if (docs.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL fr.allow_destructive = 'on'`);
      await tx.delete(documents).where(eq(documents.project_id, projectId));
    });
  }

  return { purged: docs.length };
}

// DELETE /api/documents/:id - Delete a document (HIPAA right-to-delete, fail-closed)
export async function handleDeleteDocument(req: Request, documentId: string): Promise<Response> {
  const user = await validateAuth(req);

  // Same `uuid`-column guard as handleGetDocumentStatus, and deliberately its
  // own edit rather than a shared loader: the two handlers scope DIFFERENTLY
  // (workspace-union read vs owner-only delete), so there is no seam to share.
  // The 404 body matches the owner-miss below — a malformed id must not be
  // distinguishable from a colleague's document on the right-to-delete path.
  if (!isUuidShape(documentId)) {
    throw new NotFoundError('Document not found');
  }

  // Look up FIRST so we have the KAG linkage (kag_ingestion_id) + the upload
  // tenant before deleting.
  //
  // ⛔ Scoped by user_id ONLY, and deliberately NOT by the workspace union that
  // handleListUserDocuments / handleGetDocumentStatus now use. (This comment used
  // to say "same posture as handleGetDocumentStatus"; that stopped being true the
  // moment the status read was widened.) Seeing a colleague's document and
  // destroying it are different authorities, and this path is the HIPAA
  // right-to-delete seam — it purges downstream PHI. Widening it would let any
  // workspace member irreversibly purge another member's document.
  const [doc] = await db.select()
    .from(documents)
    .where(and(
      eq(documents.id, documentId),
      eq(documents.user_id, user.id),
    ))
    .limit(1);

  if (!doc) {
    throw new NotFoundError('Document not found');
  }

  // Fail-closed: purge the document's downstream PHI before removing the fr row
  // (the shared right-to-delete seam — see purgeDocumentDownstreamPhi).
  await purgeDocumentDownstreamPhi(doc);

  await db.delete(documents)
    .where(and(
      eq(documents.id, documentId),
      eq(documents.user_id, user.id),
    ));

  return jsonResponse({ id: doc.id, deleted: true });
}
