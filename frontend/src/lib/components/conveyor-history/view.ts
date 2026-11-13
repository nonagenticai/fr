// Pure presentation helpers for the project page's conveyor history (unit-tested).
import type { CommentKind, ConversationEntry, DeliveredPr } from '$lib/types/conveyor-history';

const KIND_LABELS: Record<CommentKind, string> = {
  handoff: 'Hand-off',
  signoff: 'Sign-off',
  question: 'Question',
  rework: 'Rework',
  stall: 'Stalled',
  unblock_proposal: 'Unblock proposal',
  record: 'Record',
  comment: 'Comment',
};

export function commentKindLabel(kind: CommentKind): string {
  return KIND_LABELS[kind] ?? 'Comment';
}

export function askKindLabel(kind: ConversationEntry['ask_kind']): string {
  return kind === 'question' ? 'Question' : kind === 'signoff' ? 'Sign-off' : 'Request';
}

/** "Approved", "Rejected", "Waiting for you", or the stored status in words. */
export function decisionLabel(e: Pick<ConversationEntry, 'open' | 'decision' | 'status'>): string {
  if (e.open) return 'Waiting for a decision';
  const d = (e.decision ?? e.status ?? '').toLowerCase();
  if (d === 'approved') return 'Approved';
  if (d === 'rejected') return 'Rejected';
  if (d === 'expired') return 'Expired';
  if (d === 'voided') return 'Withdrawn';
  return d ? d[0]!.toUpperCase() + d.slice(1).replace(/_/g, ' ') : 'Decided';
}

export function prStateLabel(pr: Pick<DeliveredPr, 'state'>): string {
  return pr.state === 'merged' ? 'Merged' : pr.state === 'open' ? 'Open' : pr.state === 'closed' ? 'Closed without merging' : '';
}

/** Local "YYYY-MM-DD HH:mm"; '—' when absent or unparsable. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The decide surface for an open ask — the existing approve page, never a new path. */
export function decideHref(projectId: string, approvalId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/approve/${encodeURIComponent(approvalId)}`;
}
