/**
 * fr-agui SPEC §5.2 (W) — the web agent PROPOSES a write; the human executes it.
 *
 * For an action that declares `confirm`, the agent loop calls `buildProposal`
 * INSTEAD of `invokeAction`:
 *   - the input is validated with the action's own zod schema,
 *   - RBAC is dry-run (`assertRbac`) so a proposal the caller could never
 *     confirm is never shown — a HINT only; the route stays the authority,
 *   - a `proposalId` and, where declared, an `Idempotency-Key` are minted.
 * It creates NO approval row and runs NO handler. The browser renders the card
 * and, on the human's click, calls `confirm.http` under the human's session.
 *
 * Secrets (R7, §10.1): every `confirm.secretFields` key is removed from the
 * proposal and from anything echoed into the thread.
 */
import { assertRbac } from '../agui/rbac';
import { ActionInputValidationError } from '../agui/registry';
import type { ActionContext, AgentCallableAction } from '../agui/types';
import { cardOwnedFields, redactSecretFields, shapeProposal, type AgentProposal } from '../agui/proposal-shape';

export { isAgentProposal, redactSecretFields, type AgentProposal } from '../agui/proposal-shape';

export async function buildProposal(
  action: AgentCallableAction,
  input: unknown,
  ctx: ActionContext,
): Promise<AgentProposal> {
  const spec = action.confirm;
  if (!spec) throw new Error(`buildProposal: ${action.name} declares no confirm spec`);
  let parsed: unknown;
  try {
    // The card's own fields (secrets, human-only choices) never come from the agent.
    parsed = (action.input as { parse: (v: unknown) => unknown }).parse(
      redactSecretFields(input, cardOwnedFields(spec)),
    );
  } catch (err) {
    throw new ActionInputValidationError(action.name, err);
  }
  await assertRbac(action, ctx, parsed);
  return shapeProposal(action, parsed);
}
