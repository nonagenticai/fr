// Requirements manifest for AssetWorkspace.
//
// Backend route: backend/src/routes/assets/requirements.ts
// Upstream model: @fr/service-client-requirements RequirementOut / RequirementIn.
//
// Field-name convention: snake_case throughout — the backend response uses
// snake_case (`created_at`, `updated_at`, `project_id`, `version_status`)
// and we pass it through unchanged to keep `assetFetch` envelopes verbatim.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 6 Task 6.x.

import type { AssetManifest } from '$lib/asset-workspace';
import { assetFetch, assetFetchPage } from '$lib/api/assets';

export interface Requirement {
  id: string;
  slug?: string;
  title: string;
  description: string;
  project_id?: string | null;
  effort: number;
  reach?: number;
  impact?: number;
  confidence?: number;
  acceptance?: string[];
  links?: Record<string, string[]> | null;
  version?: string;
  version_status?: string;
  version_notes?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // CLR (Categories of Legitimate Reservation) quality, from RM's QualityMixin.
  // Surfaced on the detail page via AssetClrPanel.
  quality_score?: number | null;
  quality_issues?: string[] | null;
  quality_suggestions?: string[] | null;
}

function fmtDate(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export const requirementsManifest: AssetManifest<Requirement> = {
  name: 'requirements',
  singular: 'Requirement',
  plural: 'Requirements',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const page = await assetFetchPage<Requirement[]>(
        `/api/assets/requirements${params ? `?${params}` : ''}`,
      );
      return {
        items: page.items,
        truncated: page.truncated,
        appliedLimit: page.appliedLimit,
      };
    },
    get: (id) =>
      assetFetch<Requirement>(
        `/api/assets/requirements/${encodeURIComponent(id)}`,
      ),
    create: (input) =>
      assetFetch<Requirement>('/api/assets/requirements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    update: (id, input) =>
      assetFetch<Requirement>(
        `/api/assets/requirements/${encodeURIComponent(id)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    remove: (id) =>
      assetFetch<void>(
        `/api/assets/requirements/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
  },
  list: {
    columns: [
      { key: 'title', label: 'Title', width: '24rem' },
      { key: 'version_status', label: 'Status' },
      { key: 'effort', label: 'Effort' },
      {
        key: 'updated_at',
        label: 'Updated',
        formatter: (v) => fmtDate(v),
      },
    ],
    titleField: 'title',
    // Was `'id'` — a uuid under the heading of a row that already has a title.
    // The subtitle is the one line a human reads to tell two similarly-titled
    // rows apart, and a uuid tells them nothing; the lifecycle state does.
    // Same shape as the sibling manifests (projects → `status`, risks →
    // `category`, standards → `standard_type`). The id stays reachable in the
    // URL and in search (`searchableFields` still carries it).
    subtitleField: 'version_status',
    searchableFields: ['title', 'description', 'id'],
    defaultSort: { key: 'updated_at', dir: 'desc' },
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'description',
            label: 'Description',
            type: 'longtext',
            required: true,
          },
          {
            key: 'project_id',
            label: 'Project',
            // `type: 'relation'` — the picker offers PROJECT NAMES and stores
            // the id. It was `type: 'text'` labelled "Project ID", which asked
            // a human to type a uuid from memory. The directory is
            // `GET /api/projects` (263 rows, 263 named), NOT the
            // `library/pm/projects` manifest — a different upstream store whose
            // ids do not resolve here.
            type: 'relation',
            relationTo: 'projects',
            helpText:
              'Optional project association. Pick by name, or paste an id. An existing id that matches no project is kept, not cleared.',
          },
        ],
      },
      {
        title: 'Prioritization',
        fields: [
          {
            key: 'effort',
            label: 'Effort',
            type: 'number',
            required: true,
            helpText: 'Estimate (>0)',
          },
          { key: 'reach', label: 'Reach', type: 'number' },
          { key: 'impact', label: 'Impact', type: 'number' },
          {
            key: 'confidence',
            label: 'Confidence',
            type: 'number',
            helpText: '0–1',
          },
        ],
      },
      {
        title: 'Acceptance',
        fields: [
          {
            key: 'acceptance',
            label: 'Acceptance criteria',
            type: 'tags',
            helpText: 'Comma-separated list of criteria',
          },
        ],
      },
      {
        title: 'Traceability',
        fields: [
          {
            key: 'links',
            label: 'Trace links',
            type: 'json',
            helpText: 'Linked assets by relationship type.',
          },
        ],
      },
      {
        title: 'Versioning',
        fields: [
          { key: 'version', label: 'Version', type: 'text' },
          { key: 'version_status', label: 'Status', type: 'text' },
          { key: 'version_notes', label: 'Version notes', type: 'longtext' },
          { key: 'supersedes', label: 'Supersedes', type: 'text' },
          { key: 'superseded_by', label: 'Superseded by', type: 'text' },
          { key: 'approved_by', label: 'Approved by', type: 'text' },
          {
            key: 'approved_at',
            label: 'Approved',
            type: 'text',
            formatter: (v) => fmtDate(v) || '—',
          },
          {
            key: 'published_at',
            label: 'Published',
            type: 'text',
            formatter: (v) => fmtDate(v) || '—',
          },
          {
            key: 'created_at',
            label: 'Created',
            type: 'text',
            formatter: (v) => fmtDate(v) || '—',
          },
          {
            key: 'updated_at',
            label: 'Updated',
            type: 'text',
            formatter: (v) => fmtDate(v) || '—',
          },
        ],
      },
    ],
  },
  editor: {
    // Explicit editable sections — keeps the Versioning spine out of the
    // create/edit form. The scope picker auto-binds the new requirement to a
    // project at create time — bound_assets are how n8n sees scope.
    //
    // ⚠️ This comment used to say "read-only Traceability/Versioning". Only half
    // of that was true. `links` is a plain writable key of `RequirementIn`
    // ("Trace links (business_objectives, capabilities, services)"), and because
    // `AssetEditor` builds its PUT body from `editor.sections` alone
    // (`AssetEditor.svelte:318-356`) while upstream replaces an absent key with
    // `null` (`entity_service.py` `EntityService.update`), every edit of a requirement DELETED
    // its entire traceability map. On a manifest whose own detail page renders a
    // "Traceability" section, and whose sibling panel exists to answer "what does
    // this trace to", that is the worst possible field to have dropped.
    //
    // ⛔ Versioning genuinely stays out: `supersedes`, `superseded_by`,
    // `approved_by`, `approved_at`, `published_at`, `version_status`,
    // `version_notes` and `version` are attestations upstream manages. They must
    // be PRESERVED by the backend, never typed in here.
    scopePicker: { bindAsKind: 'requirement' },
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'description',
            label: 'Description',
            type: 'longtext',
            required: true,
          },
          {
            key: 'project_id',
            label: 'Project',
            // `type: 'relation'` — the picker offers PROJECT NAMES and stores
            // the id. It was `type: 'text'` labelled "Project ID", which asked
            // a human to type a uuid from memory. The directory is
            // `GET /api/projects` (263 rows, 263 named), NOT the
            // `library/pm/projects` manifest — a different upstream store whose
            // ids do not resolve here.
            type: 'relation',
            relationTo: 'projects',
            helpText:
              'Optional project association. Pick by name, or paste an id. An existing id that matches no project is kept, not cleared.',
          },
        ],
      },
      {
        title: 'Prioritization',
        fields: [
          {
            key: 'effort',
            label: 'Effort',
            type: 'number',
            required: true,
            helpText: 'Estimate (>0)',
          },
          { key: 'reach', label: 'Reach', type: 'number' },
          { key: 'impact', label: 'Impact', type: 'number' },
          {
            key: 'confidence',
            label: 'Confidence',
            type: 'number',
            helpText: '0–1',
          },
        ],
      },
      {
        title: 'Acceptance',
        fields: [
          {
            key: 'acceptance',
            label: 'Acceptance criteria',
            type: 'tags',
            helpText: 'Comma-separated list of criteria',
          },
        ],
      },
      {
        title: 'Traceability',
        fields: [
          {
            // `type: 'json'`, SAME control and same label as the detail view's
            // Traceability entry, because the shape genuinely is an object:
            // `RequirementInLinks` is `{[key: string]: string[]}` — an open map
            // of relationship type → ids, with no fixed keys to build a form
            // from. The existing field-type vocabulary already covers exactly
            // this (`architecture/views.layout_data`, `secrets.env_vars`), so no
            // new widget is needed or invented.
            //
            // ⚠️ `json` is the honest control here, not a lazy one. `tags` is a
            // `string[]`, which cannot carry the relationship-type key; an
            // `objectArray` repeater needs FIXED `itemFields`, and the one thing
            // this schema does not fix is its keys.
            key: 'links',
            label: 'Trace links',
            type: 'json',
            helpText:
              'Linked assets by relationship type, e.g. ' +
              '{"business_objectives": ["<id>"], "capabilities": [], "services": []}',
            // The ONE thing certain from the schema, so it belongs in the
            // BLOCKING pre-flight rather than in `advise`: every value is an
            // array of strings. `{"capabilities": "cap-1"}` is valid JSON, parses
            // without complaint, and is refused upstream with a 422 the form
            // would surface as an opaque error. Nullable/absent passes — the
            // field is optional and an empty textarea sets `null`
            // (`AssetEditor.onJsonBlur`).
            validate: (v) => {
              if (v == null) return null;
              if (typeof v !== 'object' || Array.isArray(v)) {
                return 'must be a JSON object keyed by relationship type';
              }
              for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
                if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
                  return `"${k}" must be an array of id strings`;
                }
              }
              return null;
            },
          },
        ],
      },
    ],
  },
  scope: {
    assetKind: 'requirement',
    bindable: true,
    promotable: true,
    overridable: true,
  },
  related: [
    {
      label: 'Decisions in the same project',
      manifest: 'decisions',
      // ⚠️ `assetFetchPage`, not `assetFetch`, for the RESPONSE HEADER — not for
      // a page cap.
      //
      // `assetFetch` discards the `Response`, so `X-Project-Resolved: false`
      // was thrown away here. `backend/src/routes/assets/decisions.ts:136`
      // emits it (via `projectScopeHeaders`, which also merges the header into
      // `Access-Control-Expose-Headers`) whenever `?project_id=` names a
      // project that does not exist: the route then falls back to the workspace
      // set, and this panel read the outcome as "no decisions in this project".
      // For the ~30% of assets whose `project_id` does not resolve, that is a
      // confident negative answer to a question the backend refused to answer.
      //
      // Only `projectResolved` is passed on. `truncated` is deliberately
      // dropped: the related panel has never claimed completeness, and reading
      // the headers for one signal must not smuggle in a second claim.
      fetch: async (row) => {
        const projectId = row.project_id;
        // No filter sent ⇒ nothing to resolve ⇒ assert nothing. `null`, never
        // `false`: an unscoped read did not fail to resolve a project.
        if (!projectId) return { items: [], projectResolved: null };
        const page = await assetFetchPage<unknown[]>(
          `/api/assets/decisions?project_id=${encodeURIComponent(projectId)}`,
        );
        return { items: page.items ?? [], projectResolved: page.projectResolved };
      },
    },
  ],
  destructiveActionsRequireConfirm: true,
};
