// src/routes/assets/_lib/binding-filter.ts
//
// Apply bound_to / visible_in filters against the asset_bindings table.
//
// Used by every asset list handler whose upstream service returns a
// per-tenant list; fr-backend narrows that list to a project view by
// joining against asset_bindings.
//
// `bound_to=PID`   → only assets explicitly bound to PID.
// `visible_in=PID` → assets bound to PID UNION tenant-wide-unbound
//                    (those with no row in asset_bindings for any project).
//
// Plan: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase C).

import { and, eq, inArray } from 'drizzle-orm';

import { db, assetBindings, assetType } from '../../../db/client';

// Re-exported so the AG-UI list actions' per-catalog `bindingFilter` seam
// (`typeof import('./binding-filter')`) can stub the bound-mode reader too.
// `bound_to` without `visible_in` is served by it; see bound-by-id.ts.
export { listBoundById } from './bound-by-id';

// Mirror the pgEnum's literal-union type so the eq() calls type-check
// against the asset_kind column.
type AssetKind = (typeof assetType.enumValues)[number];

export interface BindingFilters {
  bound_to?: string;
  visible_in?: string;
}

/**
 * Given a list of upstream assets (each carrying an `id` field that
 * coerces cleanly to string — uuid or numeric), return the subset
 * matching the provided binding filter. If neither filter is set,
 * returns the input unchanged.
 *
 * Implementation: one round-trip to asset_bindings keyed on this kind +
 * the candidate id set. We don't push project_id into the upstream call
 * because upstream doesn't know about bindings — they're an fr-local
 * concept.
 *
 * `asset_id` in the bindings table is `text`, so numeric upstream ids
 * are coerced to string before comparison. The caller must persist the
 * binding via the same coercion (the bindings route stores assetId as
 * the param value, which is already a string).
 */
export async function applyBindingFilter<T extends { id: string | number }>(
  kind: AssetKind,
  items: T[],
  filters: BindingFilters,
): Promise<T[]> {
  const { bound_to, visible_in } = filters;
  if (!bound_to && !visible_in) return items;
  if (items.length === 0) return items;

  const ids = items.map((it) => String(it.id));

  if (bound_to) {
    const rows = await db
      .select({ asset_id: assetBindings.asset_id })
      .from(assetBindings)
      .where(
        and(
          eq(assetBindings.asset_kind, kind),
          eq(assetBindings.project_id, bound_to),
          inArray(assetBindings.asset_id, ids),
        ),
      );
    const boundSet = new Set(rows.map((r) => r.asset_id));
    return items.filter((it) => boundSet.has(String(it.id)));
  }

  // visible_in = (bound to PID) UNION (unbound on every project).
  const rows = await db
    .select({
      asset_id: assetBindings.asset_id,
      project_id: assetBindings.project_id,
    })
    .from(assetBindings)
    .where(
      and(
        eq(assetBindings.asset_kind, kind),
        inArray(assetBindings.asset_id, ids),
      ),
    );

  const boundProjects = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = boundProjects.get(r.asset_id);
    if (!set) {
      set = new Set();
      boundProjects.set(r.asset_id, set);
    }
    set.add(r.project_id);
  }
  return items.filter((it) => {
    const set = boundProjects.get(String(it.id));
    if (!set) return true; // unbound everywhere → tenant-wide → visible
    return set.has(visible_in!); // bound to the requested project
  });
}
