import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The n8n surface was re-homed during the /tools dissolution (control-plane
// roadmap Phase 1) and is now its own route, /executions/n8n (nav standard
// 2026-10-03). 308 keeps old deep links working: the incoming query string is
// preserved (siblings do the same — see tools/bridge). A stale `tab` param is
// dropped: this URL IS the n8n surface, and the destination has no tabs.
export const load: PageLoad = ({ url }) => {
  const params = new URLSearchParams(url.search);
  params.delete('tab');
  const qs = params.toString();
  throw redirect(308, qs ? `/executions/n8n?${qs}` : '/executions/n8n');
};
