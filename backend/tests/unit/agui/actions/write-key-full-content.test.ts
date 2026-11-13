// D3 — agui write idempotency keys must cover the FULL content.
//
// kanban.add_comment, kanban.create_card and channels.send_message used to key
// on `text/title/body.slice(0, 64)`, so two DIFFERENT writes sharing a 64-char
// prefix produced the same key and the second was answered from the first's
// cached result: a lost write. The keys now embed sha256(full content).
//
// Pure: the real action's idempotencyKey differs for same-prefix inputs.

import { describe, expect, test } from 'bun:test';

import { addCommentAction } from '../../../../src/agui/actions/kanban-comment';
import { createCardAction } from '../../../../src/agui/actions/kanban-card';
import { channelsSendAction } from '../../../../src/agui/actions/channels';
import type { AgentCallableAction } from '../../../../src/agui/types';

const PREFIX = 'x'.repeat(64);
const A = `${PREFIX} first ending`;
const B = `${PREFIX} second ending`;

const CASES: Array<{
  action: AgentCallableAction<any, any>;
  mk: (content: string) => Record<string, unknown>;
}> = [
  {
    action: addCommentAction as AgentCallableAction<any, any>,
    mk: (text) => ({ card_id: '1234567890123456789', text }),
  },
  {
    action: createCardAction as AgentCallableAction<any, any>,
    mk: (title) => ({ project_ref: 'proj', title }),
  },
  {
    action: channelsSendAction as AgentCallableAction<any, any>,
    mk: (body) => ({ channel_id: 'email', body }),
  },
];

describe('agui write keys hash the full content (pure)', () => {
  for (const c of CASES) {
    test(`${c.action.name}: same 64-char prefix -> different keys`, async () => {
      const ka = await c.action.idempotencyKey((c.action.input as any).parse(c.mk(A)));
      const kb = await c.action.idempotencyKey((c.action.input as any).parse(c.mk(B)));
      expect(ka).not.toBe(kb);
      // Same content -> same key (still deterministic).
      const ka2 = await c.action.idempotencyKey((c.action.input as any).parse(c.mk(A)));
      expect(ka2).toBe(ka);
      // The raw content is not embedded in the key.
      expect(ka.includes(PREFIX)).toBe(false);
    });
  }
});
