// src/services/document-reconcile.ts
//
// Background document-status settle. The on-page poll
// (`GET /api/documents/:id/status`) only reconciles while a Documents view is
// open, so a doc whose uploader navigates away stays `processing` until they
// return — and the ~21% of jobs whose orchestrator terminal-callback is lost
// never settle at all without a sweep. This periodic, single-flight reconcile
// closes both gaps.
//
// It runs OUTSIDE a request frame, so each row is reconciled inside a rebuilt
// `withRequestContext` carrying the row's stored `tenant_id` (migration 083) —
// the kag job fetch forwards X-Tenant-Id, and without it would read the wrong
// tenant's job. Rows with no `tenant_id` (pre-083) are skipped by the selector.

import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, documents } from '../db/client';
import { config } from '../config';
import {
  getDocumentJobStatus,
  mapJobStatusToRow,
  type DocumentRowPatch,
} from '../integrations/kag';
import { withRequestContext } from '../integrations/_lib/context';
import { isIntegrationError } from '../integrations/_lib/errors';

// A doc whose ingestion job 404s can NEVER settle from the job endpoint: the
// upstream `ingestion_jobs` record is swept 7 days after completion (see
// integrations/kag.ts `resolveDocumentRuns`), or the job was never created. Left
// in-flight, such a row is a poison pill — re-selected on every sweep and 404ing
// forever. We have no evidence it completed (its terminal callback was lost and
// the job record is gone), so `failed` with an explicit reason is the honest
// terminal state that lets the row leave the stale set.
//
// It deliberately does NOT set the migration-099 degraded columns. A 404 means
// the job RECORD is gone: we never saw a stage_history, never saw a chunks_bulk,
// and cannot say whether the graph got the whole document, part of it, or none.
// That is UNKNOWN, which is exactly what leaving the columns NULL encodes —
// writing `kag_degraded: false` would launder a total absence of evidence into a
// clean bill of health, and `true` would invent a partial ingestion we have no
// proof happened. The `status: 'failed'` above already carries the operator
// signal; degradation is a claim about a COMPLETED ingestion, and there is none.
const ORPHANED_JOB_PATCH: DocumentRowPatch = {
  status: 'failed',
  error_message:
    'Ingestion job is no longer available upstream (it expired before its completion was recorded). Re-upload the document to retry.',
};

// ⭐ The SAME 404, on a row that carries a `kag_document_id`, is a DIFFERENT
// fact and must not get the patch above.
//
// ⚠️ CORRECTED 2026-09-15, and the correction matters. An earlier version of
// this comment claimed a `kag_document_id` is "evidence that the content DID
// land upstream", and settled such a row `completed`. That was FALSE, and this
// repo already knew it: `integrations/kag.ts:1756` — "the upstream top-level
// `status` flips to completed the instant PARSING ends — minutes before KARMA
// enrichment + HiRAG hierarchy make the document actually queryable. So when
// KAG indexing was requested we must gate on the KAG outcome, not parse."
// `kag_document_id` is PARSE-derived and is written AT BIRTH
// (`kag-upload-record.ts`), in the same INSERT that sets `processing`. It is
// evidence the document was PARSED. It is not evidence it was INDEXED.
//
// Worse, the branch is reachable only for SYNC rows — an async row cannot carry
// the id while still in-flight (`integrations/kag.ts:2124` returns a bare `{}`
// on the in-flight branch, so the id patch only ships on already-terminal
// patches, which this selector excludes). So 100% of the rows reaching here are
// exactly the ones whose only evidence is parse. Settling them `completed` gave
// the user a green "indexed" pill, unrecoverably, for a document KARMA and
// HiRAG may never have touched.
//
// What IS true: a 404 from `GET /jobs/{job_id}` says the JOB record expired
// (the upstream 7-day sweep), not that the document is lost. So the row stays
// LOUD — we do not know it succeeded — but it must stop instructing the one
// action that is actively harmful.
//
// `ORPHANED_JOB_PATCH` applied to it told the user two false things at once: a
// red `failed` badge for a document that is in the graph, and an instruction to
// "Re-upload the document to retry" — which, acted on, DUPLICATES PHI under a
// second job for content already present. So settle it terminal (it must still
// leave the poison-pill set) as `completed`, which is what the surviving
// evidence supports.
//
// It sets NO `error_message`: `DocumentUploadPanel.svelte` renders
// So the row stays `failed` — the honest reading of "we never saw this finish".
// What changes is the INSTRUCTION. The original patch told the user to
// re-upload, and for a document whose content may already be in the graph that
// duplicates PHI. This one says the indexing state is unknown and routes the
// decision to someone who can check, instead of guessing on the user's behalf.
//
// ⛔ It must NOT be `completed`. A green "indexed" pill for a document KARMA and
// HiRAG may never have touched is a SILENT failure, and terminal: `failed` and
// `completed` are both outside `reconcilableStatuses()` and outside `isInFlight`
// (`routes/documents.ts`), so nothing revisits either. Given the choice between
// loud-and-uncertain and silent-and-wrong, loud is the only recoverable one —
// the user can act on a red badge, and cannot act on a green one.
//
// Like the orphan patch it deliberately leaves the migration-099 columns absent:
// the job record is gone, so whether the graph got the whole document, part of
// it, or only the chunks is UNKNOWN, and NULL is the only honest encoding.
const PARSED_ORPHANED_JOB_PATCH: DocumentRowPatch = {
  status: 'failed',
  error_message:
    'Ingestion job is no longer available upstream (it expired before its completion was recorded). ' +
    'This document was parsed, so some of its content may already be indexed — do NOT re-upload it, ' +
    'ask an administrator to verify its indexing state first.',
};

interface StaleDocRow {
  id: string;
  user_id: string;
  tenant_id: string;
  kag_ingestion_id: string;
  /**
   * Migration 087's stable document identity, or null while it is still
   * unknown. REQUIRED, not optional: the selector always projects it, so a
   * fake that may omit it models a row shape production cannot produce — and
   * `listStaleDocuments` narrows the drizzle row (`string | null`) to this
   * type, which an optional field makes unassignable (TS2677). `null` is the
   * "no parse evidence" value; absence is not a state this row can be in.
   */
  kag_document_id: string | null;
}

/**
 * The production stale-document selector, as an UN-EXECUTED drizzle builder.
 *
 * Extracted for one reason: a drizzle builder answers `.toSQL()` without
 * touching a database, so the SQL production actually runs can be asserted in a
 * unit test. `listStaleDocuments` awaits exactly this object — there is no
 * second copy of the query anywhere — so a test that renders it is grading the
 * program, not a reimplementation of it.
 */
function buildStaleDocumentsQuery(cutoff: Date, limit: number, attemptedBefore: Date) {
  return db
    .select({
      id: documents.id,
      user_id: documents.user_id,
      tenant_id: documents.tenant_id,
      kag_ingestion_id: documents.kag_ingestion_id,
      // Projected for the UPSTREAM_NOT_FOUND branch ONLY: its presence is what
      // separates "the job record expired on a document that was PARSED" from
      // "we have no evidence this document exists upstream at all". Parsed is
      // NOT indexed (see the patch comment above). It is NOT a WHERE predicate
      // — a row with no document id is still reconcilable.
      kag_document_id: documents.kag_document_id,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.status, ['pending', 'processing']),
        isNotNull(documents.kag_ingestion_id),
        isNotNull(documents.tenant_id),
        // ⚠️ KEPT ON PURPOSE, and it is NOT the ordering key any more.
        // `minAgeMs` is what keeps the sweep off a just-submitted upload, and
        // the UPSTREAM_NOT_FOUND branch below depends on it: without this
        // predicate a row whose job the gateway has not published yet would
        // 404 and be settled `failed` forever. Removing it to "filter only on
        // the attempt column" would trade head-of-line blocking for wrongly
        // failing brand-new uploads.
        lt(documents.updated_at, cutoff),
        // The head-of-line fix: skip rows this sweep already looked at
        // recently, so a batch-filling set of still-indexing rows cannot be
        // re-picked ahead of a row that has never been looked at at all.
        or(
          isNull(documents.last_reconcile_attempt_at),
          lt(documents.last_reconcile_attempt_at, attemptedBefore),
        ),
      ),
    )
    // ⛔ ORDER BY updated_at is what caused the starvation — a row whose patch
    // is empty never advances it, so it stays the oldest forever. Order by the
    // ATTEMPT instead: never-attempted rows lead (NULLS FIRST), then
    // least-recently-attempted. `updated_at` survives only as a deterministic
    // tiebreak inside the never-attempted group, where it still means
    // "longest-stuck first".
    .orderBy(
      sql`${documents.last_reconcile_attempt_at} ASC NULLS FIRST`,
      asc(documents.updated_at),
    )
    .limit(limit);
}

/**
 * In-flight rows with a kag job + known tenant, unchanged since `cutoff` and
 * not ATTEMPTED since `attemptedBefore`, oldest-attempt first with
 * never-attempted rows leading.
 */
async function listStaleDocuments(cutoff: Date, limit: number, attemptedBefore: Date): Promise<StaleDocRow[]> {
  const rows = await buildStaleDocumentsQuery(cutoff, limit, attemptedBefore);
  // The isNotNull guards above mean these are non-null in practice; assert for types.
  return rows.filter(
    (r): r is StaleDocRow => !!r.tenant_id && !!r.kag_ingestion_id,
  );
}

/** Apply a settled patch to the row. */
async function applyDocumentPatch(id: string, patch: DocumentRowPatch): Promise<void> {
  await db
    .update(documents)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(documents.id, id));
}

/**
 * Record that the sweep LOOKED at this row (migration 116). Deliberately a
 * separate write from `applyDocumentPatch`: it must run for rows that produced NO
 * patch, and it must NOT move `updated_at`.
 */
async function markReconcileAttempted(id: string, at: Date): Promise<void> {
  // ⛔ `updated_at` is NOT touched here. Looking at a row is not changing it —
  // that conflation is the whole defect this column exists to remove.
  await db
    .update(documents)
    .set({ last_reconcile_attempt_at: at })
    .where(eq(documents.id, id));
}

/**
 * Reconcile one batch of stale in-flight documents. Returns the count settled
 * (a patch was applied). Strictly non-fatal per row: a flaky upstream or a
 * single bad row must not abort the sweep.
 */
async function reconcileStaleDocuments(): Promise<number> {
  const now = new Date();
  const { intervalMs, batchSize, minAgeMs } = config.docReconcile;
  const cutoff = new Date(now.getTime() - minAgeMs);
  // Don't re-pick a row this sweep already looked at inside the last tick.
  // `minAgeMs` (10s) is far shorter than `intervalMs` (45s), so using it alone
  // here would let the previous tick's batch back in on the very next tick and
  // keep competing with the never-attempted rows behind it. One full interval is
  // the shortest window that guarantees the queue advances.
  const attemptedBefore = new Date(now.getTime() - Math.max(minAgeMs, intervalMs));

  let rows: StaleDocRow[];
  try {
    rows = await listStaleDocuments(cutoff, batchSize, attemptedBefore);
  } catch (err) {
    console.error('[document-reconcile] listStale failed:', err);
    return 0;
  }

  let settled = 0;
  for (const row of rows) {
    // ⭐ STAMP THE ATTEMPT FIRST, BEFORE ANY OUTCOME IS KNOWN.
    //
    // This is the head-of-line fix. Every exit below — a settled patch, an empty
    // "still indexing" patch, a 404 orphan, a transient upstream error, an
    // unexpected throw, even the process dying mid-fetch — leaves the row having
    // been looked at, and the selector must see that. Doing it here rather than
    // in a `finally` is deliberate: a `finally` cannot run if the worker is
    // killed between the fetch and the return, and that is precisely the case
    // that would re-wedge the queue.
    //
    // Non-fatal, like every other per-row failure in this sweep: a DB blip on the
    // stamp must not abort the tick or skip the reconcile. The row simply keeps
    // its old attempt time and is re-picked next tick.
    //
    // ⚠️ DISCLOSED LIMITATION — this fix's failure mode IS the bug it replaces.
    // The catch below is per-row and silent to the selector: if the stamp write
    // fails PERSISTENTLY (column missing because migration 116 did not run, a
    // permission or constraint fault, a wedged connection), every row keeps its
    // old `last_reconcile_attempt_at` forever, the ORDER BY has nothing new to
    // sort on, and the sweep degrades to exactly the original head-of-line
    // blocking — with no alarm and no changed behaviour anywhere else.
    // In PRODUCTION nothing distinguishes the two worlds but this console.error,
    // and nothing counts it: the tick returns its normal settled count, the rows
    // stay in-flight exactly as they did before the fix, and the only difference
    // from a healthy sweep is a log line no alert reads. A durable signal (a
    // metric on consecutive stamp failures, or promoting a sustained failure to
    // fatal for the tick) is NOT implemented here.
    // MEASURED, so the scope of the gap is not overstated: mutating this call to
    // reject with 42703 on every row DOES redden the head-of-line tests
    // (16 pass / 4 fail across the two document-reconcile suites) — the defect
    // is the missing RUNTIME detector, not a missing test.
    try {
      await markReconcileAttempted(row.id, now);
    } catch (stampErr) {
      console.error(
        `[document-reconcile] failed to stamp reconcile attempt on ${row.id}:`,
        stampErr,
      );
    }
    try {
      const patch = await withRequestContext(
        {
          tenantId: row.tenant_id,
          userId: row.user_id,
          correlationId: `doc-reconcile-${row.id}`,
          initiator: 'cron',
          channel: 'background',
        },
        async () => {
          const job = await getDocumentJobStatus(row.kag_ingestion_id);
          return mapJobStatusToRow(job);
        },
      );
      if (Object.keys(patch).length > 0) {
        await applyDocumentPatch(row.id, patch);
        settled += 1;
      }
    } catch (err) {
      // A permanent 404 is terminal, NOT a transient blip: settle the row so it
      // stops poison-pilling the sweep. Every other error (timeout/5xx/network)
      // stays transient — leave the row in-flight for the next tick.
      //
      // ⚠️ CORRECTION. This comment used to end "the reconcile selector only
      // picks rows older than `minAgeMs`, so a 404 here cannot be a
      // just-submitted job racing its own creation." That is true for an ASYNC
      // upload — the same call that creates the row mints the job, so the job
      // exists the moment the row does. It is FALSE for a sync upload: its
      // `job_id` comes from the orchestrator submit hop, and `minAgeMs` is
      // 10_000 ms (`config.ts` `docReconcile`), so the claim reduces to "the
      // gateway always publishes the job inside 10 seconds" — an assumption
      // about upstream timing, not a guarantee this code makes. The branch below
      // is therefore written so a wrong 404 costs the user as little as
      // possible: a row with parse evidence is still settled `failed`, because
      // we never saw it finish — but it is never told to re-upload, because its
      // content may already be in the graph and re-uploading duplicates PHI.
      if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') {
        const parsed = !!row.kag_document_id;
        if (parsed) {
          console.warn(
            `[document-reconcile] job ${row.kag_ingestion_id} is gone upstream but ${row.id} ` +
              `carries kag_document_id=${row.kag_document_id} (PARSED, indexing state unknown); settling failed WITHOUT a re-upload instruction`,
          );
        }
        try {
          await applyDocumentPatch(
            row.id,
            parsed ? PARSED_ORPHANED_JOB_PATCH : ORPHANED_JOB_PATCH,
          );
          settled += 1;
        } catch (patchErr) {
          // A DB blip while settling the orphan must not abort the sweep.
          console.error(
            `[document-reconcile] failed to settle orphaned row ${row.id} (job ${row.kag_ingestion_id}):`,
            patchErr,
          );
        }
        continue;
      }
      console.error(
        `[document-reconcile] failed for ${row.id} (job ${row.kag_ingestion_id}):`,
        err,
      );
    }
  }
  return settled;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** Start the single-flight periodic reconcile. No-op when disabled or already started. */
export function startDocumentReconcileWorker(): void {
  if (!config.docReconcile.enabled || timer) return;
  timer = setInterval(() => {
    if (running) return; // single-flight: skip a tick still in progress
    running = true;
    reconcileStaleDocuments()
      .catch((err) => console.error('[document-reconcile] tick failed:', err))
      .finally(() => {
        running = false;
      });
  }, config.docReconcile.intervalMs);
  // Don't keep the event loop alive on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
}
