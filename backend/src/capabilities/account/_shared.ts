// fr-agui SPEC §13 P4b (part 3) — spec drain: what the caller-account
// declarations in this directory share (`/api/me/*` tenant parts, the tenant
// billing view, workspace members, the repositories catalogue, the GitHub App
// callback).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// Every route keeps its handler (`legacyHandler`), so nothing changes at runtime.
// Two refusal shapes recur and are declared exactly as the handlers render them:
//   * `validateAuth` throwing into the central catch (`handleError`): 401 with the
//     auth message, 403 `{ error, code }` for the conveyor write door;
//   * a handler that CATCHES every validateAuth throw and answers
//     `{ error: 'unauthorized' }` itself — with 401, or (where the handler reads
//     `statusCode`) the throw's own status. A licence bearer never reaches either:
//     the server's licence route door (routed-dispatch.ts) answers it 403 first.
import { z } from 'zod';

import type { ResponseSpec } from '../define';
import { DOOR_403, LICENCE_ROUTE_DOOR_403, VALIDATE_AUTH_401, frErrorBody, unauthorizedBody } from '../settings/_shared';

export { DOOR_403, LICENCE_ROUTE_DOOR_403, VALIDATE_AUTH_401, frErrorBody, unauthorizedBody };
export { pathId, routeRule, settingsCapabilities, workspaceAdminRule, type SettingsRoute } from '../settings/_shared';

/** A timestamp column as `jsonResponse` serialises it (an ISO-8601 string). */
export const isoTime = z.string().describe('ISO-8601 timestamp');

export const FR_500 = "500: fr's own (`error`), e.g. the database is unreachable.";

/** validateAuth into the central catch: the standard 401 + `default`. */
export function standardResponses(extra = '', o: { noTenant500?: boolean } = {}): ResponseSpec[] {
  return [
    { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
    {
      status: 'default',
      description:
        extra +
        DOOR_403 +
        (o.noTenant500
          ? " 500: fr's own (`error`), e.g. no tenant resolvable for the caller (no frame, no JWT tenant), or the database is unreachable."
          : ` ${FR_500}`),
      schema: frErrorBody,
    },
  ];
}

/**
 * A handler that catches every validateAuth throw and answers `{ error: 'unauthorized' }`
 * itself. `status`: `'401'` — always 401 (it reads no status, or `.status`, which an
 * AppError does not carry); `'own'` — the throw's `statusCode` (so the conveyor write
 * door is a 403 with that body).
 */
export function caughtAuthResponses(o: { status: '401' | 'own'; write?: boolean }, extra: string): ResponseSpec[] {
  const conveyor = o.write
    ? o.status === '401'
      ? " The conveyor priority identity — refused inside validateAuth ('conveyor_route_forbidden') — gets this 401 too."
      : ''
    : '';
  return [
    {
      status: 401,
      description:
        "`error` 'unauthorized': the handler catches every validateAuth refusal and answers it itself." +
        conveyor +
        ' A licence bearer is a 403 (below), never this 401.',
      schema: unauthorizedBody,
    },
    {
      status: 'default',
      description:
        extra +
        `403: ${LICENCE_ROUTE_DOOR_403}` +
        (o.status === 'own' && o.write
          ? " The conveyor priority identity on this write: 403 `error` 'unauthorized' (the handler keeps validateAuth's status)."
          : '') +
        ` ${FR_500}`,
      schema: frErrorBody,
    },
  ];
}
