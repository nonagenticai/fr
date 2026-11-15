/**
 * fr-agui SPEC §3.4 "Schema conversion" — the ONE zod→JSON-Schema converter.
 *
 * Moved here verbatim from `agent/tool-catalog.ts` (which re-exports
 * `extractJsonSchema`), so capability declarations, the derived agent tools and
 * the MCP descriptors share it without importing the AG-UI registry. Do NOT add
 * `zod-to-openapi`: a second converter recreates the "two schemas disagree"
 * class fr#1383 fixed.
 */
import { z, ZodType, type ZodTypeAny } from 'zod';

/**
 * ⛔ fr#1383. This used to probe `schema.toJsonSchema()`, a method that zod 3
 * does not have (fr pins `zod@^3`; measured 3.25.76). The probe therefore
 * returned `null` for EVERY registered action, so the model was shown tool
 * names and descriptions but never a single parameter name, and it guessed:
 * `agent.search_library` was called without `query` (the zod schema at invoke
 * requires it) and failed on every attempt. The model-facing schema is now
 * DERIVED from the very zod schema the registry validates with, so the two
 * cannot disagree: `required` is exactly the set of keys whose schema rejects
 * `undefined` (`isOptional()` is zod's own `safeParse(undefined).success`).
 *
 * Returns `null` only for a non-zod value.
 */
export function extractJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!isZodType(schema)) return null;
  try {
    // zod 4 ships the converter this file used to hand-write. `io: 'input'` because the
    // model-facing schema describes what a CALLER may send, matching what the registry
    // validates at invoke. `unrepresentable: 'any'` keeps the old contract: an exotic
    // schema becomes "accept anything" rather than throwing.
    const json = z.toJSONSchema(schema, {
      target: 'openapi-3.0',
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    // Drop the dialect declaration: the agent/MCP surface wants a bare schema object,
    // and `$schema` says nothing about the action's parameters.
    const { $schema: _dialect, ...rest } = json;
    return rest;
  } catch {
    // Never fabricate a constraint the runtime does not enforce.
    return {};
  }
}

function isZodType(v: unknown): v is ZodTypeAny {
  return v instanceof ZodType;
}
