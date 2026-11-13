/**
 * fr-agui SPEC §10.5 (P1c) — `capability_audit`: the trail of agent proposals
 * and of the human confirmations that executed them. Append-only.
 *
 *   recordProposal          — the agent loop shaped a confirm-card proposal
 *                             (status 'proposed', initiator 'agent').
 *   recordProposalExecution — a route request carried `X-Agent-Proposal-Id`
 *                             (server.ts): the human's click on that card
 *                             (status 'executed:<http status>', initiator
 *                             'human-via-agent'). capability / thread / project
 *                             are taken from THAT USER's own 'proposed' row, so a
 *                             header naming someone else's proposal (or none)
 *                             is recorded as `unmatched`, never attributed.
 *
 * This is the backend READER of `X-Agent-Proposal-Id` (P1b audit carry: the
 * header had none). It never blocks a request: an audit-write failure is logged
 * and swallowed, because the route — not the audit — is the authority.
 *
 * `input_hash` = sha256 of the REDACTED input (capabilities/redact.ts).
 */
import { createHash } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { redact } from '../capabilities/redact';

const AUDIT_STATUS_PROPOSED = 'proposed';
const PROPOSAL_HEADER = 'X-Agent-Proposal-Id';
const PROPOSAL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

interface AuditRow {
  capability_id: string | null;
  proposal_id: string;
  thread_id: string | null;
  user_id: string;
  tenant_id: string | null;
  project_id: string | null;
  initiator: string;
  input_hash: string | null;
  status: string;
  correlation_id: string | null;
}

/** Stable JSON (sorted keys) so equal inputs hash equal. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function hashRedactedInput(input: unknown, secretPaths?: readonly string[]): string {
  return createHash('sha256').update(stable(redact(input, { secretPaths }))).digest('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined): string | null => (v && UUID_RE.test(v) ? v : null);

/** The db is late-bound (dynamic import) so importers stay env-free. */
async function findProposedRow(proposalId: string, userId: string): Promise<AuditRow | null> {
  const { db, capabilityAudit } = await import('../db/client');
  const [row] = await db
    .select()
    .from(capabilityAudit)
    .where(
      and(
        eq(capabilityAudit.proposal_id, proposalId),
        eq(capabilityAudit.user_id, userId),
        eq(capabilityAudit.status, AUDIT_STATUS_PROPOSED),
      ),
    )
    .orderBy(desc(capabilityAudit.ts))
    .limit(1);
  return (row as AuditRow | undefined) ?? null;
}

async function safeInsert(row: AuditRow): Promise<void> {
  try {
    // Late-bound db so importers stay env-free.
    const { db, capabilityAudit } = await import('../db/client');
    await db.insert(capabilityAudit).values(row);
  } catch (err) {
    console.error('[capability-audit] write failed (request unaffected):', err instanceof Error ? err.message : err);
  }
}

export async function recordProposal(p: {
  capabilityId: string;
  proposalId: string;
  threadId: string | null;
  userId: string;
  tenantId: string | null | undefined;
  projectId: string | null;
  input: unknown;
  secretPaths?: readonly string[];
  correlationId: string;
}): Promise<void> {
  await safeInsert({
    capability_id: p.capabilityId,
    proposal_id: p.proposalId,
    thread_id: p.threadId,
    user_id: p.userId,
    tenant_id: uuidOrNull(p.tenantId ?? null),
    project_id: uuidOrNull(p.projectId),
    initiator: 'agent',
    input_hash: hashRedactedInput(p.input, p.secretPaths),
    status: AUDIT_STATUS_PROPOSED,
    correlation_id: p.correlationId,
  });
}

/** The proposal id a request names, or null (absent / not id-shaped). */
export function proposalIdOf(req: Request): string | null {
  const v = req.headers.get(PROPOSAL_HEADER)?.trim();
  return v && PROPOSAL_ID_RE.test(v) ? v : null;
}

/**
 * A request carrying `X-Agent-Proposal-Id` finished with `httpStatus`. `who` is
 * the request frame's verified identity; with no user nothing is recorded (an
 * unauthenticated request confirmed nothing).
 */
export async function recordProposalExecution(
  req: Request,
  httpStatus: number,
  who: { userId?: string | null; tenantId?: string | null; correlationId?: string | null },
): Promise<void> {
  const proposalId = proposalIdOf(req);
  if (!proposalId || !who.userId) return;
  let proposed: AuditRow | null = null;
  try {
    proposed = await findProposedRow(proposalId, who.userId);
  } catch (err) {
    console.error('[capability-audit] proposal lookup failed:', err instanceof Error ? err.message : err);
  }
  await safeInsert({
    capability_id: proposed?.capability_id ?? null,
    proposal_id: proposalId,
    thread_id: proposed?.thread_id ?? null,
    user_id: who.userId,
    tenant_id: uuidOrNull(who.tenantId ?? null) ?? proposed?.tenant_id ?? null,
    project_id: proposed?.project_id ?? null,
    initiator: 'human-via-agent',
    input_hash: null,
    status: proposed ? `executed:${httpStatus}` : `unmatched:${httpStatus}`,
    correlation_id: who.correlationId ?? null,
  });
}
