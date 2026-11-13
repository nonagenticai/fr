// legacyTabRedirect — the 308 target for a former AssetTabs hub root.
//
// Nav standard (owner ruling 2026-10-03): tab hubs are not exempt from "no menu
// inside a page", so every tab became its own route and sidebar row. The hub
// root (e.g. /library/kag) keeps answering, but only as a 308: to the route of
// the tab its legacy `?tab=<id>` named (bookmarks, notifications and old deep
// links keep working), or to the FIRST kind when there is no / an unknown tab.
// Every other query param rides along (e.g. /govern/architecture's
// ?projectId=&container=), and `tab` itself is dropped — it means nothing on
// the destination.
//
// Pure (no SvelteKit imports) so the per-hub tests can assert the URL.

/** `?tab=<id>` → destination path. The FIRST entry is the default. */
export type LegacyTabMap = readonly (readonly [tabId: string, path: string])[];

export function legacyTabTarget(url: URL, map: LegacyTabMap): string {
  if (map.length === 0) throw new Error('legacyTabTarget: empty tab map');
  const tab = url.searchParams.get('tab');
  const hit = tab === null ? undefined : map.find(([id]) => id === tab);
  const path = (hit ?? map[0]!)[1];
  const rest = new URLSearchParams(url.searchParams);
  rest.delete('tab');
  const qs = rest.toString();
  return qs ? `${path}?${qs}` : path;
}
