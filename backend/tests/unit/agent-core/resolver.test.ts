import { test, expect, describe } from 'bun:test';

import { HeuristicIntentResolver } from '../../../src/agent-core/resolver';
import { listActions } from '../../../src/agui/registry';
// Importing the kag tool routes registers the real kag.* actions (import-time).
import '../../../src/routes/tools/kag';
import type { InboundMessage } from '../../../src/channels';

function inbound(text: string): InboundMessage {
  return {
    channel: 'test',
    userId: 'u1',
    address: 'a1',
    text,
    correlationId: 'cid-1',
    raw: {},
  };
}

const resolver = new HeuristicIntentResolver();


describe('HeuristicIntentResolver', () => {
  test('direct invocation with JSON body', async () => {
    const r = await resolver.resolveIntent(
      inbound('kag.scrape_url {"url":"https://x"}'),
    );
    expect(r.kind).toBe('action');
    if (r.kind === 'action') {
      expect(r.actionName).toBe('kag.scrape_url');
      expect(r.input).toEqual({ url: 'https://x' });
    }
  });

  test('direct invocation with no JSON → empty input', async () => {
    const r = await resolver.resolveIntent(inbound('kag.list_sessions'));
    expect(r.kind).toBe('action');
    if (r.kind === 'action') {
      expect(r.actionName).toBe('kag.list_sessions');
      expect(r.input).toEqual({});
    }
  });

  test('unknown action → no-action with help text', async () => {
    const r = await resolver.resolveIntent(inbound('foo.bar'));
    expect(r.kind).toBe('no-action');
    if (r.kind === 'no-action') {
      expect(r.replyText).toContain('Unknown action');
      expect(r.replyText).toContain('foo.bar');
    }
  });

  test.each(['help', '?', 'commands', '', '   '])(
    'help token %p → no-action listing actions',
    async (text) => {
      const r = await resolver.resolveIntent(inbound(text));
      expect(r.kind).toBe('no-action');
      if (r.kind === 'no-action') {
        // The registry is process-wide, so which actions precede kag.* depends on
        // which test files loaded first. Assert the listing itself: it starts with
        // the FIRST registered action (in registration order) and is capped.
        const first = listActions()[0]!;
        expect(r.replyText?.startsWith(`Available actions:\n- ${first.name}: `)).toBe(true);
        expect(r.replyText?.length ?? 0).toBeLessThanOrEqual(1500);
        expect(listActions().some((a) => a.name === 'kag.scrape_url')).toBe(true);
      }
    },
  );

  test('garbage text → no-action with hint', async () => {
    const r = await resolver.resolveIntent(inbound('hi there'));
    expect(r.kind).toBe('no-action');
    if (r.kind === 'no-action') {
      expect(r.replyText).toContain('didn\'t recognize');
    }
  });

  test('malformed JSON for known action → no-action with parse error', async () => {
    const r = await resolver.resolveIntent(inbound('kag.scrape_url {nope}'));
    expect(r.kind).toBe('no-action');
    if (r.kind === 'no-action') {
      expect(r.replyText).toContain('failed to parse');
    }
  });
});
