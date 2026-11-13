#!/usr/bin/env bun
// backend/scripts/check-served-spec.ts
//
// CI guard — the served OpenAPI document (`GET /openapi.json`) equals its COMMITTED lock,
// `src/capabilities/served-spec.lock.json`: one row per operation (in served order) with the
// sha256 of its exact bytes, one sha256 per component schema, and one for the rest of the
// document (info, servers, security schemes, security, tags).
//
// WHY (fr-agui P4d-2a part 2 audit, P4d-2e). The frozen operations were moved out of the
// hand-written openapi.ts literal "verbatim", and the only proof of that was a one-off diff file:
// a test that compared each served op with the capability's OWN copy (a
// self-comparison), so the mutation `required: true → false` in a frozen op passed every test.
// With the literal deleted, nothing else holds the served bytes still. n8n-nodes-fr and the
// frontend client are generated from this document, so an unreviewed change to ANY operation is
// a consumer change shipping silently. This guard makes every such change a red CI run until the
// lock row changes with it — i.e. a visible line in the PR diff naming the operation.
//
// What a red run means, and the fix: an operation (or component, or the document) is served
// differently from what the lock records. If the change is intended, regenerate the lock IN THE
// SAME PR and let review read the diff:
//
//     bun run scripts/check-served-spec.ts --write
//
// The lock is also the served PATH ORDER (capabilities/served-spec.ts): a new operation is served
// after every locked one, and --write appends its row there.
//
// WHAT THIS DOES NOT CATCH (stated so a green run is not over-read):
//   * Whether an operation describes its route's REAL behaviour — the real-pipeline sweeps
//     (tests/unit/capabilities/*real-pipeline*) and the route-spec coverage guard own that.
//   * A change made together with a regenerated lock. That is the point: it is then a reviewed
//     diff, not a silent one. The row names the operation; the sha alone does not say what moved,
//     so read the operation in the served spec (`curl /openapi.json`, or the dump below).
//
// Exit: 0 equal · 1 the served spec differs from the lock · 2 the guard cannot trust its input.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BACKEND_DIR } from './lib/route-table';

export const EXIT_OFFENCES = 1;
export const EXIT_BROKEN_GUARD = 2;
export const LOCK_FILE = 'src/capabilities/served-spec.lock.json';

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'];

export interface LockRow {
  op: string;
  operationId: string;
  sha256: string;
}

export interface ServedSpecLock {
  document: string;
  components: Record<string, string>;
  operations: LockRow[];
}

type Spec = { paths?: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, unknown> } } & Record<string, unknown>;

export const sha256 = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The lock a spec would produce (served order). */
export function lockOf(spec: Spec): ServedSpecLock {
  const operations: LockRow[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item ?? {})) {
      if (!HTTP_METHODS.includes(method)) continue;
      const operationId = (op as { operationId?: unknown } | null)?.operationId;
      operations.push({ op: `${method.toUpperCase()} ${path}`, operationId: typeof operationId === 'string' ? operationId : '<none>', sha256: sha256(op) });
    }
  }
  const schemas = spec.components?.schemas ?? {};
  const components = Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, sha256(v)]));
  const { paths: _p, ...rest } = spec;
  const restComponents = { ...((rest.components as Record<string, unknown> | undefined) ?? {}) };
  delete restComponents.schemas;
  return { document: sha256({ ...rest, components: restComponents }), components, operations };
}

export interface Offence {
  kind: 'operation-changed' | 'operation-added' | 'operation-removed' | 'operationId-changed' | 'order' | 'component' | 'document';
  key: string;
  detail: string;
}

export function compareToLock(served: ServedSpecLock, locked: ServedSpecLock): Offence[] {
  const out: Offence[] = [];
  const lockedBy = new Map(locked.operations.map((r) => [r.op, r]));
  const servedBy = new Map(served.operations.map((r) => [r.op, r]));
  for (const r of served.operations) {
    const l = lockedBy.get(r.op);
    if (l === undefined) {
      out.push({ kind: 'operation-added', key: r.op, detail: `${r.operationId}: served, not in the lock` });
      continue;
    }
    if (l.operationId !== r.operationId) out.push({ kind: 'operationId-changed', key: r.op, detail: `${l.operationId} → ${r.operationId}` });
    else if (l.sha256 !== r.sha256) out.push({ kind: 'operation-changed', key: r.op, detail: `${r.operationId}: its served bytes differ from the lock` });
  }
  for (const l of locked.operations) {
    if (!servedBy.has(l.op)) out.push({ kind: 'operation-removed', key: l.op, detail: `${l.operationId}: in the lock, no longer served` });
  }
  // The served order of the locked operations IS the lock's order (served-spec.ts places by it):
  // a disagreement means the builder stopped honouring the lock.
  const servedLocked = served.operations.filter((r) => lockedBy.has(r.op)).map((r) => r.op);
  const lockedServed = locked.operations.filter((r) => servedBy.has(r.op)).map((r) => r.op);
  const firstDiff = servedLocked.findIndex((k, i) => k !== lockedServed[i]);
  if (firstDiff >= 0) out.push({ kind: 'order', key: servedLocked[firstDiff]!, detail: `served at position ${firstDiff}, the lock has ${lockedServed[firstDiff]} there` });
  for (const name of new Set([...Object.keys(served.components), ...Object.keys(locked.components)])) {
    if (served.components[name] !== locked.components[name]) {
      const what = locked.components[name] === undefined ? 'added' : served.components[name] === undefined ? 'removed' : 'changed';
      out.push({ kind: 'component', key: `#/components/schemas/${name}`, detail: what });
    }
  }
  if (served.document !== locked.document) {
    out.push({ kind: 'document', key: '(document)', detail: 'info / servers / securitySchemes / security / tags differ from the lock' });
  }
  return out;
}

export function lockBrokenError(lock: unknown): string | null {
  const l = lock as Partial<ServedSpecLock> | null;
  if (l === null || typeof l !== 'object' || !Array.isArray(l.operations) || typeof l.document !== 'string' || typeof l.components !== 'object') {
    return `${LOCK_FILE} is not a served-spec lock ({ document, components, operations[] }). Regenerate with --write.`;
  }
  if (l.operations.length === 0) return `${LOCK_FILE} lists ZERO operations — a lock of nothing proves nothing. Regenerate with --write.`;
  const seen = new Set<string>();
  for (const r of l.operations) {
    if (seen.has(r.op)) return `${LOCK_FILE} lists ${r.op} twice.`;
    seen.add(r.op);
  }
  return null;
}

export function renderLock(lock: ServedSpecLock): string {
  const head = {
    _: 'GENERATED by `bun run scripts/check-served-spec.ts --write` — the served OpenAPI document, one sha256 per operation (served order = this order), per component schema, and for the rest of the document. Checked in CI; regenerate in the PR that changes the spec and read the diff.',
  };
  return `${JSON.stringify({ ...head, ...lock }, null, 2)}\n`;
}

export async function main(argv: ReadonlyArray<string> = []): Promise<number> {
  const TAG = '[check-served-spec]';
  const { openapiSpec } = await import('../src/capabilities/served-spec');
  const served = lockOf(openapiSpec as unknown as Spec);
  if (served.operations.length === 0) {
    console.error(`${TAG} FAIL: the served spec has ZERO operations — refusing to compare nothing.`);
    return EXIT_BROKEN_GUARD;
  }
  // `--lock=<path>`: compare against another lock file (the unit test's fixtures). Never with --write.
  const lockArg = argv.find((a) => a.startsWith('--lock='))?.slice('--lock='.length);
  const file = lockArg ?? join(BACKEND_DIR, LOCK_FILE);
  if (argv.includes('--write')) {
    if (lockArg !== undefined) {
      console.error(`${TAG} FAIL: --write regenerates ${LOCK_FILE} only; drop --lock.`);
      return EXIT_BROKEN_GUARD;
    }
    writeFileSync(file, renderLock(served));
    console.log(`${TAG} wrote ${LOCK_FILE}: ${served.operations.length} operations, ${Object.keys(served.components).length} component schemas.`);
    return 0;
  }
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`${TAG} FAIL: cannot read ${file}: ${(err as Error).message}`);
    return EXIT_BROKEN_GUARD;
  }
  const broken = lockBrokenError(lock);
  if (broken !== null) {
    console.error(`${TAG} FAIL: ${broken}`);
    return EXIT_BROKEN_GUARD;
  }
  const offences = compareToLock(served, lock as ServedSpecLock);
  if (offences.length > 0) {
    console.error(`${TAG} FAIL: the served OpenAPI document differs from ${LOCK_FILE}:\n`);
    for (const o of offences) console.error(`  [${o.kind}] ${o.key} — ${o.detail}`);
    console.error(
      `\n${offences.length} difference(s). If intended, regenerate the lock in THIS PR (bun run scripts/check-served-spec.ts --write) ` +
        'and let review read the diff: n8n-nodes-fr and the frontend client are generated from this document.',
    );
    return EXIT_OFFENCES;
  }
  console.log(
    `${TAG} OK: ${served.operations.length} served operation(s), ${Object.keys(served.components).length} component schema(s) and the ` +
      `document equal ${LOCK_FILE}. ⚠️ Equal to the LOCK, not proven equal to the routes' behaviour.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
