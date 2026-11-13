/**
 * Plan 3 — Build the tool catalog the LLM sees on each turn.
 *
 * `listActions()` returns every registered AG-UI action in the process. The
 * agent loop must NEVER tell the LLM about an action the calling user
 * cannot use, otherwise the LLM might pick it and the registry will deny
 * with RbacDenied — wasted round-trip + worse UX. We do an RBAC dry-run
 * here (with a sentinel input) and drop denied actions before forwarding.
 *
 * The catalog shape passed to the LLM mirrors the OpenAI-style tools list:
 * one entry per action, with action name + description + a JSON-Schema-
 * shaped input descriptor. Workers can return any of these names in their
 * `tool_calls` output; everything else fails the structured-output check.
 */

import { listActions } from '../agui/registry';
import { assertRbac, RbacDeniedError } from '../agui/rbac';
import type { ActionContext, AgentCallableAction } from '../agui/types';
import { DOORWAY_INTAKE_ACTIONS, type AgentCatalogMode } from './intake-catalog';
import { extractJsonSchema } from '../capabilities/json-schema';
import { stripProjectParam } from './project-binding';
import { PROJECT_AGENT_CORE, PROJECT_AGENT_SEARCHABLE, PROJECT_BINDING } from '../agui/agent-surface';

// The converter lives in capabilities/json-schema.ts (fr-agui SPEC §3.4); re-exported
// so every existing importer of `extractJsonSchema` from here is unchanged.
export { extractJsonSchema };

export interface CatalogEntry {
  name: string;
  description: string;
  kind: 'read' | 'write';
  /** JSON Schema derived from the action's zod `input` — the same schema the registry validates with (fr#1383). */
  inputJsonSchema: Record<string, unknown> | null;
}

/**
 * Build the per-turn catalog for `ctx`. Actions whose RBAC rule denies
 * `ctx` are dropped; non-RBAC errors propagate (caller surfaces as a 500).
 */
/**
 * Is `name` in the catalog of `mode` for this turn? `searched` = the searchable
 * project tools `capabilities.search` already returned in this thread.
 *   intake   the `request-intake` pack (SPEC §6.0)
 *   project  the `project-core` pack: its core members, plus the searchable ones
 *            found in this thread (SPEC §4.1)
 *   default  no pack filter (non-rail callers and tests); a retired action
 *            (`catalog:'none'`) is never offered to an agent in any mode.
 */
export function inCatalogMode(
  name: string,
  mode: AgentCatalogMode,
  searched: ReadonlySet<string> = new Set(),
): boolean {
  if (mode === 'intake') return DOORWAY_INTAKE_ACTIONS.has(name);
  if (mode === 'project') {
    return (
      PROJECT_AGENT_CORE.has(name) ||
      (PROJECT_AGENT_SEARCHABLE.has(name) && searched.has(name))
    );
  }
  return true;
}

export async function buildToolCatalog(
  ctx: ActionContext,
  opts: { mode?: AgentCatalogMode; searched?: ReadonlySet<string> } = {},
): Promise<CatalogEntry[]> {
  const all = listActions();
  const out: CatalogEntry[] = [];
  const mode = opts.mode ?? 'default';

  for (const action of all) {
    // fr-agui SPEC §13 P1c (OQ-17 = c): a retired action is in NO agent catalog.
    if (action.catalog === 'none') continue;
    if (!inCatalogMode(action.name, mode, opts.searched)) continue;
    const allowed = await isAllowed(action, ctx);
    if (!allowed) continue;
    out.push({
      name: action.name,
      description: action.description,
      kind: action.kind,
      // fr-agui SPEC §5.7 rule 3: in a project-bound thread the project parameter
      // is not the model's to fill — it is injected from ctx.projectId.
      // fr-agui P2-c2: a human-only card field (an artifact review's decision, a
      // typed confirmation) is never the model's to fill, bound or not.
      inputJsonSchema: stripProjectParam(
        ctx.projectId
          ? stripProjectParam(extractJsonSchema(action.input), action.projectParam, PROJECT_BINDING.get(action.name)?.hide)
          : extractJsonSchema(action.input),
        undefined,
        action.confirm?.humanFields ?? [],
      ),
    });
  }

  return out;
}

async function isAllowed(
  action: AgentCallableAction,
  ctx: ActionContext,
): Promise<boolean> {
  // Dry-run input. RBAC rules SHOULD evaluate without inspecting input
  // shape (project-role / tenant-role / public / project-member), but
  // `custom` rules might. We pass `{}` and let `custom` rules decide.
  try {
    await assertRbac(action, ctx, {});
    return true;
  } catch (err) {
    if (err instanceof RbacDeniedError) return false;
    // Any other error (unexpected shape, provider crash) is logged but the
    // action is dropped from the catalog so the LLM cannot pick a tool we
    // can't actually run for this user.
    console.warn(
      `[agent/tool-catalog] dropping ${action.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
