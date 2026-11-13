import type { LayoutLoad } from './$types';
import { isKagHost, type ProductMode } from '$lib/product';

// Resolve the product mode from the request host on BOTH server and client so
// the shell renders correctly on first paint (no fr-chrome flash before the
// client corrects). `url.hostname` is the request Host on the server and the
// window host on client navigation. Everything else is the full fr product.
export const load: LayoutLoad = ({ url }) => {
  const product: ProductMode = isKagHost(url.hostname) ? 'kag' : 'fr';
  return { product };
};
