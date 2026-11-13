// Architecture standards manifest (control-plane roadmap Phase 4 read +
// Phase 5 CRUD).
//
// Backend route:  backend/src/routes/assets/architecture.ts
// Upstream model: @fr/service-client-requirements StandardOut / StandardIn.

import type { AssetManifest } from '$lib/asset-workspace';
import { assetFetch, assetFetchPage } from '$lib/api/assets';
import { idTitleMap, projectTitles } from './elements';
import { fmtDateOrDash } from '../_fmt';

export interface ArchitectureStandard {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  standard_type: string;
  status?: string;
  compliance_level?: string;
  related_principle_ids?: string[] | null;
  valid_from?: string | null;
  valid_until?: string | null;
  project_id?: string | null;
  version?: string;
  version_status?: string;
  created_at?: string | null;
  updated_at?: string | null;
  // --- ENRICHMENT, not on the wire -----------------------------------------
  /** Project's name, or the project id when it cannot be resolved. */
  project_title?: string;
  /**
   * `related_principle_ids` with each id swapped for the principle's TITLE, and
   * each UNRESOLVED id kept verbatim. Same length as the id array, always — a
   * principle that cannot be resolved must still be visible as a member of the
   * set, or the detail view silently under-reports what the standard relates to.
   */
  related_principle_titles?: string[];
}

const BASE = '/api/assets/architecture/standards';
const PRINCIPLES = '/api/assets/principles';

/**
 * Attach `project_title` / `related_principle_titles`.
 *
 * ⚠️ `related_principle_titles` is set whenever the ID ARRAY is present, even if
 * nothing resolved, so the field's presence tracks the data and not the success
 * of a secondary read. A standard with no related principles keeps the field
 * absent and renders `'—'`.
 */
export function withStandardTitles(
  rows: ArchitectureStandard[],
  principles: Map<string, string>,
  projects: Map<string, string>,
): ArchitectureStandard[] {
  return rows.map((s) => {
    const projectId = s.project_id == null ? '' : String(s.project_id).trim();
    const ids = Array.isArray(s.related_principle_ids) ? s.related_principle_ids : null;
    return {
      ...s,
      ...(projectId ? { project_title: projects.get(projectId) ?? projectId } : {}),
      ...(ids
        ? {
            related_principle_titles: ids.map((raw) => {
              const id = raw == null ? '' : String(raw).trim();
              return principles.get(id) ?? id;
            }),
          }
        : {}),
    };
  });
}

export const architectureStandardsManifest: AssetManifest<ArchitectureStandard> = {
  name: 'library/architecture/standards',
  singular: 'Standard',
  plural: 'Standards',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const [page, principles, projects] = await Promise.all([
        assetFetchPage<ArchitectureStandard[]>(`${BASE}${params ? `?${params}` : ''}`),
        idTitleMap(PRINCIPLES),
        projectTitles(),
      ]);
      return {
        items: withStandardTitles(page.items ?? [], principles, projects),
        truncated: page.truncated,
        appliedLimit: page.appliedLimit,
      };
    },
    get: async (id) => {
      const [item, principles, projects] = await Promise.all([
        assetFetch<ArchitectureStandard>(`${BASE}/${encodeURIComponent(id)}`),
        idTitleMap(PRINCIPLES),
        projectTitles(),
      ]);
      return withStandardTitles([item], principles, projects)[0];
    },
    create: (input) =>
      assetFetch<ArchitectureStandard>(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    update: (id, input) =>
      assetFetch<ArchitectureStandard>(`${BASE}/${encodeURIComponent(id)}`, {
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
      { key: 'standard_type', label: 'Type' },
      { key: 'compliance_level', label: 'Compliance' },
      { key: 'status', label: 'Status' },
      { key: 'updated_at', label: 'Updated', formatter: (v) => fmtDateOrDash(v) },
    ],
    titleField: 'title',
    subtitleField: 'standard_type',
    // BOTH forms, the way `relationships.ts` already does it — see the same note
    // on `elements.ts`. `api.list` runs `withStandardTitles` over the page, so
    // `project_title` and `related_principle_titles` are ON the list rows and the
    // client-side filter (`AssetList.svelte:192-201`) can reach them.
    // `String(array)` comma-joins, so a member title matches inside the array.
    searchableFields: [
      'title',
      'description',
      'slug',
      'standard_type',
      'project_title',
      'related_principle_titles',
      'project_id',
      'related_principle_ids',
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
          { key: 'standard_type', label: 'Standard type', type: 'text' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'compliance_level', label: 'Compliance level', type: 'text' },
        ],
      },
      {
        // Principle TITLES and the project NAME lead; the raw ids keep exactly
        // one home, underneath, for API use.
        title: 'Applicability',
        fields: [
          {
            key: 'related_principle_titles',
            label: 'Related principles',
            type: 'tags',
          },
          { key: 'valid_from', label: 'Effective', type: 'text', formatter: fmtDateOrDash },
          { key: 'valid_until', label: 'Expires', type: 'text', formatter: fmtDateOrDash },
          { key: 'project_title', label: 'Project', type: 'text' },
          { key: 'related_principle_ids', label: 'Related principle IDs', type: 'tags' },
          { key: 'project_id', label: 'Project ID', type: 'text' },
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
            // Pick by NAME. Directory is `GET /api/projects`; see `elements.ts`'s
            // `projectTitles()` for why that is this field's namespace.
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
            key: 'standard_type',
            label: 'Standard type',
            type: 'text',
            required: true,
            helpText: 'e.g. technology, security, coding, integration',
          },
          {
            key: 'status',
            label: 'Tech-radar status',
            type: 'text',
            helpText: 'e.g. adopt, trial, assess, hold',
          },
          {
            key: 'compliance_level',
            label: 'Compliance level',
            type: 'text',
            helpText: 'e.g. mandatory, recommended, optional',
          },
        ],
      },
      {
        title: 'Applicability',
        fields: [
          {
            // ⛔ STILL `tags`, and it needs TWO things this session cannot add:
            // (1) a `principles` directory in `relationDirectory.ts` (not this
            // session's file), and (2) a MULTI-valued relation field —
            // `RelationPicker.choose()` does `value = opt.id`, a scalar write, so
            // `type: 'relation'` cannot express a set at all. Both are named in
            // the handoff. The READ side IS fixed: the detail view lists principle
            // TITLES.
            key: 'related_principle_ids',
            label: 'Related principles',
            type: 'tags',
            helpText: 'Comma-separated principle IDs',
          },
          { key: 'valid_from', label: 'Effective date', type: 'date' },
          { key: 'valid_until', label: 'Expiry date', type: 'date' },
        ],
      },
    ],
  },
  destructiveActionsRequireConfirm: true,
};
