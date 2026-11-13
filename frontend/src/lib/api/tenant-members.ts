// Client for GET /api/tenant/members — the users of the CALLER'S tenant.
//
// The tenant is resolved server-side from the session; this client sends none.
// Unresolved members (`resolved: false`, sorted last by the server) are ids the
// identity provider could not name. They are kept, never filtered.
//
// ⚠️ A failure THROWS. It is never swallowed into `[]`: an empty list reads as
// "you are the only user in this tenant", which is a false statement that would
// silently hide the approver picker and collapse the roster to one person.

import { authFetch } from './auth-fetch';

export interface TenantMember {
  id: string;
  email: string | null;
  name: string | null;
  resolved: boolean;
}

export class TenantMembersError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TenantMembersError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: string | { code?: string; message?: string };
}

export async function listTenantMembers(): Promise<TenantMember[]> {
  const res = await authFetch('/api/tenant/members');

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — handled below.
  }

  if (!res.ok) {
    // Normalise both shapes: `{ error: { code, message } }` and the license
    // gate's bare `{ error: '<code>' }`.
    const rawErr = (body as ErrorBody | null)?.error;
    const code = typeof rawErr === 'string' ? rawErr : rawErr?.code;
    const msg =
      (typeof rawErr === 'string' ? undefined : rawErr?.message) ??
      `${res.status} ${res.statusText}`;
    throw new TenantMembersError(msg, res.status, code);
  }

  // Accept `{ items }` and the `{ data: { items } }` envelope.
  const payload =
    body && typeof body === 'object' && 'data' in body
      ? (body as { data: unknown }).data
      : body;
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    // A 2xx without a list is a contract break, not "zero members".
    throw new TenantMembersError(
      'Tenant members response had no items list',
      res.status,
      'malformed_response',
    );
  }
  return items as TenantMember[];
}
