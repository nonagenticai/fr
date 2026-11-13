/**
 * Server-side PROVENANCE of an `ActionContext` — which fr code built it.
 *
 * Membership is by object identity (WeakSet), so it cannot be asserted by any
 * request body, header or spread copy: only the server code named below calls
 * the `mark*` functions, on the context it hands to `invokeAction` /
 * `buildToolCatalog`. Env-free and import-free on purpose: `agui/rbac.ts` reads
 * it, and `rbac.ts` cannot import `registry.ts` (which imports `rbac.ts`).
 *
 *   CHANNEL — `channels/index.ts dispatchInbound` (Telegram / Teams /…).
 *     A confirm-card write parks for `approve <id>` ONLY on such a context
 *     (fr-agui SPEC §5.2 P, §6.5).
 *   AGENT TOKEN — the two fr-agent-token surfaces, `/api/agent/chat`
 *     (routes/agent.ts) and `/api/agui/invoke` (routes/agui.ts): the AG-UI rail.
 *     fr-agui SPEC §13 P1c (OQ-17 = c): on such a context the agent may use ONLY
 *     the project agent's set (a project-bound thread) or the doorway set
 *     (unbound), never anything else (agui/agent-surface.ts).
 *   CONFIRMED CARD — `POST /api/capabilities/:id/invoke` (routes/capability-invoke.ts):
 *     the HUMAN's own click on a confirm card for an agent-native write
 *     (SPEC §5.2 W). The registry lets a confirm-card write proceed to its
 *     approval policy only from such a context (or a channel).
 */
import type { ActionContext } from './types';

const channelDispatchedContexts = new WeakSet<ActionContext>();
const agentTokenContexts = new WeakSet<ActionContext>();
const confirmedCardContexts = new WeakSet<ActionContext>();

/** Server-side only: mark `ctx` as built by the channel dispatcher. Returns `ctx`. */
export function markChannelDispatched<C extends ActionContext>(ctx: C): C {
  channelDispatchedContexts.add(ctx);
  return ctx;
}

/** True when `ctx` was built by the channel dispatcher (never from request input). */
export function isChannelDispatched(ctx: ActionContext): boolean {
  return channelDispatchedContexts.has(ctx);
}

/** Server-side only: mark `ctx` as built by an fr-agent-token route (the AG-UI rail). */
export function markAgentTokenContext<C extends ActionContext>(ctx: C): C {
  agentTokenContexts.add(ctx);
  return ctx;
}

/** True when `ctx` was built by `/api/agent/chat` or `/api/agui/invoke`. */
export function isAgentTokenContext(ctx: ActionContext): boolean {
  return agentTokenContexts.has(ctx);
}

/** Server-side only: mark `ctx` as a human's confirm-card invocation (`POST /api/capabilities/:id/invoke`). */
export function markConfirmedCard<C extends ActionContext>(ctx: C): C {
  confirmedCardContexts.add(ctx);
  return ctx;
}

/** True when `ctx` was built by the confirm-card invoke route for a human's click. */
export function isConfirmedCard(ctx: ActionContext): boolean {
  return confirmedCardContexts.has(ctx);
}
