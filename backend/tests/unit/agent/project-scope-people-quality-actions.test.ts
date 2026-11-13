// tests/unit/agent/project-scope-people-quality-actions.test.ts
//
// fr-agui SPEC §13 P2 (P2-c1) — the shape of the six new project-agent WRITES
// (agui/actions/project-scope-people-quality.ts): each is a `capability-invoke`
// confirm card over its own invoke route, web-only, project-member, the human's
// Confirm self-approves inline (`autoApproveForInitiator`, the P2-c2 finding),
// the project is the injected `project_id`, and no input key can name another
// project. The behaviour through the real pipeline was pinned by the
// project-scope-people-quality integration suite, deleted 2026-10-29 under the
// no-test-doubles ruling — it is no longer in the suite.

import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';

import {
  PROJECT_PEOPLE_QUALITY_WRITES,
  PROJECT_SCOPE_ACTIONS,
  PROJECT_SCOPE_PEOPLE_QUALITY_ACTIONS,
} from '../../../src/agui/actions/project-scope-people-quality';
import { PROJECT_AGENT_ACTIONS, PROJECT_AGENT_CORE } from '../../../src/agui/agent-surface';
import { extractJsonSchema } from '../../../src/agent/tool-catalog';
import { assetType } from '../../../src/db/client';

const WRITES = [...PROJECT_SCOPE_ACTIONS, ...PROJECT_PEOPLE_QUALITY_WRITES];

describe('P2-c1 writes: capability-invoke confirm cards run as the human', () => {
  test('exactly these six, each a web-only project-member card on its own invoke route, self-approving for the human', () => {
    expect(WRITES.map((a) => a.name)).toEqual([
      'project_assets.bind',
      'project_assets.unbind',
      'project_assets.override',
      'project_assets.block',
      'projects.set_knowledge_allocation',
      'projects.analyze_quality',
    ]);
    for (const a of WRITES) {
      expect([a.kind, a.webOnly, a.projectParam, a.autoApproveForInitiator]).toEqual(['write', true, 'project_id', true]);
      expect(a.approval).toEqual({ type: 'single-approver', approver: 'initiator' });
      expect(a.rbac).toEqual({ type: 'project-member' });
      expect(a.confirm).toEqual({ http: { method: 'POST', path: `/api/capabilities/${a.name}/invoke` }, card: 'capability-invoke' });
    }
  });

  test('every action is in the project agent pack (so the invoke route serves it); only projects.get_quality is core', () => {
    for (const a of PROJECT_SCOPE_PEOPLE_QUALITY_ACTIONS) expect(PROJECT_AGENT_ACTIONS.has(a.name)).toBe(true);
    expect(PROJECT_SCOPE_PEOPLE_QUALITY_ACTIONS.filter((a) => PROJECT_AGENT_CORE.has(a.name)).map((a) => a.name)).toEqual(['projects.get_quality']);
  });

  test('strict inputs: no key names a project besides the injected project_id; an extra key is refused', () => {
    const pid = '0195f48b-d000-7000-8000-0000000c2c01';
    for (const a of WRITES) {
      const keys = Object.keys((extractJsonSchema(a.input) as { properties?: Record<string, unknown> }).properties ?? {});
      expect(keys.filter((k) => /project/.test(k))).toEqual(['project_id']);
    }
    const bind = PROJECT_SCOPE_ACTIONS[0]! as unknown as { input: z.ZodTypeAny };
    expect(bind.input.safeParse({ project_id: pid, kind: 'requirement', asset_id: 'r-1' }).success).toBe(true);
    expect(bind.input.safeParse({ project_id: pid, kind: 'requirement', asset_id: 'r-1', project_ids: [pid] }).success).toBe(false);
    expect(bind.input.safeParse({ project_id: pid, kind: 'not_a_kind', asset_id: 'r-1' }).success).toBe(false);
  });

  test('the scope kinds are the asset_type pgEnum (single-sourced)', () => {
    const kinds = (extractJsonSchema(PROJECT_SCOPE_ACTIONS[0]!.input) as { properties: { kind: { enum: string[] } } }).properties.kind.enum;
    expect(kinds).toEqual([...assetType.enumValues]);
  });
});
