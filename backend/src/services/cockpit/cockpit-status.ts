// src/services/cockpit/cockpit-status.ts
//
// C1 status header — the ONE lifecycle state chip, derived by fr in the read model (R-CK4).
//
// RM owns the project's type, phase and status and only PM/n8n writes them (George 2026-10-13).
// "Waiting on you", "Blocked" and "Paused" are DISPLAY states derived here from what RM, the approvals
// table, the board, the andon cord and the flow-run record say. fr reads; it never writes them
// back and never judges from them.
//
// Precedence (first match wins) — FR-PROJECT-HOME-REDESIGN-2026-10-26 §4, six states:
//   completed       RM status `closed`, or fr status `delivered`
//   cancelled       fr status `archived` while RM has NOT closed the project (stopped, not finished)
//   paused          the project's andon cord is pulled — "Paused (andon)"
//   blocked         a card is blocked for a reason OTHER than a pending approval, or a flow failed
//                   and has had no later success
//   waiting_on_you  ≥1 open approval (ask or sign-off) on the project
//   running         everything else (including "nothing has started yet": the phase says so)
//
// "Blocked" outranks "Waiting on you": a hard stop is the more urgent fact, and the needs-you strip
// still lists every open ask beside it. A card blocked only BY an open approval is not "blocked"
// — that is exactly the "waiting on you" case, counted there. A pause outranks both: nothing moves
// until someone continues it, whatever else is true.
import type { ConveyorFlowRunRow } from '../../db/schema';

export type CockpitState = 'running' | 'waiting_on_you' | 'blocked' | 'paused' | 'completed' | 'cancelled';

/** Why the state is what it is. Codes, rendered as plain words by the UI. */
export type CockpitStateReason =
  | 'rm_closed'
  | 'project_archived'
  | 'project_delivered'
  | 'andon_engaged'
  | 'card_blocked'
  | 'flow_failed'
  | 'open_approvals';

export interface StatusInputs {
  /** fr `projects.status`. */
  frStatus: string;
  /** RM `pm.status`; null when RM could not be read. */
  rmStatus: string | null;
  andonEngaged: boolean;
  /** Pending approvals on the project. */
  openApprovals: number;
  /** Cards blocked for a reason other than a pending approval (lane, label). */
  blockedCards: number;
  /** Flow runs with a failure that no later success of the same flow (and card) superseded. */
  unresolvedFlowFailures: number;
}

export interface DerivedState {
  state: CockpitState;
  reasons: CockpitStateReason[];
}

/** The project is over (completed or cancelled): no asks, drafts or running indicators. */
export function isFinishedState(s: CockpitState): boolean {
  return s === 'completed' || s === 'cancelled';
}

export function deriveCockpitState(i: StatusInputs): DerivedState {
  if (i.rmStatus === 'closed') return { state: 'completed', reasons: ['rm_closed'] };
  if (i.frStatus === 'delivered') return { state: 'completed', reasons: ['project_delivered'] };
  if (i.frStatus === 'archived') return { state: 'cancelled', reasons: ['project_archived'] };
  const paused: CockpitStateReason[] = [];
  if (i.andonEngaged) paused.push('andon_engaged');
  if (paused.length > 0) return { state: 'paused', reasons: paused };
  const blocked: CockpitStateReason[] = [];
  if (i.blockedCards > 0) blocked.push('card_blocked');
  if (i.unresolvedFlowFailures > 0) blocked.push('flow_failed');
  if (blocked.length > 0) return { state: 'blocked', reasons: blocked };
  if (i.openApprovals > 0) return { state: 'waiting_on_you', reasons: ['open_approvals'] };
  return { state: 'running', reasons: [] };
}

const FAILED = new Set(['error', 'crashed']);

function runTime(r: Pick<ConveyorFlowRunRow, 'started_at' | 'stopped_at' | 'received_at'>): number {
  const t = r.started_at ?? r.stopped_at ?? r.received_at;
  return t ? new Date(t).getTime() : 0;
}

/**
 * The failed runs no later success of the same flow on the same card superseded — "a failed flow
 * with no later success" (R-CK4). Flow identity = workflow id (else name); a run with no card
 * groups with the other card-less runs of that flow. Newest first.
 */
export function unresolvedFlowFailures<
  R extends Pick<ConveyorFlowRunRow, 'execution_id' | 'workflow_id' | 'workflow_name' | 'card_id' | 'status' | 'started_at' | 'stopped_at' | 'received_at'>,
>(runs: readonly R[]): R[] {
  const latestByKey = new Map<string, R>();
  for (const r of runs) {
    if (!FAILED.has(r.status) && r.status !== 'success') continue;
    const key = `${r.workflow_id ?? r.workflow_name ?? '?'}|${r.card_id ?? ''}`;
    const prev = latestByKey.get(key);
    if (!prev || runTime(r) > runTime(prev)) latestByKey.set(key, r);
  }
  return [...latestByKey.values()].filter((r) => FAILED.has(r.status)).sort((a, b) => runTime(b) - runTime(a));
}
