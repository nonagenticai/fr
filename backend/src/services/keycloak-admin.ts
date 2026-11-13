// src/services/keycloak-admin.ts
//
// Keycloak admin-API write helpers used by super-admin user provisioning.
// Read-side helpers (findUserByEmail, getUserById, etc.) live on the
// `KeycloakService` singleton in `./keycloak.ts`; this module hosts the
// write-side primitives so the read class stays focused on lookups.
//
// Auth pattern: reuse the existing `ServiceAuthenticator` singleton via
// `getAdminAuth()` — same OAuth2 client-credentials cache used by every
// other admin-API call in this codebase. Do NOT mint a new authenticator.

import { config } from '../config';
import { IntegrationError } from '../integrations/_lib/errors';
import { getAdminAuth, keycloak } from './keycloak';

const SERVICE = 'keycloak-admin';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Keycloak attribute payloads must be `Record<string, string[]>` per the
 * admin API spec. Callers may pass a scalar string for convenience; this
 * helper normalizes both shapes into the required array form.
 */
function normalizeAttributes(
  attrs: Record<string, string | string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = Array.isArray(v) ? v : [v];
  }
  return out;
}

async function readBodySafe(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

function badStatusError(args: {
  method: string;
  path: string;
  status: number;
  body: unknown;
  message?: string;
}): IntegrationError {
  return new IntegrationError({
    code: 'UPSTREAM_BAD_STATUS',
    message:
      args.message ??
      `Keycloak ${args.method} ${args.path} failed: ${args.status}`,
    service: SERVICE,
    method: args.method,
    path: args.path,
    upstreamStatus: args.status,
    upstreamBody: args.body,
  });
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  attributes?: Record<string, string | string[]>;
  /**
   * Default `true`. `false` creates the account DISABLED: it can neither sign in nor receive a
   * Keycloak reset/required-action email until `enableUser` (fail-closed onboarding, realm per app).
   */
  enabled?: boolean;
}

export interface CreateUserResult {
  id: string;
  alreadyExisted: boolean;
}

/**
 * Create a Keycloak user, idempotent on email collision.
 *
 * - 201 Created → extract sub from `Location` header; `alreadyExisted=false`.
 * - 409 Conflict → resolve sub via `keycloak.findUserByEmail`;
 *   `alreadyExisted=true`. This is intentional: the super-admin
 *   provisioning flow re-runs on the same payload safely.
 * - Any other non-2xx → throw `IntegrationError` with the response body.
 */
export async function createUser(
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users`;
  const url = `${config.keycloak.url}${path}`;

  const body = {
    email: input.email,
    username: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    enabled: input.enabled ?? true,
    emailVerified: true,
    attributes: normalizeAttributes(input.attributes),
  };

  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (response.status === 201) {
    const location = response.headers.get('location') ?? response.headers.get('Location');
    if (!location) {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: 'Keycloak createUser 201 missing Location header',
        service: SERVICE,
        method: 'POST',
        path,
        upstreamStatus: 201,
      });
    }
    const id = location.split('/').filter(Boolean).pop();
    if (!id) {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: `Keycloak createUser Location header has no user id: ${location}`,
        service: SERVICE,
        method: 'POST',
        path,
        upstreamStatus: 201,
      });
    }
    return { id, alreadyExisted: false };
  }

  if (response.status === 409) {
    const existing = await keycloak.findUserByEmail(input.email);
    if (!existing) {
      const body409 = await readBodySafe(response);
      throw new IntegrationError({
        code: 'UPSTREAM_CONFLICT',
        message: `Keycloak createUser conflicted but findUserByEmail returned null for ${input.email}`,
        service: SERVICE,
        method: 'POST',
        path,
        upstreamStatus: 409,
        upstreamBody: body409,
      });
    }
    return { id: existing, alreadyExisted: true };
  }

  const errBody = await readBodySafe(response);
  throw badStatusError({
    method: 'POST',
    path,
    status: response.status,
    body: errBody,
  });
}

/**
 * Set a user's password. `temporary=true` (default) forces a reset on next
 * login — the typical super-admin provisioning flow pairs this with
 * `sendUpdatePasswordEmail` so the temp password is never the long-term one.
 */
export async function setPassword(
  userId: string,
  password: string,
  temporary: boolean = true,
): Promise<void> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${userId}/reset-password`;
  const url = `${config.keycloak.url}${path}`;

  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ type: 'password', value: password, temporary }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await readBodySafe(response);
    throw badStatusError({
      method: 'PUT',
      path,
      status: response.status,
      body: errBody,
    });
  }
}

/**
 * Does this user hold a `password` credential? `GET /users/{id}/credentials`.
 *
 * Used by existing-tenant provisioning to tell a usable existing account (has a
 * password: never rotated) from one whose first run created it and then failed
 * at `setPassword` (no credential: nobody could ever log in, so the retry must
 * issue the temporary password). A failed read THROWS — "unknown" is never read
 * as either answer.
 */
export async function hasPasswordCredential(userId: string): Promise<boolean> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${userId}/credentials`;
  const url = `${config.keycloak.url}${path}`;
  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw badStatusError({ method: 'GET', path, status: response.status, body: await readBodySafe(response) });
  }
  const body = (await readBodySafe(response)) as unknown;
  if (!Array.isArray(body)) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `Keycloak GET ${path} did not return a credential list`,
      service: SERVICE,
      method: 'GET',
      path,
      upstreamStatus: response.status,
      upstreamBody: body,
    });
  }
  return body.some((c) => (c as { type?: unknown } | null)?.type === 'password');
}

/**
 * MERGE attributes onto an existing Keycloak user.
 *
 * Needed because `POST /users` only applies attributes on the 201-create path,
 * and the super-admin onboarding flow no longer creates the user itself — the
 * provisioning service does (it stamps `tenant_id` + `tenant_slug`), and its
 * request shape carries no phone. Without this, the console's optional
 * `phone_e164` field would silently drop the value the operator typed.
 *
 * Keycloak's `PUT /users/{id}` REPLACES the user representation, so a blind PUT
 * of `{attributes: {phone}}` would wipe `tenant_id`/`tenant_slug` and re-tenant
 * the user to `sub` — a data-fragmentation bug. We therefore GET the current
 * representation, merge the new keys over its existing `attributes`, and PUT the
 * union. Read-modify-write, so a genuinely concurrent attribute write can lose;
 * onboarding is a single-operator action, so that is acceptable here.
 */
export async function mergeUserAttributes(
  userId: string,
  attributes: Record<string, string | string[]>,
): Promise<void> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${userId}`;
  const url = `${config.keycloak.url}${path}`;
  const auth = getAdminAuth();

  const readResponse = await auth.authenticatedFetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!readResponse.ok) {
    throw badStatusError({
      method: 'GET',
      path,
      status: readResponse.status,
      body: await readBodySafe(readResponse),
    });
  }
  const current = (await readResponse.json()) as {
    attributes?: Record<string, string[]>;
  };

  const merged = {
    ...(current.attributes ?? {}),
    ...(normalizeAttributes(attributes) ?? {}),
  };

  const writeResponse = await auth.authenticatedFetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ attributes: merged }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!writeResponse.ok) {
    throw badStatusError({
      method: 'PUT',
      path,
      status: writeResponse.status,
      body: await readBodySafe(writeResponse),
    });
  }
}

/**
 * Trigger Keycloak's `UPDATE_PASSWORD` required-action email to a user.
 * `lifespanSeconds` controls how long the magic link in that email is valid
 * (default 12h). Used by super-admin provisioning to hand off the actual
 * password choice to the end user without ever exposing the temp value.
 */
export async function sendUpdatePasswordEmail(
  userId: string,
  lifespanSeconds: number = 43_200,
): Promise<void> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${userId}/execute-actions-email`;
  const url = `${config.keycloak.url}${path}?lifespan=${lifespanSeconds}`;

  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(['UPDATE_PASSWORD']),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await readBodySafe(response);
    throw badStatusError({
      method: 'PUT',
      path: `${path}?lifespan=${lifespanSeconds}`,
      status: response.status,
      body: errBody,
    });
  }
}

/**
 * Delete a user from fr's user realm. `true` = deleted, `false` = already gone (404).
 *
 * Used by the super-admin offboard for a CALLER-OWNED identity (realm per app): the provisioning
 * engine no longer owns that account, so it reports `keycloak_user_caller_owned` and leaves the
 * delete to fr.
 */
export async function deleteUser(userId: string): Promise<boolean> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}`;
  const url = `${config.keycloak.url}${path}`;
  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(url, {
    method: 'DELETE',
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw badStatusError({ method: 'DELETE', path, status: response.status, body: await readBodySafe(response) });
  }
  return true;
}

/** The user's `enabled` flag and attributes (`GET /users/{id}`). THROWS on any failure, 404 included. */
export async function getUserState(
  userId: string,
): Promise<{ enabled: boolean; attributes: Record<string, string[]>; email?: string; requiredActions?: string[] }> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}`;
  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(`${config.keycloak.url}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw badStatusError({ method: 'GET', path, status: response.status, body: await readBodySafe(response) });
  }
  const rep = (await response.json()) as {
    enabled?: boolean;
    attributes?: Record<string, string[]>;
    email?: string;
    requiredActions?: string[];
  };
  return {
    enabled: rep.enabled !== false,
    attributes: rep.attributes ?? {},
    ...(typeof rep.email === 'string' ? { email: rep.email } : {}),
    requiredActions: Array.isArray(rep.requiredActions) ? rep.requiredActions : [],
  };
}

/**
 * Enable the user. Whole-representation read-modify-write (a partial PUT can drop attributes under
 * the declarative user profile — see `mergeUserAttributes`); a no-op when already enabled. THROWS.
 */
export async function enableUser(userId: string): Promise<void> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}`;
  const url = `${config.keycloak.url}${path}`;
  const auth = getAdminAuth();
  const read = await auth.authenticatedFetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!read.ok) {
    throw badStatusError({ method: 'GET', path, status: read.status, body: await readBodySafe(read) });
  }
  const current = (await read.json()) as Record<string, unknown>;
  if (current.enabled === true) return;
  const write = await auth.authenticatedFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...current, enabled: true }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!write.ok) {
    throw badStatusError({ method: 'PUT', path, status: write.status, body: await readBodySafe(write) });
  }
}

/**
 * The TYPES of the user's stored credentials (`GET /users/{id}/credentials`), e.g. `['password']`.
 * THROWS on any failure — "unknown" is never read as "none".
 */
export async function getCredentialTypes(userId: string): Promise<string[]> {
  const path = `/admin/realms/${config.keycloak.userRealm}/users/${encodeURIComponent(userId)}/credentials`;
  const auth = getAdminAuth();
  const response = await auth.authenticatedFetch(`${config.keycloak.url}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw badStatusError({ method: 'GET', path, status: response.status, body: await readBodySafe(response) });
  }
  const body = (await readBodySafe(response)) as unknown;
  if (!Array.isArray(body)) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `Keycloak GET ${path} did not return a credential list`,
      service: SERVICE,
      method: 'GET',
      path,
      upstreamStatus: response.status,
      upstreamBody: body,
    });
  }
  return body.map((c) => String((c as { type?: unknown } | null)?.type ?? ''));
}
