/**
 * fr-agui SPEC §5.2 (W) — the SHAPE of a proposal for a confirm-card write.
 *
 * Shared by the agent loop (`agent/proposal.ts buildProposal`, which also
 * validates and dry-runs RBAC) and by the registry (`invokeAction`, which has
 * already done both by the time it turns an agent invocation into a proposal).
 * This module imports types only, so the registry can use it without an import
 * cycle through `agent/proposal.ts`.
 *
 * A proposal creates NO approval row and runs NO handler. The browser renders
 * the card and, on the human's click, calls `confirm.http` under the human's
 * own session. Secrets (R7, §10.1): every `confirm.secretFields` key is removed.
 */
import { randomUUID } from 'node:crypto';

import type { AgentCallableAction, ProposalSpec } from './types';

export interface AgentProposal {
  status: 'proposal';
  proposalId: string;
  action: string;
  card: ProposalSpec['card'];
  http: ProposalSpec['http'];
  /** The validated input, with every secret field removed. */
  input: Record<string, unknown>;
  /** UUID v4 the card sends as `Idempotency-Key` (when the action declares one). */
  idempotencyKey?: string;
  /** Names of the secret fields the card collects itself (never pre-filled). */
  secretFields: string[];
}

/** Remove the declared secret keys (shallow; the create inputs are flat). */
export function redactSecretFields(input: unknown, secretFields: readonly string[] | undefined): unknown {
  if (!secretFields || secretFields.length === 0) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!secretFields.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * fr-agui P2-c2: every key the card collects ITSELF — the declared secrets and the
 * human-only choices (`confirm.humanFields`) — removed before anything is proposed,
 * so neither can arrive pre-filled from the agent.
 */
export function cardOwnedFields(spec: ProposalSpec): string[] {
  return [...(spec.secretFields ?? []), ...(spec.humanFields ?? [])];
}

/** The proposal for an ALREADY-validated input of a confirm-card action. */
export function shapeProposal(action: AgentCallableAction, parsedInput: unknown): AgentProposal {
  const spec = action.confirm;
  if (!spec) throw new Error(`shapeProposal: ${action.name} declares no confirm spec`);
  const secretFields = [...(spec.secretFields ?? [])];
  return {
    status: 'proposal',
    proposalId: randomUUID(),
    action: action.name,
    card: spec.card,
    http: spec.http,
    input: (redactSecretFields(parsedInput, cardOwnedFields(spec)) ?? {}) as Record<string, unknown>,
    ...(spec.idempotent ? { idempotencyKey: randomUUID() } : {}),
    secretFields,
  };
}

export function isAgentProposal(v: unknown): v is AgentProposal {
  return !!v && typeof v === 'object' && (v as { status?: unknown }).status === 'proposal';
}
