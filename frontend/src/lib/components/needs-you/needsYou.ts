// needsYou.ts — R4 (FR-PROJECT-HOME-REDESIGN §3, §5 R4): the project's ONE place for every open
// ask, sign-off and review, oldest first, with the decided history below.
//
// Every row comes from the cockpit read model (GET /api/projects/:id/cockpit):
//   * the open list IS the C2 `actions` panel (server-ordered oldest first, each item tagged with
//     its card's exact phase) — the same list the rail badge counts (`needs_you`), so the two
//     cannot disagree;
//   * the history IS the C8 `decisions` panel, decided rows only, newest first.
// Nothing here guesses a phase: an item whose card has no phase gets no tag.

import type { CockpitActionItem, CockpitDecision } from '$lib/types/cockpit';

/** The phase tag for an item, or null when it has no exact phase (never a guessed one). */
export function phaseTag(phase: string | null | undefined, labels: ReadonlyMap<string, string>): string | null {
  if (!phase) return null;
  return labels.get(phase) ?? phase;
}

/** Decided rows only, newest decision first (an undated decision sorts last). */
export function historyRows(decisions: readonly CockpitDecision[]): CockpitDecision[] {
  const ms = (iso: string | null): number => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return decisions.filter((d) => !d.open).sort((a, b) => ms(b.decided_at) - ms(a.decided_at));
}

/** Where an artifact review is read and decided: the in-app document reader (R3). */
export function readerHref(projectId: string, artifactId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(artifactId)}`;
}

/** The open items in the server's order (oldest first), minus the ones decided here and not yet re-read. */
export function openItems(items: readonly CockpitActionItem[], decidedHere: ReadonlySet<string>): CockpitActionItem[] {
  return items.filter((i) => !decidedHere.has(i.key));
}

/** The answer of a decided row in one line, or the decision word when no answer text was written. */
export function outcomeWords(d: Pick<CockpitDecision, 'answer' | 'decision'>): string {
  if (d.answer && d.answer.trim()) return d.answer;
  if (d.decision === 'approved') return 'Approved';
  if (d.decision === 'rejected') return 'Rejected';
  return d.decision ?? 'Decided';
}
