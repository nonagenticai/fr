// src/routes/internal-conveyor-flow-runs.ts
//
// Cockpit A5 / R-CK5 — POST /api/internal/conveyor/flow-runs: the n8n-custom execution hook
// reports every conveyor execution (start, waiting, resume, end) to fr. The records land in
// `conveyor_flow_runs` (migration 213) through services/conveyor-flow-runs.ts.
//
// DOOR (S2S only — a user token can never write here):
//   1. FR_FLOW_RUN_WRITER_AZP unset/empty ⇒ 503 `flow_run_ingest_unconfigured` (fail closed,
//      before any token is read).
//   2. validateAuth with `allowServiceRealms` (the S2S doors' rule: a secure-apps service token
//      verifies here) ⇒ 401 on a missing / invalid token. A licence bearer is refused 403 by
//      validateAuth's licence route door (this route is not on the allowlist).
//   3. The issuer must be one of FR_FLOW_RUN_ISSUER (default KEYCLOAK_ISSUER) ⇒ else 403.
//   4. The token must be a CLIENT-CREDENTIALS service account (`isServiceAccount`) ⇒ else 403
//      `service_account_required` — every human / password-grant token stops here.
//   5. Its `azp` must be one of FR_FLOW_RUN_WRITER_AZP ⇒ else 403 `flow_run_writer_forbidden`.
//   AUTH_BYPASS (dev only; refused on a production-shaped boot) skips 3–5, like the bridge door.
//
// BODY: one record, an array of ≤ 200, or `{records: [...]}`. 200 with the counts whenever the
// body itself is well-formed — a bad RECORD is counted in `rejected`, never a 500. 503
// `flow_run_write_failed` only when records were valid and NONE could be written (so the hook
// retries a database outage rather than dropping the batch).
import { frFlowRunIssuers, frFlowRunWriterAzps } from '../config';
import { validateAuth } from '../middleware/auth';
import { FlowRunBodyError, ingestFlowRuns } from '../services/conveyor-flow-runs';
import { AppError, ForbiddenError, handleError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

type User = Awaited<ReturnType<typeof validateAuth>>;

/** The door. Throws AppError (401 / 403 / 503); returns the verified service account. */
export async function requireFlowRunWriter(req: Request): Promise<User> {
  const bypass = process.env.AUTH_BYPASS === 'true';
  const azps = frFlowRunWriterAzps();
  if (!bypass && azps.length === 0) {
    throw new AppError(503, 'Flow-run ingest is not configured (FR_FLOW_RUN_WRITER_AZP is unset)').withCode(
      'flow_run_ingest_unconfigured',
    );
  }
  const user = await validateAuth(req, { allowServiceRealms: true });
  if (bypass) return user;
  if (user.authKind === 'licence') {
    throw new ForbiddenError('This route accepts a service-account token only').withCode('service_account_required');
  }
  if (user.issuer === undefined || !frFlowRunIssuers().includes(user.issuer)) {
    throw new ForbiddenError('The token was not issued by the realm the flow-run writer is accepted from').withCode(
      'flow_run_writer_forbidden',
    );
  }
  if (user.isServiceAccount !== true) {
    throw new ForbiddenError('This route accepts a service-account token only').withCode('service_account_required');
  }
  if (!user.azp || !azps.includes(user.azp)) {
    throw new ForbiddenError('The token was not issued to a flow-run writer client').withCode('flow_run_writer_forbidden');
  }
  return user;
}

/** POST /api/internal/conveyor/flow-runs */
export async function handleIngestConveyorFlowRuns(req: Request): Promise<Response> {
  try {
    await requireFlowRunWriter(req);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'The body is not JSON', code: 'invalid_body' }, 400);
    }
    let result;
    try {
      result = await ingestFlowRuns(body);
    } catch (err) {
      if (err instanceof FlowRunBodyError) return jsonResponse({ error: err.message, code: err.code }, err.status);
      throw err;
    }
    const written = result.inserted + result.updated + result.kept_terminal;
    if (written === 0 && result.failed.length > 0) {
      return jsonResponse({ error: 'No valid record could be written', code: 'flow_run_write_failed', data: result }, 503);
    }
    return jsonResponse({ data: result });
  } catch (err) {
    return handleError(err);
  }
}
