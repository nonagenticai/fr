// The `deblock_action` FACET — the buckets the /approvals queue can be filtered
// and counted by.
//
// ⛔ WHY THIS EXISTS. Measured in a live browser 2026-09-15: /approvals rendered
// 200 of 1,294 pending rows and offered ONE facet, by `kind`
// (`All 1294 / Improvement 310 / Execution 138 / Other 846`). Every row badges
// its `deblock_action` instead — 104 of the 200 loaded rows were QUESTION, and
// ~395 QUESTION rows exist estate-wide. So the only lens on the page sliced by a
// dimension a decider does not decide on, and the dimension they DO decide on
// could not be filtered to at all: most of those questions sat inside the 1,094
// rows the page had never loaded.
//
// ⚠️ THIS IS A MIRROR OF THE SERVER, AND THE SERVER IS THE ONE THAT COUNTS.
// `backend/src/routes/approvals.ts :: deblockActionBucket` is a single SQL
// expression used by BOTH the `GROUP BY` that produces `action_totals` and the
// `WHERE` that `?deblock_action=` applies. The functions here exist so the page
// can (a) bucket a LOADED row the same way, as a belt against a bundle whose
// server ignores the parameter, and (b) name the chips. They must never become
// the source of a COUNT — the whole point of the change is that the counts come
// from the population, which the browser cannot see.

/**
 * The closed BLOCKED-exit set, spelled rather than imported: this is the browser
 * bundle and `backend/src/domain/engagement/deblock-actions.ts` is server code.
 * Same mirroring convention, and same hazard, as `FIX_ASSERTION_ACTIONS` in
 * `./question.ts` — a member added server-side must be added here in the same
 * change or its rows land in the `other` bucket, visibly, rather than silently
 * vanishing from the facet row.
 */
export const DEBLOCK_ACTIONS = [
  'QUESTION',
  'RETRY',
  'INFRASTRUCTURE',
  'DEPENDENCY',
  'SPLIT',
  'DROP',
  'MERGE',
  'RECLASSIFY',
  'COVERAGE',
] as const;

/** No usable `metadata.deblock_action`: absent, null, non-string, or blank. */
export const ACTION_BUCKET_NONE = 'none';
/** A non-empty string outside the closed set — an action that can move no card. */
export const ACTION_BUCKET_OTHER = 'other';

export type ActionBucket =
  | (typeof DEBLOCK_ACTIONS)[number]
  | typeof ACTION_BUCKET_NONE
  | typeof ACTION_BUCKET_OTHER;

export type ActionFacet = 'all' | ActionBucket;

/**
 * Every bucket, in the order the chips render.
 *
 * ⭐ ORDERED BY WHAT A DECIDER IS LOOKING FOR, not alphabetically and not by the
 * server's enum order. QUESTION is first because it is both the largest cohort
 * and the only one that cannot be actioned without a human writing something;
 * INFRASTRUCTURE and DEPENDENCY follow because approving one ASSERTS a fix
 * (`FIX_ASSERTION_ACTIONS`), so they are the next most attention-demanding.
 * `none` is last-but-one on purpose: it is a real, large cohort (9 of 29 pending
 * rows on the 2026-08-26 drive) and it is the set nothing downstream can move,
 * so being able to ask for it is how a decider finds the rows to escalate rather
 * than decide.
 */
export const ACTION_BUCKETS: readonly ActionBucket[] = [
  'QUESTION',
  'INFRASTRUCTURE',
  'DEPENDENCY',
  'RETRY',
  'SPLIT',
  'DROP',
  'MERGE',
  // REALIGN R5: a decider-chosen card-type change, re-driven through TODO.
  'RECLASSIFY',
  // BDD ruling 2026-10-01: a per-criterion coverage sign-off.
  'COVERAGE',
  ACTION_BUCKET_NONE,
  ACTION_BUCKET_OTHER,
];

/** Chip label. The enum members keep their own wire spelling — that is what the row badges say. */
export function actionFacetLabel(facet: ActionFacet): string {
  if (facet === 'all') return 'All';
  if (facet === ACTION_BUCKET_NONE) return 'No action';
  if (facet === ACTION_BUCKET_OTHER) return 'Unrecognised';
  return facet;
}

/**
 * The bucket a LOADED row falls into — the client-side mirror of the server's
 * `deblockActionBucket` CASE.
 *
 * ⚠️ Deliberately NOT case-insensitive, unlike `isQuestion` in `./question.ts`.
 * The server's `asDeblockAction` is exact and the facet's whole job is to agree
 * with the server's count; a lower-case `question` is `other` on both sides,
 * which is the honest answer — it is a row whose action the callback will drop.
 *
 * ⛔ A NON-STRING IS `other`, NOT `none`, AND THAT IS MEASURED RATHER THAN
 * REASONED. This function first read `typeof raw !== 'string' → none`, copying
 * `deblockActionOf` in `./question.ts`. Executed against a real Postgres 18, the
 * server's `metadata ->> 'deblock_action'` renders a JSON NUMBER as its text
 * (`123`), which is non-empty and outside the closed set, so the server buckets
 * it `other`. The disagreement was not academic: with `?deblock_action=other`
 * the server would SEND that row and this mirror would hide it, so the chip
 * would read "Unrecognised 3" above two rendered rows — the quiet
 * count-vs-list disagreement the belt exists to prevent, introduced by the belt.
 *
 * `->>` yields SQL NULL for an absent key AND for a JSON null, and both reach
 * `coalesce(…, '')` → `none`; those are the only two cases that are `none` other
 * than a blank or whitespace-only string.
 *
 * ⚠️ `JSON.stringify` is not byte-identical to `->>` for an object or array
 * (pg emits `{"a": 1}`, JS emits `{"a":1}`). That is tolerated deliberately:
 * neither spelling is in the closed set, so both land in `other` and the BUCKET
 * — the only thing this function returns — still agrees.
 *
 * Reads `metadata` defensively for the same reason `deblockActionOf` does: it is
 * untyped jsonb written by n8n.
 */
export function actionBucketOf(a: { metadata?: unknown }): ActionBucket {
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata.deblock_action;
  if (raw === undefined || raw === null) return ACTION_BUCKET_NONE;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return ACTION_BUCKET_NONE;
  return (DEBLOCK_ACTIONS as readonly string[]).includes(trimmed)
    ? (trimmed as ActionBucket)
    : ACTION_BUCKET_OTHER;
}
