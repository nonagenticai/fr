// /documents was a standalone wrapper around <DocumentUploadPanel/> — the SAME
// component /library/kag/documents renders (Knowledge → KAG → "KAG documents",
// formerly the KAG hub's default tab). It had no sidebar row and no in-app link
// ("kept so existing links/bookmarks keep working"), so under the nav standard
// (fr#1331, 2026-10-03) it is a 308 to that route instead of a second, unlisted
// copy of the page. Nothing is lost: upload, job queue and batch status all
// live in the one panel.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/library/kag/documents');
};
