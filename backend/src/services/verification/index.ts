// src/services/verification/index.ts
//
// Verification read models — the super-admin "can we trust the conveyor's
// verdicts?" surface (/operate/verification). Contract: judge-oracle
// tournament review, api-contract v1 + fr-routes (2026-09-23).
//
// Every upstream read is ONE `block()`: an outage becomes
// `{data:null, meta:{available:false, unavailable_kind:'error'}}`, never an
// empty payload and never zeros. `data` is the upstream payload VERBATIM — fr
// never recomputes a status or a metric.
//
// Judge/Candidates/tournament removal (George's ruling 2026-09-27): fr no
// longer reads procedure_management's `governance.tournament.policy` — that
// client (getTournamentPolicy) existed only to back the removed Candidates
// tab and has been deleted along with it.
//
// Upstreams:
//   - inference-router — /served-models/timeline
//   - Prometheus — /api/v1/alerts

import { getServedModelsTimeline as getIrServedModelsTimeline } from '../../integrations/inference-router';
import {
  IntegrationError,
  isIntegrationError,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import { block, type Block } from '../read-models/_lib';
import { getPrometheusClient, type PromAlert } from '../prometheus-client';

// ---------------------------------------------------------------------------
// Prometheus alerts
// ---------------------------------------------------------------------------

/** A10.4: which alert family this surface renders (filtered here, not upstream — `/api/v1/alerts` takes no query). */
const VERIFICATION_ALERTNAME_PREFIX = 'Verification';

/**
 * A10.4: Prometheus alerts. Reads `GET /api/v1/alerts`, not an instant query
 * over the `ALERTS` series, because only this endpoint carries `activeAt` —
 * the real activation time an operator needs for "since when".
 */
async function readPromAlerts(): Promise<PromAlert[]> {
  return getPrometheusClient().alerts();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every contract payload is a JSON object (runs is a list). Anything else — an
 * empty 200 body, a string, null — is a contract break, and it must surface as
 * UNAVAILABLE, not render as an empty board.
 */
function requireObject(service: string, what: string, v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `${what}: expected a JSON object`,
      service,
    });
  }
  return v as Record<string, unknown>;
}

function requireArray(service: string, what: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `${what}: expected a JSON array`,
      service,
    });
  }
  return v;
}

// ---------------------------------------------------------------------------
// inference-router served-model timeline
// ---------------------------------------------------------------------------

/** inference-router `/served-models/timeline` — which model actually served each requested alias, per day. */
export function getServedModelsTimeline(q: { days?: number }): Promise<Block<Record<string, unknown>>> {
  return block('inference-router', async () =>
    requireObject('inference-router', 'served-models/timeline', await getIrServedModelsTimeline({ days: q.days })),
  );
}

// ---------------------------------------------------------------------------
// A10.4 — Prometheus alerts. fr's OWN block: this is one of the contract's two
// named exceptions to "fr never derives" (the other is the A10.5 preflight
// below). `reachable` lives INSIDE `data`, not in `meta.available` — "alert
// state unknown" is a real, renderable state (grey), never the generic
// block-outage path and never rendered as "no alerts".
// ---------------------------------------------------------------------------

export type VerificationAlertState = 'firing' | 'pending';

export interface VerificationAlertItem {
  alertname: string;
  state: VerificationAlertState;
  severity: string | null;
  /** The `concept` label if the alert carries one; null = board-wide (contract A10.4). */
  concept: string | null;
  /**
   * When the alert started, from `/api/v1/alerts`'s own `activeAt` — the
   * real activation timestamp, not an evaluation timestamp. Null only when
   * the upstream row itself omitted it; never fabricated.
   */
  active_at: string | null;
  /** `annotations.summary` when the rule carries one, else null — never fabricated. */
  summary: string | null;
  labels: Record<string, string>;
}

export interface VerificationAlertsPayload {
  source: 'prometheus';
  reachable: boolean;
  error?: string;
  as_of: string;
  items: VerificationAlertItem[];
}

function toAlertItem(v: unknown): VerificationAlertItem | null {
  if (!v || typeof v !== 'object') return null;
  const row = v as { labels?: unknown; annotations?: unknown; state?: unknown; activeAt?: unknown };
  const labels = row.labels;
  if (!labels || typeof labels !== 'object') return null;
  const { alertname, severity, concept, ...rest } = labels as Record<string, string>;
  if (typeof alertname !== 'string' || !alertname) return null;
  if (!alertname.startsWith(VERIFICATION_ALERTNAME_PREFIX)) return null;
  if (row.state !== 'firing' && row.state !== 'pending') return null;
  const annotations = row.annotations && typeof row.annotations === 'object' ? (row.annotations as Record<string, string>) : {};
  return {
    alertname,
    state: row.state,
    severity: typeof severity === 'string' && severity ? severity : null,
    concept: typeof concept === 'string' && concept ? concept : null,
    active_at: typeof row.activeAt === 'string' && row.activeAt ? row.activeAt : null,
    summary: typeof annotations.summary === 'string' && annotations.summary ? annotations.summary : null,
    labels: { alertname, ...(severity ? { severity } : {}), ...(concept ? { concept } : {}), ...rest },
  };
}

/**
 * A10.4: `GET /api/v1/alerts`, filtered here to alertnames starting with
 * `Verification` (the endpoint takes no query — Prometheus returns every
 * live alert). Never throws — a query failure becomes `reachable:false` +
 * `items:[]` INSIDE an always-available block (the outer `block()` never
 * sees a rejection here).
 */
export function getAlerts(): Promise<Block<VerificationAlertsPayload>> {
  return block('prometheus', async (): Promise<VerificationAlertsPayload> => {
    const as_of = new Date().toISOString();
    try {
      const result = await readPromAlerts();
      const items = requireArray('prometheus', 'alerts', result)
        .map(toAlertItem)
        .filter((x): x is VerificationAlertItem => x !== null);
      return { source: 'prometheus', reachable: true, as_of, items };
    } catch (err) {
      reportSwallowedFailure(err, { service: 'prometheus', degradedTo: 'verification alerts -> reachable:false' });
      const error = isIntegrationError(err) ? `${err.code}: ${err.message}` : 'prometheus unreachable';
      return { source: 'prometheus', reachable: false, error, as_of, items: [] };
    }
  });
}
