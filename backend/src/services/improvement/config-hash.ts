// src/services/improvement/config-hash.ts
//
// Canonical JSON (recursively key-sorted) for deterministic hashing of config
// bodies. Pure + dependency-free.

/**
 * Canonical JSON: object keys sorted recursively so semantically-equal values
 * serialize identically. Array order is preserved — it is semantic for steps,
 * preconditions, and success criteria.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}
