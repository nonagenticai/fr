// src/lib/chat-seat-tenant-member.ts
//
// fr-agui P1-TEAM-b — the 1-of-any tenant-member decide arm, for the three CHAT seats
// (Telegram, Teams). The web seat's arm lives in
// `routes/approvals.ts :: resolveDecideEligibility`; this is its mirror.
//
// ⭐ George 2026-10-15: every member is now TOLD about every approval of their tenant
// (`domain/engagement/tenant-member-fanout.ts`), on the channels each member configured —
// so a member who replies on Telegram must be able to decide, exactly as on the web.
//
// A chat seat resolves a sender to the fr accounts LINKED to that address
// (`findUserIdsByChannelAddress`); prod has 12 accounts linked to one Telegram id, across
// different tenants. The roster arm picks a linked account the roster NAMES. When none is
// named, this picks the linked account that is a member of the APPROVAL'S tenant:
//
//   1. `isTenantMemberForDecision(T, id)` — `user_roles` in T, else a FRESH Keycloak read
//      of users whose `tenant_id` attribute is T (fail closed);
//   2. AND `userHomedIn(id, T)` — the account is ACTIVE and its Keycloak home tenant is T
//      (P1-TEAM-a's channel rule: a leftover `user_roles` row from before a re-homing
//      must not grant the old tenant's approvals). An outage THROWS → refused.
//
// ⭐ ACTION APPROVALS TOO (P1-TEAM-c, George 2026-10-15): any member may approve one, and
// the parked action then runs AS THE DECIDER this arm resolved (`resolvePendingAction`),
// never as the requester. So the "exactly one linked account" rule below is what makes
// the executing identity correct: an ambiguous chat address decides — and runs — nothing.
//
// ⛔ NO ROSTER, NO DECIDER — unchanged: an empty roster has no obligation to discharge, so
// the arm returns null and the seat answers as it always has.
//
// ⛔ NEVER PICK BETWEEN ACCOUNTS (P1-TEAM-b audit M1). One chat address can be linked to
// several fr accounts (live: one Telegram id → 12 accounts, people AND machine accounts —
// which George ruled 2026-10-15 are FULL members). Picking "the lowest eligible id" would
// record a human's reply as some other account's decision. So when MORE THAN ONE linked
// account is eligible in the approval's tenant the arm REFUSES (`ambiguous`) with an
// actionable reply: link exactly one account to decide here, or decide in the web app.
//
// The requester guard is the shared decide path's (`recordApprovalDecision`), applied to the
// account this resolves — the same rule as every other seat.

import { isTenantMemberForDecision, isTenantMemberForDecisionOrThrow } from '../services/tenant-member-recipients';
import { userHomedIn } from '../services/user-home-tenant';
import type { RequesterGuardApproval } from '../domain/engagement/decision-guards';

/** Why a chat seat refused to resolve ANY decider for a sender. */
export type ChatSeatRefusal =
  | { refused: 'ambiguous'; eligible: number }
  | { refused: 'several_linked'; linked: number }
  /** P1-TEAM-c audit 2: several accounts are linked and NONE is a member of the approval's tenant. */
  | { refused: 'no_linked_member'; linked: number }
  /** P1-TEAM-c audit 2: a linked account's membership could not be read — fail closed. */
  | { refused: 'linked_unverifiable' };

export function isChatSeatRefusal(x: unknown): x is ChatSeatRefusal {
  return typeof x === 'object' && x !== null && typeof (x as { refused?: unknown }).refused === 'string';
}

/** The reply a chat seat sends for a refusal. `webLink`, when given, is appended. */
export function chatSeatRefusalMessage(r: ChatSeatRefusal, webLink?: string): string {
  const tail = webLink ? ` ${webLink}` : '';
  if (r.refused === 'several_linked') {
    return (
      `This chat is linked to several fr accounts (${r.linked}) in this request's workspace, so I cannot ` +
      'tell whose decision this is. Your reply was NOT recorded. Link exactly one fr account of this ' +
      `workspace to this chat to decide here, or decide it in the fr web app.${tail}`
    );
  }
  if (r.refused === 'no_linked_member') {
    return (
      `None of the ${r.linked} fr accounts linked to this chat is a member of this request's workspace. ` +
      `Your reply was NOT recorded. Decide it in the fr web app as a member of that workspace.${tail}`
    );
  }
  if (r.refused === 'linked_unverifiable') {
    return (
      "I couldn't check which of the fr accounts linked to this chat belongs to this request's workspace. " +
      `Your reply was NOT recorded; please send it again shortly, or decide it in the fr web app.${tail}`
    );
  }
  return (
    `This chat is linked to several fr accounts (${r.eligible}) that may decide this request, ` +
    'so I cannot tell whose decision this is. Your reply was NOT recorded. Link exactly one ' +
    `account to this chat to decide here, or decide it in the fr web app.${tail}`
  );
}

/**
 * The tenant-member decider among the accounts LINKED to one chat address, or a refusal.
 *
 *   - `null` — no linked account may decide through this arm (empty roster, no tenant, nobody eligible, or every check failed — fail closed);
 *   - a user id — EXACTLY ONE linked account is a member of AND homed in the tenant;
 *   - `{ refused: 'ambiguous' }` — more than one is: never pick.
 */
export async function chooseTenantMemberDecider(
  candidates: readonly string[],
  approvalTenantId: string | null | undefined,
  rosterSize: number,
  opts: { approval?: RequesterGuardApproval } = {},
): Promise<string | ChatSeatRefusal | null> {
  if (!approvalTenantId || rosterSize === 0) return null;
  const linked = [...new Set(candidates)].sort();
  const eligible: string[] = [];
  let unverifiable = false;
  for (const id of linked) {
    try {
      if (!(await isTenantMemberForDecision(approvalTenantId, id))) continue;
      if (!(await userHomedIn(id, approvalTenantId))) continue;
      eligible.push(id);
    } catch (err) {
      // Fail closed: an unverifiable account is not a member for a decision — and while
      // any linked account is unverifiable, "exactly one is eligible" is unprovable.
      unverifiable = true;
      console.warn('[chat-seat-tenant-member] membership check failed; account skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (eligible.length > 1) return { refused: 'ambiguous', eligible: eligible.length };
  if (unverifiable) return null;
  return eligible[0] ?? null;
}

/**
 * ⛔ P1-TEAM-c ATTRIBUTION (George 2026-10-15): "an address linked to several accounts must
 * never be recorded as the wrong account". Since P1-TEAM-c an ACTION approval runs AS ITS
 * APPROVER, so the account a chat reply is recorded as is the identity a write executes
 * under — and, for every other approval, the name on the decision.
 *
 * NARROWED BY TENANT (P1-TEAM-c audit 2, a deterministic rule, not a guess). One address may
 * link several accounts (prod: one Telegram id → 12, workspace-admins of different tenants).
 * An approval belongs to ONE tenant, and only a current member of it may decide it, so:
 *   - zero or one distinct account → that list, unchanged (the seat's own checks follow);
 *   - several → keep ONLY those that are CURRENT members of the approval's tenant
 *     (`isTenantMemberForDecisionOrThrow`: `user_roles` ∪ a fresh Keycloak read; a read
 *     failure THROWS, so an outage can never hide a second member):
 *       · exactly one remains → `[that one]` — the only account that COULD decide it;
 *       · more than one remains → `{ refused: 'several_linked' }`, EXCEPT the address's
 *         own-request rule: the row's requester is one of them AND it was filed through this
 *         same channel (`action_channel`/`source`) → `[requester]` (the account this address
 *         already acted as; the requester guards still apply after);
 *       · none remains → `{ refused: 'no_linked_member' }`;
 *       · any membership read failed → `{ refused: 'linked_unverifiable' }` (never a pick
 *         made on a partial answer).
 *
 * Applied BEFORE any roster or member pick, for action AND non-action approvals alike, by
 * every chat seat: Telegram, Teams, the tenant-member arms and `approvals.decide`.
 */
export async function narrowLinkedAccountsForDecision(
  candidates: readonly string[],
  approval: {
    tenant_id: string | null | undefined;
    requester_id?: string | null;
    action_channel?: string | null;
    source?: string | null;
  },
  channel: string,
): Promise<string[] | ChatSeatRefusal> {
  const linked = [...new Set(candidates)].sort();
  if (linked.length <= 1) return linked;
  const tenantId = approval.tenant_id;
  if (!tenantId) return { refused: 'no_linked_member', linked: linked.length };
  const members: string[] = [];
  for (const id of linked) {
    try {
      if (await isTenantMemberForDecisionOrThrow(tenantId, id)) members.push(id);
    } catch (err) {
      console.warn('[chat-seat-tenant-member] linked-account membership check failed; refused', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { refused: 'linked_unverifiable' };
    }
  }
  if (members.length === 1) return members;
  if (members.length === 0) return { refused: 'no_linked_member', linked: linked.length };
  const requester = approval.requester_id ?? null;
  const filedHere = approval.action_channel === channel || approval.source === channel;
  if (requester !== null && filedHere && members.includes(requester)) return [requester];
  return { refused: 'several_linked', linked: members.length };
}
