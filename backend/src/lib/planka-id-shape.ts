// src/lib/planka-id-shape.ts
//
// Pure id-shape checks for Planka ids (fr#1437a). No DB imports, so the
// orchestrator tenant binding can use them without loading the DB graph.
//
// Planka ids are decimal snowflakes (19 digits today, e.g. card
// 1834885028425762010), sent as STRINGS end to end. fr stores them in TEXT
// columns (`projects.planka_project_id`, `streams.planka_project_id`,
// `tenant_improvement_projects.planka_project_id`, `wip_slot.project_id`).

import { isUuidShape } from './uuid-shape';

const PLANKA_ID_RE = /^\d{1,20}$/;

/** True for a Planka id (a decimal string of at most 20 digits). */
export function isPlankaIdShape(value: unknown): value is string {
  return typeof value === 'string' && PLANKA_ID_RE.test(value);
}

/**
 * A conveyor project id: a Planka project id (digits) or an fr `projects.id`
 * (uuid). Anything else is malformed — it names no row in any registry.
 */
export function isPlankaOrFrProjectIdShape(value: unknown): value is string {
  return isPlankaIdShape(value) || isUuidShape(value);
}
