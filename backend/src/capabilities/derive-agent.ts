/**
 * fr-agui SPEC §3.4 (c) — the AG-UI agent action, derived from the declaration.
 *
 * The result is a plain `AgentCallableAction` registered through the EXISTING
 * `registerAction` (agui/registry.ts), so `invokeAction`, spans, idempotency,
 * `assertRbac` and `buildToolCatalog` are reused unchanged. This module does not
 * register anything itself; the agui/actions/* module that owned the
 * hand-written action registers the derived one, at the same point in
 * `registerAllActions`, so catalog order is unchanged.
 *
 * Field mapping (every field of the P0a actions is accounted for — the
 * fingerprint test pins it against the hand-written originals):
 *
 *   name                 ← id
 *   kind                 ← effect === 'read' ? 'read' : 'write'
 *   description          ← summary (+ "\n\n" + description when present)
 *   input / output       ← input / output
 *   approval             ← approval ?? { type: 'auto' } (reads)
 *   parking              ← parking === 'never' ? 'never' : (absent)
 *   autoApproveForInitiator ← autoApproveForInitiator (absent unless declared)
 *   rbac                 ← auth.rbac
 *   handler              ← handler
 *   confirm (proposal)   ← confirm !== 'none' ⇒ { http: {method, path}, card: agent.card,
 *                            secretFields ← secrets.input pointers' top-level keys,
 *                            idempotent ← http.idempotencyHeader present }
 *   idempotencyKey, cronSafe, channelPendingText, *TtlSeconds ← agent.*
 *   projectParam         ← projectParamOf(cap) (tenancy:'project' only; SPEC §5.7 rule 3)
 *   webOnly              ← a write with no server-side handler (SPEC §5.2 W)
 *   handler (web-only write with none declared) ← webOnlyRefusal: never reached,
 *                            because the registry refuses a channel invocation of a
 *                            webOnly write before parking and the web never invokes it
 */
import type { ActionContext, AgentCallableAction, ProposalSpec } from '../agui/types';
import type { Capability } from './define';

export class AgentDerivationError extends Error {
  constructor(id: string, reason: string) {
    super(`capability ${id}: cannot derive an agent action — ${reason}`);
    this.name = 'AgentDerivationError';
  }
}

/** `/github_access_token` → `github_access_token`. A nested pointer has no flat ProposalSpec form yet. */
export function secretFieldsOf(cap: Capability<any, any>): string[] | undefined {
  const pointers = cap.secrets?.input;
  if (pointers === undefined || pointers.length === 0) return undefined;
  return pointers.map((p) => {
    const segs = p.split('/').slice(1);
    if (segs.length !== 1) throw new AgentDerivationError(cap.id, `secret pointer ${p} is nested`);
    return segs[0]!;
  });
}

function proposalOf(cap: Capability<any, any>, card: ProposalSpec['card'] | undefined): ProposalSpec | undefined {
  if (cap.confirm === 'none') return undefined;
  if (card === undefined) throw new AgentDerivationError(cap.id, 'a confirming write names agent.card');
  if (cap.http.path === null) throw new AgentDerivationError(cap.id, 'an agent-native write has no web route to confirm (P1c)');
  if (cap.http.method === 'GET') throw new AgentDerivationError(cap.id, 'a confirming write is not a GET');
  const spec: ProposalSpec = { http: { method: cap.http.method, path: cap.http.path }, card };
  const secretFields = secretFieldsOf(cap);
  if (secretFields !== undefined) spec.secretFields = secretFields;
  if (cap.http.idempotencyHeader !== undefined) spec.idempotent = true;
  return spec;
}

/** `/api/projects/:id/...` → `id`: the input key that names the project (SPEC §5.7 rule 3). */
const PROJECT_PATH_RE = /^\/api\/projects\/:([A-Za-z0-9_]+)(?:\/|$)/;

export function projectParamOf(cap: Capability<any, any>): string | undefined {
  if (cap.tenancy !== 'project' || cap.http.path === null) return undefined;
  return PROJECT_PATH_RE.exec(cap.http.path)?.[1];
}

/**
 * A write the web only confirms through its card: it has no server-side handler,
 * so nothing can run it on `approve <id>`. Every write WITH one is offered on
 * every channel (Telegram, email, Teams, mcp) — George 2026-10-30.
 */
export function isWebOnlyWrite(cap: Capability<any, any>): boolean {
  return cap.effect !== 'read' && cap.handler === undefined;
}

/** The handler of a web-only write: unreachable by construction (see header); refuses if ever called. */
function webOnlyRefusal(id: string): (input: unknown, ctx: unknown) => Promise<never> {
  return async () => {
    const { AppError } = await import('../utils/errors');
    throw new AppError(400, `${id} runs only from its confirm card on the web, under your own session`).withCode(
      'confirm_card_required',
    );
  };
}

export function deriveAgentAction<I, O>(cap: Capability<I, O>): AgentCallableAction<I, O> {
  if (!cap.agent.expose) throw new AgentDerivationError(cap.id, `agent.expose is false (${cap.agent.reason})`);
  const webOnly = isWebOnlyWrite(cap);
  if (cap.handler === undefined && !webOnly) throw new AgentDerivationError(cap.id, 'no server-side handler');
  if (cap.tenancy === 'project' && projectParamOf(cap) === undefined) {
    throw new AgentDerivationError(cap.id, "a tenancy:'project' capability's route must carry the project as /api/projects/:<param>");
  }
  const handler = cap.handler ?? (webOnlyRefusal(cap.id) as unknown as (input: I, ctx: ActionContext) => Promise<O>);
  const agent = cap.agent;
  const action: AgentCallableAction<I, O> = {
    name: cap.id,
    kind: cap.effect === 'read' ? 'read' : 'write',
    description: cap.description ? `${cap.summary}\n\n${cap.description}` : cap.summary,
    input: cap.input,
    output: cap.output,
    approval: cap.approval ?? { type: 'auto' },
    cronSafe: agent.cronSafe,
    idempotencyKey: agent.idempotencyKey,
    rbac: cap.auth.rbac,
    handler,
  };
  const projectParam = projectParamOf(cap);
  if (projectParam !== undefined) action.projectParam = projectParam;
  if (webOnly) action.webOnly = true;
  if (cap.parking === 'never') action.parking = 'never';
  if (cap.autoApproveForInitiator !== undefined) action.autoApproveForInitiator = cap.autoApproveForInitiator;
  const confirm = proposalOf(cap, agent.card);
  if (confirm !== undefined) action.confirm = confirm;
  if (agent.channelPendingText !== undefined) action.channelPendingText = agent.channelPendingText;
  if (agent.idempotencyTtlSeconds !== undefined) action.idempotencyTtlSeconds = agent.idempotencyTtlSeconds;
  if (agent.approvalTtlSeconds !== undefined) action.approvalTtlSeconds = agent.approvalTtlSeconds;
  return action;
}
