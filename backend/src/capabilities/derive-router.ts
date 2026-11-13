/**
 * fr-agui SPEC §3.4 (a) + §3.6 — the router entry, derived from the declaration,
 * PLACED by pinned overlap pairs.
 *
 * `utils/router.ts` returns the first hit in registration order. Order matters
 * only between two same-method rows whose patterns can match one concrete path;
 * those pairs are pinned in `route-overlap-pairs.json`
 * (scripts/route-overlap-pairs.ts). `deriveRouter` runs once, at boot, on an
 * EMPTY router (P4d-2e: the legacy `router.add` table is gone) and registers
 * every capability row at a position that satisfies every pinned pair naming
 * it. Every other position is equivalent by construction.
 *
 * The SAME `placeCapabilityRoutes` is what the static instruments use to
 * reconstruct the boot order (scripts/route-overlap-pairs.ts), so the test of
 * the order and the order itself cannot disagree.
 *
 * Handler: `legacyHandler` when present (every route that predates its
 * declaration — the route sees exactly the function it saw before); otherwise the adapter
 * (resolve principal → conveyor gate → zod parse → assertRbac → handler).
 */
import type { ActionContext, AgentCallableAction } from '../agui/types';
import type { Router } from '../utils/router';
import type { Capability, LegacyRouteHandler } from './define';
import { pathParams } from './derive-openapi';
import { CAPABILITIES, type RegisteredCapability } from './registry';
import pinned from './route-overlap-pairs.json';

export interface PlaceableRow {
  method: string;
  path: string;
}

/** One pinned pair: the row keyed `before` must be registered before `after`. `probe` matches both. */
export interface OverlapPair {
  before: string;
  after: string;
  probe: string;
}

export const ROUTE_OVERLAP_PAIRS: ReadonlyArray<OverlapPair> = (pinned as { pairs: OverlapPair[] }).pairs;

/** `METHOD /express/path` — the identity a pinned pair names. */
export function routeRowKey(r: PlaceableRow): string {
  return `${r.method} ${r.path}`;
}

export interface CapabilityRouteRow extends PlaceableRow {
  capabilityId: string;
  file: string;
}

/** The rows the registry derives (agent-native capabilities, and an `http.unrouted` operation, have no row). */
export function capabilityRouteRows(entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES): CapabilityRouteRow[] {
  return entries
    .filter((e) => e.cap.http.path !== null && e.cap.http.unrouted === undefined)
    .map((e) => ({ method: e.cap.http.method, path: e.cap.http.path!, capabilityId: e.cap.id, file: e.file }));
}

class RoutePlacementError extends Error {
  constructor(message: string) {
    super(`route placement: ${message}`);
    this.name = 'RoutePlacementError';
  }
}

/**
 * The full ordered table: `legacy` in its order, each `caps` row inserted where
 * the pinned pairs require. A capability row with no pinned pair is appended.
 * Throws when a capability row duplicates an existing row, or when its pairs
 * cannot all be satisfied (a predecessor sits after a successor).
 */
export function placeCapabilityRoutes<T extends PlaceableRow>(
  legacy: ReadonlyArray<T>,
  caps: ReadonlyArray<T>,
  pairs: ReadonlyArray<OverlapPair> = ROUTE_OVERLAP_PAIRS,
): T[] {
  const out = [...legacy];
  const keys = new Set(out.map(routeRowKey));
  const capKeys = new Set(caps.map(routeRowKey));
  if (capKeys.size !== caps.length) throw new RoutePlacementError('two capability rows share one METHOD path');
  for (const c of caps) {
    if (keys.has(routeRowKey(c))) {
      throw new RoutePlacementError(`${routeRowKey(c)} is registered by BOTH router.add and a capability`);
    }
  }

  // Capability rows that must precede another capability row are placed first.
  const pending = [...caps];
  const placed = new Set<string>();
  while (pending.length > 0) {
    const idx = pending.findIndex((c) =>
      pairs.every((p) => p.after !== routeRowKey(c) || !capKeys.has(p.before) || placed.has(p.before)),
    );
    if (idx < 0) throw new RoutePlacementError('pinned pairs form a cycle among capability rows');
    const row = pending.splice(idx, 1)[0]!;
    const key = routeRowKey(row);
    const at = (k: string) => out.findIndex((r) => routeRowKey(r) === k);
    const lows = pairs.filter((p) => p.after === key).map((p) => at(p.before)).filter((i) => i >= 0);
    // A successor that is a capability row NOT placed yet bounds this row through ITS placed
    // successors (transitively): `A < B < legacy L` with B unplaced must put A before L too, or B
    // has no position left (P4d-2c: architecture < rollups < kag/reviews, rollups now derived).
    const highOf = (k: string, seen: ReadonlySet<string>): number[] =>
      pairs
        .filter((p) => p.before === k)
        .flatMap((p) => {
          const i = at(p.after);
          if (i >= 0) return [i];
          if (!capKeys.has(p.after) || placed.has(p.after) || seen.has(p.after)) return [];
          return highOf(p.after, new Set([...seen, p.after]));
        });
    const highs = highOf(key, new Set([key]));
    const lo = lows.length > 0 ? Math.max(...lows) + 1 : null;
    const hi = highs.length > 0 ? Math.min(...highs) : null;
    if (lo !== null && hi !== null && lo > hi) {
      throw new RoutePlacementError(`${key} must follow row ${lo - 1} and precede row ${hi}: unsatisfiable`);
    }
    out.splice(lo ?? hi ?? out.length, 0, row);
    placed.add(key);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Adapter (capabilities with no legacyHandler)
// ───────────────────────────────────────────────────────────────────────────

/** Adapter collaborators, all late-bound (dynamic import) so this module stays side-effect free. */
async function adapterPrincipal(req: Request): Promise<Pick<ActionContext, 'userId' | 'tenantId' | 'tenantRoles' | 'tenantClaim'>> {
  const { validateAuthWithToken } = await import('../middleware/auth');
  const { user } = await validateAuthWithToken(req);
  // tenantClaim: the RAW verified claim, read only by the `workspace-admin` rule.
  return {
    userId: user.id,
    tenantId: user.tenantId,
    tenantRoles: user.roles,
    ...(user.tenantClaim !== undefined ? { tenantClaim: user.tenantClaim } : {}),
  };
}

async function adapterConveyorGate(): Promise<Response | null> {
  const { conveyorNotConfiguredResponse } = await import('../lib/conveyor-configured-gate');
  return conveyorNotConfiguredResponse();
}

async function adapterAssertRbac(cap: Capability<any, any>, ctx: ActionContext, input: unknown): Promise<void> {
  const { assertRbac } = await import('../agui/rbac');
  // assertRbac reads only `rbac` (and `name` for messages): the declared rule, verbatim.
  await assertRbac({ name: cap.id, rbac: cap.auth.rbac } as unknown as AgentCallableAction, ctx, input);
}

async function adapterErrorResponse(err: unknown): Promise<Response> {
  const { handleError } = await import('../utils/errors');
  return handleError(err);
}

/** Path params (by name) ∪ query (GET/DELETE) or JSON body — the one input object. */
async function adapterInput(cap: Capability<any, any>, req: Request, params: string[]): Promise<Record<string, unknown>> {
  const names = cap.http.path === null ? [] : pathParams(cap.http.path);
  const fromPath = Object.fromEntries(names.map((n, i) => [n, params[i]]));
  if (cap.http.method === 'GET' || cap.http.method === 'DELETE') {
    return { ...Object.fromEntries(new URL(req.url).searchParams), ...fromPath };
  }
  const text = await req.text();
  const body = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  // `http.queryFields` (P4b): named query parameters of a body method.
  const search = new URL(req.url).searchParams;
  const fromQuery = Object.fromEntries((cap.http.queryFields ?? []).filter((n) => search.has(n)).map((n) => [n, search.get(n)]));
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ...fromQuery, ...fromPath, body };
  }
  return { ...(body as Record<string, unknown>), ...fromQuery, ...fromPath };
}

function capabilityAdapter(cap: Capability<any, any>): LegacyRouteHandler {
  const handler = cap.handler;
  if (handler === undefined) throw new RoutePlacementError(`${cap.id} has neither handler nor legacyHandler`);
  return async (req: Request, ...params: string[]) => {
    try {
      // Conveyor gate FIRST, before auth (as handleCreateProject does; SPEC §3.4 a).
      if (cap.conveyorGated) {
        const gated = await adapterConveyorGate();
        if (gated !== null) return gated;
      }
      const who = await adapterPrincipal(req);
      const raw = await adapterInput(cap, req, params);
      const parsed = cap.input.safeParse(raw);
      if (!parsed.success) {
        return Response.json(
          { error: 'invalid_input', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
          { status: 400 },
        );
      }
      const ctx: ActionContext = {
        ...who,
        projectId: typeof raw.id === 'string' && cap.tenancy === 'project' ? raw.id : null,
        correlationId: req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
        initiator: 'human',
        channel: 'web',
      };
      await adapterAssertRbac(cap, ctx, parsed.data);
      const out = await handler(parsed.data, ctx);
      const status = cap.http.successStatus ?? 200;
      return status === 204 ? new Response(null, { status }) : Response.json(out, { status });
    } catch (err) {
      return adapterErrorResponse(err);
    }
  };
}

/** The function the router calls for one capability. */
export function capabilityRouteHandler(cap: Capability<any, any>): LegacyRouteHandler {
  return cap.legacyHandler ?? capabilityAdapter(cap);
}

/**
 * Build THE route table: every capability row registered into `router`, placed by the pinned pairs.
 * fr-agui P4d-2e: there is no legacy `router.add` table any more — the router must be EMPTY (a row
 * registered beside the registry would be a route no declaration, spec or guard knows about).
 */
export function deriveRouter(
  router: Router,
  entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES,
  pairs: ReadonlyArray<OverlapPair> = ROUTE_OVERLAP_PAIRS,
): void {
  const existing = router.list();
  if (existing.length > 0) {
    throw new RoutePlacementError(
      `the router already holds ${existing.length} row(s) (${existing.slice(0, 3).map(routeRowKey).join(', ')}…): every route is a ` +
        'capability (src/capabilities/registry.ts); declare it there instead of calling router.add',
    );
  }
  const byId = new Map<string, Capability<any, any>>(entries.map((e) => [e.cap.id, e.cap]));
  // `http.mountedWhen` (P4b part 3): a feature-flagged row is left out when its flag is off.
  const mounted = entries.filter((e) => e.cap.http.mountedWhen?.() ?? true);
  const ordered = placeCapabilityRoutes([], capabilityRouteRows(mounted), pairs);
  for (const row of ordered) router.add(row.method, row.path, capabilityRouteHandler(byId.get(row.capabilityId)!));
}
