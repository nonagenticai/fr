/**
 * The mailbox customer-facing copy points people at (licence renewal, "need
 * help?"). A ROLE mailbox, never a person's address: a personal address in the
 * customer UI ages badly and exposes one individual (FR-8).
 *
 * Overridable per deployment with `VITE_SUPPORT_EMAIL` (build-time, like every
 * other `VITE_*` value in this app); a blank value falls back to the default.
 */
export const DEFAULT_SUPPORT_EMAIL = 'support@nonagentic.ai';

export function supportEmail(): string {
  const raw = import.meta.env.VITE_SUPPORT_EMAIL as string | undefined;
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v.length > 0 ? v : DEFAULT_SUPPORT_EMAIL;
}
