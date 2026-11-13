/**
 * LLMIntentResolver — free-text chat routing via worker_management.
 *
 * Wraps a fallback IntentResolver. When invoked, builds a system prompt
 * from the live `listActions()` catalog, asks the WM-hosted
 * `signal-intent-resolver` worker to classify the user text into one of
 * the registered actions (or a `clarify` / `no-action` outcome), and
 * returns the structured result. Falls back to the wrapped resolver on
 * any failure: malformed LLM output, low confidence, unregistered
 * action name, transport error.
 *
 * No LLM calls happen in unit tests — the WM client is injected via the
 * second constructor arg. server.ts wires the production client.
 *
 * Sits between CommandGrammarIntentResolver (verb fast-path) and
 * HeuristicIntentResolver (last-resort regex direct invocation):
 *   CommandGrammar → LLM → Heuristic
 */

import { z } from 'zod';

import { getAction, listActions } from '../agui/registry';
import type { InboundMessage } from '../channels';
import type { IntentResolution, IntentResolver } from './types';

const llmOutputSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('action'),
    action_name: z.string().min(1),
    action_input: z.record(z.unknown()),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    intent: z.literal('clarify'),
    reply_text: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    intent: z.literal('no-action'),
    reply_text: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1),
  }),
]);

export type IntentLLMOutput = z.infer<typeof llmOutputSchema>;

/** Function signature of the LLM client. Production wires this to
 *  sendWorkerMessage('signal-intent-resolver', ...) and parses the
 *  response (`makeProductionLLMClient`). */
export type IntentLLMClient = (text: string, systemPrompt: string) => Promise<IntentLLMOutput>;

export interface LLMIntentResolverOptions {
  /** Minimum confidence the LLM must report on `intent: action` for
   *  the resolver to commit to it. Below this, falls through. */
  confidenceThreshold?: number;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Best-effort description of a zod object's input shape for the LLM
 * prompt. We don't pull in `zod-to-json-schema` (avoidable dep); the
 * LLM only needs human-readable field names + their primitive types
 * to populate `action_input`. Falls back to `<unknown shape>` if the
 * schema isn't a `ZodObject` we can introspect.
 */
function describeZodInputShape(schema: unknown): string {
  // ZodObject's runtime carries `_def.shape` (a function returning the
  // record of `{ key: ZodTypeAny }`) on zod 3.x. Anything else just
  // surfaces as `<unknown shape>`.
  const def = (schema as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } })
    ?._def;
  if (!def || def.typeName !== 'ZodObject' || typeof def.shape !== 'function') {
    return '<unknown shape>';
  }
  const shape = def.shape();
  const fields: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const fieldDef = (fieldSchema as { _def?: { typeName?: string } })?._def;
    const typeName = fieldDef?.typeName ?? 'unknown';
    // Strip the Zod prefix for readability: ZodString -> string, etc.
    const friendly = typeName.replace(/^Zod/, '').toLowerCase();
    // Detect optional via the ZodOptional wrapper.
    const optional = typeName === 'ZodOptional' ? '?' : '';
    fields.push(`${key}${optional}: ${friendly}`);
  }
  return `{ ${fields.join(', ')} }`;
}

export function buildSystemPrompt(): string {
  const actions = listActions();
  const lines: string[] = [
    'You are the intent classifier for a Telegram/Teams chat agent.',
    '',
    'Read the user message and pick exactly one of the following intents.',
    'Output ONLY a JSON object that conforms to the schema below; no prose.',
    '',
    'Schema:',
    '  intent: "action" | "clarify" | "no-action"',
    '  confidence: number in [0, 1] reflecting your certainty',
    '',
    '  When intent="action":',
    '    action_name: one of the catalogued action names below — EXACT match including the dotted prefix',
    "    action_input: object matching that action's input shape (see catalog)",
    '',
    '  When intent="clarify":',
    '    reply_text: question to ask the user (e.g. "Which card?")',
    '',
    '  When intent="no-action":',
    '    reply_text: optional friendly note (e.g. "Got it, no action needed.")',
    '',
    'Action catalog (action_name → input shape — description):',
  ];
  for (const a of actions) {
    const shape = describeZodInputShape(a.input);
    lines.push(`  - ${a.name} → ${shape} — ${a.description}`);
  }
  lines.push(
    '',
    'Rules:',
    '  - Action names MUST be the FULL dotted form from the catalog (e.g. "kanban.create_card", not "create_card").',
    '  - action_input MUST use the EXACT field names from the input shape — copy them verbatim.',
    '  - If the user message is ambiguous (e.g. references "the card" without identifying which), use intent="clarify".',
    '  - If the user message is conversational small-talk with no actionable request, use intent="no-action".',
    '  - Never invent action names not in the catalog.',
    '  - Only commit to an action when confidence >= 0.7 of correct routing AND of correct input extraction.',
  );
  return lines.join('\n');
}

export class LLMIntentResolver implements IntentResolver {
  private readonly threshold: number;

  constructor(
    private readonly fallback: IntentResolver,
    private readonly llm: IntentLLMClient,
    options: LLMIntentResolverOptions = {},
  ) {
    this.threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  }

  async resolveIntent(msg: InboundMessage): Promise<IntentResolution> {
    let raw: unknown;
    try {
      const systemPrompt = buildSystemPrompt();
      raw = await this.llm(msg.text, systemPrompt);
    } catch (err) {
      console.warn(
        `[llm-resolver] LLM call failed cid=${msg.correlationId}: ${err instanceof Error ? err.message : String(err)} — falling back`,
      );
      return this.fallback.resolveIntent(msg);
    }

    const parsed = llmOutputSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[llm-resolver] LLM output failed schema validation cid=${msg.correlationId}: ${parsed.error.message} — falling back`,
      );
      return this.fallback.resolveIntent(msg);
    }
    const out = parsed.data;

    if (out.intent === 'clarify') {
      // The model asks a question back: a reason an mcp caller can act on (fr #1683).
      return { kind: 'no-action', replyText: out.reply_text, code: 'clarification_needed' };
    }

    if (out.intent === 'no-action') {
      // Match the existing dispatcher contract: replyText is optional.
      // When present, the dispatcher posts it; when absent, dispatcher
      // returns a silent 200 ack.
      return { kind: 'no-action', replyText: out.reply_text };
    }

    // intent === 'action'
    if (out.confidence < this.threshold) {
      console.info(
        `[llm-resolver] LLM action confidence ${out.confidence} below threshold ${this.threshold} cid=${msg.correlationId} — falling back`,
      );
      return this.fallback.resolveIntent(msg);
    }

    if (!getAction(out.action_name)) {
      console.warn(
        `[llm-resolver] LLM picked unregistered action "${out.action_name}" cid=${msg.correlationId} — falling back`,
      );
      return this.fallback.resolveIntent(msg);
    }

    // An LLM chose this action from free text. Never deterministic, so a write
    // reached this way always parks for human approval.
    return {
      kind: 'action',
      actionName: out.action_name,
      input: out.action_input,
      matchedDeterministically: false,
    };
  }
}

/**
 * Production LLM client. Calls sendWorkerMessage on the
 * `signal-intent-resolver` worker provisioned in worker_management,
 * passing the same JSON schema the resolver expects so the LLM emits
 * a structured response. Parses the worker's `message` field as JSON
 * and returns it for `LLMIntentResolver` to validate.
 *
 * Accepts the send-worker-message function as a dependency so the
 * unit test doesn't need to spin up the WM HTTP client.
 */
// Structurally compatible with `sendWorkerMessage` from
// `integrations/workers.ts` — the SDK accepts the loosely-typed
// `MessageRequest`, and the response carries a `message` string. We
// don't import the SDK types here to keep agent-core independent of
// the worker_management generated client; structural typing is enough.
type WorkerMessageBody = {
  message: string;
  context?: Record<string, unknown>;
  // SDK shape: MessageRequestOutputSchema = { [k]: unknown } | null. JSON
  // schema is plain object data; keep it that loose so any valid schema
  // shape goes through unchanged.
  output_schema?: { [key: string]: unknown } | null;
};
// SDK MessageResponse.output is `unknown` — when output_schema is set,
// the worker delivers the parsed structured output here (NOT a JSON string).
// `output_type` and other fields exist but we don't use them.
type WorkerMessageReply = {
  output: unknown;
  // tolerated for forward compatibility; not used by the resolver
  output_type?: unknown;
  metadata?: unknown;
};
type SendWorkerMessage = (workerName: string, body: WorkerMessageBody) => Promise<WorkerMessageReply>;

/**
 * The worker's provisioned name in worker_management (see
 * scripts/provision-intent-resolver-worker.ts). It predates the Signal channel's
 * removal and is kept so the live worker keeps resolving; renaming it is a
 * separate cross-service change.
 */
const WORKER_NAME = 'signal-intent-resolver';

const productionOutputJsonSchema = {
  type: 'object',
  oneOf: [
    {
      properties: {
        intent: { const: 'action' },
        action_name: { type: 'string' },
        action_input: { type: 'object' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['intent', 'action_name', 'action_input', 'confidence'],
    },
    {
      properties: {
        intent: { const: 'clarify' },
        reply_text: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['intent', 'reply_text', 'confidence'],
    },
    {
      properties: {
        intent: { const: 'no-action' },
        reply_text: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['intent', 'confidence'],
    },
  ],
};

export function makeProductionLLMClient(send: SendWorkerMessage): IntentLLMClient {
  return async (text, systemPrompt) => {
    // WM workers hold system_prompt at PUT time (no per-call override —
    // see `no-prompt-registry-wm-is-the-store` memory). The role + rules
    // live in the worker's system_prompt; the live action catalog + the
    // user text travel together in the message body so the catalog
    // reflects whatever's currently registered without re-PUTting on
    // every action change.
    const composedMessage = [
      systemPrompt,
      '',
      'User message:',
      text,
    ].join('\n');

    const response = await send(WORKER_NAME, {
      message: composedMessage,
      output_schema: productionOutputJsonSchema,
    });
    // With output_schema set, WM returns the parsed structured object on
    // `output`. If the worker is misconfigured (no output_schema enforced)
    // it could land as a string instead — handle both shapes for resilience.
    let parsed: unknown = response.output;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch (err) {
        throw new Error(
          `[llm-resolver] worker output is a non-JSON string: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (parsed === undefined || parsed === null) {
      throw new Error('[llm-resolver] worker returned empty output');
    }
    // Caller (LLMIntentResolver) re-validates against the zod schema —
    // keep this return loosely typed so the boundary is one-way.
    return parsed as IntentLLMOutput;
  };
}
