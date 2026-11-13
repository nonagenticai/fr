/**
 * approval-routing.ts — decide WHICH HUMAN an approval is addressed to, and whether a
 * human needs to be bothered at all.
 *
 * THE DEFECT THIS CLOSES. `handleN8nCardApproval` — the route the whole AA conveyor
 * raises approvals through — had no field for a person. It fanned out to
 * `{channel:'websocket', address:'broadcast'}` (a live badge for whoever happens to
 * have the UI open) plus an optional raw phone on `signal`, the channel this estate
 * retired in the Telegram cutover. Measured on prod 2026-08-18: 362 approvals raised,
 * 316 naming nobody, 335 expired unanswered (92%), 52 delivery attempts logged in 3.5
 * months, exactly 1 of them telegram.
 *
 * The channel was never broken. `engagement_deliveries` records tenant …0003's
 * workspace-admin receiving an approval on telegram at 2026-06-13T15:33:59Z. The path
 * works; nothing pointed at it.
 *
 * ⚠️ WHY "HAS AN ENABLED CHANNEL" IS THE WRONG TEST — READ BEFORE SIMPLIFYING.
 * The system exec-operator `22560966-…` HAS an enabled channel: `inapp`. It owns 292 of
 * the projects, so both of the obvious rules — "notify the project owner" and "pick a
 * user with an enabled channel" — resolve to a robot, and every test that asserts only
 * "an approver was named" would pass while nobody is told anything.
 *
 * The measurement settles it: 43 `inapp` deliveries marked `sent` produced ZERO answers;
 * the single `telegram` delivery is the one that reached a person. `inapp` and
 * `websocket` are PASSIVE — you receive them only if you are already looking at the
 * thing that is asking. A gate that blocks work until a human answers must reach them
 * where they are not already looking. Hence PUSH_CHANNELS below.
 */

import { and, eq, inArray } from 'drizzle-orm';
// `db` and every table come from db/client, which re-exports schema.ts — the idiom
// every sibling in this directory uses (see notifications.ts:4). Importing the tables
// straight from schema.ts would work in TS and then diverge from the mock surface the
// tests swap in.
import { db, approvals, departments, engagementDeliveries, projects, userRoles } from '../../db/client';
import { projectOwnerTenant } from '../../lib/board-tenant-access';
import { resolveRecipients } from './channel-prefs';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { config } from '../../config';
import { keycloak } from '../../services/keycloak';
import { listTenantMemberRecipients } from '../../services/tenant-member-recipients';

/**
 * Channels that actively reach a person who is NOT currently looking at fr.
 *
 * `inapp` and `websocket` are deliberately absent. They are not broken and they are not
 * useless — they drive live badges — but they cannot discharge a gate, and treating
 * them as sufficient is precisely what produced 43 "sent" deliveries and 0 answers.
 */
export const PUSH_CHANNELS = new Set(['telegram', 'email', 'teams', 'voice', 'mcp']);

/**
 * A linked push channel fr can deliver to NOW, for routing. `mcp` is always offered
 * and linkable, but until MCP_EVENTS_URL and FR_MCP_CHANNEL_SECRET are set every send
 * fails — so it must not make an approver look reachable (the approval would expire
 * unread while `notified_at` reads as a routing success).
 */
function deliverablePushChannel(channel: string): boolean {
  if (!PUSH_CHANNELS.has(channel)) return false;
  return channel !== 'mcp' || (config.services.mcp.eventsUrl !== '' && config.services.mcp.secret !== '');
}

export type ApproverCandidateSource =
  | 'explicit'
  | 'workspace_admin'
  | 'project_owner'
  /** P1-TEAM-b: any other member of the approval's tenant (user_roles ∪ Keycloak). */
  | 'tenant_member'
  | 'fallback';

export interface ResolvedApprover {
  userId: string;
  source: ApproverCandidateSource;
  /** The push channels this human is actually reachable on. Never empty. */
  channels: string[];
}

/** Every candidate considered, and why each was accepted or rejected. */
export interface ApproverResolution {
  approver: ResolvedApprover | null;
  considered: Array<{
    userId: string;
    source: ApproverCandidateSource;
    pushChannels: string[];
    rejected?: string;
  }>;
}

/**
 * Is this user reachable on at least one PUSH channel — for THIS tenant's approval?
 * A link pinned to another workspace does not count (the fan-out skips it:
 * channel-prefs.ts `resolveRecipients`).
 *
 * Fail-closed: a prefs lookup that throws yields "not reachable", so an unreachable
 * prefs store escalates to the next candidate rather than silently nominating someone
 * who will never see the request.
 */
export async function pushChannelsFor(userId: string, tenantId?: string | null): Promise<string[]> {
  try {
    const recipients = await resolveRecipients(userId, tenantId);
    return recipients.map((r) => r.channel).filter(deliverablePushChannel);
  } catch (err) {
    // The `[]` is DELIBERATE and unchanged — see the docstring above: an
    // unreachable prefs store must escalate to the next candidate rather than
    // nominate someone who will never see the request. What was missing is not a
    // different contract, it is an operator-visible record of WHY a candidate was
    // escalated past, so a routing decision taken on a read failure can be told
    // apart from one taken on a measured absence of push channels.
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `user ${userId} treated as not-push-reachable, candidate escalated`,
    });
    return [];
  }
}

/**
 * The candidate ORDER, as a pure function — extracted so it can be proven without a
 * database, because the order is the thing that was wrong in production and the thing
 * a future edit can silently break.
 *
 * ⚠️ workspace-admin BEFORE project_owner is deliberate and counter-intuitive.
 * 292 of the projects are owned by `22560966-…`, the system exec-operator, so
 * owner-first routes almost every approval to a robot — and looks entirely correct in
 * any test that only asserts "an approver was named".
 *
 * ⚠️ fallback is LAST. It is the human of last resort, not a shortcut past a tenant
 * that has its own reachable admin; putting it earlier would silently centralise every
 * tenant's approvals onto one person.
 */
export function orderCandidates(input: {
  explicitUserId?: string | null;
  adminUserIds: string[];
  ownerUserId?: string | null;
  /**
   * P1-TEAM-b (George 2026-10-15: "all … approvals … are sent to all members"): every
   * other member of the tenant, AFTER the owner and BEFORE the tenant-independent
   * fallback — a reachable member of the tenant is a better addressee than a human
   * outside it. Optional so a caller that has not read the members is unchanged.
   */
  memberUserIds?: string[];
  fallbackUserId?: string | null;
}): Array<{ userId: string; source: ApproverCandidateSource }> {
  const out: Array<{ userId: string; source: ApproverCandidateSource }> = [];
  if (input.explicitUserId) out.push({ userId: input.explicitUserId, source: 'explicit' });
  for (const a of input.adminUserIds) out.push({ userId: a, source: 'workspace_admin' });
  if (input.ownerUserId) out.push({ userId: input.ownerUserId, source: 'project_owner' });
  for (const m of input.memberUserIds ?? []) out.push({ userId: m, source: 'tenant_member' });
  if (input.fallbackUserId) out.push({ userId: input.fallbackUserId, source: 'fallback' });
  return out;
}

/**
 * Resolve the human this approval is addressed to.
 *
 * Order — explicit, then the tenant's workspace-admin, then the project owner, then (P1-TEAM-b)
 * any other member of the tenant, then the tenant-independent fallback:
 *
 *  1. `explicitUserId` — an approver n8n named outright. This is ALSO the seam the
 *     future triage worker writes through: once a worker decides who should see a
 *     request, it names them here and this function obeys without special-casing.
 *  2. **workspace-admin before project owner**, which is the inverse of the obvious
 *     order and is deliberate: 292 projects are owned by the system exec-operator, so
 *     owner-first routes almost everything to a robot. The workspace-admin is a person
 *     by construction.
 *  3. `projects.owner_id` — correct for a human-owned project, and harmless for a
 *     robot-owned one because the push-channel test rejects it anyway.
 *
 * A candidate that is not reachable on a push channel is NOT an approver, however
 * senior. Returns `approver: null` when nobody qualifies — the caller must fail loud,
 * never write the row. An approval addressed to nobody is the 24-hour timer this whole
 * change exists to delete.
 */
export async function resolveApprover(opts: {
  tenantId: string;
  projectId?: string | null;
  explicitUserId?: string | null;
}): Promise<ApproverResolution> {
  const considered: ApproverResolution['considered'] = [];

  const adminUserIds: string[] = [];
  let ownerUserId: string | null = null;

  // The tenant's admins. One row per tenant in practice, but this does not assume that.
  try {
    const admins = await db
      .select({ user_id: userRoles.user_id })
      .from(userRoles)
      .where(and(eq(userRoles.tenant_id, opts.tenantId), eq(userRoles.role, 'workspace-admin')));
    for (const a of admins) adminUserIds.push(a.user_id);
  } catch (err) {
    console.error('[approval-routing] workspace-admin lookup failed:', err);
  }
  // …plus Keycloak realm `tenant_admin` holders whose `tenant_id` attribute is
  // this tenant — workspace-admins by the same rule every backend gate applies
  // (`isRealmTenantAdminOf`). Appended AFTER the `user_roles` admins so the
  // existing order is unchanged; `orderCandidates` + the `seen` set below dedupe.
  // Fail-soft: a directory outage leaves the DB admins and the ladder intact.
  try {
    for (const id of await keycloak.listRealmTenantAdminIds(opts.tenantId)) {
      if (!adminUserIds.includes(id)) adminUserIds.push(id);
    }
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      // Fallback only: an IntegrationError from listRealmTenantAdminIds carries its
      // own path (users search or per-user role-mappings), which wins.
      path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
      degradedTo: 'approver candidates = user_roles workspace-admins only',
    });
  }

  if (opts.projectId) {
    try {
      // Tenant-scoped: the project's owner is a candidate only when the project
      // belongs to THIS approval's tenant (the one project-owner rule,
      // `projectOwnerTenant`). A foreign or ownerless project contributes no
      // owner — never another tenant's user as this tenant's approver.
      const rows = await db
        .select({
          owner_id: projects.owner_id,
          workspace_id: departments.workspace_id,
          project_data: projects.project_data,
        })
        .from(projects)
        .leftJoin(departments, eq(departments.id, projects.dept_id))
        .where(eq(projects.id, opts.projectId));
      const row = rows[0];
      if (row?.owner_id && projectOwnerTenant(row) === opts.tenantId) {
        ownerUserId = row.owner_id;
      }
    } catch (err) {
      console.error('[approval-routing] project owner lookup failed:', err);
    }
  }

  // P1-TEAM-b — every other CURRENT member of the tenant (enabled + Keycloak-homed in T);
  // a directory outage or DB failure leaves none (fail closed). ⛔ The approval's OWN tenant only.
  let memberUserIds: string[] = [];
  try {
    memberUserIds = (await listTenantMemberRecipients(opts.tenantId)).userIds;
  } catch (err) {
    console.error('[approval-routing] tenant-member lookup failed:', err);
  }

  // LAST RESORT — a tenant-independent human. See config.services.approvals.
  // Only ONE of the 8 approval-raising tenants has a reachable workspace-admin, so
  // without this the fail-loud branch below would fire for 7 of them and stop the
  // conveyor outright. Falling back to a human is the behaviour George asked for
  // ("when in doubt use the human"); falling back to NOBODY is the defect being fixed.
  const candidates = orderCandidates({
    explicitUserId: opts.explicitUserId,
    adminUserIds,
    ownerUserId,
    memberUserIds,
    fallbackUserId: config.services.approvals.fallbackApproverUserId || null,
  });

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.userId)) continue;
    seen.add(c.userId);
    const channels = await pushChannelsFor(c.userId, opts.tenantId);
    if (channels.length > 0) {
      considered.push({ userId: c.userId, source: c.source, pushChannels: channels });
      return { approver: { userId: c.userId, source: c.source, channels }, considered };
    }
    considered.push({
      userId: c.userId,
      source: c.source,
      pushChannels: [],
      rejected: 'no enabled push channel (inapp/websocket alone cannot discharge a gate)',
    });
  }

  return { approver: null, considered };
}

// ---------------------------------------------------------------------------
// The EXPLICIT-ROSTER arm.
//
// ⛔ THE DEFECT THIS CLOSES. `resolveApprover` above — the whole PUSH_CHANNELS
// ladder — is only ever consulted by routes/execution-approvals.ts when a card has
// NO project. A card that HAS a project takes its approvers verbatim from
// `project_stakeholders` where role='execution_signoff', and the only test applied
// to that roster is `approverIds.length === 0`. A roster of exactly one
// inapp-only robot is therefore accepted as a valid roster.
//
// Measured on prod 2026-08-29 (project_stakeholders, role='execution_signoff'):
//   22560966-… (exec-operator, `inapp` ONLY — not a push channel)  172 projects
//   32969c16-… (a real decider, ZERO user_channel_prefs rows)        5 projects
// and on the approvals those rosters produced:
//   22560966-…   27 expired,  4 pending,  11 approved
//   32969c16-…    1 expired,  0 pending,   0 approved
// against the stream arm, which DOES go through the ladder and lands on a telegram
// address: 55 approved, 172 `telegram`/`sent` deliveries.
//
// So the ladder is not wrong and the ordering is not wrong — it is BYPASSED on the
// arm that carries the projects. 42 `inapp` deliveries marked `sent` on signoff
// approvals produced zero answers, which is the exact failure PUSH_CHANNELS exists
// to name.
//
// ⚠️ WHY THE ROSTER IS NEVER SHRUNK AND NEVER SUBSTITUTED. `handleUpdateApproval`
// finalises on `allDecisions.length === allRequiredApprovers.length`, so the roster's
// CARDINALITY is the gate's quorum. Filtering a 2-of-2 roster down to its one
// reachable member would silently convert it to a 1-of-1 — a weaker gate, arrived at
// by accident. So would REPLACING the roster with the ladder's single result, which is
// the same collapse wearing a different name: 2-of-2 named stakeholders become
// 1-of-1 addressed to a workspace-admin nobody named. Reachability is therefore a test
// on the roster as a WHOLE, and its only two outcomes are "honour it" and "refuse it".
// A ladder hit is a RESCUE (a reachable human is told the gate exists), never a
// replacement for the humans the project actually named.
//
// ⚠️ AND "UNREACHABLE" IS NOT THE SAME AS "UNKNOWN" — READ BEFORE TIGHTENING.
// `resolveRecipients` returning [] covers two opposite worlds:
//   • the user HAS enabled prefs and every one of them is passive (`inapp`/`websocket`)
//     — measured, definitive: this human cannot be pushed. That is the exec-operator
//     on 172 of the 177 `execution_signoff` rows, and it is the defect.
//   • the user has NO prefs row at all — we know NOTHING about them. There were 5
//     `user_channel_prefs` rows on the ENTIRE estate at 2026-08-18, so this is the
//     state of very nearly every real human in fr, including `32969c16-…`, who is a
//     real decider on 5 projects. Treating "never opted in to push" as proof of
//     unreachability would refuse essentially every roster in the system.
// Absence of evidence is therefore not evidence of unreachability, and only the first
// world can make a roster refuse.
// ---------------------------------------------------------------------------

export interface SignoffApproverPlan {
  /** The roster to write to `required_approvers`. Empty means: fail loud. */
  approverIds: string[];
  /** Where the roster came from. `null` when nobody at all could be found. */
  source: 'roster' | 'ladder' | null;
  /**
   * TRUE when the explicit roster was non-empty and EVERY member is measurably
   * unpushable — each one has enabled prefs and not one of them is a push channel.
   * This is the state that must never be silent: it is a named roster that can
   * never answer, which is a 24-hour timer wearing a gate's clothes. The caller
   * distinguishes it from an EMPTY roster because the two need different remedies
   * — seed a stakeholder vs. give the stakeholder a channel.
   *
   * It does NOT mean the roster was discarded. When it is true and `approverIds`
   * is non-empty, the roster was kept whole and a reachable human was found to
   * escalate to; when it is true and `approverIds` is empty, nobody exists at all
   * and the caller must refuse.
   */
  rosterUnreachable: boolean;
  /**
   * Humans to TELL about this gate who are not part of its quorum.
   *
   * Non-empty only on the rescue path: the roster is unpushable as a whole, so the
   * ladder's reachable human is notified so the gate is not silent — but they are
   * deliberately NOT written to `required_approvers`, because the people the
   * project named are the people whose decisions discharge it. Adding them would
   * inflate the quorum; replacing the roster with them would collapse it. Neither
   * is a routing decision this function is allowed to make.
   */
  escalationUserIds: string[];
  considered: ApproverResolution['considered'];
}

/**
 * How much we actually know about a roster member's reachability.
 *
 * `unknown` is NOT a soft `passive_only`: it is the absence of a measurement, and
 * it is the state of nearly every human in fr (5 `user_channel_prefs` rows on the
 * whole estate). It must never contribute to a refusal.
 */
export type RosterReachability = 'push' | 'passive_only' | 'unknown';

export async function classifyRosterMember(
  userId: string,
  tenantId?: string | null,
): Promise<{ verdict: RosterReachability; pushChannels: string[] }> {
  let recipients: Awaited<ReturnType<typeof resolveRecipients>>;
  try {
    recipients = await resolveRecipients(userId, tenantId);
  } catch (err) {
    // A prefs-store failure is not evidence about this human. Fail-closed here would
    // mean REFUSING to create the gate — stranding the card — on a transient read
    // error, so an unmeasurable member reads as `unknown` and the roster is honoured.
    //
    // ⚠️ NOTHING IS BEING FIXED HERE. This site is already correct: `unknown` is an
    // explicit third state that CARRIES the failure instead of laundering it into a
    // confident verdict, and the `[]` beside it is not a claim about the human (see
    // the RosterReachability docstring: `unknown` must never contribute to a
    // refusal). The only addition is operator telemetry.
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `roster member ${userId} classified unknown (prefs unreadable), roster honoured`,
    });
    return { verdict: 'unknown', pushChannels: [] };
  }
  const pushChannels = recipients.map((r) => r.channel).filter(deliverablePushChannel);
  if (pushChannels.length > 0) return { verdict: 'push', pushChannels };
  if (recipients.length > 0) return { verdict: 'passive_only', pushChannels: [] };
  return { verdict: 'unknown', pushChannels: [] };
}

/**
 * Decide who a sign-off approval is addressed to, given an explicit roster and the
 * tenant ladder.
 *
 * Pure with respect to the database: the roster arrives as ids and the ladder
 * arrives as a thunk, so the ORDER — the part that was wrong in production — is
 * provable without Postgres, exactly as `orderCandidates` is.
 *
 * Order:
 *  1. The explicit roster, WHOLE, unless every one of its members is measurably
 *     unpushable. An explicitly assigned human outranks any derived candidate,
 *     including the env fallback.
 *  2. When the roster IS measurably unpushable as a whole, the ladder
 *     (`resolveApprover`: workspace-admin → project owner → fallback) is consulted
 *     — as a RESCUE. Its hit becomes `escalationUserIds`; `approverIds` stays the
 *     roster. The ladder becomes the roster itself only when there is no roster at
 *     all (a stream) and the caller permits it.
 *  3. Nothing — and the caller must then refuse to create the approval.
 *
 * ⚠️ `allowLadderOnEmptyRoster` preserves an existing DELIBERATE decision: a PROJECT
 * with an empty sign-off roster is a loud configuration error and must stay one, so
 * the ladder must not paper over it. An unreachable roster is a different failure and
 * does get the ladder — because the alternative there is not a loud error, it is a
 * silent expiry.
 */
export async function planSignoffApprovers(input: {
  rosterUserIds: string[];
  ladder: () => Promise<ApproverResolution>;
  allowLadderOnEmptyRoster: boolean;
  /** The approval's tenant: a member's link pinned to another workspace does not reach them. */
  tenantId?: string | null;
}): Promise<SignoffApproverPlan> {
  const roster = [...new Set(input.rosterUserIds)];
  const considered: ApproverResolution['considered'] = [];

  let anyPushable = false;
  let anyUnmeasured = false;
  for (const userId of roster) {
    const { verdict, pushChannels } = await classifyRosterMember(userId, input.tenantId);
    if (verdict === 'push') anyPushable = true;
    if (verdict === 'unknown') anyUnmeasured = true;
    considered.push({
      userId,
      source: 'explicit',
      pushChannels,
      ...(verdict === 'passive_only'
        ? {
            rejected:
              'no enabled push channel (inapp/websocket alone cannot discharge a gate)',
          }
        : {}),
      ...(verdict === 'unknown'
        ? { rejected: 'no channel prefs at all — unmeasured, not proven unreachable' }
        : {}),
    });
  }

  // The roster can answer, or we cannot prove that it cannot. Either way it is the
  // gate: keep it WHOLE and do not consult the ladder at all. Consulting it here
  // would page a workspace-admin about a project whose named humans are fine.
  if (roster.length > 0 && (anyPushable || anyUnmeasured)) {
    return {
      approverIds: roster,
      source: 'roster',
      rosterUnreachable: false,
      escalationUserIds: [],
      considered,
    };
  }

  // Every member has prefs and every one of them is passive. This is the measured
  // production shape, and the only shape that may refuse.
  const rosterUnreachable = roster.length > 0;

  // An empty roster on a project stays a loud configuration error; it does not get
  // silently rescued by the tenant fallback.
  if (!rosterUnreachable && !input.allowLadderOnEmptyRoster) {
    return {
      approverIds: [],
      source: null,
      rosterUnreachable: false,
      escalationUserIds: [],
      considered,
    };
  }

  const ladder = await input.ladder();
  considered.push(...ladder.considered);

  if (!ladder.approver) {
    // Nobody on the roster and nobody in the whole tenant. Only HERE is the refusal
    // honest: there is no human anywhere who could discharge or even see this gate.
    return {
      approverIds: [],
      source: null,
      rosterUnreachable,
      escalationUserIds: [],
      considered,
    };
  }

  // ⛔ THE RESCUE IS NOT A REPLACEMENT — the defect this arm exists to NOT commit.
  // Returning `[ladder.approver.userId]` here reads as an improvement (the approval
  // is now addressed to someone who can be paged) and is a silent quorum collapse:
  // a 2-of-2 roster of named stakeholders becomes 1-of-1 held by a workspace-admin
  // the project never named, and `handleUpdateApproval` finalises the gate on that
  // one person's decision. The roster is honoured whole or refused whole; the
  // ladder's human is TOLD, and told is not the same as empowered.
  if (rosterUnreachable) {
    return {
      approverIds: roster,
      source: 'roster',
      rosterUnreachable: true,
      escalationUserIds: [ladder.approver.userId],
      considered,
    };
  }

  // No roster existed at all (a stream). The ladder IS the roster here — nothing is
  // being replaced, because nothing was named.
  return {
    approverIds: [ladder.approver.userId],
    source: 'ladder',
    rosterUnreachable: false,
    escalationUserIds: [],
    considered,
  };
}

// ---------------------------------------------------------------------------
// The triage seam.
// ---------------------------------------------------------------------------

export type TriageVerdict = 'escalate' | 'auto_approve' | 'auto_reject' | 'defer';

export interface TriageDecision {
  verdict: TriageVerdict;
  /** 'policy' while fr decides; 'worker:<name>' once a worker does. */
  actor: string;
  rationale: string;
}

const VALID_VERDICTS: ReadonlySet<string> = new Set([
  'escalate',
  'auto_approve',
  'auto_reject',
  'defer',
]);

/**
 * Normalise whatever the triager said into a verdict fr will obey.
 *
 * ⚠️ THIS FUNCTION IS THE FAIL-CLOSED GUARANTEE. Everything unknown becomes
 * `escalate`: a null verdict, an unreachable triager, a typo, a verdict from a future
 * schema this build has never heard of. Absence must never read as approval.
 *
 * That is George's "when in doubt use the human" expressed structurally instead of by
 * convention, and it is the same discipline the qa-verify-* oracles already use when
 * they abstain to `llm_judge` rather than fabricate a computational pass. The failure
 * mode it forbids is the expensive one: a triager that goes dark and, by going dark,
 * approves everything.
 */
export function resolveTriageVerdict(raw: unknown): TriageVerdict {
  if (typeof raw === 'string' && VALID_VERDICTS.has(raw)) return raw as TriageVerdict;
  return 'escalate';
}

/**
 * Decide whether a human must be bothered.
 *
 * TODAY THIS IS A PURE PASS-THROUGH — it always returns `escalate`, so landing it
 * cannot change a single approval outcome. The seam exists so that when the GPUs and
 * model quality are there (George 2026-08-18), a single-inference n8n worker can
 * pre-filter requests WITHOUT anyone having to re-open the write path of a live gate.
 *
 * When that worker lands it stays inside P-SYS-12: one inference, one schema-enforced
 * verdict, dispatched by the n8n graph — never a tool-use loop inside the model. fr's
 * job is only to store the verdict, obey it, and record who issued it.
 *
 * And whatever decides — worker or human — the outcome becomes a Decision record
 * (P-SYS-03: "every approval outcome … becomes a decision"). That is not bookkeeping:
 * it makes the triager a governed asset with `exec_quality` rows, so the existing
 * meta_prompt loop can grade and improve it exactly like any other asset, and so an
 * auto-approval is as auditable as one George typed himself.
 */
export async function triageApproval(_input: {
  tenantId: string;
  cardId?: string | null;
  description: string;
}): Promise<TriageDecision> {
  return {
    verdict: 'escalate',
    actor: 'policy',
    rationale:
      'No triage worker is wired; every approval goes to a human. Fail-closed default.',
  };
}


/**
 * confirmPushDelivery — stamp `notified_at` iff a PUSH channel actually accepted the
 * request, and leave it NULL otherwise.
 *
 * ⚠️ WHY THIS IS SHARED AND NOT INLINE. It used to be inline in ONE of the two places
 * that create an approval. `handleN8nCardApproval` (kind `generic`) ran it;
 * `createExecutionApproval` (kind `execution.ready_signoff`) never did — it fanned out
 * fire-and-forget and returned. So EVERY signoff approval carried `notified_at = NULL`
 * by construction, whether or not Telegram took it.
 *
 * That is not a cosmetic gap, because `workers/approval-expiry.ts` reads exactly this
 * column to decide which of two very different failures a row records, and writes:
 *
 *   "expired: NOBODY WAS EVER NOTIFIED … this is a routing failure, not an unanswered
 *    request; re-raise it"
 *
 * Measured on prod 2026-08-24: approvals `2c06f00a` and `c39185fb` (both signoff) had
 * `notified_at IS NULL` while `engagement_deliveries` held `channel='telegram',
 * status='sent'` rows for both. They WERE delivered. The expiry worker would have
 * blamed a routing failure it never checked, and any re-raise sweep keyed on
 * `notified_at` would re-page a human who had already been paged.
 *
 * The check is a MEASUREMENT, never an intention: an `inapp` row marked `sent` is not a
 * human being told (43 such rows produced 0 answers), so only PUSH_CHANNELS count, and
 * a failure to CONFIRM leaves the column NULL rather than optimistically stamping it.
 *
 * @returns true iff a push-channel delivery was confirmed AND the stamp was written.
 */
export async function confirmPushDelivery(
  approvalId: string,
  context: string,
): Promise<boolean> {
  try {
    const delivered = await db
      .select({ channel: engagementDeliveries.channel, status: engagementDeliveries.status })
      .from(engagementDeliveries)
      .where(
        and(
          eq(engagementDeliveries.engagement_id, approvalId),
          eq(engagementDeliveries.status, 'sent'),
          inArray(engagementDeliveries.channel, [...PUSH_CHANNELS]),
        ),
      );
    if (delivered.length === 0) {
      console.error(
        `[${context}] approval ${approvalId} reached NO push channel — it will expire ` +
          'unread unless escalated',
      );
      return false;
    }
    await db
      .update(approvals)
      .set({ notified_at: new Date() })
      .where(eq(approvals.id, approvalId));
    return true;
  } catch (err) {
    // Leave notified_at NULL. Failing to CONFIRM delivery must read as "nobody was
    // told", never as "told" — the sweep can then re-escalate.
    console.error(`[${context}] delivery confirmation failed:`, err);
    return false;
  }
}
