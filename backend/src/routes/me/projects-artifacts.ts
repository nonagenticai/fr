/**
 * GET /api/me/projects/artifacts
 *
 * Returns artifacts visible to the calling user across all of their tenant's
 * projects. Tenant scoping is enforced upstream (artifact_service uses the
 * bearer token / X-Tenant-Id header to scope results). There is no local
 * `project_members` table yet in fr-backend; the upstream's `visibility_scope`
 * is the effective enforcement boundary until that slice ships.
 *
 * Pagination: offset-based (matching ArtifactsListCrossProjectParams). The
 * response includes `next_offset` when there are more results so the frontend
 * can page forward without client-side cursor logic.
 */

import { z } from 'zod';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { listArtifactsCrossProject } from '../../integrations/artifacts';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  kind: z.string().optional(),
});

export async function handleGetMyProjectsArtifacts(
  req: Request,
): Promise<Response> {
  await validateAuth(req);

  const url = new URL(req.url);
  const params = querySchema.parse(Object.fromEntries(url.searchParams));

  const items = await listArtifactsCrossProject({
    limit: params.limit,
    offset: params.offset,
    ...(params.kind ? { kind: params.kind as never } : {}),
  });

  const nextOffset =
    items.length === params.limit ? params.offset + params.limit : null;

  return jsonResponse({ items, next_offset: nextOffset });
}
