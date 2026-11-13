// Decisions manifest for AssetWorkspace.
//
// Backend route: backend/src/routes/assets/decisions.ts
// Upstream model: @fr/service-client-requirements DecisionOut / DecisionIn.
//
// Field-name convention: snake_case throughout — the backend response uses
// snake_case (`created_at`, `updated_at`, `project_id`, `version_status`)
// and we pass it through unchanged to keep `assetFetch` envelopes verbatim.
//
// The plan's per-asset table called the rationale field `rationale`, but the
// upstream Requirements API names the same concept `decision` (with `context`
// providing the surrounding narrative). Both are longtext; both participate
// in search. We surface them under the labels users expect from an ADR
// (Context / Decision / Consequences / Alternatives) and keep the wire shape
// unchanged.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 6, decisions row.

import type { AssetManifest } from '$lib/asset-workspace';
import type { QualityColumns } from '$lib/api/quality';
import { assetFetch, assetFetchPage } from '$lib/api/assets';

export interface Decision extends QualityColumns {
  id: string;
  slug?: string;
  title: string;
  context: string;
  decision: string;
  consequences?: string | null;
  alternatives?: string[];
  status?: string;
  project_id?: string | null;
  related_principles?: string[];
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

const STATUS_OPTIONS = [
  { value: 'proposed', label: 'proposed' },
  { value: 'accepted', label: 'accepted' },
  { value: 'deprecated', label: 'deprecated' },
  { value: 'superseded', label: 'superseded' },
];

export const decisionsManifest: AssetManifest<Decision> = {
  name: 'decisions',
  singular: 'Decision',
  plural: 'Decisions',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const page = await assetFetchPage<Decision[]>(
        `/api/assets/decisions${params ? `?${params}` : ''}`,
      );
      return {
        items: page.items,
        truncated: page.truncated,
        appliedLimit: page.appliedLimit,
      };
    },
    get: (id) =>
      assetFetch<Decision>(`/api/assets/decisions/${encodeURIComponent(id)}`),
    create: (input) =>
      assetFetch<Decision>('/api/assets/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    update: (id, input) =>
      assetFetch<Decision>(`/api/assets/decisions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    remove: (id) =>
      assetFetch<void>(`/api/assets/decisions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },
  list: {
    columns: [
      { key: 'title', label: 'Title', width: '24rem' },
      { key: 'status', label: 'Status' },
      { key: 'version_status', label: 'Version' },
      {
        key: 'updated_at',
        label: 'Updated',
        formatter: (v) => fmtDate(v),
      },
    ],
    titleField: 'title',
    // Was `'id'` — a uuid under the heading of a row that already has a title.
    // An ADR's status (proposed / accepted / superseded) is what a reader needs
    // beside the title; the uuid is not something a human recognises. Matches
    // the sibling manifests (projects → `status`). The id stays in the URL.
    subtitleField: 'status',
    // Plan says ['title','rationale']; the upstream "rationale" lives in the
    // `decision` longtext field, with surrounding narrative in `context`.
    // Searching across both keeps the original UX (which also matched on
    // context + decision) while honouring the plan's intent.
    searchableFields: ['title', 'decision', 'context'],
    defaultSort: { key: 'updated_at', dir: 'desc' },
    // UI review 2026-10-07: status facet + same-title collapse (×N).
    statusFilterField: 'status',
    groupDuplicateTitles: true,
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            options: STATUS_OPTIONS,
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
        title: 'Rationale',
        fields: [
          {
            key: 'context',
            label: 'Context',
            type: 'longtext',
            required: true,
            helpText: 'Forces at play that motivate this decision',
          },
          {
            key: 'decision',
            label: 'Decision',
            type: 'longtext',
            required: true,
            helpText: 'The chosen position and rationale',
          },
          {
            key: 'consequences',
            label: 'Consequences',
            type: 'longtext',
            helpText: 'Resulting context after this decision',
          },
          {
            key: 'alternatives',
            label: 'Alternatives',
            type: 'tags',
            helpText: 'Comma-separated list of alternatives considered',
          },
          {
            key: 'related_principles',
            label: 'Related principles',
            type: 'tags',
            helpText: 'Principles that govern this decision',
          },
        ],
      },
      {
        title: 'Versioning',
        fields: [
          { key: 'version', label: 'Version', type: 'text' },
          { key: 'version_status', label: 'Version status', type: 'text' },
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
    // create/edit form.
    //
    // ⚠️ `related_principles` used to be excluded here and the comment called it
    // "read-only". It is not: it is a plain writable key of `DecisionIn`
    // ("Related principle IDs"). Calling it read-only was not a harmless
    // mislabel — `AssetEditor` builds its PUT body from `editor.sections` alone
    // (`AssetEditor.svelte:318-356`) and upstream replaces an absent key with
    // `null` (`entity_service.py` `EntityService.update`), so every edit of a decision WIPED
    // whatever principles it was linked to. An ADR that silently forgets which
    // principles govern it is the one field on this manifest that the decision
    // quality judge scores (the "principles link" ADR-structure boolean).
    //
    // ⛔ The Versioning fields stay out, and for the OPPOSITE reason: those are
    // attestations (`supersedes`, `superseded_by`, `approved_by`, `approved_at`,
    // `published_at`, `version_status`, `version_notes`, `version`) that
    // upstream manages. A text box for `approved_by` manufactures an approval.
    // They must be PRESERVED by the backend, never exposed here.
    scopePicker: { bindAsKind: 'decision' },
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            options: STATUS_OPTIONS,
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
        title: 'Rationale',
        fields: [
          {
            key: 'context',
            label: 'Context',
            type: 'longtext',
            required: true,
            helpText: 'Forces at play that motivate this decision',
          },
          {
            key: 'decision',
            label: 'Decision',
            type: 'longtext',
            required: true,
            helpText: 'The chosen position and rationale',
          },
          {
            key: 'consequences',
            label: 'Consequences',
            type: 'longtext',
            helpText: 'Resulting context after this decision',
          },
          {
            key: 'alternatives',
            label: 'Alternatives',
            type: 'tags',
            helpText: 'Comma-separated list of alternatives considered',
          },
          {
            // ⛔ STILL `tags`, the same control and for the same two missing
            // pieces as `architecture/standards.related_principle_ids`: there is
            // no `principles` directory in `relationDirectory.ts`, and
            // `type: 'relation'` is SCALAR (`RelationPicker.choose()` does
            // `value = opt.id`), so it cannot express a set at all. A picker is
            // the right end state; `tags` is the control that exists today and
            // the only one that can hold a `string[]`.
            //
            // ⚠️ Unlike standards, the READ side is NOT fixed here either: this
            // manifest has no principle-title enrichment, so the detail view
            // prints the raw ids. That is a smaller defect than the one being
            // closed (ids shown versus links destroyed) and is left standing
            // deliberately rather than widened into.
            key: 'related_principles',
            label: 'Related principles',
            type: 'tags',
            helpText: 'Comma-separated principle IDs that govern this decision',
          },
        ],
      },
    ],
  },
  scope: {
    assetKind: 'decision',
    bindable: true,
    promotable: true,
    overridable: true,
  },
  related: [
    {
      label: 'Requirements in the same project',
      manifest: 'requirements',
      // ⚠️ `assetFetchPage`, not `assetFetch`, for the RESPONSE HEADER — not for
      // a page cap. Mirror of the same fix in `requirements.ts`; the emitter
      // here is `backend/src/routes/assets/requirements.ts:142`. `assetFetch`
      // discards the `Response`, so `X-Project-Resolved: false` — the route
      // saying "that project does not exist, this is the workspace set" — was
      // dropped, and the panel reported it as "no requirements in this project".
      // Only `projectResolved` is threaded on; `truncated` stays dropped so the
      // panel gains no completeness claim it cannot support.
      fetch: async (row) => {
        const projectId = row.project_id;
        // No filter sent ⇒ nothing to resolve ⇒ assert nothing.
        if (!projectId) return { items: [], projectResolved: null };
        const page = await assetFetchPage<unknown[]>(
          `/api/assets/requirements?project_id=${encodeURIComponent(projectId)}`,
        );
        return { items: page.items ?? [], projectResolved: page.projectResolved };
      },
    },
  ],
  // DecisionOut exposes the five QualityMixin columns, so the stored verdict
  // survives a reload.
  quality: {
    kind: 'decision',
    label: 'Decision quality',
    modifiedField: 'updated_at',
  },
  destructiveActionsRequireConfirm: true,
};
