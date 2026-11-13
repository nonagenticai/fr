// Custom field group + custom field + custom field value helpers for Planka.
//
// Phase C (streams-removal Phase C — Task C1 expansion):
// fr-backend creates Planka cards for the workflow + prompt improvement
// streams. The n8n workflow router (`workflows/improvement/router.json`)
// reads stream/asset metadata from `card.custom_fields.<name>` — i.e. from
// Planka's NATIVE customFieldValues, NOT from the JSON description body.
// So fr-backend,
// after creating a card, PATCH those customFieldValues onto it (stream_id,
// stream_slug, card_type, asset_id, asset_kind — fields of the RM template's
// Metadata group).
//
// ⭐ v4 ruling 12: the RM board template is the master. Groups/fields are
// created ONLY when a board is built from the template
// (`provisionBoardFieldGroups`); card writers resolve what the board carries
// (`resolveBoardFieldGroups` / `boardField`) and skip — with a warning — any
// field it lacks. `setCardCustomFieldValue` is idempotent (Planka PATCH upserts).

import { encodePath, type PlankaHttp } from './http';
import type { components } from './openapi-types';
import type { Single } from './types';
import { PlankaError } from './errors';
import { AppError } from '../../utils/errors';
import type { PlankaClient } from './index';

export type CustomField = components['schemas']['CustomField'];
export type CustomFieldGroup = components['schemas']['CustomFieldGroup'];
export type Card = components['schemas']['Card'];
export type CustomFieldValue = components['schemas']['CustomFieldValue'];

export interface BoardFieldGroup {
  groupId: string;
  /** name → fieldId */
  fieldIds: Record<string, string>;
}

export interface BoardCustomFieldsView {
  customFieldGroups: CustomFieldGroup[];
  customFields: CustomField[];
  /**
   * Cards on the board (with their `listId`). Surfaced from the same
   * `GET /api/boards/:id` `included` bag so callers that need to scan the
   * board's cards (e.g. the improvement-card open-card dedup) don't pay a
   * second board read. Existing callers that only want groups/fields ignore
   * these fields.
   */
  cards: Card[];
  /** Native customFieldValues for every card on the board (`cardId`/`customFieldId`/`content`). */
  customFieldValues: CustomFieldValue[];
}

export class CustomFieldsResource {
  constructor(private readonly http: PlankaHttp) {}

  /**
   * Fetch the board's customFieldGroups + customFields via GET /api/boards/:id.
   * The board detail endpoint includes both bags in `included`.
   */
  async getBoardCustomFields(boardId: string): Promise<BoardCustomFieldsView> {
    const res = await this.http.request<{
      item: unknown;
      included?: {
        customFieldGroups?: CustomFieldGroup[];
        customFields?: CustomField[];
        cards?: Card[];
        customFieldValues?: CustomFieldValue[];
      };
    }>('GET', `/api/boards/${encodePath(boardId)}`, {});
    return {
      customFieldGroups: res.included?.customFieldGroups ?? [],
      customFields: res.included?.customFields ?? [],
      cards: res.included?.cards ?? [],
      customFieldValues: res.included?.customFieldValues ?? [],
    };
  }

  /**
   * Create a customFieldGroup directly on a board (not via base group).
   * POST /api/boards/:boardId/custom-field-groups
   */
  async createBoardGroup(input: {
    boardId: string;
    name: string;
    position?: number;
  }): Promise<CustomFieldGroup> {
    const res = await this.http.request<Single<CustomFieldGroup>>(
      'POST',
      `/api/boards/${encodePath(input.boardId)}/custom-field-groups`,
      {
        body: {
          name: input.name,
          position: input.position ?? 65536,
        },
      },
    );
    return res.item;
  }

  /**
   * Create a customField inside a customFieldGroup.
   * POST /api/custom-field-groups/:customFieldGroupId/custom-fields
   */
  async createFieldInGroup(input: {
    customFieldGroupId: string;
    name: string;
    position?: number;
    showOnFrontOfCard?: boolean;
  }): Promise<CustomField> {
    const res = await this.http.request<Single<CustomField>>(
      'POST',
      `/api/custom-field-groups/${encodePath(input.customFieldGroupId)}/custom-fields`,
      {
        body: {
          name: input.name,
          position: input.position ?? 65536,
          showOnFrontOfCard: input.showOnFrontOfCard ?? false,
        },
      },
    );
    return res.item;
  }

  /**
   * BOARD CREATION ONLY — create one RM-template customFieldGroup (and its
   * fields) on a board, reusing a group/field that already exists by name.
   * Called solely by `provisionBoardFieldGroups`, which the board-create paths
   * (planka/intake.ts, streams/repository.ts) feed with the tenant's RM board
   * template. ⛔ A card-write path never calls this: card writers read the
   * board (`resolveBoardFieldGroups`) and skip a field the board lacks
   * (v4 ruling 12 — the RM board template is the master; fr patches no board).
   */
  async provisionTemplateGroup(input: {
    boardId: string;
    groupName: string;
    fieldNames: readonly string[];
    position?: number;
    /** One board read shared by a batch of groups on the SAME board. */
    cache?: { view?: BoardCustomFieldsView };
  }): Promise<BoardFieldGroup> {
    const findGroup = (v: BoardCustomFieldsView) =>
      v.customFieldGroups.find(
        (g) => g.boardId === input.boardId && g.name === input.groupName,
      ) ?? null;
    const isFullyProvisioned = (v: BoardCustomFieldsView) => {
      const g = findGroup(v);
      if (!g) return false;
      const have = new Set(
        v.customFields
          .filter((f) => f.customFieldGroupId === g.id)
          .map((f) => f.name),
      );
      return input.fieldNames.every((n) => have.has(n));
    };

    const cached = input.cache?.view;
    let view = cached ?? (await this.getBoardCustomFields(input.boardId));
    if (cached && !isFullyProvisioned(view)) {
      // Never write on the strength of a shared read.
      view = await this.getBoardCustomFields(input.boardId);
    }
    if (input.cache) input.cache.view = view;

    let group = findGroup(view);
    if (!group) {
      group = await this.createBoardGroup({
        boardId: input.boardId,
        name: input.groupName,
        position: input.position,
      });
      if (input.cache) input.cache.view = undefined;
    }

    const groupId = group.id;
    const fields = view.customFields.filter((f) => f.customFieldGroupId === groupId);
    const haveByName = new Map(fields.map((f) => [f.name, f]));
    const missing = input.fieldNames.filter((n) => !haveByName.has(n));
    let position = (fields.reduce((m, f) => Math.max(m, f.position), 0) || 0) + 65536;
    for (const name of missing) {
      const created = await this.createFieldInGroup({ customFieldGroupId: groupId, name, position });
      haveByName.set(name, created);
      position += 65536;
    }
    if (missing.length > 0 && input.cache) input.cache.view = undefined;

    const fieldIds: Record<string, string> = {};
    for (const name of input.fieldNames) {
      const f = haveByName.get(name);
      if (!f) {
        throw new Error(
          `provisionTemplateGroup: failed to provision field "${name}" in group "${input.groupName}" on board ${input.boardId}`,
        );
      }
      fieldIds[name] = f.id;
    }
    return { groupId, fieldIds };
  }

  /**
   * PATCH a customFieldGroup's metadata (rename, reposition).
   * PATCH /api/custom-field-groups/:id
   *
   * Used by the AA Card Substrate Phase 3 migration script to rename the
   * legacy `Improvement Card Metadata` group → `Metadata` on already-
   * provisioned boards (and to set its canonical position 65536).
   */
  async updateGroup(input: {
    id: string;
    name?: string;
    position?: number;
  }): Promise<CustomFieldGroup> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.position !== undefined) body.position = input.position;
    const res = await this.http.request<Single<CustomFieldGroup>>(
      'PATCH',
      `/api/custom-field-groups/${encodePath(input.id)}`,
      { body },
    );
    return res.item;
  }

  /**
   * PATCH a single customFieldValue onto a card.
   * PATCH /api/cards/:cardId/custom-field-values/customFieldGroupId:{groupId}:customFieldId:{fieldId}
   *
   * Upsert semantics — missing values are created, existing values are updated.
   * Over Planka's 512-char cap: throws CustomFieldContentTooLongError (422)
   * before any request, unless `truncateHumanText` (fr#1494).
   */
  async setCardCustomFieldValue(input: {
    cardId: string;
    customFieldGroupId: string;
    customFieldId: string;
    content: string;
    /** fr#1494: opt a HUMAN-TEXT field into truncation; default refuses (see boundCustomFieldContent). */
    truncateHumanText?: boolean;
  }): Promise<void> {
    // Note: the static fragments `customFieldGroupId:` and `customFieldId:`
    // are part of Planka's URL grammar, not encoded values.
    const path =
      `/api/cards/${encodePath(input.cardId)}/custom-field-values/` +
      `customFieldGroupId:${encodePath(input.customFieldGroupId)}:` +
      `customFieldId:${encodePath(input.customFieldId)}`;
    await this.http.request(
      'PATCH',
      path,
      { body: { content: boundCustomFieldContent(input) } },
    );
  }

  /**
   * DELETE a single customFieldValue from a card, so the field reads as
   * ABSENT (not as an empty string).
   * DELETE /api/cards/:cardId/custom-field-values/customFieldGroupId:{groupId}:customFieldId:{fieldId}
   *
   * ⚠️ PLURAL, same as the PATCH upsert. Planka's routes.js mounts the delete
   * on `custom-field-values`; only its swagger comment (and so
   * docs/planka-openapi.json / openapi-types.ts) says singular
   * `custom-field-value`. The singular path is a router miss: 404
   * `{"code":"E_NOT_FOUND"}` with NO message, measured on stock 2.2.1 and the
   * planka-private fork. Treating that 404 as "already cleared" made every
   * clear a silent no-op.
   *
   * Idempotent ONLY for Planka's own "Custom field value not found" 404 (the
   * value genuinely isn't stored). Every other 404 — route miss, card not
   * found, group not found — is surfaced.
   */
  async clearCardCustomFieldValue(input: {
    cardId: string;
    customFieldGroupId: string;
    customFieldId: string;
  }): Promise<void> {
    const path =
      `/api/cards/${encodePath(input.cardId)}/custom-field-values/` +
      `customFieldGroupId:${encodePath(input.customFieldGroupId)}:` +
      `customFieldId:${encodePath(input.customFieldId)}`;
    try {
      await this.http.request('DELETE', path, {});
    } catch (err) {
      if (isCustomFieldValueNotFound(err)) return;
      throw err;
    }
  }
}

/** Planka's `customFieldValueNotFound` error message (custom-field-values/delete.js). */
export const PLANKA_CUSTOM_FIELD_VALUE_NOT_FOUND_MESSAGE = 'Custom field value not found';

/**
 * True only for the 404 Planka's delete controller raises when the card/group
 * exist but no value is stored. A router-miss 404 carries no message and a
 * missing card/group carries a different one — those are NOT "already cleared".
 */
export function isCustomFieldValueNotFound(err: unknown): boolean {
  if (!(err instanceof PlankaError) || err.status !== 404) return false;
  const body = err.body;
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { message?: unknown }).message === PLANKA_CUSTOM_FIELD_VALUE_NOT_FOUND_MESSAGE
  );
}

/**
 * Planka's hard cap on a customFieldValue.
 *
 * `server/api/controllers/custom-field-values/create-or-update.js` declares
 * `content: { type: 'string', maxLength: 512, required: true }`. Confirmed
 * against the live endpoint rather than inferred (issue #904): 513 chars ->
 * `HTTP 400 Invalid "content": Value was -1 characters longer than the
 * configured maximum length (512)`; the same request at 512 -> HTTP 200.
 */
export const PLANKA_CUSTOM_FIELD_MAX_CHARS = 512;

const TRUNCATION_MARKER = '… [truncated]';

/** The `code` of {@link CustomFieldContentTooLongError}. */
export const CUSTOM_FIELD_CONTENT_TOO_LONG = 'planka_custom_field_too_long';

/**
 * fr#1494: a custom-field value over Planka's 512-char cap, on a field that is
 * NOT an opted-in human-text field. Refused (422) before the PATCH: a value cut
 * to fit looks structurally present and is wrong — for a JSON-valued or
 * machine-read field it is unparseable — so the caller must see the refusal.
 */
export class CustomFieldContentTooLongError extends AppError {
  constructor(
    public readonly cardId: string,
    public readonly customFieldId: string,
    public readonly attemptedChars: number,
  ) {
    super(
      422,
      `Custom field value for card ${cardId} (field ${customFieldId}) is ${attemptedChars} chars; ` +
        `Planka's cap is ${PLANKA_CUSTOM_FIELD_MAX_CHARS}. Refused rather than truncated.`,
      { cardId, customFieldId, attemptedChars, maxChars: PLANKA_CUSTOM_FIELD_MAX_CHARS },
    );
    this.name = 'CustomFieldContentTooLongError';
    this.withCode(CUSTOM_FIELD_CONTENT_TOO_LONG);
  }
}

/**
 * Bound a custom-field value to Planka's 512-char cap.
 *
 * DEFAULT: REFUSE (fr#1494). Over the cap ⇒ `CustomFieldContentTooLongError`.
 * A truncated value looks complete and is not; for JSON-valued / machine-read
 * fields (`*_ref`, relation lists, grid handover state) it is corrupt data,
 * not a refusal.
 *
 * OPT-IN TRUNCATION, human-text fields only (`truncateHumanText: true`): the
 * `criterion_*` acceptance criteria and `block_reason`. There one over-long
 * value would 400 the whole write and leave the card with NO metadata, so the
 * tail is cut, a visible `… [truncated]` marker is appended and a
 * `planka_custom_field_truncated` telemetry line names the field and sizes.
 *
 * ⚠️ Cuts on a code POINT boundary. `maxLength` counts JS string length (UTF-16
 * code units), so a naive slice can sever a surrogate pair and write half an
 * emoji — a mojibake bug that only shows up on non-BMP input.
 */
export function boundCustomFieldContent(input: {
  cardId: string;
  customFieldId: string;
  content: string;
  truncateHumanText?: boolean;
}): string {
  const { content } = input;
  if (content.length <= PLANKA_CUSTOM_FIELD_MAX_CHARS) return content;
  if (input.truncateHumanText !== true) {
    throw new CustomFieldContentTooLongError(input.cardId, input.customFieldId, content.length);
  }

  const budget = PLANKA_CUSTOM_FIELD_MAX_CHARS - TRUNCATION_MARKER.length;
  let kept = content.slice(0, budget);
  // Do not end on a lone high surrogate.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);

  console.error(
    JSON.stringify({
      telemetry: 'planka_custom_field_truncated',
      card_id: input.cardId,
      custom_field_id: input.customFieldId,
      original_chars: content.length,
      written_chars: kept.length + TRUNCATION_MARKER.length,
      max_chars: PLANKA_CUSTOM_FIELD_MAX_CHARS,
    }),
  );

  return kept + TRUNCATION_MARKER;
}

/**
 * The customFieldGroup name (RM board template) read by the after-create
 * PATCH path.
 *
 * AA Card Substrate Phase 3 (2026-05-05) — renamed from `Improvement Card
 * Metadata` to `Metadata` to match the AA-spec category ordering.
 */
export const IMPROVEMENT_CARD_FIELD_GROUP_NAME = 'Metadata';

/**
 * The 5 minimum customField names the n8n workflow router (and consumers
 * like todo_pickup, blocked_handler) read via `curr.custom_fields.<name>`.
 * Order is the on-board display order; do not reorder casually.
 */
export const IMPROVEMENT_CARD_FIELD_NAMES = [
  'stream_id',
  'stream_slug',
  'card_type',
  'asset_id',
  'asset_kind',
] as const;

export type ImprovementCardFieldName =
  (typeof IMPROVEMENT_CARD_FIELD_NAMES)[number];

/**
 * READ-ONLY: every customFieldGroup on the board, by name, with its fields
 * (name → fieldId). ONE `GET /api/boards/:id`; never creates anything.
 *
 * ⭐ v4 ruling 12 (George 2026-10-13): the RM board template is the master. A
 * board's groups and fields are exactly what the template created at board
 * creation; fr's card writers READ and WRITE values on those fields only. A
 * field fr would write that the board does not carry is SKIPPED with a logged
 * warning (`boardField`), never created — fr patches no board schema.
 *
 * A group name that appears twice on a board resolves to the first one Planka
 * returns (positions are template order, so that is the template's).
 */
export async function resolveBoardFieldGroups(
  planka: PlankaClient,
  boardId: string,
): Promise<Record<string, BoardFieldGroup>> {
  const view = await planka.customFields.getBoardCustomFields(boardId);
  return boardFieldGroupsFromView(view, boardId);
}

/** The pure half of `resolveBoardFieldGroups`, for callers that already hold the board view. */
export function boardFieldGroupsFromView(
  view: Pick<BoardCustomFieldsView, 'customFieldGroups' | 'customFields'>,
  boardId: string,
): Record<string, BoardFieldGroup> {
  const out: Record<string, BoardFieldGroup> = {};
  for (const g of view.customFieldGroups) {
    // Board-level groups only (a card-scoped group has boardId null).
    if (g.boardId !== boardId || !g.name) continue;
    if (out[g.name]) continue;
    const fieldIds: Record<string, string> = {};
    for (const f of view.customFields) {
      if (f.customFieldGroupId === g.id && !(f.name in fieldIds)) fieldIds[f.name] = f.id;
    }
    out[g.name] = { groupId: g.id, fieldIds };
  }
  return out;
}

/** The telemetry tag of a card write skipped because the board lacks the field. */
export const BOARD_FIELD_MISSING_TELEMETRY = 'board_custom_field_missing';

/** Log one skipped card write: the board (built from the RM template) has no `group`.`field`. */
export function warnBoardFieldMissing(input: {
  boardId: string;
  group: string;
  field: string;
  context: string;
  cardId?: string;
}): void {
  console.warn(
    JSON.stringify({
      telemetry: BOARD_FIELD_MISSING_TELEMETRY,
      board_id: input.boardId,
      card_id: input.cardId ?? null,
      group: input.group,
      field: input.field,
      context: input.context,
      note: 'write skipped; fr never creates board fields (the RM board template is the master)',
    }),
  );
}

/**
 * Resolve `group`.`field` on a board's resolved groups. Absent ⇒ `null` plus a
 * `board_custom_field_missing` warning — the caller SKIPS the write.
 */
export function boardField(
  groups: Record<string, BoardFieldGroup>,
  input: { boardId: string; group: string; field: string; context: string; cardId?: string },
): { groupId: string; fieldId: string } | null {
  const g = groups[input.group];
  const fieldId = g?.fieldIds[input.field];
  if (!g || !fieldId) {
    warnBoardFieldMissing(input);
    return null;
  }
  return { groupId: g.groupId, fieldId };
}

/**
 * BOARD CREATION ONLY: create the RM board template's custom-field groups (and
 * their fields) on a board fr just built from that template (planka/intake.ts
 * `createProjectWithDefaultBoard`, streams/repository.ts `createStream`).
 * `groups` is REQUIRED — it is `BoardSpec.fieldGroups` from
 * services/catalogue/board-template.ts, exactly the template's (ruling 12).
 * ⛔ Never called from a card-write path (tests/unit/services/planka/
 * no-board-schema-writes.test.ts pins the callers).
 */
export async function provisionBoardFieldGroups(
  planka: PlankaClient,
  boardId: string,
  groups: ReadonlyArray<{ name: string; fields: readonly string[]; position: number }>,
): Promise<Record<string, BoardFieldGroup>> {
  const cache: { view?: BoardCustomFieldsView } = {};
  const result: Record<string, BoardFieldGroup> = {};
  for (const g of groups) {
    result[g.name] = await planka.customFields.provisionTemplateGroup({
      boardId,
      groupName: g.name,
      fieldNames: g.fields,
      position: g.position,
      cache,
    });
  }
  return result;
}
