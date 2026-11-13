/**
 * Plan 3 — Frontend mirror of `backend/src/agent/loop.ts`'s AgentChatEvent
 * union. Manually kept in sync (no generated client yet — the agent NDJSON
 * stream is not openapi-described). If you change one, change both.
 */

export type AgentChatEvent =
  | {
      type: 'assistant-start';
      correlationId: string;
      threadId: string;
      turnId: string;
    }
  | { type: 'assistant-message'; turnId: string; text: string }
  | {
      type: 'tool-call-start';
      turnId: string;
      callId: string;
      action: string;
      input: unknown;
    }
  | { type: 'tool-call-event'; callId: string; event: unknown }
  | {
      type: 'tool-call-end';
      callId: string;
      action: string;
      /** `proposal` (fr-agui SPEC §5.2 W): the agent PROPOSED a write; `output` is an AgentProposal. */
      status: 'success' | 'failed' | 'pending' | 'proposal';
      output?: unknown;
      error?: string;
      /** fr-agui SPEC §5.6: the refusal VERBATIM (`project_mismatch`, RBAC, a coded route refusal). */
      errorInfo?: { status: number; code: string | null; message: string };
    }
  /**
   * fr-agui SPEC §5.4: a successful `ui.*` navigation the server already checked.
   * The rail re-checks it client-side (lib/agent/ui-intent.ts) and calls `goto()`.
   */
  | { type: 'ui-intent'; callId: string; kind: 'navigate'; route: string }
  /** fr-agui SPEC §5.3: the resources a write may have changed — raised on lib/agent/invalidation.ts. */
  | { type: 'state-invalidate'; callId: string; resources: string[] }
  | { type: 'assistant-end'; turnId: string }
  | {
      type: 'done';
      correlationId: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'error';
      correlationId: string;
      code:
        | 'max_iterations'
        | 'wall_clock_exceeded'
        | 'tool_failure_budget'
        | 'project_not_readable'
        | 'tenant_changed'
        | 'identity_unavailable'
        | 'wm_failed'
        | 'invalid_tool_call'
        | 'internal_error';
      message: string;
      /** worker_management BYO error code (e.g. BYO_KEY_WITHHELD); `message` is the user text. */
      errorCode?: string;
    };

export interface ChatRequest {
  /** Optional client-supplied id to correlate with backend logs. */
  correlationId?: string;
  /** Empty string for the default per-channel thread; otherwise the thread to resume. */
  threadId?: string;
  /** 'web' | 'telegram' | 'teams' | future. Defaults to 'web'. */
  channel?: string;
  /** The user's message for this turn. */
  message: string;
  /** Override the default `fr-agent-default` worker. */
  workerName?: string;
  /** fr-agui SPEC §6.0: `intake` on the doorway pages narrows the catalog to request intake. */
  mode?: 'default' | 'intake';
}

/**
 * Mirror of backend `agent/proposal.ts` AgentProposal: a write the agent
 * proposed and did NOT run. The confirm card calls `http` as the human.
 */
export interface AgentProposal {
  status: 'proposal';
  proposalId: string;
  action: string;
  card: 'project-create' | 'approval-decide' | 'project-request' | 'capability-invoke' | 'file-upload' | 'artifact-review' | 'typed-confirm' | 'model-review' | 'model-import';
  http: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  input: Record<string, unknown>;
  idempotencyKey?: string;
  secretFields: string[];
}

export function isAgentProposal(v: unknown): v is AgentProposal {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { status?: unknown }).status === 'proposal' &&
    typeof (v as { proposalId?: unknown }).proposalId === 'string' &&
    typeof (v as { card?: unknown }).card === 'string'
  );
}
