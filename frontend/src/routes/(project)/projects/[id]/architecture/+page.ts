// /projects/[id]/architecture — the project's Architecture hub (+page.svelte).
//
// Architecture is a first-class part of every project (George, 2026-10-28), so
// this root is a real page now: the conformance verdict, the project's
// ArchiMate / UML models, and the code-graph views. It used to be a 308 to the
// graph (validator A2, 2026-10-03). The legacy `?tab=` links of the old
// ArchitectureView tab strip still land on the view they named; every other
// URL renders the hub.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

function tabs(projectId: string): LegacyTabMap {
  const base = `/projects/${encodeURIComponent(projectId)}/architecture`;
  return [
    ['architecture', `${base}/graph`],
    ['graph', `${base}/graph`],
    ['dependencies', `${base}/dependencies`],
    ['quality', `${base}/quality-gate`],
    ['quality-gate', `${base}/quality-gate`],
  ];
}

export const load: PageLoad = ({ params, url }) => {
  const map = tabs(params.id);
  const tab = url.searchParams.get('tab');
  if (tab !== null && map.some(([id]) => id === tab)) throw redirect(308, legacyTabTarget(url, map));
  return {};
};
