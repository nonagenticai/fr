/**
 * agent-core: intent + identity resolution seams.
 *
 * The dispatcher in `src/channels/index.ts` calls `agentCore.resolveIdentity`
 * and `agentCore.resolveIntent` to map an inbound channel message onto a
 * known user and an action invocation. Default implementations are heuristic
 * so the pipeline works without an LLM in the loop; setters allow swapping
 * in an LLM-backed resolver later (see spec
 * 2026-04-25-e7-inbound-channel-dispatch.md §"Out of scope").
 */
import type { InboundMessage } from '../channels';

/**
 * `matchedDeterministically` records HOW the intent was derived, not WHO
 * derived it and not what it is allowed to do. It is `true` only when a fixed,
 * server-side verb grammar matched the caller's raw text — i.e. fr itself
 * decided, from bytes it received, that this was a hand-typed command. It is
 * `false` for anything an LLM produced.
 *
 * ⚠️ This field must never be derived from "was a regex involved". A typed
 * `<tool>.<verb> {json}` from a LINKED sender on a sender-verified channel
 * (Telegram, mcp) is the sender's own command (`CommandGrammarIntentResolver`,
 * `true`; email/Teams `false`); the same text reaching
 * `HeuristicIntentResolver` is `false`. Each resolver states its own value
 * explicitly; nothing infers it.
 *
 * The dispatcher (`channels/index.ts`) treats this as ONE of two necessary
 * conditions for a human initiator — never as sufficient on its own. See the
 * residual-risk note there.
 */
export type IntentResolution =
  | {
      kind: 'action';
      actionName: string;
      input: unknown;
      matchedDeterministically: boolean;
    }
  /** `code`: the refusal's reason (snake_case), sent to an mcp caller (fr #1683); absent for help / chat. */
  | { kind: 'no-action'; replyText?: string; code?: string };

export interface IntentResolver {
  resolveIntent(msg: InboundMessage): Promise<IntentResolution>;
}

/**
 * Result of identity resolution. `tenantRoles` is the set of realm/client
 * roles that the dispatcher should attach to `ActionContext.tenantRoles` so
 * the E-12 RBAC default rule (`tenant-role: 'user'` for project-less
 * contexts) can succeed for legitimate agent-initiated invocations.
 *
 * Resolvers that don't have role data MUST return `[]` — the empty case
 * fails closed at `assertRbac` (the `tenant-role` check denies on
 * `roles.includes(...)` returning false), which is the correct
 * default-deny behavior.
 */
export interface IdentityResolution {
  userId: string;
  tenantRoles: string[];
  /**
   * P1-TEAM-c: EVERY fr account linked to the sender's address, when the channel can
   * link more than one (Telegram's `user_channel_prefs` reverse lookup). `userId` is
   * one of them. A decision must never be recorded — or an action run — as one of
   * several (`agui/actions/approvals-decide.ts`). Absent = exactly `userId`.
   */
  linkedAccountIds?: string[];
  /**
   * fr #1683: set ONLY for an agent product's own service member (an admin-created
   * `agent:` mcp address, domain/engagement/agent-members.ts), acting in exactly this
   * tenant within its role. Agent decisions are allowed and recorded as
   * decided_by_kind='agent'.
   */
  agentMember?: { tenantId: string; product: string };
}

export interface IdentityResolver {
  /**
   * Returns the resolved Keycloak userId + tenantRoles, or null if the
   * inbound sender cannot be mapped to a known user.
   */
  resolveIdentity(msg: InboundMessage): Promise<IdentityResolution | null>;
}
