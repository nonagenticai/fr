// src/lib/operator-billing.ts
//
// George 2026-10-27 DECISION: a super_admin switched into another tenant — or
// their switched Copilot session — is OPERATOR activity, billed to
// INTERNAL_SYSTEM_TENANT_ID, never to the customer.
//
// fr's own usage spans already follow that (middleware/usage-spans.ts). The
// Copilot's LLM usage does not go through fr's spans: the agent loop calls
// worker_management (`/workers/{name}/message`), and the http client presents
// the FRAME tenant's own `workers` licence (integrations/workers.ts), so WM —
// and inference-router behind it — bills that tenant. `asOperatorBilledCall`
// runs exactly those WM calls in a frame whose tenant is the SYSTEM tenant:
//
//   * WM receives the system tenant's `workers` licence (minted per tenant by
//     lib/bundle-token-minter.ts), so the LLM call is metered, budgeted and
//     licensed against the system tenant — the customer's licence and budget
//     are untouched;
//   * the customer's project id and end-user token are NOT carried onto it;
//   * DATA and TOOLS stay scoped to the target tenant: only the WM round trip
//     runs in this frame — every fr tool the model calls runs in the caller's
//     own (target-tenant) frame, exactly as before.
//
// ⚠️ GAP (needs worker_management): WM forwards only tenant / licence / subject
// to inference-router (`_chat_router.py _build_agent`), so the LLM cost row
// cannot carry `operator_target_tenant_id` yet. fr records it on its own span
// (usage-spans) and on the audit row; the LLM row is attributable through the
// correlation id until WM forwards an operator-target attribute.

import { withRequestContext, tryGetRequestContext } from '../integrations/_lib/context';
import { INTERNAL_SYSTEM_TENANT_ID } from '../middleware/internal-tenant-only';
import { switchedSuperAdminFrame } from './super-admin-tenant-audit';

/** Run `fn` billed to the system tenant iff the current frame is a switched super_admin; else as-is. */
export async function asOperatorBilledCall<T>(fn: () => Promise<T>): Promise<T> {
  const frame = tryGetRequestContext();
  if (!frame || !switchedSuperAdminFrame(frame)) return fn();
  const { projectId: _projectId, endUserToken: _endUserToken, ...rest } = frame;
  return withRequestContext({ ...rest, tenantId: INTERNAL_SYSTEM_TENANT_ID }, fn);
}
