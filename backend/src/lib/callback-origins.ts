// src/lib/callback-origins.ts
//
// Parser for N8N_CALLBACK_ORIGINS (D17). Dependency-free on purpose: config.ts
// validates the env at boot with it, and lib/approval-callback-url.ts (which reads
// config) re-exports it — keeping it here avoids a config <-> lib import cycle.

export interface ParsedOrigins {
  origins: string[];
  errors: string[];
}

/**
 * Parse N8N_CALLBACK_ORIGINS. Each entry must be an absolute http(s) origin —
 * no userinfo, no path (other than `/`), no query, no fragment. Entries are
 * normalised to `URL.origin` (lower-case host, default port dropped).
 */
export function parseCallbackOrigins(raw: string | undefined | null): ParsedOrigins {
  const origins: string[] = [];
  const errors: string[] = [];
  for (const entry of (raw ?? '').split(',').map((e) => e.trim()).filter((e) => e.length > 0)) {
    let u: URL;
    try {
      u = new URL(entry);
    } catch {
      errors.push(`'${entry}' is not an absolute URL`);
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      errors.push(`'${entry}' is not http(s)`);
      continue;
    }
    if (u.username || u.password) {
      errors.push(`'${u.origin}' carries userinfo`);
      continue;
    }
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      errors.push(`'${u.origin}' must be an origin only (no path, query or fragment)`);
      continue;
    }
    if (!origins.includes(u.origin)) origins.push(u.origin);
  }
  return { origins, errors };
}
