import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { isKagHost, KAG_HUB_PATH } from '$lib/product';

// In the KAG product the root is the KAG hub, not the fr tenant home. Redirect
// server-side off the request host so a cold load of kag.nonagentic.ai lands on
// /library/kag without rendering the fr home page first. fr (any other host) is
// unaffected and keeps rendering +page.svelte (the tenant home).
export const load: PageLoad = ({ url }) => {
  if (isKagHost(url.hostname)) {
    throw redirect(307, KAG_HUB_PATH);
  }
};
