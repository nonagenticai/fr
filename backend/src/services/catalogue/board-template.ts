// src/services/catalogue/board-template.ts
//
// THE PLANKA BOARD A PROJECT STARTS WITH = the tenant's requirements_management
// board template for the project type, falling back to the tenant's `default`
// template (RM rows, not code — design "fr consumes RM vocabulary"). Read
// through the one reader (tenant-catalogue.ts `boardTemplate`). Every importer
// that creates a board asks here with an EXPLICIT tenant: project create, the
// AG-UI agent project, the stream provisioner and the provisioning CLI.
//
// WHAT THE TEMPLATE DRIVES
//   * the board's LISTS (names, order, closed) — was intake.ts DEFAULT_LIST_NAMES;
//   * its LABELS;
//   * its custom-field GROUPS: the template's groups, in template order, each
//     with the template's fields.
//
// ⭐ THE RM TEMPLATE IS THE MASTER (George 2026-10-13, v4 ruling 12): the board
// gets EXACTLY the template's lists, labels and custom-field groups/fields —
// fr appends nothing (the code catalogue improvement-cards/field-groups.ts no
// longer feeds board creation; RM's default template carries every field fr
// and the n8n stage handlers write — `released`, and since RM 13a7c1d (#221)
// `source_artifact_id`/`source_item_id` (R188) and `wait_for_phase` (R190);
// `rework_count` is gone (R66)). List-name CLASSIFICATION (lib/phase.ts, lib/done-equivalent.ts,
// the target_list enums) stays in code, keyed by these list names.
//
// A tenant with neither a type template nor a `default` template is
// catalogue_not_initialised (409) — fr invents no board.

import { AppError } from '../../utils/errors';
import { CatalogueNotInitialised, boardTemplate, type CatalogueBoardTemplate } from './tenant-catalogue';

export interface BoardListSpec {
  name: string;
  closed: boolean;
}
export interface BoardLabelSpec {
  name: string;
  color: string;
}
export interface BoardFieldGroupSpec {
  name: string;
  fields: readonly string[];
  position: number;
}
export interface BoardSpec {
  /** The RM template's name (provenance). */
  template: string;
  lists: BoardListSpec[];
  labels: BoardLabelSpec[];
  fieldGroups: BoardFieldGroupSpec[];
}

/** Planka requires a label colour; an RM label with none gets this one. */
export const DEFAULT_LABEL_COLOR = 'muddy-grey';

export const BOARD_TEMPLATE_HAS_NO_LISTS = 'board_template_has_no_lists';

/**
 * The board's custom-field groups: EXACTLY the template's groups, in template
 * order, each with exactly the template's fields (v4 ruling 12 — fr adds
 * nothing). Planka positions are the template order, 65536 apart.
 */
export function boardFieldGroups(
  templateGroups: ReadonlyArray<{ name: string; fields?: readonly string[] }>,
): BoardFieldGroupSpec[] {
  return templateGroups.map((g, i) => ({
    name: g.name,
    fields: [...(g.fields ?? [])],
    position: (i + 1) * 65536,
  }));
}

/** The BoardSpec of one RM template row. Throws 409 when it defines no list. */
export function boardSpecFromTemplate(tpl: CatalogueBoardTemplate): BoardSpec {
  const lists = [...(tpl.lists ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((l) => ({ name: l.name, closed: l.closed ?? false }));
  if (lists.length === 0) {
    throw new AppError(
      409,
      `board template '${tpl.name}' defines no lists, so no board can be created from it`,
      { template: tpl.name },
    ).withCode(BOARD_TEMPLATE_HAS_NO_LISTS);
  }
  return {
    template: tpl.name,
    lists,
    labels: (tpl.labels ?? []).map((l) => ({ name: l.name, color: l.color ?? DEFAULT_LABEL_COLOR })),
    fieldGroups: boardFieldGroups(tpl.custom_field_groups ?? []),
  };
}

/**
 * The board spec for a new board of `projectType` (null = no type, e.g. a
 * stream board) in `tenantId`: the type's template, else the tenant's
 * `default`. 409 catalogue_not_initialised when neither exists.
 */
export async function boardSpecFor(tenantId: string, projectType: string | null | undefined): Promise<BoardSpec> {
  const tpl = await boardTemplate(tenantId, projectType ?? '');
  if (!tpl) throw new CatalogueNotInitialised(tenantId, ['board-templates']);
  return boardSpecFromTemplate(tpl);
}
