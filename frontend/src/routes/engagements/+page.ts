// /engagements was a one-card launcher (plus a one-tab layout) whose only
// destination was the delivery log. The sidebar now links there directly; this
// keeps old links working.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/engagements/deliveries');
};
