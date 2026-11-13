// src/connectors/types.ts
// Shared types for all connectors (Spec 2 Plan 2-B).

export interface FetchedRecord {
  /** Stable identifier for dedup via action_idempotency. */
  stable_id: string;
  /** Raw record data — passed through payload_mapper. */
  raw: unknown;
}

export interface DecryptedSecret {
  value: string;
}

/**
 * Result of a `Connector.dryRun(config, secret)` call.
 *
 * `ok: true` — the connector successfully reached the upstream and
 * returned up to `sample_count` records. `sample` is the small preview
 * (max ~3 records, with strings truncated by the route layer to prevent
 * accidental secret leak).
 *
 * `ok: false` — the connector could not reach upstream or the config
 * was rejected. `error.code` is one of `ConnectorErrorCode` (or
 * `'unreachable'` / `'timeout'` for the n8n_webhook preflight path),
 * and `error.message` is human-readable.
 */
export type DryRunResult =
  | { ok: true; sample_count: number; sample: FetchedRecord[] }
  | { ok: false; error: { code: string; message: string } };

export interface Connector {
  /**
   * Async generator yielding records from the source.
   * Throws ConnectorError on unrecoverable failures.
   */
  fetch(
    config: unknown,
    secret: DecryptedSecret | null,
  ): AsyncGenerator<FetchedRecord>;

  /**
   * Verify the (config, secret) pair reaches the upstream and yields
   * at least one parseable record (or 0 records cleanly, e.g. an empty
   * inbox / S3 prefix). Returns at most ~3 sample records for UI
   * preview. Never throws — all failures collapse to
   * `{ ok: false, error: { code, message } }`.
   *
   * Used by `POST /api/connectors/test-connection` to power the
   * "Test connection" button in ConnectorForm.svelte.
   */
  dryRun(
    config: unknown,
    secret: DecryptedSecret | null,
  ): Promise<DryRunResult>;
}

export type ConnectorErrorCode =
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_RATE_LIMITED'
  | 'PARSE_ERROR'
  | 'CONFIG_MISMATCH'
  | 'MISSING_SECRET'
  | 'INVALID_SECRET'
  | 'INVALID_QUERY'
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED';

export class ConnectorError extends Error {
  public override readonly cause: unknown;
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ConnectorError';
    this.cause = cause;
  }
}
