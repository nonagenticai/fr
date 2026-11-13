// ⭐ THE SAME REPLY DECIDES THE SAME WAY ON EVERY CHANNEL (owner ruling 2026-10-31).
//
// "any channel for any project any card-type always works exactly the same, if via any
// channel the approval message for choices [1,2,3] can be '1' as response, that applies to
// all channels and all cases!"
//
// Each case is one approval, delivered to one sender on one channel, answered with the SAME
// text through that channel's REAL inbound entry point (`handleTelegramIncoming` for
// Telegram, `channelDispatcher.handleWebhook` for every other channel — its own parser, the
// shared `runChannelTurn`, the shared decide path) against a real Postgres. The persisted
// outcome must be identical on all five channels.
//
// Each dispatch runs in a child `bun` process: CHANNEL_DISPATCH_ENABLED and the mcp secret are
// read at module load. The child registers each channel's REAL inbound adapter, as server.ts
// does. No outbound transport is configured, so the replies go nowhere; the outcome is read
// from the database.
import { afterAll, describe, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';

import {
  approvalDecisions,
  approvals,
  db,
  engagementDeliveries,
  queryClient,
  requiredApprovers,
  userChannelPrefs,
  userRoles,
  workspaces,
} from '../../../src/db/client';
import { processDecision, runChannelTurn } from '../../../src/domain/engagement/channel-reply';
import { createDbSuite } from '../helpers/db-suite';
import { withDestructiveHatch } from '../../helpers/destructive-hatch';

const BACKEND = join(import.meta.dir, '../../..');
const TENANT = '3d0c5e2a-1b7f-4c11-9a8e-00000000e17a';
const REQUESTER = '3d0c5e2a-1b7f-4c11-9a8e-000000000aaa';
const PROPOSAL = 'Use the fixtures repo';
const MCP_SECRET = 'reply-same-on-every-channel-secret';

const CHANNELS = ['telegram', 'mcp', 'email', 'teams', 'inapp'] as const;
type Channel = (typeof CHANNELS)[number];

const { itDb } = createDbSuite('reply-same-on-every-channel');

const seededUsers: string[] = [];

afterAll(async () => {
  // fr#1283's guard refuses a DELETE that empties a table, which these can on a fresh database,
  // so the cleanup runs in one transaction with the hatch armed (tests/helpers/destructive-hatch.ts).
  const users = seededUsers.length ? seededUsers : ['00000000-0000-0000-0000-000000000000'];
  await withDestructiveHatch(queryClient, async (tx) => {
    await tx`DELETE FROM engagement_deliveries WHERE recipient_user_id::text = ANY(${users}::text[])
             OR engagement_id IN (SELECT id::text FROM approvals WHERE tenant_id = ${TENANT})`;
    await tx`DELETE FROM approval_decisions WHERE approval_id IN (SELECT id FROM approvals WHERE tenant_id = ${TENANT})`;
    await tx`DELETE FROM required_approvers WHERE tenant_id = ${TENANT}`;
    await tx`DELETE FROM approvals WHERE tenant_id = ${TENANT}`;
    await tx`DELETE FROM user_channel_prefs WHERE user_id::text = ANY(${users}::text[])`;
    await tx`DELETE FROM inapp_messages WHERE user_id::text = ANY(${users}::text[])`;
    await tx`DELETE FROM user_roles WHERE tenant_id = ${TENANT}`;
    await tx`DELETE FROM workspaces WHERE id = ${TENANT}`;
  });
});

let counter = 0;
/** A fresh decider + the address they use on `channel` (fresh per case, so no history interferes). */
function newSender(channel: Channel): { userId: string; address: string } {
  counter += 1;
  const n = String(counter).padStart(12, '0');
  const userId = `3d0c5e2a-1b7f-4c11-9a8e-${n}`;
  const address = {
    telegram: String(8100000000 + counter),
    mcp: `care-bus:${TENANT}:staff-${counter}`,
    email: `staff-${counter}@reply-every-channel.test`,
    teams: `aad-${counter}`,
    inapp: userId,
  }[channel];
  return { userId, address };
}

/** A pending approval delivered (sent, an hour ago) to the sender on `channel`. */
async function seed(
  channel: Channel,
  metadata: Record<string, unknown>,
  opts: {
    /** Also record a notice of this type about something else, sent here after this ask. */
    noticeAfterAsk?: 'approval-closed' | 'licence_notification';
    /** An ACTION approval (fr executes a write as its decider). */
    action?: boolean;
  } = {},
): Promise<{ approvalId: string; address: string; userId: string }> {
  const { userId, address } = newSender(channel);
  seededUsers.push(userId);
  await db.insert(workspaces).values({ id: TENANT, name: 'reply same on every channel' }).onConflictDoNothing();
  await db.insert(userRoles).values({ user_id: userId, tenant_id: TENANT, role: 'workspace-member' });
  await db.insert(userChannelPrefs).values({ user_id: userId, channel, address, tenant_id: TENANT, enabled: true });
  const [row] = await db
    .insert(approvals)
    .values({
      tenant_id: TENANT, status: 'pending', kind: 'generic', description: 'Which repo?',
      requester_id: REQUESTER, source: 'n8n', metadata,
      ...(opts.action ? { action_id: crypto.randomUUID() } : {}),
    })
    .returning({ id: approvals.id });
  const approvalId = row!.id;
  await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: approvalId, user_id: userId, role: 'approver' });
  const hourAgo = new Date(Date.now() - 3_600_000);
  await db.insert(engagementDeliveries).values({
    engagement_id: approvalId,
    engagement_type: 'approval',
    channel,
    recipient_user_id: userId,
    recipient_address: address,
    status: 'sent',
    // Telegram records where it posted and when (its own clock); every other transport records
    // nothing and is located by the address it was sent to.
    metadata_json: channel === 'telegram'
      ? { chatId: address, messageThreadId: null, date: Math.floor(hourAgo.getTime() / 1000) }
      : null,
    created_at: hourAgo,
  });
  if (opts.noticeAfterAsk) {
    const halfHourAgo = new Date(Date.now() - 1_800_000);
    await db.insert(engagementDeliveries).values({
      engagement_id: crypto.randomUUID(),
      engagement_type: opts.noticeAfterAsk,
      channel,
      recipient_user_id: userId,
      recipient_address: address,
      status: 'sent',
      metadata_json: channel === 'telegram'
        ? { chatId: address, messageThreadId: null, date: Math.floor(halfHourAgo.getTime() / 1000) }
        : null,
      created_at: halfHourAgo,
    });
  }
  return { approvalId, address, userId };
}

/** Send `text` from `address` through `channel`'s real inbound entry point, in a child process. */
function send(channel: Channel, address: string, text: string): { status: number | null; out: string } {
  const script = `
    const { channelDispatcher, registerChannel } = await import('./src/channels');
    const { handleTelegramIncoming } = await import('./src/routes/telegram-webhook');
    const { signMcpBody } = await import('./src/channels/mcp-signature');
    const real = {
      telegram: (await import('./src/channels/telegram')).telegramChannel,
      mcp: (await import('./src/channels/mcp')).mcpChannel,
      email: (await import('./src/channels/email')).emailChannel,
      teams: (await import('./src/channels/teams')).teamsChannel,
      inapp: (await import('./src/channels/inapp')).inappChannel,
    };
    for (const c of Object.values(real)) registerChannel(c);
    const channel = ${JSON.stringify(channel)};
    const address = ${JSON.stringify(address)};
    const text = ${JSON.stringify(text)};
    const json = (body, headers = {}) => new Request('http://test/in', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
    });
    let res;
    if (channel === 'telegram') {
      res = await handleTelegramIncoming(json(JSON.stringify({
        update_id: 1,
        message: {
          message_id: 10, from: { id: Number(address), is_bot: false, first_name: 'S' },
          chat: { id: Number(address), type: 'private' }, date: Math.floor(Date.now() / 1000), text,
        },
      })));
    } else if (channel === 'mcp') {
      const body = JSON.stringify({ address, text, correlation_id: 'c-1' });
      res = await channelDispatcher.handleWebhook('mcp', json(body, signMcpBody(${JSON.stringify(MCP_SECRET)}, body)));
    } else if (channel === 'email') {
      const form = new URLSearchParams({ from: address, subject: 'Re: Approval required', 'stripped-text': text });
      res = await channelDispatcher.handleWebhook('email', new Request('http://test/in', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      }));
    } else if (channel === 'teams') {
      res = await channelDispatcher.handleWebhook('teams', json(JSON.stringify({
        text, from: { aadObjectId: address }, conversation: { id: 'conv-1' },
      })));
    } else {
      // The route hands the dispatcher the web session's tenant (routes/inapp-messages.ts).
      res = await channelDispatcher.handleWebhook('inapp', json(JSON.stringify({ userId: address, text })), {
        sessionTenant: { id: ${JSON.stringify(TENANT)} },
      });
    }
    console.log('RESULT ' + JSON.stringify({ status: res?.status ?? null, body: res ? await res.json() : null }));
    process.exit(0);
  `;
  const p = Bun.spawnSync(['bun', '-e', script], {
    cwd: BACKEND,
    env: {
      ...process.env,
      CHANNEL_DISPATCH_ENABLED: 'true',
      AUTH_BYPASS: 'true',
      FR_MCP_CHANNEL_SECRET: MCP_SECRET,
      TELEGRAM_BOT_TOKEN: '',
    },
  });
  const out = p.stdout.toString() + p.stderr.toString();
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  expect(line, out).toBeDefined();
  const parsed = JSON.parse(line!.slice('RESULT '.length)) as { status: number | null };
  return { status: parsed.status, out };
}

async function outcome(approvalId: string) {
  const [row] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId));
  const decisions = await db
    .select({ decision: approvalDecisions.decision, comment: approvalDecisions.comment })
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approval_id, approvalId));
  return { status: row!.status, decisions };
}

const QUESTION = { deblock_action: 'QUESTION', open_questions: ['Which repo?'] };

const CASES: Array<{
  name: string;
  metadata: Record<string, unknown>;
  noticeAfterAsk?: 'approval-closed' | 'licence_notification';
  action?: boolean;
  /** Channels whose SENDER identity the action-approval allowlist does not verify. */
  refusedOn?: Channel[];
  /** The reply, given the approval's id (only a reply that names it uses it). */
  text: string | ((approvalId: string) => string);
  expected: { status: string; decisions: Array<{ decision: string; comment?: string | null }> };
}> = [
  { name: '`1` approves', metadata: {}, text: '1', expected: { status: 'approved', decisions: [{ decision: 'approved' }] } },
  { name: '`approve` approves', metadata: {}, text: 'approve', expected: { status: 'approved', decisions: [{ decision: 'approved' }] } },
  {
    // fr's own close notice of another approval is approval traffic, not a steering message.
    name: '`1` still approves after a close notice of another approval',
    metadata: {},
    noticeAfterAsk: 'approval-closed',
    text: '1',
    expected: { status: 'approved', decisions: [{ decision: 'approved' }] },
  },
  {
    // ⛔ validator 7: a newer non-approval message (a licence notification saying "send 1") may
    // not steer an untagged reply onto the approval.
    name: '`1` after a newer licence notification records nothing',
    metadata: {},
    noticeAfterAsk: 'licence_notification',
    text: '1',
    expected: { status: 'pending', decisions: [] },
  },
  {
    // An ACTION approval executes as its decider, so only a seat whose sender identity is
    // verified may decide it (lib/action-decision-identity.ts): Telegram (bot secret), mcp
    // (HMAC relay), in-app (Keycloak session). Email's From and a Teams free-text sender are
    // body fields — refused there, as `approve <id>` always was.
    name: '`1` on an ACTION approval approves wherever the sender is verified',
    metadata: {},
    action: true,
    refusedOn: ['email', 'teams'],
    text: '1',
    expected: { status: 'approved', decisions: [{ decision: 'approved' }] },
  },
  {
    // An unaddressed `2 <words>` is ordinary chat ("2 people are coming"), so a reject names
    // its approval: the `#<short id>` every notification shows.
    name: '`2 #<id> too risky` rejects with the reason',
    metadata: {},
    text: (id) => `2 #${id.slice(0, 8)} too risky`,
    expected: { status: 'rejected', decisions: [{ decision: 'rejected', comment: 'too risky' }] },
  },
  {
    name: 'a bare `1` on a row with a proposed answer records the proposal',
    metadata: { ...QUESTION, proposed_answer: PROPOSAL },
    text: '1',
    expected: { status: 'approved', decisions: [{ decision: 'approved', comment: PROPOSAL }] },
  },
  {
    name: '`approve: <answer>` on a row that asks records the answer',
    metadata: QUESTION,
    text: 'approve: use the main repo',
    expected: { status: 'approved', decisions: [{ decision: 'approved', comment: 'use the main repo' }] },
  },
  {
    name: 'a bare `1` on a row that owes an answer records nothing',
    metadata: QUESTION,
    text: '1',
    expected: { status: 'pending', decisions: [] },
  },
];

describe('the same reply records the same outcome on every channel', () => {
  for (const c of CASES) {
    itDb(c.name, async () => {
      const results: Record<string, unknown> = {};
      for (const channel of CHANNELS) {
        const { approvalId, address } = await seed(channel, c.metadata, {
          ...(c.noticeAfterAsk ? { noticeAfterAsk: c.noticeAfterAsk } : {}),
          ...(c.action ? { action: true } : {}),
        });
        const sent = send(channel, address, typeof c.text === 'function' ? c.text(approvalId) : c.text);
        // Every channel's entry point answered (never fell through to "dispatch disabled").
        expect(sent.status, `${channel}: ${sent.out}`).toBe(200);
        const got = await outcome(approvalId);
        results[channel] = {
          status: got.status,
          decisions: got.decisions.map((d) => ({
            decision: d.decision,
            ...(c.expected.decisions[0]?.comment !== undefined ? { comment: d.comment } : {}),
          })),
        };
      }
      const want = Object.fromEntries(CHANNELS.map((ch) => [
        ch,
        c.refusedOn?.includes(ch) ? { status: 'pending', decisions: [] } : c.expected,
      ]));
      expect(results).toEqual(want);
    });
  }
});

describe('an ACTION approval on a seat that cannot verify its sender: one answer, never a menu', () => {
  // Email's From and a Teams free-text sender are body fields (lib/action-decision-identity.ts).
  // Whatever they type — grammar, free text, an #id — they are told to decide it in fr, and
  // nothing fr says there offers the `1` it would refuse.
  for (const channel of ['email', 'teams'] as const) {
    itDb(`${channel}: free text, \`1\` and \`approve #id\` all get the fr link, nothing recorded`, async () => {
      const { approvalId, address } = await seed(channel, {}, { action: true });
      const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      for (const text of ['hmm, what does this do', '1', `approve #${approvalId.slice(0, 8)}`]) {
        const said: string[] = [];
        const recorded = await processDecision(row!, address, async (t) => { said.push(t); }, text, { channel });
        expect(recorded).toBe(false);
        const reply = said.join('\n');
        expect({ text, reply }).toMatchObject({ text, reply: expect.stringContaining('Decide it in fr: ') });
        expect(reply).not.toMatch(/1 - Approve|send `1`|Reply:\n1/);
      }
      expect(await outcome(approvalId)).toEqual({ status: 'pending', decisions: [] });
    });
  }
});

describe('on a seat that cannot verify its sender, no reply offers a typed decision on an ACTION approval', () => {
  // Action approvals stay candidates (so "exactly one could have been meant" keeps its meaning
  // and nothing else gets decided by elimination), but every message that would offer a typed
  // form for one names fr instead. The turn runs with exactly what channels/index.ts
  // runReplyTurn passes for a 1:1 channel.
  const OFFER = /`1 #|`1` approves|`1` \(approve\)|send your decision again|Reply 1|1 - Approve|`2 #/;
  const turn = async (channel: 'email' | 'teams', address: string, text: string) => {
    const said: string[] = [];
    const now = Date.now();
    await runChannelTurn({
      channel, senderAddress: address, chatKey: address, threadKey: '', isDirectChat: true,
      isReplyToOther: false, isEdited: false, messageDate: Math.floor(now / 1000), receivedAtMs: now,
      text, say: async (t) => { said.push(t); },
    });
    return said.join('\n');
  };
  /** Another pending approval delivered to the same sender, newer than the seeded one. */
  const another = async (channel: 'email' | 'teams', seeded: { userId: string; address: string }, action: boolean) => {
    const [row] = await db
      .insert(approvals)
      .values({
        tenant_id: TENANT, status: 'pending', kind: 'generic', description: 'Second one?', requester_id: REQUESTER,
        ...(action ? { action_id: crypto.randomUUID() } : {}),
      })
      .returning({ id: approvals.id });
    await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: row!.id, user_id: seeded.userId, role: 'approver' });
    await db.insert(engagementDeliveries).values({
      engagement_id: row!.id, engagement_type: 'approval', channel, recipient_user_id: seeded.userId,
      recipient_address: seeded.address, status: 'sent', created_at: new Date(Date.now() - 3_000_000),
    });
    return row!.id;
  };

  for (const channel of ['email', 'teams'] as const) {
    itDb(`${channel}: one pending action approval after another closed recently — \`1\` offers fr, not \`1 #id\``, async () => {
      const a = await seed(channel, {}, { action: true });
      // Another approval delivered to the same sender, decided an hour ago by someone else.
      const closed = await another(channel, a, false);
      await db.update(approvals).set({ status: 'approved', completed_at: new Date(Date.now() - 3_600_000) }).where(eq(approvals.id, closed));
      const reply = await turn(channel, a.address, '1');
      expect(reply).not.toMatch(OFFER);
      expect(reply).toContain('in fr');
      expect(await outcome(a.approvalId)).toEqual({ status: 'pending', decisions: [] });
    });

    itDb(`${channel}: free text laya cannot read — fr link for an action, the ordinary answer otherwise`, async () => {
      // No laya licence in tests: laya is asked and is unavailable — the "declined" arm.
      const act = await seed(channel, {}, { action: true });
      const actReply = await turn(channel, act.address, 'hello there');
      expect(actReply).not.toMatch(OFFER);
      expect(actReply).toContain('Decide it in fr: ');
      // A non-action approval CAN be decided by a typed reply on this seat: no action wording.
      const plain = await seed(channel, {});
      const plainReply = await turn(channel, plain.address, 'hello there');
      expect(plainReply).not.toContain('agent action');
      expect(plainReply).toContain('send your decision again');
      expect(await outcome(act.approvalId)).toEqual({ status: 'pending', decisions: [] });
      expect(await outcome(plain.approvalId)).toEqual({ status: 'pending', decisions: [] });
    });

    itDb(`${channel}: one action approval — \`1\`, \`1 #id\`, \`3\` all answer with fr, nothing recorded`, async () => {
      const a = await seed(channel, {}, { action: true });
      for (const text of ['1', `1 #${a.approvalId.slice(0, 8)}`, '3', '3 what does it do']) {
        const reply = await turn(channel, a.address, text);
        expect({ text, reply }).toMatchObject({ text, reply: expect.stringContaining('in fr') });
        expect({ text, reply }).not.toMatchObject({ reply: expect.stringMatching(OFFER) });
      }
      expect(await outcome(a.approvalId)).toEqual({ status: 'pending', decisions: [] });
    });

    itDb(`${channel}: a non-action and a newer action approval — \`1\` decides NEITHER, and offers no typed form`, async () => {
      const a = await seed(channel, {});
      const b = await another(channel, a, true);
      const reply = await turn(channel, a.address, '1');
      expect(reply).not.toMatch(OFFER);
      expect(reply).toContain('in fr');
      expect(await outcome(a.approvalId)).toEqual({ status: 'pending', decisions: [] });
      expect(await outcome(b)).toEqual({ status: 'pending', decisions: [] });
    });

    itDb(`${channel}: two action approvals — \`1\` offers no typed form`, async () => {
      const a = await seed(channel, {}, { action: true });
      const b = await another(channel, a, true);
      const reply = await turn(channel, a.address, '1');
      expect(reply).not.toMatch(OFFER);
      expect(reply).toContain('in fr');
      expect(await outcome(a.approvalId)).toEqual({ status: 'pending', decisions: [] });
      expect(await outcome(b)).toEqual({ status: 'pending', decisions: [] });
    });
  }
});
