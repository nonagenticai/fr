// OpenAPI drift gates for the generated service clients (copied from the n8n
// pipeline: n8n_module_scripts/.orval/scripts/baseline.ts + regen-drift.yml).
//
//   bun run ../tooling/openapi/drift.ts --check-baseline [service…]
//     PR gate. The operationIds fr CALLS (every generated `get<Op>Url` imported
//     from `@fr/service-client-<service>` under backend/src) must equal the
//     committed baseline `tooling/openapi/baselines/<service>.json`, and every
//     one of them must exist in the committed snapshot. A snapshot refresh that
//     drops an op fr uses fails here, by name, before typecheck has to find it.
//
//   bun run ../tooling/openapi/drift.ts --write-baseline [service…]
//     Rewrite the baseline from the current source scan (commit the result).
//
//   bun run ../tooling/openapi/drift.ts --live [service…]
//     Scheduled gate. Fetch the service's LIVE openapi.json and fail when it
//     differs from the committed snapshot at all — naming added / removed
//     operations and, loudest, removed operations fr uses. (Data artifacts such
//     as RM's PM catalogue defaults are not compared live: `openapi:sync`
//     refreshes them and `clients:generate --check` guards them.)
//
// The "regenerating the committed snapshot produces no diff" gate is
// `generate-clients.ts --check`.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ensureParentDir, fromRoot, FR_ROOT, loadServices, selectServices, type OpenApiService } from './common';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

/** Services whose generated client fr calls and whose ops are baselined. */
const BASELINED = new Set(['requirements']);

/** Directories scanned for calls into the generated clients. */
const SCAN_DIRS = ['backend/src'];

interface Baseline {
  schemaVersion: 1;
  service: string;
  operationIds: string[];
}

type Spec = { paths?: Record<string, Record<string, { operationId?: string }>> };

export function operationIds(spec: Spec): string[] {
  const ids = new Set<string>();
  for (const item of Object.values(spec.paths ?? {})) {
    for (const m of METHODS) {
      const id = item?.[m]?.operationId;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids].sort();
}

/** orval's URL builder name for an operationId: `create_model` → `getCreateModelUrl`. */
export function urlBuilderName(operationId: string): string {
  const camel = operationId.replace(/[-_ ]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  return `get${camel.charAt(0).toUpperCase()}${camel.slice(1)}Url`;
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else if (/\.(ts|svelte)$/.test(entry.name)) out.push(p);
  }
}

/** Every `get…Url` named in an import from `@fr/service-client-<service>`. */
export function importedUrlBuilders(source: string, service: string): string[] {
  const names: string[] = [];
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]@fr/service-client-${service}['"]`, 'g');
  for (const m of source.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/\s+as\s+\w+$/, '');
      if (/^get\w+Url$/.test(name)) names.push(name);
    }
  }
  return names;
}

async function usedOperationIds(service: OpenApiService, spec: Spec): Promise<{ used: string[]; unknown: string[] }> {
  const byBuilder = new Map(operationIds(spec).map((id) => [urlBuilderName(id), id]));
  const files: string[] = [];
  for (const d of SCAN_DIRS) await walk(fromRoot(d), files);
  const used = new Set<string>();
  const unknown: string[] = [];
  for (const f of files) {
    for (const b of importedUrlBuilders(await readFile(f, 'utf8'), service.name)) {
      const id = byBuilder.get(b);
      if (id) used.add(id);
      else unknown.push(`${relative(FR_ROOT, f)}: ${b}`);
    }
  }
  return { used: [...used].sort(), unknown };
}

const baselineFile = (service: OpenApiService) => fromRoot(`tooling/openapi/baselines/${service.name}.json`);

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function checkBaseline(service: OpenApiService, write: boolean): Promise<number> {
  const spec = await readJson<Spec>(fromRoot(service.snapshotFile));
  const { used, unknown } = await usedOperationIds(service, spec);
  if (unknown.length > 0) {
    console.error(`[drift] ${service.name}: URL builders imported that the committed snapshot does not define:`);
    for (const u of unknown) console.error(`  - ${u}`);
    return 1;
  }
  const file = baselineFile(service);
  if (write) {
    await ensureParentDir(file);
    const body: Baseline = { schemaVersion: 1, service: service.name, operationIds: used };
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    console.log(`[drift] ${service.name}: wrote ${used.length} operationIds to ${relative(FR_ROOT, file)}`);
    return 0;
  }
  let baseline: Baseline;
  try {
    baseline = await readJson<Baseline>(file);
  } catch {
    console.error(`[drift] ${service.name}: no baseline at ${relative(FR_ROOT, file)} — run with --write-baseline`);
    return 1;
  }
  const inSpec = new Set(operationIds(spec));
  const missing = baseline.operationIds.filter((id) => !inSpec.has(id));
  const want = new Set(used);
  const have = new Set(baseline.operationIds);
  const added = used.filter((id) => !have.has(id));
  const dropped = baseline.operationIds.filter((id) => !want.has(id));
  let failed = 0;
  if (missing.length > 0) {
    console.error(`[drift] ${service.name}: operations fr uses are GONE from the snapshot: ${missing.join(', ')}`);
    failed = 1;
  }
  if (added.length > 0 || dropped.length > 0) {
    console.error(
      `[drift] ${service.name}: baseline is stale (now used: ${added.join(', ') || '-'}; no longer used: ${dropped.join(', ') || '-'}). ` +
        'Run `bun run ../tooling/openapi/drift.ts --write-baseline` in backend/ and commit it.',
    );
    failed = 1;
  }
  if (!failed) console.log(`[drift] ${service.name}: ${used.length} operations fr uses, all present in the snapshot`);
  return failed;
}

/** Stable JSON with sorted keys, so key order in the live response is not drift. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

async function checkLive(service: OpenApiService): Promise<number> {
  const snapshot = await readJson<Spec>(fromRoot(service.snapshotFile));
  let live: Spec;
  try {
    const res = await fetch(service.liveUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    live = (await res.json()) as Spec;
  } catch (err) {
    // Could not measure is NOT "measured, nothing wrong".
    console.error(`[drift] ${service.name}: could not fetch ${service.liveUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (JSON.stringify(canonical(live)) === JSON.stringify(canonical(snapshot))) {
    console.log(`[drift] ${service.name}: live spec matches the committed snapshot (${operationIds(live).length} operations)`);
    return 0;
  }
  const liveIds = new Set(operationIds(live));
  const snapIds = new Set(operationIds(snapshot));
  const added = [...liveIds].filter((id) => !snapIds.has(id));
  const removed = [...snapIds].filter((id) => !liveIds.has(id));
  console.error(`[drift] ${service.name}: LIVE spec differs from tooling/openapi/specs/${service.name}.json`);
  console.error(`  added operations (${added.length}): ${added.join(', ') || '-'}`);
  console.error(`  removed operations (${removed.length}): ${removed.join(', ') || '-'}`);
  if (BASELINED.has(service.name)) {
    try {
      const baseline = await readJson<Baseline>(baselineFile(service));
      const lost = baseline.operationIds.filter((id) => !liveIds.has(id));
      if (lost.length > 0) console.error(`  ⛔ operations fr USES that live no longer serves: ${lost.join(', ')}`);
    } catch {
      /* no baseline: the PR gate reports that */
    }
  }
  console.error('  Refresh: in backend/, `bun run openapi:sync <service> && bun run clients:generate <service>`, fix typecheck, commit.');
  return 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith('--'));
  const mode = args.find((a) => a.startsWith('--'));
  const all = await loadServices();
  const services = selectServices(all, names.length > 0 ? names : [...BASELINED]);
  let failed = 0;
  for (const s of services) {
    if (mode === '--check-baseline') failed |= await checkBaseline(s, false);
    else if (mode === '--write-baseline') failed |= await checkBaseline(s, true);
    else if (mode === '--live') failed |= await checkLive(s);
    else {
      console.error('usage: drift.ts --check-baseline | --write-baseline | --live [service…]');
      process.exit(2);
    }
  }
  process.exit(failed);
}

if (import.meta.main) await main();
