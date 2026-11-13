/**
 * G8 / R313 — `POST /api/asset-scope/:assetType/:assetId/promotion-request`: ask the
 * workspace's tenant_admins to promote a PROJECT copy of a requirement / principle / decision
 * to the whole workspace. Raises one `asset.promotion` approval (deduplicated per copy);
 * services/approvals/asset-promotion.ts holds the rules.
 *
 * ⛔ Not `POST /api/asset-scope/:assetType/:assetId/promote` (promote.ts), which widens an
 * fr ownership edge with no approval. That one is unchanged.
 */
import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { findAssetPromotion, parsePromotableKind, requestAssetPromotion } from '../../services/approvals/asset-promotion';
import { BadRequestError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';

const BodySchema = z
  .object({
    original_id: z.string().min(1).max(255).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

export async function handleRequestAssetPromotion(req: Request, assetTypeRaw: string, assetId: string): Promise<Response> {
  const user = await validateAuth(req);
  const kind = parsePromotableKind(assetTypeRaw);
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequestError('invalid JSON body');
    }
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError(`invalid body: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  const result = await requestAssetPromotion({
    user,
    tenantId: ctxTenantId(user.tenantId),
    kind,
    copyId: assetId,
    originalId: parsed.data.original_id,
    note: parsed.data.note,
  });
  return jsonResponse({ data: result }, result.deduplicated ? 200 : 201);
}

/** `GET …/promotion-request`: the copy's latest promotion in the caller's tenant (`data: null` when none). */
export async function handleGetAssetPromotion(req: Request, assetTypeRaw: string, assetId: string): Promise<Response> {
  const user = await validateAuth(req);
  parsePromotableKind(assetTypeRaw);
  return jsonResponse({ data: await findAssetPromotion(ctxTenantId(user.tenantId), assetId) });
}
