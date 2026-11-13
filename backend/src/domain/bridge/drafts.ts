// fr/backend/src/domain/bridge/drafts.ts
//
// DraftService — pre-approval staging for a kanban-card promotion. The draft
// row captures the (producer, run_id, output_id) tuple plus title/body/labels
// so the user can edit before submit. See spec §Write path.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { cardDrafts } from '../../db/schema';
import { IntegrationError } from '../../integrations/_lib/errors';
import { emitSpan, type SpanAttributes } from '../../telemetry/spans';
import { bridgeRegistry } from './registry';
import * as dedupClient from './dedup';
import {
  computeContentDigest,
  computeStableId,
  type StableIdInput,
} from './dedup';
import type {
  BridgeCtx,
  BridgeDb,
  DraftStatus,
  Initiator,
  ProducerId,
  ToolOutput,
} from './types';

export type CardDraftRow = typeof cardDrafts.$inferSelect;
type CardDraftInsert = typeof cardDrafts.$inferInsert;

export interface DraftCreateInput {
  producer: ProducerId;
  output_ids: string[];
  overrides?: Partial<{
    title: string;
    body_md: string;
    target_project_id: string;
    target_board_id: string;
    target_list_id: string;
    assignee_user_id: string;
    labels: string[];
  }>;
  initiator: Initiator;
  /**
   * Idempotency key supplied by the caller (route or AG-UI action). Stamped
   * into `metadata.idempotency_key` on the INITIAL insert so that a partial
   * unique index on `(project_id, producer, metadata->>'idempotency_key')`
   * (see migration 020) makes concurrent identical replays race-safe.
   */
  idempotency_key?: string;
  /**
   * Canonical sorted JSON encoding of the input output_ids set. Stamped into
   * `metadata.output_ids_key` alongside the idempotency_key so the same
   * tuple-key is used by the route layer and the action layer. Compute via
   * `outputIdsKey(...)` from dedup.ts — do not hand-roll.
   */
  output_ids_key?: string;
}

export interface DraftPatchInput {
  title?: string;
  body_md?: string;
  target_project_id?: string;
  target_board_id?: string;
  target_list_id?: string;
  assignee_user_id?: string | null;
  labels?: string[];
}

/**
 * Build the StableIdInput discriminated union from a producer ToolOutput.
 *
 * The producer adapter is responsible for stuffing the canonical-key fields
 * into `source_ref`. Missing fields fall back to safe defaults so the digest
 * still computes — at worst we degrade to content-digest dedup (documented
 * in spec §Dependencies).
 */
function stableIdInputFor(out: ToolOutput): StableIdInput {
  switch (out.producer) {
    case 'coding': {
      // Prefer source_ref.tool / source_ref.rule_id (the canonical carrier
      // since the bridge round-trip fix). Fall back to parsing
      // 'coding:<tool>' / 'rule:<id>' from suggested_labels for outputs
      // produced before the fix landed. If neither route yields a value,
      // throw — silently using '' would produce a DIFFERENT stable_id than
      // the source originally wrote and break dedup permanently.
      const labels = out.suggested_labels ?? [];
      const tool =
        out.source_ref?.tool ??
        labels.find((l) => l.startsWith('coding:'))?.slice('coding:'.length) ??
        '';
      const ruleId =
        out.source_ref?.rule_id ??
        labels.find((l) => l.startsWith('rule:'))?.slice('rule:'.length) ??
        '';
      if (tool === '' || ruleId === '') {
        throw new IntegrationError({
          code: 'coding_stable_id_unrecoverable',
          service: 'bridge',
          message:
            `Cannot reconstruct coding canonical key for output ${out.output_id}: ` +
            `missing tool=${JSON.stringify(tool)} or rule_id=${JSON.stringify(ruleId)}. ` +
            'Producer must emit source_ref.tool + source_ref.rule_id (or rule:<id> label).',
        });
      }
      return {
        producer: 'coding',
        tool,
        rule_id: ruleId,
        file_path: out.source_ref?.file_path ?? '',
        line_number: out.source_ref?.line_number ?? 0,
      };
    }
    case 'kag':
      return {
        producer: 'kag',
        session_id: out.run_id,
        url: out.source_ref?.url ?? '',
      };
    case 'artifacts':
      return {
        producer: 'artifacts',
        artifact_id: out.source_ref?.artifact_id ?? '',
        version: out.run_id,
      };
  }
}

export class DraftService {
  /**
   * Create one draft per output_id. Wraps the whole batch in a single
   * `fr.bridge.draft.created` span so analytics can compute hit-rate per
   * call, not per row. dedup_hit_count is mutated by-reference on the span
   * attribute object so the final emitted line reflects the real total.
   */
  async create(
    db: BridgeDb,
    ctx: BridgeCtx,
    input: DraftCreateInput,
  ): Promise<CardDraftRow[]> {
    const correlationId = ctx.request.correlationId;
    const spanAttrs: SpanAttributes = {
      project_id: ctx.project_id,
      producer: input.producer,
      initiator: input.initiator,
      correlation_id: correlationId,
      from_count: input.output_ids.length,
      // ⭐ `null`, not `0` — the last site in this change still opening a count
      // at a MEASURED zero. `0` is a claim ("we looked and found no dedup
      // hits"); `null` is the truth at span open ("nothing has been counted
      // yet"). `toOtelAttrs` drops null, so a span that dies mid-loop carries NO
      // count attribute rather than a fabricated zero, and the two bridge LIST
      // routes already open `count` / `truncated` / `dedup_known_count` this way
      // (routes/tools/bridge.ts:198, :586).
      //
      // ⚠️ This is NOT dashboard-visible on the success path, which is why it is
      // done here rather than deferred: `spanAttrs.dedup_hit_count = dedupHits`
      // below is reached unconditionally whenever `create` returns, so every
      // completed span still carries a real integer — including a genuine 0. The
      // ONLY lines that change are the `start` line and the `error` line of a
      // span that threw before the assignment, and on those two `0` was a lie.
      dedup_hit_count: null,
    };

    return emitSpan('fr.bridge.draft.created', spanAttrs, async () => {
      const source = bridgeRegistry.get(input.producer);
      const inserted: CardDraftRow[] = [];
      let dedupHits = 0;

      for (const outputId of input.output_ids) {
        const output = await source.getOutput(ctx.request, outputId);
        const partial = await source.toDraft(ctx.request, output);

        const title = input.overrides?.title ?? partial.title;
        const body = input.overrides?.body_md ?? partial.body_md;

        const stableId = computeStableId(stableIdInputFor(output));
        const digest = computeContentDigest(title, body);

        const dedupResult = await dedupClient.lookup(
          db,
          ctx.project_id,
          input.producer,
          stableId,
          digest,
        );
        const isDedup = dedupResult.match !== null;
        if (isDedup) dedupHits += 1;

        const status: DraftStatus = isDedup ? 'deduped' : 'editing';

        const row: CardDraftInsert = {
          project_id: ctx.project_id,
          drafter_id: ctx.user_id,
          initiator: input.initiator,
          producer: input.producer,
          run_id: output.run_id,
          output_id: output.output_id,
          stable_id: stableId,
          content_digest: digest,
          title,
          body_md: body,
          target_project_id:
            input.overrides?.target_project_id ?? partial.project_id ?? null,
          target_board_id: input.overrides?.target_board_id ?? null,
          target_list_id: input.overrides?.target_list_id ?? null,
          assignee_user_id: input.overrides?.assignee_user_id ?? null,
          labels: input.overrides?.labels ?? partial.labels ?? [],
          status,
          dedup_of_card_id: dedupResult.card_id ?? null,
          metadata: {
            correlation_id: correlationId,
            ...(input.idempotency_key !== undefined && {
              idempotency_key: input.idempotency_key,
            }),
            ...(input.output_ids_key !== undefined && {
              output_ids_key: input.output_ids_key,
            }),
          },
        };

        const [created] = await db.insert(cardDrafts).values(row).returning();
        if (!created) {
          throw new IntegrationError({
            code: 'draft_insert_failed',
            message: 'Failed to insert card_drafts row',
            service: 'bridge',
          });
        }
        inserted.push(created);
      }

      // Mutate the same attrs object emitSpan captured so the 'ok' line
      // carries the actual hit count.
      //
      // ⚠️ CORRECTED — this comment described an intention, not a behaviour, for
      // as long as it has existed. `emitSpan` snapshotted its attributes BEFORE
      // running the callback and spread that SNAPSHOT onto the completion line,
      // so this assignment was discarded and `dedup_hit_count` reported the
      // opening literal `0` for every draft ever created. Measured on this tree
      // (see the note beside `cleanAttrs` in telemetry/spans.ts, and
      // tests/unit/telemetry/spans.test.ts, which now pins it): the ok line read
      // `{"count":0,...}` for a handler that had set 42. The spans.ts completion
      // lines now re-read the live object, so the line below finally does what it
      // says.
      //
      // ⚠️ CORRECTED AGAIN — an earlier revision of this comment said the opening
      // literal was "left as-is only because changing it is a dashboard-visible
      // change that belongs to whoever owns the draft-creation panel". That
      // deferral was wrong on its own reasoning: because this assignment is
      // reached unconditionally on every path that returns, the SUCCESS-path
      // completion line is byte-identical whether the span opens at `0` or at
      // `null`. There was no dashboard-visible change to defer. The opening
      // literal is now `null` (see the note above it), so the only lines that
      // moved are the `start` line and the `error` line of a span that threw
      // before reaching here — exactly the two places `0` was a fabricated
      // measurement.
      spanAttrs.dedup_hit_count = dedupHits;
      return inserted;
    });
  }

  /**
   * Caller-scoped listing — the read that makes `/bridge` survive a refresh.
   *
   * SCOPE. `(project_id, drafter_id)`, both taken from the authenticated
   * BridgeCtx by the caller, never from the request. `get()` above scopes by
   * project alone, which is adequate for a point-read of a UUID the caller
   * already holds; a LISTING is a different exposure — project_id alone would
   * hand every draft in a project to anyone who can name it, and nothing in
   * `buildBridgeCtx` checks project membership. So this mirrors the file's
   * other listing (`scopedFilters`, domain/bridge/caller-scope.ts), which
   * forces BOTH identity keys from the context for exactly that reason.
   *
   * CAP. `limit` is applied with a +1 probe row so the caller can tell a full
   * page from a truncated one WITHOUT a second COUNT query. `truncated` is a
   * measurement, not a guess: it is true iff the database actually had one
   * more row than we return. Callers must render that — an absence shown as a
   * complete result is this repo's signature defect.
   */
  async list(
    db: BridgeDb,
    scope: Pick<BridgeCtx, 'project_id' | 'user_id'>,
    opts: { limit: number; statuses?: string[] } ,
  ): Promise<{ rows: CardDraftRow[]; truncated: boolean }> {
    const statuses = opts.statuses?.filter((s) => s.length > 0) ?? [];
    const predicates = [
      eq(cardDrafts.project_id, scope.project_id),
      eq(cardDrafts.drafter_id, scope.user_id),
      ...(statuses.length > 0 ? [inArray(cardDrafts.status, statuses)] : []),
    ];

    const probed = await db
      .select()
      .from(cardDrafts)
      .where(and(...predicates))
      // `created_at` alone is not a total order — a batch create writes N rows
      // inside one statement and they can share a timestamp, which makes the
      // page boundary non-deterministic and can drop or repeat a row.
      .orderBy(desc(cardDrafts.created_at), desc(cardDrafts.id))
      .limit(opts.limit + 1);

    const truncated = probed.length > opts.limit;
    return { rows: truncated ? probed.slice(0, opts.limit) : probed, truncated };
  }

  /**
   * Project-scoped fetch. Returns null on miss so route handlers can
   * decide between 404 and other shapes without a try/catch dance.
   */
  async get(
    db: BridgeDb,
    projectId: string,
    draftId: string,
  ): Promise<CardDraftRow | null> {
    const [row] = await db
      .select()
      .from(cardDrafts)
      .where(
        and(eq(cardDrafts.id, draftId), eq(cardDrafts.project_id, projectId)),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Editable-only patch. Submitting / committed / rejected / deduped drafts
   * are immutable here; bridge.reject / bridge.submit drive those transitions.
   */
  async patch(
    db: BridgeDb,
    ctx: BridgeCtx,
    draftId: string,
    patch: DraftPatchInput,
  ): Promise<CardDraftRow> {
    const existing = await this.get(db, ctx.project_id, draftId);
    if (!existing) {
      throw new IntegrationError({
        code: 'draft_not_found',
        message: `Draft ${draftId} not found`,
        service: 'bridge',
      });
    }
    if (existing.status !== 'editing') {
      throw new IntegrationError({
        code: 'draft_not_editable',
        message: `Draft ${draftId} is in status '${existing.status}' and cannot be edited`,
        service: 'bridge',
      });
    }

    return emitSpan(
      'fr.bridge.draft.edited',
      {
        project_id: ctx.project_id,
        producer: existing.producer,
        correlation_id: ctx.request.correlationId ?? null,
        draft_id: draftId,
      },
      async () => {
        // Recompute content_digest if title/body changed so dedup remains
        // accurate against the post-edit content.
        const newTitle = patch.title ?? existing.title;
        const newBody = patch.body_md ?? existing.body_md;
        const digestChanged =
          patch.title !== undefined || patch.body_md !== undefined;

        const updates: Partial<CardDraftInsert> = {
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.body_md !== undefined && { body_md: patch.body_md }),
          ...(patch.target_project_id !== undefined && {
            target_project_id: patch.target_project_id,
          }),
          ...(patch.target_board_id !== undefined && {
            target_board_id: patch.target_board_id,
          }),
          ...(patch.target_list_id !== undefined && {
            target_list_id: patch.target_list_id,
          }),
          ...(patch.assignee_user_id !== undefined && {
            assignee_user_id: patch.assignee_user_id,
          }),
          ...(patch.labels !== undefined && { labels: patch.labels }),
          ...(digestChanged && {
            content_digest: computeContentDigest(newTitle, newBody),
          }),
          updated_at: new Date(),
        };

        const [row] = await db
          .update(cardDrafts)
          .set(updates)
          .where(eq(cardDrafts.id, draftId))
          .returning();
        if (!row) {
          throw new IntegrationError({
            code: 'draft_update_failed',
            message: `Failed to update draft ${draftId}`,
            service: 'bridge',
          });
        }
        return row;
      },
    );
  }

  /**
   * Soft-delete via status flip. Audit lives in the emitted span. The
   * optional `reason` is persisted into `metadata.rejection_reason` (also
   * stamped with `rejected_by` and `rejected_at`) so downstream tooling and
   * the UI can surface why a draft was discarded. Existing metadata keys are
   * preserved (object spread; we never overwrite the whole jsonb blob).
   *
   * `reason` length is soft-capped at 2000 chars to prevent unbounded jsonb
   * growth from a runaway agent / paste; longer strings are truncated rather
   * than rejected so the user-visible action still succeeds.
   */
  async reject(
    db: BridgeDb,
    ctx: BridgeCtx,
    draftId: string,
    by: string,
    reason?: string | null,
  ): Promise<CardDraftRow> {
    const existing = await this.get(db, ctx.project_id, draftId);
    if (!existing) {
      throw new IntegrationError({
        code: 'draft_not_found',
        message: `Draft ${draftId} not found`,
        service: 'bridge',
      });
    }

    // Block reject of drafts that have already passed the editing gate. A
    // 'submitted' draft has a live approvals row + broadcast in flight; a
    // 'committed' draft has a Planka card we cannot un-write. Tolerate
    // already-rejected / deduped drafts for replay-safety.
    if (existing.status === 'committed' || existing.status === 'submitted') {
      throw new IntegrationError({
        code: 'draft_not_rejectable',
        message: `Draft ${draftId} is in status '${existing.status}' and cannot be rejected`,
        service: 'bridge',
      });
    }

    const trimmed =
      typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim().slice(0, 2000)
        : null;

    return emitSpan(
      'fr.bridge.draft.rejected',
      {
        project_id: ctx.project_id,
        producer: existing.producer,
        correlation_id: ctx.request.correlationId ?? null,
        draft_id: draftId,
        by,
        reason: trimmed,
      },
      async () => {
        // Preserve any prior metadata (e.g. correlation_id stamped on create).
        const prevMetadata =
          (existing.metadata as Record<string, unknown> | null) ?? {};
        const nextMetadata: Record<string, unknown> = {
          ...prevMetadata,
          rejection_reason: trimmed,
          rejected_by: by,
          rejected_at: new Date().toISOString(),
        };

        const [row] = await db
          .update(cardDrafts)
          .set({
            status: 'rejected',
            metadata: nextMetadata,
            updated_at: new Date(),
          })
          .where(eq(cardDrafts.id, draftId))
          .returning();
        if (!row) {
          throw new IntegrationError({
            code: 'draft_update_failed',
            message: `Failed to reject draft ${draftId}`,
            service: 'bridge',
          });
        }
        return row;
      },
    );
  }
}

export const draftService = new DraftService();
