// /library/conveyor/catalogue — redirect-only. Nav standard (owner ruling
// 2026-10-03): no tab strip inside a page, so each catalogue section is its own
// route and rail row. 308 to the first section, or to the one `?tab=<slug>` names.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget } from '$lib/nav/legacyTab';
import { CATALOGUE_TAB_MAP } from '$lib/conveyor-catalogue/sections';

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, CATALOGUE_TAB_MAP));
};
