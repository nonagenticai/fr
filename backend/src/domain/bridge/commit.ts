// fr/backend/src/domain/bridge/commit.ts
//
// CommitService — invoked by the approval-completion handler when a bridge
// approval reaches consensus. Writes the actual Planka card and stamps a
// `card_bridge_links` row so future runs dedup. See spec §Write path step 4.
//
// Idempotency: a re-entrant commit on a draft that's already 'committed'
// returns `{ idempotent: true }` without touching Planka — the
// approval-consensus path can fire twice on retry.
import { and, eq } from 'drizzle-orm';
import { approvals, cardDrafts, projects } from '../../db/schema';
import { projectTaggedForTenant } from '../../lib/project-access';
import { assertProjectNotArchived, PROJECT_ARCHIVED } from '../../lib/project-live-status';
import { IntegrationError, isIntegrationError } from '../../integrations/_lib/errors';
import * as kanbanClient from '../../integrations/kanban';
import { emitSpan } from '../../telemetry/spans';
import { assertDescriptionScenarios } from '../../services/gherkin-scenarios';
import * as dedupClient from './dedup';
import type { BridgeCtx, BridgeDb, ProducerId } from './types';

export interface CommitResult {
  card_id: string;
  idempotent: boolean;
}

interface PlankaCreateCardResponse {
  item?: { id?: string };
}

function extractCardId(resp: unknown): string {
  // Planka REST shape: { item: { id, ... } }
  const r = resp as PlankaCreateCardResponse;
  const id = r?.item?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new IntegrationError({
      code: 'kanban_unexpected_response',
      message: 'Planka createCard response missing item.id',
      service: 'kanban',
      upstreamBody: resp,
    });
  }
  return id;
}

async function assertListOnProjectBoard(
  listId: string,
  projectBoardId: string | null,
  draftId: string,
): Promise<void> {
  const notFound = () =>
    new IntegrationError({
      code: 'target_list_not_found',
      message: `Target list for draft ${draftId} is not on the project's board`,
      service: 'bridge',
    });
  if (!projectBoardId) throw notFound();
  let boardId: unknown;
  try {
    const list = (await kanbanClient.getList(listId)) as unknown as {
      item?: { boardId?: unknown };
    };
    boardId = list?.item?.boardId;
  } catch (err) {
    if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') throw notFound();
    throw err;
  }
  if (typeof boardId !== 'string' || boardId !== projectBoardId) throw notFound();
}

export class CommitService {
  async commit(
    db: BridgeDb,
    ctx: BridgeCtx,
    draftId: string,
  ): Promise<CommitResult> {
    const [draft] = await db
      .select()
      .from(cardDrafts)
      .where(
        and(
          eq(cardDrafts.id, draftId),
          eq(cardDrafts.project_id, ctx.project_id),
        ),
      )
      .limit(1);

    if (!draft) {
      throw new IntegrationError({
        code: 'draft_not_found',
        message: `Draft ${draftId} not found`,
        service: 'bridge',
      });
    }

    // fr#1500: tenant-scoped project lookup (`projectTaggedForTenant`, fails
    // closed on an untagged row), same as SubmitService.submit. A miss is
    // answered exactly like a missing draft — no existence oracle. Runs BEFORE
    // the idempotent re-entry so a foreign tenant cannot read a committed
    // draft's card id either.
    const [project] = await db
      .select({
        id: projects.id,
        status: projects.status,
        planka_board_id: projects.planka_board_id,
      })
      .from(projects)
      .where(and(eq(projects.id, ctx.project_id), projectTaggedForTenant(ctx.tenant_id)))
      .limit(1);
    if (!project) {
      throw new IntegrationError({
        code: 'draft_not_found',
        message: `Draft ${draftId} not found`,
        service: 'bridge',
      });
    }

    // Idempotent re-entry: approval-consensus may fire twice on retry; a
    // committed draft already has a card so just return the prior id.
    // Deliberately BEFORE the archived refusal: it creates nothing, so a retry
    // of a commit that landed before the archive stays a benign no-op.
    if (draft.status === 'committed' && draft.committed_card_id) {
      return { card_id: draft.committed_card_id, idempotent: true };
    }

    // fr#1500: a draft submitted BEFORE the project was archived must not
    // create a Planka card on the archived project once its approval is
    // decided — refuse with 409 `project_archived` (`archived` ONLY; pending/
    // cancelled still commit, see the helper). Before any Planka call and any
    // DB write, so the draft stays `submitted` with no card and no bridge link.
    // Loud: the commit_failed span carries the code, and the AppError renders
    // as HTTP 409 (route) / non-retriable validation_failed (AG-UI).
    try {
      assertProjectNotArchived(project);
    } catch (err) {
      await emitSpan(
        'fr.bridge.card.commit_failed',
        {
          project_id: ctx.project_id,
          producer: draft.producer,
          correlation_id: ctx.request.correlationId,
          draft_id: draft.id,
          'error.code': PROJECT_ARCHIVED,
        },
        async () => undefined,
      );
      throw err;
    }

    // H4: a commit writes a Planka card with the shared agent token, so it
    // must be the CONSEQUENCE of an approved submission — never a direct call.
    // Requires status 'submitted' AND the approval submit linked
    // (`card_drafts.approval_id`, written in the same tx as the flip) to be
    // `approved`. An editing draft, a pending/rejected approval, or a draft
    // with no linked approval is refused before any Planka call.
    if (draft.status !== 'submitted' || !draft.approval_id) {
      throw new IntegrationError({
        code: 'draft_not_committable',
        message: `Draft ${draftId} is not an approved submission`,
        service: 'bridge',
      });
    }
    const [approval] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(
        and(eq(approvals.id, draft.approval_id), eq(approvals.project_id, ctx.project_id)),
      )
      .limit(1);
    if (!approval || approval.status !== 'approved') {
      throw new IntegrationError({
        code: 'draft_not_committable',
        message: `Draft ${draftId} is not an approved submission`,
        service: 'bridge',
      });
    }

    if (!draft.target_list_id) {
      throw new IntegrationError({
        code: 'draft_missing_target_list',
        message: `Draft ${draftId} has no target_list_id`,
        service: 'bridge',
      });
    }

    // H4: `target_list_id` is client-set (drafts create/patch), and createCard
    // runs with the shared Planka agent token — so without this a caller could
    // mint a card on ANY board that token reaches. The list must resolve to the
    // project's own board (`projects.planka_board_id`). A miss — no board on
    // the project, an unknown list, or a list on another board — is the same
    // 404 `target_list_not_found`, so it is not a board-membership oracle.
    await assertListOnProjectBoard(draft.target_list_id, project.planka_board_id, draftId);

    // Render the bridge JSON block per spec §Dedup so the link survives a
    // DB loss — Planka card body becomes the source of truth.
    const bridgeMeta = {
      producer: draft.producer,
      run_id: draft.run_id,
      output_id: draft.output_id,
      stable_id: draft.stable_id,
    };
    const fence = '```';
    const bodyMd = `${draft.body_md}\n\n${fence}fr-bridge\n${JSON.stringify(bridgeMeta)}\n${fence}`;

    // fr#1338: strict gherkin_scenarios entries — refused, never stripped.
    // Before the Planka write, so a refusal leaves the draft untouched.
    assertDescriptionScenarios(bodyMd);

    const correlationId = ctx.request.correlationId;

    // STEP 1 — Planka card creation (network I/O, NOT transactional).
    // We deliberately keep this outside the DB tx because Planka is an
    // external system: a tx that wrapped this would either (a) hold a row
    // lock for a multi-second HTTP call or (b) commit the DB write before
    // we know the card landed. Errors here leave status='submitted' so the
    // user can retry; the bridge_links + draft-flip have not yet been
    // touched, so retry semantics are clean.
    let cardId: string;
    try {
      const resp = await kanbanClient.createCard(draft.target_list_id, {
        type: 'project',
        name: draft.title,
        description: bodyMd,
      });
      cardId = extractCardId(resp);
    } catch (err) {
      const code =
        err instanceof IntegrationError ? err.code : 'commit_failed';
      await emitSpan(
        'fr.bridge.card.commit_failed',
        {
          project_id: ctx.project_id,
          producer: draft.producer,
          correlation_id: correlationId,
          draft_id: draft.id,
          'error.code': code,
        },
        async () => undefined,
      );
      throw err;
    }

    // STEP 2 — record bridge link + flip draft to 'committed' inside ONE
    // transaction so we cannot end up with a recorded link but
    // status='submitted' (or vice versa) on a partial DB failure. If this
    // throws AFTER the Planka card already exists we cannot roll back the
    // card — emit `fr.bridge.card.commit_partial` and re-throw so the
    // operator notices.
    try {
      await db.transaction(async (tx) => {
        // tx is structurally a drizzle handle; recordCommit uses
        // insert(...).onConflictDoUpdate which exists on the tx type. Cast
        // through BridgeDb so the alias does not need a tx-flavored variant.
        await dedupClient.recordCommit(tx as unknown as BridgeDb, {
          project_id: ctx.project_id,
          producer: draft.producer as ProducerId,
          stable_id: draft.stable_id,
          card_id: cardId,
          run_id: draft.run_id,
          content_digest: draft.content_digest,
        });

        await tx
          .update(cardDrafts)
          .set({
            status: 'committed',
            committed_card_id: cardId,
            updated_at: new Date(),
          })
          .where(eq(cardDrafts.id, draftId));
      });
    } catch (err) {
      const code =
        err instanceof IntegrationError ? err.code : 'commit_partial';
      // The Planka card exists but our local bookkeeping failed. We cannot
      // un-create the card (Planka has no transactional API); the caller
      // / on-call must reconcile. The fenced fr-bridge JSON block in the
      // card body is the durable backstop — recordCommit can be replayed
      // safely (UNIQUE upsert) once the underlying DB issue is fixed.
      await emitSpan(
        'fr.bridge.card.commit_partial',
        {
          project_id: ctx.project_id,
          producer: draft.producer,
          correlation_id: correlationId,
          card_id: cardId,
          draft_id: draft.id,
          error_code: code,
        },
        async () => undefined,
      );
      throw err;
    }

    await emitSpan(
      'fr.bridge.card.committed',
      {
        project_id: ctx.project_id,
        producer: draft.producer,
        correlation_id: correlationId,
        draft_id: draft.id,
        card_id: cardId,
      },
      async () => undefined,
    );

    return { card_id: cardId, idempotent: false };
  }
}

export const commitService = new CommitService();
