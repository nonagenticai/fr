// services/repo-access.ts
//
// CAN WE READ THE REPOSITORIES A PROJECT REQUEST NAMES?
//
// ── THE INSTRUMENT ──────────────────────────────────────────────────────────
//
// coding-github's authenticated `POST /api/internal/github/clone-token`. It
// tries to mint a contents:read token through the nonagenticai GitHub App and
// reports the repo's visibility. That is the only instrument that can say
// `private_granted`: an anonymous `GET api.github.com/repos/...` answers 404
// for every private repo, granted or not.
//
// ⛔ NO FALLBACK TO ANONYMOUS GITHUB. When coding-github is not configured the
// verdict is `error`, not an anonymous guess — the anonymous path can never
// see a grant, so it would turn every one of our own private repos into
// `private_ungranted` and tell the user to fix a grant that is not broken.
//
// ── THE MINTED TOKEN IS DISCARDED ───────────────────────────────────────────
//
// We need the verdict, not the credential. The token is dropped the moment
// the result is read and never reaches a verdict, a log, or the response.
//
// ── CROSS-TENANT DISCLOSURE (audit 2026-09-22) ──────────────────────────────
//
// The instrument is OUR GitHub App, so its answer about a repo under one of
// OUR owners (`public` vs `private_granted` vs not-found) tells the caller
// whether a private nonagenticai repo EXISTS. Any tenant could enumerate them.
// So for a caller whose tenant is NOT internal (`isInternalTenant` — the same
// predicate `requireAnyInternalTenant` uses), a URL whose owner is listed in
// `FR_REPO_ACCESS_INTERNAL_OWNERS` (comma list, default `nonagenticai`,
// case-insensitive) is NEVER sent to coding-github. It gets only the
// ANONYMOUS GitHub lookup — what any stranger can already see: a public repo
// answers `public`, anything else `private_ungranted` with the SAME detail a
// genuinely missing repo gets. Internal
// tenants are unaffected. The tenant scope is a REQUIRED argument so no caller
// can forget it.
//
// `unknown` (not checked — e.g. a non-GitHub URL) stays distinct from `error`
// (checked and failed). The vocabulary matches the CHECK constraint on
// `project_request_repositories.access_state`
// (migrations/123_project_request_lifecycle.sql, widened by
// migrations/126_repo_access_platform_repo_forbidden.sql).
//
// ── THE PLATFORM-REPO TENANT GATE (coding-github) ───────────────────────────
//
// coding-github gates repos under a PLATFORM owner (`nonagenticai`) to the
// tenants in `CODING_GITHUB_PLATFORM_TENANTS`
// (`src/services/tenant_binding.py check_platform_repo_tenant`). Its default
// allowlist is the five canonical `0195f48b-d000-7000-8000-00000000000{1..5}`
// workspaces — which is EXACTLY the set `internalCaller` below admits (the
// four `INTERNAL_TENANT_IDS` plus `EXECUTION_TENANT_ID`). A request that
// carries no `tenant_id` is STRICTLY non-platform there, so once
// `CODING_GITHUB_PLATFORM_TENANT_ENFORCE` is on, the tenantless internal-owner
// request fr used to send would be refused.
//
// So the internal-owner branch sends the CALLER'S OWN tenant, the same tenant
// `routes/project-constraint-check.ts` already sends (`project.tenantId`).
//
// The refusal arrives as HTTP 200 `{token: null, source: 'none', reason:
// 'platform_repo_forbidden'}`, NOT a 403. Without an explicit case it fell
// through to `private_ungranted` — "repository not found, or the GitHub App is
// not installed" — which is a silently WRONG answer: the repo exists, the App
// is installed, and the caller's workspace is simply not allowed to ask. It
// has its own `access_state` so nothing has to guess.

import {
  CodingGithubError,
  CodingGithubNotConfiguredError,
  requestCloneToken,
  type CloneTokenResult,
} from '../integrations/coding-github/client';
import { EXECUTION_TENANT_ID, KATA_TENANT_ID, isInternalTenant } from '../middleware/internal-tenant-only';

export type RepoAccessState =
  | 'unknown'
  | 'public'
  | 'private_granted'
  | 'private_ungranted'
  /**
   * coding-github refused a PLATFORM-owned repo because the caller's tenant is
   * not in `CODING_GITHUB_PLATFORM_TENANTS`. Distinct from `private_ungranted`
   * (nothing is missing, and no grant would fix it) and from `error` (nothing
   * failed, and re-checking will not change the answer).
   */
  | 'platform_repo_forbidden'
  | 'error';

export interface RepoAccessItem {
  url: string;
  access_state: RepoAccessState;
  detail: string;
}

/** @deprecated alias kept for existing importers; same shape as RepoAccessItem. */
export type RepoAccessVerdict = RepoAccessItem;

// GitHub owner: alnum + hyphen. Repo: alnum, hyphen, underscore, dot.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Extract owner/repo from a github.com URL. Accepts https (with or without
 * www, `.git` suffix, trailing slash, extra path such as /tree/main) and the
 * scp-style `git@github.com:owner/repo.git`. Returns null for anything else.
 */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  let path: string;
  const scp = /^git@github\.com:(.+)$/i.exec(raw);
  if (scp) {
    path = scp[1] ?? '';
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    path = parsed.pathname;
  }

  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (parts.length < 2) return null;
  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return null;
  }
  return { owner, repo };
}

export const REPO_ACCESS_INTERNAL_OWNERS_ENV = 'FR_REPO_ACCESS_INTERNAL_OWNERS';
const DEFAULT_INTERNAL_OWNERS = 'nonagenticai';

/** Lower-cased owners only internal tenants may probe. Unset/blank → the default (fail closed). */
export function internalRepoOwners(): Set<string> {
  const raw = (process.env[REPO_ACCESS_INTERNAL_OWNERS_ENV] ?? '').trim() || DEFAULT_INTERNAL_OWNERS;
  return new Set(
    raw
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * ⛔ THE PLATFORM-TENANT SET for repositories under an internal owner — ONE
 * definition, used by `assessRepoAccess` (may we probe?) and by
 * `platformRepoRefusals` (may this tenant put the repo into fr at all?).
 *
 * EXACTLY the five canonical `0195f48b-d000-7000-8000-00000000000{1..5}`
 * workspaces: the four `INTERNAL_TENANT_IDS` plus `EXECUTION_TENANT_ID` (ours
 * too — it runs the conveyor on our own repos — but `isInternalTenant`
 * deliberately excludes it, so it is admitted explicitly). This matches
 * coding-github's `CODING_GITHUB_PLATFORM_TENANTS` default.
 *
 * ⚠️ NOT `PLATFORM_TENANT_IDS` (services/system-union.ts): that set also holds
 * the AA conveyor tenant, which coding-github REFUSES for platform repos.
 * null/undefined = unknown = NOT platform (fail closed).
 */
export function isRepoPlatformTenant(tenantId: string | null | undefined): boolean {
  if (!tenantId) return false;
  // The kata tenant is internal but NOT repo-platform: coding-github's set does not hold it.
  if (tenantId === KATA_TENANT_ID) return false;
  return isInternalTenant(tenantId) || tenantId === EXECUTION_TENANT_ID;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `host` a GitHub-family host? `github.com`, any `*.github.com`
 * (api., gist., www., codeload., …) and any `*githubusercontent.com`
 * (raw., objects., avatars., …). A trailing root dot is ignored.
 */
export function isGithubFamilyHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return h === 'github.com' || h.endsWith('.github.com') || h.endsWith('githubusercontent.com');
}

/** Percent-decode repeatedly (double-encoding), stopping on a malformed escape. */
function decodeDeep(s: string): string {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Host + the rest (path, query, fragment) of a url-ish string, or null. */
function splitHostAndRest(raw: string): { host: string; rest: string } | null {
  let s = raw.trim().replace(/\\/g, '/');
  if (!s) return null;
  // `https:/host`, `https:///host` (and backslash forms above) → `https://host`
  s = s.replace(/^([a-z][a-z0-9+.-]*):\/+/i, '$1://');
  if (s.startsWith('//')) s = `https:${s}`;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme) {
    // scp-like `[user@]host:path` (git@github.com:owner/repo.git)
    const scp = /^(?:[^@/\s]+@)?([^:/\s@]+):(.*)$/.exec(s);
    if (scp) return { host: scp[1] ?? '', rest: scp[2] ?? '' };
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    return { host: u.hostname, rest: `${u.pathname}${u.search}${u.hash}` };
  } catch {
    return null;
  }
}

/** Canonical form for the host-agnostic owner check: decoded, no control/space chars, `/` only, lower-case. */
function normaliseRepoRef(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    const next = decodeDeep(cur)
      // whitespace, C0/C1 controls, zero-width + BOM
      .replace(/[\s\u0000-\u001f\u007f-\u009f​-‍⁠﻿]+/g, '')
      .replace(/\\/g, '/');
    if (next === cur) break;
    cur = next;
  }
  return cur.toLowerCase();
}

/** Path segments with empty and `.` segments dropped (`//`, `/./` collapsed). */
function pathSegments(path: string): string[] {
  return path.split('/').filter((p) => p !== '' && p !== '.');
}

function ownerSegmentMatch(seg: string | undefined, owners: Set<string>): string | null {
  if (!seg) return null;
  let o = seg;
  if (o.endsWith('.git')) o = o.slice(0, -4);
  o = o.replace(/\.+$/, '');
  return o && owners.has(o) ? o : null;
}

/**
 * Every path a downstream parser could read owner/repo from, for any host:
 * the URL path of a `scheme://authority/path`, the path of scp `[user@]host:path`
 * (and coding-github's literal `git@…` split-at-first-colon), a scheme-less
 * `host.tld/path`, and the whole string as a bare `owner/repo` or `/owner/repo`.
 */
function candidateRepoPaths(ref: string): string[] {
  // Deliberately a UNION of readings — over-matching only ever refuses; a
  // reading we fail to take is a bypass.
  const out: string[] = [];
  const noQuery = (p: string) => p.split(/[?#]/)[0] ?? '';
  const scheme = /^[a-z][a-z0-9+.-]*:(.*)$/.exec(ref);
  if (scheme) {
    const after = scheme[1] ?? '';
    // `scheme:/path`, `scheme:path` (urlparse: no netloc → the whole remainder
    // is the path), and scp `host:owner/repo` read the same way.
    out.push(noQuery(after));
    if (after.startsWith('//')) {
      // `scheme://authority/path` — drop the authority, as urlparse().path does.
      const rest = after.slice(2);
      const slash = rest.indexOf('/');
      const authority = slash === -1 ? rest : rest.slice(0, slash);
      const path = slash === -1 ? '' : rest.slice(slash);
      out.push(noQuery(path));
      // malformed `ssh://git@host:<owner>/r` — the text after the authority's colon
      const colon = authority.lastIndexOf(':');
      if (colon !== -1) out.push(noQuery(`${authority.slice(colon + 1)}${path}`));
    }
  }
  // coding-github: a `git@…` ref is split at its FIRST colon.
  if (ref.startsWith('git@')) out.push(noQuery(ref.slice(ref.indexOf(':') + 1)));
  // scp `[user@]host:path`
  const scp = /^(?:[^@/]+@)?[^:/]+:(.*)$/.exec(ref);
  if (scp) out.push(noQuery(scp[1] ?? ''));
  // bare `owner/repo`, `/owner/repo`, and scheme-less `host.tld[:port]/path`
  const bare = noQuery(ref);
  out.push(bare);
  const segs = pathSegments(bare);
  if (segs.length > 1 && /[.:@]/.test(segs[0] ?? '')) out.push(segs.slice(1).join('/'));
  return out;
}

/**
 * The WHATWG-normalised pathname (dot segments resolved, `%2e%2e` included) of
 * `raw`, parsed the way lib/repository-name.ts `parseUrlLoosely` does: as-is,
 * then with an `https://` prefix. null when neither form parses.
 */
function whatwgPathname(raw: string): string | null {
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      return new URL(candidate).pathname;
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * Host-agnostic: the internal owner that is the FIRST path segment of any
 * reading of `url` (also after a leading `repos/`, the api.github.com shape),
 * or null. `nonagenticai-fake/x` is not EQUAL to `nonagenticai`, so it passes.
 */
export function internalOwnerByFirstSegment(
  url: string,
  owners: Set<string> = internalRepoOwners(),
): string | null {
  if (typeof url !== 'string' || owners.size === 0) return null;
  const ref = normaliseRepoRef(url);
  if (!ref) return null;
  for (const path of candidateRepoPaths(ref)) {
    const segs = pathSegments(path);
    const hit =
      ownerSegmentMatch(segs[0], owners) ??
      (segs[0] === 'repos' ? ownerSegmentMatch(segs[1], owners) : null);
    if (hit) return hit;
  }
  return null;
}

/**
 * The lower-cased internal owner a url names, or null. FAILS CLOSED on purpose:
 * for ANY GitHub-family host (`isGithubFamilyHost` — github.com, api./gist./www.
 * github.com, raw.githubusercontent.com, …) in ANY spelling (scheme, scheme-less,
 * scp, ssh, uppercase, trailing dot, port, percent-encoded, backslashes), a url
 * is refused when ANY host label or ANY path/query segment equals an internal
 * owner (case-insensitive, `.git` stripped). So `api.github.com/repos/<owner>/…`
 * and `raw.githubusercontent.com/<owner>/…` are caught even though their owner
 * is not the first segment. Precision is traded for safety on GitHub hosts only;
 * `nonagenticai-fake` (not an EQUAL segment) and non-GitHub hosts never match.
 * A legacy loose scan for `github.com/<owner>` embedded anywhere is kept as a
 * second net.
 */
export function internalOwnerOf(url: string, owners: Set<string> = internalRepoOwners()): string | null {
  if (typeof url !== 'string' || owners.size === 0) return null;
  const raw = url.trim();
  if (!raw) return null;
  const decoded = decodeDeep(raw);

  // HOST-AGNOSTIC first-segment rule (review 2026-09-30). coding-github's
  // `parse_repo_url` (src/routers/github_internal.py) derives owner/repo from
  // the URL PATH ALONE and ignores the host, so `https://gitlab.com/<owner>/r`,
  // a look-alike host, bare `<owner>/r` and scp `git@anyhost:<owner>/r` all
  // resolve to `<owner>/r` downstream. Judge the path the same way, for ANY host.
  const first = internalOwnerByFirstSegment(raw, owners);
  if (first) return first;

  // WHATWG view (review 2026-09-30): `new URL()` RESOLVES dot segments —
  // `…/acme/../<owner>/r` and `…/acme/%2e%2e/<owner>/r` have pathname
  // `/<owner>/r` — and lib/repository-name.ts deriveRepositoryNameFromUrl reads
  // exactly that pathname (raw, then `https://` + raw). Judge the same view;
  // refuse if EITHER reading yields an internal owner.
  const whatwgPath = whatwgPathname(raw);
  if (whatwgPath !== null) {
    const byUrl = internalOwnerByFirstSegment(whatwgPath, owners);
    if (byUrl) return byUrl;
  }

  for (const candidate of new Set([raw, decoded])) {
    const hr = splitHostAndRest(candidate);
    if (!hr) continue;
    const host = decodeDeep(hr.host).toLowerCase();
    if (!isGithubFamilyHost(host)) continue;
    const tokens = [
      ...host.replace(/\.+$/, '').split('.'),
      ...hr.rest.split(/[/:?#&=;@]+/),
    ];
    for (const t of tokens) {
      let seg = decodeDeep(t).trim().toLowerCase();
      if (seg.endsWith('.git')) seg = seg.slice(0, -4);
      seg = seg.replace(/\.+$/, '');
      if (seg && owners.has(seg)) return seg;
    }
  }

  const alternation = [...owners].map(escapeRegExp).join('|');
  const loose = new RegExp(
    `(^|[/@.])(www\\.)?github\\.com\\.?(:\\d+)?[:/]+(${alternation})(?=/|$|\\.git|\\?|#)`,
    'i',
  );
  const m = loose.exec(raw) ?? loose.exec(decoded);
  return m ? (m[4] ?? '').toLowerCase() : null;
}

/**
 * ⛔ PLATFORM-REPO OWNERSHIP GATE (owner ruling 2026-09-30).
 *
 * Only a platform tenant (`isRepoPlatformTenant`) may put a repository owned by
 * an internal owner (`FR_REPO_ACCESS_INTERNAL_OWNERS`, default `nonagenticai`)
 * into fr. Every other tenant is refused — INCLUDING for PUBLIC repos, which
 * `assessRepoAccess` would otherwise answer `public` and let through. Pure: no
 * network, no DB, so every write path can run it before touching anything.
 *
 * Returns one `platform_repo_forbidden` item per offending url (input order);
 * empty = allowed.
 */
export function platformRepoRefusals(
  urls: readonly string[],
  tenantId: string | null | undefined,
): RepoAccessItem[] {
  if (isRepoPlatformTenant(tenantId)) return [];
  const owners = internalRepoOwners();
  const out: RepoAccessItem[] = [];
  for (const url of urls) {
    const owner = internalOwnerOf(url, owners);
    if (owner) {
      out.push({
        url,
        access_state: 'platform_repo_forbidden',
        detail: `${owner} is a platform-owned organisation — this workspace is not permitted to use its repositories`,
      });
    }
  }
  return out;
}

/** Whose question is this? Decides whether internal-owner repos may be probed. */
export interface RepoAccessScope {
  /** The caller's ACTIVE tenant. null/undefined = unknown = treated as NOT internal. */
  tenantId: string | null | undefined;
}

function notFoundOrUngranted(url: string, owner: string): RepoAccessItem {
  return {
    url,
    access_state: 'private_ungranted',
    detail: `repository not found, or the nonagenticai GitHub App is not installed on ${owner}`,
  };
}

/** Map a clone-token answer to a verdict. Pure; never sees the token. */
export function verdictFromCloneToken(
  url: string,
  owner: string,
  r: Pick<CloneTokenResult, 'visibility' | 'source' | 'reason'>,
): RepoAccessItem {
  if (r.visibility === 'public') {
    return { url, access_state: 'public', detail: 'public repository — we can read it' };
  }
  if (r.source === 'app') {
    return {
      url,
      access_state: 'private_granted',
      detail: 'private repository — the nonagenticai GitHub App can read it',
    };
  }
  switch (r.reason) {
    case 'platform_repo_forbidden':
      // ⛔ NOT `private_ungranted`. coding-github's platform-repo tenant gate
      // refused: the repo exists and our App can read it, but this workspace
      // may not act on a platform-owned repository. No grant, no re-check and
      // no App installation changes that — only being a platform tenant does.
      return {
        url,
        access_state: 'platform_repo_forbidden',
        detail:
          `${owner} is a platform-owned organisation — this workspace is not permitted ` +
          'to act on its repositories',
      };
    case 'not_configured':
      return {
        url,
        access_state: 'error',
        detail: 'the GitHub App is not configured on coding-github — access could not be checked',
      };
    case 'tenant_required':
      // coding-github refuses a non-internal owner without the caller's tenant
      // (it can only mint via an installation bound to that tenant).
      return {
        url,
        access_state: 'error',
        detail: 'no tenant context was available for this check — access could not be checked',
      };
    case 'mint_failed':
      return {
        url,
        access_state: 'error',
        detail: 'the GitHub App could not mint a token (GitHub error) — access could not be checked',
      };
    default:
      // not_installed, or an older coding-github that omits `reason`. Either
      // way no credential exists for a repo that is private-or-missing, so we
      // cannot read it.
      return notFoundOrUngranted(url, owner);
  }
}

const GITHUB_API = 'https://api.github.com';

/**
 * Anonymous `GET api.github.com/repos/{o}/{r}` (the pre-#1156 lookup), used ONLY
 * for a non-internal caller asking about an internal-owner repo. It can reveal
 * nothing an unauthenticated stranger could not: 200 + `private: false` →
 * `public`; any other outcome (404, rate limit, timeout, network error, odd
 * body) → the same `private_ungranted` a genuinely missing repo gets.
 */
async function anonymousPublicOrHidden(
  url: string,
  owner: string,
  repo: string,
): Promise<RepoAccessItem> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'fr-project-request-repo-access',
        },
        signal: controller.signal,
      },
    );
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { private?: unknown } | null;
      if (body?.private === false) {
        return { url, access_state: 'public', detail: 'public repository — we can read it' };
      }
    }
  } catch {
    // fall through: indistinguishable from missing
  } finally {
    clearTimeout(timer);
  }
  return notFoundOrUngranted(url, owner);
}

async function assessOne(
  url: string,
  internalCaller: boolean,
  owners: Set<string>,
  tenantId: string | null | undefined,
): Promise<RepoAccessItem> {
  const parsed = parseGithubRepo(url);
  if (!parsed) {
    return {
      url,
      access_state: 'unknown',
      detail: 'only github.com repositories can be checked automatically',
    };
  }
  if (!internalCaller && owners.has(parsed.owner.toLowerCase())) {
    // OUR GitHub App is never asked. Only the anonymous answer — what anyone on
    // the internet can already see — may distinguish anything: public stays
    // public, everything else reads exactly like a missing repo.
    return anonymousPublicOrHidden(url, parsed.owner, parsed.repo);
  }

  let result: CloneTokenResult;
  try {
    // The tenant rides the BODY on EVERY branch (never a header — see the
    // client's file note).
    //   * non-internal owner: the PUBLIC GitHub App mints only through an
    //     installation bound to the caller's tenant, so it is required.
    //   * internal (platform) owner: coding-github's platform-repo gate treats
    //     an absent tenant as strictly non-platform, so under
    //     CODING_GITHUB_PLATFORM_TENANT_ENFORCE a tenantless request is
    //     refused. This branch is only reachable for an `internalCaller`, i.e.
    //     one of the five canonical workspaces that ARE platform tenants — so
    //     sending the caller's own tenant is both truthful and sufficient.
    //     Same tenant routes/project-constraint-check.ts sends.
    result = await requestCloneToken(`https://github.com/${parsed.owner}/${parsed.repo}`, {
      tenantId: tenantId ?? null,
    });
  } catch (e) {
    if (e instanceof CodingGithubNotConfiguredError) {
      return { url, access_state: 'error', detail: 'repo access check not configured' };
    }
    if (e instanceof CodingGithubError) {
      return { url, access_state: 'error', detail: `${e.message} — access could not be checked` };
    }
    return { url, access_state: 'error', detail: 'access check failed unexpectedly' };
  }

  // Discard the credential immediately; only the classification survives.
  const { visibility, source, reason } = result;
  result.token = null;
  return verdictFromCloneToken(url, parsed.owner, { visibility, source, reason });
}

/**
 * Classify each url. Never throws and preserves input order: every failure
 * becomes an `error` verdict, so one bad url can never fail a batch.
 */
export async function assessRepoAccess(
  urls: string[],
  scope: RepoAccessScope,
): Promise<RepoAccessItem[]> {
  const internalCaller = isRepoPlatformTenant(scope.tenantId);
  const owners = internalRepoOwners();
  const settled = await Promise.allSettled(
    urls.map((u) => assessOne(u, internalCaller, owners, scope.tenantId)),
  );
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { url: urls[i] ?? '', access_state: 'error', detail: 'access check failed unexpectedly' },
  );
}
