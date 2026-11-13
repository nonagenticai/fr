// @vitest-environment jsdom
//
// ApprovalDecisionSurface — fr-agui P1-TEAM-b (George 2026-10-15): any member of the
// approval's tenant may decide it (1-of-any). The surface offers the controls to a member
// acting in the row's own workspace and SAYS why (the roster names someone else); it
// offers nothing to a member of another workspace. Changes together with `canAct.ts` and
// the backend arm (parity: backend/tests/unit/lib/tenant-member-arm-parity.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ApprovalDecisionSurface from './ApprovalDecisionSurface.svelte';
import type { Approval } from '$lib/types/api';

const T = '0195f48b-d000-7000-8000-0000000000a1';
const OTHER = '0195f48b-d000-7000-8000-0000000000b2';

let host: HTMLDivElement;
let app: ReturnType<typeof mount> | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host.remove();
});

function row(): Approval {
  return {
    id: 'a-1',
    project_id: 'p1',
    tenant_id: T,
    requester_id: 'owner',
    source: 'n8n',
    status: 'pending',
    description: 'Ready to execute?',
    created_at: new Date().toISOString(),
    expires_at: null,
    required_approvers: [{ user_id: 'ghost', role: 'execution_signoff' }],
    decisions: [],
    metadata: {},
  } as unknown as Approval;
}

function render(user: { id: string; roles: string[]; tenant_id?: string }) {
  app = mount(ApprovalDecisionSurface, { target: host, props: { approval: row(), user, onDecide: () => {} } });
  flushSync();
}

describe('ApprovalDecisionSurface — tenant-member arm (P1-TEAM-b)', () => {
  it('a member acting in the row\'s workspace gets the controls AND the explanation', () => {
    render({ id: 'member', roles: [], tenant_id: T });
    expect(host.querySelector('[data-testid="approval-tenant-member-note"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="approval-super-admin-override-note"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-readonly-note"]')).toBeNull();
  });

  it('⭐ the OWNER (requester_id on a conveyor-raised row) is not told they may not decide', () => {
    render({ id: 'owner', roles: [], tenant_id: T });
    expect(host.querySelector('[data-testid="approval-tenant-member-note"]')).not.toBeNull();
  });

  it('⛔ a member of ANOTHER workspace gets no controls and no member note', () => {
    render({ id: 'member', roles: [], tenant_id: OTHER });
    expect(host.querySelector('[data-testid="approval-tenant-member-note"]')).toBeNull();
    // Read-only: the not-yours note renders, and no decision bar outcome slot exists.
    expect(host.querySelector('[data-testid="approval-readonly-note"]')).not.toBeNull();
  });
});
