#!/usr/bin/env bun
/**
 * scripts/bundle-n8n-icons.ts
 *
 * Walks two source trees and emits one combined icon manifest:
 *
 *   1. ../../n8n_separated_modules/<package>/nodes/.../<NodeName>.node.ts
 *      — @nonagentic/n8n-nodes-* community packages (TypeScript source).
 *   2. ../../n8n-mcp/node_modules/n8n-nodes-base/dist/nodes/.../<NodeName>.node.js
 *      — upstream n8n built-in nodes (compiled JS in the n8n-mcp package).
 *
 * Each node file is parsed for the package name (custom: package.json;
 * base: hardcoded "n8n-nodes-base"), the node `name` (derived from
 * filename), and the `icon:` declaration. Four icon forms are supported:
 *
 *   1. `icon: 'file:<rel>.svg'`                         — copy the SVG.
 *   2. `icon: { light: 'file:<rel>.svg', dark: '...' }` — prefer light,
 *      copy that SVG. (Upstream n8n-base form for theme-aware icons.)
 *   3. `icon: 'fa:<glyph>'`                             — prefer a
 *      colocated SVG (named after the node, or the only `*.svg` in the
 *      folder); fall back to a generated monogram SVG (deterministic hue
 *      + node initials) so the canvas never drops to the grey fallback.
 *   4. No `icon:` line                                  — same colocated-
 *      SVG-or-monogram fallback as form 3.
 *
 * Output:
 *   ../static/n8n-icons/<pkg-shortname>/<nodeName>.svg
 *   ../src/lib/workflows/iconManifest.ts mapping `<package>.<name>` (the
 *   form n8n emits in workflow JSON) AND bare `<name>` to the bundled URL.
 *
 * Idempotent — safe to commit the output and re-run on every prebuild.
 * Versioned subdirs (Set/v1/SetV1.node.js, etc.) are deliberately skipped:
 * the top-level Set.node.js is the entry point and carries the canonical
 * `name`/icon decl; the vN files declare derived names like `setV1` that
 * workflow JSON never references.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..');

/**
 * Locate a sibling directory by walking up from FRONTEND_ROOT. Works
 * whether the script runs from the main checkout
 * (`~/fr/frontend`) or from a worktree
 * (`~/fr/.claude/worktrees/<slug>/frontend`).
 */
function findSiblingDir(...segments: string[]): string | null {
  let dir = FRONTEND_ROOT;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const MODULES_ROOT = findSiblingDir('n8n_separated_modules');
const N8N_BASE_NODES = findSiblingDir('n8n-mcp', 'node_modules', 'n8n-nodes-base', 'dist', 'nodes');
const ICONS_OUT = resolve(FRONTEND_ROOT, 'static', 'n8n-icons');
const MANIFEST_OUT = resolve(FRONTEND_ROOT, 'src', 'lib', 'workflows', 'iconManifest.ts');

interface FoundNode {
  packageName: string; // e.g. "@nonagentic/n8n-nodes-kanban"
  packageShort: string; // e.g. "kanban"
  nodeFile: string; // absolute path to the .node.ts
  nodeNameLower: string; // n8n `name` field (derived from filename)
  iconKind: 'file' | 'fa' | 'none';
  iconRefRaw: string | null; // either the relative SVG path (file:) or the FA glyph (fa:)
}

function shortName(pkgName: string): string {
  // @nonagentic/n8n-nodes-kanban → kanban
  // n8n-nodes-fr               → fr
  // scheduled-report-render    → scheduled-report-render
  const tail = pkgName.includes('/') ? pkgName.split('/').pop()! : pkgName;
  return tail.replace(/^n8n-nodes-/, '');
}

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

/**
 * Walk `rootDir` recursively for `*<ext>` files (typically `.node.ts` or
 * `.node.js`). Versioned subdirs (e.g. `Set/v1/`, `Set/v2/`) are skipped:
 * the top-level entry point carries the canonical name/icon decl, and
 * vN files derive names like `setV1` that workflow JSON never references.
 */
function findNodeFiles(rootDir: string, ext: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const versionedDir = /^v\d+$/;
  const versionedFile = new RegExp(`V\\d+${ext.replace(/\./g, '\\.')}$`);
  function recurse(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (versionedDir.test(entry.name)) continue;
        if (entry.name === '__tests__' || entry.name === 'methods') continue;
        recurse(full);
      } else if (entry.isFile() && entry.name.endsWith(ext) && !versionedFile.test(entry.name)) {
        out.push(full);
      }
    }
  }
  recurse(rootDir);
  return out;
}

const FILE_ICON_RE = /^\s*icon:\s*['"]file:([^'"]+)['"]/m;
const OBJECT_LIGHT_ICON_RE = /icon:\s*\{[^}]*?light:\s*['"]file:([^'"]+)['"]/m;
const FA_ICON_RE = /^\s*icon:\s*['"]fa:([^'"]+)['"]/m;

/**
 * Derive the n8n node `name` from the file path. n8n's convention is that
 * `description.name` equals the file basename lowercased (Planka.node.ts
 * → 'planka', Fr.node.ts → 'fr', SignalTrigger.node.ts → 'signalTrigger',
 * Code.node.js → 'code', AwsLambda.node.js → 'awsLambda').
 *
 * Parsing the first `name:` line is unsafe because many node files
 * declare `INodeProperties` arrays (`name: 'resource'`, `name: 'operation'`)
 * at module scope BEFORE the description object — those grab the regex
 * match and produce nonsense like `n8n-nodes-fr.resource`. Filename
 * convention is the load-bearing source of truth.
 */
function deriveNodeName(nodeFile: string): string {
  const base = nodeFile.split('/').pop() ?? '';
  const stripped = base.replace(/\.node\.(ts|js)$/, '');
  if (!stripped) return '';
  return stripped[0]!.toLowerCase() + stripped.slice(1);
}

function parseNode(nodeFile: string): { name: string; iconKind: FoundNode['iconKind']; iconRefRaw: string | null } | null {
  const name = deriveNodeName(nodeFile);
  if (!name) return null;
  const src = readFileSync(nodeFile, 'utf8');
  const fileMatch = src.match(FILE_ICON_RE);
  if (fileMatch) return { name, iconKind: 'file', iconRefRaw: fileMatch[1]! };
  const objMatch = src.match(OBJECT_LIGHT_ICON_RE);
  if (objMatch) return { name, iconKind: 'file', iconRefRaw: objMatch[1]! };
  const faMatch = src.match(FA_ICON_RE);
  if (faMatch) return { name, iconKind: 'fa', iconRefRaw: faMatch[1]! };
  return { name, iconKind: 'none', iconRefRaw: null };
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function* walkPackages(): Generator<{ packageName: string; packageDir: string }> {
  if (!MODULES_ROOT) {
    console.error('No n8n_separated_modules directory found — skipping custom-node bundle.');
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

/**
 * Pick a colocated SVG for nodes that use fa: icons or omit the icon
 * declaration entirely. Preference order:
 *   1. <nodeNameLower>.svg  (exact match — handles Signal/SignalTrigger
 *      where two sub-nodes live in the same dir and the SVGs are named
 *      after each node)
 *   2. the only `.svg` in the folder
 * Returns null if nothing colocated; caller falls back to a monogram.
 */
function pickColocatedSvg(nodeFile: string, nodeNameLower: string): string | null {
  const dir = dirname(nodeFile);
  const exact = join(dir, `${nodeNameLower}.svg`);
  if (existsSync(exact)) return exact;
  const svgs = readdirSync(dir).filter((f) => f.endsWith('.svg'));
  if (svgs.length === 1) return join(dir, svgs[0]!);
  return null;
}

/**
 * Generate a deterministic monogram SVG for a node with no usable icon
 * source. Two-letter initial on a packageShort-derived hue. Lives only
 * in static/n8n-icons/<pkg>/<name>.svg — never copied back to source.
 */
function monogramSvg(nodeNameLower: string, packageShort: string): string {
  // Take 1-2 leading letters, prefer camelCase split.
  const m = nodeNameLower.match(/^([a-z])([A-Z])?/);
  const initials = (m ? (m[1] ?? '') + (m[2] ?? '') : nodeNameLower.slice(0, 2)).toUpperCase() || '??';
  // Deterministic hue from packageShort so a whole package shares a colour family.
  let hash = 0;
  for (const c of packageShort) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const bg = `hsl(${hue} 65% 45%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="5" fill="${bg}"/>
  <text x="12" y="13" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif" font-size="${initials.length === 1 ? 13 : 10}" font-weight="700" fill="#ffffff">${initials}</text>
</svg>
`;
}

const found: FoundNode[] = [];
const seenKeys = new Set<string>();

function pushNode(node: FoundNode): void {
  const key = `${node.packageName}.${node.nodeNameLower}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  found.push(node);
}

// 1. Custom @nonagentic/n8n-nodes-* packages (TypeScript source).
for (const { packageName, packageDir } of walkPackages()) {
  const short = shortName(packageName);
  for (const nodeFile of findNodeFiles(join(packageDir, 'nodes'), '.node.ts')) {
    const parsed = parseNode(nodeFile);
    if (!parsed) continue;
    pushNode({
      packageName,
      packageShort: short,
      nodeFile,
      nodeNameLower: parsed.name,
      iconKind: parsed.iconKind,
      iconRefRaw: parsed.iconRefRaw,
    });
  }
}

// 2. Upstream n8n built-in nodes (compiled JS in n8n-mcp/node_modules/n8n-nodes-base).
if (N8N_BASE_NODES) {
  for (const nodeFile of findNodeFiles(N8N_BASE_NODES, '.node.js')) {
    const parsed = parseNode(nodeFile);
    if (!parsed) continue;
    pushNode({
      packageName: 'n8n-nodes-base',
      packageShort: 'base',
      nodeFile,
      nodeNameLower: parsed.name,
      iconKind: parsed.iconKind,
      iconRefRaw: parsed.iconRefRaw,
    });
  }
} else {
  console.error('No n8n-mcp/node_modules/n8n-nodes-base — skipping built-in node icons.');
}

// Copy SVGs + build the manifest map.
ensureDir(ICONS_OUT);
const manifest = new Map<string, string>();
let copiedFile = 0;
let usedColocated = 0;
let monograms = 0;
let skipped = 0;
for (const node of found) {
  const outDir = join(ICONS_OUT, node.packageShort);
  ensureDir(outDir);
  const fileName = `${node.nodeNameLower}.svg`;
  const outPath = join(outDir, fileName);

  let resolvedSrc: string | null = null;
  if (node.iconKind === 'file' && node.iconRefRaw) {
    const candidate = resolve(dirname(node.nodeFile), node.iconRefRaw);
    if (existsSync(candidate)) resolvedSrc = candidate;
  }
  if (!resolvedSrc) {
    resolvedSrc = pickColocatedSvg(node.nodeFile, node.nodeNameLower);
  }

  if (resolvedSrc) {
    copyFileSync(resolvedSrc, outPath);
    if (node.iconKind === 'file') copiedFile++;
    else usedColocated++;
  } else if (node.iconKind === 'fa' || node.iconKind === 'none') {
    writeFileSync(outPath, monogramSvg(node.nodeNameLower, node.packageShort));
    monograms++;
  } else {
    // file: declared but the referenced SVG is missing AND there is no
    // colocated SVG to fall back to — record as skipped and don't
    // register a manifest entry (canvas falls back to _fallback.svg).
    skipped++;
    continue;
  }

  // n8n encodes node type as `<package>.<name>` for namespaced packages
  // when the package is loaded; community installs render plain `<name>`.
  // Register both forms so the canvas finds an icon either way.
  const url = `/n8n-icons/${node.packageShort}/${fileName}`;
  manifest.set(`${node.packageName}.${node.nodeNameLower}`, url);
  manifest.set(node.nodeNameLower, url);
}

const lines: string[] = [
  '// iconManifest.ts',
  '//',
  '// AUTOGENERATED by frontend/scripts/bundle-n8n-icons.ts.',
  '// Do not edit manually — re-run `bun run bundle:icons` instead.',
  '',
  "export const ICON_FALLBACK = '/n8n-icons/_fallback.svg';",
  '',
  'export const nodeTypeToIconPath: Readonly<Record<string, string>> = {',
];
const sortedKeys = [...manifest.keys()].sort();
for (const key of sortedKeys) {
  lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(manifest.get(key))},`);
}
lines.push('};');
lines.push('');
lines.push('export function iconFor(nodeType: string): string {');
lines.push('  return nodeTypeToIconPath[nodeType] ?? ICON_FALLBACK;');
lines.push('}');
lines.push('');

writeFileSync(MANIFEST_OUT, lines.join('\n'));
console.log(
  `Bundled n8n icons: ${copiedFile} file: copied, ${usedColocated} fa:/none with colocated svg, ${monograms} monogram fallbacks, ${skipped} skipped (no source), ${manifest.size} manifest entries.`,
);
