/**
 * Kanban tools routes — liveness verification of the kanban WebSocket
 * subscriber pool, optionally scoped to a single project.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
 *   §"Backend"  — liveness route
 *
 * HTTP route:
 *   - GET /api/tools/kanban/liveness?projectId=<opt>
 *
 * Action name (Wave 2 namespace alignment):
 *   - `kanban.verify_liveness` (renamed from `activity.liveness_status`)
 */

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { emitSpan } from '../../telemetry/spans';
import { registerAction } from '../../agui/registry';
import type { AgentCallableAction } from '../../agui/types';
import { getKanbanLivenessSnapshot } from '../kanbanWebSocket';
import { withIntegrationCatch } from '../_lib';

interface LivenessSummary {
  last_broadcast_seq: number;
  subscribers: number;
  max_lag_seconds: number;
  /** Oldest-subscription lag in milliseconds (additive — purely for the
   * AG-UI verify_liveness contract + future Prom exporter). Equivalent to
   * `Math.round(max_lag_seconds * 1000)` from the same snapshot. */
  lag_ms: number;
  status: 'live' | 'stale' | 'disconnected';
}

function summariseLiveness(projectId?: string): LivenessSummary {
  const snap = getKanbanLivenessSnapshot(projectId);
  const status: LivenessSummary['status'] =
    snap.subscribers === 0
      ? 'disconnected'
      : snap.maxLagSeconds >= 60
        ? 'disconnected'
        : snap.maxLagSeconds >= 20
          ? 'stale'
          : 'live';
  return {
    last_broadcast_seq: snap.lastBroadcastSeq,
    subscribers: snap.subscribers,
    max_lag_seconds: snap.maxLagSeconds,
    lag_ms: snap.oldestLagMs,
    status,
  };
}


// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleGetLiveness(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const url = new URL(req.url);
    const projectId = url.searchParams.get('projectId') ?? undefined;
    return await emitSpan(
      'fr.kanban.liveness',
      {
        'user.id': user.id,
        'project.id': projectId ?? null,
        outcome: 'ok',
      },
      async () => jsonResponse({ data: summariseLiveness(projectId) }),
    );
  });
}

// ---------------------------------------------------------------------------
// AG-UI action registration
//
// `kanban.verify_liveness` accepts an optional projectId. The default rbac
// resolution synthesises a `project-member` rule when projectId is supplied;
// when omitted the call is a global "is the kanban WS pool alive at all?"
// probe. Author rbac as `public` here and rely on `validateAuth` for
// authenticated-only access — the underlying snapshot only counts active
// subscribers and never leaks PII.
// ---------------------------------------------------------------------------

const livenessInputSchema = z.object({ projectId: z.string().optional() });
const livenessOutputSchema = z.object({
  status: z.enum(['live', 'stale', 'disconnected']),
  maxLagSeconds: z.number(),
  /** Oldest-subscription lag in milliseconds — additive companion to
   * `maxLagSeconds`, exposed for the upcoming Prom exporter / n8n callers
   * that prefer integer ms over fractional seconds. */
  lagMs: z.number(),
  subscribers: z.number(),
});

type LivenessInput = z.infer<typeof livenessInputSchema>;

const kanbanVerifyLivenessAction: AgentCallableAction<
  LivenessInput,
  z.infer<typeof livenessOutputSchema>
> = {
  name: 'kanban.verify_liveness',
  kind: 'read',
  description:
    'Return the kanban-WS liveness snapshot for the calling user (subscriber count + max lag seconds + green/amber/red label).',
  input: livenessInputSchema,
  output: livenessOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  // Minute bucket keeps poll-loop reads fresh without exploding the cache.
  idempotencyKey: (input) =>
    `kanban.verify_liveness:${input.projectId ?? ''}:${Math.floor(Date.now() / 60_000)}`,
  handler: async (input) => {
    const s = summariseLiveness(input.projectId);
    return {
      status: s.status,
      maxLagSeconds: s.max_lag_seconds,
      lagMs: s.lag_ms,
      subscribers: s.subscribers,
    };
  },
  rbac: { type: 'project-member' },
};

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

safeRegister(kanbanVerifyLivenessAction);

