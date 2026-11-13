// /admin/onboarding — pure helpers (type-imports only, so node-environment unit
// tests load them without the authFetch / keycloak graph).

import type { SignupApproval, SignupInviteInput, SignupLocale } from '$lib/api/signup-approvals';

/** The provisioning steps in the order the backend runs them. */
export const STEP_ORDER = ['identity', 'provision', 'workspace', 'budget', 'catalogue', 'bundle', 'invite_email'] as const;

export const STEP_LABELS: Record<string, string> = {
  identity: 'Login created',
  provision: 'Tenant + licence',
  workspace: 'Workspace admin',
  budget: 'Token budget',
  catalogue: 'PM catalogue',
  bundle: 'Conveyor bundle',
  invite_email: 'Set-password email',
};

export const LOCALE_LABELS: Record<SignupLocale, string> = {
  en: 'English',
  ar: 'العربية (Arabic)',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  he: 'עברית (Hebrew)',
  nl: 'Nederlands',
  pl: 'Polski',
};

/** One step's row on the screen: `pending` when it has not run yet. */
export function stepRows(a: Pick<SignupApproval, 'steps'>): Array<{ step: string; label: string; status: string; detail: string | null }> {
  return STEP_ORDER.map((step) => {
    const rec = a.steps?.[step];
    return {
      step,
      label: STEP_LABELS[step] ?? step,
      status: rec?.status ?? 'pending',
      detail: rec ? [rec.code, rec.error].filter(Boolean).join(' — ') || null : null,
    };
  });
}

/** The removal steps in the order the backend runs them. */
export const REMOVAL_STEP_ORDER = ['provisioning', 'licences', 'licences_tenant', 'workspace', 'grants', 'identity', 'finalize'] as const;

export const REMOVAL_STEP_LABELS: Record<string, string> = {
  provisioning: 'Provisioning run reversed',
  licences: 'Every licence revoked',
  licences_tenant: 'Licences tenant archived',
  workspace: 'Workspace archived',
  grants: 'Role grants removed',
  identity: 'Login deleted',
  finalize: 'Slug released',
};

/** One removal step's row: `pending` when it has not run yet. */
export function removalRows(a: Pick<SignupApproval, 'removal'>): Array<{ step: string; label: string; status: string; detail: string | null }> {
  if (!a.removal) return [];
  return REMOVAL_STEP_ORDER.map((step) => {
    const rec = a.removal!.steps?.[step];
    return {
      step,
      label: REMOVAL_STEP_LABELS[step] ?? step,
      status: rec?.status ?? 'pending',
      detail: rec ? [rec.code, rec.error].filter(Boolean).join(' — ') || null : null,
    };
  });
}

/** What the row needs from a super_admin, if anything. */
export type RowAction = 'decide' | 'retry_steps' | 'retry_cleanup' | 'resolve_cleanup' | 'retry_removal' | 'none';

/** An approved row can be removed (its own button beside whatever else the row needs). */
export function canRemove(a: Pick<SignupApproval, 'status' | 'tenant_slug'>): boolean {
  return a.status === 'approved' && Boolean(a.tenant_slug);
}

export function rowAction(a: Pick<SignupApproval, 'status' | 'email_state' | 'reject_repair' | 'approving' | 'removal'>): RowAction {
  if (a.status === 'pending') return a.approving ? 'none' : 'decide';
  if (a.status === 'approved') return a.email_state === 'sent' ? 'none' : 'retry_steps';
  if (a.status === 'removed') {
    const st = a.removal?.state;
    return st === 'pending' || st === 'failed' || st === 'blocked' ? 'retry_removal' : 'none';
  }
  const rr = a.reject_repair;
  if (!rr || rr.state === 'done' || rr.state === 'resolved_manually') return 'none';
  return rr.state === 'pending' ? 'retry_cleanup' : 'resolve_cleanup';
}

export function statusLabel(a: Pick<SignupApproval, 'status' | 'email_state' | 'reject_repair' | 'approving' | 'removal'>): string {
  if (a.status === 'pending') return a.approving ? 'Being approved…' : 'Pending';
  if (a.status === 'approved') return a.email_state === 'sent' ? 'Approved — email sent' : 'Approved — email waiting';
  if (a.status === 'removed') {
    const st = a.removal?.state;
    if (st === 'done') return 'Removed';
    if (st === 'resolved_manually') return 'Removed — closed by hand';
    return `Removal ${st ?? 'unknown'}`;
  }
  const rr = a.reject_repair;
  if (!rr || rr.state === 'done') return 'Rejected';
  if (rr.state === 'resolved_manually') return 'Rejected — cleanup closed by hand';
  return `Rejected — cleanup ${rr.state}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side check of the invite form; the backend re-validates (strict). */
export function inviteFormError(input: SignupInviteInput): string | null {
  if (!EMAIL_RE.test(input.email.trim())) return 'Enter a valid email address.';
  if (!input.name.trim()) return 'Enter the person’s name.';
  if (input.name.trim().length > 160) return 'The name is longer than 160 characters.';
  if (input.company && input.company.trim().length > 160) return 'The company is longer than 160 characters.';
  const t = input.tenantName?.trim() ?? '';
  if (t && (t.length < 2 || t.length > 120)) return 'The workspace name must be 2–120 characters.';
  return null;
}
