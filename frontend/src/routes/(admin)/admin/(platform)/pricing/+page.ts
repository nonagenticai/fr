// /admin/pricing — render skeleton; the in-component $effect gates on
// super-admin after auth hydrates (same pattern as the super-admin page, which
// avoids the cold-reload race where authFetch runs before auth.token is set).

import type { PageLoad } from './$types';

export const load: PageLoad = async () => ({});
