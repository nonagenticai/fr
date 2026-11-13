// src/lib/utils/groupDuplicates.ts
//
// UI review 2026-10-07: the project's Effective assets list and /decisions both
// rendered the same asset many times over (seeded / re-imported rows that share
// a type + title but carry distinct ids), so a page read as 1000+ items when it
// held a few dozen distinct ones. This collapses rows sharing a key into ONE
// group that keeps every member — nothing is dropped, the count is shown as
// "×N", and callers can still expand to the individual rows (each id stays
// actionable).
//
// Pure. Order is first-seen order of each key; members keep input order.

export interface DuplicateGroup<T> {
  /** The grouping key (as produced by `keyOf`). */
  key: string;
  /** The first member — what a collapsed row displays. */
  first: T;
  /** Every member, in input order. Never empty. */
  items: T[];
  /** `items.length`, for the "×N" badge. */
  count: number;
}

export function groupDuplicates<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): DuplicateGroup<T>[] {
  const byKey = new Map<string, DuplicateGroup<T>>();
  for (const row of rows) {
    const key = keyOf(row);
    const g = byKey.get(key);
    if (g) {
      g.items.push(row);
      g.count += 1;
    } else {
      byKey.set(key, { key, first: row, items: [row], count: 1 });
    }
  }
  return [...byKey.values()];
}

/**
 * Normalised title key: trimmed, whitespace-collapsed, case-folded — so
 * "Use Postgres" and "use  postgres " collapse together. Optionally prefixed
 * with a type so two types never merge.
 */
export function titleKey(title: unknown, type?: string): string {
  const t = String(title ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return type ? `${type}\u0000${t}` : t;
}
