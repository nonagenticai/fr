// fr/backend/src/domain/bridge/submit.ts
//
// SubmitService — flips a draft from 'editing'/'deduped' into 'submitted' by
// creating a paired `approvals` row with `callback_path` pointing at the
// commit endpoint. See spec §Write path.
import { and, eq } from 'drizzle-orm';
import { approvals, cardDrafts, projects, requiredApprovers } from '../../db/schema';
import { projectTaggedForTenant } from '../../lib/project-access';
import { assertProjectNotArchived } from '../../lib/project-live-status';
import { IntegrationError, isIntegrationError } from '../../integrations/_lib/errors';
import { getList as kanbanGetList } from '../../integrations/kanban';
import {
  approvalNotificationCopy,
  notificationService,
} from '../../domain/engagement/notifications';
import { fanOutApprovalToTenantMembers } from '../engagement/tenant-member-fanout';
import { emitSpan } from '../../telemetry/spans';
import type { BridgeCtx, BridgeDb } from './types';
import type { CardDraftRow } from './drafts';

/**
 * Validate that `target_list_id` resolves in Planka. We rely on
 * `integrations/kanban.getList`, which already raises an IntegrationError with
 * `UPSTREAM_NOT_FOUND` on a 404; we re-throw a bridge-domain
 * `target_list_not_found` so the route layer can emit a 404 with the bridge
 * envelope instead of an opaque upstream-not-found.
 *
 * Every other error (network, 5xx) propagates unchanged, so callers can
 * distinguish transport errors from a clean miss.
 */
export async function assertTargetListExists(targetListId: string): Promise<void> {
  try {
    await kanbanGetList(targetListId);
  } catch (err) {
    if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') {
      throw new IntegrationError({
        code: 'target_list_not_found',
        message: `Target list ${targetListId} does not exist in Planka`,
        service: 'bridge',
        cause: err,
      });
    }
    throw err;
  }
}

export interface SubmitResult {
  approval_id: string;
  draft: CardDraftRow;
  broadcasted_to: number;
}

export class SubmitService {
  async submit(
    db: BridgeDb,
    ctx: BridgeCtx,
    draftId: string,
  ): Promise<SubmitResult> {
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

    if (draft.status !== 'editing' && draft.status !== 'deduped') {
      throw new IntegrationError({
        code: 'draft_not_submittable',
        message: `Draft ${draftId} is in status '${draft.status}' and cannot be submitted`,
        service: 'bridge',
      });
    }

    // fr#1500: refuse a mint on an ARCHIVED project (409 `project_archived`).
    // The approvals project lane hides archived projects, so an approval minted
    // here would be invisible forever. The lookup is tenant-scoped by the
    // project's own tag (`projectTaggedForTenant`, fr row 14b — fails closed on
    // an untagged row), and a miss is answered exactly like a missing draft:
    // the caller learns nothing about whether the project exists elsewhere.
    // Runs before the Planka round-trip so the refusal does not depend on
    // Planka being reachable. `archived` ONLY — pending/cancelled still mint (see the helper).
    const [project] = await db
      .select({ id: projects.id, status: projects.status })
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
    assertProjectNotArchived(project);

    // Validate `target_list_id` against Planka before we materialise an
    // approval row. Submitting against a non-existent list would still fail
    // at the `commit` step (createCard would 404), but at that point the
    // approval is already minted and a human reviewer will have been pinged.
    // Failing fast here keeps the approval queue clean. We only validate
    // when a target list is actually set — drafts without one fail later in
    // commit.ts with `draft_missing_target_list`, which is a separate
    // semantic ("user hasn't picked a column" vs "the column they picked
    // doesn't exist").
    if (draft.target_list_id) {
      await assertTargetListExists(draft.target_list_id);
    }

    const correlationId = ctx.request.correlationId;
    const callbackPath = `/tools/bridge/drafts/${draft.id}/commit`;

    return emitSpan(
      'fr.bridge.draft.submitted',
      {
        project_id: ctx.project_id,
        producer: draft.producer,
        correlation_id: correlationId,
        draft_id: draft.id,
        channels_reached: 1,
      },
      async () => {
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        // Wrap (insert approvals → insert required_approvers → flip draft)
        // in a single transaction so we cannot end up with an orphaned
        // approval, required_approvers without their approval, or a draft
        // marked 'submitted' against a missing approval row. Pattern copied
        // from `domain/engagement/action-approvals.ts`. Network I/O (fanOut) runs
        // OUTSIDE the tx — see below.
        const { approval, updatedDraft } = await db.transaction(async (tx) => {
          const [createdApproval] = await tx
            .insert(approvals)
            .values({
              tenant_id: ctx.tenant_id,
              project_id: ctx.project_id,
              requester_id: ctx.user_id,
              description: draft.title,
              callback_path: callbackPath,
              status: 'pending',
              expires_at: expiresAt,
              metadata: {
                kind: 'bridge_card',
                draft_id: draft.id,
                callback_path: callbackPath,
                correlation_id: correlationId,
              },
            })
            .returning();

          if (!createdApproval) {
            throw new IntegrationError({
              code: 'approval_insert_failed',
              message: 'Failed to create approval row',
              service: 'bridge',
            });
          }

          await tx.insert(requiredApprovers).values({
            tenant_id: ctx.tenant_id,
            approval_id: createdApproval.id,
            user_id: ctx.user_id,
          });

          const [flipped] = await tx
            .update(cardDrafts)
            .set({
              status: 'submitted',
              approval_id: createdApproval.id,
              updated_at: new Date(),
            })
            .where(eq(cardDrafts.id, draft.id))
            .returning();

          if (!flipped) {
            throw new IntegrationError({
              code: 'draft_update_failed',
              message: `Failed to flip draft ${draft.id} to submitted`,
              service: 'bridge',
            });
          }

          return { approval: createdApproval, updatedDraft: flipped };
        });

        // Broadcast OUTSIDE the transaction. Doing this inside risks
        // notifying users of an approval whose tx was rolled back — once a
        // Telegram/Teams message is out, we cannot un-send it. fanOutToUser
        // is fire-and-forget; failures here do not roll back the DB writes
        // (which is the right tradeoff: a stuck broadcast should not vacate
        // a real pending approval).
        // THE notification copy every send uses (kind, tenant_id, action_id travel with it).
        const approvalForFanOut = approvalNotificationCopy(approval);
        await notificationService.fanOutToUser(approvalForFanOut, ctx.user_id);
        // P1-TEAM-b (George 2026-10-15): every member of the tenant is told as well
        // (told, not enrolled). Never throws.
        const members = await fanOutApprovalToTenantMembers({
          approval: approvalForFanOut,
          tenantId: ctx.tenant_id,
          alreadyNotified: [ctx.user_id],
          context: 'bridge.submit',
        });

        return {
          approval_id: approval.id,
          draft: updatedDraft,
          broadcasted_to: 1 + members.notified.length,
        };
      },
    );
  }
}

export const submitService = new SubmitService();
