// lib/manifests/kag.ts
//
// AssetManifest for KAG entities — the fifth dimension of the AA 5D
// space (Principles · Requirements · Decisions · KAG).
// Backed by `/api/assets/kag/entities` (shipped in W-1 / PR #264) which
// wraps the upstream KAG graph-nodes API into the same list+items
// envelope the four sibling manifests already consume.
//
// Detail: the manifest only declares LIST + GET surfaces; KAG entity
// authoring lives upstream in n8n's ingest workflows, so create / update
// / remove are omitted (AssetWorkspace hides those actions when absent).
//
// Plan: ~/.claude/plans/plan-is-at-floating-patterson.md Wave B #5.

import type { AssetManifest } from '$lib/asset-workspace';
import { assetFetch } from '$lib/api/assets';
import { readListCount } from '$lib/api/list-count';

export interface KagEntity {
  id: string;
  label?: string | null;
  properties?: Record<string, unknown> | null;
}

/**
 * The list envelope, as read defensively.
 *
 * ⚠️ `total` is typed optional and is NOT consumed directly — see
 * `$lib/api/list-count`. The backend currently computes it as `items.length`,
 * i.e. the length of the page it already returned, so treating it as a count of
 * the whole graph would print "300 of 300" over an arbitrarily large one. The
 * count is only believed when the envelope also states its own truthfulness
 * (`count_kind` / `total_is_exact` / `truncated`), which a parallel backend lane
 * is adding. Until then this reads UNKNOWN, and the UI says "unknown" — never 0,
 * and never a confident total.
 */
interface KagEntitiesEnvelope {
  items: KagEntity[];
  total?: number | null;
  count_kind?: string;
  total_is_exact?: boolean;
  truncated?: boolean;
}

function fmtProperties(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return '';
  // Compact "key=value" tour of the first three properties — full body
  // renders in detail view.
  return entries
    .slice(0, 3)
    .map(([k, val]) => `${k}=${typeof val === 'object' ? JSON.stringify(val) : String(val)}`)
    .join(' · ');
}

/**
 * The human label for a KAG entity, or its id when the graph node carries no
 * label. Same shape as the existing precedent in
 * `components/kag/KagContradictionList.svelte:28` (`target_label ?? target_id`)
 * — resolve to a human string, degrade to the identifier, never to blank.
 */
export function labelOrId(v: unknown, row: KagEntity): string {
  const label = v == null ? '' : String(v).trim();
  if (label) return label;
  return String(row?.id ?? '');
}

export const kagManifest: AssetManifest<KagEntity> = {
  name: 'kag',
  // Item pages are /kag/entities/<id>; the list is the KAG entities rail row
  // (/kag/entities itself is a 308 stub and must not be linked).
  routeBase: '/kag/entities',
  listHref: '/library/kag/entities',
  singular: 'KAG entity',
  plural: 'KAG entities',
  group: 'knowledge',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const env = await assetFetch<KagEntitiesEnvelope>(
        `/api/assets/kag/entities${params ? `?${params}` : ''}`,
      );
      const items = env.items ?? [];
      // ⛔ `return { items }` alone DISCARDED the envelope's count, so a capped
      // page and a complete one rendered identically. AssetList's
      // `asset-list-truncated` banner is driven by exactly these two fields;
      // omitting them is what kept it from ever firing on this manifest.
      const count = readListCount(env, items.length);
      return {
        items,
        truncated: count.kind === 'at_least',
        // The cap the SOURCE applied, when it stated one. `null` when it did
        // not — the banner then says "capped" without inventing a number.
        appliedLimit: count.kind === 'at_least' ? count.total : null,
      };
    },
    get: async (id) => {
      // KAG graph-node detail lives at /api/assets/kag/graph/nodes/:id —
      // wrap into the manifest's expected `KagEntity` shape. The handler
      // returns the upstream node JSON under `data`.
      const node = await assetFetch<KagEntity>(
        `/api/assets/kag/graph/nodes/${encodeURIComponent(id)}`,
      );
      return node;
    },
  },
  list: {
    // Label FIRST, and it is the title column, so AssetList links the human
    // label rather than the uuid. `titleField` used to be `id`, which put a
    // uuid in the <h1> of every KAG entity detail page and demoted the label a
    // human would actually recognise to the subtitle.
    columns: [
      {
        key: 'label',
        label: 'Label',
        width: '20rem',
        // The title column is also the ROW LINK, so an empty cell is an
        // unclickable-looking blank link, not merely a missing word. A row with
        // no label falls back to its id here for the same reason AssetDetail
        // falls back for the heading: something identifying always renders.
        formatter: (v, row) => labelOrId(v, row),
      },
      { key: 'id', label: 'ID', width: '18rem' },
      {
        key: 'properties',
        label: 'Properties',
        formatter: (v) => fmtProperties(v),
      },
    ],
    titleField: 'label',
    // `label` is `string | null` upstream — KAG ingest does not guarantee one.
    // Without this the swap above would trade "always a uuid" for "sometimes
    // blank", which is not an improvement.
    titleFallbackField: 'id',
    subtitleField: 'id',
    searchableFields: ['id', 'label'],
    defaultSort: { key: 'id', dir: 'asc' },
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'id', label: 'ID', type: 'text' },
          { key: 'label', label: 'Label', type: 'text' },
        ],
      },
      {
        title: 'Properties',
        fields: [
          { key: 'properties', label: 'Properties', type: 'json' },
        ],
      },
    ],
  },
  destructiveActionsRequireConfirm: false,
};
