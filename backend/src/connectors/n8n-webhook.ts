// src/connectors/n8n-webhook.ts
// Passive n8n_webhook connector — records arrive via POST /api/intake/webhook/:trigger_id.
// The fetch() generator yields nothing; the intake webhook route handles inbound records.
// Spec 2 Plan 2-B Track A; Plan 2-C Phase 3 adds dryRun preflight.

import type { N8nWebhookConnectorConfig } from '../types/connectors';
import type { Connector, DecryptedSecret, DryRunResult, FetchedRecord } from './types';
import { assertPublicUrl, safeFetch, SsrfBlockedError } from '../utils/ssrf-guard';

const PREFLIGHT_TIMEOUT_MS = 5_000;

export const n8nWebhookConnector: Connector = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *fetch(_config: unknown, _secret: DecryptedSecret | null): AsyncGenerator<FetchedRecord> {
    // n8n_webhook is a passive connector.
    // Records are pushed inbound via POST /api/intake/webhook/:trigger_id.
    // This generator intentionally yields nothing during cron ticks.
  },

  async dryRun(config: unknown, _secret: DecryptedSecret | null): Promise<DryRunResult> {
    // The n8n_webhook connector is passive — fr never fetches from n8n;
    // n8n POSTs into fr. dryRun therefore performs an outbound preflight
    // against the operator's n8n webhook URL to verify reachability +
    // basic auth posture. We accept ANY HTTP status (including 4xx) as
    // a positive "reachable" signal — n8n test webhooks commonly return
    // 404 when not in test-listen mode, and authenticated webhooks
    // return 401/403 to a HEAD without credentials. Network errors and
    // timeouts are the failure path.
    const cfg = config as N8nWebhookConnectorConfig;
    const url = cfg?.webhook_url;
    if (!url) {
      return {
        ok: false,
        error: { code: 'CONFIG_MISMATCH', message: 'webhook_url is required' },
      };
    }

    // SSRF guard: webhook_url is operator-supplied and this preflight is
    // reachable by ANY authenticated user via POST /api/connectors/test-connection.
    // Without it the "test connection" button is a port scanner for the whole
    // Tailnet. Reported as a config problem, not a reachability result, so the
    // caller cannot use a blocked target as an existence oracle.
    try {
      await assertPublicUrl(url);
    } catch (err) {
      return {
        ok: false,
        error: { code: 'CONFIG_MISMATCH', message: (err as Error).message },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        // HEAD first — cheapest and most servers honor it. Some n8n
        // webhook configurations reject HEAD; fall back to OPTIONS.
        // H3: safeFetch re-checks every redirect hop.
        response = await safeFetch(url, { method: 'HEAD', signal: controller.signal });
        if (response.status === 405 || response.status === 501) {
          response = await safeFetch(url, {
            method: 'OPTIONS',
            signal: controller.signal,
          });
        }
      } catch (err) {
        // AbortError (timeout) and any network-level failure both land
        // here. Distinguish for clearer UX in the FE button panel.
        // A refused redirect is a config problem, never a reachability result
        // (same no-oracle rule as the pre-check above).
        if (err instanceof SsrfBlockedError) {
          return { ok: false, error: { code: 'CONFIG_MISMATCH', message: err.message } };
        }
        const e = err as { name?: string; message?: string };
        if (e?.name === 'AbortError') {
          return {
            ok: false,
            error: {
              code: 'timeout',
              message: `Preflight timed out after ${PREFLIGHT_TIMEOUT_MS}ms`,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: 'unreachable',
            message: e?.message ?? 'Network error during preflight',
          },
        };
      }

      // Any HTTP response — including 4xx — proves reachability.
      // 5xx is treated as upstream-error; the operator's n8n is up
      // but mis-wired, so we surface that differently.
      if (response.status >= 500) {
        return {
          ok: false,
          error: {
            code: 'UPSTREAM_ERROR',
            message: `n8n webhook returned HTTP ${response.status}`,
          },
        };
      }

      return { ok: true, sample_count: 0, sample: [] };
    } finally {
      clearTimeout(timer);
    }
  },
};
