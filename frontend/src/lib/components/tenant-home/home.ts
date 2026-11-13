// Tenant home (`/`) — small pure helpers shared by its cards.
//
// Every card on the home page loads on its own and renders one of three states:
// loading, ready (possibly empty), or failed. A failed read is never shown as 0.

import { durationWords } from '$lib/projects/cockpit-status';
import { logRawError } from '$lib/workers/wm-errors';

export type Load<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'error' };

/** A failed read: the raw cause goes to the console, the card shows neutral copy. */
export function failed(context: string, err: unknown): { kind: 'error' } {
  logRawError(`tenant-home:${context}`, err);
  return { kind: 'error' };
}

/** "12", or "200+" when the list the server returned was capped. */
export function countText(n: number, capped: boolean): string {
  return capped ? `${n}+` : String(n);
}

/** The workspace role as a person would say it. */
export function roleWords(role: string | undefined, superAdmin: boolean): string | null {
  if (superAdmin) return 'Platform administrator';
  if (!role) return null;
  if (role === 'workspace-admin') return 'Workspace admin';
  if (role === 'own_workspace' || role === 'member') return 'Member';
  const words = role.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "3 d ago" off an ISO time; null when the time is unreadable. */
export function agoWords(iso: string | Date | null | undefined, now: number): string | null {
  const t = iso instanceof Date ? iso.getTime() : iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${durationWords(now - t)} ago` : null;
}
