/**
 * Safe command grammar (Wave 4 Task 4.2).
 *
 * Adds a deterministic verb grammar in front of `agentCore.resolveIntent` so
 * Telegram/Teams/email free-text inputs that look like simple commands
 * (`APPROVE <cid>`, `STATUS`, `HELP`, ...) get mapped to AG-UI action
 * invocations BEFORE any heuristic/LLM path runs. Anything that doesn't
 * match falls through to the wrapped resolver, so the heuristic path
 * stays intact for power users.
 *
 * `CommandGrammarIntentResolver` wraps another `IntentResolver`. Compose
 * with `HeuristicIntentResolver` and install via `setIntentResolver(...)`
 * at server boot — see `src/server.ts`.
 */
import type { IntentResolver, IntentResolution } from '../../agent-core/types';
import type { InboundMessage } from '../../channels';
import { parseDirectInvocation } from '../../agent-core/resolver';
import { senderVerifiedByChannel } from '../../lib/action-decision-identity';
import { conveyorIsConfigured } from '../../lib/conveyor-configured-gate';
import {
  channelTenantRefusalText,
  resolveChannelTenant,
} from '../../capabilities/principal';
import { withRequestContext } from '../../integrations/_lib/context';
import { startableProjectTypes } from '../../services/catalogue/tenant-catalogue';

export type Command =
  | { kind: 'invoke'; action: string; input: Record<string, unknown> }
  | { kind: 'unknown'; raw: string }
  /** fr recognised the verb and REFUSES to act on it; `replyText` says why. */
  | { kind: 'refused'; replyText: string; code: string };

const VERB_RE = /^\/?(approve|reject|status|help|comment|card|start)\b/i;

/** fr-agui SPEC §6.4: the reply when this instance has no conveyor wiring (nothing parks). */
export const START_CONVEYOR_NOT_CONFIGURED_REPLY =
  'conveyor_not_configured: projects cannot be created on this instance';

/** The id an `approve|reject <id>` names: a full UUID or a hex prefix of ≥ 8 characters. */
const APPROVAL_ID_TOKEN_RE = /^[0-9a-f][0-9a-f-]{7,35}$/i;

/**
 * True when `text` is the explicit `approve|reject <approval id> [comment…]`
 * command — the decision NAMES its target by id (a full UUID or a ≥ 8-char hex
 * prefix), so no seat has to infer which approval is meant. Channel-generic:
 * every channel's reply to a parked write tells the sender to send exactly this
 * form, and a channel route that owns other decision grammars (Telegram's
 * webhook) uses this to hand it to the dispatcher's `approvals.decide`.
 */
export function isExplicitApprovalIdCommand(text: string): boolean {
  const m = text.trim().match(/^\/?(approve|reject)\s+(\S+)/i);
  return Boolean(m && APPROVAL_ID_TOKEN_RE.test(m[2] ?? ''));
}

export function approvalIdRefusedReply(token: string): string {
  return (
    `Nothing was recorded: "${token}" is not an approval id. Send the id from the approval message ` +
    '(at least its first 8 characters), e.g. "approve 1a2b3c4d".'
  );
}

/**
 * Where `start` reads the sender's startable types (SPEC §6.4) — the tenant is
 * derived from MEMBERSHIP (capabilities/principal.ts), never from the text.
 */
export type StartableTypesLookup =
  | { kind: 'ok'; tenantId: string; tenantName: string | null; types: string[] }
  | { kind: 'refused'; replyText: string; code: string };

async function startableTypesFor(userId: string, channel: string): Promise<StartableTypesLookup> {
  const r = await resolveChannelTenant(userId);
  if (r.kind !== 'ok') {
    const code = r.kind === 'none' ? 'not_a_member' : r.kind === 'mismatch' ? 'tenant_mismatch' : 'tenant_ambiguous';
    return { kind: 'refused', replyText: channelTenantRefusalText(r), code };
  }
  try {
    const types = await withRequestContext(
      { correlationId: `start:${userId}`, initiator: 'human', channel, tenantId: r.tenant.id, userId },
      () => startableProjectTypes(r.tenant.id),
    );
    return { kind: 'ok', tenantId: r.tenant.id, tenantName: r.tenant.name, types: types.map((t) => t.name) };
  } catch (err) {
    // e.g. 409 catalogue_not_initialised — quoted, nothing parks.
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'refused', replyText: `Nothing was created: ${msg}`, code: 'project_types_unavailable' };
  }
}

function allowedTypesReply(types: string[], prefix: string): string {
  return types.length > 0
    ? `${prefix} Send "start <type> <title>" with one of: ${types.join(', ')}.`
    : `${prefix} This workspace has no project type that can start a project.`;
}

/** `start <project_type> <title…>` (SPEC §6.4). */
async function parseStart(userId: string, channel: string, rest: string): Promise<Command> {
  if (!conveyorIsConfigured()) {
    return { kind: 'refused', replyText: START_CONVEYOR_NOT_CONFIGURED_REPLY, code: 'conveyor_not_configured' };
  }
  const lookup = await startableTypesFor(userId, channel);
  if (lookup.kind === 'refused') return lookup;
  const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
  const candidate = m?.[1] ?? rest;
  const title = (m?.[2] ?? '').trim();
  if (!rest || !lookup.types.includes(candidate)) {
    return {
      kind: 'refused',
      replyText: allowedTypesReply(
        lookup.types,
        rest
          ? `Nothing was created: "${candidate}" is not a project type this workspace can start.`
          : 'Nothing was created: name the project type and title.',
      ),
      code: 'unknown_project_type',
    };
  }
  if (!title) {
    return {
      kind: 'refused',
      replyText: `Nothing was created: give the project a title, e.g. "start ${candidate} My project".`,
      code: 'title_required',
    };
  }
  return { kind: 'invoke', action: 'projects.create', input: { project_type: candidate, title } };
}

export async function tryParseCommand(args: {
  userId: string;
  channel: string;
  text: string;
}): Promise<Command | null> {
  const t = args.text.trim();
  if (!t) return null;
  const m = t.match(VERB_RE);
  if (!m) {
    // /-prefix without a known verb → structured unknown so caller can reply HELP
    if (t.startsWith('/')) return { kind: 'unknown', raw: t };
    return null;
  }
  const verb = (m[1] ?? '').toLowerCase();
  const rest = t.slice(m[0].length).trim();
  switch (verb) {
    case 'approve':
    case 'reject': {
      if (!rest) return null; // bare verb without target → fall through to wrapped resolver
      // fr-agui SPEC §5.2 (P): `approve|reject <approvalId> [comment…]` → DecideInput.
      // The first token is the id; the rest of the line is the comment.
      const sp = rest.search(/\s/);
      const idToken = sp < 0 ? rest : rest.slice(0, sp);
      const comment = sp < 0 ? '' : rest.slice(sp).trim();
      if (!APPROVAL_ID_TOKEN_RE.test(idToken)) {
        return { kind: 'refused', replyText: approvalIdRefusedReply(idToken), code: 'approval_id_invalid' };
      }
      return {
        kind: 'invoke',
        action: 'approvals.decide',
        input: {
          approvalId: idToken.toLowerCase(),
          decision: verb === 'approve' ? 'approve' : 'reject',
          ...(comment ? { comment } : {}),
        },
      };
    }
    case 'start':
      return parseStart(args.userId, args.channel, rest);
    case 'status':
      return rest
        ? {
            kind: 'invoke',
            action: 'status.summary',
            input: { scope: 'project', slug: rest },
          }
        : {
            kind: 'invoke',
            action: 'status.summary',
            input: { scope: 'mine' },
          };
    case 'help':
      return { kind: 'invoke', action: 'help.list_commands', input: {} };
    case 'comment': {
      // Format: "comment <card-id>: <text>". Planka 2.x uses Snowflake numeric
      // ids; older deployments used UUIDs. Accept either via the loose
      // alphanumeric/hyphen/underscore shape — upstream Planka rejects
      // genuinely bad ids. The action's zod input schema enforces the same.
      const colonIdx = rest.indexOf(':');
      if (colonIdx <= 0) return { kind: 'unknown', raw: t };
      const cardId = rest.slice(0, colonIdx).trim();
      const text = rest.slice(colonIdx + 1).trim();
      const cardIdRe = /^[a-zA-Z0-9_-]{1,64}$/;
      if (!cardIdRe.test(cardId) || text.length === 0) return { kind: 'unknown', raw: t };
      return {
        kind: 'invoke',
        action: 'kanban.add_comment',
        input: { card_id: cardId, text },
      };
    }
    case 'card': {
      // Format: "card <project_ref>: <title>"
      const colonIdx = rest.indexOf(':');
      if (colonIdx <= 0) return { kind: 'unknown', raw: t };
      const projectRef = rest.slice(0, colonIdx).trim();
      const title = rest.slice(colonIdx + 1).trim();
      if (projectRef.length === 0 || title.length === 0) return { kind: 'unknown', raw: t };
      return {
        kind: 'invoke',
        action: 'kanban.create_card',
        input: { project_ref: projectRef, title },
      };
    }
  }
  return null;
}

export class CommandGrammarIntentResolver implements IntentResolver {
  constructor(private readonly inner: IntentResolver) {}

  async resolveIntent(msg: InboundMessage): Promise<IntentResolution> {
    if (!msg.userId) return this.inner.resolveIntent(msg);
    // `<action> {json}` typed by the linked sender: the channel is just another
    // interface to operate fr as that person (George 2026-10-30), so it is theirs
    // exactly as the fixed verbs are — matched here, before any model, and BEFORE
    // the verbs (else `status.summary {}` reads as `status <slug>`). ONLY where the
    // sender itself is verified (Telegram, mcp): on email (spoofable From)
    // or Teams' body identity it stays `false`, so a write parks.
    const direct = parseDirectInvocation(msg.text ?? '');
    if (direct?.kind === 'no-action') return direct;
    if (direct) return { ...direct, matchedDeterministically: senderVerifiedByChannel(msg.channel) };
    const cmd = await tryParseCommand({
      userId: msg.userId,
      channel: msg.channel,
      text: msg.text,
    });
    if (cmd?.kind === 'invoke') {
      // One of the two producers that set `true` (the other: a typed
      // `<action> {json}`, above). `tryParseCommand` matched a fixed
      // verb (`card`, `comment`, `status`, `help`, `approve`, ...)
      // against the caller's raw inbound text — fr made this decision itself
      // from the bytes it received, with no model in the loop. Fall-through
      // below returns the inner resolver's own value untouched.
      return {
        kind: 'action',
        actionName: cmd.action,
        input: cmd.input,
        matchedDeterministically: true,
      };
    }
    if (cmd?.kind === 'refused') {
      return { kind: 'no-action', replyText: cmd.replyText, code: cmd.code };
    }
    if (cmd?.kind === 'unknown') {
      return {
        kind: 'no-action',
        replyText:
          'Unknown command. Send "help" to list available commands.',
        code: 'unknown_command',
      };
    }
    return this.inner.resolveIntent(msg);
  }
}
