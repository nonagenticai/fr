/**
 * AG-UI read for an asset's quality history (integrations/quality-history.ts).
 *
 * The UI's asset quality panel shows the stored verdict and the score history
 * RM recorded; this is the agent's side of that same read, and the E-14 read
 * coverage for the `quality-history` integration module.
 *
 * There is no evaluate action: requirements_management removed its LLM quality
 * judges (RM #238), and fr's Evaluate proxies and actions went with them.
 */

import { z } from 'zod';

import { getQualityHistory, QUALITY_HISTORY_KINDS } from '../../integrations/quality-history';
import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';

const getInputSchema = z.object({
  kind: z.enum(QUALITY_HISTORY_KINDS),
  id: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});
type GetInput = z.infer<typeof getInputSchema>;
const getOutputSchema = z.object({ history: z.unknown() });

const getAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'quality_history.get',
  kind: 'read',
  description:
    "An asset's recorded quality evaluations (principle, decision, architecture element or view), newest first, verbatim from requirements_management. A never-evaluated asset has an empty list.",
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  // Same as principles.get: the request tenant scopes the upstream read
  // (requireTenant), and RM 404s an asset the tenant cannot see.
  rbac: { type: 'public' },
  idempotencyKey: (i) => `quality_history.get:${i.kind}:${i.id}:${i.limit ?? ''}`,
  handler: async (input) => ({
    history: await getQualityHistory(input.kind, input.id, input.limit),
  }),
};

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') {
      return;
    }
    throw err;
  }
}

export function registerQualityHistoryActions(): void {
  safeRegister(getAction);
}
