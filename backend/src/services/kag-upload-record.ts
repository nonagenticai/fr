/**
 * Shared record-and-replay writer for KAG *synchronous* document ingests.
 *
 * Right-to-delete (`handleDeleteDocument`, routes/documents.ts) keys ENTIRELY
 * off fr `documents` rows: a purge resolves the row's `kag_document_id` (or the
 * per-run `kag_ingestion_id` fallback) and replays the row's `tenant_id`. The
 * async upload path (`POST /api/documents/upload`) records such a row; the
 * synchronous KAG upload (`kag.upload_document_sync`) durably writes
 * chunks/entities/Neo4j PHI when `send_to_kag` defaults on, so it MUST record a
 * row too or that PHI is un-purgeable.
 *
 * There are TWO execution paths for the sync upload and BOTH must record:
 *   - inline  — a human self-approves and the write runs in the HTTP handler
 *               (`handleUploadDocumentSync`, routes/tools/kag.ts).
 *   - parked  — a non-human initiator (n8n / agent) parks a PendingAction; the
 *               write runs later in the approval resolver
 *               (`resolvePendingAction`, domain/engagement/action-approvals.ts).
 *
 * This module is the single place that (a) extracts the purge keys out of the
 * upstream response and (b) inserts the row, so the two callers stay identical
 * and neither has to import the other. It deliberately lives under `services/`
 * (a leaf layer): the routes handler AND the domain resolver import it, which
 * would be a routes→domain / domain→routes cycle if the logic lived in either.
 */

import { db, documents } from '../db/client';
import { deriveKagOutcome } from '../integrations/kag';
import { AppError } from '../utils/errors';

/**
 * Pull the purge keys out of a sync upload's upstream response.
 *
 * The action's output schema is `passthrough` (unvalidated `unknown`), and the
 * upstream returns one of three shapes (KAG OpenAPI `uploadDocumentSyncResponse`,
 * 200 branch):
 *   - `DocumentSyncWrappedResponse` (send_to_kag=true, durable): top-level
 *     `job_id` (per-run) + `parsed_document.document_id` (the stable,
 *     content-derived identity chunks/graph nodes are written under).
 *   - `DocumentSyncDeferredResponse` (sync fell back to async): top-level
 *     `job_id`, no `document_id`.
 *   - `ParsedDocumentData` (send_to_kag=false, parse-only): top-level
 *     `document_id`, no `job_id` — no durable KAG footprint (not recorded).
 * So narrow defensively: prefer the nested `parsed_document.document_id`, fall
 * back to a top-level `document_id`, and read the top-level `job_id`.
 */
export function extractSyncDocIds(result: unknown): {
  documentId?: string;
  jobId?: string;
} {
  if (!result || typeof result !== 'object') return {};
  const r = result as Record<string, unknown>;
  const jobId =
    typeof r.job_id === 'string' && r.job_id.length > 0 ? r.job_id : undefined;
  let documentId: string | undefined;
  const parsedDoc = r.parsed_document;
  if (parsedDoc && typeof parsedDoc === 'object') {
    const pd = (parsedDoc as Record<string, unknown>).document_id;
    if (typeof pd === 'string' && pd.length > 0) documentId = pd;
  }
  if (
    !documentId &&
    typeof r.document_id === 'string' &&
    r.document_id.length > 0
  ) {
    documentId = r.document_id;
  }
  return { documentId, jobId };
}

/**
 * Cheap decoded-size estimate for a base64 string (no whitespace assumed).
 *
 * The parked path only has the base64 payload from the parked
 * `action_input_json` (the zod-parsed `uploadSyncInput` strips the http
 * handler's exact `byte_size`), so it derives an approximate `file_size` from
 * the encoded length. The inline path passes its exact decoded length instead.
 */
export function estimateBase64DecodedBytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/**
 * Pull the open `kag_ingest` map out of a sync upload's response.
 *
 * Present on the durable `DocumentSyncWrappedResponse` only. The deferred and
 * parse-only shapes carry no `kag_ingest` at all, and `deriveKagOutcome`
 * already reads `undefined` as `'in_flight'` — which is the truth for a
 * deferred (async-fallback) upload.
 */
export function extractSyncKagIngest(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const ki = (result as Record<string, unknown>).kag_ingest;
  if (!ki || typeof ki !== 'object' || Array.isArray(ki)) return undefined;
  return ki as Record<string, unknown>;
}

/** Normalise a raw MIME the same way the async upload path does — browsers
 * append parameters (e.g. `text/plain;charset=utf-8`) and the column is NOT
 * NULL. */
export function normalizeMimeType(contentType: string | null | undefined): string {
  return (
    ((contentType || '').split(';')[0] ?? '').trim().toLowerCase() ||
    'application/octet-stream'
  );
}

export interface SyncUploadRecordInput {
  /** The uploader's fr user id — the row owner the delete path scopes on. */
  userId: string;
  /**
   * The tenant the ingest was WRITTEN under — replayed verbatim by the purge.
   * `null` is only permitted when the response carries no purge key (nothing to
   * record); a durable ingest with a null tenant is REFUSED (422) rather than
   * stored, because a row whose ingest tenant is unrecorded is un-purgeable.
   */
  tenantId: string | null;
  filename: string;
  fileSize: number;
  mimeType?: string | null;
  /** The upstream sync-upload response the purge keys are extracted from. */
  result: unknown;
}

/**
 * Record an fr `documents` row for a sync ingest that DURABLY persisted to KAG,
 * mirroring the async upload row so right-to-delete can reach the PHI.
 *
 * Returns `true` when a row was inserted, `false` when the response carried no
 * purge key (parse-only / degenerate response — nothing the delete path could
 * ever act on, so we don't mint a row that falsely claims a KAG footprint).
 *
 * Throws {@link AppError} 422 when the content WAS durably sent (a purge key is
 * present) but no tenant could be resolved — the same fail-closed posture as
 * the async upload's 422. The delete replays this tenant verbatim; a
 * NULL-tenant row is un-purgeable (a wrong-tenant purge is a silent
 * 200-with-zeros no-op that orphans the PHI), so a row we cannot delete must
 * not be created.
 */
export async function recordSyncUploadRow(
  input: SyncUploadRecordInput,
): Promise<boolean> {
  const { documentId, jobId } = extractSyncDocIds(input.result);
  // No purge key AT ALL → nothing the delete path could ever act on; don't mint
  // a row that falsely claims a KAG footprint.
  //
  // ⚠️ RETRACTION. This comment used to close with "a durable send_to_kag ingest
  // always returns at least a job_id, so this only short-circuits degenerate
  // responses." That is an ASSUMPTION ABOUT UPSTREAM, not a contract fr
  // enforces, and it was load-bearing for the birth status below. Measured
  // against the KAG OpenAPI: the 200 branch of `uploadDocumentSyncResponse` is
  // an `anyOf` that ALSO admits `ParsedDocumentData` — no `job_id` — while
  // `send_to_kag` defaults true; and fr types the result as `unknown` and
  // validates nothing, so an empty-string, null or non-string `job_id` arrives
  // here indistinguishable from an absent one (see `extractSyncDocIds`, which
  // normalises all four to `undefined`). A durable-looking ingest with no
  // pollable key is therefore possible, and it is handled as an ANOMALY below
  // rather than assumed away here.
  if (!documentId && !jobId) return false;

  if (!input.tenantId) {
    throw new AppError(
      422,
      'Upload refused: no tenant could be resolved for this request. The document ' +
        'was ingested but could not be purged later (its tenant would be unrecorded).',
    );
  }

  // ⛔ The row is NOT unconditionally born terminal. It used to be, on the
  // premise that "the sync ingest has already parsed AND indexed into KAG" —
  // that premise is FALSE against the current upstream. `POST /ingest/sync`
  // parses inline, SUBMITS to the orchestrator and returns immediately with
  // `kag_ingest = {status:'submitted', terminal:false}`; ingestion stopped
  // waiting for enrichment because doing so produced 567-second requests, and
  // the terminal state is delivered later by the orchestrator callback.
  //
  // A row born `completed` is unreachable by BOTH places that ever learn that
  // terminal state — the on-page poll (`routes/documents.ts`, `isInFlight`) and
  // the background sweep (`services/document-reconcile.ts`) — because both
  // select on `status IN ('pending','processing')`. Consequence: `pages_detected`,
  // `entities_extracted` and, critically, the migration-099 `kag_degraded`
  // columns could never be written for a sync upload. A half-indexed sync
  // document rendered green forever, which is exactly the lie migration 099
  // exists to stop telling.
  //
  // So the birth status mirrors what every later poll would say about the SAME
  // job, via the same single readiness authority (`deriveKagOutcome`):
  //   * KAG still in flight  → `processing`; the existing machinery settles it
  //                            (including the degraded columns) on the next poll
  //                            or sweep tick, exactly as for an async upload.
  //   * KAG already terminal → keep the born-terminal insert; there is nothing
  //                            left to reconcile.
  //   * KAG already FAILED   → `failed` + an `error_message`. See below.
  //
  // ⭐ A `'failed'` OUTCOME IS NOW BORN `failed`. It used to be born `completed`,
  // disclosed at the time as "its own lie … left to its own change". Measured
  // consequence of leaving it: `deriveKagOutcome` returns `'failed'` both from a
  // terminal flat status (`failed` / `cancelled` / `karma_conflict`) and from a
  // `stage_history` event ending `failed`, and a row born `completed` is then
  // UNRECOVERABLE — the on-page poll (`routes/documents.ts`) and the sweep
  // (`services/document-reconcile.ts`) both select `status IN ('pending',
  // 'processing')`, so nothing ever revisits it. The user saw a green pill with
  // no `error_message` and no retry prompt, permanently. The row keeps whatever
  // purge keys the response carried, so right-to-delete still reaches the PHI.
  //
  // ⚠️ NO PURGE-KEY-BEARING ROW IS SILENTLY GREEN ANY MORE. This branch used to
  // be a `jobId` guard justified as "a missing flag is a far smaller defect than
  // a permanently stuck row, so a response with no pollable key stays born
  // terminal". The stuck-row half of that is real and is PRESERVED — the sweep
  // selector requires `isNotNull(kag_ingestion_id)`, so a row with no job id
  // must never be born `processing` or it sticks there forever. What is not
  // preserved is calling the result `completed`: a durable ingest that came back
  // with no usable job id is an ANOMALY (see the retraction above — it is a
  // reachable response shape, not an impossible one), and we have NO evidence
  // the KAG run finished. It is recorded as `failed` with a reason saying
  // exactly that. `failed` is terminal, so the stuck-row hazard is still gone.
  // An already-terminal `kag_ingest` with no job id is settled evidence and
  // still lands `completed` — the anomaly is the absence of evidence, not the
  // absence of the key.
  //
  // ⚠️ CORRECTION, and the residual risk it described is now CLOSED. The note
  // that stood here said the orphan-sweep exposure was bounded because "the tick
  // interval (45s) is four orders of magnitude below the 7-day upstream job
  // sweep". Two things were wrong with it. (a) The tick interval is NOT the
  // guard: `intervalMs` (45_000) only decides how often the sweep runs; what
  // keeps it off a just-submitted row is `minAgeMs = 10_000` (`config.ts`
  // `docReconcile`) — TEN seconds, not forty-five. A sync row's `job_id` comes
  // from the orchestrator submit hop and must be published within those 10s or
  // the first 404 is a race, not an orphan. (b) The interval was never the
  // relevant quantity anyway: the hazard is a 404 arriving at ANY tick, not a
  // ratio against the 7-day upstream sweep. The mislabelling itself is now
  // suppressed at the source — `document-reconcile.ts` no longer patches a row
  // that carries a `kag_document_id` to `failed` on `UPSTREAM_NOT_FOUND`.
  const kagIngest = extractSyncKagIngest(input.result);
  const kagOutcome = deriveKagOutcome(kagIngest);

  let status: 'processing' | 'completed' | 'failed';
  let errorMessage: string | null = null;
  if (kagOutcome === 'failed') {
    status = 'failed';
    // Carry the upstream reason when there is one. `integrations/kag.ts` does
    // exactly this on the ASYNC terminal path (`kagIngest.error ?? job.error`);
    // hardcoding a generic string here discarded the one fact an operator
    // needs, and made the sync and async paths disagree about the same event.
    const upstreamReason =
      typeof kagIngest?.error === 'string' && kagIngest.error.trim()
        ? ` Upstream reported: ${kagIngest.error.trim()}`
        : '';
    errorMessage =
      'KAG indexing failed upstream: the ingestion run reported a terminal failure, ' +
      'so this document is not queryable in the knowledge graph. Nothing further will ' +
      `be recorded against it.${upstreamReason}`;
  } else if (kagOutcome === 'in_flight' && jobId) {
    status = 'processing';
  } else if (kagOutcome === 'in_flight') {
    // Reaching here means `jobId` is falsy, and the `!documentId && !jobId`
    // guard above already returned — so a `documentId` is ALWAYS present on this
    // branch, i.e. the document was PARSED.
    //
    // ⚠️ Parsed is NOT indexed. `integrations/kag.ts:1756` — the upstream status
    // flips to completed the instant parsing ends, minutes before KARMA and
    // HiRAG make the document queryable. An earlier draft of this comment said
    // the content "did land upstream"; that is the same false premise that made
    // `document-reconcile.ts` settle such rows green, and it is corrected in
    // both places. What parse evidence DOES justify is withholding the
    // re-upload instruction: acting on it would duplicate PHI for content that
    // may already be in the store.
    status = 'failed';
    errorMessage =
      'Ingestion returned no usable job id, so this upload can never be polled to ' +
      'completion and its final KAG indexing state is unknown. The document was ' +
      'parsed, so some of its content may already be indexed — do NOT re-upload it, ' +
      'ask an administrator to check the ingestion run.';
  } else {
    status = 'completed';
  }

  await db.insert(documents).values({
    user_id: input.userId,
    filename: input.filename,
    file_size: input.fileSize,
    mime_type: normalizeMimeType(input.mimeType),
    status,
    error_message: errorMessage,
    tenant_id: input.tenantId,
    kag_document_id: documentId ?? null,
    kag_ingestion_id: jobId ?? null,
  });
  return true;
}
