// src/services/n8n.ts
import { config } from '../config';
import {
  n8nAttributionHeaders,
  resolveN8nAttribution,
  withN8nAttributionBody,
  type N8nAttributionInput,
} from '../integrations/_lib/n8n-attribution';
import type { DeblockAction } from '../domain/engagement/deblock-actions';

export interface ApprovalDecisionPayload {
  card_id: string;
  // ⚠️ FOUR VALUES, AND THE LAST TWO ARE NOT VERDICTS.
  // `approved`/`rejected` are records of a human decision. `expired` is a
  // RE-QUEUE NOTICE: the approval window lapsed with nobody answering, and the
  // receiver moves the card back to TODO so it can be raised again. It never
  // approves, never rejects, and never moves a card BLOCKED→DOING — see the
  // contract at the top of workers/approval-expiry.ts.
  // The receivers that understand it are enumerated in
  // services/n8n-callback.ts (`EXPIRY_CALLBACK_PATHS`); a receiver outside that
  // set is NOT fired at, because it would answer 400 or — worse — 200 without
  // moving anything.
  // `voided` (migration 110) is an administrative retraction — nobody
  // approved, nobody rejected, the approval itself was withdrawn. It is
  // reported as exactly `voided`, never coerced into `approved`, so a receiver
  // that has not been taught the value fails loud rather than acting on a
  // decision that was never made.
  decision: 'approved' | 'rejected' | 'expired' | 'voided';
  // ⭐ TRUE ONLY ON A RE-SEND OF A DECISION THAT WAS ALREADY DELIVERED ONCE.
  // The receiver (`approval-callback.json :: Resolve Target List`) uses it to
  // pick which failure it would rather have: a re-delivery that cannot PROVE the
  // card is still in BLOCKED HOLDS (fail-closed — a wrong hold costs one comment,
  // and the decision can be re-sent), while a first delivery MOVES unless it can
  // prove the card left BLOCKED (fail-open — a wrong hold there strands the card).
  //
  // ⛔ OMITTED, NEVER `false`, ON A FIRST DELIVERY. The receiver's `Parse Decision`
  // runs a CLOSED allowlist and defaults the field to false itself, so emitting it
  // adds nothing — and leaving it out keeps the first-delivery payload byte-for-byte
  // what it has always been, which is what makes this change safe to ship.
  //
  // The receiver-side guard has existed since #1285 and shipped deliberately INERT,
  // its header saying it "must land BEFORE any sender may re-deliver". Nothing ever
  // armed it: measured 2026-09-10, `redelivery` appeared nowhere in this repo. This
  // field is the sender half that was never written.
  redelivery?: boolean;
  comment?: string;
  // 'system' for an expiry: nobody decided it, and naming a decider who does
  // not exist is how a timeout gets read back as somebody's sign-off.
  decided_by: string;
  // Universal-callback-receiver dispatch data. Receiver uses approval_id
  // for the Planka idempotency-marker, tenant_id for downstream metric
  // labels, card_type to route to the matching loop/cell, and the four
  // list ids to move the card on approve/reject.
  approval_id?: string;
  tenant_id?: string;
  // ⛔ ALWAYS ON THE WIRE (George 2026-10-08: every conveyor call carries the
  // projectId; a missing one is a defect that fails loudly). The fr project the
  // decided approval belongs to: `approvals.project_id`, else the project the
  // approval's board / card maps to. `null` — never a placeholder, never a tenant
  // id — when none resolves; the receiver (`approval-callback.json :: Check Merge
  // Base`) then REFUSES to merge, which is the intended loud failure.
  project_id: string | null;
  // The approval's own `kind`, verbatim (e.g. `execution.feature_design_approval`). The
  // receiver needs it because some kinds carry NO deblock_action (A3's outcome is fixed by its
  // G-12 decision), so nothing else on the wire says which approval was decided:
  // `approval-callback.json` mints the A3 build cards only on this exact kind (P2-MINTCALL).
  // Omitted when the row has no kind, so older payloads stay byte-identical.
  approval_kind?: string;
  card_type?: string;
  qaListId?: string;
  doingListId?: string;
  todoListId?: string;
  boardId?: string;
  // WS-3 — workflow-canary routing action (kind='improvement.canary_action').
  // The receiver dispatches to worker_management keyed by (card_type, list):
  // rollback → prior version, extend → add `additional_minutes` to the window.
  // Absent (undefined) for every non-canary approval.
  canary_action?: 'rollback' | 'extend';
  list?: string;
  additional_minutes?: number;
  // BLOCKED-exit proposition (2026-08-24). The action `AA Pattern - Blocked Escalate`
  // proposed at block time and the human just approved; the kanban/approval-callback
  // receiver switches on it. Absent for every non-deblock approval.
  deblock_action?: DeblockAction;
  /** The pull request a MERGE proposition is about; absent on every other action. */
  pr_url?: string;
  pr_repo_owner?: string;
  pr_repo_name?: string;
  pr_number?: number;
  /**
   * The decider-chosen card_type of an approved RECLASSIFY (REALIGN R5). The receiver writes
   * it to the card's `card_type` field and moves BLOCKED -> TODO. Absent on every other action.
   */
  new_card_type?: string;
  /**
   * The resolved per-criterion verdict of a COVERAGE approval (George BDD ruling 2026-10-01):
   * covered ∪ rejected = every criterion of the row's coverage_request, disjoint. Absent on
   * every other action.
   */
  coverage_decision?: {
    decision: 'approve' | 'reject';
    rejected_criterion_ids: string[];
    covered_criterion_ids: string[];
    criteria_total: number;
  };
  // The improvement card the block was converted into (the LEARNING half), so the
  // receiver can relate the two cards instead of re-deriving the link from prose.
  learning_card_id?: string;
  /**
   * D13 (migration 192): the ONE artifact the decided approval was about, as stored
   * (`version` absent = the ref named the artifact, not a pinned version). Absent when
   * the approval named none, so older callbacks stay byte-identical.
   */
  artifact_ref?: { artifact_id: string; version?: number };
  /**
   * `decision: 'voided'` ONLY: the row's stored `voided_reason` (lib/void-approvals.ts), so the
   * receiver can tell a RESTART's void ("project restarted …", services/conveyor-failures.ts
   * withdrawAsksForRestart) from an operator's or an archive's. Absent on every other decision,
   * so those callbacks stay byte-identical.
   */
  voided_reason?: string;
}

export interface N8nWebhookResponse {
  success: boolean;
  message?: string;
  data?: any;
}

/**
 * Default ceiling for ONE outbound approval-decision callback, in ms.
 *
 * ⚠️ 30s, RAISED FROM A HARDCODED 10s, BECAUSE 10s WAS MEASURABLY TOO SHORT.
 * Measured on prod from Loki over 8h ending 2026-09-05T18:05Z: 202 send attempts,
 * 173 succeeded and 29 failed — a 14.4% failure rate. EVERY one of the 29 was a
 * `DOMException [TimeoutError]`; there were zero ECONNRESET, zero `fetch
 * failed`, zero AbortError. The failures were spread evenly across the de-block
 * worker's :13/:28/:43/:58 15-minute ticks rather than clustered, and n8n did
 * not roll once between 10:06Z and 18:05Z — so a pod roll is REFUTED as the
 * cause. The sends were simply slower than the ceiling.
 *
 * ⭐ AND THE RECEIVER WAS MEASURED, NOT ASSUMED — this is the number that
 * justifies the value, and an earlier version of this comment bounded 30s only
 * from ABOVE (by the outer budget) without ever measuring what it waits for.
 * Pairing n8n's `Started execution of workflow "AA Pattern - Approval Callback"
 * … ID N` with its `Execution N … finished`, across the slow ticks:
 *
 *     13:43 max 11.43s · 13:58 10.26s · 14:13 10.82s · 17:28 10.77s · 17:43 10.03s
 *     ZERO executions above 12s.
 *
 * So every one of the 29 failures missed by ONE TO TWO SECONDS. 10s sat just
 * under a ~11.5s tail; 30s clears it with ~2.6x headroom. That also corrects the
 * cost this comment used to state: it claimed a slow tick would complete "~2
 * rows instead of ~4" because the sends would burn the new ceiling. They do not
 * — at an ~11s receiver they SUCCEED at ~11s, so a slow tick completes about 5
 * rows and stops at MAX_PER_RUN, against a measured `eligible=6 delivered=0
 * failed=6` at 17:29 today where 60s of tick budget bought nothing at all.
 *
 * ⚠️ One thing this does NOT establish: whether n8n aborts a workflow when the
 * client disconnects. If it did, the 10.0-10.3s durations would partly be an
 * artefact of fr's own abort rather than true receiver latency. The 11.43s
 * sample (above the old ceiling) and the many sub-10s successes argue it does
 * not, but that is inference — direct `execution_entity` access was not
 * available. Re-measure there before moving this number again.
 *
 * THE MECHANISM. The receiver webhook ("AA Pattern - Approval Callback") runs
 * its workflow SYNCHRONOUSLY before it answers, and that workflow performs a
 * Planka card move. Planka answering `504 Gateway Time-out … nginx` under load
 * is the documented cause of the ORIGINAL delivery failures that the whole
 * de-block re-delivery path exists to repair. Slow Planka → >10s → fr aborts a
 * request the receiver is still working on.
 *
 * ⛔ WHY ABORTING EARLY IS NOT FREE — read this before "simplifying" the value
 * back to a literal. fr aborts at the ceiling, but n8n MAY ALREADY HAVE MOVED
 * THE CARD. `deliverDecisionCallback` (services/n8n-callback.ts) correctly
 * refuses to stamp `callback_acked_at` on a failure, so the row stays a
 * candidate; on the next tick the live-card-state gate in
 * workers/deblock-callback-redelivery.ts asks Planka for the card's CURRENT
 * list, finds it is no longer BLOCKED, and scores it `not_blocked`. So a
 * timeout does NOT lose a card move — it produces a SILENT
 * DUPLICATE-IN-WAITING plus a row that is permanently un-stamped and re-read
 * every tick forever. Every ms shaved off this ceiling converts real successes
 * into exactly that state. Raising it is the cheap fix; lowering it is not a
 * simplification, it re-opens a measured 14.4% failure rate.
 *
 * ⚠️ THE OUTER BUDGET, AND WHY 30 AND NOT 120. The only BATCH caller is
 * workers/deblock-callback-redelivery.ts, whose per-tick wall clock is
 * `DEBLOCK_REDELIVERY_TICK_DEADLINE_MS` (default 60_000) with a send cap of
 * MAX_PER_RUN=10. 30s fits inside that 60s, so one send can still complete
 * within a tick. An inner ceiling ABOVE the outer budget would be decided by
 * the outer one and this change would buy nothing. The deadline is checked
 * BEFORE each row, so a slow row overshoots the tick by at most itself, and the
 * advisory lock is unique to this worker (db/advisory-lock-keys.ts), so an
 * overshoot delays only this worker's own next tick 15 minutes later.
 * ⛔ Do not raise this past 60_000 without raising
 * DEBLOCK_REDELIVERY_TICK_DEADLINE_MS in the same change.
 */
export const DEFAULT_APPROVAL_CALLBACK_TIMEOUT_MS = 30_000;

/**
 * Resolve the approval-callback ceiling from the environment.
 *
 * Mirrors the guarded-lazy shape the sibling timeout knobs already use —
 * `decisionCallbackTimeoutMs` / `expiryCallbackTimeoutMs` in
 * services/n8n-callback.ts and `tickDeadlineMs` in the de-block worker: read
 * `process.env` at call time and fall back to the default on anything
 * non-finite or <= 0, so a typo'd or empty env var cannot silently install a
 * 0 ms ceiling that aborts every send instantly.
 */
export function approvalCallbackTimeoutMs(): number {
  const raw = Number(
    process.env.N8N_CALLBACK_TIMEOUT_MS ?? DEFAULT_APPROVAL_CALLBACK_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_CALLBACK_TIMEOUT_MS;
}

export interface N8nClientConfig {
  webhookUrl: string;
  apiUrl: string;
  apiKey: string;
  approvalCallbackSecret: string;
  /**
   * N8N_WEBHOOK_SECRET, sent as `X-Webhook-Secret` by `callWebhook`. The n8n
   * receivers compare it against FR_BACKEND_N8N_WEBHOOK_SECRET (same value).
   */
  webhookSecret: string;
  /**
   * Per-request ceiling for `sendApprovalDecision`, in ms. Omitted — which is
   * the case for the exported production singleton — resolves through
   * `approvalCallbackTimeoutMs()`, i.e. `N8N_CALLBACK_TIMEOUT_MS` or the 30s
   * default above.
   */
  approvalCallbackTimeoutMs: number;
}

export class N8nClient {
  private webhookUrl: string;
  private apiUrl: string;
  private apiKey: string;
  private approvalCallbackSecret: string;
  private webhookSecret: string;
  private approvalCallbackTimeoutMs: number;

  constructor(cfg?: Partial<N8nClientConfig>) {
    this.webhookUrl = cfg?.webhookUrl ?? config.services.n8n.webhookUrl;
    this.apiUrl = cfg?.apiUrl ?? config.services.n8n.apiUrl;
    this.apiKey = cfg?.apiKey ?? config.services.n8n.apiKey;
    this.approvalCallbackSecret =
      cfg?.approvalCallbackSecret ?? config.services.n8n.approvalCallbackSecret;
    this.webhookSecret = cfg?.webhookSecret ?? config.services.n8n.webhookSecret;
    this.approvalCallbackTimeoutMs =
      cfg?.approvalCallbackTimeoutMs ?? approvalCallbackTimeoutMs();
  }

  /**
   * Send an approval decision back to n8n via callback webhook.
   * The universal receiver at `improvement-approval-callback` validates
   * `X-Approval-Callback-Secret` and dispatches the Planka card move per
   * decision (approved → QA list, rejected → TODO list).
   */
  async sendApprovalDecision(callbackPath: string, payload: ApprovalDecisionPayload): Promise<N8nWebhookResponse> {
    // Normalize: callback_path may be stored with or without a leading
    // slash. `${base}/${path}` would otherwise produce a double slash.
    const trimmed = callbackPath.replace(/^\/+/, '');
    const url = `${this.webhookUrl}/${trimmed}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.approvalCallbackSecret) {
      headers['X-Approval-Callback-Secret'] = this.approvalCallbackSecret;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        // ⛔ NOT A LITERAL, AND NOT AN ARBITRARY ONE. A hardcoded 10000 here
        // failed 29 of 202 prod sends (14.4%) in one 8h window, every failure a
        // TimeoutError, because the receiver moves a Planka card synchronously
        // before answering and Planka 504s under load. Aborting early does not
        // lose the card move — it leaves a duplicate-in-waiting and an
        // un-stampable row. Full rationale, and the 60s outer tick budget that
        // bounds this number from above, at
        // DEFAULT_APPROVAL_CALLBACK_TIMEOUT_MS.
        signal: AbortSignal.timeout(this.approvalCallbackTimeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`n8n approval callback failed (${response.status}): ${errorText}`);
      }

      return (await response.json()) as N8nWebhookResponse;
    } catch (error) {
      console.error('Failed to send approval decision to n8n:', error);
      throw error;
    }
  }

  /**
   * Call an arbitrary n8n webhook endpoint.
   *
   * ⚠️ ITS 10s IS DELIBERATELY LEFT ALONE, NOT OVERLOOKED. This is the same
   * literal `sendApprovalDecision` just moved off, and the temptation is to
   * treat them as one knob. They are not the same case: the callers are
   * services/artifact-review-callback.ts (best-effort fire-and-forget to a
   * PRODUCER-SUPPLIED path) and routes/project-request-lifecycle.ts (the
   * project-request-outline trigger); neither triggers a Planka card move, so
   * they have none of the Planka-504 mechanism that made 10s too short for
   * the approval callback, and no measurement says they fail. Holding a
   * request open longer against a third-party-chosen endpoint is a cost with
   * no demonstrated benefit. Move it only with its own numbers.
   *
   * Sends `X-Webhook-Secret` when N8N_WEBHOOK_SECRET is set. Sending it to a
   * producer-supplied path is acceptable: the base is always N8N_WEBHOOK_URL,
   * i.e. n8n, which already holds the value. Never log the headers.
   *
   * Billing attribution: sends `X-Project-Id` / `X-Actor-Id` and merges
   * `project_id` / `actor_id` into a plain-object body (never overwriting a
   * caller-set field). Ids come from `attribution` when the caller passes a
   * key, otherwise from the request context (guard-validated project, the
   * caller's Keycloak `sub`). Omitted when absent — see
   * integrations/_lib/n8n-attribution.ts.
   */
  async callWebhook(
    path: string,
    payload: any,
    attribution: N8nAttributionInput = {},
  ): Promise<N8nWebhookResponse> {
    const url = `${this.webhookUrl}/${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.webhookSecret) {
      headers['X-Webhook-Secret'] = this.webhookSecret;
    }
    const attr = resolveN8nAttribution(attribution);
    Object.assign(headers, n8nAttributionHeaders(attr));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(withN8nAttributionBody(payload, attr)),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`n8n webhook ${path} failed (${response.status}): ${errorText}`);
      }

      return (await response.json()) as N8nWebhookResponse;
    } catch (error) {
      console.error(`Failed to call n8n webhook ${path}:`, error);
      throw error;
    }
  }

  /**
   * Call n8n REST API (requires API key).
   */
  async apiGet(endpoint: string): Promise<any> {
    const url = `${this.apiUrl}${endpoint}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-N8n-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`n8n API GET ${endpoint} failed (${response.status}): ${errorText}`);
    }

    return await response.json();
  }

  /**
   * Health check - verify n8n is reachable.
   *
   * ⛔ THE 5s IS LOAD-BEARING FOR A DIFFERENT REASON AND MUST NOT BE ALIGNED
   * WITH THE CALLBACK CEILING. This answers "is n8n reachable", and a
   * reachability probe that waits 30s reports healthy-but-slow as healthy for
   * 30s. Short is the feature here; the callback ceiling is long for the exact
   * opposite reason. Same for `apiGet`'s 10s: the n8n public REST API does no
   * synchronous workflow execution and no Planka write, so the mechanism that
   * moved the callback number does not apply to it.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/workflows`, {
        method: 'GET',
        headers: {
          'X-N8n-Api-Key': this.apiKey,
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const n8nClient = new N8nClient();
