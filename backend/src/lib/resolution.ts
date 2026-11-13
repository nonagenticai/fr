// src/lib/resolution.ts
//
// ONE shape for "this value might not be knowable", so that an ABSENCE can
// never render as a RESULT.
//
// THE DEFECT THIS CLOSES. Measured on `origin/main` 2026-09-26:
//
//     src/routes/reports.ts:193  .limit(limit)            // <= MAX_REPORTS_LIMIT (200)
//     src/routes/reports.ts:195  { items: reports, total: reports.length }
//
// `total` is the PAGE SIZE. A tenant with 9,845 reports is told `total: 200`,
// and there is no value `total` can take that means "more matched". The number
// is not merely imprecise — it is structurally incapable of carrying the one
// fact the caller needs. The same spelling recurs across the route tree; this
// is a population, not a one-off.
//
// ⭐ THE WIRE SHAPE AND ITS READER WERE DESIGNED TOGETHER, IN THIS CHANGE.
//
// ⚠️ An earlier version of this header said the shape "is not invented here —
// the consumer already exists", citing `frontend/src/lib/api/list-count.ts` as
// a parallel lane's prior work. That was CIRCULAR: `list-count.ts` is ADDED BY
// THIS SAME COMMIT. It could not corroborate a decision it was part of, and a
// justification that cites its own other half is not evidence — it is the same
// defect this module exists to remove, one level up.
//
// What is actually true: the writing half (here) and the reading half
// (`frontend/src/lib/api/list-count.ts`, `readListCount()`) were written as one
// design, so the union of spellings below is a CONTRACT AGREED BETWEEN THEM,
// not an observation about a pre-existing client. It is still worth quoting,
// because it is what the reader will and will not believe — and because
// renaming a key here without changing that file degrades every list to
// "total unknown" silently:
//
//     ⚠️ Today's backend computes `total: items.length` … That is not a count
//     of anything upstream; consuming it as "N of M" would print "showing 300
//     of 300" over a graph with 40,000 nodes. So a `total` arriving with NO
//     statement about its own truthfulness is read as UNKNOWN, not as exact.
//
//     A backend that genuinely counts says so, with any ONE of:
//       * `count_kind` / `total_kind`: 'exact' | 'at_least' | 'unknown'
//       * `total_is_exact`: boolean
//       * `truncated` / `has_more`: boolean
//
// So the relation belongs in the BODY, beside the number, because that is
// where the reader looks. `total_kind` is the spelling chosen from that union.
//
// ⛔ THE ONE INVARIANT: A NUMBER NEVER SHIPS WITHOUT ITS KIND. A bare `total`
// is the entire defect — the lower bound and the true total are the same
// digits, and nothing downstream can tell them apart. `serializeCount` is the
// only constructor, and it emits both or neither.
//
// ⛔ AND: an UNKNOWN must never serialise as a NUMBER — in particular never as
// `0`, which reads as "none matched" rather than "not readable". It is `null`,
// which `frontend/src/lib/api/response-shape.ts optional()` folds to
// "absent" (measured: `v === undefined || v === null ? undefined : …`), so
// every existing `{items,total}` consumer keeps working unchanged.
//
// ⚠️ HEADERS TOO, BUT AS A SECOND COPY, NOT THE ONLY ONE. `src/routes/assets/
// _lib/page-cap.ts` signals truncation in headers, deliberately, because those
// routes keep a `data` envelope and a body key would be shape drift. Both
// carry the same facts; a route that
// cannot afford a body change still has somewhere honest to put them.
//
// ⚠️ ADDING `total_kind` IS SHAPE DRIFT on an existing route (`items+total` ->
// `items+total+total_kind`): check every consumer of the body first.

// ───────────────────────────────────────────────────────────────────────────
// Counts
// ───────────────────────────────────────────────────────────────────────────

/**
 * How well a row count is known. THREE states, deliberately not two:
 *
 *   exact    — this IS the number of matching rows.
 *   at_least — a cap was applied; at least `count` matched, possibly many more.
 *   unknown  — the count could not be read at all (upstream reports no total,
 *              the count query failed, the source is a merged/filtered set
 *              whose true size nothing can state).
 *
 * `at_least` and `unknown` are NOT the same answer and must not collapse:
 * "there are at least 200, look again" is actionable; "we cannot tell you"
 * is not, and a caller that treats them alike will paginate into a void.
 */
export type CountResolution =
  | { readonly kind: 'exact'; readonly count: number }
  | { readonly kind: 'at_least'; readonly count: number }
  | { readonly kind: 'unknown'; readonly reason: string };

export function exactCount(count: number): CountResolution {
  if (!Number.isFinite(count) || count < 0) {
    return { kind: 'unknown', reason: `non-countable value: ${String(count)}` };
  }
  return { kind: 'exact', count: Math.floor(count) };
}

export function atLeastCount(count: number): CountResolution {
  if (!Number.isFinite(count) || count < 0) {
    return { kind: 'unknown', reason: `non-countable lower bound: ${String(count)}` };
  }
  return { kind: 'at_least', count: Math.floor(count) };
}

export function unknownCount(reason: string): CountResolution {
  return { kind: 'unknown', reason };
}

export interface ResolveCountInput {
  /** The rows actually being returned to the caller, AFTER any local filter. */
  readonly rows: readonly unknown[];
  /**
   * The row cap that was applied to the QUERY, or `null` when the query was
   * genuinely unbounded.
   *
   * ⚠️ This must be the limit the DATA SOURCE actually honoured, not the one
   * we asked for. Asking an upstream for 1000 when its own maximum is 500 and
   * then comparing a 500-row page against 1000 answers "not truncated" for
   * every full page — a false claim of completeness, strictly worse than the
   * silence it replaces. `src/integrations/workers.ts` documents the same trap.
   */
  readonly appliedLimit: number | null;
  /** Rows skipped before this page. The exact count is `offset + rows.length`. */
  readonly offset?: number;
  /**
   * A separately measured TRUE count (a `COUNT(*)` over the same predicate).
   * When present it wins outright — it is the only input that can make a
   * capped page report an exact total.
   */
  readonly totalMatching?: number | null;
  /**
   * The number of rows the SOURCE returned, before any local filtering.
   *
   * ⚠️ Supply this whenever the rows were filtered after fetching. The probe
   * compares a page length against the cap; a locally-filtered length is NOT
   * the page the source served, so comparing it under-reports truncation
   * exactly when filters are active — `page-cap.ts` documents this same trap.
   * Defaults to `rows.length` when the two are the same.
   */
  readonly sourceRowCount?: number;
  /**
   * When set, the answer is `unknown` OUTRIGHT, whatever the probe would have
   * said. This is the escape hatch for a set the route KNOWS it cannot
   * describe — most often a MERGED read in which one source failed and was
   * degraded to `[]`.
   *
   * ⭐ That case is exactly why this exists. `page-cap.ts` records the same
   * trap: a frame that THREW is not measured, so a short page reads as
   * complete while every row from the dead source is missing. A route that can
   * see the failure must be able to say so, and `unknown` is the only answer
   * that is true — `at_least rows.length` would still be a true lower bound,
   * but it implies the only thing missing is what the CAP removed, which is
   * not what happened.
   */
  readonly unknownReason?: string | null;
  /**
   * The set is INCOMPLETE and the rows in hand are a genuine LOWER BOUND on it.
   * Forces `at_least`, whatever the cap probe would have said.
   *
   * ⭐ WHEN TO REACH FOR THIS RATHER THAN `unknownReason`. The distinction is
   * not the cause, it is whether a TRUE lower bound survives the cut:
   *
   *   * A FAN-OUT over independently-countable sources, some of which were not
   *     read (a board cap, an upstream page that came back full, a per-list
   *     read that failed and was skipped) still yields rows that ALL matched
   *     the predicate. `rows.length` is therefore a true floor, and reporting
   *     `unknown` DISCARDS a fact we measured. `frontend/src/lib/api/
   *     list-count.ts withClientCap` states the same rule from the reading
   *     side: "the rows we were actually handed are still a genuine lower
   *     bound on what exists … dropping it would understate what we measured".
   *     `integrations/kanban.ts` says it a third time for this exact data —
   *     a cut card list should render as "1,000+", not as a shrug.
   *
   *   * `unknownReason` is for a set whose SHAPE we cannot describe at all —
   *     most often a merged read whose union is separately capped, where the
   *     surviving length is not a floor on anything the caller can paginate.
   *
   * ⛔ A lower bound of ZERO is not a lower bound; it is the trivially-true
   * statement, and it would serialise as the bare `0` this module forbids —
   * indistinguishable from "none matched". That case degrades to `unknown`,
   * which is the only honest answer left once the floor carries no
   * information.
   *
   * ⚠️ `unknownReason` still wins if both are set: a route that cannot describe
   * its set at all must not be talked up into a claim by a second flag.
   */
  readonly lowerBoundReason?: string | null;
}

/**
 * The single place the three states are decided. Every route gets the same
 * answer for the same situation, which is the point — thirteen hand-written
 * `total: rows.length` expressions were thirteen chances to get it wrong.
 */
export function resolveCount(input: ResolveCountInput): CountResolution {
  const offset = input.offset ?? 0;
  const seen = input.sourceRowCount ?? input.rows.length;

  // Checked FIRST, and before `totalMatching`: a route that knows its set is
  // incomplete must not be overridden by a count taken over only the part that
  // worked.
  if (input.unknownReason) return unknownCount(input.unknownReason);

  // Same precedence, and for the same reason: a route that has SEEN its set be
  // cut must not be overridden by a `COUNT(*)` taken over only the part that
  // worked, nor by the unbounded-query shortcut below (`appliedLimit: null`
  // means "no LIMIT clause", which is not the same claim as "nothing was
  // missed").
  if (input.lowerBoundReason) {
    const bound = offset + input.rows.length;
    // ⛔ A floor of 0 states nothing and would ship as a bare `0`. See the
    // field's JSDoc — this is the one place the two states meet.
    return bound > 0 ? atLeastCount(bound) : unknownCount(input.lowerBoundReason);
  }

  if (input.totalMatching !== undefined && input.totalMatching !== null) {
    return exactCount(input.totalMatching);
  }
  // Unbounded query: what came back IS the match set.
  if (input.appliedLimit === null) return exactCount(offset + input.rows.length);
  if (!Number.isFinite(input.appliedLimit) || input.appliedLimit <= 0) {
    return unknownCount('applied limit is not a positive finite number');
  }
  // A FULL page means the cap bound the result: more may exist behind it.
  //
  // ⚠️ KNOWN FALSE POSITIVE, accepted deliberately: a set holding EXACTLY
  // `limit` rows reads as truncated. The usual cure is to fetch `limit + 1`
  // and drop one, which does not survive a merged/filtered set — so this errs
  // toward "look again" rather than toward the silence it replaces. Routes
  // that can afford a `COUNT(*)` should pass `totalMatching` and skip the
  // probe entirely.
  if (seen >= input.appliedLimit) return atLeastCount(offset + input.rows.length);
  // Short page: the cap did not bind, so the source was exhausted.
  return exactCount(offset + input.rows.length);
}

/**
 * The BODY value for a `total` field: the count for `exact`, the LOWER BOUND
 * for `at_least`, and `null` for `unknown`.
 *
 * ⛔ THIS IS ONLY HONEST WHEN `totalKindField` SHIPS BESIDE IT. On its own,
 * `at_least` and `exact` are the same digits and the reader cannot tell them
 * apart — that is the whole defect. `serializeCount` is the only sanctioned
 * constructor precisely because it cannot emit one without the other. Do not
 * call this function directly from a route.
 *
 * ⛔ `unknown` is `null`, never `0`: a zero reads as "none matched" rather than
 * "not readable", and those are different facts.
 */
export function totalField(r: CountResolution): number | null {
  return r.kind === 'unknown' ? null : r.count;
}

/**
 * The BODY value for `total_kind` — the statement about `total`'s own
 * truthfulness that makes the number readable.
 *
 * The spelling is chosen from the union `frontend/src/lib/api/list-count.ts`
 * already recognises (`count_kind` / `total_kind`, values `exact` |
 * `at_least` | `unknown`). Do not rename it without changing that reader:
 * an unrecognised kind is not a licence to guess there, so a typo degrades
 * every list to "total unknown" silently.
 */
export function totalKindField(r: CountResolution): 'exact' | 'at_least' | 'unknown' {
  return r.kind;
}

/** Header name for the relation, exposed to cross-origin readers. */
export const TOTAL_RELATION_HEADER = 'X-Total-Relation';
export const TOTAL_LOWER_BOUND_HEADER = 'X-Total-Lower-Bound';
export const APPLIED_LIMIT_HEADER = 'X-Applied-Limit';
export const TRUNCATED_HEADER = 'X-Truncated';

/**
 * Headers that carry what the body cannot.
 *
 * `Access-Control-Expose-Headers` is required or a browser hides these from JS
 * on any cross-origin read — the signal would be on the wire and invisible,
 * which is the same silence this module exists to remove.
 */
export function countHeaders(
  r: CountResolution,
  appliedLimit: number | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    [TOTAL_RELATION_HEADER]: r.kind === 'at_least' ? 'at-least' : r.kind,
    [TRUNCATED_HEADER]: r.kind === 'at_least' ? 'true' : 'false',
  };
  if (r.kind === 'at_least') headers[TOTAL_LOWER_BOUND_HEADER] = String(r.count);
  if (appliedLimit !== null && Number.isFinite(appliedLimit)) {
    headers[APPLIED_LIMIT_HEADER] = String(appliedLimit);
  }
  headers['Access-Control-Expose-Headers'] = Object.keys(headers).join(', ');
  return headers;
}

/**
 * ⭐ THE ONE CALL A ROUTE MAKES.
 *
 *     const { total, total_kind, headers } = serializeCount({ rows, appliedLimit, totalMatching });
 *     return jsonResponse({ items: rows, total, total_kind }, 200, headers);
 *
 * It returns the number and its kind TOGETHER because that pairing is the
 * entire fix. There is deliberately no way to obtain one without the other:
 * a bare `total` is indistinguishable from the defect, whatever its value.
 *
 * `headers` carries the same three facts a second time, for readers that do
 * not parse the body and for routes pinned to an envelope they cannot extend.
 */
export function serializeCount(input: ResolveCountInput): {
  total: number | null;
  total_kind: 'exact' | 'at_least' | 'unknown';
  headers: Record<string, string>;
  resolution: CountResolution;
} {
  const resolution = resolveCount(input);
  return {
    total: totalField(resolution),
    total_kind: totalKindField(resolution),
    headers: countHeaders(resolution, input.appliedLimit),
    resolution,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-field resolution
// ───────────────────────────────────────────────────────────────────────────
//
// The same defect on a value that is not a count. Measured in
// `src/routes/tenant/billing.ts`: `projects[].name` is null for every project
// outside the caller's tenant, while `names_unavailable.projects` reads
// `false`. An absence rendering as "everything resolved". `members[].resolved`
// already exists there and is the honest spelling — this generalises it.
//
// ⛔ NOTHING IN PRODUCTION CALLS ANY OF IT YET. MEASURED 2026-09-26, over the
// whole of `backend/src`: `serializeCount` is the ONLY export of this module
// that any non-test file imports (6 routes — dashboard, reports,
// scheduled-reports, scheduled-triggers, kaizen-log, engagements/deliveries).
// `FieldResolution`, `resolved`, `unresolved`, `isResolved`, `fieldValue`,
// `allRowsResolved`, `anyRowUnresolved`, `resolvedRowCount`, `resolvePct` and
// `pctField` are reached by `tests/unit/lib/resolution.test.ts` and by nothing
// else.
//
// ⚠️ SAY IT PLAINLY, because the alternative is the defect one level up: an
// earlier version of a since-removed capped-count guard offered
// `allRowsResolved` as the reason a whole class of defect needed no scanner —
// "the enforcement is STRUCTURAL". A helper nobody calls enforces NOTHING. The
// billing defect is unexpressible *through this helper*; it remains perfectly
// expressible in `billing.ts`, which does not import it.
//
// THE IDENTIFIED CONSUMER IS `src/routes/tenant/billing.ts`, and it has NOT
// adopted this. That file is owned by a parallel lane, which is why this half
// ships ahead of its caller rather than wired in from here — writing the
// adoption from this lane would collide with work in flight. Until that lane
// lands, treat everything below as PROVIDED, not ENFORCED: the only instrument
// that can catch the flag-disagrees-with-its-rows defect is a route test in
// `billing.ts` that seeds a row it cannot resolve.
//
// UPDATE 2026-09-27: `billing.ts` now imports `anyRowUnresolved` for both
// `names_unavailable` axes, and `tests/unit/routes/tenant-billing.test.ts`
// seeds unresolvable rows (red on the pre-fix route). It is still the ONLY
// production consumer of this section.

/**
 * A field that either carries a value or explains why it does not.
 *
 * ⚠️ `unresolved` is NOT `value: null`. A row whose name is genuinely the
 * empty string, and a row whose name could not be looked up, must not
 * serialise identically — that indistinguishable pair is the defect.
 */
export type FieldResolution<T> =
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'unresolved'; readonly reason: string };

export function resolved<T>(value: T): FieldResolution<T> {
  return { kind: 'resolved', value };
}

export function unresolved<T>(reason: string): FieldResolution<T> {
  return { kind: 'unresolved', reason };
}

export function isResolved<T>(r: FieldResolution<T>): boolean {
  return r.kind === 'resolved';
}

/** BODY value for a resolved field. `null` for unresolved — never a placeholder. */
export function fieldValue<T>(r: FieldResolution<T>): T | null {
  return r.kind === 'resolved' ? r.value : null;
}

/**
 * ⭐ THE COMPLETENESS FLAG, DERIVED FROM THE ROWS — never accepted as an input.
 *
 * This signature is the whole point. The billing defect exists precisely
 * because `names_unavailable.projects` and the `projects[]` rows came from
 * different places and could therefore disagree. There is no overload of this
 * function that takes a boolean, and there must not be one: the only way to
 * obtain the flag is to hand over the rows it describes.
 *
 * Returns `true` when EVERY row resolved. An empty set is vacuously complete —
 * which is correct here and worth stating, since "no rows" is not "rows we
 * could not read"; that case is `unknown`, not `false`.
 */
export function allRowsResolved<R>(
  rows: readonly R[],
  rowIsResolved: (row: R) => boolean,
): boolean {
  return rows.every((row) => rowIsResolved(row));
}

/** The negation, spelled out so an `*_unavailable` flag need not invert by hand. */
export function anyRowUnresolved<R>(
  rows: readonly R[],
  rowIsResolved: (row: R) => boolean,
): boolean {
  return !allRowsResolved(rows, rowIsResolved);
}

/** How many rows resolved — the honest denominator for an "N of M" notice. */
export function resolvedRowCount<R>(
  rows: readonly R[],
  rowIsResolved: (row: R) => boolean,
): { resolved: number; total: number } {
  let n = 0;
  for (const row of rows) if (rowIsResolved(row)) n += 1;
  return { resolved: n, total: rows.length };
}

// ───────────────────────────────────────────────────────────────────────────
// Percentages
// ───────────────────────────────────────────────────────────────────────────

/**
 * A percentage over an axis that may have no denominator at all.
 *
 * ⛔ `0 / 0` is the case that matters. "This axis has no spend, so no share can
 * be computed" and "this axis has spend and its share is zero percent" are
 * DIFFERENT facts, and `0` cannot carry both. `unknown` is the only honest
 * answer for the first, and `pctField` is written so it can never become a
 * number.
 */
export type PctResolution =
  | { readonly kind: 'exact'; readonly pct: number }
  | { readonly kind: 'unknown'; readonly reason: string };

export function resolvePct(numerator: number, denominator: number): PctResolution {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return { kind: 'unknown', reason: 'numerator or denominator is not finite' };
  }
  if (denominator === 0) {
    return { kind: 'unknown', reason: 'no denominator — this axis has no rows to take a share of' };
  }
  return { kind: 'exact', pct: (numerator / denominator) * 100 };
}

/** BODY value. `null` when unknown — never `0`. */
export function pctField(r: PctResolution): number | null {
  return r.kind === 'exact' ? r.pct : null;
}
