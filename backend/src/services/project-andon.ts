// src/services/project-andon.ts
//
// The PROJECT andon cord: a super_admin's OPERATOR hold on one project (routes/andon.ts). Nothing
// runs on an engaged project until it is released.
//
// R349 (George 2026-11-04) retired R318's board-move hold: a person's drag on a conveyor board is
// now the plain Planka move, so nothing pulls this cord but an operator. Migration 206's
// `andon_reason` / `andon_request_id` / `andon_approval_id` columns stay as history; an engaged
// cord reads as 'operator' whatever reason it carries.
//
// A kata does not hold projects: it holds the whole conveyor n8n instance (services/kata-andon.ts).
import { eq } from 'drizzle-orm';

import { db as defaultDb, projects } from '../db/client';
import { andonState } from '../db/schema';
import { isUuidShape } from '../lib/uuid-shape';

export interface ProjectAndonView {
  project_id: string;
  engaged: boolean;
  /** 'operator' while engaged; null when released. */
  reason: 'operator' | null;
  engaged_at: string | null;
  engaged_by: string | null;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/** Pure: the cord row → the read view. */
export function buildAndonView(row: {
  id: string;
  andon_engaged: boolean;
  andon_engaged_at: Date | string | null;
  andon_engaged_by: string | null;
}): ProjectAndonView {
  return {
    project_id: row.id,
    engaged: row.andon_engaged,
    reason: row.andon_engaged ? 'operator' : null,
    engaged_at: row.andon_engaged ? iso(row.andon_engaged_at) : null,
    engaged_by: row.andon_engaged ? row.andon_engaged_by : null,
  };
}

type Db = typeof defaultDb;

/** The read view of a project the caller is already known to reach (id from a scoped lookup). */
export async function readProjectAndon(projectId: string, database: Db = defaultDb): Promise<ProjectAndonView | null> {
  if (!isUuidShape(projectId)) return null;
  const [row] = await database
    .select({
      id: projects.id,
      andon_engaged: projects.andon_engaged,
      andon_engaged_at: projects.andon_engaged_at,
      andon_engaged_by: projects.andon_engaged_by,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ? buildAndonView(row) : null;
}

/**
 * The katas holding the conveyor n8n instance (`andon_state.kata_holders`, migration 225).
 * Throws when unreadable: a hold nobody can read is not a release. A missing singleton reads as
 * no holders here — the operator cord's own gate already halts on that (fr#1208).
 */
export async function readKataHolders(database: Pick<Db, 'select'> = defaultDb): Promise<string[]> {
  const [row] = await database
    .select({ holders: andonState.kata_holders })
    .from(andonState)
    .where(eq(andonState.id, 1))
    .limit(1);
  return (row?.holders ?? []).map(String);
}

/** The super_admin cord's columns (routes/andon.ts): an engage is an OPERATOR cord. */
export function operatorAndonColumns(engaged: boolean, by: string) {
  return {
    andon_engaged: engaged,
    andon_engaged_at: engaged ? new Date() : null,
    andon_engaged_by: engaged ? by : null,
    andon_reason: engaged ? ('operator' as const) : null,
    andon_request_id: null,
    andon_approval_id: null,
  };
}
