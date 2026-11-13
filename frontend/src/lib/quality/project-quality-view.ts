// Pure view-model helpers for /projects/[id]/quality (fr#1305).
//
// ⛔ The rules these encode are the whole point of the page:
//   - a score + letter grade ONLY for `complete`;
//   - `partial` shows "graded on N of M tools" and NEVER a letter;
//   - `inconclusive`, `failed`, `not_analyzed` never show a number (never 0%);
//   - CI is for the SAME commit as the result; a null sha is "commit unknown",
//     zero runs is "no CI run for this commit" — neither is ever green.

import type {
  ProjectCiState,
  ProjectQualityHistoryRow,
  ProjectQualityLatest,
} from '$lib/types/api';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface StatusView {
  pill: string;
  tone: Tone;
  /** The headline shown where a score would go. */
  headline: string;
  /** Only for complete. */
  score: number | null;
  grade: string | null;
}

function toolFraction(l: ProjectQualityLatest): string {
  const m = l.tools_attempted.length;
  const n = l.tools_succeeded.length;
  return `${n} of ${m} tools`;
}

export function statusView(latest: ProjectQualityLatest | null): StatusView {
  if (!latest) {
    return {
      pill: 'unavailable',
      tone: 'warning',
      headline: 'quality result unavailable — the stored result could not be read',
      score: null,
      grade: null,
    };
  }
  switch (latest.status) {
    case 'complete': {
      const score = typeof latest.overall_score === 'number' ? latest.overall_score : null;
      return {
        pill: 'complete',
        tone: 'success',
        headline: score === null ? 'complete (no score stored)' : `${Math.round(score)} / 100`,
        score,
        grade: score === null ? null : latest.grade,
      };
    }
    case 'partial':
      return {
        pill: 'partial',
        tone: 'warning',
        headline: `partial — graded on ${toolFraction(latest)}`,
        score: null,
        grade: null,
      };
    case 'inconclusive':
      return {
        pill: 'inconclusive',
        tone: 'warning',
        headline: 'N/A — inconclusive, not a pass',
        score: null,
        grade: null,
      };
    case 'failed':
      return { pill: 'failed', tone: 'danger', headline: 'analysis failed', score: null, grade: null };
    case 'not_analyzed':
    default:
      return { pill: 'not analysed', tone: 'neutral', headline: 'not analysed yet', score: null, grade: null };
  }
}

export interface CiView {
  label: string;
  tone: Tone;
}

export function ciView(state: ProjectCiState, sha: string | null, reason?: string): CiView {
  if (!sha) return { label: 'commit unknown', tone: 'neutral' };
  switch (state) {
    case 'success':
      return { label: 'CI passed', tone: 'success' };
    case 'failure':
      return { label: 'CI failed', tone: 'danger' };
    case 'pending':
      return { label: 'CI running', tone: 'accent' };
    case 'none':
      return { label: 'no CI run for this commit', tone: 'neutral' };
    case 'unknown':
    default:
      return { label: reason ? `CI unknown (${reason})` : 'CI unknown', tone: 'neutral' };
  }
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '';
}

/** Trend points: `complete` rows with a score only, oldest → newest. */
export function completeTrend(rows: ProjectQualityHistoryRow[]): ProjectQualityHistoryRow[] {
  return rows
    .filter((r) => r.status === 'complete' && typeof r.overall_score === 'number')
    .slice()
    .reverse();
}

/** SVG polyline points for a 0..100 score series in a w×h box. */
export function sparklinePoints(scores: number[], w = 120, h = 28): string {
  if (scores.length === 0) return '';
  if (scores.length === 1) return `0,${h - (scores[0]! / 100) * h} ${w},${h - (scores[0]! / 100) * h}`;
  const step = w / (scores.length - 1);
  return scores
    .map((s, i) => `${Math.round(i * step * 10) / 10},${Math.round((h - (Math.max(0, Math.min(100, s)) / 100) * h) * 10) / 10}`)
    .join(' ');
}
