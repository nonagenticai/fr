import type { PageLoad } from './$types';

// No-op load — access is gated IN the component ($effect after auth.isLoading),
// never in load(): a getSuperAdminStatus() probe here races auth.initialize()
// and 401s genuine super-admins on a cold reload (mirrors the super-admin page).
export const load: PageLoad = async () => ({});
