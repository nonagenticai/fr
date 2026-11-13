// src/lib/api/connectors.ts
//
// Spec 2 Plan 2-C Phase 3 Task 3.3 — typed client for the
// `POST /api/connectors/test-connection` endpoint, used by the
// "Test connection" button in
// frontend/src/lib/components/scheduled-triggers/ConnectorForm.svelte.
//
// Backend route: backend/src/routes/connectors.ts (Phase 3 Task 3.2).

import { authFetch } from './auth-fetch';
import type { ConnectorKind } from '$lib/types/api';

/**
 * One sample record returned by a successful dry run. `raw` mirrors
 * the upstream record's shape (RSS item, github issue, S3 object) but
 * with every string field truncated to ~512 characters by the backend
 * route — never trust this for full-payload display.
 */
export interface DryRunSample {
  stable_id: string;
  raw: unknown;
}

export type DryRunResult =
  | {
      ok: true;
      sample_count: number;
      sample: DryRunSample[];
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

export interface TestConnectionInput {
  kind: ConnectorKind;
  config: unknown;
  secret_id?: string;
}

const BASE = '/api/connectors';

/**
 * Drive `Connector.dryRun(config, secret)` server-side. Returns the
 * typed dry-run envelope. Throws only on network errors / non-200
 * HTTP responses (auth failure, body-validation failure) — successful
 * `ok: false` returns from the connector itself surface as a normal
 * resolved value with `ok: false`, NOT as a thrown error.
 */
export async function testConnection(
  input: TestConnectionInput,
): Promise<DryRunResult> {
  const res = await authFetch(`${BASE}/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // body was not JSON — keep default message
    }
    throw new Error(`testConnection: ${message}`);
  }
  return (await res.json()) as DryRunResult;
}

export const connectors = {
  testConnection,
};
