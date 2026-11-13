// src/services/project-delivered.ts
//
// A project reads `delivered` once the PM (n8n) closes its RM pm_project (RM
// status `closed`, D22). fr only READS RM, and no fr write path (webhook,
// closure handler, sync job) learns of the closure, so delivery is DERIVED per
// read: a GET must not write (D-run12-9, 2026-10-31 — a read-only probe moved
// the fr row's updated_at).
//
// ⭐ READS DERIVE IT; THE RECONCILE WORKER IS THE ONLY THING THAT STORES IT
// (workers/project-delivered-reconcile.ts), and it does so for exactly ONE
// reason: the bug-hunt slot. `projects_one_live_bug_hunt_per_repo_idx`
// (db/schema.ts) is a partial unique index that excludes status 'delivered',
// so a repository's single live bug_hunt slot is freed only by a STORED
// 'delivered'. No index can see a derived value. Leaving the closure
// unstored re-created a permanent 409 `bug_hunt_project_exists` on a repo
// whose hunt had delivered (assertNoLiveBugHuntProject keys on stored status).
//
// Consumer: the MCP server's fr project task (nonagenticai_mcp_server
// docs/MCP_TASKS_FR_CAREBUS_SPEC.md §4 F-close) polls `projects.get` and
// completes when the status reads `delivered`.
import { and, asc, eq, ne } from 'drizzle-orm';

import { db } from '../db/client';
import { projectDeliverables, projects } from '../db/schema';
import { PM_PROJECT_CLOSED_STATUS } from '../integrations/pm';
import { DELIVERED_PROJECT_STATUS, isLiveProjectStatus, projectIsLive } from '../lib/project-live-status';
import type { ProjectStateOrError, RmProjectState } from './catalogue/project-state';

/** A failed project RM later closes stays failed: closing it is not delivering it. */
const FAILED_PROJECT_STATUS = 'failed';

export interface ProjectDelivery {
  status: string;
  delivered_at: Date | null;
  delivery_evidence: unknown;
}

/**
 * The delivery columns a read returns for `project`: `delivered` when RM says
 * its pm_project is closed (delivered_at = RM's `updated_at` on the closed
 * row, with the evidence pair that names the RM project; both NULL when RM
 * reports no timestamp — see the pair rule below), else the row's own. Pure —
 * writes nothing.
 */
export function deliveryFromRm(
  project: { status: string; delivered_at?: Date | string | null; delivery_evidence?: unknown },
  rm: RmProjectState | null | undefined,
): ProjectDelivery {
  if (
    rm?.pm.status !== PM_PROJECT_CLOSED_STATUS ||
    !isLiveProjectStatus(project.status) ||
    project.status === FAILED_PROJECT_STATUS
  ) {
    return {
      status: project.status,
      delivered_at: project.delivered_at ? new Date(project.delivered_at) : null,
      delivery_evidence: project.delivery_evidence ?? null,
    };
  }
  // The delivery RECORD is a PAIR — migration 173's
  // `projects_delivery_pair_check` requires `delivered_at` and
  // `delivery_evidence` to be both present or both absent. RM reporting no
  // `updated_at` means fr cannot say WHEN the pm_project closed, so there is no
  // record to return or to store; the project still reads `delivered` (RM says
  // closed) and RM still names the row (by origin_project_id).
  // Deriving evidence without a timestamp would be a value the worker could
  // never STORE, which would silently re-create the occupied bug-hunt slot.
  const deliveredAt = rm.pm.updated_at ? new Date(rm.pm.updated_at) : null;
  return {
    status: DELIVERED_PROJECT_STATUS,
    delivered_at: deliveredAt,
    delivery_evidence: deliveredAt
      ? { source: 'rm_project_closed', rm_pm_project_id: rm.rmPmProjectId, phase: rm.phase }
      : null,
  };
}

/**
 * STORE the delivery the read paths derive, once RM says the pm_project is
 * closed. Returns true when this call stamped the row.
 *
 * ⛔ CALLED ONLY BY `workers/project-delivered-reconcile.ts`. A READ PATH MUST
 * NEVER CALL IT: reading must not write (D-run12-9). The worker exists for the
 * one consumer that cannot use a derived value — the bug-hunt slot index — and
 * it stores exactly what `deliveryFromRm` reports, so a client polling the API
 * sees no jump when the row is stamped.
 *
 * Guards, in order: `st.ok` and RM `closed`; the row must still be LIVE
 * (`isLiveProjectStatus`), and `failed` is excluded because closing a failed
 * project is not delivering it. The UPDATE repeats the live + not-failed
 * predicate in its WHERE (`projectIsLive()`, `ne(status,'failed')`), so two
 * concurrent callers — or a project that was archived between SELECT and
 * UPDATE — cannot double-stamp or re-open anything: at most one UPDATE matches
 * the row, the other matches zero.
 */
export async function stampDeliveryIfRmClosed(
  project: { id: string; status: string },
  st: ProjectStateOrError | undefined,
): Promise<boolean> {
  if (
    !st?.ok ||
    st.state.pm.status !== PM_PROJECT_CLOSED_STATUS ||
    !isLiveProjectStatus(project.status) ||
    project.status === FAILED_PROJECT_STATUS
  ) {
    return false;
  }
  // DERIVE FIRST, STORE EXACTLY THAT. `deliveryFromRm` is the SAME function
  // every read path answers from, so the stored columns cannot disagree with
  // what a client was already shown. In particular `delivered_at` is RM's
  // `updated_at` on the closed row — and stays NULL when RM reports none.
  // Stamping `new Date()` there instead made a stamped project suddenly report
  // a LATER delivery time than the read had returned moments earlier (raised by
  // the 2026-10-31 audit; both cases are pinned in
  // tests/unit/db/project-delivered.test.ts).
  const delivery = deliveryFromRm(project, st.state);
  const rows = await db
    .update(projects)
    .set({
      status: delivery.status,
      delivered_at: delivery.delivered_at,
      delivery_evidence: delivery.delivery_evidence,
      updated_at: new Date(),
    })
    .where(and(eq(projects.id, project.id), projectIsLive(), ne(projects.status, FAILED_PROJECT_STATUS)))
    .returning({ id: projects.id });
  return rows.length > 0;
}

/**
 * One agreed customer deliverable. `url` is present only when the row names a repository
 * fr can resolve — a customer-visible link is never guessed.
 */
export interface ProjectDeliverable {
  title: string;
  url?: string;
}

/**
 * A row's first repository as an `https://` URL, or undefined.
 *
 * `project_deliverables.repos` is VERBATIM outline attribution (migration 151), so it
 * carries every shape the outline used: `https://github.com/acme/api`,
 * `git@github.com:acme/worker.git`, or a bare `acme/api`. A bare slug resolves against
 * github.com; anything unrecognised yields NO link rather than a link to nowhere.
 */
export function deliverableUrl(repos: string[] | null | undefined): string | undefined {
  const first = (repos ?? []).map((r) => String(r).trim()).find((r) => r !== '');
  if (!first) return undefined;
  if (/^https?:\/\//i.test(first)) return first;
  const scp = /^git@([^:]+):(.+?)(?:\.git)?$/i.exec(first);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(first)) return `https://github.com/${first}`;
  return undefined;
}

/** The project's agreed customer deliverables (approved scope), in order. */
export async function listProjectDeliverables(projectId: string): Promise<ProjectDeliverable[]> {
  const rows = await db
    .select({ title: projectDeliverables.title, repos: projectDeliverables.repos })
    .from(projectDeliverables)
    .where(and(eq(projectDeliverables.project_id, projectId), eq(projectDeliverables.kind, 'deliverable')))
    .orderBy(asc(projectDeliverables.position));
  return rows.map((row) => {
    const url = deliverableUrl(row.repos);
    return url ? { title: row.title, url } : { title: row.title };
  });
}
