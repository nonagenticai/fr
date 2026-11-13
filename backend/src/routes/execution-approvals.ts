// src/routes/execution-approvals.ts
//
// AA ready-prefetch policy gate — the approve→resume half.
//
// When a card in the AA pipeline reaches the ready-prefetch policy gate that
// requires a human stakeholder sign-off before execution, n8n parks the card
// in BLOCKED and POSTs here. fr creates an `execution.ready_signoff` approval,
// resolves the project's designated approvers from `project_stakeholders`
// (role 'execution_signoff' — seeded at project creation from the
// `approvers` roster), and fans the request out to each approver's engagement
// channel (Telegram / websocket / email per their user_channel_prefs).
//
// The approver's decision flows back through the UNCHANGED standard path:
//   PUT /api/approvals/:approvalId  →  deliverDecisionCallback  →
//   buildCallbackPayload (already emits doingListId/todoListId/boardId) →
//   the `execution-ready-signoff-callback` n8n receiver, which moves the card
//   BLOCKED→DOING (approved, router resumes the doing cell) or leaves it
//   BLOCKED (rejected).
//
// Auth (G5, George 2026-10-10): a bearer through `validateAuth` — an fr LICENCE
// token (the tenant's conveyor seat: n8n) or a Keycloak JWT. X-Webhook-Secret is
// NOT accepted (secret-only = 401). NOT the internal-tenant guard — project
// tenants are external customer tenants, not the three improvement tenants
// requireInternalTenant admits. Same AppError → status mapping (handleError)
// every other route relies on: 401 no bearer, 404 unknown / not-yours project, 400 untenanted project, 403
// fixture-origin (a deliberate refusal, not a defect — see the
// FIXTURE-ORIGIN SUPPRESSION block below), 422 no approvers assigned,
// 422 bad body (ZodError).
//
// ⚠️ THE STATUS CODE IS NOT THE CONTRACT. The caller is the n8n
// `Create Approval (Signoff)` HTTP node, configured
// onError:continueRegularOutput — it has ALREADY moved the card to BLOCKED
// before it POSTs, and it discards whatever this route answers. So every
// refusal ALSO:
//   * carries a stable machine-readable `code` on the body
//     (SIGNOFF_BLOCK_REASONS in lib/execution-signoff.ts), for a caller that
//     does look and wants to branch on the CAUSE rather than on prose; and
//   * writes an `execution_signoff_blocks` row BEFORE throwing (migration 098),
//     which is the part that actually survives. That ledger is what
//     GET /api/execution/approvals/stranded reads — see handleListStrandedSignoffs
//     at the bottom of this file.
// A successful create retires the card's open block rows.

import { z } from 'zod';
import { and, count, eq, inArray, lte, sql as drizzleSql, type SQL } from 'drizzle-orm';
import { validateAuth } from '../middleware/auth';
import { assertLicencePrOnProjectRepo, licenceTenantMismatch } from '../lib/licence-door';
import { isSuperAdmin } from '../lib/super-admin-gate';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/errors';
import {
  assertCallbackUrlAllowed,
  CALLBACK_URL_NOT_ALLOWED_CODE,
  attachApprovalCallbackUrl,
} from '../lib/approval-callback-url';
import { createdResponse, jsonResponse } from '../utils/response';
import { decideProposalGate, scoreProposal } from '../lib/proposal-score';
import { reportProposalScore } from '../lib/proposal-score-metrics';
import {
  artifactRefBodyField,
  assertArtifactRefDedupeCompatible,
  assertArtifactRefInProject,
  parseArtifactRef,
} from '../lib/approval-artifact-ref';
import {
  db,
  approvals,
  approvalKindEnum,
  requiredApprovers,
  projects,
  projectStakeholders,
  departments,
  streams,
} from '../db/client';
import {
  confirmPushDelivery,
  planSignoffApprovers,
  resolveApprover,
} from '../domain/engagement/approval-routing';
import { fanOutApprovalToTenantMembers } from '../domain/engagement/tenant-member-fanout';
import * as notifications from '../domain/engagement/notifications';
import { SIGNOFF_BLOCK_REASONS, isFixtureOrigin } from '../lib/execution-signoff';
import {
  describeSuppression,
  findOpenGateForCard,
  type OpenGate,
} from '../domain/approvals/one-open-gate';
import {
  listOpenSignoffBlocks,
  recordSignoffBlock,
  resolveSignoffBlocks,
} from '../services/execution-signoff-blocks';
import { EXPIRED_STATUS } from '../workers/approval-expiry';
import { deadlineFromHours } from '../lib/approval-deadline';
import {
  classifyUndecidableReason,
  rationaleOrAbsence,
  RATIONALE_PRODUCERS,
} from '../lib/approval-rationale';
import { isValidUuid } from '../utils/tenant';
import { findTenantScopedProject } from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { PLATFORM_TENANT_IDS, isPlatformTenant } from '../middleware/internal-tenant-only';
import { assertProjectNotArchived } from '../lib/project-live-status';
import type { User } from '../types/api';
import {
  assertNoBugFixMarker,
  assertNoCoverageSignoff,
  assertU3DedupeCompatible,
  BUG_FIX_AUTHORISING_KIND,
  BUG_FIX_MARKER_REQUIRES_SECRET_DOOR,
  resolveBugFixAuthorizationMint,
} from '../services/approvals/u3-gates';
import { assertSameBugFixRequest, mintGateOnePerBugCard } from '../services/approvals/bug-fix-uniqueness';
// Planka parent-board lookup (fr#1451): one GET via the admin agent; a 404 or
// any error is `null`, and the caller treats null as "not yours" — fail closed.
import { defaultParentBoardResolver as parentBoardResolver } from '../lib/planka-parent-board';

// The single n8n receiver workflow that handles ready-signoff decisions. fr
// derives it when omitted; any other literal is rejected so stale per-cell
// paths can't slip back in (mirrors the improvement-approval contract).
const CANONICAL_CALLBACK_PATH = 'execution-ready-signoff-callback';

// The role label that marks a project_stakeholders row as an execution
// sign-off approver. Seeded by routes/projects.ts at project creation.
const SIGNOFF_ROLE = 'execution_signoff';

const createExecutionApprovalSchema = z
  .object({
    card_id: z.string().min(1).max(256),
    // Either identifies the project. project_id is preferred (n8n carries it
    // in the project-start brief); boardId is the Planka-board fallback,
    // resolved via projects.planka_board_id.
    // ⛔ DELIBERATELY NOT `z.string().uuid()` — see #910. `schema.parse()` runs
    // before the handler, so a strict uuid() here rejects a malformed stamp one
    // step BEFORE `recordSignoffBlock` is reachable: the caller (n8n
    // `Create Approval (Signoff)`, onError:continueRegularOutput) has already
    // parked the card in BLOCKED and discards the response, so the card was held
    // with NO ledger row and no recorded reason anywhere. That made a MALFORMED
    // id strictly worse off than a merely WRONG one, which #909 routes to the
    // stream fallback and records as `metadata.unresolved_project_id`.
    //
    // The shape test did not disappear, it MOVED to where the ledger is reachable
    // (`malformedProjectId` below). It is `isValidUuid`, whose regex is ANCHORED —
    // load-bearing, not decorative: one of the 10 measured junk stamps is a
    // well-formed uuid DOUBLED ACROSS AN EMBEDDED NEWLINE, which an unanchored
    // test would accept and hand to the projects lookup.
    //
    // ⛔ WHAT THIS DOES NOT WIDEN. Nothing downstream trusts this field: it is
    // never used as a lookup key unless it is UUID-shaped, and it never reaches
    // `approvals.project_id` (a uuid FK to `projects`) — that column is written
    // `project?.id ?? null`, from the RESOLVED row only. Still bounded (min/max)
    // so an unbounded blob cannot be written to the ledger's text column.
    project_id: z.string().min(1).max(256).optional(),
    boardId: z.string().min(1).optional(),
    callback_path: z.literal(CANONICAL_CALLBACK_PATH).nullish(),
    // D17 — the n8n Wait node's `$execution.resumeUrl`, LICENCE lane only (a
    // Keycloak JWT caller is refused 422 `callback_url_not_allowed`). Validated
    // against N8N_CALLBACK_ORIGINS (lib/approval-callback-url.ts); when present the
    // decision is POSTed to it exactly as given and the row stores `callback_path`
    // NULL. ⛔ A capability — never logged in full.
    callback_url: z.string().optional(),
    // D13 — the ONE artifact this sign-off is about: `{artifact_id: uuid, version?: int >= 1}`
    // or null. Narrowed by `parseArtifactRef` (422 `artifact_ref_invalid`) and checked against
    // the resolved project (422 `artifact_ref_not_found`) — lib/approval-artifact-ref.ts.
    artifact_ref: artifactRefBodyField,
    reason: z.string().max(4000).optional(),
    // ⛔ THE PROPOSITION. Measured 2026-09-01: `action_name`, `change_summary` and
    // `impact_analysis` were NULL on 262 of 262 `execution.ready_signoff` rows, because
    // `z.object()` STRIPS unknown keys SILENTLY — n8n could send them and get a 201 while
    // fr discarded them. So the approver was shown a defect narrative and no question, and
    // across 908 approvals of every kind NOT ONE has ever been rejected. A gate that cannot
    // be answered is not a gate; it is a queue that drains by approval or by expiry.
    // `routes/approvals.ts` already accepts these three for the generic kind — this makes the
    // execution kind consistent with it rather than inventing a shape.
    // The columns are `text` and nullable (db/schema.ts:440,441,479); the caps below are ours,
    // to keep one runaway field from crowding out the others in the approver's view.
    action_name: z.string().max(200).optional(),
    change_summary: z.string().max(4000).optional(),
    impact_analysis: z.string().max(4000).optional(),
    expires_in_hours: z.number().int().min(1).max(168).optional(),
    // Resume coordinates the callback receiver needs to move the card back to
    // DOING. doingListId + boardId are required; buildCallbackPayload reads
    // them straight off approval.metadata. passthrough() keeps any extra n8n
    // context (e.g. card_name) without dropping it.
    metadata: z
      .object({
        doingListId: z.string().min(1),
        todoListId: z.string().optional(),
        boardId: z.string().min(1),
        card_type: z.string().optional(),
        // The asker's proposed answer: a bare approve accepts it as the decision comment
        // (deblock-actions `withProposedAnswer`, every seat).
        proposed_answer: z.string().trim().min(1).max(2000).optional(),
      })
      .passthrough(),
  })
  .refine((b) => Boolean(b.project_id || b.boardId), {
    message: 'either project_id or boardId is required',
  });

export { CANONICAL_CALLBACK_PATH, SIGNOFF_ROLE, createExecutionApprovalSchema };

/**
 * POST /api/execution/approvals
 *
 * Body:
 *   {
 *     card_id: string (Planka card id),
 *     project_id?: uuid,            // preferred project key
 *     boardId?: string,            // Planka-board fallback key
 *     callback_path?: 'execution-ready-signoff-callback',
 *     reason?: string,
 *     expires_in_hours?: number,
 *     metadata: { doingListId, todoListId?, boardId, card_type? }
 *   }
 *
 * Returns 201 with the created approval row.
 */

// ── G5: THE LICENCE CALLER MINTS EVERY KIND, TENANT-BOUND ─────────────────────
// A licence caller (`authKind === 'licence'`) is the tenant's conveyor seat and
// takes the metadata the old secret door took — MERGE / SPLIT / DROP deblocks,
// canary, phase-advance, the bug-fix marker (George 2026-10-10) — bound to its
// tenant (a canary target is a platform-owned workflow route, so only a platform
// licence may name one — LICENCE CANARY FIELDS below): `authorizeJwtCaller` pins the target to the licence tenant, every list
// the callback may move the card to (incl. `qaListId`) must be on the target
// board, and a MERGE's PR must be in the project's repository
// (`assertLicencePrOnProjectRepo`). Refused (422 metadata_control_key_forbidden):
// the keys that reach outside the tenant or forge server-owned provenance.
export const LICENCE_METADATA_FORBIDDEN_KEYS = [
  'learning_card_id',
  'stream_id',
  'unresolved_project_id',
  'requested_via',
  'requested_by_user_id',
] as const;

// ── JWT DOOR: METADATA IS DATA, NEVER CONTROL ─────────────────────────────────
// `metadata` is `.passthrough()` and is spread onto the row, and several keys on
// it are not descriptive: `buildCallbackPayload` / the approval-completion phase advance (deleted, fr#1481)
// read them to decide what an APPROVE does — merge a PR, roll back a canary,
// advance the project's macro phase, route to another list. On the licence lane
// the producer is the tenant's conveyor seat (G5 above). On the JWT door the
// producer is a tenant user, so
// those keys would let a routine sign-off, once approved, merge a PR the caller
// chose (fr#1162 audit, review 5277235991).
//
// So on the JWT door:
//   * a CONTROL key is a 422 naming the key, so the caller learns it cannot set
//     it, rather than getting a 201 that silently lost it;
//   * any key not on the data allowlist is DROPPED — a future control key added
//     to the callback builder is therefore inert on this door by default;
//   * `deblock_action` is accepted ONLY as 'QUESTION' with non-empty
//     `open_questions` (what ready-prefetch sends; its callback exit is a move
//     of the caller's own, board-bound card to TODO);
//   * `card_type` is kept as a LABEL only: rows from this door carry
//     `requested_via: 'jwt'`, and the (deleted, fr#1481) phase-signal card-type reader
//     refuses to read their card_type as a phase-advance signal.
export const JWT_METADATA_CONTROL_KEYS = [
  'deblock_action',
  'pr_url',
  'pr_repo_owner',
  'pr_repo_name',
  'pr_number',
  'advance_phase_on_approve',
  'canary_action',
  'list',
  'additional_minutes',
  'learning_card_id',
  'qaListId',
  'initiator',
  'stream_id',
  'unresolved_project_id',
  'requested_via',
  'requested_by_user_id',
] as const;
export const JWT_METADATA_ALLOWED_KEYS = [
  // resume coordinates — each is bound to the target board (findOffBoardTarget, every caller)
  'doingListId',
  'todoListId',
  'boardId',
  // descriptive context ready-prefetch's `Build Create-Approval Body` sends
  'card_type',
  'card_name',
  'project_type',
  'gate_terms',
  'policy_key',
  'policy_source',
  'brief_fingerprint',
  'risk_score',
  'risk_threshold',
  'risk_factors',
  'open_questions',
  // The asker's proposed answer: data the approver accepts or overrides; a bare approve
  // records it as the decision comment (deblock-actions `withProposedAnswer`).
  'proposed_answer',
  'degraded_legs',
  'degraded_legs_soft',
  'decision_authoring_gap',
  'project_id_forwarded',
  'project_id_rejected',
  'project_id_rejected_reason',
  'project_id_existence_checked',
  // The bug-fix authorization marker (`'bug_fix_authorization'`) ready-prefetch forwards.
  // Data, not control: it can only make the row STRICTER (the shared decide gate), never
  // select what an approve does.
  'approval_kind',
] as const;
export const JWT_METADATA_CONTROL_KEY_CODE = 'metadata_control_key_forbidden';

// ── LICENCE CANARY FIELDS: BOUND TO THE ROUTE'S OWNER, SHAPE-CHECKED ──────────
// `canary_action` / `list` / `additional_minutes` (with `card_type`) name a WORKFLOW ROUTE —
// worker_management's (card_type, list) routing slot that the improvement callback rolls back
// or extends. A route is PLATFORM-owned (one routing table, operated with the platform's WM
// credential), not a resource of any customer tenant, so the only tenant it binds to is a
// platform tenant: a customer licence naming a canary target is 403 licence_tenant_mismatch
// (the same refusal an off-tenant qaListId gets), a platform licence may raise it. The shape
// mirrors improvement-approvals' canary contract, so nothing unbounded reaches the row or the
// callback payload: canary_action ∈ {rollback, extend}; card_type + list non-empty strings
// (≤128); additional_minutes an integer in [1, 10080], required for extend and refused
// otherwise; list / additional_minutes without canary_action refused.
const LICENCE_CANARY_FIELDS = ['canary_action', 'list', 'additional_minutes'] as const;
const LICENCE_CANARY_ACTIONS = ['rollback', 'extend'] as const;
const CANARY_MAX_ADDITIONAL_MINUTES = 10080;
const INVALID_CANARY_METADATA_CODE = 'invalid_canary_metadata';

function assertLicenceCanaryFields(m: Record<string, unknown>, licenceTenantId: string | undefined): void {
  if (!LICENCE_CANARY_FIELDS.some((k) => k in m)) return;
  if (!isPlatformTenant(licenceTenantId?.toLowerCase())) {
    throw licenceTenantMismatch('a canary target (a workflow route, platform-owned)');
  }
  const bad = (field: string, why: string): never => {
    throw new ValidationError(`metadata.${field} ${why}`).withCode(INVALID_CANARY_METADATA_CODE);
  };
  const action = m.canary_action;
  if (typeof action !== 'string' || !(LICENCE_CANARY_ACTIONS as readonly string[]).includes(action)) {
    bad('canary_action', "must be 'rollback' or 'extend' when any canary field is set");
  }
  const shortString = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;
  if (!shortString(m.list)) bad('list', 'must be a non-empty string (≤128) naming the routed list');
  if (!shortString(m.card_type)) bad('card_type', 'must be a non-empty string (≤128) naming the routed card type');
  const mins = m.additional_minutes;
  if (action === 'extend') {
    if (typeof mins !== 'number' || !Number.isInteger(mins) || mins < 1 || mins > CANARY_MAX_ADDITIONAL_MINUTES) {
      bad('additional_minutes', `must be an integer in [1, ${CANARY_MAX_ADDITIONAL_MINUTES}] when canary_action=extend`);
    }
  } else if ('additional_minutes' in m) {
    bad('additional_minutes', 'is only accepted with canary_action=extend');
  }
}

function jwtMetadata(
  metadata: z.infer<typeof createExecutionApprovalSchema>['metadata'],
  caller: Pick<User, 'authKind' | 'tenantId'>,
): z.infer<typeof createExecutionApprovalSchema>['metadata'] {
  const m = metadata as Record<string, unknown>;
  const refuse = (key: string, why: string): never => {
    throw new ValidationError(
      `metadata.${key} cannot be set by a bearer-token caller: ${why}. It selects what ` +
        'approving this sign-off DOES, and on this door the server, not the caller, owns that.',
    ).withCode(JWT_METADATA_CONTROL_KEY_CODE);
  };
  // G5: the licence caller keeps the passthrough the secret door had (see the block above);
  // its marker and PR are bound downstream (resolveBugFixAuthorizationMint reads the report
  // only inside the licence-pinned tenant; assertLicencePrOnProjectRepo).
  if (caller.authKind === 'licence') {
    for (const key of LICENCE_METADATA_FORBIDDEN_KEYS) {
      if (key in m) refuse(key, 'it reaches outside the licence tenant or forges server-owned provenance');
    }
    assertLicenceCanaryFields(m, caller.tenantId);
    return metadata;
  }
  // U3: a Keycloak-JWT caller (human / SA) cannot mint the bug_fix_authorization marker —
  // refused loudly: dropping it would turn the caller's bug-fix gate into a plain sign-off
  // with a 201. Only the licence door (here and webhooks card-approval) mints it.
  assertNoBugFixMarker(m, BUG_FIX_MARKER_REQUIRES_SECRET_DOOR, 'the JWT door of POST /api/execution/approvals');
  for (const key of JWT_METADATA_CONTROL_KEYS) {
    if (!(key in m)) continue;
    if (key === 'deblock_action') {
      const oq = m.open_questions;
      if (m.deblock_action === 'QUESTION' && Array.isArray(oq) && oq.length > 0) continue;
      refuse(key, "only 'QUESTION' with a non-empty open_questions is accepted");
    }
    refuse(key, 'control key');
  }
  const out: Record<string, unknown> = {};
  for (const key of JWT_METADATA_ALLOWED_KEYS) {
    if (key in m) out[key] = m[key];
  }
  if (m.deblock_action === 'QUESTION') out.deblock_action = 'QUESTION';
  return out as z.infer<typeof createExecutionApprovalSchema>['metadata'];
}

/**
 * The JWT lane's authorization, applied once the target is resolved and BEFORE
 * any ledger write or roster read. Every refusal is the same 404 as a missing
 * target (no cross-tenant existence leak) and records nothing.
 *
 *   * the approval's tenant must be the caller's ACTIVE tenant — an untenanted
 *     target can therefore never be minted through this door;
 *   * a project must pass `findTenantScopedProject` (owner-AND-tenant, the gate
 *     every mutating project sub-resource uses — NOT the read lane);
 *   * a stream must be owned by the active tenant;
 *   * the card, metadata.boardId and resume lists must be on the target board
 *     (`findOffBoardTarget`).
 */
async function authorizeJwtCaller(
  user: User,
  t: {
    projectId: string | null;
    streamTenantId: string | null;
    resolvedTenantId: string | null;
  } & BoardBinding,
): Promise<void> {
  const notFound = () =>
    new NotFoundError('No project or improvement stream found').withCode(
      SIGNOFF_BLOCK_REASONS.PROJECT_NOT_FOUND,
    );
  const activeTenantId = ctxTenantId(user.tenantId);
  if (!t.resolvedTenantId || t.resolvedTenantId !== activeTenantId) throw notFound();
  if (t.projectId) {
    const reachable = await findTenantScopedProject(db, user, t.projectId);
    if (!reachable) throw notFound();
  } else if (!t.streamTenantId || t.streamTenantId !== activeTenantId) {
    throw notFound();
  }
  // On this door an off-board target is the same 404 as a missing target: no
  // existence leak, no ledger row (see ONE BEARER DOOR in the handler).
  if ((await findOffBoardTarget(t)) !== null) throw notFound();
}

/** The one board a sign-off may act on, and every id the decision callback keys on. */
type BoardBinding = {
  targetBoardId: string | null;
  cardId: string;
  metadataBoardId: string;
  listIds: string[];
};

/**
 * ── THE CARD MUST BE ON THE AUTHORIZED BOARD (fr#1451) ─────────────────────
 *
 * Authorizing the project/stream is not authorizing the CARD: `card_id` is free
 * text, and it is what `resolveSignoffBlocks`, `findOpenGateForCard` and the
 * decision callback (which moves the card) all key on. So: the target must have
 * a board, the card must be on it, the resume `metadata.boardId` must be it, and
 * every list the callback may move the card to must be on it.
 *
 * Returns null when every id is bound, else WHY not. Fail closed: a board
 * Planka cannot answer for (the resolver's null — 404 or any error) is never
 * treated as a match. `authorizeJwtCaller` turns a non-null answer into its 404
 * (the old secret door's 422 + ledger row went with the door, G5).
 */
async function findOffBoardTarget(t: BoardBinding): Promise<string | null> {
  if (!t.targetBoardId) return 'the resolved project/stream has no Planka board (planka_board_id)';
  const board = String(t.targetBoardId);
  if (String(t.metadataBoardId) !== board) {
    return `metadata.boardId ${t.metadataBoardId} is not the target board ${board}`;
  }
  const cardBoard = await parentBoardResolver('card', t.cardId);
  if (cardBoard === null) return `card ${t.cardId}: its board could not be resolved in Planka`;
  if (cardBoard !== board) return `card ${t.cardId} is on board ${cardBoard}, not the target board ${board}`;
  for (const listId of t.listIds) {
    const listBoard = await parentBoardResolver('list', listId);
    if (listBoard === null) return `list ${listId}: its board could not be resolved in Planka`;
    if (listBoard !== board) return `list ${listId} is on board ${listBoard}, not the target board ${board}`;
  }
  return null;
}

/**
 * The 200 answer for "this card already has a gate".
 *
 * ONE owner, because there are now TWO ways to arrive here: the cheap pre-check
 * before triage, and a lost INSERT race inside `mintOneOpenGate`. Those must be
 * byte-identical to a caller — a race is not a different outcome, it is the same
 * outcome discovered later. Two copies would drift, and the second one would be
 * the one nobody reads.
 */
async function dedupGateResponse(existingGate: OpenGate): Promise<Response> {
  const existingRoster = await db
    .select()
    .from(requiredApprovers)
    .where(eq(requiredApprovers.approval_id, existingGate.id));
  // 200, not 201: nothing was created. The body keeps THIS route's envelope —
  // the created path answers `{ data: { id, kind, ... } }`, so a dedup that
  // answered `{ approval_id }` would break every caller reading `data.id` and
  // would trip the response-envelope ratchet. `deduplicated` sits beside the
  // envelope so a caller can tell the two apart without shape-sniffing.
  return jsonResponse({
    data: {
      id: existingGate.id,
      kind: existingGate.kind,
      status: existingGate.status,
      card_id: existingGate.card_id,
      callback_path: existingGate.callback_path,
      description: existingGate.description,
      metadata: existingGate.metadata,
      artifact_ref: existingGate.artifact_ref ?? null,
      required_approvers: existingRoster.length,
      created_at: existingGate.created_at,
      expires_at: existingGate.expires_at,
    },
    deduplicated: true,
  });
}

// ── PROPOSAL QUALITY: A JUDGE BEFORE A PERSON (George 2026-11-01) ──────────────────────────
// A conveyor ask may carry `metadata.proposed_answer` — the answer the coach would give
// itself, which a bare approve accepts as the decision comment. That proposal is written by
// an LLM, and a measured one asserted a claim its own tool contradicted ("the quality service
// reports those paths match no files in this repository", while both files were present).
//
// `metadata.proposal_check: 'required'` asks fr to have laya score the proposal's
// ACTIONABILITY before the row is minted. Not actionable at the shared 0.5 margin ⇒ 422
// `proposal_unclear`, and NOTHING is written: the coach re-proposes with the feedback rather
// than putting a vague answer in front of a person.
//
// ⛔ FAIL OPEN. laya unreachable, no licence for the tenant, timeout, non-200: the ask is
// minted unchanged. A question a human must answer is never withheld because a judge was
// down — that is the direction that strands a card, and it is the worse direction.
// ⛔ LICENCE DOOR ONLY, BY CONSTRUCTION: `jwtMetadata` drops every key outside its data
// allowlist, so a tenant user's JWT can never make this server call a model. `proposal_check`
// is not on that allowlist and must not be added to it.
// ⛔ TRUTH IS NOT JUDGED HERE. Measured 2026-11-01: laya called the false claim above
// "grounded" at 0.70. It separates concrete from vague; whether a claim is TRUE stays a
// prompt rule on the coach. Do not read `proposal_score` as a fact-check.
export const PROPOSAL_CHECK_KEY = 'proposal_check';
export const PROPOSAL_UNCLEAR_CODE = 'proposal_unclear';

export async function assertProposalActionable(args: {
  tenantId: string;
  cardId: string;
  question: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  // ⛔ A CALLER NEVER ASSERTS A VERDICT. `proposal_score` is the SERVER's record of what the
  // judge did, so anything a caller put there is dropped BEFORE the gate can skip — otherwise
  // a licence caller could mint a row claiming `{choice:'actionable',confidence:0.99}` on an
  // ask that was never scored. (Blanking here, not in the forbidden-key list, because the key
  // is fr's own output and must survive its own write.)
  delete args.metadata.proposal_score;
  if (String(args.metadata[PROPOSAL_CHECK_KEY] ?? '') !== 'required') return;
  const proposal = String(args.metadata.proposed_answer ?? '').trim();
  if (!proposal) return;
  const score = await scoreProposal({
    tenantId: args.tenantId,
    question: args.question.trim() || 'A conveyor card is blocked and a person must answer.',
    proposal,
  });
  const decision = decideProposalGate(score);
  if (decision.action === 'proceed') {
    if (decision.recorded) {
      // Evidence on the row, readable through GET /api/approvals/:id (the row is returned
      // whole): what the judge said about THIS ask, not what a caller claimed.
      args.metadata.proposal_score = decision.recorded;
      reportProposalScore({
        outcome: 'pass',
        choice: 'actionable',
        confidence: decision.recorded.confidence,
        tenantId: args.tenantId,
        cardId: args.cardId,
      });
    } else if (!score.available) {
      // Fail open, and SAY SO — a silent skip is indistinguishable from a pass.
      args.metadata.proposal_score = { available: false, reason: score.reason };
      reportProposalScore({
        outcome: 'unavailable',
        choice: 'none',
        reason: score.reason,
        tenantId: args.tenantId,
        cardId: args.cardId,
      });
    }
    return;
  }
  reportProposalScore({
    outcome: 'refused',
    choice: score.available ? score.choice : 'none',
    confidence: score.available ? score.confidence : null,
    tenantId: args.tenantId,
    cardId: args.cardId,
  });
  throw new ValidationError(
    `The proposed answer was not accepted: ${decision.feedback} Nothing was written.`,
  ).withCode(PROPOSAL_UNCLEAR_CODE);
}

export async function handleCreateExecutionApproval(req: Request): Promise<Response> {
  // ── ONE BEARER DOOR, ONE GATE (G5, George 2026-10-10) ────────────────────────
  // The X-Webhook-Secret door is GONE: a secret-only request is 401 (validateAuth).
  // The caller is a licence (the tenant's conveyor seat — typed n8n op
  // `approvals.createExecutionApproval`) or a Keycloak JWT. Either must ALREADY be
  // able to reach the resolved project or stream in its tenant — see
  // `authorizeJwtCaller` below — and everything after that point (fixture refusal,
  // roster, one-open-gate, triage, fan-out) is shared. The two differ only in
  // metadata (`jwtMetadata`): the licence mints every kind, tenant-bound; a JWT
  // gets the data allowlist.
  //
  // ⛔ WHY THIS WIDENS NOTHING. The roster is never taken from the request on
  // either door: it is `project_stakeholders` (role 'execution_signoff', seeded by
  // `resolveSignoffStakeholderIds` at project create) through `planSignoffApprovers`.
  // On a project, the JWT gate is `findTenantScopedProject` — the owner-AND-tenant
  // gate `POST /api/projects/:projectId/approvals` already applies, and that route
  // lets the same caller name ANY roster; this one lets it name none. On a stream,
  // the gate is `streams.tenant_id === active tenant`, and a stream's tenant is
  // always an internal improvement tenant (CHECK streams_kind_tenant_check), so a
  // customer tenant can never mint one. A caller that cannot reach the target gets
  // the same 404 as a missing target, and writes NO ledger row — an
  // unauthenticated-to-this-target caller must not be able to write to the
  // operator's stranded view.
  const caller: User = await validateAuth(req);

  const raw = await req.json();
  const parsedBody = createExecutionApprovalSchema.parse(raw);
  // JWT: metadata is an ALLOWLIST, and any key that selects what the decision
  // callback DOES is refused. Licence: the passthrough (MERGE / canary / … mint),
  // tenant-bound below. See `jwtMetadata`.
  // U3: this route mints execution.ready_signoff, never qa.coverage_signoff, yet the decide
  // path keys a per-criterion COVERAGE verdict on the stored deblock_action. Refused on BOTH
  // doors before the JWT allowlist could silently drop it (assertNoCoverageSignoff).
  assertNoCoverageSignoff(parsedBody.metadata, 'POST /api/execution/approvals');
  // D17: refused/validated BEFORE any lookup that writes, dedupes or mints.
  let callbackUrl: string | null = null;
  if (parsedBody.callback_url !== undefined) {
    if (caller.authKind !== 'licence') {
      throw new ValidationError(
        'callback_url is not allowed: only a licence caller (the n8n conveyor seat) may name ' +
          'a Wait-node resume URL. Nothing was written',
      ).withCode(CALLBACK_URL_NOT_ALLOWED_CODE);
    }
    callbackUrl = assertCallbackUrlAllowed(parsedBody.callback_url);
  }
  // D13: shape first (422 artifact_ref_invalid), before any lookup or write.
  const artifactRef = parseArtifactRef(parsedBody.artifact_ref);
  const body = { ...parsedBody, metadata: jwtMetadata(parsedBody.metadata, caller) };

  // ── #890, THE SECOND DOOR ────────────────────────────────────────────────────
  // `routes/webhooks.ts` refuses a reason no human can answer; this path did not,
  // so whether a crashed producer's error text became a human-facing question
  // depended on WHICH door the approval arrived through — the same split this
  // file's triage comment below describes, in a second place.
  //
  // It matters here specifically because `body.reason` is interpolated verbatim
  // into `description` twice below, and `description` IS the question the
  // approver is shown. `rationaleOrAbsence` (imported above) does not close this:
  // it only handles an ABSENT reason, never an error-shaped one.
  //
  // ⚠️ Measured against production before writing this (2026-09-06): of 842
  // `[ready-signoff]` rows, ZERO would be refused by this guard today. That is
  // the intended blast radius — this closes a hole, it does not reclassify
  // existing traffic. The 118 rows carrying an upstream fault all arrive as
  // deliberately-authored `evidence_gap: …` reports, which `classifyUndecidableReason`
  // passes BY DESIGN (it fires only when a reason STARTS as an error report).
  // Whether those are decidable is a separate question about the AA producer's
  // contract, and is deliberately NOT settled by widening this classifier —
  // a false positive here strands a real card, which is the worse direction.
  // ⚠️ Only when a reason was actually SUPPLIED. Unlike webhooks.ts — where the
  // schema makes `reason` REQUIRED, so 'empty' is a real defect — `reason` is
  // OPTIONAL here and its absence is legitimate: fr falls back to its own
  // 'awaiting human execution sign-off' description below. Classifying an absent
  // reason would refuse every well-formed call that simply omits it. Caught by
  // the 'omitted reason gets past the guard' case, which failed on exactly this.
  const undecidable = body.reason === undefined ? null : classifyUndecidableReason(body.reason);
  if (undecidable) {
    throw new ValidationError(
      `Card ${body.card_id} supplied a sign-off reason that cannot be decided on ` +
        `(${undecidable}): ${JSON.stringify(body.reason)}. An approval a human ` +
        'cannot answer is a timer, not a gate — it consumes approver attention and ' +
        'TTL and then expires unread. Send the actual block reason, or fix the ' +
        'upstream failure that produced this text; do not mint a gate to carry it.',
    );
  }

  const resolveBoardId = body.boardId ?? body.metadata.boardId;

  // ── #910: THE SHAPE TEST, MOVED INSIDE THE HANDLER ───────────────────────────
  // A project_id that is not UUID-shaped is recorded and then ignored, never
  // honoured. Keeping it out of the projects lookup is not cosmetic — passing it
  // to `eq(projects.id, …)` would make Postgres raise
  // `invalid input syntax for type uuid` and turn a diagnosable refusal into a
  // 500 with no ledger row, i.e. exactly the defect this fix closes.
  const malformedProjectId =
    body.project_id && !isValidUuid(body.project_id) ? body.project_id : null;
  const projectKey = body.project_id && !malformedProjectId ? body.project_id : null;

  // Resolve the project row + its tenant via the project → department →
  // workspace chain (workspaces.id IS the tenant_id). Look up by project_id
  // when supplied, else by planka_board_id.
  const projectSelect = db
    .select({
      id: projects.id,
      owner_id: projects.owner_id,
      tenant_id: departments.workspace_id,
      project_data: projects.project_data,
      planka_board_id: projects.planka_board_id,
      status: projects.status,
      repository_url: projects.repository_url,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id));
  // Which key, if any, the project lookup is allowed to use:
  //   * a well-formed project_id → look it up by id;
  //   * a MALFORMED project_id   → no project lookup at all. A malformed key is
  //     still a key the caller NAMED, so it must not silently fall through to the
  //     board→PROJECT chain — that is the same refusal #909 makes for a
  //     well-formed id that resolves to nothing (see the block below), and it is
  //     what keeps a junk stamp from acquiring a project's scope by accident;
  //   * no project_id at all     → look up by planka_board_id.
  let projectWhere: SQL | undefined;
  if (projectKey) projectWhere = eq(projects.id, projectKey);
  else if (!body.project_id) projectWhere = eq(projects.planka_board_id, resolveBoardId);

  const projectRows = projectWhere ? await projectSelect.where(projectWhere).limit(1) : [];
  const project = projectRows[0];

  // ── IMPROVEMENT-STREAM BOARDS ────────────────────────────────────────────────
  // A Planka board is registered in fr as EITHER a project (projects.planka_board_id)
  // OR an improvement stream (streams.planka_board_id) — the asset-authoring boards
  // (Decisions / Principles / Requirements) and the system streams are the latter.
  // routes/webhooks.ts::resolveCardApprovalTenant has always resolved both chains;
  // this route resolved only the project chain, so every gate-eligible card on a
  // stream board 404'd `signoff_project_not_found` and — because the caller runs
  // onError:continueRegularOutput — was parked in BLOCKED permanently and silently.
  // Measured 2026-08-24: 183 unresolved execution_signoff_blocks rows, ALL that one
  // reason, across 13 boards of which 8 are registered streams; all 183 cards were
  // still sitting in BLOCKED. That is 33% of the entire 552-card BLOCKED backlog,
  // caused by two sibling routes in this service disagreeing about what a boardId is.
  //
  // A stream has no project row by construction, so `project_id` on the approval
  // stays null (nullable column) and the sign-off roster cannot come from
  // project_stakeholders — see the roster block below.
  //
  // ⛔ WHAT CHANGED, AND WHY. This was gated on `!project && !body.project_id`, so
  // the fallback ran only when the caller supplied NO project_id at all. A
  // UUID-shaped project_id that resolves to no project row therefore SUPPRESSED the
  // stream lookup and 404'd `signoff_project_not_found` — on a board the very same
  // request would have resolved perfectly had the id simply been omitted. The
  // caller (n8n `ready-prefetch :: Assert Approval Created`) swallows the 404 and
  // reports the card unreleasable, so the card is held in READY instead of getting
  // the sign-off it would otherwise get. Latent only because n8n sends no
  // project_id today; it arms the moment ncn#1210 starts stamping one. Measured on
  // prod worker4: of 106 distinct project_id values on the 302 decision_development
  // cards, 20 are UUID-shaped orphans resolving to no fr project — 58 cards.
  //
  // The extra term was never a stated intent: the #839 commit that added this block
  // describes the rule as "resolve streams.planka_board_id WHEN THE PROJECT CHAIN
  // MISSES", and the request schema calls project_id "preferred" with boardId the
  // "fallback" — a preference that falls back, not an exclusive key. Nor did any
  // test pin it: both `signoff_project_not_found` cases name a board that is a
  // registered PROJECT, so they 404 identically either way. Gating on `!project`
  // alone is what the surrounding prose already claimed to do.
  //
  // ⚠️ WHAT THIS DELIBERATELY DOES NOT DO. It does not fall back from an
  // unresolvable project_id to the board→PROJECT chain. `approvals.project_id` is
  // read downstream as an AUTHORIZATION fact, and resolving a project from a key
  // the caller did not name would attach the approval — and its scope — to a
  // project on the strength of a string that matched nothing. The stream lane is
  // safe precisely because it grants no project scope at all: `project_id` and
  // `requester_id` stay NULL and the tenant comes from `streams.tenant_id`, i.e.
  // the board the card actually lives on. That is byte-for-byte the scope this
  // request would already have received with the bad id omitted, so widening adds
  // no reachable state. An orphan id on a board registered as a real PROJECT still
  // 404s, and should: there the id is the only project key in play and a wrong one
  // must stay loud.
  const streamRows =
    !project && resolveBoardId
      ? await db
          .select({
            id: streams.id,
            tenant_id: streams.tenant_id,
            slug: streams.slug,
            planka_board_id: streams.planka_board_id,
            name: streams.name,
          })
          .from(streams)
          .where(eq(streams.planka_board_id, resolveBoardId))
          .limit(1)
      : [];
  const stream = streamRows[0];

  if (!project && !stream) {
    // No ledger row: a not-found here is indistinguishable from not-yours, and a
    // caller that cannot reach the target must not write to the operator's
    // stranded view. The caller reads the response.
    throw new NotFoundError('No project or improvement stream found').withCode(
      SIGNOFF_BLOCK_REASONS.PROJECT_NOT_FOUND,
    );
  }
  // Tenant scope: prefer the dept→workspace chain, but projects are not
  // department-assigned (dept_id is null in practice), so fall back to the
  // keycloak tenant persisted on project_data at create time — the workspace
  // the project belongs to. Migration 043 requires a non-null tenant on every
  // approval; fail loud rather than write a NULL.
  // streams.tenant_id is NOT NULL, so a stream-resolved board is always tenanted;
  // only the project chain can land untenanted.
  const tenantId = project
    ? (project.tenant_id ??
      ((project.project_data as { keycloak_tenant_id?: string } | null)
        ?.keycloak_tenant_id ??
        null))
    : (stream?.tenant_id ?? null);
  const boardBinding: BoardBinding = {
    // The ONE board this request may act on: the resolved project's board, or
    // the stream's board. The card and every list the callback will move it to
    // must sit on it (findOffBoardTarget — enforced for every caller).
    targetBoardId: project ? (project.planka_board_id ?? null) : (stream?.planka_board_id ?? null),
    cardId: body.card_id,
    metadataBoardId: body.metadata.boardId,
    // `qaListId` reaches the row only on the licence lane (the JWT allowlist drops it).
    listIds: [body.metadata.doingListId, body.metadata.todoListId, (body.metadata as { qaListId?: unknown }).qaListId].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    ),
  };
  await authorizeJwtCaller(caller, {
    projectId: project?.id ?? null,
    streamTenantId: stream?.tenant_id ?? null,
    resolvedTenantId: tenantId,
    ...boardBinding,
  });
  // G5: a licence MERGE names a PR fr's platform credential merges — it must be in
  // the project's repository (a stream target has none ⇒ refused).
  if (caller.authKind === 'licence') {
    assertLicencePrOnProjectRepo(body.metadata as Record<string, unknown>, project?.repository_url ?? null);
  }
  // fr#1499: an approval minted on an ARCHIVED project is written and then
  // INVISIBLE — the approvals project lane hides archived projects — so the
  // card it gates would wait forever. Refuse with 409 `project_archived`
  // before any write. Placed AFTER the authorization above, so a caller that
  // cannot reach the project still gets the 404 (no existence oracle).
  // Licence (n8n) lane: record the block FIRST — n8n's POST node discards this
  // response (onError:continueRegularOutput), so the row is what survives. The
  // target is already bound to the licence tenant, so the row is attributable.
  if (project?.status === 'archived') {
    if (caller.authKind === 'licence') {
      await recordSignoffBlock({
        card_id: body.card_id,
        board_id: resolveBoardId ?? null,
        requested_project_id: body.project_id ?? null,
        reason_code: SIGNOFF_BLOCK_REASONS.PROJECT_ARCHIVED,
        detail: `project ${project.id} is archived; an approval on it would be invisible`,
      });
    }
    assertProjectNotArchived({ id: project.id, status: project.status });
  }
  if (!tenantId) {
    const detail =
      `Project ${project?.id ?? '(stream ' + (stream?.slug ?? 'unknown') + ')'} has no resolvable tenant (no department link and no keycloak_tenant_id on project_data); cannot create a tenant-scoped approval.`;
    await recordSignoffBlock({
      card_id: body.card_id,
      board_id: resolveBoardId ?? null,
      requested_project_id: body.project_id ?? null,
      resolved_project_id: project?.id ?? null,
      reason_code: SIGNOFF_BLOCK_REASONS.PROJECT_UNTENANTED,
      detail,
    });
    throw new BadRequestError(detail).withCode(
      SIGNOFF_BLOCK_REASONS.PROJECT_UNTENANTED,
    );
  }

  // D13: the ref must name an artifact of THIS approval's project (resolved and
  // authorized above — so no existence oracle for a caller who cannot reach it).
  // 422 artifact_ref_not_found before any dedupe or write.
  if (artifactRef) await assertArtifactRefInProject(artifactRef, project?.id ?? null, tenantId);

  // ── U3 BUG-FIX GATE (RULING 10-01) ───────────────────────────────────────
  // A ready-prefetch sign-off marked metadata.approval_kind='bug_fix_authorization' must
  // cite the bug card's U2 report {report_id, report_hash, bug_ids[], bug_card_id}; refused
  // (422/409) before the dedupe and the insert. Unmarked rows: null, nothing changes.
  // The marker reaches here only through the LICENCE caller (tenant-bound:
  // `authorizeJwtCaller` already pinned `tenantId` to the licence tenant, and the mint reads
  // the report only within `tenantId`). The other minting door is webhooks card-approval
  // (licence too). A Keycloak-JWT marked body never reaches here: `jwtMetadata` refuses it
  // with 422 bug_fix_marker_requires_secret_door (code name kept for callers).
  // `parsedBody.metadata` — for the licence it is the same object as `body.metadata`.
  const bugFixAuth = await resolveBugFixAuthorizationMint({ metadata: parsedBody.metadata, tenantId });

  // ── FIXTURE-ORIGIN SUPPRESSION ───────────────────────────────────────────
  // Refuse to MINT a human approval for integration-test traffic. Placed after
  // tenant resolution (so the block row carries a tenant and is attributable)
  // and before the roster block (so no roster is resolved, no `approvals` row is
  // inserted, no `required_approvers` rows are written, and nothing is fanned
  // out to a human's Telegram).
  //
  // MEASURED 2026-08-25: of the 11 PENDING sign-offs in this queue, 11 were
  // fixture traffic — 10 from the Planka project "IT Flow1 — bump fastmcp to
  // 3.4.7", 1 from board `smoke-test-2026-05-01`. Zero were real. IT Flow1 is a
  // live-fire test that cycles a dependency backwards through versions within
  // minutes; it accounts for 129 fixture projects, 402 cards and 37% of all
  // BLOCKED cards, and the trailing 48h of BLOCKED arrivals were 7 fixture / 0
  // real. The pre-existing `_test` suppression cannot see any of it: `_test` is
  // a per-invocation WEBHOOK payload flag, and this driver POSTs
  // `fr /api/projects` instead — the real path, where no `_test` key exists to
  // carry. Hence a marker on the PROJECT (lib/execution-signoff.ts).
  //
  // Reuses `project.project_data`, already selected above — no extra query.
  if (isFixtureOrigin({ projectData: project?.project_data, boardId: resolveBoardId })) {
    const detail =
      `Fixture-origin work: no human sign-off minted for ` +
      `${project ? `project ${project.id}` : `stream ${stream?.slug ?? resolveBoardId}`} ` +
      `(board ${resolveBoardId ?? 'unknown'}). This is a deliberate refusal, not a ` +
      `configuration defect — see SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN.`;
    // Recorded for the same reason as every other refusal (the caller discards
    // the response), but deliberately EXCLUDED from the stranded view — this
    // row is a counter of suppressed synthetic traffic, not an operator task.
    await recordSignoffBlock({
      card_id: body.card_id,
      board_id: resolveBoardId ?? null,
      requested_project_id: body.project_id ?? null,
      resolved_project_id: project?.id ?? null,
      tenant_id: tenantId,
      reason_code: SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN,
      detail,
    });
    // 403, not 422: the request is well-formed and nothing is misconfigured —
    // fr is declining to act on it. The n8n caller runs
    // onError:continueRegularOutput and tolerates the throw; the card stays
    // where the driver put it, which for fixture traffic is the correct
    // end-state (the fixture project is torn down, not signed off).
    throw new ForbiddenError(detail).withCode(SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN);
  }

  // Resolve the execution sign-off roster — the authoritative answer to
  // "who must sign off" lives in project_stakeholders, not the request.
  const stakeholderRows = project
    ? await db
        .select({ user_id: projectStakeholders.user_id })
        .from(projectStakeholders)
        .where(
          and(
            eq(projectStakeholders.project_id, project.id),
            eq(projectStakeholders.role, SIGNOFF_ROLE),
          ),
        )
    : [];
  const rosterUserIds = [...new Set(stakeholderRows.map((r) => r.user_id))];

  // WHO CAN ACTUALLY DECIDE.
  //
  // A stream board has no project_stakeholders row and never can — the roster
  // is seeded by routes/projects.ts at PROJECT creation. Falling through to the
  // NO_APPROVERS 422 here would swap one permanent strand for another, so a
  // stream resolves its approver through the same ladder the card-approval
  // webhook uses (workspace-admin → project owner → APPROVAL_FALLBACK_APPROVER_USER_ID).
  // That ladder is what gitops#2883 armed and what makes the approval addressable;
  // it is still deliberately NOT applied to a PROJECT whose roster is merely EMPTY,
  // because an empty roster must stay a loud configuration error rather than be
  // papered over by the tenant fallback.
  //
  // ⛔ WHAT CHANGED, AND WHY. `approverIds.length === 0` used to be the ONLY test
  // applied to a project's roster, so a roster naming a human who cannot be told
  // counted as a valid roster. 172 of 177 `execution_signoff` stakeholder rows name
  // the exec-operator, whose only channel is the passive `inapp` — 27 of its
  // approvals expired, 4 are pending, and 42 `inapp` deliveries marked `sent`
  // produced zero answers.
  //
  // ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: change WHO the gate belongs to. The
  // roster written to `required_approvers` is the roster the project named, always,
  // whole — see `planSignoffApprovers` for why replacing it with the ladder's single
  // hit is a silent 2-of-2 → 1-of-1 quorum collapse. All the ladder can add here is
  // `escalationUserIds`: a reachable human who is TOLD, so an unpushable roster stops
  // being a silent 24-hour timer without the gate quietly changing hands.
  const plan = await planSignoffApprovers({
    rosterUserIds,
    ladder: () => resolveApprover({ tenantId, projectId: project?.id ?? null }),
    allowLadderOnEmptyRoster: !project,
    tenantId,
  });
  const approverIds = plan.approverIds;

  if (approverIds.length === 0) {
    // A policy-gated project with no approvers assigned is a configuration
    // error, not a transient one — 422 so the caller (and the operator) sees
    // it clearly instead of silently creating an unactionable approval.
    //
    // "so the caller sees it clearly" was the original intent and it was never
    // true: the caller discards the response. The recorded block is what makes
    // it actually visible, and the `code` is what lets a caller that DOES look
    // branch on the cause rather than on the message text.
    //
    // ⚠️ An UNREACHABLE roster is recorded as its own reason. It is not the same
    // defect as an empty one and it does not have the same remedy: the human is
    // already assigned, they just cannot be told. Reporting it as NO_APPROVERS
    // sends the operator to seed another stakeholder, who — on the measured
    // estate, where 172 of 177 rows name the same inapp-only exec-operator —
    // would be exactly as unreachable as the first.
    const reasonCode = plan.rosterUnreachable
      ? SIGNOFF_BLOCK_REASONS.NO_REACHABLE_APPROVER
      : SIGNOFF_BLOCK_REASONS.NO_APPROVERS;
    const detail = plan.rosterUnreachable
      ? `No reachable approver for ${project ? `project ${project.id}` : `stream ${stream?.slug ?? resolveBoardId}`} (tenant ${tenantId}). ` +
        `The '${SIGNOFF_ROLE}' roster names ${rosterUserIds.length} user(s) and EVERY one of them has channel prefs ` +
        `carrying no push channel (inapp/websocket are passive and cannot discharge a gate), and no workspace-admin, ` +
        `project owner or APPROVAL_FALLBACK_APPROVER_USER_ID could be reached either — so there is nobody to escalate ` +
        `to. Considered: ${JSON.stringify(plan.considered)}.`
      : (project
        ? `Project ${project.id} has no '${SIGNOFF_ROLE}' approvers; assign approvers at project creation before gating execution.`
        : `Improvement stream ${stream?.slug ?? resolveBoardId} has no reachable approver for tenant ${tenantId}; give the tenant a workspace-admin with an enabled push channel, or set APPROVAL_FALLBACK_APPROVER_USER_ID.`);
    await recordSignoffBlock({
      card_id: body.card_id,
      board_id: resolveBoardId ?? null,
      requested_project_id: body.project_id ?? null,
      resolved_project_id: project?.id ?? null,
      tenant_id: tenantId,
      reason_code: reasonCode,
      detail,
    });
    throw new ValidationError(detail).withCode(reasonCode);
  }

  // ⛔ NO DEADLINE UNLESS ONE WAS ASKED FOR. `card_id` is required on this route, so every row
  // it writes is card-blocking, and BLOCKED is the human-input gate — a TTL on it is the
  // defect, not the feature. The previous `?? 24` made NULL unreachable through the API even
  // after migration 105 made the column nullable, which is why 132 of these kept expiring.
  const expiresAt = deadlineFromHours(body.expires_in_hours);

  // ── ONE CARD, ONE OPEN GATE (#892) ───────────────────────────────────────────────────────
  // This path inserted UNCONDITIONALLY while its sibling (routes/webhooks.ts) had
  // suppressed duplicates since 2026-08-26 — so whether a card could collect a second
  // pending approval depended on which door the request came through. Same asymmetry
  // this path has already been fixed for once (it set no triage at all until 2026-09-01).
  //
  // MEASURED 2026-08-30 over the complete 585-row population: 101 live pending rows for
  // 69 distinct (card_id, kind) pairs; 24 pairs carried more than one live row,
  // accounting for 56 of the 101. Every refutation in that triage run was this defect.
  //
  // ⚠️ This used to say "checked BEFORE triage, not after: triage is a network call, and a
  // request that is going to be deduplicated should not pay for one". The triage step was
  // removed on 2026-09-23 (see the block below), so that ordering argument no longer has a
  // subject — but the CHECK stays exactly where it is, because the rest of the reason does:
  // a request that is going to be deduplicated should not do the fan-out work either.
  const existingGate = await findOpenGateForCard({ tenantId, cardId: body.card_id });
  if (existingGate) {
    // U3: a MARKED request dedupes only onto the SAME request (hash, bug card, bug_ids as a
    // set); a different one is 409, never the old row: bug_card_already_has_approval only when
    // the open gate IS this bug card's authorization, else open_gate_conflict (an unmarked
    // gate, or a marked row for another bug card — for which bug-fix-for-card reads 404).
    assertSameBugFixRequest(existingGate, bugFixAuth, BUG_FIX_AUTHORISING_KIND);
    // This door mints execution.ready_signoff, never a G-12 gate kind: an open
    // execution.question / feature_design / coverage gate on the card is 409, not "yours".
    assertU3DedupeCompatible(null, existingGate);
    // D13: the gate keeps its own artifact_ref; a request naming another is 409.
    assertArtifactRefDedupeCompatible(existingGate, artifactRef);
    console.warn(describeSuppression('execution-approvals', body.card_id, existingGate));
    // D17: the deduped create's Wait node must resume too — ATTACH its URL to the
    // surviving gate (a no-op when that URL is already attached).
    if (callbackUrl) await attachApprovalCallbackUrl(existingGate.id, tenantId, callbackUrl);
    return dedupGateResponse(existingGate);
  }

  // ── PROPOSAL QUALITY, AFTER THE DEDUPE, BEFORE THE MINT ─────────────────────────────────
  // After: a request that will be answered by an EXISTING open gate shows no new proposal, so
  // paying for a judge and refusing the duplicate would only make the coach retry against a
  // question it cannot replace. Before: the mint, so a refused proposal writes nothing — no
  // approval, no roster, no fan-out.
  await assertProposalActionable({
    tenantId,
    cardId: body.card_id,
    question: body.change_summary ?? body.reason ?? '',
    metadata: body.metadata as Record<string, unknown>,
  });

  // ── TRIAGE (B10b) — REMOVED 2026-09-23, AND THE REMOVAL IS THE FIX ───────────────────────
  // This path used to call `triageApproval()` and store the result in the four `triage_*`
  // columns, added by B10b because the sibling path (routes/webhooks.ts) did and "is this
  // approval triaged?" therefore answered differently depending on which door the request
  // came through. The asymmetry was real; the cure was symmetry in the WRONG DIRECTION.
  //
  // MEASURED 2026-09-23: the four columns had ZERO readers outside their own write paths —
  // zero in backend/src, zero in frontend/src. `triageApproval()` is a hardcoded pass-through
  // returning the same constant for every row, so B10b's own acceptance test ("a created
  // ready-signoff approval carries a triage verdict, actor and rationale") was satisfied by a
  // constant. Both doors now agree by writing NOTHING, which is the symmetric state that costs
  // a human nothing to read.
  //
  // ⛔ AND IT COST A NETWORK CALL PER MINT. `triageApproval` is an async seam intended to become
  // an n8n worker call; every ready-signoff mint paid for it (and for the escalate-on-throw
  // catch) to compute a value that was written and never read again.
  //
  // ⚠️ `approver_user_id` was deliberately never set here either, for the same reason one level
  // out: the approver IS recorded, correctly, in `required_approvers` below (role
  // `execution_signoff`), which is the de facto roster every authorization site actually reads.
  // That column likewise has ZERO readers in backend/src; B10a removes it.
  //
  // The columns themselves stay until migration 130 — a column cannot be dropped in the release
  // that still writes it, because a lagging or rolled-back pod would INSERT into a dropped
  // column and 500 this route. See the block at the `gateValues` insert in routes/webhooks.ts.

  // The values are built first and handed to `mintOneOpenGate`, which makes the
  // INSERT itself the arbiter against migration 114's partial unique index. The
  // pre-check above is a cheap fast path, not a guard: between its SELECT and this
  // write another execution can mint, which is fr#1000 (39 mints on one card in
  // 60s, tightest pair 57ms apart). A conflict here is not an error — it means a
  // sibling won, and the gate it created is the honest answer to "gate this card".
  const gateValues: typeof approvals.$inferInsert = {
      tenant_id: tenantId,
      project_id: project?.id ?? null,
      requester_id: project?.owner_id ?? null,
      status: 'pending',
      kind: 'execution.ready_signoff',
      description: `[ready-signoff] ${body.card_id}: ${body.reason ?? 'awaiting human execution sign-off'}`,
      // D17: a callback_url row has NO callback_path — the decision goes to the URL
      // only, never also to `${N8N_WEBHOOK_URL}/<callback_path>`.
      callback_path: callbackUrl ? null : (body.callback_path ?? CANONICAL_CALLBACK_PATH),
      card_id: body.card_id,
      source: 'n8n',
      // D13 (migration 192): validated above against the resolved project.
      artifact_ref: artifactRef,
      // ⛔ NEVER present-and-empty — and, since 2026-09-03, never absent either.
      //
      // The rule here used to be `?? null`, argued against `?? ''`: the frontend renders
      // these on a truthiness check (`approvals/+page.svelte:934-945`, the [id] detail view
      // and `NeedsYouQueue.svelte`), so `''` draws an EMPTY heading — a proposition that
      // looks answered and says nothing. That half still holds and is still enforced.
      //
      // But NULL takes the OTHER failure. It renders nothing at all, so the approver cannot
      // distinguish "the producer supplied no reasoning" from "this kind of approval has no
      // reasoning section".
      //
      // Re-measured 2026-09-03 06:52 UTC (an earlier version of this comment claimed "273 of
      // 275" and "69 of 72"; BOTH were wrong — see lib/approval-rationale.ts for the full
      // correction). Over the last 72h this route's `evidence_gap` cohort is 402 rows, 292
      // with a real worker rationale and 110 with none. And it is a CUTOVER, not a rate: by
      // day it runs 0/58 · 0/121 · 54/71 · 169/170 · 69/70, i.e. the producer began emitting
      // rationales on 2026-09-01 and nothing of any kind carried one before that.
      //
      // The `decision_authoring_gap` link is real, but only once the cutover is held
      // constant: on 2026-09-01 alone, 3 of 32 `decision_authoring_gap` rows carry prose
      // against 54 of 67 `evidence_gap` rows without that term. On those cards the decisions
      // author produced ZERO decisions, so there IS no worker rationale upstream to carry.
      // Those rows rendered identically to the ones that DO carry reasoning: silent.
      // `rationaleOrAbsence` makes the second case SAY so, in fr's own voice, naming the
      // producer.
      //
      // ⛔ It does NOT invent one. See lib/approval-rationale.ts: a summary synthesised from
      // the description or the gate terms would let a human believe they hold the worker's
      // reasoning when they hold fr's paraphrase of a defect narrative.
      //
      // `action_name` keeps `?? null`: it is stored for the queue predicate and is deliberately
      // not assumed to be visible, so an absence marker there would be noise, not disclosure.
      action_name: body.action_name ?? null,
      change_summary: rationaleOrAbsence(
        body.change_summary,
        'change_summary',
        RATIONALE_PRODUCERS.readySignoff,
      ),
      impact_analysis: rationaleOrAbsence(
        body.impact_analysis,
        'impact_analysis',
        RATIONALE_PRODUCERS.readySignoff,
      ),
      // Spread the n8n metadata (doingListId/todoListId/boardId/card_type +
      // any passthrough keys) so buildCallbackPayload can echo the resume
      // coordinates straight back on the decision callback.
      //
      // ── `policy_key` VS `tenant_id` — WHY THIS FILE DOES NOT RECONCILE THEM ──
      // MEASURED (7d to 2026-09-26): 9 rows from this route carry
      // `tenant_id = …0003` while their own `metadata.policy_key` names
      // `…0001`. That disagreement is the live cause of the tenant-scoped count
      // split in fr#1140 — the same gate is counted under two tenants
      // depending on which field the reader trusts.
      //
      // ⛔ THE TENANT IS NOT DERIVED FROM THE POLICY KEY, AND MUST NOT BE.
      // `tenantId` above comes from fr's OWN ownership chain (board → project →
      // department → workspace, or board → stream) and is the column every
      // authorization site reads to decide who may see and decide this row.
      // `policy_key` arrives on a `.passthrough()` object supplied by the
      // caller — it is on `JWT_METADATA_ALLOWED_KEYS` as DESCRIPTIVE CONTEXT,
      // deliberately not a control key. Letting it choose the tenant would let
      // a caller move a gate into a tenant that never owned the work, which is
      // a cross-tenant authorization defect and strictly worse than the
      // mislabelling it would fix.
      //
      // ⭐ SO THE DISAGREEMENT IS RECORDED, NOT SILENTLY RESOLVED — and it is
      // recorded ONE level down, in `domain/approvals/one-open-gate.ts
      // :: policyKeyTenantMismatch`, which stamps
      // `metadata.policy_key_tenant_mismatch` onto the row AFTER this spread
      // (so a caller cannot forge or blank it) and counts it on
      // `fr_approval_answerability_total{reason="tenant_policy_key_mismatch"}`.
      // It lives there rather than here for the same reason the one-open-gate
      // rule does: every n8n door mints through that one arbiter, and a check
      // written in a route is a check the next route forgets.
      metadata: {
        ...body.metadata,
        // U3 bug-fix gate: the validated marker + report/bug fields replace the raw copies.
        ...(bugFixAuth ?? {}),
        reason: body.reason ?? null,
        // ⛔ THE DEFECT THIS CLOSES (#889): a stream-board sign-off was ORPHANED
        // FROM ITS STREAM. The stream identity is resolved above (:~197-212) and
        // was then spent entirely on log strings and error `detail` text — it was
        // never written to the row, so once the request returned there was no way
        // to answer "which improvement stream is this approval for?" from the
        // approvals table at all.
        //
        // `project_id` is NOT the place to put it and stays null on purpose: a
        // stream has no project row by construction (see the IMPROVEMENT-STREAM
        // BOARDS block above), and `approvals.project_id` is an FK to `projects`
        // that a stream id would violate.
        //
        // `metadata->>'stream_id'` is the ESTABLISHED link, not a new one:
        // migration 047 (:~31-40) backfills `approvals.tenant_id` by joining
        // `streams.id::text = a.metadata->>'stream_id'`, and
        // routes/improvement-approvals.ts (:~228-231) already writes exactly this
        // key at insert time for the `improvement.*` kinds. Writing it here puts
        // `execution.ready_signoff` rows raised off a stream board on the same
        // footing as their improvement-kind siblings — no migration, no column.
        //
        // Written ONLY on the stream lane, and after the `...body.metadata`
        // spread so a caller cannot forge or blank it: a project-resolved row has
        // no stream, and `stream_id: undefined` would serialise into the jsonb as
        // an explicit null that `metadata->>'stream_id' IS NOT NULL` in 047 would
        // still (correctly) skip but which reads as "looked for one and found
        // none" rather than "not applicable". `...(cond ? {k:v} : {})` omits the
        // key outright.
        ...(stream ? { stream_id: stream.id } : {}),
        // Provenance: through which bearer, and (JWT only) WHO minted it. Written
        // after the spread so a caller cannot forge or blank it. A licence's subject
        // is not a person: `requested_by_user_id` feeds the requester derivation
        // (one-open-gate `resolveRequesterId`, a visibility fact), so it is omitted
        // for a licence exactly as it was for the old secret door.
        ...(caller.authKind === 'licence'
          ? { requested_via: 'licence' }
          : { requested_via: 'jwt', requested_by_user_id: caller.id }),
        // ⚠️ AN ID THAT RESOLVED TO NOTHING IS NOT SWALLOWED. Degrading to the
        // stream lane is the right end-state for the CARD, but a caller sending a
        // project_id that matches no project row is still sending something wrong,
        // and the 404 was the only thing that ever made that visible. Keep the id
        // as PROVENANCE — never as scope: `project_id` above stays null, so this
        // key confers nothing and no reader treats it as authority. It is written
        // only on the degraded path (`!project` here means the stream lane
        // resolved), after the `...body.metadata` spread so a caller cannot forge
        // or blank it, and omitted outright rather than serialised as an explicit
        // null on the normal path. `buildCallbackPayload` is a closed allowlist so
        // it never reaches the n8n receiver.
        //
        // #910: this key now carries the MALFORMED case too, and deliberately under
        // the SAME name. "Unresolved" is the property that matters to every reader
        // — the id named no project and conferred no scope — and splitting it into
        // a second key would make an operator query for junk stamps miss the
        // orphans and vice versa. `project_id` above is still `project?.id ?? null`,
        // so neither kind can reach the authorization column.
        ...(!project && body.project_id
          ? { unresolved_project_id: body.project_id }
          : {}),
      },
      expires_at: expiresAt,
  };

  // U3: a marked row is also arbitrated by migration 153's one-bug-fix-authorization-per-bug-
  // card UNIQUE index — 409 bug_card_already_has_approval, or the existing row (deduplicated)
  // only when it is the SAME request (report_hash, bug_card_id, bug_ids as a set); the same
  // equality gates the generic onConflict dedupe, whose refusal is open_gate_conflict unless
  // the re-read row is this bug card's authorization. Unmarked rows: exactly mintOneOpenGate.
  const { gate: approval, deduplicated: gateWasDeduplicated } = await mintGateOnePerBugCard(
    { tenantId, cardId: body.card_id, values: gateValues },
    bugFixAuth,
  );
  if (gateWasDeduplicated) {
    // The race re-read is the same dedupe as the pre-check above, so the same refusal.
    assertU3DedupeCompatible(null, approval);
    assertArtifactRefDedupeCompatible(approval, artifactRef);
    console.warn(describeSuppression('execution-approvals', body.card_id, approval));
    if (callbackUrl) await attachApprovalCallbackUrl(approval.id, tenantId, callbackUrl);
    return dedupGateResponse(approval);
  }

  if (!approval) {
    throw new Error('execution approval insert returned no rows');
  }

  if (callbackUrl) await attachApprovalCallbackUrl(approval.id, tenantId, callbackUrl);

  await db.insert(requiredApprovers).values(
    approverIds.map((user_id) => ({
      tenant_id: tenantId,
      approval_id: approval.id,
      user_id,
      role: SIGNOFF_ROLE,
    })),
  );

  // Fan-out: ws broadcast for live badges + per-user resolution so each
  // approver gets the request on their chosen channel (Telegram / websocket /
  // email per user_channel_prefs). Fire-and-forget — a channel failure must
  // not fail the approval creation (the row is already durable + resolvable
  // via the fr frontend).
  notifications.notificationService
    .fanOut({ ...approval, metadata: null }, [{ channel: 'websocket', address: 'broadcast' }])
    .catch((err) => console.error('[execution-approvals] ws fan-out error:', err));

  // AWAITED, unlike the ws broadcast above. The per-user fan-out is what writes the
  // `engagement_deliveries` rows that `confirmPushDelivery` then reads, so firing it
  // and returning would race the confirmation to a guaranteed NULL. It keeps its own
  // catch: a channel failure must still not fail the approval creation (the row is
  // durable and resolvable in the fr frontend) — it must only fail to be CONFIRMED.
  for (const user_id of approverIds) {
    await notifications.notificationService
      .fanOutToUser({ ...approval, metadata: approval.metadata ?? null }, user_id, 'approval')
      .catch((err) => console.error('[execution-approvals] per-user fan-out error:', err));
  }

  // ESCALATION — non-empty ONLY when every named approver is measurably unpushable.
  // These humans are told, not enrolled: they are absent from `required_approvers`
  // above by design, so the quorum stays exactly the roster the project named. This
  // is the whole of what the ladder is allowed to do on the project arm.
  if (plan.escalationUserIds.length > 0) {
    console.error(
      `[execution-approvals] approval ${approval.id} has an UNPUSHABLE roster ` +
        `(${approverIds.join(', ')}) — escalating to ${plan.escalationUserIds.join(', ')}. ` +
        'The roster is unchanged; give one of its members a push channel.',
    );
    for (const user_id of plan.escalationUserIds) {
      await notifications.notificationService
        .fanOutToUser({ ...approval, metadata: approval.metadata ?? null }, user_id, 'approval')
        .catch((err) => console.error('[execution-approvals] escalation fan-out error:', err));
    }
  }

  // P1-TEAM-b (George 2026-10-15): every member of the approval's tenant is told — told,
  // NOT enrolled: `required_approvers` above stays the quorum, and any member may
  // discharge it through the 1-of-any decide arm. Awaited, before the confirmation below.
  await fanOutApprovalToTenantMembers({
    approval: { ...approval, metadata: approval.metadata ?? null },
    tenantId,
    alreadyNotified: [...approverIds, ...plan.escalationUserIds],
    context: 'execution-approvals',
  });

  // ⛔ THE DEFECT THIS CLOSES. This call did not exist, so `notified_at` was NULL on
  // EVERY `execution.ready_signoff` approval ever created — not because delivery
  // failed, but because nothing ever looked. `workers/approval-expiry.ts` reads that
  // column and, on NULL, writes "NOBODY WAS EVER NOTIFIED … this is a routing failure,
  // not an unanswered request; re-raise it". Measured on prod 2026-08-24: approvals
  // 2c06f00a and c39185fb were both stamped NULL while `engagement_deliveries` held
  // `telegram`/`sent` rows for both. The worker was about to name a cause it had never
  // checked, on every signoff row in the table.
  await confirmPushDelivery(approval.id, 'execution-approvals');

  // The card is releasable again — retire any block rows it accumulated while
  // the project was misconfigured, so the operator view stays a list of things
  // that are still broken.
  await resolveSignoffBlocks(body.card_id, { tenantId });

  console.log(
    `[execution-approvals] Created ready-signoff approval ${approval.id} for ` +
      `${project ? `project ${project.id}` : `stream ${stream?.slug ?? resolveBoardId}`} ` +
      `(${approverIds.length} approver(s), card ${body.card_id})`,
  );

  return createdResponse({
    data: {
      id: approval.id,
      kind: approval.kind,
      status: approval.status,
      card_id: approval.card_id,
      callback_path: approval.callback_path,
      description: approval.description,
      metadata: approval.metadata,
      artifact_ref: approval.artifact_ref ?? null,
      required_approvers: approverIds.length,
      created_at: approval.created_at,
      expires_at: approval.expires_at,
    },
  });
}

// ---------------------------------------------------------------------------
// Operator visibility — GET /api/execution/approvals/stranded
// ---------------------------------------------------------------------------
//
// The question this exists to answer, in one request:
//
//     "Which cards are blocked on an approval that can never be granted?"
//
// Before this endpoint, answering it required a hand-written join across two
// separate databases (kanban.custom_field_value ⨝ fr.project_stakeholders) that
// nobody could run from inside the product — which is why a backlog of
// permanently stranded cards accumulated for five weeks with nothing red
// anywhere.
//
// There are exactly two ways a card ends up stranded, and the response reports
// both separately because they need different fixes:
//
//   `unreleasable` — the approval was never created at all. fr refused
//       (unknown project / untenanted project / empty approver roster) and n8n
//       discarded the refusal. Fix = repair the project configuration; the
//       `remedy` field on each row says which.
//
//   `expired` — the approval WAS created, nobody decided it before
//       `expires_at`, and workers/approval-expiry.ts has since closed it as
//       terminal. Fix = re-raise the gate (or fix why nobody was notified);
//       the card is still in BLOCKED and no sign-off happened.
//
//   `pending_past_expiry` — a live-fire canary. These are rows the expiry
//       worker has not yet swept. It should be 0 in steady state; a number
//       that stays non-zero means the worker is not running, which is exactly
//       the silent-failure mode this work exists to eliminate.
//
// Auth: super-admin. This is cross-tenant operator diagnostics — an
// `unreleasable` row for an unresolvable project has no tenant to scope it to
// (execution_signoff_blocks.tenant_id is nullable for precisely that reason),
// so there is no correct tenant-scoped rendering of it.

/**
 * Every approval kind the reaper can strand — read from the schema enum rather
 * than restated, so a new kind cannot be added to the column without appearing
 * here.
 *
 * ⛔ THE DEFECT THIS CLOSES. `workers/approval-expiry.ts` says in its own header
 * that it is "deliberately kind-agnostic": its UPDATE has no `kind` predicate, so
 * it writes a terminal `status='expired'` (plus an `error_message`, plus the
 * "NOT SENT"/"FAILED" re-queue stamps) for ANY kind. This view — the ONLY
 * operator surface that reads those stamps — filtered BOTH its queries on
 * `kind = 'execution.ready_signoff'`. So a `generic` or `improvement.design`
 * approval that expired with an unreachable n8n receiver became terminal, kept
 * its error_message, and appeared in no operator view at all. Permanently,
 * silently stranded. Expiry is one-way (`handleUpdateApproval` 422s any decision
 * on a non-pending row), so there is no later chance to notice.
 *
 * ⚠️ MEASURED, prod (worker4, db `fr`, 2026-09-08) — and the measurement is what
 * makes this urgent rather than theoretical:
 *   * all 120 rows currently `expired` ARE `execution.ready_signoff`, so nothing
 *     is stranded-and-invisible TODAY. Read alone that number says "no problem".
 *   * but pending: generic **1,169**, improvement.design **24**,
 *     execution.ready_signoff 181 — and `min(expires_at)` across ALL THREE is
 *     **2026-09-10**, two days out. Every one of those 1,193 non-signoff rows
 *     carries a `callback_path`, so the reaper WILL sweep them and WILL try to
 *     notify. The zero above is a zero that depends on a deadline not having
 *     arrived yet.
 *
 * The fix is not "add the two missing kinds": that would re-create the same
 * drift the next time `approvalKindEnum` grows. The view is kind-AGNOSTIC by
 * default — matching the reaper it reports on — with an OPTIONAL `?kind=` filter
 * for an operator who wants one lane.
 */
const STRANDED_KIND_FILTERS = approvalKindEnum.enumValues;

/**
 * Parse `?kind=`. Absent or empty → no filter (report every kind, matching the
 * reaper). Present and not a real approval kind → 400.
 *
 * ⛔ IT MUST REFUSE RATHER THAN IGNORE, and that is not a style preference. The
 * sibling defect in `routes/approvals.ts` (`parseApprovalStatusFilter`, and its
 * long comment) was exactly this: a filter param that fell through to the
 * UNFILTERED list and reported it as the filtered answer — `?status=expired`
 * returned 2,448 rows instead of 106, a 23x overstatement presented as an answer
 * to the question that was asked. An ignored filter is worse than a rejected one
 * because nothing downstream can tell.
 *
 * `''` is treated as ABSENT, not as an error — that is what a form control
 * submits for "any kind", and the unfiltered list is the correct answer to it.
 * Case-sensitive: the column stores the enum spelling, and silently
 * lower-casing would be a second guess in a function that exists because
 * guessing was the bug.
 */
type StrandedKindFilter =
  | { ok: true; kind: string | undefined }
  | { ok: false; message: string };

function parseStrandedKindFilter(raw: string | null): StrandedKindFilter {
  if (raw === null || raw.trim() === '') return { ok: true, kind: undefined };
  if (!(STRANDED_KIND_FILTERS as readonly string[]).includes(raw)) {
    return {
      ok: false,
      message: `kind must be one of: ${STRANDED_KIND_FILTERS.join(', ')}`,
    };
  }
  return { ok: true, kind: raw };
}

function signoffAuthErrorToResponse(e: unknown): Response {
  if (e instanceof ForbiddenError) return jsonResponse({ error: 'forbidden' }, 403);
  if (e instanceof UnauthorizedError) return jsonResponse({ error: 'unauthorized' }, 401);
  const code = (e as { code?: string }).code;
  if (typeof code === 'string' && code.startsWith('ERR_JWT_')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

/**
 * GET /api/execution/approvals/stranded
 *
 * Query: `?kind=<approval kind>` — OPTIONAL. Absent → every kind, which is the
 * scope the reaper actually operates on. An unrecognised value is a 400, never a
 * silently unfiltered list (see parseStrandedKindFilter).
 *
 * ⚠️ THE `unreleasable` BUCKET IS UNAFFECTED BY `?kind=` AND THAT IS CORRECT, not
 * an oversight. It comes from `execution_signoff_blocks`, a ledger written when
 * fr REFUSED to create an approval at all — those rows have no approval and
 * therefore no kind to filter on. Filtering the two approval-backed buckets while
 * leaving it whole is the only honest rendering; the alternative (emptying it
 * under a kind filter) would assert that no card is unreleasable, which is a
 * different and false claim.
 *
 * Returns:
 *   {
 *     summary: { unreleasable, expired, pending_past_expiry },   // full counts
 *     unreleasable: [ { card_id, board_id, reason_code, remedy, attempts, ... } ],
 *     expired:      [ { id, kind, card_id, project_id, expires_at, ... } ],  // ≤500
 *     pending_past_expiry: [ ...same shape as expired... ]                   // ≤500
 *   }
 */
export async function handleListStrandedSignoffs(req: Request): Promise<Response> {
  try {
    const user = await validateAuth(req);
    if (!isSuperAdmin(user)) throw new ForbiddenError('super-admin only');
  } catch (e) {
    return signoffAuthErrorToResponse(e);
  }

  // Refused, never ignored — see parseStrandedKindFilter. Returned rather than
  // thrown because every other exit from this handler is a Response, so a caller
  // holding the function directly (the integration suite does) reads the refusal
  // the same way an HTTP caller does.
  const kindFilter = parseStrandedKindFilter(
    new URL(req.url).searchParams.get('kind'),
  );
  if (!kindFilter.ok) {
    return jsonResponse({ error: kindFilter.message }, 400);
  }
  // `and()` drops an `undefined` arm, so an absent filter emits the SAME SQL as
  // no filter at all rather than a `kind = NULL` that would match nothing.
  const kindScope = kindFilter.kind
    ? eq(approvals.kind, kindFilter.kind as (typeof STRANDED_KIND_FILTERS)[number])
    : undefined;

  // ⛔ fr row 14d: PLATFORM tenants only. A super-admin alone never lists a
  // customer tenant's rows: the approval-backed buckets carry
  // `approvals.tenant_id IN <platform set>`, and the ledger bucket keeps only
  // blocks whose `tenant_id` is a platform tenant (a NULL tenant fails closed).
  const platformScope = inArray(approvals.tenant_id, [...PLATFORM_TENANT_IDS]);
  const unreleasable = (await listOpenSignoffBlocks()).filter((b) =>
    isPlatformTenant(b.tenant_id),
  );

  const approvalCols = {
    id: approvals.id,
    card_id: approvals.card_id,
    project_id: approvals.project_id,
    tenant_id: approvals.tenant_id,
    // ⚠️ Load-bearing now that the view is multi-kind: without it an operator
    // reading a mixed list cannot tell a stranded `improvement.design` from a
    // stranded signoff, which is the difference between "re-raise the gate" and
    // "the improvement loop is stuck".
    kind: approvals.kind,
    status: approvals.status,
    description: approvals.description,
    created_at: approvals.created_at,
    expires_at: approvals.expires_at,
    error_message: approvals.error_message,
  };

  const expired = await db
    .select(approvalCols)
    .from(approvals)
    .where(and(eq(approvals.status, EXPIRED_STATUS), kindScope, platformScope))
    .orderBy(approvals.expires_at)
    .limit(500);

  // The canary described above: pending AND past expires_at. routes/approvals.ts
  // refuses to decide these (`Approval has expired`) and nothing else touches
  // them, so while they sit here they are undecidable by construction.
  const pendingPastExpiry = await db
    .select(approvalCols)
    .from(approvals)
    .where(
      and(
        eq(approvals.status, 'pending'),
        lte(approvals.expires_at, drizzleSql`now()`),
        kindScope,
        platformScope,
      ),
    )
    .orderBy(approvals.expires_at)
    .limit(500);

  // ⚠️ The summary counts the FULL population, not the page.
  //
  // `summary` used to be `expired.length` / `pendingPastExpiry.length` — the
  // length of a list already clamped to 500. That was harmless while the view
  // was signoff-only (120 expired rows on prod, nowhere near the cap) and stops
  // being harmless the moment it goes kind-agnostic: measured 2026-09-08 there
  // are 1,374 pending approvals whose earliest `expires_at` is 2026-09-10, so
  // the `pending_past_expiry` canary — the bucket whose entire job is to say
  // "the reaper is not keeping up" — would have reported a flat 500 while the
  // real number climbed past 1,000. A number that saturates is not a canary.
  // The rows stay capped (this is an operator page, not an export); only the
  // count is honest about what the cap hid.
  const [expiredTotal] = await db
    .select({ n: count() })
    .from(approvals)
    .where(and(eq(approvals.status, EXPIRED_STATUS), kindScope, platformScope));
  const [pendingPastExpiryTotal] = await db
    .select({ n: count() })
    .from(approvals)
    .where(
      and(
        eq(approvals.status, 'pending'),
        lte(approvals.expires_at, drizzleSql`now()`),
        kindScope,
        platformScope,
      ),
    );

  return jsonResponse({
    summary: {
      unreleasable: unreleasable.length,
      expired: expiredTotal?.n ?? expired.length,
      pending_past_expiry: pendingPastExpiryTotal?.n ?? pendingPastExpiry.length,
    },
    unreleasable,
    expired,
    pending_past_expiry: pendingPastExpiry,
  });
}
