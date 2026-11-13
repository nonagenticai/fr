// lib/manifests/principles.ts
//
// AssetManifest for the `principles` knowledge asset. Drives the generic
// AssetWorkspace UI (list / detail / new / edit) for /principles routes.
//
// Backend canonical shape: PrincipleOut (packages/service-clients/requirements
// /src/generated/models/principleOut.ts). The longtext "body" of a principle
// is the `statement` field — not literally `body`. We keep the per-asset
// notes' intent (longtext for the principle body) and adjust the field name
// to the actual backend response.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 6 Tasks 6.3–6.9.

import type { AssetManifest } from '$lib/asset-workspace';
import type { QualityColumns } from '$lib/api/quality';
import { assetFetch, assetFetchPage } from '$lib/api/assets';

export interface Principle extends QualityColumns {
  id: string;
  slug?: string;
  title: string;
  statement: string;
  rationale?: string | null;
  implications?: string[];
  tags?: string[];
  active?: boolean;
  version?: string;
  version_status?: string;
  supersedes?: string | null;
  superseded_by?: string | null;
  version_notes?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  published_at?: string | null;
  creator_id?: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export const principlesManifest: AssetManifest<Principle> = {
  name: 'principles',
  singular: 'Principle',
  plural: 'Principles',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const page = await assetFetchPage<Principle[]>(
        `/api/assets/principles${params ? `?${params}` : ''}`,
      );
      return {
        items: page.items,
        truncated: page.truncated,
        appliedLimit: page.appliedLimit,
      };
    },
    get: (id) =>
      assetFetch<Principle>(`/api/assets/principles/${encodeURIComponent(id)}`),
    create: (input) =>
      assetFetch<Principle>('/api/assets/principles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    update: (id, input) =>
      assetFetch<Principle>(
        `/api/assets/principles/${encodeURIComponent(id)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    remove: (id) =>
      assetFetch<void>(`/api/assets/principles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },
  list: {
    columns: [
      { key: 'title', label: 'Title', width: '24rem' },
      // ⛔ `{ key: 'id', label: 'ID' }` used to sit HERE, in the second column,
      // directly beside the title it duplicates the identity of. A uuid is not a
      // column a human reads — it was the widest cell on the page and told the
      // reader nothing the row's own link does not already carry. Removed, not
      // moved: the id still reaches every operator who needs it through the
      // detail route's URL, and `searchableFields` below keeps it MATCHABLE so
      // pasting a uuid from a sibling surface still finds the row.
      //
      // ⚠️ NOT replaced by `slug`. `Principle.slug` is declared `slug?: string`,
      // and an unverified column renders blank for every row — the same reason a
      // sibling session declined `slug` as a subtitle. `version_status` is the
      // candidate if a third column is ever wanted; it is on `PrincipleOut` and
      // already rendered in the detail view.
      { key: 'version', label: 'Version' },
      { key: 'active', label: 'Active', formatter: (v) => (v === false ? 'no' : 'yes') },
    ],
    titleField: 'title',
    // `title` is non-nullable on `PrincipleOut`, but "declared non-nullable" and
    // "never empty in practice" are different claims and only the first is
    // checkable from here. The kag pairing costs one line and makes a row with a
    // blank title render — and stay clickable — as its id instead of as nothing.
    titleFallbackField: 'id',
    searchableFields: ['title', 'statement', 'id'],
    defaultSort: { key: 'title', dir: 'asc' },
    tagsField: 'tags',
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'statement',
            label: 'Statement',
            type: 'longtext',
            required: true,
          },
          { key: 'rationale', label: 'Rationale', type: 'longtext' },
          { key: 'implications', label: 'Implications', type: 'tags' },
          { key: 'tags', label: 'Tags', type: 'tags' },
          { key: 'active', label: 'Active', type: 'boolean' },
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
          { key: 'approved_at', label: 'Approved', type: 'text' },
          { key: 'published_at', label: 'Published', type: 'text' },
          { key: 'created_at', label: 'Created', type: 'text' },
          { key: 'updated_at', label: 'Updated', type: 'text' },
        ],
      },
    ],
  },
  editor: {
    scopePicker: { bindAsKind: 'principle' },
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          {
            key: 'statement',
            label: 'Statement',
            type: 'longtext',
            required: true,
          },
          { key: 'rationale', label: 'Rationale', type: 'longtext' },
          {
            key: 'implications',
            label: 'Implications',
            type: 'tags',
            helpText: 'Comma-separated list',
          },
          {
            key: 'tags',
            label: 'Tags',
            type: 'tags',
            helpText: 'Comma-separated list',
          },
          { key: 'active', label: 'Active', type: 'boolean' },
        ],
      },
    ],
  },
  scope: {
    assetKind: 'principle',
    bindable: true,
    promotable: true,
    overridable: true,
  },
  // PrincipleOut exposes the five QualityMixin columns, so a stored verdict
  // survives a reload and the stale badge can be computed against updated_at.
  quality: {
    kind: 'principle',
    label: 'Description quality',
    modifiedField: 'updated_at',
  },
  destructiveActionsRequireConfirm: true,
};
