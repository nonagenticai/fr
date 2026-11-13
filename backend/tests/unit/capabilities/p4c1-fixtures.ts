// tests/unit/capabilities/p4c1-fixtures.ts
//
// Shared fixtures for the fr-agui P4c part-1 suites (oversight-*.test.ts): the 42
// capabilities (card types, asset scope edges, traceability, measure, the delivery
// audit, inference quality, departments, the global andon,
// verification, the control tower), the concrete request each probe
// sends (path parameters, the query / body each handler's own validation accepts),
// and the drizzle builder stand-in. No database is touched and no mock.module() is
// used.
import { ANDON_CAPABILITIES } from '../../../src/capabilities/admin/andon';
import { DEPARTMENT_CAPABILITIES } from '../../../src/capabilities/admin/departments';
import { CONTROL_TOWER_CAPABILITIES, VERIFICATION_CAPABILITIES } from '../../../src/capabilities/admin/verification';
import type { Capability } from '../../../src/capabilities/define';
import { pathParams } from '../../../src/capabilities/derive-openapi';
import { ASSET_ASSIGNMENT_CAPABILITIES } from '../../../src/capabilities/observe/asset-assignments';
import { CARD_TYPE_CAPABILITIES } from '../../../src/capabilities/observe/card-types';
import { ENGAGEMENT_CAPABILITIES } from '../../../src/capabilities/observe/engagements';
import { MEASURE_CAPABILITIES } from '../../../src/capabilities/observe/measure';
import { TRACEABILITY_CAPABILITIES } from '../../../src/capabilities/observe/traceability';

export const HOME = 'a100000c-0000-4000-8000-00000000000c';
export const OTHER = 'b200000d-0000-4000-8000-00000000000d';
export const UUID = '0195f48b-d000-7000-8000-0000000000c1';
export const T0 = '2026-10-01T00:00:00.000Z';

type Cap = Capability<unknown, unknown>;
export const OBSERVE: ReadonlyArray<Cap> = [
  ...CARD_TYPE_CAPABILITIES, ...ASSET_ASSIGNMENT_CAPABILITIES, ...TRACEABILITY_CAPABILITIES, ...MEASURE_CAPABILITIES,
  ...ENGAGEMENT_CAPABILITIES,
];
export const ADMIN: ReadonlyArray<Cap> = [
  ...DEPARTMENT_CAPABILITIES, ...ANDON_CAPABILITIES,
  ...VERIFICATION_CAPABILITIES, ...CONTROL_TOWER_CAPABILITIES,
];
export const ALL: ReadonlyArray<Cap> = [...OBSERVE, ...ADMIN];

export const byId = (id: string): Cap => {
  const c = ALL.find((x) => x.id === id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
};

/** A concrete value per path parameter name. */
const PARAM: Record<string, string> = { id: UUID, userId: 'u-target', cardType: 'bug_fix', cardId: 'card-1', runId: 'run-1' };
export const paramsOf = (cap: Cap): Record<string, string> =>
  Object.fromEntries(pathParams(cap.http.path!).map((p) => [p, PARAM[p] ?? UUID]));
export const hasBody = (cap: Cap): boolean => cap.http.method !== 'GET' && cap.http.method !== 'DELETE';

/** The query each probe sends: what the handler needs before it decides anything else. */
export const QUERIES: Record<string, Record<string, string>> = {
  'asset_assignments.list': { type: 'requirement' },
  'verification.get_evidence': { criterion: 'c_one' },
};

export const BODIES: Record<string, unknown> = {
  'departments.create': { name: 'Ops' },
  'departments.update': { name: 'Ops 2' },
  'departments.add_member': { user_id: 'u-target', role: 'dept-member' },
  'departments.update_member': { role: 'dept-manager' },
};

/** A drizzle builder stand-in: every query EXECUTES (is awaited) against `next()`. */
export function storeChain(next: () => unknown): unknown {
  const p: unknown = new Proxy(function chain() {}, {
    get(_t, key) {
      if (key === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          try {
            const v = next();
            if (v instanceof Error) reject(v);
            else resolve(v);
          } catch (e) {
            reject(e);
          }
        };
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

export const urlOf = (input: unknown): string => String(input instanceof Request ? input.url : input);

/** The path a probe hits, with its parameters and query filled in. */
export function urlFor(cap: Cap, query: Record<string, string> = QUERIES[cap.id] ?? {}): string {
  const params = paramsOf(cap);
  const path = cap.http.path!.replace(/:(\w+)/g, (_m, k: string) => encodeURIComponent(params[k]!));
  const qs = new URLSearchParams(query).toString();
  return `http://test${path}${qs ? `?${qs}` : ''}`;
}

/** The input the DECLARED rule sees: path parameters, the query and the body together. */
export function inputOf(cap: Cap, query: Record<string, string> = QUERIES[cap.id] ?? {}): Record<string, unknown> {
  return { ...paramsOf(cap), ...query, ...((hasBody(cap) ? BODIES[cap.id] : undefined) ?? {}) as Record<string, unknown> };
}
