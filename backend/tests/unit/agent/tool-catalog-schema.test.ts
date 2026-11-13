/**
 * fr#1383 — the tool catalog the model sees must advertise each action's real
 * input schema, derived from the SAME zod schema the registry validates with.
 *
 * Before: `extractJsonSchema` probed a `toJsonSchema()` method zod 3 does not
 * have, so EVERY catalog entry carried `inputJsonSchema: null`. The model never
 * saw a parameter name and called `agent.search_library` without `query`
 * (required at invoke) on every attempt.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { z, type ZodTypeAny } from 'zod';

import { listActions } from '../../../src/agui/registry';
import { registerAllActions, ACTION_MODULE_LOADERS } from '../../../src/agui/register-all-actions';
import { buildToolCatalog, extractJsonSchema } from '../../../src/agent/tool-catalog';
import type { ActionContext } from '../../../src/agui/types';

const ctx: ActionContext = {
  userId: 'u1',
  projectId: null,
  correlationId: 'cid-catalog',
  initiator: 'agent',
  channel: 'web',
  tenantRoles: ['super_admin'],
};

const SRC_DIR = resolve(import.meta.dir, '../../../src');
const REGISTER_ALL_PATH = join(SRC_DIR, 'agui/register-all-actions.ts');

let registeredCount = 0;

beforeAll(async () => {
  // Load the registry EXACTLY the way production does: `server.ts` calls
  // `registerAllActions()` once at boot, and so does this test. That covers
  // the agui/actions/* modules AND the route modules (routes/tools/{kag,
  // coding,analytics,kanban}, routes/assets/artifacts) whose `registerAction`
  // calls run at import time. Importing those route modules has no DB/network
  // side effect: the DB client is a lazily-connecting pool and nothing at
  // their top level issues a query or a request.
  await registerAllActions();
  registeredCount = listActions().length;
});

/** Every `.ts` under `src/` (no tests), for the static completeness scan. */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * A module REGISTERS actions iff it imports `registerAction` from the registry
 * AND calls it (a mention inside a log string, e.g. coverage-check.ts, is not one).
 */
function registersActions(src: string): boolean {
  return (
    /import\s*\{[^}]*\bregisterAction\b[^}]*\}\s*from\s*['"][^'"]*agui\/registry['"]|import\s*\{[^}]*\bregisterAction\b[^}]*\}\s*from\s*['"]\.\.?\/registry['"]/.test(src) &&
    /\bregisterAction\s*\(/.test(src)
  );
}

/** Strip `//` line and block comments (good enough for a call-site scan). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/**
 * ⛔ COMPLETENESS GUARD (fr#1383). The keep-out below proves "every REGISTERED
 * action reaches the model with its schema" — which is vacuous for an action
 * whose module is never loaded. These two checks use an instrument independent
 * of the registry (a static text scan of `src/`) to prove the registry the test
 * built is the whole set.
 */
describe('completeness: the test registry is the production registry (fr#1383)', () => {
  test('every src module that CALLS registerAction( is a loader in registerAllActions', () => {
    const registry = join(SRC_DIR, 'agui/registry.ts');
    const callers = walkTs(SRC_DIR)
      .filter((f) => f !== registry && registersActions(code(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC_DIR, f))
      .sort();
    const manifestSrc = readFileSync(REGISTER_ALL_PATH, 'utf8');
    const loaded = [...code(manifestSrc).matchAll(/import\(\s*'([^']+)'\s*\)/g)]
      .map((m) => relative(SRC_DIR, resolve(dirname(REGISTER_ALL_PATH), m[1]!) + '.ts'))
      .sort();
    // The parsed literals ARE the runtime array (no hidden/computed loaders).
    expect(loaded.length).toBe(ACTION_MODULE_LOADERS.length);
    // Floor: the scan really ran over the action modules. Non-vacuity only — no
    // count of the surface is pinned.
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((f) => !loaded.includes(f))).toEqual([]);
  });

  test('every action name statically declared in a registering module is in the registry', () => {
    const names = new Set<string>();
    for (const f of walkTs(SRC_DIR)) {
      const src = code(readFileSync(f, 'utf8'));
      if (!registersActions(src) || f.endsWith('agui/registry.ts')) continue;
      for (const m of src.matchAll(/^\s*name:\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_.]+)['"]/gm)) names.add(m[1]!);
    }
    const registered = new Set(listActions().map((a) => a.name));
    // Non-vacuity: the scan must have found literal names, and the registry must
    // be at least as large. No counts of the surface are pinned.
    expect(names.size).toBeGreaterThan(0);
    expect([...names].filter((n) => !registered.has(n)).sort()).toEqual([]);
    expect(registeredCount).toBeGreaterThanOrEqual(names.size);
  });
});

describe('tool catalog input schemas (fr#1383)', () => {
  test('agent.search_library advertises `query` as a REQUIRED string', async () => {
    // fr-agui P1c (OQ-17 = c): agent.search_library is RETIRED from the agent
    // (catalog:'none'), so it is in no catalog; its schema is still the one the
    // converter derives (the REST/channel callers validate with the same zod).
    const action = listActions().find((a) => a.name === 'agent.search_library');
    expect(action?.catalog).toBe('none');
    expect((await buildToolCatalog(ctx)).find((e) => e.name === 'agent.search_library')).toBeUndefined();
    const entry = { inputJsonSchema: extractJsonSchema(action!.input) };
    const schema = entry!.inputJsonSchema as {
      type: string;
      properties: Record<string, { type?: string; minLength?: number; default?: unknown }>;
      required?: string[];
    } | null;
    expect(schema).not.toBeNull();
    expect(schema!.type).toBe('object');
    expect(schema!.required).toEqual(['query']);
    expect(schema!.properties.query).toMatchObject({ type: 'string', minLength: 1 });
    // `limit` has a zod default → optional for the caller, and says so.
    expect(schema!.properties.limit).toMatchObject({ type: 'integer', default: 5 });
  });

  test('architecture.get_entity_graph advertises entity_id as a uuid', async () => {
    const catalog = await buildToolCatalog(ctx);
    const entry = catalog.find((e) => e.name === 'architecture.get_entity_graph');
    const schema = entry!.inputJsonSchema as {
      properties: Record<string, { format?: string; description?: string }>;
      required?: string[];
    };
    expect(schema.required?.sort()).toEqual(['entity_id', 'entity_type']);
    expect(schema.properties.entity_id!.format).toBe('uuid');
    expect(schema.properties.entity_id!.description).toContain('UUID');
  });

  test('EVERY registered action has a schema, and its `required` matches what zod rejects at invoke', () => {
    const actions = listActions();
    // Floor: the registry really was populated (a vacuous loop proves nothing).
    // Non-vacuity only — no count is pinned.
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      const schema = extractJsonSchema(a.input) as { required?: string[]; type?: string } | null;
      expect({ action: a.name, hasSchema: schema !== null }).toEqual({ action: a.name, hasSchema: true });
      // Every top-level key zod reports as missing for `{}` must be advertised
      // as required, and vice versa — the two schemas are one source of truth.
      const parsed = (a.input as ZodTypeAny).safeParse({});
      const missing = parsed.success
        ? []
        : parsed.error.issues
            .filter((i) => i.path.length === 1 && i.code === 'invalid_type' && (i as { received?: string }).received === 'undefined')
            .map((i) => String(i.path[0]));
      expect({ action: a.name, required: [...(schema!.required ?? [])].sort() }).toEqual({
        action: a.name,
        required: [...new Set(missing)].sort(),
      });
    }
  });

  test('converter: optional / nullable / enum / array / record / strict', () => {
    const s = z
      .object({
        a: z.string().optional(),
        b: z.number().int().min(0).max(9),
        c: z.enum(['x', 'y']),
        d: z.array(z.string()).min(1),
        e: z.record(z.number()),
        f: z.string().nullable(),
        g: z.literal('k'),
      })
      .strict();
    expect(extractJsonSchema(s)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'integer', minimum: 0, maximum: 9 },
        c: { type: 'string', enum: ['x', 'y'] },
        d: { type: 'array', items: { type: 'string' }, minItems: 1 },
        e: { type: 'object', additionalProperties: { type: 'number' } },
        f: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        g: { const: 'k' },
      },
      required: ['b', 'c', 'd', 'e', 'f', 'g'],
      additionalProperties: false,
    });
    expect(extractJsonSchema('not zod')).toBeNull();
  });
});

describe('converter branches: union + effects/refinement (fr#1383)', () => {
  test('a union becomes anyOf of each member', () => {
    expect(extractJsonSchema(z.object({ v: z.union([z.string(), z.number()]) }))).toEqual({
      type: 'object',
      properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['v'],
    });
  });

  test('a refined / transformed object advertises the INNER object (effects are runtime-only)', () => {
    const s = z
      .object({ a: z.string().min(2), b: z.number().optional() })
      .refine((x) => x.a !== 'zz', { message: 'no zz' })
      .transform((x) => x);
    expect(extractJsonSchema(s)).toEqual({
      type: 'object',
      properties: { a: { type: 'string', minLength: 2 }, b: { type: 'number' } },
      required: ['a'],
    });
  });
});
