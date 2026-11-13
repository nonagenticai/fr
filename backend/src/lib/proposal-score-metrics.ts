// src/lib/proposal-score-metrics.ts
//
// ⛔ WHAT THIS COUNTS: every conveyor ask that ASKED for its proposed answer to be judged
// (metadata.proposal_check === 'required'), by what the gate did with it — passed, refused,
// or could not be scored at all.
//
// WHY (2026-11-01, the reason this file exists at all): the gate's output was console-only,
// so a laya outage would disable it silently — every proposal proceeding unscored would look
// exactly like every proposal passing. `outcome="unavailable"` is the series that makes an
// outage visible; `outcome="refused"` next to `outcome="pass"` is the refusal rate.
//
// Same mechanism as `approvals-ws-refusal-metrics.ts`: closed label sets, pre-seeded to zero,
// increment-only, one structured log line per call. Tenant and card ids are LOG-ONLY, never
// labels. Imports nothing, so the route can import it with no database.

export const PROPOSAL_SCORE_OUTCOMES = [
  /** The judge called the proposal actionable at or above the floor; the ask was minted. */
  'pass',
  /** The judge did not; the ask was refused (422 proposal_unclear) and NOTHING was written. */
  'refused',
  /** The judge could not answer (no licence, timeout, non-200, unparseable). The ask was minted unscored. */
  'unavailable',
] as const;
export type ProposalScoreOutcome = (typeof PROPOSAL_SCORE_OUTCOMES)[number];

export const PROPOSAL_SCORE_CHOICES = [
  /** The judge named a side. */
  'actionable',
  'vague',
  /** No answer at all — only ever with `unavailable`. */
  'none',
] as const;
export type ProposalScoreChoice = (typeof PROPOSAL_SCORE_CHOICES)[number];

const counts = new Map<string, number>();
const key = (o: ProposalScoreOutcome, c: ProposalScoreChoice): string => `${o}|${c}`;
for (const o of PROPOSAL_SCORE_OUTCOMES) for (const c of PROPOSAL_SCORE_CHOICES) counts.set(key(o, c), 0);

export interface ProposalScoreReport {
  outcome: ProposalScoreOutcome;
  choice: ProposalScoreChoice;
  /** Log-only. */
  tenantId?: string | null;
  /** Log-only. */
  cardId?: string | null;
  /** Log-only, 3 decimals. */
  confidence?: number | null;
  /** Log-only: why the judge was unavailable. */
  reason?: string | null;
}

export function reportProposalScore(r: ProposalScoreReport): void {
  const k = key(r.outcome, r.choice);
  counts.set(k, (counts.get(k) ?? 0) + 1);
  console.info(
    JSON.stringify({
      telemetry: 'proposal_scored',
      outcome: r.outcome,
      choice: r.choice,
      confidence: typeof r.confidence === 'number' ? Number(r.confidence.toFixed(3)) : null,
      reason: r.reason ?? null,
      tenant_id: r.tenantId ?? null,
      card_id: r.cardId ?? null,
    }),
  );
}

export function renderProposalScoreMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_proposal_score_total Conveyor asks whose proposed answer was judged before a person saw it, by what the gate did.',
    '# TYPE fr_proposal_score_total counter',
  ];
  for (const o of PROPOSAL_SCORE_OUTCOMES) {
    for (const c of PROPOSAL_SCORE_CHOICES) {
      lines.push(`fr_proposal_score_total{outcome="${o}",choice="${c}"} ${counts.get(key(o, c)) ?? 0}`);
    }
  }
  return lines;
}
