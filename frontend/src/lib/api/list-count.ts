// lib/api/list-count.ts
//
// How many rows exist upstream, and how confident the answer is.
//
// ## The defect this replaces
//
// `GET /api/assets/kag/entities` envelopes as `{ items, total }`, and the
// frontend threw `total` away (`manifests/kag.ts` returned `{ items }`), while
// `kagGraphApi.entities` additionally `.slice(0, limit)`-ed the list CLIENT-SIDE
// with no signal at all. A capped list and a complete one painted identical
// pixels.
//
// ## Why a bare `total` is NOT trusted here
//
// ⚠️ Today's backend computes `total: items.length` — the length of the page it
// is already returning (`backend/src/routes/assets/kag.ts`, `handleKagListEntities`).
// That is not a count of anything upstream; consuming it as "N of M" would print
// "showing 300 of 300" over a graph with 40,000 nodes. So a `total` arriving with
// NO statement about its own truthfulness is read as UNKNOWN, not as exact.
//
// A backend that genuinely counts says so, with any ONE of:
//   * `count_kind` / `total_kind`: 'exact' | 'at_least' | 'unknown'
//   * `total_is_exact`: boolean
//   * `truncated` / `has_more`: boolean
// The union is deliberate: the envelope is being reshaped in a parallel lane, and
// a reader that recognises only one spelling would silently degrade to "unknown"
// the day a different one ships. Recognising several costs nothing; guessing an
// exact count costs the reader's trust.
//
// ⛔ The failure direction is fixed: when nothing here can be believed, the answer
// is `unknown` — which callers render as "—" or say nothing at all. It is never
// `0`, and never a confident total.

export type ListCount =
  /** Upstream counted the whole set. `total` is the real number of rows. */
  | { kind: 'exact'; total: number }
  /** More rows exist than were returned. `total` is a LOWER BOUND. */
  | { kind: 'at_least'; total: number }
  /** Nothing trustworthy was reported. Say "unknown"; never print a number. */
  | { kind: 'unknown' };

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function finite(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

function firstBoolean(env: Record<string, unknown>, keys: string[]): boolean | null {
  for (const k of keys) {
    if (typeof env[k] === 'boolean') return env[k] as boolean;
  }
  return null;
}

/**
 * Read an upstream list envelope's count claim.
 *
 * @param envelope    the parsed response body (any shape; non-objects are `unknown`)
 * @param returnedLen how many rows the caller actually received, used only as the
 *                    lower bound when the envelope states truncation without a number
 */
export function readListCount(envelope: unknown, returnedLen: number): ListCount {
  const env = record(envelope);
  if (!env) return { kind: 'unknown' };

  const total = finite(env.total) ?? finite(env.count) ?? finite(env.total_count);

  // 1. An explicit kind wins outright.
  const kindRaw = env.count_kind ?? env.total_kind;
  if (typeof kindRaw === 'string') {
    const kind = kindRaw.trim().toLowerCase();
    if (kind === 'unknown') return { kind: 'unknown' };
    if (kind === 'exact' || kind === 'at_least' || kind === 'at-least') {
      // A kind without a usable number is still unknown: the label alone
      // cannot be rendered.
      if (total === null) return { kind: 'unknown' };
      return { kind: kind === 'exact' ? 'exact' : 'at_least', total };
    }
    // An unrecognised kind is not a licence to guess.
    return { kind: 'unknown' };
  }

  // 2. An explicit exactness flag.
  if (typeof env.total_is_exact === 'boolean') {
    if (total === null) return { kind: 'unknown' };
    return env.total_is_exact ? { kind: 'exact', total } : { kind: 'at_least', total };
  }

  // 3. A truncation flag. `false` means the page IS the whole set, so the
  //    number of rows in hand is itself an exact count even with no `total`.
  const truncated = firstBoolean(env, ['truncated', 'has_more', 'more_available']);
  if (truncated !== null) {
    const n = total ?? returnedLen;
    return truncated ? { kind: 'at_least', total: n } : { kind: 'exact', total: n };
  }

  // 4. Nothing said anything believable about the whole set.
  return { kind: 'unknown' };
}

/**
 * Fold a client-side cap into a count.
 *
 * Slicing locally can only ever REMOVE certainty: a set the server called exact
 * becomes a lower bound the moment we stop rendering some of it.
 *
 * ⚠️ `receivedLen` is the count BEFORE the slice, not after. When the server
 * said nothing believable, the rows we were actually handed are still a genuine
 * lower bound on what exists — so a cap turns `unknown` into `at_least
 * receivedLen`. That is the one direction in which slicing ADDS information, and
 * dropping it would understate what we measured.
 */
export function withClientCap(count: ListCount, receivedLen: number, capped: boolean): ListCount {
  if (!capped) return count;
  if (count.kind === 'unknown') return { kind: 'at_least', total: receivedLen };
  return { kind: 'at_least', total: Math.max(count.total, receivedLen) };
}

/**
 * The sentence a list header shows: "N of M", "N of at least M", or the honest
 * "N shown · total unknown".
 *
 * ⚠️ `shown` is the POST-filter count and `total` is the PRE-filter one, so the
 * two are only pairable when the caller has not filtered — which is why the
 * caller passes `shown` explicitly rather than this deriving it.
 */
export function describeCount(count: ListCount, shown: number, noun = 'items'): string {
  switch (count.kind) {
    case 'exact':
      return `${shown} of ${count.total} ${noun}`;
    case 'at_least':
      return `${shown} of at least ${count.total} ${noun} — more exist upstream`;
    case 'unknown':
      return `${shown} ${noun} shown · total unknown`;
  }
}
