// src/lib/k8s-scale.ts
//
// The global andon cord's ACTUATOR. One replica count, one Deployment:
// `n8n/n8n-worker` → 0 while the cord is engaged, 1 when it is released.
//
// ⭐ WHY THE WORKER AND NOT THE WORKFLOWS. `EXECUTIONS_MODE: queue` plus
// `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true` make the worker the ONLY executor.
// Main cannot run a workflow even if it tried: with manual offload on, n8n 2.42.6's
// `commands/start.js` sets `needsTaskRunner=false`, so main's task-runner sidecar
// never starts. Worker=0 therefore stops EVERY execution — production runs and the
// editor's own "test workflow" runs alike, because those are offloaded too. The
// editor, the REST API and n8n-mcp stay up, so flows stay editable. It is also
// CONTENT-AGNOSTIC: unlike deactivating each workflow, it does not care how many
// exist or which of them were created after the pull.
//
// ⚠️ WHAT WORKER=0 DOES NOT STOP: THE INBOUND WEBHOOK. Main keeps accepting
// `/webhook/*` and turns every hit into a QUEUED execution — the caller gets its
// normal response and NOTHING RUNS, but the job is banked, not dropped. Releasing
// the cord drains that backlog, so this is "pause with replay", not "discard".
// That is still the objective (nothing executes while it is engaged); the point of
// writing it down is that the next reader asks this exact question. If the replay
// ever matters, the lever is the Redis queue in `n8n-redis`, not this module.
//
// ⛔ WHY NOT THE n8n API. Deactivating every workflow is a SNAPSHOT (anything
// created or activated later still runs) and it needs n8n healthy to make hundreds
// of calls — the one moment a stop must not depend on the thing it is stopping.
// Scaling is one PATCH, and it works while n8n is wedged. ⛔ `n8n` MAIN IS NEVER
// SCALED: it terminates inbound webhooks and serves the editor.
//
// ⛔ THE REPLICA FIELD IS NOT IN GIT. kustomize-controller re-applies the `services`
// Kustomization every 5m, so a `replicas` value declared in
// clusters/prod/services/n8n/n8n-worker-deployment.yaml would reset this to 1 on
// the next apply and the cord would silently un-pull itself. That file carries a
// comment saying so — read it before "restoring" the field.
//
// Permission model: ServiceAccount `fr/fr-andon` (clusters/prod/services/fr/
// rbac-andon.yaml) + Role/RoleBinding in ns `n8n` pinned by `resourceNames` to this
// one Deployment (clusters/prod/services/n8n/rbac-andon.yaml). ⛔ The grant must
// live in the N8N tree: a Role written under services/fr/ is rewritten into
// namespace `fr` by the kustomize namespace transformer — created, correct-looking,
// granting nothing. The token is PROJECTED into the fr-backend container only; the pod keeps
// `automountServiceAccountToken: false`.
//
// ⚠️ RBAC cannot bound the VALUE. fr writes 0 or 1 and nothing else; scaling above
// 1 would run a second worker against the ReadWriteOnce `n8n-data` PVC under
// `strategy: Recreate`, which that Deployment forbids.

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const NAMESPACE = 'n8n';
const DEPLOYMENT = 'n8n-worker';

/**
 * Wall-clock budget for ONE API call. The in-cluster round trip measured 7 ms
 * (2026-11-01), so anything near this bound is a broken path, not a slow one —
 * and a super-admin is waiting on an HTTP response during an incident.
 */
const REQUEST_TIMEOUT_MS = 4_000;

/** What the cord knows after an attempt. `null` = NOT MEASURED, never 0. */
export interface WorkerScaleReading {
  /**
   * `spec.replicas` of `n8n-worker`. `null` = the READ failed (or its parse did)
   * — a refused WRITE still reads back a value, see {@link scaleN8nWorker}.
   */
  replicas: number | null;
  /**
   * `status.availableReplicas` — how many worker pods are actually Ready.
   * `null` = not measured. A worker scaled back up takes tens of seconds to
   * become available, so this is routinely 0/absent immediately after a release;
   * that is a fact about the rollout, not a failure of the release.
   */
  available: number | null;
  /** Why the attempt failed, or `null` when it landed. */
  error: string | null;
}

/** The API server base. Taken from the pod env; the DNS name is the fallback. */
export function apiBase(env: Record<string, string | undefined> = process.env): string {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  return host ? `https://${host}:${port}` : 'https://kubernetes.default.svc';
}

/** The scale subresource for `n8n-worker`. Pure, so it can be pinned by a test. */
export function workerScaleUrl(base: string = apiBase()): string {
  return `${base}/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${DEPLOYMENT}/scale`;
}

/** The Deployment itself — the scale subresource does not expose `status`. */
export function workerDeploymentUrl(base: string = apiBase()): string {
  return `${base}/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${DEPLOYMENT}`;
}

/**
 * Pull the two numbers out of a Scale/Deployment body. Pure.
 *
 * ⛔ `Number.isInteger` rather than a truthiness check, because `0` is the value
 * that matters most here and `replicas || null` would turn the cord's own
 * success into "unknown".
 */
export function parseScaleReading(body: unknown): {
  replicas: number | null;
  available: number | null;
} {
  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const spec = asRecord(asRecord(body).spec);
  const status = asRecord(asRecord(body).status);
  const num = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
  return { replicas: num(spec.replicas), available: num(status.availableReplicas) };
}

async function readServiceAccountFile(name: string): Promise<string> {
  const file = Bun.file(`${SERVICE_ACCOUNT_DIR}/${name}`);
  if (!(await file.exists())) {
    throw new Error(`${SERVICE_ACCOUNT_DIR}/${name} is not mounted`);
  }
  return file.text();
}

/**
 * One authenticated call to the API server.
 *
 * The cluster CA is passed explicitly: the k3s API server's certificate is signed
 * by the cluster CA, which is not in the image's system trust store.
 */
async function k8sFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = (await readServiceAccountFile('token')).trim();
  const ca = await readServiceAccountFile('ca.crt');
  const withTls = {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    tls: { ca },
  } as RequestInit;
  return fetch(url, withTls);
}

/**
 * What the cord records after an ACCEPTED scale write. Pure, so the decision is pinned.
 *
 * ⛔ `echoed` IS NOT EVIDENCE ON ITS OWN. This is the `autoscaling/v1 Scale` subresource,
 * whose `ScaleSpec.Replicas` is `int32` with `json:"replicas,omitempty"` — a scale to
 * ZERO therefore comes back with NO `spec.replicas` field at all. Reading that body as
 * the answer recorded `replicas: null` plus a permanent "reports replicas=null" error on
 * every SUCCESSFUL pull (measured 2026-11-08: the row said NULL while the Deployment was
 * genuinely at 0/0). The Deployment's own `spec.replicas` is a `*int32` and IS present,
 * so `after` — that read-back — is the measurement. `echoed` survives only as the
 * fallback for the case where the read-back failed, where it is still something the API
 * server said.
 */
export function reconcileScaleReading(
  wanted: 0 | 1,
  echoed: number | null,
  after: WorkerScaleReading,
): WorkerScaleReading {
  const observed = after.error === null ? after.replicas : echoed;
  if (after.error !== null) {
    return {
      replicas: observed,
      available: null,
      error: `k8s accepted the scale to ${wanted} but the read-back failed: ${after.error}`,
    };
  }
  if (observed !== wanted) {
    return {
      replicas: observed,
      available: after.available,
      error: `k8s accepted the scale to ${wanted} but reports replicas=${String(observed)}`,
    };
  }
  return { replicas: observed, available: after.available, error: null };
}

/** Read the worker's current replica state. NEVER throws. */
export async function readN8nWorkerScale(base?: string): Promise<WorkerScaleReading> {
  try {
    const res = await k8sFetch(workerDeploymentUrl(base));
    if (!res.ok) {
      return {
        replicas: null,
        available: null,
        error: `k8s read failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      };
    }
    const { replicas, available } = parseScaleReading(await res.json());
    return { replicas, available, error: null };
  } catch (e) {
    return {
      replicas: null,
      available: null,
      error: `k8s read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Write the worker's replica count. NEVER throws.
 *
 * Returns what the API server says AFTER the write, read back over the same
 * connection budget — so the caller stores a MEASUREMENT, not an intention.
 *
 * ⛔ A REFUSED WRITE IS NOT A FAILED MEASUREMENT, AND CONFLATING THEM HIDES THE
 * FACT THE OPERATOR NEEDS. This used to return `replicas: null` whenever the PATCH
 * failed: the row then carried "unknown" and the REST of the answer had to be
 * inferred from that absence. (That absence also disarmed the estate alert while it
 * was fed by fr's own gauge — the gauge is gone as of 2026-11-02;
 * `FrAndonReleasedWorkerStillStopped` now reads kube-state-metrics. The distinction
 * below is still load-bearing for `GET /api/andon` and the admin page.)
 *
 * So on a failed write we still READ the Deployment: the write did not land, but
 * the replica count is knowable, and recording it keeps the operator's evidence
 * self-sufficient. `replicas: null` is now reserved for the case it means — the
 * read failed too — and is never a stand-in for "the patch was refused".
 */
export async function scaleN8nWorker(
  replicas: 0 | 1,
  base?: string,
): Promise<WorkerScaleReading> {
  try {
    const res = await k8sFetch(workerScaleUrl(base), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { replicas } }),
    });
    if (!res.ok) {
      const observed = await readN8nWorkerScale(base);
      return {
        replicas: observed.replicas,
        available: observed.available,
        error: `k8s scale to ${replicas} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      };
    }
    // ⛔ THE PATCH BODY IS NOT THE MEASUREMENT — see `reconcileScaleReading` above. The
    // scale subresource omits `replicas` when it is 0, so believing it made a
    // successful pull look like a failed measurement. Read the Deployment back and let
    // that decide; one extra GET, and it already ran here for `status`.
    const echoed = parseScaleReading(await res.json()).replicas;
    return reconcileScaleReading(replicas, echoed, await readN8nWorkerScale(base));
  } catch (e) {
    // Same rule as the refused-write branch above: try to MEASURE even though the
    // write failed, so the caller records a fact and the gauge keeps its sample.
    const observed = await readN8nWorkerScale(base);
    return {
      replicas: observed.replicas,
      available: observed.available,
      error: `k8s scale to ${replicas} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
