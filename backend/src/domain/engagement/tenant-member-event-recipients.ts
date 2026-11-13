// src/domain/engagement/tenant-member-event-recipients.ts
//
// fr-agui P1-TEAM-b — who is told about a NON-approval project event
// (`POST /api/webhooks/n8n/execution-event`, the bug-report webhook).
//
// ⭐ GEORGE, 2026-10-15: "all notifications/approvals/questions are sent to all
// members". So the recipient set is EVERY member of the event's tenant
// (`listTenantMemberRecipients`), plus any explicitly named id that is ALSO a member.
//
// ⛔ AN EXPLICIT ID OUTSIDE THE TENANT IS DROPPED, NEVER NOTIFIED. The webhook secret
// is shared by every n8n producer, so a caller-named recipient is an assertion, not a
// fact. Membership of an explicit id is read through the same CURRENT-member list
// (enabled and Keycloak-homed in T; a stale `user_roles` row does not count — P1-TEAM-b
// audit B1). When the directory could not be read that list is EMPTY, so every explicit
// id is dropped too and nobody is told (fail closed on LEAKAGE): an explicit id here is
// an unverifiable producer assertion, not a roster the raise site already holds.
//
// ⛔ Budget-threshold alerts do NOT come through here — they stay workspace-ADMIN only
// (`routes/webhooks/budget-threshold.helpers.ts`), a tenant-admin concern.

import {
  listTenantMemberRecipients,
  type TenantMemberRecipients,
} from '../../services/tenant-member-recipients';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';

export interface ExecutionEventRecipients {
  recipientIds: string[];
  /** Explicit ids refused because they are not (provably) members of the tenant. */
  droppedExplicit: string[];
  degraded: boolean;
}

export async function executionEventRecipients(
  input: {
    tenantId: string;
    explicitUserIds: readonly string[];
    context: string;
  },
  listMembers: (tenantId: string) => Promise<TenantMemberRecipients> = (t) =>
    listTenantMemberRecipients(t),
): Promise<ExecutionEventRecipients> {
  let members: TenantMemberRecipients;
  try {
    members = await listMembers(input.tenantId);
  } catch (err) {
    // A DB failure: nobody is provably a member, so nobody is told — never a guess.
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `[${input.context}] tenant-member list for ${input.tenantId} unreadable — NOBODY notified (no member is provable)`,
    });
    return { recipientIds: [], droppedExplicit: [...new Set(input.explicitUserIds)], degraded: true };
  }
  const memberSet = new Set(members.userIds);
  const droppedExplicit: string[] = [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of input.explicitUserIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (memberSet.has(id)) out.push(id);
    else droppedExplicit.push(id);
  }
  for (const id of members.userIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (droppedExplicit.length > 0) {
    console.warn(
      `[${input.context}] dropped ${droppedExplicit.length} explicit recipient(s) that are not ` +
        `members of tenant ${input.tenantId}: ${droppedExplicit.join(', ')}`,
    );
  }
  return { recipientIds: out, droppedExplicit, degraded: members.realmError !== undefined };
}
