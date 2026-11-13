// src/services/improvement-cards/card-priority.ts
//
// The ONE writer of a card's `Metadata.priority` slot. Shared by the create
// door (POST /api/cards/project, routes/cards/project.ts) and the
// edit door (PATCH /api/projects/:projectId/cards/:cardId/priority,
// routes/cards/priority.ts) so the two cannot drift on which group/field the
// value lands in.

import { warnBoardFieldMissing, type BoardFieldGroup } from '../planka/custom-fields';
import type { PlankaClient } from '../planka';
/**
 * The TEXT written to `Metadata.priority`: the level's legacy text
 * (services/catalogue/priority-levels.ts legacyPriorityText). Planka's field is
 * the board template's, read by n8n's TODO pickup.
 */
export type CardPriority = string;

/** The customField name inside the `Metadata` group (field-groups.ts). */
export const CARD_PRIORITY_FIELD = 'priority';

/** Where a write happens — for the `board_custom_field_missing` warning. */
export interface CardFieldWriteSite {
  boardId: string;
  context: string;
}

/**
 * Write (`priority` set) or clear (`null`) `Metadata.priority` on `cardId`.
 * `metadata` is the board's resolved `Metadata` group (read-only). A board
 * whose RM template lacks the field: the write is SKIPPED with a
 * `board_custom_field_missing` warning — fr never creates the field (v4
 * ruling 12). Returns whether it wrote.
 */
export async function writeCardPriority(
  planka: Pick<PlankaClient, 'customFields'>,
  cardId: string,
  metadata: BoardFieldGroup,
  priority: CardPriority | null,
  site: CardFieldWriteSite,
): Promise<boolean> {
  const fieldId = metadata.fieldIds[CARD_PRIORITY_FIELD];
  if (!fieldId) {
    warnBoardFieldMissing({ ...site, cardId, group: 'Metadata', field: CARD_PRIORITY_FIELD });
    return false;
  }
  if (priority === null) {
    await planka.customFields.clearCardCustomFieldValue({
      cardId,
      customFieldGroupId: metadata.groupId,
      customFieldId: fieldId,
    });
    return true;
  }
  await planka.customFields.setCardCustomFieldValue({
    cardId,
    customFieldGroupId: metadata.groupId,
    customFieldId: fieldId,
    content: priority,
  });
  return true;
}

/** Runtime State field names of the server-stamped provenance (field-groups.ts). */
export const CARD_PRIORITY_SET_BY_FIELD = 'priority_set_by';
export const CARD_PRIORITY_BASE_FIELD = 'priority_base';

async function writeOrClear(
  planka: Pick<PlankaClient, 'customFields'>,
  cardId: string,
  group: BoardFieldGroup,
  field: string,
  content: string | null,
  site: CardFieldWriteSite,
): Promise<void> {
  const fieldId = group.fieldIds[field];
  if (!fieldId) {
    warnBoardFieldMissing({ ...site, cardId, group: 'Runtime State', field });
    return;
  }
  if (content === null) {
    await planka.customFields.clearCardCustomFieldValue({
      cardId,
      customFieldGroupId: group.groupId,
      customFieldId: fieldId,
    });
    return;
  }
  await planka.customFields.setCardCustomFieldValue({
    cardId,
    customFieldGroupId: group.groupId,
    customFieldId: fieldId,
    content,
  });
}

/**
 * Write the server-stamped provenance into the board's ensured `Runtime State`
 * group: `priority_set_by` (`null` clears) then `priority_base` (`null` clears).
 * Only routes/cards/priority.ts calls this, with values it derived itself —
 * never with caller-supplied ones. A field the board lacks is skipped with a
 * warning (never created).
 */
export async function writeCardPriorityProvenance(
  planka: Pick<PlankaClient, 'customFields'>,
  cardId: string,
  runtimeState: BoardFieldGroup,
  provenance: { setBy: string | null; base: string | null },
  site: CardFieldWriteSite,
): Promise<void> {
  await writeOrClear(planka, cardId, runtimeState, CARD_PRIORITY_SET_BY_FIELD, provenance.setBy, site);
  await writeOrClear(planka, cardId, runtimeState, CARD_PRIORITY_BASE_FIELD, provenance.base, site);
}
