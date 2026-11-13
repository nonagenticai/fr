/**
 * Plan 3 — Lazy bootstrap for the `fr-agent-default` worker in
 * worker_management.
 *
 * Workers are tenant-isolated, so we can't seed a global default at boot —
 * each tenant must have its own row in `workers`. On the first agent loop
 * turn for a tenant, this module ensures the worker exists with the
 * canonical Plan 3 config; subsequent turns hit a per-tenant in-memory
 * cache and skip the round-trip.
 *
 * The agent loop in `loop.ts` calls `ensureWorker(workerName)` once before
 * the first WM round-trip. Failures here are logged but do NOT abort the
 * loop — the loop will surface a sensible upstream error from
 * `sendWorkerMessage` itself if the worker really isn't configured.
 *
 * NOTE on worker config: the system prompt + model + output_schema landed
 * here are the contract the loop relies on. If you change them, bump the
 * cache key (see `WORKER_CONFIG_REVISION`) so existing tenants pick up
 * the new shape on next turn.
 */

import { getWorker, createWorker, updateWorker } from '../integrations/workers';
import { getTenantId } from '../integrations/_lib/context';

import { FR_AGENT_TOOL_OUTPUT_SCHEMA } from './tool-output-schema';

/**
 * The work-size tier the assistant runs at (owner ruling 2026-10-01). WM
 * resolves the tenant's `tier:medium` BYO row (falling back to the tenant's
 * `__default__` row) at run time. No model pin: the tenant's row decides the
 * model, and a withheld/unusable key is a WM error, never a silent fallback.
 */
export const FR_AGENT_WORK_TIER = 'medium' as const;

/** Default worker name used by the agent loop when no override is set. */
export const FR_AGENT_DEFAULT = 'fr-agent-default';

/**
 * Bump this string whenever the canonical worker config (system prompt,
 * model, output schema) changes shape. Existing per-tenant cache entries
 * with an older revision are evicted, forcing a `PUT /workers/{name}` so
 * the upstream config matches.
 */
const WORKER_CONFIG_REVISION = '2026-10-01-plan3-r8-work-tier-medium';

const SYSTEM_PROMPT = `You are the fr conversation agent — the single user-facing
intelligence layer for an agent-first corporate platform.

Output contract (STRICT — your reply MUST match exactly one of these shapes):
  - Final answer:  { "kind": "final_answer", "text": "<answer>" }
  - Tool calls:    { "kind": "tool_calls",
                     "calls": [ { "action": "<slice>.<verb_object>",
                                  "input": { ... } }, ... ] }

\`kind\` is ONLY ever the literal string "final_answer" or "tool_calls".
Action names like "agent.search_library" are NEVER used as \`kind\`; they
go inside \`calls[].action\`. Tool action names must come from the
"## AVAILABLE TOOLS (JSON)" block in the message — never invent a tool name.

Workflow vs exception path:
  - Prefer the "deterministic workflow" path when an action exists for
    the user's intent. The system is intelligence; rely on it.
  - When no codified action covers the user's intent, answer the user
    honestly about what is and isn't supported today.

Style:
  - Concise. Show the user what you did, not how you decided.
  - When you call tools, the user sees the tool-call cards inline; you
    don't need to narrate intermediate steps in prose.
  - When the AVAILABLE TOOLS block does not contain something the user
    asked for, say so directly.`;

interface WorkerConfig {
  worker_name: string;
  agent_type: string;
  agent_role: string;
  model_provider: string;
  model: string;
  temperature: number;
  work_tier: typeof FR_AGENT_WORK_TIER;
  system_prompt: string;
  description: string;
  output_schema: Record<string, unknown>;
  // Round-tripped through WM (worker_management commit a3bdd5a adds the
  // top-level workers.config_revision column + WorkerCreateRequest field).
  // Lets operators query "which revision did each tenant land on?" instead
  // of relying on the in-process verified-cache. Older WM images with
  // extra="ignore" silently drop the field — harmless during rollout.
  // @fr/service-client-workers will pick it up on the next openapi regen.
  config_revision: string;
}

export function buildConfig(workerName: string): WorkerConfig {
  return {
    worker_name: workerName,
    agent_type: 'pydantic_ai',
    // WM's WorkerCreateRequest validator (worker_management/src/api/workers/
    // models.py:371) requires agent_role whenever agent_type is set;
    // omitting it returns 422 and the loop surfaces the error as the
    // assistant reply. Matches the seed-script convention of a concrete,
    // human-readable role label.
    agent_role: 'fr Conversation Agent',
    // WHY model_provider/model are still sent (owner asked to drop them if WM
    // allowed it): WM's `validate_effective_worker`
    // (src/api/workers/models.py) REQUIRES both for a pydantic_ai worker
    // ("model_provider is required for pydantic_ai agent" / "model is required
    // when model_provider is specified"), so a create without them is a 422.
    // They are NOT a pin: `inference_router` is system-routed, so
    // `resolve_llm_config` (src/worker/factory/llm_config_resolver.py) does not
    // treat it as a genuine per-worker override and overlays the tenant's
    // `tier:<work_tier>` row first, then `__default__`. These two values are
    // only the platform routing used when the tenant has no row at all.
    model_provider: 'inference_router',
    // ONE vLLM model on pgx, served as `local-llm`; every consumer names exactly
    // that. Never a placeholder (`default`, `tier-*`) or a concrete model name
    // (`qwen*`, `pgx-*`, `deepseek*`, `gpt-*`): ensureWorker PUTs this config for
    // every tenant at runtime, so any other value here is a live producer that
    // reverts worker rows fixed via the worker_management API.
    model: 'local-llm',
    temperature: 0.2,
    // Selects the tenant's per-tier BYO row in WM (see FR_AGENT_WORK_TIER).
    work_tier: FR_AGENT_WORK_TIER,
    system_prompt: SYSTEM_PROMPT,
    description: 'fr conversation agent — Plan 3',
    output_schema: FR_AGENT_TOOL_OUTPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
    config_revision: WORKER_CONFIG_REVISION,
  };
}

/**
 * Per-tenant memo of "we have already verified this worker is up-to-date
 * in this process". Keyed by `${tenantId}:${workerName}:${revision}`.
 * Cleared on process restart, which is fine — bootstrap is cheap.
 */
const verified = new Set<string>();

function cacheKey(workerName: string): string {
  const tenant = getTenantId() ?? 'no-tenant';
  return `${tenant}:${workerName}:${WORKER_CONFIG_REVISION}`;
}

/**
 * Ensure `workerName` exists in worker_management for the current tenant
 * with the canonical Plan 3 config. Idempotent + memoized; safe to call
 * on every loop turn.
 */
export async function ensureWorker(
  workerName: string = FR_AGENT_DEFAULT,
): Promise<void> {
  const key = cacheKey(workerName);
  if (verified.has(key)) return;

  const config = buildConfig(workerName);

  try {
    await getWorker(workerName);
    // Already exists — PUT so the system prompt / model / schema are
    // refreshed if they drifted. updateWorker maps to PUT /workers/{name}
    // which "reflects on next call" per WM contract.
    await updateWorker(workerName, config);
  } catch (err) {
    if (isNotFound(err)) {
      await createWorker(config);
    } else {
      // Don't poison the cache on transient errors; let the next turn retry.
      throw err;
    }
  }

  verified.add(key);
}

function isNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'UPSTREAM_NOT_FOUND') return true;
  const status = (err as { upstreamStatus?: unknown }).upstreamStatus;
  return status === 404;
}
