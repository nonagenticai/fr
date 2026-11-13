// tests/unit/services/catalogue/project-intake-approval-mode.test.ts
//
// Approval mode (George 2026-10-27): the user picks which conveyor sign-offs they
// are asked for; fr validates the value and passes it to RM as
// `it_inputs.approval_mode`. fr keeps no copy (RM-only). A body without it gets
// 'brief_and_closure' (George 2026-10-31, R329; was 'autonomous'). fr never leaves
// it unset, so the stored mode never depends on the flows' fallback.
//
// Hermetic: pure functions, no DB.

import { describe, expect, test } from 'bun:test';

import { APPROVAL_MODES, ProjectCreateSchema } from '../../../../src/types/api';
import {
  frIntakeFieldsFromRm,
  frKeptProjectData,
  IT_INPUT_KEYS,
  RM_ONLY_PROJECT_DATA_KEYS,
  rmIntakeOfCreate,
} from '../../../../src/services/catalogue/project-intake';

const BASE = { name: 'A', project_type: 'it', it_flow: 'bug', bug_test_command: ['pytest'], problem_statement: 'p' };
const intakeOf = (body: unknown) =>
  rmIntakeOfCreate(ProjectCreateSchema.parse(body) as never, { scopeLevel: 'repo', priorityLevelId: null });

describe('approval_mode', () => {
  test('the four modes, in RM order', () => {
    expect([...APPROVAL_MODES]).toEqual(['all', 'auto_drafts', 'brief_and_closure', 'autonomous']);
  });

  test.each([...APPROVAL_MODES])('%s is passed to RM it_inputs', (mode) => {
    const intake = intakeOf({ ...BASE, approval_mode: mode });
    expect(intake.it_inputs).toEqual({ it_flow: 'bug', bug_test_command: ['pytest'], approval_mode: mode });
  });

  test('absent: RM it_inputs gets brief_and_closure', () => {
    const intake = intakeOf(BASE);
    expect(intake.it_inputs).toEqual({ it_flow: 'bug', bug_test_command: ['pytest'], approval_mode: 'brief_and_closure' });
  });

  test('absent on a non-IT project (e.g. the agent create body): still brief_and_closure', () => {
    const intake = intakeOf({ name: 'F', project_type: 'feature' });
    expect(intake.it_inputs).toEqual({ approval_mode: 'brief_and_closure' });
  });

  test.each(['never', 'ALL', '', 'auto-drafts', 1, true])('%p is refused before any write', (bad) => {
    const r = ProjectCreateSchema.safeParse({ ...BASE, approval_mode: bad });
    expect(r.success).toBe(false);
  });

  test('RM-only: fr keeps no copy and PATCH treats it as RM-owned', () => {
    expect(IT_INPUT_KEYS).toContain('approval_mode');
    expect(RM_ONLY_PROJECT_DATA_KEYS).toContain('approval_mode');
    const v = ProjectCreateSchema.parse({ ...BASE, approval_mode: 'autonomous' });
    expect(frKeptProjectData(v as never)).toEqual({ it_flow: 'bug' });
  });

  test('read back from the RM row into the flat project view', () => {
    const out = frIntakeFieldsFromRm({ it_inputs: { it_flow: 'bug', approval_mode: 'brief_and_closure' } } as never);
    expect(out.approval_mode).toBe('brief_and_closure');
    expect(frIntakeFieldsFromRm({ it_inputs: { it_flow: 'bug' } } as never).approval_mode).toBeUndefined();
  });
});
