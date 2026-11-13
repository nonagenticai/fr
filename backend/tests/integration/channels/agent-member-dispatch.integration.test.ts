// tests/integration/channels/agent-member-dispatch.integration.test.ts
//
// fr #1683 end to end through the channel dispatcher, for a REAL pending approval
// (owner rulings 2026-10-31 — the agent platform is fr's autonomous user over mcp):
//
//   * the agent member decides itself: recorded decided_by_kind='agent' with `via` =
//     {channel, agent_member_id, product, job_id}; its own parked action (naming
//     someone else) is refused APPROVER_IS_REQUESTER;
//   * option A: with `on_behalf_of` = a staff member of the agent's tenant, the
//     decision is THAT person's (decided_by_kind 'human') with the same `via`; a sub
//     that is not a member is refused, and the requester as on_behalf_of hits
//     APPROVER_IS_REQUESTER exactly as on their own seat.
//
// The production identity resolver is chosen at import time from
// CHANNEL_IDENTITY_RESOLVER, so each dispatch runs in a fresh child `bun` process with
// it set and with the command-grammar intent resolver server.ts installs. AUTH_BYPASS
// stands in for the Keycloak home-tenant read (userHomedIn) of the staff member; the
// agent member needs no Keycloak, which is what is under test.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';

import { mcpRefusalCode } from '../../../src/channels';
import { parseMcpBody } from '../../../src/channels/mcp';
import { AppError } from '../../../src/utils/errors';
import {
  agentMembers,
  approvalDecisions,
  approvals,
  db,
  requiredApprovers,
  userChannelPrefs,
  userRoles,
  workspaces,
} from '../../../src/db/client';
import { createAgentMember } from '../../../src/domain/engagement/agent-members';
import { requestActionApproval } from '../../../src/domain/engagement/action-approvals';
import type { AgentCallableAction } from '../../../src/agui/types';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '6a83e0b5-1683-4c11-9a55-00000000d15e';
const STAFF = '6a83e0b5-1683-4c11-9a55-0000000005af';
const OUTSIDER = '6a83e0b5-1683-4c11-9a55-00000000000e';
const OTHER_REQUESTER = '6a83e0b5-1683-4c11-9a55-000000000aaa';
const JOB = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BACKEND = join(import.meta.dir, '../../..');
const { itDb } = createDbSuite('agent-member-dispatch');

afterEach(async () => {
  const ids = (await db.select({ id: agentMembers.user_id }).from(agentMembers).where(eq(agentMembers.tenant_id, TENANT))).map((r) => r.id);
  await db.delete(agentMembers).where(eq(agentMembers.tenant_id, TENANT));
  await db.delete(userRoles).where(eq(userRoles.tenant_id, TENANT));
  if (ids.length) await db.delete(userChannelPrefs).where(inArray(userChannelPrefs.user_id, ids));
  const appr = (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.tenant_id, TENANT))).map((r) => r.id);
  if (appr.length) {
    await db.delete(approvalDecisions).where(inArray(approvalDecisions.approval_id, appr));
    await db.delete(requiredApprovers).where(inArray(requiredApprovers.approval_id, appr));
    await db.delete(approvals).where(inArray(approvals.id, appr));
  }
  await db.delete(workspaces).where(eq(workspaces.id, TENANT));
});

/** A pending approval in TENANT that `rostered` is named to decide. */
async function seedApproval(
  requesterId: string,
  rostered: string,
  kind: 'generic' | 'execution.ready_signoff' = 'generic',
  extraMetadata: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(approvals)
    .values({
      tenant_id: TENANT, status: 'pending', kind, description: 'decide me', requester_id: requesterId,
      // The shape of a conveyor question (sub.ask_fr, e.g. prod approval 1c44d0b5).
      ...(kind === 'execution.ready_signoff'
        ? { source: 'n8n', metadata: { ask_kind: 'question', open_questions: ['Which repo?'], ...extraMetadata } }
        : {}),
    })
    .returning({ id: approvals.id });
  await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: row!.id, user_id: rostered, role: 'approver' });
  return row!.id;
}

async function setup(
  requesterId = OTHER_REQUESTER,
  opts: {
    rosterAgent?: boolean;
    kind?: 'generic' | 'execution.ready_signoff';
    agentRole?: 'workspace-admin' | 'workspace-member';
    metadata?: Record<string, unknown>;
  } = {},
) {
  const agent = await createAgentMember({ tenantId: TENANT, product: 'agent', role: opts.agentRole ?? 'workspace-admin', createdBy: STAFF });
  await db.insert(userRoles).values({ user_id: STAFF, tenant_id: TENANT, role: 'workspace-member' });
  await db.insert(workspaces).values({ id: TENANT, name: 'agent dispatch test' }).onConflictDoNothing();
  const rostered = opts.rosterAgent ? agent.user_id : STAFF;
  return { agent, approvalId: await seedApproval(requesterId, rostered, opts.kind, opts.metadata) };
}

/** Dispatch one mcp message from `address` in a fresh process; returns its combined output. */
function dispatch(msg: { address: string; text: string; onBehalfOf?: string; jobId?: string }): string {
  const script = `
    const { registerAllActions } = await import('./src/agui/register-all-actions');
    const { dispatchInbound } = await import('./src/channels');
    const { setIntentResolver } = await import('./src/agent-core');
    const { HeuristicIntentResolver } = await import('./src/agent-core/resolver');
    const { CommandGrammarIntentResolver } = await import('./src/domain/engagement/command-grammar');
    // The grammar resolver server.ts installs (its LLM fallback is not needed for \\\`approve <id>\\\`).
    setIntentResolver(new CommandGrammarIntentResolver(new HeuristicIntentResolver()));
    await registerAllActions();
    const m = ${JSON.stringify(msg)};
    const res = await dispatchInbound({
      channel: 'mcp', userId: '', address: m.address, text: m.text, correlationId: 'job-1683-dispatch',
      threadId: m.address, raw: {},
      ...(m.onBehalfOf ? { onBehalfOf: m.onBehalfOf } : {}), ...(m.jobId ? { jobId: m.jobId } : {}),
    });
    console.log('RESULT ' + JSON.stringify({ status: res.status, body: await res.json() }));
    process.exit(0);
  `;
  const p = Bun.spawnSync(['bun', '-e', script], {
    cwd: BACKEND,
    env: { ...process.env, CHANNEL_IDENTITY_RESOLVER: 'keycloak', AUTH_BYPASS: 'true' },
  });
  const out = p.stdout.toString() + p.stderr.toString();
  expect(out, out).toContain('RESULT ');
  return out;
}

/** The dispatcher's JSON answer (`{status, code?, …}`) from a child run's output. */
function bodyOf(out: string): { status: string; code?: string; correlationId?: string } {
  const line = out.split('\n').find((l) => l.startsWith('RESULT '))!;
  return (JSON.parse(line.slice('RESULT '.length)) as { body: { status: string; code?: string; correlationId?: string } }).body;
}

async function decisionsOf(approvalId: string) {
  return db.select().from(approvalDecisions).where(eq(approvalDecisions.approval_id, approvalId));
}
async function statusOf(approvalId: string) {
  return (await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)))[0]!.status;
}

describe('the agent member decides itself (recorded as agent)', () => {
  itDb('it answers a conveyor question: decided_by_kind agent, via the agent member and job', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true, kind: 'execution.ready_signoff' });
    // An open question is answered by the decision's comment.
    const out = dispatch({ address: agent.address, text: `approve ${approvalId} Use the fixtures repo`, jobId: JOB });
    expect(await statusOf(approvalId), out).toBe('approved');
    const [d, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({ approver_id: agent.user_id, decision: 'approved', decided_by_kind: 'agent', comment: 'Use the fixtures repo' });
    expect(d!.via).toEqual({ channel: 'mcp', agent_member_id: agent.user_id, product: 'agent', job_id: JOB });
  });

  itDb('approving its own parked action is refused APPROVER_IS_REQUESTER', async () => {
    const { agent } = await setup();
    // The agent asked for a write whose policy names STAFF; the tenant has more than one member.
    const action = {
      name: 'test.agent_write', description: 'agent own write', kind: 'write',
      approval: { type: 'single-approver', approver: STAFF },
    } as unknown as AgentCallableAction;
    const pending = await requestActionApproval(action, {}, {
      userId: agent.user_id, projectId: null, correlationId: 'c', initiator: 'human', channel: 'mcp',
      tenantRoles: [], tenantId: TENANT, channelLinkedTenantId: TENANT,
    });
    const out = dispatch({ address: agent.address, text: `approve ${pending.approvalId}`, jobId: JOB });
    expect(bodyOf(out)).toMatchObject({ status: 'error', code: 'approver_is_requester' });
    // fr's own refusal line for the APPROVER_IS_REQUESTER guard (routes/approvals.ts).
    expect(out).toContain(`requester ${agent.user_id} is also the decider`);
    expect(await statusOf(pending.approvalId)).toBe('pending');
    expect(await decisionsOf(pending.approvalId)).toHaveLength(0);
  });
});

describe('metadata.proposed_answer: a bare approve accepts the proposal (routes/approvals.ts recordApprovalDecision)', () => {
  const question = { deblock_action: 'QUESTION', proposed_answer: 'Use the fixtures repo' };

  itDb('a bare `approve <id>` records the proposed answer as the decision comment', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true, kind: 'execution.ready_signoff', metadata: question });
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}`, jobId: JOB });
    expect(await statusOf(approvalId), out).toBe('approved');
    const [d, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({ decision: 'approved', comment: 'Use the fixtures repo' });
  });

  itDb('a typed answer wins over the proposal', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true, kind: 'execution.ready_signoff', metadata: question });
    const out = dispatch({ address: agent.address, text: `approve ${approvalId} Use the main repo`, jobId: JOB });
    expect(await statusOf(approvalId), out).toBe('approved');
    expect((await decisionsOf(approvalId))[0]).toMatchObject({ comment: 'Use the main repo' });
  });

  itDb('CONTROL: the same bare approve without a proposal is refused, nothing recorded', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, {
      rosterAgent: true, kind: 'execution.ready_signoff', metadata: { deblock_action: 'QUESTION' },
    });
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}`, jobId: JOB });
    expect(await statusOf(approvalId), out).toBe('pending');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
  });

  // ⛔ QUESTION only: a fix assertion owes a statement of what was FIXED, never a proposal.
  itDb('a non-QUESTION row (INFRASTRUCTURE) ignores proposed_answer: the bare approve is refused, nothing recorded', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, {
      rosterAgent: true, kind: 'execution.ready_signoff', metadata: { deblock_action: 'INFRASTRUCTURE', proposed_answer: 'Use the fixtures repo' },
    });
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}`, jobId: JOB });
    // Refused by the fix-assertion answer guard, not by anything else on the row.
    expect(out).toContain('State what was fixed');
    expect(await statusOf(approvalId), out).toBe('pending');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
  });
});

describe('option A: a staff member answers through the agent member', () => {
  itDb('a member with decide rights: recorded as a human decision of that member, via the agent and job', async () => {
    const { agent, approvalId } = await setup();
    dispatch({ address: agent.address, text: `approve ${approvalId}`, onBehalfOf: STAFF, jobId: JOB });
    expect(await statusOf(approvalId)).toBe('approved');
    const [d, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({ approver_id: STAFF, decision: 'approved', decided_by_kind: 'human' });
    expect(d!.via).toEqual({ channel: 'mcp', agent_member_id: agent.user_id, product: 'agent', job_id: JOB });
  });

  itDb('a sub that is not a member of the agent tenant is refused', async () => {
    const { agent, approvalId } = await setup();
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}`, onBehalfOf: OUTSIDER, jobId: JOB });
    expect(bodyOf(out)).toEqual({ status: 'no-action', code: 'not_a_member', correlationId: 'job-1683-dispatch' });
    expect(await statusOf(approvalId)).toBe('pending');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
  });

  itDb('the requester as on_behalf_of is refused (requester_is_decider, APPROVER_IS_REQUESTER)', async () => {
    const { agent, approvalId } = await setup(STAFF);
    // A second party on the roster and in the tenant, so none of the self-decision exemptions applies.
    await db.insert(userRoles).values({ user_id: OTHER_REQUESTER, tenant_id: TENANT, role: 'workspace-member' });
    await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: approvalId, user_id: OTHER_REQUESTER, role: 'approver' });
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}`, onBehalfOf: STAFF });
    expect(bodyOf(out)).toMatchObject({ status: 'error', code: 'approver_is_requester' });
    // fr's own refusal line for the APPROVER_IS_REQUESTER guard (routes/approvals.ts).
    expect(out).toContain(`requester ${STAFF} is also the decider`);
    expect(await statusOf(approvalId)).toBe('pending');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
  });
});

describe('on_behalf_of is honoured only for an agent member', () => {
  itDb('a person\'s own mcp link that names on_behalf_of still decides as that person, with no via', async () => {
    const { approvalId } = await setup();
    // OTHER is a member and on the roster too, so honouring on_behalf_of would record OTHER.
    await db.insert(userRoles).values({ user_id: OTHER_REQUESTER, tenant_id: TENANT, role: 'workspace-member' });
    await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: approvalId, user_id: OTHER_REQUESTER, role: 'approver' });
    const address = 'care-bus:1683:staff';
    await db.insert(userChannelPrefs).values({ user_id: STAFF, channel: 'mcp', address, tenant_id: TENANT, enabled: true });
    try {
      dispatch({ address, text: `approve ${approvalId}`, onBehalfOf: OTHER_REQUESTER, jobId: JOB });
      const decisions = await decisionsOf(approvalId);
      expect(decisions.map((d) => d.approver_id)).toEqual([STAFF]);
      expect(decisions[0]!.via).toBeNull();
    } finally {
      await db.delete(userChannelPrefs).where(eq(userChannelPrefs.address, address));
    }
  });
});

describe('refusal codes on the mcp channel are specific (the agent escalates by them)', () => {
  itDb('approval_not_found: an id no approval of the tenant has', async () => {
    const { agent } = await setup();
    const out = dispatch({ address: agent.address, text: 'approve 6a83e0b5-1683-4c11-9a55-00000000dead' });
    expect(bodyOf(out)).toMatchObject({ status: 'error', code: 'approval_not_found' });
  });

  itDb('already_decided: an approval that is no longer pending', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true });
    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, approvalId));
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}` });
    expect(bodyOf(out)).toMatchObject({ status: 'error', code: 'already_decided' });
  });

  itDb('no web-only refusal: a RECLASSIFY row is decided over mcp by the same rules as the web', async () => {
    // Owner ruling 2026-10-31: every channel is equivalent. The seat no longer refuses the row
    // ("decide in fr"); the decision route's own rule applies — an approve without
    // new_card_type is refused (nothing recorded), a reject is recorded.
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true });
    await db.update(approvals).set({ metadata: { deblock_action: 'RECLASSIFY' } }).where(eq(approvals.id, approvalId));
    const approveOut = dispatch({ address: agent.address, text: `approve ${approvalId}` });
    expect(bodyOf(approveOut).status, approveOut).toBe('error');
    expect(bodyOf(approveOut).code, approveOut).not.toBe('decide_in_fr');
    expect(await statusOf(approvalId)).toBe('pending');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
    const rejectOut = dispatch({ address: agent.address, text: `reject ${approvalId} keep the current type` });
    expect(await statusOf(approvalId), rejectOut).toBe('rejected');
    expect(await decisionsOf(approvalId)).toHaveLength(1);
  });

  itDb('structured fields reach the route over mcp: a COVERAGE row decided per criterion', async () => {
    // Owner ruling 2026-10-31: every channel is equivalent — `approvals.decide {json}` carries the
    // web's structured fields. An unknown criterion id is refused by the ROUTE's own rule (only
    // possible if the field arrived); a valid one is recorded with its per-criterion verdict.
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true });
    await db.update(approvals).set({
      metadata: { deblock_action: 'COVERAGE', coverage_request: { criteria: [{ criterion_id: 'AC-1' }, { criterion_id: 'AC-2' }] } },
    }).where(eq(approvals.id, approvalId));
    const decide = (ids: string[]) =>
      dispatch({
        address: agent.address,
        text: `approvals.decide ${JSON.stringify({ approvalId, decision: 'approve', rejected_criterion_ids: ids })}`,
      });
    const unknown = decide(['AC-9']);
    expect(await statusOf(approvalId), unknown).toBe('pending');
    expect(unknown).toContain('rejected_criterion');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
    const ok = decide(['AC-2']);
    expect(await statusOf(approvalId), ok).toBe('approved');
    const [row] = await db.select({ metadata: approvals.metadata }).from(approvals).where(eq(approvals.id, approvalId));
    expect((row!.metadata as { coverage_decision?: { rejected_criterion_ids?: string[] } }).coverage_decision?.rejected_criterion_ids, ok)
      .toEqual(['AC-2']);
  });

  itDb('no_decide_rights: a tenant-admin-only kind decided by a workspace-member agent', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER, { rosterAgent: true, agentRole: 'workspace-member' });
    await db.update(approvals).set({ kind: 'asset.promotion' }).where(eq(approvals.id, approvalId));
    const out = dispatch({ address: agent.address, text: `approve ${approvalId}` });
    expect(bodyOf(out)).toMatchObject({ status: 'error', code: 'no_decide_rights' });
    expect(await statusOf(approvalId)).toBe('pending');
  });

  itDb('no-action refusals carry their reason; help has no code', async () => {
    const { agent } = await setup();
    const cases: Array<[string, string]> = [
      ['approve 12', 'approval_id_invalid'],
      ['nosuch.action {}', 'unknown_action'],
      ['approvals.decide {"approvalId": }', 'invalid_input'],
      ['please do the thing', 'unknown_command'],
    ];
    for (const [text, code] of cases) {
      const body = bodyOf(dispatch({ address: agent.address, text }));
      expect({ text, status: body.status, code: body.code }).toEqual({ text, status: 'no-action', code });
    }
    // `help` answers (an action result) with no refusal code.
    const help = bodyOf(dispatch({ address: agent.address, text: 'help' }));
    expect(help.code).toBeUndefined();
  });

  test('mcpRefusalCode: snake_case [a-z_] ≤ 64, aliases, and forbidden / error only without a code', () => {
    expect(mcpRefusalCode(new AppError(403, 'x').withCode('APPROVER_IS_REQUESTER'))).toBe('approver_is_requester');
    expect(mcpRefusalCode(new AppError(403, 'x').withCode('channel_sender_not_tenant_member'))).toBe('not_a_member');
    expect(mcpRefusalCode(new AppError(400, 'x').withCode('g12-decision.required 2'))).toBe('g_decision_required');
    expect(mcpRefusalCode(new AppError(400, 'x').withCode('a'.repeat(80)))).toHaveLength(64);
    expect(mcpRefusalCode(new AppError(403, 'x'))).toBe('forbidden');
    expect(mcpRefusalCode(new Error('x'))).toBe('error');
  });
});

describe('parseMcpBody reads job and on_behalf_of (nonagenticai_mcp_server #64)', () => {
  test('top-level siblings of address; a malformed value rejects the body', () => {
    const base = { address: 'agent:t', text: 'help', correlation_id: 'c' };
    expect(parseMcpBody(JSON.stringify({ ...base, job: JOB, on_behalf_of: STAFF }))).toMatchObject({ jobId: JOB, onBehalfOf: STAFF });
    const bare = parseMcpBody(JSON.stringify(base));
    expect(bare?.jobId).toBeUndefined();
    expect(bare?.onBehalfOf).toBeUndefined();
    expect(parseMcpBody(JSON.stringify({ ...base, job: 'not-a-uuid' }))).toBeNull();
    expect(parseMcpBody(JSON.stringify({ ...base, on_behalf_of: '' }))).toBeNull();
    expect(parseMcpBody(JSON.stringify({ ...base, on_behalf_of: 'x'.repeat(257) }))).toBeNull();
  });
});

// Owner direction 2026-10-31: approvals multicast to every configured channel, so a person
// on the web and the agent over mcp answering at the same moment is the normal case. The
// decision is atomic (routes/approvals.ts locks the approval row FOR UPDATE around the
// insert, quorum and completing update): exactly one wins, the other is refused
// already_decided with nothing written.
describe('first answer wins: a web decision and an agent decision at the same moment', () => {
  /** Run `body` in a fresh child once the wall clock reaches `startAt` (both children race). */
  async function raceChild(body: string, startAt: number): Promise<string> {
    const script = `
      const { registerAllActions } = await import('./src/agui/register-all-actions');
      const { dispatchInbound } = await import('./src/channels');
      const { setIntentResolver } = await import('./src/agent-core');
      const { HeuristicIntentResolver } = await import('./src/agent-core/resolver');
      const { CommandGrammarIntentResolver } = await import('./src/domain/engagement/command-grammar');
      const { recordApprovalDecision } = await import('./src/routes/approvals');
      const { channelAuthUser } = await import('./src/capabilities/principal');
      setIntentResolver(new CommandGrammarIntentResolver(new HeuristicIntentResolver()));
      await registerAllActions();
      const wait = ${startAt} - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      ${body}
      process.exit(0);
    `;
    const p = Bun.spawn(['bun', '-e', script], {
      cwd: BACKEND,
      env: { ...process.env, CHANNEL_IDENTITY_RESOLVER: 'keycloak', AUTH_BYPASS: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    expect(out + err, out + err).toContain('RESULT ');
    return out + err;
  }
  const resultOf = (out: string) =>
    JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice('RESULT '.length)) as { ok: boolean; code?: string };

  itDb('exactly one decision row; the loser gets already_decided', async () => {
    const { agent, approvalId } = await setup(OTHER_REQUESTER);
    // Both children load their modules first, then fire at the same instant.
    const startAt = Date.now() + 8_000;
    const web = raceChild(`
      try {
        const user = await channelAuthUser(${JSON.stringify(STAFF)}, ${JSON.stringify(TENANT)});
        const res = await recordApprovalDecision(user, ${JSON.stringify(approvalId)},
          async () => ({ status: 'approved', comment: 'web says yes' }), new Headers(),
          { channel: 'web', evidence: { keycloakSession: true } });
        console.log('RESULT ' + JSON.stringify({ ok: res.status < 400 }));
      } catch (e) {
        console.log('RESULT ' + JSON.stringify({ ok: false, code: e?.code ?? String(e) }));
      }
    `, startAt);
    const mcp = raceChild(`
      const res = await dispatchInbound({
        channel: 'mcp', userId: '', address: ${JSON.stringify(agent.address)},
        text: ${JSON.stringify(`approve ${approvalId} agent says yes`)}, correlationId: 'race-1683',
        threadId: ${JSON.stringify(agent.address)}, raw: {}, jobId: ${JSON.stringify(JOB)},
      });
      const b = await res.json();
      console.log('RESULT ' + JSON.stringify({ ok: b.status === 'result', code: b.code, status: b.status }));
    `, startAt);
    const [webOut, mcpOut] = await Promise.all([web, mcp]);
    const results = [resultOf(webOut), resultOf(mcpOut)];
    const ctx = `web: ${webOut}\n\nmcp: ${mcpOut}`;

    expect(results.filter((r) => r.ok), ctx).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.code, ctx).toBe('already_decided');
    expect(await statusOf(approvalId), ctx).toBe('approved');
    expect(await decisionsOf(approvalId), ctx).toHaveLength(1);
  }, 60_000);
});

// ── THE SAME RULES WHEN THE REPLY IS READ BY THE SHARED REPLY FLOW ────────────────────────
// A tagged `1` reaches `runChannelTurn` from `channelDispatcher.handleWebhook` (the real mcp
// entry point, with a signed body) before the dispatcher ever sees it. `on_behalf_of` must be
// resolved there exactly as the dispatcher resolves it: a member of the AGENT's workspace, and
// only that workspace's approvals. A tag binds by id alone, so another tenant's approval must be
// refused even when on_behalf_of names one of that tenant's members.
const OTHER_TENANT = '6a83e0b5-1683-4c11-9a55-00000000b0b0';
const OTHER_ADMIN = '6a83e0b5-1683-4c11-9a55-0000000000b1';
const MCP_SECRET = 'agent-member-dispatch-secret';

function viaWebhook(
  msg: { address: string; text: string; onBehalfOf?: string; jobId?: string },
  /** false ⇒ the real Keycloak read runs (CI's KEYCLOAK_URL is unresolvable: a genuine fault). */
  authBypass = true,
): string {
  const script = `
    const { channelDispatcher, registerChannel } = await import('./src/channels');
    const { mcpChannel } = await import('./src/channels/mcp');
    const { signMcpBody } = await import('./src/channels/mcp-signature');
    const { registerAllActions } = await import('./src/agui/register-all-actions');
    const { setIntentResolver } = await import('./src/agent-core');
    const { HeuristicIntentResolver } = await import('./src/agent-core/resolver');
    const { CommandGrammarIntentResolver } = await import('./src/domain/engagement/command-grammar');
    setIntentResolver(new CommandGrammarIntentResolver(new HeuristicIntentResolver()));
    await registerAllActions();
    registerChannel(mcpChannel);
    const m = ${JSON.stringify(msg)};
    const body = JSON.stringify({
      address: m.address, text: m.text, correlation_id: 'job-1683-webhook',
      ...(m.onBehalfOf ? { on_behalf_of: m.onBehalfOf } : {}), ...(m.jobId ? { job: m.jobId } : {}),
    });
    const res = await channelDispatcher.handleWebhook('mcp', new Request('http://test/in', {
      method: 'POST', headers: { 'content-type': 'application/json', ...signMcpBody(${JSON.stringify(MCP_SECRET)}, body) }, body,
    }));
    console.log('RESULT ' + JSON.stringify({ status: res.status, body: await res.json() }));
    process.exit(0);
  `;
  const p = Bun.spawnSync(['bun', '-e', script], {
    cwd: BACKEND,
    env: {
      ...process.env, CHANNEL_IDENTITY_RESOLVER: 'keycloak', AUTH_BYPASS: authBypass ? 'true' : '',
      CHANNEL_DISPATCH_ENABLED: 'true', FR_MCP_CHANNEL_SECRET: MCP_SECRET,
    },
  });
  const out = p.stdout.toString() + p.stderr.toString();
  expect(out, out).toContain('RESULT ');
  return out;
}

describe('on_behalf_of through the shared reply flow (a tagged `1`)', () => {
  afterEach(async () => {
    const appr = (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.tenant_id, OTHER_TENANT))).map((r) => r.id);
    if (appr.length) {
      await db.delete(approvalDecisions).where(inArray(approvalDecisions.approval_id, appr));
      await db.delete(requiredApprovers).where(inArray(requiredApprovers.approval_id, appr));
      await db.delete(approvals).where(inArray(approvals.id, appr));
    }
    await db.delete(userRoles).where(eq(userRoles.tenant_id, OTHER_TENANT));
    await db.delete(workspaces).where(eq(workspaces.id, OTHER_TENANT));
  });

  itDb('a member of the agent tenant decides as that member, via the agent and job', async () => {
    const { agent, approvalId } = await setup();
    viaWebhook({ address: agent.address, text: `1 [ApprovalId:${approvalId}]`, onBehalfOf: STAFF, jobId: JOB });
    expect(await statusOf(approvalId)).toBe('approved');
    const [d, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({ approver_id: STAFF, decision: 'approved', decided_by_kind: 'human' });
    expect(d!.via).toEqual({ channel: 'mcp', agent_member_id: agent.user_id, product: 'agent', job_id: JOB });
  });

  itDb('an UNREADABLE on_behalf_of membership is refused retriably (503), never a 200', async () => {
    const { agent, approvalId } = await setup();
    // OUTSIDER has no user_roles row, so membership falls to the Keycloak home-workspace read,
    // which faults (unresolvable KEYCLOAK_URL). A fault is not an answer.
    const out = viaWebhook({ address: agent.address, text: `1 [ApprovalId:${approvalId}]`, onBehalfOf: OUTSIDER }, false);
    const line = out.split('\n').find((l) => l.startsWith('RESULT '))!;
    const res = JSON.parse(line.slice('RESULT '.length)) as { status: number; body: Record<string, unknown> };
    expect(res, out).toEqual({
      status: 503,
      body: { error: 'identity_unavailable', retryable: true, correlationId: 'job-1683-webhook' },
    });
    expect(await statusOf(approvalId)).toBe('pending');
    expect(await decisionsOf(approvalId)).toHaveLength(0);
  });

  itDb('ANOTHER tenant\'s approval, on behalf of one of ITS members, is refused not_a_member', async () => {
    const { agent } = await setup();
    await db.insert(workspaces).values({ id: OTHER_TENANT, name: 'other tenant' }).onConflictDoNothing();
    await db.insert(userRoles).values({ user_id: OTHER_ADMIN, tenant_id: OTHER_TENANT, role: 'workspace-admin' });
    const [row] = await db
      .insert(approvals)
      .values({ tenant_id: OTHER_TENANT, status: 'pending', kind: 'generic', description: 'theirs', requester_id: OTHER_REQUESTER })
      .returning({ id: approvals.id });
    await db.insert(requiredApprovers).values({ tenant_id: OTHER_TENANT, approval_id: row!.id, user_id: OTHER_ADMIN, role: 'approver' });
    const out = viaWebhook({ address: agent.address, text: `1 [ApprovalId:${row!.id}]`, onBehalfOf: OTHER_ADMIN, jobId: JOB });
    expect(bodyOf(out)).toEqual({ status: 'no-action', code: 'not_a_member', correlationId: 'job-1683-webhook' });
    expect(await statusOf(row!.id)).toBe('pending');
    expect(await decisionsOf(row!.id)).toHaveLength(0);
  });

  itDb('ANOTHER tenant\'s approval, on behalf of a member of the AGENT tenant, records nothing', async () => {
    const { agent } = await setup();
    await db.insert(workspaces).values({ id: OTHER_TENANT, name: 'other tenant' }).onConflictDoNothing();
    // STAFF is a member of both: the agent tenant (setup) and the approval's tenant.
    await db.insert(userRoles).values({ user_id: STAFF, tenant_id: OTHER_TENANT, role: 'workspace-admin' });
    const [row] = await db
      .insert(approvals)
      .values({ tenant_id: OTHER_TENANT, status: 'pending', kind: 'generic', description: 'theirs', requester_id: OTHER_REQUESTER })
      .returning({ id: approvals.id });
    await db.insert(requiredApprovers).values({ tenant_id: OTHER_TENANT, approval_id: row!.id, user_id: STAFF, role: 'approver' });
    viaWebhook({ address: agent.address, text: `1 [ApprovalId:${row!.id}]`, onBehalfOf: STAFF, jobId: JOB });
    expect(await statusOf(row!.id)).toBe('pending');
    expect(await decisionsOf(row!.id)).toHaveLength(0);
  });
});
