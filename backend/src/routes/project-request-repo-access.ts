// routes/project-request-repo-access.ts
//
// CAN WE READ THE REPOSITORIES A PROJECT REQUEST NAMES?
//
// ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────
//
// All of our work happens on repository files. The project request form used
// to ask for "data classification / target environment / access
// requirements" — fields nothing consumed — while never checking the one fact
// that decides whether the work is possible at all: whether WE can read the
// repos. A project could be created against an unreadable repo and nobody
// learned until the clone failed downstream.
//
// ── WHERE THE LOGIC LIVES ───────────────────────────────────────────────────
//
// The classification moved to `services/repo-access.ts` (`assessRepoAccess`),
// which asks coding-github's authenticated clone-token endpoint — the only
// instrument that can report `private_granted`. The previous anonymous
// `GET api.github.com/repos/...` answered 404 for every private repo, granted
// or not. This route keeps only auth, input validation and the response shape.

import { z } from 'zod';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { jsonResponse } from '../utils/response';
import { assessRepoAccess } from '../services/repo-access';

export {
  parseGithubRepo,
  type RepoAccessState,
  type RepoAccessVerdict,
  type RepoAccessItem,
} from '../services/repo-access';

export const VerifyRepoAccessBody = z
  .object({
    urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(20),
  })
  .strict();

function ctxTenantIdOrNull(fallback: string | null | undefined): string | null {
  try {
    return ctxTenantId(fallback);
  } catch {
    return null; // unknown tenant → treated as NOT internal (fail closed)
  }
}

/** POST /api/project-requests/verify-repo-access */
export async function handleVerifyRepoAccess(req: Request): Promise<Response> {
  let tenantId: string | null;
  try {
    const user = await validateAuth(req);
    // The ACTIVE tenant decides whether internal-owner repos may be probed
    // (services/repo-access.ts § CROSS-TENANT DISCLOSURE).
    tenantId = ctxTenantIdOrNull(user.tenantId);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: z.infer<typeof VerifyRepoAccessBody>;
  try {
    body = VerifyRepoAccessBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse({ error: 'invalid request body', details: e.errors }, 422);
    }
    if (e instanceof SyntaxError) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    throw e;
  }

  const items = await assessRepoAccess(body.urls, { tenantId });
  return jsonResponse({ items });
}
