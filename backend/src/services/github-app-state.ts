// services/github-app-state.ts
//
// The `state` parameter of the public GitHub App install flow — the ONLY
// identity the unauthenticated callback has (fr auth is bearer-only, and a
// browser redirect from github.com carries no bearer).
//
// Same construction as services/download-tokens.ts (HMAC-SHA256 +
// single-use Redis nonce consumed with GETDEL + constant-time compare), with
// its own key `GITHUB_APP_STATE_SIGNING_KEY` and a 600 s TTL.
//
// Wire:  base64url(JSON({ user_id, tenant_id, issued_at, nonce, sig }))
// sig =  HMAC-SHA256(key, JSON.stringify([user_id, tenant_id, issued_at, nonce]))
//
// The preimage is a JSON ARRAY, not a `|`-joined string: JSON string encoding
// escapes every delimiter it uses, so the preimage is injective over ANY field
// values — no argument about field domains is needed (contrast the long
// comment on download-tokens.ts `downloadTokenPreimage`).
//
// Redis: `github-app:state:<nonce>` → JSON({ user_id, tenant_id, issued_at }),
// TTL 600 s. The tenant is inside the SIGNED wire, and the stored record is
// cross-checked against it, so neither a tampered query string nor a
// mismatched record can move a binding to a different tenant.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { redis } from './redis';
import { AppError } from '../utils/errors';
import { githubAppStateSigningKey, GITHUB_APP_ENV } from './github-app-config';

const STATE_TTL_SECONDS = 600;
const KEY_PREFIX = 'github-app:state:';

type GithubAppStateErrorCode = 'STATE_INVALID' | 'STATE_EXPIRED' | 'STATE_CONSUMED';

/**
 * A state that must not be honoured. Extends AppError (400) so any boundary
 * that lets it escape answers a 4xx, never a bare 500; the callback itself
 * catches it and redirects `?error=invalid_state`.
 */
export class GithubAppStateError extends AppError {
  readonly stateCode: GithubAppStateErrorCode;
  constructor(code: GithubAppStateErrorCode, message: string) {
    super(400, message);
    this.name = 'GithubAppStateError';
    this.stateCode = code;
    this.withCode(code);
  }
}

/** The signing key is unset — the flow is not configured. Never a user error. */
class GithubAppStateKeyMissingError extends Error {
  constructor() {
    super(`${GITHUB_APP_ENV.stateSigningKey} is not configured; refusing to mint or verify install state.`);
    this.name = 'GithubAppStateKeyMissingError';
  }
}

interface GithubAppStatePayload {
  user_id: string;
  tenant_id: string;
  issued_at: number;
  nonce: string;
}

interface Wire extends GithubAppStatePayload {
  sig: string;
}

/** Nonce store seam. Default: fr's Redis, with GETDEL for atomic single use. */
interface NonceStore {
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Atomically read AND delete. null when absent. */
  take(key: string): Promise<string | null>;
}

const redisStore: NonceStore = {
  async put(key, value, ttlSeconds) {
    await redis.set(key, value, ttlSeconds);
  },
  async take(key) {
    const raw = (await redis.send('GETDEL', [key])) as string | null | undefined;
    return raw ?? null;
  },
};

/** Epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function key(): string {
  const k = githubAppStateSigningKey();
  if (!k) throw new GithubAppStateKeyMissingError();
  return k;
}

/** Exported so a test can pin it: this is a SIGNING preimage. */
function statePreimage(userId: string, tenantId: string, issuedAt: number, nonce: string): string {
  return JSON.stringify([userId, tenantId, issuedAt, nonce]);
}

function sign(p: GithubAppStatePayload): string {
  return createHmac('sha256', key())
    .update(statePreimage(p.user_id, p.tenant_id, p.issued_at, p.nonce))
    .digest('hex');
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function unb64url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function hexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Mint a single-use state bound to (user, tenant). */
export async function mintGithubAppState(args: {
  userId: string;
  tenantId: string;
}): Promise<{ state: string; expiresAt: number }> {
  if (!args.userId || !args.tenantId) {
    throw new GithubAppStateError('STATE_INVALID', 'user and tenant are required to mint install state');
  }
  const payload: GithubAppStatePayload = {
    user_id: args.userId,
    tenant_id: args.tenantId,
    issued_at: nowSeconds(),
    nonce: randomBytes(16).toString('hex'),
  };
  const sig = sign(payload);
  await redisStore.put(
    `${KEY_PREFIX}${payload.nonce}`,
    JSON.stringify({ user_id: payload.user_id, tenant_id: payload.tenant_id, issued_at: payload.issued_at }),
    STATE_TTL_SECONDS,
  );
  return { state: b64url(JSON.stringify({ ...payload, sig } satisfies Wire)), expiresAt: payload.issued_at + STATE_TTL_SECONDS };
}

/**
 * Verify and CONSUME a state. Order: shape → signature → age → GETDEL →
 * record cross-check. The nonce is consumed only after the signature holds,
 * so a forged state cannot burn someone else's nonce.
 */
export async function consumeGithubAppState(raw: string | null | undefined): Promise<GithubAppStatePayload> {
  if (!raw) throw new GithubAppStateError('STATE_INVALID', 'state is missing');
  let wire: Wire;
  try {
    const p = JSON.parse(unb64url(raw)) as Partial<Wire>;
    if (
      typeof p.user_id !== 'string' || !p.user_id ||
      typeof p.tenant_id !== 'string' || !p.tenant_id ||
      typeof p.issued_at !== 'number' || !Number.isInteger(p.issued_at) ||
      typeof p.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(p.nonce) ||
      typeof p.sig !== 'string'
    ) {
      throw new GithubAppStateError('STATE_INVALID', 'state payload is malformed');
    }
    wire = p as Wire;
  } catch (e) {
    if (e instanceof GithubAppStateError) throw e;
    throw new GithubAppStateError('STATE_INVALID', 'state is not base64url-JSON');
  }

  if (!hexEqual(sign(wire), wire.sig)) {
    throw new GithubAppStateError('STATE_INVALID', 'state signature does not match');
  }

  const age = nowSeconds() - wire.issued_at;
  if (age < -30) throw new GithubAppStateError('STATE_INVALID', 'state issued in the future');
  if (age > STATE_TTL_SECONDS) throw new GithubAppStateError('STATE_EXPIRED', 'state has expired');

  const stored = await redisStore.take(`${KEY_PREFIX}${wire.nonce}`);
  if (stored === null) throw new GithubAppStateError('STATE_CONSUMED', 'state has already been used');

  let rec: { user_id?: unknown; tenant_id?: unknown };
  try {
    rec = JSON.parse(stored) as typeof rec;
  } catch {
    throw new GithubAppStateError('STATE_INVALID', 'stored state record is corrupted');
  }
  if (rec.user_id !== wire.user_id || rec.tenant_id !== wire.tenant_id) {
    throw new GithubAppStateError('STATE_INVALID', 'state record mismatch');
  }
  return { user_id: wire.user_id, tenant_id: wire.tenant_id, issued_at: wire.issued_at, nonce: wire.nonce };
}

// ── Pending claims ───────────────────────────────────────────────────────────
//
// The callback is unauthenticated, so the state tells it only who STARTED the
// install — not who is sitting at the browser that came back from GitHub. An
// attacker can mint a state in their own tenant and send the install link to
// an admin of org X; binding from the state alone would put X into the
// attacker's tenant. So the callback never binds: it parks a verified claim
// here under an unguessable handle, and the AUTHENTICATED confirm endpoint
// binds only when the confirming user + tenant equal the state's.
//
// Redis: `github-app:claim:<64 hex>` → JSON(GithubAppPendingClaim), TTL 600 s,
// consumed with GETDEL (single use, whether or not the confirm succeeds).

const CLAIM_TTL_SECONDS = 600;
const CLAIM_PREFIX = 'github-app:claim:';
const HANDLE_RE = /^[0-9a-f]{64}$/;

interface GithubAppPendingClaim {
  user_id: string;
  tenant_id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  github_user_login: string;
  verified_admin: true;
}

/** Park a verified claim; returns the 32-byte (hex) handle. */
export async function createPendingClaim(claim: GithubAppPendingClaim): Promise<string> {
  const handle = randomBytes(32).toString('hex');
  await redisStore.put(`${CLAIM_PREFIX}${handle}`, JSON.stringify(claim), CLAIM_TTL_SECONDS);
  return handle;
}

/** Atomically take (GETDEL) a claim. null when malformed, absent, expired or already taken. */
export async function takePendingClaim(handle: string): Promise<GithubAppPendingClaim | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const raw = await redisStore.take(`${CLAIM_PREFIX}${handle}`);
  if (raw === null) return null;
  let c: Partial<GithubAppPendingClaim>;
  try {
    c = JSON.parse(raw) as Partial<GithubAppPendingClaim>;
  } catch {
    return null;
  }
  if (
    typeof c.user_id !== 'string' || !c.user_id ||
    typeof c.tenant_id !== 'string' || !c.tenant_id ||
    typeof c.installation_id !== 'number' || !Number.isSafeInteger(c.installation_id) ||
    typeof c.account_login !== 'string' || !c.account_login ||
    typeof c.account_type !== 'string' ||
    typeof c.github_user_login !== 'string' ||
    c.verified_admin !== true
  ) {
    return null;
  }
  return c as GithubAppPendingClaim;
}
