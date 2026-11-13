// src/routes/approval-mint-design-units.ts
//
// POST /api/approvals/:approvalId/mint-design-units — P2.3 step 3 (C1-59), the Proof-2 mint.
// An EXPLICIT, IDEMPOTENT, COMPUTED operation: a decided A3 (`execution.feature_design_approval`)
// carries its sealed handoff.v2 contract in `metadata.handoff_contract`; this mints ONE dev card
// per contract unit. No post-decision hook and no flag: the conveyor calls it from an atomic.
//
// AUTH / TENANCY — the conveyor-facing computed-op door of POST /api/decompositions/commit
// (`validateAuth` + `ctxTenantId`), NARROWED: the caller's active tenant must BE the EXEC
// tenant (403 mint_design_units_exec_only). There is deliberately no aa-orchestrator
// cross-tenant arm (cardRouteTenantRefusal has one): a customer tenant can never call this.
// The approval is then read under that tenant — another tenant's approval is 404, byte-
// identical to a missing one. Every card is minted through `createProjectCardFor` (the in-
// process body of POST /api/cards/project) under EXECUTION_TENANT_ID, exactly as
// decomposition-commit does — same EXEC pin, suppression read, asset_id dedupe, create lease.
//
// ORDER (each step refuses with ZERO cards minted — validation is all-or-nothing):
//   1. approval exists under the caller's tenant                         404 approval_not_found
//   2. kind === execution.feature_design_approval                        409 approval_kind_invalid
//   3. status === approved                                               409 approval_not_approved
//   4. a stored approve decision exists (any decider kind — human or agent; George
//      2026-10-31: the responder is the responder, not fr's to decide)  409 approval_not_decided
//   5. metadata.handoff_contract present                                 409 missing_contract
//   6. sha256(canonicalizeJcs(contract minus design_approval_id)) ===    409 contract_hash_mismatch
//      metadata.contract_hash (re-verified on READ: the stored contract is what is minted)
//   7. design_approval_id := approval.id (injected when absent; a different stored value is
//      refused design_approval_id_mismatch by step 9, never overwritten)
//   8. contract.design_card_id === approval.card_id (non-null)            409 design_card_mismatch
//      (every unit card is parented under design_card_id and linkParentChild writes THAT card's
//      child_cards unchecked — a sealed contract may only hang its cards under its own A3's card)
//   9. ncn handoff.v2 checks (services/approvals/handoff-mint.ts)        422 handoff_contract_refused
//  10. approvals.project_id present (the project the cards land in)     409 design_project_unresolved
//  11. P2-SCOPE: when the project has DEFERRED deliverables with minter 'mint-design-units', each
//      unit maps to the ONE such deliverable whose AC crit_ ids (criteriaFromAcceptance over its
//      acceptance_criteria text) ⊇ the unit's acceptance_criteria ids:
//        no single deliverable holds them and they reach >1 deliverable 422 unit_spans_deliverables
//        otherwise none holds them                                       422 unit_unmapped
//      No such deliverables at all ⇒ the LEGACY path, unchanged: no deliverable_id, no stamp.
// Steps 4–11 are also SURFACED on the design card (approvals.card_id): one Planka comment through
// the existing `planka.comments` client — the evidence-append idiom (services/improvement-cards/
// evidence-append.ts): non-fatal, never silent, idempotent on a `fr-c159-mint-refusal:` key line.
// The response says whether it landed (`refusal_surfaced`). Every refusal logs `[c159-mint]`.
//
// MINT: one card per unit in requires-first (topological) order; asset_id `a3:<approval.id>:
// <unit_key>` (a DONE-deduping prefix, services/improvement-cards/dedup.ts), so a re-drive gets
// every existing card back and never mints a second. A unit's `requires` become
// requires_card_ids of the sibling cards minted before it. On the P2-SCOPE path each mint body
// carries `deliverable_id` (attached by createProjectCardFor → attachCardToDeliverable, a dedupe
// hit included), and after the LAST card every mint-design-units deliverable is stamped minted
// with its unit count (0 for a deliverable no unit maps to) through stampDeliverableMinted — a
// re-drive replays the same counts (no second stamp).
//   200 { data: { approval_id, contract_hash, cards: [{unit_key, asset_id, card_type, card_id,
//         created}], created_count[, deliverables: [{deliverable_id, minted_count, replayed}]] } }
//         — a second call: same card ids, created false
//   409 minted_count_conflict (a deliverable was already stamped with another count)
//   409 mint_stamp_retry (a deliverable changed between the read and the stamp; retry)
//   422 mint_refused (the minter refused a card on its input; not retryable as-is)
//   502 mint_failed  (upstream failure; retry the same call — it converges on the asset ids)
//   409 mint_incomplete (a card is still being created elsewhere; retry)
//   401 no/invalid token · 403 mint_design_units_exec_only

import { and, eq } from 'drizzle-orm';

import { approvalDecisions, approvals, db } from '../db/client';
import { projectDeliverables } from '../db/schema';
import { criteriaFromAcceptance } from '../lib/deliverable-covers';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { isUuidShape } from '../lib/uuid-shape';
import { jsonResponse } from '../utils/response';
import { EXECUTION_TENANT_ID } from './tenants';
import { createProjectCardFor } from './cards/project';
import { MINT_REFUSAL_STATUSES } from './decomposition-commit';
import { stampDeliverableMinted } from './deliverable-minted';
import { handoffContractHash } from '../services/approvals/handoff-contract';
import {
  designCardBindingRefusal,
  validateHandoffForMint,
  type HandoffCardBody,
  type HandoffViolation,
} from '../services/approvals/handoff-mint';
import { FEATURE_DESIGN_APPROVAL_KIND } from '../services/approvals/u3-gates';
import { plankaAsAgent } from '../services/planka/with-auth';

const C159_LOG = '[c159-mint]';
const MINT_REFUSAL_KEY_PREFIX = 'fr-c159-mint-refusal: ';
/** project_deliverables.minter of the rows THIS route mints and stamps (P2-SCOPE). */
const MINT_DESIGN_UNITS_MINTER = 'mint-design-units';

type UnitDeliverableMap =
  | { ok: true; byUnit: Map<string, string> }
  | { ok: false; code: 'unit_unmapped' | 'unit_spans_deliverables'; unit_key: string; deliverable_ids: string[] };

/**
 * PURE. Map each unit to the ONE deliverable whose crit_ ids ⊇ the unit's criterion ids. A unit
 * whose ids reach more than one deliverable without a single owner (or with several) spans; a
 * unit no deliverable holds is unmapped. First failing unit wins (all-or-nothing).
 */
function mapUnitsToDeliverables(
  bodies: ReadonlyArray<Pick<HandoffCardBody, 'unit_key' | 'card_inputs'>>,
  deliverables: ReadonlyArray<{ id: string; acceptance_criteria: unknown }>,
): UnitDeliverableMap {
  const crits = deliverables.map((d) => ({
    id: d.id,
    ids: new Set(criteriaFromAcceptance(d.acceptance_criteria).map((c) => c.id)),
  }));
  const byUnit = new Map<string, string>();
  for (const b of bodies) {
    const unitIds = b.card_inputs.acceptance_criterion_ids;
    const holders = crits.filter((d) => unitIds.every((id) => d.ids.has(id)));
    if (holders.length === 1) {
      byUnit.set(b.unit_key, holders[0]!.id);
      continue;
    }
    const touched = crits.filter((d) => unitIds.some((id) => d.ids.has(id))).map((d) => d.id);
    if (touched.length > 1) {
      return { ok: false, code: 'unit_spans_deliverables', unit_key: b.unit_key, deliverable_ids: touched };
    }
    return { ok: false, code: 'unit_unmapped', unit_key: b.unit_key, deliverable_ids: touched };
  }
  return { ok: true, byUnit };
}

interface MintedUnitCard {
  unit_key: string;
  asset_id: string;
  card_type: string;
  card_id: string;
  created: boolean;
}

type RefusalSurface = { surfaced: true; replay?: true } | { surfaced: false; reason: string };

function refusal(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: code, code, message, ...extra }, status);
}

/**
 * Put the refusal on the design card. NEVER throws (a failed comment must not turn a 4xx into a
 * 500); every outcome is returned and logged. Idempotent: the key line is looked for on the
 * newest comment page first, so a re-drive of the same refusal does not stack comments.
 */
async function surfaceRefusalOnCard(
  cardId: string | null,
  approvalId: string,
  code: string,
  message: string,
  violations: HandoffViolation[] = [],
): Promise<RefusalSurface> {
  if (!cardId) {
    console.warn(`${C159_LOG} refusal ${code} on approval ${approvalId} NOT surfaced: the approval has no card_id`);
    return { surfaced: false, reason: 'no_card' };
  }
  const key = `${MINT_REFUSAL_KEY_PREFIX}${approvalId}:${code}`;
  try {
    const planka = plankaAsAgent();
    const page = await planka.comments.listForCard(cardId, {});
    if (page.some((c) => (c.text ?? '').split('\n').some((l) => l.trim() === key))) {
      return { surfaced: true, replay: true };
    }
    const lines = violations
      .slice(0, 50)
      .map((x) => `- unit ${x.unit}: ${x.field} ${x.code}${x.detail ? ` (${x.detail})` : ''}`);
    await planka.comments.create({
      cardId,
      text: [
        `**Dev-card mint REFUSED** for design approval \`${approvalId}\`: \`${code}\`. Zero cards were minted.`,
        '',
        message,
        ...(lines.length ? ['', ...lines] : []),
        '',
        key,
      ].join('\n'),
    });
    return { surfaced: true };
  } catch (err) {
    console.warn(
      `${C159_LOG} refusal ${code} on approval ${approvalId} NOT surfaced on card ${cardId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return { surfaced: false, reason: 'comment_write_failed' };
  }
}

async function refuseVisibly(
  approval: { id: string; card_id: string | null },
  status: number,
  code: string,
  message: string,
  extra: { violations?: HandoffViolation[]; details?: Record<string, unknown> } = {},
): Promise<Response> {
  console.warn(`${C159_LOG} approval ${approval.id} refused ${status} ${code}: ${message}`);
  const surfaced = await surfaceRefusalOnCard(approval.card_id, approval.id, code, message, extra.violations);
  return refusal(status, code, message, {
    approval_id: approval.id,
    minted: 0,
    ...(extra.violations ? { violations: extra.violations } : {}),
    ...(extra.details ?? {}),
    refusal_surfaced: surfaced,
  });
}

export async function handleMintDesignUnits(req: Request, approvalIdRaw: string): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);
  if (activeTenantId !== EXECUTION_TENANT_ID) {
    return refusal(
      403,
      'mint_design_units_exec_only',
      'POST /api/approvals/:id/mint-design-units is a conveyor operation of the EXEC tenant only',
    );
  }

  const approvalId = (approvalIdRaw ?? '').trim();
  const [approval] = isUuidShape(approvalId)
    ? await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, approvalId), eq(approvals.tenant_id, activeTenantId)))
    : [];
  if (!approval) return refusal(404, 'approval_not_found', 'Approval not found');

  if (approval.kind !== FEATURE_DESIGN_APPROVAL_KIND) {
    return refusal(409, 'approval_kind_invalid', `approval ${approval.id} is ${approval.kind}, not ${FEATURE_DESIGN_APPROVAL_KIND}`);
  }
  if (approval.status !== 'approved') {
    return refusal(409, 'approval_not_approved', `approval ${approval.id} is ${approval.status}, not approved`, {
      status: approval.status,
    });
  }

  // 4. A stored approve decision exists — any decider kind (human or agent member).
  const decisions = await db
    .select({ decision: approvalDecisions.decision, item_decisions: approvalDecisions.item_decisions })
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approval_id, approval.id));
  const approves = decisions.filter((d) => d.decision === 'approved');
  if (approves.length === 0) {
    return refuseVisibly(approval, 409, 'approval_not_decided', `approval ${approval.id} has no stored approve decision`);
  }

  const meta = (approval.metadata && typeof approval.metadata === 'object' ? approval.metadata : {}) as Record<string, unknown>;
  const stored = meta.handoff_contract;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return refuseVisibly(approval, 409, 'missing_contract', `approval ${approval.id} carries no metadata.handoff_contract`);
  }

  // 6. Re-verify the seal on what is about to be minted.
  const recomputed = handoffContractHash(stored as Record<string, unknown>);
  if (recomputed !== meta.contract_hash) {
    return refuseVisibly(
      approval,
      409,
      'contract_hash_mismatch',
      'the stored handoff_contract no longer hashes to metadata.contract_hash',
      { details: { recomputed, contract_hash: meta.contract_hash ?? null } },
    );
  }

  // 7. Inject the binding (excluded from the hash, so the seal above is unaffected).
  const contract = structuredClone(stored) as Record<string, unknown>;
  if (contract.design_approval_id === undefined) contract.design_approval_id = approval.id;

  // 8. The parent binding: the cards hang under design_card_id, which must be THIS A3's card.
  const cardBinding = designCardBindingRefusal(contract, approval.card_id);
  if (cardBinding) {
    return refuseVisibly(approval, 409, 'design_card_mismatch', cardBinding, {
      details: { design_card_id: contract.design_card_id ?? null, card_id: approval.card_id ?? null },
    });
  }

  // 9. ncn handoff.v2 checks, all-or-nothing.
  const scenarios = Array.isArray(meta.scenarios) ? (meta.scenarios as Array<Record<string, unknown>>) : [];
  const criterionIds = [
    ...new Set(scenarios.map((s) => s.criterion_id).filter((x): x is string => typeof x === 'string' && x.length > 0)),
  ];
  const result = validateHandoffForMint(contract, {
    approval: { id: approval.id, kind: approval.kind, design_hash: meta.design_hash, decided: approves.length > 0 },
    designDoc: { hash: meta.design_hash, criterion_ids: criterionIds },
  });
  if (!result.ok) {
    return refuseVisibly(
      approval,
      422,
      'handoff_contract_refused',
      `the stored handoff.v2 contract fails ${result.violations.length} check(s); first: ${result.code}`,
      { violations: result.violations, details: { first_code: result.code } },
    );
  }

  // 10. Where the cards land.
  if (!approval.project_id) {
    return refuseVisibly(
      approval,
      409,
      'design_project_unresolved',
      `approval ${approval.id} has no project_id; the unit cards have no project to land in`,
    );
  }

  // 11. P2-SCOPE: the deferred deliverables this mint fills, mapped BEFORE any card is minted.
  const deferredRows = await db
    .select({ id: projectDeliverables.id, acceptance_criteria: projectDeliverables.acceptance_criteria })
    .from(projectDeliverables)
    .where(
      and(
        eq(projectDeliverables.project_id, approval.project_id),
        eq(projectDeliverables.deferred, true),
        eq(projectDeliverables.minter, MINT_DESIGN_UNITS_MINTER),
      ),
    )
    .orderBy(projectDeliverables.position);
  // LEGACY: a project with no mint-design-units deliverables (every project promoted before the
  // ncn outline emitted them) mints exactly as before — no deliverable_id, no stamp.
  let deliverableByUnit: Map<string, string> | null = null;
  if (deferredRows.length > 0) {
    const mapped = mapUnitsToDeliverables(result.bodies, deferredRows);
    if (!mapped.ok) {
      return refuseVisibly(
        approval,
        422,
        mapped.code,
        mapped.code === 'unit_spans_deliverables'
          ? `unit ${mapped.unit_key}'s acceptance criteria span ${mapped.deliverable_ids.length} mint-design-units deliverables; no single deliverable holds them all`
          : `no mint-design-units deliverable holds every acceptance criterion of unit ${mapped.unit_key}`,
        { details: { unit_key: mapped.unit_key, deliverable_ids: mapped.deliverable_ids } },
      );
    }
    deliverableByUnit = mapped.byUnit;
  }

  // ── mint (no tx held; each card idempotent on its a3: asset id) ──
  const cards: MintedUnitCard[] = [];
  const cardIdByUnit = new Map<string, string>();
  for (const body of result.bodies) {
    const requiresCardIds = body.requires.map((k) => cardIdByUnit.get(k)).filter((x): x is string => !!x);
    const res = await createProjectCardFor(
      user,
      EXECUTION_TENANT_ID,
      mintRequestBody(body, approval.project_id, requiresCardIds, deliverableByUnit?.get(body.unit_key)),
    );
    const out = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const cardId = typeof out?.card_id === 'string' && out.card_id.length > 0 ? out.card_id : null;
    const failed = (status: number, code: string, message: string): Response => {
      console.error(`${C159_LOG} approval ${approval.id} unit ${body.unit_key}: ${code} (upstream ${res.status}) — ${message}`);
      return refusal(status, code, message, {
        approval_id: approval.id,
        unit_key: body.unit_key,
        asset_id: body.asset_id,
        upstream_status: res.status,
        upstream: out,
        cards,
      });
    };
    if (MINT_REFUSAL_STATUSES.has(res.status)) {
      return failed(422, 'mint_refused', `minting unit ${body.unit_key} was refused (${res.status}); retrying the same call cannot succeed`);
    }
    if (res.status < 200 || res.status >= 300) {
      return failed(502, 'mint_failed', `minting unit ${body.unit_key} failed with ${res.status}; retry the same call to converge`);
    }
    if (!cardId) return failed(409, 'mint_incomplete', `no card id for unit ${body.unit_key} yet; retry the same call`);
    cardIdByUnit.set(body.unit_key, cardId);
    cards.push({
      unit_key: body.unit_key,
      asset_id: body.asset_id,
      card_type: body.card_type,
      card_id: cardId,
      created: res.status === 201,
    });
  }
  const createdCount = cards.filter((c) => c.created).length;
  console.log(`${C159_LOG} approval ${approval.id}: ${cards.length} unit card(s), ${createdCount} created`);

  // P2-SCOPE: after the LAST card, stamp every mint-design-units deliverable with its unit count.
  // In-process (the stamp route's own statement); the EXEC pin was enforced above and by every
  // mint. A re-drive gets `replay` (same count, no second stamp).
  const stamps: Array<{ deliverable_id: string; minted_count: number; replayed: boolean }> = [];
  if (deliverableByUnit) {
    for (const d of deferredRows) {
      const count = [...deliverableByUnit.values()].filter((id) => id === d.id).length;
      const s = await stampDeliverableMinted(approval.project_id, d.id, count);
      if (s.kind === 'stamped' || s.kind === 'replay') {
        stamps.push({ deliverable_id: d.id, minted_count: count, replayed: s.kind === 'replay' });
        continue;
      }
      const conflict = s.kind === 'conflict';
      console.error(`${C159_LOG} approval ${approval.id}: stamping deliverable ${d.id} (${count}) → ${s.kind}`);
      return refusal(
        409,
        conflict ? 'minted_count_conflict' : 'mint_stamp_retry',
        conflict
          ? `deliverable ${d.id} was already stamped minted with count ${s.kind === 'conflict' ? s.minted_count : '?'}, not ${count}`
          : `deliverable ${d.id} could not be stamped (${s.kind}); retry the same call`,
        { approval_id: approval.id, deliverable_id: d.id, requested_count: count, cards, deliverables: stamps },
      );
    }
  }
  return jsonResponse(
    {
      data: {
        approval_id: approval.id,
        contract_hash: recomputed,
        cards,
        created_count: createdCount,
        ...(deliverableByUnit ? { deliverables: stamps } : {}),
      },
    },
    200,
  );
}

/** The POST /api/cards/project body for one unit (EXPORTED so the exact shape is unit-pinned). */
function mintRequestBody(
  body: HandoffCardBody,
  projectId: string,
  requiresCardIds: string[],
  deliverableId?: string,
): Record<string, unknown> {
  return {
    project_id: projectId,
    card_type: body.card_type,
    card_name: body.card_name,
    description: body.description,
    parent_card_id: body.parent_card_id,
    target_list: 'TODO',
    asset_id: body.asset_id,
    ...(requiresCardIds.length > 0 ? { requires_card_ids: requiresCardIds } : {}),
    ...(deliverableId ? { deliverable_id: deliverableId } : {}),
  };
}
