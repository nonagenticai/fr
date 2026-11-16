// src/lib/decided-by-kind.ts
//
// Cockpit A5 / R-CK1 (migration 211): WHAT made an approval decision — a person, the Claude
// approval-triage agent, or fr policy code. Every `approval_decisions` insert site passes
// `decidedByKindFor(approverId)` (or `'rule'` from a policy writer) explicitly; the column's DB
// default exists only so it could land NOT NULL on historical rows.
//
// The triage agents decide as ORDINARY approver uuids (Keycloak users `claude-approval-triage*`,
// George 2026-10-14), so the only discriminator fr has is the user id. A username prefix is not
// used: usernames are not a trust anchor here, user ids are.
//
// ⛔ No ids are compiled in. FR_TRIAGE_AGENT_USER_IDS (CSV of uuids) is the ONLY source; the
// built-in list stays empty so behaviour does not depend on a Keycloak user id shipped in a
// public repo. Empty means fail-closed in the safe direction: with no env set, nothing is
// classified as `triage_agent`, so no approval is ever credited to a triage agent that this
// deployment was not told about.
import type { DecidedByKind } from '../db/schema';
import { isAgentMemberId } from '../domain/engagement/agent-members';

export const TRIAGE_AGENT_USER_IDS: readonly string[] = [];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The built-in ids plus any well-formed uuid in FR_TRIAGE_AGENT_USER_IDS, lower-cased. */
export function triageAgentUserIds(): Set<string> {
  const extra = (process.env.FR_TRIAGE_AGENT_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s));
  return new Set([...TRIAGE_AGENT_USER_IDS.map((s) => s.toLowerCase()), ...extra]);
}

/** `'triage_agent'` for a known triage service-account user id, else `'human'`. */
export function decidedByKindFor(
  approverId: string | null | undefined,
): Extract<DecidedByKind, 'human' | 'triage_agent' | 'agent'> {
  // fr #1683: an agent member (a version-8 UUID principal) deciding as itself.
  if (isAgentMemberId(approverId)) return 'agent';
  if (typeof approverId === 'string' && triageAgentUserIds().has(approverId.trim().toLowerCase())) {
    return 'triage_agent';
  }
  return 'human';
}
