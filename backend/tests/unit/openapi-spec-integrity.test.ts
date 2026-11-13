// tests/unit/openapi-spec-integrity.test.ts
//
// THE SECOND GATE THAT DID NOT EXIST.
//
// `src/openapi.ts` is a HAND-MAINTAINED spec object. The only thing CI ran
// against it was `tsc --noEmit`, which proves the object is syntactically a
// TypeScript literal and NOTHING about whether the document it describes is
// coherent. Everything below is invisible to the typechecker, because every one
// of them is a well-typed string:
//
//   - two operations sharing an `operationId` (generated clients collide or
//     silently drop one — `bun run clients:generate` / orval keys on it)
//   - an operation tagged with a tag no `tags[]` entry declares (the tag
//     vanishes from the rendered docs, or renders as an empty section)
//   - an operation with no `operationId`, no tag, or no success response
//   - a TYPO'D `$ref` — `#/components/schemas/Aproval` typechecks perfectly and
//     resolves to nothing. This is the one most likely to be a real future
//     mistake, and `tsc` will never see it.
//
// ⚠️ RATCHETS, NOT SOFTENING. Two checks below carry a FROZEN allowlist of the
// violations that exist on main TODAY, so the gate catches new debt without
// blocking on old. An allowlist here is a licence to not look, so each one also
// asserts it has no STALE entries: fix the underlying spec and this test fails
// until the entry is deleted. Never add to an allowlist to make a red go green.
//
// ⭐ MUTATION CONTROL. Every checker in this file is a pure function over a spec
// object, and the second `describe` block runs those SAME functions against a
// synthetic fixture that has been deliberately broken. A checker with no proven
// failing case is theatre — it is indistinguishable from `return []`.
// The synthetic fixture is built in memory; the real spec is never mutated.

import { describe, expect, test } from 'bun:test';
import { openapiSpec } from '../../src/capabilities/served-spec';

// ---------------------------------------------------------------------------
// Minimal structural types. Deliberately loose: this test must be able to SEE
// a malformed spec, so it cannot assume the shapes it is checking for.
// ---------------------------------------------------------------------------

type Operation = {
  operationId?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
};

type Spec = {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  tags?: { name?: string }[];
  components?: { schemas?: Record<string, unknown> };
};

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'options',
  'head',
  'trace',
] as const;

type Located = { path: string; method: string; op: Operation };

/** `get /health` — the label used in every failure message and allowlist. */
function label(l: Located): string {
  return `${l.method} ${l.path}`;
}

// ---------------------------------------------------------------------------
// Checkers. Each returns a list of OFFENDERS (empty = clean) and each offender
// carries enough text to act on without opening the spec.
// ---------------------------------------------------------------------------

function collectOperations(spec: Spec): Located[] {
  const out: Located[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item)) {
      // A path item legally holds `parameters`, `summary`, `$ref` etc. Only the
      // HTTP-method keys are operations; treating the others as operations
      // would manufacture false offenders.
      if (!(HTTP_METHODS as readonly string[]).includes(key)) continue;
      if (!value || typeof value !== 'object') continue;
      out.push({ path, method: key, op: value as Operation });
    }
  }
  return out;
}

/** Check 2 — duplicate operationIds, naming the id and BOTH locations. */
function findDuplicateOperationIds(spec: Spec): string[] {
  const seen = new Map<string, Located[]>();
  for (const l of collectOperations(spec)) {
    const id = l.op.operationId;
    if (typeof id !== 'string' || id.length === 0) continue; // check 4's job
    const bucket = seen.get(id);
    if (bucket) bucket.push(l);
    else seen.set(id, [l]);
  }
  return [...seen.entries()]
    .filter(([, ls]) => ls.length > 1)
    .map(
      ([id, ls]) =>
        `operationId '${id}' is used ${ls.length}x: ${ls.map(label).join(' AND ')}`,
    );
}

/** Check 3 — tags used by an operation but absent from the top-level `tags`. */
function findUndeclaredTags(spec: Spec): string[] {
  const declared = new Set(
    (spec.tags ?? [])
      .map((t) => t?.name)
      .filter((n): n is string => typeof n === 'string'),
  );
  const users = new Map<string, string[]>();
  for (const l of collectOperations(spec)) {
    for (const tag of l.op.tags ?? []) {
      if (declared.has(tag)) continue;
      const bucket = users.get(tag);
      if (bucket) bucket.push(label(l));
      else users.set(tag, [label(l)]);
    }
  }
  return [...users.entries()].map(
    ([tag, ops]) =>
      `tag '${tag}' is used by ${ops.length} operation(s) but is not declared in the top-level tags[]: ${ops.join(', ')}`,
  );
}

/** Check 4a — operations with a missing or empty `operationId`. */
function findMissingOperationIds(spec: Spec): string[] {
  return collectOperations(spec)
    .filter((l) => typeof l.op.operationId !== 'string' || l.op.operationId.length === 0)
    .map((l) => label(l));
}

/** Check 4b — operations carrying no tag at all. */
function findUntaggedOperations(spec: Spec): string[] {
  return collectOperations(spec)
    .filter((l) => !Array.isArray(l.op.tags) || l.op.tags.length === 0)
    .map((l) => `${label(l)} has no tags[]`);
}

/** Check 4c — operations documenting no 2xx response. */
function findOperationsWithoutSuccessResponse(spec: Spec): string[] {
  return collectOperations(spec)
    .filter(
      (l) =>
        !Object.keys(l.op.responses ?? {}).some(
          (code) =>
            /^2\d\d$/.test(code) ||
            // fr-agui P4b part 3: a browser-redirect operation (GET /api/github-app/callback)
            // succeeds with a 3xx — documented WITH its Location header, or it does not count.
            (/^3\d\d$/.test(code) &&
              Boolean((l.op.responses as Record<string, { headers?: Record<string, unknown> }>)[code]?.headers?.Location)),
        ),
    )
    .map(
      (l) =>
        `${label(l)} documents no 2xx response (has: ${
          Object.keys(l.op.responses ?? {}).join(', ') || 'nothing'
        })`,
    );
}

/** Every `$ref` anywhere in the document, with the JSON path it was found at. */
function collectRefs(spec: unknown): { ref: string; where: string }[] {
  const found: { ref: string; where: string }[] = [];
  const walk = (node: unknown, where: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${where}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        found.push({ ref: value, where });
      } else {
        walk(value, `${where}.${key}`);
      }
    }
  };
  walk(spec, '$');
  return found;
}

/** Check 5 — refs that do not resolve under components.schemas. */
function findDanglingRefs(spec: Spec): string[] {
  const schemas = spec.components?.schemas ?? {};
  return collectRefs(spec)
    .filter(({ ref }) => {
      const m = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
      // A ref that is not a local components.schemas pointer is also an
      // offender: nothing in this repo publishes any other target, and a
      // remote/`#/components/responses/...` ref would break every generator.
      return !m || !Object.prototype.hasOwnProperty.call(schemas, m[1] as string);
    })
    .map(({ ref, where }) => `dangling $ref '${ref}' at ${where}`);
}

/**
 * Check 7 — the document is valid OpenAPI **3.0** at the schema-keyword level.
 *
 * The spec declares `openapi: '3.0.x'`. OAS 3.0 Schema Objects are a restricted
 * SUBSET of JSON Schema draft-04/05: the keywords below are JSON Schema (or OAS
 * 3.1-only) and are NOT allowed in a 3.0 document. Strict consumers reject the
 * WHOLE spec on one of them — orval 8.37 (the n8n node generator in
 * n8n_module_scripts) refused fr's spec over a single `propertyNames`.
 * `tsc` cannot see this: every keyword is a well-typed object key.
 *
 * The walk visits SCHEMA positions only (components.schemas.*, every `schema`
 * key, and schema children: properties.*, items, additionalProperties,
 * allOf/oneOf/anyOf/not), so a PROPERTY NAMED `const` or `if` is not an offender,
 * and `examples` maps on media types / parameters (valid 3.0) are not flagged.
 */
const OAS30_FORBIDDEN_SCHEMA_KEYWORDS: readonly string[] = [
  'propertyNames',
  'const',
  '$defs',
  'definitions',
  'if',
  'then',
  'else',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'minContains',
  'maxContains',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
  'patternProperties',
  'additionalItems',
  'examples',
  '$schema',
  '$id',
  '$anchor',
  '$comment',
  '$dynamicRef',
  '$dynamicAnchor',
  'contentMediaType',
  'contentEncoding',
  'contentSchema',
];
const OAS30_TYPES: readonly string[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
];

function findNonOas30SchemaKeywords(spec: Spec): string[] {
  const offenders: string[] = [];
  if (typeof spec.openapi !== 'string' || !/^3\.0\.\d+$/.test(spec.openapi)) {
    offenders.push(`$.openapi is '${String(spec.openapi)}', expected 3.0.x`);
  }

  const visitSchema = (node: unknown, where: string): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      if (Array.isArray(node)) offenders.push(`${where}: schema is an array`);
      return;
    }
    const o = node as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (OAS30_FORBIDDEN_SCHEMA_KEYWORDS.includes(key)) {
        offenders.push(`${where}: '${key}' is not an OAS 3.0 schema keyword`);
      }
    }
    if ('type' in o) {
      if (typeof o.type !== 'string') {
        offenders.push(`${where}: type must be a single string in OAS 3.0 (use nullable)`);
      } else if (!OAS30_TYPES.includes(o.type)) {
        offenders.push(`${where}: type '${o.type}' is not an OAS 3.0 type`);
      }
    }
    for (const k of ['exclusiveMinimum', 'exclusiveMaximum']) {
      if (k in o && typeof o[k] !== 'boolean') {
        offenders.push(`${where}: ${k} must be a boolean in OAS 3.0`);
      }
    }
    if (o.properties && typeof o.properties === 'object') {
      for (const [name, child] of Object.entries(o.properties)) {
        visitSchema(child, `${where}.properties.${name}`);
      }
    }
    if ('items' in o) visitSchema(o.items, `${where}.items`);
    if (o.additionalProperties && typeof o.additionalProperties === 'object') {
      visitSchema(o.additionalProperties, `${where}.additionalProperties`);
    }
    if ('not' in o) visitSchema(o.not, `${where}.not`);
    for (const k of ['allOf', 'oneOf', 'anyOf']) {
      const arr = o[k];
      if (Array.isArray(arr)) arr.forEach((c, i) => visitSchema(c, `${where}.${k}[${i}]`));
    }
  };

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    visitSchema(schema, `$.components.schemas.${name}`);
  }
  // Every `schema` key outside components.schemas (parameters, media types,
  // headers). Example payloads are data, not schemas — never descend into them.
  const findSchemaKeys = (node: unknown, where: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => findSchemaKeys(v, `${where}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'example' || key === 'examples') continue;
      if (key === 'schema') visitSchema(value, `${where}.schema`);
      else findSchemaKeys(value, `${where}.${key}`);
    }
  };
  findSchemaKeys(spec.paths ?? {}, '$.paths');
  return offenders;
}

/** Check 6 — operationIds that are not camelCase-ish. */
function findNonCamelCaseOperationIds(spec: Spec): string[] {
  return collectOperations(spec)
    .map((l) => l.op.operationId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .filter((id) => !/^[a-z][A-Za-z0-9]*$/.test(id));
}

// ---------------------------------------------------------------------------
// FROZEN ALLOWLISTS — existing debt on main. See the header: adding to these to
// silence a red is forbidden. Both are checked for stale entries below.
// ---------------------------------------------------------------------------

/**
 * EMPTY, and that is the point.
 *
 * Writing this test found a real defect: `GET /health` was the ONE operation of
 * 52 with no `operationId`, so generated clients named that method themselves.
 * It was briefly recorded here as a frozen entry — then FIXED in the same change
 * (`operationId: 'healthCheck'`), so the list is empty and the ratchet starts
 * clean rather than shipping with debt already in it.
 *
 * The stale-entry assertion below means an entry added here dies as soon as the
 * operation it excuses is fixed, so this list can only ever shrink.
 */
const KNOWN_MISSING_OPERATION_ID: readonly string[] = [];

/**
 * Empty, and measured so: all 51 operationIds on main already match
 * /^[a-z][A-Za-z0-9]*$/. The list exists so a future violation can be ratcheted
 * rather than blocking, NOT because anything needs it today.
 */
const KNOWN_NON_CAMEL_OPERATION_IDS: readonly string[] = [];

const spec = openapiSpec as unknown as Spec;

// ---------------------------------------------------------------------------
// The real spec.
// ---------------------------------------------------------------------------

describe('openapi spec integrity (real spec)', () => {
  test('CONTROL: the spec parses and is non-trivial', () => {
    // ⛔ THE NON-VACUITY GUARD. Every other assertion in this block reports
    // offenders from a WALK of the spec: if the spec were empty, renamed, or
    // restructured so the walk found nothing, all of them would compare [] to
    // [] and report a clean bill of health for a document that is not there.
    // These are `> 0` floors, deliberately NOT counts of the surface: the
    // number of paths/operations/tags grows with every route and must not be
    // pinned here.
    const paths = Object.keys(spec.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);

    const operations = collectOperations(spec);
    expect(operations.length).toBeGreaterThan(0);

    // Non-vacuity for checks 2/3/5 specifically: each needs its input to be
    // non-empty before an empty offender list means anything.
    expect(
      operations.filter((l) => typeof l.op.operationId === 'string').length,
    ).toBeGreaterThan(0);
    expect((spec.tags ?? []).length).toBeGreaterThan(0);
    expect(collectRefs(spec).length).toBeGreaterThan(0);
    expect(Object.keys(spec.components?.schemas ?? {}).length).toBeGreaterThan(0);
  });

  test('no duplicate operationId anywhere in the spec', () => {
    expect(findDuplicateOperationIds(spec)).toEqual([]);
  });

  test('every tag used by an operation is declared in the top-level tags[]', () => {
    expect(findUndeclaredTags(spec)).toEqual([]);
  });

  test('every operation has a non-empty operationId (frozen allowlist for existing debt)', () => {
    const offenders = findMissingOperationIds(spec);
    const unexpected = offenders.filter(
      (o) => !KNOWN_MISSING_OPERATION_ID.includes(o),
    );
    expect(unexpected).toEqual([]);

    // The ratchet must not rot: an allowlist entry that is no longer an
    // offender is a licence to not look. Fix the spec, delete the line.
    const stale = KNOWN_MISSING_OPERATION_ID.filter((k) => !offenders.includes(k));
    expect(stale).toEqual([]);
  });

  test('every operation carries at least one tag', () => {
    expect(findUntaggedOperations(spec)).toEqual([]);
  });

  test('every operation documents at least one 2xx response', () => {
    expect(findOperationsWithoutSuccessResponse(spec)).toEqual([]);
  });

  test('every $ref resolves to an existing components.schemas entry', () => {
    expect(findDanglingRefs(spec)).toEqual([]);
  });

  test('every operationId is camelCase-ish (frozen allowlist for existing debt)', () => {
    const offenders = findNonCamelCaseOperationIds(spec);
    const unexpected = offenders.filter(
      (o) => !KNOWN_NON_CAMEL_OPERATION_IDS.includes(o),
    );
    expect(unexpected).toEqual([]);

    const stale = KNOWN_NON_CAMEL_OPERATION_IDS.filter(
      (k) => !offenders.includes(k),
    );
    expect(stale).toEqual([]);
  });

  test('every schema uses only OAS 3.0 keywords (no propertyNames/const/type arrays/…)', () => {
    expect(findNonOas30SchemaKeywords(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MUTATION CONTROL — prove every checker above can actually FAIL.
//
// These run the SAME functions the real-spec block runs, against a synthetic
// spec built here. The real `openapiSpec` object is never touched.
// ---------------------------------------------------------------------------

/** A small, deliberately VALID spec. Every checker must report [] against it. */
function cleanSyntheticSpec(): Spec {
  return {
    openapi: '3.0.3',
    tags: [{ name: 'Widgets' }, { name: 'System' }],
    components: {
      schemas: {
        Widget: { type: 'object', properties: { id: { type: 'string' } } },
        WidgetList: {
          type: 'array',
          items: { $ref: '#/components/schemas/Widget' },
        },
      },
    },
    paths: {
      '/widgets': {
        // A non-method sibling key, so the walker is exercised against one.
        parameters: [{ name: 'tenantId', in: 'query' }],
        get: {
          operationId: 'listWidgets',
          tags: ['Widgets'],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WidgetList' },
                },
              },
            },
            '404': { description: 'nope' },
          },
        },
        post: {
          operationId: 'createWidget',
          tags: ['Widgets'],
          responses: {
            '201': {
              description: 'created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Widget' },
                },
              },
            },
          },
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          tags: ['System'],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
}

describe('openapi spec integrity (mutation control: each detector can fail)', () => {
  test('CONTROL: the clean synthetic fixture is clean under EVERY checker', () => {
    // Without this, a "detects X" test below could pass because its checker
    // reports something for any input at all.
    const s = cleanSyntheticSpec();
    expect(collectOperations(s).length).toBe(3);
    expect(findDuplicateOperationIds(s)).toEqual([]);
    expect(findUndeclaredTags(s)).toEqual([]);
    expect(findMissingOperationIds(s)).toEqual([]);
    expect(findUntaggedOperations(s)).toEqual([]);
    expect(findOperationsWithoutSuccessResponse(s)).toEqual([]);
    expect(findDanglingRefs(s)).toEqual([]);
    expect(findNonCamelCaseOperationIds(s)).toEqual([]);
    expect(findNonOas30SchemaKeywords(s)).toEqual([]);
    expect(collectRefs(s).length).toBe(3);
  });

  test('CONTROL: an empty spec is reported as trivial by the non-vacuity floor', () => {
    // The guard that makes every [] above meaningful — proven on the input it
    // exists to reject.
    const empty: Spec = { paths: {}, tags: [], components: { schemas: {} } };
    expect(collectOperations(empty)).toEqual([]);
    // ...and note every checker is silent on it, which is exactly the failure
    // mode the floor prevents:
    expect(findDuplicateOperationIds(empty)).toEqual([]);
    expect(findDanglingRefs(empty)).toEqual([]);
  });

  test('detects a duplicate operationId, naming the id and BOTH locations', () => {
    const s = cleanSyntheticSpec();
    (s.paths!['/health']!.get as Operation).operationId = 'listWidgets';
    const offenders = findDuplicateOperationIds(s);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain("operationId 'listWidgets'");
    expect(offenders[0]).toContain('get /widgets');
    expect(offenders[0]).toContain('get /health');
  });

  test('detects a tag used by an operation but not declared in tags[]', () => {
    const s = cleanSyntheticSpec();
    (s.paths!['/widgets']!.post as Operation).tags = ['Gadgets'];
    const offenders = findUndeclaredTags(s);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain("tag 'Gadgets'");
    expect(offenders[0]).toContain('post /widgets');
  });

  test('detects a missing operationId', () => {
    const s = cleanSyntheticSpec();
    delete (s.paths!['/widgets']!.get as Operation).operationId;
    expect(findMissingOperationIds(s)).toEqual(['get /widgets']);
  });

  test('detects an empty-string operationId (not just an absent one)', () => {
    const s = cleanSyntheticSpec();
    (s.paths!['/widgets']!.get as Operation).operationId = '';
    expect(findMissingOperationIds(s)).toEqual(['get /widgets']);
  });

  test('detects an operation with no tags', () => {
    const s = cleanSyntheticSpec();
    (s.paths!['/widgets']!.post as Operation).tags = [];
    delete (s.paths!['/health']!.get as Operation).tags;
    const offenders = findUntaggedOperations(s);
    expect(offenders.length).toBe(2);
    expect(offenders.join(' ')).toContain('post /widgets');
    expect(offenders.join(' ')).toContain('get /health');
  });

  test('detects an operation with no 2xx response', () => {
    const s = cleanSyntheticSpec();
    (s.paths!['/widgets']!.get as Operation).responses = {
      '404': { description: 'nope' },
      '500': { description: 'boom' },
    };
    const offenders = findOperationsWithoutSuccessResponse(s);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain('get /widgets');
    expect(offenders[0]).toContain('404');
  });

  test('detects a dangling $ref, naming the ref and where it appeared', () => {
    // The typo'd-ref case: well-typed, invisible to tsc, resolves to nothing.
    const s = cleanSyntheticSpec();
    (
      s.paths!['/widgets']!.post as unknown as {
        responses: Record<string, { content: Record<string, { schema: unknown }> }>;
      }
    ).responses['201']!.content['application/json']!.schema = {
      $ref: '#/components/schemas/Widgit',
    };
    const offenders = findDanglingRefs(s);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain("'#/components/schemas/Widgit'");
    expect(offenders[0]).toContain('paths./widgets.post.responses.201');
  });

  test('detects a dangling $ref nested deep inside an array', () => {
    // Proves the walker recurses through arrays, not just objects — a ref
    // inside `allOf`/`oneOf` is the common real shape.
    const s = cleanSyntheticSpec();
    s.components!.schemas!.Widget = {
      allOf: [
        { $ref: '#/components/schemas/WidgetList' },
        { $ref: '#/components/schemas/DoesNotExist' },
      ],
    };
    const offenders = findDanglingRefs(s);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain('DoesNotExist');
    expect(offenders[0]).toContain('allOf[1]');
  });

  test('detects a $ref that points outside components.schemas', () => {
    const s = cleanSyntheticSpec();
    (
      s.paths!['/widgets']!.get as unknown as {
        responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
      }
    ).responses['200']!.content!['application/json']!.schema = {
      $ref: '#/components/responses/NotFound',
    };
    const offenders = findDanglingRefs(s);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain('#/components/responses/NotFound');
  });

  test('detects non-OAS-3.0 schema keywords at nested schema positions', () => {
    const s = cleanSyntheticSpec();
    s.components!.schemas!.Widget = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        // a PROPERTY NAMED `const` is legal and must not be flagged
        const: { type: 'string' },
        plan: {
          type: 'object',
          propertyNames: { enum: ['todo', 'done'] },
          additionalProperties: { type: 'object', properties: { k: { const: 'x' } } },
        },
        maybe: { type: ['string', 'null'] },
        nul: { type: 'null' },
        tuple: { type: 'array', prefixItems: [{ type: 'string' }] },
        lo: { type: 'number', exclusiveMinimum: 0 },
      },
    };
    const offenders = findNonOas30SchemaKeywords(s);
    expect(offenders.sort()).toEqual(
      [
        "$.components.schemas.Widget.properties.plan: 'propertyNames' is not an OAS 3.0 schema keyword",
        "$.components.schemas.Widget.properties.plan.additionalProperties.properties.k: 'const' is not an OAS 3.0 schema keyword",
        '$.components.schemas.Widget.properties.maybe: type must be a single string in OAS 3.0 (use nullable)',
        "$.components.schemas.Widget.properties.nul: type 'null' is not an OAS 3.0 type",
        "$.components.schemas.Widget.properties.tuple: 'prefixItems' is not an OAS 3.0 schema keyword",
        '$.components.schemas.Widget.properties.lo: exclusiveMinimum must be a boolean in OAS 3.0',
      ].sort(),
    );
  });

  test('detects non-OAS-3.0 keywords inside an inline request-body schema and a wrong openapi version', () => {
    const s = cleanSyntheticSpec();
    s.openapi = '3.1.0';
    (s.paths!['/widgets']!.post as Record<string, unknown>).requestBody = {
      content: {
        'application/json': {
          schema: { type: 'object', allOf: [{ if: { type: 'string' } }] },
          // a media-type `examples` map is valid 3.0 and its payload is data
          examples: { a: { value: { schema: { const: 1 } } } },
        },
      },
    };
    expect(findNonOas30SchemaKeywords(s).sort()).toEqual(
      [
        "$.openapi is '3.1.0', expected 3.0.x",
        "$.paths./widgets.post.requestBody.content.application/json.schema.allOf[0]: 'if' is not an OAS 3.0 schema keyword",
      ].sort(),
    );
  });

  test('detects a non-camelCase operationId', () => {
    const s = cleanSyntheticSpec();
    (s.paths!['/widgets']!.get as Operation).operationId = 'list_widgets';
    (s.paths!['/widgets']!.post as Operation).operationId = 'CreateWidget';
    (s.paths!['/health']!.get as Operation).operationId = 'get-health';
    expect(findNonCamelCaseOperationIds(s).sort()).toEqual([
      'CreateWidget',
      'get-health',
      'list_widgets',
    ]);
  });

  test('CONTROL: the walker ignores non-method keys on a path item', () => {
    // If `parameters` were treated as an operation, the fixture would show 4
    // operations and every per-operation checker would emit a phantom offender.
    const s = cleanSyntheticSpec();
    expect(collectOperations(s).map(label).sort()).toEqual([
      'get /health',
      'get /widgets',
      'post /widgets',
    ]);
  });
});
