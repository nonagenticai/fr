/**
 * Artifact download tokens — HMAC-signed, single-use, short-lived.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-artifacts-browser.md §8.4.
 *
 * Token wire format: base64url(JSON({ user_id, artifact_id, issued_at, nonce, sig }))
 * where `sig = HMAC-SHA256(ARTIFACTS_DOWNLOAD_SIGNING_KEY,
 *   `${user_id}|${artifact_id}|${issued_at}|${nonce}`)`.
 *
 * Redis store keyed by nonce (so an attacker can't pre-compute the storage
 * key without seeing a real token):
 *   key:   `artifacts:dltok:<nonce>`
 *   value: JSON({ user_id, artifact_id, project_id, issued_at })
 *   TTL:   300 s (5 min)
 *
 * Single-use is enforced atomically via Redis `GETDEL` so concurrent download
 * attempts can never both succeed.
 *
 * The project_id is carried INSIDE the signed payload (not in the URL) so a
 * tampered query string can't redirect a token to a different project.
 *
 * Errors: `DownloadTokenInvalidError`, `DownloadTokenExpiredError`,
 * `DownloadTokenConsumedError`. Routes map all three to HTTP 401.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { redis } from './redis';

const TOKEN_TTL_SECONDS = 300;
const KEY_PREFIX = 'artifacts:dltok:';

export class DownloadTokenError extends Error {
  readonly code: 'DOWNLOAD_TOKEN_INVALID' | 'DOWNLOAD_TOKEN_EXPIRED' | 'DOWNLOAD_TOKEN_CONSUMED';
  constructor(
    code: 'DOWNLOAD_TOKEN_INVALID' | 'DOWNLOAD_TOKEN_EXPIRED' | 'DOWNLOAD_TOKEN_CONSUMED',
    message: string,
  ) {
    super(message);
    this.name = 'DownloadTokenError';
    this.code = code;
  }
}

export class DownloadTokenInvalidError extends DownloadTokenError {
  constructor(message = 'Download token is invalid') {
    super('DOWNLOAD_TOKEN_INVALID', message);
    this.name = 'DownloadTokenInvalidError';
  }
}

export class DownloadTokenExpiredError extends DownloadTokenError {
  constructor(message = 'Download token has expired') {
    super('DOWNLOAD_TOKEN_EXPIRED', message);
    this.name = 'DownloadTokenExpiredError';
  }
}

export class DownloadTokenConsumedError extends DownloadTokenError {
  constructor(message = 'Download token has already been used') {
    super('DOWNLOAD_TOKEN_CONSUMED', message);
    this.name = 'DownloadTokenConsumedError';
  }
}

export interface DownloadTokenPayload {
  user_id: string;
  artifact_id: string;
  project_id: string;
  issued_at: number;
  nonce: string;
  /**
   * Tenant captured AT MINT TIME, where a request context still exists.
   *
   * The resolve route authenticates by this token, not by a bearer, so it has
   * NO ambient tenant — `getTenantId()` is undefined there and the artifacts
   * upstream would silently fall back to DEFAULT_TENANT_ID. Carrying it here
   * is what lets a download of a non-default-tenant artifact resolve at all.
   *
   * OPTIONAL on purpose: it rides the Redis record, NOT the signed wire (same
   * as `project_id`), so no signature changes and no in-flight token is
   * invalidated. A token minted before this shipped simply has no tenant, and
   * the resolve path then behaves exactly as it did before. Self-heals within
   * the 5-minute TTL.
   */
  tenant_id?: string;
}

interface TokenWire {
  user_id: string;
  artifact_id: string;
  issued_at: number;
  nonce: string;
  sig: string;
}

interface RedisRecord {
  user_id: string;
  artifact_id: string;
  project_id: string;
  issued_at: number;
  /** See DownloadTokenPayload.tenant_id — unsigned, like project_id. */
  tenant_id?: string;
}

function signingKey(): string {
  // Read live from process.env so tests that set the env var via a preload
  // file (after ESM-hoisted imports of `config.ts`) still see the value.
  // The `config.services.artifacts.downloadSigningKey` snapshot is the
  // canonical production source; this fallback only kicks in when the
  // snapshot is empty.
  const key = config.services.artifacts.downloadSigningKey || process.env.ARTIFACTS_DOWNLOAD_SIGNING_KEY;
  if (!key) {
    throw new Error(
      'ARTIFACTS_DOWNLOAD_SIGNING_KEY is not configured; refusing to mint or resolve download tokens.',
    );
  }
  return key;
}

/**
 * The exact byte string this module HMACs. Exported so the pinning test in
 * `tests/unit/services/download-tokens-preimage.test.ts` can assert it against
 * a frozen literal — this is a SIGNING preimage, and a silent re-key here is an
 * auth change, not a formatting change.
 *
 * ── Why a bare `|` is sufficient HERE (and why that is not a general rule) ──
 *
 * `connectors/rss.ts` had to move to netstring framing (`<len>:<value>`, PR
 * #746) because its fields are arbitrary third-party text out of a
 * non-validating XML parser, so ANY delimiter can also occur inside a field and
 * the preimage becomes re-splittable. That argument does not transfer here,
 * because every field in this preimage is drawn from a domain that provably
 * excludes `|`:
 *
 *   userId      Keycloak `sub` claim (`services/keycloak.ts` validateToken):
 *               a UUID. Hex + hyphens.
 *   artifactId  A `uuid` PRIMARY KEY in artifact_service
 *               (`src/models/artifact.py`: `mapped_column(Uuid, default=uuid7)`,
 *               surfaced as `ArtifactOut.id: UUID`), and every upstream route
 *               types its path param `artifact_id: UUID`, so FastAPI 422s
 *               anything that is not a UUID. `mintDownloadToken` is only ever
 *               reached AFTER `getArtifact(projectId, artifactId)` succeeds
 *               against that service (`routes/assets/artifacts.ts`), so a
 *               non-UUID artifact id cannot be signed at all. The
 *               agent-callable action independently validates
 *               `artifact_id: z.string().uuid()`.
 *   issuedAt    `Math.floor(Date.now() / 1000)` — decimal digits. (And
 *               `String(x)` on a JS number is injective, so a forged wire
 *               cannot pick a different number with the same rendering.)
 *   nonce       `randomBytes(16).toString('hex')` — 32 hex chars.
 *
 * A legitimately minted preimage therefore contains EXACTLY three `|`, which
 * makes the 4-way split unique and the `(userId, artifactId, issuedAt, nonce)`
 * -> preimage map injective over the mint domain. Two distinct (user, artifact)
 * pairs cannot produce the same signed string, so a signature cannot be
 * transplanted from one to the other.
 *
 * ⚠️ That injectivity is a property of the FIELD DOMAINS, not of the format.
 * If `artifactId` ever stops being a UUID, the map stops being injective
 * immediately: `sign(u, 'a|123', 456, 'n')` and `sign(u, 'a', 123, '456|n')`
 * produce the identical preimage `u|a|123|456|n`. The pinning test asserts both
 * halves of that — the frozen format AND the collision that appears the moment
 * a field admits the separator — so a future widening of the id type cannot
 * pass silently. If it does widen, move this preimage to the netstring framing
 * `derivedStableId` uses in `connectors/rss.ts`.
 *
 * Two independent defences sit behind the signature even so, which is why this
 * is defence-in-depth rather than the only thing standing here:
 *   1. the Redis record is keyed by the NONCE, so a re-split (which necessarily
 *      changes the nonce) looks up a key that was never written; and
 *   2. `resolveDownloadToken` cross-checks the stored record's user_id +
 *      artifact_id against the wire's.
 */
export function downloadTokenPreimage(
  userId: string,
  artifactId: string,
  issuedAt: number,
  nonce: string,
): string {
  return `${userId}|${artifactId}|${issuedAt}|${nonce}`;
}

function sign(userId: string, artifactId: string, issuedAt: number, nonce: string): string {
  const h = createHmac('sha256', signingKey());
  h.update(downloadTokenPreimage(userId, artifactId, issuedAt, nonce));
  return h.digest('hex');
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64').toString('utf8');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Both expected to be hex; compare as bytes for constant-time semantics.
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Mint a single-use, 5-minute HMAC token bound to (user, artifact, project).
 * Persists the tracking record in Redis under the nonce; the returned token
 * string is what callers stuff into the `?t=` query param.
 */
export async function mintDownloadToken(args: {
  userId: string;
  artifactId: string;
  projectId: string;
  /** Ambient tenant at mint time; see DownloadTokenPayload.tenant_id. */
  tenantId?: string;
}): Promise<{ token: string; issuedAt: number; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const sig = sign(args.userId, args.artifactId, issuedAt, nonce);

  const wire: TokenWire = {
    user_id: args.userId,
    artifact_id: args.artifactId,
    issued_at: issuedAt,
    nonce,
    sig,
  };
  const token = base64UrlEncode(JSON.stringify(wire));

  const record: RedisRecord = {
    user_id: args.userId,
    artifact_id: args.artifactId,
    project_id: args.projectId,
    issued_at: issuedAt,
    // Trimmed-non-empty or absent entirely — a blank tenant must not be
    // stored, because absent and present-but-empty are different requests to
    // the artifacts upstream (absent takes the default, empty is a 400).
    ...(args.tenantId?.trim() ? { tenant_id: args.tenantId.trim() } : {}),
  };
  await redis.set(`${KEY_PREFIX}${nonce}`, record, TOKEN_TTL_SECONDS);

  return {
    token,
    issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_SECONDS,
  };
}

/**
 * Atomic single-use resolve: verify HMAC, then `GETDEL` the Redis record so
 * a concurrent second resolve loses the race and gets `DOWNLOAD_TOKEN_CONSUMED`.
 *
 * On success the caller receives the full payload (including project_id) so it
 * can stream from upstream; on failure throws one of the three FR-only token
 * errors. We deliberately do NOT distinguish "expired (TTL elapsed)" from
 * "never issued / nonce wrong" beyond what TTL gives us — both look like a
 * missing Redis key. We surface CONSUMED only when the signature was valid
 * AND the key is missing AND the issued_at is still inside the TTL window;
 * otherwise EXPIRED. (A determined replayer racing a fresh mint is the
 * INVALID case because the sig would not match the new nonce.)
 */
export async function resolveDownloadToken(rawToken: string): Promise<DownloadTokenPayload> {
  let wire: TokenWire;
  try {
    const decoded = base64UrlDecode(rawToken);
    const parsed = JSON.parse(decoded) as Partial<TokenWire>;
    if (
      typeof parsed.user_id !== 'string' ||
      typeof parsed.artifact_id !== 'string' ||
      typeof parsed.issued_at !== 'number' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.sig !== 'string'
    ) {
      throw new DownloadTokenInvalidError('Token payload is malformed');
    }
    wire = parsed as TokenWire;
  } catch (err) {
    if (err instanceof DownloadTokenError) throw err;
    throw new DownloadTokenInvalidError('Token is not valid base64url-JSON');
  }

  const expectedSig = sign(wire.user_id, wire.artifact_id, wire.issued_at, wire.nonce);
  if (!constantTimeEqualHex(expectedSig, wire.sig)) {
    throw new DownloadTokenInvalidError('Token signature does not match');
  }

  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - wire.issued_at;
  // Reject obviously-future timestamps (clock skew tolerance: 30s) so a
  // forged-but-signature-valid token (e.g. via key compromise) can't be
  // back-dated indefinitely. Also rejects negative-age tokens entirely.
  if (ageSeconds < -30) {
    throw new DownloadTokenInvalidError('Token issued in the future');
  }
  if (ageSeconds > TOKEN_TTL_SECONDS) {
    throw new DownloadTokenExpiredError();
  }

  // Atomic single-use: GETDEL returns the value AND removes the key in one
  // round-trip. If two requests arrive concurrently, exactly one sees the
  // value; the other sees null and we surface CONSUMED.
  const key = `${KEY_PREFIX}${wire.nonce}`;
  const raw = (await redis.send('GETDEL', [key])) as string | null;

  if (raw === null || raw === undefined) {
    // Signature was valid AND age is inside the TTL window, so the key was
    // either consumed by an earlier successful resolve, or expired between
    // the timestamp check and the GETDEL (rare). Treat the expected case as
    // CONSUMED so replays surface the right error to the caller.
    throw new DownloadTokenConsumedError();
  }

  let record: RedisRecord;
  try {
    record = JSON.parse(raw) as RedisRecord;
  } catch {
    // Stored value isn't JSON we can read — defensive, since we control the
    // serialization. Treat as INVALID so callers don't race to download.
    throw new DownloadTokenInvalidError('Stored token record is corrupted');
  }

  // Cross-check that the signed wire matches the stored record. This catches
  // the (extremely unlikely) case of a nonce collision or a key compromise
  // letting an attacker mint for one user/artifact while the Redis record
  // belongs to another.
  if (record.user_id !== wire.user_id || record.artifact_id !== wire.artifact_id) {
    throw new DownloadTokenInvalidError('Token record mismatch');
  }

  return {
    user_id: record.user_id,
    artifact_id: record.artifact_id,
    project_id: record.project_id,
    issued_at: record.issued_at,
    // Absent for tokens minted before this field existed — the caller then
    // omits the header and behaves exactly as it did before.
    tenant_id: record.tenant_id,
    nonce: wire.nonce,
  };
}
