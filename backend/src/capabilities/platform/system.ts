// fr-agui SPEC §13 P4d-2d — spec drain: `GET /health`, the readiness probe. Its literal operation
// moves VERBATIM into `openapi.frozen`, unchanged (no edit: the server answers it BEFORE routing, so
// neither the licence door nor any other pipeline step can answer it).
//
// It is NOT a router row: src/server.ts serves it with a direct pathname match inside the Bun.serve
// fetch handler (it reports Postgres / Redis readiness and must not depend on anything else). So
// the declaration is `http.unrouted` — documented in the served spec, no route row, no handler —
// and route-spec accounting keeps its EXEMPT_SPEC_OPERATIONS entry (a spec operation with no
// `router.add` row). `GET /health/live` (liveness) has no operation, as before.
//
// P4d-2e (P4d-2d carry): the frozen operation now declares what the probe answers (src/server.ts, the
// `/health` branch): `db`, `redis` and `degraded` beside status / version / timestamp, and the 503 (not
// ready: Postgres unreachable — Redis alone only degrades, lib/readiness.ts) with the same body.
//
// ⛔ Side-effect free (define.ts).
import { z } from 'zod';

import { defineCapability, type Capability } from '../define';

/** The readiness fields the `/health` branch reports (lib/readiness.ts `readinessVerdict`). */
const HEALTH_DEPENDENCIES = {
  db: { type: 'string', enum: ['ok', 'error'] },
  redis: { type: 'string', enum: ['ok', 'error'] },
  degraded: { type: 'array', items: { type: 'string' }, description: "Non-fatal dependencies in error (e.g. ['redis']); 200 with status 'degraded'." },
} as const;

export const SYSTEM_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability<unknown, unknown>({
    id: 'system.health_check',
    area: 'system',
    summary: 'Health check',
    http: { method: 'GET', path: '/health', operationId: 'healthCheck', unrouted: 'src/server.ts — the direct `/health` pathname match in the fetch handler, before the router' },
    input: z.object({}),
    output: z.unknown().describe("The frozen operation's success body (openapi.frozen)."),
    errors: [],
    // Public: no bearer, nothing through the registry or the agent.
    auth: { principal: 'public', rbac: { type: 'custom', check: async () => false } },
    tenancy: 'platform',
    effect: 'read',
    confirm: 'none',
    agent: { expose: false, reason: 'transport' },
    openapi: {
      frozen: {
        summary: 'Health check',
        tags: ['System'],
        operationId: 'healthCheck',
        security: [],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded'], example: 'ok' },
                    version: { type: 'string', example: '1.0.0' },
                    timestamp: { type: 'string', format: 'date-time' },
                    ...HEALTH_DEPENDENCIES,
                  },
                },
              },
            },
          },
          '503': {
            description: "Not ready: Postgres is unreachable (`status` 'unhealthy', `db` 'error'). Redis alone only degrades (200).",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['unhealthy'] },
                    version: { type: 'string', example: '1.0.0' },
                    timestamp: { type: 'string', format: 'date-time' },
                    ...HEALTH_DEPENDENCIES,
                  },
                },
              },
            },
          },
        },
      },
    },
  }),
];
