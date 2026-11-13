// /channels/[id] — the schedule action gate.
//
// Component-level rendering isn't viable here (the page pulls `$app/stores` and
// `$app/navigation`), so the decision is factored into `page-helpers.ts` — the
// same convention as `routes/settings/usage/page.test.ts`.
//
// THE DEFECT: resolving the owning project's `dept_id` sat in its own inner try
// whose catch was `scheduleProjectDeptId = null`. A failed `GET /api/projects/:id`
// therefore failed closed — correct — and did it silently: Run now, Save and
// Delete all vanished and the page rendered as an ordinary read-only view. The
// user reads that as "I do not have permission", when in truth nothing about
// their permission was ever determined. A deny and an unanswered question must
// not paint the same pixels.

import { describe, it, expect } from 'vitest';
import { scheduleActionsState } from './page-helpers';

describe('scheduleActionsState', () => {
  it('a lost dept read is PERMISSION-UNKNOWN, never a plain deny', () => {
    expect(
      scheduleActionsState({ canEdit: false, deptUnreadable: 'HTTP 502' }),
    ).toBe('permission-unknown');
  });

  it('still hides the actions — the deny is kept, only the silence is fixed', () => {
    // The backend is the security boundary either way; the fix is what the page
    // SAYS about the hidden buttons, not whether it shows them.
    expect(
      scheduleActionsState({ canEdit: false, deptUnreadable: 'HTTP 502' }),
    ).not.toBe('actions');
  });

  it('a fully-read deny stays a deny', () => {
    expect(scheduleActionsState({ canEdit: false, deptUnreadable: null })).toBe(
      'denied',
    );
    expect(
      scheduleActionsState({ canEdit: false, deptUnreadable: undefined }),
    ).toBe('denied');
    // An empty-string reason is no reason at all.
    expect(scheduleActionsState({ canEdit: false, deptUnreadable: '' })).toBe(
      'denied',
    );
  });

  it('a granted user gets the actions even with the dept read lost', () => {
    // A workspace-admin passes regardless of `dept_id`, so for them the lost
    // input changed nothing and there is nothing to warn about. Warning anyway
    // would be its own false claim.
    expect(
      scheduleActionsState({ canEdit: true, deptUnreadable: 'HTTP 502' }),
    ).toBe('actions');
    expect(scheduleActionsState({ canEdit: true, deptUnreadable: null })).toBe(
      'actions',
    );
  });
});
