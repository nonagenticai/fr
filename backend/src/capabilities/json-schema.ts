/**
 * fr-agui SPEC §3.4 "Schema conversion" — the ONE zod→JSON-Schema converter.
 *
 * Moved here verbatim from `agent/tool-catalog.ts` (which re-exports
 * `extractJsonSchema`), so capability declarations, the derived agent tools and
 * the MCP descriptors share it without importing the AG-UI registry. Do NOT add
 * `zod-to-openapi`: a second converter recreates the "two schemas disagree"
 * class fr#1383 fixed.
 */
import { z, ZodType, type ZodEnum, type ZodTypeAny } from 'zod';

/**
 * ⛔ fr#1383. This used to probe `schema.toJsonSchema()`, a method that zod does
 * not have. The probe therefore returned `null` for EVERY registered action, so
 * the model was shown tool names and descriptions but never a single parameter
 * name, and it guessed: `agent.search_library` was called without `query` (the
 * zod schema at invoke requires it) and failed on every attempt. The
 * model-facing schema is now DERIVED from the very zod schema the registry
 * validates with, so the two cannot disagree: `required` is exactly the set of
 * keys whose schema rejects `undefined` (`isOptional()` is zod's own
 * `safeParse(undefined).success`).
 *
 * zod 4 migration: the walk below is the zod 3 converter's, unchanged in what it
 * EMITS (the agent schemas and the served OpenAPI lock depend on those exact
 * bytes), read off zod 4's runtime definition `schema._zod.def` instead of zod
 * 3's `_def.typeName`. `z.toJSONSchema` is deliberately NOT used: it emits
 * `$defs`/`format`/`nullable` shapes and drops `z.date()`/`z.bigint()` that the
 * old converter spelled, so every derived operation would move.
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

/**
 * zod 3's `z.nativeEnum`, which zod 4 folded into `z.enum` (and deprecated): a
 * TS enum / `as const` object whose JSON-Schema the converter below emits as the
 * bare `{ enum: [...] }` zod 3 spelled — `z.enum` says `type: 'string'` as well,
 * and that is a DIFFERENT schema. zod 4 erases the distinction in the runtime
 * definition (`_zod.def` is byte-for-byte the same for both), so it has to be
 * carried explicitly: the marker rides on the definition, which copies through
 * `.describe()`/`.refine()`/clone.
 *
 * ⚠️ The served OpenAPI lock records the bare form for every native-enum
 * operation (`served-spec.lock.json`); using `z.enum` there moves their bytes.
 */
export function nativeEnum<const T extends Record<string, string | number>>(values: T): ZodEnum<T> {
  const schema = z.enum(values);
  ((schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def).frNativeEnum = true;
  return schema;
}

/** Deep enough for every action schema; a cycle (z.lazy) bottoms out as `{}`. */
const MAX_SCHEMA_DEPTH = 12;

/** zod 4's runtime definition: `schema._zod.def`. */
type ZodDef = Record<string, unknown> & { type?: string };
type CheckDef = Record<string, unknown> & { check?: string };

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/** `def.checks` — string / number / array constraints, each with its own `_zod.def`. */
function checksOf(def: ZodDef): CheckDef[] {
  const list = (def.checks ?? []) as Array<{ _zod?: { def?: CheckDef } }>;
  return list.map((c) => c._zod?.def ?? {});
}

/** `.regex()` carries its pattern as a RegExp in zod 4; a string check carries a string. */
function regexOf(c: CheckDef): string | undefined {
  const pattern = c.pattern;
  if (typeof pattern === 'string') return pattern;
  if (pattern instanceof RegExp) return pattern.source;
  return undefined;
}

function withDescription(
  schema: ZodTypeAny,
  out: Record<string, unknown>,
): Record<string, unknown> {
  const description = (schema as unknown as { description?: string }).description;
  return description ? { ...out, description } : out;
}

/** Does the schema accept `undefined`? (`required` = the keys that do NOT.) */
function acceptsUndefined(schema: ZodTypeAny): boolean {
  const isOptional = (schema as unknown as { isOptional?: () => boolean }).isOptional;
  if (typeof isOptional === 'function') return isOptional.call(schema);
  try {
    return schema.safeParse(undefined).success;
  } catch {
    return false;
  }
}

/** zod 4 object catchall: `never` = `.strict()`, `unknown` = `.passthrough()`, absent = strip. */
function objectCatchallType(def: ZodDef): string | undefined {
  const catchall = def.catchall as { _zod?: { def?: { type?: string } } } | undefined;
  return catchall?._zod?.def?.type;
}

function zodToJsonSchema(schema: ZodTypeAny, depth: number): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  const next = (s: ZodTypeAny) => zodToJsonSchema(s, depth + 1);
  const def = defOf(schema);

  switch (def.type) {
    case 'object': {
      const shape = (def.shape ?? {}) as Record<string, ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = next(field);
        if (!acceptsUndefined(field)) required.push(key);
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      // `.strict()` refuses unknown keys; strip and passthrough stay unstated
      // (a passthrough body is spelled `additionalProperties: true` by the
      // OpenAPI derivation, which owns the "forwarded verbatim" claim).
      if (objectCatchallType(def) === 'never') out.additionalProperties = false;
      return withDescription(schema, out);
    }
    case 'string': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const check of checksOf(def)) {
        switch (check.check) {
          case 'min_length':
            out.minLength = check.minimum;
            break;
          case 'max_length':
            out.maxLength = check.maximum;
            break;
          case 'length_equals':
            out.minLength = check.length;
            out.maxLength = check.length;
            break;
          case 'string_format':
            // zod 4 folds `uuid()/email()/url()/datetime()` AND `.regex()` into
            // one `string_format` check (each with an internal validation
            // pattern); only the named format is advertised, as before.
            if (check.format === 'uuid') out.format = 'uuid';
            else if (check.format === 'email') out.format = 'email';
            else if (check.format === 'url') out.format = 'uri';
            else if (check.format === 'datetime') out.format = 'date-time';
            else if (check.format === 'regex') {
              const pattern = regexOf(check);
              if (pattern !== undefined) out.pattern = pattern;
            }
            break;
          default:
            // Unknown/other checks (emoji, base64, starts_with, …) are
            // runtime-only: never fabricate a constraint the old converter
            // did not spell.
            break;
        }
      }
      return withDescription(schema, out);
    }
    case 'number': {
      const out: Record<string, unknown> = { type: 'number' };
      // `z.int()` / `z.int32()` carry their format on the definition itself;
      // `z.number().int()` carries it as a check.
      const ownFormat = def.check === 'number_format' ? (def.format as string | undefined) : undefined;
      if (ownFormat === 'safeint' || ownFormat === 'int32' || ownFormat === 'uint32') out.type = 'integer';
      for (const check of checksOf(def)) {
        if (check.check === 'number_format') {
          if (check.format === 'safeint' || check.format === 'int32' || check.format === 'uint32') out.type = 'integer';
        } else if (check.check === 'greater_than') {
          out[check.inclusive === true ? 'minimum' : 'exclusiveMinimum'] = check.value;
        } else if (check.check === 'less_than') {
          out[check.inclusive === true ? 'maximum' : 'exclusiveMaximum'] = check.value;
        }
      }
      return withDescription(schema, out);
    }
    case 'bigint':
      return withDescription(schema, { type: 'integer' });
    case 'boolean':
      return withDescription(schema, { type: 'boolean' });
    case 'date':
      return withDescription(schema, { type: 'string', format: 'date-time' });
    case 'null':
      return withDescription(schema, { type: 'null' });
    case 'literal': {
      const values = (def.values ?? []) as unknown[];
      return withDescription(schema, { const: values[0] });
    }
    case 'enum': {
      // zod 4 folded ZodEnum and ZodNativeEnum into one `enum` definition with
      // `entries` (key → value). A numeric TS enum carries reverse mappings
      // (value → key); drop them, as the zod 3 converter did.
      const entries = (def.entries ?? {}) as Record<string, string | number>;
      const values = Object.keys(entries)
        .filter((k) => typeof entries[entries[k] as string | number] !== 'number')
        .map((k) => entries[k]);
      // `z.enum` is a string enum and says so; a native TS enum (see
      // `nativeEnum`) keeps the zod 3 form, which carried no `type`.
      const namedEnum = def.frNativeEnum !== true;
      return withDescription(schema, namedEnum ? { type: 'string', enum: values } : { enum: values });
    }
    case 'array': {
      const out: Record<string, unknown> = { type: 'array', items: next(def.element as ZodTypeAny) };
      let min: unknown;
      let max: unknown;
      for (const check of checksOf(def)) {
        if (check.check === 'min_length') min = check.minimum;
        else if (check.check === 'max_length') max = check.maximum;
        else if (check.check === 'length_equals') {
          min = check.length;
          max = check.length;
        }
      }
      if (min !== undefined) out.minItems = min;
      if (max !== undefined) out.maxItems = max;
      return withDescription(schema, out);
    }
    case 'tuple':
      return withDescription(schema, {
        type: 'array',
        prefixItems: ((def.items ?? []) as ZodTypeAny[]).map(next),
      });
    case 'record':
      return withDescription(schema, {
        type: 'object',
        additionalProperties: next(def.valueType as ZodTypeAny),
      });
    case 'union': {
      // ZodUnion and ZodDiscriminatedUnion alike: zod 4 keeps `options`.
      const options = (def.options ?? []) as ZodTypeAny[] | Map<unknown, ZodTypeAny>;
      const list = Array.isArray(options) ? options : [...options.values()];
      return withDescription(schema, { anyOf: list.map(next) });
    }
    case 'intersection':
      return withDescription(schema, {
        allOf: [next(def.left as ZodTypeAny), next(def.right as ZodTypeAny)],
      });
    case 'optional':
      return withDescription(schema, next(def.innerType as ZodTypeAny));
    case 'nonoptional':
      return withDescription(schema, next(def.innerType as ZodTypeAny));
    case 'nullable':
      return withDescription(schema, { anyOf: [next(def.innerType as ZodTypeAny), { type: 'null' }] });
    case 'default': {
      const dv = def.defaultValue;
      return withDescription(schema, {
        ...next(def.innerType as ZodTypeAny),
        default: typeof dv === 'function' ? (dv as () => unknown)() : dv,
      });
    }
    case 'prefault':
      return withDescription(schema, next(def.innerType as ZodTypeAny));
    case 'pipe': {
      // `.transform()` is `pipe(in: X, out: transform)` and advertises X
      // (effects are runtime-only). `z.preprocess()` is the mirror image —
      // `pipe(in: transform, out: X)` — and advertises X too.
      const pipeIn = def.in as ZodTypeAny;
      const pipeOut = def.out as ZodTypeAny;
      const inType = pipeIn === undefined ? undefined : defOf(pipeIn).type;
      return withDescription(schema, next(inType === 'transform' ? pipeOut : pipeIn));
    }
    case 'catch':
    case 'readonly':
      return withDescription(schema, next(def.innerType as ZodTypeAny));
    case 'lazy':
      return withDescription(schema, next((def.getter as () => ZodTypeAny)()));
    default:
      // ZodUnknown / ZodAny / ZodNever and anything exotic: accept anything.
      // Never fabricate a constraint the runtime does not enforce.
      return withDescription(schema, {});
  }
}
