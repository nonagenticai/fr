// Plan 7 Stage 9 — thin wrapper around the canonical card-create path.
// Used by agent-asset.ts to route principle/requirement/decision through
// the Plan-7 loop instead of calling create* upstream directly.
//
// Body shape mirrors a subset of POST /api/cards/improvement (see
// services/improvement-cards/request-schema.ts). Returns card_id; the
// caller treats that as the upstream id for the AG-UI action's response.

import { IntegrationError } from '../../integrations/_lib/errors';

export type AssetCardType =
  | 'principle_development'
  | 'requirement_development'
  | 'decision_development'
  // change_*_development cards revise an EXISTING asset (vs the *_development
  // cards above which author a new one). They carry target_asset_id; when the
  // loop reaches QA the change persists via PUT (updateX) in
  // routes/asset-authoring/publish.ts.
  | 'change_principle_development'
  | 'change_requirement_development'
  | 'change_decision_development';

export type AssetCardGroup = 'principle' | 'requirement' | 'decision';

export interface MintImprovementCardBody {
  card_type: AssetCardType;
  card_group: AssetCardGroup;
  target_list: 'TODO';
  problem_statement: string;
  desired_outcome: string;
  requestor: string;
  /**
   * For change_*_development cards: the id + kind of the asset being revised.
   * These map onto the CardGenerationRequest `asset_id`/`asset_kind` fields,
   * which the improvement-card route persists into the card's Metadata group
   * (Metadata.asset_id) — the one place n8n card-hydration + the QA-phase
   * publish can read the target asset back from. The create path leaves both
   * unset (a new asset has no id yet).
   */
  asset_id?: string;
  asset_kind?: AssetCardGroup;
  /**
   * @deprecated Not part of CardGenerationRequest, so the route drops it.
   * Kept only to document intent; the real carrier is `asset_id` above.
   */
  target_asset_id?: string;
}

export interface MintImprovementCardCtx {
  tenantId: string;
  /** Optional Bearer token forwarded to fr's /api/cards/improvement. */
  licenseToken?: string;
}

/**
 * Per-request ceiling for the two self-calls below.
 *
 * There was NO timeout at all. These call fr's OWN `FR_INTERNAL_URL`, so a
 * wedged fr wedges itself: the caller waits forever and nothing bounds it.
 */
export const IMPROVEMENT_CARD_TIMEOUT_MS = 30_000;

/** Shared transport for the two self-calls: bounded, and coded on failure. */
async function callSelf(
  url: string,
  path: string,
  init: RequestInit,
  op: string,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error('timeout')),
    IMPROVEMENT_CARD_TIMEOUT_MS,
  );
  try {
    return await fetch(`${url}${path}`, { ...init, signal: ac.signal });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    throw new IntegrationError({
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: timedOut
        ? `${op} timed out after ${IMPROVEMENT_CARD_TIMEOUT_MS}ms`
        : `${op} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      service: 'fr-internal',
      method: String(init.method ?? 'GET'),
      path,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function mintImprovementCard(
  body: MintImprovementCardBody,
  ctx: MintImprovementCardCtx,
): Promise<{ card_id: string }> {
  const url = process.env.FR_INTERNAL_URL;
  if (!url) {
    throw new Error(
      'mintImprovementCard: FR_INTERNAL_URL is not set. Set it in the gitops ' +
        'fr ConfigMap; no hardcoded fallback is permitted per ' +
        'deployment/docs/config-externalization-policy.md.',
    );
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': ctx.tenantId,
  };
  if (ctx.licenseToken) headers.Authorization = `Bearer ${ctx.licenseToken}`;

  const res = await callSelf(
    url,
    '/api/cards/improvement',
    { method: 'POST', headers, body: JSON.stringify(body) },
    'mintImprovementCard',
  );
  if (!res.ok) {
    // The BODY goes in `upstreamBody`, NOT `message`. The telemetry logger
    // emits `message` verbatim, so interpolating the response text here is the
    // same leak fixed in metering-admin and documents on this branch.
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: `mintImprovementCard failed: ${res.status}`,
      service: 'fr-internal',
      method: 'POST',
      path: '/api/cards/improvement',
      upstreamStatus: res.status,
      upstreamBody: await res.text(),
    });
  }
  return (await res.json()) as { card_id: string };
}
