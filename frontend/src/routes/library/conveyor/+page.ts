import type { PageLoad } from './$types';
import { fetchConveyorTaxonomy, type ConveyorTaxonomy } from '$lib/api/conveyor-taxonomy';

// Client-side load — authFetch needs the Keycloak store.
export const ssr = false;

export interface ConveyorPageData {
  /** null when the catalogue could not be read; `error` then says why. */
  taxonomy: ConveyorTaxonomy | null;
  error: string | null;
}

/** Never rejects: a failed read renders an error state, not SvelteKit's 500 shell. */
export const load: PageLoad = async (): Promise<ConveyorPageData> => {
  try {
    return { taxonomy: await fetchConveyorTaxonomy(), error: null };
  } catch (e) {
    return { taxonomy: null, error: e instanceof Error && e.message ? e.message : 'Unknown error' };
  }
};
