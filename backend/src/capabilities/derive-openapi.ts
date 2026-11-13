/**
 * fr-agui SPEC §3.4 (b) — the OpenAPI document, derived from the declarations.
 *
 * P4d-2e: the hand-written `src/openapi.ts` literal is GONE. Every served
 * operation is a capability's (`deriveOperation`); the non-path parts of the
 * document (info, servers, the shared `components`, the tag list) are
 * `capabilities/spec-document.ts`; and the PATH ORDER — which the literal used
 * to pin with position markers — is the committed order of
 * `capabilities/served-spec.lock.json` (one row per operation, with its
 * sha256: scripts/check-served-spec.ts fails CI when any served operation,
 * component or the document changes without the lock changing with it, so an
 * edit to any declared operation shows as a diff in review).
 *
 * `buildOpenApiSpec` places the operations in the lock's order; an operation
 * the lock does not list yet (a NEW capability) is appended in registry order,
 * and the lock guard then asks for the lock to be regenerated. Two capabilities
 * on one path+method fail the build. A `http.specExempt` capability (a routed
 * byte passthrough no operation can describe) is not emitted.
 *
 * ⚠️ `x-fr-capability` (SPEC §3.4 b metadata). The served document emits it
 * only when `extensions` is on. It ships OFF: turning it on changes every
 * operation's bytes (and the lock) and is a one-line change
 * (`SERVED_SPEC_EXTENSIONS`) for the unit that accepts that diff.
 */
import type { ZodTypeAny } from 'zod';

import type { Capability } from './define';
import { CAPABILITIES, type RegisteredCapability } from './registry';
import { extractJsonSchema } from './json-schema';

/** Served-spec switch for the `x-fr-capability` extension (see header). */
export const SERVED_SPEC_EXTENSIONS = false;

/** `/api/projects/:id` → `/api/projects/{id}`. */
export function openApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function pathParams(expressPath: string): string[] {
  return [...expressPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

export function capabilityExtension(cap: Capability<any, any>): Record<string, unknown> {
  return {
    id: cap.id,
    effect: cap.effect,
    tenancy: cap.tenancy,
    confirm: cap.confirm,
    conveyorGated: cap.conveyorGated === true,
  };
}

export interface DeriveOptions {
  /** Emit `x-fr-capability` metadata (see header). */
  extensions: boolean;
}

/**
 * The operation object for one capability. A frozen operation is returned as a
 * deep copy of exactly what the literal held; a new one is built from the zod
 * schemas through the ONE converter (json-schema.ts).
 */
export function deriveOperation(
  cap: Capability<any, any>,
  opts: DeriveOptions = { extensions: SERVED_SPEC_EXTENSIONS },
): Record<string, unknown> {
  const frozen = cap.openapi?.frozen;
  const op: Record<string, unknown> =
    frozen !== undefined ? structuredClone(frozen) : buildOperation(cap);
  if (opts.extensions) op['x-fr-capability'] = capabilityExtension(cap);
  return op;
}

/**
 * Does the input object accept keys it does not list? (`.passthrough()`, looked
 * up through refine/transform wrappers.) Such a body is forwarded verbatim to
 * an upstream that owns its schema, so the spec says `additionalProperties:
 * true` rather than claiming the listed keys are the whole contract.
 */
export function inputIsPassthrough(schema: ZodTypeAny): boolean {
  let s: ZodTypeAny = schema;
  for (let i = 0; i < 8; i += 1) {
    const def = (s as unknown as { _def: { typeName?: string; schema?: ZodTypeAny; innerType?: ZodTypeAny; unknownKeys?: string } })._def;
    if (def.typeName === 'ZodObject') return def.unknownKeys === 'passthrough';
    const inner = def.schema ?? def.innerType;
    if (inner === undefined) return false;
    s = inner;
  }
  return false;
}

/** Same walk as `inputIsPassthrough`: does the input object refuse unknown keys (`.strict()`)? */
export function inputIsStrict(schema: ZodTypeAny): boolean {
  let s: ZodTypeAny = schema;
  for (let i = 0; i < 8; i += 1) {
    const def = (s as unknown as { _def: { typeName?: string; schema?: ZodTypeAny; innerType?: ZodTypeAny; unknownKeys?: string } })._def;
    if (def.typeName === 'ZodObject') return def.unknownKeys === 'strict';
    const inner = def.schema ?? def.innerType;
    if (inner === undefined) return false;
    s = inner;
  }
  return false;
}

/**
 * fr-agui P4d-1 — the served-spec marker for a secret-carrying field (SPEC §10.1
 * `secrets.input` / `secrets.output`); the agent schemas never carry it. ⚠️ Nothing renders
 * it as a password input YET: the n8n-nodes-fr generator (n8n_module_scripts
 * `scripts/generate-node.ts`) does not read `x-secret` (measured P4d-1 audit and P4d-2e regen
 * check), so a secret input still renders as a plain string field there. The marker is the
 * contract the generator half has to honour (typeOptions.password), not a claim that it does.
 */
export const SECRET_MARKER_KEY = 'x-secret';

/**
 * Mark the field a JSON pointer names (`/a/b`) inside a JSON schema, in place. The
 * pointer names object keys only and steps THROUGH arrays (`/items/url` is the `url`
 * of every `items[]` element), and through `anyOf` / `allOf` branches (a nullable).
 * Returns how many leaves it marked (0 = the pointer names nothing in this schema).
 */
export function markSecret(schema: unknown, segments: ReadonlyArray<string>, depth = 0): number {
  if (schema === null || typeof schema !== 'object' || depth > 16) return 0;
  const o = schema as Record<string, unknown>;
  if (segments.length === 0) {
    o[SECRET_MARKER_KEY] = true;
    return 1;
  }
  let n = 0;
  const [head, ...rest] = segments;
  const props = o.properties as Record<string, unknown> | undefined;
  if (props !== undefined && head! in props) n += markSecret(props[head!], rest, depth + 1);
  if (o.items !== undefined) n += markSecret(o.items, segments, depth + 1);
  for (const k of ['anyOf', 'allOf', 'oneOf'] as const) {
    if (Array.isArray(o[k])) for (const b of o[k] as unknown[]) n += markSecret(b, segments, depth + 1);
  }
  return n;
}

const pointerSegments = (p: string): string[] => p.split('/').slice(1);

const BINARY = { type: 'string', format: 'binary' } as const;

function buildOperation(cap: Capability<any, any>): Record<string, unknown> {
  const path = cap.http.path ?? `/api/capabilities/${cap.id}/invoke`;
  const params = pathParams(path);
  const input = extractJsonSchema(cap.input) ?? {};
  const props = (input.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((input.required ?? []) as string[]);
  // P4d-1: `http.bodyFields` gives a DELETE a JSON body, and lets a body key share a path parameter's name.
  const bodyFields = cap.http.bodyFields ?? [];
  for (const f of bodyFields) {
    if (props[f] === undefined) throw new OpenApiDerivationError(`${cap.id}: http.bodyFields ${f} is not an input property`);
  }
  const isDelete = cap.http.method === 'DELETE';
  const hasBody = cap.http.method !== 'GET' && (!isDelete || bodyFields.length > 0);
  const multipart = cap.http.requestBody?.contentType === 'multipart/form-data';
  const fileFields = cap.http.requestBody?.fileFields ?? [];

  // Secret pointers (SPEC §10.1) name input properties; mark each one where it lands.
  for (const ptr of cap.secrets?.input ?? []) markSecret(input, pointerSegments(ptr));

  const parameters: Record<string, unknown>[] = params.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: props[name] ?? { type: 'string' },
  }));
  const bodyProps: Record<string, unknown> = {};
  const bodyRequired: string[] = [];
  const queryFields = cap.http.queryFields ?? [];
  for (const [name, schema] of Object.entries(props)) {
    if (params.includes(name)) {
      // Also a body key (the route's body schema requires the same name): a COPY, so the two never alias.
      if (bodyFields.includes(name)) {
        bodyProps[name] = structuredClone(schema);
        if (required.has(name)) bodyRequired.push(name);
      }
      continue;
    }
    const inBody = hasBody && !queryFields.includes(name) && (!isDelete || bodyFields.includes(name));
    if (!inBody) {
      parameters.push({ name, in: 'query', required: required.has(name), schema });
    } else {
      bodyProps[name] = multipart && fileFields.includes(name) ? { ...BINARY, ...describedBy(schema) } : schema;
      if (required.has(name)) bodyRequired.push(name);
    }
  }
  // P4d-1: request headers the route reads (not input properties).
  for (const h of cap.http.headers ?? []) {
    parameters.push({ name: h.name, in: 'header', required: h.required, description: h.description, schema: { type: 'string' } });
  }
  // A named file part is REQUIRED: the zod stand-in (`z.unknown()`) is optional
  // by construction, but the route refuses a form without it.
  for (const f of fileFields) {
    if (bodyProps[f] === undefined) bodyProps[f] = { ...BINARY };
    if (!bodyRequired.includes(f)) bodyRequired.push(f);
  }

  const op: Record<string, unknown> = { summary: cap.summary };
  if (cap.description) op.description = cap.description;
  if (cap.openapi?.tags !== undefined && cap.openapi.tags.length > 0) op.tags = [...cap.openapi.tags];
  op.operationId = cap.http.operationId;
  if (cap.openapi?.security !== undefined) op.security = cap.openapi.security;
  if (cap.openapi?.internal) op['x-internal'] = true;
  if (parameters.length > 0) op.parameters = parameters;
  const passthroughBody = hasBody && inputIsPassthrough(cap.input);
  if (Object.keys(bodyProps).length > 0 || passthroughBody) {
    const schema: Record<string, unknown> = { type: 'object', properties: bodyProps };
    if (bodyRequired.length > 0) schema.required = bodyRequired;
    if (passthroughBody) schema.additionalProperties = true;
    // P4d-1: a `.strict()` input refuses an unknown key, and the served spec says so.
    else if (inputIsStrict(cap.input)) schema.additionalProperties = false;
    const mediaType = multipart ? 'multipart/form-data' : 'application/json';
    op.requestBody = { required: bodyRequired.length > 0, content: { [mediaType]: { schema } } };
  }
  const success = String(cap.http.successStatus ?? 200);
  const responseType = cap.http.responseContentType;
  const responses: Record<string, unknown> = {
    [success]:
      success === '204'
        ? { description: 'No content' }
        : success === '302'
          ? {
              description: 'Found: a browser redirect (no body); where to, and why, is in the operation description.',
              headers: { Location: { description: 'The redirect target.', schema: { type: 'string' } } },
            }
          : responseType !== undefined
          ? { description: 'OK', content: { [responseType]: { schema: { ...BINARY } } } }
          : {
              description: 'OK',
              content: { 'application/json': { schema: outputSchema(cap) } },
            },
  };
  for (const e of cap.errors) {
    responses[String(e.status)] = {
      description: e.code,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } },
    };
  }
  for (const r of cap.openapi?.responses ?? []) {
    responses[String(r.status)] = {
      description: r.description,
      content: { 'application/json': { schema: responseSchema(cap.id, r.status, r.schema) } },
    };
  }
  op.responses = responses;
  return toOas30(op) as Record<string, unknown>;
}

/** The success body, with every `secrets.output` field marked. */
function outputSchema(cap: Capability<any, any>): Record<string, unknown> {
  const out = extractJsonSchema(cap.output) ?? {};
  for (const ptr of cap.secrets?.output ?? []) markSecret(out, pointerSegments(ptr));
  return out;
}

/** A declared response body; defineCapability already refused an unextractable one, so null here is a bug. */
function responseSchema(id: string, status: number | 'default', schema: unknown): Record<string, unknown> {
  const json = extractJsonSchema(schema);
  if (json === null) throw new Error(`${id}: openapi.responses ${status} schema is not extractable`);
  return json;
}

/**
 * The served document is OpenAPI 3.0 (n8n-nodes-fr's orval refuses 3.1-only
 * keywords; tests/unit/openapi-spec-integrity.test.ts). The ONE converter
 * (json-schema.ts) speaks JSON Schema for the agent catalog — `nullable()` is
 * `anyOf: [X, {type: 'null'}]`, `z.literal` is `const` — so a derived operation
 * is rewritten into the 3.0 spellings HERE, leaving the agent schemas untouched:
 *   anyOf [X, {type:'null'}]  →  X + nullable: true   (description kept)
 *   const v                   →  enum: [v]
 *   exclusiveMinimum: n       →  minimum: n, exclusiveMinimum: true   (fr-agui P4b: `z.number().positive()`)
 *   exclusiveMaximum: n       →  maximum: n, exclusiveMaximum: true
 */
export function toOas30(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toOas30);
  if (v === null || typeof v !== 'object') return v;
  const o = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toOas30(x)]));
  const any = o.anyOf;
  if (Array.isArray(any)) {
    const isNull = (s: unknown) => typeof s === 'object' && s !== null && (s as Record<string, unknown>).type === 'null' && Object.keys(s).length === 1;
    const rest = any.filter((s) => !isNull(s));
    if (rest.length < any.length) {
      const { anyOf: _drop, ...others } = o;
      const inner = rest.length === 1 ? (rest[0] as Record<string, unknown>) : { anyOf: rest };
      return { ...inner, ...others, nullable: true };
    }
  }
  if ('const' in o) {
    const { const: c, ...others } = o;
    return { ...others, enum: [c] };
  }
  // JSON Schema's numeric exclusive bounds are a boolean MODIFIER of minimum / maximum in 3.0.
  for (const [ex, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (typeof o[ex] === 'number') {
      const { [ex]: n, ...others } = o;
      return toOas30({ ...others, [bound]: n, [ex]: true });
    }
  }
  return o;
}

function describedBy(schema: Record<string, unknown>): Record<string, unknown> {
  return typeof schema.description === 'string' ? { description: schema.description } : {};
}

export class OpenApiDerivationError extends Error {
  constructor(message: string) {
    super(`openapi derivation: ${message}`);
    this.name = 'OpenApiDerivationError';
  }
}

/** `GET /api/projects/{id}` — the identity of one served operation (and of one lock row). */
export function servedOperationKey(method: string, openApiPathname: string): string {
  return `${method.toUpperCase()} ${openApiPathname}`;
}

/**
 * The served document: `document` (every non-path part; its `paths` key holds the position
 * `paths` takes in the output, so the key order of the document is stable) with every
 * capability operation placed in `order` (`METHOD /openapi/path` keys, the lock's order), then
 * every operation `order` does not list, in registry order. `document` is not mutated.
 */
export function buildOpenApiSpec<T extends { paths: Record<string, unknown> }>(
  document: T,
  entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES,
  opts: DeriveOptions = { extensions: SERVED_SPEC_EXTENSIONS },
  order: ReadonlyArray<string> = [],
): Omit<T, 'paths'> & { paths: Record<string, Record<string, unknown>> } {
  if (Object.keys(document.paths).length > 0) {
    throw new OpenApiDerivationError('the spec document carries no path: every operation is a capability\'s');
  }
  const ops = new Map<string, { path: string; method: string; cap: Capability<any, any> }>();
  for (const { cap } of entries) {
    if (cap.http.path === null || cap.http.specExempt !== undefined) continue;
    const path = openApiPath(cap.http.path);
    const method = cap.http.method.toLowerCase();
    const key = servedOperationKey(method, path);
    const other = ops.get(key);
    if (other !== undefined) throw new OpenApiDerivationError(`${key} is served by BOTH ${other.cap.id} and ${cap.id}`);
    ops.set(key, { path, method, cap });
  }
  const paths: Record<string, Record<string, unknown>> = {};
  const place = (key: string): void => {
    const o = ops.get(key);
    if (o === undefined) return;
    ops.delete(key);
    (paths[o.path] ??= {})[o.method] = deriveOperation(o.cap, opts);
  };
  for (const key of order) place(key);
  for (const key of [...ops.keys()]) place(key);
  return { ...document, paths };
}
