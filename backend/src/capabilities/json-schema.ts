/**
 * fr-agui SPEC §3.4 "Schema conversion" — the ONE zod→JSON-Schema converter.
 *
 * Moved here verbatim from `agent/tool-catalog.ts` (which re-exports
 * `extractJsonSchema`), so capability declarations, the derived agent tools and
 * the MCP descriptors share it without importing the AG-UI registry. Do NOT add
 * `zod-to-openapi`: a second converter recreates the "two schemas disagree"
 * class fr#1383 fixed.
 */
import {
  ZodFirstPartyTypeKind,
  ZodType,
  type ZodObject,
  type ZodRawShape,
  type ZodTypeAny,
} from 'zod';

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
  return zodToJsonSchema(schema, 0);
}

function isZodType(v: unknown): v is ZodTypeAny {
  return v instanceof ZodType;
}

/** Deep enough for every action schema; a cycle (z.lazy) bottoms out as `{}`. */
const MAX_SCHEMA_DEPTH = 12;

function withDescription(
  schema: ZodTypeAny,
  out: Record<string, unknown>,
): Record<string, unknown> {
  const description = schema.description;
  return description ? { ...out, description } : out;
}

function zodToJsonSchema(schema: ZodTypeAny, depth: number): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  const next = (s: ZodTypeAny) => zodToJsonSchema(s, depth + 1);
  // `_def.typeName` is zod 3's public discriminator for every built-in type.
  const def = (schema as unknown as { _def: Record<string, unknown> & { typeName?: string } })._def;

  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const obj = schema as ZodObject<ZodRawShape>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(obj.shape) as Array<[string, ZodTypeAny]>) {
        properties[key] = next(field);
        if (!field.isOptional()) required.push(key);
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      if (def.unknownKeys === 'strict') out.additionalProperties = false;
      return withDescription(schema, out);
    }
    case ZodFirstPartyTypeKind.ZodString: {
      const out: Record<string, unknown> = { type: 'string' };
      for (const check of (def.checks ?? []) as Array<{ kind: string; value?: unknown; regex?: RegExp }>) {
        if (check.kind === 'min') out.minLength = check.value;
        else if (check.kind === 'max') out.maxLength = check.value;
        else if (check.kind === 'length') {
          out.minLength = check.value;
          out.maxLength = check.value;
        } else if (check.kind === 'uuid') out.format = 'uuid';
        else if (check.kind === 'email') out.format = 'email';
        else if (check.kind === 'url') out.format = 'uri';
        else if (check.kind === 'datetime') out.format = 'date-time';
        else if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
      }
      return withDescription(schema, out);
    }
    case ZodFirstPartyTypeKind.ZodNumber: {
      const out: Record<string, unknown> = { type: 'number' };
      for (const check of (def.checks ?? []) as Array<{ kind: string; value?: number; inclusive?: boolean }>) {
        if (check.kind === 'int') out.type = 'integer';
        else if (check.kind === 'min') out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        else if (check.kind === 'max') out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
      }
      return withDescription(schema, out);
    }
    case ZodFirstPartyTypeKind.ZodBigInt:
      return withDescription(schema, { type: 'integer' });
    case ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription(schema, { type: 'boolean' });
    case ZodFirstPartyTypeKind.ZodDate:
      return withDescription(schema, { type: 'string', format: 'date-time' });
    case ZodFirstPartyTypeKind.ZodNull:
      return withDescription(schema, { type: 'null' });
    case ZodFirstPartyTypeKind.ZodLiteral:
      return withDescription(schema, { const: def.value });
    case ZodFirstPartyTypeKind.ZodEnum:
      return withDescription(schema, { type: 'string', enum: [...(def.values as string[])] });
    case ZodFirstPartyTypeKind.ZodNativeEnum: {
      // A numeric TS enum carries reverse mappings (value -> key); drop them.
      const obj = def.values as Record<string, string | number>;
      const values = Object.keys(obj)
        .filter((k) => typeof obj[obj[k] as string] !== 'number')
        .map((k) => obj[k]);
      return withDescription(schema, { enum: values });
    }
    case ZodFirstPartyTypeKind.ZodArray: {
      const out: Record<string, unknown> = { type: 'array', items: next(def.type as ZodTypeAny) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return withDescription(schema, out);
    }
    case ZodFirstPartyTypeKind.ZodTuple:
      return withDescription(schema, {
        type: 'array',
        prefixItems: (def.items as ZodTypeAny[]).map(next),
      });
    case ZodFirstPartyTypeKind.ZodRecord:
      return withDescription(schema, {
        type: 'object',
        additionalProperties: next(def.valueType as ZodTypeAny),
      });
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>;
      const list = Array.isArray(options) ? options : [...options.values()];
      return withDescription(schema, { anyOf: list.map(next) });
    }
    case ZodFirstPartyTypeKind.ZodIntersection:
      return withDescription(schema, {
        allOf: [next(def.left as ZodTypeAny), next(def.right as ZodTypeAny)],
      });
    case ZodFirstPartyTypeKind.ZodOptional:
      return withDescription(schema, next(def.innerType as ZodTypeAny));
    case ZodFirstPartyTypeKind.ZodNullable:
      return withDescription(schema, { anyOf: [next(def.innerType as ZodTypeAny), { type: 'null' }] });
    case ZodFirstPartyTypeKind.ZodDefault:
      return withDescription(schema, {
        ...next(def.innerType as ZodTypeAny),
        default: (def.defaultValue as () => unknown)(),
      });
    case ZodFirstPartyTypeKind.ZodEffects:
      return withDescription(schema, next(def.schema as ZodTypeAny));
    case ZodFirstPartyTypeKind.ZodPipeline:
      return withDescription(schema, next(def.in as ZodTypeAny));
    case ZodFirstPartyTypeKind.ZodBranded:
      return withDescription(schema, next(def.type as ZodTypeAny));
    case ZodFirstPartyTypeKind.ZodCatch:
    case ZodFirstPartyTypeKind.ZodReadonly:
      return withDescription(schema, next(def.innerType as ZodTypeAny));
    case ZodFirstPartyTypeKind.ZodLazy:
      return withDescription(schema, next((def.getter as () => ZodTypeAny)()));
    default:
      // ZodUnknown / ZodAny and anything exotic: accept anything. Never
      // fabricate a constraint the runtime does not enforce.
      return withDescription(schema, {});
  }
}
