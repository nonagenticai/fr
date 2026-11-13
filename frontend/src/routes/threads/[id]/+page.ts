import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => ({ threadId: params.id });
