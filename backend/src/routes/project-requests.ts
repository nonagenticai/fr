// src/routes/project-requests.ts
//
// The CP→fr bridge RECEIVING half (commonpractice PLAN-PHASE5.D § fr-side).
// Common Practice forwards a winning solution to fr as a DRAFT project_request
// a human reviews/edits/approves before fr/n8n/kanban act. Two surfaces:
//
//   1. POST /api/project-requests            — bridge intake (SA-authed). Creates
//      a DRAFT only — NO Planka board, NO n8n. Idempotent on (tenant, external_ref).
//   2. GET/PATCH/approve/reject              — the human review surface (user-authed,
//      tenant-scoped). Approve runs the SHARED `createProjectCore` so the promoted
//      project is byte-identical to POST /api/projects (and only then fires n8n).
//
// The intake body matches the CP adapter wire contract exactly
// (commonpractice/backend/src/host/delivery/fr.ts):
//   { external_ref, external_origin, payload }  with two-token auth, and the
//   success response carries `project_request_id` (CP records `draft_created`).

import { assertConveyorConfigured, conveyorNotConfiguredResponse } from '../lib/conveyor-configured-gate';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, notInArray, TransactionRollbackError } from 'drizzle-orm';
import {
  appendHistorySql,
  type HistoryEntry,
} from './project-request-history';
import { db, projectRequests } from '../db/client';
// Migration 127's tables are not re-exported by db/client; imported from the
// schema module directly, exactly as routes/project-request-lifecycle.ts does
// for `projectOutlines`.
import { projectDeliverables, projectMilestones, projectOutlines, projects } from '../db/schema';
import { config } from '../config';
import { notifyCpPromoted } from '../connectors/commonpractice-feedback';
import {
  ProjectCreateFields,
  ProjectCreateSchema,
  MilestoneSchema,
  OutlineDeliverableSchema,
  type OutlineDeliverable,
} from '../types/api';
import { validateAuth } from '../middleware/auth';
import { requireBridgeWriter } from '../middleware/bridge-auth';
import { ctxTenantId } from '../middleware/request-context';
import { isUuidShape } from '../lib/uuid-shape';
import { projectTypes, type CatalogueProjectType } from '../services/catalogue/tenant-catalogue';
import { BadRequestError, NotFoundError, ValidationError } from '../utils/errors';
import { AppError } from '../utils/errors';
import { clientSafeCaughtErrorText } from '../integrations/_lib/errors';
import { jsonResponse, createdResponse } from '../utils/response';
import { sendWorkerMessage } from '../integrations/workers';
import {
  createSingleProject,
  shouldOrchestrateProjectStart,
  ProjectCreateError,
} from './projects';
import { EXECUTION_TENANT_ID } from '../middleware/internal-tenant-only';
import { PHASE_PLAN_GATE_UNKNOWN, planGateUnknownSlugs, storedPhasePlan } from '../lib/phase-plan';
import { RequesterRequestBitsSchema, mergeRequestBits, requestBitVector } from '../lib/request-bits';
import {
  projectStartTemplateRequired,
  type ProjectStartTemplate,
} from '../lib/project-start-template';
import {
  FR_REPO_SENTINEL,
  collectRequestRepoUrls,
  loadRequestRepositories,
  platformRepoRefusalResponse,
  repoAccessGateResponse,
} from './project-request-repo-gate';

// Approve reuses the SAME shared project-creation engine the create + bulk
// routes use (`routes/projects.ts createSingleProject`) so a promoted request is
// byte-identical to POST /api/projects — no divergent code path.

// CP posts this sentinel when it cannot derive a repository (a valid URL so the
// draft is creatable). A repository is OPTIONAL (George 2026-10-13), but the
// sentinel means "fill this in": APPROVE/SUBMIT reject it (422) when PROVIDED,
// while an omitted repository_url is accepted. Defined in the shared repo gate.
export { FR_REPO_SENTINEL };

// The bridge intake envelope. `payload` is the canonical fr-mapped ProjectCreate;
// at intake `repository_url` may be the sentinel (a valid URL) or omitted.
//
// ⛔ THE `withRepoScopeCoherence` WRAPPER IS REMOVED (2026-09-30) — DO NOT
// RESTORE IT. This was the THIRD attachment site (the other two were on
// `ProjectCreateSchema` and `ProjectRequestSchema` in types/api.ts), and the
// helper no longer exists: types/api.ts:421-449 deletes it and every predicate
// with it. The rule bound `scope_level` to repository count in BOTH directions,
// and the second direction — >1 repo requires `scope_level === 'multi_repo'` —
// REFUSED the ordinary case of two repos at granularity 'module'. `scope_level`
// is a granularity vocabulary, orthogonal to repo count, and is now DERIVED from
// that count in routes/projects.ts. What a multi-repo project declares about
// itself is `coordination_mode`.
//
// ⚠️ The field extension it wrapped is PRESERVED verbatim and is the only thing
// this door still adds over the shared field set: intake may omit
// `repository_url` (or send the CP sentinel), which the approve/submit gates
// then refuse. `.extend()` needs the raw ZodObject, which is why this reads
// `ProjectCreateFields` and not `ProjectCreateSchema`.
const ProjectRequestIntakeSchema = ProjectCreateFields.extend({
  repository_url: z.string().url().nullish(),
});

const IntakeBodySchema = z.object({
  external_ref: z
    .union([z.string().min(1), z.number()])
    .transform((v) => String(v)),
  external_origin: z.record(z.string(), z.unknown()).optional(),
  payload: z.record(z.string(), z.unknown()),
});


// ---------------------------------------------------------------------------
// Conversational intake (D5) — single-turn NL→brief extraction.
// ---------------------------------------------------------------------------
//
// A user types a free-text project description; one single-turn worker call
// (NOT an agent tool-loop — workers stay single-turn per the AA non-agentic
// philosophy) translates it into a structured ProjectCreate, which is landed as
// a DRAFT the human then reviews/approves through the EXISTING queue. Approval
// routes through the shared createSingleProject, so the *_start_request_analysis
// card (P-SYS-09 IO-Map) is guaranteed for orchestrated (feature/it EXEC) types
// (createSingleProject is the ONLY create door — the AG-UI `agent.create_project`
// verb that bypassed it is retired, George v4).

const INTAKE_WORKER_NAME = 'intake_project_brief_extraction';

// The subset of ProjectCreate the extraction fills from free text. Auto-created
// worker validates its output against this JSON Schema (WM output_schema).
// Exported so a unit test can pin the property set. `additionalProperties:
// false` makes this schema a closed allow-list, i.e. the thing that decides
// which fields a natural-language intake can EVER populate; a field silently
// missing from it is indistinguishable from a field the user never mentioned.
//
// ⛔ project_type is the REQUESTING TENANT's RM vocabulary, never an fr constant:
// the enum and the prompt list are built per request from
// `projectTypes(tenantId)` (services/catalogue/tenant-catalogue.ts). A tenant
// with no catalogue is `catalogue_not_initialised` (409) before any LLM call.
export function intakeExtractionSchema(
  types: ReadonlyArray<Pick<CatalogueProjectType, 'name'>>,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'A short project name (<=255 chars).' },
      description: { type: 'string', description: 'One-line summary of the project.' },
      project_type: {
        type: 'string',
        enum: types.map((t) => t.name),
        description:
          "The tenant's project type that best fits the request (one of the listed names). Omit when no type clearly fits.",
      },
      problem_statement: { type: 'string' },
      desired_outcome: { type: 'string' },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      success_criteria: { type: 'array', items: { type: 'string' } },
      // The four project-definition scope lists. ⚠️ LOAD-BEARING, not cosmetic:
      // `additionalProperties: false` above means a key absent from this schema is
      // silently DROPPED from the worker's output, so an intake text that states
      // its scope would have had that scope discarded here. They are read by
      // `scopeFieldsForBrief` / `BRIEF_SCOPE_FIELDS` (routes/projects.ts), which
      // delivers them into both agent briefs. None is required — the system prompt
      // already says to leave anything unstated empty, and an invented scope is
      // worse than an absent one.
      in_scope: { type: 'array', items: { type: 'string' } },
      out_of_scope: { type: 'array', items: { type: 'string' } },
      high_level_requirements: { type: 'array', items: { type: 'string' } },
      assumptions: { type: 'array', items: { type: 'string' } },
      repository_url: {
        type: 'string',
        description:
          'The git repository URL ONLY if the user explicitly named one; otherwise omit — never invent a URL.',
      },
    },
    required: ['name'],
  };
}

/** The extraction system prompt, listing the tenant's project types (name — title: description). */
function intakeSystemPrompt(
  types: ReadonlyArray<Pick<CatalogueProjectType, 'name' | 'title' | 'description'>>,
): string {
  const list = types
    .map((t) => {
      const desc = typeof t.description === 'string' && t.description.trim() ? `: ${t.description.trim()}` : '';
      return `"${t.name}" (${t.title})${desc}`;
    })
    .join('; ');
  return [
    'You translate a free-text project request into a structured project brief.',
    'Return ONLY fields you can ground in the text; leave anything unstated empty.',
    `Infer project_type as exactly one of this workspace's project types: ${list}. Omit project_type when none clearly fits.`,
    'NEVER invent a repository URL — omit repository_url unless the user named a real repo.',
    'Do not add commentary; emit only the structured object.',
  ].join(' ');
}

/** What the extraction is told, built per request from the tenant catalogue. */
interface ExtractBriefSpec {
  system_prompt: string;
  output_schema: Record<string, unknown>;
}

async function realExtractBrief(text: string, spec: ExtractBriefSpec): Promise<Record<string, unknown>> {
  const res = await sendWorkerMessage(INTAKE_WORKER_NAME, {
    message: text,
    system_prompt: spec.system_prompt,
    output_schema: spec.output_schema,
    // Ephemeral: don't persist auto-created-worker state for a stateless extract.
    disable_state_storage: true,
  });
  const out = res.output;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    return out as Record<string, unknown>;
  }
  throw new Error('intake extraction returned no structured object');
}

const DraftFromTextBodySchema = z.object({
  text: z.string().min(1).max(20_000),
  name: z.string().min(1).max(255).optional(),
});

/**
 * The fr table a failed DB write targeted, or null when the error is not a DB
 * write. Reads the postgres driver's `table_name` first, then drizzle's
 * `Failed query: insert into "<table>"` wrapper (which drops the driver fields).
 * Only a bare identifier is returned — never the SQL text or its bound values.
 */
function failedWriteTable(err: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const table = (cur as { table_name?: unknown }).table_name;
    if (typeof table === 'string' && /^[a-z_][a-z0-9_]*$/i.test(table)) return table;
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === 'string') {
      const m = /\b(?:insert into|update|delete from)\s+"([a-z_][a-z0-9_]*)"/i.exec(msg);
      if (m?.[1]) return m[1];
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function computeMissingRequired(
  payload: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  // A repository is OPTIONAL (George 2026-10-13): an ABSENT repository_url is
  // not missing. Only the CP sentinel is — it means "fill this in", and approve
  // refuses it (422 repository_url_required).
  if (payload.repository_url === FR_REPO_SENTINEL) {
    missing.push('repository_url');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 1. POST /api/project-requests — bridge intake (SA-authed, idempotent draft).
// ---------------------------------------------------------------------------
export async function handleCreateProjectRequest(req: Request): Promise<Response> {
  // ⛔ v4 wiring gate (George 2026-10-13), FIRST — before auth, which can upsert
  // the caller's user row, and before any DB/RM/Planka side effect.
  const notConfigured = conveyorNotConfiguredResponse();
  if (notConfigured) return notConfigured;
  const { tenantId, subjectId } = await requireBridgeWriter(req);

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const { external_ref, external_origin, payload } = IntakeBodySchema.parse(raw);

  // Validate the envelope payload is a creatable ProjectCreate (sentinel url ok).
  const validatedPayload = ProjectRequestIntakeSchema.parse(payload);

  // ⛔ PLATFORM-REPO OWNERSHIP GATE (ruling 2026-09-30), before any write: a
  // non-platform tenant may not store an internal-owner repo, public or not.
  const refused = platformRepoRefusalResponse(
    collectRequestRepoUrls(validatedPayload),
    tenantId,
  );
  if (refused) return refused;

  const source =
    external_origin && typeof external_origin.source === 'string'
      ? external_origin.source
      : 'commonpractice';

  const now = new Date();
  const [existing] = await db
    .select()
    .from(projectRequests)
    .where(
      and(
        eq(projectRequests.tenant_id, tenantId),
        eq(projectRequests.external_ref, external_ref),
      ),
    );

  if (existing) {
    // A promoted request is immutable — a re-post means the upstream lost track
    // of an already-created project. Surface the project id rather than dup.
    if (existing.status === 'promoted') {
      return jsonResponse(
        {
          error: 'project_request_already_promoted',
          project_request_id: existing.id,
          project_id: existing.project_id,
          status: existing.status,
        },
        409,
      );
    }
    // draft / failed / rejected / approved → update + reopen to draft.
    const [updated] = await db
      .update(projectRequests)
      .set({
        source,
        external_origin: external_origin ?? null,
        payload: validatedPayload,
        status: 'draft',
        rejection_reason: null,
        error: null,
        created_by: subjectId ?? existing.created_by,
        updated_at: now,
        history: appendHistorySql({
          at: now.toISOString(),
          action: 're_posted',
          by: subjectId,
          from_status: existing.status,
        }),
      })
      .where(eq(projectRequests.id, existing.id))
      .returning();
    return jsonResponse(
      { project_request_id: updated!.id, status: updated!.status },
      200,
    );
  }

  const [created] = await db
    .insert(projectRequests)
    .values({
      tenant_id: tenantId,
      source,
      external_ref,
      external_origin: external_origin ?? null,
      payload: validatedPayload,
      status: 'draft',
      created_by: subjectId,
      history: [
        { at: now.toISOString(), action: 'created', by: subjectId },
      ] as HistoryEntry[],
    })
    .returning();

  return createdResponse({
    project_request_id: created!.id,
    status: created!.status,
  });
}

// ---------------------------------------------------------------------------
// 2. POST /api/project-requests/draft-from-text — conversational intake (D5).
//    User-authed, tenant-scoped. Free text → single-turn worker extraction →
//    DRAFT project_request. The reviewer edits/approves via the existing queue.
// ---------------------------------------------------------------------------
export async function handleCreateProjectRequestFromText(
  req: Request,
): Promise<Response> {
  // ⛔ v4 wiring gate (George 2026-10-13), FIRST — before auth, which can upsert
  // the caller's user row, and before any DB/RM/Planka side effect.
  const notConfigured = conveyorNotConfiguredResponse();
  if (notConfigured) return notConfigured;
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const { text, name } = DraftFromTextBodySchema.parse(raw);

  // The tenant's RM project types drive the schema enum + prompt list. No
  // catalogue ⇒ CatalogueNotInitialised (409) before any LLM call.
  const types = await projectTypes(tenantId);
  const spec: ExtractBriefSpec = {
    system_prompt: intakeSystemPrompt(types),
    output_schema: intakeExtractionSchema(types),
  };

  // Single-turn extraction. A worker/upstream failure must NOT write a partial
  // row — surface 502 so the user retries against a clean slate.
  let extracted: Record<string, unknown>;
  try {
    extracted = await realExtractBrief(text, spec);
  } catch (err) {
    console.warn('[project-requests.draft] brief extraction failed:', err);
    const detail = clientSafeCaughtErrorText(err, 'brief extraction failed — try again');
    return jsonResponse({ error: 'intake_extraction_failed', detail }, 502);
  }

  // Coerce the extraction into a creatable (sentinel-tolerant) ProjectCreate.
  // The worker may omit fields; fill the required ones so the draft validates and
  // the reviewer supplies the real repo at approval.
  const draftInput: Record<string, unknown> = { ...extracted };
  const extractedName =
    typeof extracted.name === 'string' && extracted.name.trim()
      ? extracted.name.trim()
      : undefined;
  const chosenName = name ?? extractedName;
  if (!chosenName) {
    throw new ValidationError(
      'could not derive a project name from the text — provide a name',
      { code: 'name_required' },
    );
  }
  draftInput.name = chosenName.slice(0, 255);
  // A repository is OPTIONAL (George 2026-10-13): no repo named ⇒ the key is
  // dropped, never replaced by the CP sentinel (which means "fill this in" and
  // would block approval of a project that legitimately has no repo).
  if (
    typeof draftInput.repository_url !== 'string' ||
    !draftInput.repository_url
  ) {
    delete draftInput.repository_url;
  }

  let validatedPayload: z.infer<typeof ProjectRequestIntakeSchema>;
  try {
    validatedPayload = ProjectRequestIntakeSchema.parse(draftInput);
  } catch (err) {
    // The extraction produced an unusable brief (wrong field types). Treat as an
    // extraction failure, not a client error — no row written.
    const detail = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { error: 'intake_extraction_failed', detail },
      502,
    );
  }

  // ⛔ PLATFORM-REPO OWNERSHIP GATE — the extraction may have lifted a repo url
  // out of the free text; refuse before the draft row is written.
  const refused = platformRepoRefusalResponse(
    collectRequestRepoUrls(validatedPayload),
    tenantId,
  );
  if (refused) return refused;

  const now = new Date();
  const [created] = await db
    .insert(projectRequests)
    .values({
      tenant_id: tenantId,
      source: 'conversational',
      external_ref: `conversational:${randomUUID()}`,
      external_origin: { source: 'conversational', created_by: user.id },
      payload: validatedPayload,
      status: 'draft',
      created_by: user.id,
      history: [
        {
          at: now.toISOString(),
          action: 'created',
          by: user.id,
          detail: 'conversational_intake',
        },
      ] as HistoryEntry[],
    })
    .returning();

  const missing_required = computeMissingRequired(
    created!.payload as Record<string, unknown>,
  );
  // Compute the honest advisory from the REAL gate (this path knows the
  // requester's tenant) rather than a type-only mirror that would drift after
  // the 2026-07-07 widening (every EXEC-tenant project now orchestrates).
  const willRunAnalysis = shouldOrchestrateProjectStart({
    projectType:
      typeof validatedPayload.project_type === 'string'
        ? validatedPayload.project_type
        : undefined,
    cveSweep:
      typeof validatedPayload.cve_sweep === 'boolean'
        ? validatedPayload.cve_sweep
        : undefined,
    tenantId,
    execTenantId: EXECUTION_TENANT_ID,
  });

  return createdResponse({
    project_request_id: created!.id,
    status: created!.status,
    payload: created!.payload,
    missing_required,
    will_run_analysis: willRunAnalysis,
  });
}

// ---------------------------------------------------------------------------
// Human review surface — user-authed, tenant-scoped.
// ---------------------------------------------------------------------------
export async function loadOwnedRequest(req: Request, id: string) {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  const row = await loadRequestInTenant(tenantId, id);
  return { user, tenantId, row };
}

/**
 * The tenant-scoped request load behind `loadOwnedRequest`, for a caller that
 * already resolved its tenant (the agent's `project_requests.*` reads,
 * agui/actions/project-requests.ts) — the SAME query and the SAME 404.
 */
export async function loadRequestInTenant(tenantId: string, id: string) {
  // `project_requests.id` is a `uuid` column (schema.ts:193), so a `:id` segment
  // that is not UUID-shaped never returns zero rows — it aborts the query with
  // 22P02 `invalid input syntax for type uuid` and escapes as a bare 500. Answer
  // the SAME 404 a well-formed-but-absent id gets below: a distinct status would
  // hand a prober a free oracle for telling malformed from absent, defeating the
  // don't-leak-existence contract this helper exists to hold. `isUuidShape`, not
  // `isValidUuid` (utils/tenant) — that one pins the version/variant nibbles and
  // would 404 legal `uuid` literals naming rows that genuinely exist.
  if (!isUuidShape(id)) {
    throw new NotFoundError('Project request not found');
  }
  const [row] = await db
    .select()
    .from(projectRequests)
    .where(
      and(eq(projectRequests.id, id), eq(projectRequests.tenant_id, tenantId)),
    );
  if (!row) {
    // Same 404 whether the row is in another tenant or genuinely missing.
    throw new NotFoundError('Project request not found');
  }
  return row;
}

// GET /api/project-requests — list this tenant's requests (newest first).
export async function handleListProjectRequests(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const rows = await listProjectRequestRows(ctxTenantId(user.tenantId));
  return jsonResponse({ items: rows, total: rows.length });
}

/** This tenant's requests, newest first — the list route's query, shared with the agent's read. */
export async function listProjectRequestRows(tenantId: string) {
  return db
    .select()
    .from(projectRequests)
    .where(eq(projectRequests.tenant_id, tenantId))
    .orderBy(desc(projectRequests.created_at));
}

// GET /api/project-requests/:id
export async function handleGetProjectRequest(
  req: Request,
  id: string,
): Promise<Response> {
  const { row } = await loadOwnedRequest(req, id);
  const { repositories, request_bit_vector } = await projectRequestDetailParts(row);
  return jsonResponse({ ...row, repositories, request_bit_vector });
}

/** The GET's response body for one loaded row — shared with the agent's `project_requests.get`. */
export async function projectRequestDetail(row: Awaited<ReturnType<typeof loadRequestInTenant>>) {
  const { repositories, request_bit_vector } = await projectRequestDetailParts(row);
  return { ...row, repositories, request_bit_vector };
}

/** The two fields the GET adds to a loaded row (repo set + bit vector). */
async function projectRequestDetailParts(row: Awaited<ReturnType<typeof loadRequestInTenant>>) {
  // ⭐ THE STAGE-A REPO SET, WITH THE RECORDED PER-REPO VERDICT.
  //
  // The review page reconstructed this list out of `payload`
  // (frontend/src/routes/projects/requests/[id]/+page.svelte), which can show
  // WHICH repositories a request names but never WHY one was refused — the gate
  // computed that per repo and, until this change, threw it away, so a reviewer
  // had to re-probe GitHub to find out. `access_state` / `access_detail` /
  // `access_checked_at` are the recorded verdict; a request that has never been
  // submitted simply has no rows yet, which is honest rather than empty.
  const repositories = await loadRequestRepositories(row.id);
  // U-PS-S0: the full discriminating bit vector — stored bits (NULL ⇒ every bit unknown) +
  // repo_count computed from THIS repo set, so it can never drift from the repos.
  const request_bit_vector = requestBitVector(
    row.request_bits,
    collectRequestRepoUrls(row.payload, repositories),
  );
  return { repositories, request_bit_vector };
}

// PATCH /api/project-requests/:id — edit the payload while draft/failed.
export async function handlePatchProjectRequest(
  req: Request,
  id: string,
): Promise<Response> {
  const { user, row } = await loadOwnedRequest(req, id);
  if (row.status !== 'draft' && row.status !== 'failed') {
    throw new ValidationError(
      `project request can only be edited while draft or failed (is '${row.status}')`,
      { code: 'project_request_not_editable' },
    );
  }
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  // ⚠️ `.partial()` needs the raw ZodObject, and the coherence rule is
  // DELIBERATELY not attached to a patch: a PATCH may legitimately carry only
  // `scope_level` or only `repo`, so judging coherence on the fragment would
  // reject an edit that makes the merged payload coherent. The merged payload is
  // re-validated through the full `ProjectCreateSchema` on approve (:604 below),
  // which is where the rule bites — nothing reaches a project without passing it.
  const patch = ProjectCreateFields.partial().parse(raw);
  // U-PS-S0: OPTIONAL structured request bits, a top-level key BESIDE the payload fields
  // (never inside `payload`, which flows into the project). A requester may write only
  // bit_source 'form' | 'unknown' (422 on 'extracted', the ZodError mapping every PATCH validation gets); absent ⇒ untouched, exactly as before.
  const rawBits =
    raw && typeof raw === 'object' && 'request_bits' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).request_bits
      : undefined;
  const bitsPatch = rawBits === undefined ? undefined : RequesterRequestBitsSchema.parse(rawBits);

  const mergedPayload = {
    ...(row.payload as Record<string, unknown>),
    ...patch,
  };
  // ⛔ PLATFORM-REPO OWNERSHIP GATE over the MERGED payload, judged against the
  // request's OWNING tenant — before the write.
  const refused = platformRepoRefusalResponse(
    collectRequestRepoUrls(mergedPayload),
    row.tenant_id,
  );
  if (refused) return refused;
  const now = new Date();
  const [updated] = await db
    .update(projectRequests)
    .set({
      payload: mergedPayload,
      ...(bitsPatch !== undefined ? { request_bits: mergeRequestBits(row.request_bits, bitsPatch) } : {}),
      updated_at: now,
      history: appendHistorySql({
        at: now.toISOString(),
        action: 'edited',
        by: user.id,
        detail: [...Object.keys(patch), ...(bitsPatch !== undefined ? ['request_bits'] : [])].join(','),
      }),
    })
    .where(eq(projectRequests.id, id))
    .returning();
  return jsonResponse(updated);
}

/**
 * `projects.coordination_mode` (migration 143) — whether the repositories a
 * multi-repo project names are delivered together or independently. Repo COUNT
 * cannot express it, which is why it survived the deletion of the repo↔scope
 * coherence rule that count-based `scope_level` did not.
 *
 * ONE reader, used by both roads that carry the value: the approve path (below,
 * onto the project row) and submit's analysis webhook
 * (routes/project-request-lifecycle.ts). Two readers that could disagree would
 * hand n8n a different mode from the one the project row ends up with.
 *
 * ⚠️ TAKES `unknown` DELIBERATELY. On approve it reads the zod-validated body,
 * where `ProjectCreateFields.coordination_mode` (types/api.ts:247) has already
 * applied its `'coordinated'` default. On the webhook it reads a STORED payload,
 * which for any request created before that key existed carries no
 * `coordination_mode` at all. Anything that is not one of the two values
 * `projects_coordination_mode_check` permits becomes the column's own default —
 * never a value the CHECK would reject.
 */
type CoordinationMode = 'coordinated' | 'independent';

export function requestCoordinationMode(payload: unknown): CoordinationMode {
  const v =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).coordination_mode
      : undefined;
  return v === 'independent' ? 'independent' : 'coordinated';
}

const RejectBodySchema = z.object({ reason: z.string().min(1).max(2000) });

// POST /api/project-requests/:id/reject
/**
 * Statuses in which the OUTLINE owns the request (migration 123).
 *
 * ⛔ The direct approve/reject routes predate the two-stage lifecycle. Left
 * unguarded, a reviewer could approve a request sitting in `outline_proposed`
 * straight into a project — bypassing the outline the agent produced — and the
 * outline's approval would stay pending in the queue, answerable, for a
 * request that no longer needs it. Rejecting mid-outline strands it the same
 * way. So while an outline is in flight, the only decision road is the
 * outline's own approval; the request itself can be decided directly only as a
 * draft or after a failed promotion.
 */
export const OUTLINE_IN_FLIGHT_STATUSES: readonly string[] = [
  'submitted',
  'analysing',
  'outline_proposed',
  'approved',
];

function outlineInFlightConflict(row: { id: string; status: string }): Response | null {
  if (!OUTLINE_IN_FLIGHT_STATUSES.includes(row.status)) return null;
  return jsonResponse(
    {
      error: 'outline_in_flight',
      message:
        'this request is in the outline stage — decide it through its outline approval, not directly',
      project_request_id: row.id,
      status: row.status,
    },
    409,
  );
}

/**
 * Reject / withdraw: the request's pre-approval project (allocated at submit,
 * routes/project-request-lifecycle.ts allocatePreApprovalProject) becomes
 * `cancelled` — and nothing else changes. The row is kept so spend already
 * attributed to it stays attributed. Conditional on `pending`: a project that
 * already went live (a late promote failure) is never cancelled from here.
 */
export async function cancelPreApprovalProject(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) return;
  await tx
    .update(projects)
    .set({ status: 'cancelled', updated_at: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.status, 'pending')));
}

export async function handleRejectProjectRequest(
  req: Request,
  id: string,
): Promise<Response> {
  const { user, row } = await loadOwnedRequest(req, id);
  const inFlight = outlineInFlightConflict(row);
  if (inFlight) return inFlight;
  if (row.status === 'promoted') {
    throw new ValidationError('a promoted project request cannot be rejected', {
      code: 'project_request_already_promoted',
    });
  }
  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const { reason } = RejectBodySchema.parse(raw);
  const now = new Date();
  // ⛔ SERIALISED WITH APPROVE'S CLAIM. `row` was read without a lock (and the
  // body read above can take arbitrarily long), so a concurrent approve may
  // have claimed the request (→ `approved`) or finished it (→ `promoted`) since.
  // The UPDATE is therefore conditional on the status the guards above judged:
  // if anything moved it, no row comes back, nothing is cancelled, and the
  // reject 409s. Only a reject whose request UPDATE won cancels the
  // pre-approval project — same transaction, so the two never disagree.
  let liveProject = false;
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(projectRequests)
      .set({
        status: 'rejected',
        rejection_reason: reason,
        reviewed_by: user.id,
        updated_at: now,
        history: appendHistorySql({
          at: now.toISOString(),
          action: 'rejected',
          by: user.id,
          detail: reason,
        }),
      })
      .where(and(eq(projectRequests.id, id), eq(projectRequests.status, row.status)))
      .returning();
    if (!u) return undefined;
    // A linked project this request already turned LIVE (a promotion that
    // failed after activation; approve resumes it) is never left behind a
    // rejected request: refuse, rolling the request UPDATE back.
    if (u.project_id) {
      const [linked] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, u.project_id))
        .for('update');
      if (linked && wasPromotedFromRequest(linked, u.id)) {
        liveProject = true;
        tx.rollback();
      }
    }
    await cancelPreApprovalProject(tx, u.project_id);
    return u;
  }).catch((err: unknown) => {
    if (err instanceof TransactionRollbackError) return undefined;
    throw err;
  });
  if (!updated) {
    return jsonResponse(
      {
        error: 'project_request_reject_conflict',
        message: liveProject
          ? 'this request already has a live project (a promotion failed after activation) — approve it again to finish the promotion'
          : 'this request changed while it was being rejected — reload and retry',
        project_request_id: row.id,
      },
      409,
    );
  }
  return jsonResponse(updated);
}

// POST /api/project-requests/:id/approve — promote to a real project via the
// SHARED createProjectCore (byte-identical to POST /api/projects; fires n8n).
// The body, when present, is the final edited ProjectCreate; otherwise the
// stored payload is used. repository_url is OPTIONAL (George 2026-10-13), but a
// PROVIDED CP sentinel is rejected (422) — a human must replace it or remove it.
export async function handleApproveProjectRequest(
  req: Request,
  id: string,
): Promise<Response> {
  // ⛔ v4 wiring gate (George 2026-10-13), FIRST — before auth, which can upsert
  // the caller's user row, and before any DB/RM/Planka side effect.
  const notConfigured = conveyorNotConfiguredResponse();
  if (notConfigured) return notConfigured;
  const { user, tenantId, row } = await loadOwnedRequest(req, id);
  const inFlight = outlineInFlightConflict(row);
  if (inFlight) return inFlight;
  if (row.status === 'promoted') {
    return jsonResponse(
      {
        error: 'project_request_already_promoted',
        project_request_id: row.id,
        project_id: row.project_id,
        status: row.status,
      },
      409,
    );
  }
  if (row.status === 'rejected') {
    throw new ValidationError(
      'a rejected project request must be re-posted before it can be approved',
      { code: 'project_request_rejected' },
    );
  }
  // `withdrawn` is terminal: the
  // requester took it back, and its pre-approval project is `cancelled`.
  if (row.status === 'withdrawn') {
    return jsonResponse(
      {
        error: 'project_request_withdrawn',
        message: 'this request was withdrawn by its requester and cannot be approved',
        project_request_id: row.id,
        status: row.status,
      },
      409,
    );
  }

  const raw = await req.json().catch(() => ({}));
  const merged =
    raw && typeof raw === 'object' && Object.keys(raw).length > 0
      ? { ...(row.payload as Record<string, unknown>), ...raw }
      : (row.payload as Record<string, unknown>);

  const validated = ProjectCreateSchema.parse(merged);
  if (validated.repository_url === FR_REPO_SENTINEL) {
    throw new ValidationError(
      'repository_url is still the CP placeholder — set a real repository before approving',
      { code: 'repository_url_required' },
    );
  }

  // ⛔ THE REPO-ACCESS GATE — the same one submit runs (project-request-repo-gate.ts),
  // over the FINAL repo set: the validated primary (which the body may have
  // replaced) plus every repo the merged payload / request rows still name.
  // Before any write; a refusal leaves the request exactly as it was.
  const denied = await repoAccessGateResponse({
    requestId: row.id,
    tenantId,
    payload: merged,
    extraUrls: validated.repository_url ? [validated.repository_url] : [],
    verb: 'approve',
  });
  if (denied) return denied;

  // ⛔ CLAIM THE REQUEST BEFORE ANY PLANKA WORK (the outline road's pattern,
  // project-request-lifecycle.ts onOutlineDecided). Conditional on the status
  // this handler validated: of two concurrent approves exactly one moves the
  // row to `approved` (promotion under way — OUTLINE_IN_FLIGHT_STATUSES, so a
  // third approve or a reject now 409s on the guard above); the loser 409s
  // here having created no board, card or secret. A promotion failure stamps
  // `failed` (promoteProjectRequest), which is approvable again.
  //
  // ⚠️ KNOWN HAZARD, NOT RECOVERED (documented, deliberately not built): if the
  // process dies after this claim commits and before promoteProjectRequest
  // stamps `promoted` or `failed`, the request stays `approved` forever — an
  // OUTLINE_IN_FLIGHT status, so direct approve, reject and withdraw all refuse
  // it. The outline road (project-request-lifecycle.ts onOutlineDecided) claims
  // to `approved` the same way and shares the same hazard. Recovery needs an
  // operator (or a future reconciler) to move it to `failed`.
  const [claimed] = await db
    .update(projectRequests)
    .set({ status: 'approved', updated_at: new Date() })
    .where(and(eq(projectRequests.id, row.id), eq(projectRequests.status, row.status)))
    .returning();
  if (!claimed) {
    return jsonResponse(
      {
        error: 'project_request_approve_conflict',
        message: 'this request changed while it was being approved — reload and retry',
        project_request_id: row.id,
      },
      409,
    );
  }

  try {
    const { promoted, project, planka } = await promoteProjectRequest({
      row: claimed,
      user,
      validated,
      // `coordination_mode` reaches the PROJECT ROW from here. Read through the
      // one normaliser off the validated body, so the value the project gets is
      // the value submit's webhook reported.
      coordinationMode: requestCoordinationMode(validated),
    });
    return jsonResponse({
      ...promoted,
      project: {
        ...project,
        planka: { boardId: planka.board.id },
      },
    });
  } catch (err) {
    if (err instanceof ProjectCreateError) {
      return jsonResponse(err.payload, err.httpStatus);
    }
    if (err instanceof AppError) {
      return jsonResponse({ error: err.message, details: err.details }, err.statusCode);
    }
    throw err;
  }
}

type RequestRow = typeof projectRequests.$inferSelect;

/**
 * True when `project` is live and was promoted from request `requestId`:
 * createSingleProject writes `project_data.external_origin.project_request_id`
 * from promoteProjectRequest's server-built `externalOrigin` only.
 */
function wasPromotedFromRequest(
  project: typeof projects.$inferSelect,
  requestId: string,
): boolean {
  if (project.status !== 'active') return false;
  const data = (project.project_data ?? {}) as Record<string, unknown>;
  const origin = data.external_origin as Record<string, unknown> | undefined;
  return origin?.project_request_id === requestId;
}

/** The request's decided (`approved`) outline, newest version first. */
async function approvedOutlineFor(requestId: string): Promise<ApprovedOutlineScope | undefined> {
  const [o] = await db
    .select({
      id: projectOutlines.id,
      deliverables: projectOutlines.deliverables,
      intermediate_deliverables: projectOutlines.intermediate_deliverables,
      milestones: projectOutlines.milestones,
      effort_estimate: projectOutlines.effort_estimate,
    })
    .from(projectOutlines)
    .where(and(eq(projectOutlines.request_id, requestId), eq(projectOutlines.status, 'approved')))
    .orderBy(desc(projectOutlines.version))
    .limit(1);
  return o;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE APPROVED SCOPE (migration 127)
// ═══════════════════════════════════════════════════════════════════════════
//
// Promotion used to re-parse the Stage-A request payload and nothing else, so
// every deliverable, acceptance criterion, milestone and effort figure a human
// signed off on the OUTLINE was dropped on the floor. `promoteProjectRequest`
// now takes the decided outline and copies its scope onto the project.

/**
 * The decided `project_outlines` row, as the promote path needs it.
 *
 * ⛔ THE JSONB FIELDS ARE `unknown` ON PURPOSE. They are `jsonb` columns, so
 * drizzle hands them back as `unknown`; typing them as arrays here would be a
 * cast nobody checked. `buildApprovedScopeRows` re-validates them against the
 * SAME zod schemas the outline webhook accepted them with, so a row that has
 * been tampered with (or written by a future, wider emitter) fails LOUDLY
 * inside the promote try rather than landing half-shaped.
 */
interface ApprovedOutlineScope {
  /** `project_outlines.id` — PROVENANCE, written to `source_outline_id`. */
  id: string;
  deliverables: unknown;
  intermediate_deliverables: unknown;
  milestones: unknown;
  effort_estimate: unknown;
  // ── U-PS-ROUTE (migration 167). Optional so every existing caller and the
  // resumed-direct road are unchanged; present on the outline road. ─────────
  /** The outline VERSION decided. */
  version?: number;
  /** `project_outlines.phase_plan` — NULL/absent ⇒ no template (legacy start). */
  phase_plan?: unknown;
  phase_plan_hash?: string | null;
  /** The `project_outline.approval` that decided this version — the contract close. */
  approval_id?: string | null;
  decided_by?: string | null;
  decided_at?: Date | null;
}

/**
 * The template start a decided outline carries, or undefined when it carries
 * no phase plan. A PRESENT but malformed plan throws (storedPhasePlan), inside
 * promote's try, so the request is stamped failed rather than silently started
 * on the legacy path. Exported for the unit test.
 */
export function startTemplateFromOutline(
  outline: ApprovedOutlineScope | undefined,
): ProjectStartTemplate | undefined {
  const plan = storedPhasePlan(outline?.phase_plan);
  if (!outline || !plan) return undefined;
  if (!outline.phase_plan_hash) {
    throw new Error(`outline ${outline.id} carries a phase_plan without its phase_plan_hash`);
  }
  // fr#1481 — the outline-approval guard for a plan stored before the webhook
  // refused unmappable gate slugs: promote fails loudly (request → failed)
  // rather than start a project whose gate can never open.
  const unknownGates = planGateUnknownSlugs(plan);
  if (unknownGates.length > 0) {
    throw new Error(
      `${PHASE_PLAN_GATE_UNKNOWN}: outline ${outline.id} gates name no approval predicate: ` +
        unknownGates.map((g) => `${g.phase}:${g.slug}`).join(', '),
    );
  }
  return {
    templateId: plan.template_id,
    templateHash: plan.template_hash,
    phasePlan: plan,
    phasePlanHash: outline.phase_plan_hash,
    outlineId: outline.id,
    outlineVersion: outline.version ?? 0,
    approvalId: outline.approval_id ?? null,
    decidedBy: outline.decided_by ?? null,
    decidedAt: outline.decided_at ?? null,
  };
}

/**
 * Turn a decided outline into the rows migration 127 stores. PURE — exported so
 * the position sequencing is pinned by a unit test with no database, and so the
 * integration test can assert the DB agrees with it.
 *
 * ⭐ ONE SHARED POSITION SEQUENCE ACROSS BOTH KINDS. `project_deliverables`
 * carries `UNIQUE (project_id, position)` and the two kinds live in ONE table
 * precisely so the promoted scope has a single total order (see the migration
 * header: "`position` has to be unique across the whole list for an ordering to
 * exist at all"). So deliverables occupy 0..n-1 and intermediates continue at
 * n..n+m-1 — giving each kind its own 0-based sequence would 23505 the moment a
 * request had at least one of each, which is the ordinary case.
 *
 * ⛔ `project_deliverables.kind` IS NOT THE OUTLINE ITEM'S OWN `kind`. The
 * table's vocabulary is the CLOSED 'deliverable' | 'intermediate' and it is
 * decided by WHICH ARRAY the item arrived in. The outline item's `kind` is the
 * conveyor roadmap's free-string per-deliverable contract kind ('artifact',
 * 'doc', …); migration 127 has no column for it and it is DROPPED here. Writing
 * it into `kind` would 23514 against `project_deliverables_kind_check` for every
 * value the roadmap ever publishes. (`checked_by` is dropped for the same
 * reason — no column.)
 *
 * ⭐ `repos` IS CARRIED (migration 151, fr#1332) — the earlier decision to drop
 * it waited for a reader, and the C1-58 intake minter is that reader: it reads
 * `repos` off GET /api/projects/:id/deliverables and names one per child on
 * POST /api/decompositions/commit (routes/decomposition-commit.ts), which
 * writes it as the card's `repository_url` input. Copied VERBATIM (the
 * request's own spelling, as the outline stored it). An outline item with no
 * `repos` key stores NULL — never `[]`, which would claim "changes no repo".
 *
 * ⛔ `repos_source` IS STILL DROPPED: no reader names it. The defaulted-vs-stated
 * marker stays on `project_outlines.deliverables`, recoverable through
 * `source_outline_id` + this function's position order (deliverables 0..n-1,
 * then intermediates n..n+m-1).
 */
/**
 * U-PS-COMMIT: a deferred deliverable must name its minter, else no one would
 * ever mint it and its phase could never exit. Throws inside promote's try (the
 * request is stamped failed, loudly) — the DB CHECK
 * project_deliverables_minting_check is the second layer.
 */
function deferredWithMinter(item: OutlineDeliverable, outlineId: string, position: number): boolean {
  const deferred = item.deferred === true;
  if (deferred && !item.minter) {
    throw new Error(
      `outline ${outlineId} deliverable at position ${position} is deferred but names no minter`,
    );
  }
  return deferred;
}

export function buildApprovedScopeRows(
  outline: ApprovedOutlineScope,
  projectId: string,
): {
  deliverables: (typeof projectDeliverables.$inferInsert)[];
  milestones: (typeof projectMilestones.$inferInsert)[];
  effortEstimate: unknown;
} {
  const DeliverableList = z.array(OutlineDeliverableSchema);
  const items: { kind: 'deliverable' | 'intermediate'; item: OutlineDeliverable }[] = [
    ...DeliverableList.parse(outline.deliverables ?? []).map((item) => ({
      kind: 'deliverable' as const,
      item,
    })),
    ...DeliverableList.parse(outline.intermediate_deliverables ?? []).map((item) => ({
      kind: 'intermediate' as const,
      item,
    })),
  ];
  const milestones = z.array(MilestoneSchema).parse(outline.milestones ?? []);

  return {
    deliverables: items.map(({ kind, item }, position) => ({
      project_id: projectId,
      source_outline_id: outline.id,
      position,
      kind,
      title: item.title,
      description: item.description ?? null,
      acceptance_criteria: item.acceptance_criteria,
      repos: item.repos ?? null,
      // U-PS-COMMIT (migration 169). Absent ⇒ false/NULL = today's semantics.
      deferred: deferredWithMinter(item, outline.id, position),
      minter: item.minter ?? null,
      // Migration 171 (fr#1481): the row → phase-plan deliverable join.
      plan_deliverable_id: item.plan_deliverable_id ?? null,
    })),
    milestones: milestones.map((m, position) => ({
      project_id: projectId,
      position,
      name: m.name,
      target_date: m.target_date ?? null,
    })),
    effortEstimate: outline.effort_estimate ?? null,
  };
}

/**
 * Turn an approved request into a project. THE one engine for it.
 *
 * Extracted from handleApproveProjectRequest so the two roads to a project —
 * a reviewer approving the request directly, and a human approving the agent's
 * OUTLINE (routes/project-request-lifecycle.ts) — cannot drift. Two copies of
 * "create the project, send CommonPractice feedback, stamp promoted" is how the
 * second road would end up skipping the feedback, or the history entry.
 *
 * On failure it records `status='failed'` + `error` + a history entry on the
 * request and RETHROWS, so each caller decides how to present the error while
 * neither can forget to record it.
 *
 * ⛔ `outline` IS OPTIONAL AND MUST STAY OPTIONAL. The direct-approve road
 * (`handleApproveProjectRequest`) has no outline — a reviewer approving a draft
 * never produced one — and must keep behaving byte-identically. Making this
 * parameter required would break that road, not improve this one.
 */
export async function promoteProjectRequest(opts: {
  row: RequestRow;
  user: Parameters<typeof createSingleProject>[0]['user'];
  validated: ReturnType<typeof ProjectCreateSchema.parse>;
  historyAction?: string;
  /** The decided outline whose scope this project is getting (migration 127). */
  outline?: ApprovedOutlineScope;
  /** `projects.coordination_mode` (migration 143). Defaults to 'coordinated'. */
  coordinationMode?: CoordinationMode;
}) {
  // ⛔ v4 wiring gate — a BACKSTOP, not the outline road's gate. It throws
  // before this function's own try, so it records nothing on the request. On
  // the outline road that would strand the request (onOutlineDecided has
  // already decided the outline and moved the request by the time it gets
  // here), so that road refuses earlier: approvals.ts handleUpdateApproval
  // before the decision commits, and onOutlineDecided before its first write.
  assertConveyorConfigured();
  const { row, user, validated } = opts;
  const externalOrigin = {
    ...((row.external_origin as Record<string, unknown> | null) ?? {}),
    project_request_id: row.id,
  };
  const now = new Date();
  let promoteConflictProjectId: string;
  try {
    // ── THE PRE-APPROVAL ROW BECOMES THE PROJECT (George 2026-10-08) ─────────
    // Submit allocated a `pending` projects row so pre-approval LLM spend has a
    // projectId. Promotion turns that SAME row active (createSingleProject
    // refuses unless it is still `pending`). A `cancelled` link is a rejected
    // request a bridge re-post reopened and approved directly: it keeps its
    // spend, and this promotion creates a fresh row as before. No link (a
    // pre-change submit, or a draft approved directly) ⇒ unchanged behaviour.
    //
    // ── RESUME, NOT 409, WHEN THIS REQUEST ALREADY ACTIVATED ITS ROW ─────────
    // The activation (createSingleProject's transaction) commits BEFORE the
    // non-transactional tail — createSingleProject's own Planka orchestration,
    // then the writes below. A failure there used to leave the project
    // `active` and the request `failed`, and then re-submit AND approve both
    // 409'd forever (the row is no longer `pending`). So a linked row that is
    // `active` AND was promoted from THIS request (external_origin carries its
    // id — written server-side by the promote below, never by a caller) is
    // resumed: no second createSingleProject, and the request-side writes
    // below (coordination mode, approved scope, CP feedback, `promoted` stamp)
    // run again, each idempotent. An `active` row from anywhere else still 409s.
    let existingProjectId: string | undefined;
    let resumed: typeof projects.$inferSelect | undefined;
    if (row.project_id) {
      const [linked] = await db.select().from(projects).where(eq(projects.id, row.project_id));
      if (linked && wasPromotedFromRequest(linked, row.id)) resumed = linked;
      else if (linked && linked.status !== 'cancelled') existingProjectId = row.project_id;
    }

    // ── U-PS-ROUTE: A TEMPLATE START, OR (FLAG ON) NO START AT ALL ───────────
    // The approved outline version's phase plan IS the template coordinates;
    // a request carries `template_id@hash` exactly when its decided outline
    // does. With PROJECT_START_TEMPLATE_REQUIRED on, an orchestrated EXEC
    // request without one is refused `no_template` (PSD §4: terminal, never a
    // silent fallback to the legacy E8 / project_setup start). Flag OFF (the
    // default) ⇒ a template-less promote is exactly today's. A resumed promote
    // already created its project, so it is never re-judged here.
    const startTemplate = startTemplateFromOutline(opts.outline);
    if (
      !resumed &&
      !startTemplate &&
      projectStartTemplateRequired() &&
      row.tenant_id === EXECUTION_TENANT_ID &&
      shouldOrchestrateProjectStart({
        projectType: validated.project_type,
        cveSweep: validated.cve_sweep,
        tenantId: row.tenant_id,
        execTenantId: EXECUTION_TENANT_ID,
      })
    ) {
      throw new ProjectCreateError(
        {
          error: 'no_template',
          message:
            'no_template: an orchestrated EXEC project request is promoted only from an approved ' +
            'outline that carries a template (template_id@hash); this one carries none',
          project_request_id: row.id,
        },
        422,
      );
    }

    const { project, planka } = resumed
      ? {
          project: resumed,
          planka: { board: { id: resumed.planka_board_id } },
        }
      : await createSingleProject({
          validated,
          user,
          existingProjectId,
          extraProjectData: { external_origin: externalOrigin },
          // The platform-repo ownership gate judges the REQUEST's tenant, not the
          // deciding user's active one (an outline may be decided from a platform
          // workspace — routes/project-request-lifecycle.ts onOutlineDecided).
          repoGateTenantId: row.tenant_id,
          ...(startTemplate ? { startTemplate } : {}),
        });
    // A resumed direct approve carries no outline; the request's own APPROVED
    // outline (if the first attempt came down the outline road) is the scope
    // the human signed off, so it is re-read rather than dropped.
    const outline = opts.outline ?? (resumed ? await approvedOutlineFor(row.id) : undefined);

    // ── coordination_mode REACHES THE PROJECT ROW (migration 143) ──────────
    //
    // ⚠️ AN EXPLICIT UPDATE, not a field of `validated`, and that is not
    // redundancy: `createSingleProject` (routes/projects.ts) does not write the
    // `coordination_mode` column, so the value the caller sent would land
    // nowhere and every promoted project would silently read 'coordinated' from
    // the column default. Measured before writing this: zero occurrences of
    // `coordination_mode` in routes/projects.ts.
    //
    // Unconditional, for the same reason the effort-estimate write below is:
    // writing 'coordinated' explicitly records a decision, where leaving it to
    // the default is indistinguishable from nobody having been asked. Inside the
    // try, so a failure stamps the request `failed` rather than producing a
    // project whose coordination mode is quietly wrong.
    await db
      .update(projects)
      .set({ coordination_mode: opts.coordinationMode ?? 'coordinated' })
      .where(eq(projects.id, project.id));

    // ── THE APPROVED SCOPE REACHES THE PROJECT (migration 127) ─────────────
    //
    // ⛔ NOT BEST-EFFORT, AND DELIBERATELY NOT WRAPPED IN A `.catch(() => {})`.
    // A throw here escapes into this function's existing catch, which stamps
    // the request `status='failed'` + a history entry and RETHROWS. That is the
    // point: a project that silently lost the scope a human approved is the
    // exact defect this unit exists to close, and producing one from the error
    // path would be worse than the original bug — it would be the same data
    // loss wearing a green response.
    //
    // ⚠️ The project row already exists at this point (it is created outside
    // any transaction by `createSingleProject`), so a failure here leaves an
    // orphan project with a `failed` request. That is the pre-existing shape of
    // every post-creation promote failure — `scripts/reconcile-orphaned-projects.ts`
    // is what reconciles it — and is not made worse by these three writes.
    // The three writes ARE atomic with each other, so a project can never end
    // up with half its approved scope.
    if (outline) {
      const scope = buildApprovedScopeRows(outline, project.id);
      await db.transaction(async (tx) => {
        // Resume: the scope transaction is atomic, so either all of it landed
        // on the first attempt or none did — re-inserting would 23505.
        const already =
          resumed !== undefined &&
          ((
            await tx
              .select({ id: projectDeliverables.id })
              .from(projectDeliverables)
              .where(eq(projectDeliverables.project_id, project.id))
              .limit(1)
          ).length > 0 ||
            (
              await tx
                .select({ project_id: projectMilestones.project_id })
                .from(projectMilestones)
                .where(eq(projectMilestones.project_id, project.id))
                .limit(1)
            ).length > 0);
        if (!already && scope.deliverables.length > 0) {
          await tx.insert(projectDeliverables).values(scope.deliverables);
        }
        if (!already && scope.milestones.length > 0) {
          await tx.insert(projectMilestones).values(scope.milestones);
        }
        // Unconditional: writing NULL when the outline agreed no effort figure
        // is the correct record ("no estimate approved"), and an always-run
        // write means a broken column cannot hide behind an empty outline.
        await tx
          .update(projects)
          .set({ approved_effort_estimate: scope.effortEstimate })
          .where(eq(projects.id, project.id));
      });
    }

    // Phase 5.1 — best-effort fr→CP promotion feedback. Never throws, never
    // blocks; folded into history so the loop is observable.
    const origin = (row.external_origin as Record<string, unknown> | null) ?? null;
    const feedback = await notifyCpPromoted({
      source: typeof origin?.source === 'string' ? origin.source : '',
      projectRequestId: row.id,
      frProjectId: project.id,
      tenantId: row.tenant_id,
      cpSolutionId:
        typeof origin?.cp_solution_id === 'string' ? origin.cp_solution_id : '',
      frProjectUrl: config.publicBaseUrl
        ? `${config.publicBaseUrl}/projects/${project.id}`
        : '',
    });
    if (feedback.attempted && !feedback.ok) {
      console.warn(
        `[project-requests] CP promotion feedback failed for request ${row.id}: ${feedback.detail}`,
      );
    }

    const entries: HistoryEntry[] = [
      {
        at: now.toISOString(),
        action: opts.historyAction ?? 'approved',
        by: user.id,
        detail: resumed ? `${project.id} (resumed: project was already active)` : project.id,
      },
    ];
    if (feedback.attempted) {
      entries.push({
        at: now.toISOString(),
        action: feedback.ok ? 'cp_feedback_sent' : 'cp_feedback_failed',
        by: user.id,
        detail: feedback.detail,
      });
    }

    // ⛔ CONDITIONAL ON THE CLAIM STATUS. Both promote roads claim the request
    // to `approved` before any Planka work (handleApproveProjectRequest,
    // onOutlineDecided). If anything moved it since — a bridge re-post reopens
    // an `approved` row to `draft`, after which the requester may withdraw it —
    // that later decision wins and is NOT overwritten with `promoted`.
    const [promoted] = await db
      .update(projectRequests)
      .set({
        status: 'promoted',
        project_id: project.id,
        reviewed_by: user.id,
        payload: validated,
        error: null,
        updated_at: now,
        history: appendHistorySql(...entries),
      })
      .where(and(eq(projectRequests.id, row.id), eq(projectRequests.status, 'approved')))
      .returning();
    if (promoted) return { promoted, project, planka };
    promoteConflictProjectId = project.id;
  } catch (err) {
    // Stored on the request row, which the requester reads back: fr-authored
    // errors keep their text, anything else (secrets-service body, upstream
    // sentence) is stored client-safe. The raw error is logged and rethrown.
    console.warn('[project-requests.approve] promotion failed:', err);
    const failedTable = failedWriteTable(err);
    const message =
      err instanceof AppError || err instanceof ProjectCreateError
        ? err.message
        : failedTable
          ? // Name WHICH of fr's own writes failed (the requester needs to know the
            // scope was not saved), never the driver text — drizzle's message
            // embeds the full SQL and its bound VALUES.
            `project creation failed while saving ${failedTable} — try again`
          : clientSafeCaughtErrorText(err, 'project creation failed — try again', {
              forStorage: true,
            });
    await db
      .update(projectRequests)
      .set({
        status: 'failed',
        error: message,
        reviewed_by: user.id,
        payload: validated,
        updated_at: now,
        history: appendHistorySql({
          at: now.toISOString(),
          action: 'approve_failed',
          by: user.id,
          detail: message,
        }),
      })
      // Never overwrite a decision that won: a concurrent loser's failure must
      // not turn the winner's `promoted` — nor a terminal `rejected` /
      // `withdrawn` — into `failed` (which would make it approvable again).
      .where(
        and(
          eq(projectRequests.id, row.id),
          notInArray(projectRequests.status, ['promoted', 'rejected', 'withdrawn']),
        ),
      );
    throw err;
  }

  // ── THE PROMOTION LOST ITS CLAIM (outside the try: not a `failed` stamp) ───
  // The project is ALREADY active and cannot be un-activated from here (Planka
  // board + secrets exist). Least surprising consistent outcome: keep the
  // request's newer status, but make sure it LINKS the live project — only
  // where the request is still reopenable (`draft` / `failed`): a later approve
  // then RESUMES it (wasPromotedFromRequest), and reject/withdraw refuse it
  // because a live project is linked. A request that went terminal
  // (`withdrawn` / `rejected`) is left alone and the orphan is logged for
  // scripts/reconcile-orphaned-projects.ts. The caller gets a 409.
  const projectId = promoteConflictProjectId;
  const conflictAt = new Date();
  const [relinked] = await db
    .update(projectRequests)
    .set({
      project_id: projectId,
      updated_at: conflictAt,
      history: appendHistorySql({
        at: conflictAt.toISOString(),
        action: 'promote_conflict',
        by: user.id,
        detail: `${projectId} is active; the request changed during promotion and was not marked promoted`,
      }),
    })
    .where(
      and(
        eq(projectRequests.id, row.id),
        notInArray(projectRequests.status, ['promoted', 'rejected', 'withdrawn']),
      ),
    )
    .returning({ status: projectRequests.status });
  console.warn(
    `[project-requests] promotion of request ${row.id} lost its 'approved' claim after project ${projectId} went active; ${
      relinked
        ? `request kept status '${relinked.status}' and now links the project (approve again resumes it)`
        : 'request is terminal — project is orphaned (reconcile-orphaned-projects)'
    }`,
  );
  throw new ProjectCreateError(
    {
      error: 'project_request_promote_conflict',
      message:
        'this request changed while it was being promoted — its project is active but the request was not marked promoted; reload and retry',
      project_request_id: row.id,
      project_id: projectId,
    },
    409,
  );
}

