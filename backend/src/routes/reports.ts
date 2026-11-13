// src/routes/reports.ts
// Report endpoints — receives n8n-generated reports and serves them to the frontend
import { db, projectReports, projects, departments, streams } from '../db/client';
import { eq, desc, and, sql, count } from 'drizzle-orm';
import { jsonResponse, createdResponse } from '../utils/response';
import { serializeCount } from '../lib/resolution';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { holdsOrchestratorRole } from '../lib/project-access';
import { isUuidShape } from '../lib/uuid-shape';
import {
  licenceTenantMismatch,
  licenceOnly,
  sameTenant,
  type LicenceDoor,
} from '../lib/licence-door';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { wsManager } from '../domain/engagement/adapters/websocket';
import { z } from 'zod';
import { persistBugReport } from '../services/reports/bug-report';
import { AA_TRACE_HEADER } from '../lib/aa-trace';
import { resolveCardApprovalTenant } from './webhooks';

// The generic report path. `bug_report` is deliberately NOT in this enum: it has
// its own schema (required tenant, server-recomputed content hash, insert-once,
// transactional notification — services/reports/bug-report.ts) and is routed
// there BEFORE this schema is consulted, so the generic path can never write a
// bug_report row without those guarantees.
const N8nReportSchema = z.object({
  report_type: z.enum(['status', 'sprint', 'dependency', 'quality', 'custom']),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.record(z.any()).optional(),
  card_id: z.string().optional(),
  board_id: z.string().optional(),
  project_id: z.string().uuid().optional(),
  // Optional explicit tenant from n8n — preferred when supplied. Harmless
  // until n8n starts sending it; mirrors N8nCardApprovalSchema. Migration 080.
  tenant_id: z.string().uuid().optional(),
});

/**
 * Resolve the tenant for an incoming n8n report (migration 080).
 *
 * Priority (mirrors resolveCardApprovalTenant in routes/webhooks.ts and the
 * backfill passes in migration 080):
 *   1. Explicit `tenant_id` supplied by n8n.
 *   2. `project_id` → projects.dept_id → departments.workspace_id, falling back
 *      to projects.project_data->>'keycloak_tenant_id' for dept-less projects
 *      (the authoritative tenant for workspace-scope projects — see routes/projects.ts).
 *   3. `board_id` → projects.planka_board_id → departments.workspace_id.
 *   4. `board_id` → streams.planka_board_id → streams.tenant_id.
 *
 * Returns null when none resolve. Unlike card-approval (NOT NULL column → 400),
 * reports keep tenant_id nullable: the caller stores the row with NULL and
 * warns, so report ingestion is never dropped. NULL-tenant rows are
 * fail-closed-invisible once reads are scoped.
 */
export async function resolveReportTenant(
  explicitTenantId: string | undefined,
  projectId: string | undefined,
  boardId: string | undefined,
): Promise<string | null> {
  if (explicitTenantId) return explicitTenantId;

  if (projectId) {
    const [projRow] = await db
      .select({
        deptTenant: departments.workspace_id,
        dataTenant: sql<string | null>`${projects.project_data}->>'keycloak_tenant_id'`,
      })
      .from(projects)
      .leftJoin(departments, eq(departments.id, projects.dept_id))
      .where(eq(projects.id, projectId))
      .limit(1);
    const fromProject = projRow?.deptTenant ?? projRow?.dataTenant ?? null;
    if (fromProject) return fromProject;
  }

  if (!boardId) return null;

  const [boardProjRow] = await db
    .select({ tenant_id: departments.workspace_id })
    .from(projects)
    .innerJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  if (boardProjRow?.tenant_id) return boardProjRow.tenant_id;

  const [streamRow] = await db
    .select({ tenant_id: streams.tenant_id })
    .from(streams)
    .where(eq(streams.planka_board_id, boardId))
    .limit(1);
  return streamRow?.tenant_id ?? null;
}

// ⚠️ HISTORICAL: this receiver was fronted by X-Webhook-Secret (first a
// fail-open local copy, then utils/webhook-secret.ts). G4 (2026-10-10) removed
// that door; it accepts an fr licence token only (`licenceOnly`).

/**
 * POST /api/webhooks/n8n/report
 * n8n pushes generated reports here. FR stores + broadcasts via WebSocket.
 */
export async function handleN8nReport(req: Request): Promise<Response> {
  // G4: a licence token ONLY (lib/licence-door.ts). The X-Webhook-Secret door
  // that used to front this route is removed — a secret-only request is 401.
  const door = await licenceOnly(req);
  const body = await req.json();

  if (
    body !== null &&
    typeof body === 'object' &&
    (body as { report_type?: unknown }).report_type === 'bug_report'
  ) {
    const b = body as { tenant_id?: unknown; board_id?: unknown; project_id?: unknown };
    await assertReportLicenceTenant(door, {
      tenant_id: typeof b.tenant_id === 'string' ? b.tenant_id : undefined,
      board_id: typeof b.board_id === 'string' ? b.board_id : undefined,
      // ⛔ Resolved HERE, not left to persistBugReport: its project check
      // (`projectTenant && projectTenant !== v.tenant_id`) passes a project
      // with NO tenant, whose owner would then be notified with caller text.
      // A tenantless project resolves null ⇒ mismatch ⇒ 403 for a licence.
      project_id: typeof b.project_id === 'string' ? b.project_id : undefined,
      requireTenant: true,
    });
    return handleBugReport(body, req.headers.get(AA_TRACE_HEADER));
  }

  const validated = N8nReportSchema.parse(body);

  // Tenant scope (migration 080). Every hint sent must resolve to the licence
  // tenant (403 licence_tenant_mismatch, nothing written), and the row is filed
  // under the licence tenant — never NULL, never a body-named tenant.
  await assertReportLicenceTenant(door, validated);
  const tenantId = door.tenantId;

  const [report] = await db.insert(projectReports).values({
    tenant_id: tenantId,
    project_id: validated.project_id,
    card_id: validated.card_id,
    report_type: validated.report_type,
    title: validated.title,
    summary: validated.summary,
    details: validated.details,
    board_id: validated.board_id,
    generated_by: 'n8n',
  }).returning();

  if (!report) {
    throw new Error('Failed to create report');
  }

  // Broadcast to connected WebSocket clients — the report's OWN tenant
  // channel only (fr row 14d-2); a NULL-tenant report is dropped and counted.
  wsManager.publishReport(report);

  console.log(`[reports] Stored ${validated.report_type} report: ${validated.title}`);

  return createdResponse({
    id: report.id,
    report_type: report.report_type,
    title: report.title,
    created_at: report.created_at,
  });
}

/**
 * Licence door (lib/licence-door.ts): each tenant hint the body sends — an
 * explicit `tenant_id`, a `project_id`, a `board_id` — must name the licence's
 * tenant. Each is resolved ON ITS OWN (project: `resolveReportTenant`; board:
 * `resolveCardApprovalTenant`), never as a fallback chain, and an unknown
 * project/board refuses like a foreign one.
 * `requireTenant`: the bug_report schema makes `tenant_id` mandatory, so on
 * that path it must be present AND the licence's.
 */
async function assertReportLicenceTenant(
  door: LicenceDoor,
  hints: { tenant_id?: string; project_id?: string; board_id?: string; requireTenant?: boolean },
): Promise<void> {
  if (hints.tenant_id !== undefined || hints.requireTenant) {
    if (!sameTenant(hints.tenant_id, door.tenantId)) throw licenceTenantMismatch('tenant_id');
  }
  if (hints.project_id !== undefined) {
    const t = await resolveReportTenant(undefined, hints.project_id, undefined);
    if (!sameTenant(t, door.tenantId)) throw licenceTenantMismatch(`project ${hints.project_id}`);
  }
  if (hints.board_id !== undefined) {
    // resolveCardApprovalTenant, not resolveReportTenant's board arm: that arm walks only the
    // dept chain, which is null for every tag-tenanted project board (webhooks.ts explains).
    const t = await resolveCardApprovalTenant(undefined, hints.board_id);
    if (!sameTenant(t, door.tenantId)) throw licenceTenantMismatch(`board ${hints.board_id}`);
  }
}

/**
 * `report_type: 'bug_report'` (U2). 201 when this call stored the report, 200
 * with the SAME row when (tenant_id, content_hash) already existed — insert-once.
 */
async function handleBugReport(body: unknown, traceIdHeader: string | null): Promise<Response> {
  const { report, created, notified } = await persistBugReport(body, { traceIdHeader });

  // fr row 14d-2: the report's OWN tenant channel only.
  if (created) wsManager.publishReport(report);


  console.log(
    `[reports] bug_report ${report.id} ${created ? 'stored' : 'already stored (insert-once)'} ` +
      `content_hash=${report.content_hash} trace_id=${report.trace_id ?? 'none'} notified=${notified}`,
  );

  return jsonResponse(
    {
      id: report.id,
      report_type: report.report_type,
      title: report.title,
      content_hash: report.content_hash,
      trace_id: report.trace_id,
      created_at: report.created_at,
      created,
      notified,
    },
    created ? 201 : 200,
  );
}

// Pagination bounds for the reports list (cap idiom mirrors me/notifications.ts).
const DEFAULT_REPORTS_LIMIT = 20;
const MAX_REPORTS_LIMIT = 200;

/**
 * GET /api/reports
 * List reports, optionally filtered by type, project or card (`card_id`, U2).
 */
export async function handleListReports(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const reportType = url.searchParams.get('type');
  const projectId = url.searchParams.get('project_id');
  const cardId = url.searchParams.get('card_id');
  // Clamp limit so a hostile `?limit=1e9` can't trigger an unbounded scan
  // (cap idiom mirrors me/notifications.ts).
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_REPORTS_LIMIT,
    MAX_REPORTS_LIMIT,
  );

  // Mandatory tenant predicate first (migration 080) — without it any
  // authenticated user could list every tenant's reports (IDOR). NULL-tenant
  // rows never match, so legacy un-attributable reports are fail-closed.
  const conditions = [eq(projectReports.tenant_id, ctxTenantId(user.tenantId))];
  if (reportType) conditions.push(eq(projectReports.report_type, reportType));
  if (projectId) conditions.push(eq(projectReports.project_id, projectId));
  // U2: the card view links to the reports written for that card.
  if (cardId) conditions.push(eq(projectReports.card_id, cardId));

  // ⚠️ `total` USED TO BE `reports.length`, which is the size of the page the
  // `.limit(limit)` below had just cut — 20 by default, 200 at most. A tenant
  // holding 9,845 reports was told `total: 20`, and no value of that field
  // could have meant "more matched". The count below runs against the SAME
  // `conditions` array the page was drawn from, not a re-derived copy: a count
  // that can drift from its own list is how the old number stayed plausible.
  // Same idiom as routes/approvals.ts:653.
  const where = and(...conditions);
  const [reports, totalRows] = await Promise.all([
    db
      .select()
      .from(projectReports)
      .where(where)
      .orderBy(desc(projectReports.created_at))
      .limit(limit),
    db.select({ n: count() }).from(projectReports).where(where),
  ]);

  const { total, total_kind, headers } = serializeCount({
    rows: reports,
    appliedLimit: limit,
    totalMatching: totalRows[0]?.n ?? null,
  });
  return jsonResponse({ items: reports, total, total_kind }, 200, headers);
}

/**
 * GET /api/reports/:reportId
 * Get a single report with full details.
 */
export async function handleGetReport(req: Request, reportId: string): Promise<Response> {
  const user = await validateAuth(req);

  // `project_reports.id` is a `uuid` column (schema.ts:618): a `:reportId` that
  // is not UUID-shaped aborts the query with 22P02 `invalid input syntax for
  // type uuid` rather than matching nothing, surfacing as a bare 500. Same 404
  // as the cross-tenant/absent case below — a distinct status for "malformed"
  // would give a prober exactly the oracle the tenant-scoped 404 denies.
  // `isUuidShape`, not `isValidUuid`: shape only, no version/variant pinning,
  // so legal `uuid` literals that name real rows are not rejected.
  if (!isUuidShape(reportId)) {
    throw new NotFoundError('Report not found');
  }

  // Scope by tenant (migration 080). A cross-tenant id finds no row → 404
  // (NOT 403), so an attacker cannot probe for report ids across tenants.
  const [report] = await db.select()
    .from(projectReports)
    .where(and(
      eq(projectReports.id, reportId),
      eq(projectReports.tenant_id, ctxTenantId(user.tenantId)),
    ));

  if (!report) {
    throw new NotFoundError('Report not found');
  }

  return jsonResponse(report);
}

// ── bug_fix: the APPEND-ONLY "this bug_report is fixed" record ─────────────────
//
// George 2026-10-11 (R16, typed n8n op `report.markBugReportFixed`): the conveyor's
// implementation card marks a confirmed bug fixed with the commit that fixed it.
// A bug_report row is insert-once and content-hashed (migration 147), so it is
// NEVER mutated: the fix is its own `project_reports` row, `report_type =
// 'bug_fix'`, pointing at the bug_report. At most one fix per bug_report: the
// same (full) commit again is an idempotent 200 with the stored row, a different commit
// is 409 `bug_report_already_fixed`. `bug_fix` is not in the generic report enum
// above, so this is the only door that writes one.
export const MarkBugReportFixedSchema = z
  .object({
    // The FULL sha only (sha1 40 / sha256 64): an abbreviation is ambiguous evidence, and
    // matching abbreviations made idempotency fail OPEN for a different commit.
    commit_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'commit_sha must be a full 40- or 64-character hex git sha'),
    pr_url: z.string().url().max(2048).optional(),
    card_id: z.string().min(1).max(64).optional(),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const BUG_FIX_REPORT_TYPE = 'bug_fix' as const;

/**
 * POST /api/reports/:reportId/fix — record that a bug_report is fixed.
 * Who: the system seat (a licence — the conveyor — or the aa-orchestrator role)
 * or a super-admin; anyone else 403. Tenant-scoped exactly like GET
 * /api/reports/:reportId: a bug_report in another tenant (or absent, or not a
 * bug_report) is the same 404.
 */
export async function handleMarkBugReportFixed(req: Request, reportId: string): Promise<Response> {
  const user = await validateAuth(req);
  if (!(user.authKind === 'licence' || holdsOrchestratorRole(user) || isSuperAdmin(user))) {
    throw new ForbiddenError('Only the conveyor (licence) or a super-admin may record a bug fix');
  }
  if (!isUuidShape(reportId)) throw new NotFoundError('Report not found');
  // ONE canonical spelling for the lock key, the duplicate lookup and the stored
  // pointer: the uuid column matches case-insensitively, so a mixed-case id must
  // not become a second lock key (two fixes for one bug_report otherwise).
  const bugReportId = reportId.toLowerCase();
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const body = MarkBugReportFixedSchema.parse(raw);
  const tenantId = ctxTenantId(user.tenantId);
  const commitSha = body.commit_sha.toLowerCase();

  const outcome = await db.transaction(async (tx) => {
    // Serialise concurrent fix records for the same bug_report (one fix per report).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bug-fix:${bugReportId}`}))`);
    const [bug] = await tx
      .select()
      .from(projectReports)
      .where(
        and(
          eq(projectReports.id, bugReportId),
          eq(projectReports.tenant_id, tenantId),
          eq(projectReports.report_type, 'bug_report'),
        ),
      );
    if (!bug) throw new NotFoundError('Report not found');

    const [existing] = await tx
      .select()
      .from(projectReports)
      .where(
        and(
          eq(projectReports.tenant_id, tenantId),
          eq(projectReports.report_type, BUG_FIX_REPORT_TYPE),
          sql`${projectReports.details}->>'bug_report_id' = ${bugReportId}`,
        ),
      )
      .limit(1);
    if (existing) {
      const storedSha = String(((existing.details ?? {}) as Record<string, unknown>).commit_sha ?? '');
      if (storedSha === commitSha) return { row: existing, created: false };
      throw new AppError(409, `bug report ${bugReportId} is already recorded as fixed by ${storedSha}`).withCode(
        'bug_report_already_fixed',
      );
    }

    const [row] = await tx
      .insert(projectReports)
      .values({
        tenant_id: tenantId,
        project_id: bug.project_id,
        card_id: body.card_id ?? bug.card_id,
        board_id: bug.board_id,
        report_type: BUG_FIX_REPORT_TYPE,
        title: `Fix for bug report ${bugReportId}`,
        summary: `Fixed in ${commitSha}`,
        details: {
          bug_report_id: bugReportId,
          bug_report_content_hash: bug.content_hash,
          commit_sha: commitSha,
          ...(body.pr_url ? { pr_url: body.pr_url } : {}),
          ...(body.card_id ? { card_id: body.card_id } : {}),
          ...(body.note ? { note: body.note } : {}),
        },
        generated_by: user.authKind === 'licence' ? 'conveyor' : 'manual',
      })
      .returning();
    return { row: row!, created: true };
  });

  return outcome.created ? createdResponse({ data: outcome.row }) : jsonResponse({ data: outcome.row }, 200);
}

