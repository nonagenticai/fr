// src/services/n8n-callback.ts
// Sends approval decisions back to n8n when complete
import { storedArtifactRef } from '../lib/approval-artifact-ref';
import { db, approvals, approvalDecisions, approvalCallbackUrls } from '../db/client';
import { config } from '../config';
import {
  claimCallbackUrlSend,
  isCallbackUrlAlreadyTerminal,
  markCallbackUrlAlreadyTerminal,
  markCallbackUrlDelivered,
  postDecisionToCallbackUrl,
  redactCallbackUrl,
  scheduleCallbackUrlRetry,
} from '../lib/approval-callback-url';
import {
  asDeblockAction,
  classifyDeblockExit,
  irreconcilableDualExit,
} from '../domain/engagement/deblock-actions';
import { recordDeblockDualExit } from '../lib/deblock-action-metrics';
import { eq, sql } from 'drizzle-orm';
import { approvalCallbackTimeoutMs, n8nClient } from './n8n';
import { trackDetached } from '../lib/detached-work';
import type { ApprovalDecisionPayload, N8nWebhookResponse } from './n8n';
import {
  listProjectIdsForBoardFromDb,
  resolveCardProject,
} from '../routes/project-constraint-check';

type ApprovalRow = typeof approvals.$inferSelect;
type DecisionRow = typeof approvalDecisions.$inferSelect;

// ⛔ NO APPROVAL-DRIVEN PHASE TARGET (fr#1481, CONVEYOR-TAXONOMY D4). The
// approval-completion phase advance — the `advance_phase_on_approve` marker and
// the contract-gate `decision_development` card-type fallback — was DELETED with
// U-PS-PHASEEXIT. ⛔ George 2026-10-13: n8n is the ONLY writer of a project's
// phase (PATCH /api/projects/:id/phase). Approval completion never advances it —
// the computed `planPhaseExit` writer was deleted with its sweep.

/**
 * Upper bound on the card → Planka → project fallback. It runs INSIDE a decision
 * delivery that callers race against a deadline (`decisionRequestDeadlineMs`), so a
 * slow Planka must cost at most this, and a lookup that does not answer in time is a
 * `null` project_id — the loud signal. Kept at 1s, well inside that deadline: a healthy
 * Planka answers in
 * milliseconds, so this only ever bites during an outage.
 */
export const CALLBACK_CARD_PROJECT_LOOKUP_TIMEOUT_MS = 1_000;

/**
 * The card → project lookup: `resolveCardProject` (card → Planka board →
 * `projects.planka_board_id`), the same chain the constraint check uses. Card
 * gone / no project is `null`; an ambiguous board or a Planka failure THROWS and
 * `resolveCallbackProjectId` turns that into a warning plus `null`.
 */
async function cardProjectIdFromPlanka(cardId: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`card → project lookup exceeded ${CALLBACK_CARD_PROJECT_LOOKUP_TIMEOUT_MS}ms`)),
      CALLBACK_CARD_PROJECT_LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    const res = await Promise.race([
      resolveCardProject(cardId),
      timeout,
    ]);
    return res.status === 'found' ? res.projectId : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fr project a decision callback reports as `project_id`.
 *
 *   1. `approvals.project_id` — the row's own column, when set. No lookup.
 *   2. the row's `metadata.boardId` → `projects.planka_board_id`
 *      (`listProjectIdsForBoardFromDb`), accepted only when it names exactly ONE
 *      project.
 *   3. the row's `card_id` → its Planka board → project (`resolveCardProject`).
 *   4. otherwise `null`, with a warning. Never a placeholder, never a tenant id.
 *
 * Used by BOTH senders — `deliverDecisionCallback` (first delivery AND the
 * redelivery worker, which calls it with `redelivery: true`) and
 * `sendN8nExpiryCallback` — so every callback body carries the field, resolved
 * the same way. Never throws.
 */
export async function resolveCallbackProjectId(
  approval: Pick<ApprovalRow, 'id' | 'project_id' | 'card_id' | 'metadata'>,
): Promise<string | null> {
  if (approval.project_id) return approval.project_id;
  const metadata = (approval.metadata || {}) as Record<string, unknown>;
  const boardId =
    typeof metadata.boardId === 'string' && metadata.boardId.length > 0 ? metadata.boardId : undefined;
  try {
    if (boardId) {
      const ids = [...new Set(await listProjectIdsForBoardFromDb(boardId))];
      if (ids.length === 1) return ids[0]!;
    }
    if (approval.card_id) {
      const fromCard = await cardProjectIdFromPlanka(approval.card_id);
      if (fromCard) return fromCard;
    }
  } catch (err) {
    console.warn(
      `[n8n-callback] project_id lookup failed for approval ${approval.id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.warn(
    `[n8n-callback] approval ${approval.id} (card ${approval.card_id ?? 'none'}, board ` +
      `${boardId ?? 'none'}) resolves to NO fr project; the decision callback carries ` +
      'project_id: null and n8n will refuse any merge on it.',
  );
  return null;
}

/**
 * Build the outbound payload for the universal callback receiver. Pure
 * function so unit tests can assert payload shape without a database.
 *
 * The receiver consumes:
 *   - card_id, decision, comment, decided_by — Planka card action +
 *     audit string;
 *   - approval_id, tenant_id, card_type — idempotency-marker key +
 *     metric labels;
 *   - {qa,doing,todo}ListId, boardId — Planka list targets for the
 *     approve/reject card move.
 */
export function buildCallbackPayload(
  approval: ApprovalRow,
  lastDecision: DecisionRow | undefined,
  opts: {
    redelivery?: boolean;
    /**
     * The project resolved by `resolveCallbackProjectId` for a row whose own
     * `project_id` is NULL. Omitted = the row's own `project_id` (or null).
     */
    projectId?: string | null;
  } = {},
): ApprovalDecisionPayload {
  const metadata = (approval.metadata || {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  // WS-3 — carry the canary routing action through untouched. `canary_action`
  // is only ever 'rollback'|'extend' on a canary approval; anything else (or a
  // non-canary approval) leaves it undefined.
  const canaryActionRaw = metadata.canary_action;
  const canary_action =
    canaryActionRaw === 'rollback' || canaryActionRaw === 'extend'
      ? canaryActionRaw
      : undefined;

  // BLOCKED-exit proposition — echo the action the human just approved back to n8n so the
  // callback can execute it. This allowlist is closed: a key absent here is DROPPED, which
  // is why `deblock_action` has to be named in both this builder and N8nCardApprovalSchema.
  // Validated against the same closed set on the way out; anything else becomes undefined
  // rather than reaching the switch as an unrecognised string.
  //
  // ── ⛔ AND IT NOW ASKS THE CLASSIFIER, WHICH IS THE WHOLE POINT ─────────────────────
  // This line used to be `asDeblockAction(metadata.deblock_action)` and nothing else. That
  // narrowing is correct in isolation and was the defect in context: `classifyDeblockExit`
  // reads the SAME row, finds a lane carve-out, and reports `action: undefined` — while
  // this builder put the action on the wire anyway. Two code paths, one row, opposite
  // conclusions, and the row's fate decided by whichever one you happened to read.
  //
  // ⭐ fr#1481: approving no longer advances a project's phase from approval
  // metadata (the marker / card-type phase target was deleted; n8n is the only
  // phase writer, George 2026-10-13). The classifier's `phase_advance` lane
  // is RETAINED for stored rows carrying the `advance_phase_on_approve` marker —
  // the mint still refuses that dual-exit shape, and withholding the card move
  // here stays the conservative direction for any row that predates the refusal.
  // It is counted rather than dropped quietly.
  const deblockExit = classifyDeblockExit({
    action: metadata.deblock_action,
    doingListId: metadata.doingListId,
    todoListId: metadata.todoListId,
    advancePhase: metadata.advance_phase_on_approve,
    improvementKind:
      typeof approval.kind === 'string' && approval.kind.startsWith('improvement')
        ? approval.kind
        : undefined,
    approvalKind: approval.kind,
  });
  const dualExit = irreconcilableDualExit(deblockExit);
  if (dualExit) {
    recordDeblockDualExit('decide', dualExit.exemption);
    console.error(
      `[n8n-callback] approval ${approval.id} (card ${approval.card_id ?? 'unknown'}) asserts ` +
        `two exits: the ${dualExit.exemption} lane AND deblock_action=${dualExit.discarded}. ` +
        'WITHHOLDING the action from the callback so this one decision has one effect. The card ' +
        'will NOT move. The mint refuses this shape; a row reaching here came from another door.',
    );
  }
  const deblock_action = dualExit ? undefined : asDeblockAction(metadata.deblock_action);

  return {
    card_id: approval.card_id || '',
    // Not a mapping — a direct pass-through of the row's own status. A
    // `voided` approval reports `voided`, never `approved`: this cast names
    // the closed set (ApprovalDecisionPayload['decision']) it must belong to,
    // it does not coerce the runtime value into it.
    decision: approval.status as 'approved' | 'rejected' | 'expired' | 'voided',
    // `undefined` — NOT `false` — on a first delivery, so the emitted JSON stays
    // byte-identical to what this builder has always produced. Only an explicit
    // `true` from the one re-sender puts the key on the wire. See the field's
    // contract on `ApprovalDecisionPayload`.
    redelivery: opts.redelivery === true ? true : undefined,
    comment: lastDecision?.comment || undefined,
    decided_by: lastDecision?.approver_id || 'system',
    approval_id: approval.id,
    tenant_id: approval.tenant_id ?? undefined,
    // ⛔ ALWAYS EMITTED, `null` included — see the field's contract on
    // `ApprovalDecisionPayload`. The row's own column wins; the resolved value is
    // only ever a fallback for a NULL column, never an override.
    project_id: approval.project_id ?? opts.projectId ?? null,
    // The row's own kind, verbatim — see the field's contract on `ApprovalDecisionPayload`.
    approval_kind: str(approval.kind),
    card_type: str(metadata.card_type),
    qaListId: str(metadata.qaListId),
    doingListId: str(metadata.doingListId),
    todoListId: str(metadata.todoListId),
    boardId: str(metadata.boardId),
    // WS-3 canary routing fields (undefined on non-canary approvals).
    canary_action,
    list: str(metadata.list),
    additional_minutes: num(metadata.additional_minutes),
    deblock_action,
    learning_card_id: str(metadata.learning_card_id),
    // The PR a MERGE proposition is about. Echoed back for the same reason every other key here
    // is: this builder is a CLOSED allowlist, so a field the mint stored but this does not name
    // is silently dropped and the callback merges nothing while reporting success.
    pr_url: str(metadata.pr_url),
    pr_repo_owner: str(metadata.pr_repo_owner),
    pr_repo_name: str(metadata.pr_repo_name),
    pr_number: num(metadata.pr_number),
    // RECLASSIFY's payload (REALIGN R5): the type the receiver writes before moving the card
    // to TODO. Same closed-allowlist reason as `pr_url` — omit it here and the card re-runs
    // under its OLD type. Gated on the action actually on the wire, so a stray stored value
    // can never ride along on any other action (or on a withheld dual-exit action).
    new_card_type: deblock_action === 'RECLASSIFY' ? str(metadata.new_card_type) : undefined,
    // COVERAGE's payload (George BDD ruling 2026-10-01): the per-criterion verdict the PUT
    // resolved and stored. Gated on the wire action like `new_card_type`; absent on every
    // other action, so older callbacks are byte-identical.
    // ⛔ ALSO gated on the row's own status being a DECISION (approved / rejected): the decide
    // path is the only writer of `coverage_decision` (every mint strips it, see
    // `stripDecideOwnedMetadata`), and it only ever writes it in the UPDATE that completes the
    // row as approved/rejected. An expired or voided COVERAGE row was never signed off, so
    // whatever sits in its metadata must not reach n8n as a verdict.
    // D13: the artifact the human decided about (closed allowlist — named here or dropped).
    artifact_ref: storedArtifactRef(approval.artifact_ref) ?? undefined,
    coverage_decision:
      deblock_action === 'COVERAGE' &&
      (approval.status === 'approved' || approval.status === 'rejected')
        ? coverageDecisionOf(metadata.coverage_decision)
        : undefined,
    // A void's recorded reason, for `voided` ONLY (last key: every other decision's JSON is
    // byte-identical). A restart's starts "project restarted" (George 2026-10-31).
    voided_reason: approval.status === 'voided' ? str(approval.voided_reason) : undefined,
  };
}


/** Narrow a stored `coverage_decision` to the wire shape, or undefined when malformed. */
function coverageDecisionOf(raw: unknown): ApprovalDecisionPayload['coverage_decision'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const rejected = ids(r.rejected_criterion_ids);
  const covered = ids(r.covered_criterion_ids);
  if ((r.decision !== 'approve' && r.decision !== 'reject') || !rejected || !covered) return undefined;
  if (typeof r.criteria_total !== 'number') return undefined;
  return {
    decision: r.decision,
    rejected_criterion_ids: rejected,
    covered_criterion_ids: covered,
    criteria_total: r.criteria_total,
  };
}

// ---------------------------------------------------------------------------
// Expiry re-queue notice
//
// `deliverDecisionCallback` (below) is the DECISION path — it is reached only from the
// three handlers that record a human verdict (routes/approvals.ts,
// telegram-webhook.ts, teams-webhook.ts). The reaper in
// workers/approval-expiry.ts is not one of them, and must never become one:
// firing the decision path for a lapse would run the approval-completion phase advance (deleted, fr#1481)
// and the receiver's approve/reject branches against an approval nobody
// answered.
//
// This is a separate, deliberately narrower sender. It only ever emits
// `decision: 'expired'`, which is a re-queue notice, not a verdict.
// ---------------------------------------------------------------------------

/**
 * Receiver webhook paths that UNDERSTAND `decision: 'expired'`.
 *
 * ⚠️ THIS IS AN ALLOWLIST, NOT A CONVENIENCE. Every entry was taught the
 * `expired` branch explicitly — validation, routing AND the card action,
 * together (the first two by n8n_custom_nodes #1187, the third by #1193) —
 * because those receivers' `Route by decision` runs `fallbackOutput: "none"`:
 * an accepted-but-unrouted item is silently dropped, which is strictly worse
 * than a loud 400. A path belongs here only once its receiver is DEPLOYED, not
 * once the PR that teaches it is merged.
 *
 * `kanban/approval-callback` WAS deliberately absent, and is now admitted —
 * the condition its exclusion named has been met. Until n8n_custom_nodes #1193
 * it had no decision allowlist at all, so an `expired` there fell through
 * `Parse Decision` → `shouldMoveCard:false` → `Add Comment Only` → HTTP 200:
 * a comment on a card that never moves. Firing at it then would have reported
 * success and re-queued nothing — the stranding defect behind a green light.
 *
 * ⛔ THE GATE IS THE DEPLOY, NOT THE MERGE, AND THAT DISTINCTION IS THE WHOLE
 * REASON THIS ENTRY IS SAFE. Admitting the path while the old receiver is still
 * the live one converts a silent stranding into an ACTIVE MIS-ROUTE, which is
 * worse than the bug. Verified against the live `workflow_entity` row on
 * worker4 before this line was added — not against the merge:
 *
 * ⚠️ CORRECTED 2026-09-07 — this paragraph used to read "Merging #1193 imports
 * nothing into n8n." ⛔ THAT IS FALSE, AND IT WAS FALSE WHEN IT WAS WRITTEN.
 * `nonagenticai/n8n_custom_nodes` `.github/workflows/build-and-deploy.yml` fires
 * `on: push: branches:[main], paths:['workflows/**', ...]` and runs job
 * `import-production-workflows` (`scripts/import-production-workflows.sh`),
 * which PUTs `/api/v1/workflows/<id>` at `https://n8n.example.com` (find-or-create
 * by `.name`), then job `verify-prod-matches-main` read-back diffs it. ⭐ MERGING
 * IMPORTS TO PRODUCTION AUTOMATICALLY AND UNATTENDED, IN ABOUT 80 SECONDS.
 * Measured end to end on `n8n_custom_nodes@5841de79` (committed 11:32:33Z):
 * run 34117154716 — `import-production-workflows` success 11:33:33→11:34:13Z,
 * `verify-prod-matches-main` success 11:34:15→11:34:37Z; live
 * `workflow_entity.updatedAt` for `exec::ready-signoff-callback` moved to
 * 2026-09-07 11:33:55.564+00, i.e. +82s after the merge and inside that job's
 * window. Positive control: sibling `AA Pattern - Approval Callback`
 * (`yG1N9K2hTswEZNTq`) stayed at 2026-09-05, so the query is sound and the move
 * is attributable. ⚠️ Not a premise that expired either — the import job has
 * existed since `c642736f` (2026-06-01), months before #1193 merged.
 * (The commit message on `af00f057` carries the same stale claim. A commit
 * message is immutable; it cannot be corrected, only known about.)
 *
 * ⭐ THE CONCLUSION ABOVE STILL HOLDS — for a different reason. Verify against
 * the live row, not the merge, NOT because a merge imports nothing but because
 * the import is A CLAIM TO OBSERVE, NOT TO TRUST: it is path-filtered (a change
 * outside `workflows/**` imports nothing) and the job can be skipped or
 * cancelled. That failure is documented in the workflow itself — `7851c8bf`
 * is literally "a skipped import must not look like a successful deploy", and
 * the `import_only` dispatch input exists to repair exactly that. So watch
 * `import-production-workflows` on the merge commit, then read the row.
 *   id                 yG1N9K2hTswEZNTq  (AA Pattern - Approval Callback)
 *   updatedAt          2026-08-31 12:57:28+00   (post-merge)
 *   active             t
 *   versionId          == activeVersionId       (the executed version IS this one)
 *   activeVersion nodes contain `expired`       t
 * The `activeVersion` half is not belt-and-braces: n8n keeps a separate
 * snapshot per workflow and a credential-id change has been seen to update the
 * top-level nodes while `activeVersion` kept the old ones. Check both.
 *
 * If you ever need to re-verify:
 *   SELECT w."versionId", w."activeVersionId",
 *          (h.nodes::text LIKE '%expired%') AS active_version_has_expired
 *     FROM workflow_entity w
 *     LEFT JOIN workflow_history h ON h."versionId" = w."activeVersionId"
 *    WHERE w.id = 'yG1N9K2hTswEZNTq';
 */
export const EXPIRY_CALLBACK_PATHS: ReadonlySet<string> = new Set([
  // workflows/improvement/approval_callback.json — the universal receiver.
  'improvement-approval-callback',
  // workflows/patterns/execution-ready-signoff-callback.json. fr pins
  // execution.ready_signoff rows to this exact value with a z.literal
  // (routes/execution-approvals.ts) and expiry never rewrites callback_path,
  // so every ready-signoff expiry lands here.
  'execution-ready-signoff-callback',
  // workflows/patterns/approval-callback.json — the card-blocking receiver, and
  // the largest expiring population on prod. Taught the `expired` branch by
  // n8n_custom_nodes #1193, which reuses the existing `Planka: move card to
  // TODO` path. Admitted only after the deploy check above.
  //
  // ⚠️ CORRECTED 2026-09-13 (#1098). This comment used to claim #1193 "KEEPS the
  // guard that throws when `expired && !todo_list_id` — without that throw a null
  // listId no-ops and the card strands anyway". BOTH HALVES ARE FALSE, and the
  // error propagated: `workers/approval-expiry.ts` cited it as the justification
  // for excluding this rail from the redrive, which left 367 cards permanently
  // BLOCKED.
  //
  // MEASURED against the LIVE ACTIVE workflow `yG1N9K2hTswEZNTq` (`active=t`,
  // `versionId = activeVersionId`, updated 2026-09-10 18:25 — the deployed copy,
  // not the repo file): `Resolve Target List` computes
  // `todoListId = ctx.todoListId || resolved.TODO || ''` from a live
  // `Planka: Get Board Lists` call, and states in as many words "DELIBERATELY DOES
  // NOT THROW. An unresolvable list still falls through to 'Add Comment Only' …
  // Visibly broken beats silently nothing." A blank `metadata.todoListId` is the
  // NORMAL shape here — the minter hardcodes `todoListId: ''` and 0 of 317 rows
  // have ever carried one — and the receiver derives the target itself.
  'kanban/approval-callback',
]);

/**
 * How long ONE re-queue notice may take before it is abandoned.
 *
 * ⚠️ LOAD-BEARING. Without it the reaper blocks on the network, and a tick may
 * hold 500 rows, so an unreachable receiver would keep a worker that ticks every
 * 15 MINUTES busy for a large fraction of them. (Measured smaller but the same
 * shape in tests: an unresolvable webhook host cost ~5s per row and blew a
 * caller's budget.)
 *
 * ⛔ THE 2000 THIS REPLACES WAS A GUESS, AND IT WAS WRONG BY AN ORDER OF
 * MAGNITUDE. The sentence that justified it — "a receiver that cannot answer in
 * 2s is down" — was never measured, and the sibling comment in
 * workers/approval-expiry.ts went further and asserted "a healthy receiver
 * answers in tens of milliseconds". Both are false. 59 of 61 recorded failures
 * on this path read `abandoned after 2000ms`, i.e. this constant was not
 * catching dead receivers, it WAS the failure.
 *
 * MEASURED 2026-09-11, worker4 db `n8n`, `execution_entity` joined to
 * `execution_data`, window 2026-09-08..2026-09-11. All three receivers in
 * {@link EXPIRY_CALLBACK_PATHS} are `responseMode: lastNode`, so the execution
 * duration IS what fr waits on — this is the receiver's own latency, not a
 * proxy for it.
 *
 *   Real `expired` notices (exec::ready-signoff-callback, the only receiver that
 *   has ever run this branch — the kanban one has 0 executions carrying an
 *   expired decision), n = 18:
 *     mean 3,348 · p50 732 · p90 14,967 · p95 17,462 · p99 18,874 · max 19,227
 *     3 of 18 (17%) above the old 2,000.
 *
 *   ⚠️ n = 18 makes that p99 an INTERPOLATION between the top two samples, not a
 *   measurement. p95 and max are the load-bearing numbers; the p99 is quoted so
 *   nobody re-derives it and thinks it is firmer than it is.
 *
 *   All decisions, all three receivers, n = 2,352: mean 22,844 · p50 9,472 · p99
 *   110,592. That tail is NOT this path: it is the approve/reject branches
 *   running the full AA conveyor, which the `expired` branch does not enter. It
 *   is quoted to refute the obvious "size it at the overall p99" reading.
 *
 * ⛔ AND 30_000 IS A CEILING, NOT A PREFERENCE. Two independent budgets bound
 * this from above, and a larger value would be INERT rather than generous:
 *   - `N8nClient.sendApprovalDecision` aborts its own fetch at
 *     `approvalCallbackTimeoutMs()` (services/n8n.ts), default 30_000. Anything
 *     above that loses the race to the client's own AbortSignal every time.
 *   - The whole notice phase stops at `notifyDeadlineMs()` in
 *     workers/approval-expiry.ts — ⚠️ **300_000**, not the 60_000 this line used
 *     to say. `DEFAULT_NOTIFY_DEADLINE_MS` (approval-expiry.ts:327) was raised by
 *     #1096 and these comments did not follow. The ORDERING ARGUMENT ABOVE
 *     SURVIVES — 30_000 still sits under both budgets — it is merely looser
 *     against 300s than against 60s, so the CLIENT's own 30_000 AbortSignal is
 *     the binding ceiling here, not this one.
 * So 30_000 is simultaneously the largest value that can matter and ~1.6x the
 * measured p99. It also matches DEFAULT_APPROVAL_CALLBACK_TIMEOUT_MS, which was
 * raised 10_000 -> 30_000 for the same receiver and the same reason.
 *
 * ⚠️ THE COST, STATED. The phase deadline is checked BEFORE each send, so a
 * slow-but-alive receiver now lets ~2 rows be attempted per tick instead of ~30,
 * and the rest are stamped `callbacksDeferred` — which this worker never
 * retries. That is still the better trade: at 2,000 those ~30 attempts produced
 * 30 guaranteed failures (the row's card never moves), whereas at a measured
 * ~15s receiver the attempts SUCCEED. At the measured p50 of 732 ms a healthy
 * 500-row batch is unaffected either way.
 *
 * Read per call so a test can narrow it. Env: APPROVAL_EXPIRY_CALLBACK_TIMEOUT_MS
 * — confirmed UNSET on the live deployment (neither `deploy/fr` container env
 * nor the `fr-env` secret carries it, checked 2026-09-11), so this default is
 * the value in force and changing it is not inert.
 */
export const DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS = 30_000;

export function expiryCallbackTimeoutMs(): number {
  const raw = Number(
    process.env.APPROVAL_EXPIRY_CALLBACK_TIMEOUT_MS ?? DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS;
}

/** `callback_path` is stored with or without a leading slash; compare normalized. */
export function normalizeCallbackPath(path: string): string {
  return path.replace(/^\/+/, '');
}

export type ExpiryCallbackOutcome =
  | 'sent'
  | 'skipped-no-callback-path'
  | 'skipped-unsupported-receiver'
  | 'skipped-not-expired'
  | 'skipped-not-found'
  | 'failed';

export interface ExpiryCallbackResult {
  outcome: ExpiryCallbackOutcome;
  /** Present only for `failed`. */
  error?: string;
}

/**
 * Tell n8n that an approval LAPSED, so the receiver can re-queue its card.
 *
 * Never throws — the caller is a batch reaper and one dead webhook must not
 * leave the rest of the batch un-expired. The outcome is returned so the caller
 * can count it and stamp the row; swallowing it into a log line only would
 * recreate the stranding defect somewhere nobody looks.
 *
 * Guards, in order:
 *   1. the row must actually be `expired` (never notify a live approval);
 *   2. it must have a `callback_path` (a web-only approval has no n8n side);
 *   3. that path must be a receiver that can route `expired`.
 */
export async function sendN8nExpiryCallback(
  approvalId: string,
  deps: {
    db?: typeof db;
  } = {},
): Promise<ExpiryCallbackResult> {
  const database = deps.db ?? db;

  const [approval] = await database
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));

  if (!approval) return { outcome: 'skipped-not-found' };
  if (approval.status !== 'expired') return { outcome: 'skipped-not-expired' };
  if (!approval.callback_path) return { outcome: 'skipped-no-callback-path' };
  if (!EXPIRY_CALLBACK_PATHS.has(normalizeCallbackPath(approval.callback_path))) {
    return { outcome: 'skipped-unsupported-receiver' };
  }

  // No decision row is read, and none exists: an expiry is the ABSENCE of a
  // decision. `decided_by` therefore resolves to 'system' inside the builder.
  const payload = buildCallbackPayload(approval, undefined, {
    projectId: await resolveCallbackProjectId(approval),
  });

  // ── RECORD THE ATTEMPT BEFORE MAKING IT ───────────────────────────────────
  //
  // THE DEFECT THIS CLOSES. Until here, a re-queue notice that SUCCEEDED wrote
  // no column at all: only failures were durable, appended to `error_message`
  // by workers/approval-expiry.ts::recordCallbackFailure. Measured on prod
  // 2026-09-08: of 120 expired rows, 61 carry a recorded failure and 59 carry
  // NOTHING — and for those 59, 'sent' and 'skipped-unsupported-receiver' are
  // indistinguishable forever. `callback_delivered_at` cannot fill the gap: its
  // only writer is workers/deblock-callback-redelivery.ts, whose predicate is
  // `status IN ('approved','voided')`, so an `expired` row is excluded from it
  // BY CONSTRUCTION, not by failure. The absence is structural.
  //
  // ⭐ INCREMENTED BEFORE THE SEND, NOT AFTER, AND THAT ORDER IS THE WHOLE
  // DISCRIMINATOR. Stamped after a 2xx it would just duplicate
  // `callback_acked_at`. Stamped before, it separates "fr made a call and the
  // receiver did not answer" from "fr never called", which is precisely the
  // pair a timeout makes ambiguous. Combined with the columns already on the
  // row, every outcome of this function is now readable after the fact:
  //
  //   sent                          attempts >= 1, callback_acked_at NOT NULL
  //   failed (incl. timeout)        attempts >= 1, acked NULL, error_message set
  //   skipped-unsupported-receiver  attempts  = 0, acked NULL, callback_path NOT NULL
  //   skipped-no-callback-path      callback_path IS NULL
  //
  // ⛔ IT DELIBERATELY DOES NOT WRITE `callback_resolution`. That column's four
  // values are the DE-BLOCK worker's terminal vocabulary, and a non-NULL value
  // there removes a row from that worker's candidate predicate. An `expired` row
  // is not in its population today, so writing one would change nothing NOW and
  // silently pre-retire the whole cohort the day somebody widens the predicate
  // to `expired` — which is a live open question (see the worker's "expired is
  // NOBODY ANSWERING" block). Recording the attempt does not pre-empt that
  // decision; classifying the row would.
  //
  // ⚠️ NO INTERFERENCE WITH THE DE-BLOCK WORKER'S USE OF THIS SAME COUNTER.
  // Its MAX_SEND_ATTEMPTS bound applies to `approved`/`voided` rows. Statuses
  // are terminal and disjoint — expiry only ever touches `pending`, and
  // handleUpdateApproval 422s a non-pending row — so no row can be counted by
  // both paths.
  //
  // Best-effort by the same rule as every other stamp here: losing the counter
  // must not cost the re-queue notice itself, which is the durable half.
  try {
    await database
      .update(approvals)
      .set({
        callback_send_attempts: sql`${approvals.callback_send_attempts} + 1`,
        updated_at: new Date(),
      })
      .where(eq(approvals.id, approvalId));
  } catch (err) {
    console.error(
      `[n8n-callback] could not record a re-queue send attempt on ${approvalId} — ` +
        'the notice is still being sent, but this row will read as never-attempted:',
      err,
    );
  }

  // The ack stamp, in one copy: written by the on-time path below AND by a
  // success that lands after the race was lost.
  const stampAcked = async (late: boolean): Promise<void> => {
    try {
      await database
        .update(approvals)
        .set({ callback_acked_at: new Date(), updated_at: new Date() })
        .where(eq(approvals.id, approvalId));
    } catch (err) {
      // The receiver DID accept it, so this is not a delivery failure — but the
      // row now reads as attempted-and-unacked, which is the shape of a
      // TIMEOUT. Loud, never silent: a reader would otherwise draw exactly the
      // wrong conclusion from the pair of columns this commit exists to make
      // trustworthy.
      console.error(
        `[n8n-callback] n8n ACKED the re-queue notice for ${approvalId}` +
          (late ? ' (after the timeout)' : '') +
          ' but could NOT stamp callback_acked_at — this row will read as a failed ' +
          'or timed-out send even though the receiver accepted it:',
        err,
      );
    }
  };

  const timeoutMs = expiryCallbackTimeoutMs();
  let raceLost = false;
  const send = n8nClient.sendApprovalDecision(approval.callback_path, payload);
  // If the race is lost, this promise still settles later. A late SUCCESS is
  // still an ack — the receiver took the notice — so stamp it exactly as the
  // on-time path does (this function has already returned 'failed'; the column
  // is what corrects the record). A late rejection is swallowed: a rejection
  // with no listener takes the process down.
  void trackDetached(
    send
      .then(async () => {
        if (raceLost) await stampAcked(true);
      })
      .catch(() => {}),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      send,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          raceLost = true;
          reject(new Error(`re-queue callback abandoned after ${timeoutMs}ms (no response)`));
        }, timeoutMs);
      }),
    ]);
    // n8n returned 2xx — it ACCEPTED the re-queue notice. That is all this site
    // can honestly know, and `callback_acked_at` is 113's name for exactly that
    // measurement, so it is all that is written.
    //
    // ⛔ NOT `callback_delivered_at`. Since 113 that column means THE CARD
    // MOVED, established only by re-reading Planka, which nothing on the expiry
    // path does. Writing it here would recreate 113's 373/373 defect on a new
    // population, and worse: `callback_delivered_at IS NULL` is half the
    // de-block worker's candidate predicate, so a false stamp would retire these
    // rows from the only repair path there is.
    //
    // ⚠️ AN ACK IS NOT A RE-QUEUE. This records that the receiver took the
    // notice, not that the card left BLOCKED. Whether an expired card-blocking
    // approval is re-raised at all is the open question named in
    // workers/deblock-callback-redelivery.ts; this makes the send observable so
    // that question can be answered from data instead of guessed.
    await stampAcked(false);
    return { outcome: 'sent' };
  } catch (err) {
    // ⚠️ A TIMEOUT IS REPORTED AS A FAILURE EVEN THOUGH THE RECEIVER MAY STILL
    // ACT ON IT. That asymmetry is deliberate, but NOT because the receiver
    // dedupes — IT DOES NOT. `approval-callback` ("AA Pattern - Approval
    // Callback") moves the card with an unconditional `card.update{listId}`;
    // its only idempotency marker is an `already_merged` branch covering the
    // MERGE path. What makes over-reporting safe is that NOTHING ACTS ON THE
    // FAILURE IS NARROWLY SCOPED. ⚠️ UPDATED: a re-delivery worker IS now
    // registered (workers/deblock-callback-redelivery.ts). It does not make
    // over-reporting unsafe, because it never trusts this column on its own —
    // it asks Planka for the card's CURRENT list and sends only when the card
    // is still in BLOCKED. A card this failure path stranded is in BLOCKED, so
    // it is repaired; a card that in fact moved is not a candidate at all.
    // Over-reporting is honest about what fr actually observed. Under-reporting
    // is what strands cards.
    return {
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The DECISION callback
// ---------------------------------------------------------------------------

export type DecisionCallbackOutcome =
  | 'sent'
  | 'skipped-not-found'
  | 'skipped-no-callback-path'
  // Same spelling as `ExpiryCallbackOutcome`'s member ON PURPOSE — it is the
  // same refusal for the same reason (a receiver that cannot route this
  // decision), and `routes/approvals.ts` already prints any outcome that is
  // neither `sent` nor `skipped-no-callback-path` by name.
  | 'skipped-unsupported-receiver'
  | 'failed'
  // ⭐ A TIMEOUT IS AN UNKNOWN OUTCOME, NOT A FAILURE — it is spelled separately
  // from `failed` because the two make OPPOSITE claims about the receiver.
  // `failed` says the receiver did not take the work. This member says only that
  // FR STOPPED WAITING before the receiver answered: whether the card moved is
  // UNKNOWN to this process, and on the measured evidence it very likely DID.
  //
  // MEASURED 2026-09-13: 66 rows in 3 days recorded
  // `decision callback abandoned after 5000ms (no response)`, while n8n recorded
  // ZERO errored executions over the same window. The receiver's own latency,
  // quoted in the expiry-timeout block above, is p50 9,472 ms / mean 22,844 ms —
  // i.e. fr was abandoning BELOW the receiver's median and then reporting a
  // client-side abort as a receiver FAILURE. Those 66 rows are not 66 refusals.
  //
  // ⛔ LIKE EVERY NON-`sent` OUTCOME, THIS ONE STAMPS NOTHING. `callback_acked_at`
  // stays NULL, so the row stays inside the candidate predicate of
  // workers/deblock-callback-redelivery.ts and the worker reconciles it against
  // the card's ACTUAL list — which is the only reader that can resolve the
  // unknown this member names.
  | 'timeout-unknown'
  // ⭐ THE RECEIVER SAID THE WAITING EXECUTION IS GONE (HTTP 409/410), so there
  // was nothing left to deliver and fr stopped replaying at it. This is NOT a
  // failure and NOT an unknown: it is the terminal answer to the question the
  // send asked. Reached only from the callback_url lane
  // (`deliverApprovalCallbackUrls`); the legacy `callback_path` lane never
  // classifies a status this way. Those rows are retired
  // (`markCallbackUrlAlreadyTerminal`), never re-scheduled.
  | 'already-terminal';

export interface DecisionCallbackResult {
  outcome: DecisionCallbackOutcome;
  /** Present only for `failed` or `timeout-unknown`. */
  error?: string;
  /**
   * ⭐ THE RECEIVER'S OWN 200 BODY, RETURNED VERBATIM. Present only for `sent`.
   *
   * ⛔ IT IS NOT A SECOND STAMP AND IT DOES NOT WIDEN WHAT AN ACK MEANS — read the
   * header before touching this. `callback_acked_at` still means TRANSPORT ACK and
   * only the de-block worker may write `callback_delivered_at`; nothing here is
   * persisted by this function, and nothing here may be.
   *
   * WHY IT EXISTS. `AA Pattern - Approval Callback` answers 200 with a body that
   * SAYS WHAT IT DID: `Final Output` (n8n id yG1N9K2hTswEZNTq) returns
   * `{ processed, cardId, decision, cardMoved, deblock_action, deliberate_hold,
   * resolve_diagnostic, … }`, and for an approved `QUESTION` carrying no answer
   * text it returns `deliberate_hold: true` with `resolve_diagnostic` ending
   * `APPROVED WITH NO ANSWER: the ask is still open`. It was DELIBERATELY holding
   * the card. This function used to `await` the send and throw the body away, so
   * fr counted the ack, learned nothing, and re-sent four more times before
   * retiring the row `send_exhausted / receiver_unresponsive` — blaming n8n for a
   * decision n8n reported in the response.
   *
   * ⚠️ TYPED AS THE CLIENT'S DECLARED SHAPE, WHICH THE LIVE BODY DOES NOT MATCH.
   * `N8nWebhookResponse` declares `{ success, message?, data? }` and this receiver
   * emits neither `success` nor `data` — the interesting fields are TOP LEVEL. So
   * every reader must narrow defensively (see `classifyReceiverHold` in
   * workers/deblock-callback-redelivery.ts, which reads top level AND `data`), and
   * ⛔ nobody may branch on `response.success` for this path: it is `undefined` on
   * every send this receiver has ever answered, which is falsy.
   */
  response?: N8nWebhookResponse;
}

/**
 * Receiver webhook paths that UNDERSTAND `decision: 'voided'`.
 *
 * ⚠️ THIS IS AN ALLOWLIST, NOT A CONVENIENCE — the same allowlist, for the same
 * reason, as `EXPIRY_CALLBACK_PATHS` above, one decision value over. Read that
 * comment first; this one only records what is different.
 *
 * `buildCallbackPayload` does not MAP the decision, it PASSES THE ROW'S STATUS
 * THROUGH (`decision: approval.status`, and the comment there says so). So a
 * voided approval puts the literal string `voided` on the wire, and a receiver
 * that was never taught that value decides what happens to it — which is the
 * whole problem, because on these receivers "decides" means "drops".
 *
 * ⭐ MEASURED 2026-09-07 against the LIVE n8n `workflow_entity` on worker4 and
 * fr's prod `approvals` table (SELECT-only). Path → workflow was resolved from
 * `webhook_entity.webhookPath`, NOT from the workflow's display name:
 *
 *   path                              workflow (active)              routes 'voided'
 *   kanban/approval-callback          AA Pattern - Approval Callback       YES
 *   execution-ready-signoff-callback  exec::ready-signoff-callback         NO
 *   improvement-approval-callback     improve::approval-callback           NO
 *
 * ⛔ ONLY `kanban/approval-callback` IS ADMITTED, and note that this is a
 * STRICTLY SMALLER set than `EXPIRY_CALLBACK_PATHS`. The two lists are not
 * interchangeable and must not be merged: a receiver taught `expired` was not
 * thereby taught `voided`, and two of the three expiry entries prove it.
 *
 * WHY `kanban/approval-callback` IS ON THE LIST. Its live row
 * `yG1N9K2hTswEZNTq` is `active`, its `versionId` EQUALS its `activeVersionId`
 * (the executed version is this one), and `voided` appears in the `Parse
 * Decision` and `Resolve Target List` code nodes of BOTH the top-level `nodes`
 * and the `activeVersion` snapshot in `workflow_history`. Both halves are
 * checked for the reason the expiry comment gives: those two have been seen to
 * disagree.
 *
 * WHY `execution-ready-signoff-callback` IS NOT, and this is the entry that
 * matters — fr routes 98 voided approvals at it today (854 rows on that path,
 * of which 94 of the 98 voided have `callback_delivered_at IS NULL`). Its
 * `Route by decision` Switch carries `fallbackOutput: "none"` and exactly four
 * output keys:
 *
 *     idempotent, approved, rejected, expired          ⛔ no `voided`
 *
 * `fallbackOutput: "none"` means an item matching no rule is DROPPED — the
 * webhook still answers 200, fr stamps `callback_acked_at`, and nothing moves.
 * That is the silent-stranding shape, not a loud 400. ⚠️ NOTE it is not that
 * this receiver "has no decision allowlist" — it HAS one and `voided` is
 * absent from it, which is worse, because the drop is deliberate and quiet.
 *
 * ⛔ ADDING A PATH REQUIRES EVIDENCE THE RECEIVER HANDLES `voided`, AND THE
 * GATE IS THE DEPLOY, NOT THE MERGE. Merging in `n8n_custom_nodes` DOES import
 * to production automatically (`build-and-deploy.yml` → `import-production-
 * workflows`, ~80s) but that job is path-filtered and can be skipped or
 * cancelled, so it is a claim to OBSERVE, not to trust. Watch the import job on
 * the merge commit, then read the live row. Re-derive with:
 *
 *   SELECT we."webhookPath", w.name, w.active,
 *          (w."versionId" = w."activeVersionId") AS ver_match,
 *          (w.nodes::text  LIKE '%voided%')      AS top_has_voided,
 *          (h.nodes::text  LIKE '%voided%')      AS active_has_voided
 *     FROM webhook_entity we
 *     JOIN workflow_entity w  ON w.id = we."workflowId"
 *     LEFT JOIN workflow_history h ON h."versionId" = w."activeVersionId"
 *    WHERE we."webhookPath" = '<the path you want to add>';
 *
 * and, for a Switch-routed receiver, the keys it can actually reach:
 *
 *   SELECT n->>'name',
 *          n->'parameters'->'options'->>'fallbackOutput',
 *          (SELECT string_agg(v->>'outputKey', ',')
 *             FROM jsonb_array_elements(n->'parameters'->'rules'->'values') v)
 *     FROM workflow_entity w, jsonb_array_elements(w.nodes::jsonb) n
 *    WHERE w.id = '<id>' AND lower(n->>'type') LIKE '%switch%';
 */
export const VOIDED_CALLBACK_PATHS: ReadonlySet<string> = new Set([
  // workflows/patterns/approval-callback.json — the card-blocking receiver, and
  // the only one of the three measured to route `voided`. Carries 240 of the
  // 341 voided rows on prod.
  'kanban/approval-callback',
]);

/**
 * How long ONE decision callback may take before it is abandoned.
 *
 * Applied when a caller asks for it (`deps.timeoutMs`).
 *
 * ⚠️ CORRECTED 2026-09-14 — THIS BLOCK SAID "NO CALLER ASKS FOR IT TODAY, and
 * this function has no callers at all", AND #1116 MADE THAT FALSE THE SAME DAY
 * IT WAS WRITTEN. Two callers now pass it explicitly:
 * `routes/approvals.ts:418` and `lib/chat-seat-decision.ts:307`, both as
 * `sendTimeoutMs()`. The claim that request-path callers "stay on `N8nClient`'s
 * own 10s ceiling" is stale in the same way — they are bounded here, at 30_000.
 * A docblock asserting a parameter is unused, one file from two live call
 * sites, is the reading a later change will trust and be wrong about.
 *
 * The re-delivery worker (`workers/deblock-callback-redelivery.ts`) still does
 * NOT pass it, and that remains deliberate: it is unbounded by design so a slow
 * receiver is retried rather than abandoned.
 *
 * ⚠️ AND THE BATCH ARITHMETIC HERE WAS BUILT ON A STALE 60s. It read "10 rows x
 * 10s is 100s against a 60s tick deadline". The deadline is `notifyDeadlineMs()`
 * = **300_000** (approval-expiry.ts:327, raised by #1096), so 100s no longer
 * exceeds it and the sentence's own numbers stopped supporting its conclusion.
 * ⭐ The conclusion survives on TRUE numbers, and only just: at the 30_000
 * ceiling a bounded batch is 10 rows x 30s = 300s — EXACTLY the tick deadline,
 * so ~10 guaranteed sends per tick and deferral is structural on any fuller
 * batch. 20 of the 81 measured failures were Planka 504s, i.e. exactly the case
 * where every send burns its full ceiling.
 *
 * ⛔ A stale figure in this family has already escaped the file: a peer lane
 * derived a fictitious "66s vs 60s capacity cliff" from it and briefed two other
 * lanes on it before the real 300_000/30_000 numbers refuted the whole
 * narrative. Correct the digits here, not only in the reader's head.
 */

/**
 * ⚠️ RAISED 5_000 -> 30_000 ON 2026-09-13, AND THE OLD VALUE WAS BELOW THE
 * RECEIVER'S MEDIAN.
 *
 * MEASURED 2026-09-13: 66 approvals in 3 days carry
 * `decision callback abandoned after 5000ms (no response)`, and n8n recorded
 * ZERO errored executions in that same window. Against the receiver's measured
 * latency — p50 9,472 ms, mean 22,844 ms, the same figures quoted in
 * `DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS` above — a 5,000 ms deadline does not
 * sample a slow tail: it expires before the TYPICAL send completes. Those 66
 * abandonments were therefore mostly not receiver failures at all; the work very
 * likely COMPLETED and fr merely stopped listening for the answer.
 *
 * ⭐ THE EXPIRY PATH ALREADY MADE THIS EXACT MOVE, against the SAME receiver and
 * for the SAME reason: `APPROVAL_EXPIRY_CALLBACK_TIMEOUT_MS` went 2_000 ->
 * 30_000 (see the block at DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS, which also
 * records the ceiling argument — `N8nClient`'s own 30_000 AbortSignal makes any
 * larger value inert). This is that decision applied to the decision path, which
 * was simply missed at the time.
 */
export const DEFAULT_DECISION_CALLBACK_TIMEOUT_MS = 30_000;

export function decisionCallbackTimeoutMs(): number {
  const raw = Number(
    process.env.APPROVAL_DECISION_CALLBACK_TIMEOUT_MS ?? DEFAULT_DECISION_CALLBACK_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DECISION_CALLBACK_TIMEOUT_MS;
}

/**
 * How long the DECIDER'S HTTP REQUEST waits to learn the outcome — which is a
 * DIFFERENT question from how long fr waits for the receiver, and the two were
 * the same number until 2026-09-13.
 *
 * ⛔ WHY THEY MUST NOT BE ONE KNOB. `reportDecisionCallback`
 * (`routes/approvals.ts`) passed `decisionCallbackTimeoutMs()` as BOTH the send
 * bound and the outer race deadline, so raising it to cover the receiver's p50
 * would have made a human sit on a spinner for the full 30 s after clicking
 * Approve. Lowering it instead is what produced the 66 false
 * `abandoned after 5000ms` stamps. One number cannot serve both: the send bound
 * must exceed the receiver's typical latency, and the human's wait must not.
 *
 * ⭐ SPLITTING THEM COSTS NOTHING, because the race already had the right shape.
 * When this deadline wins, `reportDecisionCallback` answers `pending` — which is
 * TRUE, not a hedge — and DELIBERATELY LEAVES THE SEND IN FLIGHT, so the
 * receiver's answer still lands and still stamps `callback_acked_at` at its own
 * pace. The decider gets a fast, honest answer; the send gets the full 30 s it
 * needed all along. Nothing is abandoned that used to be delivered, and nothing
 * is stamped that used to be unknown.
 *
 * ⚠️⚠️ CORRECTED 2026-09-14 — THE PARAGRAPH THIS REPLACES WAS ARITHMETICALLY
 * SELF-REFUTING, AND IT WAS MINE. It read: "8 s is chosen to sit just UNDER the
 * receiver's measured p50 of 9,472 ms: MOST decisions will still resolve inside
 * the request." A deadline set just under the MEDIAN resolves strictly FEWER
 * THAN HALF of them — that is what a median is. So `pending`, which the operator
 * is shown as "unknown, still reconciling", was the majority outcome of a
 * perfectly healthy approval, not an exceptional one, and the product owner read
 * it exactly as it looked: "Approve seemed to fail."
 *
 * ⛔ THE PREVIOUS FIX SPLIT THE KNOBS AND THEN PUT THE NEW ONE ON THE WRONG SIDE
 * OF THE SAME NUMBER. The split is right and stays; only the value was wrong.
 *
 * ⭐ RE-MEASURED 2026-09-14, live, on worker4 db `n8n` — DO NOT QUOTE THE 9,472
 * FROM MEMORY, IT IS THE OLD POPULATION. `execution_entity` joined to
 * `workflow_entity`, `responseMode: lastNode` so the execution duration IS what
 * fr waits on, grouped by receiver so the decide path is not averaged with the
 * signoff rail, 14-day window:
 *
 *   receiver                          n     mean    p50     p75      p90      p99
 *   AA Pattern - Approval Callback   675   7,857   6,914   10,420   12,928   29,746
 *   exec::ready-signoff-callback     227   4,215   3,805    5,686    7,558   10,508
 *
 *   (For contrast, the figure the comments above still quote — p50 9,472 / mean
 *   22,844, n=2,352, 2026-09-08..11 — pooled ALL THREE receivers and the AA
 *   conveyor branches. Both readings are kept because the choice below must be
 *   right under EITHER, and a value tuned to only the newer one would be a
 *   correction that expires.)
 *
 * 15_000 ms is chosen against BOTH readings:
 *   • it EXCEEDS the p50 under either — 1.58x the stale 9,472, 2.2x the live
 *     6,914 — so the TYPICAL approval now resolves inside the request and the
 *     operator sees the real outcome instead of `pending`;
 *   • it clears the live p90 (12,928), so on today's distribution ~9 in 10 do;
 *   • it is EXACTLY HALF the send bound, so the split this block exists to
 *     defend stays visible and unmistakable at a glance;
 *   • the tail still hands off rather than being abandoned: when this deadline
 *     wins, the send keeps running to the full 30 s, `callback_acked_at` stays
 *     NULL, and workers/deblock-callback-redelivery.ts — the reconciliation
 *     mechanism that ALREADY EXISTS — finds the row. Nothing new is invented to
 *     catch the tail.
 *
 * ⚠️ THE HUMAN'S WAIT IS BOUNDED, AND THE BOUND IS NOT THE TYPICAL WAIT. The
 * worst case rises 8 s -> 15 s; the MEDIAN wait is unchanged at ~6.9 s, because
 * a decision that answers in 6.9 s answers in 6.9 s under either deadline. The
 * only requests that now wait longer are the ones that previously waited 8 s and
 * were then told nothing useful. Still half the 30 s spinner the collapsed knob
 * would have produced.
 *
 * Every seat (web, Telegram, Teams, mcp) decides through `recordApprovalDecision`,
 * so this is every seat's number (owner ruling 2026-10-31: channels are equivalent).
 */
export const DEFAULT_DECISION_REQUEST_DEADLINE_MS = 15_000;

export function decisionRequestDeadlineMs(): number {
  const raw = Number(
    process.env.APPROVAL_DECISION_REQUEST_DEADLINE_MS ?? DEFAULT_DECISION_REQUEST_DEADLINE_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DECISION_REQUEST_DEADLINE_MS;
}

/**
 * Did fr LEARN what happened to this callback, or is it still unknown?
 *
 * ⛔ THE DISTINCTION THE DECIDE RESPONSE COULD NOT MAKE. `PUT /api/approvals/:id`
 * answered HTTP 200 for EVERY completing decision — `sent`, `pending`,
 * `timeout-unknown`, `failed` and all three `skipped-*` alike. An API caller that
 * branches on the status code (which is every non-browser caller: the AA
 * conveyor, the approval scripts, `curl`) therefore could not tell "the decision
 * was recorded AND handed to the receiver" from "the decision was recorded and
 * nothing downstream is known to have happened". The frontend could — it reads
 * `callback.outcome` — but a contract that is only honest to one of its two
 * consumers is honest to neither.
 *
 * ⚠️ THIS IS "fr KNOWS", NOT "THE CARD MOVED", and the names in this file have
 * been wrong about exactly that before (migration 113 moved the stamp for this
 * reason). `sent` means the receiver ACCEPTED the callback. Whether the Planka
 * card actually left BLOCKED is `callback_delivered_at`, written only by
 * workers/deblock-callback-redelivery.ts after it re-reads the board. Do not
 * widen this predicate into a claim about the card.
 *
 * ⚠️ `skipped-no-callback-path` IS settled, and the other two `skipped-*` are
 * NOT. A row with no callback path owed no send, so there is nothing left to
 * learn. `skipped-not-found` and `skipped-unsupported-receiver` are rows where a
 * send WAS owed and deliberately not made — reading those as settled rebuilds
 * the lie this module exists to remove. That is the same membership
 * `lib/chat-seat-decision.ts :: isDelivered` uses, deliberately.
 */
export function decisionOutcomeIsSettled(outcome: string): boolean {
  return outcome === 'sent' || outcome === 'skipped-no-callback-path';
}

/**
 * Send the final decision for a completed approval back to n8n, and RECORD
 * WHETHER IT LANDED.
 *
 * ⛔ THE STAMP IS THE POINT. Before migration 109 this function's only report of
 * a send failure was a `console.error`, and its only caller invoked it
 * fire-and-forget. A failure — or a pod that rolled before the un-awaited promise
 * ran — left the approvals row saying `approved` with nothing anywhere disagreeing,
 * while the Planka card stayed BLOCKED forever. Measured on prod 2026-09-04: 320
 * cards blocked behind 488 already-decided approvals.
 *
 * ⚠️ MIGRATION 113 MOVED THE STAMP, AND THAT IS THE POINT OF THIS FUNCTION NOW.
 * Between 109 and 113 this wrote `callback_delivered_at` on a 2xx. A 2xx from
 * n8n is a TRANSPORT ACK — the webhook acks on receipt, and the Planka
 * `card.update{listId}` that actually moves the card BLOCKED -> DOING happens
 * afterwards, in a queue measured giving up (61 rows) behind a Planka measured
 * 504-ing (20 rows). Because `callback_delivered_at IS NULL` is half the
 * candidate predicate of workers/deblock-callback-redelivery.ts, that stamp
 * RETIRED a row from the only repair path there is, on evidence that the repair
 * had merely been *accepted for processing*.
 *
 * MEASURED 2026-09-06: of 373 callbacks stamped "delivered" in 30h, 373 of 373
 * (253 distinct cards) were still sitting in BLOCKED. The worker drained its own
 * queue, not the board.
 *
 * So: this function stamps `callback_acked_at`, which is the honest name for
 * what it can actually observe, and it stamps NOTHING ELSE. `callback_delivered_at`
 * now means THE CARD MOVED, and only the re-delivery worker may write it — after
 * re-reading the card's list from Planka. An ack does not retire a row; it only
 * opens a grace window, so a card that never moves comes back for another attempt.
 *
 * ⛔ DO NOT "SIMPLIFY" THIS BACK INTO ONE COLUMN. The two facts have different
 * truth values on the same row for 373 measured rows, and collapsing them is the
 * defect, not a tidy-up.
 *
 * ⚠️ WHY THIS FUNCTION DOES NOT DO THE EFFECT CHECK ITSELF. It is called on the
 * live decision path (routes/approvals.ts) as well as from the worker, has no
 * Planka dependency, and n8n's move is asynchronous — an immediate re-read here
 * would almost always still say BLOCKED, so it would answer "no effect" for
 * every healthy send while adding a Planka round-trip to every human decision.
 * The verification belongs where the Planka client and the retry budget already
 * live: the worker.
 *
 * Never throws. The outcome is RETURNED so the caller (and the worker) can count
 * it; swallowing it into a log line only is the defect.
 */
export type DeliverDecisionCallbackDeps = {
    db?: typeof db;
    /** Abandon the send after this many ms. Omitted = the client's own ceiling. */
    timeoutMs?: number;
    /**
     * TRUE only when this decision has already been delivered once and is being
     * re-sent. Set by workers/deblock-callback-redelivery.ts and by nothing else;
     * every other caller is a first delivery and passes nothing. Arms the
     * receiver's re-delivery idempotence guard.
     */
    redelivery?: boolean;
  };

export async function deliverDecisionCallback(
  approvalId: string,
  deps: DeliverDecisionCallbackDeps = {},
): Promise<DecisionCallbackResult> {
  const database = deps.db ?? db;

  const [approval] = await database.select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));

  if (!approval) {
    console.warn(`[n8n-callback] Approval ${approvalId} not found`);
    return { outcome: 'skipped-not-found' };
  }

  // ── D17: STORED callback_url(s) (n8n Wait-node resume URLs) WIN ─────────────
  // Such an approval was minted with `callback_path` NULL, so nothing keyed on
  // the path (this function's legacy branch below, the de-block worker, the
  // expiry sender) ever posts it to `${N8N_WEBHOOK_URL}/<path>`. Only the side
  // table holds the URLs (migration 191, 1:N) — capabilities, never logged.
  const callbackRows = await database
    .select({ id: approvalCallbackUrls.id, callback_url: approvalCallbackUrls.callback_url })
    .from(approvalCallbackUrls)
    .where(eq(approvalCallbackUrls.approval_id, approvalId));
  let urlResult: DecisionCallbackResult | undefined;
  if (callbackRows.some((r) => r.callback_url.length > 0)) {
    urlResult = await deliverToCallbackUrls(database, approval, deps);
    // A gate minted WITH callback_url has callback_path NULL: the URLs are all.
    if (!approval.callback_path) return urlResult;
  }
  // A LEGACY gate (callback_path set) that a later create deduped onto and
  // attached a callback_url to: its own receiver is still owed the decision, so
  // the legacy path runs too. 'sent' only when both delivered.
  const legacy = await deliverLegacyDecisionCallback(database, approval, approvalId, deps);
  return urlResult && legacy.outcome === 'sent' && urlResult.outcome !== 'sent' ? urlResult : legacy;
}

async function deliverLegacyDecisionCallback(
  database: typeof db,
  approval: ApprovalRow,
  approvalId: string,
  deps: DeliverDecisionCallbackDeps,
): Promise<DecisionCallbackResult> {
  if (!approval.callback_path) {
    // Web-only approval — no n8n callback needed. Deliberately NOT stamped:
    // `callback_delivered_at` records a delivery that happened, and nothing was
    // delivered. A re-delivery worker would select on `callback_path IS NOT
    // NULL`, so these rows would never be in its population and need no marker —
    // (workers/deblock-callback-redelivery.ts selects exactly that way, so these
    // rows are correctly outside its population. An earlier revision of this
    // comment added "and no such worker is registered today" — no longer true.)
    return { outcome: 'skipped-no-callback-path' };
  }

  // ⛔ THE RECEIVER MUST BE ABLE TO ROUTE THIS DECISION. Same guard, same
  // spelling and same refusal as `sendN8nExpiryCallback`'s third guard: skip the
  // send, return the outcome, stamp NOTHING, never throw. See
  // `VOIDED_CALLBACK_PATHS` for the measurement behind the list.
  //
  // Scoped to `voided` ALONE and deliberately so. `approved`/`rejected` are
  // routed by every receiver measured and are not gated here; `expired` never
  // reaches this function at all (it has its own narrower sender above). A gate
  // that withheld more than the one decision value nobody can route would be as
  // wrong as no gate.
  //
  // ⚠️ NOT STAMPING IS THE CORRECT REFUSAL, not an oversight. `callback_acked_at`
  // stays NULL, which is the honest record — n8n acked nothing because fr sent
  // nothing. It also leaves the row visible to
  // workers/deblock-callback-redelivery.ts rather than retiring it, which is
  // what we want: the day the receiver is taught `voided` and added to the list,
  // the rows this refused are still there to be delivered. Before this guard
  // those rows were *sent* and silently dropped by the receiver's
  // `fallbackOutput: "none"`, so the refusal replaces a false ack with no ack.
  //
  // Placement: after the `callback_path` guard, mirroring the expiry sender's
  // order. It is deliberately BELOW the phase-advance block, which is unaffected
  // either way — the approval-completion phase advance (deleted, fr#1481) requires `status === 'approved'`,
  // so a voided row never advances a phase and this guard withholds only the
  // outbound call, never a second effect.
  if (
    approval.status === 'voided' &&
    !VOIDED_CALLBACK_PATHS.has(normalizeCallbackPath(approval.callback_path))
  ) {
    // ⭐ #1083 — THE REFUSAL IS NOW DURABLE, NOT JUST CORRECT. Everything the
    // paragraph above says stays true (no ack stamp, row stays in the worker's
    // population), but "stamped NOTHING" also meant this row was afterwards
    // indistinguishable from one nobody had decided. The note names the receiver
    // and the decision value, so the recovery this refusal PROMISES — the day the
    // receiver is taught `voided` — can be scoped from a query instead of guessed.
    await recordDecisionCallbackProblem(
      database,
      approvalId,
      `n8n decision callback NOT SENT: receiver '${approval.callback_path}' is not in ` +
        "VOIDED_CALLBACK_PATHS, so it cannot route decision 'voided'. Nothing was sent; " +
        'callback_acked_at stays NULL and this row remains a re-delivery candidate.',
    );
    return { outcome: 'skipped-unsupported-receiver' };
  }

  // Get decisions to find who decided and their comments
  const decisions = await database.select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approval_id, approvalId));

  const lastDecision = decisions[decisions.length - 1];
  const payload = buildCallbackPayload(approval, lastDecision, {
    redelivery: deps.redelivery,
    projectId: await resolveCallbackProjectId(approval),
  });

  let response: N8nWebhookResponse | undefined;
  try {
    // ⭐ THE RETURN VALUE IS KEPT NOW, WHERE IT USED TO BE DISCARDED. See
    // `DecisionCallbackResult.response`: the receiver reports in this body whether
    // it MOVED the card or deliberately HELD it, and throwing that away is what
    // made five sends of an unanswerable payload look like an unresponsive n8n.
    response = await withOptionalTimeout(
      n8nClient.sendApprovalDecision(approval.callback_path, payload),
      deps.timeoutMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[n8n-callback] Failed to send decision for approval ${approvalId}:`, error);
    // ⛔ NO ACK STAMP. Leaving `callback_acked_at` NULL is what lets
    // a future re-delivery find this row again. A `failed`
    // outcome that also stamped it would look identical to a success to every reader.
    //
    // ⭐ #1083 — BUT THE FAILURE ITSELF IS NOW RECORDED. "No stamp" used to mean
    // "no trace at all": the row read exactly like one that had never been
    // decided, and the only report was the `console.error` above. The reason goes
    // to `error_message` (the same column and same shape
    // workers/approval-expiry.ts uses for the expiry-callback failures), so a
    // query can find these rows and say WHY, not just that they are unacked.
    //
    // ⭐ BUT A TIMEOUT IS NOT ONE OF THOSE FAILURES, AND SAYING "FAILED" ABOUT IT
    // WAS A CLAIM fr COULD NOT MAKE. `DecisionCallbackTimeout` means only that
    // this process stopped waiting — see the class's own comment. It is branched
    // BEFORE the FAILED write so the 66 rows/3 days measured on 2026-09-13 stop
    // accusing a receiver that logged zero errored executions over the same
    // window. Genuine transport errors fall through to the FAILED branch below,
    // unchanged; the `console.error` above fires for both, on purpose, because a
    // send that did not answer inside the deadline is worth a log line either way.
    if (error instanceof DecisionCallbackTimeout) {
      await recordDecisionCallbackProblem(
        database,
        approvalId,
        `n8n decision callback OUTCOME UNKNOWN: ${message}. The receiver's measured latency is ` +
          'p50 ~9.5s / mean ~22.8s and it records no failed executions, so the work may well have ' +
          'COMPLETED — fr stopped waiting. callback_acked_at stays NULL, so this row remains a ' +
          're-delivery candidate and the worker will reconcile it.',
      );
      return { outcome: 'timeout-unknown', error: message };
    }

    await recordDecisionCallbackProblem(
      database,
      approvalId,
      `n8n decision callback FAILED: ${message}`,
    );
    return { outcome: 'failed', error: message };
  }

  // The send returned 2xx — i.e. n8n ACCEPTED it. That is all this site can
  // honestly know, so `callback_acked_at` is all it writes. It happens BEFORE
  // the log line, because a log line is what this defect had.
  //
  // ⛔ NOT `callback_delivered_at`. See the header: that column now means the
  // card moved, and only the worker can establish that.
  try {
    await database
      .update(approvals)
      .set({ callback_acked_at: new Date(), updated_at: new Date() })
      .where(eq(approvals.id, approvalId));
  } catch (err) {
    // The receiver DID accept it, so this is not a delivery failure. The cost of
    // losing THIS stamp is now much smaller than it was before 113: the ack only
    // opens a grace window, so an unrecorded ack means the worker may re-send
    // this row one tick sooner than it needed to — against a card it will
    // re-check is still in BLOCKED first. It is not a silent write-off any more.
    // Loud, never silent — the row is still wrong and worth knowing about.
    console.error(
      `[n8n-callback] n8n ACKED approval ${approvalId} but could NOT stamp ` +
        'callback_acked_at — the row reads as never-sent, so the re-delivery ' +
        'worker may retry it early (its live BLOCKED gate still applies):',
      err,
    );
  }

  console.log(`[n8n-callback] Sent decision for approval ${approvalId} to n8n (${approval.callback_path})`);
  // ⚠️ `response` MAY BE `undefined` EVEN HERE, and a reader must handle that
  // rather than treat its absence as evidence of anything. A 2xx whose body is not
  // JSON never reaches this line (`N8nClient.sendApprovalDecision` throws out of
  // `response.json()`), but its declared result does not promise a body either.
  // Absence of a hold marker is not a hold; it is silence.
  return { outcome: 'sent', response };
}

/** The statuses whose callback_url rows are POSTed: every terminal one. */
export const CALLBACK_URL_TERMINAL_STATUSES = ['approved', 'rejected', 'expired', 'voided'] as const;

export type CallbackUrlDeliveryDeps = Pick<
  DeliverDecisionCallbackDeps,
  'db' | 'timeoutMs'
>;

/**
 * D17 — POST an approval's terminal outcome to EVERY attached `callback_url`
 * (migration 191, 1:N), each EXACTLY as given, with the EXISTING payload
 * (`buildCallbackPayload`) and `X-Approval-Callback-Secret`. Reached on a
 * decision (approved / rejected, via `deliverDecisionCallback`), on expiry
 * (workers/approval-expiry.ts → decision `expired`, `decided_by: 'system'`, the
 * same no-decision payload `sendN8nExpiryCallback` builds) and on a void
 * (lib/void-approvals.ts → decision `voided`), so a Wait node never waits forever.
 *
 * Each row is CLAIMED before its send (lib/approval-callback-url.ts
 * `claimCallbackUrlSend`), so a row another sender holds, one in backoff, or one
 * already delivered is skipped — and `redelivery: true` rides only a row that has
 * been attempted before. A failure schedules THAT row's backoff; a 2xx marks THAT
 * row delivered. `callback_acked_at` is stamped once no row is left undelivered.
 * Never throws; never logs a URL in full.
 *
 * ⭐ 409/410 IS TERMINAL, NOT A FAILURE. The receiver answers 409 from
 * `webhook-waiting/<executionId>` exactly when that execution is no longer
 * waiting, so the notice is MOOT. That row is retired
 * (`markCallbackUrlAlreadyTerminal`), nothing is recorded as a problem and no
 * retry is scheduled; when no row was delivered the call reports
 * `already-terminal`. Every OTHER non-2xx, timeout and transport error keeps the
 * pre-existing failed/timeout handling — and `failed` still means exactly what
 * it did, so the alert on `outcome="failed"` is untouched.
 */
export async function deliverApprovalCallbackUrls(
  approvalId: string,
  deps: CallbackUrlDeliveryDeps = {},
): Promise<DecisionCallbackResult> {
  const database = deps.db ?? db;
  const [approval] = await database.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) return { outcome: 'skipped-not-found' };
  return deliverToCallbackUrls(database, approval, deps);
}

async function deliverToCallbackUrls(
  database: typeof db,
  approval: ApprovalRow,
  deps: CallbackUrlDeliveryDeps,
): Promise<DecisionCallbackResult> {
  if (!(CALLBACK_URL_TERMINAL_STATUSES as readonly string[]).includes(String(approval.status))) {
    // A pending row has nothing to report yet; its URLs wait for the outcome.
    return { outcome: 'skipped-no-callback-path' };
  }
  const bookkeeping = async (what: string, where: string, f: () => Promise<void>): Promise<void> => {
    try {
      await f();
    } catch (err) {
      console.error(
        `[n8n-callback] could not ${what} for approval ${approval.id} (callback_url ${where}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const rows = (await database.execute<{ id: string; callback_url: string }>(sql`
    SELECT id, callback_url
      FROM approval_callback_urls
     WHERE approval_id = ${approval.id}::uuid
       AND delivered_at IS NULL
     ORDER BY created_at, id
  `)) as unknown as Array<{ id: string; callback_url: string }>;

  // An expiry is the ABSENCE of a decision — no decision row is read for it, so
  // `decided_by` resolves to 'system' exactly as in sendN8nExpiryCallback. A
  // decided or voided row reads its decisions as deliverDecisionCallback does.
  const decisions =
    approval.status === 'expired'
      ? []
      : await database.select().from(approvalDecisions).where(eq(approvalDecisions.approval_id, approval.id));
  const projectId = await resolveCallbackProjectId(approval);

  const sender = (url: string, body: ApprovalDecisionPayload) =>
    postDecisionToCallbackUrl(url, body, {
      secret: config.services.n8n.approvalCallbackSecret,
      timeoutMs: approvalCallbackTimeoutMs(),
    });

  let sent = 0;
  let firstResponse: unknown;
  // Rows this sender CLAIMED (so it owns their outcome). A row claimed and
  // answered 409/410 is `already-terminal`; one still leased by another sender
  // is neither, which is how the "nothing to report" branch stays honest.
  let attempted = 0;
  let alreadyTerminal = 0;
  const failures: Array<{ message: string; timedOut: boolean }> = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const where = redactCallbackUrl(row.callback_url);
    let prior: number | null = null;
    try {
      prior = await claimCallbackUrlSend(database, row.id);
    } catch (err) {
      console.error(
        `[n8n-callback] could not claim the callback_url send for approval ${approval.id} (callback_url ${where}):`,
        err instanceof Error ? err.message : String(err),
      );
      failures.push({ message: `could not claim callback_url ${where}`, timedOut: false });
      continue;
    }
    if (prior === null) continue; // delivered, leased by another sender, or backing off
    attempted += 1;

    const payload = buildCallbackPayload(approval, decisions[decisions.length - 1], {
      redelivery: prior > 0,
      projectId,
    });
    try {
      const response = await withOptionalTimeout(sender(row.callback_url, payload), deps.timeoutMs);
      if (sent === 0) firstResponse = response;
      sent += 1;
      await bookkeeping('mark the callback_url delivered', where, () => markCallbackUrlDelivered(database, row.id));
      console.log(
        `[n8n-callback] Sent ${String(approval.status)} for approval ${approval.id} to callback_url ${where}`,
      );
    } catch (error) {
      // One place decides what a thrown send means, so the 409/410 branch can be
      // exercised against a real database without a fake receiver.
      const handled = await handleCallbackUrlSendFailure({
        database,
        approvalId: approval.id,
        decisionLabel: String(approval.status),
        callbackId: row.id,
        callbackUrl: row.callback_url,
        error,
      });
      if (handled.outcome === 'already-terminal') {
        alreadyTerminal += 1;
        continue;
      }
      failures.push({
        message: handled.message,
        timedOut: handled.outcome === 'timeout-unknown',
      });
    }
  }

  const list = Array.isArray(rows) ? rows : [];
  const notSent = callbackUrlLaneFailureOutcome({
    sent,
    attempted,
    alreadyTerminal,
    failures,
    undeliveredRows: list.length,
  });
  if (notSent) return notSent;

  await bookkeeping('stamp callback_acked_at', 'all attached', async () => {
    // Only once EVERY attached URL has been delivered — one acked receiver is
    // not an ack for the execution still waiting on another.
    await database.execute(sql`
      UPDATE approvals
         SET callback_acked_at = coalesce(callback_acked_at, now()), updated_at = now()
       WHERE id = ${approval.id}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM approval_callback_urls c
            WHERE c.approval_id = ${approval.id}::uuid AND c.delivered_at IS NULL
         )
    `);
  });
  return { outcome: 'sent', response: firstResponse as N8nWebhookResponse | undefined };
}

/**
 * Decide whether a callback_url lane pass can report anything other than
 * `sent`, WITHOUT touching the database. `null` means every attached URL was
 * delivered, so the caller may stamp `callback_acked_at` and answer `sent`.
 *
 * PRE-EXISTING RULES, UNCHANGED:
 *   * a real failure dominates: `failed`, or `timeout-unknown` when every
 *     failure was a timeout, with the messages joined;
 *   * claimed nothing and delivered nothing while undelivered rows exist →
 *     `timeout-unknown` (another sender holds them, fr was not left guessing).
 *
 * ⭐ THE ONE ADDITION: when every row this pass CLAIMED answered 409/410, the
 * waiting executions are gone and nothing was delivered — `already-terminal`.
 * Not `failed` (nothing was refused; there was nothing left to deliver) and not
 * `timeout-unknown` (fr was not left guessing).
 */
export function callbackUrlLaneFailureOutcome(input: {
  sent: number;
  /** Rows this pass claimed — it owns their outcome. */
  attempted: number;
  alreadyTerminal: number;
  failures: ReadonlyArray<{ message: string; timedOut: boolean }>;
  /** Undelivered rows the SELECT returned this pass. */
  undeliveredRows: number;
}): DecisionCallbackResult | null {
  const { sent, attempted, alreadyTerminal, failures, undeliveredRows } = input;
  if (failures.length > 0) {
    // A REAL failure dominates, exactly as before: a terminal row alongside it
    // is still retired above, and its outcome is reported by that retirement.
    const allTimedOut = failures.every((f) => f.timedOut);
    return {
      outcome: allTimedOut ? 'timeout-unknown' : 'failed',
      error: failures.map((f) => f.message).join('; '),
    };
  }
  if (sent === 0 && alreadyTerminal > 0 && alreadyTerminal === attempted) {
    return { outcome: 'already-terminal' };
  }
  if (sent === 0 && undeliveredRows > 0) {
    return {
      outcome: 'timeout-unknown',
      error: 'every undelivered callback_url is leased by another send or backing off',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// One failed send, one decision
// ---------------------------------------------------------------------------

export type CallbackUrlSendFailureOutcome = 'already-terminal' | 'failed' | 'timeout-unknown';

export interface CallbackUrlSendFailureResult {
  outcome: CallbackUrlSendFailureOutcome;
  /** The scrubbed failure message — safe to log and to persist. */
  message: string;
}

/**
 * Handle ONE claimed `callback_url` row whose POST threw. The caller has already
 * claimed the row (`claimCallbackUrlSend`), so it owns this outcome.
 *
 * ⭐ 409/410 — THE WAITING EXECUTION IS GONE. n8n answers 409 at
 * `webhook-waiting/<executionId>` exactly when that execution is no longer
 * waiting (already resumed, cancelled or expired), so the notice is MOOT and
 * replaying it can never succeed. fr's live defect on 2026-11-03 was exactly
 * this replay: every expiry tick re-POSTed the same notice and recorded the 409
 * as a failure. So a terminal answer:
 *
 *   * RETIRES the row (`markCallbackUrlAlreadyTerminal`) — delivered_at is the
 *     marker every sender and both retry lanes read;
 *   * does NOT call `scheduleCallbackUrlRetry` (no replay);
 *   * does NOT call `recordDecisionCallbackProblem` (a moot row must not be
 *     painted as a broken one in `error_message`);
 *   * returns `already-terminal`, never `failed`.
 *
 * ⛔ EVERY OTHER THROW KEEPS THE PRE-EXISTING PATH EXACTLY: a timeout is still
 * `timeout-unknown`, every other non-2xx / network error is still `failed`, both
 * still record the problem and schedule the backoff. Do not widen the two
 * statuses — a 500 means the receiver broke, a 404 may mean fr has the wrong
 * path, and neither is evidence that the execution is gone.
 */
export async function handleCallbackUrlSendFailure(input: {
  database: typeof db;
  approvalId: string;
  /** The approval's status, only for the operator-facing log line. */
  decisionLabel: string;
  callbackId: string;
  /** Raw URL — used ONLY to scrub it out of the message, never logged. */
  callbackUrl: string;
  error: unknown;
}): Promise<CallbackUrlSendFailureResult> {
  const { database, approvalId, decisionLabel, callbackId, callbackUrl, error } = input;
  const where = redactCallbackUrl(callbackUrl);
  // The lib's errors carry only the redacted URL; the message is still never
  // trusted to be URL-free — scrub it.
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.split(callbackUrl).join(where);

  if (isCallbackUrlAlreadyTerminal(error)) {
    console.log(
      `[n8n-callback] already-terminal (HTTP ${error.status}) — the waiting execution is gone; ` +
        `nothing to deliver for approval ${approvalId} (callback_url ${where})`,
    );
    try {
      await markCallbackUrlAlreadyTerminal(database, callbackId);
    } catch (err) {
      // The send's verdict is unchanged — it WAS terminal — but the row stays
      // due, so the redelivery lane will find it again (bounded by its attempt
      // cap). Loud, never silent: that is a failed retirement, not a failed
      // notice.
      console.error(
        `[n8n-callback] could not mark the callback_url already-terminal for approval ${approvalId} ` +
          `(callback_url ${where}) — the redelivery lane will retry it:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return { outcome: 'already-terminal', message };
  }

  const timedOut = error instanceof DecisionCallbackTimeout;
  console.error(
    `[n8n-callback] ${decisionLabel} callback to callback_url ${where} for approval ${approvalId} ` +
      `${timedOut ? 'OUTCOME UNKNOWN' : 'FAILED'}: ${message} — scheduled for re-delivery`,
  );
  await recordDecisionCallbackProblem(
    database,
    approvalId,
    `callback_url decision callback ${timedOut ? 'OUTCOME UNKNOWN' : 'FAILED'}: ${message}`,
  );
  try {
    await scheduleCallbackUrlRetry(database, callbackId, message);
  } catch (err) {
    // Same rule as the caller's `bookkeeping`: losing the backoff write must not
    // change the outcome this function reports.
    console.error(
      `[n8n-callback] could not schedule the callback_url retry for approval ${approvalId} ` +
        `(callback_url ${where}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { outcome: timedOut ? 'timeout-unknown' : 'failed', message };
}

/**
 * Append a decision-callback problem to `approvals.error_message`.
 *
 * ── THE GAP THIS CLOSES (#1083) ────────────────────────────────────────────
 * `deliverDecisionCallback` had TWO branches that returned a non-`sent` outcome
 * and stamped NOTHING: the `failed` catch, and the `skipped-unsupported-receiver`
 * refusal. Both returned honestly to their caller, and the only caller threw the
 * result away into a `console.error` from an un-awaited `.then()`. So after the
 * fact those rows are INDISTINGUISHABLE from a row that was never decided:
 * `callback_acked_at` NULL, `callback_delivered_at` NULL, `callback_resolution`
 * NULL, `callback_send_attempts` 0. A log line is not a record — it is gone on
 * the next pod roll, and no query can find it.
 *
 * `error_message` is the right column and this is not a new convention: it is
 * exactly what workers/approval-expiry.ts::recordCallbackFailure already appends
 * to, in the same shape, bounded to the same 300 characters (the column is read
 * by humans in the stranded view, and an upstream error body is unbounded).
 * Additive — any existing text is preserved.
 *
 * ⛔ IT DELIBERATELY DOES NOT WRITE `callback_resolution`, for the reason the
 * expiry sender gives one screen up: those four values are the DE-BLOCK worker's
 * TERMINAL vocabulary, and `AND a.callback_resolution IS NULL` is a clause of its
 * candidate predicate. Writing one here would retire the row from the only repair
 * path there is — on evidence that the repair had FAILED, which is precisely
 * backwards.
 *
 * ⛔ AND IT DOES NOT TOUCH `callback_send_attempts`, which is the tempting move
 * and is wrong from THIS call site. That counter is the de-block worker's retry
 * BUDGET (`MAX_SEND_ATTEMPTS = 5` → `send_exhausted`), and the worker charges it
 * itself, before its own send. Incrementing it here would silently spend one of
 * the worker's five repairs on the request-path send for every decision fr ever
 * takes — a change to a worker this change does not own. The failed/skipped pair
 * is already distinguishable from the text written below, which is what the
 * observability requirement actually asks for.
 *
 * ⭐ AND THIS RESTRAINT HAS A LIVE DOWNSTREAM CONSUMER, which is the argument
 * that should stop anyone "tidying" it. 2026-09-10, from the session building the
 * migration-113 follow-up repair. The population is defined by its SIGNATURE, not by
 * a count that rots: `callback_delivered_at IS NOT NULL AND callback_resolution IS NULL`.
 *
 * ⛔ DO NOT TRUST ANY COUNT YOU FIND FOR THIS POPULATION, INCLUDING THE ONE BELOW.
 * Four figures are in circulation and nobody has reconciled them: **500** (a single
 * census, 2026-09-10T12:25Z — approved 429 + voided 71, over 341 cards), **482** (mine,
 * same day, but `approved`-ONLY, which is why it is smaller and not a contradiction),
 * and **373 / 216**, both quoted in migration 113's own header.
 *
 * ⚠️ AND THE "CORROBORATION" FOR 500 WAS NOT ONE. It was briefly claimed that 113's
 * `_migration_effects` receipt independently confirmed 500. It does not: that receipt
 * counts `callback_delivered_at IS NOT NULL AND callback_acked_at IS NULL`, and **113
 * ADDED `callback_acked_at` in the same file**, so the column was NULL on every row at
 * that instant. The receipt is therefore the same rows by a differently-worded
 * predicate — agreement by CONSTRUCTION, not by independent measurement. A control
 * drawn from the thing that built the subject is not a control.
 *
 * ⇒ If you need a number here, re-measure it, date it, and name the status filter.
 * The SIGNATURE is the durable part; the cardinality is not. Those are BLOCKED cards whose approvals
 * were stamped `callback_delivered_at` on the n8n ACK (pre-113), so the de-block
 * worker's `callback_delivered_at IS NULL` clause can never reach them — they
 * were made unreachable ONCE, by a column written too eagerly. Their repair
 * un-stamps that column to return the rows to the candidate set. If this function
 * stamped `callback_resolution` or `callback_send_attempts` on a FAILED callback,
 * it would make that same population unreachable a SECOND time, by a different
 * column, and the repair would silently recover nothing.
 * A column that means "terminal" must only ever be written by something that
 * actually reached a terminal state. This call site never does.
 */
async function recordDecisionCallbackProblem(
  database: typeof db,
  approvalId: string,
  note: string,
): Promise<void> {
  const trimmed = note.slice(0, 300);
  try {
    await database
      .update(approvals)
      .set({
        error_message: sql`coalesce(${approvals.error_message}, '') || ${' | ' + trimmed}`,
        updated_at: new Date(),
      })
      .where(eq(approvals.id, approvalId));
  } catch (err) {
    // Best-effort by the same rule as every other stamp in this file: losing the
    // record must not cost the outcome the caller is waiting on. Loud, never
    // silent — a row that fails to record its own failure is the shape this
    // whole change exists to remove.
    console.error(
      `[n8n-callback] could not record a decision-callback problem on ${approvalId} — ` +
        'this row will read as though nothing went wrong:',
      err,
    );
  }
}

/**
 * ⭐ THE DEADLINE'S OWN ERROR TYPE, SO A TIMEOUT IS DISTINGUISHABLE FROM A
 * TRANSPORT FAILURE.
 *
 * ⛔ WHY A TYPE AND NOT A MESSAGE MATCH. The two are OPPOSITE claims and the
 * catch block has to tell them apart to report honestly: a transport error means
 * the receiver did not take the work, whereas losing this race means only that
 * FR STOPPED WAITING — the receiver may well have FINISHED it. Measured
 * 2026-09-13: 66 rows in 3 days recorded `abandoned after 5000ms` while n8n
 * recorded ZERO errored executions over the same window, against a receiver
 * whose own measured latency is p50 9,472 ms / mean 22,844 ms. Reporting those
 * as `failed` told every downstream reader something fr had never observed.
 *
 * ⚠️ THE MESSAGE TEXT IS DELIBERATELY BYTE-IDENTICAL to what this site has always
 * rejected with. Existing log greps and the `error_message` rows already on prod
 * match on that string; the discriminator moved to the TYPE precisely so the
 * text could stay put and nothing that reads history breaks.
 *
 * ⚠️ EXPORTED since the 409/410 change: the per-row failure handler lives in
 * this module and its callers/tests must distinguish a timeout from a transport
 * failure the same way, never by parsing the message.
 */
export class DecisionCallbackTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionCallbackTimeout';
  }
}

/**
 * Race a send against an optional deadline. Mirrors `sendN8nExpiryCallback`'s
 * shape, including the `send.catch(() => {})`: if the race is lost the original
 * promise still settles, and an unhandled rejection with no listener takes the
 * process down.
 */
async function withOptionalTimeout<T>(
  send: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return send;
  send.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      send,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DecisionCallbackTimeout(
                `decision callback abandoned after ${timeoutMs}ms (no response)`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

