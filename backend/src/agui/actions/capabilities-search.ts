/**
 * fr-agui SPEC §4.1 — `capabilities.search {query, area?}`, the project agent's
 * meta-tool.
 *
 * Only the `project-core` pack's CORE members are sent every turn (local-llm is
 * one vLLM model with a bounded context). The pack's SEARCHABLE members are
 * found through this tool: it returns those matching the query that the caller
 * may use, and the agent loop adds them to this THREAD's catalog from the next
 * step on (agent/loop.ts reads them back out of the thread's own tool results,
 * so the widening is per thread and survives a reload).
 *
 * It can never widen RBAC (§10.4): every hit is dry-run through `assertRbac`
 * with the caller's own context, exactly as the catalog is, and nothing outside
 * the project agent's pack can ever be returned. A bound thread only.
 */
import { z } from 'zod';

import { getAction, registerAction } from '../registry';
import { assertRbac, RbacDeniedError } from '../rbac';
import { PROJECT_AGENT_SEARCHABLE } from '../agent-surface';
import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';

export const CAPABILITY_SEARCH_LIMIT = 8;

const input = z.object({
  query: z.string().min(1).max(200),
  /** The capability namespace (`toc`, `architecture`, `coding`, …) to restrict to. */
  area: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
});
const output = z.object({
  capabilities: z.array(z.object({ name: z.string(), description: z.string(), kind: z.enum(['read', 'write']) })),
  note: z.string(),
});
type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
}

/** Relevance: query words found in the name (×3) or the description (×1). 0 = no match. */
export function scoreCapability(query: string, name: string, description: string): number {
  const hay = { name: name.toLowerCase().replace(/[._]/g, ' '), desc: description.toLowerCase() };
  let score = 0;
  for (const w of words(query)) {
    if (hay.name.includes(w)) score += 3;
    else if (hay.desc.includes(w)) score += 1;
  }
  return score;
}

async function allowed(action: AgentCallableAction, ctx: ActionContext): Promise<boolean> {
  try {
    await assertRbac(action, ctx, {});
    return true;
  } catch (err) {
    if (err instanceof RbacDeniedError) return false;
    return false;
  }
}

export async function searchCapabilities(i: Input, ctx: ActionContext): Promise<Output> {
  if (!ctx.projectId) {
    throw new AppError(409, 'capabilities.search works inside a project').withCode('project_required');
  }
  const hits: Array<{ score: number; a: AgentCallableAction }> = [];
  for (const name of PROJECT_AGENT_SEARCHABLE) {
    if (i.area && !name.startsWith(`${i.area}.`)) continue;
    const a = getAction(name);
    if (!a) continue;
    const score = scoreCapability(i.query, a.name, a.description);
    if (score === 0) continue;
    if (!(await allowed(a, ctx))) continue;
    hits.push({ score, a });
  }
  hits.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name));
  const top = hits.slice(0, CAPABILITY_SEARCH_LIMIT);
  return {
    capabilities: top.map(({ a }) => ({ name: a.name, description: a.description.split('\n')[0]!, kind: a.kind })),
    note:
      top.length > 0
        ? 'These tools are available from your next step in this conversation.'
        : 'No further project tool matches; answer with the tools you have, or tell the user what is not possible here.',
  };
}

export const capabilitiesSearchAction: AgentCallableAction<Input, Output> = {
  name: 'capabilities.search',
  kind: 'read',
  description:
    'Find more of THIS project\'s tools by keyword (e.g. "toc conflict", "architecture views", "coding findings"). The tools found are offered on your next step.',
  input,
  output,
  approval: { type: 'auto' },
  cronSafe: false,
  idempotencyKey: (i) => `capabilities.search:${i.area ?? ''}:${i.query}`,
  rbac: { type: 'project-member' },
  handler: searchCapabilities,
};

/** Production registrar (called by `registerAllActions`). */
export function registerCapabilitiesSearchActions(): void {
  try {
    registerAction(capabilitiesSearchAction);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}
