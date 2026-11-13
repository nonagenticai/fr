// src/connectors/commonpractice-feedback.ts
//
// Phase 5.1 — fr→CP promotion feedback (closes the CP→fr delivery loop).
//
// When an fr `project_request` that Common Practice forwarded is approved and
// promoted to a real project (routes/project-requests.ts handleApprove), fr
// notifies CP so CP can flip its `solution_deliveries` row draft_created →
// promoted and stamp the new fr_project_id + deep link.
//
// Direction & auth: fr → CP, POST {COMMONPRACTICE_API_URL}/api/delivery/fr-feedback,
// authed by fr's existing portal service account (fr-backend) which carries the
// `delivery-feedback-writer` realm role (provisioned 2026-06-13). CP validates
// the JWT against the same portal JWKS it uses for user tokens — no new secret.
//
// This call is STRICTLY BEST-EFFORT: it NEVER throws and NEVER blocks the
// promotion (which already succeeded in fr). A CP outage / 5xx / timeout is
// logged + recorded in the request history; CP can reconcile later. The call is
// skipped entirely for non-CP-originated requests and when the CP base URL is
// unconfigured (empty COMMONPRACTICE_API_URL disables the loop).

import { config } from '../config';
import { getServiceAuthenticator } from '../lib/service-authenticators';

/** What fr tells CP when a CP-originated request is promoted. */
export interface CpPromotedFeedback {
  /** external_origin.source — only "commonpractice" requests are reported. */
  source: string;
  /** The fr project_request id (== CP solution_deliveries.external_ref). The join key. */
  projectRequestId: string;
  /** The newly-created fr project id (lands in CP solution_deliveries.fr_project_id). */
  frProjectId: string;
  /** The request's tenant (CP sets app.current_tenant from this to find the row under RLS). */
  tenantId: string;
  /** external_origin.cp_solution_id — CP cross-checks it against the matched delivery. */
  cpSolutionId: string;
  /** Deep link to the promoted fr project (empty when FR_PUBLIC_URL is unset). */
  frProjectUrl: string;
}

export interface CpFeedbackResult {
  /** false = skipped (non-CP origin or CP url unconfigured); true = an HTTP call was made. */
  attempted: boolean;
  ok: boolean;
  /** Short human-readable outcome for the request history / logs. */
  detail: string;
}

const TIMEOUT_MS = 5_000;

/** The real outbound POST. Bounded, never throws. */
async function postCpPromoted(fb: CpPromotedFeedback): Promise<CpFeedbackResult> {
  const base = config.services.commonpractice.baseUrl;
  if (!base) {
    return { attempted: false, ok: false, detail: 'COMMONPRACTICE_API_URL unset — feedback disabled' };
  }
  const url = `${base}/api/delivery/fr-feedback`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await getServiceAuthenticator().authenticatedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_request_id: fb.projectRequestId,
        fr_project_id: fb.frProjectId,
        tenant_id: fb.tenantId,
        cp_solution_id: fb.cpSolutionId,
        fr_project_url: fb.frProjectUrl,
      }),
      signal: controller.signal,
    });
    if (res.ok) return { attempted: true, ok: true, detail: `CP ${res.status}` };
    const text = await res.text().catch(() => '');
    return { attempted: true, ok: false, detail: `CP ${res.status} ${text.slice(0, 200)}`.trim() };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const detail =
      e?.name === 'AbortError'
        ? `timeout after ${TIMEOUT_MS}ms`
        : e?.message ?? 'network error';
    return { attempted: true, ok: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort fr→CP promotion feedback. NEVER throws. Returns a result the
 * caller folds into the project_request history. Skips non-CP-originated
 * requests (attempted=false).
 */
export async function notifyCpPromoted(fb: CpPromotedFeedback): Promise<CpFeedbackResult> {
  if (fb.source !== 'commonpractice') {
    return { attempted: false, ok: false, detail: 'not a commonpractice-originated request' };
  }
  try {
    return await postCpPromoted(fb);
  } catch (err) {
    // Defensive: the impl is written never to throw, but a callback must never
    // be able to break an approval.
    return { attempted: true, ok: false, detail: (err as Error)?.message ?? 'unexpected feedback error' };
  }
}
