/**
 * Thin Prometheus query client used by the analytics rollup worker.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §8.2.
 *
 * The worker only needs two endpoints:
 *   - /api/v1/query        → instant query at a single point in time
 *   - /api/v1/query_range  → range query across [start, end] at step
 *
 * Both return the standard Prometheus envelope:
 *   { status: 'success' | 'error', data: { resultType, result } }
 *
 * We expose typed wrappers and lift the result array directly so callers
 * never reach into the raw envelope.
 *
 * Networking goes through the shared HttpClient so retry/timeout/correlation
 * propagation match every other integration. The base URL is configurable
 * via `PROMETHEUS_URL`; defaults to the in-cluster service per spec §8.2.
 */

import { HttpClient } from '../integrations/_lib/http-client';
import { IntegrationError } from '../integrations/_lib/errors';

export interface PromInstantValue {
  /** [unix_ts_seconds, string_value] — Prometheus returns numeric value as string. */
  metric: Record<string, string>;
  value: [number, string];
}

interface PromRangeValue {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

interface PromInstantResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'vector' | 'scalar' | 'string' | 'matrix';
    result: PromInstantValue[];
  };
  errorType?: string;
  error?: string;
}

interface PromRangeResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'matrix';
    result: PromRangeValue[];
  };
  errorType?: string;
  error?: string;
}

/**
 * One row of `GET /api/v1/alerts` (the Alertmanager-shaped rules API, not
 * `/api/v1/query` over the `ALERTS` series). This is the ONLY Prometheus
 * endpoint that carries `activeAt` — the actual activation timestamp, not an
 * evaluation timestamp — which is why A10.4 reads it instead of instant-
 * querying `ALERTS{...}` for "since when".
 */
export interface PromAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: 'firing' | 'pending' | 'inactive';
  activeAt: string;
  value: string;
}

interface PromAlertsResponse {
  status: 'success' | 'error';
  data: {
    alerts: PromAlert[];
  };
  errorType?: string;
  error?: string;
}

export class PrometheusClient {
  private readonly http: HttpClient;

  constructor() {
    // No hardcoded fallback per config-externalization-policy.md; in
    // production `validateProductionConfig` enforces PROMETHEUS_URL is
    // set.
    const baseUrl = process.env.PROMETHEUS_URL ?? '';
    this.http = new HttpClient({
      serviceName: 'prometheus',
      baseUrl,
      defaultTimeoutMs: 10_000,
      // Prometheus has no bearer auth, and PROMETHEUS_URL points straight at the
      // in-cluster Service (prometheus.example.com:9090) with no
      // auth proxy in front. The JWT was pure egress.
      sendAuthorization: false,
      // Prometheus is read-only and idempotent; one retry on a flap is fine.
      retry: { attempts: 2, backoffMs: 200 },
    });
  }

  /**
   * Instant query — `query` is PromQL, `time` is the eval timestamp (unix
   * seconds). When omitted Prometheus uses "now".
   */
  async instantQuery(query: string, time?: number): Promise<PromInstantValue[]> {
    const params = new URLSearchParams({ query });
    if (time !== undefined) params.set('time', String(time));
    const body = await this.http.json<PromInstantResponse>(
      `/api/v1/query?${params.toString()}`,
    );
    if (!body || body.status !== 'success') {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: `prometheus instant query failed: ${body?.error ?? 'unknown'}`,
        service: 'prometheus',
        path: '/api/v1/query',
      });
    }
    return body.data.result;
  }

  /**
   * Range query — start/end are unix seconds, step is a PromQL duration like
   * '5m' or a numeric seconds string.
   */
  async rangeQuery(
    query: string,
    start: number,
    end: number,
    step: string,
  ): Promise<PromRangeValue[]> {
    const params = new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step,
    });
    const body = await this.http.json<PromRangeResponse>(
      `/api/v1/query_range?${params.toString()}`,
    );
    if (!body || body.status !== 'success') {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: `prometheus range query failed: ${body?.error ?? 'unknown'}`,
        service: 'prometheus',
        path: '/api/v1/query_range',
      });
    }
    return body.data.result;
  }

  /**
   * `GET /api/v1/alerts` — the live alerts list, each row carrying `state`
   * ('firing' | 'pending', plus 'inactive' which callers filter out),
   * `labels`, `annotations` and — the reason this exists — `activeAt`, the
   * real activation time. Takes no query params; Prometheus returns every
   * currently-known alert and callers filter by label themselves (same
   * convention as `instantQuery`/`rangeQuery`, which also do not filter
   * server-side beyond the PromQL the caller supplies).
   */
  async alerts(): Promise<PromAlert[]> {
    const body = await this.http.json<PromAlertsResponse>('/api/v1/alerts');
    if (!body || body.status !== 'success') {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: `prometheus alerts query failed: ${body?.error ?? 'unknown'}`,
        service: 'prometheus',
        path: '/api/v1/alerts',
      });
    }
    return body.data.alerts;
  }
}

let cachedClient: PrometheusClient | null = null;

/** Singleton accessor used by the rollup worker. */
export function getPrometheusClient(): PrometheusClient {
  if (!cachedClient) cachedClient = new PrometheusClient();
  return cachedClient;
}
