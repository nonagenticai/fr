// src/services/approval-consensus.ts
// Channel-agnostic consensus logic for approvals.
// Given the current set of recorded decisions and the required approvers,
// decide whether the approval as a whole is now approved / rejected /
// still pending. Pure TypeScript — no DB writes, no fetch, no side effects.
//
// Callers own persistence: they write the new decision, then pass the full
// list of decisions + required approvers into evaluateConsensus(). This keeps
// the math identical across transport channels (Telegram, Teams, future ones).

export type ConsensusStatus = 'pending' | 'approved' | 'rejected';

/** A single approver's recorded decision. */
export interface ApproverDecision {
  approver_id: string;
  decision: 'approved' | 'rejected';
  decided_at?: Date;
  comment?: string | null;
}

/** A required approver for a multi-party approval. */
export interface RequiredApprover {
  user_id: string;
}

/** The result of evaluating consensus. */
export interface ConsensusResult {
  status: ConsensusStatus;
  /** When status transitioned to a terminal value (approved/rejected). */
  decisionAt?: Date;
  /** approver_id whose decision tipped consensus (or caused rejection). */
  decidedBy?: string;
}

/**
 * Deduplicate decisions by approver_id — the earliest decision per approver
 * wins. This mirrors the channel webhooks' idempotency semantics where a
 * duplicate vote from the same approver is rejected before it reaches
 * consensus evaluation, but belt-and-suspenders here for safety.
 */
export function dedupeDecisions(decisions: ApproverDecision[]): ApproverDecision[] {
  const seen = new Map<string, ApproverDecision>();
  for (const d of decisions) {
    const existing = seen.get(d.approver_id);
    if (!existing) {
      seen.set(d.approver_id, d);
      continue;
    }
    const existingTs = existing.decided_at?.getTime() ?? Number.POSITIVE_INFINITY;
    const incomingTs = d.decided_at?.getTime() ?? Number.POSITIVE_INFINITY;
    if (incomingTs < existingTs) {
      seen.set(d.approver_id, d);
    }
  }
  return Array.from(seen.values());
}

/**
 * Evaluate the consensus for an approval given the full list of decisions
 * already recorded and the required approvers.
 *
 * Semantics (mirrors the legacy channel-webhook logic):
 *   - ANY rejection → immediately rejected (first rejecter decides).
 *   - If requiredApprovers is non-empty → all must approve.
 *   - If requiredApprovers is empty → any single approval completes
 *     (card-approval flow).
 *   - Otherwise → pending.
 */
export function evaluateConsensus(
  decisions: ApproverDecision[],
  requiredApprovers: RequiredApprover[],
): ConsensusResult {
  const deduped = dedupeDecisions(decisions);

  const rejection = deduped.find((d) => d.decision === 'rejected');
  if (rejection) {
    return {
      status: 'rejected',
      decisionAt: rejection.decided_at,
      decidedBy: rejection.approver_id,
    };
  }

  if (requiredApprovers.length > 0) {
    const approvedIds = new Set(
      deduped.filter((d) => d.decision === 'approved').map((d) => d.approver_id),
    );
    const allApproved = requiredApprovers.every((r) => approvedIds.has(r.user_id));
    if (allApproved) {
      // Pick the latest approval timestamp as decisionAt, that approver as decidedBy.
      const approvals = deduped.filter((d) => d.decision === 'approved');
      const last = approvals.reduce<ApproverDecision | undefined>((acc, d) => {
        if (!acc) return d;
        const accTs = acc.decided_at?.getTime() ?? 0;
        const dTs = d.decided_at?.getTime() ?? 0;
        return dTs >= accTs ? d : acc;
      }, undefined);
      return {
        status: 'approved',
        decisionAt: last?.decided_at,
        decidedBy: last?.approver_id,
      };
    }
    return { status: 'pending' };
  }

  // Card-approval flow: any single approval completes.
  const firstApproval = deduped.find((d) => d.decision === 'approved');
  if (firstApproval) {
    return {
      status: 'approved',
      decisionAt: firstApproval.decided_at,
      decidedBy: firstApproval.approver_id,
    };
  }

  return { status: 'pending' };
}

/** One roster obligation (a `required_approvers` row). */
export interface RosterObligation {
  id: string;
  /** The user the row names. */
  user_id?: string | null;
  /** The role the row asks for — a free-text label (`execution_signoff`, `card_approver`, …). */
  role?: string | null;
}

/** One recorded decision, with WHICH obligation it discharged (migration 108). */
export interface RosterDecision {
  decision: 'approved' | 'rejected' | string;
  /** NULL only on pre-108 decisions, which cannot say which obligation they met. */
  required_approver_id: string | null;
  /** Who decided. Absent ⇒ treated as the row's own named user (the conservative reading). */
  approver_id?: string | null;
}

/**
 * ⭐ THE ONE QUORUM RULE, for every decision seat (HTTP, Telegram, Teams) — fr#1059,
 * George's ruling 2026-10-03 ("role slot"): a roster row is an OBLIGATION, discharged by the
 * user it names or by any holder of the role it asks for (WHO may record against WHICH row is
 * the picker's rule, `selectDischargedRosterRow`). Quorum asks one question — is every
 * obligation discharged? — never "did every NAMED user decide", which is what the chat seats
 * used to ask (`evaluateConsensus`) and which split-brained against the web seat.
 *
 * ⚠️ SLOTS OF ONE ROLE ARE FUNGIBLE, SO QUORUM IS A MATCHING, NOT A LOOKUP. A decision by a
 * caller NOT named on the row it was recorded against (a role-holder, or an explicit override)
 * discharges "one obligation of that row's role", not that row in particular: which same-role
 * row the picker happened to hand it depended only on id order. A decision by the row's own
 * named user discharges exactly that row. So rows A and B both asking role R: X (holds R)
 * recorded on B, then B's own decision (recorded on B) → B fixed, X fills A → approved,
 * whichever row sorted first. Computed from STORED rows and decisions alone, so every seat
 * gives the same answer for the same data, and no chat user is ever moved onto a row that
 * does not name them (the chat seats carry no role evidence). UNIQUE (approval_id,
 * approver_id) — migration 157 — keeps every person to one slot.
 *
 *   - ANY rejection → rejected (unchanged on every seat).
 *   - EMPTY roster → any single approval completes (the chat seats' card-approval flow; the
 *     HTTP seat refuses an empty roster before it gets here).
 *   - any PRE-108 decision (required_approver_id NULL) → the old count comparison, so no
 *     historical row becomes uncompletable (unchanged from the HTTP seat).
 *   - otherwise → approved iff every row is either discharged by its own named user, or covered
 *     by a fungible stand-in decision of its role (role-less rows form one pool of their own —
 *     P1-TEAM-b audit: an override stand-in on a role-less row no longer strands its named user).
 */
export function evaluateRosterQuorum(
  rows: readonly RosterObligation[],
  decisions: readonly RosterDecision[],
): ConsensusStatus {
  if (decisions.some((d) => d.decision === 'rejected')) return 'rejected';
  const approved = decisions.filter((d) => d.decision === 'approved');
  if (approved.length === 0) return 'pending';
  if (rows.length === 0) return 'approved';
  if (approved.some((d) => !d.required_approver_id)) {
    return approved.length === rows.length ? 'approved' : 'pending';
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const filled = new Set<string>();
  // Keyed by the row's role; ROLELESS ('') is the pool of role-less rows.
  const fungibleByRole = new Map<string, number>();
  const ROLELESS = '';
  const roleKey = (row: RosterObligation): string => (row.role ? row.role : ROLELESS);
  for (const d of approved) {
    const row = rowById.get(d.required_approver_id as string);
    if (!row) continue;
    // ⛔ P1-TEAM-b audit: a stand-in on a ROLE-LESS row is fungible too. Only an OVERRIDE
    // arm (a tenant member, a super-admin, the solo tenant) can record against a role-less
    // row it is not named on — nobody holds a role it does not ask for — and the override
    // could have taken ANY open row: which one it got was id order. Counting it as THAT
    // row's discharge used to strand the row's named approver: their own decision landed on
    // the same row, counted for nothing, and a second role-less obligation stayed open for
    // ever. As a fungible role-less slot it fills whichever role-less row is still unmet.
    const standIn = Boolean(d.approver_id) && d.approver_id !== row.user_id;
    if (standIn) {
      fungibleByRole.set(roleKey(row), (fungibleByRole.get(roleKey(row)) ?? 0) + 1);
    } else {
      filled.add(row.id);
    }
  }
  for (const row of rows) {
    if (filled.has(row.id)) continue;
    const spare = fungibleByRole.get(roleKey(row)) ?? 0;
    if (spare === 0) return 'pending';
    fungibleByRole.set(roleKey(row), spare - 1);
  }
  return 'approved';
}
