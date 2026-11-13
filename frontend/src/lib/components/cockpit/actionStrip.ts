// actionStrip.ts — C2: which open items the cockpit may decide INLINE, and which must "Open".
//
// Inline Approve / Reject is offered ONLY for a simple sign-off: a pending row the viewer may
// decide (the SAME rule the decide endpoint enforces — `cockpitApprovalActable`, which mirrors
// handleUpdateApproval; fr#1538 is open and this does not change who may approve), that asks no
// question, demands no answer text, carries no proposed card action and cites no evidence. Anything
// with evidence, a question, a gate term or a structured decision goes to the approve page, where
// the full decision surface shows what approving does.
import type { CockpitActionItem, CockpitApproval } from '$lib/types/cockpit';
import type { Approval } from '$lib/types/api';
import type { ApproverIdentity } from '$lib/approvals/canAct';
import { answerDemandOf, brokenGateTermsOf, deblockActionOf, isQuestion } from '$lib/approvals/question';
import { coverageArtifactsOf, coverageCriteriaOf } from '$lib/approvals/coverage';
import { cockpitApprovalActable } from './cockpitApproval';

/** Metadata keys that mean "there is evidence to look at before deciding". */
const EVIDENCE_KEYS = ['artifact_ref', 'artifact_id', 'pr_url', 'report_id', 'evidence', 'bug_ids', 'handoff_contract', 'gate_terms'];

export type InlineVerdict =
  | { inline: true }
  | { inline: false; why: 'not_signoff' | 'not_yours' | 'question' | 'answer' | 'action' | 'evidence' | 'gate' | 'unknown' };

export function inlineVerdict(
  item: CockpitActionItem,
  approval: CockpitApproval | undefined,
  user: ApproverIdentity | null | undefined,
): InlineVerdict {
  if (item.type !== 'signoff') return { inline: false, why: 'not_signoff' };
  if (!approval || approval.status !== 'pending') return { inline: false, why: 'unknown' };
  if (!cockpitApprovalActable(approval, user)) return { inline: false, why: 'not_yours' };
  const row = approval as unknown as Pick<Approval, 'metadata'>;
  if (isQuestion(row)) return { inline: false, why: 'question' };
  if (answerDemandOf(row) !== null) return { inline: false, why: 'answer' };
  if (brokenGateTermsOf(row).length > 0) return { inline: false, why: 'gate' };
  if (deblockActionOf(row) !== null) return { inline: false, why: 'action' };
  const md = approval.metadata ?? {};
  if (EVIDENCE_KEYS.some((k) => md[k] !== undefined && md[k] !== null)) return { inline: false, why: 'evidence' };
  if ((coverageCriteriaOf(row) ?? []).length > 0 || coverageArtifactsOf(row).length > 0) return { inline: false, why: 'evidence' };
  return { inline: true };
}

/**
 * R2 — may an open QUESTION be answered inline (a text box on the Overview)? Only a plain
 * question the viewer may decide: no structured answer form, no broken gate term, no proposed card
 * action, no evidence to read first. Everything else goes to the approve page ("Open"). The answer
 * travels through the SAME decide endpoint as the approve page (`recordDecision`, isQuestion).
 */
export function inlineAnswerVerdict(
  item: CockpitActionItem,
  approval: CockpitApproval | undefined,
  user: ApproverIdentity | null | undefined,
): boolean {
  if (item.type !== 'ask') return false;
  if (!approval || approval.status !== 'pending') return false;
  if (!cockpitApprovalActable(approval, user)) return false;
  const row = approval as unknown as Pick<Approval, 'metadata'>;
  if (!isQuestion(row)) return false;
  if (answerDemandOf(row) !== null) return false;
  if (brokenGateTermsOf(row).length > 0) return false;
  const action = deblockActionOf(row);
  if (action !== null && action.toUpperCase() !== 'QUESTION') return false;
  const md = approval.metadata ?? {};
  if (EVIDENCE_KEYS.some((k) => md[k] !== undefined && md[k] !== null)) return false;
  return true;
}

/** Where "Open" goes for an item. */
export function openHref(projectId: string, item: CockpitActionItem): string {
  if (item.approval_id) {
    return `/projects/${encodeURIComponent(projectId)}/approve/${encodeURIComponent(item.approval_id)}`;
  }
  if (item.artifact_id) return `/library/artifacts#artifact-${encodeURIComponent(item.artifact_id)}`;
  return `/projects/${encodeURIComponent(projectId)}/needs-you`;
}

export const ACTION_TYPE_WORD: Readonly<Record<CockpitActionItem['type'], string>> = {
  ask: 'Question',
  signoff: 'Sign-off',
  review: 'Review',
};
