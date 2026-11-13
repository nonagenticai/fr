#!/usr/bin/env bun
/**
 * Idempotent provisioning of the `signal-intent-resolver` worker in
 * worker_management. Run once per environment after the LLMIntentResolver
 * code lands.
 *
 *   bun run scripts/provision-intent-resolver-worker.ts
 *
 * Re-running is safe — getWorker probes existence; if found, updateWorker
 * replaces the config; otherwise createWorker mints it.
 *
 * Note on prompts: this baked-in system_prompt carries the role + rules
 * only. The live action catalog (with input shapes) is composed into the
 * per-call message body by `makeProductionLLMClient`, so the worker-level
 * prompt never goes stale relative to the registered actions.
 */

import {
  createWorker,
  getWorker,
  sendWorkerMessage,
  updateWorker,
} from '../src/integrations/workers';

const WORKER_NAME = 'signal-intent-resolver';
// Route: WM → inference-router → the ONE vLLM model on pgx, served as
// `local-llm`. Every consumer names exactly `local-llm` — never a placeholder
// (`default`, `tier-*`) or a concrete model name — and there is deliberately no
// env override for the model.
const MODEL = 'local-llm';
const MODEL_PROVIDER = process.env.INTENT_RESOLVER_MODEL_PROVIDER || 'inference_router';
// pydantic-ai is the agent type for "standard LLM via pydantic-ai" workers
// in WM. Required: WM 400s "Worker is not an agent" on /message without it.
// Other types (claude-code, codex, remote-*) are CLI-based and would hang
// for the few-hundred-ms intent classification we want here.
const AGENT_TYPE = 'pydantic_ai';
// WM rejects 422 if agent_type is set without agent_role. Free-form label.
const AGENT_ROLE = 'intent-classifier';
const TEMPERATURE = 0; // deterministic intent classification
// Output is a small JSON envelope; cap so a chatty backend can't blow the
// model context window or burn tokens on prose.
const MAX_TOKENS = 256;

// Trimmed prompt — role + rules only. The action catalog (names + zod
// input shapes) is inlined into the per-call message body by
// `makeProductionLLMClient`, not here.
const SYSTEM_PROMPT = `You classify user intent. Output ONLY JSON matching output_schema. No prose.

Rules:
- action_name: FULL dotted form from catalog
- action_input: EXACT field names from catalog, ALL required fields populated
- Always include confidence (0-1)
- intent="clarify" for ambiguous, "no-action" for small-talk`;

async function main(): Promise<void> {
  let exists = false;
  try {
    await getWorker(WORKER_NAME);
    exists = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404|not.?found/i.test(msg)) {
      exists = false;
    } else {
      throw err;
    }
  }

  const body = {
    worker_name: WORKER_NAME,
    agent_type: AGENT_TYPE,
    agent_role: AGENT_ROLE,
    model: MODEL,
    model_provider: MODEL_PROVIDER,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    system_prompt: SYSTEM_PROMPT,
  };

  if (exists) {
    // updateWorker takes (workerName, body) — body shape is similar
    // (WorkerUpdateRequest accepts the same configurable fields).
    await updateWorker(WORKER_NAME, body);
    console.log(`[provision] updated existing worker "${WORKER_NAME}"`);
  } else {
    await createWorker(body);
    console.log(`[provision] created worker "${WORKER_NAME}"`);
  }

  // Sanity probe: send a no-op message and assert the worker round-trips.
  // We don't validate the output content (a fresh worker may pick any
  // intent on "hi") — just that the call returns without error.
  try {
    const probe = await sendWorkerMessage(WORKER_NAME, {
      message: 'hi',
      output_schema: {
        type: 'object',
        properties: {
          intent: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['intent', 'confidence'],
      },
    });
    console.log('[provision] probe ok, output type:', typeof probe.output);
  } catch (err) {
    console.warn(
      '[provision] probe failed (worker provisioned, runtime call errored):',
      err instanceof Error ? err.message : String(err),
    );
    // Don't fail the script — the worker is provisioned. Probe failure
    // means the runtime call needs further investigation (model
    // misconfigured, inference-router unreachable, etc.) but the config
    // itself is in place.
  }
}

await main();
