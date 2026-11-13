/**
 * OpenTelemetry SDK bootstrap. Spec: 2026-04-24-analytics-page §11.
 *
 * Goals:
 *   1. Real OTLP-HTTP trace exporter pointed at the cluster Tempo collector
 *      when `OTEL_EXPORTER_OTLP_ENDPOINT` (or
 *      `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set.
 *   2. Zero behavior change when those envs are unset — `getTracer()` returns
 *      the no-op tracer so tests and cluster-less dev loops keep working.
 *   3. Lazy init (BY DESIGN: extension point — not pending work): SDK
 *      construction runs on the first `getTracer()` call so importing
 *      `telemetry/spans` in tests doesn't drag in the whole sdk-node graph.
 *
 * The OTLP endpoint, when set, MUST be the collector's HTTP traces URL
 * (e.g. `http://otel-collector.example.com:4318/v1/traces`).
 * `@opentelemetry/sdk-node` handles trace pipeline + auto-context-propagation.
 *
 * Service identity is sourced from `OTEL_SERVICE_NAME` with a sensible
 * default of `fr-backend`. `service.namespace` mirrors `OTEL_SERVICE_NAMESPACE`
 * if set (otherwise `fr`). Resource attrs are added defensively so the
 * collector can route by them.
 */

import { trace, type Tracer } from '@opentelemetry/api';

let initialized = false;
let initializedTracer: Tracer | null = null;

/**
 * Initialize the OTel SDK once. Safe to call multiple times — second + later
 * calls are no-ops. Synchronous-looking but starts the SDK in the background;
 * we don't `await sdk.start()` because the SDK accepts spans before the
 * exporter is ready and buffers them, and we don't want first-request latency
 * to take an exporter-handshake hit.
 *
 * Errors are swallowed (logged) so a misconfigured collector NEVER blocks
 * fr-backend boot — analytics is observability, not a critical path.
 */
function initOnce(): void {
  if (initialized) return;
  initialized = true;

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    // No endpoint configured — keep the no-op tracer. This is the normal
    // path for `bun test` and for any env where Tempo isn't reachable.
    return;
  }

  // Tests should never spin up a real exporter — even with the env set, a
  // running test suite shouldn't open sockets to a live collector. Bun
  // populates `process.env.NODE_ENV === 'test'` for `bun test`.
  if (process.env.NODE_ENV === 'test' || process.env.OTEL_SDK_DISABLED === 'true') {
    return;
  }

  try {
    // Dynamic require so the heavy SDK isn't pulled in when no endpoint is
    // set (and especially so the test process stays lean).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      OTLPTraceExporter,
    } = require('@opentelemetry/exporter-trace-otlp-http');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Resource } = require('@opentelemetry/resources');

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'fr-backend';
    const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE ?? 'fr';

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`,
      }),
      resource: new Resource({
        'service.name': serviceName,
        'service.namespace': serviceNamespace,
      }),
    });

    sdk.start();

    // Best-effort flush on shutdown so the last traces of a SIGTERM cycle
    // make it to the collector.
    const shutdown = () => {
      sdk.shutdown().catch((err: unknown) =>
        console.error('[otel] shutdown error:', err),
      );
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log(`[otel] tracing enabled → ${endpoint} (service=${serviceName})`);
  } catch (err) {
    // Most likely cause: the optional sdk-node deps aren't installed in this
    // image. Don't crash boot — fall back to no-op tracer + the structured
    // log line that spans.ts always writes.
    console.warn('[otel] init failed, falling back to no-op tracer:', err);
  }
}

/**
 * Returns a tracer suitable for `tracer.startActiveSpan(...)` calls. When the
 * SDK is not initialized (no endpoint, test mode, or init failure) this is
 * the no-op tracer from @opentelemetry/api — which still implements
 * `startActiveSpan` correctly and just doesn't emit anything.
 */
export function getTracer(): Tracer {
  if (!initialized) initOnce();
  if (!initializedTracer) {
    initializedTracer = trace.getTracer('fr-backend', '1.0.0');
  }
  return initializedTracer;
}

