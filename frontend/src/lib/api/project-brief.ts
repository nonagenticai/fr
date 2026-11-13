// /api/projects/:id/brief — the project brief, now owned by
// requirements_management (RM) as VERSIONS. fr keeps no copy and is READ-ONLY
// here (George 2026-10-13, D15/R16): v1 is the user's project request, every
// later version is the conveyor's (the PM writes RM directly). fr proxies the
// reads only.
//
// ⛔ fr is a FACILITATOR here. A failed read (403/404, 503 rm_brief_unavailable)
// comes back as a `BriefFailure` with the status, the code and one sentence from
// the shared formatter; nothing here judges the brief.

import { authFetch } from './auth-fetch';
import { formatApiError } from './api-error';

export interface BriefRisk {
  description: string;
  likelihood?: string | null;
  impact?: string | null;
  mitigation?: string | null;
}

export interface BriefDependencyObject {
  kind: string;
  name: string;
  note?: string | null;
}
export type BriefDependency = string | BriefDependencyObject;

export type BriefConstraint = string | ({ kind: string } & Record<string, unknown>);

/**
 * One acceptance criterion as RM stores it (RM #235). `status`/`evidence`/`checked_*` are written
 * ONLY by the conveyor (PM / n8n, R-CK7): fr displays them and never marks a criterion met.
 */
export interface BriefAcceptanceCriterion {
  id: string;
  text: string;
  status: 'met' | 'not_met' | 'unchecked';
  evidence: { kind: 'test_run' | 'pr' | 'report'; ref: string }[];
  checked_at: string | null;
  checked_by: string | null;
}

/** The versioned brief document, as RM stores it. Every key is nullable. */
export interface ProjectBrief {
  problem_statement?: string | null;
  desired_outcome?: string | null;
  business_case?: string | null;
  success_criteria?: string[] | null;
  /** RM #235: checkable items (older payloads / input: plain strings). */
  acceptance_criteria?: (string | BriefAcceptanceCriterion)[] | null;
  in_scope?: string[] | null;
  out_of_scope?: string[] | null;
  high_level_requirements?: string[] | null;
  assumptions?: string[] | null;
  access_requirements?: string[] | null;
  stakeholders?: string[] | null;
  approvers?: string[] | null;
  deadline?: string | null;
  budget?: string | null;
  notes?: string | null;
  constraints?: BriefConstraint[] | null;
  dependencies?: BriefDependency[] | null;
  risks?: BriefRisk[] | null;
}

export type BriefAuthorKind = 'user' | 'conveyor';

/** GET /api/projects/:id/brief — the flat current brief plus its RM version. */
export interface CurrentProjectBrief extends ProjectBrief {
  project_id: string;
  name?: string | null;
  project_type?: string | null;
  constraints_text?: string | null;
  target_packages?: unknown;
  repositories?: unknown;
  brief_version: number | null;
  brief_author_kind: BriefAuthorKind | null;
  brief_updated_at: string | null;
}

export interface BriefVersionSummary {
  version: number;
  author_kind: BriefAuthorKind;
  author_subject_id: string;
  note: string | null;
  created_at: string;
}

export interface BriefVersionList {
  data: BriefVersionSummary[];
  total: number;
  current_version: number | null;
}

export interface BriefVersionDetail extends BriefVersionSummary {
  project_id: string;
  brief: ProjectBrief;
}

export const RM_BRIEF_UNAVAILABLE = 'rm_brief_unavailable';

export interface BriefFailure {
  ok: false;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** `error.code`, or the bare `error` string; null when none. */
  code: string | null;
  /** One sentence, via the shared formatter. */
  message: string;
  /** RM unreachable (503 rm_brief_unavailable, any 5xx, no answer): NOT "no brief". */
  unavailable: boolean;
}

export type BriefResult<T> = { ok: true; data: T } | BriefFailure;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function briefErrorCode(body: unknown): string | null {
  // fr's error envelope (backend utils/errors handleError) is
  // `{ error: <message>, code?, details? }` — the CODE is `code` (AppError) or
  // `details.code` (ValidationError); `error` is the human sentence.
  if (!isRecord(body)) return null;
  if (typeof body.code === 'string') return body.code;
  if (isRecord(body.details) && typeof body.details.code === 'string') return body.details.code;
  const err = body.error;
  if (isRecord(err) && typeof err.code === 'string') return err.code;
  return null;
}

/** Turn a non-2xx Response into a failure. Never throws. */
export async function briefFailureOf(r: Response): Promise<BriefFailure> {
  const text = await r.text().catch(() => '');
  let body: unknown = text;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  const code = briefErrorCode(body);
  const fallback = `HTTP ${r.status}`;
  // fr's brief routes answer `{ error: '<code>', message }`; the shared
  // formatter returns a bare-string `error` as-is, which would show the CODE —
  // so the route's own sentence wins when there is one.
  const message =
    typeof body === 'string'
      ? body.trim() || fallback
      : isRecord(body) && typeof body.message === 'string' && body.message
        ? body.message
        : isRecord(body) && typeof body.error === 'string' && body.error
          ? body.error
          : formatApiError(body, fallback);
  return {
    ok: false,
    status: r.status,
    code,
    message,
    unavailable: r.status >= 500 || code === RM_BRIEF_UNAVAILABLE,
  };
}

function unreachable(e: unknown): BriefFailure {
  const message = e instanceof Error && e.message ? e.message : 'The brief could not be reached';
  return { ok: false, status: 0, code: null, message, unavailable: true };
}

async function call<T>(
  url: string,
  init: RequestInit,
  pick: (json: unknown) => T,
): Promise<BriefResult<T>> {
  let r: Response;
  try {
    r = await authFetch(url, init);
  } catch (e) {
    return unreachable(e);
  }
  if (r == null || typeof (r as { ok?: unknown }).ok !== 'boolean') {
    return unreachable(new Error(`No response from ${url}`));
  }
  if (!r.ok) return briefFailureOf(r);
  try {
    return { ok: true, data: pick(await r.json()) };
  } catch (e) {
    return unreachable(e);
  }
}

/** `{ data: X }` → X; anything else is returned as-is. */
function unwrapData<T>(json: unknown): T {
  if (isRecord(json) && 'data' in json) return json.data as T;
  return json as T;
}

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/brief`;
}

export function getCurrentBrief(projectId: string): Promise<BriefResult<CurrentProjectBrief>> {
  // The route answers the flat brief (no `{ data }` envelope); tolerate one.
  return call(base(projectId), {}, (json) =>
    isRecord(json) && 'project_id' in json
      ? (json as unknown as CurrentProjectBrief)
      : unwrapData<CurrentProjectBrief>(json),
  );
}

export function listBriefVersions(projectId: string): Promise<BriefResult<BriefVersionList>> {
  // fr answers `{ data: { versions, total, current_version } }`.
  return call(`${base(projectId)}/versions`, {}, (json) => {
    const j = isRecord(json) && isRecord(json.data) ? json.data : {};
    const data = Array.isArray(j.versions) ? (j.versions as BriefVersionSummary[]) : [];
    return {
      data,
      total: typeof j.total === 'number' ? j.total : data.length,
      current_version: typeof j.current_version === 'number' ? j.current_version : null,
    };
  });
}

export function getBriefVersion(
  projectId: string,
  version: number,
): Promise<BriefResult<BriefVersionDetail>> {
  return call(`${base(projectId)}/versions/${encodeURIComponent(String(version))}`, {}, (json) =>
    unwrapData<BriefVersionDetail>(json),
  );
}
