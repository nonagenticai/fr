// relationDirectory.ts
// ====================
// The id → HUMAN-LABEL directories a `type: 'relation'` field picks from.
//
// ## Why this exists
//
// `relation` has been in the `FieldDef` union since Wave 6 and was declared by
// ZERO manifests, because `AssetEditor` rendered it as a plain `<input>` with a
// `TBD: typeahead picker` comment. Every foreign key in the workspace was
// therefore typed as a raw uuid into a text box — the exact thing a human
// cannot do. Declaring the type without building the mechanism made the type
// unusable, so nobody used it, so nobody noticed.
//
// This module is the mechanism's data half: a small registry of named
// directories, each of which knows how to read its own store and normalise it
// to `{ id, label }`. `RelationPicker.svelte` is the UI half.
//
// ## Why a registry rather than `relationTo` naming a manifest
//
// `relationTo` used to be documented as "the peer manifest's `name`", and for
// `project_id` that would have resolved to the `library/pm/projects` manifest —
// a DIFFERENT upstream store (`/api/assets/pm/projects`) whose ids are not the
// ids `project_id` holds. A picker built on it would have offered a list of
// plausible-looking options none of which resolve: worse than the raw input,
// because the raw input at least does not claim the value came from a
// validated set. The fr project directory is `GET /api/projects` — the same
// read `AssetCreateScopePicker` and `AssetBindingsList` already use.

import { authFetch } from '$lib/api/auth-fetch';
import { readFailureReason } from './scopeRefs';

export interface RelationOption {
  id: string;
  label: string;
  /**
   * ⚠️ `false` ⇒ this option may be DISPLAYED but must never be OFFERED.
   *
   * The two are different permissions and conflating them is what made the
   * project directory wrong in both directions at once. A soft-deleted
   * (`status:'archived'`) project must still be NAMEABLE — thousands of asset
   * rows already point at one, and a directory that omits it renders those rows
   * as bare uuids — while being unpickable, because picking it would create a
   * NEW reference to a deleted project.
   *
   * `undefined` means selectable, so every existing directory and every test
   * double that returns `{ id, label }` keeps today's behaviour. Consumers test
   * `selectable !== false`, never `selectable === true`.
   */
  selectable?: boolean;
}

export interface RelationDirectoryResult {
  options: RelationOption[];
  /**
   * ⚠️ Non-null ⇒ the directory could NOT be read, and the value is WHY.
   *
   * Distinct from "the directory is empty" for the same reason
   * `scopeRefs.ts` keeps them distinct: `[]` is what a failed read and a
   * genuinely empty store both look like, and only one of them justifies
   * telling the user there is nothing to pick.
   */
  unreadable: string | null;
}

export type RelationDirectoryLoader = () => Promise<RelationDirectoryResult>;

interface ProjectRow {
  id?: string | null;
  name?: string | null;
  title?: string | null;
  /** `'archived'` is fr's soft-delete state — displayable, not selectable. */
  status?: string | null;
}

/**
 * `GET /api/projects` → `{ id, label }`.
 *
 * Measured 2026-09-24 against the live route: 263 projects, 263 carrying a
 * `name`, so a title-based picker is fully supported by the data. `title` is
 * accepted as a secondary key only so a shape change does not silently empty
 * the picker; a row with neither is DROPPED rather than rendered as a blank
 * option, because a blank option is unpickable and indistinguishable from a
 * rendering bug.
 *
 * ## ⭐ Why `?include_archived=1`, and why ONLY here
 *
 * Bare `GET /api/projects` is the BROWSER read and excludes `archived`, fr's
 * soft-delete state. Measured on production 2026-09-24: **262 of 263 projects
 * are archived, 1 is active** — so the bare read is a ONE-ITEM directory, and
 * this module's two consumers both need more than that:
 *
 *   - the detail page's label resolver (`AssetDetail.resolveRelationLabels`)
 *     must NAME a project a row already points at. Measured in the upstream
 *     `requirements_api`: 16,457 asset rows carry a `project_id`, only **40**
 *     of them point at the one active project, and of the 86 distinct
 *     referenced projects that resolve in fr, **85 are archived**. Without the
 *     opt-in, 85 of 86 referenced projects render as bare uuids.
 *   - the picker (`RelationPicker`) must DISCLOSE what the stored value is
 *     before a human edits the row — "this id matches no project" is a false
 *     statement about a project that exists and is archived.
 *
 * ⛔ It does NOT follow that the picker may OFFER them: `selectable:false`
 * carries that, and `RelationPicker` drops non-selectable options from its
 * option list. The five OTHER `/api/projects` readers in the app
 * (`activeProject`, `AssetList`, `AssetScopePanel`, `AssetCreateScopePicker`,
 * `AssetBindingsList`) each issue their own bare fetch and are deliberately
 * left alone — the widening is confined to the one read whose job is naming.
 */
export const loadProjectDirectory: RelationDirectoryLoader = async () => {
  try {
    const res = await authFetch('/api/projects?include_archived=1');
    if (!res.ok) {
      // A non-ok response never reaches the catch below. Left unhandled it
      // would produce `options: []` — the empty state — from a read that
      // failed. Same two-paths-one-wrong-claim defect as
      // AssetCreateScopePicker's.
      return {
        options: [],
        unreadable: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
      };
    }
    const body = (await res.json()) as { items?: ProjectRow[] } | ProjectRow[];
    const rows = Array.isArray(body) ? body : (body?.items ?? []);
    const options: RelationOption[] = [];
    for (const r of rows ?? []) {
      const id = r?.id == null ? '' : String(r.id).trim();
      const label = String(r?.name ?? r?.title ?? '').trim();
      // ⚠️ Keyed on `status === 'archived'`, NOT on "anything that is not
      // active". `projects.status` is a four-value enum (`submitted`, `active`,
      // `archived`, `failed`) and only `archived` is the soft delete; a
      // `submitted` or `failed` project is a live row a human may legitimately
      // pick, and treating it as unselectable would silently remove options
      // that work today. A row with no `status` at all (a shape change, or an
      // older route revision) stays selectable: the fallback must be the
      // pre-existing behaviour.
      if (id && label) {
        options.push({ id, label, selectable: r?.status !== 'archived' });
      }
    }
    return { options, unreadable: null };
  } catch (err) {
    return { options: [], unreadable: readFailureReason(err, 'project list read failed') };
  }
};

/**
 * The registered directories. There is no `pm*` entry: fr's PM library pages
 * (and their manifests) are retired, and `pm_projects` ids are a different
 * store from fr `/api/projects` ids anyway (see this file's header).
 */
const REGISTRY: Record<string, RelationDirectoryLoader> = {
  projects: loadProjectDirectory,
};

/**
 * The loader for a `relationTo` key, or `null` when none is registered.
 *
 * `null` is not an error: `RelationPicker` then renders the free-text input
 * alone, which is precisely what `relation` rendered for every field before
 * this existed. A manifest cannot break a form by naming a directory that does
 * not exist yet.
 */
export function relationDirectoryFor(
  relationTo: string | undefined,
): RelationDirectoryLoader | null {
  if (!relationTo) return null;
  return REGISTRY[relationTo] ?? null;
}

