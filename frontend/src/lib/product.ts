// src/lib/product.ts
//
// Product-mode signal. ONE fr-frontend image serves two products:
//   - fr  (fr.nonagentic.ai)  — the full control-plane surface.
//   - kag (kag.nonagentic.ai) — a license-gated KAG ingest/query/research
//                               subset, served by the SAME image.
//
// The authoritative signal is the REQUEST HOST (resolved client-side from
// window.location.hostname) — it needs no rebuild and is the same signal that
// drives the per-host Keycloak client (see services/keycloak.ts). During SSR
// (no window) we fall back to a build-time hint, defaulting to 'fr', so the
// server-rendered shell is the harmless fr default and the client corrects on
// hydration. Keep this list data-driven so staging/preview hosts are explicit.

export type ProductMode = 'fr' | 'kag';

/** Hosts served as the KAG product. Add staging/preview hosts here. */
export const KAG_HOSTS: ReadonlySet<string> = new Set(['kag.nonagentic.ai']);

/** The Keycloak client used when serving the KAG product. */
export const KAG_KEYCLOAK_CLIENT_ID = 'kag-frontend';

/** True when `hostname` is a KAG product host. Single source for the host list. */
export function isKagHost(hostname: string | null | undefined): boolean {
  return !!hostname && KAG_HOSTS.has(hostname);
}

/** Resolve the current product mode. Host is authoritative; env is SSR fallback. */
export function productMode(): ProductMode {
  if (typeof window !== 'undefined' && isKagHost(window.location.hostname)) {
    return 'kag';
  }
  const hint = import.meta.env.VITE_PRODUCT_MODE as ProductMode | undefined;
  return hint === 'kag' ? 'kag' : 'fr';
}

export function isKag(): boolean {
  return productMode() === 'kag';
}

// The route surface a KAG user may reach. Everything else is redirected to the
// hub in kag mode (the backend license gate is the real control; this just
// keeps stray fr pages — which would query an empty kag_frontend DB — out of
// the product). '/' redirects here via routes/+page.ts. ⚠️ The FIRST REAL KAG
// page, not /library/kag: that is a 308 stub now (nav standard 2026-10-03), so
// pointing here at it made a KAG-host root visit two redirects deep.
export const KAG_HUB_PATH = '/library/kag/documents';
const KAG_ALLOWED_PREFIXES: readonly string[] = [
  '/library/kag',
  '/library/research',
  '/settings',
  '/license-upgrade',
  '/login',
];

/** Is `path` part of the KAG product surface (so kag mode should NOT bounce it)? */
export function isKagAllowedPath(path: string): boolean {
  if (path === '/') return true; // root redirects to the hub
  return KAG_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
