// src/lib/api/signup-approvals.ts
//
// Typed client for the early-access signup v2 super_admin surface (backend
// routes/signup-approvals.ts). The two service doors (intake, Telegram decision)
// are not called from the browser.
//
//   GET  /api/signup-approvals?status=   → { items: SignupApproval[] }
//   GET  /api/signup-approvals/:id       → { data: SignupApproval }
//   POST /api/signup-approvals/invite    → ApproveResult & { reusedPending }
//   POST /api/signup-approvals/:id/approve        { tenantName? } → ApproveResult
//   POST /api/signup-approvals/:id/reject         → { approval }
//   POST /api/signup-approvals/:id/retry          → { approval }
//   POST /api/signup-approvals/:id/resolve-repair { note, acknowledgeLiveAccess } → { approval }
//   POST /api/signup-approvals/:id/remove           { confirm: <slug> } → { approval }
//   POST /api/signup-approvals/:id/removal/retry    → { approval }
//   POST /api/signup-approvals/:id/removal/resolve  { note, acknowledgeLiveAccess } → { approval }
//
// Every refusal throws an Error carrying the backend's own reason
// (`errorDetailFrom`), never a bare status. 503 `signup_not_configured` means the
// deployment does not take signups (FR_SIGNUP_ENABLED is off) — the page shows
// that as its own state.

import { authFetch } from './auth-fetch';
import { errorDetailFrom } from './error-detail';
import { logRawError } from '$lib/workers/wm-errors';

export const SIGNUP_LOCALES = ['en', 'ar', 'de', 'es', 'fr', 'he', 'nl', 'pl'] as const;
export type SignupLocale = (typeof SIGNUP_LOCALES)[number];

export type SignupStatus = 'pending' | 'approved' | 'rejected' | 'removed';
export type SignupListFilter = SignupStatus | 'needs_attention';

export interface SignupStep {
  status: 'ok' | 'skipped' | 'failed' | 'waiting' | 'unknown';
  at: string;
  code?: string | null;
  error?: string | null;
  detail?: Record<string, unknown>;
}

export interface SignupRejectRepair {
  state: 'pending' | 'done' | 'failed' | 'blocked' | 'resolved_manually';
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  blockers: string[];
  undid: string[];
  note: string | null;
}

/** The early-access removal of an approved workspace (null until a super_admin removes it). */
export interface SignupRemoval {
  state: 'pending' | 'blocked' | 'failed' | 'done' | 'resolved_manually';
  tenant_id: string;
  tenant_slug: string;
  requested_by: string;
  requested_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  blockers: string[];
  steps: Record<string, { status: 'ok' | 'skipped' | 'failed' | 'blocked'; at: string; code?: string | null; error?: string | null }>;
  note: string | null;
}

export interface SignupApproval {
  id: string;
  email: string;
  name: string;
  company: string | null;
  message: string | null;
  locale: SignupLocale | null;
  source: 'web' | 'chat' | 'invite';
  status: SignupStatus;
  created_at: string;
  decided_at: string | null;
  decided_via: 'onboarding' | 'telegram' | null;
  decider_actor: string | null;
  approving: boolean;
  tenant_name: string | null;
  tenant_slug: string | null;
  tenant_id: string | null;
  suggested_tenant_name: string;
  steps: Record<string, SignupStep>;
  steps_not_ok: Array<{ step: string; status: string; code: string | null }>;
  email_state: 'sent' | 'waiting';
  steps_attempts: number;
  steps_next_attempt_at: string | null;
  reject_repair: SignupRejectRepair | null;
  removal: SignupRemoval | null;
}

export interface SignupApproveResult {
  approval: SignupApproval;
  tenantId: string;
  tenant: { id: string; name: string | null; slug: string | null };
  emailState: 'sent' | 'waiting';
  stepsNotOk: Array<{ step: string; status: string; code: string | null }>;
}

export interface SignupInviteInput {
  email: string;
  name: string;
  company?: string;
  tenantName?: string;
  locale?: SignupLocale;
}

/** Thrown for a refusal; `code` is the backend's machine code when it sent one. */
export class SignupApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'SignupApiError';
  }
}

/** The machine code (`error` when it is a string) of an already-parsed error body. */
function codeOf(body: unknown): string | null {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : null;
}

async function fail(r: Response, what: string): Promise<never> {
  // One read of the body: a non-JSON body (an ingress page) leaves both the code and the detail
  // empty and the message still names the status.
  const text = await r.text();
  let body: unknown = undefined;
  if (text.trim().startsWith('{')) {
    try {
      body = JSON.parse(text);
    } catch (parseErr) {
      logRawError(`signup-approvals.${what}`, r.status, String(parseErr));
      throw new SignupApiError('The request failed and the server reply could not be read.', r.status, null);
    }
  }
  // The page shows the backend's own sentence (written for the operator); the raw status goes to
  // the console only (customer-copy guard, fr#1409).
  logRawError(`signup-approvals.${what}`, r.status, text.slice(0, 500));
  const detail = errorDetailFrom(body);
  throw new SignupApiError(detail || 'The request was refused; see the browser console for details.', r.status, codeOf(body));
}

async function post<T>(path: string, body: unknown, what: string): Promise<T> {
  const r = await authFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) return fail(r, what);
  return (await r.json()) as T;
}

export async function listSignupApprovals(status?: SignupListFilter): Promise<SignupApproval[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const r = await authFetch(`/api/signup-approvals${qs}`);
  if (!r.ok) return fail(r, 'listSignupApprovals');
  return ((await r.json()) as { items: SignupApproval[] }).items;
}

export async function getSignupApproval(id: string): Promise<SignupApproval> {
  const r = await authFetch(`/api/signup-approvals/${encodeURIComponent(id)}`);
  if (!r.ok) return fail(r, 'getSignupApproval');
  return ((await r.json()) as { data: SignupApproval }).data;
}

export function approveSignup(id: string, tenantName?: string): Promise<SignupApproveResult> {
  const body = tenantName && tenantName.trim() ? { tenantName: tenantName.trim() } : {};
  return post(`/api/signup-approvals/${encodeURIComponent(id)}/approve`, body, 'approveSignup');
}

export async function rejectSignup(id: string): Promise<SignupApproval> {
  return (await post<{ approval: SignupApproval }>(`/api/signup-approvals/${encodeURIComponent(id)}/reject`, {}, 'rejectSignup')).approval;
}

export async function retrySignupSteps(id: string): Promise<SignupApproval> {
  return (await post<{ approval: SignupApproval }>(`/api/signup-approvals/${encodeURIComponent(id)}/retry`, {}, 'retrySignupSteps')).approval;
}

export async function resolveSignupRepair(id: string, note: string, acknowledgeLiveAccess: boolean): Promise<SignupApproval> {
  return (
    await post<{ approval: SignupApproval }>(
      `/api/signup-approvals/${encodeURIComponent(id)}/resolve-repair`,
      { note, acknowledgeLiveAccess },
      'resolveSignupRepair',
    )
  ).approval;
}

export function inviteSignup(input: SignupInviteInput): Promise<SignupApproveResult & { reusedPending: boolean }> {
  const body: Record<string, string> = { email: input.email.trim(), name: input.name.trim() };
  if (input.company?.trim()) body.company = input.company.trim();
  if (input.tenantName?.trim()) body.tenantName = input.tenantName.trim();
  if (input.locale) body.locale = input.locale;
  return post('/api/signup-approvals/invite', body, 'inviteSignup');
}

/**
 * Remove an approved early-access workspace end to end (`confirm` = its slug). A blocked / failed
 * removal throws (409 / 502) with the backend's sentence; the row then shows the removal's state.
 */
export async function removeSignup(id: string, confirm: string): Promise<SignupApproval> {
  return (
    await post<{ approval: SignupApproval }>(`/api/signup-approvals/${encodeURIComponent(id)}/remove`, { confirm: confirm.trim() }, 'removeSignup')
  ).approval;
}

export async function retrySignupRemoval(id: string): Promise<SignupApproval> {
  return (await post<{ approval: SignupApproval }>(`/api/signup-approvals/${encodeURIComponent(id)}/removal/retry`, {}, 'retrySignupRemoval')).approval;
}

export async function resolveSignupRemoval(id: string, note: string, acknowledgeLiveAccess: boolean): Promise<SignupApproval> {
  return (
    await post<{ approval: SignupApproval }>(
      `/api/signup-approvals/${encodeURIComponent(id)}/removal/resolve`,
      { note, acknowledgeLiveAccess },
      'resolveSignupRemoval',
    )
  ).approval;
}
