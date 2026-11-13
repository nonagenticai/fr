// src/lib/payload-mapper.ts
//
// Payload-Mapper DSL Contract (Spec 2 Plan 2-B Phase 0)
// ------------------------------------------------------
// Mapper configs are JSONB stored in `scheduled_triggers.payload_mapper`.
// Shape: Record<string, string> where each value is a JSONPath expression.
//
//   - Must start with "$." or "$"
//   - "$.foo.bar"        -> scalar
//   - "$.items[*].id"    -> array (always returned as array, even empty)
//   - "$..title"         -> recursive descent (returns array)
//
// Operators NOT permitted (rejected at compile time by `compileMapper`):
//   - filter expressions   "[?(@.x)]"
//   - script expressions   "[(@.length-1)]"
//
// Why: filter/script expressions can run arbitrary JS at JSONPath eval time;
// rejecting them at config save-time keeps the DSL declarative and audit-friendly.
//
// Results are written into `IntakeEnvelope.mapped` keyed by the mapper config's keys.
//

import { JSONPath } from 'jsonpath-plus';

export type CompiledMapper = (record: unknown) => Record<string, unknown>;

/**
 * Validate a mapper config and return a compiled function.
 * Throws if any path is invalid or uses a forbidden operator.
 * Call at config-save time so invalid configs are rejected before storage.
 */
export function compileMapper(config: Record<string, string>): CompiledMapper {
  for (const [k, v] of Object.entries(config)) {
    if (typeof v !== 'string' || !v.startsWith('$')) {
      throw new Error(`mapper key '${k}' must start with $`);
    }
    // Reject filter expressions "[?(...)]" and script expressions "[(...)]"
    if (/\[\?\(/.test(v) || /\[\(/.test(v)) {
      throw new Error(`mapper key '${k}' uses forbidden operator`);
    }
  }
  return (record: unknown) => {
    const out: Record<string, unknown> = {};
    for (const [k, path] of Object.entries(config)) {
      // Array paths: [*] wildcard or recursive descent ($..foo)
      const isArrayPath = path.includes('[*]') || /^\$\.\./.test(path);
      const result = JSONPath({ path, json: record as object, wrap: isArrayPath });
      if (isArrayPath) {
        out[k] = Array.isArray(result) ? result : result === undefined ? [] : [result];
      } else {
        // For scalar paths, JSONPath returns the value directly or undefined
        out[k] = Array.isArray(result) ? result[0] : result;
      }
    }
    return out;
  };
}
