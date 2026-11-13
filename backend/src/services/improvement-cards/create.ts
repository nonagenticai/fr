// src/services/improvement-cards/create.ts
//
// Single source of truth for minting an improvement card. Today's two
// callers (POST /api/assets/:assetKind/:assetId/improvement-card and
// streams.open_improvement_card AG-UI action) duplicate the same
// description-JSON build + customFieldValues PATCH + orphan-delete
// rollback. This helper consolidates that flow without changing wire
// behavior on either side.
//
// Why a `createCard` callback instead of calling planka.cards.create
// directly: the two existing sites use *different* card-create paths.
// The HTTP-route site uses `agent.cards.create()` (the agent-token
// PlankaClient) because the per-stream board was provisioned by the
// agent and the user may not be a member yet. The AG-UI action goes
// through the kanban integration's `createCard()`, which posts via the
// httpJson client used elsewhere by AG-UI actions. Both paths must be
// preserved bit-for-bit (same body, same client identity); the helper
// abstracts only the description-JSON build and the customFieldValues
// PATCH+rollback that are identical between them.
//
// Failure-mode contract (matches existing call-site behavior):
//   - if the customFieldGroup isn't provisioned on the board, the
//     PATCH throws and we delete the just-created kanban card so we
//     don't leak an undispatchable card. The original error is
//     re-thrown.
//   - orphan-delete failures are swallowed (logged by the caller's
//     surrounding try/catch where applicable); the original PATCH
//     error always wins so the operator sees the actionable message.
//   - empty stream.slug fails LOUD before any kanban write — Migration
//     050 made slugs NOT NULL, an empty slug here means the stream row
//     was persisted incorrectly and we refuse to mint inconsistent
//     cards.

import type { PlankaClient } from '../planka';
import {
  newBoardFieldGroupCache,
  setImprovementCardFieldValues,
} from '../planka/improvement-card-fields';
import {
  resolveBoardFieldGroups,
  warnBoardFieldMissing,
  type BoardFieldGroup,
} from '../planka/custom-fields';
import { IntegrationError } from '../../integrations/_lib/errors';
import type { GroupFieldValues } from './from-request';

export interface CreateImprovementCardInput {
  /** Stream metadata; planka_list_id is the TODO list resolved by the caller. */
  stream: {
    id: string;
    slug: string;
    planka_board_id: string;
    planka_list_id: string;
  };
  asset: { id: string; kind: string };
  /**
   * Writable/authoritative tenant id for the improvement subject. Emitted into
   * the fenced description JSON as `tenant_id` so the n8n DOING card-hydration
   * carries the full subject (asset_id, asset_kind, tenant_id, desired_outcome)
   * without a manual card PATCH. Optional + backward-safe: non-asset call sites
   * omit it and the field serializes as null.
   */
  tenantId?: string;
  /** card_type derived from CARD_TYPE_BY_KIND[stream.kind] by the caller. */
  card_type: string;
  /** Pre-formatted card name (e.g. "workflow asset-1 — needs improvement (manual trigger)"). */
  cardName: string;
  /**
   * Caller-controlled fields merged into the card-create body alongside
   * the helper-built name+description. Today's call sites pass either
   * `{ position: 65536 }` (HTTP route, no type) or
   * `{ type: 'story', position: 65536 }` (AG-UI action).
   */
  cardBody: Record<string, unknown>;
  /**
   * Extra fields merged into the description JSON. Both sites pass
   * `trigger_reason: 'manual'`; the AG-UI action additionally passes
   * `slot_id` so the description carries the metering slot identifier.
   * `asset_version` and `trigger_metric` are always emitted as null
   * to match existing wire shape.
   */
  descriptionExtras: Record<string, unknown>;
  /**
   * Caller-supplied card-create function. Optional — when omitted the
   * helper falls back to `planka.cards.create({ listId, ...body })`,
   * which is what the Phase 6 route uses. The two existing call sites
   * (handleManualImprovementCard, streams.open_improvement_card) keep
   * passing their own (kanban-integration / agent-token) override so
   * their card-create wire shape and client identity are preserved
   * bit-for-bit.
   */
  createCard?: (
    listId: string,
    body: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  /**
   * AA Card Substrate Phase 6 — when provided, write all 8 AA-spec
   * customFieldGroup values onto the card after creation. Each group's
   * map is `{ fieldName: contentString }`; every present field is PATCHed
   * (including empty strings — we want `''` to mean "configured but
   * blank" rather than "missing key").
   *
   * When ABSENT, the helper falls back to the Phase 3 5-field write
   * (stream_id / stream_slug / card_type / asset_id / asset_kind on
   * the Metadata group) so existing call sites keep working without
   * any code change.
   */
  field_values?: GroupFieldValues;
  /**
   * Phase 4a — manual-trigger scoring flag. When true, writes the literal
   * string `'true'` to the `manual_trigger` Metadata field so that
   * todo_pickup.json's priority sort (cf.manual_trigger ? 1 : 0) scores
   * manually-triggered cards above auto-detected ones at the same severity.
   *
   * Only used in the Phase 3 fallback path (manual call sites that don't
   * supply field_values). When field_values is present, the caller is
   * responsible for setting Metadata.manual_trigger via valuesFromRequest.
   */
  manual_trigger?: boolean;
  /**
   * U11 — runs INSIDE the orphan-card rollback try, after every field write and
   * before the task lists, with the new card id. A throw deletes the card and
   * re-throws, exactly like a failed field PATCH. POST /api/cards/improvement
   * uses it to insert the `card_plan_pins` row and then stamp the
   * `Metadata.plan_pin` pointer (row first, B13's ordering). Absent ⇒ unchanged.
   */
  afterCreate?: (cardId: string) => Promise<void>;
}

export interface CreateImprovementCardResult {
  cardId: string;
}

/**
 * Build description JSON, create the card via the caller's createCard
 * function, then PATCH the 5 customFieldValues required by the n8n
 * workflow router. On PATCH failure, delete the orphan card and
 * re-throw the original error.
 */
export async function createImprovementCard(
  planka: PlankaClient,
  input: CreateImprovementCardInput,
): Promise<CreateImprovementCardResult> {
  // C1 (streams-removal Phase C): cards must carry BOTH stream_id and
  // stream_slug. Migration 050 made `streams.slug` NOT NULL — an empty
  // slug here means the row was never persisted correctly; fail loud
  // BEFORE the kanban write so we don't mint an inconsistent card.
  if (!input.stream.slug) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `Stream ${input.stream.id} is missing a slug; refusing to create card with inconsistent custom_fields`,
      service: 'fr-streams',
    });
  }

  // The description JSON is the human-readable subject record (visible in the
  // Planka UI) AND the n8n DOING card-hydration source for asset self-improvement
  // cards. Two deliberate choices vs. the old raw single-line stringify:
  //   1. tenant_id is included — it was in NEITHER the description nor the
  //      Metadata customFields before, so the DOING hydration subject
  //      (asset_id, asset_kind, tenant_id, desired_outcome) was incomplete and
  //      an operator had to hand-PATCH a fenced block. Now it's carried natively.
  //   2. The object is wrapped in a ```json fence (mirrors the intake-card
  //      description in routes/projects.ts) so the n8n hydration parser extracts
  //      the subject robustly even if prose is ever prepended, and the Planka UI
  //      renders it as a code block. The parser also still accepts raw {…}, so
  //      this is backward-compatible for any existing consumer.
  const description =
    '```json\n' +
    JSON.stringify(
      {
        stream_id: input.stream.id,
        stream_slug: input.stream.slug,
        asset_id: input.asset.id,
        asset_kind: input.asset.kind,
        asset_version: null,
        trigger_metric: null,
        tenant_id: input.tenantId ?? null,
        ...input.descriptionExtras,
      },
      null,
      2,
    ) +
    '\n```';

  // Default createCard: simple agent-token planka.cards.create — used by
  // the Phase 6 POST /api/cards/improvement route. Existing call sites
  // (manual-trigger HTTP route, AG-UI streams.open_improvement_card)
  // keep passing their own override so their wire shape + client
  // identity stay bit-for-bit identical.
  const createCardFn =
    input.createCard ??
    (async (listId: string, body: Record<string, unknown>) => {
      const card = await planka.cards.create({
        listId,
        ...body,
      } as Parameters<typeof planka.cards.create>[0]);
      return { id: card.id };
    });

  const created = await createCardFn(input.stream.planka_list_id, {
    ...input.cardBody,
    name: input.cardName,
    description,
  });
  const cardId = created.id;
  if (!cardId) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: 'Planka cards.create response missing card id',
      service: 'planka',
    });
  }

  // C1-expansion (streams-removal Phase C): description JSON above is
  // the human-readable record (visible in the Planka UI); the n8n
  // workflow router actually reads from native customFieldValues
  // (`curr.custom_fields.<name>`). PATCH the 5 minimum fields the
  // router needs to dispatch this card. Defense in depth — both
  // substrates carry the same metadata.
  //
  // resolveImprovementFieldGroup throws fail-loud if the board lacks the
  // router's 5 Metadata fields (its RM template is broken); rollback below
  // deletes the orphan card and re-throws.
  try {
    if (input.field_values) {
      // AA Card Substrate Phase 6 — caller submitted a fully-qualified
      // request mapped through valuesFromRequest(); write all 8 groups onto
      // the card, on the fields the board carries (READ-ONLY: a field the RM
      // template did not create is skipped with a warning — v4 ruling 12).
      const groups = await resolveBoardFieldGroups(
        planka,
        input.stream.planka_board_id,
      );
      await writeAllGroupValues(planka, cardId, input.stream.planka_board_id, groups, input.field_values);
    } else {
      // Phase 3 fallback — the Phase 1 5-field write path used by the
      // existing manual-trigger / AG-UI call sites that don't (yet)
      // construct a CardGenerationRequest.
      const fieldCache = newBoardFieldGroupCache();
      await setImprovementCardFieldValues(
        planka,
        {
          boardId: input.stream.planka_board_id,
          cardId,
          values: {
            stream_id: input.stream.id,
            stream_slug: input.stream.slug,
            card_type: input.card_type,
            asset_id: input.asset.id,
            asset_kind: input.asset.kind,
          },
        },
        fieldCache,
      );
      // Phase 4a — write manual_trigger after the 5 base fields if the
      // field is provisioned on the board. Uses the same board GET that
      // resolveImprovementFieldGroup already made (fieldCache now has the
      // resolved Metadata group). Skips silently on un-provisioned boards
      // (forward-compat; same policy as writeAllGroupValues field skips).
      if (input.manual_trigger !== undefined) {
        const boardView = await planka.customFields.getBoardCustomFields(
          input.stream.planka_board_id,
        );
        const metaGroup = boardView.customFieldGroups.find(
          (g) => g.name === 'Metadata',
        );
        if (metaGroup) {
          const manualTriggerField = boardView.customFields.find(
            (f) =>
              f.customFieldGroupId === metaGroup.id &&
              f.name === 'manual_trigger',
          );
          if (manualTriggerField) {
            await planka.customFields.setCardCustomFieldValue({
              cardId,
              customFieldGroupId: metaGroup.id,
              customFieldId: manualTriggerField.id,
              content: input.manual_trigger ? 'true' : '',
            });
          }
        }
      }
    }

    if (input.afterCreate) {
      await input.afterCreate(cardId);
    }

    // (Planka task-lists used to be derived here from the vendored roster's
    // per-phase protocol arrays. The card-type vocabulary is now the tenant's
    // RM catalogue, which models no per-phase protocol, so a card is created
    // with no task lists — design: fr consumes RM vocabulary.)
  } catch (err) {
    // Roll back the just-created card so we don't leak a card that the
    // workflow router can't dispatch. Swallow the delete-failure path
    // (logged) so the original PATCH error always wins — that's the
    // operator-actionable signal.
    try {
      await planka.cards.delete(cardId);
    } catch (delErr) {
      console.error(
        '[createImprovementCard] orphan kanban card delete failed (post-customFieldValues)',
        delErr,
      );
    }
    throw err;
  }

  return { cardId };
}

/**
 * Phase 6 helper — PATCH every field listed in `values` into its group on the
 * board. Sequential rather than Promise.all() so a failed PATCH surfaces with
 * the offending (group, field) name and the caller can run the orphan-card
 * delete cleanly. Empty-string values are SKIPPED (not PATCHed) — Planka
 * rejects `''` for required fields (see commit 21ac398).
 *
 * A group or field the board does not carry (its RM template did not create
 * it) is SKIPPED with a `board_custom_field_missing` warning — never created
 * (v4 ruling 12: the RM board template is the master).
 */
async function writeAllGroupValues(
  planka: PlankaClient,
  cardId: string,
  boardId: string,
  groups: Record<string, BoardFieldGroup>,
  values: GroupFieldValues,
): Promise<void> {
  for (const [groupName, fieldMap] of Object.entries(values) as Array<
    [keyof GroupFieldValues, Record<string, string>]
  >) {
    const group = groups[groupName];
    for (const [fieldName, content] of Object.entries(fieldMap)) {
      if (content === '') continue; // skip empty strings — Planka rejects them for required fields
      const fieldId = group?.fieldIds[fieldName];
      if (!group || !fieldId) {
        warnBoardFieldMissing({ boardId, cardId, group: groupName, field: fieldName, context: 'improvement-cards.create' });
        continue;
      }
      await planka.customFields.setCardCustomFieldValue({
        cardId,
        customFieldGroupId: group.groupId,
        customFieldId: fieldId,
        content,
        // fr#1494: only the human-text `criterion_*` slots are truncated with a
        // marker; every other field refuses an over-long value (422).
        truncateHumanText: groupName === 'Acceptance Criteria',
      });
    }
  }
}
