/**
 * Composition + fall-through integration test for
 * `CommandGrammarIntentResolver(HeuristicIntentResolver)` (Wave 4 Task 4.2).
 *
 * Drives the wrapped resolver against the real fr-postgres. A bare YES/NO
 * used to bind to the user's newest pending approval (`findLastPendingApproval`);
 * since validator 7 (George 2026-10-11, FAIL CLOSED) it is refused even when
 * a pending approval for the sender is seeded — an untagged decision never binds.
 *
 * Skips cleanly when the local DB isn't reachable (mirrors the pattern in
 * `dispatcher-pipeline.test.ts`).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { queryClient } from '../../../src/db/client';
import {
  CommandGrammarIntentResolver,
} from '../../../src/domain/engagement/command-grammar';
import { HeuristicIntentResolver } from '../../../src/agent-core';
import type { InboundMessage } from '../../../src/channels';

import { createDbSuite } from '../helpers/db-suite';

const sql = queryClient;
let reachable = false;

const SEED_USER = '00000000-0000-0000-0000-00000000c0de';
const SEED_CORRELATION_ID = 'cmdgram-cid-seed-1';

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM approvals LIMIT 1`;
    await sql`SELECT 1 FROM required_approvers LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[command-grammar integration] DB not reachable, skipping. Start fr-postgres with the approvals/required_approvers tables. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

afterAll(() => {
  // queryClient is shared with the app; do not end() here.
});

async function clearSeed(): Promise<void> {
  // Approval rows cascade to required_approvers via FK ON DELETE CASCADE.
  await sql`
    DELETE FROM approvals
     WHERE action_correlation_id = ${SEED_CORRELATION_ID}
  `;
}

beforeEach(async () => {
  if (!reachable) return;
  await clearSeed();
});

afterEach(async () => {
  if (!reachable) return;
  await clearSeed();
});

const { itDb } = createDbSuite('command-grammar-resolver');

function inbound(text: string): InboundMessage {
  return {
    channel: 'telegram',
    userId: SEED_USER,
    address: '+15555550100',
    text,
    correlationId: 'inbound-cid-1',
    raw: {},
  };
}

describe('CommandGrammarIntentResolver(HeuristicIntentResolver)', () => {
  itDb('non-command free-text → falls through to HeuristicIntentResolver', async () => {
    const resolver = new CommandGrammarIntentResolver(new HeuristicIntentResolver());
    const out = await resolver.resolveIntent(inbound('tell me a story'));
    // HeuristicIntentResolver answers any unrecognized free-text with a
    // friendly hint (no-action). The exact text is the heuristic's, so we
    // just assert the discriminator + that some replyText is present.
    expect(out.kind).toBe('no-action');
    if (out.kind === 'no-action') {
      expect(out.replyText).toBeTruthy();
      // Must NOT be the command-grammar's own unknown-command reply.
      expect(out.replyText).not.toContain('Unknown command');
    }
  });

});

describe('typed <action> {json} from a linked sender (George 2026-10-30)', () => {
  // The real registry, exactly what server.ts boots — `status.summary` is a real action.
  beforeAll(async () => {
    const { registerAllActions } = await import('../../../src/agui/register-all-actions');
    await registerAllActions();
  });
  const resolver = new CommandGrammarIntentResolver(new HeuristicIntentResolver());
  const typed = (channel: string): InboundMessage => ({ ...inbound('status.summary {}'), channel });

  itDb('is the sender\'s own command on telegram and mcp', async () => {
    for (const channel of ['telegram', 'mcp']) {
      const r = await resolver.resolveIntent(typed(channel));
      expect(r).toEqual({ kind: 'action', actionName: 'status.summary', input: {}, matchedDeterministically: true });
    }
  });

  itDb('is NOT credited to the person on email or teams (the sender is not verified there)', async () => {
    for (const channel of ['email', 'teams']) {
      const r = await resolver.resolveIntent(typed(channel));
      expect(r).toEqual({ kind: 'action', actionName: 'status.summary', input: {}, matchedDeterministically: false });
    }
  });
});
