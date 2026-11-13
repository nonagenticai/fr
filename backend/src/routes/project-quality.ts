// src/routes/project-quality.ts
//
// The project Quality tab (fr#1305) — thin handlers over
// services/project-quality.ts. Conventions follow routes/coding/handlers.ts:
// withIntegrationCatch → validateAuth → ctxTenantId (explicit tenant, honours
// the super-admin workspace override) → jsonResponse({ data }).
//
//   GET  /api/projects/:id/quality                 stored result + CI per repo (read lane)
//   GET  /api/projects/:id/quality/history?repo_id= stored history for one repo (read lane)
//   POST /api/projects/:id/quality/analyze         202; ensure workspace + analyze in background
//                                                  (write lane — same gate as Provision);
//                                                  409 + current state while one is in flight

import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { jsonResponse } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import {
  readProjectQuality,
  readProjectQualityHistory,
  startProjectQualityAnalysis,
} from '../services/project-quality';
import { withIntegrationCatch } from './_lib';

// GET /api/projects/:id/quality
export function handleGetProjectQuality(req: Request, projectId: string): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const data = await readProjectQuality(user, projectId, tenantId);
    return jsonResponse({ data });
  });
}

// GET /api/projects/:id/quality/history?repo_id=
export function handleGetProjectQualityHistory(
  req: Request,
  projectId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const repoId = new URL(req.url).searchParams.get('repo_id')?.trim();
    if (!repoId) throw new BadRequestError('`repo_id` is required');
    const data = await readProjectQualityHistory(user, projectId, repoId, tenantId);
    return jsonResponse({ data });
  });
}

// POST /api/projects/:id/quality/analyze
export function handleAnalyzeProjectQuality(req: Request, projectId: string): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const result = await startProjectQualityAnalysis(user, projectId, tenantId);
    if (!result.started) {
      return jsonResponse(
        {
          error: 'analysis_in_progress',
          message: 'A quality analysis is already running for this project.',
          data: { analysis: result.state },
        },
        409,
      );
    }
    return jsonResponse({ data: { analysis: result.state } }, 202);
  });
}
