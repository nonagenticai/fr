// Page states for the catalogue sections. Pure.
//
// Four states a list read can land in, never collapsed into one another: an
// unreachable catalogue (RM down, MISSING_TENANT) is NOT an empty catalogue, and
// a resource RM has not shipped yet (its 404 passed through) is neither.

import type { Capability } from '$lib/rbac/assetScopeCapability';
import type { CatalogueFailure, CatalogueResult } from '$lib/api/conveyor-catalogue';

/** Admins edit; everyone else reads. `unknown` (roles still loading) reads until it settles. */
export type CatalogueMode = 'edit' | 'read' | 'checking';

export function catalogueMode(admin: Capability): CatalogueMode {
  if (admin === 'permitted') return 'edit';
  if (admin === 'denied') return 'read';
  return 'checking';
}

export type ListView<T> =
  | { kind: 'loading' }
  | { kind: 'unavailable'; failure: CatalogueFailure }
  | { kind: 'not-shipped'; failure: CatalogueFailure }
  | { kind: 'error'; failure: CatalogueFailure }
  | { kind: 'empty' }
  | { kind: 'ready'; rows: T[] };

export function listView<T>(r: CatalogueResult<T[]>): ListView<T> {
  if (!r.ok) {
    if (r.unavailable) return { kind: 'unavailable', failure: r };
    if (r.status === 404) return { kind: 'not-shipped', failure: r };
    return { kind: 'error', failure: r };
  }
  return r.data.length === 0 ? { kind: 'empty' } : { kind: 'ready', rows: r.data };
}

/** Rows of a secondary list (a picker's options); a failed read is reported, not treated as empty. */
export function rowsOr<T>(r: CatalogueResult<T[]> | null): { rows: T[]; failure: CatalogueFailure | null } {
  if (!r) return { rows: [], failure: null };
  return r.ok ? { rows: r.data, failure: null } : { rows: [], failure: r };
}

/** Pretty JSON of an error body for verbatim display; a string body stays as-is. */
export function bodyText(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

/** Import counts as display rows: `{collection, created, existing, filled}` per counted collection. */
export interface ImportRow {
  collection: string;
  created: number;
  existing: number;
  filled: number | null;
}

export function importRows(result: Record<string, unknown>): { rows: ImportRow[]; skipped: [string, string[]][] } {
  const rows: ImportRow[] = [];
  const skipped: [string, string[]][] = [];
  for (const [key, v] of Object.entries(result)) {
    if (Array.isArray(v)) {
      if (v.length > 0) skipped.push([key, v.map(String)]);
      continue;
    }
    if (v && typeof v === 'object' && 'created' in v && 'existing' in v) {
      const c = v as { created: unknown; existing: unknown; filled?: unknown };
      rows.push({
        collection: key,
        created: Number(c.created),
        existing: Number(c.existing),
        filled: typeof c.filled === 'number' ? c.filled : null,
      });
    }
  }
  return { rows, skipped };
}
