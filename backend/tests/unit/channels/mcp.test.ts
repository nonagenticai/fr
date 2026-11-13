// The `mcp` channel: signature, inbound parse, outbound event shape, and the
// shared command list. Pure logic + fr's own config object; no doubles.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { config } from '../../../src/config';
import { mcpChannel, parseMcpBody } from '../../../src/channels/mcp';
import {
  MAX_SKEW_SECONDS,
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
  signMcpBody,
  verifyMcpSignature,
} from '../../../src/channels/mcp-signature';
import { approvalEvent } from '../../../src/domain/engagement/adapters/mcp';
import { PROPOSED_ANSWER_NOTE } from '../../../src/domain/engagement/deblock-actions';
import { CHANNEL_COMMANDS, CHANNEL_GUIDES, helpText } from '../../../src/domain/engagement/channel-commands';
import { PUSH_CHANNELS } from '../../../src/domain/engagement/approval-routing';
import { isVerifiedActionDecisionSeat } from '../../../src/lib/action-decision-identity';
import { handleMcpIncoming } from '../../../src/routes/mcp-webhook';
import type { ApprovalWithDetails } from '../../../src/domain/engagement/notifications';
// `projects.close` registers itself at import (agui/actions/project-lifecycle.ts);
// the typed-invocation case below is the MCP channel's own text for it.
import '../../../src/agui/actions/project-lifecycle';
import { parseDirectInvocation } from '../../../src/agent-core/resolver';

const SECRET = 'test-mcp-channel-secret';
const nowSec = () => Math.floor(Date.now() / 1000);

function macAt(secret: string, ts: number, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
}

describe('mcp signature', () => {
  const body = JSON.stringify({ address: 'care-bus:t1:u1', text: 'status' });

  test('a signed body verifies', () => {
    const h = signMcpBody(SECRET, body);
    expect(verifyMcpSignature(SECRET, body, h[MCP_TIMESTAMP_HEADER]!, h[MCP_SIGNATURE_HEADER]!)).toBe(true);
  });

  test('wrong secret, tampered body, blank secret and missing headers are refused', () => {
    const h = signMcpBody(SECRET, body);
    const ts = h[MCP_TIMESTAMP_HEADER]!;
    const sig = h[MCP_SIGNATURE_HEADER]!;
    expect(verifyMcpSignature('other', body, ts, sig)).toBe(false);
    expect(verifyMcpSignature(SECRET, body + ' ', ts, sig)).toBe(false);
    expect(verifyMcpSignature('', body, ts, macAt('', Number(ts), body))).toBe(false);
    expect(verifyMcpSignature(SECRET, body, null, sig)).toBe(false);
    expect(verifyMcpSignature(SECRET, body, ts, null)).toBe(false);
    expect(verifyMcpSignature(SECRET, body, 'abc', sig)).toBe(false);
  });

  test('the timestamp is inside the MAC', () => {
    const h = signMcpBody(SECRET, body);
    const other = String(Number(h[MCP_TIMESTAMP_HEADER]!) - 1);
    expect(verifyMcpSignature(SECRET, body, other, h[MCP_SIGNATURE_HEADER]!)).toBe(false);
  });

  test('a stale or future timestamp is refused even with a valid MAC', () => {
    const stale = nowSec() - MAX_SKEW_SECONDS - 5;
    const future = nowSec() + MAX_SKEW_SECONDS + 5;
    expect(verifyMcpSignature(SECRET, body, String(stale), macAt(SECRET, stale, body))).toBe(false);
    expect(verifyMcpSignature(SECRET, body, String(future), macAt(SECRET, future, body))).toBe(false);
    const fresh = nowSec() - 10;
    expect(verifyMcpSignature(SECRET, body, String(fresh), macAt(SECRET, fresh, body))).toBe(true);
  });
});

describe('mcp inbound parse', () => {
  test('a well-formed body becomes an mcp InboundMessage replying to its address', () => {
    const msg = parseMcpBody(JSON.stringify({ address: 'care-bus:t1:u1', text: '  approve 1234abcd ok ', correlation_id: 'run-1' }));
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe('mcp');
    expect(msg!.address).toBe('care-bus:t1:u1');
    expect(msg!.threadId).toBe('care-bus:t1:u1');
    expect(msg!.text).toBe('approve 1234abcd ok');
    expect(msg!.correlationId).toBe('run-1');
    expect(msg!.userId).toBe('');
  });

  test('a missing correlation id is generated', () => {
    const msg = parseMcpBody(JSON.stringify({ address: 'a', text: 'help' }));
    expect(msg!.correlationId.length).toBeGreaterThan(0);
  });

  test('malformed bodies are refused', () => {
    for (const raw of [
      'not json',
      'null',
      JSON.stringify({ text: 'help' }),
      JSON.stringify({ address: '', text: 'help' }),
      JSON.stringify({ address: 'a', text: '   ' }),
      JSON.stringify({ address: 'a', text: 7 }),
      JSON.stringify({ address: 'x'.repeat(513), text: 'help' }),
      JSON.stringify({ address: 'a', text: 'x'.repeat(4001) }),
    ]) {
      expect(parseMcpBody(raw)).toBeNull();
    }
  });

  describe('parseWebhook verifies before parsing', () => {
    const mutableMcp = config.services.mcp as { secret: string };
    const saved = mutableMcp.secret;
    beforeAll(() => {
      mutableMcp.secret = SECRET;
    });
    afterAll(() => {
      mutableMcp.secret = saved;
    });
    const req = (body: string, headers: Record<string, string>) =>
      new Request('https://fr.test/api/webhooks/mcp/incoming', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });

    test('signed → message; unsigned or wrongly signed → null', async () => {
      const body = JSON.stringify({ address: 'care-bus:t1:u1', text: 'status' });
      expect((await mcpChannel.parseWebhook(req(body, signMcpBody(SECRET, body))))?.channel).toBe('mcp');
      expect(await mcpChannel.parseWebhook(req(body, {}))).toBeNull();
      expect(await mcpChannel.parseWebhook(req(body, signMcpBody('other', body)))).toBeNull();
    });
  });
});

describe('mcp outbound approval events', () => {
  const base: ApprovalWithDetails = {
    id: 'a1',
    project_id: 'p1',
    description: 'Merge the fix?',
    card_id: null,
    callback_path: null,
    source: null,
    metadata: { change_summary: 'one file', deblock_actions: ['retry'] },
    status: 'pending',
    expires_at: new Date('2026-11-01T00:00:00Z'),
    requester_id: null,
    kind: 'execution.question',
    tenant_id: 't1',
  };

  test('a pending approval is approval.requested with the decision schema inputs', () => {
    expect(approvalEvent(base, 'care-bus:t1:u1')).toEqual({
      type: 'approval.requested',
      address: 'care-bus:t1:u1',
      approval_id: 'a1',
      project_id: 'p1',
      tenant_id: 't1',
      correlation_id: null,
      kind: 'execution.question',
      description: 'Merge the fix?',
      change_summary: 'one file',
      impact_analysis: undefined,
      allowed_decisions: ['approved', 'rejected'],
      deblock_actions: ['retry'],
      expires_at: '2026-11-01T00:00:00.000Z',
    });
  });

  test('a proposed answer is carried, with the line saying a plain approve accepts it', () => {
    const ev = approvalEvent(
      { ...base, metadata: { ...base.metadata, deblock_action: 'QUESTION', proposed_answer: 'Use the fixtures repo' } },
      'x',
    );
    expect(ev.proposed_answer).toBe('Use the fixtures repo');
    expect(ev.proposed_answer_note).toBe(PROPOSED_ANSWER_NOTE);
    expect(PROPOSED_ANSWER_NOTE).toContain('plain approve');
    // CONTROL: no proposal → neither field.
    expect(approvalEvent(base, 'x').proposed_answer).toBeUndefined();
    expect(approvalEvent(base, 'x').proposed_answer_note).toBeUndefined();
    // CONTROL: a non-QUESTION row (a fix assertion) ignores proposed_answer entirely.
    const infra = approvalEvent(
      { ...base, metadata: { ...base.metadata, deblock_action: 'INFRASTRUCTURE', proposed_answer: 'Use the fixtures repo' } },
      'x',
    );
    expect(infra.proposed_answer).toBeUndefined();
    expect(infra.proposed_answer_note).toBeUndefined();
  });

  test('a decided approval is approval.closed with its final status', () => {
    expect(approvalEvent({ ...base, status: 'expired' }, 'x')).toEqual({
      type: 'approval.closed',
      address: 'x',
      approval_id: 'a1',
      project_id: 'p1',
      tenant_id: 't1',
      correlation_id: null,
      final_status: 'expired',
    });
  });

  test('an approval asked by an MCP-started n8n run names that run on both events', () => {
    const asked = { ...base, metadata: { ...base.metadata, mcp_run_id: 'run-7' } };
    expect(approvalEvent(asked, 'x').correlation_id).toBe('run-7');
    expect(approvalEvent({ ...asked, status: 'approved' }, 'x').correlation_id).toBe('run-7');
  });
});

describe('channel command list', () => {
  test('help text lists every command', () => {
    const text = helpText();
    for (const c of CHANNEL_COMMANDS) expect(text).toContain(c.usage);
  });

  test('every grammar verb is documented', async () => {
    const src = await Bun.file(`${import.meta.dir}/../../../src/domain/engagement/command-grammar.ts`).text();
    const m = src.match(/const VERB_RE = \/\^\\\/\?\(([^)]+)\)/);
    expect(m).not.toBeNull();
    const verbs = m![1]!.split('|').filter((v) => v !== 'yes' && v !== 'no');
    const usages = CHANNEL_COMMANDS.map((c) => c.usage.split(' ')[0]);
    for (const v of verbs) expect(usages).toContain(v);
  });

  test('mcp is a command channel', () => {
    expect(CHANNEL_GUIDES.find((g) => g.channel === 'mcp')?.commands).toBe(true);
  });
});

describe('POST /api/webhooks/mcp/incoming', () => {
  const mutableMcp = config.services.mcp as { eventsUrl: string; secret: string };
  const saved = { ...mutableMcp };
  afterAll(() => {
    Object.assign(mutableMcp, saved);
  });
  const post = (body: string, headers: Record<string, string> = {}) =>
    handleMcpIncoming(
      new Request('https://fr.test/api/webhooks/mcp/incoming', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      }),
    );
  const good = JSON.stringify({ address: 'care-bus:t1:u1', text: 'status', correlation_id: 'run-1' });

  test('401 on a missing or wrong signature; 400 on a signed bad body', async () => {
    Object.assign(mutableMcp, { secret: SECRET });
    expect((await post(good)).status).toBe(401);
    expect((await post(good, signMcpBody('other', good))).status).toBe(401);
    const bad = JSON.stringify({ address: 'a' });
    const res = await post(bad, signMcpBody(SECRET, bad));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad_request');
  });

  test('401 when the secret is unset, whatever is presented', async () => {
    Object.assign(mutableMcp, { secret: '' });
    expect((await post(good, signMcpBody('', good))).status).toBe(401);
  });

  test('a valid request reaches the dispatcher (503 retryable while CHANNEL_DISPATCH_ENABLED is off)', async () => {
    Object.assign(mutableMcp, { secret: SECRET });
    const res = await post(good, signMcpBody(SECRET, good));
    if (process.env.CHANNEL_DISPATCH_ENABLED === 'true') {
      expect(res.status).not.toBe(401);
    } else {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'channel_dispatch_disabled', retryable: true });
    }
  });

  test('mcp is on by default: a push channel, and a seat that may decide an action approval', () => {
    expect(PUSH_CHANNELS.has('mcp')).toBe(true);
    expect(isVerifiedActionDecisionSeat({ channel: 'mcp' })).toBe(true);
    expect(isVerifiedActionDecisionSeat({ channel: 'email' })).toBe(false);
  });
});

describe('typed <action> {json} is credited to the person only where the channel verifies the sender', () => {
  test('telegram and mcp verify the sender; email, teams, web do not', async () => {
    const { senderVerifiedByChannel } = await import('../../../src/lib/action-decision-identity');
    for (const c of ['telegram', 'mcp']) expect(senderVerifiedByChannel(c)).toBe(true);
    for (const c of ['email', 'teams', 'web', 'inapp', 'voice', 'unknown']) expect(senderVerifiedByChannel(c)).toBe(false);
  });
});

describe('projects.close over mcp: the typed invocation the conveyor sends', () => {
  // The MCP server's exact channel text (FR-CLOSE-CONTRACT.md): the command
  // grammar's typed branch resolves it by NAME before any model runs.
  const ID = '11111111-1111-4111-8111-111111111111';

  test('`projects.close {"id":"<uuid>"}` resolves as an action, not unknown_action', () => {
    expect(parseDirectInvocation(`projects.close {"id":"${ID}"}`)).toEqual({
      kind: 'action',
      actionName: 'projects.close',
      input: { id: ID },
    });
  });

  test('a malformed body is refused invalid_input; an unregistered action is unknown_action', () => {
    const bad = parseDirectInvocation('projects.close {"id": }');
    expect(bad?.kind).toBe('no-action');
    expect((bad as { code?: string }).code).toBe('invalid_input');
    const unknown = parseDirectInvocation('projects.nosuch {}');
    expect(unknown?.kind).toBe('no-action');
    expect((unknown as { code?: string }).code).toBe('unknown_action');
  });
});
