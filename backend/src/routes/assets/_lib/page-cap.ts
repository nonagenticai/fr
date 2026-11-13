// src/routes/assets/_lib/page-cap.ts
//
// Asset lists were silently capped. Measured 2026-09-06 in a real browser as
// `fr-test` with super_admin: `/decisions`, `/principles`, `/requirements` and
// `/library/architecture` each rendered EXACTLY 100 rows, with no total, no
// pager and no notice — while the system-workspace tenant holds 9,845
// decisions. fr sent no `limit`, so the upstream service applied its own
// default of 100 and fr presented that page as the whole set.
//
// ⚠️ WHY A BOOLEAN AND NOT A TOTAL. The upstream services DO report a true
// total (`X-Total-Count`), and forwarding it was the obvious fix. It is wrong
// here: `applyEffectiveFilter` (run by `listWithSystemUnion`) DROPS rows from
// the upstream page, so the upstream total is always >= what
// the user can actually see. Rendering "100 of 9,845" next to a list that can
// never reach 9,845 moves the lie rather than removing it. "There is more" is
// the strongest claim that stays true, and it is exact.
//
// ⚠️ AND WHY THE PROBE READS THE RAW UPSTREAM LENGTH. The `listFn` passed to
// `listWithSystemUnion` filters (bindings, visibility) before returning, so its
// length is NOT the page size the upstream served. Comparing the filtered
// length to the limit would under-report truncation exactly when filters are
// active. Record the length upstream returned, before any local filter.

/** Rows requested per upstream page when the caller does not ask for more. */
export const ASSET_LIST_DEFAULT_LIMIT = 200;

/**
 * Ceiling for `?limit=`. This is the upstream services' own maximum
 * (`Query(100, ge=1, le=1000)` in requirements_management), so asking for more
 * would be silently clamped there and the truncation probe would then compare
 * against a limit that was never applied — reporting "complete" for a capped
 * page. Keep these in step.
 */
export const ASSET_LIST_MAX_LIMIT = 1000;

/**
 * Per-frame row cap for this request. Invalid, absent or out-of-range values
 * fall back to the default rather than 400 — a list route that starts refusing
 * requests because a stale bookmark carries `?limit=abc` is a worse outcome
 * than serving the default page.
 *
 * ⚠️ This is only TRUE because the union routes strip `limit` before handing
 * the query to their upstream zod schema, which is
 * `z.coerce.number().int().min(1).max(1000)` and THROWS on junk. With no
 * ZodError handler in server.ts that throw is a 500. One owner for this value.
 */
export function resolveListLimit(sp: URLSearchParams): number {
  const raw = sp.get('limit');
  if (raw === null) return ASSET_LIST_DEFAULT_LIMIT;
  const n = Number(raw);
  // ⚠️ `Number('')` and `Number('  ')` are BOTH 0, and `Number.isFinite(0)` is
  // true — so an empty `?limit=` reads as a finite zero, not as "unset". The
  // `n < 1` clause is what makes that safe, and it is the ONLY thing that does:
  // an earlier version of this function also special-cased the blank string,
  // and a mutation test showed that branch was unkillable because this one
  // already covered it. One guard, and it is load-bearing.
  if (!Number.isFinite(n) || n < 1) return ASSET_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), ASSET_LIST_MAX_LIMIT);
}

/**
 * Records the largest raw upstream page seen while the list ran.
 * `listWithSystemUnion` invokes `listFn` exactly once, under the caller's own
 * tenant frame (fr never reads the system frame on a customer's behalf), so
 * `max` is simply that page's raw length. Routes that call their upstream more
 * than once per request (architecture, pm, artifacts) still get "the fullest
 * page returned" — the only length that can be compared to the cap.
 */
export interface FrameProbe {
  record(upstreamRowCount: number): void;
  readonly max: number;
}

export function frameProbe(): FrameProbe {
  let max = 0;
  return {
    record(n: number) {
      if (n > max) max = n;
    },
    get max() {
      return max;
    },
  };
}

/**
 * Response headers that tell the client the truth about the page it just got.
 *
 * Headers, not body: every one of these routes is pinned to the `data` envelope
 * and ANY shape drift is a break — because a changed envelope silently breaks
 * whatever already reads it. A header carries the signal without touching the
 * shape, so no consumer of `{ data }` is affected.
 *
 * `Access-Control-Expose-Headers` is required or the browser hides both from
 * JS on any cross-origin read — the header would be on the wire and invisible,
 * which is the same silence this change exists to remove.
 */
/**
 * ⚠️ KNOWN LIMITS OF THIS SIGNAL — measured, and deliberately not papered over.
 *
 * 1. (Retired 2026-09-30.) The union no longer makes a second, system-frame
 *    read that could fail and be degraded unmeasured: `listWithSystemUnion`
 *    reads once, under the caller's frame, and a failure of that read
 *    propagates instead of being swallowed.
 * 2. Exactly `limit` rows reads as truncated. A tenant holding precisely 200
 *    decisions is told more exist. The usual cure is to request `limit + 1` and
 *    drop one, which does not survive the routes' local filters plus
 *    `applyEffectiveFilter` —
 *    so the false positive is accepted, and it errs toward "look again" rather
 *    than toward the silence this replaces.
 * 3. `truncated` describes the UPSTREAM page, not the rendered rows. When
 *    `applyEffectiveFilter` drops most of a full frame, the banner is still
 *    correct — more rows do exist upstream — but raising the cap may return
 *    the same visible set. The banner therefore claims only that the page is
 *    capped, never a count.
 */
/**
 * `truncatedOverride`: a route that did NOT read an upstream page — the
 * `?bound_to=` mode, which reads the bound ids from `asset_bindings` and fetches
 * each one (`bound-by-id.ts`) — knows exactly whether more rows exist, and
 * passes that answer here instead of a probe reading. `appliedLimit` is then
 * the cap on bound ids, which is the same `limit` the caller asked for.
 */
export function pageCapHeaders(
  appliedLimit: number,
  probe: FrameProbe,
  truncatedOverride?: boolean,
): Record<string, string> {
  const truncated = truncatedOverride ?? probe.max >= appliedLimit;
  return {
    'X-Applied-Limit': String(appliedLimit),
    'X-Truncated': truncated ? 'true' : 'false',
    'Access-Control-Expose-Headers': 'X-Applied-Limit, X-Truncated',
  };
}
