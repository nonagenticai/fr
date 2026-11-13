// src/lib/approval-answerability.ts
//
// ⛔ WHAT THIS DECIDES: whether an approval about to be minted is ANSWERABLE BY
// CONSTRUCTION — i.e. whether any human, given unlimited goodwill, could ever
// discharge it.
//
// This is the third member of a family that already exists in this repo and is
// deliberately named as such, because each member refuses a DIFFERENT shape of
// dead gate and they are easy to confuse:
//
//   * `classifyUndecidableReason` (lib/approval-rationale.ts) refuses an
//     approval whose REASON carries no proposition — "No reason provided", a
//     laundered worker crash. The question is unanswerable because of what it
//     SAYS.
//   * `resolveApprover` (domain/engagement/approval-routing.ts) refuses an
//     approval nobody can be TOLD about — no reachable push channel.
//   * `classifyDeblockExit` (domain/engagement/deblock-actions.ts) refuses an
//     approval whose answer DOES NOTHING.
//
// This one refuses an approval whose ROW cannot carry an answer: no resolvable
// requester, an approver who is not a member of the row's own tenant, no
// deadline the reaper can ever match, or no statement of what is being asked.
//
// ── THE MEASUREMENT (prod primary, read-only, 2026-09-26) ─────────────────────
// ⚠️ Read the denominator before the numerator. The ~1,279-row pending queue
// the fr issues (#1057/#1072/#1073/#1102/#1103/#1139/#1140) describe NO LONGER
// EXISTS — it was drained 2026-09-22 (1,032 rows voided, owner-approved) and
// pending is now 5. Those issues describe a POPULATION that is gone. What is
// still live is the PRODUCERS, so every number below is a 7-day production
// rate, not a backlog:
//
//   producer (source='n8n')                       7d rows   measured defect
//   generic / kanban/approval-callback              106      requester_source
//                                                            ='unattributable' 105,
//                                                            requester_id NULL 105,
//                                                            approver_source='fallback' 105,
//                                                            approver NOT a member of the
//                                                            row's own tenant 105
//   project_outline.approval / no callback_path       2      BOTH expires_at IS NULL,
//                                                            BOTH lack card_type AND
//                                                            gate_terms
//   execution.ready_signoff                           9      tenant_id disagrees with its
//                                                            own metadata.policy_key
//
// ⛔ NO BACKFILL, NO REPAIR, NO MIGRATION. The operator's standing rule is that
// historical rows are disposable; what gets fixed is the code path. Nothing in
// this module or its callers reads, rewrites or reasons about an existing row.
//
// ── WHY THIS SHIPS IN OBSERVE MODE ───────────────────────────────────────────
// ⭐ A default-refuse here would be a fleet-wide outage, not a fix. On the
// measured rates the approver arm alone refuses 105 of 106 `generic` mints, so
// flipping enforcement on today stops the conveyor for every card that reaches
// BLOCKED. The estate already has the right pattern for this —
// `coding-github`'s platform-tenant gate shipped OBSERVE-first behind
// `CODING_GITHUB_PLATFORM_TENANT_ENFORCE` and was enforced only after a clean
// window — and this follows it verbatim:
//
//   default   = observe: mint exactly as today, count the reason, log one
//               structured line naming the approval and the producer kind;
//   enforce   = refuse, with the reason named back to the producer.
//
// ⚠️ AND THE COUNTER IS NOT DECORATION ON THE OBSERVE ARM — IT IS THE WHOLE
// DELIVERABLE UNTIL THE FLAG FLIPS. `fr_approval_answerability_total` is what
// says whether the approver arm has stopped firing, and therefore whether
// `enforce` can be turned on at all. Flipping the flag while
// `reason="approver_foreign_tenant"` is still climbing converts a silent defect
// into a visible outage; that is a worse trade, not a braver one. The remedy
// for THAT arm is not in fr at all — it is either an
// `APPROVAL_FALLBACK_APPROVER_USER_ID` who is a member of the tenants that
// raise approvals, or reachable workspace-admins for those tenants. See
// `resolveApprover`'s ladder.
//
// ── WHAT THIS MODULE MUST NEVER DO ───────────────────────────────────────────
// ⛔ FABRICATE. `lib/approval-rationale.ts` states the rule for the rationale
// columns — "fr NEVER writes a rationale it was not given" — and it applies
// here unchanged and for the same reason. A `card_type` invented from an
// adjacent field, or a `requester_id` set to whatever human happened to be
// nearby, makes the row LOOK answerable to the approver while attesting to
// something fr does not know. That is strictly worse than the empty field,
// because the empty field at least stops a human from deciding.
//
// So the resolution ladder in `domain/approvals/one-open-gate.ts` derives ONLY
// values that already exist somewhere in the request's own object graph
// (project → owner, project_request → created_by, stream → project → owner,
// jwt-door provenance), and this module classifies everything else rather than
// filling it in.
//
// Lives in `lib/` and imports NOTHING but types, for the same reason
// `conveyor-refusal-metrics.ts` and `board-tenant-gate-metrics.ts` do: the
// callers are unit-tested with no database, so this module must not
// transitively import `db/client`.

/**
 * The closed set of ways an approval can be unanswerable by construction.
 *
 * ⛔ CLOSED AND ORDER-STABLE — it is a Prometheus label value set. Adding a
 * member adds series; renaming one silently breaks every alert and dashboard
 * written against the old name.
 */
export const ANSWERABILITY_REASONS = [
  /**
   * No resolvable requester. The row's `requester_id` is NULL and nothing in
   * the request's own object graph names a subject.
   *
   * ⚠️ The stored counterpart is `metadata.requester_source='unattributable'`,
   * which `routes/webhooks.ts` writes deliberately so a NULL reads as "no
   * project to attribute this to" rather than "this route never set the
   * field". 105 of the 106 measured `generic` rows carry both.
   *
   * ⭐ THIS IS THE ARM THAT RESOLVES RATHER THAN REFUSES most of the time —
   * see `one-open-gate.ts :: resolveRequesterId`. It is classified here only
   * when every honest derivation has been tried and failed.
   */
  'requester_unresolvable',
  /**
   * The approval names an approver who is NOT a member of the approval's own
   * tenant (no `user_roles` row for that user under `approvals.tenant_id`).
   *
   * ⭐ THE LIABILITY, STATED PRECISELY: this is not "an approver we cannot
   * reach" — `resolveApprover` already refuses that and it is a different
   * defect. This is an approver fr CAN reach who has no standing in the tenant
   * whose work they are signing off. 105 of 106 measured rows are
   * `approver_source='fallback'`, i.e. `APPROVAL_FALLBACK_APPROVER_USER_ID`,
   * a deliberately tenant-INDEPENDENT human. The fallback is doing exactly
   * what it was configured to do; what nothing states is that the resulting
   * signature is given by somebody the tenant never appointed.
   *
   * ⛔ THIS ARM DOES NOT RE-ROUTE, AND THAT IS A DELIBERATE REFUSAL TO WRITE A
   * NO-OP. The obvious "resolution" is to swap the foreign approver for a
   * workspace-admin of the row's own tenant. `resolveApprover` ALREADY tries
   * exactly that, first, and reaches `fallback` only when no in-tenant
   * candidate has a push channel — so re-running the same ladder here would
   * return the same answer, and overriding it with an UNREACHABLE in-tenant
   * admin would trade a liability for a stranded card ("an approval addressed
   * to nobody is the 24-hour timer this whole change exists to delete").
   * The fix for this arm is configuration, not code, and the counter is how it
   * gets noticed.
   */
  'approver_foreign_tenant',
  /**
   * `expires_at` is absent, so the expiry worker's `expires_at <= now()`
   * predicate can never match the row — SQL three-valued logic skips NULL, at
   * every future instant. The row is UN-REAPABLE.
   *
   * ⛔ UN-REAPABLE IS NOT UNANSWERABLE, AND CONFLATING THE TWO INVERTS THE
   * ARGUMENT. A NULL-deadline row is if anything MORE answerable than a dated
   * one: `hasPassedDeadline` returns false for it forever, so a human can
   * always decide it. What it cannot do is LAPSE. `lib/approval-deadline.ts`'s
   * header argues at length that for a CARD-BLOCKING approval that is the
   * CORRECT state — "BLOCKED *is* the wait state, so a deadline on it is the
   * defect" — and 132 approvals expired because two writers manufactured a
   * deadline out of nothing. Do not read this reason as "NULL is a bug".
   *
   * ⚠️ WHAT THIS ARM ACTUALLY ENCODES is the 2026-09-02 OPERATOR OVERRIDE
   * recorded in that same file, which is later than its header and governs:
   * `deadlineFromHours` no longer returns `| null` and every one of its callers
   * therefore writes a dated row. So "no deadline was requested" is no longer
   * expressible through fr's own helper, and a mint that reaches here with a
   * NULL got there by OMITTING the column rather than by asking for no
   * deadline — which is the case this fills in.
   *
   * ⭐ ALWAYS RESOLVED, NEVER REFUSED, and the direction matters: the resolution
   * is `deadlineFromHours(null)`, i.e. the operator's own default, applied by
   * the one helper that owns it. Counted anyway, because a producer that keeps
   * omitting the column is a producer worth naming — but never refused, because
   * an absent deadline has a correct answer and a refusal here could only ever
   * be a refusal that should have been a resolution.
   */
  'deadline_absent',
  /**
   * Neither `metadata.card_type` nor `metadata.gate_terms` is present, so the
   * row states neither WHAT kind of thing is being decided nor the concrete
   * conditions the decision is against. `workers/approval-redelivery.ts` reads
   * `metadata->'gate_terms'` to build its digest and reports "(no gate_terms
   * recorded)"; a full triage of 274 rows once scored ALL 274
   * `insufficient_evidence` for exactly this.
   *
   * ⛔ NOT RESOLVED, ON PURPOSE. Only the producer knows what it is asking.
   * Deriving a card_type from `kind`, `asset_kind` or the description would be
   * the fabrication `lib/approval-rationale.ts` forbids one file over.
   */
  'no_card_type_and_no_gate_terms',
  /**
   * The row's `tenant_id` disagrees with the tenant named inside its own
   * `metadata.policy_key`.
   *
   * ⚠️ RECORDED, NEVER OBEYED — see `routes/execution-approvals.ts`. fr's
   * `tenant_id` is resolved from fr's OWN ownership chain (board → project →
   * department → workspace) and governs who may decide the row. `policy_key`
   * is a producer-supplied string. Letting the string pick the tenant would
   * let a producer move a gate into a tenant that never owned the work, which
   * is a strictly worse failure than the mislabelling it would fix. So the
   * resolved tenant wins, the disagreement is written onto the row as
   * evidence, and this counts it.
   */
  'tenant_policy_key_mismatch',
  /** The row carries none of the above. The DENOMINATOR — see the render note. */
  'none',
] as const;
export type AnswerabilityReason = (typeof ANSWERABILITY_REASONS)[number];

/**
 * What HAPPENED to a mint once its reasons were known.
 *
 * ⭐ Without this label a resolution is indistinguishable from a defect. The
 * requester arm resolves most of the time and the deadline arm resolves always,
 * so a counter keyed on `reason` alone would report a healthy, self-healing
 * path as a rising defect rate — and an operator watching it would flip
 * `enforce` on the strength of a number that says the opposite of what they
 * think it says.
 */
export const ANSWERABILITY_OUTCOMES = [
  /** The value was DERIVED from the request's own object graph and written. */
  'resolved',
  /** Unresolvable, and observe mode minted anyway. This is the defect rate. */
  'observed',
  /** Unresolvable, and enforce mode refused the mint. */
  'refused',
  /** Nothing was wrong. Only ever paired with `reason="none"`. */
  'clean',
] as const;
export type AnswerabilityOutcome = (typeof ANSWERABILITY_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// MODE
// ---------------------------------------------------------------------------

export type AnswerabilityMode = 'observe' | 'enforce';

/**
 * The ONE env flag, and the only thing that changes an outcome.
 *
 * ⛔ DEFAULT IS `observe`, AND THE DEFAULT IS THE SAFE DIRECTION. The value is
 * TRIMMED and LOWERCASED before the comparison, so `enforce`, `ENFORCE` and
 * `  Enforce  ` all arm it — surrounding whitespace and the operator's choice
 * of case are not a different intent, and a deploy that sets `ENFORCE` meaning
 * to arm it must not silently read as observe. Everything else (unset, empty,
 * whitespace-only, misspelt, `true`, `1`, `enforced`, `enforcing`, `yes`) reads
 * as observe. A typo must never arm a refusal — the failure mode of an
 * accidental `enforce` is the conveyor stopping fleet-wide, and the failure
 * mode of an accidental `observe` is one more day of a defect that has been
 * live for weeks. Both halves are pinned in
 * `tests/unit/lib/approval-answerability.test.ts`.
 *
 * Named after `CODING_GITHUB_PLATFORM_TENANT_ENFORCE`'s role rather than its
 * spelling, because fr's own precedent is a MODE string with two values
 * (`FR_ENFORCE_ACTION_COVERAGE=strict`, and the withdrawn
 * `PROJECT_ID_EMIT_MODE=observe|enforce`) and a mode reads correctly in a log
 * line where a bare boolean does not.
 */
export const ANSWERABILITY_MODE_ENV = 'FR_APPROVAL_ANSWERABILITY_MODE';

/**
 * Read at CALL TIME, not at module load.
 *
 * ⚠️ Deliberate: a module-level constant is captured once per process, so a
 * test that sets the env after import would drive the wrong branch and pass —
 * the shape of a gate that cannot fail. Reading per call costs one property
 * access on a path that is already doing a database insert.
 */
export function answerabilityMode(): AnswerabilityMode {
  return process.env[ANSWERABILITY_MODE_ENV]?.trim().toLowerCase() === 'enforce'
    ? 'enforce'
    : 'observe';
}

/** True when the gate may refuse. Exported so callers name the predicate, not the string. */
export function answerabilityEnforces(): boolean {
  return answerabilityMode() === 'enforce';
}

// ---------------------------------------------------------------------------
// CLASSIFICATION — pure
// ---------------------------------------------------------------------------

/**
 * The already-resolved facts a classification needs. Everything here is a
 * POST-resolution value: the caller runs its derivation ladder first and hands
 * in what it ended up with, so this function never has to know how a requester
 * was found.
 */
export interface AnswerabilityFacts {
  /** `approvals.requester_id` AFTER the caller's resolution ladder. */
  requesterId: string | null | undefined;
  /** `approvals.approver_user_id`, or null when the row names nobody. */
  approverUserId: string | null | undefined;
  /**
   * Whether `approverUserId` holds a role in the row's own tenant.
   *
   * ⚠️ `null` means NOT ESTABLISHED — the membership lookup threw, or the row
   * names no approver at all — and is treated as ANSWERABLE. Failing this arm
   * OPEN is deliberate: a Postgres wobble must not present as every approval
   * being unanswerable, which is the single most likely way this gate gets
   * wrongly blamed and reverted. Compare `board_lookup_failed` in
   * `board-tenant-gate-metrics.ts`, which exists for the same reason.
   */
  approverIsTenantMember: boolean | null;
  /** `approvals.expires_at` AFTER the caller's resolution ladder. */
  expiresAt: Date | string | null | undefined;
  /** The row's `metadata`, as it will be written. */
  metadata: unknown;
  /**
   * The tenant named inside `metadata.policy_key`, when one is extractable and
   * differs from the row's `tenant_id`. `null` when the keys agree, when no
   * policy_key was sent, or when it embeds no tenant at all.
   */
  policyKeyTenantMismatch?: string | null;
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/** A non-empty string, trimmed. The repo's `.trim() ? … : undefined` idiom. */
function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `gate_terms` counts only as a NON-EMPTY ARRAY OF NON-EMPTY STRINGS.
 *
 * ⚠️ An absent key and an empty array are different findings and the mint
 * paths preserve that distinction on purpose (`...(x?.length ? {x} : {})`), but
 * for THIS question they are the same: neither states a condition a human can
 * answer against. `[]` must not buy a pass — that would be the vacuous gate.
 */
function hasGateTerms(value: unknown): boolean {
  return Array.isArray(value) && value.some((t) => present(t));
}

/**
 * Every way this approval is unanswerable, in `ANSWERABILITY_REASONS` order.
 *
 * Returns `[]` for an answerable row. Deliberately returns ALL reasons rather
 * than the first: a row with no requester AND no gate terms is two defects in
 * two different producers, and reporting only the first hides the second from
 * the counter — which is how a fix ships, the number does not move, and the
 * second cause is never found.
 */
export function classifyAnswerability(
  facts: AnswerabilityFacts,
): AnswerabilityReason[] {
  const reasons: AnswerabilityReason[] = [];
  const meta = metadataRecord(facts.metadata);

  if (!present(facts.requesterId)) reasons.push('requester_unresolvable');

  // `=== false` and not `!`: `null` is NOT ESTABLISHED and must not fire. See
  // the field docblock — this arm fails OPEN.
  if (present(facts.approverUserId) && facts.approverIsTenantMember === false) {
    reasons.push('approver_foreign_tenant');
  }

  if (facts.expiresAt == null) reasons.push('deadline_absent');

  if (!present(meta.card_type) && !hasGateTerms(meta.gate_terms)) {
    reasons.push('no_card_type_and_no_gate_terms');
  }

  if (present(facts.policyKeyTenantMismatch)) {
    reasons.push('tenant_policy_key_mismatch');
  }

  return reasons;
}

/**
 * The refusal message handed back to the producer in enforce mode.
 *
 * Names the reasons AND the flag, so the operator reading an n8n execution can
 * tell a deliberate refusal from a defect without reading fr's source. The
 * remedy sentence per reason is the point: a refusal that does not say what to
 * send instead is the same dead end as the approval it refused.
 */
export function answerabilityRefusalMessage(
  reasons: readonly AnswerabilityReason[],
  cardId: string | null | undefined,
): string {
  const remedy: Record<AnswerabilityReason, string> = {
    requester_unresolvable:
      'no requester could be derived from the project, the project request, the ' +
      'stream or the JWT caller — send a project_id/stream_id fr can resolve, or ' +
      'name the requester explicitly',
    approver_foreign_tenant:
      'the named approver holds no role in this approval\'s tenant — give the ' +
      'tenant a workspace-admin with an enabled push channel, or set ' +
      'APPROVAL_FALLBACK_APPROVER_USER_ID to a human who is a member of it',
    deadline_absent:
      'the column was omitted rather than a TTL declined — fr filled it from the ' +
      'tenant default (lib/approval-deadline.ts DEFAULT_TTL_DAYS, the 2026-09-02 ' +
      'operator decision); send deadline_hours/expires_in_hours to choose your own',
    no_card_type_and_no_gate_terms:
      'the row states neither metadata.card_type nor metadata.gate_terms, so there ' +
      'is no proposition to decide — send at least one',
    tenant_policy_key_mismatch:
      'metadata.policy_key names a different tenant than the one fr resolved for ' +
      'this board/project — fix the producer\'s policy lookup',
    none: '',
  };
  return (
    `Approval for card ${cardId ?? '(none)'} REFUSED as unanswerable by construction: ` +
    reasons.map((r) => `${r} (${remedy[r]})`).join('; ') +
    `. This refusal is armed by ${ANSWERABILITY_MODE_ENV}=enforce; ` +
    'in observe mode the same row is minted and only counted.'
  );
}

/** The error `code` a caller may branch on, rather than on message text. */
export const ANSWERABILITY_REFUSAL_CODE = 'approval_unanswerable';
