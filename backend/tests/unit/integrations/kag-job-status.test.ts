import { describe, expect, test } from 'bun:test';
import {
  mapJobStatusToRow,
  deriveIngestionProgress,
  deriveKagDegradation,
} from '../../../src/integrations/kag';
import type { DocumentJobStatusResponse } from '@fr/service-client-kag';

// `mapJobStatusToRow` is the pure mapping from an upstream kag document-job
// status onto a local `documents` row patch. It is the heart of the lazy
// reconcile in `GET /api/documents/:id/status`: only an EXPLICIT terminal
// status flips the row, in-flight/unknown is a no-op, and page/entity counts
// are best-effort probes of the open `result.metadata` / `kag_ingest` maps.

function job(partial: Partial<DocumentJobStatusResponse>): DocumentJobStatusResponse {
  return { job_id: 'job-1', status: 'processing', ...partial };
}

describe('mapJobStatusToRow', () => {
  test('completed → status completed + pages from result.metadata.page_count', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        result: {
          document_id: 'd1',
          text: '…',
          metadata: { page_count: 12, entity_count: 30 },
        },
      }),
    );
    expect(out.status).toBe('completed');
    expect(out.pages_detected).toBe(12);
    expect(out.entities_extracted).toBe(30);
  });

  test('upstream "success"/"done" are also terminal-complete', () => {
    expect(mapJobStatusToRow(job({ status: 'success' })).status).toBe('completed');
    expect(mapJobStatusToRow(job({ status: 'DONE' })).status).toBe('completed');
  });

  test('pages probe falls back across num_pages / pages and coerces strings', () => {
    expect(
      mapJobStatusToRow(
        job({ status: 'completed', result: { document_id: 'd', text: '', metadata: { num_pages: 5 } } }),
      ).pages_detected,
    ).toBe(5);
    expect(
      mapJobStatusToRow(
        job({ status: 'completed', result: { document_id: 'd', text: '', metadata: { pages: '7' } } }),
      ).pages_detected,
    ).toBe(7);
  });

  test('entities can come from the kag_ingest map when metadata lacks them', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        result: { document_id: 'd', text: '', metadata: {} },
        kag_ingest: { entities_extracted: 42 },
      }),
    );
    expect(out.status).toBe('completed');
    expect(out.entities_extracted).toBe(42);
  });

  test('completed with no metadata → status completed, counts null (row still settles)', () => {
    const out = mapJobStatusToRow(job({ status: 'completed' }));
    expect(out.status).toBe('completed');
    expect(out.pages_detected).toBeNull();
    expect(out.entities_extracted).toBeNull();
  });

  test('failed/error → status failed + error_message carried from job.error', () => {
    const out = mapJobStatusToRow(job({ status: 'failed', error: 'parser exploded' }));
    expect(out.status).toBe('failed');
    expect(out.error_message).toBe('parser exploded');

    const out2 = mapJobStatusToRow(job({ status: 'error' }));
    expect(out2.status).toBe('failed');
    expect(out2.error_message).toBeTruthy();
  });

  test('in-flight / unknown status → no-op patch (leaves the row untouched)', () => {
    expect(mapJobStatusToRow(job({ status: 'processing' }))).toEqual({});
    expect(mapJobStatusToRow(job({ status: 'queued' }))).toEqual({});
    expect(mapJobStatusToRow(job({ status: '' }))).toEqual({});
    expect(mapJobStatusToRow(job({ status: 'something-new' }))).toEqual({});
  });

  test('non-numeric / junk page values do not produce a count', () => {
    const out = mapJobStatusToRow(
      job({ status: 'completed', result: { document_id: 'd', text: '', metadata: { page_count: 'lots' } } }),
    );
    expect(out.status).toBe('completed');
    expect(out.pages_detected).toBeNull();
  });

  // --- KAG-gated readiness: when send_to_kag, parse-complete is NOT ready. ---

  test('send_to_kag + parse completed but KAG still in flight → no-op (stays processing)', () => {
    // The core bug: previously this settled to `completed` at ~17s parse time,
    // ~8 min before the doc was actually queryable.
    const out = mapJobStatusToRow(
      job({ status: 'completed', send_to_kag: true, kag_ingest: { status: 'submitted' } }),
    );
    expect(out).toEqual({});
  });

  test('send_to_kag + kag_ingest.status completed → completed', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        result: { document_id: 'd', text: '', metadata: { page_count: 9 } },
        kag_ingest: { status: 'completed', entities_extracted: 4827 },
      }),
    );
    expect(out.status).toBe('completed');
    expect(out.pages_detected).toBe(9);
    expect(out.entities_extracted).toBe(4827);
    // Migration 099 honesty pin. This fixture carries NO stage_history and NO
    // chunks_bulk, so upstream told us nothing about completeness. The key must
    // be OMITTED (column stays NULL = unknown), never written as `false` — this
    // test was previously green precisely because a completion was
    // unconditionally clean, and `toBeUndefined()` would still pass on a
    // `{kag_degraded: undefined}` patch, so assert on key presence.
    expect('kag_degraded' in out).toBe(false);
    expect('chunks_total' in out).toBe(false);
  });

  test('send_to_kag + lost terminal callback: HiRAG stage completed in history → completed', () => {
    // The ~21% of jobs frozen at "submitted" still settle via stage_history.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'submitted',
          response: { profile: { enable_hirag: true } },
          stage_history: [
            { event: 'job.stage.completed', stage: 'karma' },
            { event: 'job.stage.completed', stage: 'hirag' },
          ],
        },
      }),
    );
    expect(out.status).toBe('completed');
    // Migration 099: a lost-callback settle is exactly the population that must
    // stay UNKNOWN. These stage events carry no `metrics` at all, so there is no
    // degradation evidence — the columns must be left untouched rather than
    // stamped clean. (This test used to be satisfied by the defect: a completion
    // was unconditionally clean.)
    expect('kag_degraded' in out).toBe(false);
    expect('kag_degraded_reason' in out).toBe(false);
  });

  test('send_to_kag + only KARMA done, HiRAG pending → still processing', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'submitted',
          response: { profile: { enable_hirag: true } },
          stage_history: [{ event: 'job.stage.completed', stage: 'karma' }],
        },
      }),
    );
    expect(out).toEqual({});
  });

  test('send_to_kag + hirag disabled: KARMA completed is terminal → completed', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'submitted',
          response: { profile: { enable_hirag: false } },
          stage_history: [{ event: 'job.stage.completed', stage: 'karma' }],
        },
      }),
    );
    expect(out.status).toBe('completed');
  });

  test('send_to_kag + KAG failure (flat status) → failed with message', () => {
    const out = mapJobStatusToRow(
      job({ status: 'completed', send_to_kag: true, kag_ingest: { status: 'failed', error: 'karma blew up' } }),
    );
    expect(out.status).toBe('failed');
    expect(out.error_message).toBe('karma blew up');
  });

  test('send_to_kag + a *_failed stage event → failed', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: { status: 'submitted', stage_history: [{ event: 'job.stage.failed', stage: 'hirag' }] },
      }),
    );
    expect(out.status).toBe('failed');
  });

  test('parse failure is terminal even when send_to_kag', () => {
    const out = mapJobStatusToRow(
      job({ status: 'failed', send_to_kag: true, error: 'parser exploded' }),
    );
    expect(out.status).toBe('failed');
    expect(out.error_message).toBe('parser exploded');
  });

  // --- Migration 099: the degraded columns, written on completed-KAG only. ---

  test('completed + degraded KARMA stage → patches all six degraded columns', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: {
                degraded: true,
                partial: true,
                degraded_reason: 'failed_chunks_over_tolerance: 119/137 > 0.10',
                succeeded_chunks: 18,
                failed_chunks: 119,
                total_chunks: 137,
              },
            },
            { event: 'job.stage.completed', stage: 'hirag' },
          ],
        },
      }),
    );
    expect(out.status).toBe('completed');
    expect(out.kag_degraded).toBe(true);
    expect(out.kag_degraded_stage).toBe('knowledge');
    expect(out.kag_degraded_reason).toContain('119/137');
    expect(out.chunks_indexed).toBe(18);
    expect(out.chunks_failed).toBe(119);
    expect(out.chunks_total).toBe(137);
  });

  test('completed + explicit clean evidence → kag_degraded FALSE with counts', () => {
    // `false` is a real, positive all-clear and must be persisted as such —
    // collapsing it to "omit the key" would make a verified-complete graph
    // indistinguishable from the unknown population.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: {
                degraded: false,
                partial: false,
                succeeded_chunks: 137,
                failed_chunks: 0,
                total_chunks: 137,
              },
            },
          ],
        },
      }),
    );
    expect(out.kag_degraded).toBe(false);
    expect(out.kag_degraded_stage).toBeNull();
    expect(out.chunks_total).toBe(137);
  });

  test('completed with NO degradation evidence → the six keys are OMITTED', () => {
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            // Metrics present, but carrying neither `degraded` nor `partial`.
            { event: 'job.stage.completed', stage: 'karma', metrics: { entities: 239 } },
          ],
        },
      }),
    );
    expect(out.status).toBe('completed');
    // `toBeUndefined()` would ALSO pass for `{kag_degraded: undefined}`, which
    // drizzle treats as "leave alone" but which is not what we are asserting.
    // Key presence is the falsifiable check.
    expect('kag_degraded' in out).toBe(false);
    expect('kag_degraded_reason' in out).toBe(false);
    expect('kag_degraded_stage' in out).toBe(false);
    expect('chunks_indexed' in out).toBe(false);
    expect('chunks_failed' in out).toBe(false);
    expect('chunks_total' in out).toBe(false);
  });

  test('KAG-failed branch never writes the degraded columns', () => {
    // A failed job is strictly stronger than degraded; writing a partial-credit
    // count set onto a failure would imply an ingestion that completed.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'failed',
          error: 'karma blew up',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { degraded: true, total_chunks: 137 },
            },
          ],
        },
      }),
    );
    expect(out.status).toBe('failed');
    expect('kag_degraded' in out).toBe(false);
    expect('chunks_total' in out).toBe(false);
  });

  test('parse-only branch never writes the degraded columns', () => {
    // KAG was never requested, so there is no completeness claim to make even
    // though a stale kag_ingest map happens to be attached.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: false,
        kag_ingest: {
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { degraded: true, total_chunks: 137 },
            },
          ],
        },
      }),
    );
    expect(out.status).toBe('completed');
    expect('kag_degraded' in out).toBe(false);
  });

  test('in-flight KAG stays a strict no-op even with a degraded stage recorded', () => {
    // Row churn guard: the caller writes whenever the patch is non-empty, so an
    // in-flight degradation leak would rewrite the row on EVERY poll.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'submitted',
          response: { profile: { enable_hirag: true } },
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { degraded: true, total_chunks: 137 },
            },
          ],
        },
      }),
    );
    expect(out).toEqual({});
  });

  // --- entities_extracted: the count lives in stage_history[karma], not the
  // top level. Verified against a live prod job (2,191 entities) whose fr row
  // still settled `entities_extracted = NULL`, as had every prod row before it.

  test('a completed kag job takes entities_extracted from stage_history[karma].metrics.entities', () => {
    // Kills the top-level-only lookup. This fixture is the REAL live blob shape:
    // `result.metadata` empty, and kag_ingest's top-level keys carry no
    // entity_count/entities/entities_extracted anywhere.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        result: { document_id: 'd', text: '', metadata: {} },
        kag_ingest: {
          status: 'completed',
          attempts: 1,
          terminal: true,
          chunks_bulk: { status: 'succeeded', count: 20 },
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: {
                entities: 2191,
                relationships: 2099,
                total_chunks: 20,
                failed_chunks: 0,
                succeeded_chunks: 20,
                degraded: false,
                partial: false,
                degraded_reason: null,
                upstream_degraded_chunks: 0,
              },
            },
            { event: 'job.stage.completed', stage: 'hirag', metrics: { levels: 4, entities: 0 } },
            {
              event: 'job.stage.completed',
              stage: 'kag',
              metrics: { nodes_created: 56, chunks_total: 20 },
            },
          ],
        },
      }),
    );
    expect(out.status).toBe('completed');
    expect(out.entities_extracted).toBe(2191);
    // The clean run is still recorded as an explicit all-clear.
    expect(out.kag_degraded).toBe(false);
    expect(out.chunks_total).toBe(20);
  });

  test('hirag entities:0 does not override karma entities:2191', () => {
    // Kills any fold that takes the first/last stage carrying the key. hirag
    // legitimately reports 0 on a healthy job; writing that 0 would positively
    // assert "nothing was indexed" — strictly worse than the NULL it replaces.
    // hirag is placed LAST here so a last-wins fold would read its 0.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { entities: 2191, degraded: false, partial: false },
            },
            { event: 'job.stage.completed', stage: 'kag', metrics: { entities: 0 } },
            { event: 'job.stage.completed', stage: 'hirag', metrics: { levels: 4, entities: 0 } },
          ],
        },
      }),
    );
    expect(out.entities_extracted).toBe(2191);
  });

  test('a top-level entity_count still wins over the stage-history fallback', () => {
    // Kills a reordering of the `??` chain. The stage-history read is the LAST
    // resort; a payload that does surface the count up top keeps precedence.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        result: { document_id: 'd', text: '', metadata: { entity_count: 7 } },
        kag_ingest: {
          status: 'completed',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { entities: 2191, degraded: false, partial: false },
            },
          ],
        },
      }),
    );
    expect(out.entities_extracted).toBe(7);
  });

  test('the karma entity fallback does NOT require degradation evidence', () => {
    // Kills gating the entity count on `deriveKagDegradation` being non-null.
    // A pre-orchestrator-#123 job carries `entities` with NO degraded/partial
    // key: its completeness is unknown, but its entity count is still known.
    const out = mapJobStatusToRow(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            { event: 'job.stage.completed', stage: 'karma', metrics: { entities: 512 } },
            { event: 'job.stage.completed', stage: 'hirag' },
          ],
        },
      }),
    );
    expect(out.entities_extracted).toBe(512);
    // …and the degradation columns stay OMITTED, because that IS still unknown.
    expect('kag_degraded' in out).toBe(false);
  });
});

describe('deriveIngestionProgress', () => {
  const keyState = (p: ReturnType<typeof deriveIngestionProgress>, k: string) =>
    p.stages.find((s) => s.key === k)?.state;

  test('parse-only (no KAG) completed → ready, KAG stages skipped', () => {
    const p = deriveIngestionProgress(
      job({
        status: 'completed',
        send_to_kag: false,
        result: { document_id: 'd', text: '', metadata: { page_count: 3 } },
      }),
    );
    expect(p.terminal).toBe('ready');
    expect(p.percentComplete).toBe(100);
    expect(keyState(p, 'upload')).toBe('done');
    expect(keyState(p, 'parse')).toBe('done');
    expect(p.stages.find((s) => s.key === 'parse')?.detail).toBe('3 pages');
    // KAG stages absent in parse-only flow.
    expect(p.stages.some((s) => s.key === 'knowledge')).toBe(false);
  });

  test('send_to_kag while parsing → parse active, terminal null', () => {
    const p = deriveIngestionProgress(job({ status: 'processing', send_to_kag: true }));
    expect(p.terminal).toBeNull();
    expect(keyState(p, 'parse')).toBe('active');
    expect(p.currentStageKey).toBe('parse');
  });

  test('send_to_kag + KARMA done, HiRAG running → knowledge done, hierarchy active', () => {
    const p = deriveIngestionProgress(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'submitted',
          response: { profile: { enable_hirag: true } },
          stage_history: [
            { event: 'job.stage.completed', stage: 'karma', metrics: { entities: 4827 } },
          ],
        },
      }),
    );
    expect(p.terminal).toBeNull();
    expect(keyState(p, 'parse')).toBe('done');
    expect(keyState(p, 'knowledge')).toBe('done');
    expect(p.stages.find((s) => s.key === 'knowledge')?.detail).toBe('4,827 entities');
    expect(keyState(p, 'hierarchy')).toBe('active');
    expect(p.currentStageKey).toBe('hierarchy');
    expect(p.percentComplete).toBeGreaterThan(0);
    expect(p.percentComplete).toBeLessThan(100);
  });

  test('send_to_kag completed via flat status → ready, all enabled stages done, 100%', () => {
    const p = deriveIngestionProgress(
      job({ status: 'completed', send_to_kag: true, kag_ingest: { status: 'completed' } }),
    );
    expect(p.terminal).toBe('ready');
    expect(p.percentComplete).toBe(100);
    expect(p.currentStageKey).toBeNull();
    expect(keyState(p, 'index')).toBe('done');
    // Migration 099: a flat `completed` with no stage_history carries no
    // completeness evidence, so `ready` here is a statement about the pipeline
    // TERMINATING, not a verified-complete graph. `degradation` must be null
    // (unknown), never `{degraded:false}`.
    expect(p.degradation).toBeNull();
  });

  test('failed stage → terminal failed with failedStageKey + errorMessage', () => {
    const p = deriveIngestionProgress(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'failed',
          error: 'karma blew up',
          stage_history: [{ event: 'job.stage.failed', stage: 'karma' }],
        },
      }),
    );
    expect(p.terminal).toBe('failed');
    expect(p.failedStageKey).toBe('knowledge');
    expect(p.errorMessage).toBe('karma blew up');
  });

  test('parse failure → terminal failed at parse', () => {
    const p = deriveIngestionProgress(
      job({ status: 'failed', send_to_kag: true, error: 'parser exploded' }),
    );
    expect(p.terminal).toBe('failed');
    expect(p.failedStageKey).toBe('parse');
    expect(keyState(p, 'parse')).toBe('failed');
  });

  test('ids expose ingestion job + tenant for the debug panel', () => {
    const p = deriveIngestionProgress(
      job({
        job_id: 'ingest-77',
        status: 'processing',
        send_to_kag: true,
        kag_ingest: { status: 'submitted', tenant_id: 'tenant-abc', job_id: 'orch-9' },
      }),
    );
    expect(p.ids.ingestionJobId).toBe('ingest-77');
    expect(p.ids.tenantId).toBe('tenant-abc');
    expect(p.ids.orchestratorJobId).toBe('orch-9');
  });

  // --- Migration 099: the metric fold + the degraded terminal. ---

  const degradedKarmaJob = () =>
    job({
      status: 'completed',
      send_to_kag: true,
      kag_ingest: {
        status: 'completed',
        stage_history: [
          {
            event: 'job.stage.completed',
            stage: 'karma',
            metrics: {
              entities: 239,
              degraded: true,
              partial: true,
              degraded_reason: 'karma_upstream_degraded on 18/18 succeeded chunk(s)',
              succeeded_chunks: 18,
              failed_chunks: 119,
              total_chunks: 137,
              failed_chunk_indices: [1, 2, 3],
              processing_time_ms: null,
              nested: { a: 1 },
            },
          },
          { event: 'job.stage.completed', stage: 'hirag' },
          { event: 'job.stage.completed', stage: 'kag' },
        ],
      },
    });

  test('metric fold keeps booleans AND strings, drops arrays/objects/null', () => {
    // The original filter was `typeof v === 'number'`, which ate `degraded`,
    // `partial` (booleans) and `degraded_reason` (a string) — the entire
    // migration-099 signal. kag_orchestrator's karma adapter carries a comment
    // about working around this exact filter.
    const p = deriveIngestionProgress(degradedKarmaJob());
    const m = p.stages.find((s) => s.key === 'knowledge')?.metrics ?? {};
    expect(m.degraded).toBe(true);
    expect(m.partial).toBe(true);
    expect(m.degraded_reason).toBe('karma_upstream_degraded on 18/18 succeeded chunk(s)');
    expect(m.total_chunks).toBe(137);
    // Still dropped: an array (rendering chunk indices is not the goal), a
    // nested object, and an explicit null.
    expect('failed_chunk_indices' in m).toBe(false);
    expect('nested' in m).toBe(false);
    expect('processing_time_ms' in m).toBe(false);
  });

  test('typed per-stage degraded siblings mirror the metrics', () => {
    const p = deriveIngestionProgress(degradedKarmaJob());
    const knowledge = p.stages.find((s) => s.key === 'knowledge');
    expect(knowledge?.degraded).toBe(true);
    expect(knowledge?.degradedReason).toContain('karma_upstream_degraded');
    // A stage with no degradation key at all stays UNKNOWN, not clean.
    const hierarchy = p.stages.find((s) => s.key === 'hierarchy');
    expect(hierarchy?.degraded).toBeUndefined();
  });

  test('completed + degraded → terminal degraded, 100%, no active stage, stages still done', () => {
    const p = deriveIngestionProgress(degradedKarmaJob());
    expect(p.terminal).toBe('degraded');
    // The pipeline TERMINATED and every stage ran: the bar counts stages, so a
    // degraded job is still 100. Adding a 'degraded' IngestionStageState would
    // silently drop this to 66% because percentComplete counts state === 'done'.
    expect(p.percentComplete).toBe(100);
    // A finished job must not report a phantom active stage.
    expect(p.currentStageKey).toBeNull();
    expect(keyState(p, 'knowledge')).toBe('done');
    expect(keyState(p, 'hierarchy')).toBe('done');
    expect(keyState(p, 'index')).toBe('done');
    expect(p.failedStageKey).toBeNull();
    expect(p.degradation?.degraded).toBe(true);
    expect(p.degradation?.stage).toBe('knowledge');
    expect(p.degradation?.chunksFailed).toBe(119);
  });

  test('a terminal degraded pipeline reports NO active stage even while parse still reads in-flight', () => {
    // Mutation kill: `terminal !== null ? null : find(active)` collapsed to
    // `terminal === 'ready' ? null : …` survives every all-stages-done fixture,
    // because `kagReady` force-marks the KAG stages 'done' so there is no active
    // one to find. The `parse` stage is different — its state comes from the
    // job's TOP-LEVEL status, which upstream can leave in-flight ('processing')
    // after kag_ingest has already gone terminal. Under that mutant this job
    // renders a phantom "Parsing" spinner beside a finished, degraded pipeline.
    const p = deriveIngestionProgress(
      job({
        status: 'processing',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { degraded: true, partial: true, succeeded_chunks: 18, total_chunks: 137 },
            },
          ],
        },
      }),
    );
    expect(keyState(p, 'parse')).toBe('active');
    expect(p.terminal).toBe('degraded');
    expect(p.currentStageKey).toBeNull();
  });

  test('completed + explicitly clean evidence → terminal ready, degradation degraded:false', () => {
    const p = deriveIngestionProgress(
      job({
        status: 'completed',
        send_to_kag: true,
        kag_ingest: {
          status: 'completed',
          stage_history: [
            {
              event: 'job.stage.completed',
              stage: 'karma',
              metrics: { degraded: false, partial: false, total_chunks: 137 },
            },
          ],
        },
      }),
    );
    expect(p.terminal).toBe('ready');
    expect(p.percentComplete).toBe(100);
    expect(p.degradation?.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kag_document_id harvest (migration 087)
//
// ingestion returns the STABLE, content-derived `document_id` (≠ the per-run job_id). fr
// stores it so purge/dedupe key on the identity chunks are actually written under. It is
// harvested ONLY onto terminal patches — emitting it mid-flight would make every poll
// rewrite the row.
//
// The id is read from `result`, NOT from the top-level `document_id`, which is PROVISIONAL
// mid-flight (ingestion stores `document_id = job_id` until the worker re-points it). The
// fixtures below therefore build the shape the ASYNC path actually returns — a summary with
// the id inside `result` and NO `text`/`metadata`.
//
// The previous version of this suite hand-built `{ document_id }` at the TOP level and cast
// with `as DocumentJobStatusResponse`. That cast is what let it "pass" against a shape the
// server has never sent: in production KAG's response_model dropped the top-level field
// entirely, so `kag_document_id` was NULL on every row while these tests stayed green. Do not
// reintroduce a cast here — if a fixture needs one, the fixture is lying.
// ---------------------------------------------------------------------------

/** The REAL async job shape: the stable id lives inside `result`, and there is no `text`. */
function asyncJob(
  partial: Partial<DocumentJobStatusResponse>,
  documentId?: string | null,
): DocumentJobStatusResponse {
  return {
    job_id: 'job-1',
    status: 'processing',
    // The top-level id is the PROVISIONAL one (= job_id) until the worker re-points it.
    // It is set here deliberately: if the harvest ever reads it again, these tests break.
    document_id: 'job-1',
    ...partial,
    result: {
      object_key: 'uploads/deadbeef/report.pdf',
      success: true,
      parser_used: 'docling',
      text_length: 8123,
      ...(documentId === undefined ? {} : { document_id: documentId }),
    },
  };
}

describe('mapJobStatusToRow — kag_document_id', () => {
  test('parse-only completed → harvests the stable document_id', () => {
    const out = mapJobStatusToRow(asyncJob({ status: 'completed' }, 'doc-stable-1'));
    expect(out.status).toBe('completed');
    expect(out.kag_document_id).toBe('doc-stable-1');
  });

  test('kag completed → harvests the stable document_id', () => {
    const out = mapJobStatusToRow(
      asyncJob(
        {
          status: 'completed',
          send_to_kag: true,
          kag_ingest: { status: 'completed' },
        },
        'doc-stable-2',
      ),
    );
    expect(out.status).toBe('completed');
    expect(out.kag_document_id).toBe('doc-stable-2');
  });

  test('failed → still harvests the id (a failed run may have written chunks)', () => {
    const out = mapJobStatusToRow(
      asyncJob({ status: 'failed', error: 'boom' }, 'doc-stable-3'),
    );
    expect(out.status).toBe('failed');
    expect(out.kag_document_id).toBe('doc-stable-3');
  });

  test('in-flight (KAG still indexing) → NO-OP even though document_id is known', () => {
    // Regression: emitting the id here would make the caller (which writes whenever
    // the patch is non-empty) rewrite the row + bump updated_at on EVERY poll, and
    // keep shoving the row out of the reconcile sweep's staleness window.
    const out = mapJobStatusToRow(
      asyncJob(
        { status: 'completed', send_to_kag: true, kag_ingest: { status: 'processing' } },
        'doc-stable-4',
      ),
    );
    expect(out).toEqual({});
  });

  test('no document_id upstream → key omitted (never nulls an already-stored id)', () => {
    const out = mapJobStatusToRow(asyncJob({ status: 'completed' }, null));
    expect(out.status).toBe('completed');
    expect('kag_document_id' in out).toBe(false);
  });

  test('blank document_id → treated as unknown, key omitted', () => {
    const out = mapJobStatusToRow(asyncJob({ status: 'completed' }, '   '));
    expect('kag_document_id' in out).toBe(false);
  });

  test('the PROVISIONAL top-level document_id is never harvested', () => {
    // Regression guard for the original defect. Mid-flight, ingestion stores
    // `document_id = job_id`; only `result.document_id` is the content-derived identity.
    // Reading the top-level field would persist the per-run job id as if it were stable —
    // exactly the confusion migration 087 exists to end. Here `result` carries NO id (the
    // job has not parsed yet) while the top level carries the provisional one.
    const out = mapJobStatusToRow(asyncJob({ status: 'completed' }, null));
    expect('kag_document_id' in out).toBe(false);
    expect(out.kag_document_id).toBeUndefined();
  });

  test('async shape yields null page/entity counts but still settles to completed', () => {
    // Honesty pin, not an aspiration: the async `result` is a summary with no `metadata`, so
    // the page/entity probes legitimately find nothing. Populating them needs a `page_count`
    // added to ingestion's async summary (page counts, NOT the full text — that is PHI on a
    // hot polled endpoint). Until then this is the true behaviour, and the row must still
    // reach a terminal status rather than hanging.
    const out = mapJobStatusToRow(asyncJob({ status: 'completed' }, 'doc-stable-5'));
    expect(out.status).toBe('completed');
    expect(out.kag_document_id).toBe('doc-stable-5');
    expect(out.pages_detected ?? null).toBeNull();
    expect(out.entities_extracted ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveKagDegradation (migration 099)
//
// The defect: karma PR #127 ("partial credit") + kag_orchestrator #123 let the
// pipeline COMPLETE a job that lost most of its chunks, and fr rendered a clean
// green `completed`. A real prod row today reads
//   total_chunks 137 · succeeded_chunks 18 · failed_chunks 119 · entities 239
// — 86% of the document missing from the graph. 20 such rows exist in prod.
//
// Two rules carry the whole fix and are pinned hardest below:
//   1. Degradation is decided by the EXPLICIT `degraded`/`partial` flags, never
//      by `failed_chunks > 0`. karma's partial-credit chunks come back ok=True,
//      so a count-based predicate misses PR #127 entirely.
//   2. NO evidence ⇒ `null` (unknown), NOT `{degraded:false}`. That is the
//      lost-terminal-callback population and it must never be laundered clean.
// ---------------------------------------------------------------------------

/** One `job.stage.completed` history entry. */
const stageEvent = (stage: string, metrics?: Record<string, unknown>) => ({
  event: 'job.stage.completed',
  stage,
  ...(metrics === undefined ? {} : { metrics }),
});

describe('deriveKagDegradation', () => {
  test('no kag_ingest → null (nothing to know)', () => {
    expect(deriveKagDegradation(undefined)).toBeNull();
  });

  test('empty stage_history and no chunks_bulk → null, NOT {degraded:false}', () => {
    // Kills "no evidence ⇒ clean". This is the ~21% lost-callback population:
    // a terminal flat status with a stage_history that never got appended.
    expect(deriveKagDegradation({ status: 'completed', stage_history: [] })).toBeNull();
    expect(deriveKagDegradation({ status: 'completed' })).toBeNull();
    // Stage events with metrics that carry NEITHER key are still no evidence.
    expect(
      deriveKagDegradation({
        status: 'completed',
        stage_history: [stageEvent('karma', { entities: 239, total_chunks: 137 })],
      }),
    ).toBeNull();
  });

  test('karma degraded:false + counts → {degraded:false} with the counts', () => {
    // Kills collapsing a falsy verdict to null: an EXPLICIT clean is real
    // information and must be distinguishable from unknown.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', {
          degraded: false,
          partial: false,
          succeeded_chunks: 137,
          failed_chunks: 0,
          total_chunks: 137,
        }),
      ],
    });
    expect(d).not.toBeNull();
    expect(d!.degraded).toBe(false);
    expect(d!.stage).toBeNull();
    expect(d!.reason).toBeNull();
    expect(d!.chunksIndexed).toBe(137);
    expect(d!.chunksFailed).toBe(0);
    expect(d!.chunksTotal).toBe(137);
  });

  test('the REAL prod row (137/18/119) → degraded true + counts + reason', () => {
    const d = deriveKagDegradation({
      status: 'completed',
      stage_history: [
        stageEvent('karma', {
          entities: 239,
          degraded: true,
          partial: true,
          degraded_reason: 'failed_chunks_over_tolerance: 119/137 > 0.10',
          succeeded_chunks: 18,
          failed_chunks: 119,
          total_chunks: 137,
          failed_chunk_indices: [0, 1, 2],
        }),
        stageEvent('hirag'),
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.stage).toBe('knowledge');
    expect(d!.reason).toBe(
      'Extracting knowledge: failed_chunks_over_tolerance: 119/137 > 0.10',
    );
    expect(d!.chunksIndexed).toBe(18);
    expect(d!.chunksFailed).toBe(119);
    expect(d!.chunksTotal).toBe(137);
  });

  test('karma partial:true with `degraded` absent → degraded true', () => {
    // karma sets `partial = bool(failed)` INDEPENDENTLY of `degraded` (which is
    // its own tolerance OR-ed with karma-upstream partial credit). Reading only
    // `degraded` would miss every under-tolerance loss.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { partial: true, succeeded_chunks: 130, failed_chunks: 7, total_chunks: 137 }),
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.stage).toBe('knowledge');
  });

  test('karma degraded:true with failed_chunks 0 → STILL degraded, chunksFailed 0', () => {
    // 🔴 The kill shot for a count-based predicate. This is precisely PR #127:
    // karma's partial-credit chunks are returned ok=True, so failed_pct is 0.0
    // and `failed_chunks > 0` can NEVER see them — the orchestrator says so in
    // src/adapters/karma/__init__.py. Every chunk "succeeded"; the extraction
    // inside them was still partial.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', {
          degraded: true,
          partial: false,
          degraded_reason:
            'karma_upstream_degraded on 6/18 succeeded chunk(s): llm_truncated_output',
          succeeded_chunks: 18,
          failed_chunks: 0,
          total_chunks: 18,
        }),
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.chunksFailed).toBe(0);
    expect(d!.chunksIndexed).toBe(18);
    expect(d!.chunksTotal).toBe(18);
    expect(d!.reason).toContain('llm_truncated_output');
  });

  test('hirag degraded → degraded true, stage hierarchy', () => {
    // hirag mirrors one bit into degraded + partial (partial graph-write, e.g. a
    // graph_adapter 207 Multi-Status dropping hierarchy nodes). Handle any
    // stage, not just karma.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { degraded: false, partial: false, total_chunks: 40 }),
        stageEvent('hirag', {
          degraded: true,
          partial: true,
          degraded_reason: 'kag_graph dual-write returned 207',
        }),
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.stage).toBe('hierarchy');
    expect(d!.reason).toBe('Building hierarchy: kag_graph dual-write returned 207');
    // Counts still come from the KARMA event only — never invented for hirag.
    expect(d!.chunksTotal).toBe(40);
  });

  test('kag stage maps to index', () => {
    const d = deriveKagDegradation({
      stage_history: [stageEvent('kag', { degraded: true })],
    });
    expect(d!.stage).toBe('index');
  });

  test('several degraded stages → first in pipeline order wins', () => {
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('hirag', { degraded: true, degraded_reason: 'h' }),
        stageEvent('karma', { degraded: true, degraded_reason: 'k' }),
        stageEvent('kag', { degraded: true, degraded_reason: 'i' }),
      ],
      chunks_bulk: { status: 'failed', error: 'connection refused' },
    });
    // History order is hirag-first, but attribution is PIPELINE order.
    expect(d!.stage).toBe('knowledge');
    // Reasons are joined in pipeline order too.
    expect(d!.reason).toBe(
      'Extracting knowledge: k | Building hierarchy: h | Indexed: i | Chunk store write failed: connection refused',
    );
  });

  test('chunks_bulk failed with no stage degradation → degraded, stage chunks', () => {
    const d = deriveKagDegradation({
      status: 'completed',
      chunks_bulk: { status: 'failed', error_type: 'ConnectError', error: 'kag-graph unreachable' },
    });
    expect(d!.degraded).toBe(true);
    expect(d!.stage).toBe('chunks');
    expect(d!.reason).toBe('Chunk store write failed: kag-graph unreachable');
    // No karma event ⇒ no counts. Never derived from the other two.
    expect(d!.chunksIndexed).toBeNull();
    expect(d!.chunksFailed).toBeNull();
    expect(d!.chunksTotal).toBeNull();
  });

  test('chunks_bulk failed falls back to error_type when error is absent', () => {
    const d = deriveKagDegradation({ chunks_bulk: { status: 'failed', error_type: 'TimeoutError' } });
    expect(d!.reason).toBe('Chunk store write failed: TimeoutError');
  });

  test("chunks_bulk 'skipped' / 'succeeded' are evidence but NOT degradation", () => {
    // Both are legitimate outcomes (no chunks / no base url; or a clean write).
    // They still count as evidence, so the verdict is a real `false`, not null.
    const skipped = deriveKagDegradation({
      chunks_bulk: { status: 'skipped', reason: 'no_chunks_or_no_base_url' },
    });
    expect(skipped!.degraded).toBe(false);
    expect(skipped!.stage).toBeNull();

    const ok = deriveKagDegradation({ chunks_bulk: { status: 'succeeded', count: 137 } });
    expect(ok!.degraded).toBe(false);
  });

  test('a malformed chunks_bulk is not evidence', () => {
    // No string `status` ⇒ nothing was recorded ⇒ stays unknown.
    expect(deriveKagDegradation({ chunks_bulk: {} })).toBeNull();
    expect(deriveKagDegradation({ chunks_bulk: 'failed' })).toBeNull();
    expect(deriveKagDegradation({ chunks_bulk: [{ status: 'failed' }] })).toBeNull();
  });

  test('kag_ingest.status "failed" alone is NOT degradation (deriveKagOutcome owns it)', () => {
    // A failed job is strictly stronger than degraded; treating it as evidence
    // here would produce a bogus {degraded:false} on every hard failure.
    expect(deriveKagDegradation({ status: 'failed', error: 'karma blew up' })).toBeNull();
  });

  test('degraded_reason: null never produces the literal string "null"', () => {
    const d = deriveKagDegradation({
      stage_history: [stageEvent('karma', { degraded: true, degraded_reason: null })],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.reason).toBeNull();
    expect(d!.reason).not.toBe('null');
  });

  test('a non-string / blank degraded_reason contributes nothing', () => {
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { degraded: true, degraded_reason: '   ' }),
        stageEvent('hirag', { degraded: true, degraded_reason: 42 }),
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.reason).toBeNull();
  });

  test('reason is capped at 500 characters', () => {
    const d = deriveKagDegradation({
      stage_history: [stageEvent('karma', { degraded: true, degraded_reason: 'x'.repeat(900) })],
    });
    expect(d!.reason!.length).toBe(500);
    expect(d!.reason!.startsWith('Extracting knowledge: ')).toBe(true);
  });

  test('the LAST completed event per stage wins (a retried stage rewrites its metrics)', () => {
    // First-wins would report the SUPERSEDED numbers: here the retry recovered
    // every chunk, so reading the first event would flag a clean doc degraded.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', {
          degraded: true,
          partial: true,
          degraded_reason: 'first attempt lost 119 chunks',
          succeeded_chunks: 18,
          failed_chunks: 119,
          total_chunks: 137,
        }),
        stageEvent('karma', {
          degraded: false,
          partial: false,
          degraded_reason: null,
          succeeded_chunks: 137,
          failed_chunks: 0,
          total_chunks: 137,
        }),
      ],
    });
    expect(d!.degraded).toBe(false);
    expect(d!.reason).toBeNull();
    expect(d!.chunksIndexed).toBe(137);
    expect(d!.chunksFailed).toBe(0);
  });

  test('the LAST event wins in the other direction too (retry lost the chunks)', () => {
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { degraded: false, partial: false, failed_chunks: 0, total_chunks: 137 }),
        stageEvent('karma', {
          degraded: true,
          partial: true,
          degraded_reason: 'retry lost 119 chunks',
          succeeded_chunks: 18,
          failed_chunks: 119,
          total_chunks: 137,
        }),
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.chunksFailed).toBe(119);
    expect(d!.reason).toContain('retry lost 119 chunks');
  });

  test('a *_failed stage event does not overwrite the last completed metrics', () => {
    // Only `job.stage.completed` events are folded; a failure event carries no
    // completeness metrics and must not clear the ones we have.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { degraded: true, succeeded_chunks: 18, total_chunks: 137 }),
        { event: 'job.stage.failed', stage: 'hirag' },
      ],
    });
    expect(d!.degraded).toBe(true);
    expect(d!.chunksTotal).toBe(137);
  });

  test('counts are read only from KARMA and never derived from each other', () => {
    // Only `total_chunks` is present. `succeeded`/`failed` stay null rather than
    // being back-computed — a fabricated count is worse than a missing one.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { degraded: true, total_chunks: 137 }),
        stageEvent('hirag', { degraded: false, succeeded_chunks: 999, failed_chunks: 999 }),
      ],
    });
    expect(d!.chunksTotal).toBe(137);
    expect(d!.chunksIndexed).toBeNull();
    expect(d!.chunksFailed).toBeNull();
  });

  test('entities is read from the KARMA event only — hirag entities:0 never wins', () => {
    // The entity count rides the same karma fold as the chunk counts. hirag
    // emits `entities: 0` on a healthy job, so a stage-agnostic read would
    // report 0 entities for a document that indexed 2,191 of them.
    const d = deriveKagDegradation({
      stage_history: [
        stageEvent('karma', { degraded: false, partial: false, entities: 2191 }),
        stageEvent('hirag', { degraded: false, levels: 4, entities: 0 }),
      ],
    });
    expect(d!.entities).toBe(2191);
  });

  test('entities is null when karma never reported it (never invented)', () => {
    const d = deriveKagDegradation({
      stage_history: [stageEvent('karma', { degraded: true, total_chunks: 137 })],
    });
    expect(d!.entities).toBeNull();
  });

  test('the chunk_states-derived kag_ingest.karma.chunks_total is NOT read', () => {
    // The orchestrator warns that field is "chunks seen so far", not a
    // denominator. Only stage_history[karma].metrics.total_chunks (= len(results))
    // is a real total.
    const d = deriveKagDegradation({
      karma: { chunks_total: 9999, chunks_succeeded: 9999 },
      stage_history: [stageEvent('karma', { degraded: true, total_chunks: 137 })],
    });
    expect(d!.chunksTotal).toBe(137);
    expect(d!.chunksIndexed).toBeNull();
  });
});
