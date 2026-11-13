import { BlockList, isIP } from 'node:net';
import { describe as bunDescribe } from 'bun:test';
import { PlankaAuth, type PlankaAuthConfig } from '../../../src/services/planka/auth';
import { PlankaHttp } from '../../../src/services/planka/http';
import { PlankaClient } from '../../../src/services/planka';
import { PlankaNotFoundError } from '../../../src/services/planka/errors';

/**
 * The opt-in these suites require ON TOP of TEST_PLANKA_*. Hand runs of this
 * harness (per the old `kubectl port-forward` recipe, which exported
 * TEST_PLANKA_URL=$PLANKA_BASE_URL) wrote ~80 `fr-plan-*` / `fr-intake-*`
 * projects onto the PRODUCTION kanban. Having credentials in the environment is
 * not intent; this variable is. NOTE: a port-forward to production reads as
 * `localhost`, which no host check can see — the opt-in is the only barrier there.
 */
export const PLANKA_OPT_IN_VAR = 'RUN_PLANKA_INTEGRATION';
/** Second, separate opt-in that is the ONLY way past the production-host refusal. */
export const ALLOW_PROD_VAR = 'ALLOW_PROD_INTEGRATION';

/** RFC 2606/6761/6762 reserved TLDs: a `<name>.<tld>` under these is never a k8s `<svc>.<ns>`. */
const NON_CLUSTER_TLDS = new Set(['localhost', 'local', 'test', 'example', 'invalid']);

/**
 * IP ranges that are production for this estate: the k3s pod (10.42/16) and
 * service (10.43/16) CIDRs, the tailnet (100.64/10 + fd7a:115c:a1e0::/48, which
 * covers every node incl. the postgres primary and standby) and each node's
 * public IP (worker4, master, worker3, worker1, worker5, worker2).
 */
const PROD_IPS = new BlockList();
PROD_IPS.addSubnet('10.42.0.0', 16, 'ipv4');
PROD_IPS.addSubnet('10.43.0.0', 16, 'ipv4');
PROD_IPS.addSubnet('100.64.0.0', 10, 'ipv4');
PROD_IPS.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
for (const ip of ['85.215.118.229', '217.160.28.34', '217.160.57.117', '85.215.101.85', '85.215.253.207', '84.80.5.71']) {
  PROD_IPS.addAddress(ip, 'ipv4');
}

/**
 * True when `hostname` (as `new URL().hostname` returns it, brackets allowed) is
 * production for this estate. Decided from the literal, never by resolving it:
 *  - DNS zones: `*.internal` (tailnet split-DNS), `*.nonagentic.ai` (public),
 *    `*.svc` / `*.svc.cluster.local` / `*.cluster.local` (in-cluster);
 *  - short in-cluster names: one label other than `localhost` (`postgres`,
 *    `planka`) and `<svc>.<ns>` (two labels, e.g. `pgbouncer.pgbouncer`) unless
 *    the last label is a reserved non-cluster TLD. Inside a pod these resolve
 *    via the cluster search path; a docker-compose name is indistinguishable, so
 *    publish it on localhost instead;
 *  - IP literals in PROD_IPS (v4-mapped IPv6 included).
 * A test harness must never write there by default.
 */
export function isProdHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const family = isIP(h);
  if (family === 4) return PROD_IPS.check(h, 'ipv4');
  if (family === 6) return PROD_IPS.check(h, 'ipv6');
  if (
    h === 'nonagentic.ai' ||
    h.endsWith('.nonagentic.ai') ||
    h.endsWith('.internal') ||
    h.endsWith('.svc') ||
    h.endsWith('.svc.cluster.local') ||
    h.endsWith('.cluster.local')
  ) {
    return true;
  }
  const labels = h.split('.');
  if (labels.length === 1) return h !== 'localhost';
  if (labels.length === 2) return !NON_CLUSTER_TLDS.has(labels[1] ?? '');
  return false;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Pure decision for "may this process write to the Planka at TEST_PLANKA_URL?".
 * Returns `null` when safe, otherwise the reason it must refuse. Checks both
 * the Planka URL and DATABASE_URL (the kanban route suites boot the fr app,
 * which reads fr's DB). An unparseable URL is refused, never assumed local.
 */
export function prodTargetRefusal(env: Record<string, string | undefined>): string | null {
  if (env[ALLOW_PROD_VAR] === '1') return null;
  const targets: Array<[string, string | undefined]> = [
    ['TEST_PLANKA_URL', env.TEST_PLANKA_URL],
    ['DATABASE_URL', env.DATABASE_URL],
  ];
  for (const [name, value] of targets) {
    if (!value) continue;
    const host = hostOf(value);
    if (host === null) return `${name} is not a parseable URL — refusing rather than guessing it is local`;
    if (isProdHost(host)) {
      return `${name} host '${host}' is production; set ${ALLOW_PROD_VAR}=1 only if writing test data there is really intended`;
    }
  }
  return null;
}

/** Read + validate the TEST_PLANKA_* env vars. Returns null if any required var is missing. */
export function plankaEnv(): { url: string; email: string; password: string } | null {
  const url = process.env.TEST_PLANKA_URL;
  const email = process.env.TEST_PLANKA_EMAIL;
  const password = process.env.TEST_PLANKA_PASSWORD;
  if (!url || !email || !password) return null;
  return { url, email, password };
}

/**
 * Build a fresh PlankaClient pointed at a real Planka (gated by TEST_PLANKA_*).
 * Each suite gets its own auth + http instance (no sharing with the production
 * singleton) so per-suite cleanup does not bleed between suites.
 */
export function makeTestClient(): PlankaClient {
  const env = plankaEnv();
  if (!env) {
    throw new Error(
      'TEST_PLANKA_* env vars required — integration test harness called without them',
    );
  }
  const refusal = prodTargetRefusal(process.env);
  if (refusal) throw new Error(`planka integration harness refused: ${refusal}`);
  const cfg: PlankaAuthConfig = {
    baseUrl: env.url,
    email: env.email,
    password: env.password,
    termsPath: process.env.PLANKA_TERMS_PATH ?? '/api/terms',
    acceptTermsPath: process.env.PLANKA_ACCEPT_TERMS_PATH ?? '/api/access-tokens/accept-terms',
    defaultLanguage: process.env.PLANKA_DEFAULT_LANGUAGE ?? 'en-US',
  };
  const auth = new PlankaAuth(cfg);
  const http = new PlankaHttp(auth, env.url);
  return PlankaClient.forTesting(http, auth);
}

/**
 * Suffix a short unique token to a prefix so parallel/re-run suites don't collide on names.
 * Combines Date.now() + a monotonically-incrementing counter + random — same-ms calls
 * from the same process cannot collide even when the test runner fires them synchronously.
 */
let _uniqueCounter = 0;
export function unique(prefix: string): string {
  _uniqueCounter = (_uniqueCounter + 1) & 0xffffff;
  return `${prefix}-${Date.now()}-${_uniqueCounter}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * Delete a scratch project the way Planka actually allows: boards first, then
 * the project. Planka refuses to delete a project that still has boards, and the
 * old `projects.delete(id).catch(() => {})` teardown swallowed exactly that
 * refusal — every run left its project behind. A project that is already gone
 * (the test deleted it) is fine; ANY other failure throws, so a leak is a red
 * run instead of silent clutter.
 */
export async function deleteProjectDeep(client: PlankaClient, projectId: string): Promise<void> {
  let boards: Array<{ id: string }>;
  try {
    boards = await client.boards.listByProject(projectId);
  } catch (err) {
    if (err instanceof PlankaNotFoundError) return;
    throw err;
  }
  for (const b of boards) {
    try {
      await client.boards.delete(b.id);
    } catch (err) {
      if (!(err instanceof PlankaNotFoundError)) throw err;
    }
  }
  try {
    await client.projects.delete(projectId);
  } catch (err) {
    if (!(err instanceof PlankaNotFoundError)) throw err;
  }
}

/**
 * Run `deleteProjectDeep` over every id, attempting ALL of them, then throw one
 * error naming each project that could not be removed. For use in `afterAll`.
 */
export async function cleanupProjects(
  client: PlankaClient | undefined,
  ids: ReadonlyArray<string | undefined>,
): Promise<void> {
  const live = ids.filter((id): id is string => !!id);
  if (live.length === 0) return;
  if (!client) throw new Error(`planka cleanup: no client, cannot delete projects ${live.join(', ')}`);
  const failures: string[] = [];
  for (const id of live) {
    try {
      await deleteProjectDeep(client, id);
    } catch (err) {
      failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `planka cleanup LEAKED ${failures.length} project(s) — delete them by hand:\n  ${failures.join('\n  ')}`,
    );
  }
}

/** True when this process has both the credentials AND the explicit opt-in. */
export function plankaEnabled(): boolean {
  return plankaEnv() !== null && process.env[PLANKA_OPT_IN_VAR] === '1';
}

/**
 * `describe` wrapper that resolves to `describe.skip` unless TEST_PLANKA_* are
 * set AND RUN_PLANKA_INTEGRATION=1. When enabled against a production host (or
 * a production DATABASE_URL) it THROWS at collection time rather than skipping —
 * a refused target must be loud.
 * Usage:
 *   import { plankaDescribe } from './_setup';
 *   plankaDescribe('MyResource integration', () => { ... });
 *
 * Keeps the skip/enabled decision in one place so later suites (T9-T16, T19-T26)
 * don't each re-invent the env gating.
 */
export function plankaDescribe(name: string, body: () => void): void {
  if (plankaEnabled()) {
    const refusal = prodTargetRefusal(process.env);
    if (refusal) throw new Error(`planka integration harness refused '${name}': ${refusal}`);
    bunDescribe(name, body);
  } else {
    bunDescribe.skip(name, body);
  }
}
