// src/routes/assets/quality-history.ts
//
// GET /api/assets/:kind/:id/quality/history?limit= — the append-only quality
// evaluation log of one asset, proxied from requirements_management
// `GET /{principles|decisions|architecture/elements|architecture/views|pm/risks}/{id}/quality/history`.
// Contract: judge-oracle tournament review fr-routes.md (2026-09-23).
//
// `:kind` is the quality-history kind (integrations/quality-history.ts
// `QualityHistoryKind`): principle | decision | architectureElement |
// architectureView.
//
// Tenancy: authenticated user, ambient
// `X-Tenant-Id`; requirements_management scopes the read to that tenant and
// 404s an entity the tenant cannot see. NOT super-admin gated: the asset
// quality panel is a tenant surface. Response is a Block: an upstream failure is
// `available:false` inside a 200 — the panel then says "unavailable", never
// renders an empty history as if nothing had ever been scored.

import { z } from 'zod';
import { jsonResponse } from '../../utils/response';
import { block, parseQuery, runReadModel } from '../../services/read-models/_lib';
import {
  getQualityHistory,
  isQualityHistoryKind,
  QUALITY_HISTORY_PATHS,
} from '../../integrations/quality-history';
import { IntegrationError } from '../../integrations/_lib/errors';

// Upstream bounds: HISTORY_LIMIT_MAX = 500 (requirements_management _quality_history.py).
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function handleGetAssetQualityHistory(
  req: Request,
  kind: string,
  id: string,
): Promise<Response> {
  return runReadModel(req, async () => {
    if (!isQualityHistoryKind(kind)) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: `kind: must be one of ${Object.keys(QUALITY_HISTORY_PATHS).join(', ')}`,
      });
    }
    const { limit } = parseQuery(querySchema, req);
    let assetId: string;
    try {
      assetId = decodeURIComponent(id);
    } catch {
      throw new IntegrationError({ code: 'BAD_REQUEST', message: 'id: malformed escape' });
    }
    const { data, meta } = await block('requirements', async () => {
      const raw = await getQualityHistory(kind, assetId, limit);
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { items?: unknown }).items)) {
        throw new IntegrationError({
          code: 'UPSTREAM_BAD_BODY',
          message: 'quality/history: expected {items: [...]}',
          service: 'requirements_management',
        });
      }
      return raw as Record<string, unknown>;
    });
    return jsonResponse({ data, meta });
  });
}
