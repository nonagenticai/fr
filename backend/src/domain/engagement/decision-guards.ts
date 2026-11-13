// src/domain/engagement/decision-guards.ts
//
// PURE decision-integrity predicates shared by every path that writes an
// `approval_decisions` row: `routes/approvals.ts` (the HTTP seat),
// `routes/teams-webhook.ts` and `routes/telegram-webhook.ts`. This file is the
// `domain/engagement/deblock-actions.ts`
// precedent (#1107, `answerlessApproveDemand`) applied to two MORE rules that were
// drifting the same way: one path had a rule, three did not, or four had four
// slightly different copies.
//
// ⛔ NO db, NO request, NO clock beyond what the caller passes in — every function
// here takes plain values and returns a plain verdict, so it can be pinned by a unit
// test without Postgres and cannot itself develop a fifth copy of a rule.

/**
 * Would recording THIS decider's decision close the gate on the person who
 * RAISED the approval?
 *
 * ⛔ WHY THIS IS A SHARED PREDICATE AND NOT A COPIED `===`. `routes/teams-webhook.ts`
 * (#…, `APPROVER_IS_REQUESTER`) has enforced this since before this file existed — its
 * own comment states the reasoning precisely: "attributing a decision to the person who
 * RAISED the request lets a caller record an approval under an identity that never acted
 * (self-approval / spoofing)". `routes/telegram-webhook.ts` never enforced it at all,
 * and it resolves a decider identity by exact `user_id` match against the roster
 * (`findApproverByTelegramId`) — so the gap is real
 * whenever a requester is ALSO listed as (or role-matches into) a required approver and
 * happens to be registered on that channel. That is not a hypothetical unauthenticated-
 * payload risk like Teams' `approverId` field; it is the same conflict-of-interest concern
 * on an authenticated identity, which is exactly why it belongs in the shared predicate
 * rather than staying Teams-only prose.
 *
 * ⚠️ `null`/`undefined` `requesterId` never matches. A cardless / requester-less approval
 * (n8n / KAG worker ingest — see `routes/approvals.ts :: loadReachableApproval`) has no
 * requester to protect against, and a predicate that treated "unknown requester" as "is the
 * requester" would refuse a decider it has no evidence against.
 */
export function isRequesterDecidingOwnApproval(
  requesterId: string | null | undefined,
  deciderId: string,
): boolean {
  return requesterId != null && requesterId === deciderId;
}

/**
 * Was this approval raised by the SYSTEM (the conveyor / an n8n producer) rather than
 * by the human named in `requester_id`?
 *
 * ⭐ P1-TEAM-b INVARIANT (George 2026-10-15): "A human may not decide an approval THEY
 * requested. But conveyor/system-raised rows whose `requester_id` defaults to the owner
 * must NOT lock the owner out. The requester of a conveyor-raised row is the system, not
 * the owner." Every n8n producer route (`routes/webhooks.ts` approval-request and
 * card-approval, `routes/execution-approvals.ts`, the outline minter in
 * `routes/project-request-lifecycle.ts`) writes `source = 'n8n'` and DEFAULTS
 * `requester_id` to the project owner (or the request's creator) — nobody in that
 * `requester_id` asked for anything. Every human-raised row writes `source = 'web'`
 * (`POST /api/approvals`, the bridge submit) or is an action approval.
 *
 * ⛔ `action_id == null` IS LOAD-BEARING, NOT DECORATION. An ACTION approval
 * (`domain/engagement/action-approvals.ts`) writes `source = ctx.channel`, and the
 * channel comes from the CALLER's `X-Channel` header — a human could send
 * `X-Channel: n8n` and make their own request read as system-raised. Every action
 * approval carries `action_id`, so it is never system-raised here, whatever its source.
 *
 * ⚠️ FAIL CLOSED: an unknown / NULL source is a HUMAN-raised row (the guard applies), and
 * so is an n8n-source row minted with a person's Keycloak JWT (`metadata.requested_via =
 * 'jwt'`, see below).
 */
export function isSystemRaisedApproval(approval: {
  source?: string | null;
  action_id?: string | null;
  metadata?: unknown;
}): boolean {
  if (approval.source !== 'n8n') return false;
  if (approval.action_id != null && approval.action_id !== '') return false;
  // ⛔ A KEYCLOAK-JWT MINT IS A HUMAN'S REQUEST. `POST /api/execution/approvals` writes
  // `source = 'n8n'` on BOTH bearer lanes, and stamps `metadata.requested_via` server-side
  // AFTER the caller's metadata spread (unforgeable): 'licence' for the tenant's conveyor
  // seat, 'jwt' for a person. A JWT-minted row keeps the requester guard exactly as it was
  // before P1-TEAM-b — otherwise an owner could raise their own sign-off with their token
  // and decide it themselves.
  const md = approval.metadata;
  if (md && typeof md === 'object' && !Array.isArray(md)) {
    if ((md as Record<string, unknown>).requested_via === 'jwt') return false;
  }
  return true;
}

/**
 * P1-TEAM-b — may the 1-of-any TENANT-MEMBER arm even be considered for this caller on
 * this row? PURE; the membership read itself (`isTenantMemberForDecision`, fail closed)
 * runs only when this is true. Mirrored term-for-term by the frontend's
 * `$lib/approvals/tenantMemberArm.ts :: tenantMemberArmApplies` (parity-pinned by
 * `tests/unit/lib/tenant-member-arm-parity.test.ts`).
 *
 *   - NOT the super-admin arm (that one already widened, in a platform tenant);
 *   - the caller matched NO roster row on their own (named, or a held role) — a caller
 *     who did keeps exactly their candidate set, so no existing decision moves;
 *   - the roster is NON-EMPTY: an empty roster has no obligation to discharge;
 *   - the approval's tenant IS the caller's request tenant: the super-admin home-view READ
 *     relaxation must never become a WRITE in a tenant the caller is not acting in;
 *
 * ⭐ ACTION approvals (`approvals.action_id` set) take this arm too since P1-TEAM-c
 * (George 2026-10-15): "any member may approve, but the action then runs under the
 * APPROVER's identity, not the requester's". That is safe ONLY because
 * `resolvePendingAction` executes the parked action AS THE DECIDER (their user id, their
 * fresh membership, their RBAC; no fallback to the requester) — so a member B approving
 * A's request never executes anything AS A.
 */
export function tenantMemberArmPrecondition(input: {
  approvalTenantId: string | null | undefined;
  callerTenantId: string | null | undefined;
  callerMatchedARosterRow: boolean;
  rosterSize: number;
  superAdminDecider: boolean;
}): boolean {
  return (
    !input.superAdminDecider &&
    !input.callerMatchedARosterRow &&
    input.rosterSize > 0 &&
    typeof input.approvalTenantId === 'string' &&
    input.approvalTenantId.length > 0 &&
    input.approvalTenantId === input.callerTenantId
  );
}

/**
 * The self-decision guard's real subject: the HUMAN who raised this row is deciding it.
 * `isRequesterDecidingOwnApproval` on a human-raised row; never on a system-raised one
 * (whose `requester_id` names the owner it was defaulted to, not someone who asked).
 * The one predicate all three decide seats call (`routes/approvals.ts`, Teams, Telegram)
 * — so the owner keeps deciding conveyor sign-offs on every seat.
 */
export interface RequesterGuardApproval {
  requester_id?: string | null;
  source?: string | null;
  action_id?: string | null;
  metadata?: unknown;
}

export function isHumanRequesterDecidingOwnApproval(
  approval: RequesterGuardApproval,
  deciderId: string,
): boolean {
  if (isSystemRaisedApproval(approval)) return false;
  return isRequesterDecidingOwnApproval(approval.requester_id, deciderId);
}

/**
 * WHICH roster obligation does THIS decision discharge?
 *
 * ⛔ WHY THIS IS A SHARED FUNCTION. `routes/approvals.ts :: handleUpdateApproval` picks
 * this (migration 108, #923) with a deliberate preference order — see its own comment for
 * the full argument — and until now it was the ONLY path that recorded the answer at all;
 * the three chat seats insert `approval_decisions` with no `required_approver_id`, so every
 * chat-seat decision reads as "pre-108, unknown" for ever, and `handleUpdateApproval`'s own
 * quorum falls back to a bare row-count comparison whenever ANY decision on the approval is
 * one of those NULLs — silently degrading exactly the quorum-precision #923 was written to
 * restore, on every approval a chat seat ever touches.
 *
 * Order of preference (fr#1237 inserted rung 2; the others are as
 * `routes/approvals.ts` has always had them):
 *   1. a row that names this caller directly — the strongest claim;
 *   2. an undischarged row asking for a ROLE THIS CALLER ACTUALLY HOLDS — see the
 *      ordering note below for why this outranks rung 3;
 *   3. any row not already discharged by an earlier decision — so N distinct deciders
 *      cover N distinct roster rows instead of two of them racing the same one;
 *   4. an already-discharged row — cannot happen today (a caller may decide an approval
 *      once), but is a defined answer rather than `undefined`.
 *
 * ⛔ EVERY RUNG RESOLVES OVER A TOTALLY ORDERED SET, AND THAT IS THE fr#1237 FIX. Each
 * rung used to be a bare `.find()` (and rung 4 a bare `[0]`) over `candidateRosterRows`
 * EXACTLY as the caller passed it — which for all four seats is an unordered
 * `db.select()` with no `ORDER BY`. Postgres is free to return those rows in any order
 * (and does change it after a heap rewrite — VACUUM FULL, a CLUSTER, or a plan flip to a
 * bitmap scan), so on a roster with two rows a caller could match, WHICH obligation got
 * recorded in `approval_decisions.required_approver_id` was not a decision anyone made.
 * That column is load-bearing for the #923 quorum, and this site's own comment in
 * `routes/approvals.ts` says so: "Picking the first match would let TWO role-holders both
 * discharge the SAME roster row, leaving a second obligation silently unmet while the
 * approval looked complete."
 *
 * ⚠️ THE OPERATOR'S RULING WAS "`ORDER BY created_at, id`", AND `created_at` DOES NOT
 * EXIST ON THIS TABLE. Measured on `db/schema.ts:1376-1385`: `required_approvers` has
 * exactly `id`, `tenant_id`, `approval_id`, `user_id`, `role` — no timestamp of any kind
 * (positive control: the adjacent `project_stakeholders` at :1392 does carry `added_at`,
 * so the absence is a measurement, not a failed grep). So INSERTION ORDER IS
 * UNRECOVERABLE for this table and no sort can restore it; `id` is the only deterministic
 * key it has. `created_at` is still read FIRST when a row carries one, because this
 * function is generic and a caller with a timestamped roster should get the ruling's
 * intended order — but do not read that branch as "this is ordered by creation time":
 * on today's `required_approvers` every row takes the `id` path. ⛔ If insertion order is
 * ever actually needed, that is a MIGRATION adding the column, not a change here.
 *
 * ⚠️ WHY RUNG 2 OUTRANKS RUNG 3, in the operator's words: prefer the obligation naming a
 * role the acting user actually holds.
 *
 * ⛔ THREE DIFFERENT ROLE VOCABULARIES EXIST IN THIS CODEBASE AND RUNG 2 COMPARES TWO OF
 * THEM. An earlier revision of this docblock named the THIRD one, which would lead a
 * reader to conclude rung 2 can never fire and delete it as dead code. Name them:
 *
 *   (a) `callerRoles` — the **Keycloak realm claim** (`realm_access.roles`, put on the
 *       request by `middleware/auth.ts`). Open vocabulary, signed by Keycloak, NOT
 *       constrained by any database CHECK. `routes/approvals.ts:2210` names
 *       `card_approver` and `execution_signoff` as two realm roles that live in it.
 *   (b) `r.role` — **`required_approvers.role`**, plain nullable TEXT
 *       (`db/schema.ts:1384`, comment: "tech_lead, manager, owner, etc."). MEASURED on
 *       production `fr` 2026-09-27: `card_approver` 3730, `execution_signoff` 915,
 *       `reviewer` 2, `outline_approver` 2, `action_approver` 1 — five values, no enum.
 *   (c) `user_roles.role` — CHECK-constrained to `workspace-admin` / `workspace-member`
 *       by migration 104 (`db/schema.ts:1916`). **NEITHER OPERAND OF RUNG 2.** It is the
 *       workspace-membership table `soloTenantMemberIsTenantGod` counts, nothing more.
 *
 * ⇒ RUNG 2 COMPARES (a) AGAINST (b): "does the realm claim this caller presented contain
 * the free-text role string this roster row asks for". (c) never enters. Measured
 * control on the same instance: the intersection of `required_approvers.role` with
 * `user_roles.role` is **0 rows** (non-zero control: `user_roles` holds 13 rows,
 * `workspace-admin` 12 / `workspace-member` 1, so the query discriminates) — i.e. if (c)
 * WERE an operand, rung 2 would be provably dead. It is not an operand, and rung 2 CAN
 * fire: a super-admin whose realm claim includes `card_approver` or `execution_signoff`
 * matches roster rows asking for exactly those.
 *
 * Rung 2 still changes nothing for a caller holding no roles, which is every chat seat:
 * they pass no roles at all (see the `callerRoles` note below).
 *
 * ⚠️ WHERE IT CHANGES BEHAVIOUR TODAY: NOWHERE, AND THAT IS A MEASUREMENT, NOT A
 * JUSTIFICATION. Rung ordering can only matter when a caller has TWO OR MORE candidate
 * rows to choose between. Measured on production `fr` 2026-09-27 over the WHOLE
 * `approvals` table (4,889 rows): roster size 0 → 240 approvals, 1 → 4,648, **2 → 1**
 * (`e65772e0-6bee-467b-93ba-55512fe3d6e5`, created 2026-07-05, `voided`, two distinct
 * users both asking `execution_signoff`). Of the 3 rows `pending` at that moment, all 3
 * had a roster of exactly 1. With one candidate every rung returns the same row. Two
 * further reasons rung 2 cannot bite even on a 2-row roster: for the non-super-admin HTTP
 * seat the candidates ALREADY came from `approverIdentityFilter` (user_id OR a held
 * role), so every role row in the set is one the caller holds and rung 2 ≡ rung 3; and
 * the three chat seats narrow to `user_id === approver` (`teams-webhook.ts:541`), so rung
 * 1 always wins. ⇒ Do not present this ordering as a live nondeterminism anyone has
 * observed. It is correct, and it is currently unexercised — and it must stay, because
 * the whole point is that the NEXT 2-row roster must not depend on heap order.
 *
 * ⚠️ `candidateRosterRows` MUST already be narrowed to rows this decider identity is
 * entitled to discharge — this function does not re-run that authorization check. The HTTP
 * seat's candidates come from `approverIdentityFilter` (user_id OR a held role); the chat
 * seats' candidates come from an exact `user_id` match only (their identity resolution
 * carries no verifiable role claim — see `teams-webhook.ts`'s own comment on why its roster
 * match is user_id-only). Passing an unnarrowed roster here would let this function assign a
 * decision to an obligation the caller was never authorized to discharge.
 *
 * Returns `undefined` for an empty candidate set — the empty-roster / card-approval shape,
 * where there is no roster row to discharge and `required_approver_id` stays NULL, exactly
 * as every path already behaves for that shape today.
 */
export interface DischargeCandidateRow {
  id: string;
  user_id: string | null;
  /** The role the obligation asks for, when it asks for one rather than naming a user. */
  role?: string | null;
  /**
   * OPTIONAL BECAUSE THE TABLE THIS IS CALLED WITH HAS NO SUCH COLUMN. See the
   * `ORDER BY created_at, id` note above: on `required_approvers` this is always
   * `undefined` and the order degrades to `id`. It is read when present so a caller
   * with a timestamped roster gets the ruling's intended order.
   */
  created_at?: Date | string | null;
}

/**
 * The sort key for one row: its creation instant, or `+Infinity` when it has none.
 *
 * `+Infinity` is NULLS LAST, which is what `ORDER BY created_at` does in Postgres for an
 * ascending sort — so a roster that is PARTLY timestamped sorts the same way here as it
 * would in the database, rather than putting the unknown rows first. An unparseable
 * string is treated as absent for the same reason: it is not evidence of a time.
 */
function createdAtKey(value: Date | string | null | undefined): number {
  if (value == null) return Number.POSITIVE_INFINITY;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * `ORDER BY created_at, id` — TOTAL, so the result never depends on the input order.
 *
 * ⚠️ It must be total, not merely "stable enough": `Array.prototype.sort` is stable, so a
 * comparator returning 0 for two distinct rows would silently fall back to the unordered
 * database order this function exists to stop depending on. The `id` tie-break is what
 * makes that unreachable.
 */
function compareDischargeCandidates(a: DischargeCandidateRow, b: DischargeCandidateRow): number {
  const ka = createdAtKey(a.created_at);
  const kb = createdAtKey(b.created_at);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function selectDischargedRosterRow<T extends DischargeCandidateRow>(
  candidateRosterRows: readonly T[],
  priorDecisions: readonly { required_approver_id: string | null }[],
  callerUserId: string,
  /**
   * The realm roles this caller HOLDS, for rung 2.
   *
   * ⛔ DEFAULTS TO NONE, AND THE DEFAULT IS THE CORRECT VALUE FOR THE CHAT SEATS.
   * `teams-webhook.ts` and `telegram-webhook.ts` resolve a decider by exact `user_id`
   * match and carry NO verifiable role claim (their own
   * comments say so, and `approval-roster-lane.ts:46-50` says the roster read must not
   * inherit changes to a different question) — so they must not be handed roles, and
   * omitting the argument is how they say that. Only the HTTP seat, whose candidates came
   * from `approverIdentityFilter` (user_id OR a held role), passes `user.roles`.
   */
  callerRoles: readonly string[] = [],
  /**
   * ⛔ fr#1059 (correct under EITHER reading of a roster row — "requires that person" or "a
   * slot any holder of its role may fill"): a caller who is NEITHER named on a row NOR holds
   * the role it asks for may discharge it ONLY through an explicit override arm — the HTTP
   * seat's super-admin arm and its solo-tenant arm (fr#1220), both of which widen the
   * candidate set on purpose and say so. Every other caller gets `undefined` and the seat
   * refuses. This used to be the unconditional `undischarged[0] ?? ordered[0]` tail, which
   * let ANY candidate set — however it was built — discharge an obligation the caller has
   * no claim to.
   */
  opts: { override?: boolean } = {},
): T | undefined {
  const alreadyDischarged = new Set(
    priorDecisions
      .map((d) => d.required_approver_id)
      .filter((id): id is string => Boolean(id)),
  );
  // ⚠️ A COPY. `candidateRosterRows` is `readonly` and callers reuse it (the HTTP seat
  // re-reads it for the quorum tally); sorting in place would reorder a caller's array as
  // a side effect of asking a question about it.
  const ordered = [...candidateRosterRows].sort(compareDischargeCandidates);
  const undischarged = ordered.filter((r) => !alreadyDischarged.has(r.id));
  const asksForARoleTheCallerHolds = (r: T): boolean =>
    r.role != null && r.role !== '' && callerRoles.includes(r.role);
  const namesCaller = (r: T): boolean => r.user_id === callerUserId;
  // Rung 1 prefers an UNDISCHARGED row naming the caller: a caller named on two rows, one
  // of which an override arm already took, lands on their open one (P1-TEAM-b audit).
  const claimed =
    undischarged.find(namesCaller) ??
    ordered.find(namesCaller) ??
    undischarged.find(asksForARoleTheCallerHolds);
  if (claimed) return claimed;
  if (!opts.override) return undefined;
  // ⚠️ An override (a tenant member, a super-admin, the solo tenant) is named on NO row, and
  // `required_approvers.user_id` is NOT NULL, so it necessarily takes a row that names
  // someone else. That named approver is NOT moved off their own row later (a chat seat
  // carries no evidence for any other row): `evaluateRosterQuorum` counts an override's
  // decision as a fungible stand-in instead, so both decisions still count.
  return undischarged[0] ?? ordered[0];
}
