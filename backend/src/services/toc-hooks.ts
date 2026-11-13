// fr-initiated TOC (Theory-of-Constraints / Dettmer Logical Thinking Process)
// workflow hooks — plan §5 B/C (hook A, the project-create IO-Map seed, was
// REMOVED 2026-10-14 with the project-create intake card it fired off: fr
// creates no card on project create — George 2026-10-12).
//
// These let fr OPTIONALLY nudge the AA n8n builder subroutines (and fold a CLR
// quality read into the improvement-approval gate) at two natural moments:
//
//   B. card → BLOCKED   → build an Evaporating Cloud     (Build Evaporating Cloud subroutine)
//   C. improvement-approval create → fold the structural 8-CLR quality of a
//      linked TOC tree into the approval row's `metadata.clr_check`.
//
// CRITICAL coordination contract (see config.services.n8n hook flags): the AA
// n8n orchestrator ALREADY authors IO-Maps at project-start and auto-ECs on QA
// conflicts. Firing B blindly would double-build. So every hook is:
//   - DEFAULT OFF (gated on its config flag), AND
//   - a no-op unless the target workflow id is configured, AND
//   - best-effort / non-blocking — it NEVER throws into the caller. A failure
//     is logged and swallowed so the user-facing action (create project, move
//     card, create approval) always succeeds.
//
// Keeping the logic here (not inline in the route handlers) keeps the routes
// thin and makes the gating/guards directly unit-testable.
//
// ⚠️ TRIGGER NOTE (2026-06-01): build-ownership was settled as "AA owns
// auto-builds; fr is read + on-demand", so hook B stays OFF. They also still
// call `runWorkflow` (n8n public API `POST /workflows/{id}/run`) which returns
// 405 — n8n has no run-by-id endpoint. Before EVER enabling B, switch its
// trigger to the production WEBHOOK path the on-demand write actions now use
// (`triggerWorkflow(config.services.n8n.aaBuild*Webhook, …)` — see
// `agui/actions/toc.ts triggerBuild`). As shipped they are double-gated off
// (flag default-false AND target workflow id unset) and best-effort, so the
// 405 can never reach a user.

import { config } from '../config';
import { isDoneEquivalentListName } from '../lib/done-equivalent';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { runWorkflow } from '../integrations/n8n';
import { getTocQuality, type ClrReport } from '../integrations/toc';

function warn(hook: string, err: unknown): void {
  console.warn(
    `[toc-hooks.${hook}] best-effort hook failed (swallowed):`,
    err instanceof Error ? err.message : String(err),
  );
}

/** Case-insensitive match for the canonical Planka "BLOCKED" list. */
export function isBlockedList(listName: string | null | undefined): boolean {
  return (listName ?? '').trim().toUpperCase() === 'BLOCKED';
}

/*
 * The list names that mean THE WORK IS FINISHED — the receiver's `normalize()` aliases
 * (`n8n_custom_nodes :: workflows/patterns/approval-callback.json :: Resolve Target List`
 * folds DONE/RELEASED and COMPLETED into DONE). fr must answer "finished" for AT LEAST those,
 * or it approves rows n8n then refuses to move. Since 2026-10-05 the answer comes from the one
 * shared DONE predicate (lib/done-equivalent.ts), a superset of that alias set. If `normalize()` gains a DONE alias
 * the predicate does not match, add it THERE.
 */
/**
 * Case-insensitive match for a Planka list that means the card is FINISHED.
 *
 * ⛔ A POSITIVE TEST AGAINST NAMED LISTS, NEVER `!isBlockedList(...)`, and the
 * receiver's own comment already says why at length: a card can legitimately sit
 * in TODO with its gate still open (the BLOCKED→TODO recycle loop puts it there),
 * so "not BLOCKED" is not "finished". Only DONE is a state where re-driving the
 * card BACKWARD destroys work rather than merely repeating it.
 *
 * Unknown/unreadable names answer FALSE. A caller must therefore never read a
 * `false` as proof the card is live — only as "this is not positively finished".
 */
export function isFinishedList(listName: string | null | undefined): boolean {
  // ⛔ The ONE shared DONE predicate (lib/done-equivalent.ts). It is a SUPERSET of the
  // receiver's normalize() aliases (DONE, DONE/RELEASED, COMPLETED) — broader only in the
  // refusal direction (a card on e.g. "SHIPPED" is also treated as finished, so an approve
  // that would drive it backward is refused; REJECT is never blocked).
  return isDoneEquivalentListName(listName);
}

/**
 * Hook B — after a card is moved, when the destination is the project's
 * BLOCKED list, optionally build an Evaporating Cloud for the project conflict
 * via the AA "Build Evaporating Cloud" subroutine.
 *
 * Returns the triggered executionId, or `null` when the hook is disabled /
 * unconfigured / the destination is not BLOCKED / the trigger failed. Never
 * throws.
 */
export async function maybeEvaporateOnBlocked(params: {
  projectId: string | null | undefined;
  destinationListName: string | null | undefined;
  cardId?: string;
}): Promise<string | null> {
  const wfId = config.services.n8n.aaBuildEvaporatingCloudWorkflowId;
  if (!config.services.n8n.hookEvaporateOnBlocked || !wfId) return null;
  if (!params.projectId) return null;
  if (!isBlockedList(params.destinationListName)) return null;
  try {
    const { executionId } = await runWorkflow(wfId, {
      project_id: params.projectId,
      card_id: params.cardId ?? null,
      source: 'fr.card_blocked_hook',
    });
    return executionId;
  } catch (err) {
    warn('evaporateOnBlocked', err);
    return null;
  }
}

interface ClrCheck {
  toc_tree_id: string;
  score: number | null;
  issue_count: number;
  passed: boolean | null;
  evaluated_at: string;
}

/**
 * Hook C — fold the structural 8-CLR quality of a linked TOC tree into an
 * improvement-approval's `metadata.clr_check`, so the approval UI can show the
 * CLR gate. The tree id is read from the inbound approval metadata
 * (`toc_tree_id` | `clr_tree_id`). Best-effort: returns `null` when the hook is
 * disabled, no tree is linked, or the quality read failed. Never throws.
 */
export async function buildClrCheckMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Promise<ClrCheck | null> {
  if (!config.services.n8n.hookClrCheckOnImprovementApproval) return null;
  const treeId =
    typeof metadata?.toc_tree_id === 'string'
      ? metadata.toc_tree_id
      : typeof metadata?.clr_tree_id === 'string'
        ? metadata.clr_tree_id
        : null;
  if (!treeId) return null;
  try {
    const report: ClrReport = await getTocQuality(treeId);
    const issueCount = Array.isArray(report.issues) ? report.issues.length : 0;
    return {
      toc_tree_id: treeId,
      score: typeof report.score === 'number' ? report.score : null,
      issue_count: issueCount,
      passed: typeof report.score === 'number' ? issueCount === 0 : null,
      evaluated_at: new Date().toISOString(),
    };
  } catch (err) {
    warn('clrCheckOnImprovementApproval', err);
    // Degrading is right — an approval must not fail because the CLR hook did.
    // But the caller folds this into `approvals.metadata.clr_check`, so on
    // failure the KEY IS SIMPLY ABSENT and the approval UI renders no CLR gate:
    // indistinguishable from "hook disabled" or "no tree linked". Recorded so
    // a missing gate is at least attributable afterwards.
    reportSwallowedFailure(err, {
      service: 'n8n',
      degradedTo: 'approval stored with no clr_check key — the gate is invisible, not absent',
    });
    return null;
  }
}
