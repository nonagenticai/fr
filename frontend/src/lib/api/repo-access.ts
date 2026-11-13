// Client for POST /api/project-requests/verify-repo-access.
//
// BLOCKING (decision George, 2026-09-22 — supersedes the 2026-09-21 "advisory,
// never blocks"). A request cannot be submitted unless every repository is
// `public` or `private_granted`; the backend refuses the submit with a 422
// `repo_access_denied` otherwise, and the form mirrors that so the user sees it
// before clicking. A failure of this call is reported as a failed CHECK, never
// as "your repo is private" — the two lead the user to do completely different
// things.

import { authFetch } from './auth-fetch';

export type RepoAccessState =
  | 'unknown'
  | 'public'
  | 'private_granted'
  | 'private_ungranted'
  /**
   * coding-github refused a PLATFORM-owned repo (`nonagenticai`) because this
   * workspace is not one of its platform tenants. Kept distinct from
   * `private_ungranted` — nothing is missing and no grant would help — and
   * from `error` — nothing failed and re-checking cannot change the answer.
   * Mirrors backend/src/services/repo-access.ts.
   */
  | 'platform_repo_forbidden'
  | 'error';

export interface RepoAccessVerdict {
  url: string;
  access_state: RepoAccessState;
  detail: string;
}

export async function verifyRepoAccess(urls: string[]): Promise<RepoAccessVerdict[]> {
  const res = await authFetch('/api/project-requests/verify-repo-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls })
  });
  if (!res.ok) {
    throw new Error(`repository access check failed (${res.status})`);
  }
  const body = (await res.json()) as { items?: RepoAccessVerdict[] };
  if (!Array.isArray(body.items)) {
    throw new Error('repository access check returned an unexpected response');
  }
  return body.items;
}

/** The only states that let a submit through. Mirrors the backend gate. */
export const READABLE_ACCESS_STATES: readonly RepoAccessState[] = ['public', 'private_granted'];

export function isReadable(v: RepoAccessVerdict | undefined | null): boolean {
  return !!v && READABLE_ACCESS_STATES.includes(v.access_state);
}

/**
 * The per-repo items of a 422 `repo_access_denied` from the submit API, or null
 * when the error body is anything else. `detail` may be null on the wire.
 */
export function parseRepoAccessDenied(data: unknown): RepoAccessVerdict[] | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { error?: unknown; items?: unknown };
  if (d.error !== 'repo_access_denied' || !Array.isArray(d.items)) return null;
  return d.items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .map((i) => ({
      url: String(i.url ?? ''),
      access_state: (typeof i.access_state === 'string' ? i.access_state : 'unknown') as RepoAccessState,
      detail: typeof i.detail === 'string' ? i.detail : ''
    }));
}

/** How a verdict is worded to the user. Never claims more than was measured. */
export function describeVerdict(v: RepoAccessVerdict): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  switch (v.access_state) {
    case 'public':
      return { tone: 'ok', text: 'Public — we can read it.' };
    case 'private_granted':
      return { tone: 'ok', text: 'Private — we have access.' };
    case 'private_ungranted':
      return {
        tone: 'warn',
        text: 'We cannot read this repository (it is private or does not exist). Grant us read access or fix the URL — it cannot be submitted until we can read it.'
      };
    case 'platform_repo_forbidden':
      // ⛔ NOT the `private_ungranted` wording ("grant us read access") and NOT
      // the `error` wording ("re-check"): neither action can change this
      // answer. The repository is platform-owned and this workspace may not
      // act on it — the only remedy is a different workspace.
      return {
        tone: 'warn',
        text: 'This repository belongs to the platform organisation and this workspace is not permitted to use it. Switch to a workspace that owns it, or name a different repository.'
      };
    case 'error':
      return { tone: 'warn', text: `Could not check: ${v.detail} — re-check before submitting.` };
    default:
      return {
        tone: 'warn',
        text: `${v.detail || 'Not checked.'} — only repositories we can read can be submitted.`
      };
  }
}
