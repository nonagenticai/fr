// asset-workspace/manifest.ts
//
// Resource-manifest types for the generic AssetWorkspace.
//
// Each asset type (workers, requirements, principles, decisions,
// secrets, artifacts, …) is described by a single AssetManifest<T>. The
// declarative manifest then drives a small set of generic Svelte components
// (AssetList / AssetDetail / AssetEditor / AssetWorkspace) — replacing the
// ~30 bespoke +page.svelte files we have today.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 6 Task 6.1 Step 1.

import type { AssetKind } from '$lib/api/bindings';
import type { QualityKind } from '$lib/api/quality';

export interface FieldDef<T = unknown> {
  key: keyof T & string;
  label: string;
  type:
    | 'text'
    | 'longtext'
    | 'number'
    | 'boolean'
    | 'date'
    | 'select'
    | 'tags'
    | 'json'
    | 'objectArray'
    | 'relation';
  required?: boolean;
  helpText?: string;
  /** For type='select'. */
  options?: { value: string; label: string }[];
  /**
   * For type='objectArray' — the per-ROW field definitions, rendered once per
   * element of the array.
   *
   * ⚠️ Only the scalar-ish row types are honoured by `ObjectArrayEditor`
   * (`text`, `longtext`, `number`, `boolean`, `tags`, `json`). Nesting an
   * `objectArray` inside an `objectArray` is deliberately NOT supported: a
   * two-level repeater needs a reorder story for both levels, and no asset
   * upstream asks for one. A row field of an unsupported type renders nothing
   * rather than a broken control.
   *
   * An `objectArray` with no `itemFields` renders the add/remove/reorder chrome
   * over empty rows, which is useless but not wrong — it degrades, it does not
   * throw.
   *
   * ⚠️ Typed `FieldDef<Record<string, unknown>>`, NOT `FieldDef` (whose default
   * `T = unknown` collapses `key: keyof T & string` to `never` — an array no
   * manifest could populate). A row is a bag of string keys, so that is also
   * the honest shape.
   */
  itemFields?: FieldDef<Record<string, unknown>>[];
  /**
   * BLOCKING field validation, run by `AssetEditor.onSubmit` for every field
   * that declares it, immediately after the `json` parse pass and before any
   * network call. A non-null return is the message; `null` means valid.
   *
   * ⚠️ SYNCHRONOUS on purpose. A validator that could fetch would either make
   * the submit button lie about its own latency or, far worse, fail OPEN when
   * the fetch errors — and a validator that fails open is the vacuous-gate
   * shape. Anything needing a round trip belongs upstream, where the 422 lives.
   *
   * ⚠️ It surfaces into the SAME `saveError` channel as the json pre-flight.
   * A second error surface is how a form ends up showing one error while
   * refusing for another.
   */
  validate?: (v: unknown) => string | null;
  /**
   * NON-BLOCKING advice, re-evaluated as the field changes and rendered under
   * the control. A non-null return is the message; `null` means nothing to say.
   *
   * ## Why this is separate from `validate`, and why it must stay separate
   *
   * Some defects are certain and belong in `validate` (an empty `steps` array
   * is refused upstream by `@minItems 1`, so refusing it here only trades an
   * opaque 422 for a precise message). Others are *probably* wrong but are
   * judged against a constant this repo only MIRRORS from somewhere else — the
   * procedure work-floor's non-work `action_type` list mirrors n8n's
   * `_NONWORK_AT`. Hard-blocking on a mirrored constant refuses legitimate
   * bodies on the day the upstream list widens and before this copy catches up.
   *
   * So: certain → `validate` (refuse); mirrored/heuristic → `advise` (warn and
   * save anyway). Collapsing the two is how a warning becomes an outage.
   */
  advise?: (v: unknown) => string | null;
  /**
   * For type='relation' — the key of the human-label DIRECTORY this field
   * resolves against, as registered in `relationDirectory.ts` (e.g.
   * `'projects'`).
   *
   * ⚠️ Not a manifest `name`. The field needs an id→human-label source, and
   * the manifest that happens to render a kind is not always the store the FK
   * points at: `project_id` on requirements/decisions resolves against
   * `GET /api/projects`, NOT against the `library/pm/projects` manifest, which
   * is a different upstream store whose ids do not resolve here.
   *
   * An unregistered key is not an error: the field degrades to the free-text
   * input, which is what `relation` rendered for every field before the picker
   * existed.
   *
   * ## BOTH DIRECTIONS, and that is the point
   *
   * This started life as a WRITE-ONLY contract — "the key of the directory the
   * PICKER reads". The picker then let a human choose "Apollo migration" by
   * name, stored its uuid, and `AssetDetail` printed the uuid straight back:
   * the human picked a title and read a uuid, so the surface that taught them
   * the name immediately unlearned it. A directory that resolves id→label for
   * the editor resolves it for the detail view too, and `AssetDetail` now does
   * exactly that (see `resolveRelationLabels` there).
   *
   * Reading through the SAME registry is deliberate: a second id→label source
   * for the same FK can disagree with the picker's, and the field would then
   * offer one set of names and print another. One directory cannot drift from
   * itself.
   *
   * ⚠️ The detail read is ENRICHMENT and degrades to the ID, never to blank:
   * an unregistered key, a failed directory read, and an id the directory does
   * not contain all render the raw value — which is exactly what the field
   * showed before this existed. It must never blank the field or fail the page.
   */
  relationTo?: string;
  /**
   * Detail-view formatter.
   *
   * ⚠️ SYNCHRONOUS, so a formatter cannot fetch — which is why id→label
   * resolution for `relation` fields lives in the load path and not here. A
   * formatter declared on a `relation` field still WINS over the resolved
   * label: an explicit manifest instruction outranks generic enrichment.
   */
  formatter?: (v: unknown) => string;
}

export interface ColumnDef<T = unknown>
  extends Pick<FieldDef<T>, 'key' | 'label'> {
  /** Optional CSS width hint, e.g. '24rem'. */
  width?: string;
  /** Cell formatter — receives the cell value AND the full row. */
  formatter?: (v: unknown, row: T) => string;
}

export interface AssetManifest<T = unknown> {
  /** URL slug, e.g. 'workers'. */
  name: string;
  /**
   * Route base for this asset's item pages (`<base>/<id>`, `<base>/new`,
   * `<base>/<id>/edit`). Defaults to `/<name>`. Needed when the slug is not
   * the route: `kag` entities live at /kag/entities/<id>, and `/kag/<id>` —
   * what the default built — is no route at all (validator N3, 2026-10-03).
   */
  routeBase?: string;
  /**
   * Where "back to the list" goes. Defaults to `routeBase`. Set it when the
   * list is a different page from the item base — and it must be a real page,
   * never a redirect stub (nav standard: in-app links never target a redirect).
   */
  listHref?: string;
  /** Human label for one item, e.g. 'Worker'. */
  singular: string;
  /** Human label for the collection, e.g. 'Workers'. */
  plural: string;
  /** Sidebar grouping. */
  group: 'knowledge' | 'execution' | 'operational' | 'support';
  /**
   * Field on T whose value is used as the URL identifier (and as the cache
   * key in lists). Defaults to `'id'`. Set to `'name'` for assets that
   * identify by name (workers, secrets, artifacts).
   */
  idField?: keyof T & string;

  api: {
    /**
     * `truncated` is optional: a manifest whose route does not report a page
     * cap simply omits it, and the UI says nothing — which is correct, rather
     * than claiming completeness it cannot verify.
     */
    list: (
      params?: Record<string, string>,
    ) => Promise<{ items: T[]; truncated?: boolean; appliedLimit?: number | null }>;
    get: (id: string) => Promise<T>;
    create?: (input: Partial<T>) => Promise<T>;
    update?: (id: string, input: Partial<T>) => Promise<T>;
    remove?: (id: string) => Promise<void>;
  };

  list: {
    columns: ColumnDef<T>[];
    titleField: keyof T & string;
    /**
     * Field to fall back to when `titleField` is empty on a row.
     *
     * ## Why this exists
     *
     * `titleField` used to be set to the row's `id` on manifests whose human
     * label is nullable (KAG entities), because a uuid always renders and a
     * null label renders blank. That trade is backwards: it puts a uuid in the
     * page heading of EVERY row to avoid a blank heading on the few rows that
     * have no label. Humans do not read uuids — they read titles.
     *
     * Declaring the human field as `titleField` and the id as
     * `titleFallbackField` gets both: the label when there is one, and an
     * identifier (not a blank heading) when there is not. A manifest whose
     * `titleField` is non-nullable simply omits this.
     *
     * AssetDetail resolves title → fallback → `idField`/route id, in that
     * order, and never renders an empty heading.
     */
    titleFallbackField?: keyof T & string;
    subtitleField?: keyof T & string;
    searchableFields?: (keyof T & string)[];
    defaultSort?: { key: keyof T & string; dir: 'asc' | 'desc' };
    /**
     * Field on T whose value is `string[]` and drives the tag-filter sidebar.
     * Omit when the asset has no tag-like dimension. Filter semantics:
     * OR within a facet, AND across facets — same as workflows/facets.ts.
     */
    tagsField?: keyof T & string;
    /**
     * UI review 2026-10-07: opt-in status facet. A select over the values of
     * this field PRESENT in the loaded rows (URL param `status`). Client-side —
     * it narrows what was loaded, it does not re-query.
     */
    statusFilterField?: keyof T & string;
    /**
     * UI review 2026-10-07: opt-in. Collapse rows whose title (normalised) is
     * identical into one row with a "×N" badge that expands to every member.
     * Nothing is dropped — every id stays reachable.
     */
    groupDuplicateTitles?: boolean;
    /**
     * Opt-in server-side inclusion switch: a "Show …" checkbox in the list
     * header bound to URL param `param` (URL-as-truth). When checked,
     * `{ [param]: 'true' }` is added to the `api.list` params and the list
     * re-queries — unlike `statusFilterField`, this widens what the SERVER
     * returns (e.g. PM projects hides `closed` rows unless asked).
     */
    includeToggle?: { param: string; label: string };
    /**
     * Opt-in muted badge beside the row title (e.g. "closed"). Return null for
     * no badge. The row itself is dimmed when a badge is shown.
     */
    rowBadge?: (row: T) => string | null;
  };

  detail: {
    sections: { title: string; fields: FieldDef<T>[] }[];
  };

  editor?: {
    sections?: { title: string; fields: FieldDef<T>[] }[];
    /**
     * When set, AssetEditor renders an AssetCreateScopePicker above the
     * sections on the NEW form (not the edit form). On submit, if scope
     * is 'project', AssetEditor posts a binding to
     * `/api/assets/<bindAsKind>/<new-id>/bindings` after the upstream
     * create returns. Omit for asset kinds where project-scoped creation
     * is meaningless (e.g. system entities) or where the create UX
     * lives outside AssetEditor (KAG upload, artifact ingest).
     */
    scopePicker?: {
      bindAsKind:
        | 'requirement'
        | 'principle'
        | 'decision'
        | 'kag_document'
        | 'workflow'
        | 'trigger'
        | 'channel'
        | 'artifact';
      default?: 'tenant' | 'project';
    };
  };

  /**
   * Opt the list + detail views into the asset's scope-management surface
   * (the unified replacement for the old /library/[type] tenancy lens):
   *   - list: a Scope column + a bulk-action bar (assign-to-project,
   *     promote-to-workspace, promote-to-department);
   *   - detail: the AssetScopePanel ("Scope & Projects" — project bindings,
   *     promote, override/block).
   * Omit for assets with no project/scope dimension (e.g. workers, secrets).
   * `assetKind` is the bindings/asset-scope API kind (matches
   * `editor.scopePicker.bindAsKind`).
   */
  scope?: {
    assetKind: AssetKind;
    /** Assign-to-project via asset_bindings (POST /api/assets/:kind/:id/bindings). */
    bindable?: boolean;
    /** Promote to workspace/department via asset_assignments. */
    promotable?: boolean;
    /** Override/block an inherited asset at a dept/project scope. */
    overridable?: boolean;
  };

  /**
   * Opt the detail view into this asset's stored quality verdict and score
   * history (AssetQualityPanel, read-only — fr runs no evaluation).
   *
   * `modifiedField` drives the stale badge — a stored score describing text
   * that has since been edited is misleading, and every one of these assets
   * exposes `updated_at`. Omitting it disables the badge rather than guessing.
   *
   * `persistenceNote` says why no stored verdict is readable for an asset, when
   * that is the case, instead of the panel implying it was never evaluated.
   */
  quality?: {
    /** Which asset kind the verdict and history belong to. */
    kind: QualityKind;
    /** Section heading, e.g. 'Description quality'. */
    label: string;
    /** Field on T holding the entity's own last-modified timestamp. */
    modifiedField?: keyof T & string;
    /** Why no stored verdict is readable for this asset, when that is the case. */
    persistenceNote?: string;
  };

  related?: {
    label: string;
    /** Peer manifest name. */
    manifest: string;
    /**
     * Read the peer rows for this row.
     *
     * ⚠️ `projectResolved` is the THREE-STATE `X-Project-Resolved` reading from
     * `assetFetchPage` (`true` / `false` / `null` — see `AssetPage`). A fetch
     * that scopes by `?project_id=` MUST thread it through, because `false`
     * means the route filtered on a project that DOES NOT EXIST: `items: []`
     * then has nothing to do with "this project holds none", and the two were
     * rendered identically. Omit it (or pass `null`) when the fetch sends no
     * project filter, or reads a route that does not emit the header — silence
     * must never be promoted to `true`.
     *
     * ⚠️ `truncated` is deliberately NOT part of this shape. The related panel
     * makes no completeness claim, so a `fetch` reading the page headers for
     * the resolution signal must not start implying it read a page cap too.
     */
    fetch: (
      row: T,
    ) => Promise<{ items: unknown[]; projectResolved?: boolean | null }>;
  }[];

  destructiveActionsRequireConfirm?: boolean;
}

// --- The title fallback chain, in ONE place -------------------------------
//
// `list.titleFallbackField` was added to the manifest type and honoured by
// `AssetDetail` alone. The other two surfaces that render a row's human label —
// `AssetList` (whose title cell IS the row's link text) and `RelatedAssets` —
// each read `row[titleField]` raw, so a manifest that declared a fallback got
// it in the page heading and a BLANK, unclickable-looking link in the list that
// leads there. A per-manifest workaround (a `ColumnDef.formatter` doing `?? id`
// on every manifest) is the same fix written N times, and the Nth is the one
// nobody writes.
//
// So the chain lives here and all three surfaces call it.

/**
 * One rung of the chain: the row's value for `field`, stringified and trimmed,
 * or `''`.
 *
 * ⚠️ Trimmed and tested for NON-EMPTY, not for null. A field that is present
 * but holds `''` (or `'   '`) is as blank on screen as a missing one, so `??`
 * alone would happily "succeed" into an empty heading — the exact defect the
 * chain exists to prevent.
 */
export function rowFieldText(
  row: Record<string, unknown>,
  field?: string,
): string {
  if (!field) return '';
  const v = row[field];
  if (v == null) return '';
  return String(v).trim();
}

/**
 * A row's human label: `titleField` → `titleFallbackField` → `idField`/`id`.
 *
 * Returns `''` only when the row carries nothing in any of the three, which is
 * a row with no identity at all. Callers with a better last resort (AssetDetail
 * has the route's `id` param) `||` it on.
 */
export function resolveRowTitle<T>(
  row: T,
  manifest: Pick<AssetManifest<T>, 'list' | 'idField'>,
): string {
  const r = row as Record<string, unknown>;
  return (
    rowFieldText(r, manifest.list.titleField) ||
    rowFieldText(r, manifest.list.titleFallbackField) ||
    rowFieldText(r, manifest.idField ?? 'id')
  );
}

/** `<routeBase>` for item pages — `/<name>` unless the manifest overrides it. */
export function assetRouteBase(manifest: Pick<AssetManifest<never>, 'name' | 'routeBase'>): string {
  return manifest.routeBase ?? `/${manifest.name}`;
}

/** The list page "back" / post-delete links land on. */
export function assetListHref(
  manifest: Pick<AssetManifest<never>, 'name' | 'routeBase' | 'listHref'>,
): string {
  return manifest.listHref ?? assetRouteBase(manifest);
}

/** One item's detail page. */
export function assetItemHref(
  manifest: Pick<AssetManifest<never>, 'name' | 'routeBase'>,
  id: string | number,
): string {
  return `${assetRouteBase(manifest)}/${encodeURIComponent(String(id))}`;
}
