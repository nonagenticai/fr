// src/routes/approval-write-set.ts
//
// GET /api/approvals/:approvalId/write-set?tenant_id=<uuid> — U4. The APPROVED, sealed write
// set of a PR-bearing proof card: every repo-relative path its PR may create, modify or delete.
// ncn reads it at dispatch (pre-send createPullRequest refusal) and the constraint-check
// landing gate re-reads it at the PR head. Resolution + contract: services/approvals/write-set.ts.
//
// ⛔ LICENCE DOOR ONLY (G4, George 2026-10-10 — lib/licence-door.ts `licenceOnly`), the same
// door as GET /api/approvals/bug-fix-for-card/:bugCardId: the shared X-Webhook-Secret door was
// REMOVED on BOTH verbs. No Keycloak-JWT lane. The caller NAMES the tenant (`tenant_id`,
// required) and it must be the licence's tenant — else the same 404 approval_not_found (this
// route's not-yours convention). Both verbs are read-only.
// ⛔ TENANT-PREDICATED: another tenant's approval is 404, byte-identical to a missing one.
// ⛔ RE-SEALS ON READ: a feature write set whose recomputed seal differs is 409
// write_set_seal_mismatch and NOTHING of it is returned.
//
//   200 { data: { approval_id, source: 'feature'|'bug_fix', write_set: string[], write_set_seal } }
//   400 tenant_id_invalid
//   401 no licence token / licence refused (an X-Webhook-Secret header is ignored)
//   404 approval_not_found
//   409 not_a_write_set_approval | write_set_missing | write_set_seal_mismatch |
//       write_set_invalid | write_set_too_broad | report_not_found | report_hash_mismatch |
//       approval_items_missing | no_approved_bugs
//
// POST /api/approvals/:approvalId/write-set/fence — U4 PR-LESS fence. Same door, same tenant
// rule, same resolution (resolveSealedWriteSet below — ONE reader for both verbs, so the two
// can never answer different 404/409s), then the ONE rule (lib/write-set.ts
// evaluateWriteSetFence) over the caller's change set. Lets ncn refuse BEFORE
// createPullRequest, when there is no PR for constraint-check to read. READ-ONLY: no write.
//
//   body { tenant_id: uuid, changed_paths: string[] }   changed_paths = added ∪ modified ∪
//        deleted ∪ rename-old ∪ rename-new, 1..MAX_CHANGED_PATHS non-empty strings ≤ 1024
//        (the constraint-check caps). EMPTY is refused: an empty change set would pass
//        vacuously, so a caller that dropped its paths must not read as in_set.
//   200 { data: { approval_id, outcome: 'in_set'|'write_set_test_path_mismatch'|
//                 'diff_outside_write_set', offending: string[], write_set_seal,
//                 checked_paths_count } }   (outcome/offending exactly as the rule returns them)
//   400 tenant_id_invalid | changed_paths_invalid      401 | 404 | 409 as the GET

import { licenceOnly, sameTenant, type LicenceDoor } from '../lib/licence-door';
import { isUuidShape } from '../lib/uuid-shape';
import { AppError, BadRequestError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { resolveApprovalWriteSet, type ApprovalWriteSet } from '../services/approvals/write-set';
import { assertWriteSetPaths } from '../services/approvals/write-set-paths';
import { evaluateWriteSetFence, type WriteSetFenceOutcome } from '../lib/write-set';
import { MAX_CHANGED_PATHS } from './project-constraint-check';

/** Same per-path bound as constraint-check's `changed_paths`. */
const MAX_CHANGED_PATH_LENGTH = 1024;

function requireTenantId(raw: unknown, where: 'query parameter' | 'body field', door: LicenceDoor): string {
  const tenantId = typeof raw === 'string' ? raw.trim() : '';
  if (!isUuidShape(tenantId)) {
    throw new BadRequestError(`tenant_id ${where} (uuid) is required`).withCode('tenant_id_invalid');
  }
  // Licence door: another tenant reads exactly like a missing approval.
  if (!sameTenant(tenantId, door.tenantId)) {
    throw new AppError(404, 'Approval not found').withCode('approval_not_found');
  }
  return tenantId;
}

/**
 * The ONE resolution both verbs use: tenant-scoped read + re-seal (services/approvals/write-set.ts),
 * refusals thrown as their 404/409 code, then the egress path predicate.
 */
async function resolveSealedWriteSet(approvalId: string, tenantId: string): Promise<ApprovalWriteSet> {
  const r = await resolveApprovalWriteSet({ approvalId: (approvalId ?? '').trim(), tenantId });
  if (!r.ok) throw new AppError(r.status, r.message).withCode(r.code);
  // EGRESS: what leaves this door passes the ONE path predicate (write-set-paths.ts), the same
  // one the constraint-check fence applies — the two can never disagree on a path.
  // Throws WriteSetPathsError: an AppError 409 carrying write_set_invalid | write_set_too_broad.
  assertWriteSetPaths(r.data.write_set);
  return r.data;
}

export async function handleGetApprovalWriteSet(req: Request, approvalId: string): Promise<Response> {
  const door = await licenceOnly(req);
  const tenantId = requireTenantId(new URL(req.url).searchParams.get('tenant_id'), 'query parameter', door);
  return jsonResponse({ data: await resolveSealedWriteSet(approvalId, tenantId) });
}

export interface WriteSetFenceResponse {
  approval_id: string;
  outcome: WriteSetFenceOutcome;
  offending: string[];
  write_set_seal: string;
  checked_paths_count: number;
}

export async function handleApprovalWriteSetFence(req: Request, approvalId: string): Promise<Response> {
  const door = await licenceOnly(req);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  const body = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const tenantId = requireTenantId(body.tenant_id, 'body field', door);

  const paths = body.changed_paths;
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > MAX_CHANGED_PATHS ||
    !paths.every((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_CHANGED_PATH_LENGTH)
  ) {
    throw new BadRequestError(
      `changed_paths must be 1..${MAX_CHANGED_PATHS} non-empty strings of at most ${MAX_CHANGED_PATH_LENGTH} chars`,
    ).withCode('changed_paths_invalid');
  }
  const changed = new Set(paths as string[]);

  const ws = await resolveSealedWriteSet(approvalId, tenantId);
  const fence = evaluateWriteSetFence(ws.write_set, changed);
  const data: WriteSetFenceResponse = {
    approval_id: ws.approval_id,
    outcome: fence.outcome,
    offending: fence.offending,
    write_set_seal: ws.write_set_seal,
    checked_paths_count: changed.size,
  };
  return jsonResponse({ data });
}
