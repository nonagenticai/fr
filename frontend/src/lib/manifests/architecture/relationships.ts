// Architecture relationships manifest (control-plane roadmap Phase 4 read +
// Phase 5 create/delete).
//
// Backend route:  backend/src/routes/assets/architecture.ts
// Upstream model: @fr/service-client-requirements ArchitectureRelationshipOut / In.
//
// The polymorphic relationship rows are the cross-domain edge set
// (architecture ↔ requirement ↔ decision ↔ principle ↔ pm_activity) that the
// Phase-8 Traceability graph will render. Relationships are IMMUTABLE upstream
// — the generated client ships no update builder — so this manifest exposes
// create + remove only (no `api.update`, hence no Edit affordance / edit route).

import type { AssetManifest } from '$lib/asset-workspace';
import { assetFetch, assetFetchPage } from '$lib/api/assets';
import { idTitleMap, projectTitles } from './elements';
import { fmtDateOrDash } from '../_fmt';

export interface ArchitectureRelationship {
  id: string;
  slug: string;
  source_entity_type: string;
  source_id: string;
  target_entity_type: string;
  target_id: string;
  relationship_type: string;
  name?: string | null;
  description?: string | null;
  project_id?: string | null;
  properties?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  // --- ENRICHMENT, not on the wire -----------------------------------------
  // `endpointLabel()` used to return `"<entity_type>:<uuid>"` for the Source and
  // Target columns. That is a FORMATTED uuid, which is still a uuid: the two
  // most important cells on the surface named neither end of the edge. Both ends
  // are resolved to titles at read time (see `endpointTitles`) and fall back to
  // the old `type:id` form, so a failed or capped directory read degrades to
  // exactly what shipped before.
  /** Source entity's title, or `"<entity_type>:<id>"` when unresolvable. */
  source_label?: string;
  /** Target entity's title, or `"<entity_type>:<id>"` when unresolvable. */
  target_label?: string;
  /** Project's name, or the project id when it cannot be resolved. */
  project_title?: string;
}

const BASE = '/api/assets/architecture/relationships';

// --- Polymorphic endpoint resolution ---------------------------------------
//
// A relationship endpoint is an `(entity_type, id)` pair across five stores, so
// there is no single directory to read — the set to read depends on the rows.
//
// ⚠️ THE VOCABULARY IS PLURAL TABLE NAMES, and this file's own helpText used to
// teach the SINGULAR. The codebase contradicts itself:
//   - `backend/src/integrations/architecture.ts:188` — "`entityType` is the
//     upstream table name (`architecture_elements`, `requirements`,
//     `decisions`, `principles`, `pm_*`)"
//   - `backend/src/agui/actions/architecture.ts:184` — the same sentence
//   - `backend/src/routes/traceability.ts:69-85` — `TYPE_LABEL` and `ROUTE_BASE`
//     are BOTH keyed on the plural names, and are the only canonical mapping
//     that exists
//   - …against a backend test fixture using `'architecture_element'`, and this
//     file's old helpText.
// The generated client types the field as a bare `string` with no enum, so
// neither form can be ruled out on the wire. The registry is therefore keyed on
// the canonical plural names and ACCEPTS the singular as an alias, because rows
// created through this very form were told to type the singular. Guessing one
// and dropping the other would make the resolver dead for half the data while
// looking like it worked.

/** Canonical `entity_type` (plural upstream table name) → its asset list route. */
const ENTITY_DIRECTORIES: Readonly<Record<string, string>> = {
  architecture_elements: '/api/assets/architecture/elements',
  requirements: '/api/assets/requirements',
  decisions: '/api/assets/decisions',
  principles: '/api/assets/principles',
  // (pm_activities is gone with /api/assets/pm/* — v4 D15/R16: an endpoint of
  // that type is shown as its `type:id`, like every other undirected store.)
};

/**
 * The canonical key for a wire `entity_type`, or `null` when no directory
 * serves it.
 *
 * `null` is not an error — `endpointLabel` then returns the `type:id` form this
 * file already shipped. The four stores above are the ones with both a list
 * route and a human title; `architecture_relationships`, `pm_buffers` and the
 * rest of `traceability.ts`'s sixteen types resolve to nothing and stay as ids.
 */
export function canonicalEntityType(entityType: unknown): string | null {
  const raw = entityType == null ? '' : String(entityType).trim().toLowerCase();
  if (!raw) return null;
  if (raw in ENTITY_DIRECTORIES) return raw;
  // Singular → plural, the form this file's helpText used to ask for.
  const plural = `${raw}s`;
  return plural in ENTITY_DIRECTORIES ? plural : null;
}

/**
 * `entity_type → (id → title)` for ONLY the entity types the given rows
 * actually reference.
 *
 * ⚠️ Scoped to the rows on purpose: reading all five stores unconditionally
 * would spend four requests to resolve a page of elements-only edges. Each read
 * is independently failure-isolated inside `idTitleMap`, so one dead store
 * costs its own labels and nothing else.
 */
export async function endpointTitles(
  rows: ReadonlyArray<ArchitectureRelationship>,
): Promise<Map<string, Map<string, string>>> {
  const needed = new Set<string>();
  for (const r of rows ?? []) {
    for (const t of [r?.source_entity_type, r?.target_entity_type]) {
      const key = canonicalEntityType(t);
      if (key) needed.add(key);
    }
  }
  const keys = [...needed];
  const maps = await Promise.all(keys.map((k) => idTitleMap(ENTITY_DIRECTORIES[k])));
  return new Map(keys.map((k, i) => [k, maps[i]]));
}

/**
 * One endpoint in human terms.
 *
 * ⚠️ The fallback is the ORIGINAL `"<entity_type>:<id>"`, not a blank and not a
 * bare id: an unresolvable endpoint must still say which store it points into,
 * and this surface is the only place that says it.
 */
export function endpointLabel(
  entityType: unknown,
  id: unknown,
  titles?: Map<string, Map<string, string>>,
): string {
  const t = entityType ? String(entityType) : '?';
  const i = id ? String(id) : '?';
  const key = canonicalEntityType(entityType);
  const resolved = key && i ? titles?.get(key)?.get(i.trim()) : undefined;
  return resolved && resolved.trim() ? resolved : `${t}:${i}`;
}

/**
 * `relationship id → human label`, for surfaces that hold a bare relationship id
 * (`architecture/views.ts`'s `relationship_ids`).
 *
 * ⚠️ `name` is OPTIONAL upstream and the list already renders `'—'` for a blank
 * one, so `name` alone would map only the named rows and leave the rest
 * unresolved — a directory that works for some rows and not others is harder to
 * read than one that works for none. `relationship_type` is REQUIRED (it is the
 * manifest's own `titleField`), so it is the floor: every relationship gets a
 * label, and a named one gets the better label.
 *
 * Returns an EMPTY map on any failure — see `idTitleMap`'s note in `elements.ts`.
 */
export async function relationshipLabels(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows = await assetFetch<ArchitectureRelationship[]>(BASE);
    for (const r of rows ?? []) {
      const id = r?.id == null ? '' : String(r.id).trim();
      if (!id) continue;
      const name = r?.name == null ? '' : String(r.name).trim();
      const type = r?.relationship_type == null ? '' : String(r.relationship_type).trim();
      const label = name || type;
      if (label) map.set(id, label);
    }
  } catch {
    return map;
  }
  return map;
}

/**
 * Attach `source_label` / `target_label` / `project_title`. Never blank: every
 * label degrades through `endpointLabel`'s `type:id` form.
 */
export function withEndpointLabels(
  rows: ArchitectureRelationship[],
  titles: Map<string, Map<string, string>>,
  projects: Map<string, string>,
): ArchitectureRelationship[] {
  return rows.map((r) => {
    const projectId = r.project_id == null ? '' : String(r.project_id).trim();
    return {
      ...r,
      source_label: endpointLabel(r.source_entity_type, r.source_id, titles),
      target_label: endpointLabel(r.target_entity_type, r.target_id, titles),
      ...(projectId ? { project_title: projects.get(projectId) ?? projectId } : {}),
    };
  });
}

export const architectureRelationshipsManifest: AssetManifest<ArchitectureRelationship> =
  {
    name: 'library/architecture/relationships',
    singular: 'Relationship',
    plural: 'Relationships',
    group: 'knowledge',
    api: {
      list: async (q) => {
        const params = new URLSearchParams(q ?? {}).toString();
        const page = await assetFetchPage<ArchitectureRelationship[]>(
          `${BASE}${params ? `?${params}` : ''}`,
        );
        // Sequential on purpose: which directories to read is DERIVED from the
        // page, so it cannot be started before the page lands. `projectTitles`
        // could run in parallel with the page; it is bundled here instead so the
        // two enrichments share one await and one failure surface.
        const [titles, projects] = await Promise.all([
          endpointTitles(page.items ?? []),
          projectTitles(),
        ]);
        return {
          items: withEndpointLabels(page.items ?? [], titles, projects),
          truncated: page.truncated,
          appliedLimit: page.appliedLimit,
        };
      },
      get: async (id) => {
        const item = await assetFetch<ArchitectureRelationship>(
          `${BASE}/${encodeURIComponent(id)}`,
        );
        const [titles, projects] = await Promise.all([
          endpointTitles([item]),
          projectTitles(),
        ]);
        return withEndpointLabels([item], titles, projects)[0];
      },
      // No update — relationships are immutable upstream (edit = delete + recreate).
      create: (input) =>
        assetFetch<ArchitectureRelationship>(BASE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      remove: (id) =>
        assetFetch<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    },
    list: {
      columns: [
        { key: 'relationship_type', label: 'Type', width: '12rem' },
        // Titles, not uuids, and NOT via a formatter: a formatter is synchronous
        // and cannot fetch, which is why the old one could only ever reformat
        // the uuid it was handed. `source_label` / `target_label` are resolved on
        // read and fall back to the old `type:id` string, so these cells are
        // never blank.
        { key: 'source_label', label: 'Source' },
        { key: 'target_label', label: 'Target' },
        { key: 'name', label: 'Label', formatter: (v) => (v ? String(v) : '—') },
      ],
      titleField: 'relationship_type',
      subtitleField: 'slug',
      // Labels are searchable now, and the raw ids stay matchable: pasting a
      // uuid from a sibling surface must still find the row.
      searchableFields: [
        'relationship_type',
        'name',
        'source_label',
        'target_label',
        'source_id',
        'target_id',
        'slug',
      ],
      defaultSort: { key: 'relationship_type', dir: 'asc' },
    },
    detail: {
      sections: [
        {
          title: 'Relationship',
          fields: [
            { key: 'relationship_type', label: 'Type', type: 'text' },
            { key: 'name', label: 'Label', type: 'text' },
            { key: 'description', label: 'Description', type: 'longtext' },
            { key: 'slug', label: 'Slug', type: 'text' },
          ],
        },
        {
          // The resolved endpoint leads; the raw id keeps its one home directly
          // under it so an operator can still paste it into the API.
          title: 'Source',
          fields: [
            { key: 'source_label', label: 'Source', type: 'text' },
            { key: 'source_entity_type', label: 'Source type', type: 'text' },
            { key: 'source_id', label: 'Source ID', type: 'text' },
          ],
        },
        {
          title: 'Target',
          fields: [
            { key: 'target_label', label: 'Target', type: 'text' },
            { key: 'target_entity_type', label: 'Target type', type: 'text' },
            { key: 'target_id', label: 'Target ID', type: 'text' },
          ],
        },
        {
          title: 'Metadata',
          fields: [
            { key: 'project_title', label: 'Project', type: 'text' },
            { key: 'project_id', label: 'Project ID', type: 'text' },
            { key: 'properties', label: 'Properties', type: 'json' },
            { key: 'created_at', label: 'Created', type: 'text', formatter: fmtDateOrDash },
            { key: 'updated_at', label: 'Updated', type: 'text', formatter: fmtDateOrDash },
          ],
        },
      ],
    },
    editor: {
      sections: [
        {
          title: 'Relationship',
          fields: [
            {
              key: 'relationship_type',
              label: 'Type',
              type: 'text',
              required: true,
              helpText: 'e.g. realizes, serves, composes, triggers',
            },
            { key: 'name', label: 'Label', type: 'text' },
            { key: 'description', label: 'Description', type: 'longtext' },
          ],
        },
        {
          title: 'Source',
          fields: [
            {
              key: 'source_entity_type',
              label: 'Source type',
              type: 'text',
              required: true,
              // ⚠️ WAS "e.g. architecture_element, requirement" — the SINGULAR.
              // Every canonical mapping in the estate is keyed on the PLURAL
              // upstream table name (`traceability.ts:69-85`,
              // `integrations/architecture.ts:188`), so this field was teaching
              // humans a value the rest of the system does not recognise.
              helpText:
                'Source entity table (plural) — e.g. architecture_elements, requirements, decisions, principles',
            },
            {
              // ⛔ STILL `text`. This is a POLYMORPHIC key: the store it points
              // into is chosen by `source_entity_type`, so it needs one directory
              // PER entity type and a picker that reloads when the sibling field
              // changes. `relationDirectory.ts` registers only `projects` and is
              // not this session's file; `FieldDef` has no way to express "the
              // directory named by another field". Named in the handoff. The READ
              // side IS fixed — Source/Target now show titles.
              key: 'source_id',
              label: 'Source ID',
              type: 'text',
              required: true,
              helpText: 'Id of the source entity in the table named above',
            },
          ],
        },
        {
          title: 'Target',
          fields: [
            {
              key: 'target_entity_type',
              label: 'Target type',
              type: 'text',
              required: true,
              // Same singular→plural correction as Source type above.
              helpText:
                'Target entity table (plural) — e.g. architecture_elements, requirements, decisions, principles',
            },
            {
              // ⛔ STILL `text`, for the same polymorphic reason as `source_id`.
              key: 'target_id',
              label: 'Target ID',
              type: 'text',
              required: true,
              helpText: 'Id of the target entity in the table named above',
            },
          ],
        },
        {
          title: 'Metadata',
          fields: [
            {
              key: 'project_id',
              label: 'Project',
              // Pick by NAME. Directory is `GET /api/projects` — see
              // `elements.ts`'s `projectTitles()` for the verification that fr
              // project ids are this field's namespace.
              type: 'relation',
              relationTo: 'projects',
              helpText:
                'Optional project association. Pick by name, or paste an id. An existing id that matches no project is kept, not cleared.',
            },
            { key: 'properties', label: 'Properties', type: 'json' },
          ],
        },
      ],
    },
    destructiveActionsRequireConfirm: true,
  };
