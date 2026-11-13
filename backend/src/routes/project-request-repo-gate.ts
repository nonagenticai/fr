// src/routes/project-request-repo-gate.ts
//
// ⛔ THE REPO-ACCESS GATE (decision George, 2026-09-22) — ONE implementation,
// used by EVERY road that finalises a project request:
//   * POST /api/project-requests/:id/submit   (routes/project-request-lifecycle.ts)
//   * POST /api/project-requests/:id/approve  (routes/project-requests.ts) — the
//     legacy direct approve promotes `draft`/`failed` requests straight into a
//     project and may REPLACE repository_url in its body, so without the gate
//     it was a way around the submit check. It gates the FINAL repo set.
// (POST /api/projects is NOT gated server-side for READABILITY — a deliberate,
// noted gap. It IS gated for PLATFORM-REPO OWNERSHIP, like every write road:
// see `platformRepoRefusalResponse` below, ruling 2026-09-30.)
//
// A request can NOT move on unless we can read every repository it names.
// Public repos pass; a private repo passes only when our GitHub App can read it
// (`private_granted`). Everything else — `private_ungranted`, `error` (rate
// limit, GitHub down) and `unknown` (not a github.com URL, so nothing could be
// checked) — refuses with 422 `repo_access_denied`. This SUPERSEDES the
// 2026-09-21 "advisory, never blocks" decision recorded in migration 123 and
// routes/project-request-repo-access.ts. Draft save is NOT gated.
//
// `error` blocks too, deliberately: "we could not find out" is not "we can
// read it", and letting it through would make a GitHub outage the easiest way
// past the gate. The verdict detail says which it was.
//
// This module deliberately imports nothing from project-requests.ts /
// project-request-lifecycle.ts, so both can import it without a cycle.

import { and, asc, desc, eq } from 'drizzle-orm';

import { db } from '../db/client';
import { projectRequestRepositories } from '../db/schema';
import { jsonResponse } from '../utils/response';
import {
  assessRepoAccess,
  platformRepoRefusals,
  type RepoAccessItem,
} from '../services/repo-access';

export type { RepoAccessItem };

// fr's intake requires a repository_url CP cannot derive; CP posts this sentinel
// (a valid URL so the draft is creatable). Submit/approve require a REAL url, so
// an un-edited sentinel is rejected (422) — mirrors the CP-side constant.
// Re-exported by routes/project-requests.ts, its historical home.
export const FR_REPO_SENTINEL = 'https://example.invalid/REPLACE-IN-FR';

/** The states that let a request through. Nothing else does. */
export const READABLE_ACCESS_STATES = ['public', 'private_granted'] as const;

/**
 * One repository a request names, with the metadata the Stage-A table stores.
 *
 * `position` is the index in the canonical order below and `is_primary` is true
 * for position 0 and nothing else — which is exactly what
 * `project_request_repositories_one_primary_idx` (one primary per request)
 * permits, and what this module's "primary first" contract already meant.
 *
 * ⛔ `position` is DERIVED from the order, never read off the wire. No inbound
 * shape carries one (`ProjectCreateFields.repo` in types/api.ts has no `position`
 * key, so a client that sent one would have it stripped), and a field that is
 * accepted but stripped is a write-only field pretending to be a contract. The
 * ARRAY ORDER is the single source of truth.
 */
export interface RequestRepoEntry {
  url: string;
  branch: string | null;
  path: string | null;
  name: string | null;
  is_primary: boolean;
  position: number;
}

/** The stored row, verdict columns included — the review / webhook view. */
export interface StoredRequestRepo extends RequestRepoEntry {
  access_state: string;
  access_detail: string | null;
  access_checked_at: Date | null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.trim() || null;
}

type RepoFields = { url: string; branch: string | null; path: string | null; name: string | null };

/**
 * Read one candidate into a partial entry, or null when it names no url.
 *
 * Accepts a bare url string and every object shape a request can carry
 * (`repo.primary`, `repo.additional[]`, `repositories[]`, a stored table row).
 * `fallback` supplies what the candidate itself cannot hold: the primary arrives
 * as the scalar `payload.repository_url`, whose branch is the SIBLING scalar
 * `payload.branch` — reading only the candidate would record the project's
 * primary repo with a null branch on every single request.
 */
function entryOf(v: unknown, fallback: Partial<RepoFields> = {}): RepoFields | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const url = o ? str(o.url) : str(v);
  if (!url) return null;
  return {
    url,
    branch: (o ? str(o.branch) : null) ?? str(fallback.branch),
    path: (o ? str(o.path) : null) ?? str(fallback.path),
    name: (o ? str(o.name) : null) ?? str(fallback.name),
  };
}

/**
 * ⭐ THE ONE EXTRACTION. Every repository URL a request names, deduplicated,
 * primary first, WITH the metadata the table stores.
 *
 * `collectRequestRepoUrls` below is this function's `.url` projection and
 * nothing more, and `replaceRequestRepositories` writes exactly these entries.
 * Two extractions that can disagree about the ORDER, the DEDUPE or WHICH repo is
 * primary is the defect class this table exists to close — the gate would then
 * block on a url no row records, or record a verdict against the wrong repo — so
 * there is deliberately only one.
 *
 * Read from EVERY place a request can carry a repo, because a URL we forget to
 * check is a URL the gate lets through unread:
 *   - payload.repository_url            (the ProjectCreate primary; branch from payload.branch)
 *   - payload.repo.primary.url / repo.additional[].url   (the form's shape)
 *   - payload.repositories[].url        (the Stage-A ProjectRequestSchema shape)
 *   - project_request_repositories rows (migration 123), passed in by the caller
 * The CP placeholder sentinel is excluded: the handlers refuse it with their
 * own, more specific 422 before this gate runs.
 *
 * A url seen twice keeps its FIRST position and GAINS any field the first
 * sighting left empty, so a `repo.primary` carrying `path` still records that
 * path when `repository_url` named the same repo first. Merging cannot reorder.
 */
export function collectRequestRepos(
  payload: unknown,
  tableRows: readonly {
    url: string;
    branch?: string | null;
    path?: string | null;
    name?: string | null;
    is_primary?: boolean | null;
    position?: number | null;
  }[] = [],
): RequestRepoEntry[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const repo = (p.repo && typeof p.repo === 'object' ? p.repo : {}) as Record<string, unknown>;
  const candidates: (RepoFields | null)[] = [
    entryOf(p.repository_url, { branch: str(p.branch) }),
    entryOf(repo.primary),
  ];
  if (Array.isArray(repo.additional)) candidates.push(...repo.additional.map((x) => entryOf(x)));
  if (Array.isArray(p.repositories)) candidates.push(...p.repositories.map((x) => entryOf(x)));
  const rows = [...tableRows].sort(
    (a, b) =>
      Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) ||
      (a.position ?? 0) - (b.position ?? 0),
  );
  candidates.push(...rows.map((r) => entryOf(r)));

  const out: RepoFields[] = [];
  const byUrl = new Map<string, RepoFields>();
  for (const c of candidates) {
    if (!c || c.url === FR_REPO_SENTINEL) continue;
    const first = byUrl.get(c.url);
    if (first) {
      first.branch ??= c.branch;
      first.path ??= c.path;
      first.name ??= c.name;
      continue;
    }
    byUrl.set(c.url, c);
    out.push(c);
  }
  return out.map((e, i) => ({ ...e, is_primary: i === 0, position: i }));
}

/** The gate's view of the one extraction: just the urls, in that one order. */
export function collectRequestRepoUrls(
  payload: unknown,
  tableRows: readonly { url: string; is_primary?: boolean | null; position?: number | null }[] = [],
): string[] {
  return collectRequestRepos(payload, tableRows).map((r) => r.url);
}

const REQUEST_REPO_COLUMNS = {
  url: projectRequestRepositories.url,
  branch: projectRequestRepositories.branch,
  path: projectRequestRepositories.path,
  name: projectRequestRepositories.name,
  is_primary: projectRequestRepositories.is_primary,
  position: projectRequestRepositories.position,
};

/**
 * ⛔ THE ONLY WRITER of `project_request_repositories`, and until 2026-09-30
 * there was NO writer at all. Migration 123 created the table, this module
 * SELECTed it, its partial unique index sorted it — and not one line in
 * `backend/src` or `backend/tests` ever INSERTed a row. So the per-repo access
 * verdict the gate computes below had nowhere to land, and a reviewer looking at
 * a denied request could not see WHICH repo failed or WHY without re-probing
 * GitHub. The three verdict columns existed for that answer and were never
 * populated.
 *
 * DELETE-then-INSERT inside ONE transaction, so a re-submit REPLACES the set
 * rather than duplicating it or 23505-ing on `PRIMARY KEY (request_id,
 * position)`. Existing rows are fed back THROUGH the extraction first, so a repo
 * only the table knew about survives the rewrite instead of being silently
 * dropped by it.
 *
 * `access_state` returns to its `unknown` default here on purpose: the set has
 * just changed and `repoAccessGateResponse` re-assesses live immediately after.
 * Carrying a previous verdict forward would be a claim about a repo nobody has
 * looked at yet — which is the precise distinction `unknown` (not checked) vs
 * `error` (checked, could not find out) was created to hold.
 */
export async function replaceRequestRepositories(
  requestId: string,
  payload: unknown,
): Promise<RequestRepoEntry[]> {
  const existing = await db
    .select(REQUEST_REPO_COLUMNS)
    .from(projectRequestRepositories)
    .where(eq(projectRequestRepositories.request_id, requestId));
  const entries = collectRequestRepos(payload, existing);
  await db.transaction(async (tx) => {
    await tx
      .delete(projectRequestRepositories)
      .where(eq(projectRequestRepositories.request_id, requestId));
    if (entries.length > 0) {
      await tx.insert(projectRequestRepositories).values(
        entries.map((e) => ({
          request_id: requestId,
          position: e.position,
          url: e.url,
          branch: e.branch,
          path: e.path,
          name: e.name,
          is_primary: e.is_primary,
        })),
      );
    }
  });
  return entries;
}

/**
 * The stored rows WITH their recorded verdicts, primary first.
 *
 * Ordered by `is_primary DESC, position ASC` rather than by `position` alone:
 * the two agree for anything this module wrote (primary IS position 0), and
 * ordering on both means a row written by some future emitter that disagrees
 * still presents the primary first rather than silently demoting it.
 */
export async function loadRequestRepositories(requestId: string): Promise<StoredRequestRepo[]> {
  const rows = await db
    .select({
      ...REQUEST_REPO_COLUMNS,
      access_state: projectRequestRepositories.access_state,
      access_detail: projectRequestRepositories.access_detail,
      access_checked_at: projectRequestRepositories.access_checked_at,
    })
    .from(projectRequestRepositories)
    .where(eq(projectRequestRepositories.request_id, requestId))
    .orderBy(desc(projectRequestRepositories.is_primary), asc(projectRequestRepositories.position));
  return rows;
}

/**
 * The vocabulary `project_request_repositories_access_state_check` permits
 * (migration 123, widened by 126).
 *
 * ⚠️ A SECOND EMITTER of the same list as `RepoAccessState`
 * (services/repo-access.ts) and the CHECK constraint, and that is the reason
 * `recordAccessVerdicts` below degrades instead of trusting it: if the union
 * gains a value this list has not, a submit that SHOULD have succeeded would
 * die on a 23514 from a cache write.
 */
const RECORDABLE_ACCESS_STATES: readonly string[] = [
  'unknown',
  'public',
  'private_granted',
  'private_ungranted',
  'platform_repo_forbidden',
  'error',
];

/**
 * Record each verdict on the row that names that url — the answer this gate
 * used to compute and throw away.
 *
 * UPDATE-only, matched on `(request_id, url)`. A url the assessor was asked
 * about that has NO row records nothing rather than inventing one: the real case
 * is the approve path's `extraUrls` replacement primary, and an invented row
 * would need a `position` that collides with the set submit wrote.
 *
 * An `access_state` outside the CHECK constraint's vocabulary is stored as
 * `error`, with the rejected value in the detail so it is diagnosable. A widened
 * `RepoAccessState` must never be able to 23514 a submission.
 */
async function recordAccessVerdicts(
  requestId: string,
  items: readonly RepoAccessItem[],
): Promise<void> {
  const at = new Date();
  for (const item of items) {
    const known = RECORDABLE_ACCESS_STATES.includes(item.access_state);
    await db
      .update(projectRequestRepositories)
      .set({
        access_state: known ? item.access_state : 'error',
        access_detail: known
          ? item.detail
          : `unrecognised access_state '${item.access_state}': ${item.detail}`,
        access_checked_at: at,
      })
      .where(
        and(
          eq(projectRequestRepositories.request_id, requestId),
          eq(projectRequestRepositories.url, item.url),
        ),
      );
  }
}

/**
 * ⛔ THE PLATFORM-REPO OWNERSHIP GATE as a response (owner ruling 2026-09-30).
 * Pure: no DB, no GitHub. Returns the 422 `repo_access_denied` Response — the
 * SAME shape `repoAccessGateResponse` sends — when a non-platform tenant names
 * a repository under an internal owner (services/repo-access.ts
 * `platformRepoRefusals`), else null. Every road that lets a tenant put a repo
 * into fr calls it BEFORE any write or probe.
 */
export function platformRepoRefusalResponse(
  urls: readonly string[],
  tenantId: string | null | undefined,
): Response | null {
  const body = platformRepoRefusalBody(urls, tenantId);
  return body ? jsonResponse(body, 422) : null;
}

/** The 422 body behind `platformRepoRefusalResponse` (for throw-style callers). */
export function platformRepoRefusalBody(
  urls: readonly string[],
  tenantId: string | null | undefined,
): { error: 'repo_access_denied'; message: string; items: RepoAccessItem[] } | null {
  const items = platformRepoRefusals(
    [...new Set(urls.filter((u) => typeof u === 'string' && u && u !== FR_REPO_SENTINEL))],
    tenantId,
  );
  if (items.length === 0) return null;
  return {
    error: 'repo_access_denied',
    message:
      'this workspace may not use repositories owned by a platform organisation — remove them and try again',
    items,
  };
}

/** The verdicts that refuse the request. Empty = every repo is readable. */
export function repoAccessBlockers(items: readonly RepoAccessItem[]): RepoAccessItem[] {
  return items.filter(
    (i) => !(READABLE_ACCESS_STATES as readonly string[]).includes(i.access_state),
  );
}

/**
 * Run the gate over the request's repositories. Returns the 422
 * `repo_access_denied` Response to send, or null when every repo is readable.
 *
 * ⚠️ IT WRITES — corrected 2026-09-30, this docblock said "Performs NO writes".
 * It now records every verdict into `project_request_repositories`
 * (`access_state` / `access_detail` / `access_checked_at`), the three columns
 * migration 123 created for exactly this answer and that nothing had ever
 * populated. What the original sentence was PROTECTING is still true and is the
 * part that matters: a refusal changes no `status` and appends no `history`
 * entry, so a denied request is left exactly where it was. Recording WHICH repo
 * refused and why is the point of the row, not a side effect — it is what lets a
 * reviewer read the verdict instead of re-probing GitHub.
 *
 * `payload` is the payload whose repos are being finalised (for approve: the
 * stored payload merged with the body's edits, so a replaced repository_url is
 * what gets checked). `extraUrls` are prepended (approve passes the validated
 * primary). `tenantId` is the caller's active tenant — it decides whether
 * internal-owner repos may be probed at all (services/repo-access.ts).
 */
export async function repoAccessGateResponse(opts: {
  requestId: string;
  tenantId: string;
  payload: unknown;
  extraUrls?: readonly string[];
  verb: 'submit' | 'approve';
}): Promise<Response | null> {
  const tableRows = await db
    .select({
      url: projectRequestRepositories.url,
      is_primary: projectRequestRepositories.is_primary,
      position: projectRequestRepositories.position,
    })
    .from(projectRequestRepositories)
    .where(eq(projectRequestRepositories.request_id, opts.requestId));
  const urls = [
    ...new Set([
      ...(opts.extraUrls ?? []).filter((u) => u && u !== FR_REPO_SENTINEL),
      ...collectRequestRepoUrls(opts.payload, tableRows),
    ]),
  ];
  // NO REPOSITORY ⇒ the gate is NOT APPLICABLE (George 2026-10-13: a repo is
  // optional). Nothing to probe, nothing to record — and no GitHub call.
  if (urls.length === 0) return null;
  // ⛔ PLATFORM-REPO OWNERSHIP first (pure — no GitHub probe): a non-platform
  // tenant naming an internal-owner repo is refused even when the repo is
  // PUBLIC, which the assessor below would otherwise pass. The refusal is
  // recorded on the request's rows like every other verdict, so a reviewer can
  // read WHY without re-running anything.
  const refused = platformRepoRefusals(urls, opts.tenantId);
  if (refused.length > 0) {
    await recordAccessVerdicts(opts.requestId, refused);
    return jsonResponse(
      {
        error: 'repo_access_denied',
        message: `this workspace may not use repositories owned by a platform organisation — remove them and ${opts.verb} again`,
        items: refused,
      },
      422,
    );
  }
  const verdicts = await assessRepoAccess(urls, { tenantId: opts.tenantId });
  // A URL the assessor did not answer for is NOT readable. Guard against a
  // short answer turning "unchecked" into "passed".
  const answered = new Set(verdicts.map((v) => v.url));
  const missing: RepoAccessItem[] = urls
    .filter((u) => !answered.has(u))
    .map((u) => ({ url: u, access_state: 'unknown', detail: 'access was not checked' }));
  // Record BEFORE deciding, and for every repo rather than only the blockers: a
  // reviewer needs to see that the other repos were checked and passed, else an
  // absent verdict is indistinguishable from a repo nobody looked at.
  await recordAccessVerdicts(opts.requestId, [...verdicts, ...missing]);

  const blockers = [...repoAccessBlockers(verdicts), ...missing];
  if (blockers.length === 0) return null;
  return jsonResponse(
    {
      error: 'repo_access_denied',
      message: `we cannot read every repository this request names — grant read access (or fix the URL) and ${opts.verb} again`,
      items: blockers,
    },
    422,
  );
}
