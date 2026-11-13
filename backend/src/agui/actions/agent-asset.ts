/**
 * Plan 3 follow-up — agent.create_asset AG-UI action.
 *
 * Plan 7 Stage 9: principle/requirement/decision now route through the
 * card-creation loop (POST /api/cards/improvement → Stage 5 dispatch →
 * upstream persists at QA).
 *
 * KAG-doc creation is intentionally NOT included here (the KAG ingest
 * pipeline is async + multi-step); the agent uses the existing kag.*
 * actions for that.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import { withInvokeCard } from '../capability-invoke-card';
import type { ActionContext, AgentCallableAction } from '../types';
import {
  mintImprovementCard,
  type AssetCardGroup,
  type AssetCardType,
} from '../../services/improvement-cards/mint-client';

const assetTypeSchema = z.enum(['principle', 'decision', 'requirement']);

const inputSchema = z.object({
  /**
   * fr-agui P2: the project this write targets — the PROJECT PARAMETER
   * (agui/agent-surface.ts PROJECT_BINDING): removed from the model's schema
   * and set from the thread in a bound context, required by the confirm card's
   * route (POST /api/capabilities/:id/invoke). Unused outside a project.
   */
  project_id: z.string().uuid().optional(),
  asset_type: assetTypeSchema,
  /** Free-form payload — passed through to the upstream `create` body. */
  payload: z.record(z.unknown()),
});

const outputSchema = z.object({
  asset_type: assetTypeSchema,
  id: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

const CARD_TYPE_BY_ASSET: Record<
  'principle' | 'requirement' | 'decision',
  { card_type: AssetCardType; card_group: AssetCardGroup }
> = {
  principle: { card_type: 'principle_development', card_group: 'principle' },
  requirement: { card_type: 'requirement_development', card_group: 'requirement' },
  decision: { card_type: 'decision_development', card_group: 'decision' },
};

const CHANGE_CARD_TYPE_BY_ASSET: Record<
  'principle' | 'requirement' | 'decision',
  { card_type: AssetCardType; card_group: AssetCardGroup }
> = {
  principle: { card_type: 'change_principle_development', card_group: 'principle' },
  requirement: { card_type: 'change_requirement_development', card_group: 'requirement' },
  decision: { card_type: 'change_decision_development', card_group: 'decision' },
};

const action: AgentCallableAction<Input, Output> = {
  name: 'agent.create_asset',
  kind: 'write',
  description:
    'Create a tenant-scoped asset (principle/requirement/decision). Mints a *_development card on the AA board and returns the card_id — the actual asset persists upstream when the loop reaches QA.',
  input: inputSchema,
  output: outputSchema,
  // The human's Confirm IS the approval: the sole approver is the initiator, so the
  // confirmed run executes inline (shouldSelfApprove) instead of parking an
  // approval only that same human could grant. A non-human initiator still parks.
  approval: { type: 'single-approver', approver: 'initiator' },
  autoApproveForInitiator: true,
  cronSafe: false,
  idempotencyKey: (i) =>
    `agent.create_asset:${i.asset_type}:${JSON.stringify(i.payload).slice(0, 256)}`,
  rbac: { type: 'project-member' },
  handler: async (input, ctx: ActionContext): Promise<Output> => {
    const map = CARD_TYPE_BY_ASSET[input.asset_type];
    const payload = (input.payload ?? {}) as {
      problem_statement?: unknown;
      desired_outcome?: unknown;
    };
    const out = await mintImprovementCard(
      {
        card_type: map.card_type,
        card_group: map.card_group,
        target_list: 'TODO',
        problem_statement: String(payload.problem_statement ?? '(no statement)'),
        desired_outcome: String(payload.desired_outcome ?? '(no outcome)'),
        requestor: 'agent.create_asset',
      },
      { tenantId: ctx.tenantId ?? '' },
    );
    return { asset_type: input.asset_type, id: out.card_id };
  },
};

// ---------------------------------------------------------------------------
// agent.update_asset — the assisted-REVISE counterpart to create_asset.
// Mints a change_*_development card carrying the target asset_id; when the
// loop reaches QA the revision persists via PUT (updateX) through
// routes/asset-authoring/publish.ts.
const updateAssetTypeSchema = z.enum(['principle', 'decision', 'requirement']);

const updateInputSchema = z.object({
  /**
   * fr-agui P2: the project this write targets — the PROJECT PARAMETER
   * (agui/agent-surface.ts PROJECT_BINDING): removed from the model's schema
   * and set from the thread in a bound context, required by the confirm card's
   * route (POST /api/capabilities/:id/invoke). Unused outside a project.
   */
  project_id: z.string().uuid().optional(),
  asset_type: updateAssetTypeSchema,
  /** Id of the existing asset to revise. */
  asset_id: z.string().min(1),
  /** Free-form payload — passed through to the upstream change loop. */
  payload: z.record(z.unknown()),
});

const updateOutputSchema = z.object({
  asset_type: updateAssetTypeSchema,
  asset_id: z.string(),
  card_id: z.string(),
});

type UpdateInput = z.infer<typeof updateInputSchema>;
type UpdateOutput = z.infer<typeof updateOutputSchema>;

const updateAction: AgentCallableAction<UpdateInput, UpdateOutput> = {
  name: 'agent.update_asset',
  kind: 'write',
  description:
    'Revise an existing tenant-scoped asset (principle/requirement/decision). Mints a change_*_development card on the AA board carrying the target asset_id and returns the card_id — the revision persists upstream (PUT) when the loop reaches QA.',
  input: updateInputSchema,
  output: updateOutputSchema,
  // The human's Confirm IS the approval: the sole approver is the initiator, so the
  // confirmed run executes inline (shouldSelfApprove) instead of parking an
  // approval only that same human could grant. A non-human initiator still parks.
  approval: { type: 'single-approver', approver: 'initiator' },
  autoApproveForInitiator: true,
  cronSafe: false,
  idempotencyKey: (i) =>
    `agent.update_asset:${i.asset_type}:${i.asset_id}:${JSON.stringify(i.payload).slice(0, 256)}`,
  rbac: { type: 'project-member' },
  handler: async (input, ctx: ActionContext): Promise<UpdateOutput> => {
    const map = CHANGE_CARD_TYPE_BY_ASSET[input.asset_type];
    const payload = (input.payload ?? {}) as {
      problem_statement?: unknown;
      desired_outcome?: unknown;
    };
    const out = await mintImprovementCard(
      {
        card_type: map.card_type,
        card_group: map.card_group,
        target_list: 'TODO',
        problem_statement: String(payload.problem_statement ?? '(no statement)'),
        desired_outcome: String(payload.desired_outcome ?? '(no outcome)'),
        requestor: 'agent.update_asset',
        // asset_id/asset_kind ride through CardGenerationRequest onto the
        // card's Metadata group (Metadata.asset_id) so the loop knows which
        // existing asset to revise. (target_asset_id alone was silently
        // dropped — not a CardGenerationRequest field.)
        asset_id: input.asset_id,
        asset_kind: map.card_group,
        target_asset_id: input.asset_id,
      },
      { tenantId: ctx.tenantId ?? '' },
    );
    return {
      asset_type: input.asset_type,
      asset_id: input.asset_id,
      card_id: out.card_id,
    };
  },
};

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerAgentAssetActions(): void {
  safeRegister(withInvokeCard(action));
  safeRegister(withInvokeCard(updateAction));
}

registerAgentAssetActions();
