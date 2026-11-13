// src/lib/deblock-action-metrics.ts
//
// ⛔ WHAT THIS COUNTS, AND WHY IT HAD TO EXIST BEFORE ANY OTHER FIX.
//
// `services/n8n-callback.ts :: buildCallbackPayload` narrows `metadata.deblock_action`
// through `asDeblockAction`, whose contract is spelled out in
// `domain/engagement/deblock-actions.ts`: "a key absent here is DROPPED". An approval
// minted WITHOUT a `deblock_action` is therefore answered by a human, marked approved,
// callback-delivered — and moves no card. Nothing anywhere counted that.
//
// THE MEASUREMENT -- RE-DERIVED 2026-09-07, AND THE FIRST ONE WAS OFF-ROUTE.
// This header used to carry a table of "291 cards / 137 keyless approvals" and present it
// as the case for the `mint` counter. Re-measured on prod `fr` (worker4) and bucketed by
// `callback_path`, with every bucket summed against `count(*)` = 2,855, because a
// bucketed census that does not sum to its denominator is not a census:
//
//   callback_path                      rows   carries deblock_action   approved w/o one
//   kanban/approval-callback          2,005   1,730                    3
//   execution-ready-signoff-callback    844       0                  456
//
// The `137` is the count of DELIVERED callbacks among those 456 keyless
// `execution.ready_signoff` rows. That rail is minted by `routes/execution-approvals.ts`.
// The `mint` arm of this counter is fed only by `handleN8nCardApproval`, which never
// touches that rail. The counter is real, but it counts the TOP row of that table, not
// the bottom one, and the two are different components with different fixes.
//
// The `signoff_rail` exemption in `deblock-actions.ts` exists precisely so the 844 rows in
// the bottom row do NOT arrive here as `action="absent"`. They would have been 844/844
// false positives -- a counter that fires on 100% of a rail's healthy traffic gets muted,
// and a muted counter is worse than an absent one because it still reads as coverage.
//
// ── WHY A COUNTER AND NOT ONLY A 422 ─────────────────────────────────────────────
// `routes/webhooks.ts` DOES now refuse a keyless BLOCKED-exit mint (see
// `classifyDeblockExit`), and a refusal is the loud half. But the refusal is invisible
// from outside fr: `blocked-escalate :: Call FR` carries `continueOnFail:true`, so a 422
// does not redden the n8n execution — it returns and `Format Result` reads
// `approval_id || null`. Without this counter the new refusal would be as silent as the
// bug it replaces, just at a different seam.
//
// The `decide` stage is the other half: the 137 keyless approvals ALREADY in the queue
// cannot be refused retroactively, so when one of them completes, this records it rather
// than letting another approved-and-immovable card leave no trace.
//
// Lives in `lib/` for the same reason `metering-span-metrics.ts` does: `routes/metrics.ts`
// imports the render helper, and nothing on a hot path may transitively pull in `db/client`.

import {
  DEBLOCK_ACTIONS,
  DEBLOCK_EXEMPTIONS,
  HOLD_CAUSES,
  READ_DEGRADED_CAUSES,
  SEND_EXHAUSTION_CAUSES,
  type DeblockAction,
  type DeblockExemption,
  type HoldCause,
  type ReadDegradedCause,
  type SendExhaustionCause,
} from '../domain/engagement/deblock-actions';
import { hostname } from 'node:os';

/**
 * The two seams a `deblock_action` can go missing at.
 *
 * `mint`   — `POST /api/webhooks/n8n/card-approval` created (or refused to create) the row.
 * `decide` — a human completed a BLOCKED-exit approval and fr built the n8n callback.
 */
export const DEBLOCK_METRIC_STAGES = ['mint', 'decide'] as const;
export type DeblockMetricStage = (typeof DEBLOCK_METRIC_STAGES)[number];

/**
 * Label values. The seven real actions, plus the two ways the value fails to be one:
 *
 * `absent`       — the producer sent no action at all. At `mint` this is a REFUSED row;
 *                  at `decide` it is one of the pre-existing keyless approvals.
 * `unrecognised` — a value was present and is not in the closed set, so `asDeblockAction`
 *                  drops it. Unreachable at `mint` (the zod enum rejects it first) and
 *                  reachable at `decide`, where the source is free-form `metadata` jsonb
 *                  that some other writer may have touched.
 *
 * `dual_exit_<lane>` — the row carried a usable action AND a lane carve-out fired, so it
 *                  asserts two exits for one decision. One series PER LANE, deliberately:
 *                  a single `dual_exit` label would have made the two populations
 *                  indistinguishable, and they are measured at opposite rates and handled
 *                  in opposite ways. Measured 2026-09-07 on prod: `phase_advance` 0 and
 *                  `signoff_rail` 0/844 (both REFUSED at the mint and withheld from the
 *                  callback), against `improvement_gate` 32 of 34 — the normal shape of a
 *                  live lane, which is neither refused nor withheld and is recorded here
 *                  precisely so that open finding stops being a note in a pull request.
 *                  `no_list_target` is structurally unreachable (step 3 runs only after
 *                  step 2 has ruled out a usable action) and is exposed anyway, at a
 *                  permanent zero, because a series that appears only once it is non-zero
 *                  cannot be alerted on from a dashboard nobody has built yet.
 */
export type DeblockDualExitLabel = `dual_exit_${DeblockExemption}`;

/** DERIVED from the lane set, never spelled a second time — add a lane, get its series. */
const DUAL_EXIT_LABELS: readonly DeblockDualExitLabel[] = DEBLOCK_EXEMPTIONS.map(
  (e) => `dual_exit_${e}` as const,
);

export type DeblockMetricLabel =
  | DeblockAction
  | 'absent'
  | 'unrecognised'
  | DeblockDualExitLabel;

const DEBLOCK_METRIC_LABELS: readonly DeblockMetricLabel[] = [
  ...DEBLOCK_ACTIONS,
  'absent',
  'unrecognised',
  ...DUAL_EXIT_LABELS,
];

/** The series a dual-exit conflict on `lane` lands on. One spelling, two callers. */
export function dualExitLabel(lane: DeblockExemption): DeblockDualExitLabel {
  return `dual_exit_${lane}`;
}

// WRITE THE SEPARATOR AS AN ESCAPE, NEVER AS A LITERAL NUL. This was a raw 0x00 byte in
// the source. Two of them made git classify the whole file as BINARY, so it rendered as
// `Bin 0 -> 6751 bytes` in every diff and no reviewer could read a single line of it --
// not in this pull request and not in any future one. A file nobody can diff is a
// permanent hole in review, which is worse than whatever it hides.
// U+0000 cannot appear in a stage or a label (both are closed sets of identifiers), so it
// remains a safe composite-key separator; it just has to be SPELLED, not embedded.
const key = (stage: DeblockMetricStage, label: DeblockMetricLabel): string =>
  `${stage}\u0000${label}`;

const counts = new Map<string, number>();

/**
 * The redelivery worker's exhaustion counter — a SEPARATE family, deliberately.
 *
 * ⛔ IT COULD NOT HAVE BEEN A THIRD `stage` ON `fr_deblock_actions_total`, and that was
 * checked rather than assumed. That counter's label set is action-shaped (the seven
 * actions, plus `absent`/`unrecognised`/`dual_exit_<lane>`) and its documented meaning is
 * "the action that SURVIVED narrowing". The dominant exhaustion population — 93 of 108 on
 * prod 2026-09-07 — is `no_actionable_exit`, a row with no action AND no list target,
 * which that label set can only express as `absent`. `absent` there means "a row that
 * genuinely should have carried an action and did not", i.e. a MINT DEFECT. Folding the
 * two together would make a lane with nothing to move indistinguishable from a lane whose
 * action went missing, on the one counter built to tell causes apart — the same silencing
 * the SIGNOFF_RAIL_KIND carve-out exists to prevent.
 */
const exhaustionCounts = new Map<SendExhaustionCause, number>();

/**
 * ⭐ #1115 — THE HOLD COUNTER, AND WHY IT IS A THIRD FAMILY RATHER THAN A LABEL.
 *
 * `workers/deblock-callback-redelivery.ts :: classifyReceiverHold` has always derived
 * WHY the receiver is holding a card in BLOCKED on purpose, and the value reached one
 * `console.log` and one per-tick counter — both of which die with the process. So
 * `callback_resolution = 'hold_acknowledged'` could say N cards are held and nothing
 * outside a log grep could say which need a human to type an answer
 * (`answer_missing`) and which need a fault to clear (`hold_by_design`). Two
 * populations, two different fixes, one number.
 *
 * ⚠️ THE SPLIT THIS COUNTER EXISTS TO REPLACE WAS DERIVED, NOT MEASURED, AND SAYING
 * OTHERWISE IS ITS OWN DEFECT. #1115 quotes `answer_missing` 94 / `hold_by_design`
 * 33. Those come from bucketing rows by `metadata->>'deblock_action'` — a PROXY for
 * what the receiver said, not `classifyReceiverHold`'s output, which was never stored
 * anywhere to be counted. The classifier reads the receiver's 200 BODY and can
 * disagree with the row's own action, so the proxy can only ever approximate this
 * family. Commit 48892aec on the #1115 branch wrote "measured on prod" over that
 * derivation and was wrong to. ⭐ THIS COUNTER IS THE FIRST INSTRUMENT THAT ACTUALLY
 * MEASURES THE SPLIT — so treat 94/33 as the prior it will confirm or refute, and if
 * the series disagree with it, the series are right.
 *
 * ⛔ `fr_deblock_redelivery_exhausted_total` MUST NOT BE REUSED, and the worker's own
 * `HOLD_CAUSES` comment says so first: that family's HELP text reads "Approvals
 * retired as send_exhausted", and a hold is NOT one. Folding a hold into it would
 * make a healthy, correct, deliberate hold arithmetically indistinguishable from the
 * failure the counter exists to report — the same silencing the SIGNOFF_RAIL_KIND
 * carve-out and the `dual_exit_<lane>` split each refuse elsewhere in this file.
 *
 * ⛔ AND IT IS NOT A ROW COLUMN. This counter is the WHOLE remedy, not half of one:
 * the hold cause is a log and per-tick label "exactly like `SendExhaustionCause`",
 * and `SendExhaustionCause` is log + Prometheus, persisted nowhere. A branch commit
 * (48892aec) wrote it to `metadata->>'callback_hold_cause'` and was reverted in
 * 1e7ea8f4 for exactly that reason. Persistence remains an open question for a human
 * on #1115; it is not something this file settles.
 */
const holdCounts = new Map<HoldCause, number>();

/**
 * ⭐ #1104. Rows retired as `read_degraded`, by WHICH read kept failing.
 *
 * ⛔ IT IS A THIRD FAMILY AND MUST NOT BE FOLDED INTO EITHER SIBLING, for the reason
 * the sibling above records one paragraph up: `fr_deblock_redelivery_exhausted_total`'s
 * HELP text reads "Approvals retired as send_exhausted" and a degraded read is not one
 * (the row was never sent for at all — the worker fails CLOSED on an unreadable card),
 * and `fr_deblock_redelivery_hold_total` counts a receiver DELIBERATELY holding a card,
 * which is the system working. This family counts a card fr could never see.
 *
 * ⚠️ AND IT IS NOT `card_unreadable` EITHER, WHICH HAS NO COUNTER AT ALL. That value
 * means Planka answered 404 on the card's own read path — evidence ABOUT THE CARD. This
 * one means fr never got an answer at all while Planka was demonstrably up. Summing them
 * would erase exactly the distinction workers/deblock-callback-redelivery.ts spends its
 * header defending.
 */
const readDegradedCounts = new Map<ReadDegradedCause, number>();

function zero(): void {
  counts.clear();
  for (const stage of DEBLOCK_METRIC_STAGES) {
    for (const label of DEBLOCK_METRIC_LABELS) counts.set(key(stage, label), 0);
  }
  // Pre-zeroed for the same reason the counter above is: a series that appears only once
  // it is non-zero cannot be alerted on from a dashboard nobody has built yet.
  exhaustionCounts.clear();
  for (const cause of SEND_EXHAUSTION_CAUSES) exhaustionCounts.set(cause, 0);
  // ⭐ Same discipline, and it matters MORE here: a healthy estate holds some cards on
  // purpose forever, so `hold_by_design` may legitimately sit at 0 for weeks. An absent
  // series and a genuine zero are the same picture on a graph and different facts.
  holdCounts.clear();
  for (const cause of HOLD_CAUSES) holdCounts.set(cause, 0);
  // ⭐ Same discipline again, and it matters MOST here: on a healthy estate this
  // family is expected to sit at 0 forever, so an absent series and a genuine zero
  // are the same picture on a graph and completely different facts — the second says
  // the bound #1104 asked for is armed and has had nothing to retire.
  readDegradedCounts.clear();
  for (const cause of READ_DEGRADED_CAUSES) readDegradedCounts.set(cause, 0);
}
zero();

/**
 * Count one row retired as `send_exhausted`, by the cause `causeOfSendExhaustion` derived
 * from the row's own stored metadata.
 *
 * ⭐ THIS IS THE ANSWER TO "how many exhausted because there was nothing to move them to?"
 * — `fr_deblock_redelivery_exhausted_total{cause="no_actionable_exit"}` — without opening
 * a psql session. It rides the SAME pushgateway group as the counter above (see
 * `renderDeblockActionPushBody`), so it needs no new job and no new scrape target, and
 * this family reaches Prometheus carrying `exported_job="fr-deblock-actions"` like its
 * sibling.
 *
 * ⚠️ CORRECTED 2026-09-25 — this said "⛔ no `prometheus.io/*` annotations: fr's API
 * port is deliberately unscraped". Measured: fr's API port IS scraped, since
 * 2026-09-23. `clusters/prod/services/fr/service.yaml` on gitops `origin/main`
 * carries `prometheus.io/scrape: "true"`, `prometheus.io/port: "8888"` and
 * `prometheus.io/path: "/api/metrics/prom"` on the `fr-backend` Service (gitops
 * #4079, "feat(fr): make fr scrapable — three layers, one commit"), picked up by the
 * `kubernetes-service-endpoints` job. The push path below is still the one this
 * family USES and is not being changed — but "unscraped" is no longer a reason for
 * anything, so do not cite it as one.
 */
export function recordSendExhaustion(cause: SendExhaustionCause): void {
  exhaustionCounts.set(cause, (exhaustionCounts.get(cause) ?? 0) + 1);
}

/**
 * Count one row retired as `hold_acknowledged`, by the cause `classifyReceiverHold`
 * read out of the receiver's own 200 body.
 *
 * ⭐ THIS IS THE ANSWER TO "how many held cards are waiting on a human to type an
 * answer?" — `fr_deblock_redelivery_hold_total{cause="answer_missing"}` — without
 * grepping a worker log that a pod restart deletes. It rides the SAME pushgateway
 * group as its two siblings (see `renderDeblockActionPushBody`), so it needs no new
 * job and no new scrape target, and this family reaches Prometheus carrying
 * `exported_job="fr-deblock-actions"` exactly as `recordSendExhaustion`'s does.
 *
 * ⚠️ CORRECTED 2026-09-25 — this said "⛔ no `prometheus.io/*` annotations: fr's API
 * port is deliberately unscraped". Measured: it IS scraped as of 2026-09-23 — see the
 * retraction on `recordSendExhaustion` above for the annotations and the commit.
 *
 * ⚠️ A RISE HERE IS NOT A FAULT, AND THE ALERT WRITTEN OVER IT MUST SAY SO. Unlike
 * `fr_deblock_redelivery_exhausted_total`, every increment on this family is the
 * system working: the receiver answered, said it was holding on purpose, and fr
 * stopped re-sending. What is worth alerting on is `answer_missing` ACCUMULATING —
 * cards parked on a question nobody has answered — not the counter being non-zero.
 */
export function recordHoldAcknowledged(cause: HoldCause): void {
  holdCounts.set(cause, (holdCounts.get(cause) ?? 0) + 1);
}

/**
 * ⭐ #1104. Count one row retired as `read_degraded`, by which read kept failing.
 *
 * ⛔ THIS IS THE "LOUD" HALF OF THE #1104 FIX AND IT IS NOT OPTIONAL. The defect was a
 * row that could never retire; the danger in fixing it is a row that retires SILENTLY and
 * reads, to anything downstream, like a card that completed normally. It cannot: the
 * resolution value is its own (`read_degraded`, migration 134 — never `moved`, which is
 * the only value that stamps `callback_delivered_at`), and this counter is the half of
 * that a dashboard can see without a psql session.
 *
 * ⚠️ A RISE HERE IS A REAL FAULT, unlike `fr_deblock_redelivery_hold_total`. Every
 * increment is a card fr gave up on being able to READ while Planka was answering other
 * cards correctly — `WHERE callback_resolution = 'read_degraded'` is the operator's queue
 * of them. `cause="list_read"` climbing means Planka is serving cards whose LIST it will
 * not serve (measured: archived lists); `cause="card_read"` climbing means individual
 * cards 5xx while their siblings do not.
 *
 * ⛔ AND IT RIDES THE SAME PUSHGATEWAY GROUP as its two siblings (see
 * `renderDeblockActionPushBody`) — no new job, no new scrape target, and it reaches
 * Prometheus carrying `exported_job="fr-deblock-actions"` exactly as they do.
 */
export function recordReadDegraded(cause: ReadDegradedCause): void {
  readDegradedCounts.set(cause, (readDegradedCounts.get(cause) ?? 0) + 1);
}

/**
 * Count one BLOCKED-exit approval at one seam.
 *
 * `action` is the NARROWED value (`asDeblockAction`'s output), never the raw metadata:
 * pass `undefined` for absent, and set `present` when the raw value existed but did not
 * survive narrowing — that is the difference between "the producer said nothing" and
 * "the producer said something this system throws away", and they have different fixes.
 */
export function recordDeblockAction(
  stage: DeblockMetricStage,
  action: DeblockAction | undefined,
  opts?: { rawWasPresent?: boolean },
): void {
  const label: DeblockMetricLabel = action ?? (opts?.rawWasPresent ? 'unrecognised' : 'absent');
  const k = key(stage, label);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

/**
 * Count one DUAL-EXIT approval at one seam — a row asserting a lane carve-out AND a usable
 * action, i.e. two exits for one human decision.
 *
 * Separate from `recordDeblockAction` on purpose. That function's contract is "the action
 * that SURVIVED narrowing", and it is read as a delivery: `mint:RETRY` means a row went in
 * carrying RETRY. A dual-exit row's action also survives narrowing, and is then REFUSED or
 * WITHHELD. Folding it into the `RETRY` series would have made a refusal arithmetically
 * indistinguishable from a delivery on the one counter built to tell them apart.
 */
export function recordDeblockDualExit(stage: DeblockMetricStage, lane: DeblockExemption): void {
  const k = key(stage, dualExitLabel(lane));
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderDeblockActionMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_deblock_actions_total BLOCKED-exit card approvals by stage and by the deblock_action that survived the closed allowlist. absent/unrecognised mean the approval cannot move its card. dual_exit_<lane> means the row asserted a lane carve-out AND a usable action, so the action was refused at mint or withheld from the callback.',
    '# TYPE fr_deblock_actions_total counter',
  ];
  for (const stage of DEBLOCK_METRIC_STAGES) {
    for (const label of DEBLOCK_METRIC_LABELS) {
      lines.push(
        `fr_deblock_actions_total{stage="${stage}",action="${label}"} ${counts.get(key(stage, label)) ?? 0}`,
      );
    }
  }
  lines.push(
    '# HELP fr_deblock_redelivery_exhausted_total Approvals retired as send_exhausted by workers/deblock-callback-redelivery.ts, by the cause the worker derived for that row. never_acked means NO receiver ever acked the row, so nothing downstream can be blamed for anything: the send may have failed, or fr may have withheld the decision as unroutable for this callback_path (VOIDED_CALLBACK_PATHS). It is a property of the DELIVERY rather than of the row stored exit, it is tested FIRST, and it dominates the four causes below, which are all derived from the stored exit. receiver_unresponsive means fr sent a usable deblock_action and n8n acked it and the card still did not move. no_actionable_exit means the callback carried no usable action and no list target, so the receiver was never given anything to move the card with. mint_gap means a list target existed but the action was absent or unrecognised. exempt_lane means the row exit is driven by another mechanism entirely.',
  );
  lines.push('# TYPE fr_deblock_redelivery_exhausted_total counter');
  for (const cause of SEND_EXHAUSTION_CAUSES) {
    lines.push(
      `fr_deblock_redelivery_exhausted_total{cause="${cause}"} ${exhaustionCounts.get(cause) ?? 0}`,
    );
  }
  lines.push(
    '# HELP fr_deblock_redelivery_hold_total Approvals retired as hold_acknowledged by workers/deblock-callback-redelivery.ts, by the cause the receiver reported in its own 200 body. This is NOT a failure family: every increment is the receiver saying it is holding the card in BLOCKED deliberately and fr correctly ceasing to re-send, so it must never be summed with fr_deblock_redelivery_exhausted_total. answer_missing means an approved QUESTION whose decision comment carried no answer text, so the ask is still open and the row is spent: only a human typing an answer releases it, and no re-send can supply one. hold_by_design means a holding action other than that (INFRASTRUCTURE, DEPENDENCY) where the approval was never the thing that moves the card: a fault must clear or a card must reach DONE. The two are split because the fixes differ and one label would send half of all readers to the wrong one. The card STAYS in BLOCKED in both cases, by design.',
  );
  lines.push('# TYPE fr_deblock_redelivery_hold_total counter');
  for (const cause of HOLD_CAUSES) {
    lines.push(`fr_deblock_redelivery_hold_total{cause="${cause}"} ${holdCounts.get(cause) ?? 0}`);
  }
  lines.push(
    '# HELP fr_deblock_redelivery_read_degraded_total Approvals retired as read_degraded by workers/deblock-callback-redelivery.ts, by which read kept failing. This is a FAILURE family and must never be summed with fr_deblock_redelivery_hold_total: every increment is a card fr could not READ, over DEGRADED_STRIKES ticks spanning DEGRADED_MIN_SPAN_MS, each of them a tick in which OTHER cards were read successfully - so it is not a Planka outage. It is also NOT fr_deblock_redelivery_exhausted_total: such a row was never sent for at all, because the worker fails closed on a card whose list it cannot establish. card_read means GET /api/cards/:id never produced a usable answer. list_read means the card read returned 200 with a listId and GET /api/lists/:id then failed, so Planka affirmatively said the card EXISTS and this is never evidence the card is gone. empty_read means a 200 that answered nothing - a card with no listId, or a list with no name. The card is NOT claimed to have moved and callback_delivered_at is NOT stamped.',
  );
  lines.push('# TYPE fr_deblock_redelivery_read_degraded_total counter');
  for (const cause of READ_DEGRADED_CAUSES) {
    lines.push(
      `fr_deblock_redelivery_read_degraded_total{cause="${cause}"} ${readDegradedCounts.get(cause) ?? 0}`,
    );
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION: WHY THIS COUNTER IS PUSHED, AND WHAT A CONSUMER MAY DO WITH IT
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS CLOSES. Everything above renders exposition text for
// `routes/metrics.ts :: handlePromMetrics`.
//
// ⚠️ CORRECTED 2026-09-25 — this said that exporter is one "this file's own header
// (and `workers/scheduled-trigger-health.ts`) records as NEVER SCRAPED". Measured:
// that is no longer true. Since 2026-09-23 the `fr-backend` Service carries
// `prometheus.io/scrape: "true"` / `port: "8888"` / `path: "/api/metrics/prom"` in
// `clusters/prod/services/fr/service.yaml` on gitops `origin/main` (gitops #4079,
// which shipped the PeerAuthentication and NetworkPolicy companions in the same
// commit), so `handlePromMetrics` IS scraped by the `kubernetes-service-endpoints`
// job. The 2026-09-07 reading below was correct WHEN TAKEN and is kept because it is
// the evidence that motivated the push design — but it is now a historical
// measurement, not the current state, and nothing may cite "never scraped" as a live
// fact. The push path is retained deliberately (it is what this family uses, and the
// rejected-alternative section below still stands on its own reasoning); what has
// changed is the premise, not the design.
//
// ── THE ORIGINAL 2026-09-07 MEASUREMENT (historical) ────────────────────────
// Verified 2026-09-07 against prometheus in-cluster: `fr_deblock_actions_total` had
// **0 series** and `/api/v1/metadata` did not know the name, while the only four
// retained `fr_*` families — `fr_approvals_pending_expiring`,
// `fr_approval_horizon_push_timestamp_seconds`,
// `fr_scheduled_triggers_enabled`, `fr_scheduled_trigger_health_push_timestamp_
// seconds` — ALL arrive via the pushgateway carrying `exported_job`. So the
// counter built to end a silence (a 422 refusal is invisible outside fr, because
// `blocked-escalate :: Call FR` runs `continueOnFail:true`) was itself silent,
// and every count died with the pod.
//
// ── DESIGN CHOSEN: PUSH ─────────────────────────────────────────────────────
// Mirror `workers/approval-expiry.ts :: APPROVAL_HORIZON_PUSHGATEWAY_JOB`.
// `PUSHGATEWAY_URL` is already on `deploy/fr` (verified live 2026-09-07 on the
// `fr/fr` Deployment, container `fr-backend`:
// `http://pushgateway.example.com:9091`), the gateway is a
// healthy prometheus target, and the horizon emitter's own heartbeat was 67s old
// when this was written — so the 15-minute tick this hangs off is demonstrably
// alive in prod, not merely present in the source.
//
// ── ALTERNATIVE REJECTED: A DEDICATED METRICS PORT ──────────────────────────
// ⭐ WRITTEN HERE ON PURPOSE. A rejected alternative is invisible to a diff
// reader, so the next person to think "just scrape it" must meet the reason in
// the file rather than in a pull request nobody will re-read.
//
// The fleet idiom IS a second port (kag 9900, ingestion 8555, karma 8801,
// hirag 8802, kag-graph 8803, graph-adapter 8804, nlp-service 8805,
// kag-orchestrator 8806, n8n 5678); fr is the only app publishing metrics solely
// on its authenticated API port. And note precisely what fr's existing comments
// argue: they rule out scraping **port 8888**, because the `fr` namespace is
// ambient-meshed and scraping the API port means `portLevelMtls: PERMISSIVE` on
// the port that serves the whole authenticated API. That argument does NOT by
// itself forbid a SEPARATE unauthenticated port. The alternative was live.
//
// ⚠️ CORRECTED 2026-09-25 — the paragraph above says fr's comments "rule out
// scraping **port 8888**" and calls fr "the only app publishing metrics solely on
// its authenticated API port". Measured: port 8888 IS scraped as of 2026-09-23.
// gitops #4079 annotated the `fr-backend` Service (`prometheus.io/port: "8888"`,
// `path: "/api/metrics/prom"`) and shipped exactly the two companions this paragraph
// treated as disqualifying — a `fr-metrics` PeerAuthentication with
// `portLevelMtls {8888: PERMISSIVE}` and an `allow-prometheus-scrape/fr`
// NetworkPolicy — in the same commit. `/api/metrics/prom` is also unauthenticated by
// design, so "authenticated API port" overstates the exposure. The cost argument
// below (a new listener, containerPort, Service port, policy) is untouched and is
// why this family still pushes; the PRECEDENT argument above has been overtaken by
// events and must not be quoted as a live constraint.
//
// It is rejected anyway, on cost rather than on precedent:
//   * it is not a code change. It is a new listener in fr, a containerPort, a
//     Service port, a `prometheus.io/*` annotation set (or a ServiceMonitor), and
//     an ambient/mTLS exception scoped to the new port — four repos' worth of
//     coordination to retain one counter fr can already retain today.
//   * it changes the mesh posture. Push changes nothing about who may reach fr.
//   * it would make this the ONLY `fr_*` family on a different collection path
//     from the other four, so every fr dashboard and rule would need two
//     idioms (`exported_job` for four families, `job` for this one).
//   * the estate carries a do-not-re-attempt marker on a related port move.
// If fr ever gains a metrics port for its own reasons, this emitter should be
// deleted, not kept alongside it — two paths for one counter is a worse state
// than either path alone.
//
// ── 🔴 COUNTER SEMANTICS: THE PUSHGATEWAY REPLACES, IT DOES NOT ACCUMULATE ───
// A push REPLACES the metric families it carries WITHIN ONE GROUP. A per-process
// counter pushed into a SHARED group is therefore not restart-safe: the new
// process starts at 0 and pushes 0, and a raw `sum()` reads that as a real
// decrease. That is why this does NOT copy the horizon emitter's grouping key.
//
//   horizon (a GAUGE snapshot): pushed as `{job="fr-approval-horizon"}` — one
//     group, and replace-on-push is exactly right for a gauge.
//   this (a COUNTER):           pushed as `{job="fr-deblock-actions", instance="<pod>"}`.
//
// ⚠️ CORRECTED 2026-09-07 — THOSE ARE THE NAMES THE EMITTER *PUSHES*, AND THEY
// ARE NOT THE NAMES A PromQL CONSUMER SELECTS ON. This block previously gave
// only the pushed spelling, with nothing marking it as one layer of two, so it
// read as the query spelling as well. It is not, and the distinction is the
// difference between a working alert rule and a permanently green one:
//
//   * PUSH layer — this file, the pushgateway's own `/api/v1/metrics` group
//     labels, and `clusters/prod/services/prometheus/pushgateway_reap.py`
//     (whose `STANDARD_KEYS = {"job", "instance"}` matches against exactly
//     those group labels). Here the names are `job` and `instance`. Everything
//     above about grouping, clobbering, per-pod ownership and reap safety is
//     stated in these names and is correct in them.
//   * QUERY layer — the prometheus TSDB, i.e. every PromQL expression, alert
//     rule and dashboard. Here the names are `exported_job` and
//     `exported_instance`. Prometheus scrapes the gateway under
//     `job_name: 'kubernetes-pods'`, and NO `honor_labels` key is set anywhere
//     in the `prometheus-config` ConfigMap, so the default `honor_labels: false`
//     applies: on ingest the SCRAPE's own `job`/`instance` win, and the PUSHED
//     pair is kept under an `exported_` prefix rather than being dropped. A
//     scraped series therefore reads `job="kubernetes-pods"`,
//     `instance="<gateway pod ip>:9091"`, `exported_job="fr-deblock-actions"`,
//     `exported_instance="<pod>"`.
//
// Re-derived live 2026-09-07 WITH A POSITIVE CONTROL, because an empty read is
// not a negative result and the wrong version of this comment was written from
// one. `push_time_seconds{exported_job="license-authz"}` — the same
// job-plus-instance push shape this emitter uses — returns a live series
// carrying BOTH renamed labels (`exported_instance="license-authz-69b9c8c544-hstpk"`,
// the pushed pod name, beside `instance="10.42.0.17:9091"`, the gateway pod),
// while `count({job="license-authz"})` and `{job="fr-approval-horizon"}` each
// return EMPTY. The header note above ("ALL arrive via the pushgateway carrying
// `exported_job`") was right; this block contradicted it.
//
// The `instance` segment is the whole fix. Each pod owns its own group, so:
//   * two pods never merge into one series and never clobber each other's push
//     (fr runs 1 replica today — this must not silently break the day it does not);
//   * a rollout starts a NEW series at 0 while the retired pod's series stays
//     frozen at its last value, so `sum(increase(...))` spans the restart instead
//     of reading a cliff;
//   * a container restart INSIDE one pod reuses the same `instance` and does
//     produce a genuine within-series reset — which is precisely the case
//     prometheus counter-reset detection exists for, and is why the consumer
//     contract below is not optional.
//
// ⚠️ CONSUMER CONTRACT — `increase()` / `rate()`, NEVER a raw `sum()`.
// `sum(fr_deblock_actions_total)` is meaningless here: it adds a live pod's
// running total to every retired pod's frozen total, and it drops when a group
// is reaped. Ask `sum by (action) (increase(fr_deblock_actions_total[1h]))`.
// Alert rules that watch this must be written that way; there is no rule in
// deployment for it yet, and that gitops change is not in this repo.
//
// ⛔ FOR WHOEVER WRITES THAT RULE — SELECT ON `exported_job`, NEVER ON `job`.
// The bare metric name in the line above already matches (the family name is
// unique to this emitter, so it needs no selector). What must NEVER be added is
// a `job=` matcher. Copy-pasteable, in the spelling that actually returns
// series — scoped, and split by pod generation:
//
//     sum by (action) (increase(fr_deblock_actions_total{exported_job="fr-deblock-actions"}[1h]))
//     sum by (action, exported_instance) (increase(fr_deblock_actions_total{exported_job="fr-deblock-actions"}[1h]))
//     absent(fr_deblock_actions_push_timestamp_seconds{exported_job="fr-deblock-actions"})
//
// `{job="fr-deblock-actions"}` matches ZERO series and RAISES NOTHING. PromQL
// has no unknown-label error: an unmatched label name is an empty vector, not a
// failure. A rule written that way is permanently green, alerts never, and
// reports a silent zero that reads exactly like a healthy system — which is the
// same shape of silence this entire file was built to remove, reintroduced one
// layer further out.
//
// Rejected here too: keying by a per-PROCESS boot id instead of the pod name.
// It would remove the within-pod reset, but at the price of one permanent group
// per crash-loop iteration, and prometheus already handles the reset correctly.
// Bounded cardinality wins.
//
// ── ⛔ WHY THIS CANNOT REOPEN deployment#3490 ────────────────────────
// #3490 (merged 2026-09-05T17:54:58Z) closed an ALARM-ERASURE vector: a
// `DeployJobInterrupted` annotation told operators to go DELETE a pushgateway
// group, and on 2026-09-04 the whole `job="ci-deploy"` group was deleted by hand,
// erasing three firing criticals. The vector is a DELETE, and a group shared with
// something that alerts.
//
//   1. This emitter issues NO DELETE and NO PUT. It POSTs, and a POST replaces
//      only the same-named families inside its OWN group. A test pins the method.
//   2. Its job name is NEW. The live registry was enumerated 2026-09-07 and holds
//      11 job values — aa-conveyor-stats, alert-vacuity-audit,
//      ambient_mesh_repair, ci-deploy, detector-scan-streams,
//      exec_ready_signoff_callback, fr-approval-horizon,
//      fr-scheduled-trigger-health, license-authz, node_mac,
//      verdaccio-uplink-reconcile. `fr-deblock-actions` is none of them, so no
//      existing group can be overwritten by collision.
//   3. It is safe under `clusters/prod/services/prometheus/pushgateway_reap.py`
//      BY that script's own rule, not by luck. The reaper touches a group only
//      when its keys are EXACTLY {job, instance} (true here) AND it is >24h stale
//      (false here — the push cadence is 15 minutes) AND some OTHER group of the
//      same job pushed within the last hour. If fr stops pushing entirely there is
//      no fresh sibling, nothing is reaped, and the heartbeat below keeps
//      reporting the outage on real data. Retired pod generations, and only those,
//      get cleaned up.
//
// ── WHICH QUESTION THIS ANSWERS, AND WHICH IT DOES NOT ──────────────────────
// "It ran", "it kept up" and "it is still pointed at the right rows" are three
// different questions and this answers ONE AND A HALF of them:
//   ✅ IT RAN — `fr_deblock_actions_push_timestamp_seconds` is the staleness
//      partner, same shape as the horizon and scheduled-trigger heartbeats.
//      Without it a dead emitter and a genuinely-zero counter are byte-identical,
//      which is the exact defect #3490 named as "presence-only".
//   ✅ HOW MUCH FLOWED — via `increase()`, per stage and action.
//   ⚠️ IT KEPT UP — only weakly. There is no queue and no lag here, so "kept up"
//      degenerates to "the tick is not wedged", which the heartbeat's age already
//      shows. It cannot tell you fr is behind on approvals.
//   ⛔ IT IS STILL POINTED AT THE RIGHT ROWS — NOT ANSWERED, and nothing here
//      pretends otherwise. If `DEBLOCK_ACTIONS` or `DEBLOCK_EXEMPTIONS` changes,
//      or the `signoff_rail` exemption stops matching the rail it was measured
//      against, every series stays green while its meaning moves underneath.
//      Closing that needs a population control against the database, which is a
//      different change from retaining a counter.

/**
 * Pushgateway grouping key, JOB half. NEW name — see the #3490 note above; it
 * collides with none of the 11 job values live on 2026-09-07.
 */
export const DEBLOCK_ACTIONS_PUSHGATEWAY_JOB = 'fr-deblock-actions';

/**
 * Wall-clock bound on the pushgateway POST. NOT tuning — see the
 * `publishDeblockActionMetrics` docblock: it is what makes the failure path
 * reachable at all when the socket never settles. 10 s is orders of magnitude
 * above a healthy in-cluster POST and far below the 15-minute tick that awaits
 * this. Deliberately a local constant rather than an import from
 * `workers/approval-expiry.ts`: that module imports THIS one, so sharing the
 * constant from there would be a cycle.
 */
export const DEBLOCK_PUSH_TIMEOUT_MS = 10_000;

/** Heartbeat family. The `absent()`/staleness partner for the counter. */
export const DEBLOCK_ACTIONS_PUSH_TIMESTAMP_METRIC =
  'fr_deblock_actions_push_timestamp_seconds';

/**
 * Grouping key, INSTANCE half.
 *
 * Refuses rather than guesses. A shared constant fallback would merge every
 * pod into one group and reintroduce exactly the clobbering this key exists to
 * prevent, and it would do so SILENTLY — so an unidentifiable process pushes
 * nothing, the heartbeat goes stale, and `absent()` reports it.
 *
 * The charset is restricted because a pushgateway grouping value containing `/`
 * cannot be expressed in the plain path form at all (it needs the `@base64`
 * spelling), and a value that needs escaping would also stop
 * `pushgateway_reap.py` from matching its own DELETE path. Pod names satisfy
 * this by construction; a developer laptop hostname may not, and that is a
 * refusal, not a corruption.
 */
export function resolveDeblockPushInstance(
  env: Record<string, string | undefined>,
  fallbackHostname: string,
): string | null {
  const candidate = (env.POD_NAME ?? env.HOSTNAME ?? fallbackHostname ?? '').trim();
  if (candidate === '') return null;
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
}

/**
 * The pushgateway body: every counter series (INCLUDING the zeros — see
 * `renderDeblockActionMetrics`; a series that appears only once it is non-zero
 * cannot be alerted on) plus the heartbeat.
 */
export function renderDeblockActionPushBody(nowSeconds: number): string {
  const lines = [...renderDeblockActionMetrics()];
  lines.push(
    `# HELP ${DEBLOCK_ACTIONS_PUSH_TIMESTAMP_METRIC} Unix time this fr-backend process last published deblock action counters.`,
  );
  lines.push(`# TYPE ${DEBLOCK_ACTIONS_PUSH_TIMESTAMP_METRIC} gauge`);
  lines.push(`${DEBLOCK_ACTIONS_PUSH_TIMESTAMP_METRIC} ${Math.floor(nowSeconds)}`);
  return lines.join('\n') + '\n';
}

/**
 * Publish the deblock counters to the pushgateway.
 *
 * NEVER throws — this is observability hanging off a worker tick, and a
 * pushgateway outage must not stop that tick. NEVER silent either: every
 * failure path logs `[deblock-metrics]` with the reason, because "nothing said
 * anything" is the failure mode this whole counter exists to remove.
 *
 * NEVER HANGS, which is a THIRD property and not implied by the first two. The
 * catch below sits after the await, so an untimed `fetch` against a socket that
 * never settles is not a caught failure — it is a promise that never resolves,
 * and it takes whatever awaited this call with it. `DEBLOCK_PUSH_TIMEOUT_MS`
 * converts that into an `AbortError` the catch already handles.
 *
 * ⛔ POST only. See the #3490 note: DELETE is the alarm-erasure vector, and PUT
 * would replace families in the group that this body does not carry.
 */
export async function publishDeblockActionMetrics(): Promise<void> {
  const env = process.env;
  const logger = console;
  const nowSeconds = Date.now() / 1000;

  const pushgatewayUrl = (env.PUSHGATEWAY_URL ?? '').trim();
  if (pushgatewayUrl === '') {
    // No hardcoded fallback, per config-externalization-policy.md — same as the
    // horizon emitter. The `absent()` half of the alert pair catches this where
    // the push was expected.
    return;
  }

  const instance = resolveDeblockPushInstance(env, hostname());
  if (instance === null) {
    logger.error(
      '[deblock-metrics] no usable pushgateway instance identity ' +
        '(POD_NAME/HOSTNAME/os.hostname all empty or not [A-Za-z0-9._-]); ' +
        'NOT pushing, because a shared fallback group would let two processes ' +
        'overwrite each other',
    );
    return;
  }

  const url =
    `${pushgatewayUrl.replace(/\/+$/, '')}` +
    `/metrics/job/${encodeURIComponent(DEBLOCK_ACTIONS_PUSHGATEWAY_JOB)}` +
    `/instance/${encodeURIComponent(instance)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: renderDeblockActionPushBody(nowSeconds),
      // See the docblock: without this the catch below is unreachable on a
      // silent drop, and this call is awaited by a worker tick.
      signal: AbortSignal.timeout(DEBLOCK_PUSH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.error(
        `[deblock-metrics] pushgateway returned ${resp.status}; deblock counters NOT updated ` +
          `(job=${DEBLOCK_ACTIONS_PUSHGATEWAY_JOB} instance=${instance})`,
      );
    }
  } catch (err) {
    logger.error(
      `[deblock-metrics] push failed, deblock counters NOT updated ` +
        `(job=${DEBLOCK_ACTIONS_PUSHGATEWAY_JOB} instance=${instance}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

