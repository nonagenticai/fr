// Architecture elements manifest (control-plane roadmap Phase 4 read +
// Phase 5 CRUD).
//
// Backend route:  backend/src/routes/assets/architecture.ts
// Upstream model: @fr/service-client-requirements ArchitectureElementOut / In.
//
// snake_case field names pass through from the backend verbatim. The editor
// surfaces only the writable ArchitectureElementIn fields (version/audit fields
// stay read-only in the detail view). No scopePicker — architecture assets are
// tenant-scoped automatically (their kind is not in the bindAsKind enum).

import type { AssetManifest } from '$lib/asset-workspace';
import type { QualityColumns } from '$lib/api/quality';
import { assetFetch, assetFetchPage } from '$lib/api/assets';
import { loadProjectDirectory } from '$lib/asset-workspace/relationDirectory';
import { fmtDateOrDash } from '../_fmt';

export interface ArchitectureElement extends QualityColumns {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  layer: string;
  element_type: string;
  status?: string;
  architecture_state?: string | null;
  parent_id?: string | null;
  project_id?: string | null;
  properties?: Record<string, unknown> | null;
  version?: string;
  version_status?: string;
  created_at?: string | null;
  updated_at?: string | null;
  // --- ENRICHMENT, not on the wire -----------------------------------------
  // See the "Read-time title resolution" block below for why these exist at
  // all. Both are id-fallback-resolved, so neither is ever blank on a row that
  // has the underlying id.
  /** Parent element's title, or its id when the title cannot be resolved. */
  parent_title?: string;
  /** Project's name, or the project id when it cannot be resolved. */
  project_title?: string;
}

const BASE = '/api/assets/architecture/elements';

// --- Read-time title resolution -------------------------------------------
//
// ⚠️ `type: 'relation'` fixes the EDITOR ONLY. `AssetDetail.renderField`
// (`AssetDetail.svelte:102-119`) has no `relation` branch: a relation field in
// a `detail` section falls through to `String(value)` and renders the raw uuid,
// exactly as `type: 'text'` did. MEASURED — so declaring `relation` on a detail
// field buys nothing a human can read, and the READ side needs its own
// mechanism.
//
// That mechanism is `pm/dependencies.ts`'s: `ColumnDef.formatter` and
// `FieldDef.formatter` are SYNCHRONOUS, so a formatter cannot fetch. Titles are
// resolved once per read in the fetch layer, attached to the row, and every
// label degrades to the id — never to blank — the way
// `KagContradictionList.svelte:28` reads `target_label ?? target_id`.
//
// ⚠️ These helpers live in THIS file rather than in a new shared module or in
// `asset-workspace/relationDirectory.ts` because this session's lease is the
// four `architecture/*.ts` manifests and not those files. `relationships.ts`,
// `standards.ts` and `views.ts` import them from here.
//
// ⚠️ `assetFetch`, NOT `assetFetchPage`, for every secondary read below. The
// architecture list handlers ARE `resolveListLimit`-capped, so a directory read
// can come back partial; ids beyond the cap simply do not resolve and render as
// ids, which is the same safe direction as a failed read. Reading the cap here
// would surface a truncation warning about a SECONDARY read on a page whose
// PRIMARY read was complete — a claim about the wrong request.

interface LabelledRow {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  label?: unknown;
}

/**
 * `id → human label` over rows already in hand. No fetch, so it is free on a
 * list read that has the rows anyway.
 *
 * A row with an id but no label is SKIPPED rather than mapped to `''`: an empty
 * string would win the `?? id` fallback at every call site and render a blank
 * where the id used to be, which is the one outcome worse than the uuid.
 */
export function titleIndex(rows: ReadonlyArray<LabelledRow> | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows ?? []) {
    const id = r?.id == null ? '' : String(r.id).trim();
    const label = String(r?.title ?? r?.name ?? r?.label ?? '').trim();
    if (id && label) map.set(id, label);
  }
  return map;
}

/**
 * `id → human label` for an asset list endpoint, or an EMPTY map on any
 * failure.
 *
 * ⚠️ The catch is total and silent ON PURPOSE. An element list that cannot name
 * its parent is still a correct element list; enrichment must never take the
 * primary read down with it. The visible consequence of a failure is the id —
 * i.e. exactly what this surface showed before.
 */
export async function idTitleMap(url: string): Promise<Map<string, string>> {
  try {
    return titleIndex(await assetFetch<LabelledRow[]>(url));
  } catch {
    return new Map<string, string>();
  }
}

/**
 * `project id → project name`, from the SAME directory the relation picker
 * offers (`relationDirectory.loadProjectDirectory` → `GET /api/projects`), so
 * the read side and the write side can never disagree about what a project is
 * called.
 *
 * ⛔ Not `library/pm/projects`: a DIFFERENT upstream store whose ids are not the
 * ids `project_id` holds — see `relationDirectory.ts`'s own note.
 *
 * ⭐ That `GET /api/projects` is the right namespace for an ARCHITECTURE
 * `project_id` is verified independently of the requirements/decisions
 * precedent: `routes/projects/[id]/governance/+page.svelte:21,41` takes the fr
 * project route param and passes it straight to `getArchitectureConformance`,
 * which is `POST /architecture/tools/conformance { project_id }` in
 * requirements_management — the same upstream that owns these elements.
 */
export async function projectTitles(): Promise<Map<string, string>> {
  // `loadProjectDirectory` never throws and reports an unreadable directory as
  // `{ options: [], unreadable }`. Enrichment treats both the same way (no
  // labels ⇒ ids), so the reason is deliberately not surfaced here; the EDITOR
  // is where "the directory is down" has to be said, and RelationPicker says it.
  const { options } = await loadProjectDirectory();
  return new Map(options.map((o) => [o.id, o.label]));
}

/** `element id → element title` for every architecture element this tenant can read. */
export async function architectureElementTitles(): Promise<Map<string, string>> {
  return await idTitleMap(BASE);
}

/**
 * Attach `parent_title` / `project_title`. Falls back to the id — never to
 * blank — and leaves the field ABSENT when there is no id at all, so `'—'`
 * still renders for an element with no parent.
 */
export function withElementTitles(
  rows: ArchitectureElement[],
  parents: Map<string, string>,
  projects: Map<string, string>,
): ArchitectureElement[] {
  return rows.map((e) => {
    const parentId = e.parent_id == null ? '' : String(e.parent_id).trim();
    const projectId = e.project_id == null ? '' : String(e.project_id).trim();
    return {
      ...e,
      ...(parentId ? { parent_title: parents.get(parentId) ?? parentId } : {}),
      ...(projectId ? { project_title: projects.get(projectId) ?? projectId } : {}),
    };
  });
}

export const architectureElementsManifest: AssetManifest<ArchitectureElement> = {
  name: 'library/architecture/elements',
  singular: 'Element',
  plural: 'Elements',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const [page, projects] = await Promise.all([
        assetFetchPage<ArchitectureElement[]>(`${BASE}${params ? `?${params}` : ''}`),
        projectTitles(),
      ]);
      return {
        // ⭐ Parent titles come from the page ITSELF, not a second read of the
        // same endpoint: a parent is an element, and re-fetching the store we
        // just fetched would double the cost to resolve rows we already hold. A
        // parent outside the returned page falls back to its id, same as any
        // other unresolved reference.
        items: withElementTitles(page.items ?? [], titleIndex(page.items), projects),
        truncated: page.truncated,
        appliedLimit: page.appliedLimit,
      };
    },
    get: async (id) => {
      // A single element carries no sibling rows, so the parent directory has
      // to be read here — unlike `list` above.
      const [item, parents, projects] = await Promise.all([
        assetFetch<ArchitectureElement>(`${BASE}/${encodeURIComponent(id)}`),
        architectureElementTitles(),
        projectTitles(),
      ]);
      return withElementTitles([item], parents, projects)[0];
    },
    create: (input) =>
      assetFetch<ArchitectureElement>(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    update: (id, input) =>
      assetFetch<ArchitectureElement>(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    remove: (id) =>
      assetFetch<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  list: {
    columns: [
      { key: 'title', label: 'Name', width: '22rem' },
      { key: 'layer', label: 'Layer' },
      { key: 'element_type', label: 'Type' },
      { key: 'version_status', label: 'Status' },
      { key: 'updated_at', label: 'Updated', formatter: (v) => fmtDateOrDash(v) },
    ],
    titleField: 'title',
    subtitleField: 'element_type',
    // BOTH forms, the way `relationships.ts` already does it. The Hierarchy &
    // scope section now leads with `parent_title` / `project_title` and DEMOTES
    // the raw ids — but this line was never touched when that landed, so the new
    // titles were displayed-and-unsearchable and the ids they replaced were too.
    // A human who used to find a row by pasting a uuid must still be able to,
    // and being able to search "Apollo Migration" is the point of resolving it.
    //
    // ⚠️ Reachable because `api.list` runs `withElementTitles` over the page, so
    // `parent_title` / `project_title` are ON the list rows. Search is a
    // CLIENT-SIDE filter over the loaded payload (`AssetList.svelte:192-201`
    // reads `row[k]`), so a field absent from the list payload can never match —
    // which is exactly why `views.ts` does NOT get its `*_titles` added.
    searchableFields: [
      'title',
      'description',
      'slug',
      'element_type',
      'parent_title',
      'project_title',
      'parent_id',
      'project_id',
    ],
    defaultSort: { key: 'updated_at', dir: 'desc' },
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Name', type: 'text' },
          { key: 'description', label: 'Description', type: 'longtext' },
          { key: 'slug', label: 'Slug', type: 'text' },
        ],
      },
      {
        title: 'Classification',
        fields: [
          { key: 'layer', label: 'ArchiMate layer', type: 'text' },
          { key: 'element_type', label: 'Element type', type: 'text' },
          { key: 'status', label: 'Element status', type: 'text' },
          { key: 'architecture_state', label: 'Architecture state', type: 'text' },
        ],
      },
      {
        // Titles, not uuids. `parent_title` / `project_title` are
        // id-fallback-resolved on read, so these rows are never blank even when
        // the directory read failed — and the RAW ids keep exactly ONE home,
        // this section, so an operator can still paste them into the API. Same
        // split as `pm/dependencies.ts`'s Link vs Metadata sections.
        title: 'Hierarchy & scope',
        fields: [
          { key: 'parent_title', label: 'Parent element', type: 'text' },
          { key: 'project_title', label: 'Project', type: 'text' },
          { key: 'parent_id', label: 'Parent element ID', type: 'text' },
          { key: 'project_id', label: 'Project ID', type: 'text' },
          { key: 'properties', label: 'Properties', type: 'json' },
        ],
      },
      {
        title: 'Versioning',
        fields: [
          { key: 'version', label: 'Version', type: 'text' },
          { key: 'version_status', label: 'Status', type: 'text' },
          { key: 'created_at', label: 'Created', type: 'text', formatter: fmtDateOrDash },
          { key: 'updated_at', label: 'Updated', type: 'text', formatter: fmtDateOrDash },
        ],
      },
    ],
  },
  editor: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Name', type: 'text', required: true },
          { key: 'description', label: 'Description', type: 'longtext' },
          {
            key: 'project_id',
            label: 'Project',
            // `type: 'relation'` — the picker offers PROJECT NAMES and stores
            // the id. It was `type: 'text'` labelled "Project scope", which
            // asked a human to type a uuid from memory. Directory is
            // `GET /api/projects`, the same one `decisions.ts` and
            // `requirements.ts` already use; see `projectTitles()` above for why
            // that is the right namespace for an ARCHITECTURE project_id.
            type: 'relation',
            relationTo: 'projects',
            helpText:
              'Optional project association. Pick by name, or paste an id. An existing id that matches no project is kept, not cleared.',
          },
        ],
      },
      {
        title: 'Classification',
        fields: [
          {
            key: 'layer',
            label: 'ArchiMate layer',
            type: 'text',
            required: true,
            helpText: 'e.g. business, application, technology, motivation',
          },
          {
            key: 'element_type',
            label: 'Element type',
            type: 'text',
            required: true,
            helpText: 'Element type within the layer (e.g. application_component)',
          },
          { key: 'status', label: 'Element status', type: 'text' },
          {
            key: 'architecture_state',
            label: 'Architecture state',
            type: 'select',
            helpText: 'Baseline, target, or transitional',
            options: [
              { value: 'baseline', label: 'Baseline' },
              { value: 'target', label: 'Target' },
              { value: 'transitional', label: 'Transitional' },
            ],
          },
        ],
      },
      {
        title: 'Hierarchy',
        fields: [
          {
            // ⛔ STILL `text`, deliberately. This wants to be
            // `type: 'relation', relationTo: 'architectureElements'` — but
            // `relationDirectory.ts` registers only `projects`, and that file is
            // not this session's to change. The missing piece is named in the
            // handoff: an `architectureElements` directory over
            // `GET /api/assets/architecture/elements` (`{ id, title }`). The
            // READ side is already fixed — the detail view shows the parent's
            // TITLE (see `withElementTitles`) — so what remains is only the
            // write-side picker.
            key: 'parent_id',
            label: 'Parent element',
            type: 'text',
            helpText: 'Parent element ID for decomposition',
          },
          { key: 'properties', label: 'Properties', type: 'json' },
        ],
      },
    ],
  },
  // ArchitectureElementOut exposes the five QualityMixin columns.
  quality: {
    kind: 'architectureElement',
    label: 'Description quality',
    modifiedField: 'updated_at',
  },
  destructiveActionsRequireConfirm: true,
};
