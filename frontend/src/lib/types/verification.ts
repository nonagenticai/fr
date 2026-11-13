// verification.ts (types)
// ========================
// Frontend mirror of the verification API contract (v1, 2026-09-23).
//
// Every fr route under /api/admin/verification/* returns `Block<T>` whose
// `data` is the upstream payload VERBATIM (inference-router or Prometheus). fr never
// recomputes a status or a metric; these types only describe what arrives.
//
// (The determinism / judge-calibration benchmark payloads were removed
// 2026-11-01 with asset-evaluator; only the alerts strip remains.)

// ---------------------------------------------------------------------------
// Contract A10.4 (2026-09-26): alerts. fr's OWN Prometheus read — the
// contract's first named exception to "fr never derives". `reachable` lives
// INSIDE `data`, not `meta.available` — a Prometheus outage is a real,
// renderable state ("alert state unknown", grey), never the generic
// block-outage path and never rendered as "no alerts".
// ---------------------------------------------------------------------------

export type TrustConcept = 'oracle' | 'judge' | 'candidates' | 'determinism';

export type VerificationAlertState = 'firing' | 'pending';

export interface VerificationAlertItem {
  alertname: string;
  state: VerificationAlertState;
  severity: string | null;
  /** The `concept` label if present; null = board-wide (contract A10.4). */
  concept: TrustConcept | (string & {}) | null;
  /** When the alert started (`/api/v1/alerts`'s own `activeAt`), or null if the upstream row omitted it. Never fabricated. */
  active_at: string | null;
  /** `annotations.summary` when the rule carries one, else null. */
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
