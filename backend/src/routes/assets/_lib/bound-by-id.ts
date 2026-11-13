// src/routes/assets/_lib/bound-by-id.ts
//
// `?bound_to=<projectId>` list mode, driven FROM the bindings table.
//
// ⛔ THE DEFECT THIS REPLACES. The list routes used to fetch ONE upstream page
// (limit 200, page-cap.ts) and only then narrow it to the rows bound in fr's
// `asset_bindings` (binding-filter.ts). Two consequences:
//   1. A bound asset that sits beyond upstream row 200 was NEVER shown — the
//      project's own bound list silently omitted it.
//   2. `X-Truncated` described the upstream page, not the bound set. Measured
//      live: `X-Truncated: true` with 0 items.
//
// Here the bindings table is the source of the id set, and each bound id is
// fetched individually with the SAME getter (and the same system-union wrapper)
// the single-item route uses, so tenant / system-row semantics are identical to
// opening that item directly. `truncated` now describes the bound set itself.
//
// `visible_in` is NOT served from here: it is "bound to P UNION unbound
// everywhere", and the unbound half has no id list to start from.

import { and, asc, eq } from 'drizzle-orm';

import { db, assetBindings, assetType } from '../../../db/client';
import {
  IntegrationError,
  isIntegrationError,
} from '../../../integrations/_lib/errors';
import { BadRequestError } from '../../../utils/errors';
import { isUuidShape } from '../../../lib/uuid-shape';

type AssetKind = (typeof assetType.enumValues)[number];

/** Upper bound on concurrent single-item upstream reads per request. */
const BOUND_FETCH_CONCURRENCY = 8;

interface BoundByIdResult<T> {
  items: T[];
  /** True when more ids are bound to the project than `limit`. */
  truncated: boolean;
  /** Bound ids the upstream answered 404 for (deleted, or not visible to this tenant). */
  skippedMissing: number;
}

/**
 * Returns up to `take` bound asset ids for (kind, projectId), in a stable order.
 */
type BoundIdsLoader = (
  kind: AssetKind,
  projectId: string,
  take: number,
) => Promise<string[]>;

const loadBoundIds: BoundIdsLoader = async (kind, projectId, take) => {
  const rows = await db
    .select({ asset_id: assetBindings.asset_id })
    .from(assetBindings)
    .where(
      and(
        eq(assetBindings.asset_kind, kind),
        eq(assetBindings.project_id, projectId),
      ),
    )
    .orderBy(asc(assetBindings.asset_id))
    .limit(take);
  return rows.map((r) => r.asset_id);
};

/** An upstream 404 for one id: the binding outlived the row, or the row is not visible here. */
function isUpstreamNotFound(err: unknown): boolean {
  if (!isIntegrationError(err)) return false;
  return err.code === 'UPSTREAM_NOT_FOUND' || err.upstreamStatus === 404;
}

/**
 * Bounded-concurrency map. Order of results follows `inputs`. The first
 * rejection rejects the whole call and stops workers from starting new items.
 */
async function mapWithConcurrency<I, O>(
  inputs: readonly I[],
  concurrency: number,
  fn: (input: I) => Promise<O>,
): Promise<O[]> {
  const out = new Array<O>(inputs.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed) {
      const i = next++;
      if (i >= inputs.length) return;
      try {
        out[i] = await fn(inputs[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, inputs.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

const MISSING = Symbol('missing');

/**
 * The bound set for (kind, projectId), fetched id by id.
 *
 *   * ids come from `asset_bindings`, ordered by asset_id; the first `limit`
 *     are fetched and `truncated` is true iff more are bound;
 *   * each id is read with `getById`, at most BOUND_FETCH_CONCURRENCY at once;
 *   * an upstream 404 for an id is SKIPPED and counted in `skippedMissing`;
 *   * ANY other error propagates — the route answers with its usual upstream
 *     error status, never an empty 200 that reads as "nothing bound";
 *   * `predicate` (optional) applies the route's other list filters to the
 *     fetched rows, since no upstream list query narrowed them.
 */
export async function listBoundById<T>(
  kind: AssetKind,
  projectId: string,
  limit: number,
  getById: (id: string) => Promise<T>,
  predicate?: (row: T) => boolean,
): Promise<BoundByIdResult<T>> {
  // One row past the cap answers "is there more" without counting the table.
  const raw = await loadBoundIds(kind, projectId, limit + 1);
  const ids = [...new Set(raw)];
  const truncated = ids.length > limit;
  const page = ids.slice(0, limit);

  const fetched = await mapWithConcurrency(page, BOUND_FETCH_CONCURRENCY, async (id) => {
    try {
      return await getById(id);
    } catch (err) {
      if (isUpstreamNotFound(err)) return MISSING;
      throw err;
    }
  });

  let skippedMissing = 0;
  const items: T[] = [];
  for (const row of fetched) {
    if (row === MISSING) {
      skippedMissing += 1;
      continue;
    }
    if (predicate && !predicate(row as T)) continue;
    items.push(row as T);
  }
  return { items, truncated, skippedMissing };
}

/**
 * `asset_bindings.project_id` is a uuid column: a non-uuid `bound_to` (e.g. a
 * `stream:<uuid>` pseudo-project id) would raise Postgres 22P02 and escape as a
 * bare 500, so it is a 400 here.
 */
export function assertBoundToShape(boundTo: string): void {
  if (!isUuidShape(boundTo)) {
    throw new BadRequestError('bound_to must be a project uuid');
  }
}

/**
 * Bound mode serves the first `limit` bound ids; there is no upstream page for
 * an `offset` to address, so it is refused rather than silently ignored (an
 * ignored offset would re-serve page one as if it were page two).
 */
export function assertNoOffsetInBoundMode(offset: number | undefined): void {
  if (offset !== undefined && offset !== 0) {
    throw new BadRequestError('offset is not supported together with bound_to');
  }
}

/**
 * AG-UI twin of {@link assertNoOffsetInBoundMode}: the same refusal as a
 * caller-side `BAD_REQUEST` IntegrationError, the vocabulary the AG-UI
 * actions already use for rejected input (so it is not retried as an
 * upstream failure).
 */
export function rejectOffsetInBoundMode(offset: number | undefined): void {
  if (offset !== undefined && offset !== 0) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'offset is not supported together with bound_to',
    });
  }
}

/**
 * Equality predicate over row fields, for the upstream list filters that are
 * plain column equality (`origin_kind`, `status`, `project_id`). Undefined
 * values are "no filter". Compared as strings, as they arrive on the wire.
 */
export function fieldEquals<T>(
  filters: Record<string, string | null | undefined>,
): ((row: T) => boolean) | undefined {
  // null and undefined both mean "not filtered", as on the upstream wire.
  const active = Object.entries(filters).filter(
    (e): e is [string, string] => e[1] !== undefined && e[1] !== null,
  );
  if (active.length === 0) return undefined;
  return (row: T) => {
    const r = row as Record<string, unknown>;
    return active.every(([k, v]) => r[k] !== undefined && r[k] !== null && String(r[k]) === v);
  };
}
