#!/usr/bin/env bun
// backend/scripts/route-overlap-pairs.ts
//
// fr-agui SPEC §3.6 — route order is enforced as PINNED OVERLAP PAIRS, not as
// positions.
//
// `src/utils/router.ts` returns the FIRST row whose method matches and whose
// compiled pattern matches the path, in `router.add` order. Order therefore
// matters only between two rows of the same method whose patterns can match
// the same concrete path (`/api/approvals/void` before `/api/approvals/:approvalId`).
// Every other pair of rows is order-free.
//
// This module computes, from the static route table, the ORDERED route list the
// running server builds:
//
//   1. `src/server.ts` rows in text order,
//   2. with each `register<Name>(router)` delegation spliced in at its call site
//      (the rows of THAT function body only — `registerBridgeCommitRoute` and
//      `registerBridgeRoutes` live in one file and are called at different
//      places),
//   3. dynamic-method loops (`for (const method of ['GET', …]) router.add(method, …)`)
//      expanded to one row per method,
//   4. capability-derived rows placed by `placeCapabilityRoutes` — the SAME
//      function `deriveRouter` runs at boot (src/capabilities/derive-router.ts).
//
// …and every ordered pair of rows that overlap. `--write` pins them in
// `src/capabilities/route-overlap-pairs.json`; with no flag it prints a diff
// against the pinned file and exits 1 on any difference.
//
// ⚠️ CONDITIONAL REGISTRATION. `registerBridgeRoutes(router)` runs only when
// FR_FEATURE_BRIDGE is on. The table here is the SUPERSET (flag on): a pair that
// exists only with the flag on is still pinned, because the order must hold in
// both configurations.
//
// ⚠️ OVERLAP IS DECIDED BY PROBES, NOT BY REGEX ALGEBRA. Two patterns overlap
// when a probe path built from one matches the other's compiled regex (see
// `patternsOverlap`). That is exact for the shapes this table uses — every
// segment is a literal or a whole `:param`, plus one `(.*)` suffix row — and
// `unsupportedPatternError` refuses any other shape rather than guess.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  BACKEND_DIR,
  HANDLER_ROOT,
  ROUTE_TABLE_FILE,
  listSourceFiles,
  parseRouteTable,
} from './lib/route-table';
import { compileRoutePattern } from '../src/utils/router';
import {
  capabilityRouteRows,
  placeCapabilityRoutes,
  routeRowKey,
  type OverlapPair,
  type PlaceableRow,
} from '../src/capabilities/derive-router';
import { CAPABILITIES } from '../src/capabilities/registry';

export const OVERLAP_PAIRS_FILE = 'src/capabilities/route-overlap-pairs.json';

export interface OrderedRow extends PlaceableRow {
  /** File that registers the row (`src/server.ts`, a delegated file, or a capability module). */
  file: string;
  /** Handler text as written, or `capability:<id>` for a derived row. */
  handler: string;
}

/** `register<Name>(router)` call sites in server.ts, in text order. */
const DELEGATION_CALL_RE = /\b(register\w+)\s*\(\s*router\s*\)/g;

/** The body text of `export function <name>(` in `content`, by brace matching. */
export function functionBody(content: string, name: string): string | null {
  const start = content.search(new RegExp(`export\\s+function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const open = content.indexOf('{', content.indexOf(')', start));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Rows of one source segment, in text order, with a dynamic-method loop
 * expanded. Throws on a non-literal method it cannot expand: a row this module
 * silently dropped would make every overlap verdict about it vacuous.
 */
export function segmentRows(text: string, file: string): OrderedRow[] {
  const out: OrderedRow[] = [];
  for (const r of parseRouteTable(text)) {
    if (r.methodIsLiteral) {
      out.push({ method: r.method, path: r.path, file, handler: r.handler.replace(/\s+/g, ' ').trim() });
      continue;
    }
    const loop = new RegExp(
      `for\\s*\\(\\s*const\\s+${r.rawMethod}\\s+of\\s+\\[([^\\]]*)\\]\\s*\\)\\s*\\{?\\s*router\\.add\\(\\s*${r.rawMethod}\\s*,`,
    ).exec(text);
    if (loop === null) {
      throw new Error(
        `${file}: router.add(${r.rawMethod}, '${r.path}', …) has a non-literal method that is not a ` +
          `\`for (const ${r.rawMethod} of [...])\` loop — cannot expand it, refusing to drop it.`,
      );
    }
    for (const m of loop[1]!.split(',').map((s) => s.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean)) {
      out.push({ method: m.toUpperCase(), path: r.path, file, handler: r.handler.replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

export interface OrderedTableSources {
  serverSource?: string;
  handlerFiles?: ReadonlyArray<{ path: string; content: string }>;
  /** Capability-derived rows to place (default: the real registry). */
  capabilityRows?: ReadonlyArray<OrderedRow>;
  /** Pinned pairs `placeCapabilityRoutes` honours (default: the pinned file). */
  pairs?: ReadonlyArray<OverlapPair>;
}

/** The legacy (`router.add`) rows only, in the order the server registers them. */
export function legacyOrderedRows(sources: OrderedTableSources = {}): OrderedRow[] {
  const serverSource =
    sources.serverSource ?? readFileSync(join(BACKEND_DIR, ROUTE_TABLE_FILE), 'utf8');
  const handlerFiles =
    sources.handlerFiles ??
    listSourceFiles(join(BACKEND_DIR, HANDLER_ROOT)).map((full) => ({
      path: relative(BACKEND_DIR, full),
      content: readFileSync(full, 'utf8'),
    }));

  const out: OrderedRow[] = [];
  let cursor = 0;
  DELEGATION_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DELEGATION_CALL_RE.exec(serverSource)) !== null) {
    out.push(...segmentRows(serverSource.slice(cursor, m.index), ROUTE_TABLE_FILE));
    cursor = m.index + m[0].length;
    const name = m[1]!;
    const owner = handlerFiles.find((f) => functionBody(f.content, name) !== null);
    if (owner === undefined) {
      throw new Error(`src/server.ts calls ${name}(router) but no file under ${HANDLER_ROOT} exports it.`);
    }
    out.push(...segmentRows(functionBody(owner.content, name)!, owner.path));
  }
  out.push(...segmentRows(serverSource.slice(cursor), ROUTE_TABLE_FILE));
  return out;
}

/** The capability rows of the real registry, as ordered-table rows. */
export function registryCapabilityRows(): OrderedRow[] {
  return capabilityRouteRows(CAPABILITIES).map((r) => ({
    method: r.method,
    path: r.path,
    file: r.file,
    handler: `capability:${r.capabilityId}`,
  }));
}

export function readPinnedPairs(): OverlapPair[] {
  return JSON.parse(readFileSync(join(BACKEND_DIR, OVERLAP_PAIRS_FILE), 'utf8')).pairs as OverlapPair[];
}

/** Legacy rows plus capability rows placed exactly as `deriveRouter` places them at boot. */
export function orderedRouteTable(sources: OrderedTableSources = {}): OrderedRow[] {
  const legacy = legacyOrderedRows(sources);
  const caps = sources.capabilityRows ?? registryCapabilityRows();
  const pairs = sources.pairs ?? readPinnedPairs();
  return placeCapabilityRoutes(legacy, caps, pairs);
}

// ───────────────────────────────────────────────────────────────────────────
// Overlap
// ───────────────────────────────────────────────────────────────────────────

const PARAM_SEGMENT = /^:\w+$/;
const REGEX_SUFFIX = '(.*)';

/** A shape `patternsOverlap` decides exactly, or the reason it cannot. */
export function unsupportedPatternError(path: string): string | null {
  const body = path.endsWith(REGEX_SUFFIX) ? path.slice(0, -REGEX_SUFFIX.length) : path;
  for (const seg of body.split('/').slice(1)) {
    if (PARAM_SEGMENT.test(seg)) continue;
    if (/[:()*+?[\]{}|\\^$]/.test(seg)) {
      return `pattern ${path}: segment "${seg}" mixes a parameter or regex syntax with text`;
    }
  }
  return null;
}

/** Concrete probe paths a pattern matches: params filled from the OTHER pattern where it is literal. */
function probes(a: string, b: string): string[] {
  const aBody = a.endsWith(REGEX_SUFFIX) ? a.slice(0, -REGEX_SUFFIX.length) : a;
  const bBody = b.endsWith(REGEX_SUFFIX) ? b.slice(0, -REGEX_SUFFIX.length) : b;
  const aSegs = aBody.split('/');
  const bSegs = bBody.split('/');
  const filled = aSegs.map((seg, i) => {
    if (!PARAM_SEGMENT.test(seg)) return seg;
    const other = bSegs[i];
    return other !== undefined && other !== '' && !PARAM_SEGMENT.test(other) ? other : 'probe-x';
  });
  const base = filled.join('/');
  if (!a.endsWith(REGEX_SUFFIX)) return [base];
  // A `(.*)` suffix matches anything after the prefix: try the prefix alone and
  // the prefix extended by the rest of the other pattern's segments.
  const rest = bSegs.slice(aSegs.length).map((s) => (PARAM_SEGMENT.test(s) ? 'probe-x' : s));
  return [base, `${base}/probe-x`, rest.length > 0 ? `${base}/${rest.join('/')}` : base];
}

/** True when some concrete path matches BOTH patterns. */
export function patternsOverlap(a: string, b: string): boolean {
  const ra = compileRoutePattern(a);
  const rb = compileRoutePattern(b);
  return probes(a, b).some((p) => ra.test(p) && rb.test(p)) || probes(b, a).some((p) => ra.test(p) && rb.test(p));
}

/** Every ordered pair (earlier, later) of same-method rows that overlap. */
export function computeOverlapPairs(rows: ReadonlyArray<OrderedRow>): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.method !== b.method) continue;
      if (!patternsOverlap(a.path, b.path)) continue;
      pairs.push({ before: routeRowKey(a), after: routeRowKey(b), probe: probePath(a.path, b.path) });
    }
  }
  return pairs;
}

/** One concrete path both patterns match (the pair's evidence). */
export function probePath(a: string, b: string): string {
  const ra = compileRoutePattern(a);
  const rb = compileRoutePattern(b);
  const hit = [...probes(a, b), ...probes(b, a)].find((p) => ra.test(p) && rb.test(p));
  if (hit === undefined) throw new Error(`probePath: ${a} and ${b} do not overlap`);
  return hit;
}

/** Rows whose `METHOD pattern` key is not unique — a pair could not name them. */
export function duplicateRowKeys(rows: ReadonlyArray<OrderedRow>): string[] {
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(routeRowKey(r), (seen.get(routeRowKey(r)) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} (x${n})`);
}

export function main(argv: ReadonlyArray<string> = []): number {
  const write = argv.includes('--write');
  // Pairs are computed over the LEGACY order plus capability rows placed by the
  // CURRENT pinned file; `--write` on a fresh tree with no file pins against the
  // legacy table alone.
  let rows: OrderedRow[];
  try {
    rows = write ? orderedRouteTable({ pairs: safePinned() }) : orderedRouteTable();
  } catch (err) {
    console.error(`[route-overlap-pairs] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const unsupported = rows.map((r) => unsupportedPatternError(r.path)).filter((e): e is string => e !== null);
  if (unsupported.length > 0) {
    console.error(`[route-overlap-pairs] FAIL: unsupported pattern shape(s):\n  ${unsupported.join('\n  ')}`);
    return 2;
  }
  const pairs = computeOverlapPairs(rows);
  if (write) {
    writeFileSync(
      join(BACKEND_DIR, OVERLAP_PAIRS_FILE),
      `${JSON.stringify({ generatedBy: 'bun run scripts/route-overlap-pairs.ts --write', rows: rows.length, pairs }, null, 2)}\n`,
    );
    console.log(`[route-overlap-pairs] wrote ${pairs.length} pair(s) over ${rows.length} row(s) to ${OVERLAP_PAIRS_FILE}`);
    return 0;
  }
  const pinned = readPinnedPairs();
  const fmt = (p: OverlapPair) => `${p.before}  <  ${p.after}`;
  const pinnedSet = new Set(pinned.map(fmt));
  const liveSet = new Set(pairs.map(fmt));
  const added = [...liveSet].filter((p) => !pinnedSet.has(p));
  const removed = [...pinnedSet].filter((p) => !liveSet.has(p));
  if (added.length === 0 && removed.length === 0) {
    console.log(`[route-overlap-pairs] OK: ${pairs.length} pinned pair(s) over ${rows.length} row(s) unchanged.`);
    return 0;
  }
  console.error('[route-overlap-pairs] FAIL: overlap pairs differ from the pinned file');
  for (const p of added) console.error(`  + ${p}`);
  for (const p of removed) console.error(`  - ${p}`);
  return 1;
}

function safePinned(): OverlapPair[] {
  try {
    return readPinnedPairs();
  } catch {
    return [];
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
