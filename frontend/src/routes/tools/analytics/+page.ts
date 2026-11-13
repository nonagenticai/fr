import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Operator analytics was re-homed to /measure during the /tools dissolution
// (control-plane roadmap Phase 3), the precursor to the T/I/OE dashboard.
// 308 keeps old deep links working.
export const load: PageLoad = () => {
  throw redirect(308, '/measure');
};
