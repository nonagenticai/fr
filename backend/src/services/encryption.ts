// src/services/encryption.ts
//
// AES-GCM-256 envelope encryption for credentials at rest.
//
// Two surfaces:
//
//   1. The legacy `encrypt`/`decrypt` pair returns separate ciphertext +
//      base64 IV — used by `user_secrets` (`encrypted_value` bytea + `iv`
//      text columns). Existing call sites preserved unchanged.
//
//   2. `encryptToEnvelope`/`decryptFromEnvelope` return/consume a base64
//      JSON envelope `{v:1, iv, ct}` — used by `channels.credentials_enc`,
//      a single TEXT column. The decrypt path detects legacy plaintext
//      (no `{"v":` prefix) and returns it unchanged with a one-shot WARN
//      so a backfill can finish without downtime.
//
// IV is 12 fresh bytes from `crypto.getRandomValues` per call (NIST SP
// 800-38D §8.2.1 random-IV requirement). Key is 32 bytes derived from
// `config.security.encryptionKey` (env `SECRET_ENCRYPTION_KEY`); tests
// pin a deterministic 32-byte default in `tests/setup-env.ts` so suites
// run without a real env override.
//
// Error paths intentionally do NOT include ciphertext or key material in
// their messages — see `decryptFromEnvelope` below.
import { config } from '../config';

interface CredentialEnvelopeV1 {
  v: 1;
  /** base64-encoded 12-byte IV. */
  iv: string;
  /** base64-encoded ciphertext (with auth tag appended by AES-GCM). */
  ct: string;
}

/**
 * Heuristic discriminator between an envelope-encoded value and a legacy
 * plaintext value. Pre-cutover the column held arbitrary plaintext (typically
 * a JSON string of the credentials object); post-cutover it holds a base64-
 * encoded JSON envelope that always begins with `{"v":1` once decoded.
 *
 * The base64 prefix `eyJ2Ijox` decodes to `{"v":1`. Anything starting with
 * that prefix is treated as an envelope. Everything else is legacy
 * plaintext and passed through.
 */
const ENVELOPE_BASE64_PREFIX = 'eyJ2Ijox';

function looksLikeEnvelope(stored: string): boolean {
  return stored.startsWith(ENVELOPE_BASE64_PREFIX);
}

// One-shot WARN guard — every call site that hits a legacy plaintext row
// emits `[encryption] legacy_plaintext detected on credential read` ONCE
// per process so the operator can run the backfill without log spam.
let legacyPlaintextWarned = false;

class EncryptionService {
  private key: CryptoKey | null = null;

  async initialize(): Promise<void> {
    const keyMaterial = new TextEncoder().encode(config.security.encryptionKey);
    if (keyMaterial.byteLength < 32) {
      // Don't include the key (or its length being 'too short') in messages
      // that ship to logs verbatim — but the operator needs to know the
      // configured key is too short. Phrase it as a config error.
      throw new Error(
        'Encryption key configuration is invalid: SECRET_ENCRYPTION_KEY must be at least 32 bytes.',
      );
    }

    // Import key for AES-GCM
    this.key = await crypto.subtle.importKey(
      'raw',
      keyMaterial.slice(0, 32), // Use first 32 bytes
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encrypt(plaintext: string): Promise<{ encrypted: ArrayBuffer; iv: string }> {
    if (!this.key) throw new Error('Encryption service not initialized');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      encoded
    );

    return {
      encrypted,
      iv: Buffer.from(iv).toString('base64'),
    };
  }

  async decrypt(encryptedData: ArrayBuffer, ivBase64: string): Promise<string> {
    if (!this.key) throw new Error('Encryption service not initialized');

    const iv = Buffer.from(ivBase64, 'base64');

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.key,
      encryptedData
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Encrypt a plaintext string into a base64-encoded JSON envelope
   * `{v:1, iv, ct}`. The envelope shape is stable across process restarts
   * — the IV is stored alongside the ciphertext so a fresh process can
   * decrypt with the same configured key.
   *
   * IV is 12 fresh bytes per call. Empty plaintext is supported and
   * yields a distinct envelope every call (different IVs).
   */
  async encryptToEnvelope(plaintext: string): Promise<string> {
    if (!this.key) throw new Error('Encryption service not initialized');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      encoded,
    );
    const envelope: CredentialEnvelopeV1 = {
      v: 1,
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(new Uint8Array(ct)).toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  }

  /**
   * Decrypt a stored credential value. Three behaviors:
   *
   *   - `null` in → `null` out (no row / cleared credentials).
   *   - envelope-shaped (base64 of `{"v":1,…}`) → decrypted plaintext.
   *   - anything else → legacy plaintext passthrough + one-shot WARN.
   *
   * On decrypt failure (envelope-shaped but key/ct mismatch, or malformed
   * envelope JSON), throws a generic error WITHOUT echoing the ciphertext
   * or key material into the message — leak-resistance is required by
   * Phase 4 review gate.
   */
  async decryptFromEnvelope(stored: string | null): Promise<string | null> {
    if (stored === null || stored === undefined) return null;
    if (!this.key) throw new Error('Encryption service not initialized');

    if (!looksLikeEnvelope(stored)) {
      // Legacy plaintext — pre-backfill data. Pass through, warn once.
      if (!legacyPlaintextWarned) {
        legacyPlaintextWarned = true;
        // Intentionally does NOT include the value or any prefix of it.
        console.warn(
          '[encryption] legacy_plaintext detected on credential read — run scripts/encrypt-channel-credentials.ts to migrate.',
        );
      }
      return stored;
    }

    let envelope: CredentialEnvelopeV1;
    try {
      const json = Buffer.from(stored, 'base64').toString('utf8');
      const parsed = JSON.parse(json) as CredentialEnvelopeV1;
      if (parsed.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') {
        throw new Error('shape mismatch');
      }
      envelope = parsed;
    } catch {
      // Don't echo `stored` into the error message.
      throw new Error('Failed to parse credential envelope: malformed v1 envelope');
    }

    try {
      const iv = Buffer.from(envelope.iv, 'base64');
      const ct = Buffer.from(envelope.ct, 'base64');
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.key,
        ct,
      );
      return new TextDecoder().decode(plain);
    } catch {
      // Don't include ciphertext in the message.
      throw new Error('Failed to decrypt credential envelope (key mismatch or tampered ciphertext).');
    }
  }
}

export const encryption = new EncryptionService();
