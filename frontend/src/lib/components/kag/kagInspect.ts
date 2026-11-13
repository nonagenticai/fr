// kagInspect.ts
// =============
// Pure, framework-free helpers for the KAG "Copy as API / n8n" inspector (P3-D4).
// Given the exact gateway call a surface made ({ method, path, body }), produce a
// reproducible curl and — when one genuinely exists — the equivalent n8n node
// operation. The KAG n8n node (`@nonagentic/n8n-nodes-kag.kag`) has NO `ask`
// operation (RAG answer-composition is a gateway/fr concern), so we map only the
// operations that really exist and are honest about the ones that don't, rather
// than inventing a node operation the catalog does not offer.

export interface GatewayCall {
  method: string;
  /** fr BFF path, e.g. `/api/assets/kag/ask`. */
  path: string;
  body?: unknown;
}

/** The KAG n8n node operation a call maps to, or null when there is no direct one. */
export interface N8nEquivalent {
  node: string;
  resource: string;
  operation: string;
}

const KAG_NODE = '@nonagentic/n8n-nodes-kag.kag';

/**
 * Map a KAG BFF call to the KAG n8n node operation that performs the same thing,
 * keyed on the call's path (each surface uses a distinct BFF path). Returns null
 * when the catalog has no matching operation — notably a RAG `/ask`, which
 * composes an answer over retrieval and has no single node operation.
 */
export function n8nEquivalent(call: GatewayCall): N8nEquivalent | null {
  const p = call.path;
  if (p.endsWith('/kag/search')) {
    return { node: KAG_NODE, resource: 'query', operation: 'semanticSearch' };
  }
  if (p.endsWith('/kag/hierarchical-retrieval')) {
    return { node: KAG_NODE, resource: 'query', operation: 'hierarchicalRetrieval' };
  }
  // `/kag/ask` (RAG) and anything else: no single node operation.
  return null;
}

/** JSON body, pretty-printed; empty string when there is no body. */
export function prettyBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

/**
 * A reproducible curl for the call. The path is left relative to the fr origin —
 * the caller runs it against their own `https://fr.<host>` — and a note reminds
 * that fr applies auth (session cookie / license) server-side, so a raw curl
 * needs the caller's own credentials. Single-quoted body is shell-safe (inner
 * single quotes are escaped).
 */
export function toCurl(call: GatewayCall): string {
  const parts = [`curl -X ${call.method.toUpperCase()} '${call.path}'`];
  if (call.body !== undefined && call.body !== null) {
    parts.push(`  -H 'content-type: application/json'`);
    const json = prettyBody(call.body);
    parts.push(`  -d '${json.replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(' \\\n');
}
