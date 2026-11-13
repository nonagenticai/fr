// src/routes/admin/assets/_lib/system-ownership.ts
//
// STRICT tenant separation for the admin asset console (2026-09-30).
//
//   * LIST under a customer tenant: fr makes NO system-frame call. The rows
//     returned are what upstream answers under the caller's own frame; each
//     row's `is_system` flag is derived from the ROW (`tenant_id === system`),
//     never from which call produced it.
//   * WRITE (update/delete) under a customer tenant by a NON-super-admin: the
//     row is read first under the caller's frame, and a row owned by the
//     SYSTEM tenant is refused 403 `system_asset_read_only` before the
//     mutation is attempted. A super-admin, or a caller whose active tenant IS
//     system (reachable only by a super-admin, and gateWriteAsset enforces
//     that), proceeds unchanged.

import { isSuperAdmin } from '../../../../lib/super-admin-gate';
import { getRequestContext } from '../../../../integrations/_lib/context';
import {
  isIntegrationError,
  integrationErrorResponse,
} from '../../../../integrations/_lib/errors';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../../middleware/internal-tenant-only';
import { jsonResponse } from '../../../../utils/response';
import { isSystemRow } from '../../../assets/_lib/system-union';


/**
 * Ownership pre-read for update/delete. Returns a Response to short-circuit
 * with (403, or the pre-read's own integration error), or `null` to proceed.
 * A 404 on the pre-read proceeds: the write itself yields its own 404.
 */
export async function refuseSystemOwnedWrite(
  user: { roles?: readonly string[] },
  fetchRow: () => Promise<unknown>,
): Promise<Response | null> {
  if (isSuperAdmin(user)) return null;
  if (getRequestContext().tenantId === INTERNAL_SYSTEM_TENANT_ID) return null;
  let row: unknown;
  try {
    row = await fetchRow();
  } catch (e) {
    if (isIntegrationError(e)) {
      if (e.code === 'UPSTREAM_NOT_FOUND') return null;
      return integrationErrorResponse(e);
    }
    throw e;
  }
  if (isSystemRow(row)) {
    return jsonResponse(
      {
        error: 'system_asset_read_only',
        detail:
          'system assets are read-only for workspace users; only a super-admin may edit or delete them',
      },
      403,
    );
  }
  return null;
}
