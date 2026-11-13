// Architecture views manifest (control-plane roadmap Phase 4 read +
// Phase 5 CRUD).
//
// Backend route:  backend/src/routes/assets/architecture.ts
// Upstream model: @fr/service-client-requirements ArchitectureViewOut / In.
//
// A view is an ArchiMate viewpoint over a set of elements + relationships.
// Faithful viewpoint rendering is later-session work; here element_ids /
// relationship_ids are edited as comma-separated ID lists (tags).

import type { AssetManifest } from '$lib/asset-workspace';
import type { QualityColumns } from '$lib/api/quality';
import { assetFetch, assetFetchPage } from '$lib/api/assets';
import { architectureElementTitles } from './elements';
import { relationshipLabels } from './relationships';
import { fmtDateOrDash } from '../_fmt';

export interface ArchitectureView extends QualityColumns {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  viewpoint: string;
  project_id?: string | null;
  element_ids?: string[] | null;
  relationship_ids?: string[] | null;
  layout_data?: Record<string, unknown> | null;
  version?: string;
  version_status?: string;
  created_at?: string | null;
  updated_at?: string | null;
  // --- ENRICHMENT, not on the wire -----------------------------------------
  // A view IS its contents, and the detail view rendered both content sets as
  // tags of bare uuids under the headings "Element IDs" / "Relationship IDs" —
  // on rows describing elements that all have titles.
  /** `element_ids` with each id swapped for the element title; unresolved ids kept. */
  element_titles?: string[];
  /** `relationship_ids` with each id swapped for its label; unresolved ids kept. */
  relationship_labels?: string[];
}

const BASE = '/api/assets/architecture/views';

/**
 * Attach `element_titles` / `relationship_labels`.
 *
 * ⚠️ Each output array is the SAME LENGTH as its id array, with unresolved ids
 * kept verbatim. Dropping them would make a view under-report its own contents —
 * and the list's "Elements" count column is computed from `element_ids`, so a
 * shorter title list would visibly contradict the number beside it.
 */
export function withViewContentTitles(
  rows: ArchitectureView[],
  elements: Map<string, string>,
  relationships: Map<string, string>,
): ArchitectureView[] {
  const resolve = (ids: unknown, dir: Map<string, string>): string[] | null => {
    if (!Array.isArray(ids)) return null;
    return ids.map((raw) => {
      const id = raw == null ? '' : String(raw).trim();
      return dir.get(id) ?? id;
    });
  };
  return rows.map((v) => {
    const els = resolve(v.element_ids, elements);
    const rels = resolve(v.relationship_ids, relationships);
    return {
      ...v,
      ...(els ? { element_titles: els } : {}),
      ...(rels ? { relationship_labels: rels } : {}),
    };
  });
}

export const architectureViewsManifest: AssetManifest<ArchitectureView> = {
  name: 'library/architecture/views',
  singular: 'View',
  plural: 'Views',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const page = await assetFetchPage<ArchitectureView[]>(
        `${BASE}${params ? `?${params}` : ''}`,
      );
      return {
        items: page.items,
        truncated: page.truncated,
        appliedLimit: page.appliedLimit,
      };
    },
    // ⭐ Enrichment happens on `get` ONLY, not on `list`. The list renders a
    // COUNT of `element_ids` and never the ids themselves, so resolving two
    // directories there would spend two extra reads per page render on labels
    // nothing displays. The tags that DID render uuids live in the detail view.
    get: async (id) => {
      const [item, elements, relationships] = await Promise.all([
        assetFetch<ArchitectureView>(`${BASE}/${encodeURIComponent(id)}`),
        architectureElementTitles(),
        relationshipLabels(),
      ]);
      return withViewContentTitles([item], elements, relationships)[0];
    },
    create: (input) =>
      assetFetch<ArchitectureView>(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    update: (id, input) =>
      assetFetch<ArchitectureView>(`${BASE}/${encodeURIComponent(id)}`, {
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
      { key: 'viewpoint', label: 'Viewpoint' },
      {
        key: 'element_ids',
        label: 'Elements',
        formatter: (v) => (Array.isArray(v) ? String(v.length) : '0'),
      },
      { key: 'version_status', label: 'Status' },
      { key: 'updated_at', label: 'Updated', formatter: (v) => fmtDateOrDash(v) },
    ],
    titleField: 'title',
    subtitleField: 'viewpoint',
    // ⛔ `element_titles` / `relationship_labels` are DELIBERATELY ABSENT, and
    // this is the one of the three architecture manifests where adding "both
    // forms" would be a LIE rather than a fix.
    //
    // Search is a client-side filter over the LOADED LIST PAYLOAD
    // (`AssetList.svelte:192-201` reads `row[k]` on the rows `api.list`
    // returned). `api.list` here deliberately does NOT enrich — the list renders
    // a COUNT of `element_ids` and never the ids, so two extra directory reads
    // per page render would resolve labels nothing displays. The existing case
    // "api.list does NOT read the content directories" pins that. So those two
    // fields are simply not on a list row, and declaring them searchable would
    // add a matcher that can never match: a lying declaration, which is the same
    // defect class as the unasserted comment this whole pass is closing.
    //
    // The raw id arrays ARE on the wire, so THOSE are reachable, and they buy the
    // real capability: paste an element uuid and find every view that contains
    // it. Nothing was removed from this line when the detail view was converted,
    // so there is no prior search ability being restored here — this is the only
    // half of the claim that can be made true on this manifest.
    searchableFields: [
      'title',
      'description',
      'slug',
      'viewpoint',
      'element_ids',
      'relationship_ids',
    ],
    defaultSort: { key: 'updated_at', dir: 'desc' },
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Name', type: 'text' },
          { key: 'description', label: 'Purpose & audience', type: 'longtext' },
          { key: 'slug', label: 'Slug', type: 'text' },
          { key: 'viewpoint', label: 'ArchiMate viewpoint', type: 'text' },
          {
            // Read-back for the field the editor now offers. Declared as a
            // `relation` rather than mirrored through a `project_title`
            // enrichment on `api.get`: `AssetDetail.resolveRelationLabels`
            // already resolves relation fields id→label through the SAME
            // directory the picker reads, which is the idiom
            // `decisions.detail.project_id` and `requirements.detail.project_id`
            // use. Its three architecture siblings enrich instead, but each of
            // them already fetches a directory in `api.get`; this manifest's
            // `api.get` deliberately reads only the element and relationship
            // directories (see the `api.list` note below), and adding a third
            // store read to print one name would spend a request the detail
            // component can answer for free. Degrades to the raw id, never to
            // blank.
            key: 'project_id',
            label: 'Project',
            type: 'relation',
            relationTo: 'projects',
          },
        ],
      },
      {
        // Titles lead; the raw id tags keep exactly one home, underneath, for API
        // use. An id that resolves to nothing appears in BOTH lists — as itself.
        title: 'Contents',
        fields: [
          { key: 'element_titles', label: 'Elements', type: 'tags' },
          { key: 'relationship_labels', label: 'Relationships', type: 'tags' },
          { key: 'element_ids', label: 'Element IDs', type: 'tags' },
          { key: 'relationship_ids', label: 'Relationship IDs', type: 'tags' },
          { key: 'layout_data', label: 'Visualization hints', type: 'json' },
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
          { key: 'description', label: 'Purpose & audience', type: 'longtext' },
          {
            key: 'viewpoint',
            label: 'ArchiMate viewpoint',
            type: 'text',
            required: true,
            helpText: 'e.g. layered, application_cooperation, business_process',
          },
          {
            // The exact idiom its three siblings already use — `elements.ts`,
            // `relationships.ts` and `standards.ts` all declare this field as
            // `type: 'relation', relationTo: 'projects'`. views was the only
            // architecture manifest that did not offer it at all, although
            // `ArchitectureViewIn.project_id` ("Project scope") has always been
            // there, so a view's project scope was both unsettable and — because
            // `AssetEditor` PUTs only the keys in `editor.sections`
            // (`AssetEditor.svelte:318-356`) and upstream nulls the absent ones
            // (`entity_service.py` `EntityService.update`) — erased by any edit.
            //
            // ⭐ ID SPACE: these are fr `projects` ids
            // (`GET /api/projects`), NOT requirements_management `pm_projects`
            // ids. Same answer and same evidence as the three siblings — a view
            // is scoped by the same upstream architecture store those elements
            // and relationships live in, reached through the conformance route
            // (`routes/projects/[id]/governance/+page.svelte` hands an fr project
            // id to `POST /architecture/tools/conformance`). That is why this
            // manifest is in the ratchet's reviewed list and the pm ones are not.
            key: 'project_id',
            label: 'Project',
            type: 'relation',
            relationTo: 'projects',
            helpText:
              'Optional project association. Pick by name, or paste an id. An existing id that matches no project is kept, not cleared.',
          },
        ],
      },
      {
        title: 'Contents',
        fields: [
          {
            // ⛔ STILL `tags`, for the same two missing pieces as
            // `standards.related_principle_ids`: no `architectureElements`
            // directory in `relationDirectory.ts` (not this session's file), and
            // `type: 'relation'` is SCALAR — `RelationPicker.choose()` does
            // `value = opt.id`, so it cannot express a set. Both named in the
            // handoff. The READ side IS fixed — the detail view lists element
            // titles.
            key: 'element_ids',
            label: 'Element IDs',
            type: 'tags',
            helpText: 'Comma-separated element IDs',
          },
          {
            // ⛔ STILL `tags`, same two missing pieces, plus there is no
            // relationship directory either.
            key: 'relationship_ids',
            label: 'Relationship IDs',
            type: 'tags',
            helpText: 'Comma-separated relationship IDs',
          },
          { key: 'layout_data', label: 'Visualization hints', type: 'json' },
        ],
      },
    ],
  },
  // ArchitectureViewOut exposes the five QualityMixin columns.
  quality: {
    kind: 'architectureView',
    label: 'View coherence',
    modifiedField: 'updated_at',
  },
  destructiveActionsRequireConfirm: true,
};
