// src/domain/engagement/tenant-member-fanout.ts
//
// fr-agui P1-TEAM-b — every approval / question is sent to ALL members of its tenant.
//
// ⭐ GEORGE, 2026-10-15, VERBATIM: "all notifications/approvals/questions are sent to
// all members, each member can configure their notification channels."
//
// ⛔ TOLD IS NOT ENROLLED. This module only NOTIFIES. It never writes
// `required_approvers`: the roster stays exactly what the raise site wrote, so the
// gate stays 1-of-1 (or N-of-N where a producer named N). Deciding is 1-of-any tenant
// member through the decide arm in `routes/approvals.ts :: resolveDecideEligibility`
// (and the three chat seats), which DISCHARGES a roster row — it does not need the
// member to be on it. Enrolling every member as a roster row would turn a 1-of-1 gate
// into an N-of-N one, which is the opposite of the ruling.
//
// Each member's own `user_channel_prefs` decide WHERE they are reached
// (`fanOutToUser` reads them); a member with no prefs gets the `skipped_disabled`
// audit row, exactly as a rostered approver with no prefs always has.
//
// ⛔ STRICT TENANT SEPARATION: the recipient list is `listTenantMemberRecipients(T)`
// for the approval's OWN tenant `T`, nothing else — and only CURRENT members (enabled and
// Keycloak-homed in T; a stale `user_roles` row is dropped, P1-TEAM-b audit B1). Fail
// CLOSED on content: a directory outage or a DB failure tells nobody extra (reported) —
// the approval itself is already durable and its rostered approver already told.

import { listTenantMemberRecipients } from '../../services/tenant-member-recipients';
import { notificationService, type ApprovalWithDetails } from './notifications';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';

type FanOutToUser = (
  approval: ApprovalWithDetails,
  userId: string,
  engagementType: string,
  actionId: string | null,
) => Promise<void>;

export interface TenantMemberFanOutResult {
  /** Members told by THIS call (excludes `alreadyNotified`). */
  notified: string[];
  /** True when the member list was unreadable (nobody extra was told). */
  degraded: boolean;
}

/**
 * Tell every member of `tenantId` about `approval`, except the ids in
 * `alreadyNotified` (the rostered approvers / escalation humans the raise site has
 * already told — told once, not twice). AWAITED per member so the
 * `engagement_deliveries` rows exist before a caller's `confirmPushDelivery`.
 * Never throws.
 */
export async function fanOutApprovalToTenantMembers(input: {
  approval: ApprovalWithDetails;
  tenantId: string;
  alreadyNotified?: Iterable<string>;
  engagementType?: string;
  actionId?: string | null;
  context: string;
}): Promise<TenantMemberFanOutResult> {
  const send: FanOutToUser = (a, u, e, act) => notificationService.fanOutToUser(a, u, e, act);
  const skip = new Set(input.alreadyNotified ?? []);
  let userIds: string[] = [];
  let degraded = false;
  try {
    const members = await listTenantMemberRecipients(input.tenantId);
    userIds = members.userIds;
    degraded = members.realmError !== undefined;
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `[${input.context}] tenant-member list for ${input.tenantId} unreadable — only the already-addressed approver(s) were told`,
    });
    return { notified: [], degraded: true };
  }
  const notified: string[] = [];
  for (const userId of userIds) {
    if (skip.has(userId)) continue;
    skip.add(userId);
    try {
      await send(input.approval, userId, input.engagementType ?? 'approval', input.actionId ?? null);
      notified.push(userId);
    } catch (err) {
      console.error(`[${input.context}] tenant-member fan-out to ${userId} failed:`, err);
    }
  }
  return { notified, degraded };
}
