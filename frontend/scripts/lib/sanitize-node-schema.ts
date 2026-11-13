/**
 * scripts/lib/sanitize-node-schema.ts
 *
 * The node-schema manifest is bundled into the PUBLIC frontend. n8n node
 * authors write operator text into `default` and `description` — in-cluster
 * service URLs (`http://fr-backend.fr.svc.cluster.local:8000`), `*.internal`
 * hosts, secret env-var names (`N8N_WEBHOOK_SECRET`) and references to private
 * operator memory files. None of that is the browser's business, and the side
 * panel renders fine without it (a missing default/description is already a
 * supported shape: both fields are optional).
 *
 * Rule: a `default`, `description`, `placeholder` or option `value` STRING
 * (property, nested value, option, or the node's own description) that matches
 * any pattern below is DROPPED, not rewritten — a half-redacted URL is still a
 * topology hint. A leaking `displayName` (a REQUIRED label) falls back to the
 * entry's `name`; if the `name` leaks too, the whole entry is dropped — there is
 * nothing safe left to label it with. Applied at generation time by
 * `bundle-n8n-schemas.ts`.
 *
 * ⚠️ Every string field the manifest carries is covered, not only the two that
 * happened to leak first: the leak test scans the WHOLE serialised manifest, so
 * an option `value: "http://kag.internal:8000"` used to fail that test at
 * bundle time with no sanitizer able to fix it (FR-4).
 */

export const LEAK_PATTERNS: readonly RegExp[] = [
  /svc\.cluster\.local/i,
  // A host under the private `.internal` TLD (`artifacts.internal`,
  // `kag.internal:8000`). Requires the leading dot so the plain English word
  // "internal" is not caught.
  /[a-z0-9-]\.internal\b/i,
  // A Kubernetes service DNS name short of the cluster suffix
  // (`fr-backend.fr.svc`, `kag.kag.svc:8000`).
  /\b[a-z0-9-]+\.[a-z0-9-]+\.svc\b/i,
  // A private / tailnet IPv4 literal: RFC 1918 (10/8, 172.16/12, 192.168/16)
  // and the CGNAT 100.64/10 range Tailscale hands out. Public addresses and
  // loopback are not topology.
  /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/,
  // Secret-bearing env-var names: N8N_WEBHOOK_SECRET, *_API_KEY, *_TOKEN, ...
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CLIENT_SECRET)\b/,
  // References to private operator memory files.
  /\bmemory\b[^\n]{0,80}\.md\b/i,
];

export function leaks(value: unknown): boolean {
  return typeof value === 'string' && LEAK_PATTERNS.some((re) => re.test(value));
}

interface Describable {
  name?: string;
  displayName?: string;
  description?: string;
  placeholder?: unknown;
  default?: unknown;
  value?: unknown;
  options?: Describable[];
  values?: Describable[];
}

/**
 * Return a copy with every leaking string removed, or `null` when the entry's
 * label (`displayName` and `name`) itself leaks and nothing safe can label it.
 */
export function sanitizeEntry<T extends Describable>(p: T): T | null {
  const out = { ...p };
  if (leaks(out.name)) {
    // `name` is the option label / parameter key; a leaking one cannot be
    // shown or referenced safely.
    return null;
  }
  if (leaks(out.displayName)) {
    if (typeof out.name === 'string' && out.name.length > 0) out.displayName = out.name;
    else return null;
  }
  if (leaks(out.description)) delete out.description;
  if (leaks(out.placeholder)) delete out.placeholder;
  if (leaks(out.default)) delete out.default;
  if (leaks(out.value)) delete out.value;
  if (Array.isArray(out.options)) out.options = sanitizeList(out.options);
  if (Array.isArray(out.values)) out.values = sanitizeList(out.values);
  return out;
}

function sanitizeList<T extends Describable>(list: T[]): T[] {
  return list.map(sanitizeEntry).filter((x): x is T => x !== null);
}

export function sanitizeSchema<
  S extends { displayName?: string; description?: string; properties: Describable[] },
>(s: S): S {
  const out = { ...s, properties: sanitizeList(s.properties) };
  if (leaks(out.description)) delete out.description;
  if (leaks(out.displayName)) out.displayName = 'n8n node';
  return out;
}
