// E-11 — agent runtime (extension-point shape; current policy = echo).
//
// What this is:
//   * The destination for inbound channel messages dispatched by E-7
//     (`src/channels/index.ts` calls `agentRuntime.handleInbound(msg)`
//     when the intent resolver doesn't match a concrete action).
//   * The producer of AG-UI events (`src/agui/protocol.types.ts`) that
//     a future agent client will stream over SSE.
//
// Current policy (BY DESIGN: extension point — replace the policy class
// without touching the seam):
//   * deterministic echo, no LLM call.
//   * `handleInbound(msg)` writes a `tool_result {output:{echo:msg.text}}`
//     back to the originating channel via `notificationService` and
//     records an `engagement_deliveries` row for audit.
//   * `invoke({...})` is an `AsyncIterable<AguiEvent>` that yields
//     exactly one `tool_result` followed by `done {reason:'complete'}`.
//
// Frozen interface from
// docs/superpowers/plans/completed/2026-04-25-architecture-enablers-execution.md
// (Task 6, lines 519-539). Keep `handleInbound` and `invoke` shapes stable
// when the policy is replaced — callers ride this seam.

import { eq } from 'drizzle-orm';

import { db, engagementDeliveries } from '../db/client';
import {
  notificationService,
  type ChannelMessage,
} from '../domain/engagement/notifications';
import type { AguiEvent } from '../agui/protocol.types';
import type { InboundMessage } from '../channels';
import { getOrCreateSession, touchSession } from './session-store';

export interface AgentRuntimeInvokeArgs {
  userId: string;
  input: string;
  channel: string;
  threadId?: string;
}

export interface AgentRuntime {
  /**
   * Process an inbound channel message: load/create the runtime session,
   * generate a reply (current echo policy), post it back via the
   * originating channel's `sendMessage`, and record an
   * `engagement_deliveries` row for audit. Never throws on transport
   * failure — the failed delivery is recorded as `status='failed'`
   * instead.
   */
  handleInbound(msg: InboundMessage): Promise<void>;

  /**
   * Streaming invocation surface — for AG-UI clients. Yields a
   * sequence of AguiEvent values; current echo policy yields exactly:
   *   1. `tool_result { id:'1', output:{ echo: args.input } }`
   *   2. `done { reason:'complete' }`
   * Replacing the policy can emit tool_call / streaming deltas / approval
   * events — the seam is stable.
   */
  invoke(args: AgentRuntimeInvokeArgs): AsyncIterable<AguiEvent>;
}

/**
 * Echo policy (default). Pure module-state: the singleton at the bottom
 * of this file is what `channels/index.ts` imports.
 */
class StubAgentRuntime implements AgentRuntime {
  async handleInbound(msg: InboundMessage): Promise<void> {
    // Load or create the conversation session. Stable upsert seam — a
    // policy that needs to persist state writes through here.
    const session = await getOrCreateSession(
      msg.userId,
      msg.channel,
      msg.threadId ?? '',
    );

    // The stub policy: echo the input back. ChannelMessage of kind
    // 'text' is the simplest discriminator that all adapters accept.
    const reply: ChannelMessage = {
      kind: 'text',
      correlationId: msg.correlationId,
      text: `echo: ${msg.text}`,
    };

    const channel = notificationService.getChannel(msg.channel);
    let success = false;
    let error: string | undefined;
    if (!channel) {
      // Unknown channel — record the dropped delivery. NOT throwing
      // here mirrors the fan-out semantics in notifications.fanOutToUser.
      error = `channel not registered: ${msg.channel}`;
    } else {
      try {
        const result = await channel.sendMessage(msg.address, reply);
        success = result.success;
        error = result.error;
      } catch (err) {
        // Adapter throw — same audit-symmetry rule as fanOutToUser.
        error = err instanceof Error ? err.message : String(err);
      }
    }

    // Audit row. Mirrors the fan-out path so the delivery is visible in
    // the same `engagement_deliveries` surface. `engagement_type='runtime'`
    // marks runtime-initiated replies (vs `'approval'` for fan-out).
    try {
      await db.insert(engagementDeliveries).values({
        engagement_type: 'runtime',
        channel: msg.channel,
        recipient_user_id: msg.userId,
        recipient_address: msg.address,
        status: success ? 'sent' : channel ? 'failed' : 'skipped_disabled',
        error: error ?? null,
        metadata_json: { correlation_id: msg.correlationId, kind: 'text' },
      });
    } catch {
      // Audit write is best-effort — never block the runtime on it.
    }

    // Bump TTL so the session doesn't expire while the user is active.
    await touchSession(session.id);
  }

  async *invoke(args: AgentRuntimeInvokeArgs): AsyncIterable<AguiEvent> {
    // Wave-1 stub: one tool_result echo, then done. The `id` is fixed
    // because the stub doesn't track multiple concurrent tool calls.
    const echo: AguiEvent = {
      type: 'tool_result',
      id: '1',
      output: { echo: args.input },
    };
    yield echo;

    // Bump session TTL — invoke() is the streaming counterpart of
    // handleInbound() and should keep the conversation alive too.
    const session = await getOrCreateSession(
      args.userId,
      args.channel,
      args.threadId ?? '',
    );
    await touchSession(session.id);

    const done: AguiEvent = { type: 'done', reason: 'complete' };
    yield done;
  }
}

/**
 * Module singleton. Channels and AG-UI route handlers import this name
 * directly (matches the plan's `export const agentRuntime: AgentRuntime`).
 */
export let agentRuntime: AgentRuntime = new StubAgentRuntime();

// Re-export for legibility — callers usually need both.
export { engagementDeliveries } from '../db/client';
// also surface the `eq` we use internally so tests can build matching
// where clauses without importing drizzle-orm separately.
export { eq };
