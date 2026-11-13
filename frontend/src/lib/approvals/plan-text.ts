// The text a decider is asked to sign off, as the approval row carries it.
//
// ⭐ WHERE THE PLAN TEXT LIVES. The conveyor's sign-off ask (`sub.ask_fr`,
// `metadata.ask_kind = 'signoff'`, e.g. "Sign-off: rewrite plan — …") writes the
// WHOLE plan — goals, ordered steps, capability decisions, risks — into
// `approvals.change_summary` as multi-line plain text (measured on prod
// 2026-10-27, project bcbee1b0…: 1.4–2.3 kB, `\n`-separated, `- ` bullets). The
// backend serves the column unchanged (`routes/approvals.ts :: handleGetApproval`
// selects the whole row). The defect was purely in the review pages: they put the
// plan in a `<p>` WITHOUT preserved line breaks, so the browser collapsed it into
// one run-on paragraph, under a "What changed" heading, BELOW the Approve bar —
// the approver met the buttons before the thing they were approving.
//
// No markdown renderer exists in fr (only DOMPurify for HTML artifacts), and the
// producer writes plain text, so the plan renders as ESCAPED text with
// `white-space: pre-wrap` — never `{@html}`.

import type { Approval } from '$lib/types/api';
import { openQuestionsOf } from './question';

/** True when the row is the conveyor's sign-off ask (the plan IS the subject). */
export function isSignoffAsk(a: Pick<Approval, 'metadata'> | null | undefined): boolean {
  const md = (a?.metadata ?? null) as Record<string, unknown> | null;
  return md !== null && md.ask_kind === 'signoff';
}

/** Dossier heading for `change_summary`: a sign-off shows a plan, not a change. */
export function changeSummaryTitle(a: Pick<Approval, 'metadata'> | null | undefined): string {
  return isSignoffAsk(a) ? 'Plan for your sign-off' : 'What changed';
}

/**
 * The headline gist of a change summary: its first non-blank line.
 *
 * A single-line summary comes back unchanged (byte for byte), so the headline is
 * exactly what it always was for every row that is not a multi-line plan. A
 * multi-line plan contributes only its opening sentence — the full text renders,
 * with its line breaks, in its own section directly above the decision bar.
 */
export function changeSummaryGist(value: string): string {
  if (!value.includes('\n')) return value;
  const first = value.split('\n').find((line) => line.trim().length > 0);
  return first === undefined ? value : first.trim();
}

const HEADLINE_MAX = 160;

/**
 * A short heading for a long ask: the first line ({@link changeSummaryGist}), then its first
 * sentence, capped. The full text is shown ONCE, elsewhere (the "Question for you" box) — the
 * heading only names the item. A text with no sentence end and under the cap comes back whole.
 */
export function headlineGist(value: string): string {
  const line = changeSummaryGist(value).trim();
  const m = /^(.{12,}?[.?!])(?=\s|$)/.exec(line);
  const sentence = m ? m[1]! : line;
  return sentence.length > HEADLINE_MAX ? `${sentence.slice(0, HEADLINE_MAX - 1).trimEnd()}…` : sentence;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * True when `change_summary` only repeats the row's stated question (the conveyor writes the
 * question into both `change_summary` and `metadata.open_questions`, measured on prod 2026-10-28,
 * project bcbee1b0…). The "Question for you" box already shows it, so a surface that would print
 * the summary again skips it. ⛔ Never for a sign-off: there the summary IS the plan being signed.
 * A summary that says MORE than the question is not a repeat and is still shown.
 */
export function summaryRepeatsQuestion(
  a: Pick<Approval, 'change_summary' | 'metadata'> | null | undefined,
): boolean {
  if (!a || isSignoffAsk(a) || typeof a.change_summary !== 'string') return false;
  const cs = norm(a.change_summary);
  if (!cs) return false;
  return openQuestionsOf(a).some((q) => norm(q).includes(cs));
}
