// /projects/[id]/assets — formerly the "Assets (5D)" Inspect page: a tab
// button strip (Principles / Requirements / Decisions) over
// ProjectLibraryTab, plus an "Open full editor →" link to
// /projects/[id]/library/<kind>. That library route renders the SAME
// ProjectLibraryTab for the same kind (list + create/edit/unbind), so it is a
// superset: the tab strip was a menu inside a page duplicating four project
// Library rows (validator A1, nav standard 2026-10-03). Redirect-only now —
// 308 to the first kind, or to the kind a legacy `?tab=` names (slug or the
// singular AssetKind). The tabs were local state, never URL-driven, so the
// mapping is belt-and-braces for hand-typed links.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const KINDS = ['principles', 'requirements', 'decisions'] as const;

function tabs(projectId: string): LegacyTabMap {
  const base = `/projects/${encodeURIComponent(projectId)}/library`;
  return KINDS.flatMap((k) => [
    [k, `${base}/${k}`] as const,
    [k.slice(0, -1), `${base}/${k}`] as const,
  ]);
}

export const load: PageLoad = ({ params, url }) => {
  throw redirect(308, legacyTabTarget(url, tabs(params.id)));
};
