#!/usr/bin/env bun
/**
 * scripts/bundle-n8n-schemas.ts
 *
 * Sibling of bundle-n8n-icons.ts. For each n8n custom-node package, dynamically
 * imports the compiled `dist/nodes/<Name>/<Name>.node.js`, instantiates the
 * exported class, and reads `description.properties` to capture the canonical
 * parameter schema (displayName, type, options, displayOptions, etc.).
 *
 * Emits ../src/lib/workflows/nodeSchemaManifest.ts mapping the n8n node
 * type (`<package>.<name>` AND bare `<name>`) to a trimmed property array
 * that the side-panel renderer uses to turn raw `parameters` JSON into a
 * human-readable view.
 *
 * Idempotent — commit the output and re-run on every prebuild. Stock n8n
 * built-in nodes (`n8n-nodes-base.*`) are NOT covered; the renderer falls
 * back to a value-only key/value display for those.
 *
 * ⛔ The output ships in the PUBLIC bundle. Every schema passes through
 * `sanitizeSchema` (scripts/lib/sanitize-node-schema.ts) before it is written:
 * defaults/descriptions naming in-cluster hosts, private-TLD hosts, secret
 * env-var names or private memory files are dropped.
 *
 * `--resanitize` re-emits the COMMITTED manifest through the sanitizer without
 * reading any node package — for applying a sanitizer change without a full
 * module rebuild (which would also pull in unrelated schema drift).
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizeSchema } from './lib/sanitize-node-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..');

function findModulesRoot(): string {
  let dir = FRONTEND_ROOT;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'n8n_separated_modules');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(FRONTEND_ROOT, '..', '..', 'n8n_separated_modules');
}

const MODULES_ROOT = findModulesRoot();
const MANIFEST_OUT = resolve(FRONTEND_ROOT, 'src', 'lib', 'workflows', 'nodeSchemaManifest.ts');

// ---------------------------------------------------------------------------
// Shape we keep around per property. Trimmed compared to n8n's INodeProperties
// to keep the bundled manifest under control — anything we don't render is
// dropped. Keep this in sync with `parameterRender.ts`.
// ---------------------------------------------------------------------------

interface ParamOption {
  name: string;
  value?: unknown;
  description?: string;
}

interface ParamTypeOptions {
  // n8n's UI uses `editor` to swap a plain string input for a syntax-aware
  // editor. We keep only the discriminator + language hint — the panel
  // uses them to render long strings as a <pre><code> block with a
  // language chip.
  editor?: string;
  editorLanguage?: string;
  rows?: number;
  password?: boolean;
}

interface ParamProperty {
  name: string;
  displayName: string;
  description?: string;
  type: string;
  default?: unknown;
  required?: boolean;
  options?: ParamOption[];
  displayOptions?: {
    show?: Record<string, unknown[]>;
    hide?: Record<string, unknown[]>;
  };
  typeOptions?: ParamTypeOptions;
  // For collection/fixedCollection, n8n nests properties one level deeper.
  values?: ParamProperty[];
}

// ---------------------------------------------------------------------------

function readPackageName(packageDir: string): string | null {
  const pj = join(packageDir, 'package.json');
  if (!existsSync(pj)) return null;
  try {
    const data = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string };
    return data.name ?? null;
  } catch {
    return null;
  }
}

function deriveNodeNameFromFile(nodeFile: string): string {
  const base = nodeFile.split('/').pop() ?? '';
  const stripped = base.replace(/\.node\.(ts|js)$/, '');
  if (!stripped) return '';
  return stripped[0]!.toLowerCase() + stripped.slice(1);
}

function* walkPackages(): Generator<{ packageName: string; packageDir: string }> {
  if (!existsSync(MODULES_ROOT)) {
    console.error(`No n8n_separated_modules directory at ${MODULES_ROOT} — skipping bundle.`);
    return;
  }
  for (const entry of readdirSync(MODULES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(MODULES_ROOT, entry.name);
    const pkgName = readPackageName(dir);
    if (!pkgName) continue;
    yield { packageName: pkgName, packageDir: dir };
  }
}

function findCompiledNodeFiles(packageDir: string): string[] {
  const distNodes = join(packageDir, 'dist', 'nodes');
  if (!existsSync(distNodes)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(distNodes, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subdir = join(distNodes, entry.name);
    for (const f of readdirSync(subdir)) {
      if (f.endsWith('.node.js')) out.push(join(subdir, f));
    }
  }
  return out;
}

function pickKeys<T extends object, K extends keyof T>(src: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function trimOption(o: unknown): ParamOption | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;
  const out: ParamOption = { name: r.name };
  if (r.value !== undefined) out.value = r.value;
  if (typeof r.description === 'string') out.description = r.description;
  return out;
}

function trimProperty(p: unknown): ParamProperty | null {
  if (!p || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.type !== 'string') return null;
  const out: ParamProperty = {
    name: r.name,
    displayName: typeof r.displayName === 'string' ? r.displayName : r.name,
    type: r.type,
  };
  if (typeof r.description === 'string' && r.description) out.description = r.description;
  if (r.default !== undefined) out.default = r.default;
  if (r.required === true) out.required = true;
  if (Array.isArray(r.options)) {
    const opts = r.options.map(trimOption).filter((x): x is ParamOption => x !== null);
    if (opts.length > 0) out.options = opts;
  }
  if (r.displayOptions && typeof r.displayOptions === 'object') {
    const d = r.displayOptions as { show?: unknown; hide?: unknown };
    const dRaw = pickKeys(d, ['show', 'hide'] as const);
    const trimmed: ParamProperty['displayOptions'] = {};
    if (dRaw.show && typeof dRaw.show === 'object') {
      trimmed.show = dRaw.show as Record<string, unknown[]>;
    }
    if (dRaw.hide && typeof dRaw.hide === 'object') {
      trimmed.hide = dRaw.hide as Record<string, unknown[]>;
    }
    if (trimmed.show || trimmed.hide) out.displayOptions = trimmed;
  }
  if (r.typeOptions && typeof r.typeOptions === 'object') {
    const t = r.typeOptions as Record<string, unknown>;
    const opts: ParamTypeOptions = {};
    if (typeof t.editor === 'string') opts.editor = t.editor;
    if (typeof t.editorLanguage === 'string') opts.editorLanguage = t.editorLanguage;
    if (typeof t.rows === 'number') opts.rows = t.rows;
    if (t.password === true) opts.password = true;
    if (Object.keys(opts).length > 0) out.typeOptions = opts;
  }
  // fixedCollection / collection: nested values array
  if (Array.isArray((r as { values?: unknown }).values)) {
    const nested = (r as { values: unknown[] }).values
      .map(trimProperty)
      .filter((x): x is ParamProperty => x !== null);
    if (nested.length > 0) out.values = nested;
  }
  return out;
}

interface DiscoveredSchema {
  packageName: string;
  nodeNameLower: string;
  displayName: string;
  description?: string;
  properties: ParamProperty[];
}

async function importNodeDescription(nodeFile: string): Promise<{ name?: string; displayName?: string; description?: string; properties?: unknown[] } | null> {
  try {
    const mod = (await import(pathToFileURL(nodeFile).href)) as Record<string, unknown>;
    for (const exportName of Object.keys(mod)) {
      const C = mod[exportName];
      if (typeof C !== 'function') continue;
      // n8n node classes are constructed with no args; description is set on instance.
      try {
        const inst = new (C as new () => { description?: unknown })();
        const desc = inst.description as { name?: string; displayName?: string; description?: string; properties?: unknown[] } | undefined;
        if (desc && typeof desc.name === 'string' && Array.isArray(desc.properties)) {
          return desc;
        }
      } catch {
        // class might require args or runtime — skip and continue to next export
      }
    }
  } catch (err) {
    console.warn(`schemas: import failed for ${nodeFile}: ${(err as Error).message}`);
  }
  return null;
}

async function main(): Promise<void> {
  if (process.argv.includes('--resanitize')) {
    const mod = (await import(pathToFileURL(MANIFEST_OUT).href)) as {
      nodeTypeToSchema: Record<string, NodeSchemaPayload>;
    };
    const entries = Object.entries(mod.nodeTypeToSchema);
    writeManifest(entries);
    console.log(`Re-sanitized n8n schema manifest: ${entries.length} manifest entries.`);
    return;
  }
  const found: DiscoveredSchema[] = [];
  for (const { packageName, packageDir } of walkPackages()) {
    for (const nodeFile of findCompiledNodeFiles(packageDir)) {
      const desc = await importNodeDescription(nodeFile);
      const nodeNameLower = desc?.name ?? deriveNodeNameFromFile(nodeFile);
      if (!desc || !Array.isArray(desc.properties)) {
        console.warn(`schemas: no description for ${packageName}/${nodeNameLower}`);
        continue;
      }
      const trimmed = desc.properties
        .map(trimProperty)
        .filter((x): x is ParamProperty => x !== null);
      found.push({
        packageName,
        nodeNameLower,
        displayName: desc.displayName ?? nodeNameLower,
        description: desc.description,
        properties: trimmed,
      });
    }
  }

  const manifest = new Map<string, DiscoveredSchema>();
  for (const s of found) {
    manifest.set(`${s.packageName}.${s.nodeNameLower}`, s);
    manifest.set(s.nodeNameLower, s);
  }

  const entries: Array<[string, NodeSchemaPayload]> = [...manifest.entries()].map(
    ([key, s]) => {
      const payload: NodeSchemaPayload = {
        displayName: s.displayName,
        properties: s.properties,
      };
      if (s.description) payload.description = s.description;
      return [key, payload];
    },
  );
  writeManifest(entries);
  console.log(`Bundled n8n schemas: ${found.length} nodes, ${manifest.size} manifest entries.`);
}

function writeManifest(entries: Array<[string, NodeSchemaPayload]>): void {
  const byKey = new Map(entries);
  const lines: string[] = [
    '// nodeSchemaManifest.ts',
    '//',
    '// AUTOGENERATED by frontend/scripts/bundle-n8n-schemas.ts.',
    '// Do not edit manually — re-run `bun run bundle:schemas` instead.',
    '',
    'export interface ParamOption {',
    '  name: string;',
    '  value?: unknown;',
    '  description?: string;',
    '}',
    '',
    'export interface ParamTypeOptions {',
    '  editor?: string;',
    '  editorLanguage?: string;',
    '  rows?: number;',
    '  password?: boolean;',
    '}',
    '',
    'export interface ParamProperty {',
    '  name: string;',
    '  displayName: string;',
    '  description?: string;',
    '  type: string;',
    '  default?: unknown;',
    '  required?: boolean;',
    '  options?: ParamOption[];',
    '  displayOptions?: {',
    '    show?: Record<string, unknown[]>;',
    '    hide?: Record<string, unknown[]>;',
    '  };',
    '  typeOptions?: ParamTypeOptions;',
    '  values?: ParamProperty[];',
    '}',
    '',
    'export interface NodeSchema {',
    '  displayName: string;',
    '  description?: string;',
    '  properties: ParamProperty[];',
    '}',
    '',
    'export const nodeTypeToSchema: Readonly<Record<string, NodeSchema>> = {',
  ];

  const sortedKeys = [...byKey.keys()].sort();
  for (const key of sortedKeys) {
    const payload = sanitizeSchema(byKey.get(key)!);
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(payload)},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export function schemaFor(nodeType: string): NodeSchema | undefined {');
  lines.push('  return nodeTypeToSchema[nodeType];');
  lines.push('}');
  lines.push('');

  writeFileSync(MANIFEST_OUT, lines.join('\n'));
}

interface NodeSchemaPayload {
  displayName: string;
  description?: string;
  properties: ParamProperty[];
}

await main();
