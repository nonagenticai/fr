// src/routes/admin/assets/decisions.ts
//
// Super-admin asset console — decisions proxy. Pattern-replica of
// principles.ts; delegates to `src/integrations/decisions.ts`.

import { z } from 'zod';
import {
  listDecisions,
  getDecision,
  createDecision,
  updateDecision,
  deleteDecision,
  parseListDecisionsParams,
  type ListDecisionsParams,
  getDecisionTarget,
} from '../../../integrations/decisions';
import { getRequestContext } from '../../../integrations/_lib/context';
import {
  isIntegrationError,
  integrationErrorResponse,
} from '../../../integrations/_lib/errors';
import { jsonResponse } from '../../../utils/response';
import { gateReadAsset, gateWriteAsset } from './_lib/gate';
import { refuseSystemOwnedWrite } from './_lib/system-ownership';
import { customerNotFoundError,
  isPlatformTenant, isSystemRow } from '../../assets/_lib/system-union';

type AnyRecord = Record<string, unknown>;
function tagSystem<T extends AnyRecord>(row: T, isSystem: boolean): T & { is_system: boolean } {
  return { ...row, is_system: isSystem };
}

export async function handleListAdminDecisions(req: Request): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  let params: ListDecisionsParams | undefined;
  try {
    params = parseListDecisionsParams(url.searchParams);
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }

  const ctx = getRequestContext();
  const active = ctx.tenantId;
  if (!active) {
    return jsonResponse({ error: 'no_active_tenant' }, 400);
  }

  // STRICT tenant separation (2026-09-30): ONE upstream call, under the
  // caller's active tenant frame. fr never makes a second call pinned to the
  // system tenant for a customer tenant — that union handed customer admins
  // every system row (DRAFTs, conveyor records). When the active tenant IS
  // system (super-admin via X-Active-Tenant) this is the system list, as
  // before. `is_system` is read off each ROW (`tenant_id === system`), not
  // inferred from which call produced it.
  try {
    const rows = await listDecisions(params);
    // A customer (non-platform) tenant never sees a system-tenant row, even if
    // the upstream's inheritance regresses. Platform tenants keep them, tagged.
    const visible = isPlatformTenant(active) ? rows : rows.filter((r) => !isSystemRow(r));
    const tagged = visible.map((r) =>
      tagSystem(r as unknown as AnyRecord, isSystemRow(r)),
    );
    return jsonResponse({ decisions: tagged });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleGetAdminDecision(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;
  try {
    const row = await getDecision(id);
    const ctx = getRequestContext();
    // `is_system` comes from the ROW's owner, not the active tenant. A customer
    // (non-platform) tenant never sees a system-owned row: answer it exactly as
    // an upstream miss would.
    const isSystem = isSystemRow(row);
    if (isSystem && !isPlatformTenant(ctx.tenantId)) {
      return integrationErrorResponse(
        customerNotFoundError(getDecisionTarget(id)),
      );
    }
    return jsonResponse({
      decision: tagSystem(row as unknown as AnyRecord, isSystem),
    });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

const DecisionBodySchema = z.object({}).passthrough();

export async function handleCreateAdminDecision(req: Request): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  let body;
  try {
    body = DecisionBodySchema.parse(await req.json());
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }
  try {
    const created = await createDecision(
      body as unknown as Parameters<typeof createDecision>[0],
    );
    return jsonResponse({ decision: created }, 201);
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleUpdateAdminDecision(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  // A customer tenant-admin may not edit/delete a SYSTEM-owned row, even
  // when upstream resolves it under their frame. Super-admin proceeds.
  const refused = await refuseSystemOwnedWrite(gate.user, () => getDecision(id));
  if (refused) return refused;
  let body;
  try {
    body = DecisionBodySchema.parse(await req.json());
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }
  try {
    const updated = await updateDecision(
      id,
      body as unknown as Parameters<typeof updateDecision>[1],
    );
    return jsonResponse({ decision: updated });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleDeleteAdminDecision(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  // A customer tenant-admin may not edit/delete a SYSTEM-owned row, even
  // when upstream resolves it under their frame. Super-admin proceeds.
  const refused = await refuseSystemOwnedWrite(gate.user, () => getDecision(id));
  if (refused) return refused;
  try {
    await deleteDecision(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}
