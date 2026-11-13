// src/services/reports/bug-report.ts
//
// U2 — persist a bug_report/v1 artifact and tell a human it exists, atomically.
//
//   1. H_r is RECOMPUTED here from the validated body (src/lib/bug-report-hash.ts).
//      A client-sent `content_hash` is an assertion: if it disagrees → 400.
//   2. tenant_id is REQUIRED (the zod schema refuses null/absent; migration 147's
//      CHECK is the backstop). A NULL-tenant row would be invisible to every
//      tenant (reads are tenant-predicated, migration 080), so for an artifact a
//      human must read before approving, "stored but invisible" is a loss.
//   3. Insert-once per (tenant_id, H_r): ON CONFLICT against migration 147's
//      partial UNIQUE index. A duplicate returns the EXISTING row (200), mints no
//      second row and no second notification.
//   4. The report row and its `report.ready` inbox notification(s) are written in
//      ONE transaction. If any notification insert fails, the report rolls back
//      too; if there is nobody to notify, the insert is refused (422) rather than
//      committing a report no one was told about. External channel sends happen
//      only AFTER commit — a send cannot be rolled back.
//
// `assertReportBeforeApproval` is the U3 contract helper (movies-78 calls it when
// it mints an approval that cites a report). It has no caller in this change.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db as defaultDb, departments, projectReports, projects, userRoles } from '../../db/client';
import {
  BugReportDetailsSchema,
  CONTENT_HASH_RE,
  bugReportHash,
} from '../../lib/bug-report-hash';
import { isUuidShape } from '../../lib/uuid-shape';
import { resolveTraceId } from '../../lib/aa-trace';
import { AppError, BadRequestError, ValidationError } from '../../utils/errors';
import { notificationService, type ExecutionEvent } from '../../domain/engagement/notifications';
import { defaultSeverity } from '../../domain/engagement/event-types';
import { listTenantMemberRecipients } from '../tenant-member-recipients';
import { keycloak } from '../keycloak';

/** POST /api/webhooks/n8n/report body when `report_type` is `bug_report`. */
const N8nBugReportSchema = z.object({
  report_type: z.literal('bug_report'),
  title: z.string().min(1),
  summary: z.string().min(1),
  // REQUIRED and non-null — see header point 2. No resolution fallback: the
  // producer names the tenant explicitly, because H_r binds it.
  tenant_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  card_id: z.string().min(1),
  board_id: z.string().optional(),
  content_hash: z.string().regex(CONTENT_HASH_RE, 'content_hash must be 64 lowercase hex chars').optional(),
  // AA-TRACE §1 join key (UUIDv7). Optional: the spec's carrier is the
  // X-AA-Trace-Id header (§2) and a write without one is an orphan that is
  // STORED with trace_id NULL, not refused. Format is checked in
  // resolveTraceId (shared with the header) so both carriers fail the same way.
  // NOT part of H_r — see src/lib/bug-report-hash.ts.
  trace_id: z.string().optional(),
  // Optional explicit recipients, ADDED to every member of the tenant (P1-TEAM-b:
  // all members are always told). EVERY explicit recipient must be a member of
  // `tenant_id` (assertRecipientsInTenant) — one outsider refuses the whole
  // request 422 `recipient_not_in_tenant`; it is never filtered silently.
  recipient_user_ids: z.array(z.string().min(1)).max(50).optional(),
  details: BugReportDetailsSchema,
});
type N8nBugReport = z.infer<typeof N8nBugReportSchema>;

/**
 * The subset of `userIds` that are members of `tenantId`, by fr's definition
 * of membership as `approverIsTenantMember` (domain/approvals/one-open-gate.ts)
 * reads it — a `user_roles` row under the tenant, any role — plus the tenant's
 * realm `tenant_admin`s (a Keycloak-only admin has no `user_roles` row but IS a
 * member; it is the same directory half listWorkspaceAdminRecipients unions
 * in). The directory is asked only for ids the DB did not already vouch for,
 * and a failed directory read THROWS rather than reading as "not a member":
 * no silent pass across a tenant boundary, and no false 422 on an outage.
 */
async function listTenantMembers(tenantId: string, userIds: string[]): Promise<Set<string>> {
  const members = new Set<string>();
  if (userIds.length === 0) return members;
  const rows = await defaultDb
    .selectDistinct({ user_id: userRoles.user_id })
    .from(userRoles)
    .where(and(eq(userRoles.tenant_id, tenantId), inArray(userRoles.user_id, userIds)));
  for (const r of rows) members.add(r.user_id);
  if (userIds.every((id) => members.has(id))) return members;
  const wanted = new Set(userIds);
  for (const id of await keycloak.listRealmTenantAdminIds(tenantId)) if (wanted.has(id)) members.add(id);
  return members;
}

export type StoredReport = typeof projectReports.$inferSelect;

interface PersistBugReportResult {
  report: StoredReport;
  created: boolean;
  notified: number;
}

/**
 * ⛔ STRICT tenant separation: the webhook secret is shared by every n8n
 * producer, so a caller-named recipient list is an assertion, not a fact. Any
 * id outside the report's tenant refuses the WHOLE request (422
 * `recipient_not_in_tenant`, nothing stored, nobody notified) — filtering it
 * out silently would hide the producer bug that named it.
 */
async function assertRecipientsInTenant(tenantId: string, ids: string[]): Promise<void> {
  const members = await listTenantMembers(tenantId, ids);
  const outsiders = ids.filter((id) => !members.has(id));
  if (outsiders.length > 0) {
    throw new ValidationError(
      `bug_report recipient_user_ids name ${outsiders.length} user(s) who are not members of tenant ${tenantId}; nothing was stored and nobody was notified`,
      { recipients_not_in_tenant: outsiders },
    ).withCode('recipient_not_in_tenant');
  }
}

/**
 * P1-TEAM-b (George 2026-10-15): "all notifications … are sent to all members". The
 * report goes to EVERY member of its tenant (`listTenantMembers` dep: user_roles ∪
 * Keycloak `tenant_id`, fail soft), and an explicit `recipient_user_ids` list is ADDED
 * to that — after the whole list is proven to be members (422 otherwise, unchanged).
 * This used to be the explicit list, else the project OWNER only, else the admins.
 */
async function resolveRecipients(v: N8nBugReport): Promise<string[]> {
  const explicit = v.recipient_user_ids && v.recipient_user_ids.length > 0
    ? [...new Set(v.recipient_user_ids)]
    : [];
  if (explicit.length > 0) await assertRecipientsInTenant(v.tenant_id, explicit);
  const members = (await listTenantMemberRecipients(v.tenant_id)).userIds;
  return [...new Set([...explicit, ...members])];
}

/**
 * A `project_id` the report names must exist and must not belong to ANOTHER
 * tenant: H_r binds (tenant_id, project_id), and the project owner is a
 * notification recipient, so a mismatched pair would both mint a false artifact
 * and notify across a tenant boundary.
 */
async function assertProjectInTenant(v: N8nBugReport): Promise<void> {
  if (!v.project_id) return;
  const [row] = await defaultDb
    .select({
      deptTenant: departments.workspace_id,
      dataTenant: sql<string | null>`${projects.project_data}->>'keycloak_tenant_id'`,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, v.project_id))
    .limit(1);
  if (!row) {
    throw new ValidationError(`bug_report names project ${v.project_id}, which does not exist`).withCode(
      'project_not_found',
    );
  }
  const projectTenant = row.deptTenant ?? row.dataTenant ?? null;
  if (projectTenant && projectTenant !== v.tenant_id) {
    throw new ValidationError(
      `bug_report tenant_id ${v.tenant_id} does not own project ${v.project_id}`,
    ).withCode('tenant_project_mismatch');
  }
}

export async function persistBugReport(
  body: unknown,
  opts: { traceIdHeader?: string | null } = {},
): Promise<PersistBugReportResult> {
  const v = N8nBugReportSchema.parse(body);
  const traceId = resolveTraceId(opts.traceIdHeader, v.trace_id);

  const contentHash = bugReportHash({
    tenant_id: v.tenant_id,
    project_id: v.project_id ?? null,
    card_id: v.card_id,
    hunt: v.details.hunt,
    repo: v.details.repo,
    commit_sha: v.details.commit_sha,
    bugs: v.details.bugs,
  });
  if (v.content_hash !== undefined && v.content_hash !== contentHash) {
    throw new BadRequestError('content_hash does not match the server-recomputed H_r', {
      sent: v.content_hash,
      recomputed: contentHash,
    }).withCode('content_hash_mismatch');
  }

  await assertProjectInTenant(v);
  const recipients = await resolveRecipients(v);

  const outcome = await defaultDb.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(projectReports)
      .values({
        tenant_id: v.tenant_id,
        project_id: v.project_id ?? null,
        card_id: v.card_id,
        report_type: 'bug_report',
        title: v.title,
        summary: v.summary,
        details: v.details,
        board_id: v.board_id ?? null,
        generated_by: 'n8n',
        content_hash: contentHash,
        trace_id: traceId,
      })
      .onConflictDoNothing({
        target: [projectReports.tenant_id, projectReports.content_hash],
        where: sql`content_hash IS NOT NULL`,
      })
      .returning();

    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(projectReports)
        .where(
          and(eq(projectReports.tenant_id, v.tenant_id), eq(projectReports.content_hash, contentHash)),
        )
        .limit(1);
      if (!existing) {
        // ON CONFLICT fired but the conflicting row is not visible — only
        // possible if it was deleted between the two statements. Fail loud.
        throw new Error(`bug_report insert conflicted on ${contentHash} but no row is visible`);
      }
      return { report: existing, created: false, notifications: [] as Array<{ userId: string; id: string }> };
    }

    if (recipients.length === 0) {
      throw new ValidationError(
        `bug_report for tenant ${v.tenant_id} has nobody to notify (no recipient_user_ids and no tenant member); refusing to store a report no one is told about`,
      ).withCode('no_report_recipients');
    }

    const event = reportReadyEvent(inserted);
    const written: Array<{ userId: string; id: string }> = [];
    for (const userId of recipients) {
      written.push({ userId, id: await notificationService.writeEventInboxRow(tx, event, userId) });
    }
    return { report: inserted, created: true, notifications: written };
  });

  if (outcome.created) {
    const event = reportReadyEvent(outcome.report);
    // After commit. Each send is best-effort and records its own delivery row.
    await Promise.allSettled(
      outcome.notifications.map((n) => notificationService.deliverEventExternally(event, n.userId, n.id)),
    );
  }

  return { report: outcome.report, created: outcome.created, notified: outcome.notifications.length };
}

function reportReadyEvent(report: StoredReport): ExecutionEvent {
  return {
    event_type: 'report.ready',
    tenant_id: report.tenant_id as string,
    severity: defaultSeverity('report.ready'),
    title: `Bug report ready: ${report.title}`,
    body: report.summary,
    link: `/reports/${report.id}`,
    project_id: report.project_id ?? null,
    card_id: report.card_id ?? null,
    source: 'n8n',
    correlation_id: report.content_hash ?? null,
    metadata: {
      report_id: report.id,
      report_type: report.report_type,
      content_hash: report.content_hash,
      trace_id: report.trace_id ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// U3 contract helper
// ─────────────────────────────────────────────────────────────────────────────

type ReportPreconditionCode =
  | 'report_not_found'
  | 'report_hash_mismatch'
  | 'report_not_before_now';

/** Thrown by `assertReportBeforeApproval`. 409: the approval's precondition does not hold. */
class ReportPreconditionError extends AppError {
  constructor(
    public readonly reason: ReportPreconditionCode,
    message: string,
  ) {
    super(409, message);
    this.name = 'ReportPreconditionError';
    this.code = reason;
  }
}

/**
 * Throws `ReportPreconditionError` unless `report_id` exists IN `tenant_id`
 * with exactly `report_hash` as its content_hash, and was created strictly
 * before the database's `now()` (so a report and the approval citing it can
 * never share a transaction, and the report always precedes the approval).
 *
 * A row in another tenant is indistinguishable from a missing one
 * (`report_not_found`), as on the read routes. `executor` is `db` or a tx.
 */
export async function assertReportBeforeApproval(
  executor: Pick<typeof defaultDb, 'select'>,
  args: { tenant_id: string; report_id: string; report_hash: string },
): Promise<void> {
  if (!isUuidShape(args.report_id) || !isUuidShape(args.tenant_id)) {
    throw new ReportPreconditionError('report_not_found', `report ${args.report_id} not found`);
  }
  const [row] = await executor
    .select({
      content_hash: projectReports.content_hash,
      before_now: sql<boolean>`${projectReports.created_at} < now()`,
    })
    .from(projectReports)
    .where(and(eq(projectReports.id, args.report_id), eq(projectReports.tenant_id, args.tenant_id)))
    .limit(1);
  if (!row) {
    throw new ReportPreconditionError('report_not_found', `report ${args.report_id} not found`);
  }
  if (!row.content_hash || row.content_hash !== args.report_hash) {
    throw new ReportPreconditionError(
      'report_hash_mismatch',
      `report ${args.report_id} does not carry content_hash ${args.report_hash}`,
    );
  }
  if (row.before_now !== true) {
    throw new ReportPreconditionError(
      'report_not_before_now',
      `report ${args.report_id} was not created before now()`,
    );
  }
}
