// src/scripts/backfill-signoff-report-reviews.ts
//
// One-off backfill for George's 2026-10-29 ruling (a decided card sign-off resolves that card's
// pending conveyor report.json reviews). The live hook in routes/approvals.ts covers every decision
// from now on; this resolves the reports of sign-offs decided BEFORE it shipped, through the SAME
// function (`resolveCardReportsForSignoff`), as the recorded decider.
//
// Newest decision first, so where a card was signed off more than once its latest decision wins
// (each pass only touches reports still `pending`, and only those created at or before that
// sign-off's decision). A report counted or resolved by one pass is never offered to a later pass
// — without that, a dry run (which writes nothing, so every report stays `pending`) counted a card
// with several sign-offs once per sign-off.
//
//   bun run src/scripts/backfill-signoff-report-reviews.ts           # dry run: counts only
//   bun run src/scripts/backfill-signoff-report-reviews.ts --apply   # writes the reviews
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { approvalDecisions, approvals } from '../db/schema';
import {
  resolveCardReportsForSignoff,
  type DecidedSignoff,
} from '../services/approvals/signoff-resolves-reports';

export interface DecidedSignoffRow extends DecidedSignoff {
  status: string;
  decider_id: string | null;
}

export interface BackfillSignoffReportsOpts {
  apply: boolean;
  loadSignoffs: () => Promise<DecidedSignoffRow[]>;
}

export interface ProjectCounts {
  signoffs: number;
  resolved: number;
  would_resolve: number;
  failed: number;
}

export interface BackfillSignoffReportsSummary {
  signoffs: number;
  skipped_no_decider: number;
  resolved: number;
  would_resolve: number;
  failed: number;
  projects: Record<string, ProjectCounts>;
}

export async function runBackfillSignoffReports(opts: BackfillSignoffReportsOpts): Promise<BackfillSignoffReportsSummary> {
  const log = (m: string) => console.log(m);
  // Reports an earlier pass already took are never offered to a later one; a dry run writes nothing.
  const taken = new Set<string>();
  const s: BackfillSignoffReportsSummary = { signoffs: 0, skipped_no_decider: 0, resolved: 0, would_resolve: 0, failed: 0, projects: {} };
  for (const row of await opts.loadSignoffs()) {
    s.signoffs += 1;
    const pid = row.project_id ?? 'none';
    const p = (s.projects[pid] ??= { signoffs: 0, resolved: 0, would_resolve: 0, failed: 0 });
    p.signoffs += 1;
    if (!row.decider_id) {
      s.skipped_no_decider += 1;
      log(`[skip] sign-off ${row.id}: no recorded decider`);
      continue;
    }
    const r = await resolveCardReportsForSignoff(row, row.status, row.decider_id, { apply: opts.apply, exclude: taken });
    if (r.outcome !== 'done') continue;
    for (const id of [...r.resolved, ...r.failed]) taken.add(id);
    const n = r.resolved.length;
    if (opts.apply) {
      s.resolved += n;
      p.resolved += n;
    } else {
      s.would_resolve += n;
      p.would_resolve += n;
    }
    s.failed += r.failed.length;
    p.failed += r.failed.length;
    if (n || r.failed.length) {
      log(`[${opts.apply ? 'apply' : 'dry-run'}] project ${pid} card ${row.card_id} sign-off ${row.id} (${row.status}): ${n} report(s)${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
    }
  }
  for (const [pid, c] of Object.entries(s.projects)) {
    if (c.resolved || c.would_resolve || c.failed) log(`[project] ${pid} ${JSON.stringify(c)}`);
  }
  log(`[summary] ${JSON.stringify({ ...s, projects: Object.keys(s.projects).length })}`);
  return s;
}

/** Decided card sign-offs, newest first, with the approver of the deciding decision. */
export async function loadDecidedSignoffsFromDb(): Promise<DecidedSignoffRow[]> {
  const rows = await db
    .select({
      id: approvals.id,
      tenant_id: approvals.tenant_id,
      project_id: approvals.project_id,
      card_id: approvals.card_id,
      metadata: approvals.metadata,
      status: approvals.status,
      completed_at: approvals.completed_at,
    })
    .from(approvals)
    .where(
      and(
        inArray(approvals.status, ['approved', 'rejected']),
        isNotNull(approvals.card_id),
        isNotNull(approvals.project_id),
        sql`${approvals.metadata}->>'ask_kind' = 'signoff'`,
      ),
    )
    .orderBy(desc(approvals.completed_at));
  const out: DecidedSignoffRow[] = [];
  for (const r of rows) {
    const [d] = await db
      .select({ approver_id: approvalDecisions.approver_id })
      .from(approvalDecisions)
      .where(and(eq(approvalDecisions.approval_id, r.id), eq(approvalDecisions.decision, r.status)))
      .orderBy(desc(approvalDecisions.decided_at))
      .limit(1);
    out.push({ ...r, decider_id: d?.approver_id ?? null });
  }
  return out;
}

if (import.meta.main) {
  runBackfillSignoffReports({ apply: process.argv.includes('--apply'), loadSignoffs: loadDecidedSignoffsFromDb })
    .then((s) => process.exit(s.failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error('[fatal]', err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
