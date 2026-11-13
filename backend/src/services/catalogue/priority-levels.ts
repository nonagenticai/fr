// src/services/catalogue/priority-levels.ts
//
// PRIORITY = the tenant's requirements_management priority levels (design "fr
// consumes RM vocabulary", George's Q3 = (b): STORE THE RM priority-level id).
// fr holds no P0..P3 list: every door resolves the caller's value against the
// tenant whose project/card it is, through the one reader
// (tenant-catalogue.ts `priorities`, ordered by RM rank; 409
// catalogue_not_initialised when the tenant has none).
//
// INPUT. A door accepts the level's id OR its name, case-insensitively (`P1`,
// `p1`) — the conveyor and the UI kept sending `P0..P3` while the ids were
// introduced. Anything else is 400 `invalid_priority` naming the tenant's levels.
//
// STORAGE. The id is the value of record (`priority_level_id`). The legacy TEXT
// (`priority`, `from_priority`/`to_priority`, Planka `Metadata.priority`) is
// still written — `legacyPriorityText` — for the BACKFILL WINDOW ONLY (design:
// "the legacy column is dropped in a follow-up migration once the backfill is
// measured at 100% for every tenant that has rows"). ⚠️ FOLLOW-UP: drop the
// legacy text writes together with the columns, after
// scripts/backfill-priority-level-ids.ts reports 0 unmapped for every tenant.
// Planka's `Metadata.priority` stays text (it is the board template's field,
// which n8n's TODO pickup sorts by).
//
// RULE. "The conveyor may never set P0" is now "may never set the RANK-0
// (highest) level" — the level with the tenant's lowest rank.

import { BadRequestError, ForbiddenError } from '../../utils/errors';
import { isConveyorActor } from '../../lib/conveyor-identity';
import type { User } from '../../types/api';
import { priorities, type CataloguePriority } from './tenant-catalogue';

export type { CataloguePriority } from './tenant-catalogue';

/** Stable machine-readable code for a priority outside the tenant's levels. */
export const INVALID_PRIORITY = 'invalid_priority';
export const CONVEYOR_TOP_PRIORITY_FORBIDDEN = 'conveyor_p0_forbidden';

/** The level `raw` names (id, or name case-insensitively), or null. */
export function findPriorityLevel(
  levels: readonly CataloguePriority[],
  raw: string,
): CataloguePriority | null {
  const v = raw.trim();
  if (v === '') return null;
  return (
    levels.find((l) => l.id === v) ??
    levels.find((l) => l.name.toLowerCase() === v.toLowerCase()) ??
    null
  );
}

/** Resolve a body value to one of `levels` — 400 `invalid_priority` (with the allowed names) otherwise. */
export function resolvePriorityLevel(levels: readonly CataloguePriority[], raw: unknown): CataloguePriority {
  const hit = typeof raw === 'string' ? findPriorityLevel(levels, raw) : null;
  if (hit) return hit;
  throw new BadRequestError(
    `priority must be one of ${levels.map((l) => legacyPriorityText(l)).join(', ')} (or a priority level id)`,
    { field: 'priority', allowed: levels.map((l) => ({ id: l.id, name: l.name, title: l.title, rank: l.rank })) },
  ).withCode(INVALID_PRIORITY);
}

/** The tenant's levels, then the resolved level (`null` passes through as a clear). */
export async function resolveTenantPriority(
  tenantId: string,
  raw: unknown,
): Promise<{ levels: CataloguePriority[]; level: CataloguePriority | null }> {
  const levels = await priorities(tenantId);
  return { levels, level: raw === null ? null : resolvePriorityLevel(levels, raw) };
}

/**
 * The legacy TEXT for a level, written beside the id during the backfill window
 * only (see the header): the RM name upper-cased (`p1` → `P1`).
 */
export function legacyPriorityText(level: CataloguePriority): string {
  return level.name.toUpperCase();
}

/** The level a stored legacy text maps to (case-insensitive name), or null. */
export function levelForLegacyText(
  levels: readonly CataloguePriority[],
  text: string | null | undefined,
): CataloguePriority | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  return levels.find((l) => l.name.toLowerCase() === text.trim().toLowerCase()) ?? null;
}

/** True when `level` is the tenant's highest level (the lowest rank, i.e. rank 0 in RM's defaults). */
export function isTopPriorityLevel(levels: readonly CataloguePriority[], level: CataloguePriority): boolean {
  const top = Math.min(...levels.map((l) => l.rank));
  return level.rank === top;
}

/** The conveyor never sets the rank-0 (highest) level → 403 `conveyor_p0_forbidden`. */
export function assertConveyorNotTopPriority(
  user: Pick<User, 'azp' | 'username' | 'roles'>,
  levels: readonly CataloguePriority[],
  level: CataloguePriority | null,
): void {
  if (level && isConveyorActor(user) && isTopPriorityLevel(levels, level)) {
    throw new ForbiddenError(
      `the conveyor may never set the highest priority level (${legacyPriorityText(level)})`,
    ).withCode(CONVEYOR_TOP_PRIORITY_FORBIDDEN);
  }
}
