// src/lib/super-admin-tenant-audit.ts
//
// ⭐ George 2026-10-27: a super_admin is TENANT-ADMIN in any tenant it switches
// into — "every such action audited". Two layers, both keyed on the request
// frame `buildRequestContext` built (never on anything a client can set), and
// both decided by ONE predicate, `switchedSuperAdminFrame`:
//
//   1. `recordSuperAdminSwitchRequest` — the structured `[super-admin-switch]`
//      line. EVERY WRITE is logged. READS are deduplicated (coordinator decision
//      2026-10-28, measured ~150k switched requests/day, almost all GET polls):
//      one line per (actor, via, target tenant) per hour, kept in a bounded
//      in-process LRU. Every switched request — read or write, logged or not —
//      is COUNTED (`fr_super_admin_switch_requests_total{via,kind}`), so the rate
//      is never lost. The kanban / approvals WebSocket upgrade emits the same
//      line (via `ws-upgrade`).
//   2. `recordSuperAdminTenantWrite` — ONE durable `super_admin_tenant_actions`
//      row (migration 215, append-only) per WRITE (method not GET/HEAD/OPTIONS),
//      with the status the handler answered — or 500 when it threw. server.ts
//      runs it through `withSuperAdminWriteAudit`, in a `finally`.
//   3. `auditSuperAdminAgentAction` — ONE row per WRITE agent action the
//      registry runs (`invokeAction`), with the action name and its outcome.
//      A Copilot chat turn runs its no-confirm-card writes IN-PROCESS (one HTTP
//      request, many actions), so layer 2 alone would leave one opaque row.
//
// "Switched" =
//   * `via: 'active-tenant-header'` — a SIGNED super_admin whose X-Active-Tenant
//     was accepted and names a tenant other than their own JWT tenant; or
//   * `via: 'agent-session'` — an fr-minted Copilot token carrying the
//     `super_admin_switch` claim, i.e. a session issued for a switched fr
//     super-admin session (services/agent-session.ts). Its frame has no signed
//     claims, so without this arm every Copilot write in a switched tenant would
//     go unaudited.
// A super_admin in their home tenant, any non-super_admin and a licence token
// are never recorded here.
//
// Telemetry never fails the request: both recorders swallow their own errors
// (logged under the tag, so a lost audit row is visible).

import { db, superAdminTenantActions } from '../db/client';
import type { RequestContext } from '../integrations/_lib/context';

/** The stable log tag. Grep / Loki-query this, never the free-text message. */
export const SUPER_ADMIN_SWITCH_LOG_TAG = '[super-admin-switch]';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** GET / HEAD / OPTIONS — the methods that are not audited as a write. */
export function isReadMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toUpperCase());
}

function routePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export type SwitchedVia = 'active-tenant-header' | 'agent-session' | 'ws-upgrade';

export interface SwitchedSuperAdminFrame {
  actorUserId: string;
  tenantId: string;
  homeTenantId: string | undefined;
  via: SwitchedVia;
}

type AuditFrame = Pick<
  RequestContext,
  'activeTenantVia' | 'tenantId' | 'jwtTenantId' | 'callerIsSuperAdmin' | 'userId' | 'agentSuperAdminSwitch'
>;

/** THE predicate: is this frame a super_admin (or their switched Copilot) acting outside home? */
export function switchedSuperAdminFrame(ctx: AuditFrame): SwitchedSuperAdminFrame | null {
  if (typeof ctx.userId !== 'string' || ctx.userId.length === 0) return null;
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.length === 0) return null;
  if (ctx.agentSuperAdminSwitch === true) {
    return { actorUserId: ctx.userId, tenantId: ctx.tenantId, homeTenantId: undefined, via: 'agent-session' };
  }
  if (ctx.activeTenantVia !== 'active-tenant-header' || ctx.callerIsSuperAdmin !== true) return null;
  if (ctx.tenantId === ctx.jwtTenantId) return null;
  return { actorUserId: ctx.userId, tenantId: ctx.tenantId, homeTenantId: ctx.jwtTenantId, via: 'active-tenant-header' };
}

// ── Read-line dedupe + the counter ───────────────────────────────────────────

/** A READ line is logged at most once per (actor, via, target tenant) per this window. */
export const READ_LINE_WINDOW_MS = 60 * 60 * 1000;
/** Bound on the dedupe memory: least-recently-logged keys are evicted first. */
export const READ_LINE_LRU_MAX = 5_000;

/** key → epoch ms the read line was last logged. Map iteration order = LRU order. */
const readLineLoggedAt = new Map<string, number>();
const nowFn: () => number = () => Date.now();

const VIAS: readonly SwitchedVia[] = ['active-tenant-header', 'agent-session', 'ws-upgrade'];
const switchCounts = new Map<string, number>();
function countSwitch(via: SwitchedVia, kind: 'read' | 'write'): void {
  const k = `${via}|${kind}`;
  switchCounts.set(k, (switchCounts.get(k) ?? 0) + 1);
}

/** True iff a READ line for `key` should be logged now (and records it). */
function shouldLogRead(key: string): boolean {
  const now = nowFn();
  const last = readLineLoggedAt.get(key);
  if (last !== undefined && now - last < READ_LINE_WINDOW_MS) return false;
  readLineLoggedAt.delete(key); // re-insert ⇒ most recently used
  readLineLoggedAt.set(key, now);
  while (readLineLoggedAt.size > READ_LINE_LRU_MAX) {
    const oldest = readLineLoggedAt.keys().next().value;
    if (oldest === undefined) break;
    readLineLoggedAt.delete(oldest);
  }
  return true;
}

/** Prometheus text-exposition lines for the switch counter. Rendered by routes/metrics.ts. */
export function renderSuperAdminSwitchMetrics(): string[] {
  const lines = [
    '# HELP fr_super_admin_switch_requests_total Requests a super_admin (or their switched Copilot session) sent into a tenant other than their own, by surface and read/write. Every one is counted; the [super-admin-switch] log line keeps every write and one read per (actor, surface, tenant) per hour.',
    '# TYPE fr_super_admin_switch_requests_total counter',
  ];
  for (const via of VIAS) {
    for (const kind of ['read', 'write'] as const) {
      lines.push(`fr_super_admin_switch_requests_total{via="${via}",kind="${kind}"} ${switchCounts.get(`${via}|${kind}`) ?? 0}`);
    }
  }
  return lines;
}

/**
 * The `[super-admin-switch]` line for one switched request: always for a write,
 * deduplicated for a read (see above). Counts every call. Never throws.
 */
export function recordSuperAdminSwitchRequest(args: {
  actor: string | undefined;
  tenantId: string;
  homeTenantId: string | undefined;
  via?: SwitchedVia;
  method: string;
  url: string;
}): void {
  try {
    const via = args.via ?? 'active-tenant-header';
    const write = !isReadMethod(args.method);
    countSwitch(via, write ? 'write' : 'read');
    if (!write && !shouldLogRead(`${args.actor ?? ''}|${via}|${args.tenantId}`)) return;
    console.info(
      SUPER_ADMIN_SWITCH_LOG_TAG,
      JSON.stringify({
        event: 'super_admin_switch',
        actor: args.actor ?? null,
        tenant_id: args.tenantId,
        home_tenant_id: args.homeTenantId ?? null,
        via,
        method: args.method.toUpperCase(),
        route: routePath(args.url),
        write,
      }),
    );
  } catch {
    // A broken logger must not fail the request.
  }
}

export interface SuperAdminTenantWrite {
  actorUserId: string;
  tenantId: string;
  homeTenantId: string | undefined;
  method: string;
  url: string;
  status: number;
  correlationId: string | undefined;
  /** Agent-action rows: `action:<name>` (else derived from `url`). */
  route?: string;
  actionName?: string;
  outcome?: AgentActionOutcome;
}

/** What an audited agent WRITE action did. */
export type AgentActionOutcome = 'executed' | 'parked' | 'proposed' | 'failed';

async function sink(row: typeof superAdminTenantActions.$inferInsert): Promise<void> {
  await db.insert(superAdminTenantActions).values(row);
}

/**
 * Persist one write. Returns a promise that never rejects (the caller awaits it
 * so the row exists before the response leaves; a failed insert is logged).
 */
export async function recordSuperAdminTenantWrite(
  w: SuperAdminTenantWrite,
): Promise<void> {
  if (isReadMethod(w.method)) return;
  try {
    await sink({
      actor_user_id: w.actorUserId,
      tenant_id: w.tenantId,
      home_tenant_id: w.homeTenantId ?? null,
      method: w.method.toUpperCase(),
      route: w.route ?? routePath(w.url),
      status: w.status,
      action_name: w.actionName ?? null,
      outcome: w.outcome ?? null,
      correlation_id: w.correlationId ?? null,
    });
  } catch (err) {
    try {
      console.error(
        SUPER_ADMIN_SWITCH_LOG_TAG,
        JSON.stringify({
          event: 'super_admin_tenant_write_audit_failed',
          actor: w.actorUserId,
          tenant_id: w.tenantId,
          method: w.method.toUpperCase(),
          route: w.route ?? routePath(w.url),
          action_name: w.actionName ?? null,
          status: w.status,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch {
      // nothing left to do
    }
  }
}

/**
 * Persist the write iff `switchedSuperAdminFrame(ctx)`. Reads and every other
 * frame are a no-op. Never throws.
 */
export async function auditSwitchedSuperAdminWrite(
  ctx: AuditFrame & Pick<RequestContext, 'correlationId'>,
  method: string,
  url: string,
  status: number,
): Promise<void> {
  if (isReadMethod(method)) return;
  const switched = switchedSuperAdminFrame(ctx);
  if (!switched) return;
  await recordSuperAdminTenantWrite({
    actorUserId: switched.actorUserId,
    tenantId: switched.tenantId,
    homeTenantId: switched.homeTenantId,
    method,
    url,
    status,
    correlationId: ctx.correlationId,
  });
}

/**
 * server.ts's ONE wrapper around request handling: runs `handle`, then audits
 * the write with the status it answered — in a `finally`, so a handler error
 * that escapes is audited too (status 500) before it propagates. A `undefined`
 * result (a WebSocket upgrade Bun took over) is audited as 101.
 */
export async function withSuperAdminWriteAudit<T extends Response | undefined>(
  ctx: AuditFrame & Pick<RequestContext, 'correlationId'>,
  req: Request,
  handle: () => Promise<T>,
): Promise<T> {
  let status = 500;
  try {
    const res = await handle();
    status = res === undefined ? 101 : res.status;
    return res;
  } finally {
    await auditSwitchedSuperAdminWrite(ctx, req.method, req.url, status);
  }
}

/**
 * Layer 3: run one registry WRITE action and, iff the request frame is a
 * switched super_admin (or their switched Copilot session —
 * `switchedSuperAdminFrame`), persist one row with the action name and its
 * outcome: `executed` (200), `parked` (202, an approval was minted), `proposed`
 * (202, a confirm card was handed back) or `failed` (the error's status, 500
 * when it has none; the error is rethrown). Any other frame: just runs `run`.
 */
export async function auditSuperAdminAgentAction<T>(
  frame: (AuditFrame & Pick<RequestContext, 'correlationId'>) | undefined,
  actionName: string,
  run: () => Promise<T>,
): Promise<T> {
  const switched = frame ? switchedSuperAdminFrame(frame) : null;
  if (!switched) return run();
  const write = (outcome: AgentActionOutcome, status: number) =>
    recordSuperAdminTenantWrite({
      actorUserId: switched.actorUserId,
      tenantId: switched.tenantId,
      homeTenantId: switched.homeTenantId,
      method: 'ACTION',
      url: '',
      route: `action:${actionName}`,
      status,
      correlationId: frame?.correlationId,
      actionName,
      outcome,
    });
  let result: T;
  try {
    result = await run();
  } catch (err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    await write('failed', typeof status === 'number' ? status : 500);
    throw err;
  }
  const shape = (result as { status?: unknown } | null | undefined)?.status;
  if (shape === 'pending') await write('parked', 202);
  else if (shape === 'proposal') await write('proposed', 202);
  else await write('executed', 200);
  return result;
}
