// AA Card Substrate Phase 6 — POST /api/cards/improvement
//
// Validation gate that accepts a fully-qualified
// `card_generation_request_template.v1` body (see
// services/improvement-cards/request-schema.ts), maps it to all 8 AA-spec
// customFieldGroups, and creates the Planka card via the unified
// createImprovementCard helper.
//
// Two tenant gates depending on card_type:
//
//   * Asset-authoring card_types (principle/requirement/decision* —
//     extended in Plan 7 Stage 0a) accept ANY authenticated tenant. The
//     asset stream is lazily provisioned per (tenant, kind) on first
//     call via getOrCreateAssetStream. No `stream_slug` required.
//
//   * Every other card_type is refused with the opaque 404: it was admitted
//     only on the three v3 improvement tenants, deleted 2026-11-03
//     (kata-super-admin §7).
//
// Why we resolve the stream ourselves (instead of trusting the body's
// stream_id/stream_slug verbatim): the body is workflow-authored and we
// don't want a poisoned slug + wrong board id minting a card on the
// wrong board. We always resolve the stream under the authenticated
// tenant, then read its planka_board_id from the DB row.
//
// Error envelope is the simple `{ error: code, ... }` shape used by the
// Phase 5 relations route — n8n consumers already speak it.

import { z } from 'zod';

import { CardGenerationRequest } from '../../services/improvement-cards/request-schema';
import { valuesFromRequest } from '../../services/improvement-cards/from-request';
import { createImprovementCard } from '../../services/improvement-cards/create';
import {
  PLAN_PIN_METADATA_FIELD,
  insertPlanPin,
  preparePlanPin,
  type PreparedPlanPin,
} from '../../services/improvement-cards/plan-pin';
import { boardField, resolveBoardFieldGroups } from '../../services/planka/custom-fields';
import {
  createByNameLeaseKey,
  findOpenCardByName,
  findOpenCardForAsset,
  isDedupedCardType,
  partitionBoardLists,
} from '../../services/improvement-cards/dedup';
import {
  claimCreateLease,
  createLeaseKey,
  releaseCreateLeaseQuietly,
  waitForOpenCard,
} from '../../services/improvement-cards/create-lease';
import { cardTypeCapability } from '../../services/catalogue/tenant-catalogue';
import { legacyPriorityText, resolveTenantPriority } from '../../services/catalogue/priority-levels';
import {
  appendDedupeEvidence,
  evidenceResponseFields,
  isEvidenceBearing,
} from '../../services/improvement-cards/evidence-append';
import { stampBlockReasonQuietly } from '../../services/card-block-reason';
import { isBlocked } from '../../lib/phase';
import {
  getStreamBySlug,
  addMember,
  type AssetKind,
} from '../../services/streams/repository';
import { STREAM_MEMBER_ASSET_KINDS } from '../../db/schema';
import {
  getOrCreateAssetStream,
} from '../../services/streams/provisioner';
import { PlankaClient } from '../../services/planka';
import { jsonResponse } from '../../utils/response';
import { validateAuth } from '../../middleware/auth';
import {
  assetStreamKindForCardType,
  isAssetCardType,
  refuseRetiredInternalSurface,
} from '../../middleware/internal-tenant-only';
import { getTenantId, getTenantIsServiceAccountSubject } from '../../integrations/_lib/context';
import { handle } from '../assets/_lib/handler';
import { isDoneEquivalentListName } from '../../lib/done-equivalent';
import { isProofSubsetCardType } from '../../domain/engagement/proof-subset';
import { doneWithoutComputedCheckBody } from '../../services/done-guard';

const PLANKA_BOARD_PLACEHOLDER = 'planka-tbd';

// `asset_stream_membership.asset_id` is `uuid NOT NULL`, but the card request's
// `asset_id` is a free `z.string().optional()` — and deliberately so: the WS3-C
// parent-approval flow stamps a SYNTHETIC id (`<parentCardId>:<kind>:<title>`,
// see the dedup block below), which is not a UUID and must never reach the
// column. Reuse of the streams route's own regex, kept in sync by shape.
const MEMBERSHIP_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Minus 'card' (migration 144): a stream-membership write of 'card' would hit
// the asset_stream_membership_not_card CHECK, so it is skipped as unknown.
const ASSET_KIND_VALUES = new Set<string>(STREAM_MEMBER_ASSET_KINDS);

type MembershipOutcome =
  | 'recorded'
  | 'skipped_no_asset'
  | 'skipped_non_uuid_asset_id'
  | 'skipped_unknown_asset_kind'
  | 'failed';

/**
 * Step 6 — record the card's subject asset as a member of its stream.
 *
 * WHY THIS EXISTS. `asset_stream_membership` has been EMPTY since
 * `migrations/038_internal_improvement_workspaces.sql:32` TRUNCATEd it on
 * 2026-04-29 during the tenancy redesign. The write path never broke —
 * `addMember` (services/streams/repository.ts) works — but nothing automated
 * ever called it (its only route, the streams members CRUD, was deleted with
 * the stream surfaces, kata-super-admin §7), and
 * `getOrCreateAssetStream` provisions the stream without ever adding its
 * subject. So the one code path that both creates a stream AND knows which
 * asset it is about is this route, and it was not writing the row.
 *
 * Two things stayed broken for that whole period:
 *   - `POST /api/assets/:kind/:id/improvement-card` is hard-gated on membership
 *     (`routes/assets/streams.ts`, "manual-trigger doesn't bypass membership")
 *     and therefore 404s for EVERY asset;
 *   - the n8n `detector-scan-streams` walk reads `GET …/members`, gets `[]` for
 *     every stream, and can never mint a card.
 *
 * NON-FATAL BY DESIGN, BUT NEVER SILENT. The card is already minted when this
 * runs. Throwing here would return an error for a card that exists, inviting a
 * retry that mints a second one — strictly worse than a missing index row. So a
 * failure is caught, logged, AND reported to the caller as
 * `stream_membership: 'failed'`. Every skip likewise names its reason. This is
 * a deliberate graceful degrade with a real reader, not a swallow.
 */
async function recordStreamMembership(
  streamId: string,
  assetId: string | undefined,
  assetKind: string | undefined,
  tenantId: string,
): Promise<MembershipOutcome> {
  if (!assetId || !assetKind) return 'skipped_no_asset';
  if (!MEMBERSHIP_UUID.test(assetId)) return 'skipped_non_uuid_asset_id';
  // The card schema does not constrain asset_kind to the enum; an unknown value
  // would make the INSERT throw on the enum cast rather than fail a check.
  if (!ASSET_KIND_VALUES.has(assetKind)) return 'skipped_unknown_asset_kind';

  try {
    // Idempotent: addMember is ON CONFLICT DO NOTHING with a follow-up SELECT,
    // so a re-mint against the same asset returns the existing row.
    const row = await addMember(
      streamId,
      assetKind as AssetKind,
      assetId,
      tenantId,
    );
    // null = the tenant guard rejected the stream, which cannot happen here
    // (we resolved the stream for this tenant moments ago) — but if it ever
    // does, say so rather than reporting a write that did not happen.
    return row ? 'recorded' : 'failed';
  } catch (e) {
    console.error(
      '[POST /api/cards/improvement] stream membership write failed',
      { streamId, assetKind, assetId },
      e,
    );
    return 'failed';
  }
}

// Wrap the impl in the standard `handle()` so any IntegrationError thrown
// deep in the request path maps to its proper HTTP status via
// integrationErrorResponse instead of escaping as a bare 500. The notable
// case: `refuseRetiredInternalSurface()` throws IntegrationError(UPSTREAM_NOT_FOUND)
// for a non-asset card_type — that must surface as
// a clean 404 (the surface stays private), not a 500. Planka/DB UPSTREAM_*
// failures (timeout → 504, unreachable → 502) likewise map correctly.
export function handleCreateImprovementCard(req: Request): Promise<Response> {
  return handle(
    () => createImprovementCardImpl(req),
    (res) => res,
  );
}

async function createImprovementCardImpl(req: Request): Promise<Response> {
  await validateAuth(req);

  // 1. Validate the body. zod gives us a structured `issues` array we can
  //    surface to the caller — workflow authors need to know which field
  //    is rejected. Body parse runs BEFORE the tenant gate so we can
  //    branch on card_type (asset vs system).
  let parsed: ReturnType<typeof CardGenerationRequest.parse>;
  try {
    const raw = await req.json();
    parsed = CardGenerationRequest.parse(raw);
  } catch (e: unknown) {
    if (e instanceof z.ZodError) {
      return jsonResponse(
        { error: 'validation_failed', issues: e.issues },
        400,
      );
    }
    return jsonResponse(
      { error: 'validation_failed', issues: [{ message: String(e) }] },
      400,
    );
  }

  // 1b. U11 — validate, size-cap and hash the plan pin (sha256 computed HERE,
  //     server-side) and refuse a bad one with a 422 before any Planka call,
  //     stream resolution or lease. Pure; nothing is written.
  let planPin: PreparedPlanPin | null = null;
  if (parsed.plan_pin) {
    const prepared = preparePlanPin(parsed.plan_pin);
    if (!prepared.ok) return jsonResponse(prepared.body, prepared.status);
    planPin = prepared.pin;
  }

  // 2. Decide the tenant gate by card_type and resolve the stream.
  //    - Asset card_types: any authenticated tenant; lazily provision
  //      the per-tenant asset-authoring stream via getOrCreateAssetStream.
  //    - Other card_types: refused (their improvement tenants are gone).
  const planka = PlankaClient.fromConfig().asAgent();

  let tenantId: string;
  let stream: Awaited<ReturnType<typeof getStreamBySlug>>;
  if (isAssetCardType(parsed.card_type)) {
    const t = getTenantId();
    if (!t) return jsonResponse({ error: 'tenant_required' }, 401);
    // A service-account `sub` is a caller identity, not a tenant (§2.4): the
    // fr-backend SA sub 6d5a9a20-… minted three asset streams as if it were a
    // workspace. Refuse before getOrCreateAssetStream can provision one.
    if (getTenantIsServiceAccountSubject()) {
      return jsonResponse(
        {
          error: 'service_account_subject_not_a_tenant',
          message:
            'the token is a service account with no tenant_id claim, so its sub ' +
            'would be used as a tenant id; authenticate as the tenant of the card ' +
            'this call acts for instead (e.g. a tenant licence token)',
        },
        403,
      );
    }
    tenantId = t;
    const assetKind = assetStreamKindForCardType(parsed.card_type);
    if (!assetKind) {
      // Should be unreachable — isAssetCardType + the
      // assetStreamKindForCardType switch are kept in lock-step. Surface
      // loudly so a future drift between the two doesn't go silent.
      return jsonResponse({ error: 'unknown_asset_card_type' }, 400);
    }
    stream = await getOrCreateAssetStream(tenantId, assetKind, planka);
  } else {
    refuseRetiredInternalSurface('createImprovementCard', 'fr-streams');
  }
  if (!stream) return jsonResponse({ error: 'stream_not_found' }, 404);
  if (
    !stream.planka_board_id ||
    stream.planka_board_id === PLANKA_BOARD_PLACEHOLDER
  ) {
    return jsonResponse({ error: 'stream_board_not_provisioned' }, 409);
  }

  // 3. Resolve the target list on the stream's board. Lists are
  //    name-keyed (TODO/READY/DOING/QA/BLOCKED/DONE) — the AA spec
  //    requires every system-stream board to carry all 6, but we don't
  //    auto-create here; if the operator hasn't provisioned the
  //    requested list we 404 cleanly so the caller can retry against a
  //    different list (or run the provision script).
  const lists = await planka.lists.listByBoard(stream.planka_board_id);
  const targetList = lists.find((l) => l.name === parsed.target_list);
  if (!targetList) {
    return jsonResponse(
      { error: 'target_list_not_found', list: parsed.target_list },
      404,
    );
  }

  // DONE-move guard (ncn#2087 row #7), create arm: a NEW card holds no computed pass, so a
  // proof-subset card may never be minted straight into a DONE-family list.
  if (isDoneEquivalentListName(targetList.name) && isProofSubsetCardType(parsed.card_type)) {
    return jsonResponse(
      { ...doneWithoutComputedCheckBody('(new card)', parsed.card_type), card_id: null },
      409,
    );
  }

  // 3b. Open-card dedup. Two families are deduped, both keyed on an OPEN card
  //     (any list except DONE) already carrying this asset_id on the board —
  //     return it idempotently instead of minting a second:
  //       * DEDUP_CARD_TYPES — detector/sweep *_analysis cards. The
  //         improvability governor is event-driven: n8n fires a scoped
  //         measurement after every QA exec_quality write, so an asset that
  //         keeps passing QA while its analysis card is still open would mint a
  //         duplicate every time (nothing else dedupes — orchestrator + DB
  //         create unconditionally).
  //       * PARENT_APPROVAL_DEDUP_CARD_TYPES (WS3-C) — AA-intake
  //         parent-approval `*_development` cards, created unconditionally so a
  //         BLOCKED→DOING re-run duplicates them. The orchestrator stamps a
  //         stable synthetic asset_id (`<parentCardId>:<kind>:<title>`), so a
  //         re-run collapses onto the existing OPEN card.
  //       * DETECTOR_SIGNATURE_DEDUP_CARD_TYPES — blocked-escalate learning
  //         cards. That workflow mints one on EVERY transition into BLOCKED and
  //         already passes a stable synthetic `asset_id` (its
  //         `block_reason_class::card_type::subject` learning_signature) for
  //         this exact purpose, naming this route as the collapsing point. The
  //         card_types it emits were in neither set above, so the key was
  //         computed and never consulted — measured 2026-08-26 as 125 cards
  //         carrying 14 distinct signatures, all minted inside 2 days.
  //     The `parsed.asset_id &&` gate is load-bearing: a `*_development` card
  //     WITHOUT an asset_id (every manual/human-authored asset card — see
  //     PARENT_APPROVAL_DEDUP_CARD_TYPES doc) is NEVER suppressed. A card only
  //     in DONE does NOT suppress (a fresh degradation / re-open re-emits).
  //
  //     ⚠️ #996 — that read ALONE is a TOCTOU. It answers "is there an open
  //     card?" and the create it guards then runs for tens of seconds
  //     (measured 2026-08-16: 54–104s per card, 10/10 samples), so two
  //     emitters firing inside that window both read "none" and both create.
  //     Steps 3c/3d below add a create LEASE around exactly that window. See
  //     services/improvement-cards/create-lease.ts for the mechanism and for
  //     why the lease deliberately carries no card id.
  // Hoisted above the dedup arms: step 3e keys its read and its lease on the
  // card title, and the title must be the SAME string the mint at step 5 uses
  // or the lease would guard a name no card is ever created under. Computed
  // once, here, for both.
  const trimmedTitle = parsed.problem_statement.slice(0, 200);

  // U7 (LEDGER C2-31) — EVERY dedupe answer goes through here, so no path can
  // collapse an evidence-bearing request onto an open card and drop its
  // evidence. Six call sites (asset arm: pre-read, lease loser, winner recheck;
  // name arm: the same three). SCOPED: only a request whose additional_context
  // carries `source_card_id` appends; any other hit (detector `*_analysis`
  // re-emits) answers byte-identically to pre-U7 — no Planka call, no evidence
  // fields. The append never throws and never changes the status or card_id —
  // its outcome is reported alongside them. See evidence-append.ts.
  const boardId = stream.planka_board_id;
  const evidenceBearing = isEvidenceBearing(parsed);
  const dedupeHit = async (
    cardId: string | null,
    dedupePath: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> => {
    if (!evidenceBearing) {
      return jsonResponse({ card_id: cardId, deduped: true, ...extra }, 200);
    }
    const outcome = await appendDedupeEvidence(planka, {
      boardId,
      cardId,
      tenantId,
      cardRequest: parsed,
      dedupePath,
    });
    return jsonResponse(
      { card_id: cardId, deduped: true, ...extra, ...evidenceResponseFields(outcome) },
      200,
    );
  };
  // The card's group = its card type's RM capability in the minting tenant's
  // catalogue (design Q1 = a). Read BEFORE any lease is claimed, so an RM
  // failure here (or CatalogueNotInitialised) can never strand a lease; '' when
  // the tenant has no such card type, exactly as the vendored lookup answered.
  const cardGroup = (await cardTypeCapability(tenantId, parsed.card_type)) ?? '';
  // Design Q3 = b: a supplied priority must be one of the minting tenant's RM
  // levels (400 invalid_priority before any lease); Metadata.priority gets the
  // level's legacy text.
  const priorityText =
    parsed.priority !== undefined
      ? legacyPriorityText((await resolveTenantPriority(tenantId, parsed.priority)).level!)
      : undefined;

  let heldLease: { key: string; owner: string } | undefined;
  if (
    parsed.asset_id &&
    isDedupedCardType(parsed.card_type)
  ) {
    // Open lists (everything except DONE) and, within them, the BLOCKED ones.
    // A card parked in BLOCKED suppresses only until the dedup module's TTL
    // expires — see its BLOCKED-SUPPRESSION essay for the 16 assets a single
    // BLOCKED card had sealed for two months. The split lives in the dedup
    // module beside the rule it feeds, so "which list is the blocked one" has
    // exactly one spelling on this path.
    const { openListIds, blockedListIds } = partitionBoardLists(lists);
    const assetId = parsed.asset_id;
    const findOpen = (): Promise<string | null> =>
      findOpenCardForAsset(planka, {
        boardId: stream.planka_board_id,
        assetId,
        openListIds,
        blockedListIds,
      });

    const existingCardId = await findOpen();
    if (existingCardId) {
      return dedupeHit(existingCardId, 'asset:open_card');
    }

    // 3c. Nobody has an open card. Try to become the one process allowed to
    //     create one for this (tenant, board, asset).
    const leaseKey = createLeaseKey(stream.planka_board_id, assetId);
    const owner = crypto.randomUUID();
    const won = await claimCreateLease(tenantId, leaseKey, owner);

    if (!won) {
      // LOSER. Never creates — its only job is to answer with the winner's
      // card once that card becomes visible, or to say a create is running.
      // The card id comes from findOpenCardForAsset, never from the lease.
      const marker = await waitForOpenCard(findOpen);
      return marker
        ? dedupeHit(marker, 'asset:lease_loser')
        : dedupeHit(null, 'asset:lease_loser', { create_in_progress: true });
    }

    // 3d. WINNER RECHECK — load-bearing, do not remove (mutant M5).
    //     The pre-read at step 3b happened BEFORE the claim. A previous
    //     winner A may have created its card and released its lease in
    //     between, which is precisely why this claim succeeded. Without this
    //     second read, B mints a duplicate of A's card.
    const afterClaim = await findOpen();
    if (afterClaim) {
      await releaseCreateLeaseQuietly(tenantId, leaseKey, owner);
      return dedupeHit(afterClaim, 'asset:winner_recheck');
    }

    heldLease = { key: leaseKey, owner };
  } else {
    // ── 3e. THE UN-ASSETED ARM ────────────────────────────────────────────
    // ⛔ THE ARM ABOVE IS NOT REACHED BY EVERY CREATE, AND THIS IS THE HALF
    // THAT WAS MEASURED DUPLICATING. `parsed.asset_id && isDedupedCardType(...)`
    // excludes every card with no asset_id and every card_type outside the
    // three dedup sets — and for that population this route did a bare create
    // with NO read, NO lease and no unique constraint anywhere. It is not that
    // the check-then-act raced; there was no check to race with.
    //
    // MEASURED (7d to 2026-09-26): 7 duplicate pairs on
    // `POST /api/cards/improvement`, each pair the SAME board with an
    // IDENTICAL card name, created within 780s of each other.
    //
    // ⭐ CLOSED WITH THE MECHANISM THIS ROUTE ALREADY USES, not a new one:
    // pre-read → `claimCreateLease` → WINNER RECHECK → create → release in
    // `finally`. Same conditional-upsert lease (`domain/engagement/dedup-claim.ts`
    // shape, pgbouncer-safe: one autocommit statement, no advisory lock, no
    // connection held across the create), same loser behaviour, same TTL. The
    // ONLY difference is the key: the card's own name, because this population
    // has no asset identity to key on. See `createByNameLeaseKey` and
    // `findOpenCardByName` for the honest cost of that weaker key.
    //
    // ⛔ `card_drafts` IS NOT USED AND MUST NOT BE. Its idempotency index is
    // the obvious-looking home for this, and it protects nothing: the table is
    // EMPTY on prod (measured 2026-09-26, as is `card_contracts`), so nothing
    // on this path writes it and a unique index over zero rows cannot exclude
    // anything.
    //
    // ⚠️ WHY THIS IS STILL A WINDOW-REDUCER AND NOT EXACTLY-ONCE — the same
    // honest caveat `create-lease.ts` records for the asset arm. Planka has no
    // unique constraint on a card name, so a hard guarantee needs fr's own
    // table with a partial unique index. The measured failure is a
    // seconds-to-minutes window, which this closes.
    const { openListIds, blockedListIds } = partitionBoardLists(lists);
    const findOpenNamed = (): Promise<string | null> =>
      findOpenCardByName(planka, {
        boardId: stream.planka_board_id,
        name: trimmedTitle,
        openListIds,
        blockedListIds,
      });

    const existingNamed = await findOpenNamed();
    if (existingNamed) {
      return dedupeHit(existingNamed, 'name:open_card');
    }

    const nameLeaseKey = createByNameLeaseKey(
      stream.planka_board_id,
      trimmedTitle,
    );
    const nameOwner = crypto.randomUUID();
    const wonName = await claimCreateLease(tenantId, nameLeaseKey, nameOwner);

    if (!wonName) {
      // LOSER. Never creates. The card id comes from the OPEN-card read, never
      // from the lease — the lease deliberately stores no card id, so it can
      // never answer with a card that has since reached DONE.
      const marker = await waitForOpenCard(findOpenNamed);
      return marker
        ? dedupeHit(marker, 'name:lease_loser')
        : dedupeHit(null, 'name:lease_loser', { create_in_progress: true });
    }

    // WINNER RECHECK — load-bearing, exactly as in the asset arm. The pre-read
    // happened BEFORE the claim; a previous winner may have created its card
    // and released its lease in between, which is precisely WHY this claim
    // succeeded. Without this second read the winner mints a duplicate of the
    // card it is about to be told already exists.
    const afterNameClaim = await findOpenNamed();
    if (afterNameClaim) {
      await releaseCreateLeaseQuietly(tenantId, nameLeaseKey, nameOwner);
      return dedupeHit(afterNameClaim, 'name:winner_recheck');
    }

    heldLease = { key: nameLeaseKey, owner: nameOwner };
  }

  // 5. Mint the card. The helper handles description JSON, the 8-group
  //    PATCH, task-list generation, and orphan-card rollback if any
  //    PATCH fails. Card name = problem_statement (truncated) — the AA
  //    spec uses problem_statement as the human-readable card title.
  //
  //    #996 — the create runs inside `try { … } finally { release }`.
  //    `finally`, NOT `catch (e: Error)`: a rejection with a non-Error value
  //    (a bare string, an aborted signal's reason) must still release the
  //    lease, otherwise one bad throw suppresses every subsequent create for
  //    a full TTL. Mutants M6/M7. Release is quiet — the card already exists
  //    by then, so failing the request would invite the retry that mints the
  //    duplicate this lease exists to prevent.
  // `trimmedTitle` is hoisted above the dedup arms (step 3) so the name-keyed
  // lease guards the SAME string this mint writes. ⛔ Do not re-derive it here:
  // two spellings of the title is how a lease starts guarding a name no card is
  // ever created under, which reads as a working lease and suppresses nothing.
  let result: Awaited<ReturnType<typeof createImprovementCard>>;
  try {
    // 4. Build the per-group field bag. Context overrides body so the
    //    request can't contradict the resolved stream.
    //
    //    ⚠️ INSIDE the try ON PURPOSE. This used to sit between the lease
    //    claim and this block, so anything that threw here leaked the lease
    //    for a full TTL — suppressing every create for this (board, asset)
    //    for ~20 minutes. It cannot throw today (pure string building), which
    //    is exactly why the hazard was invisible and why no test caught it:
    //    the mutants inject throws from createCard, which is already covered.
    //    Keeping it here makes the safety structural rather than incidental.
    const fieldValues = valuesFromRequest({ ...parsed, priority: priorityText }, {
      stream_id: stream.id,
      stream_slug: stream.slug,
      asset_id: parsed.asset_id,
      asset_kind: parsed.asset_kind,
      card_group: cardGroup,
      keycloak_tenant_id: tenantId,
    });
    result = await createImprovementCard(planka, {
      stream: {
        id: stream.id,
        slug: stream.slug,
        planka_board_id: stream.planka_board_id,
        planka_list_id: targetList.id,
      },
      asset: {
        id: parsed.asset_id ?? '',
        kind: parsed.asset_kind ?? '',
      },
      // Carry the resolved tenant into the fenced description JSON so the n8n
      // DOING card-hydration reads the full subject without a manual PATCH.
      tenantId,
      card_type: parsed.card_type,
      cardName: trimmedTitle,
      cardBody: { type: 'project', position: 65536 },
      descriptionExtras: {
        trigger_reason: parsed.requestor,
        desired_outcome: parsed.desired_outcome,
        // Persist additional_context into the description JSON so downstream
        // workflows can read it back from the card (e.g. the post-contract
        // decomposition producer reads `additional_context.analysis_payload`
        // — the tier child_cards — at done-finalize). Dropped before WI-4 s2.
        ...(parsed.additional_context !== undefined
          ? { additional_context: parsed.additional_context }
          : {}),
      },
      field_values: fieldValues,
      // U11 — inside createImprovementCard's orphan-card rollback try: the pin
      // row first, then its pointer (B13's ordering), so a failed pointer
      // stamp deletes the card. ⛔ A row that already exists for the card
      // Planka has just minted is refused, never overwritten. The row itself
      // is insert-once (migration 148) and survives a rolled-back card.
      ...(planPin
        ? {
            afterCreate: async (cardId: string) => {
              const pin = planPin!;
              const inserted = await insertPlanPin({
                cardId,
                tenantId,
                plan: pin.plan,
                sha256: pin.sha256,
              });
              if (!inserted) {
                throw new Error(
                  `plan_pin: card_plan_pins already holds a row for new card ${cardId}; the pin is never rewritten`,
                );
              }
              // Read-only: a board whose RM template lacks the field skips the
              // pointer write with a warning (the pin row above still stands).
              const groups = await resolveBoardFieldGroups(planka, stream.planka_board_id);
              const field = boardField(groups, {
                boardId: stream.planka_board_id,
                cardId,
                group: 'Metadata',
                field: PLAN_PIN_METADATA_FIELD,
                context: 'cards.improvement.plan_pin',
              });
              if (!field) return;
              await planka.customFields.setCardCustomFieldValue({
                cardId,
                customFieldGroupId: field.groupId,
                customFieldId: field.fieldId,
                content: pin.pointer,
              });
            },
          }
        : {}),
    });
  } finally {
    if (heldLease) {
      await releaseCreateLeaseQuietly(
        tenantId,
        heldLease.key,
        heldLease.owner,
      );
    }
  }

  // 5b. A card minted STRAIGHT INTO BLOCKED is a BLOCKED transition like any
  //     other, and `request-schema.ts` lets `target_list` be 'BLOCKED'. Nothing
  //     on this path carries a reason, so without this the card lands with an
  //     empty `block_reason` — the exact population measured 2026-09-11 (19 of
  //     19 `workflow_statistics_analysis` cards). Best-effort: the card exists,
  //     and failing the 201 now would invite a retry that mints a second card.
  if (isBlocked(targetList.name ?? null)) {
    await stampBlockReasonQuietly(planka, {
      boardId: stream.planka_board_id,
      cardId: result.cardId,
      source: 'fr.cards.improvement.create',
    });
  }

  // 6. Record the subject asset's membership in this stream. Runs AFTER the
  //    mint so a membership row never outlives a card that failed to create.
  //    See recordStreamMembership's header for why this is non-fatal.
  const stream_membership = await recordStreamMembership(
    stream.id,
    parsed.asset_id,
    parsed.asset_kind,
    tenantId,
  );

  return jsonResponse(
    {
      card_id: result.cardId,
      stream_membership,
      // U11 — sha256 of the stored plan pin (= the Metadata.plan_pin pointer's
      // sha256). Null when `plan_pin` was omitted.
      plan_pin_sha256: planPin?.sha256 ?? null,
    },
    201,
  );
}
