// GET /api/card-types and GET /api/card-types/:card_type
//
// The caller tenant's card types, read from its requirements_management PM
// catalogue through the one reader (services/catalogue/tenant-catalogue.ts —
// design: fr consumes RM vocabulary, George 2026-10-12). This used to be a
// read-only view over the vendored ncn roster + fr's description catalogue; both
// are gone. The /cards/[id] page renders the RM attributes (description,
// inputs, outputs, acceptance, rules, definition_of_done).
//
// `card_group` is the card type's RM capability name (design Q1 = a).

import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { UnauthorizedError } from '../utils/errors';
import {
  capabilities as catalogueCapabilities,
  cardTypes as catalogueCardTypes,
} from '../services/catalogue/tenant-catalogue';
import { jsonResponse } from '../utils/response';

export function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

async function callerTenant(req: Request): Promise<string | Response> {
  try {
    const user = await validateAuth(req);
    return ctxTenantId(user.tenantId);
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function handleGetCardType(
  req: Request,
  cardType: string,
): Promise<Response> {
  const tenantId = await callerTenant(req);
  if (tenantId instanceof Response) return tenantId;
  const [types, caps] = await Promise.all([
    catalogueCardTypes(tenantId),
    catalogueCapabilities(tenantId),
  ]);
  const ct = types.find((t) => t.name === cardType);
  if (!ct) {
    return jsonResponse({ error: 'card_type_not_found', card_type: cardType }, 404);
  }
  const capability = caps.find((c) => c.id === ct.capability_id) ?? null;
  return jsonResponse({
    card_type: ct.name,
    title: ct.title,
    card_type_description: ct.description ?? '',
    card_group: capability?.name ?? null,
    capability: capability ? { name: capability.name, title: capability.title } : null,
    // RM: null = not set; rendered as "none recorded" (an empty list).
    inputs: ct.inputs ?? [],
    outputs: ct.outputs ?? [],
    acceptance: ct.acceptance ?? [],
    rules: ct.rules ?? [],
    human_task: ct.human_task ?? null,
    definition_of_done: ct.definition_of_done ?? null,
  });
}

export async function handleListCardTypes(req: Request): Promise<Response> {
  const tenantId = await callerTenant(req);
  if (tenantId instanceof Response) return tenantId;
  const types = await catalogueCardTypes(tenantId);
  return jsonResponse({ card_types: types.map((t) => t.name) });
}
