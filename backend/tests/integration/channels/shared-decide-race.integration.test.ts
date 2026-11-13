// Owner ruling 2026-10-31: every channel is equivalent, and every chat seat (Telegram,
// Teams, the `approvals.decide` action) decides through ONE function,
// `decideAsChannelSender` → `recordApprovalDecision` — the web PUT's own path, with its
// atomic row lock. This races a CHAT seat (the exact call Telegram's button / reply makes:
// channel 'telegram', the resolved sender in the approval's tenant) against an mcp agent
// decision, released at the same wall-clock instant in two separate processes. Exactly one
// `approval_decisions` row; the loser is refused `already_decided`. Since Teams
// makes the same call, this covers it too.
import { afterEach, describe, expect } from 'bun:test';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';

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
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '7b94f1c6-2794-4d22-8b66-00000000d15e';
const STAFF = '7b94f1c6-2794-4d22-8b66-0000000005af';
const REQUESTER = '7b94f1c6-2794-4d22-8b66-000000000aaa';
const JOB = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const BACKEND = join(import.meta.dir, '../../..');
const { itDb } = createDbSuite('shared-decide-race');

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

/**
 * A fresh child that loads every module, prints READY, then waits for `GO <epoch-ms>` on
 * stdin and fires at that instant. The parent sends GO only after BOTH children are READY,
 * so a slow module load can never serialise the race (real clock, no fake timers).
 */
function raceChild(body: string) {
  const script = `
    const { registerAllActions } = await import('./src/agui/register-all-actions');
    const { dispatchInbound } = await import('./src/channels');
    const { setIntentResolver } = await import('./src/agent-core');
    const { HeuristicIntentResolver } = await import('./src/agent-core/resolver');
    const { CommandGrammarIntentResolver } = await import('./src/domain/engagement/command-grammar');
    const { decideAsChannelSender } = await import('./src/agui/actions/approvals-decide');
    setIntentResolver(new CommandGrammarIntentResolver(new HeuristicIntentResolver()));
    await registerAllActions();
    console.log('READY');
    let startAt = 0;
    for await (const line of console) {
      if (line.startsWith('GO ')) { startAt = Number(line.slice(3)); break; }
    }
    const wait = startAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    ${body}
    process.exit(0);
  `;
  const p = Bun.spawn(['bun', '-e', script], {
    cwd: BACKEND,
    env: { ...process.env, CHANNEL_IDENTITY_RESOLVER: 'keycloak', AUTH_BYPASS: 'true' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let out = '';
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => (markReady = r));
  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout) {
      out += decoder.decode(chunk);
      if (out.includes('READY')) markReady();
    }
  })();
  const done = (async () => {
    const err = await new Response(p.stderr).text();
    await Promise.all([stdoutDone, p.exited]);
    markReady();
    expect(out + err, out + err).toContain('RESULT ');
    return out + err;
  })();
  return { ready, go: (at: number) => { p.stdin.write(`GO ${at}\n`); p.stdin.flush(); }, done };
}
const resultOf = (out: string) =>
  JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice('RESULT '.length)) as { ok: boolean; code?: string };

describe('first answer wins on the shared decide path: a Telegram decision and an agent decision', () => {
  itDb('exactly one decision row; the loser gets already_decided', async () => {
    await db.insert(workspaces).values({ id: TENANT, name: 'shared decide race' }).onConflictDoNothing();
    await db.insert(userRoles).values({ user_id: STAFF, tenant_id: TENANT, role: 'workspace-member' });
    const agent = await createAgentMember({ tenantId: TENANT, product: 'agent', role: 'workspace-admin', createdBy: STAFF });
    const [row] = await db
      .insert(approvals)
      .values({ tenant_id: TENANT, status: 'pending', kind: 'generic', description: 'decide me', requester_id: REQUESTER })
      .returning({ id: approvals.id });
    const approvalId = row!.id;
    await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: approvalId, user_id: STAFF, role: 'approver' });

    const telegram = raceChild(`
      try {
        await decideAsChannelSender(
          { channel: 'telegram', userId: ${JSON.stringify(STAFF)}, tenantId: ${JSON.stringify(TENANT)} },
          { approvalId: ${JSON.stringify(approvalId)}, decision: 'approve', comment: 'telegram says yes' },
        );
        console.log('RESULT ' + JSON.stringify({ ok: true }));
      } catch (e) {
        console.log('RESULT ' + JSON.stringify({ ok: false, code: e?.code ?? String(e) }));
      }
    `);
    const mcp = raceChild(`
      const res = await dispatchInbound({
        channel: 'mcp', userId: '', address: ${JSON.stringify(agent.address)},
        text: ${JSON.stringify(`approve ${approvalId} agent says yes`)}, correlationId: 'race-shared',
        threadId: ${JSON.stringify(agent.address)}, raw: {}, jobId: ${JSON.stringify(JOB)},
      });
      const b = await res.json();
      console.log('RESULT ' + JSON.stringify({ ok: b.status === 'result', code: b.code, status: b.status }));
    `);
    // Both children have loaded every module; release them at one shared instant.
    await Promise.all([telegram.ready, mcp.ready]);
    const at = Date.now() + 500;
    telegram.go(at);
    mcp.go(at);
    const [tgOut, mcpOut] = await Promise.all([telegram.done, mcp.done]);
    const results = [resultOf(tgOut), resultOf(mcpOut)];
    const ctx = `telegram: ${tgOut}\n\nmcp: ${mcpOut}`;

    expect(results.filter((r) => r.ok), ctx).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.code, ctx).toBe('already_decided');
    const [status] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId));
    expect(status?.status, ctx).toBe('approved');
    const decisions = await db.select().from(approvalDecisions).where(eq(approvalDecisions.approval_id, approvalId));
    expect(decisions, ctx).toHaveLength(1);
  }, 60_000);
});
