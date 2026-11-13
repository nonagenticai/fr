// src/services/signup/identity.ts — the Keycloak half of an early-access approval.
//
// fr MINTS the requester's realm identity itself, BEFORE the provisioning engine runs, and that is
// load-bearing rather than a style choice:
//
//   * The Keycloak auto sign-in SPI (contract C5, nonagenticai/keycloak) fires ONLY for a user with
//     no stored credential, no IdP link and no federation ("first-credential only"). The provisioning
//     engine, when IT creates a user, sets a temporary password (orchestration.py step 2) — that is a
//     stored credential, so the person would set a password and then hit a login form.
//   * The engine on a 409 (the user already exists) sets no password and sends no welcome email,
//     so creating the identity here first makes the approval send exactly ONE email (ours).
//   * Only the inbox owner can set this identity's password: the only way is the link mailed to the
//     address, which also completes VERIFY_EMAIL. That is why a minted identity may be seated and
//     licensed before anybody has signed in.
//
// An identity that ALREADY existed before the approval (someone's portal login — e.g. a
// CommonPractice user) is never adopted by the one-tap path: it may carry credentials, IdP links and
// a `tenant_id` attribute pointing elsewhere. Approve then refuses (`identity_exists`) and the
// super_admin provisions that person from Admin → Users, where the existing-account path is handled.
//
// OWNERSHIP IS AN ATTRIBUTE, NOT A HEURISTIC. `createUser` stamps `fr_signup_id = [<signup row id>]`
// on the identity it mints. fr adopts (a crash between create and record), overwrites attributes on,
// or deletes (reject) a realm user ONLY when that attribute equals the row's id exactly — a "fresh,
// credential-less" identity is not enough: the portal realm is shared, and CommonPractice's
// early-access flow mints exactly such identities for the same addresses. The attribute must be
// declared in the realm's user profile (admin view/edit only), or Keycloak drops it SILENTLY — so the
// approve re-reads the user right after create/adopt and refuses (`identity_attr_dropped`) before any
// tenant or licence exists.
//
// Every attribute write is a read-modify-write of the WHOLE user representation (Keycloak's PUT
// replaces it), so no other attribute — `tenant_id`, `phone`, … — is lost.
import { config } from '../../config';
import { getAdminAuth } from '../keycloak';

const TIMEOUT_MS = 15_000;

/** The realm-user attribute that marks an identity as minted by THIS fr signup row. */
export const SIGNUP_ID_ATTRIBUTE = 'fr_signup_id';

/** True only when `user` carries exactly `fr_signup_id = [signupId]`. */
export function identityBelongsTo(user: Pick<RealmUser, 'attributes'> | null | undefined, signupId: string): boolean {
  const v = user?.attributes?.[SIGNUP_ID_ATTRIBUTE];
  return Array.isArray(v) && v.length === 1 && v[0] === signupId;
}

export class KeycloakSignupError extends Error {
  constructor(
    readonly op: string,
    readonly status: number | null,
    message: string,
    /** The request was sent and no answer came in time: its effect is UNKNOWN (it may have happened). */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'KeycloakSignupError';
  }
}

export interface RealmUser {
  id: string;
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  createdTimestamp?: number;
  federationLink?: string;
  attributes?: Record<string, string[]>;
  requiredActions?: string[];
  [key: string]: unknown;
}

function base(): string {
  return `${config.keycloak.url}/admin/realms/${config.keycloak.userRealm}`;
}

async function kcFetch(op: string, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await getAdminAuth().authenticatedFetch(`${base()}${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new KeycloakSignupError(op, null, `Keycloak ${op} ${timedOut ? 'timed out' : 'unreachable'}: ${err instanceof Error ? err.message : String(err)}`, timedOut);
  }
}

async function fail(op: string, res: Response): Promise<never> {
  const text = await res.text().catch(() => '');
  throw new KeycloakSignupError(op, res.status, `Keycloak ${op} failed: ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
}

/** Split "Ann Early" → first "Ann", last "Early"; a one-word name repeats (VERIFY_PROFILE wants both). */
export function splitName(name: string, email: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const local = email.split('@')[0] || email;
    return { firstName: local, lastName: local };
  }
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export interface IdentityOps {
  /**
   * Create a DISABLED, UNVERIFIED, credential-less user stamped `fr_signup_id = [signupId]`.
   * `{created:false}` on a 409 (address taken). Disabled until `enableUser` right before the one
   * email (George 2026-10-23): a failed approval leaves no identity that can sign in or receive
   * mail (Keycloak sends no reset/required-action email to a disabled user).
   */
  createUser(input: { email: string; name: string; locale: string; signupId: string }): Promise<{ created: true; id: string } | { created: false }>;
  findUserByEmail(email: string): Promise<RealmUser | null>;
  getUser(id: string): Promise<RealmUser | null>;
  /** Stored credentials (password, OTP, …) — a minted identity has none until the link is used. */
  countCredentials(id: string): Promise<number>;
  countIdentityLinks(id: string): Promise<number>;
  /** Merge (value) or remove (null) attributes, whole-representation read-modify-write. */
  updateAttributes(id: string, attrs: Record<string, string | null>): Promise<void>;
  executeActionsEmail(
    id: string,
    actions: string[],
    o: { clientId: string; redirectUri: string; lifespanSeconds: number },
  ): Promise<void>;
  /** Enable the user (whole-representation read-modify-write; idempotent). */
  enableUser(id: string): Promise<void>;
  /** Delete the user; false when it was already gone. */
  deleteUser(id: string): Promise<boolean>;
}

export const keycloakIdentityOps: IdentityOps = {
  async createUser({ email, name, locale, signupId }) {
    const { firstName, lastName } = splitName(name, email);
    const res = await kcFetch('createUser', '/users', {
      method: 'POST',
      body: JSON.stringify({
        username: email,
        email,
        firstName,
        lastName,
        // Disabled until the approval has fully landed (enableUser, invite_email step).
        enabled: false,
        // VERIFY_EMAIL in the one email completes this; nobody can sign in before it.
        emailVerified: false,
        attributes: { locale: [locale], [SIGNUP_ID_ATTRIBUTE]: [signupId] },
      }),
    });
    if (res.status === 409) return { created: false };
    if (res.status !== 201) return fail('createUser', res);
    const id = (res.headers.get('location') ?? '').split('/').filter(Boolean).pop();
    if (!id) throw new KeycloakSignupError('createUser', 201, 'Keycloak createUser 201 without a Location id');
    return { created: true, id };
  },

  async findUserByEmail(email) {
    const q = new URLSearchParams({ email: email.trim().toLowerCase(), exact: 'true', max: '2' });
    const res = await kcFetch('findUserByEmail', `/users?${q.toString()}`);
    if (!res.ok) return fail('findUserByEmail', res);
    const users = (await res.json()) as RealmUser[];
    if (users.length > 1) throw new KeycloakSignupError('findUserByEmail', 200, `two realm users carry ${email}`);
    return users[0] ?? null;
  },

  async getUser(id) {
    const res = await kcFetch('getUser', `/users/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) return fail('getUser', res);
    return (await res.json()) as RealmUser;
  },

  async countCredentials(id) {
    const res = await kcFetch('getCredentials', `/users/${encodeURIComponent(id)}/credentials`);
    if (!res.ok) return fail('getCredentials', res);
    return ((await res.json()) as unknown[]).length;
  },

  async countIdentityLinks(id) {
    const res = await kcFetch('getFederatedIdentity', `/users/${encodeURIComponent(id)}/federated-identity`);
    if (!res.ok) return fail('getFederatedIdentity', res);
    return ((await res.json()) as unknown[]).length;
  },

  async updateAttributes(id, attrs) {
    const path = `/users/${encodeURIComponent(id)}`;
    const read = await kcFetch('getUser', path);
    if (!read.ok) return fail('getUser', read);
    const user = (await read.json()) as RealmUser;
    const merged: Record<string, string[]> = { ...(user.attributes ?? {}) };
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null) delete merged[k];
      else merged[k] = [v];
    }
    const write = await kcFetch('updateUser', path, { method: 'PUT', body: JSON.stringify({ ...user, attributes: merged }) });
    if (!write.ok) return fail('updateUser', write);
  },

  async executeActionsEmail(id, actions, o) {
    const q = new URLSearchParams({
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      lifespan: String(o.lifespanSeconds),
    });
    const res = await kcFetch('executeActionsEmail', `/users/${encodeURIComponent(id)}/execute-actions-email?${q.toString()}`, {
      method: 'PUT',
      body: JSON.stringify(actions),
    });
    if (!res.ok) return fail('executeActionsEmail', res);
  },

  async enableUser(id) {
    const path = `/users/${encodeURIComponent(id)}`;
    const read = await kcFetch('getUser', path);
    if (!read.ok) return fail('getUser', read);
    const user = (await read.json()) as RealmUser;
    if (user.enabled === true) return;
    const write = await kcFetch('enableUser', path, { method: 'PUT', body: JSON.stringify({ ...user, enabled: true }) });
    if (!write.ok) return fail('enableUser', write);
  },

  async deleteUser(id) {
    const res = await kcFetch('deleteUser', `/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.status === 404) return false;
    if (!res.ok) return fail('deleteUser', res);
    return true;
  },
};
