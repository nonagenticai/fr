// The workspace's member directory, for naming who did something on the
// modeling pages. requirements_management records the acting subject id (the
// Keycloak user id); this resolves it through fr's own tenant member list
// (GET /api/tenant/members — any member may read it: tenant-wide collaboration,
// George 2026-10-15). Loaded once per page session, shared by every page.
//
// A failed load is NOT silently "no members": it is recorded (`failed`) and the
// pages say "a workspace member" (names unavailable) instead of claiming that
// anyone left. "A former member" is said only for an id the directory does not
// resolve.
import { listTenantMembers, type TenantMember } from '$lib/api/tenant-members';

type Status = 'idle' | 'loading' | 'ready' | 'failed';

class MemberDirectory {
  #byId = $state<Map<string, TenantMember>>(new Map());
  #status = $state<Status>('idle');

  get status(): Status {
    return this.#status;
  }

  #requested = false;

  /**
   * Start the one load (idempotent). Safe to call while rendering: the state
   * change happens in a microtask, never inside the template that asked.
   */
  ensure(): void {
    if (this.#requested) return;
    this.#requested = true;
    queueMicrotask(() => this.#load());
  }

  #load(): void {
    this.#status = 'loading';
    listTenantMembers()
      .then((members) => {
        this.#byId = new Map(members.map((m) => [m.id, m]));
        this.#status = 'ready';
      })
      .catch((err) => {
        console.warn('[modeling] the member directory could not be read; names are shown generically', err);
        this.#status = 'failed';
      });
  }

  member(id: string): TenantMember | undefined {
    return this.#byId.get(id);
  }
}

export const memberDirectory = new MemberDirectory();
