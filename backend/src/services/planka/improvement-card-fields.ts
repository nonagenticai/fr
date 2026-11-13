// Wrapper over CustomFieldsResource that resolves the "Improvement Card
// Metadata" group + its 5 fields by name and PATCHes them onto a freshly-
// created card.
//
// Lookup is cached per (boardId, planka client identity) via a Map injected
// by the caller. Today's call sites construct one cache per handler
// invocation and look up exactly ONE board, so the cache doesn't actually
// save any HTTP calls — the indirection exists so future batch callers
// (e.g. bulk-create across many boards) can reuse a single cache across
// multiple boards within one operation. We don't use a process-wide cache
// because (a) Planka administrators can rename or re-provision groups, and
// (b) tests reset their stubs frequently.
//
// Failure mode: if the customFieldGroup or any of the 5 customFields is
// missing on the board, this throws an `IntegrationError` (the board's RM
// template lacks the router's fields; fr never creates them). Callers MUST
// surface that as a 500 to the API caller — silent skip would re-introduce
// the latent router-dispatch bug this code was added to fix.

import type { PlankaClient } from './index';
import { IntegrationError } from '../../integrations/_lib/errors';
import {
  IMPROVEMENT_CARD_FIELD_GROUP_NAME,
  IMPROVEMENT_CARD_FIELD_NAMES,
  type ImprovementCardFieldName,
} from './custom-fields';

export interface ResolvedImprovementFieldGroup {
  groupId: string;
  /** name → fieldId, populated for ALL 5 IMPROVEMENT_CARD_FIELD_NAMES */
  fieldIds: Record<ImprovementCardFieldName, string>;
}

export type BoardFieldGroupCache = Map<string, ResolvedImprovementFieldGroup>;

/**
 * Construct a fresh field-group cache. Scope: per-handler-invocation today
 * (single card-create touches one board, so the cache is effectively a
 * no-op); future batch callers can reuse the same cache across multiple
 * boards within one operation to amortize the getBoardCustomFields lookup.
 */
export function newBoardFieldGroupCache(): BoardFieldGroupCache {
  return new Map();
}

/**
 * Resolve (and cache) the improvement-card customFieldGroup + 5 fields for
 * a given board. Reads from the board's existing customFieldGroups +
 * customFields — does NOT auto-create (they come from the board's RM template).
 */
export async function resolveImprovementFieldGroup(
  planka: PlankaClient,
  boardId: string,
  cache: BoardFieldGroupCache,
): Promise<ResolvedImprovementFieldGroup> {
  const cached = cache.get(boardId);
  if (cached) return cached;

  const view = await planka.customFields.getBoardCustomFields(boardId);
  const group = view.customFieldGroups.find(
    (g) => g.name === IMPROVEMENT_CARD_FIELD_GROUP_NAME && g.boardId === boardId,
  );
  if (!group) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message:
        `Planka board ${boardId} is missing the "${IMPROVEMENT_CARD_FIELD_GROUP_NAME}" customFieldGroup ` +
        `required by the n8n workflow router; the board's RM board template must define it ` +
        `(fr never creates board fields).`,
      service: 'planka',
    });
  }

  const fieldByName = new Map(
    view.customFields
      .filter((f) => f.customFieldGroupId === group.id)
      .map((f) => [f.name, f]),
  );

  const fieldIds: Partial<Record<ImprovementCardFieldName, string>> = {};
  const missing: string[] = [];
  for (const name of IMPROVEMENT_CARD_FIELD_NAMES) {
    const f = fieldByName.get(name);
    if (!f) {
      missing.push(name);
    } else {
      fieldIds[name] = f.id;
    }
  }
  if (missing.length > 0) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message:
        `Planka board ${boardId} customFieldGroup "${IMPROVEMENT_CARD_FIELD_GROUP_NAME}" ` +
        `is missing required customField(s): ${missing.join(', ')}; the board's RM board template ` +
        `must define them (fr never creates board fields).`,
      service: 'planka',
    });
  }

  const resolved: ResolvedImprovementFieldGroup = {
    groupId: group.id,
    fieldIds: fieldIds as Record<ImprovementCardFieldName, string>,
  };
  cache.set(boardId, resolved);
  return resolved;
}

/**
 * PATCH the 5 customFieldValues onto a freshly-created card. Throws if the
 * group/fields aren't provisioned on the board (see resolveImprovementFieldGroup).
 *
 * Sequential rather than Promise.all() so a per-field error surfaces
 * cleanly with the offending name.
 */
export async function setImprovementCardFieldValues(
  planka: PlankaClient,
  input: {
    boardId: string;
    cardId: string;
    values: Record<ImprovementCardFieldName, string>;
  },
  cache: BoardFieldGroupCache,
): Promise<void> {
  const { groupId, fieldIds } = await resolveImprovementFieldGroup(
    planka,
    input.boardId,
    cache,
  );
  for (const name of IMPROVEMENT_CARD_FIELD_NAMES) {
    const fieldId = fieldIds[name];
    const content = input.values[name];
    await planka.customFields.setCardCustomFieldValue({
      cardId: input.cardId,
      customFieldGroupId: groupId,
      customFieldId: fieldId,
      content,
    });
  }
}
