// src/routes/approvals/[id]/page-helpers.ts
//
// Pure logic for the project-agnostic approval-review page, factored out so it
// is unit-testable under the repo's node-env vitest (no @testing-library/svelte).
// The .svelte
// template wiring + gating (canActOnApproval) is verified by svelte-check + the
// already-green canAct.test.ts.

import { apiClient } from '$lib/api/unified-client';
import { decisionNotice, type DecisionNotice } from '$lib/approvals/decision-callback';
// ⭐ EXTRACTED, NOT CHANGED. `'Rejected.'` used to be a literal on the reject path
// below and was the de-facto definition of what the whole product does when a
// decider rejects without typing anything. The two improvement lenses each guessed
// a different rule from it (one blocked the click, one sent no `reason` at all), so
// it now lives in one module both they and this file import. Same value, same four
// tests, one source.
//
// ⚠️ NOW THE FUNCTION, NOT JUST THE CONSTANT. This file used to import
// the bare `DEFAULT_REJECT_REASON` constant and re-spell the rule as an or-fallback,
// while `ApprovalGateTimeline`, `PromptGatePanel` and `GovernanceDecisionPanel` all
// call `rejectReason(text)`. That was TWO implementations of one contract, and the
// only reason they agreed was `const text = comment.trim()` twenty-five lines below
// — a trim performed for the approve path's answer guard that the reject path was
// silently relying on at a distance. Delete or move that trim (say, to inline the
// guard) and this surface starts sending three spaces as a rejection reason while
// the lenses keep sending 'Rejected.', with nothing red anywhere: the server
// accepts any non-empty string, so the divergence shows up only as two different
// audit trails for the same gesture. Importing the function removes the second
// implementation rather than pinning its spelling.
//
// The defaults did NOT need reconciling: `rejectReason()` returns this very
// `DEFAULT_REJECT_REASON`, so the value on the wire is unchanged in every case.
import { rejectReason } from '$lib/approvals/reject-reason';
import { coveragePayload, type CoverageChoice } from '$lib/approvals/coverage';
import type { G12A3DecideTemplate, G12DecideTemplate, G12DecisionBody } from '$lib/types/api';

// Structurally identical to DecisionBar's `Decision`; declared locally so this
// helper (loaded directly by vitest) never imports from a .svelte module.
export type Decision = 'approve' | 'changes' | 'reject';

export interface DecisionOutcome {
  kind: Decision;
  /**
   * What was DECIDED. Unchanged, and deliberately still says nothing about the
   * callback — callers that render the decided-state panel want this line.
   */
  message: string;
  /**
   * ⭐ WHAT TO TELL THE OPERATOR, including what happened downstream.
   *
   * `notice.delivered` is true ONLY when the n8n callback was accepted, i.e.
   * only when the card actually moves. A surface that toasts `message` on its
   * own is claiming a success it has not verified — see
   * `$lib/approvals/decision-callback`.
   */
  notice: DecisionNotice;
}

/**
 * What the caller knows about the row being decided, that the decision itself
 * cannot tell us.
 *
 * This is a REQUIRED, single-field object rather than a positional boolean on
 * purpose: a bare 5th `true`/`false` is invisible at the call site and a
 * defaulted one would let a new caller silently re-open the exact hole this
 * guard closes (see `recordDecision`). Required + named means TypeScript makes
 * every call site state the answer, and `{ isQuestion }` cannot be transposed
 * with any other argument.
 */
export interface DecisionContext {
  /**
   * True when this approval's effective deblock action is QUESTION — i.e. the
   * decision comment is the ANSWER the n8n callback forwards, not a note.
   * Derive it with `isQuestion` from `$lib/approvals/question`.
   */
  isQuestion: boolean;
  /**
   * REALIGN R5 — whether the approve still owes text when the decider switched the
   * action to RECLASSIFY: `answerRequired(row, 'approved', 'RECLASSIFY')`. Consulted
   * INSTEAD of `isQuestion` only when a reclassify is sent, because the server keys
   * the demand on the effective action. Absent ⇒ no client-side demand (the server
   * still decides).
   */
  answerRequiredOnReclassify?: boolean;
}

/**
 * Map a DecisionBar action to the backend approval API and return the outcome
 * line to reflect in the UI. The backend has no distinct "changes" state, so
 * changes-requested is recorded as a rejection carrying the requested changes
 * (so the line stops and the agent reworks). An empty comment falls back to a
 * default reason on the reject/changes paths.
 *
 * ⛔ APPROVING A QUESTION WITH NO ANSWER IS REFUSED HERE, CLIENT-SIDE.
 *
 * On a QUESTION row the comment is not commentary — it IS the answer, and it is
 * the only thing that moves the card. With answer text the callback returns the
 * card to TODO to be re-driven; with an empty one the approval is spent (no
 * second decision is accepted from the same approver) and the card stays BLOCKED
 * with `block_reason=approval_answer_missing`, unrecoverably. The backend
 * refuses this with a 422 and no override (`backend/src/routes/approvals.ts`
 * ~1510-1528); we throw before the request rather than spend a round-trip on a
 * call that cannot succeed. Whitespace-only counts as empty on BOTH sides — the
 * backend trims too, so anything else here would disagree with the server.
 *
 * Rejecting a question is a legitimate terminal and is deliberately NOT guarded,
 * matching the server, which exempts it.
 *
 * Every other path is unchanged: reject ⇒ `{reason}`; changes ⇒ a reject with a
 * `[changes requested]` prefix; approve with text ⇒ `{comment}`; approve with no
 * text on a NON-question ⇒ `undefined`.
 *
 * ⚠️ THE TWO FALLBACKS ARE DIFFERENT ON PURPOSE. Reject falls back through the
 * shared `rejectReason()` to 'Rejected.'; changes-requested keeps its own
 * 'Changes requested.' literal, because it is a distinct gesture whose stored
 * reason has to read as one — the two must not be consolidated into a single
 * default just because both paths call `api.reject`.
 */
export async function recordDecision(
  approvalId: string,
  kind: Decision,
  comment: string,
  context: DecisionContext,
  /**
   * The super-admin's #1064 broken-gate override argument, when the row carries a
   * broken gate term. Sent as `reason` alongside `comment`, NEVER merged into it.
   *
   * ⛔ THE SEPARATION IS THE POINT. The server reads `reason` for the override and
   * `comment` for the answer, and subtracts a reason it consumed as an override from
   * the persisted answer. Passing the override text as `comment` would hand the n8n
   * callback an override rationale as if it were the reply to a question.
   *
   * Undefined on every non-broken-gate row, which is all of them today: measured
   * 2026-09-13, 174 of 974 pending rows carry a broken gate and 0 of those also
   * demand an answer.
   */
  overrideReason?: string,
  /**
   * REALIGN R5 — the decider chose RECLASSIFY and picked a new card type. Sent as
   * `deblock_action: 'RECLASSIFY'` + `new_card_type`; approve-only (a reject carries
   * neither — the server refuses `new_card_type` on any other decision).
   */
  reclassify?: { newCardType: string },
  /**
   * COVERAGE — the criteria the decider ticked as a gap. Sent as `rejected_criterion_ids`
   * on approve (a partial approve) and on reject; none ticked sends nothing (the server
   * reads that as approve = all covered, reject = all gaps).
   */
  coverage?: CoverageChoice,
  /**
   * G-12 A1 — the per-bug picker's choice on a bug-fix authorization row. When present the
   * body is built ONLY by `bugFixDecisionBody` (the gate refuses free text, needs the
   * structured g12_decision, and fixes how approve/reject relate to the rejected set).
   */
  bugFix?: BugFixChoice,
  /**
   * G-12 A3 — the feature-design review form's choice. When present the body is built ONLY by
   * `a3DecisionBody`: never a deblock_action (the server refuses one on this kind), never free
   * text, always the structured g12_decision from the server's `g12_decide_a3` template.
   */
  a3?: A3Choice,
): Promise<DecisionOutcome> {
  if (a3) {
    if (reclassify) {
      throw new Error(
        'Reclassify is not available on a feature-design approval: its outcome is fixed by its G-12 decision ' +
          '(the server refuses any deblock_action on this kind).',
      );
    }
    const req = a3DecisionBody(kind, comment, a3);
    if (req.verb === 'approve') {
      const res = await apiClient.approvals.approve(approvalId, req.body);
      return outcome(kind, 'Approved — the design and its acceptance tests are accepted; build cards can be minted.', res);
    }
    const res = await apiClient.approvals.reject(approvalId, req.body);
    return outcome(kind, `Rejected (${req.body.reason}) — the design goes back to the system.`, res);
  }
  if (bugFix) {
    const req = bugFixDecisionBody(kind, comment, bugFix);
    const n = bugFix.bugIds.length;
    if (req.verb === 'approve') {
      const kept = n - (req.body.rejected_bug_ids?.length ?? 0);
      const res = await apiClient.approvals.approve(approvalId, req.body);
      return outcome(kind, `Approved ${kept} of ${n} bug${n === 1 ? '' : 's'} — fixes are authorised for those only.`, res);
    }
    const res = await apiClient.approvals.reject(approvalId, req.body);
    return outcome(kind, `Rejected — all ${n} bug${n === 1 ? '' : 's'} rejected, no fix authorised.`, res);
  }
  const coverageBody = coveragePayload(coverage);
  const text = comment.trim();
  if (kind === 'approve') {
    const newCardType = reclassify?.newCardType.trim();
    if (reclassify && !newCardType) {
      throw new Error('Choose the card type to reclassify this card to before approving.');
    }
    const answerOwed = reclassify
      ? (context.answerRequiredOnReclassify ?? false)
      : context.isQuestion;
    if (answerOwed && text.length === 0) {
      throw new Error(
        'This approval is a question, and your answer is what moves the card: it is ' +
          'forwarded to the callback, which returns the card to TODO to be re-driven. ' +
          'Approving with an empty answer does not release anything — it spends the ' +
          'approval (no second decision is accepted from you) and strands the card in ' +
          'BLOCKED. Write the answer, or reject the question with a reason.',
      );
    }
    const override = (overrideReason ?? '').trim();
    // Both fields travel, each in its own slot; an empty one is omitted rather than
    // sent as '' so the server's `comment || reason` fallback keeps its meaning.
    const payload = {
      ...(text ? { comment: text } : {}),
      ...(override ? { reason: override } : {}),
      ...(newCardType ? { deblock_action: 'RECLASSIFY', new_card_type: newCardType } : {}),
      ...coverageBody,
    };
    const res = await apiClient.approvals.approve(
      approvalId,
      Object.keys(payload).length > 0 ? payload : undefined,
    );
    return outcome(
      kind,
      newCardType
        ? `Approved — reclassified to ${newCardType}; the card returns to TODO.`
        : 'Approved — the system advances the phase.',
      res,
    );
  }
  if (kind === 'reject') {
    const res = await apiClient.approvals.reject(approvalId, { reason: rejectReason(text), ...coverageBody });
    return outcome(kind, 'Rejected — sent back to the system.', res);
  }
  const res = await apiClient.approvals.reject(approvalId, {
    reason: text ? `[changes requested] ${text}` : 'Changes requested.',
    ...coverageBody,
  });
  return outcome(kind, 'Changes requested — sent back to the system.', res);
}

/**
 * Pair the decision line with what the response said happened downstream.
 *
 * ⛔ Every return path of `recordDecision` goes through here, so a new decision
 * kind cannot be added that reports its own success without consulting the
 * callback — which is exactly how the unconditional `toast.success` survived.
 */
function outcome(kind: Decision, message: string, response: unknown): DecisionOutcome {
  return { kind, message, notice: decisionNotice(message, response) };
}

// ── G-12 A1: per-bug reject picker (bug-fix authorization) ──────────────────────────
//
// Every rule below is READ from backend/src/services/approvals/u3-gates.ts, never invented:
//   * the row: `metadata.approval_kind === 'bug_fix_authorization'` (isBugFixAuthorizationRow,
//     domain/engagement/deblock-actions.ts) on kind `execution.ready_signoff` — the ONLY kind
//     whose approve authorises fixes (bugFixDecisionAuthorises; BUG_FIX_PROCEED_DEBLOCK_ACTIONS
//     is empty, RULING a 10-01). A marked generic row rejects every bug on any decision, so a
//     picker there would offer a choice the gate cannot honour.
//   * `g12_decision` is REQUIRED (parseG12Decision → 422 g12_decision_required); its
//     rule_version / rule_row / inputs_hash come from the server's `g12_decide` template.
//   * free text is refused: `comment` / `reason` must be empty or one of the row's codes
//     (422 free_text_refused).
//   * approve + rejected_bug_ids omitted ⇒ every bug approved; reject + omitted ⇒ every bug
//     rejected (assertBugFixAuthorizationDecide).
//   * approve must leave ≥1 bug approved; rejecting ALL on an approve is
//     422 decision_items_inconsistent ("someApproved !== authorises"). Reject-all is therefore
//     a REJECT decision, never an approve.
//   * any rejected bug needs a closed-set code: g12_decision.reject_reason_code
//     (422 reject_reason_code_required / reason_code_not_in_rule).
//   * a rejection needs a non-empty `reason` (routes/approvals.ts "A reason is required when
//     rejecting"), and that reason must itself be a code — so it IS the reject code.

export const BUG_FIX_AUTHORIZATION_MARKER = 'bug_fix_authorization';
export const BUG_FIX_AUTHORISING_KIND = 'execution.ready_signoff';

export interface BugFixPickerModel {
  /** metadata.report_id — the bug report the decider reviews; null ⇒ no link. */
  reportId: string | null;
  /** metadata.bug_ids — the bugs this approval decides, in the order minted. */
  bugIds: string[];
  /** The server's G-12 template; null ⇒ the row cannot be decided per bug here. */
  template: G12DecideTemplate | null;
}

/** The picker model, or null for every row that is not an A1 bug-fix authorization. */
export function bugFixPickerModel(approval: {
  kind?: string;
  metadata?: Record<string, unknown> | null;
  g12_decide?: G12DecideTemplate;
}): BugFixPickerModel | null {
  const md = approval.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return null;
  if (md.approval_kind !== BUG_FIX_AUTHORIZATION_MARKER || approval.kind !== BUG_FIX_AUTHORISING_KIND) return null;
  const bugIds = Array.isArray(md.bug_ids)
    ? md.bug_ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (bugIds.length === 0) return null;
  const reportId = typeof md.report_id === 'string' && md.report_id.length > 0 ? md.report_id : null;
  return { reportId, bugIds, template: approval.g12_decide ?? null };
}

/** `/reports/<id>` for the cited bug report, or null when the row cites none. */
export function bugReportHref(model: Pick<BugFixPickerModel, 'reportId'> | null): string | null {
  return model?.reportId ? `/reports/${encodeURIComponent(model.reportId)}` : null;
}

export interface BugFixChoice {
  template: G12DecideTemplate;
  bugIds: string[];
  /** The bugs the decider ticked "reject". */
  rejectedBugIds: string[];
  /** One of template.reject_codes, or '' when none chosen. */
  rejectReasonCode: string;
}

export type BugFixDecisionRequest =
  | {
      verb: 'approve';
      body: { g12_decision: G12DecisionBody; rejected_bug_ids?: string[] };
    }
  | { verb: 'reject'; body: { reason: string; g12_decision: G12DecisionBody } };

/**
 * PURE. The decide body the A1 gate accepts for approve-all, reject-some (an approve) and
 * reject-all (a reject); throws, before any request, on every body the gate would refuse.
 */
export function bugFixDecisionBody(kind: Decision, comment: string, choice: BugFixChoice): BugFixDecisionRequest {
  const { template, bugIds } = choice;
  if (kind === 'changes') {
    throw new Error(
      'Request changes is not available on a bug-fix authorization: its free text is refused by the gate. ' +
        'Reject the bugs with a reason code instead.',
    );
  }
  if (comment.trim() !== '') {
    throw new Error(
      'A bug-fix authorization takes no free-text comment (the gate refuses it). ' +
        'Clear the comment; tick the bugs to reject and pick a reason code.',
    );
  }
  const base = { rule_version: template.rule_version, rule_row: template.rule_row, inputs_hash: template.inputs_hash };
  const code = choice.rejectReasonCode;
  const codeOk = code !== '' && template.reject_codes.includes(code);
  const ticked = new Set(choice.rejectedBugIds);
  const rejected = bugIds.filter((id) => ticked.has(id));

  if (kind === 'reject') {
    if (!codeOk) throw new Error('Pick a reject reason code before rejecting the bug report.');
    // rejected_bug_ids omitted ⇒ every bug rejected on a reject.
    return { verb: 'reject', body: { reason: code, g12_decision: { ...base, reject_reason_code: code } } };
  }
  if (rejected.length === bugIds.length) {
    throw new Error(
      'Every bug is ticked for rejection, so approving would authorise no fix — the gate refuses that ' +
        '(decision_items_inconsistent). Use Reject to reject the whole report.',
    );
  }
  if (rejected.length === 0) {
    // Omitted ⇒ every bug approved — the same body the chat seat's approve-all sends.
    return { verb: 'approve', body: { g12_decision: base } };
  }
  if (!codeOk) throw new Error('Pick a reject reason code for the bugs you ticked.');
  return {
    verb: 'approve',
    body: { rejected_bug_ids: rejected, g12_decision: { ...base, reject_reason_code: code } },
  };
}

// ── G-12 A3: feature-design review (execution.feature_design_approval) ──────────────────────
//
// Every rule below is READ from backend/src/services/approvals/u3-gates.ts, never invented:
//   * any decider may decide (human or agent; the server stamps the honest decider_kind).
//   * deblock_action is refused on this kind (routes/approvals.ts deblock_action_not_allowed,
//     and u3-gates assertU3DecideGates) — so this path never sends one.
//   * `g12_decision` is REQUIRED; rule_version / rule_row / item_id / codes come from the
//     server's `g12_decide_a3` template (webA3DecideTemplate), never re-spelled here.
//   * inputs_hash is the SEALED `a3_inputs_hash` (design_hash with the write-set seal folded in);
//     a bare design_hash is 409 inputs_hash_mismatch. The template carries the right value.
//   * items = exactly ONE item, the design (items_mismatch otherwise); approve ⇔ that item
//     approved (decision_items_inconsistent otherwise).
//   * free text is refused (free_text_refused): `comment` / `reason` must be empty or a code.
//     A rejection needs a non-empty `reason` ("A reason is required when rejecting"), so the
//     reason IS the chosen reject code — the "required comment" on reject is that code.

export const FEATURE_DESIGN_APPROVAL_KIND = 'execution.feature_design_approval';

export interface A3Unit {
  unitKey: string;
  kind: string;
  file: string;
  fn: string;
  summary: string;
  targetFiles: string[];
  elementIds: string[];
  criteria: Array<{ id: string; text: string }>;
  tests: Array<{ id: string; path: string; code: string }>;
  covers: string[];
  requires: string[];
  childCardType: string;
}

export interface A3Scenario {
  scenarioId: string;
  criterionId: string;
  title: string;
  gherkin: string | null;
}

export interface A3ReviewModel {
  designArtifactId: string | null;
  designHash: string | null;
  contractHash: string | null;
  scenariosHash: string | null;
  writeSet: string[];
  units: A3Unit[];
  scenarios: A3Scenario[];
  hasHandoffContract: boolean;
  template: G12A3DecideTemplate | null;
  /** Why this design cannot be decided here; null when the form may submit. */
  disabledReason: string | null;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objs = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The A3 review model, or null for every row that is not an A3. Text only — nothing is markup. */
export function a3ReviewModel(approval: {
  kind?: string;
  metadata?: Record<string, unknown> | null;
  g12_decide_a3?: G12A3DecideTemplate;
}): A3ReviewModel | null {
  if (approval.kind !== FEATURE_DESIGN_APPROVAL_KIND) return null;
  const md = obj(approval.metadata);
  const contract = md.handoff_contract;
  const units = objs(obj(contract).units).map((u): A3Unit => {
    const spec = obj(u.unit);
    const scope = obj(u.scope);
    return {
      unitKey: s(u.unit_key),
      kind: s(spec.kind),
      file: s(spec.file),
      fn: s(spec.function),
      summary: s(scope.summary),
      targetFiles: strs(scope.target_files),
      elementIds: strs(scope.element_ids),
      criteria: objs(u.acceptance_criteria).map((c) => ({ id: s(c.id), text: s(c.text) })),
      tests: objs(u.acceptance_tests).map((t) => ({ id: s(t.id), path: s(t.path), code: s(t.code) })),
      covers: strs(u.covers),
      requires: strs(u.requires),
      childCardType: s(u.child_card_type),
    };
  });
  const scenarios = objs(md.scenarios).map((sc) => ({
    scenarioId: s(sc.scenario_id),
    criterionId: s(sc.criterion_id),
    title: s(sc.title),
    gherkin: nonEmpty(sc.gherkin),
  }));
  const designHash = nonEmpty(md.design_hash);
  const hasHandoffContract = units.length > 0;
  const template = approval.g12_decide_a3 ?? null;
  const disabledReason = !designHash
    ? 'This approval carries no metadata.design_hash, so there is no design to bind a decision to.'
    : !hasHandoffContract
      ? 'This approval carries no metadata.handoff_contract (no units), so there are no acceptance tests to approve.'
      : !template
        ? 'fr served no G-12 decide template for this design: you cannot decide it now, or its write_set no longer matches its seal.'
        : null;
  return {
    designArtifactId: nonEmpty(md.design_artifact_id),
    designHash,
    contractHash: nonEmpty(md.contract_hash),
    scenariosHash: nonEmpty(md.scenarios_hash),
    writeSet: strs(md.write_set),
    units,
    scenarios,
    hasHandoffContract,
    template,
    disabledReason,
  };
}

/** First 12 characters of a hash for display (the full value goes in a title attribute). */
export function shortHash(h: string | null): string {
  return h ? (h.length > 12 ? `${h.slice(0, 12)}…` : h) : '—';
}

export interface A3Choice {
  template: G12A3DecideTemplate | null;
  designHash: string | null;
  hasHandoffContract: boolean;
  /** One of template.reject_codes, or '' when none chosen. Required for Reject. */
  rejectReasonCode: string;
}

export type A3DecisionRequest =
  | { verb: 'approve'; body: { g12_decision: G12DecisionBody } }
  | { verb: 'reject'; body: { reason: string; g12_decision: G12DecisionBody } };

/**
 * PURE. The decide body the A3 gate accepts; throws, before any request, on every body the gate
 * would refuse. The body is built field by field — it can never carry a deblock_action.
 */
export function a3DecisionBody(kind: Decision, comment: string, choice: A3Choice): A3DecisionRequest {
  if (!choice.designHash) {
    throw new Error('This approval carries no design_hash; there is no design to approve or reject.');
  }
  if (!choice.hasHandoffContract) {
    throw new Error('This approval carries no handoff_contract; there are no acceptance tests to decide.');
  }
  const t = choice.template;
  if (!t) {
    throw new Error('fr served no G-12 decide template for this design; it cannot be decided here.');
  }
  if (kind === 'changes') {
    throw new Error(
      'Request changes is not available on a feature-design approval: its free text is refused by the gate. ' +
        'Reject with a reason code instead.',
    );
  }
  if (comment.trim() !== '') {
    throw new Error(
      'A feature-design approval takes no free-text comment (the gate refuses it). ' +
        'Clear the comment; to reject, pick a reason code.',
    );
  }
  const base = { rule_version: t.rule_version, rule_row: t.rule_row, inputs_hash: t.inputs_hash };
  if (kind === 'approve') {
    const code = t.approve_codes[0];
    if (!code) throw new Error('The G-12 rule has no approve code for this row.');
    return {
      verb: 'approve',
      body: { g12_decision: { ...base, items: [{ item_id: t.item_id, decision: 'approve', reason_code: code }] } },
    };
  }
  const code = choice.rejectReasonCode;
  if (code === '' || !t.reject_codes.includes(code)) {
    throw new Error('Pick a reject reason code before rejecting the design.');
  }
  return {
    verb: 'reject',
    body: {
      reason: code,
      g12_decision: { ...base, items: [{ item_id: t.item_id, decision: 'reject', reason_code: code }] },
    },
  };
}

// ── D13: the approval's artifact ─────────────────────────────────────────────
//
// An approval may name ONE artifact (`artifact_ref`, backend migration 192). There
// is no per-id artifact page: the existing artifact view is the tenant Artifacts
// page, whose rows carry `id="artifact-<id>"` (view + download from there), so the
// link is the same fragment link `/projects/[id]/artifacts` builds.

export interface ArtifactLink {
  href: string;
  label: string;
}

/** The "Artifact" link for an approval's `artifact_ref`, or null when it names none. */
export function artifactRefLink(
  approval: { artifact_ref?: { artifact_id?: unknown; version?: unknown } | null },
): ArtifactLink | null {
  const ref = approval.artifact_ref;
  if (!ref || typeof ref.artifact_id !== 'string' || ref.artifact_id === '') return null;
  const version = typeof ref.version === 'number' && Number.isInteger(ref.version) ? ref.version : null;
  return {
    href: `/library/artifacts#artifact-${encodeURIComponent(ref.artifact_id)}`,
    label: version === null ? ref.artifact_id : `${ref.artifact_id} (version ${version})`,
  };
}
