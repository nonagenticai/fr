/**
 * Plan 3 — Agent loop.
 *
 * One run per user message. Calls worker_management as the sole LLM gateway
 * (memory `wm-as-sole-llm-gateway`), iterates over its structured tool-call
 * outputs against the AG-UI registry, and emits NDJSON events the frontend
 * renders as message + tool-call cards.
 *
 * Hard caps: max 10 iterations, max 60s wall-clock. On overflow we surface
 * an `error: max-iterations` event and persist the messages we DO have so
 * the user can see what got done.
 *
 * Tool-failure budget (fr#1383): the run also ends — with a terminal
 * `tool_failure_budget` error — as soon as the SAME (action, input) has failed
 * twice, or MAX_CONSECUTIVE_TOOL_FAILURES tool calls in a row have failed.
 * Retrying an identical call that just failed cannot succeed; before this the
 * loop replayed it until the iteration / wall-clock cap.
 *
 * This module is a generator-style event emitter; the route handler in
 * `routes/agent.ts` adapts the async iterator to an NDJSON ReadableStream.
 */

import { randomUUID } from 'node:crypto';
import {
  clientSafeCaughtErrorText,
  clientSafeUpstreamText,
  isIntegrationError,
} from '../integrations/_lib/errors';

import { sendWorkerMessage } from '../integrations/workers';
import { asOperatorBilledCall } from '../lib/operator-billing';
import { AppError } from '../utils/errors';
import { wmByoErrorFromIntegrationError } from '../lib/wm-byo-errors';
import { getAction, invokeAction, UnknownActionError } from '../agui/registry';
import { RbacDeniedError } from '../agui/rbac';
import type { ActionContext, PendingAction } from '../agui/types';
import { emitSpan } from '../telemetry/spans';

import { ensureWorker, FR_AGENT_DEFAULT } from './wm-bootstrap';
import { buildToolCatalog, type CatalogEntry } from './tool-catalog';
import type { AgentCatalogMode } from './intake-catalog';
import { renderPackBlock } from './packs';
import { AGENT_PII_MASKS, redact, scrubString } from '../capabilities/redact';
import { invalidationsFor } from './state-invalidate';
import { recordProposal } from '../services/capability-audit';
import { isAgentTokenContext } from '../agui/context-provenance';
import type { AgentProposal } from '../agui/proposal-shape';
import { buildProposal, isAgentProposal, redactSecretFields } from './proposal';
import { bindProjectInput } from './project-binding';
import { assertAssetInBoundProject } from './project-asset-guard';
import * as sessionStore from './session-store';
import type { ConversationMessage } from './session-store';
import type { FrAgentOutput } from './tool-output-schema';

// ---------- Wire events ----------

export type AgentChatEvent =
  | { type: 'assistant-start'; correlationId: string; threadId: string; turnId: string }
  | { type: 'assistant-message'; turnId: string; text: string }
  | {
      type: 'tool-call-start';
      turnId: string;
      callId: string;
      action: string;
      input: unknown;
    }
  | {
      type: 'tool-call-event';
      callId: string;
      // shape mirrors the underlying AG-UI registry event union; we
      // pass the raw value through.
      event: unknown;
    }
  | {
      type: 'tool-call-end';
      callId: string;
      action: string;
      /**
       * `proposal` (fr-agui SPEC §5.2 W): a write the agent proposed and did NOT
       * run; `output` is the AgentProposal the confirm card renders.
       */
      status: 'success' | 'failed' | 'pending' | 'proposal';
      output?: unknown;
      error?: string;
      /**
       * fr-agui SPEC §4.3 / §5.6: the refusal VERBATIM — `{status, code, message}`
       * when the failure carried them (an AppError: RBAC, project_mismatch,
       * validation, a coded route refusal). `error` keeps the string form.
       */
      errorInfo?: { status: number; code: string | null; message: string };
    }
  /**
   * fr-agui SPEC §4.3 / §5.4: a successful `ui.*` call. The rail calls `goto(route)`;
   * the route was checked server-side (agui/actions/ui-navigate.ts).
   */
  | { type: 'ui-intent'; callId: string; kind: 'navigate'; route: string }
  /**
   * fr-agui SPEC §4.3 / §5.3: the resources a write may have changed. The
   * frontend stores (board, project, approvals) re-fetch; invalidation, not a patch.
   */
  | { type: 'state-invalidate'; callId: string; resources: string[] }
  | { type: 'assistant-end'; turnId: string }
  | { type: 'done'; correlationId: string; threadId: string; turnId: string }
  | {
      type: 'error';
      correlationId: string;
      code:
        | 'max_iterations'
        | 'wall_clock_exceeded'
        | 'wm_failed'
        | 'invalid_tool_call'
        | 'tool_failure_budget'
        | 'project_not_readable'
        | 'tenant_changed'
        | 'identity_unavailable'
        | 'internal_error';
      message: string;
      /**
       * worker_management's own error code when the failure is a tenant BYO-key
       * error (BYO_KEY_WITHHELD, BYO_KEY_UNUSABLE, BYO_PROVIDER_NOT_CONFIGURED,
       * BYO_PROVIDER_CALL_FAILED, MODEL_NOT_AVAILABLE_TO_TENANT). `message` is
       * then the user-facing sentence for it. Absent for every other failure.
       */
      errorCode?: string;
    };

// ---------- Caps ----------

const MAX_ITERATIONS = 10;
const WALL_CLOCK_MS = 60_000;
/**
 * fr#1383. A run stops once this many tool calls in a row have failed (any
 * tool, any input), or once the same (action, input) has failed
 * MAX_IDENTICAL_TOOL_FAILURES times — whichever comes first. A success resets
 * the consecutive counter; the identical-call tally lives for the whole run.
 */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 4;
export const MAX_IDENTICAL_TOOL_FAILURES = 2;

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` are the same call. */
function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

// ---------- Input ----------

export interface RunAgentLoopArgs {
  sessionId: string;
  threadId: string;
  workerName: string | null;
  userMessage: string;
  ctx: ActionContext;
  /** fr-agui SPEC §6.0: `intake` = the doorway (request-intake) catalog only. */
  catalogMode?: AgentCatalogMode;
}

/**
 * Async generator: yields events in wire order. Caller is responsible for
 * encoding to NDJSON and writing to the response stream.
 */
export async function* runAgentLoop(
  args: RunAgentLoopArgs,
): AsyncGenerator<AgentChatEvent> {
  const { sessionId, threadId, ctx } = args;
  const turnId = randomUUID();
  const startedAt = Date.now();
  const workerName = args.workerName ?? FR_AGENT_DEFAULT;

  yield {
    type: 'assistant-start',
    correlationId: ctx.correlationId,
    threadId,
    turnId,
  };

  // Persist the user message before any LLM round-trip so a crash
  // mid-turn doesn't lose the user's input.
  // §10.1 (b): a secret pasted into the chat is scrubbed before it is stored
  // (and so before it reaches the LLM). The rail's own detector blocks the send
  // first (§5.5); this is the server's defence in depth.
  const userMsg: ConversationMessage = {
    role: 'user',
    content: scrubString(args.userMessage),
    ts: new Date().toISOString(),
  };
  await sessionStore.appendMessage(sessionId, userMsg);

  try {
    yield* iterateTurn({
      sessionId,
      threadId,
      turnId,
      workerName,
      ctx,
      startedAt,
      catalogMode: args.catalogMode ?? 'default',
    });
  } catch (err) {
    console.error('[agent.loop] turn failed:', err);
    yield {
      type: 'error',
      correlationId: ctx.correlationId,
      code: 'internal_error',
      message: clientSafeCaughtErrorText(err, 'The agent hit an internal error — try again'),
    };
  }
}

interface TurnArgs {
  sessionId: string;
  threadId: string;
  turnId: string;
  workerName: string;
  ctx: ActionContext;
  startedAt: number;
  catalogMode: AgentCatalogMode;
}

async function* iterateTurn(
  args: TurnArgs,
): AsyncGenerator<AgentChatEvent> {
  const { sessionId, threadId, turnId, workerName, ctx, startedAt } = args;

  // One bootstrap per loop run; cheap if cached.
  // Operator activity (a switched super_admin's Copilot) is billed to the system tenant:
  // the WM round trips run in a system-tenant frame (lib/operator-billing.ts).
  await asOperatorBilledCall(() => ensureWorker(workerName));

  let consecutiveFailures = 0;
  const failuresByCall = new Map<string, number>();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (Date.now() - startedAt > WALL_CLOCK_MS) {
      yield {
        type: 'error',
        correlationId: ctx.correlationId,
        code: 'wall_clock_exceeded',
        message: `Agent loop exceeded ${WALL_CLOCK_MS}ms wall-clock`,
      };
      yield { type: 'done', correlationId: ctx.correlationId, threadId, turnId };
      return;
    }

    const messages = await sessionStore.loadMessages(sessionId);
    const catalog = await buildToolCatalog(ctx, {
      mode: args.catalogMode,
      searched: args.catalogMode === 'project' ? searchedCapabilities(messages) : undefined,
    });
    const catalogNames = new Set(catalog.map((c) => c.name));

    let wmOutput: FrAgentOutput;
    try {
      wmOutput = await emitSpan(
        'agent.wm_call',
        {
          turnId,
          iteration: i,
          worker: workerName,
          correlationId: ctx.correlationId,
        },
        () => callWorker(workerName, messages, catalog, args.catalogMode),
      );
    } catch (err) {
      // A tenant BYO-key failure is reported as what it is, in words the user
      // can act on (owner ruling 2026-10-01: never a silent fallback, never an
      // opaque "worker_management returned 403").
      const byo = wmByoErrorFromIntegrationError(err);
      yield {
        type: 'error',
        correlationId: ctx.correlationId,
        code: 'wm_failed',
        message: byo ? byo.message : upstreamSafeText(err),
        ...(byo ? { errorCode: byo.code } : {}),
      };
      yield { type: 'done', correlationId: ctx.correlationId, threadId, turnId };
      return;
    }

    if (wmOutput.kind === 'final_answer') {
      // §10.1 (b)(c): the stored thread and the stream carry the same scrubbed text.
      const text = scrubString(wmOutput.text);
      const assistantMsg: ConversationMessage = {
        role: 'assistant',
        content: text,
        ts: new Date().toISOString(),
      };
      await sessionStore.appendMessage(sessionId, assistantMsg);
      yield { type: 'assistant-message', turnId, text };
      yield { type: 'assistant-end', turnId };
      yield { type: 'done', correlationId: ctx.correlationId, threadId, turnId };
      return;
    }

    // tool_calls path
    for (const call of wmOutput.calls) {
      const callId = randomUUID();
      // R7 + §10.1: a declared secret field never reaches the NDJSON stream or
      // the thread, and neither does a secret-SHAPED value (redact.ts).
      const secretFields = getAction(call.action)?.confirm?.secretFields;
      const safeInput = redact(redactSecretFields(call.input, secretFields), { secretPaths: secretFields, pii: AGENT_PII_MASKS });
      yield {
        type: 'tool-call-start',
        turnId,
        callId,
        action: call.action,
        input: safeInput,
      };

      // The catalog is a hard boundary in the doorway AND the project agent
      // (SPEC §6.0, §4.1): a tool outside THIS turn's catalog is refused even if
      // the model names one it saw elsewhere (a retired action, a searchable one
      // not yet found by capabilities.search).
      const bounded = args.catalogMode === 'intake' || args.catalogMode === 'project';
      const rawEvent = !bounded || catalogNames.has(call.action)
        ? await runOneTool(call.action, call.input, ctx)
        : {
            action: call.action,
            status: 'failed' as const,
            error: `Unknown action: ${call.action}. It is not in this conversation's tool catalog.`,
          };
      // §10.1 (a)(b)(c): ONE redacted view goes to the stream, the thread and
      // (through the thread) the next LLM call.
      const toolEvent: ToolCallEnd = {
        ...rawEvent,
        ...(rawEvent.output !== undefined ? { output: redact(rawEvent.output, { secretPaths: secretFields, pii: AGENT_PII_MASKS }) } : {}),
        ...(rawEvent.error !== undefined ? { error: scrubString(rawEvent.error) } : {}),
        ...(rawEvent.errorInfo !== undefined
          ? { errorInfo: { ...rawEvent.errorInfo, message: scrubString(rawEvent.errorInfo.message) } }
          : {}),
      };
      yield { type: 'tool-call-end', callId, ...toolEvent };
      for (const ev of followUpEvents(callId, toolEvent, ctx)) yield ev;
      // SPEC §10.5: a rail proposal is audited (`capability_audit`, with the bound
      // project); the human's click on its card is audited by the route.
      if (toolEvent.status === 'proposal' && isAgentTokenContext(ctx)) {
        const proposal = toolEvent.output as AgentProposal;
        await recordProposal({
          capabilityId: call.action,
          proposalId: proposal.proposalId,
          threadId,
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          input: proposal.input,
          secretPaths: secretFields,
          correlationId: ctx.correlationId,
        });
      }

      // Persist the tool result so the next WM call sees it as context.
      // ⛔ fr#1383: a FAILED call has no `output`, so this used to persist
      // `null` and the model saw `TOOL[x] (failed): null` — never the reason —
      // and re-issued the identical call. The (client-safe) error text is what
      // the model needs to correct its input.
      await sessionStore.appendMessage(sessionId, {
        role: 'tool',
        action: call.action,
        callId,
        output:
          toolEvent.status === 'failed'
            ? { error: toolEvent.error ?? 'tool call failed', ...(toolEvent.errorInfo ? { code: toolEvent.errorInfo.code } : {}) }
            : (toolEvent.output ?? null),
        status: toolEvent.status,
        ts: new Date().toISOString(),
      });

      if (toolEvent.status === 'failed') {
        consecutiveFailures++;
        const key = `${call.action}\u0000${stableStringify(call.input)}`;
        const sameCallFailures = (failuresByCall.get(key) ?? 0) + 1;
        failuresByCall.set(key, sameCallFailures);
        const repeated = sameCallFailures >= MAX_IDENTICAL_TOOL_FAILURES;
        if (repeated || consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          const why = repeated
            ? `${call.action} failed ${sameCallFailures} times with the same input`
            : `${consecutiveFailures} tool calls failed in a row`;
          // Same cap as a replayed tool output: the error text is already
          // client-safe (see toolErrorText), this only bounds its size.
          const lastError = toolEvent.error
            ? ` Last error: ${truncateErrorText(toolEvent.error)}`
            : '';
          yield {
            type: 'error',
            correlationId: ctx.correlationId,
            code: 'tool_failure_budget',
            message: `Agent stopped: ${why}, so retrying cannot help.${lastError} Rephrase the request or send another message to continue.`,
          };
          yield { type: 'done', correlationId: ctx.correlationId, threadId, turnId };
          return;
        }
      } else {
        consecutiveFailures = 0;
      }
    }

    // Loop continues — WM gets the new context on the next iteration.
  }

  yield {
    type: 'error',
    correlationId: ctx.correlationId,
    code: 'max_iterations',
    message: `Agent loop hit max iterations (${MAX_ITERATIONS}). The conversation can continue with another user message.`,
  };
  yield { type: 'done', correlationId: ctx.correlationId, threadId, turnId };
}

interface ToolCallEnd {
  action: string;
  status: 'success' | 'failed' | 'pending' | 'proposal';
  output?: unknown;
  error?: string;
  errorInfo?: { status: number; code: string | null; message: string };
}

/**
 * The searchable project tools `capabilities.search` returned earlier in THIS
 * thread (SPEC §4.1): read back out of the thread's own stored tool results, so
 * the widening is per thread, survives a reload and needs no extra state.
 */
export function searchedCapabilities(messages: ConversationMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool' || m.action !== 'capabilities.search' || m.status !== 'success') continue;
    const caps = (m.output as { capabilities?: unknown } | null)?.capabilities;
    if (!Array.isArray(caps)) continue;
    for (const c of caps) {
      const name = (c as { name?: unknown } | null)?.name;
      if (typeof name === 'string') out.add(name);
    }
  }
  return out;
}

/** `ui-intent` after a successful navigation; `state-invalidate` after a write that ran or parked. */
function* followUpEvents(callId: string, ev: ToolCallEnd, ctx: ActionContext): Generator<AgentChatEvent> {
  if (ev.status === 'success' && ev.action.startsWith('ui.')) {
    const out = ev.output as { kind?: unknown; route?: unknown } | null;
    if (out && out.kind === 'navigate' && typeof out.route === 'string') {
      yield { type: 'ui-intent', callId, kind: 'navigate', route: out.route };
    }
    return;
  }
  const action = getAction(ev.action);
  if (action?.kind === 'write' && (ev.status === 'success' || ev.status === 'pending')) {
    const resources = invalidationsFor(ev.action, ctx.projectId);
    if (resources.length > 0) yield { type: 'state-invalidate', callId, resources };
  }
}

async function runOneTool(
  action: string,
  input: unknown,
  ctx: ActionContext,
): Promise<ToolCallEnd> {
  try {
    const registered = getAction(action);
    // fr-agui SPEC §5.7 rule 3: a project-bound thread's project is injected from
    // `ctx.projectId`; another project's id is refused `project_mismatch` before
    // anything is proposed or invoked (invokeAction applies the same, idempotently).
    if (registered) input = bindProjectInput(registered, input, ctx);
    // fr-agui P2: an asset addressed by id must be the bound project's
    // (agent/project-asset-guard.ts) — before a proposal is shaped, too.
    if (registered) await assertAssetInBoundProject(registered, input, ctx);
    // fr-agui SPEC §5.2 (W): a write with a confirm card is PROPOSED, never
    // invoked — no handler, no approval row. The human's click runs it.
    if (registered?.confirm) {
      const proposal = await buildProposal(registered, input, ctx);
      return { action, status: 'proposal', output: proposal };
    }
    const result = await invokeAction(action, input, ctx);
    if (isAgentProposal(result)) return { action, status: 'proposal', output: result };
    if (isPendingAction(result)) {
      return {
        action,
        status: 'pending',
        output: {
          actionId: result.actionId,
          ...(result.approvalId ? { approvalId: result.approvalId } : {}),
        },
      };
    }
    return { action, status: 'success', output: result };
  } catch (err) {
    if (err instanceof UnknownActionError) {
      return {
        action,
        status: 'failed',
        error: `Unknown action: ${action}. The LLM picked a tool that is not in the catalog — this is a bug.`,
      };
    }
    if (err instanceof RbacDeniedError) {
      return {
        action,
        status: 'failed',
        error: `RBAC denied: ${err.reason}`,
        errorInfo: { status: err.statusCode, code: err.code ?? null, message: err.reason },
      };
    }
    const text = toolErrorText(err);
    return {
      action,
      status: 'failed',
      error: text,
      ...(err instanceof AppError && !isIntegrationError(err)
        ? { errorInfo: { status: err.statusCode, code: err.code ?? null, message: text } }
        : {}),
    };
  }
}

/** What a non-super-admin is told when a tool failed with text fr did not author. */
export const GENERIC_TOOL_FAILURE_TEXT =
  'The tool failed for a reason that cannot be shown — try a different input or another tool';

/**
 * fr#1383. The ONE sanitiser for a failed tool call's text. Its output reaches
 * three places — the panel (`tool-call-end.error`), the model (replayed into
 * the next WM message), and the terminal `tool_failure_budget` message — so
 * none of them can carry more than the user-facing error path would.
 *
 *  - IntegrationError → `clientSafeUpstreamText` (the user-facing rule in
 *    `integrations/_lib/errors.ts`): per-status generic text for an upstream
 *    code, fr's own message for an fr-local code.
 *  - AppError (ActionInputValidationError, RBAC, ForbiddenError, ...) is
 *    fr-authored about the caller's own input; the model needs it to recover.
 *  - ANY OTHER error is a plain `Error` whose text fr cannot vouch for (a
 *    library or a client that embeds an upstream body — secrets-service does)
 *    → `clientSafeCaughtErrorText`, which fails closed to the generic text.
 */
function toolErrorText(err: unknown): string {
  if (isIntegrationError(err)) return upstreamSafeText(err);
  if (err instanceof AppError) return err.message;
  return clientSafeCaughtErrorText(err, GENERIC_TOOL_FAILURE_TEXT);
}

function truncateErrorText(text: string): string {
  return text.length <= TOOL_OUTPUT_BUDGET
    ? text
    : `${text.slice(0, TOOL_OUTPUT_BUDGET)}… [truncated, ${text.length} chars]`;
}

/**
 * An agent-token caller is never a verified super-admin, so an upstream
 * IntegrationError's "<service> <METHOD> <internal path> returned <status>"
 * becomes the generic per-status text. fr-authored errors (action validation,
 * RBAC) keep their message — the model and the user need it to recover.
 */
function upstreamSafeText(err: unknown): string {
  if (isIntegrationError(err)) console.warn('[agent.loop] upstream failure:', err.message);
  return clientSafeUpstreamText(err);
}

function isPendingAction(v: unknown): v is PendingAction {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { status?: unknown }).status === 'pending' &&
    typeof (v as { actionId?: unknown }).actionId === 'string'
  );
}

// ---------- WM call ----------

async function callWorker(
  workerName: string,
  messages: ConversationMessage[],
  catalog: CatalogEntry[],
  mode: AgentCatalogMode,
): Promise<FrAgentOutput> {
  // WM accepts a single `message` string + `context`. The tool catalog is one
  // entry per RBAC-allowed action, each with a JSON-Schema input — easily tens
  // of KB and deeply nested. WM caps `context` at 10KB serialized / depth-10
  // (worker_management MessageRequest.validate_context), so the catalog must NOT
  // go there; we render it INTO the `message` body (5M-char cap) instead.
  //
  // `trust_content: true` tells WM's message security-validator that the
  // JSON-Schema / shell-ish / URL substrings in the catalog + tool-output
  // transcript are fr-constructed content, not adversarial input — fr is the
  // trusted, license-authz-gated caller. Every tool call the LLM emits is still
  // RBAC-revalidated here before execution and constrained to the worker's
  // output_schema, so this does not widen the real attack surface.
  //
  // The system_prompt is set on the worker itself in wm-bootstrap; we do NOT
  // override it per-call so a malicious user can't smuggle one in.
  const transcript = renderTranscript(messages);
  // SPEC §11.2: fr's own in-repo pack instructions (fr-authored, so they sit
  // above the catalog). The worker's system_prompt is fixed in wm-bootstrap.
  const pack = mode === 'project' ? renderPackBlock('project-core') : mode === 'intake' ? renderPackBlock('request-intake') : null;
  const message =
    `${pack ? `${pack}\n\n` : ''}${renderCatalog(catalog)}\n\n` +
    `## CONVERSATION\n${transcript}`;

  // A switched super_admin's Copilot is OPERATOR activity: the LLM call is metered and licensed
  // against the system tenant, never the customer (lib/operator-billing.ts). Tools stay target-scoped.
  const resp = await asOperatorBilledCall(() =>
    sendWorkerMessage(workerName, {
      message,
      trust_content: true,
    }),
  );

  const out = resp.output;
  const parsed = parseAgentOutput(out);
  if (!parsed) {
    throw new Error(
      `worker_management returned an output that did not match the agent schema: ${JSON.stringify(out).slice(0, 500)}`,
    );
  }
  return parsed;
}

// The LLM picks tool action names from this catalog (see wm-bootstrap
// SYSTEM_PROMPT, which points it at the AVAILABLE TOOLS block). Rendered into
// the message body — NOT context — because WM caps context at 10KB/depth-10.
function renderCatalog(catalog: CatalogEntry[]): string {
  if (catalog.length === 0) return '## AVAILABLE TOOLS (JSON)\n[]';
  return `## AVAILABLE TOOLS (JSON)\n${JSON.stringify(catalog)}`;
}

/**
 * Per-tool-message budget for what we replay back to the model.
 *
 * 1000 -> 2500 -> 10000. The earlier caps were sized against the WRONG
 * constraint: WM's 10KB/depth-10 limit applies to `context`, and the transcript
 * is rendered into the MESSAGE body (see the call site, and renderCatalog's
 * note saying the same thing about the tool catalog). So the tight cap bought
 * nothing and cost answers.
 *
 * Measured live 2026-08-07 against the real principles catalog (100 rows,
 * ~1009 chars each): the flagship question "list the principles in the library"
 * surfaced 2 of 100 at 2500. At 10000 with null/empty fields dropped it
 * surfaces ~14 — a 7x better answer for one constant and a filter.
 *
 * Still bounded, not unbounded: a turn can carry several tool messages, and an
 * enormous transcript is its own failure mode.
 */
export const TOOL_OUTPUT_BUDGET = 10_000;

/** Array-shaped payload keys used across the action catalog. */
const LIST_KEYS = ['items', 'results', 'sources', 'data', 'rows'] as const;

/**
 * Render a tool result for the model WITHOUT ever handing it malformed JSON.
 *
 * This used to be `JSON.stringify(output).slice(0, 1000)`. A blind slice cuts
 * mid-object, so anything larger than the cap reached the model as a corrupt
 * fragment ending in a half-written string. Observed live 2026-08-07: asking
 * the agent "list the principles in the library" produced
 *   `2. **Idempotency-...** (entry returned, but the full title/statement was
 *    truncated in the tool response)`
 * plus "the returned list may contain additional entries beyond what was
 * shown" — the model correctly refusing to trust a payload we had corrupted.
 *
 * Two rules now hold:
 *  1. The model always receives VALID JSON.
 *  2. When we drop data we say so in-band, with counts, so the model can tell
 *     the user "showing 5 of 23" instead of guessing whether more exists.
 */
/** Drop null / empty-string / empty-array fields. Lossless for a reader. */
function leanItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export function renderToolOutput(output: unknown): string {
  const full = JSON.stringify(output) ?? 'null';
  if (full.length <= TOOL_OUTPUT_BUDGET) return full;

  // Array-shaped payloads: keep WHOLE elements, never a partial one.
  const obj =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : null;
  const listKey = obj ? LIST_KEYS.find((k) => Array.isArray(obj[k])) : null;
  const list = Array.isArray(output)
    ? (output as unknown[])
    : listKey
      ? (obj![listKey] as unknown[])
      : null;

  if (list) {
    const kept: unknown[] = [];
    let used = 0;
    for (const item of list) {
      // Only when we are ALREADY dropping data do we lean each row out. A
      // payload that fits is returned byte-identical above, so fidelity is
      // never traded away for rows we could have shown anyway.
      //
      // Dropping null / '' / [] is lossless for a reader: absent and null mean
      // the same thing here, and these rows carry ~30 fields of versioning and
      // quality metadata that are mostly empty. Measured 29% smaller, i.e. ~40%
      // more rows survive the budget.
      const lean = leanItem(item);
      const size = (JSON.stringify(lean) ?? 'null').length + 1;
      if (used + size > TOOL_OUTPUT_BUDGET) break;
      kept.push(lean);
      used += size;
    }
    const note = { shown: kept.length, total: list.length, reason: 'tool output exceeded the per-message budget' };
    const payload = Array.isArray(output)
      ? { items: kept, _truncated: note }
      : { ...obj, [listKey as string]: kept, _truncated: note };
    const rendered = JSON.stringify(payload);
    // Even one element can exceed the budget; fall through rather than lie.
    if (rendered.length <= TOOL_OUTPUT_BUDGET * 2) return rendered;
  }

  // Non-list payload: hand over a truncated STRING (valid JSON) plus the note,
  // never a severed object.
  return JSON.stringify({
    _truncated: { reason: 'tool output exceeded the per-message budget', originalLength: full.length },
    preview: full.slice(0, TOOL_OUTPUT_BUDGET),
  });
}

export function renderTranscript(messages: ConversationMessage[]): string {
  if (messages.length === 0) return '(empty conversation)';
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`USER: ${m.content}`);
    } else if (m.role === 'assistant') {
      lines.push(`ASSISTANT: ${m.content}`);
    } else {
      lines.push(`TOOL[${m.action}] (${m.status}): ${renderToolOutput(m.output)}`);
    }
  }
  return lines.join('\n');
}

function parseAgentOutput(raw: unknown): FrAgentOutput | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'final_answer' && typeof obj.text === 'string') {
    return { kind: 'final_answer', text: obj.text };
  }
  if (obj.kind === 'tool_calls' && Array.isArray(obj.calls)) {
    const calls: Array<{ action: string; input: unknown }> = [];
    for (const c of obj.calls) {
      if (
        c !== null &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).action === 'string'
      ) {
        const cObj = c as Record<string, unknown>;
        calls.push({
          action: cObj.action as string,
          input: cObj.input,
        });
      }
    }
    if (calls.length > 0) return { kind: 'tool_calls', calls };
  }
  return null;
}
