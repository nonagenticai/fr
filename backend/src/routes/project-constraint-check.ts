// src/routes/project-constraint-check.ts
//
// POST /api/projects/constraint-check — the LANDING GATE for project constraints.
//
// n8n's merge paths call this (typed op `project.constraintCheck` in
// @nonagentic/n8n-nodes-fr) BEFORE merging a PR. Contract, fail-closed:
//   * 200 + verdict 'pass' | 'unchecked_only' → may merge;
//   * 200 + verdict 'violation'               → must NOT merge;
//   * ANY non-200 (401/404/422/502)           → must NOT merge.
// card_id resolution (card → board → projects.planka_board_id):
//   * card not found in Planka          → 404 (block);
//   * card found, board has NO fr project → 200 pass, project_id null,
//     reason 'no_project' — many conveyor boards are not fr projects, so there
//     are no constraints to enforce and a 404 would halt their merges forever;
//   * board maps to MORE THAN ONE project → 502 'ambiguous board→project
//     mapping' (fail closed: we cannot tell whose constraints apply).
// U4 WRITE-SET FENCE (optional inputs `write_set_approval_id` + `changed_paths`): every
// changed path — caller's `changed_paths` ∪ the PR's own filename/previous_filename, so both
// sides of a rename and deletions count — must be in the approval's sealed write set
// (GET /api/approvals/:id/write-set's resolver). Out-of-set test files only →
// `write_set_test_path_mismatch`; any out-of-set non-test path → `diff_outside_write_set`.
// Half an input or an unreadable write set → `diff_outside_write_set` with file null
// (fail-closed). ⛔ STRICT TENANT SEPARATION: the write set is ONLY ever read scoped to the
// PROJECT's tenant. No resolvable project tenant (a no_project board, or a project with no
// tenant) → `write_set_tenant_unresolved` (block class) and the write set is NEVER read; a
// cross-tenant approval id is the same refusal as a missing one. Absent both inputs: unchanged.
// The tenant refusal comes BEFORE any token mint, GitHub call or approval read. When the fence
// runs, the response carries `fence.head_sha` — the PR head read before AND after the file list
// (differ ⇒ 502) — so A5's landing signoff can bind "the fence passed at head X".
// Upstream failure (coding-github token mint, GitHub files API, Planka card
// lookup) is a 502, never a 200 — a gate that could not look must not look
// like one that looked and found nothing.
//
// Auth mirrors routes/notifications/dispatch.ts: validateAuth (licence bearer)
// then requireAnyInternalTenant — the four internal workspaces only; anyone
// else gets 404, not 403 (the surface stays private).
//
// The rule logic lives in services/constraint-check.ts (pure). This file only
// resolves the project, fetches the PR's files and renders the verdict.
//
// ⛔ The GitHub token minted by coding-github is never logged, returned or put
// in an error message.

import { freshProjectState } from '../services/catalogue/project-state';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { handle } from './assets/_lib/handler';
import { validateAuth } from '../middleware/auth';
import { requireAnyInternalTenant } from '../middleware/internal-tenant-only';
import { jsonResponse } from '../utils/response';
import { AppError, NotFoundError } from '../utils/errors';
import { db, projects, departments } from '../db/client';
import { isLiveProjectStatus } from '../lib/project-live-status';
import { plankaAsAgent } from '../services/planka/with-auth';
import { PlankaNotFoundError } from '../services/planka/errors';
import { requestCloneToken } from '../integrations/coding-github/client';
import { fetchPrHeadSha as fetchPrHeadShaFromGitHub, PrHeadUnavailableError } from '../services/repository-pins';
import {
  evaluateConstraints,
  hasCheckableConstraints,
  type ConstraintEvaluation,
  type ConstraintViolation,
  type PrFile,
} from '../services/constraint-check';
import {
  DIFF_OUTSIDE_WRITE_SET,
  WRITE_SET_TENANT_UNRESOLVED,
  WRITE_SET_TEST_PATH_MISMATCH,
  evaluateWriteSetFence,
  type WriteSetFenceOutcome,
} from '../lib/write-set';
import { resolveApprovalWriteSet, type WriteSetResolution } from '../services/approvals/write-set';
import { WriteSetPathsError, assertWriteSetPaths } from '../services/approvals/write-set-paths';

// ─── request contract ────────────────────────────────────────────────────────

/** Bound on `changed_paths`: GitHub's 3000-file ceiling × both sides of a rename. */
export const MAX_CHANGED_PATHS = 6000;

// GitHub owner/repo names: letters, digits, '-', '_', '.'. Constrained so the
// values cannot smuggle path segments into the API URL.
const ghName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine((s) => s !== '.' && s !== '..');

const constraintCheckSchema = z
  .object({
    card_id: z.string().min(1).max(64).optional(),
    project_id: z.string().uuid().optional(),
    owner: ghName,
    repo: ghName,
    pr_number: z.number().int().positive(),
    // U4 WRITE-SET FENCE (both optional; absent together ⇒ no fence, the pre-U4 contract).
    // Present ⇒ every changed path must be in the approval's sealed write set
    // (lib/write-set.ts). Either one WITHOUT the other is a fail-closed violation, never a
    // silent skip: a caller that sent half a fence asked for one.
    write_set_approval_id: z.string().uuid().optional(),
    // added ∪ modified ∪ deleted ∪ rename-old ∪ rename-new, as the caller computed them.
    // The gate UNIONS this with the PR's own file list (filename + previous_filename), so a
    // caller can never shrink the change set by omission.
    changed_paths: z.array(z.string().min(1).max(1024)).max(MAX_CHANGED_PATHS).optional(),
  })
  .refine((b) => !!b.project_id || !!b.card_id, {
    message: 'Provide project_id or card_id',
  });

/** GitHub's pulls/{n}/files endpoint returns at most 3000 files. */
const MAX_PR_FILES = 3000;
const PER_PAGE = 100;

// ─── reads ────────────────────────────────────────────────────────

/**
 * The check could not run because an upstream (coding-github, GitHub, Planka)
 * failed. fr's own 502 — the upstream's status is only ever in the message.
 * Extends AppError so handleError renders `{error}` with 502 on its own.
 */
class ConstraintCheckUpstreamError extends AppError {
  constructor(message: string) {
    super(502, message);
    this.name = 'ConstraintCheckUpstreamError';
  }
}

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Project row's id, owning tenant and raw `project_data.constraints`, or null
 * when absent. `tenantId` is null when the row carries no tenant at all.
 */
async function loadProjectFromDb(projectId: string) {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      project_data: projects.project_data,
      dept_tenant_id: departments.workspace_id,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const pd = (row.project_data ?? {}) as Record<string, unknown>;
  // Same resolution as routes/webhooks.ts tenantFromProjectRow: the dept →
  // workspace arm first, then the `keycloak_tenant_id` stamped at create time
  // (the arm that actually resolves in prod — dept_id is NULL estate-wide).
  // Blank is not a tenant.
  const stamped = typeof pd.keycloak_tenant_id === 'string' ? pd.keycloak_tenant_id.trim() : '';
  // The constraints are the BRIEF's (rm#213, George 2026-10-13: RM stores the
  // brief as versions, fr keeps no copy; constraints are fixed by version 1).
  // Read FRESH from RM. ⛔ FAIL CLOSED: a landing gate that cannot read the
  // requester's rules must not pass, so an RM failure is this route's 502.
  const tenantId = row.dept_tenant_id || stamped || null;
  // No tenant ⇒ no RM read (RM is never called tenantless): the write-set fence
  // below refuses an unresolved tenant (write_set_tenant_unresolved) anyway.
  if (!tenantId) return { id: row.id, tenantId: null, constraints: undefined };
  let constraints: unknown;
  try {
    constraints = (await freshProjectState({ id: row.id, name: row.name, project_data: row.project_data })).pm.brief
      ?.constraints;
  } catch (err) {
    throw new ConstraintCheckUpstreamError(
      `the project's brief (its constraints) could not be read from requirements_management (${
        (err as { code?: unknown }).code ?? (err instanceof Error ? err.name : typeof err)
      })`,
    );
  }
  return { id: row.id, tenantId, constraints };
}

/**
 * card → board (Planka, as the admin agent — the same lookup
 * lib/board-tenant-access.ts resolveCardBoardOrRefuse uses).
 */
export async function defaultGetCardBoardId(cardId: string): Promise<string | null> {
  let boardId: string | undefined;
  try {
    const card = await plankaAsAgent().cards.get(cardId);
    boardId = card.item?.boardId;
  } catch (err) {
    if (err instanceof PlankaNotFoundError) return null;
    throw new ConstraintCheckUpstreamError(`Planka card lookup failed (${err instanceof Error ? err.name : typeof err})`);
  }
  if (!boardId) throw new ConstraintCheckUpstreamError('Planka card lookup returned no boardId');
  return boardId;
}

/** Rows scanned per board: enough to find the live one(s) among reused-board history. */
const BOARD_PROJECT_SCAN_LIMIT = 50;

/**
 * board → project by projects.planka_board_id (the chain routes/execution-approvals.ts uses).
 *
 * LIVE WINS. `planka_board_id` is not unique, and a board is routinely reused by
 * a new project after the old one is archived — so the archived sibling must not
 * make the mapping ambiguous (502, every merge on the board blocked) or be the
 * one whose constraints get checked. When the board has any live project
 * (`isLiveProjectStatus`), only live projects count.
 *
 * ⛔ A board whose projects are ALL non-live still resolves to them, never to
 * `[]`: `[]` is `no_project`, which the landing gate answers 200 pass — dropping
 * an archived project's constraints would fail OPEN. A DELIVERED hunt project
 * stays resolvable the same way.
 *
 * Returns at most 2 ids — all the callers need to see ambiguity.
 */
export async function listProjectIdsForBoardFromDb(boardId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(eq(projects.planka_board_id, boardId))
    .limit(BOARD_PROJECT_SCAN_LIMIT);
  const live = rows.filter((r) => isLiveProjectStatus(r.status));
  return (live.length > 0 ? live : rows).slice(0, 2).map((r) => r.id);
}

type CardProjectResolution =
  | { status: 'card_not_found' }
  | { status: 'no_project' }
  | { status: 'found'; projectId: string };

const AMBIGUOUS_BOARD_MAPPING = 'ambiguous board→project mapping';

/** card → project, discriminated. Throws ConstraintCheckUpstreamError (502) on ambiguity. */
// The card's board comes from Planka (null = card not found, throw = upstream
// failure); the fr projects on that board from the DB (at most 2 — enough to
// detect ambiguity).
export async function resolveCardProject(cardId: string): Promise<CardProjectResolution> {
  const boardId = await defaultGetCardBoardId(cardId);
  if (!boardId) return { status: 'card_not_found' };
  const ids = [...new Set(await listProjectIdsForBoardFromDb(boardId))];
  if (ids.length === 0) return { status: 'no_project' };
  if (ids.length > 1) throw new ConstraintCheckUpstreamError(AMBIGUOUS_BOARD_MAPPING);
  return { status: 'found', projectId: ids[0]! };
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

interface FetchedFiles {
  files: PrFile[];
  truncated: boolean;
}

async function fetchPrFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | null,
): Promise<FetchedFiles> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fr-constraint-check',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const files: PrFile[] = [];
  for (let page = 1; page <= MAX_PR_FILES / PER_PAGE; page++) {
    const url =
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/files` +
      `?per_page=${PER_PAGE}&page=${page}`;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      // Name only: a fetch error message could echo request headers.
      throw new ConstraintCheckUpstreamError(`GitHub files API unreachable (${err instanceof Error ? err.name : typeof err})`);
    }
    if (res.status !== 200) {
      throw new ConstraintCheckUpstreamError(`GitHub files API returned HTTP ${res.status} for ${owner}/${repo}#${prNumber}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ConstraintCheckUpstreamError('GitHub files API returned an unreadable body');
    }
    if (!Array.isArray(body)) throw new ConstraintCheckUpstreamError('GitHub files API returned a non-array body');
    for (const f of body as Record<string, unknown>[]) {
      if (!f || typeof f.filename !== 'string') {
        throw new ConstraintCheckUpstreamError('GitHub files API returned an entry without a filename');
      }
      files.push({
        filename: f.filename,
        status: typeof f.status === 'string' ? f.status : 'modified',
        patch: typeof f.patch === 'string' ? f.patch : null,
        previous_filename: typeof f.previous_filename === 'string' ? f.previous_filename : null,
      });
    }
    if (body.length < PER_PAGE) return { files, truncated: false };
  }
  // Every page was full up to GitHub's 3000-file ceiling: the list may be cut.
  return { files, truncated: true };
}

/**
 * U4 / A5 binding — the PR's head commit, from `GET /repos/{o}/{r}/pulls/{n}` (`head.sha`). The
 * files endpoint does not carry it, so the route brackets the files read with two of these and
 * fails closed (502) if they differ: the file list and the SHA are then one snapshot.
 *
 * The GitHub read lives in `services/repository-pins.ts` (the create path resolves a PR pin the
 * same way); here its typed failure becomes this route's 502.
 */
async function fetchPrHeadSha(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | null,
): Promise<string> {
  try {
    return await fetchPrHeadShaFromGitHub(owner, repo, prNumber, token);
  } catch (err) {
    if (err instanceof PrHeadUnavailableError) throw new ConstraintCheckUpstreamError(err.message);
    throw err;
  }
}

// ─── handler ─────────────────────────────────────────────────────────────────

interface ConstraintCheckResponse extends ConstraintEvaluation {
  /** null only when the card's board has no fr project (reason 'no_project'). */
  project_id: string | null;
  reason?: 'no_project';
  owner: string;
  repo: string;
  pr_number: number;
  files_checked: number;
  /** Present iff the request carried a write-set fence input (U4). */
  write_set?: WriteSetCheck;
  /**
   * Present iff the fence RAN against the PR diff (a fence input was sent and a project tenant
   * resolved). A5's landing signoff binds "the fence passed at head X" to this.
   */
  fence?: FenceBinding;
}

interface FenceBinding {
  /** The PR head SHA, read immediately before AND after the file list (equal, else 502). */
  head_sha: string;
  /** |caller changed_paths ∪ PR filename ∪ PR previous_filename| — what was checked. */
  checked_paths_count: number;
  /** The resolved approval's id; null when the write set could not be read (a violation is listed). */
  write_set_approval_id: string | null;
  /** The resolved, re-verified seal; null when the write set could not be read. */
  write_set_seal: string | null;
}

interface WriteSetCheck {
  approval_id: string | null;
  /** null when the fence could not run (missing input / read failure) — then a violation is listed. */
  outcome: WriteSetFenceOutcome | null;
  offending: string[];
}

/**
 * U4 — the write-set fence's contribution to the verdict. Fail-closed: a missing input or a
 * write set that cannot be read is a `diff_outside_write_set` violation with file null; NO
 * project tenant is `write_set_tenant_unresolved` (block class) WITHOUT calling the reader —
 * there is no unscoped read. Out-of-set paths are one violation EACH: all
 * `write_set_test_path_mismatch` when every one is a test file (qa_needs_info class), else all
 * `diff_outside_write_set` (block class).
 */
async function writeSetViolations(
  input: {
    approvalId: string | undefined;
    changedPaths: string[] | undefined;
    files: PrFile[];
    /** The PROJECT's tenant; null = none resolvable (no project, or a project with no tenant). */
    scopeTenant: string | null;
  },
): Promise<{ violations: ConstraintViolation[]; check: WriteSetCheck; checkedPathsCount: number; seal: string | null }> {
  const changed = new Set<string>(input.changedPaths ?? []);
  for (const f of input.files) {
    changed.add(f.filename);
    if (f.previous_filename) changed.add(f.previous_filename);
  }
  const checkedPathsCount = changed.size;
  const fail = (detail: string, kind: string = DIFF_OUTSIDE_WRITE_SET) => ({
    violations: [{ kind, file: null, detail }],
    check: { approval_id: input.approvalId ?? null, outcome: null, offending: [] },
    checkedPathsCount,
    seal: null,
  });
  if (!input.approvalId) return fail('write_set_approval_id missing; cannot verify the change set');
  if (!input.changedPaths) return fail('changed_paths missing; cannot verify the change set');
  // ⛔ No project tenant ⇒ refuse. NEVER read the write set unscoped.
  if (input.scopeTenant === null) {
    return fail('no project tenant resolvable; the write set is only ever read tenant-scoped', WRITE_SET_TENANT_UNRESOLVED);
  }

  let r: WriteSetResolution;
  try {
    // U4: the approved, sealed write set (services/approvals/write-set.ts), ALWAYS tenant-scoped.
    r = await resolveApprovalWriteSet({ approvalId: input.approvalId, tenantId: input.scopeTenant });
  } catch (err) {
    return fail(`write set unreadable (${err instanceof Error ? err.name : typeof err}); cannot verify`);
  }
  if (!r.ok) return fail(`write set unavailable (${r.code}); cannot verify`);
  // The ONE path predicate (write-set-paths.ts), the same one the read route applies.
  try {
    assertWriteSetPaths(r.data.write_set);
  } catch (err) {
    if (!(err instanceof WriteSetPathsError)) throw err;
    return fail(`write set unavailable (${err.pathsCode}); cannot verify`);
  }

  const fence = evaluateWriteSetFence(r.data.write_set, changed);
  const check: WriteSetCheck = { approval_id: r.data.approval_id, outcome: fence.outcome, offending: fence.offending };
  const seal = r.data.write_set_seal;
  if (fence.outcome === 'in_set') return { violations: [], check, checkedPathsCount, seal };
  const kind = fence.outcome === WRITE_SET_TEST_PATH_MISMATCH ? WRITE_SET_TEST_PATH_MISMATCH : DIFF_OUTSIDE_WRITE_SET;
  return {
    violations: fence.offending.map((p) => ({
      kind,
      file: p,
      detail: `${p} is not in the approved write set of approval ${r.data.approval_id} (${r.data.source})`,
    })),
    check,
    checkedPathsCount,
    seal,
  };
}

export async function handleConstraintCheck(req: Request): Promise<Response> {
  await validateAuth(req);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Validation error', details: [{ message: 'Invalid JSON body' }] }, 422);
  }
  const parsed = constraintCheckSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'Validation error', details: parsed.error.errors }, 422);
  }
  const body = parsed.data;

  return handle(
    async (): Promise<Response> => {
      requireAnyInternalTenant('fr-project-constraint-check');
      // U4: a fence was asked for if EITHER input is present (a half-fence fails closed).
      const fenceRequested = body.write_set_approval_id !== undefined || body.changed_paths !== undefined;

      try {
        let projectId: string | null;
        if (body.project_id) {
          projectId = body.project_id;
        } else {
          const resolved = await resolveCardProject(body.card_id as string);
          if (resolved.status === 'card_not_found') throw new NotFoundError('Card not found');
          if (resolved.status === 'no_project' && !fenceRequested) {
            // Not an fr project board: nothing to enforce. Must NOT block.
            const r: ConstraintCheckResponse = {
              project_id: null,
              owner: body.owner,
              repo: body.repo,
              pr_number: body.pr_number,
              files_checked: 0,
              verdict: 'pass',
              violations: [],
              unchecked: [],
              reason: 'no_project',
            };
            return jsonResponse(r);
          }
          // no_project WITH a fence: no project tenant to scope the write-set read by, so the
          // fence refuses below (write_set_tenant_unresolved). It must NOT silently pass.
          projectId = resolved.status === 'found' ? resolved.projectId : null;
        }
        const project = projectId === null ? null : await loadProjectFromDb(projectId);
        if (projectId !== null && !project) throw new NotFoundError('Project not found');

        // ⛔ DO NOT "fix" the metering attribution here with
        // `attributeRequestTo({ tenantId: project.tenantId })`. It was proposed
        // off this warning —
        //   "[usage-spans] metering span emitted with NO tenant for
        //    POST /api/projects/constraint-check … publish it with
        //    attributeRequestTo()"
        // — read as "this route resolves a project but meters to the nil
        // tenant". MEASURED (by temporarily adding exactly that call: every
        // assertion unchanged):
        //
        //  1. `requireAnyInternalTenant()` above reads `getTenantId()`, which is
        //     the SAME `requestContext` field `withUsageSpans` meters from. The
        //     gate admitting the request and the span being attributed are ONE
        //     fact — so by the time a project can be resolved, `ctx.tenantId`
        //     is always one of the four internal tenants.
        //  2. `attributeRequestTo` is FILL-IF-EMPTY by design
        //     (integrations/_lib/context.ts) and refuses to displace a
        //     bearer-derived tenant. The call would be an unconditional no-op here.
        //  3. An unattributed span for THIS route is therefore a REFUSAL (401
        //     no/invalid bearer, 404 non-internal tenant) — both of which
        //     return before `loadProject` is ever called, so there is no
        //     project whose tenant could have been published. Attributing a
        //     refused request would bill someone for a request we rejected.
        //
        // The genuinely tenantless residue is correct and must stay: a card
        // whose board has no fr project (the `no_project` branch above, which
        // never loads a project at all) and a project row with `tenantId`
        // null have nothing truthful to attribute to. Inventing a value there
        // is the failure `lib/project-owner-guard.ts` calls "refuse, don't
        // coerce". `project.tenantId` is used below for coding-github AUTHZ,
        // which is a different question from who is BILLED.

        const base = {
          project_id: project?.id ?? null,
          ...(project ? {} : { reason: 'no_project' as const }),
          owner: body.owner,
          repo: body.repo,
          pr_number: body.pr_number,
        };
        const constraints = project?.constraints ?? null;
        // ⛔ The write set is read ONLY in the PROJECT's tenant. No project, or a project with no
        // tenant, is null ⇒ write_set_tenant_unresolved; there is no unscoped read.
        const scopeTenant: string | null = project?.tenantId ?? null;

        // A fence with no project tenant (no project, OR a project whose tenantId is null): fail
        // closed BEFORE any token mint, GitHub read or approval read — there is no tenant to act
        // as, and nothing a diff could change about the refusal. (`!project` implies a fence: the
        // no-fence no_project case returned above.)
        if (!project || (fenceRequested && scopeTenant === null)) {
          const ws = await writeSetViolations({
            approvalId: body.write_set_approval_id,
            changedPaths: body.changed_paths,
            files: [],
            scopeTenant: null,
          });
          const r: ConstraintCheckResponse = {
            ...base,
            files_checked: 0,
            verdict: 'violation',
            violations: ws.violations,
            unchecked: [],
            write_set: ws.check,
          };
          return jsonResponse(r);
        }

        // Nothing enforceable → no need to read the diff (and no upstream to fail) — unless the
        // write-set fence was asked for: it is evaluated against the PR's own file list.
        if (!fenceRequested && !hasCheckableConstraints(constraints)) {
          const r: ConstraintCheckResponse = {
            ...base,
            files_checked: 0,
            ...evaluateConstraints(constraints, []),
          };
          return jsonResponse(r);
        }

        let token: string | null;
        try {
          // pr-read: GET /pulls/{n}/files needs pull_requests:read, not just contents. `tenantId` is
          // the RESOLVED PROJECT's tenant — never the caller's (the caller is n8n's internal
          // identity); coding-github answers `tenant_required` without it for a non-internal owner.
          const t = await requestCloneToken(`https://github.com/${body.owner}/${body.repo}`, {
            scope: 'pr-read',
            tenantId: project.tenantId,
          });
          // ⛔ coding-github's platform-repo tenant gate. It refuses on a 200
          // (`token: null`, `reason: platform_repo_forbidden`), so without this
          // branch it read as "no GitHub token available" — an upstream fault
          // the reader would go and investigate on coding-github's side. It is
          // not a fault: the repo is platform-owned and THIS PROJECT'S tenant
          // is not in CODING_GITHUB_PLATFORM_TENANTS. The refusal still blocks
          // (an unread diff can never be declared constraint-clean) and the
          // status stays 502 so the n8n caller's contract is unchanged — only
          // the diagnosis is corrected.
          //
          // ⚠️ Gated on the SAME `not public` precondition as the branch below,
          // deliberately. coding-github resolves visibility anonymously even
          // when it refuses to mint, so a PUBLIC platform repo comes back
          // `visibility: 'public', token: null, reason: platform_repo_forbidden`
          // and its diff is still readable without any credential. Firing on
          // the reason alone would turn a check that works today into a 502.
          // `verdictFromCloneToken` orders its branches the same way.
          if (t.reason === 'platform_repo_forbidden' && t.visibility !== 'public') {
            throw new ConstraintCheckUpstreamError(
              `${body.owner}/${body.repo} is a platform-owned repository and this project's ` +
                `tenant (${project.tenantId ?? 'none'}) may not act on it — the PR diff could not be read ` +
                '(platform_repo_forbidden)',
            );
          }
          if (!t.token && t.visibility !== 'public') {
            throw new ConstraintCheckUpstreamError(
              `no GitHub token available for private repository ${body.owner}/${body.repo}` +
                (t.reason ? ` (${t.reason})` : ''),
            );
          }
          token = t.token;
        } catch (err) {
          if (err instanceof ConstraintCheckUpstreamError) throw err;
          // CodingGithub* errors are token-free by construction (client.ts header).
          throw new ConstraintCheckUpstreamError(
            `GitHub token mint failed: ${err instanceof Error ? err.message : typeof err}`,
          );
        }

        // U4/A5: with a fence, bracket the file list between two head reads so the SHA we return
        // and the list we checked are ONE snapshot; a push in between fails closed (502).
        const headBefore = fenceRequested ? await fetchPrHeadSha(body.owner, body.repo, body.pr_number, token) : null;
        const { files, truncated } = await fetchPrFiles(body.owner, body.repo, body.pr_number, token);
        if (headBefore !== null) {
          const headAfter = await fetchPrHeadSha(body.owner, body.repo, body.pr_number, token);
          if (headAfter !== headBefore) {
            throw new ConstraintCheckUpstreamError(
              `PR head moved during the check (${headBefore} → ${headAfter}); the file list is not a single snapshot`,
            );
          }
        }
        token = null;

        const evaluation = evaluateConstraints(constraints, files);
        if (truncated) {
          evaluation.violations.push({
            kind: 'check_error',
            file: null,
            detail: `too many files to verify (GitHub lists at most ${MAX_PR_FILES})`,
          });
          evaluation.verdict = 'violation';
        }
        let writeSet: WriteSetCheck | undefined;
        let fenceBinding: FenceBinding | undefined;
        if (fenceRequested) {
          const ws = await writeSetViolations({
            approvalId: body.write_set_approval_id,
            changedPaths: body.changed_paths,
            files,
            scopeTenant,
          });
          writeSet = ws.check;
          fenceBinding = {
            head_sha: headBefore as string,
            checked_paths_count: ws.checkedPathsCount,
            write_set_approval_id: ws.seal === null ? null : ws.check.approval_id,
            write_set_seal: ws.seal,
          };
          if (ws.violations.length > 0) {
            evaluation.violations.push(...ws.violations);
            evaluation.verdict = 'violation';
          }
        }
        const r: ConstraintCheckResponse = {
          ...base,
          files_checked: files.length,
          ...evaluation,
          ...(writeSet ? { write_set: writeSet } : {}),
          ...(fenceBinding ? { fence: fenceBinding } : {}),
        };
        return jsonResponse(r);
      } catch (err) {
        if (err instanceof ConstraintCheckUpstreamError) {
          console.error('[constraint-check] upstream failure:', err.message);
          return jsonResponse({ error: err.message }, 502);
        }
        throw err;
      }
    },
    (res) => res,
  );
}
