/**
 * Default heuristic IntentResolver.
 *
 * Recognizes:
 *   - direct invocation: `<tool>.<verb_noun> [{json}]`
 *   - help: empty / `help` / `?` / `commands` → list available actions
 *   - everything else: friendly hint
 *
 * No LLM in this path. A future LLM-backed resolver can replace it via
 * `setIntentResolver` in `./index`.
 */
import type { InboundMessage } from '../channels';
import { getAction, listActions } from '../agui/registry';
import type { IntentResolution, IntentResolver } from './types';

const DIRECT_INVOCATION_RE =
  /^([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*(\{[\s\S]*\})?\s*$/;

const HELP_TOKENS = new Set(['', 'help', '?', 'commands']);

function helpText(): string {
  const all = listActions();
  if (all.length === 0) {
    return 'No actions are currently registered.';
  }
  const lines = all.map((a) => `- ${a.name}: ${a.description}`);
  let body = `Available actions:\n${lines.join('\n')}`;
  // Keep replies friendly across chat transports — cap length.
  const MAX = 1500;
  if (body.length > MAX) {
    body = body.slice(0, MAX - 3) + '...';
  }
  return body;
}

function unknownActionReply(name: string): string {
  const known = listActions()
    .map((a) => a.name)
    .slice(0, 20)
    .join(', ');
  return `Unknown action: ${name}. Try "help" to list available commands.${
    known ? ` Known: ${known}.` : ''
  }`;
}

/**
 * `<tool>.<verb_noun> [{json}]` typed by the sender. Null when the text is not
 * that shape; a `no-action` reply when the action is unknown or the JSON is bad.
 */
export function parseDirectInvocation(
  text: string,
): { kind: 'action'; actionName: string; input: unknown } | { kind: 'no-action'; replyText: string; code: string } | null {
  const m = DIRECT_INVOCATION_RE.exec(text.trim());
  if (!m) return null;
  const actionName = m[1]!;
  const jsonPart = m[2];
  if (!getAction(actionName)) {
    return { kind: 'no-action', replyText: unknownActionReply(actionName), code: 'unknown_action' };
  }
  let input: unknown = {};
  if (jsonPart) {
    try {
      input = JSON.parse(jsonPart);
    } catch (err) {
      return {
        kind: 'no-action',
        replyText: `Action "${actionName}" found, but the JSON input failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
        code: 'invalid_input',
      };
    }
  }
  return { kind: 'action', actionName, input };
}

export class HeuristicIntentResolver implements IntentResolver {
  async resolveIntent(msg: InboundMessage): Promise<IntentResolution> {
    const text = (msg.text ?? '').trim();
    const lower = text.toLowerCase();

    if (HELP_TOKENS.has(lower)) {
      return { kind: 'no-action', replyText: helpText() };
    }

    const direct = parseDirectInvocation(text);
    if (direct?.kind === 'no-action') return direct;
    if (direct) {
      // `false` here: this resolver also serves an unidentified sender. A linked
      // sender's typed invocation is matched first, by the command grammar
      // (domain/engagement/command-grammar.ts), which credits it to them.
      return { ...direct, matchedDeterministically: false };
    }

    return {
      kind: 'no-action',
      replyText:
        'I didn\'t recognize that as an action. Try "help" to list available commands, ' +
        'or "<tool>.<verb_noun> {...json}" to invoke directly.',
      code: 'unknown_command',
    };
  }
}

export const defaultIntentResolver = new HeuristicIntentResolver();
