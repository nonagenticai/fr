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
// ⛔ TRIAGE_AGENT_USER_IDS must equal the IN-list in migrations/211_approval_decided_by_kind.sql
// (tests/unit/lib/decided-by-kind.test.ts compares them). FR_TRIAGE_AGENT_USER_IDS (CSV of uuids)
// ADDS ids at runtime for a new triage account; it can never remove a built-in one.
import type { DecidedByKind } from '../db/schema';
import { isAgentMemberId } from '../domain/engagement/agent-members';

export const TRIAGE_AGENT_USER_IDS: readonly string[] = [
  '72084c2b-d87a-44fe-bcf0-9baddde3be78', // claude-approval-triage-conveyor (tenant 5f868d42)
  'd16aa38b-30b7-46af-b47a-ae24d87527f4', // claude-approval-triage
  'f66d2f56-784e-471b-9fb2-4afcb4851270', // claude-approval-triage-workflow-improvement
  '44b9d331-8392-4af4-93fd-f0610379091a', // claude-approval-triage-nonagentic-exec
  '1351ff57-3c88-4ea4-a3f2-0c77cc993982', // claude-approval-triage-prompt-improvement
  '0df838ad-8122-4716-a86b-c080330ffec9', // claude-approval-triage-procedure-improvement
];

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
