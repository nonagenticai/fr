// cardTypeColors.ts
//
// Colour for a card's group. The group IS the card type's requirements_management
// CAPABILITY (design "fr consumes RM vocabulary", Q1 = a): capabilities are per
// tenant and live in RM, so there is no list of groups here — a colour is a
// DETERMINISTIC function of the capability NAME over the design-token palette
// (src/lib/styles/tokens.css). The same name always gets the
// same colour, on every board and in every tenant.
//
// Classes are listed verbatim so the Tailwind JIT keeps them in the production
// build — do NOT compose class names dynamically here.

export interface GroupColors {
  /** Tailwind bg utility (a design token) for a small dot or strip. */
  bgClass: string;
  /** Tailwind text utility (a design token) used in the legend. */
  textClass: string;
  /** Human-readable label for the legend. */
  label: string;
}

/** The token palette a capability name hashes into. Order is part of the contract. */
export const GROUP_PALETTE: ReadonlyArray<Pick<GroupColors, 'bgClass' | 'textClass'>> = [
  { bgClass: 'bg-[var(--color-accent)]', textClass: 'text-[var(--color-accent-text)]' },
  { bgClass: 'bg-[var(--color-info)]', textClass: 'text-[var(--color-info-text)]' },
  { bgClass: 'bg-[var(--color-success)]', textClass: 'text-[var(--color-success-text)]' },
  { bgClass: 'bg-[var(--color-warning)]', textClass: 'text-[var(--color-warning-text)]' },
  { bgClass: 'bg-[var(--color-danger)]', textClass: 'text-[var(--color-danger-text)]' },
  { bgClass: 'bg-[var(--color-secondary)]', textClass: 'text-[var(--color-secondary-text)]' },
  { bgClass: 'bg-[var(--color-primary)]', textClass: 'text-[var(--color-text)]' },
  { bgClass: 'bg-[var(--color-accent-strong)]', textClass: 'text-[var(--color-accent-text)]' },
  { bgClass: 'bg-[var(--color-info-strong)]', textClass: 'text-[var(--color-info-text-strong)]' },
  { bgClass: 'bg-[var(--color-secondary-strong)]', textClass: 'text-[var(--color-secondary-text)]' },
  { bgClass: 'bg-[var(--color-link)]', textClass: 'text-[var(--color-link)]' },
];

export const UNKNOWN_GROUP_COLORS: GroupColors = {
  bgClass: 'bg-[var(--color-border-strong)]',
  textClass: 'text-[var(--color-text-muted)]',
  label: 'Unclassified',
};

/** FNV-1a 32-bit — stable across runtimes, no dependency. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `requirements_management` → `Requirements management`. */
export function groupLabel(group: string): string {
  const words = group.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The colours of a capability name; the Unclassified sentinel for none. */
export function getGroupColors(group: string | null | undefined): GroupColors {
  if (!group) return UNKNOWN_GROUP_COLORS;
  const p = GROUP_PALETTE[hash(group) % GROUP_PALETTE.length]!;
  return { ...p, label: groupLabel(group) };
}

/** The distinct groups (capabilities) among `cards`, sorted, with their colours. */
export function legendGroups(
  cards: ReadonlyArray<{ card_group?: string | null }>,
): Array<GroupColors & { key: string }> {
  const keys = [...new Set(cards.map((c) => c.card_group).filter((g): g is string => !!g))].sort();
  return keys.map((key) => ({ key, ...getGroupColors(key) }));
}
