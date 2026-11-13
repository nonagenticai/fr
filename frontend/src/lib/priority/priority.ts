// Priority for a project or a card = one of the TENANT's requirements_management
// priority levels (design "fr consumes RM vocabulary", Q3 = b: fr stores the
// level id). There is NO P0..P3 list here: the levels are loaded from
// GET /api/conveyor/priority-levels (ordered by rank) and every picker builds
// its options from them. `null` means unset. This is deliberately NOT the
// work_intake_record `low|medium|high|urgent` enum in $lib/types/custom-fields.ts.
//
// The backend owns the writes (PATCH /api/projects/:id `{ priority }` and
// PATCH /api/projects/:projectId/cards/:cardId/priority `{ priority }`, which
// accept a level id or name) and audits every effective change.

/** One priority level as GET /api/conveyor/priority-levels answers it. */
export interface PriorityLevel {
  id: string;
  name: string;
  title: string;
  rank: number;
  is_default: boolean;
  conveyor_may_set?: boolean;
  description?: string | null;
}

/** `<select>` value for "unset". A native select cannot carry `null`. */
export const PRIORITY_UNSET = '' as const;
/** A select value: a level id, or unset. */
export type PrioritySelectValue = string;

/** Options for a picker: Unset, then the levels by rank (value = level id). */
export function priorityOptions(levels: readonly PriorityLevel[]): { value: PrioritySelectValue; label: string }[] {
  return [
    { value: PRIORITY_UNSET, label: 'Unset' },
    ...[...levels]
      .sort((a, b) => a.rank - b.rank)
      .map((l) => ({ value: l.id, label: l.description ? `${l.title} – ${l.description}` : l.title })),
  ];
}

/**
 * The stored level: by id first (a project's RM `priority_level_id`, the value
 * of record), else by the name/legacy text (RM `priority_name` / Planka
 * Metadata.priority) matched case-insensitively to a level NAME. Null = unset
 * or a value that is not one of these levels.
 */
export function storedPriorityLevel(
  levels: readonly PriorityLevel[],
  stored: { id?: unknown; text?: unknown },
): PriorityLevel | null {
  if (typeof stored.id === 'string' && stored.id) {
    const hit = levels.find((l) => l.id === stored.id);
    if (hit) return hit;
  }
  if (typeof stored.text === 'string' && stored.text.trim()) {
    const t = stored.text.trim().toLowerCase();
    return levels.find((l) => l.name.toLowerCase() === t) ?? null;
  }
  return null;
}

export function toSelectValue(level: PriorityLevel | null): PrioritySelectValue {
  return level?.id ?? PRIORITY_UNSET;
}

/** The level id to send (null = clear). */
export function fromSelectValue(v: string): string | null {
  return v === PRIORITY_UNSET ? null : v;
}

/** Display text for a stored level (its RM title), or 'unset'. */
export function priorityLabel(level: PriorityLevel | null): string {
  return level?.title ?? 'unset';
}

/** Response of PATCH /api/projects/:projectId/cards/:cardId/priority. */
export interface CardPriorityResponse {
  card_id: string;
  /** The level's legacy text (Metadata.priority). */
  priority: string | null;
  /** The RM priority-level id (the value of record). */
  priority_level_id: string | null;
}

/**
 * Readable text for the backend's priority refusal codes. `ApiError.message`
 * prefers the body's `error` field, which on these routes is a raw code
 * (`invalid_priority`, `card_not_found`, …). Scoped to the two priority
 * surfaces on purpose — ApiError's global message choice is unchanged.
 */
export const PRIORITY_ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_priority: "Priority must be one of this workspace's priority levels.",
  catalogue_not_initialised: "This workspace's priority levels are not set up yet.",
  conveyor_p0_forbidden: 'The conveyor may not set the highest priority.',
  card_not_found: "This card is not on the project's board.",
  project_board_not_provisioned: 'This project has no board yet.',
};

/**
 * Map a failed priority save to text for the user. Looks for a known code in
 * the error body (`data.code`, `data.error`) and then in `message`; otherwise
 * falls back to the message (or a generic line for a non-Error).
 */
export function priorityErrorMessage(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data;
  const candidates: unknown[] = [];
  if (data && typeof data === 'object') {
    candidates.push((data as Record<string, unknown>).code, (data as Record<string, unknown>).error);
  }
  if (err instanceof Error) candidates.push(err.message);
  for (const c of candidates) {
    if (typeof c === 'string' && Object.hasOwn(PRIORITY_ERROR_TEXT, c)) return PRIORITY_ERROR_TEXT[c]!;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Saving the priority failed.';
}
